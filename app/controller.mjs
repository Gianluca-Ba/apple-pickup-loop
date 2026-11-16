import { AvailabilityQueue } from './availability-queue.mjs';
import { readNativeWalletFailure, WALLET_EVIDENCE_WINDOW_MS } from './wallet-result.mjs';
import { randomUUID } from 'node:crypto';
import { statfsSync } from 'node:fs';
import { validateSelection, validatePickupContact, jst } from './shared.mjs';
export const MESSAGES = Object.freeze({
  PRODUCT_IDENTITY_UNVERIFIED: 'Il prodotto nel profilo Safari non corrisponde al colore selezionato. Verifica il carrello dedicato prima di riprendere.',
  TOTAL_CHANGED: 'Il totale in alto a destra non corrisponde all’importo atteso.',
  SESSION_EXTENSION_REQUIRED: 'L’avviso di inattività Apple richiede un intervento per estendere la sessione in Safari.',
  POSTAL_REFRESH_UNCERTAIN: 'L’aggiornamento della disponibilità tramite CAP non è ancora verificato. Controlla la pagina del ritiro in Safari.',
  POSTAL_CONTROL_CHANGED: 'Il controllo per modificare o applicare il CAP non è disponibile nella pagina del ritiro.',
  SAFARI_SCRIPT_UNAVAILABLE: 'Safari non ha restituito la lettura della pagina. Attendo e verifico di nuovo il checkout esistente.',
  SAFARI_ROUTE_CHANGED: 'Safari non restituisce una pagina Apple valida. Se la navigazione privata è bloccata, sbloccala con Touch ID o password macOS.',
  STORE_UNVERIFIED: 'Lo Store selezionato non è più verificabile nella pagina del ritiro.',
  PICKUP_CALENDAR_TIMEOUT: 'Apple non ha reso disponibile il calendario di ritiro entro l’attesa prevista. Verifico il checkout esistente.',
  PICKUP_ACCEPTANCE_UNVERIFIED: 'Apple non ha ancora confermato il ritiro selezionato nel passaggio ai dati di contatto.',
  PICKUP_VALIDATION_REQUIRED: 'Apple non ha accettato i dati di ritiro: verifica il messaggio mostrato in Safari.',
  LOGIN_REQUIRED: 'Completa l’accesso al tuo account Apple in Safari.',
  CONTACT_MANUAL: 'Completa i dati di ritiro direttamente in Safari.',
  BAG_CONFIGURATION_REQUIRED: 'Verifica in Safari che il carrello contenga solo il prodotto selezionato, quantità 1, senza servizi aggiuntivi.',
  REMOVE_SERVICE_MANUALLY: 'Rimuovi il servizio aggiuntivo dal carrello in Safari.',
  ACCESSIBILITY_REQUIRED: 'Il processo dell’app richiede il permesso Accessibilità nelle impostazioni di macOS.',
  SAFARI_AX_UNAVAILABLE: 'Verifica temporaneamente incompleta delle finestre di Safari. Attendo una lettura valida prima di agire.',
  SAFARI_TAB_CHANGED: 'La scheda Safari dedicata non è verificabile. Controllo il collegamento alla finestra esistente.',
  SAFARI_TAB_REQUIRED: 'Apri una finestra Safari dedicata con una sola scheda Apple Store Giappone.',
  SAFARI_NOT_RUNNING: 'Apri Safari con una finestra dedicata ad Apple Store Giappone.',
  EXISTING_CHECKOUT: 'È presente un checkout precedente: completalo o annullalo in Safari.',
  APPLE_PAY_UNAVAILABLE: 'Verifica Apple Pay in Safari. L’app non richiede dati della carta.',
  APPLE_PAY_OBSERVER_UNAVAILABLE: 'Safari non consente di verificare gli eventi Apple Pay. Controlla il checkout prima di riprendere.',
  APPLE_PAY_ROUTE_REQUIRED: 'Safari deve usare il percorso Apple Pay diretto del carrello. Il checkout ordinario non è consentito.',
  PAYMENT_UNCERTAIN: 'Esito Apple Pay ancora da verificare. Controlla Safari: il tentativo resta sotto osservazione.',
  PAYMENT_INPUT_RECONCILING: 'Clic Apple Pay rifiutato da Safari. Verifico la pagina prima di riprendere.',
  PAYMENT_FAILURE_SETTLING: 'Wallet ha segnalato un fallimento. Verifico che l’esito resti stabile.',
  PAYMENT_AUTHORIZE: 'Autorizza il pagamento Apple Pay sul tuo dispositivo.',
  PRODUCT_CONFIGURATION_UNVERIFIED: 'Verifica e aggiungi in Safari la configurazione scelta dal catalogo.',
  PRODUCT_CONFIGURATION_REQUIRED: 'Completa la configurazione del prodotto in Safari e aggiungilo al carrello.',
  FINAL_REVIEW_REQUIRED: 'Verifica il riepilogo Apple Pay in Safari.',
  REVIEW_CHANGED: 'Il riepilogo Apple non corrisponde a prodotto, prezzo e Store selezionati.',
  CATALOG_UNAVAILABLE: 'Il catalogo Apple non è al momento verificabile.',
  HOST_DISK_LOW: 'Spazio disco del Mac quasi esaurito. Porta lo spazio libero ad almeno 3 GB per riprendere la ricerca.',
  HOST_DISK_CHECK_REQUIRED: 'Impossibile verificare lo spazio libero. Controlla il disco del Mac prima di riprendere la ricerca.',
});
export function paymentDecision({ page, ui, elapsed, stable = false, opened = false, notDispatched = false }) {
  if (page?.confirmation && page.phase === 'success') return 'success';
  if (!ui?.known || ui.active || page?.pending || !page?.ready) return 'wait';
  // The native transport can prove that a rejected click never reached the
  // event queue. The original document must independently still show no session.
  if (elapsed < 30000) {
    return elapsed >= 2000 && stable && notDispatched && !opened &&
      page.inputRejectionReady === true && !page.paymentObserved && !page.paymentActive &&
      !page.paymentCompleted && !page.paymentSucceeded && !page.paymentCancelled ? 'retry' : 'wait';
  }
  // A merchant success still needs an order confirmation. Never retry it on a
  // later cancellation callback, stock warning, or incomplete redirect.
  if (page.paymentSucceeded === true) return 'uncertain';
  if (stable && page.paymentFailed === true) return 'retry';
  if(stable&&notDispatched&&!opened&&['contact','billing','review','pickup','expired','unavailable','bag'].includes(page.phase)&&!page.paymentObserved&&!page.paymentActive&&!page.paymentCompleted)return 'retry';
  if (stable && (page.terminalFailure || page.paymentCancelledBeforeAuthorization === true)) return 'retry';
  // An explicit APW fulfillment rejection before any observed payment opening
  // is different from stock merely disappearing after a payment intent.
  if (stable && !opened && page.prePaymentRejection) return 'retry';
  return 'uncertain';
}
export class PurchaseController {
  constructor({ storage, safari, fleet, catalog, notify = () => {}, now = Date.now, onChange = () => {}, readWalletFailure = readNativeWalletFailure, readDiskBytes = () => { const s = statfsSync(storage.directory ?? process.cwd()); return s.bavail * s.bsize; } }) {
    Object.assign(this, { storage, safari, fleet, catalog, notify, now, onChange, readDiskBytes }); this.enabled = false; this.phase = 'stopped'; this.message = 'Seleziona il prodotto e premi Attivazione.'; this.busy = false; this.nextTick = 0; this.notifications = []; this.lastNotice = null; this.current = null; this.stablePayment = null; this.generation = 0; this.availability = new Map();
    if (['intent', 'waiting', 'uncertain'].includes(storage.guard.phase)) { this.phase = 'payment-observation'; this.message = MESSAGES.PAYMENT_UNCERTAIN; this.current = { id: storage.guard.attempt.id, pressedAt: storage.guard.attempt.pressedAt, storeId: storage.guard.attempt.storeId, recovered: true, ...(storage.guard.attempt.openedAt ? { openedAt: storage.guard.attempt.openedAt } : {}), ...(storage.guard.attempt.alertedAt ? { alertedAt: storage.guard.attempt.alertedAt } : {}), ...(storage.guard.attempt.dispatchRejected===true?{dispatchRejected:true}:{}), ...(storage.guard.attempt.selection ? { selection: storage.guard.attempt.selection } : {}), ...(storage.guard.attempt.purpose === 'open-apple-pay-only' ? { purpose: 'open-apple-pay-only' } : {}) }; }
    if (storage.guard.phase === 'completed') { this.phase = 'success'; this.message = 'Acquisto già confermato da Apple. Ciclo concluso.'; }
    this.readWalletFailure = readWalletFailure;
    if (this.current) {
      this.currentStore=this.current.storeId;
      const a=storage.guard.attempt,at=a.nativeFailureAt;
      if (a.walletEvidenceInvalidated === true) this.current.walletEvidenceInvalidated = true;
      if(!this.current.walletEvidenceInvalidated&&Number.isSafeInteger(at)&&at>=this.current.pressedAt&&at<=this.now()){
        this.current.nativeFailureAt=at;
        if(a.nativeFailureNeedsRecheck===true)this.current.nativeFailureNeedsRecheck=true;
      }
    }
    this.signalQueue=new AvailabilityQueue({now:this.now,preferFreshest:()=>this.selections().length===1});
    safari.priorityCandidate=()=>this.peekCandidate();
    safari.configureSelections?.(this.selections());
    safari.onTiming = step => this.traceStep(step);
    safari.onAvailability = sample => this.safariAvailability(sample);
    safari.expected?.(this.current?.selection ?? storage.settings.selection, this.current?.storeId);
    if (this.current?.purpose) this.message = 'Prova Apple Pay sotto osservazione. Non confermare il pagamento.';
  }
  get pendingAvailability(){return this.peekCandidate();}
  set pendingAvailability(value){this.signalQueue??=new AvailabilityQueue({now:this.now,preferFreshest:()=>this.selections().length===1});this.signalQueue.clear();if(value)this.enqueueCandidate(value);}
  candidateUsable(v){const selection=this.selections().find(s=>s.sku===v.sku);if(!selection?.stores.includes(v.storeId)||this.safari.routeAvailable?.(v.sku)===false)return false;const latest=this.availability.get(this.availabilityKey(v.sku,v.storeId));return !(latest?.state==='unavailable'&&latest.at>=v.observedAt);}
  peekCandidate(){this.signalQueue?.prune(v=>this.candidateUsable(v));return this.signalQueue?.peek()??null;}
  enqueueCandidate(value){const sku=value.sku??this.storage.settings.selection.sku;for(const storeId of new Set([value.storeId,...(value.alternatives??[])])){if(storeId===this.currentStore&&sku===this.checkoutSelection?.sku)continue;this.signalQueue.push({...value,sku,storeId});}this.signalQueue.prune(v=>this.candidateUsable(v));}
  pauseStock(){const drain=this.fleet.quiesce?this.fleet.quiesce():this.fleet.stop();this.stockDrain=Promise.resolve(drain).catch(()=>{this.stockDrainUnverified=true;});}
  selections() { return [this.storage.settings.selection, ...(this.storage.settings.alternativeSelections ?? [])].filter(Boolean).map(s => ({ ...s, stores:this.storage.settings.selection.stores, ...((this.storage.settings.alternativeSelections?.length ?? 0) ? { requireProductIdentity:true } : {}) })); }
  prepaymentGuardClear() {
    const {phase,attempt}=this.storage.guard;
    // A reviewed failure remains in the journal until a later payment intent.
    // It is no longer a reason to suppress safe pre-payment reads or recovery.
    return phase==='idle'||(phase==='failed'&&!this.current&&!attempt?.purpose&&
      this.storage.statistics.successes===0&&['native-wallet-completed-failure','operator-reviewed-pickup-refusal'].includes(attempt?.resolution?.source)&&
      attempt.resolution.reviewedNoOrder===true);
  }
  effectiveSelection() { return this.current?.selection ?? this.checkoutSelection ?? this.storage.settings.selection; }
  samplingSelection() { const all=this.selections(); return all.length > 1 ? all : all[0]; }
  availabilityKey(sku,id) { return this.selections().length > 1 ? sku + ':' + id : id; }
  snapshot() { const queued=this.pendingAvailability;return { version: 2, enabled: this.enabled, phase: this.phase, message: this.message, time: jst(this.now()), selection: this.storage.settings.selection, selections:this.selections(), targetQuantity:1, availabilityQueue:{size:this.signalQueue.size,oldestAgeMs:queued?Math.max(0,this.now()-queued.firstReceivedAt):0}, variantAvailability:this.selections().map(s => ({sku:s.sku,name:s.name,stores:s.stores.map(id=>{const v=this.availability.get(this.availabilityKey(s.sku,id));return{id,state:v&&this.now()-v.at<=90000?v.state:'unknown',observedAt:v?.at??null};})})), pickupContact: this.storage.settings.pickupContact, checkoutStoreId: this.currentStore ?? null, checkoutTiming: this.activeTrace ?? this.storage.checkoutTimings.at(-1) ?? null, availability: (this.storage.settings.selection?.stores ?? []).map(id => { const value = this.availability.get(this.availabilityKey(this.storage.settings.selection.sku,id)); return { id, state: value && this.now() - value.at <= 90000 ? value.state : 'unknown', observedAt: value?.at ?? null }; }), keeper: { enabled: this.enabled, phase: this.phase === 'watching' ? 'maintaining' : this.enabled ? 'waiting' : 'stopped', recoveries:this.keeperRecoveries??0,recoveryPending:this.keeperRecoveryPending===true,stockPaused:this.keeperStockPaused===true,lastRecoveryAtJST:this.keeperRecoveredAt===undefined?null:jst(this.keeperRecoveredAt),lastRecoveryCode:this.keeperRecoveryCode??null }, safari: this.safari.snapshot(), fleet: this.fleet.snapshot(), statistics: this.storage.statistics, notifications: this.notifications.slice(-20), payment: { phase: this.storage.guard.phase, verification: this.current?.purpose === 'open-apple-pay-only', requiresOperator: this.phase === 'payment-observation', recheckAt: this.current ? this.current.pressedAt + 30000 : null } }; }
  state(phase, message) { this.phase = phase; this.message = message; this.onChange(); }
  notice(type, code, message) {
    const key = type + ':' + code + ':' + (this.current?.id ?? ''); if (this.lastNotice === key) return;
    this.lastNotice = key; const n = { id: randomUUID(), type, code, message, at: this.now() }; this.notifications.push(n); this.notifications = this.notifications.slice(-30); this.notify(n); this.onChange();
  }
  async select(selection, alternatives = []) {
    if (this.enabled || this.busy || this.current || ['intent','waiting','uncertain'].includes(this.storage.guard.phase)) throw Error('SELECTION_LOCKED');
    validateSelection(selection);
    if (!Array.isArray(alternatives) || alternatives.length > 1) throw Error('SELECTION_INVALID');
    for (const a of alternatives) { validateSelection(a); if (a.sku === selection.sku || a.productId !== selection.productId || a.priceJPY !== selection.priceJPY || !/256\s*GB/i.test(a.name) || !/256\s*GB/i.test(selection.name)) throw Error('SELECTION_INVALID'); }
    this.availability.clear(); this.storage.settings.selection=selection; this.storage.settings.alternativeSelections=alternatives; this.safari.configureSelections?.(this.selections()); this.storage.saveSettings(); this.onChange();
  }
  async setPickupContact(contact) {
    if (this.enabled || this.busy || this.current || ['intent','waiting','uncertain'].includes(this.storage.guard.phase)) throw Error('SELECTION_LOCKED');
    this.storage.settings.pickupContact = validatePickupContact(contact); this.storage.saveSettings(); this.onChange();
  }
  async activation(enabled) {
    if (typeof enabled !== 'boolean') throw Error('ACTIVATION_INVALID');
    if (this.transition) throw Error('ACTIVATION_BUSY');
    if (!enabled) { this.enabled = false; this.generation++; this.pendingAvailability=null; this.state(this.current ? 'payment-observation' : 'stopping', this.current ? 'Disattivato. Osservo soltanto il pagamento già avviato.' : 'Chiusura ordinata dei controlli Linux…'); this.transition = true; try { await this.fleet.stop(); if (!this.current) this.state('stopped', 'Disattivato.'); } finally { this.transition = false; } return; }
    if (this.current?.purpose === 'open-apple-pay-only') throw Error('VERIFICATION_ACTIVE');
    if (this.storage.guard.phase === 'completed') throw Error('ORDER_ALREADY_CONFIRMED');
    if (this.enabled) return;
    validateSelection(this.storage.settings.selection);
    if (!this.storage.settings.pickupContact) throw Error('PICKUP_CONTACT_REQUIRED');
    if (!this.catalog.updatedAt || this.now() - this.catalog.updatedAt > 3600000) throw Error('CATALOG_REFRESH_REQUIRED');
    const s = this.storage.settings.selection, fresh = await this.catalog.resolve(s.productId, s.sku);
    if (fresh.priceJPY !== s.priceJPY) throw Error('CATALOG_PRICE_CHANGED');
    for (const a of this.selections().slice(1)) { const v=await this.catalog.resolve(a.productId,a.sku); if(v.priceJPY!==a.priceJPY)throw Error('CATALOG_PRICE_CHANGED'); }
    this.enabled = true; this.generation++; this.lastNotice = null;
    if (!this.current) {
      this.currentStore = null; this.checkoutSelection = null; this.pendingAvailability = null; this.pendingRecovery = null; this.stockPageRecovery = null; this.pickupRebuild = null; this.recoveredPickupReady = false; this.resumePhase = null; this.keeperRecoveryPending=false; this.keeperStockPaused=false; this.checkoutStartedAt = null;
      this.state('preparing', 'Collegamento Safari e verifica del carrello…');
    }
    this.nextTick = 0; this.onChange();
  }
  check(generation) { if (!this.enabled || generation !== this.generation) throw Error('STOPPED'); }
  diskReady() {
    if (this.current || this.currentStore || ['intent','waiting','uncertain'].includes(this.storage.guard.phase)) return true;
    let bytes;
    try { bytes = this.readDiskBytes(); } catch {}
    const known = Number.isSafeInteger(bytes) && bytes >= 0;
    if (known && bytes >= (this.waitingForDisk ? 3000000000 : 2000000000)) {
      if (this.waitingForDisk) {
        this.waitingForDisk = false; this.resumePhase = null;
        if (this.lastNotice?.startsWith('action:HOST_DISK_')) this.lastNotice = null;
      }
      return true;
    }
    if (!this.waitingForDisk) {
      this.waitingForDisk = true;
      try {
        const drain = this.fleet.quiesce ? this.fleet.quiesce() : this.fleet.stop();
        this.stockDrain = Promise.resolve(drain).catch(() => { this.stockDrainUnverified = true; });
      } catch { this.stockDrainUnverified = true; this.stockDrain = Promise.resolve(); }
    }
    this.pendingAvailability = null; this.resumePhase = null;
    const code = known ? 'HOST_DISK_LOW' : 'HOST_DISK_CHECK_REQUIRED';
    this.state('intervention', MESSAGES[code]); this.notice('action', code, MESSAGES[code]); return false;
  }
  async tick() {
    if (this.busy || this.now() < this.nextTick || !this.enabled && !this.current) return;
    this.busy = true; const generation = this.generation, check = () => this.check(generation), wasWatching = this.phase === 'watching' || this.phase === 'intervention' && this.resumePhase === 'watching';
    try {
      if (!this.diskReady()) return;
      // Native Apple Pay can remain open after its originating tab changes.
      // Observe the existing intent first; never rebind it to another tab.
      if (this.current) { await this.observePayment(); return; }
      if (this.pickupRebuild && this.fleet.paused) return;
      const preparingVariants = this.safari.prepareSelections && !wasWatching && !this.currentStore &&
        ['preparing', 'intervention'].includes(this.phase);
      if (!preparingVariants) await this.safari.bind();
      check();
      if (this.pendingRecovery && this.currentStore) {
        try { await this.recoverCheckout(this.pendingRecovery, check); }
        catch (error) { if (error.message === 'STOPPED' || !this.enabled) throw error; this.state('intervention', 'Verifica il checkout in Safari prima di riprendere.'); }
        return;
      }
      if (['preparing', 'intervention'].includes(this.phase) && !wasWatching) {
        if (this.currentStore) { await this.checkout(this.currentStore, check); return; }
        let preparation;
        if (this.safari.prepareSelections) {
          const rebuildSKU=this.pickupRebuild?.generation===generation&&this.prepaymentGuardClear()?this.pickupRebuild.sku:undefined;
          const checkPreparation = () => {
            check();
            if (rebuildSKU && this.fleet.paused) throw Error('STOPPED');
          };
          const onPreparedSibling = async () => {
            checkPreparation();
            if (this.current || this.currentStore || !this.prepaymentGuardClear()) throw Error('EXISTING_CHECKOUT');
            await this.fleet.start(this.samplingSelection());
            checkPreparation();
            this.state('preparing', 'Ricerca Linux attiva. Ripristino la pagina di ritiro in Safari…');
          };
          preparation = await this.safari.prepareSelections(
            this.selections(), checkPreparation, () => Boolean(this.pendingAvailability),
            { rebuildSKU, onPreparedSibling, allowPartial:this.prepaymentGuardClear() },
          );
          checkPreparation();
        }
        else { await this.safari.prepareBag(this.effectiveSelection(), check); check(); preparation=await this.safari.preparePickup?.(check,()=>Boolean(this.pendingAvailability)); }
        check();
        if (preparation?.waiting) {
          this.message = this.pickupRebuild && this.fleet.enabled
            ? 'Ricerca Linux attiva. Attendo il CAP e la lista Store in Safari…'
            : 'Attendo la preparazione del CAP e della lista Store in Safari…';
          return;
        }
        await this.fleet.start(this.samplingSelection()); check(); this.pickupRebuild=null; this.keeperStockPaused=false;
        this.state('watching', preparation?.partial ? 'Ricerca Linux attiva. Una sola finestra Safari è pronta per il ritiro.' : preparation?.pickupUnavailable?'Ricerca Linux attiva. Apple non offre ancora il ritiro: attendo una nuova disponibilità.':'Ricerca Linux attiva. Safari pronto per il ritiro con Apple Pay.');
      } else if (wasWatching) {
        const state = await this.safari.inspect();
        if (state.phase === 'authentication') throw Error('LOGIN_REQUIRED');
        if (state.paymentActive || ['contact', 'billing', 'review'].includes(state.phase)) { await this.fleet.stop(); throw Error('EXISTING_CHECKOUT'); }
        // A response may settle after abort preflight has quiesced dispatch.
        // Reconcile that transaction even when the page is no longer pending.
        if(this.keeperRecoveryPending&&!this.currentStore&&this.prepaymentGuardClear()&&this.safari.restoreStaleKeeper){
          await this.restoreKeeper(check);return;
        }
        if (state.pending && !state.sessionWarning) {
          this.message = 'Attendo il completamento del cambio fra ritiro e consegna.'; return;
        }
        if (['expired','unavailable','bag'].includes(state.phase)) {
          // Restoring this pre-payment Safari page is independent of guest
          // stock replies. Quiesce dispatch and retain the late-reply fence.
          const drain = this.fleet.quiesce ? this.fleet.quiesce() : this.fleet.stop();
          this.stockDrain = Promise.resolve(drain).catch(() => { this.stockDrainUnverified = true; });
          this.state('preparing', 'Ripristino del mantenitore…'); return;
        }
        // A fresh queued Store signal can use this verified resting pickup
        // page. The checkout still performs its own native payment guards;
        // skip redundant keeper reads before the finally block dispatches it.
        const queued=this.pendingAvailability;
        if (this.phase === 'watching' && queued && this.now() - queued.observedAt <= 5000 && state.phase === 'pickup' && state.fulfillmentMode === 'pickup' && state.ready !== false && !state.pending && !state.sessionWarning) return;
        const keepalive = this.safari.maintain ? await this.safari.maintain(check, () => Boolean(this.pendingAvailability)) : await this.safari.action('keepalive'); if (keepalive.manual) throw Error('SESSION_EXTENSION_REQUIRED');
        check();
        if (keepalive.expired) { this.pauseStock(); this.state('preparing','Sessione Apple scaduta. Ripristino il checkout senza ripetere un pagamento.'); return; }
        this.observationFailures = 0; this.resumePhase = null; this.state('watching', keepalive.partial ? 'Ricerca Linux attiva. Una sola finestra Safari è pronta per il ritiro.' : keepalive.pickupUnavailable?'Ricerca Linux attiva. Apple non offre ancora il ritiro: attendo una nuova disponibilità.':keepalive.waiting?'Ricerca Linux attiva. Preparo CAP e lista Store in Safari…':'Ricerca Linux attiva. Safari pronto per il ritiro con Apple Pay.');
      }
    } catch (e) {
      if(!this.keeperRecoveryPending&&!this.current&&wasWatching&&e.message==='PAGE_TRANSITION_UNCERTAIN'&&!this.currentStore&&this.prepaymentGuardClear()&&this.safari.restoreStaleKeeper){
        this.keeperRecoveryPending=true;
        try{await this.restoreKeeper(check);return;}catch(error){if(error.message==='STOPPED'||!this.enabled)return;}
      }
      if (!this.current && wasWatching && ['SAFARI_SCRIPT_UNAVAILABLE','SAFARI_UNCERTAIN','SAFARI_AX_UNAVAILABLE'].includes(e.message)) {
        this.observationFailures = (this.observationFailures ?? 0) + 1;
        if (this.observationFailures >= 3) { this.message = 'Safari temporaneamente non verificabile. Ripeto l’osservazione senza riaprire il checkout.'; this.notice('action','SAFARI_OBSERVATION_DELAY',this.message); }
        return;
      }
      if (e.message === 'SAFARI_ROUTE_CHANGED' && wasWatching && !this.current && !this.currentStore &&
          this.enabled && !this.fleet.paused && this.prepaymentGuardClear() &&
          this.selections().length === 2 && this.safari.prepareSelections) {
        this.resumePhase = null;
        this.state('preparing', 'Verifico quale finestra Safari può continuare il ritiro.');
        this.notice('action', e.message, MESSAGES[e.message]);
        return;
      }
      if (this.current) { this.storage.setGuard('uncertain', this.guardAttempt()); this.state('payment-observation', MESSAGES.PAYMENT_UNCERTAIN); this.notice('action', 'PAYMENT_UNCERTAIN', MESSAGES.PAYMENT_UNCERTAIN); }
      else if (e.message !== 'STOPPED' && this.enabled) {
        if (this.pickupRebuild && this.fleet.enabled && !this.fleet.paused) this.pauseStock();
        if (this.currentStore) this.recordCheckoutEvent(e.message);
        if (['STOCK_FAILED','PREORDER_SESSION_EXPIRED','PREORDER_PAGE_UNAVAILABLE','POSTAL_REFRESH_UNCERTAIN'].includes(e.message) && this.currentStore) {
          try { await this.recoverCheckout(e.message, check); return; }
          catch (error) { if (error.message === 'STOPPED' || !this.enabled) return; this.state('intervention', 'Verifica il checkout in Safari prima di riprendere.'); this.notice('action', 'CHECKOUT_CHECK_REQUIRED', this.message); return; }
        }
        if (wasWatching) this.resumePhase = 'watching';
        this.state('intervention', MESSAGES[e.message] ?? 'Intervento richiesto in Safari: verifica lo stato della pagina Apple.');
        this.notice('action', /^[A-Z][A-Z_0-9]{0,79}$/.test(e.message) ? e.message : 'SAFARI_CHECK_REQUIRED', this.message);
      }
    } finally { this.finishWork(this.current ? 1000 : 5000); }
  }
  async restoreKeeper(check) {
    let paused=false;const pause=()=>{if(!paused){this.keeperStockPaused=true;this.pauseStock();paused=true;}};
    const result=await this.safari.restoreStaleKeeper(check,pause);check();
    if(!result.needsPreparation&&this.keeperStockPaused){
      await this.fleet.start(this.samplingSelection());check();this.keeperStockPaused=false;
    }
    this.keeperRecoveryPending=false;this.resumePhase=null;
    this.keeperRecoveries=(this.keeperRecoveries??0)+1;this.keeperRecoveredAt=this.now();
    this.keeperRecoveryCode=result.aborted?'STALE_KEEPER_ABORTED':result.needsPreparation?'KEEPER_REPREPARATION':'LATE_PICKUP_VERIFIED';
    if(result.needsPreparation){pause();this.state('preparing','Ripristino della pagina di ritiro dopo una transizione del mantenitore non confermata.');}
    else this.state('watching','Mantenitore riconciliato. Ricerca Linux attiva e Safari sul ritiro.');
  }
  finishWork(delayMs) {
    const resume = this.recoveredPickupReady === true;
    const reprepare = this.verifiedBagGeneration === this.generation && this.enabled && !this.transition && !this.current && !this.currentStore && this.phase === 'preparing' && this.prepaymentGuardClear();
    const observeOpening = this.current && this.fastWalletPoll === this.current && this.storage.guard.phase === 'waiting';
    this.recoveredPickupReady = false; this.verifiedBagGeneration = undefined;
    this.fastWalletPoll = null;
    this.busy = false; this.nextTick = this.now() + (resume || reprepare || observeOpening ? 0 : delayMs);
    this.onChange(); this.dispatchPendingAvailability();
    // Re-enter the normal guarded checkout path; never open payment from a
    // recovery catch handler where an uncertain intent could be overlooked.
    if (resume && this.enabled) void this.tick();
  }
  safariAvailability(sample) {
    if(!this.enabled||this.phase!=='watching'||this.current||this.currentStore||!this.prepaymentGuardClear())return false;
    if(sample?.origin!=='safari-pickup-response'||!Number.isSafeInteger(sample.observedAt)||this.now()-sample.observedAt<0||this.now()-sample.observedAt>5000||!Array.isArray(sample.stores)||!sample.stores.length||sample.stores.length>20||sample.stores.some(s=>s?.state!=='available'||!/^R\d{3}$/.test(s.id??'')))return false;
    const selection=this.selections().find(s=>s.sku===sample.sku);if(!selection||sample.stores.some(s=>!selection.stores.includes(s.id)))return false;
    this.signal({sku:sample.sku,observedAt:sample.observedAt,stores:sample.stores.map(s=>({id:s.id,state:'available'}))},{countStockCheck:false});return true;
  }
  signal(sample,{countStockCheck=true}={}) {
    const selection=this.selections().find(s=>s.sku === sample.sku || !sample.sku && this.selections().length===1); if(!selection)return;
    const sku=selection.sku;
    const receivedAt=this.now();
    const at = Number.isFinite(sample.observedAt) ? Math.min(receivedAt, sample.observedAt) : receivedAt;
    for (const store of sample.stores) if (this.storage.settings.selection.stores.includes(store.id) && ['available','unavailable'].includes(store.state)) {
      const latest = this.availability.get(this.availabilityKey(sku,store.id));
      // Concurrent Linux replies may arrive out of order. A withdrawal wins
      // an equal timestamp; an older reply cannot revive or hide fresh stock.
      if (!latest || at > latest.at || at === latest.at && store.state === 'unavailable') this.availability.set(this.availabilityKey(sku,store.id), { state: store.state, at });
    }
    if(countStockCheck){this.storage.statistics.checksBySKU ??= {}; this.storage.statistics.checksBySKU[sku] = (this.storage.statistics.checksBySKU[sku] ?? 0) + 1;
    this.storage.statistics.checks++; this.storage.saveStatistics();} this.onChange();
    if (!this.enabled || this.current) return;
    const readyDuringRebuild = this.phase === 'preparing' && this.pickupRebuild?.generation === this.generation &&
      sku !== this.pickupRebuild.sku && !this.currentStore && this.fleet.enabled && !this.fleet.paused &&
      this.prepaymentGuardClear() && this.safari.readyForCheckout?.(sku);
    if (!['watching','checkout'].includes(this.phase) && !readyDuringRebuild) return;
    if (sample.canCheckout === false) {
      const alternate = sample.canQueueDuringCheckout === true && this.phase === 'checkout' &&
        this.currentStore && sku !== this.effectiveSelection().sku && this.prepaymentGuardClear();
      if (!alternate) return;
    }
    const [storeId, ...alternatives] = [...new Set(sample.stores.filter(s => s.state === 'available' && !(this.currentStore===s.id && this.checkoutSelection?.sku===sku) && this.storage.settings.selection.stores.includes(s.id) && this.availability.get(this.availabilityKey(sku,s.id))?.state === 'available').map(s => s.id))];
    if (!storeId || this.now() - at > 5000) return;
    this.enqueueCandidate({sku,storeId,observedAt:at,alternatives,receivedAt,requestStartedAt:sample.requestStartedAt,node:sample.node,blockedBy:this.busy?(this.phase==='checkout'?'checkout':'keeper'):'idle',...(!countStockCheck?{origin:'safari-pickup-response'}:{})});
    this.dispatchPendingAvailability();
  }
  dispatchPendingAvailability() {
    if(!this.enabled||this.current||['intent','waiting','uncertain','completed'].includes(this.storage.guard.phase)){this.pendingAvailability=null;return;}
    if(this.busy||this.currentStore||this.phase!=='watching')return;
    const sample=this.signalQueue.take(v=>this.candidateUsable(v));
    if(sample)this.startCheckout(sample.storeId,sample);
  }
  async preferPreparedStore(storeId, sample, selection, check) {
    if(!sample?.alternatives?.length||!this.safari.preferredPickupStore||!this.prepaymentGuardClear())return storeId;
    const candidates=[storeId,...sample.alternatives].filter(id=>this.candidateUsable({...sample,sku:selection.sku,storeId:id}));
    if(candidates[0]!==storeId)return null;
    if(candidates.length<2)return storeId;
    let preferred;
    try{preferred=await this.safari.preferredPickupStore(selection,candidates);}
    catch(error){if(['PAYMENT_ACTIVE','ACCESSIBILITY_REQUIRED','SAFARI_AX_UNAVAILABLE'].includes(error.message))throw error;}
    check();
    if(this.phase!=='watching'||this.current||this.currentStore||!this.prepaymentGuardClear()||this.now()-sample.observedAt>5000)return null;
    if(candidates.slice(1).includes(preferred)&&this.candidateUsable({...sample,sku:selection.sku,storeId:preferred})){
      this.enqueueCandidate({...sample,sku:selection.sku,storeId,alternatives:[]});
      this.checkoutSignal.preferredPreparedStore=true;
      return preferred;
    }
    return this.candidateUsable({...sample,sku:selection.sku,storeId})?storeId:null;
  }
  startCheckout(storeId, sample = null) {
    if (!this.enabled || this.busy || this.current || this.currentStore || this.phase !== 'watching' || ['intent','waiting','uncertain','completed'].includes(this.storage.guard.phase)) return;
    if (!this.diskReady()) return;
    const selection=this.selections().find(s=>s.sku===(sample?.sku??this.storage.settings.selection.sku)); if(!selection)return; this.checkoutSelection=selection;
    const [nextStoreId, ...alternatives] = sample?.alternatives ?? [];
    // Alternatives retain the original observation time; no request or retry
    // extends their freshness. Only verified pickup stock loss resumes them.
    if(nextStoreId)this.enqueueCandidate({...sample,sku:selection.sku,storeId:nextStoreId,alternatives});
    this.signalQueue.remove(selection.sku,storeId);
    this.checkoutSignal=sample?{...sample,receivedAt:sample.receivedAt??this.now(),firstReceivedAt:sample.firstReceivedAt??sample.receivedAt??this.now()}:null;
    const generation = this.generation; this.busy = true;
    const check=()=>this.check(generation);
    const start=async()=>{
      const chosen=sample?.alternatives?.length&&this.safari.preferredPickupStore?await this.preferPreparedStore(storeId,sample,selection,check):storeId;
      if(!chosen){this.checkoutSelection=null;this.checkoutSignal=null;return;}
      this.signalQueue.remove(selection.sku,chosen);
      await this.checkout(chosen,check);
    };
    void start().catch(async e => {
      if (this.current) {
        this.storage.setGuard('uncertain', this.guardAttempt());
        const rejected = this.current.dispatchRejected === true;
        this.state('payment-observation', rejected ? MESSAGES.PAYMENT_INPUT_RECONCILING : MESSAGES.PAYMENT_UNCERTAIN);
        if (!rejected) this.notice('action', 'PAYMENT_UNCERTAIN', this.message);
      }
      else if (e.message !== 'STOPPED' && this.enabled) {
        if (this.currentStore) this.recordCheckoutEvent(e.message);
        else { this.checkoutSelection=null;this.checkoutSignal=null; }
        if (['STOCK_FAILED','PREORDER_SESSION_EXPIRED','PREORDER_PAGE_UNAVAILABLE','POSTAL_REFRESH_UNCERTAIN'].includes(e.message)) {
          try { await this.recoverCheckout(e.message, () => this.check(generation)); }
          catch (error) { if (error.message === 'STOPPED' || !this.enabled) return; this.state('intervention','Verifica il checkout in Safari prima di riprendere.'); this.notice('action','CHECKOUT_CHECK_REQUIRED',this.message); }
        }
        else { this.state('intervention', MESSAGES[e.message] ?? 'Verifica il checkout in Safari per continuare.'); this.notice('action', Object.hasOwn(MESSAGES, e.message) ? e.message : 'CHECKOUT_CHECK_REQUIRED', this.message); }
      }
    }).finally(() => this.finishWork(1000));
  }
  traceStep(step) {
    if (!this.activeTrace) return;
    this.activeTrace.steps.push({ ...step, offsetMs: Math.max(0, this.now() - this.traceStartedAt - step.durationMs) });
    // Preserve the initial CAP/Store evidence when a long retry fills the log.
    if (this.activeTrace.steps.length > 300) this.activeTrace.steps = [...this.activeTrace.steps.slice(0, 60), ...this.activeTrace.steps.slice(-240)];
  }
  finishCheckoutTrace(code) {
    if (!this.activeTrace) return;
    const trace = this.activeTrace; this.activeTrace = null;
    trace.code = /^[A-Z][A-Z_0-9]{0,79}$/.test(code) ? code : 'CHECKOUT_ERROR';
    trace.endedAtJST = jst(this.now()); trace.totalMs = Math.max(0, this.now() - this.traceStartedAt);
    if(trace.signalToStartMs!==undefined)trace.endToEndMs=trace.signalToStartMs+trace.totalMs;
    this.storage.saveCheckoutTiming(trace);
  }
  recordCheckoutEvent(code, stage = 'before-payment') {
    if (!this.currentStore || !/^[A-Z][A-Z_0-9]{0,79}$/.test(code)) return;
    const history = this.storage.statistics.checkoutHistory;
    const event = { attempt: this.storage.statistics.checkoutAttempts, atJST: jst(this.now()), sku: this.effectiveSelection().sku, storeId: this.currentStore, stage, code, elapsedMs: Math.max(0, this.now() - (this.checkoutStartedAt ?? this.now())) };
    const last = history.at(-1);
    if (last?.attempt === event.attempt && last.storeId === event.storeId && last.code === event.code) return;
    const key = { PICKUP_STORE_SELECTED:'store', PICKUP_DATE_SELECTED:'date', PICKUP_TIME_SELECTED:'time' }[code];
    const progress = this.storage.statistics.checkoutProgress;
    if (key && event.attempt > 0 && progress.attempt <= event.attempt) {
      if (progress.attempt < event.attempt) { progress.attempt = event.attempt; progress.stages = []; }
      if (progress.stages.includes(key)) return;
      progress.stages.push(key); progress[key]++;
    }
    history.push(event); this.storage.statistics.checkoutHistory = history.slice(-100); this.storage.saveStatistics();
  }
  async recoverCheckout(code, check) {
    this.pendingRecovery = code;
    if(['POSTAL_REFRESH_UNCERTAIN','STOCK_FAILED'].includes(code)){
      check();const page=await this.safari.inspect();check();
      if(page.phase==='expired')code='PREORDER_SESSION_EXPIRED';
      else if(page.phase==='unavailable')code='PREORDER_PAGE_UNAVAILABLE';
    }
    if (['PREORDER_SESSION_EXPIRED','PREORDER_PAGE_UNAVAILABLE'].includes(code)) await this.resumeAfterExpiredSession(check);
    else if (code === 'POSTAL_REFRESH_UNCERTAIN') await this.resumeAfterPostalFailure(check);
    else if (code === 'STOCK_FAILED') await this.resumeAfterStockFailure(check);
    else throw Error('RECOVERY_INVALID');
    this.pendingRecovery = null;
  }
  async resumeAfterStockFailure(check) {
    const verify = async (phases = ['pickup']) => {
      check(); const ui = await this.safari.paymentStatus(), page = await this.safari.inspect(); check();
      if (this.current || ['intent','waiting','uncertain','completed'].includes(this.storage.guard.phase) || !ui.known || ui.active || page.pending || page.ready === false || !phases.includes(page.phase) || page.paymentObserved || page.paymentDispatched || page.paymentCompleted) throw Error('EXISTING_CHECKOUT');
      return page;
    };
    const matchingRecovery = this.stockPageRecovery?.storeId === this.currentStore && this.stockPageRecovery.startedAt === this.checkoutStartedAt;
    let page = await verify(matchingRecovery && this.stockPageRecovery.stage === 'bag' ? ['pickup','bag'] : ['pickup']);
    const prepareAgain = async () => {
      check();
      const rebuildSKU=this.effectiveSelection().sku;
      this.recordCheckoutEvent('PICKUP_PAGE_REBUILD_STARTED');
      if (this.currentStore) this.availability.set(this.availabilityKey(this.effectiveSelection().sku,this.currentStore), { state:'unavailable', at:this.now() });
      this.currentStore = null; this.checkoutSelection = null; this.stockPageRecovery = null; this.resumePhase = null;
      const alternative=this.pendingAvailability;
      if(alternative&&this.safari.readyForCheckout?.(alternative.sku)){this.state('watching','Passo alla disponibilità alternativa già preparata.');await this.fleet.start(this.samplingSelection());return;}
      this.pauseStock(); check();
      this.verifiedBagGeneration = this.generation;
      this.pickupRebuild = { generation:this.generation, sku:rebuildSKU };
      this.state('preparing', 'Apple ha mantenuto il rifiuto del ritiro. Ripristino la pagina Apple Pay e attendo un nuovo avviso.');
    };
    if (page.phase === 'bag') { await prepareAgain(); return; }
    this.recordCheckoutEvent('STOCK_FAILED');
    const sibling = this.pendingAvailability;
    const refusedSku = this.effectiveSelection().sku;
    if (sibling && sibling.sku !== refusedSku && this.prepaymentGuardClear() &&
        page.fulfillmentMode === 'pickup' && !page.paymentActive && this.safari.readyForCheckout?.(sibling.sku)) {
      this.recordCheckoutEvent('PICKUP_ALTERNATIVE_COLOUR_PRIORITY');
      this.availability.set(this.availabilityKey(refusedSku, this.currentStore), { state:'unavailable', at:this.now() });
      this.currentStore = null; this.checkoutSelection = null; this.stockPageRecovery = null; this.resumePhase = null;
      this.state('watching', 'Ritiro rifiutato. Passo all’altro colore già pronto in Safari.');
      await this.fleet.start(this.samplingSelection());
      return;
    }
    if (page.pickupUnavailable || page.stockFailure && page.errors > 0) {
      if (!matchingRecovery) this.stockPageRecovery = { storeId:this.currentStore, startedAt:this.checkoutStartedAt, stage:'mode' };
      if (page.pickupUnavailable && this.stockPageRecovery.stage === 'fresh-postal-refusal') this.recordCheckoutEvent('PICKUP_MODE_RECOVERY_SKIPPED');
      if (page.pickupUnavailable && this.stockPageRecovery.stage === 'mode') {
        this.stockPageRecovery.stage = 'mode-attempted';
        this.recordCheckoutEvent('PICKUP_MODE_RECOVERY_STARTED');
        await this.safari.refreshPickup(check); page = await verify();
        this.recordCheckoutEvent('PICKUP_MODE_RECOVERY_FINISHED');
      }
      if (page.pickupUnavailable || page.stockFailure || page.errors > 0) {
        if (this.stockPageRecovery.stage === 'bag') throw Error('EXISTING_CHECKOUT');
        this.stockPageRecovery.stage = 'bag';
        // This is a verified pre-payment refusal. Navigate once through the
        // normal bag route; a lost reply is observed rather than replayed.
        await this.safari.transition('navigate', {url:'https://www.apple.com/jp/shop/bag'}, ['bag'], check, {pollMs:100,accept:p=>!p.pending&&p.ready!==false});
        await prepareAgain(); return;
      }
      this.recordCheckoutEvent('PICKUP_PAGE_RESTORED');
    }
    if (this.stockPageRecovery && !this.stockPageRecovery.resumed && page.fulfillmentResponseVerified && page.fulfillmentMode === 'pickup' && !page.pickupUnavailable && !page.stockFailure && !page.errors && ['selected','unselected'].includes(page.storeState)) {
      this.stockPageRecovery.resumed = true; this.recoveredPickupReady = true; this.resumePhase = null;
      this.recordCheckoutEvent('PICKUP_AVAILABILITY_RECOVERED');
      this.state('preparing', 'Ritiro nuovamente disponibile nella risposta Apple. Riprendo la selezione dello Store e del calendario.'); return;
    }
    this.stockPageRecovery = null;
    if (this.currentStore) this.availability.set(this.availabilityKey(this.effectiveSelection().sku,this.currentStore), { state: 'unavailable', at: this.now() });
    this.currentStore = null; this.checkoutSelection = null; this.resumePhase = null; this.state('watching','Disponibilità terminata. Mantengo la pagina del ritiro e riprendo la ricerca.');
    await this.fleet.start(this.samplingSelection());
  }
  async resumeAfterPostalFailure(check) {
    const verify = async () => {
      check();
      if (this.current || ['intent','waiting','uncertain','completed'].includes(this.storage.guard.phase)) throw Error('EXISTING_CHECKOUT');
      const ui = await this.safari.paymentStatus(), page = await this.safari.inspect(); check();
      if (!ui.known || ui.active || page.pending || page.ready === false || page.phase !== 'pickup' || page.paymentObserved || page.paymentDispatched || page.paymentCompleted) throw Error('EXISTING_CHECKOUT');
      return page;
    };
    await verify();
    // Abandon this pre-payment availability query through the normal mode
    // transition, then await a fresh stock signal instead of resending CAP.
    await this.safari.refreshPickup(check);
    if ((await verify()).fulfillmentMode !== 'pickup') throw Error('EXISTING_CHECKOUT');
    this.recordCheckoutEvent('PICKUP_REFRESH_RECOVERED');
    this.availability.delete(this.availabilityKey(this.effectiveSelection().sku,this.currentStore));
    this.currentStore = null; this.checkoutSelection = null; this.resumePhase = null;
    await this.fleet.start(this.samplingSelection()); check();
    this.state('watching', 'Aggiornamento CAP ripristinato. Safari è sul ritiro e la ricerca è ripresa.');
  }
  async resumeAfterExpiredSession(check) {
    check(); const ui = await this.safari.paymentStatus(), page = await this.safari.inspect(); check();
    if (this.current || ['intent','waiting','uncertain','completed'].includes(this.storage.guard.phase) || !ui.known || ui.active || page.pending || page.ready===false || !['expired','unavailable'].includes(page.phase) || page.paymentObserved || page.paymentDispatched || page.paymentCompleted) throw Error('EXISTING_CHECKOUT');
    this.recordCheckoutEvent(page.phase === 'unavailable' ? 'PREORDER_PAGE_UNAVAILABLE' : 'PREORDER_SESSION_EXPIRED');
    this.currentStore = null; this.checkoutSelection = null; this.resumePhase = null; this.pendingAvailability = null;
    this.pauseStock(); check();
    this.state('preparing', 'Sessione Apple scaduta prima del pagamento. Ripristino il carrello e il checkout Apple Pay.');
  }
  guardAttempt() { return { id: this.current.id, pressedAt: this.current.pressedAt, storeId: this.current.storeId, ...(this.current.openedAt ? { openedAt: this.current.openedAt } : {}), ...(this.current.alertedAt ? { alertedAt: this.current.alertedAt } : {}), ...(this.current.dispatchRejected===true?{dispatchRejected:true}:{}), ...(this.current.walletEvidenceInvalidated===true?{walletEvidenceInvalidated:true}:{}), ...(this.current.nativeFailureAt?{nativeFailureAt:this.current.nativeFailureAt,...(this.current.nativeFailureNeedsRecheck===true?{nativeFailureNeedsRecheck:true}:{})}:{}), ...(this.current.selection ? { selection:this.current.selection } : {}), ...(this.current.purpose ? { purpose: this.current.purpose } : {}) }; }
  async checkout(storeId, check) {
    check();
    const first = !this.currentStore;
    // CHECKOUT_STARTED persists the increment and event together before any
    // Safari action, avoiding a second synchronous statistics write here.
    if (first) { this.stockPageRecovery = null; this.checkoutStartedAt = this.now(); this.storage.statistics.checkoutAttempts++; }
    this.currentStore = storeId;
    if (first) {
      this.recordCheckoutEvent('CHECKOUT_STARTED');
      if(this.checkoutSignal?.preferredPreparedStore)this.recordCheckoutEvent('PICKUP_PREPARED_STORE_PREFERRED');
    }
    this.state('checkout', 'Disponibilità trovata. Preparo il ritiro e Apple Pay…');
    this.traceStartedAt = this.checkoutStartedAt ?? this.now();
    const previousTrace = this.storage.checkoutTimings.at(-1);
    this.activeTrace = { attempt: this.storage.statistics.checkoutAttempts, sku: this.effectiveSelection().sku, storeId, startedAtJST: jst(this.traceStartedAt), steps: !first && previousTrace?.attempt === this.storage.statistics.checkoutAttempts && previousTrace.storeId === storeId ? [...previousTrace.steps] : [] };
    if(this.checkoutSignal){const v=this.checkoutSignal;Object.assign(this.activeTrace,{signalObservedAtJST:jst(v.observedAt),signalReceivedAtJST:jst(v.receivedAt),signalAgeAtReceiptMs:Math.max(0,v.receivedAt-v.observedAt),queueWaitMs:Math.max(0,this.traceStartedAt-v.firstReceivedAt),signalToStartMs:Math.max(0,this.traceStartedAt-v.observedAt),queueBlockedBy:v.blockedBy??'idle',...(v.node?{node:v.node}:{}),...(Number.isFinite(v.requestStartedAt)?{nodeRequestMs:Math.max(0,v.observedAt-v.requestStartedAt)}:{})});if(v.origin==='safari-pickup-response')this.traceStep({name:'signal:safari-pickup-response',durationMs:0,result:'ok',code:'FRESH_FULFILLMENT_RESPONSE'});}
    let outcome = 'CHECKOUT_FINISHED';
    try {
    const pauseAt = this.now();
    const drain = this.fleet.quiesce
      ? this.fleet.quiesce({ queueCheckoutAlternatives: this.selections().length === 2 })
      : this.fleet.stop();
    this.traceStep({ name: 'stock:pause-dispatch', durationMs: Math.max(0, this.now() - pauseAt), result: 'ok' });
    this.stockDrain = Promise.resolve(drain).catch(() => { this.stockDrainUnverified = true; });
    check(); this.recordCheckoutEvent('SAFARI_STARTED');
    this.safari.setPickupContact?.(this.storage.settings.pickupContact);
    const { store } = await this.safari.prepareCheckout(this.effectiveSelection(), storeId, check, code => { check(); this.recordCheckoutEvent(code); }); check();
    const attempt = { id: randomUUID(), pressedAt: this.now(), storeId, selection:this.effectiveSelection() };
    await this.safari.pressApplePay(this.effectiveSelection(), store, attempt.id, () => {
      check(); this.pendingAvailability = null; this.current = attempt; this.storage.setGuard('intent', this.guardAttempt());
      this.storage.statistics.attempts++; this.storage.saveStatistics();
    }, check);
    outcome = 'APPLE_PAY_DISPATCHED'; this.recordCheckoutEvent('APPLE_PAY_DISPATCHED', 'payment');
    this.storage.setGuard('waiting', this.guardAttempt()); this.state('payment-observation', 'Richiesta Apple Pay inviata. Verifico l’apertura della finestra; esito tra almeno 30 secondi.');
    } catch (error) {
      outcome = error.message;
      if(this.current&&error.notDispatched===true){this.current.dispatchRejected=true;this.storage.setGuard('uncertain',this.guardAttempt());}
      if (error.freshPickupRefusalVerified === true && !this.current && this.prepaymentGuardClear() && this.currentStore) {
        this.stockPageRecovery = { storeId:this.currentStore, startedAt:this.checkoutStartedAt, stage:'fresh-postal-refusal' };
        this.recordCheckoutEvent('PICKUP_FRESH_REFUSAL_VERIFIED');
      }
      throw error;
    }
    finally { this.finishCheckoutTrace(outcome); }
    if (outcome === 'APPLE_PAY_DISPATCHED' && this.current) {
      // The native click can return with Wallet already visible. Observe it
      // once now, without touching the page or waiting for the normal tick.
      const pending = this.current;
      try { this.noteNativeWalletOpening(await this.safari.paymentStatus(), pending); } catch {}
      if (this.current === pending && !pending.alertedAt) this.fastWalletPoll = pending;
    }
  }
  noteNativeWalletOpening(ui, attempt) {
    if (!attempt || this.current !== attempt || !ui?.known || !ui.active || ui.kind !== 'apple-pay') return;
    const firstSession = !attempt.openedAt;
    const firstAlert = !attempt.alertedAt;
    if (firstSession) attempt.openedAt = this.now();
    if (firstAlert) attempt.alertedAt = this.now();
    if (firstSession || firstAlert) this.storage.setGuard(this.storage.guard.phase, this.guardAttempt());
    if (firstAlert) {
      this.recordCheckoutEvent('APPLE_PAY_OPENED', 'payment');
      this.notice('action', 'PAYMENT_AUTHORIZE', MESSAGES.PAYMENT_AUTHORIZE);
    }
  }
  noteWalletObservationGap(ui) {
    this.stablePayment=null;
    const attempt=this.current;
    if(!attempt?.nativeFailureAt)return;
    // A real Wallet sheet, or an unclassified active sheet, invalidates
    // the prior evidence. An unreadable status or identified Safari modal
    // instead holds the same proof for a fresh, scoped log verification.
    if(ui?.known&&ui.active&&ui.kind!=='safari-modal'){
      delete attempt.nativeFailureAt;delete attempt.nativeFailureNeedsRecheck;
      attempt.walletEvidenceInvalidated=true;
      this.storage.setGuard('uncertain',this.guardAttempt());
      this.recordCheckoutEvent('APPLE_PAY_NATIVE_FAILURE_INVALIDATED','payment');
    }else if(!attempt.nativeFailureNeedsRecheck){
      attempt.nativeFailureNeedsRecheck=true;
      this.storage.setGuard('uncertain',this.guardAttempt());
      this.recordCheckoutEvent('APPLE_PAY_NATIVE_FAILURE_RECHECK_REQUIRED','payment');
    }
  }
  async observePayment() {
    if (this.current?.purpose === 'open-apple-pay-only') return this.observeVerification();
    const read=async run=>{
      try{return await run();}
      catch(error){this.noteWalletObservationGap();throw error;}
    };
    // A native authorization sheet can block Safari JavaScript. Observe and
    // announce the real sheet first, leaving its page untouched until it closes.
    const ui = await read(()=>this.safari.paymentStatus());
    this.noteNativeWalletOpening(ui, this.current);
    if (!ui?.known || ui.active) { this.noteWalletObservationGap(ui); return; }
    let page = await read(()=>this.safari.inspect({paymentContext:{id:this.current.id,pressedAt:this.current.pressedAt}}));
    const diagnosticCodes={PICKUP_UNAVAILABLE:'MERCHANT_PICKUP_UNAVAILABLE',PICKUP_OPTIONS_REJECTED:'MERCHANT_PICKUP_OPTIONS_REJECTED',PAYMENT_FAILURE:'MERCHANT_PAYMENT_FAILURE',SESSION_EXPIRED:'MERCHANT_SESSION_EXPIRED',STOCK_FAILURE_OBSERVED:'MERCHANT_STOCK_FAILURE_OBSERVED',TERMINAL_FAILURE_OBSERVED:'MERCHANT_TERMINAL_FAILURE_OBSERVED'};
    // Record live page flags as well as a retained observer result. These are
    // diagnostic enums only: a stock warning after authorization is never
    // evidence that payment failed or permission to retry the purchase.
    const diagnostics=[...(Array.isArray(page.merchantDiagnostics)?page.merchantDiagnostics:[]),...(page.pickupOptionsRejected===true?['PICKUP_OPTIONS_REJECTED']:[]),...(page.stockFailure===true?['STOCK_FAILURE_OBSERVED']:[]),...(page.terminalFailure===true?['TERMINAL_FAILURE_OBSERVED']:[])];
    for(const diagnostic of new Set(diagnostics)){const code=diagnosticCodes[diagnostic];if(code&&!this.storage.statistics.checkoutHistory.some(e=>e.attempt===this.storage.statistics.checkoutAttempts&&e.code===code))this.recordCheckoutEvent(code,'payment');}
    if (!this.current.openedAt && page.paymentObserved && page.paymentActive) {
      this.current.openedAt = this.now(); this.storage.setGuard(this.storage.guard.phase, this.guardAttempt());
      this.recordCheckoutEvent('APPLE_PAY_SESSION_STARTED', 'payment');
    }
    const alreadyConfirmed = this.storage.statistics.history.some(h => h.attempt === this.current.id && h.result === 'success');
    if (alreadyConfirmed && ui.known && !ui.active && !page.pending && ['bag','expired'].includes(page.phase)) {
      this.storage.setGuard('completed',this.guardAttempt());this.enabled=false;this.generation++;
      this.current=null;this.currentStore=null;this.stablePayment=null;this.state('success','Acquisto già confermato da Apple. Ciclo concluso.');await this.fleet.stop();return;
    }
    const quiet = ui.known && !ui.active && !page.pending && page.ready;
    const recheck=this.current.nativeFailureNeedsRecheck===true&&Boolean(this.current.nativeFailureAt);
    const now = this.now();
    const elapsed = now - this.current.pressedAt;
    const inEvidenceWindow = elapsed >= 30000 && elapsed <= WALLET_EVIDENCE_WINDOW_MS;
    // The Wallet journal can gain its terminal event after a quiet reading,
    // including after Safari has already replaced the payment page.
    const shouldCheck = inEvidenceWindow && !this.current.walletEvidenceInvalidated &&
      now >= (this.current.nativeFailureNextCheckAt ?? 0) &&
      (recheck ? (this.current.nativeFailureRechecks ?? 0) < 2 : !this.current.nativeFailureAt);
    if(quiet&&this.current.openedAt&&!page.confirmation&&!page.paymentFailed&&!page.paymentSucceeded&&!page.terminalFailure&&!page.paymentCancelledBeforeAuthorization&&shouldCheck){
      const previousFailureAt=this.current.nativeFailureAt;
      if (recheck) this.current.nativeFailureRechecks = (this.current.nativeFailureRechecks ?? 0) + 1;
      this.current.nativeFailureNextCheckAt = now + (recheck ? 2000 : 5000);
      let proof;try{proof=await this.readWalletFailure({pressedAt:this.current.pressedAt,openedAt:this.current.openedAt,now});}catch{}
      const freshUI=await read(()=>this.safari.paymentStatus());
      if(!freshUI?.known||freshUI.active){this.noteWalletObservationGap(freshUI);return;}
      if(proof?.source==='native-wallet-completed-failure'&&Number.isSafeInteger(proof.failedAt)&&proof.failedAt>=this.current.openedAt&&proof.failedAt<=this.now()&&(!recheck||proof.failedAt===previousFailureAt)){
        this.current.nativeFailureAt=proof.failedAt;delete this.current.nativeFailureNeedsRecheck;delete this.current.nativeFailureNextCheckAt;this.current.nativeFailureObservedAt=this.now();
        this.storage.setGuard(this.storage.guard.phase,this.guardAttempt());
        this.recordCheckoutEvent(recheck?'APPLE_PAY_NATIVE_FAILURE_REVERIFIED':'APPLE_PAY_NATIVE_FAILURE_VERIFIED','payment');
      }
    }
    const usableNativeFailure=this.current.nativeFailureNeedsRecheck?null:this.current.nativeFailureAt;
    if(quiet&&usableNativeFailure&&!page.paymentSucceeded)page={...page,paymentFailed:true};
    const signature = JSON.stringify({ phase: page.phase, terminalFailure: page.terminalFailure, paymentCancelled: page.paymentCancelledBeforeAuthorization, paymentFailed:page.paymentFailed,paymentSucceeded:page.paymentSucceeded,stockFailure: page.stockFailure, pickupOptionsRejected:page.pickupOptionsRejected, prePaymentRejection: page.prePaymentRejection, inputRejectionReady:page.inputRejectionReady });
    const stable = quiet && this.stablePayment?.signature === signature && this.now() - this.stablePayment.at >= 2000;
    if (!quiet || this.stablePayment?.signature !== signature) this.stablePayment = quiet ? { signature, at: this.now() } : null;
    const decision = paymentDecision({ page, ui, elapsed: this.now() - this.current.pressedAt, stable, opened: Boolean(this.current.openedAt),notDispatched:this.current.dispatchRejected===true });
    if (decision === 'wait') return;
    if (decision === 'success') {
      const stats = this.storage.statistics;
      if (!stats.history.some(h => h.attempt === this.current.id)) { stats.successes++; stats.history.push({ attempt: this.current.id, at: this.now(), sku: this.effectiveSelection().sku, storeId: this.current.storeId, result: 'success' }); stats.history = stats.history.slice(-500); this.storage.saveStatistics(); }
      this.storage.setGuard('completed', this.guardAttempt()); this.state('success', 'Acquisto completato e confermato da Apple.'); this.notice('success', 'ORDER_CONFIRMED', 'Acquisto completato e confermato da Apple.');
      this.enabled=false;this.generation++;this.current=null;this.currentStore=null;this.stablePayment=null;await this.fleet.stop();
      return;
    }
    if (decision === 'retry') {
      const inputRejected = this.current.dispatchRejected === true && !this.current.openedAt && page.inputRejectionReady === true;
      const reason = inputRejected ? 'APPLE_PAY_INPUT_REJECTED' :
        page.paymentFailed === true ? 'APPLE_PAY_COMPLETED_FAILED' :
        page.paymentCancelledBeforeAuthorization === true ? 'APPLE_PAY_CANCELLED' :
        page.terminalFailure ? 'APPLE_PAY_TERMINAL_FAILURE' :
        this.current.dispatchRejected === true ? 'APPLE_PAY_INPUT_REJECTED' : 'APPLE_PAY_PREPAYMENT_REJECTED';
      const stats = this.storage.statistics;
      const recorded = stats.checkoutHistory.some(e => e.attempt === stats.checkoutAttempts && e.stage === 'payment' && e.code === reason);
      if (!recorded) {
        stats.failures++;
        this.recordCheckoutEvent(reason, 'payment');
      }
      this.storage.setGuard('failed', this.guardAttempt());
      const generation = this.generation;
      const attempt = { attemptId:this.current.id, pressedAt:this.current.pressedAt };
      const terminalFailure = usableNativeFailure
        ? { ...attempt, source:'native-wallet-completed-failure', failedAt:usableNativeFailure }
        : reason === 'APPLE_PAY_INPUT_REJECTED' ? { ...attempt, source:'native-input-rejected' } : undefined;
      if (this.enabled) await this.safari.navigateBag(terminalFailure ? { terminalFailure } : {});
      this.current = null; this.currentStore = null; this.checkoutSelection = null; this.stablePayment = null;
      if (this.enabled) {
        this.storage.setGuard('idle');
        if (this.generation === generation) this.verifiedBagGeneration = generation;
        this.state('preparing', 'Tentativo concluso senza ordine. Riprendo dal carrello.');
      } else this.state('stopped', 'Disattivato. Il tentativo precedente è terminato.');
    } else {
      this.storage.setGuard('uncertain', this.guardAttempt());
      // A fresh, scoped Wallet failure still needs a second stable observation.
      // Keep the guard closed but avoid asking the owner to act during that
      // brief check. A conflicting or persistently unstable result still alerts.
      if (quiet && !stable && usableNativeFailure && !page.paymentSucceeded && this.now() - this.current.nativeFailureObservedAt < 3500) {
        this.state('payment-observation', MESSAGES.PAYMENT_FAILURE_SETTLING); return;
      }
      this.state('payment-observation', MESSAGES.PAYMENT_UNCERTAIN); this.notice('action', 'PAYMENT_UNCERTAIN', MESSAGES.PAYMENT_UNCERTAIN);
    }
  }
  async reconcileFailedPayment(proof) {
    // Explicit recovery after order-history review. Either Wallet proves the
    // failure or the operator confirms the refusal on the still-bound attempt.
    const blocked = () => Error('PAYMENT_RECONCILIATION_BLOCKED');
    const reviewedPickup = proof?.source === 'operator-reviewed-pickup-refusal';
    const valid = () => !this.enabled && !this.transition && this.current && !this.current.purpose &&
      this.storage.guard.phase === 'uncertain' && this.storage.guard.attempt?.id === this.current.id &&
      this.storage.statistics.successes === 0 && proof?.reviewedNoOrder === true && proof.attemptId === this.current.id &&
      (reviewedPickup ? proof.pickupRefusalReported === true :
        proof.source === 'native-wallet-completed-failure' && Number.isSafeInteger(proof.failedAt) &&
        proof.failedAt >= this.current.pressedAt && proof.failedAt <= this.now());
    if (this.busy || !valid()) throw blocked();
    this.busy = true;
    try {
      const ui = await this.safari.paymentStatus();
      if (!ui.known || ui.active) throw blocked();
      const page = await this.safari.inspect(reviewedPickup ? {
        guardPayment:true,observeAvailability:false,
        paymentContext:{id:this.current.id,pressedAt:this.current.pressedAt},
      } : undefined);
      if (!valid() || !page.ready || page.pending || page.confirmation || page.sessionWarning ||
          page.paymentObserved || page.paymentActive || page.paymentCompleted || page.paymentSucceeded) throw blocked();
      if (reviewedPickup) {
        if (page.phase !== 'pickup' || !page.applePayRoute || !page.paymentAttemptMatches ||
            !page.merchantDiagnostics?.includes('PICKUP_UNAVAILABLE') ||
            this.storage.statistics.history.some(h => h.attempt === this.current.id && h.result === 'success')) throw blocked();
      } else if (!['pickup','bag','expired','unavailable'].includes(page.phase) || page.paymentDispatched) throw blocked();
      const nativeAgain = await this.safari.paymentStatus();
      if (!valid() || !nativeAgain.known || nativeAgain.active) throw blocked();
      if (reviewedPickup) await this.safari.navigateBag({
        terminalFailure:{source:proof.source,attemptId:this.current.id,pressedAt:this.current.pressedAt},
      });
      if (!valid()) throw blocked();
      const code = reviewedPickup ? 'APPLE_PAY_PICKUP_REFUSAL_RECONCILED' : 'APPLE_PAY_NATIVE_FAILURE_RECONCILED';
      const stats = this.storage.statistics;
      if (!stats.checkoutHistory.some(e => e.attempt === stats.checkoutAttempts && e.code === code)) {
        stats.failures++;
        stats.checkoutHistory.push({attempt:stats.checkoutAttempts,atJST:jst(this.now()),sku:this.effectiveSelection().sku,storeId:this.current.storeId,stage:'payment',code,elapsedMs:Math.max(0,this.now()-this.current.pressedAt)});
        stats.checkoutHistory = stats.checkoutHistory.slice(-100); this.storage.saveStatistics();
      }
      this.storage.setGuard('failed', {...this.guardAttempt(),resolution:{source:proof.source,
        ...(reviewedPickup ? {reviewedAtJST:jst(this.now())} : {failedAtJST:jst(proof.failedAt)}),
        reviewedNoOrder:true}});
      this.current = null; this.currentStore = null; this.checkoutSelection = null; this.stablePayment = null;
      this.state('stopped',reviewedPickup ? 'Ritiro rifiutato e storico ordini controllato. Pronto a riprendere.' :
        'Fallimento Wallet verificato e storico ordini controllato. Pronto a riprendere.');
    } finally { this.busy = false; }
  }
  async observeVerification() {
    const ui = await this.safari.paymentStatus();
    if (!ui.known || ui.active) { this.state('payment-observation', ui.active && ui.kind === 'apple-pay' ? 'Prova: finestra Apple Pay aperta. Non confermare il pagamento.' : 'Prova Apple Pay sotto osservazione. Non confermare il pagamento.'); return; }
    const page = await this.safari.inspect();
    if (page.confirmation && page.phase === 'success') {
      const a = this.current, stats = this.storage.statistics;
      if (!stats.history.some(h => h.attempt === a.id)) { stats.successes++; stats.history.push({ attempt: a.id, at: this.now(), sku: a.selection.sku, storeId: a.storeId, result: 'success' }); this.storage.saveStatistics(); }
      this.storage.setGuard('completed', this.guardAttempt()); this.notice('success','ORDER_CONFIRMED','Acquisto completato e confermato da Apple.'); this.current = null; this.state('stopped','Acquisto confermato. Ciclo disattivato.'); return;
    }
    const quiet = !page.pending && page.ready;
    const signature = JSON.stringify({ phase: page.phase, paymentCancelled: page.paymentCancelledBeforeAuthorization,paymentFailed:page.paymentFailed,paymentSucceeded:page.paymentSucceeded, terminalFailure: page.terminalFailure, stockFailure: page.stockFailure });
    const stable = quiet && this.stablePayment?.signature === signature && this.now() - this.stablePayment.at >= 2000;
    if (!quiet || this.stablePayment?.signature !== signature) this.stablePayment = quiet ? { signature, at: this.now() } : null;
    const decision = paymentDecision({ page, ui, elapsed: this.now() - this.current.pressedAt, stable,notDispatched:this.current.dispatchRejected===true });
    if (decision === 'retry') { this.storage.setGuard('failed', this.guardAttempt()); this.current = null; this.stablePayment = null; this.state('stopped','Prova conclusa senza pagamento. Ciclo disattivato.'); }
    else if (decision === 'uncertain') { this.storage.setGuard('uncertain', this.guardAttempt()); this.state('payment-observation','Prova Apple Pay da verificare. Non confermare il pagamento.'); }
  }
  async shutdown() { this.enabled = false; this.generation++; await this.fleet.stop(); }
}
