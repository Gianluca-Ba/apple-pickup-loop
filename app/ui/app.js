const $ = id => document.getElementById(id), yen = n => n == null ? '—' : new Intl.NumberFormat('ja-JP', { style: 'currency', currency: 'JPY' }).format(n);
const phaseTitles = { stopped: 'Pronto quando lo sei tu.', stopping: 'Chiudo i controlli.', preparing: 'Preparo la sessione.', watching: 'In ascolto della disponibilità.', checkout: 'Il tuo ritiro prende forma.', 'payment-observation': 'Ora tocca ad Apple Pay.', intervention: 'Serve il tuo intervento.', success: 'Acquisto confermato.' };
const nodePhases = { standby:'Riserva pronta', unverified: 'Da verificare', ready: 'Verificato', reserve: 'Riserva', checking: 'Controllo in corso', cooldown: 'Attesa del nodo', recovering: 'In recupero', retiring: 'Chiusura controllo', offline: 'Non raggiungibile', blocked: 'Pausa Apple' };
const contactKeys = ['lastName','firstName','emailAddress','mobilePhone'];
let contactDirty = false, contactSaving = false;
let state, variants = [], pending = false, initialized = false, catalogStamp = null, seenNotices = new Set(), configuring = false, configSequence = 0, connectionLost = false;
function error(message) { $('error').hidden = !message; $('error').textContent = message ?? ''; }
async function api(path, body) { const r = await fetch(path, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const data = await r.json(); if (!r.ok) throw Error(data.error ?? 'Operazione non completata.'); return data; }
function options(element, values, selected, empty) { element.replaceChildren(); if (!values.length) { const o = document.createElement('option'); o.textContent = empty; element.append(o); return; } for (const [value, label] of values) { const o = document.createElement('option'); o.value = value; o.textContent = label; o.selected = value === selected; element.append(o); } }
function lockControls() { const locked = !state || state.enabled || state.payment.phase === 'intent' || state.payment.phase === 'waiting' || state.payment.phase === 'uncertain' || configuring || pending; for (const k of contactKeys) $('pickup-' + k).disabled = locked || contactSaving; for (const id of ['category', 'product', 'configuration','alternative-configuration']) $(id).disabled = locked || !$(id).options.length; for (const e of $('store-options').querySelectorAll('input')) e.disabled = locked; $('activation').disabled = pending || !state || !state.selection || !state.catalog.updatedAt || configuring || contactDirty || contactSaving || state?.payment.verification; }
async function loadConfigurations(productId, selectedSKU) {
  const sequence = ++configSequence; configuring = true; lockControls();
  try { const data = await api('/api/catalog/configurations?productId=' + encodeURIComponent(productId)); if (sequence !== configSequence) return; variants = data.configurations; options($('configuration'), variants.map(v => [v.sku, v.name + ' · ' + yen(v.priceJPY)]), selectedSKU, 'Configurazioni non disponibili'); renderAlternatives(); }
  catch (e) { if (sequence === configSequence) { variants = []; options($('configuration'), [], null, 'Catalogo non verificabile'); error(e.message); } }
  finally { if (sequence === configSequence) { configuring = false; lockControls(); } }
}
function renderAlternatives() {
  const primary=variants.find(v=>v.sku===$('configuration').value);
  const eligible=primary&&/256\s*GB/i.test(primary.name)?variants.filter(v=>v.sku!==primary.sku&&v.priceJPY===primary.priceJPY&&/256\s*GB/i.test(v.name)):[];
  const chosen=$('alternative-configuration').value||state.selections?.[1]?.sku||'';
  options($('alternative-configuration'),[['','Solo la configurazione principale'],...eligible.map(v=>[v.sku,v.name])],eligible.some(v=>v.sku===chosen)?chosen:'','');
}
function productOptions(category, selected) { const products = state.catalog.products.filter(p => p.category === category); options($('product'), products.map(p => [p.id, p.name]), selected, 'Nessun prodotto disponibile'); }
async function saveSelection() {
  if (pending || configuring || !state || state.enabled) return;
  const sku = $('configuration').value, productId = $('product').value, stores = [...$('store-options').querySelectorAll('input:checked')].map(e => e.value);
  if (!variants.some(v => v.sku === sku) || !stores.length) return;
  pending = true; lockControls();
  try { const result = await api('/api/selection', { productId, sku, stores, alternativeSkus:$('alternative-configuration').value?[$('alternative-configuration').value]:[] }); state = { ...state, ...result }; error(null); renderState(); }
  catch (e) { error(e.message); } finally { pending = false; lockControls(); }
}
async function renderCatalog() {
  const selected = state.selection;
  options($('category'), state.catalog.categories.map(c => [c.id, c.name]), selected?.category, 'Catalogo in caricamento…');
  productOptions($('category').value, selected?.productId);
  $('store-options').replaceChildren();
  for (const store of state.stores) { const label = document.createElement('label'), input = document.createElement('input'); input.type = 'checkbox'; input.value = store.id; input.checked = selected?.stores.includes(store.id) ?? true; input.addEventListener('change', saveSelection); label.dataset.storeId = store.id; const name = document.createElement('span'), availability = document.createElement('span'); name.textContent = store.name; availability.className = 'store-availability'; availability.textContent = 'Da verificare'; label.append(input, name, availability); $('store-options').append(label); }
  if ($('product').value) await loadConfigurations($('product').value, selected?.sku);
  initialized = true; lockControls();
}
function renderState() {
  if (!state) return;
  document.body.classList.toggle('active', state.enabled); document.body.classList.toggle('attention', ['intervention','payment-observation'].includes(state.phase)); document.body.classList.toggle('success', state.phase === 'success');
  if (!contactDirty && !contactSaving) for (const k of contactKeys) $('pickup-' + k).value = state.pickupContact?.[k] ?? '';
  $('clock').textContent = state.time; $('activation').setAttribute('aria-pressed', String(state.enabled)); $('activation-label').textContent = state.enabled ? 'Attivo' : 'Attivazione'; $('activation').setAttribute('aria-label', state.enabled ? 'Attivo' : 'Attivazione');
  $('activation-note').textContent = state.enabled ? 'Ciclo attivo. Premi per disattivare.' : state.payment.phase === 'uncertain' ? 'Pagamento precedente ancora sotto osservazione.' : 'Attiva ricerca, mantenitore e checkout in un gesto.';
  $('phase-title').textContent = phaseTitles[state.phase] ?? state.phase; $('phase-badge').textContent = state.enabled ? state.phase === 'intervention' ? 'INTERVENTO RICHIESTO' : 'ATTIVO' : 'DISATTIVATO'; $('message').textContent = state.message;
  $('selected-name').textContent = state.selections?.length>1?state.selections.map(v=>v.name).join(' oppure '):state.selection?.name ?? 'Seleziona un prodotto'; $('selected-price').textContent = yen(state.selection?.priceJPY); $('selected-sku').textContent = state.selection ? (state.selections??[state.selection]).map(v=>v.sku).join(' · ') + ' · Apple Store Japan' + (state.selections?.length>1?' · 1 iPhone totale':'') : 'Apple Store Japan';
  $('catalog-status').textContent = state.catalog.loading ? 'AGGIORNAMENTO…' : state.catalog.updatedAt ? 'CATALOGO LIVE · APPLE JP' : 'CATALOGO NON VERIFICATO';
  $('safari-dot').classList.toggle('on', state.safari.bound); $('safari-state').textContent = state.safari.bound ? 'Collegato' : 'Da collegare'; $('keeper-dot').classList.toggle('on', state.keeper.enabled); $('keeper-state').textContent = state.keeper.phase === 'maintaining' ? 'In funzione' : state.keeper.enabled ? 'In attesa del checkout' : 'Fermo';
  const pickupReady=$('pickup-ready-note'),preparation=state.safari.pickupPreparation;
  if(pickupReady)pickupReady.textContent=({'stores-ready':'CAP applicato · '+(preparation?.storeCount??0)+' punti di ritiro caricati · Calendario dopo la disponibilità','store-selected':'Store selezionato · In attesa del calendario','calendar-ready':'Store selezionato · Calendario aperto','pickup-unavailable':'Ritiro temporaneamente non disponibile su Apple · Ricerca attiva','preparing':'Preparo CAP e lista degli Store…'})[preparation?.state]??'Preparazione del ritiro da verificare.';
  $('variant-readiness').textContent=state.selections?.length>1?'Primo colore disponibile · stop dopo il primo acquisto. '+(state.safari.variants??[]).map(v=>v.name+': '+(v.bound&&v.skuVerified&&v.fulfillmentMode==='pickup'?'ritiro preparato':'da preparare')).join(' · '):'';
  for (const e of document.querySelectorAll('.steps li')) e.classList.toggle('current', e.dataset.step === state.phase);
  const f = state.fleet;
  const stockInFlight = f.nodes.filter(n => n.phase === 'checking').length;
  const recoveryInFlight = Math.max(0, f.inFlight - stockInFlight);
  $('tunnels').textContent = f.uncertainTunnels === (f.workerCount??19) && !f.enabled ? '—' : f.verifiedTunnels; $('positions').textContent = f.assigned; $('inflight').textContent = stockInFlight; $('checks').textContent = state.statistics.checks.toLocaleString('it-IT');
  if ($('inflight-recovery')) $('inflight-recovery').textContent = 'Recuperi dei controlli: ' + recoveryInFlight;
  const rate = f.throughput; $('throughput-note').textContent = rate ? 'Ultimo minuto: ' + rate.validLastMinute + (state.selections?.length>1?' controlli validi totali sui due colori':' controlli validi') + ' · Limite teorico con ' + rate.samplingNodes + ' nodi: ' + rate.theoreticalPerMinute.toFixed(2).replace('.', ',') + '/min · Avvii separati da almeno ' + (rate.dispatchIntervalMs / 1000).toLocaleString('it-IT') + ' s' : '';
  $('fleet-note').textContent = f.block ?? (f.connected + ' tunnel collegati · '+(rate?.samplingNodes??f.assigned)+' nodi idonei alla ricerca · ' + (f.standbyReady??0) + ' riserve pronte · ' + f.verifiedTunnels + ' verificati · ' + f.uncertainTunnels + ' da riconciliare · 65 s per nodo dalla risposta');
  $('nodes').replaceChildren();
  if (f.recovering) $('fleet-note').textContent += ' · Recupero VPN in corso';
  for (const n of f.nodes) { const tile = document.createElement('div'); tile.className = 'node ' + n.phase + (n.id === 'mac' ? ' mac' : ''); const head = document.createElement('div'); head.className = 'node-head'; head.append(document.createElement('i'), document.createTextNode(n.id === 'mac' ? 'Mac' : n.name + (n.provider ? ' · ' + (n.provider==='windscribe'?'Windscribe':'NordVPN') : ''))); const count = document.createElement('span'); count.className = 'count'; count.textContent = n.checks; const phase = document.createElement('span'); phase.className = 'node-phase'; phase.textContent = n.pauseHttpStatus === 541 ? 'Pausa Apple 541 · ' + Math.max(0, Math.ceil((n.nextAllowedAt - Date.now()) / 1000)) + ' s' : n.connected === false && n.nextVpnAllowedAt > Date.now() ? 'Attesa VPN · ' + Math.ceil((n.nextVpnAllowedAt - Date.now()) / 1000) + ' s' : nodePhases[n.phase] ?? 'In verifica'; tile.append(head, count, phase); $('nodes').append(tile); }
  $('checkout-attempts').textContent = (state.statistics.checkoutAttempts ?? 0).toLocaleString('it-IT');
  const progress = state.statistics.checkoutProgress;
  for (const key of ['store','date','time']) $('selected-' + key + '-count').textContent = (progress?.[key] ?? 0).toLocaleString('it-IT');
  $('checkout-progress-note').textContent = progress ? 'Stadi osservati dal ' + progress.sinceJST + ', incluse selezioni già presenti nella pagina. Ogni fase conta una volta per tentativo. Nei tempi sono distinte le azioni automatiche.' : 'In attesa delle nuove statistiche di selezione.';
  $('tunnel-limit').textContent = '/ massimo ' + f.vpnLimit; $('position-limit').textContent = '/ ' + f.positions;
  const availableStores = [];
  for (const label of $('store-options').querySelectorAll('label[data-store-id]')) {
    const readings=(state.variantAvailability??[{sku:state.selection?.sku,name:state.selection?.name,stores:state.availability??[]}]).map(v=>({...v,result:v.stores.find(s=>s.id===label.dataset.storeId)}));
    const positives=readings.filter(v=>v.result?.observedAt!=null&&Date.now()-v.result.observedAt<=90000&&v.result.state==='available');
    const result=readings.map(v=>v.result).filter(Boolean).sort((a,b)=>(b.observedAt??0)-(a.observedAt??0))[0],fresh=readings.every(v=>v.result?.observedAt!=null&&Date.now()-v.result.observedAt<=90000),available=positives.length>0;
    label.classList.toggle('available', available); label.classList.toggle('attempting', state.checkoutStoreId === label.dataset.storeId);
    const text = available ? 'Disponibile'+(state.selections?.length>1?' · '+positives.map(v=>v.name).join(' / '):'') : fresh && result?.state === 'unavailable' ? 'Non disponibile' : 'Da verificare';
    label.querySelector('.store-availability').textContent = text; label.title = result?.observedAt ? 'Ultimo riscontro ' + new Intl.DateTimeFormat('it-IT', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(result.observedAt) + ' JST' : text;
    if (available) availableStores.push(state.stores.find(s => s.id === label.dataset.storeId)?.name ?? label.dataset.storeId);
  }
  if(state.availabilityQueue?.size)$('throughput-note').textContent+=' · '+state.availabilityQueue.size+' alternative fresche in coda';
  $('stock-signal').hidden = !availableStores.length; $('stock-signal').textContent = availableStores.length ? 'Disponibilità rilevata: Apple ' + availableStores.join(' · Apple ') : '';
  for (const key of ['attempts','failures','successes']) $(key).textContent = state.statistics[key].toLocaleString('it-IT');
  const timing = state.checkoutTiming; $('timing-breakdown').replaceChildren();
  if (timing) {
    $('timing-summary').textContent = 'Tentativo ' + timing.attempt + (state.selections?.length>1?' · '+(state.selections.find(v=>v.sku===timing.sku)?.name??timing.sku):'') + ' · ' + (timing.totalMs == null ? 'in corso' : (timing.totalMs / 1000).toFixed(2).replace('.', ',') + ' s') + (timing.code ? ' · ' + timing.code : '');
    const totals = new Map(); let storeResponseMs = 0, storeResponses = 0,sessionSwitchMs=null,storeNetwork=null,postalNetwork=null;
    if(timing.signalToStartMs!==undefined){const row=document.createElement('p');row.className='footnote';row.textContent='Avviso → inizio: '+timing.signalToStartMs+' ms · coda: '+(timing.queueWaitMs??0)+' ms · ricezione: '+(timing.signalAgeAtReceiptMs??0)+' ms'+(timing.endToEndMs!==undefined?' · avviso → esito: '+(timing.endToEndMs/1000).toFixed(2).replace('.',',')+' s':'');$('timing-breakdown').append(row);}
    for (const step of timing.steps ?? []) {
      // This retrospective network span overlaps the calendar reads/waits.
      // Show it separately so it cannot double the measured checkout time.
      if(step.name==='postal:response'){postalNetwork=step;continue;}
      if(step.name==='session:activate'){sessionSwitchMs=step.durationMs;continue;}
      if (step.name === 'calendar:store-response') { storeResponseMs += step.durationMs; storeResponses++;storeNetwork=step; continue; }
      const key = step.name.startsWith('calendar:') ? 'Calendario del ritiro' : step.name === 'dom:store' ? 'Scelta Store' : ['dom:fill-contact','dom:prepare-contact'].includes(step.name) ? 'Compilazione contatti' : step.name === 'native:press-apple-pay' ? 'Invio clic Apple Pay' : step.name === 'native:payment-status' ? 'Verifica finestra di pagamento' : step.name.startsWith('wait:') ? 'Attese della pagina' : step.name.startsWith('stock:') ? 'Sospensione ricerca' : 'Altri passaggi Safari'; totals.set(key, (totals.get(key) ?? 0) + step.durationMs);
    }
    for (const [name, ms] of [...totals].sort((a,b) => b[1]-a[1])) { const row = document.createElement('p'); row.className = 'footnote'; row.textContent = name + ': ' + (ms / 1000).toFixed(2).replace('.', ',') + ' s'; $('timing-breakdown').append(row); }
    for(const [label,step] of [['CAP',postalNetwork],['Store',storeNetwork]])if(step?.firstByteMs!==undefined){const row=document.createElement('p');row.className='footnote';row.textContent=label+' · attesa primo byte: '+step.firstByteMs+' ms · scaricamento: '+(step.downloadMs??0)+' ms · connessione: '+(step.connectMs??0)+' ms · già compresi';$('timing-breakdown').append(row);}
    if(sessionSwitchMs!==null){const row=document.createElement('p');row.className='footnote';row.textContent='Collegamento sessione: '+sessionSwitchMs+' ms · già compreso nei passaggi sopra';$('timing-breakdown').append(row);}
    if (storeResponses) { const row = document.createElement('p'); row.className = 'footnote'; row.textContent = 'Risposta Apple allo Store: ' + (storeResponseMs / 1000).toFixed(2).replace('.', ',') + ' s · già compresa nei passaggi sopra'; $('timing-breakdown').append(row); }
  }
  const inherited = state.statistics.previous;
  if (inherited) $('historical').textContent = 'Storico conservato: ' + (inherited.checks ?? 0).toLocaleString('it-IT') + ' controlli validi. ' + (inherited.dropCount ?? 0) + ' finestre di disponibilità. I dati personali della versione precedente sono stati rimossi.';
  const remaining = state.payment.recheckAt ? Math.max(0, Math.ceil((state.payment.recheckAt - Date.now()) / 1000)) : 0;
  $('payment-wait').textContent = state.payment.verification ? 'Prova Apple Pay: non confermare il pagamento. Il ciclo automatico è disattivato.' : state.phase === 'payment-observation' ? remaining ? 'Prima verifica della pagina fra ' + remaining + ' s. La conferma Apple Pay resta nelle tue mani.' : 'Verifico la pagina. Il carrello si ripristina solo a tentativo concluso.' : '';
  if (state.notifications.length) {
    $('notices').replaceChildren();
    for (const n of [...state.notifications].reverse().slice(0, 4)) { const row = document.createElement('div'); row.className = 'notice ' + n.type; const icon = document.createElement('span'); icon.textContent = n.type === 'success' ? '✓' : '↗'; const body = document.createElement('div'), p = document.createElement('p'), time = document.createElement('time'); p.textContent = n.message; time.textContent = new Intl.DateTimeFormat('it-IT', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(n.at) + ' JST'; body.append(p, time); row.append(icon, body); $('notices').append(row);
      if (!seenNotices.has(n.id)) { seenNotices.add(n.id); if ('Notification' in window && Notification.permission === 'granted') new Notification(n.type === 'success' ? 'Acquisto Apple confermato' : 'Apple Loop · Intervento richiesto', { body: n.message, tag: n.id }); }
    }
  }
  lockControls();
}
async function savePickupContact() {
  if (!state || state.enabled || contactSaving || !contactDirty) return;
  if (contactKeys.some(k => !$('pickup-' + k).checkValidity())) { $('contact-save-state').textContent = 'Completa tutti i dati di ritiro per salvarli.'; return; }
  const data = Object.fromEntries(contactKeys.map(k => [k, $('pickup-' + k).value.trim()]));
  contactSaving = true; lockControls(); $('contact-save-state').textContent = 'Salvataggio…';
  try { const result = await api('/api/pickup-contact', data); state = { ...state, ...result }; contactDirty = false; $('contact-save-state').textContent = 'Dati salvati. Safari li compilerà automaticamente.'; error(null); }
  catch (e) { $('contact-save-state').textContent = 'Dati non salvati.'; error(e.message); }
  finally { contactSaving = false; lockControls(); }
}
for (const k of contactKeys) { $('pickup-' + k).addEventListener('input', () => { contactDirty = true; $('contact-save-state').textContent = 'Modifiche da salvare: completa il campo.'; lockControls(); }); $('pickup-' + k).addEventListener('change', () => { void savePickupContact(); }); }
$('category').addEventListener('change', async () => { productOptions($('category').value); await loadConfigurations($('product').value); await saveSelection(); });
$('product').addEventListener('change', async () => { await loadConfigurations($('product').value); await saveSelection(); });
$('configuration').addEventListener('change',()=>{renderAlternatives();void saveSelection();});
$('alternative-configuration').addEventListener('change',saveSelection);
$('activation').addEventListener('click', async () => {
  if (pending || !state) return; pending = true; lockControls();
  if (!state.enabled && 'Notification' in window && Notification.permission === 'default') void Notification.requestPermission();
  try { const result = await api('/api/activation', { enabled: !state.enabled }); state = { ...state, ...result }; error(null); renderState(); } catch (e) { error(e.message); } finally { pending = false; lockControls(); }
});
let polling = false;
async function poll() { if (polling) return; polling = true; try { const fresh = await api('/api/state'); state = fresh; if (connectionLost) { error(null); connectionLost = false; } renderState(); if (fresh.catalog.updatedAt && (!initialized || catalogStamp !== fresh.catalog.updatedAt)) { catalogStamp = fresh.catalog.updatedAt; await renderCatalog(); } } catch { connectionLost = true; error('Collegamento all’app interrotto. Riconnessione in corso…'); $('activation').disabled = true; } finally { polling = false; } }
void poll(); setInterval(poll, 2000);
