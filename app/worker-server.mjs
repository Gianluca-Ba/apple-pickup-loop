import { createServer, request } from 'node:http';
import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { PickupWorker, linuxNetwork, safeWorkerFailure } from './worker.mjs';
import { readJSON, writeJSON } from './storage.mjs';
import { validateSelection } from './shared.mjs';
export const SOCKET = '/home/monitor/.apple-pickup-v2.sock';
export function workerClientReply(id, value) {
  if (!/^[a-f0-9-]{36}$/.test(id ?? '') || !value || typeof value !== 'object' || Array.isArray(value) || typeof value.ok !== 'boolean') throw Error('INVALID_RESPONSE');
  return { ...value, requestId: id, channel: 'stock-worker-v1' };
}
export class WorkerJobs {
  constructor(worker, path, now = Date.now) { this.worker = worker; this.path = path; this.now = now; this.saved = path ? readJSON(path, []) : []; this.jobs = new Map(); this.orphanedUntil = this.saved.some(r => r.state === 'pending' && r.identity.includes('sample')) ? now() + 65000 : 0; }
  save() { if (this.path) writeJSON(this.path, this.saved.slice(-128)); }
  start(id, operation, data = {}) {
    if (!/^[a-f0-9-]{36}$/.test(id ?? '') || !['network', 'sample', 'close'].includes(operation)) throw Error('INVALID_COMMAND');
    if (operation === 'sample') { validateSelection(data.selection); if (!/^[a-f0-9]{64}$/.test(data.fingerprint ?? '')) throw Error('INVALID_COMMAND'); }
    const identity = JSON.stringify({ operation, sku: data.selection?.sku, stores: data.selection?.stores });
    if (this.jobs.has(id)) { if (this.jobs.get(id).identity !== identity) throw Error('REQUEST_REUSED'); return this.result(id); }
    const saved = this.saved.find(r => r.id === id);
    if (saved) { if (saved.identity !== identity) throw Error('REQUEST_REUSED'); return saved.result ?? { ok: false, code: 'sample-uncertain', nextAllowedInMs: 65000 }; }
    if (operation === 'sample' && this.orphanedUntil > this.now()) return { ok: false, code: 'sample-uncertain', nextAllowedInMs: this.orphanedUntil - this.now() };
    const record = { id, identity, state: 'pending' }; this.saved = [...this.saved.filter(r => r.state === 'pending'), ...this.saved.filter(r => r.state !== 'pending').slice(-127), record]; this.save();
    const job = { identity, result: null }; this.jobs.set(id, job);
    void Promise.resolve().then(() => operation === 'sample' ? this.worker.sample(data.selection, data.fingerprint) : this.worker[operation]()).then(result => ({ ok: true, result: result ?? null }), e => safeWorkerFailure(e, this.now())).then(value => {
      job.result = value; record.state = 'done';
      // Network proofs live only in RAM. Never persist an IP or its fingerprint.
      record.result = operation === 'network' ? { ok: false, code: 'proof-expired' } : value; this.save();
      while (this.jobs.size > 128) { const first = this.jobs.keys().next().value; if (!this.jobs.get(first).result) break; this.jobs.delete(first); }
    });
    return { ok: true, pending: true };
  }
  result(id) { const current = this.jobs.get(id); if (current) return current.result ?? { ok: true, pending: true }; const saved = this.saved.find(r => r.id === id); return saved ? saved.result ?? { ok: false, code: 'sample-uncertain', nextAllowedInMs: 65000 } : { ok: false, code: 'operation-missing' }; }
}
export function serve(worker, path) {
  const jobs = new WorkerJobs(worker, path);
  const server = createServer(async (req, res) => {
    let value;
    try {
      if (req.method !== 'POST') throw Error('INVALID_COMMAND');
      let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 4096) throw Error('INVALID_COMMAND'); }
      const data = JSON.parse(raw);
      value = req.url === '/result' ? jobs.result(data.id) : req.url === '/start' ? jobs.start(data.id, data.operation, data.data) : { ok: false, code: 'invalid-command' };
    } catch { value = { ok: false, code: 'invalid-command' }; }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value));
  });
  server.listen(SOCKET, () => chmodSync(SOCKET, 0o600)); return server;
}
export async function client(path, data) {
  return new Promise((accept, reject) => {
    const req = request({ socketPath: SOCKET, path, method: 'POST', timeout: 2500, headers: { 'Content-Type': 'application/json' } }, res => { let text = ''; res.on('data', d => { text += d; if (text.length > 32768) req.destroy(); }); res.on('end', () => { try { accept(JSON.parse(text)); } catch { reject(Error('INVALID_RESPONSE')); } }); });
    req.on('error', reject); req.on('timeout', () => req.destroy(Error('TIMEOUT'))); req.end(JSON.stringify(data));
  });
}
export async function startWorker() {
    // The deployment starts a single daemon per worker after stopping old consumers.
    if (existsSync(SOCKET)) unlinkSync(SOCKET);
    const stateDirectory = process.env.APPLE_LOOP_STATE_DIR ?? '/home/monitor';
    if (!['/home/monitor', '/var/lib/apple-loop-state'].includes(stateDirectory)) throw Error('STATE_DIRECTORY_INVALID');
    const browserFactory = async () => {
      if (process.env.APPLE_LOOP_BROWSER_RUNTIME === 'local') {
        const { createChromiumStockSession } = await import('./chromium-session.mjs');
        return createChromiumStockSession();
      }
      const { createContainerBrowserPool } = await import('./browser-pool.mjs');
      const sockets = process.env.APPLE_LOOP_SINGLE_BROWSER === '1' ? ['/home/monitor/.iphone-container-ipc/a.sock'] : undefined;
      return createContainerBrowserPool({ pointerPath: stateDirectory + '/.iphone-container-next.json', sockets });
    };
    const worker = new PickupWorker({
      ledgerPath: stateDirectory + '/.iphone-stock-ledger.json',
      network: linuxNetwork,
      browserFactory,
    });
    const server = serve(worker, stateDir+'/.apple-pickup-v2-requests.json');
    for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => { await worker.close(); server.close(); });
    return server;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--client') {
    let id;
    try { const data = JSON.parse(Buffer.from(process.argv[4], 'base64').toString()); id = data.id; console.log(JSON.stringify(workerClientReply(id, await client(process.argv[3], data)))); }
    catch { const value = { ok: false, code: 'worker-unreachable' }; console.log(JSON.stringify(/^[a-f0-9-]{36}$/.test(id ?? '') ? workerClientReply(id, value) : value)); }
  } else await startWorker();
}
