import { createServer } from 'node:http';
import { readFileSync, existsSync, openSync, closeSync, unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { AppStorage } from './storage.mjs';
import { AppleCatalog } from './catalog.mjs';
import { SafariSessions } from './safari-sessions.mjs';
import { LinuxFleet } from './fleet.mjs';
import { PurchaseController } from './controller.mjs';
import { STORES, REGION } from './shared.mjs';
import { desktopNotification } from './notifications.mjs';
import { closeGuestStream } from './guest-stream.mjs';
export const ROOT = fileURLToPath(new URL('../', import.meta.url));
const ERRORS = Object.freeze({ VERIFICATION_ACTIVE: 'Prova Apple Pay ancora aperta: chiudi o annulla la finestra e attendi la verifica.', PICKUP_CONTACT_INVALID: 'Completa cognome, nome, email e telefono per il ritiro.', PICKUP_CONTACT_REQUIRED: 'Inserisci i dati di ritiro prima dell’attivazione.', ACTIVATION_BUSY: 'Attendi la chiusura del ciclo precedente.', SELECTION_LOCKED: 'Disattiva il ciclo e attendi la conclusione del pagamento prima di cambiare prodotto.', CATALOG_PRICE_CHANGED: 'Apple ha aggiornato il prezzo. Seleziona nuovamente la configurazione.', CATALOG_REFRESH_REQUIRED: 'Attendi l’aggiornamento del catalogo Apple.', CONFIGURATION_PRICE_UNVERIFIED: 'Prezzo o configurazione non verificabili nel catalogo Apple.', PRODUCT_NOT_IN_CATALOG: 'Il prodotto non è nel catalogo attuale.', SELECTION_INVALID: 'Scegli prodotto, configurazione e almeno uno Store.', ACTIVATION_INVALID: 'Stato di attivazione non valido.' });
export function createApplication({ directory = ROOT + 'data', catalog = new AppleCatalog(), storage = new AppStorage(directory), safari = new SafariSessions({directory}), fleet, notify = desktopNotification, now = Date.now } = {}) {
  let controller;
  fleet ??= new LinuxFleet({ positions: storage.settings.positions, vpnLimit: storage.settings.vpnLimit,workerCount:storage.settings.workerCount,standbyTarget:storage.settings.standbyTarget,nordLimit:storage.settings.nordLimit, onSignal: sample => controller.signal(sample), onBlocked: message => { controller.state('intervention', message); controller.notice('action', 'APPLE_WAIT', message); }, canChange: () => controller.enabled && !controller.current && !controller.currentStore && controller.phase === 'watching', now });
  controller = new PurchaseController({ catalog, storage, safari, fleet, notify, now });
  safari.canRebind = () => !controller.current && !controller.currentStore && ['preparing','intervention'].includes(controller.phase);
  return { controller, catalog, storage, safari, fleet };
}
export function createHTTPServer(app, { port = 4318 } = {}) {
  const server = createServer(async (req, res) => {
    const actualPort = port || server.address()?.port;
    const origin = 'http://127.0.0.1:' + actualPort;
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" };
    const send = (status, value) => { res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    if (req.headers.host !== '127.0.0.1:' + actualPort && req.headers.host !== 'localhost:' + actualPort) return send(403, { error: 'Origine non valida.' });
    let u; try { u = new URL(req.url, origin); } catch { return send(400, { error: 'Richiesta non valida.' }); }
    try {
      if (req.method === 'GET' && u.pathname === '/api/state') return send(200, { ...app.controller.snapshot(), region: REGION, stores: STORES, catalog: app.catalog.snapshot() });
      if (req.method === 'GET' && u.pathname === '/api/catalog/configurations') return send(200, { configurations: await app.catalog.configurations(u.searchParams.get('productId')) });
      if (req.method === 'GET' && ['/','/app.css','/app.js'].includes(u.pathname)) {
        const file = u.pathname === '/' ? 'index.html' : u.pathname.slice(1), type = file.endsWith('html') ? 'text/html' : file.endsWith('css') ? 'text/css' : 'text/javascript';
        res.writeHead(200, { ...headers, 'Content-Type': type + '; charset=utf-8' }); return res.end(readFileSync(new URL('./ui/' + file, import.meta.url)));
      }
      if (req.method !== 'POST' || !['/api/activation', '/api/selection', '/api/pickup-contact','/api/fleet/capacity'].includes(u.pathname)) return send(404, { error: 'Endpoint non disponibile.' });
      if (req.headers.origin !== origin || req.headers['content-type']?.split(';')[0] !== 'application/json') return send(403, { error: 'Origine della richiesta non valida.' });
      let raw = ''; for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 8192) return send(413, { error: 'Richiesta troppo grande.' }); }
      const data = JSON.parse(raw);
      if (u.pathname === '/api/activation') { if (Object.keys(data).some(k => k !== 'enabled')) throw Error('ACTIVATION_INVALID'); await app.controller.activation(data.enabled); }
      else if (u.pathname === '/api/pickup-contact') await app.controller.setPickupContact(data);
      else if(u.pathname==='/api/fleet/capacity') {
        if(Object.keys(data).some(k=>!['workerCount','positions','vpnLimit','standbyTarget','nordLimit'].includes(k))||app.controller.enabled||app.controller.busy||app.controller.transition||app.controller.current||app.controller.currentStore||app.controller.phase!=='stopped'||app.storage.guard.phase!=='idle')throw Error('FLEET_CAPACITY_BUSY');
        await app.safari.bind();const ui=await app.safari.paymentStatus();if(!ui.known||ui.active)throw Error('FLEET_CAPACITY_BUSY');
        app.fleet.configure(data);await app.fleet.inspect();Object.assign(app.storage.settings,{workerCount:app.fleet.workerCount,positions:app.fleet.positions,vpnLimit:app.fleet.vpnLimit,standbyTarget:app.fleet.standbyTarget,nordLimit:app.fleet.nordLimit});app.storage.saveSettings();
      }
      else {
        if (Object.keys(data).some(k => !['productId', 'sku', 'stores','alternativeSkus'].includes(k)) || !Array.isArray(data.stores)) throw Error('SELECTION_INVALID');
        const variant = await app.catalog.resolve(data.productId, data.sku);
        if(data.alternativeSkus!==undefined&&(!Array.isArray(data.alternativeSkus)||data.alternativeSkus.length>1))throw Error('SELECTION_INVALID');
        const alternatives=[];for(const sku of data.alternativeSkus??[])alternatives.push({...await app.catalog.resolve(data.productId,sku),stores:data.stores});
        await app.controller.select({ ...variant, stores: data.stores },alternatives);
      }
      return send(200, { ok: true, ...app.controller.snapshot() });
    } catch (e) { return send(400, { error: e.message === 'ORDER_ALREADY_CONFIRMED' ? 'Acquisto già confermato da Apple. Il ciclo è concluso.' : ERRORS[e.message] ?? 'Operazione non completata. Verifica la configurazione e lo stato di Safari.' }); }
  });
  server.requestTimeout = 10000; return server;
}
export async function initializeCatalog(app) {
  try {
    await app.catalog.refresh();
    const previous = app.storage.settings.selection;
    if (previous) {
      try { const variant = await app.catalog.resolve(previous.productId, previous.sku); if (!app.controller.current) { app.storage.settings.selection = { ...variant, stores: previous.stores }; app.safari.configureSelections?.(app.controller.selections()); app.storage.saveSettings(); } } catch { app.controller.message = 'La selezione precedente non è verificabile: scegli una configurazione dal catalogo attuale.'; }
    }
  } catch { app.controller.message = 'Catalogo Apple non disponibile. Attendo il prossimo aggiornamento.'; app.controller.notice('action', 'CATALOG_UNAVAILABLE', app.controller.message); }
}
export async function startApplication() {
  const locks = [ROOT + 'data/app.lock', ROOT + 'stock-monitor-state.json.lock'];
  const app = createApplication(); const acquired = [];
  for (const path of locks) { try { const fd = openSync(path, 'wx', 0o600); writeFileSync(fd, String(process.pid)); closeSync(fd); acquired.push(path); } catch { for (const p of acquired) unlinkSync(p); throw Error('Un altro processo gestisce la ricerca.'); } }
  const server = createHTTPServer(app); server.listen(4318, '127.0.0.1');
  void initializeCatalog(app);
  if (!app.controller.current) void app.fleet.inspect().catch(() => { app.fleet.block = 'Flotta Linux da verificare prima dell’attivazione.'; });
  const tick = setInterval(() => { void app.controller.tick(); }, 1000);
  const refresh = setInterval(() => { if (!app.controller.enabled && !app.controller.current) void initializeCatalog(app); }, 1800000);
  let closing = false;
  async function stop() { if (closing) return; closing = true; clearInterval(tick); clearInterval(refresh); try { await app.controller.shutdown(); } finally { try { await closeGuestStream(); } finally { server.close(); server.closeIdleConnections(); for (const path of acquired) try { unlinkSync(path); } catch {} } } }
  process.on('SIGTERM', () => { void stop(); }); process.on('SIGINT', () => { void stop(); });
  return { ...app, server, stop };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await startApplication();
