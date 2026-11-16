import { abortStaleKeeper } from './keeper-recovery.mjs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { pageDOM } from './page-dom.mjs';
import { choosePickupSchedule, pickupScheduleDOM } from './pickup-time.mjs';
import { pickupFastDOM } from './pickup-fast.mjs';
import { freshPickupAvailability } from './pickup-availability.mjs';
import { STORES } from './shared.mjs';
import { readJSON, writeJSON } from './storage.mjs';
import { createNativeTransport } from './native-transport.mjs';
const executable = fileURLToPath(new URL('./native/safari', import.meta.url));
const sendNative = createNativeTransport({ executable });
// Observed in JP checkout.session.d.interactionMs; warnings remain checked on every tick.
const SESSION_INTERACTION_MS = 300000;
export async function nativeRequest(request) {
  if (process.env.CHECKOUT_DISABLE_NATIVE === '1') throw Error('NATIVE_DISABLED_OFFLINE');
  return sendNative(request);
}
export function requireQuietSafari(ui) {
  if (ui?.active) throw Error('PAYMENT_ACTIVE');
  if (!ui?.known) throw Error(ui?.code === 'SAFARI_AX_UNAVAILABLE' ? 'SAFARI_AX_UNAVAILABLE' : 'ACCESSIBILITY_REQUIRED');
}
export class SafariSession {
  constructor({ invoke = nativeRequest, now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)), bindingPath = process.env.CHECKOUT_DISABLE_NATIVE === '1' ? null : fileURLToPath(new URL('../data/safari-binding.json', import.meta.url)) } = {}) { this.invoke = invoke; this.now = now; this.sleep = sleep; this.bindingPath = bindingPath; this.binding = bindingPath ? readJSON(bindingPath, null) : null; this.navigationUntil = 0; this.phase = 'unbound'; this.canRebind = () => false; }
  snapshot() { return { browser: 'Safari', bound: Boolean(this.binding), phase: this.phase, sessionWarning: this.sessionWarning ?? false, fulfillmentMode: this.fulfillmentMode ?? null, pickupPreparation: this.pickupPreparation ?? { state:'waiting',postalReady:false,storesReady:false,calendarReady:false,storeCount:0 } }; }
  expected(selection, storeId) { this.selection = selection; this.store = STORES.find(s => s.id === storeId) ?? null; }
  setPickupContact(contact) { this.pickupContact = contact; }
  async readBoundWindow(read,retry,{check=()=>{},onRetry=()=>{},reason='window-read',retryProcessRead=false,retryScriptRead=false}={}) {
    const binding=this.binding,identity=JSON.stringify(binding);
    const unchanged=()=>binding&&this.binding===binding&&JSON.stringify(this.binding)===identity;
    const changed=()=>Object.assign(Error('SAFARI_TAB_CHANGED'),{bindingChanged:true});
    try{return await read();}
    catch(error){
      const canRetry=error.message==='SAFARI_TAB_CHANGED' ||
        retryProcessRead&&error.message==='SAFARI_CHANGED' ||
        retryScriptRead&&error.message==='SAFARI_SCRIPT_UNAVAILABLE';
      if(!binding||!canRetry)throw error;
      if(!unchanged())throw changed();
      check();onRetry(error.message);await this.pause(100,reason);check();
      if(!unchanged())throw changed();
      // The second operation must revalidate the original target and native
      // payment state. This helper never retries a mutation or discovers tabs.
      return retry();
    }
  }
  async bind() {
    let previousFailure;
    if (this.binding) {
      try { await this.readBoundWindow(()=>this.request('payment-status'),async()=>{requireQuietSafari(await this.paymentStatus());const ui=await this.request('payment-status');requireQuietSafari(ui);return ui;}); this.phase = 'bound'; return; }
      // Keep the last exact target until a replacement has been verified. A
      // temporary window-list failure followed by ambiguous discovery must not
      // discard the only binding that distinguishes the two colour profiles.
      catch (e) {
        if (e.bindingChanged || !this.canRebind() || !['SAFARI_CHANGED','SAFARI_TAB_CHANGED'].includes(e.message)) throw e;
        previousFailure = e;
      }
    }
    try { this.binding = await this.invoke({ operation: 'bind' }); }
    catch (e) { throw previousFailure && e.message==='SAFARI_TAB_REQUIRED' ? previousFailure : e; }
    if (this.bindingPath) writeJSON(this.bindingPath, this.binding);
    this.phase = 'bound';
  }
  async measure(name, run) {
    const start = this.now();
    try { const value = await run(); this.onTiming?.({ name, durationMs: Math.max(0, this.now() - start), result: 'ok' }); return value; }
    catch (error) {
      this.onTiming?.({ name, durationMs: Math.max(0, this.now() - start), result: 'error', code: /^[A-Z][A-Z_0-9]{0,79}$/.test(error.message) ? error.message : 'NATIVE_ERROR', ...(error.notDispatched===true?{notDispatched:true}:{}) });
      if (name === 'native:press-apple-pay' && error.notDispatched === true) {
        if(error.axTarget)this.onTiming?.({name:'native:pay-ax-target',durationMs:0,result:'error',code:error.axTarget});
        if(error.domTarget)this.onTiming?.({name:'native:pay-dom-target',durationMs:0,result:'ok',code:error.domTarget});
      }
      throw error;
    }
  }
  pause(ms, reason = 'poll') { return this.measure('wait:' + reason, () => this.sleep(ms)); }
  request(operation, extra = {}) { if (!this.binding) throw Error('SAFARI_UNBOUND'); const { timingLabel, timingHandled, ...payload } = extra; const run = () => this.invoke({ operation, binding: this.binding, allowNavigation: this.navigationUntil > this.now(), ...payload }); return timingHandled ? run() : this.measure(timingLabel ?? 'native:' + operation, run); }
  async evaluate(fn, parameters, { guardPayment = false, allowSessionModal = false, strictBinding = false } = {}) {
    const script = `JSON.stringify((()=>{try{return{appleLoopEnvelope:1,ok:true,value:(${fn.toString()})(${JSON.stringify(parameters)})}}catch(error){const d=error.pickupDiagnostic,diagnostic={};if(d&&typeof d==='object'){for(const k of ['dateCount','selectorCount','dateElementCount','selectorElementCount','checkedStoreCount','dateLabelVisibleCount','storeCandidateCount','storeVisibleCandidateCount'])if(Number.isSafeInteger(d[k])&&d[k]>=0&&d[k]<=1000)diagnostic[k]=d[k];for(const k of ['storeResponseMs','firstByteMs','downloadMs','connectMs'])if(Number.isSafeInteger(d[k])&&d[k]>=0&&d[k]<=300000)diagnostic[k]=d[k];if(typeof d.storeConfirmed==='boolean')diagnostic.storeConfirmed=d.storeConfirmed;if(['store-disabled','store-not-confirmed'].includes(d.readinessReason))diagnostic.readinessReason=d.readinessReason;}return{appleLoopEnvelope:1,ok:false,code:/^[A-Z][A-Z_0-9]{0,79}$/.test(error.message)?error.message:'DOM_ACTION_FAILED',...(Object.keys(diagnostic).length?{pickupDiagnostic:diagnostic}:{})}}})())`;
    const action = /^[a-z][a-z0-9-]{0,47}$/.test(parameters?.action ?? '') ? parameters.action : 'read';
    return this.measure((fn === pickupScheduleDOM || fn === pickupFastDOM ? 'calendar:' : 'dom:') + action, async () => {
    const result = await this.request(guardPayment ? 'evaluate-guarded' : 'evaluate', { script, timingHandled: true, ...(guardPayment ? { allowSessionModal } : {}), ...(strictBinding ? { allowNavigation:false } : {}) });
    if (result?.appleLoopEnvelope !== 1 || typeof result.ok !== 'boolean') throw Error('SAFARI_SCRIPT_UNAVAILABLE');
    if (!result.ok) {
      const error = Error(result.code);
      if (result.pickupDiagnostic && typeof result.pickupDiagnostic === 'object') error.pickupDiagnostic = result.pickupDiagnostic;
      throw error;
    }
    if(fn===pickupFastDOM&&['date','slot'].includes(action)&&typeof result.value?.selectionChanged==='boolean')this.onTiming?.({name:'calendar:'+action+'-origin',durationMs:0,result:'ok',code:result.value.selectionChanged?'AUTOMATION':'ALREADY_SELECTED'});
    return result.value;
    });
  }
  async inspect({paymentContext,guardPayment=false,observeAvailability:allowAvailability=true,check=()=>{},onWindowRetry=()=>{},windowRetryReason='window-read',entryRetry=false} = {}) {
    const observeAvailability=allowAvailability&&typeof this.onAvailability==='function'&&Boolean(this.selection?.sku)&&this.confirmedSKU===this.selection.sku&&Boolean(this.binding?.nonce)&&!paymentContext&&!this.pendingPostal&&!this.keeperSuspended;
    const parameters={ action: 'inspect', selection: this.selection, store: this.store, ...(paymentContext?{paymentContext,observerNonce:this.binding?.nonce}:{}),...(observeAvailability?{observeAvailability:true}:{}) };
    const read=()=>this.evaluate(pageDOM,parameters,{guardPayment});
    const state=paymentContext?await read():await this.readBoundWindow(
      read,()=>this.evaluate(pageDOM,parameters,{guardPayment:true,strictBinding:entryRetry}),
      {check,onRetry:onWindowRetry,reason:windowRetryReason,retryScriptRead:entryRetry}
    );
    this.phase = state.phase; this.lastPagePhase=state.phase; this.sessionWarning = state.sessionWarning ?? false; this.fulfillmentMode = state.fulfillmentMode ?? null;
    if (this.pendingSchedule && !state.pending && !state.paymentDispatched && (['bag','product','expired','unavailable'].includes(state.phase) || state.phase === 'pickup' && state.fulfillmentMode === 'delivery')) this.pendingSchedule = null;
    if(this.pendingPostal&&!state.pending&&!state.paymentActive&&!state.paymentObserved&&!state.paymentDispatched&&!state.paymentCompleted&&['bag','product','expired','unavailable'].includes(state.phase))this.pendingPostal=null;
    if(observeAvailability&&state.phase==='pickup'&&state.fulfillmentMode==='pickup'&&state.ready!==false&&!state.pending&&!state.sessionWarning&&!state.errors&&state.fulfillmentResponseVerified===true&&Number.isSafeInteger(state.fulfillmentResponseEpochMs)&&state.fulfillmentResponseEpochMs!==this.lastAvailabilityMarker&&state.fulfillmentResponseAgeMs>=150&&state.fulfillmentResponseAgeMs<=5000){
      // This optional read consumes an existing response; it sends no request
      // to Apple. Lost advisory reads leave the ordinary stock path intact.
      try {
        const sample=await this.evaluate(freshPickupAvailability,{action:'pickup-availability',nonce:this.binding.nonce,sku:this.selection.sku,priceJPY:this.selection.priceJPY,stores:this.selection.stores});
        if(sample?.origin==='safari-pickup-response'&&sample.sku===this.confirmedSKU&&Number.isSafeInteger(sample.observedAt)&&this.now()-sample.observedAt>=0&&this.now()-sample.observedAt<=5000&&Array.isArray(sample.stores)&&sample.stores.length>0&&sample.stores.length<=this.selection.stores.length&&sample.stores.every(s=>this.selection.stores.includes(s.id)&&s.state==='available')){
          if(this.onAvailability({sku:sample.sku,observedAt:sample.observedAt,stores:sample.stores.map(s=>({id:s.id,state:'available'})),origin:'safari-pickup-response'})===true)this.lastAvailabilityMarker=state.fulfillmentResponseEpochMs;
        }
      } catch {}
    }
    return state;
  }
  async paymentStatus() { return this.request('payment-status', { observeOnly: true }); }
  async action(action, options = {}) {
    const previousNavigationUntil = this.navigationUntil;
    if (['navigate', 'restart-success', 'checkout', 'product-add', 'pickup-continue', 'contact-continue', 'review'].includes(action)) this.navigationUntil = this.now() + 30000;
    try { return await this.evaluate(pageDOM, { action, selection: this.selection, store: this.store, ...options }, { guardPayment: true, allowSessionModal: action === 'keepalive', strictBinding: action === 'reposition-apple-pay' || action === 'navigate' && options.terminalFailure?.source === 'operator-reviewed-pickup-refusal' }); }
    catch (error) {
      // These native rejections precede document ownership and all DOM work.
      // A lost JavaScript reply retains the expected-navigation allowance.
      if (['PAYMENT_ACTIVE','ACCESSIBILITY_REQUIRED','SAFARI_AX_UNAVAILABLE','INVALID_COMMAND'].includes(error.message)) this.navigationUntil = previousNavigationUntil;
      throw error;
    }
  }
  async navigateBag({ terminalFailure } = {}) {
    const options={url:'https://www.apple.com/jp/shop/bag',...(terminalFailure?{terminalFailure:{...terminalFailure,nonce:this.binding?.nonce,sku:this.selection?.sku}}:{})};
    return this.transition('navigate',options,['bag'],()=>{},{pollMs:100,accept:p=>p.ready&&!p.pending});
  }
  async transition(action, options, phases, check = () => {}, waitOptions = {}) {
    check();
    try { await this.action(action, options); }
    catch (e) {
      // Safari may lose the JavaScript reply when the click replaces its page.
      // Observe the existing target; never replay that navigation or submission.
      if (!['SAFARI_SCRIPT_UNAVAILABLE','SAFARI_UNCERTAIN'].includes(e.message)) throw e;
    }
    return this.waitFor(phases, { ...waitOptions, check });
  }
  async waitFor(phases, { deadline = this.now() + 30000, check = () => {}, accept = () => true, pollMs = 500 } = {}) {
    let ownershipFailures = 0;
    while (this.now() < deadline) {
      check(); let s;
      try { s = await this.inspect(); }
      catch (e) {
        if (e.message === 'SAFARI_FOREIGN_OWNER') {
          // An expected page transition can momentarily hide its marker.
          // Each retry still executes the native ownership check. Never
          // adopt another marker or resend the transition that is in flight.
          if (this.navigationUntil <= this.now() || ++ownershipFailures >= 3) throw e;
          await this.pause(Math.min(100, Math.max(0, deadline-this.now())), 'ownership-read'); continue;
        }
        if (!['SAFARI_SCRIPT_UNAVAILABLE','SAFARI_UNCERTAIN'].includes(e.message)) throw e;
        await this.pause(pollMs); continue;
      }
      if (phases.includes(s.phase) && accept(s)) return s;
      if (s.phase === 'authentication') throw Error('LOGIN_REQUIRED');
      await this.pause(pollMs);
    }
    throw Error('PAGE_TRANSITION_UNCERTAIN');
  }
  async ensureFulfillment(mode, check = () => {}, { earlyPickupReturn = false } = {}) {
    if (!['pickup','delivery'].includes(mode)) throw Error('FULFILLMENT_MODE_REQUIRED');
    const canReturn = s => earlyPickupReturn && s.fulfillmentReturnReady === true;
    let state = await this.waitFor(['pickup'], { check, pollMs: earlyPickupReturn ? 25 : 100, accept: s => !s.pending && s.ready !== false && ['pickup','delivery'].includes(s.fulfillmentMode) || canReturn(s) });
    if (state.fulfillmentMode === mode) return state;
    check();
    try { await this.action('fulfillment-mode', { mode, ...(mode === 'pickup' && canReturn(state) ? { returnAfterDelivery:true } : {}) }); }
    catch (e) { if (!['SAFARI_SCRIPT_UNAVAILABLE','SAFARI_UNCERTAIN'].includes(e.message)) throw e; }
    return this.waitFor(['pickup'], { check, pollMs: earlyPickupReturn ? 25 : 100, accept: s => s.fulfillmentMode === mode && (!s.pending && s.ready !== false || mode === 'delivery' && canReturn(s)) });
  }
  async refreshPickup(check = () => {}, shouldYield = () => false, { canSuspend = () => false } = {}) {
    if (shouldYield()) return { maintained: true, mode: 'pickup', yielded: true };
    const stockPriority = Error('KEEPER_YIELD'); let yielded = false, suspended = false, failed = false;
    // Stock can arrive during the awaited page read immediately before the
    // delivery click. Once a change is sent, the finally block still waits
    // for its response and restores pickup before checkout can proceed.
    const beforeDelivery = () => { check(); if (shouldYield()) throw stockPriority; };
    this.pendingMode = 'pickup';
    try {
      const delivery = await this.ensureFulfillment('delivery', beforeDelivery, { earlyPickupReturn:true });
      check(); if (!delivery?.fulfillmentReturnReady && !delivery?.fulfillmentResponseVerified && !shouldYield()) await this.pause(750);
    } catch (error) {
      if (error !== stockPriority) { failed=true; throw error; }
      yielded = true;
    } finally {
      // Only a verified other-colour session may proceed independently.
      // Keep the interrupted mode transaction for later read-only reconciliation.
      const restoreCheck=()=>{check();if(!failed&&shouldYield()&&canSuspend())throw stockPriority;};
      try {
        restoreCheck();const pickup=await this.ensureFulfillment('pickup',restoreCheck,{earlyPickupReturn:true});
        if(!pickup?.fulfillmentResponseVerified){await this.pause(250);await this.ensureFulfillment('pickup',restoreCheck);}
        this.pendingMode=null;this.pendingPostal=null;
      } catch(error){if(error!==stockPriority)throw error;suspended=true;yielded=true;}
    }
    if(suspended)return{maintained:true,yielded:true,suspended:true};
    if (!yielded) this.nextKeepaliveAt = this.now() + SESSION_INTERACTION_MS;
    return { maintained: true, mode: 'pickup', ...(yielded ? { yielded:true } : {}) };
  }
  async restoreStaleKeeper(check = () => {}, beforeAbort = () => {}) {
    check();const ui=await this.paymentStatus();check();
    requireQuietSafari(ui);
    let page=await this.inspect();check();
    if(page.paymentActive||page.paymentObserved||page.paymentDispatched||page.paymentCompleted)throw Error('EXISTING_CHECKOUT');
    if(['bag','expired','unavailable'].includes(page.phase))return{needsPreparation:true};
    if(page.phase!=='pickup')throw Error('EXISTING_CHECKOUT');
    if(!page.pending&&page.ready!==false&&page.fulfillmentMode==='pickup'){
      this.pendingMode=null;this.nextKeepaliveAt=this.now()+SESSION_INTERACTION_MS;return{ready:true};
    }
    const args={nonce:this.binding?.nonce};
    await this.evaluate(abortStaleKeeper,{...args,observeOnly:true},{guardPayment:true});check();
    beforeAbort();check();this.navigationUntil=this.now()+30000;
    try{await this.evaluate(abortStaleKeeper,args,{guardPayment:true});}
    catch(error){if(!['SAFARI_SCRIPT_UNAVAILABLE','SAFARI_UNCERTAIN'].includes(error.message))throw error;}
    page=await this.waitFor(['bag','expired','unavailable'],{check,pollMs:100,accept:p=>!p.pending&&p.ready!==false});
    this.pendingMode=null;this.pendingPostal=null;return{needsPreparation:true,aborted:true};
  }
  async renewSession(check = () => {}) {
    const extend = async () => {
      check();
      try { return await this.action('keepalive'); }
      catch (e) {
        if (!['SAFARI_SCRIPT_UNAVAILABLE','SAFARI_UNCERTAIN'].includes(e.message)) throw e;
        // Reconcile the existing extension request; never click it a second time.
        const state = await this.waitFor(['pickup','contact','billing','review','expired'], { check, pollMs:100, accept: s => s.phase === 'expired' || !s.sessionWarning && !s.pending && s.ready !== false });
        return state.phase === 'expired' ? { expired: true } : { maintained: true };
      }
    };
    let result = await extend();
    if (result.manual && result.reason === 'extension-control') {
      const deadline = this.now() + 1500;
      for (let poll = 0; poll < 15 && this.now() < deadline; poll++) {
        check(); const state = await this.inspect();
        if (state.phase === 'authentication') throw Error('LOGIN_REQUIRED');
        if (state.phase === 'expired' || state.sessionExpired) return { expired: true };
        if (!state.sessionWarning && !state.pending && state.ready !== false) { result = { maintained: true }; break; }
        if (state.sessionWarning && state.sessionExtendAvailable) {
          result = await extend();
          if (!result.manual) break;
        }
        const remaining = deadline - this.now();
        if (remaining > 0) await this.pause(Math.min(100, remaining), 'session-control');
      }
    }
    if (result.manual) throw Error('SESSION_EXTENSION_REQUIRED');
    if (result.expired) return result;
    if (result.extensionRequested || result.extensionPending) {
      const state = await this.waitFor(['pickup','contact','billing','review','expired'], { check, pollMs:100, accept: s => s.phase === 'expired' || !s.sessionWarning && !s.pending && s.ready !== false });
      this.sessionWarning = false;
      return state.phase === 'expired' ? { expired: true } : { maintained: true, sessionExtended: true };
    }
    return result;
  }
  async maintain(check = () => {}, shouldYield = () => false, {canSuspend=()=>false}={}) {
    const result = await this.renewSession(check);
    if (result.expired) return result;
    const state = await this.inspect();
    if (state.phase !== 'pickup' || state.pending) return { waiting: true };
    // Pickup is the resting state, including recovery from an interrupted cycle.
    if (this.pendingMode || state.fulfillmentMode === 'delivery') {
      await this.ensureFulfillment('pickup', check); this.pendingMode = null;
      this.nextKeepaliveAt = this.now() + SESSION_INTERACTION_MS;
      return { maintained: true, mode: 'pickup', ...await this.preparePickup(check,shouldYield) };
    }
    if (shouldYield()) return { maintained: true, mode: 'pickup', yielded: true };
    const now = this.now();
    if (this.nextKeepaliveAt === undefined) this.nextKeepaliveAt = now + SESSION_INTERACTION_MS;
    if (now < this.nextKeepaliveAt) return { ...result,...await this.preparePickup(check,shouldYield) };
    const refreshed=await this.refreshPickup(check,shouldYield,{canSuspend});
    return refreshed.yielded?refreshed:{...refreshed,...await this.preparePickup(check,shouldYield)};
  }
  async preparePickup(check = () => {}, shouldYield = () => false) {
    const store=STORES.find(s=>s.id===this.selection?.stores?.[0]);
    const mark=(state,page={})=>this.pickupPreparation={state,postalReady:['stores-ready','store-selected','calendar-ready'].includes(state)||Boolean(page.refreshSubmitted&&page.refreshComplete),storesReady:page.storeListReady===true,calendarReady:page.pickupCalendarAvailable===true,storeCount:page.storeCount??0};
    if(!store){mark('waiting');return {waiting:true};}
    const read=async()=>{check();const p=await this.evaluate(pageDOM,{action:'postal-state',storeId:store.id,postalCode:store.postalCode});check();if(p.phase==='authentication')throw Error('LOGIN_REQUIRED');if(p.paymentActive||p.paymentObserved||p.paymentDispatched||p.paymentCompleted||['contact','billing','review','success'].includes(p.phase))throw Error('EXISTING_CHECKOUT');return p;};
    let page=await read();
    if(page.phase!=='pickup'||page.pending||page.ready===false||page.sessionWarning||page.errors>0&&!page.pickupSelectionPromptOnly){mark('waiting',page);return {waiting:true};}
    if(page.pickupCalendarAvailable||page.anyStoreSelected){mark(page.pickupCalendarAvailable?'calendar-ready':'store-selected',page);return {prepared:true};}
    if(page.storeListReady&&(!page.inputVisible||page.inputHasValue)){mark('stores-ready',page);return {prepared:true};}
    if(page.pickupUnavailable){mark('pickup-unavailable',page);return {prepared:false,pickupUnavailable:true};}
    if(shouldYield()){mark('waiting',page);return {yielded:true};}
    mark('preparing',page);
    const yielded=Error('PICKUP_PREPARATION_YIELDED');
    const beforeMutation=()=>{check();if(shouldYield()&&this.pendingPostal?.stage!=='submitted'){this.pendingPostal=null;throw yielded;}};
    try { await this.refreshStoreAvailability(store,beforeMutation); }
    catch(error){if(error===yielded){mark('waiting');return {yielded:true};}if(error.message==='STOCK_FAILED'&&error.freshPickupRefusalVerified){mark('pickup-unavailable',{refreshSubmitted:true,refreshComplete:true});return {prepared:false,pickupUnavailable:true};}throw error;}
    page=await read();
    if(page.pickupUnavailable){mark('pickup-unavailable',page);return {prepared:false,pickupUnavailable:true};}
    if(!page.storeListReady)throw Error('POSTAL_REFRESH_UNCERTAIN');
    mark('stores-ready',page);return {prepared:true};
  }
  async reusePreparedPickup(selection, check) {
    check();
    const binding = this.binding;
    if (!binding || this.selection?.sku !== selection.sku || this.confirmedSKU !== selection.sku ||
        this.pickupPreparation?.state !== 'stores-ready' || this.pendingMode || this.pendingPostal ||
        this.pendingSchedule || this.keeperSuspended || !(this.nextKeepaliveAt > this.now())) return false;
    const state = await this.evaluate(pageDOM, { action:'prepared-pickup-check', selection }, { guardPayment:true, strictBinding:true });
    check();
    // A fresh read neither changes the checkout page nor renews its lease.
    return this.binding === binding && this.nextKeepaliveAt > this.now() && state.valid === true;
  }
  async preferredPickupStore(selection, storeIds) {
    const binding=this.binding;
    if(!binding||this.confirmedSKU!==selection.sku||this.pendingMode||this.pendingPostal||this.pendingSchedule||this.keeperSuspended)return null;
    const v=await this.evaluate(pageDOM,{action:'preferred-pickup-store',selection,storeIds},{guardPayment:true,strictBinding:true});
    return this.binding===binding&&storeIds.slice(1).includes(v.storeId)?v.storeId:null;
  }
  async waitBagTotal(selection, check = () => {}) {
    const deadline = this.now() + 10000;
    for (let attempt = 0; attempt < 100 && this.now() < deadline; attempt++) {
      check();
      try {
        const bag = await this.evaluate(pageDOM, { action: 'bag-total-check', selection });
        if (bag.rendered !== false) return bag;
      } catch (error) { if (!['PAGE_BUSY','SAFARI_SCRIPT_UNAVAILABLE','SAFARI_UNCERTAIN'].includes(error.message)) throw error; }
      await this.pause(100, 'bag-total');
    }
    throw Error('PAGE_TRANSITION_UNCERTAIN');
  }
  async addConfiguredProduct(selection, check = () => {}) {
    const deadline = this.now() + 15000;
    let noCareRequested = false;
    for (let attempt = 0; attempt < 150 && this.now() < deadline; attempt++) {
      check(); let state;
      try { state = await this.evaluate(pageDOM, { action: 'product-state', selection }); }
      catch (error) { if (!['SAFARI_SCRIPT_UNAVAILABLE','SAFARI_UNCERTAIN'].includes(error.message)) throw error; }
      if (state && state.phase !== 'product') throw Error('PRODUCT_REQUIRED');
      if (state && !state.pending && state.ready !== false) {
        const chooseNoCare = state.careCount > 0 && !state.noCareChecked && state.noCareReady;
        if (!chooseNoCare && state.productIdentityPresent && !state.productVerified) throw Error('PRODUCT_CONFIGURATION_UNVERIFIED');
        const canAdd = state.productVerified && state.addReady && (!state.careCount || state.noCareChecked);
        if (chooseNoCare && !noCareRequested || canAdd) {
          check(); let result;
          try { result = await this.action('product-add', { selection }); }
          catch (error) {
            if (!['SAFARI_SCRIPT_UNAVAILABLE','SAFARI_UNCERTAIN'].includes(error.message)) throw error;
            return; // Observe the existing result; never replay an uncertain add.
          }
          if (!result?.configurationStep) return;
          noCareRequested = true;
          continue; // Read the resulting state immediately, without a fixed delay.
        }
      }
      await this.pause(100, 'product-controls');
    }
    throw Error('PRODUCT_CONFIGURATION_REQUIRED');
  }
  async prepareBag(selection, check) {
    this.selection = selection;
    let state = await this.waitFor(['authentication','bag','product','pickup','contact','billing','review','success','expired','unavailable'], {check,pollMs:100,accept:s=>s.pending||s.sessionWarning||s.ready!==false});
    if (state.phase !== 'authentication' && state.sessionWarning && !state.sessionExpired) { await this.renewSession(check); state = await this.inspect(); }
    if (state.phase === 'authentication') throw Error('LOGIN_REQUIRED');
    if (['contact', 'billing', 'review', 'success'].includes(state.phase) || state.pending) throw Error('EXISTING_CHECKOUT');
    if (state.phase === 'pickup' && state.applePayRoute && (state.pickupUnavailable || state.stockFailure || state.errors > 0 || selection.requireProductIdentity && this.confirmedSKU !== selection.sku)) {
      state = await this.transition('navigate', {url:'https://www.apple.com/jp/shop/bag'}, ['bag'], check, {pollMs:100,accept:p=>!p.pending&&p.ready!==false});
    }
    if (state.phase === 'pickup' && state.applePayRoute) {
      if (!(await this.evaluate(pageDOM, { action: 'checkout-check', selection })).valid) throw Error('TOTAL_CHANGED');
      await this.ensureFulfillment('pickup', check); this.nextKeepaliveAt = this.now() + SESSION_INTERACTION_MS; return;
    }
    if (state.phase !== 'bag') await this.transition('navigate', { url: 'https://www.apple.com/jp/shop/bag' }, ['bag'], check);
    let bag = await this.waitBagTotal(selection, check);
    if (bag.empty) {
      check(); await this.action('navigate', { url: selection.url }); await this.waitFor(['product'], { check });
      await this.addConfiguredProduct(selection, check);
      const added = await this.waitFor(['bag','product'], { check, accept: s => s.phase === 'bag' || s.bagRedirectReady === true });
      if (added.phase !== 'bag') await this.transition('navigate', { url: 'https://www.apple.com/jp/shop/bag' }, ['bag'], check);
      bag = await this.waitBagTotal(selection, check);
    }
    if (!bag.valid) throw Error('TOTAL_CHANGED');
    if (selection.requireProductIdentity) { await this.evaluate(pageDOM, { action:'bag-product-identity', selection }); check(); this.confirmedSKU = selection.sku; }
    const ready = await this.inspect();
    if (ready.applePayEntryReady === false) await this.waitFor(['bag'], { check, accept: s => s.applePayEntryReady === true });
    const checkout = await this.transition('checkout', { selection }, ['pickup'], check);
    if (checkout.applePayRoute !== true) throw Error('APPLE_PAY_ROUTE_REQUIRED');
    await this.ensureFulfillment('pickup', check); this.nextKeepaliveAt = this.now() + SESSION_INTERACTION_MS;
  }
  async refreshStoreAvailability(store, check = () => {}, deadline = this.now() + 25000, onStage = () => {}, {fast=false} = {}) {
    let retriedWindowRead = false;
    const reportResponse=(state,result='ok')=>{
      if(!Number.isSafeInteger(state.refreshResponseMs))return;
      this.onTiming?.({name:'postal:response',durationMs:state.refreshResponseMs,result,
        ...(result==='error'?{code:'PICKUP_DELIVERY_ONLY'}:{}),
        ...Object.fromEntries(['firstByteMs','downloadMs','connectMs','requestStartAfterSubmitMs','verifiedAfterResponseMs']
          .filter(k=>Number.isSafeInteger(state[k])&&state[k]>=0&&state[k]<=300000).map(k=>[k,state[k]]))});
    };
    const wait = async (accept, recover) => {
      const startedAt = this.now();
      const pause = async () => {
        const remaining = deadline - this.now();
        if (remaining > 0) await this.pause(Math.min(remaining, this.now() - startedAt < 1000 ? 50 : 100), 'postal');
      };
      while (this.now() < deadline) {
        check(); let state;
        try {
          const parameters = { action:'postal-state', storeId:store.id, postalCode:store.postalCode,
            ...(this.pendingPostal?.id ? {refreshId:this.pendingPostal.id} : {}) };
          const read = () => this.evaluate(pageDOM,parameters);
          state = retriedWindowRead ? await read() : await this.readBoundWindow(read,
            () => this.evaluate(pageDOM,parameters,{guardPayment:true,strictBinding:true}),
            {check,reason:'postal-window',onRetry:()=>{
              retriedWindowRead = true;
              onStage('SAFARI_POSTAL_READ_RETRY');
            }});
        }
        catch (e) { if (!['SAFARI_SCRIPT_UNAVAILABLE','SAFARI_UNCERTAIN'].includes(e.message)) throw e; await pause(); continue; }
        if (state.phase === 'authentication') throw Error('LOGIN_REQUIRED');
        if (state.phase === 'expired') throw Error('PREORDER_SESSION_EXPIRED');
        if (state.phase === 'unavailable') throw Error('PREORDER_PAGE_UNAVAILABLE');
        if (state.phase !== 'pickup' || state.paymentActive) throw Error('EXISTING_CHECKOUT');
        if (!state.pending && state.pickupUnavailable && (this.pendingPostal?.stage !== 'submitted' || state.refreshComplete)) {
          const freshPickupRefusalVerified = this.pendingPostal?.stage === 'submitted' && state.refreshComplete === true && state.fulfillmentMode === 'pickup' && state.ready !== false && !state.paymentObserved && !state.paymentDispatched && !state.paymentCompleted;
          if(freshPickupRefusalVerified)reportResponse(state,'error');
          this.pendingPostal = null; onStage('PICKUP_DELIVERY_ONLY');
          throw Object.assign(Error('STOCK_FAILED'), { freshPickupRefusalVerified });
        }
        if (!state.pending && state.ready !== false && state.fulfillmentMode === 'pickup' && accept(state)) return state;
        if (!state.pending && state.ready !== false && state.fulfillmentMode === 'pickup') await recover?.(state);
        await pause();
      }
      throw Error('POSTAL_REFRESH_UNCERTAIN');
    };
    const dispatchOnce = async (action, extra = {}) => {
      check();
      try { return await this.action(action, { postalCode: store.postalCode, refreshId: this.pendingPostal.id, ...extra }); }
      catch (e) { if (!['SAFARI_SCRIPT_UNAVAILABLE','SAFARI_UNCERTAIN'].includes(e.message)) throw e; }
    };
    const readyToFill = state => state.inputVisible && state.inputReady && state.searchVisible;
    let editorReady = false;
    if (this.pendingPostal && this.pendingPostal.storeId !== store.id) throw Error('POSTAL_REFRESH_UNCERTAIN');
    if (!this.pendingPostal) {
      const existing = await wait(s => (s.refreshSubmitted && !s.refreshComplete) || readyToFill(s) || s.canEdit);
      editorReady = readyToFill(existing);
      const resuming = existing.refreshSubmitted && !existing.refreshComplete;
      this.pendingPostal = { storeId: store.id, id: resuming ? existing.refreshId : randomUUID(), stage: resuming ? 'submitted' : 'opening', openingAt: this.now() };
      if (this.pendingPostal.stage === 'opening' && !editorReady) {
        const result = await dispatchOnce(fast?'postal-advance':'postal-open');
        if (result?.submitted) { this.pendingPostal.stage = 'submitted'; if(result.refreshId)this.pendingPostal.id=result.refreshId; }
        else if(result?.prepared){this.pendingPostal.stage='prepared';this.pendingPostal.preparedReady=result.readiness?.inputMatches&&result.readiness.searchReady&&!result.readiness.pending;}
      }
    }
    const beforeInput=error=>['POSTAL_CONTROL_CHANGED','POSTAL_INPUT_REQUIRED'].includes(error.message);
    let verifiedPostalState;
    for (;;) {
      while (this.pendingPostal.stage === 'opening') {
        if (!editorReady) {
          const state=await wait(s=>readyToFill(s)||s.refreshSubmitted, async state => {
            // A stale fill marker is not a live editor. Reopen once only
            // after a collapsed, quiet control proves no matching submission.
            if (state.editorClosed && !state.refreshSubmitted && !state.paymentObserved && !state.paymentDispatched &&
                !state.paymentCompleted && !this.pendingPostal.openRetried &&
                (this.pendingPostal.submitRemountRetried || this.now()-this.pendingPostal.openingAt>=1000)) {
              this.pendingPostal.openRetried=true;onStage('PICKUP_POSTAL_EDITOR_RECOVERED');await dispatchOnce('postal-open');
            }
          });
          if(state.refreshSubmitted){this.pendingPostal.stage='submitted';break;}
          if(state.refreshPrepared&&state.inputMatches){this.pendingPostal.stage='prepared';break;}
        }
        onStage('PICKUP_POSTAL_EDITOR_READY');
        this.pendingPostal.stage='submitted';
        let result;
        try{result=await dispatchOnce('postal');}
        catch(error){
          if(!beforeInput(error))throw error;
          this.pendingPostal.stage='opening';editorReady=false;
          onStage('PICKUP_POSTAL_CONTROLS_LOADING');continue;
        }
        if(result?.prepared&&result.submitted===false)this.pendingPostal.stage='prepared';
      }
      while (this.pendingPostal.stage === 'prepared') {
        if(!this.pendingPostal.preparedReady)await wait(s => s.inputMatches && s.searchReady);
        this.pendingPostal.preparedReady=false;
        this.pendingPostal.stage='submitted';
        let result;
        try{result=await dispatchOnce('postal-submit');}
        catch(error){
          // These explicit guard errors precede any input or click. A lost
          // command reply stays in submitted and is reconciled read-only.
          if(!beforeInput(error))throw error;
          this.pendingPostal.stage='opening';editorReady=false;
          if(this.pendingPostal.submitRemountRetried)throw Error('POSTAL_REFRESH_UNCERTAIN');
          this.pendingPostal.submitRemountRetried=true;this.pendingPostal.openRetried=false;
          onStage('PICKUP_POSTAL_SUBMIT_REMOUNT_RECONCILED');break;
        }
        if (result?.prepared && result.submitted === false) this.pendingPostal.stage = 'prepared';
      }
      if(this.pendingPostal.stage==='opening')continue;
      // A matching preparation marker proves a lost fill reply sent no search.
      // Submitted queries require their actual response and are never replayed.
      const state = await wait(s => s.refreshPrepared || s.refreshSubmitted && s.refreshComplete);
      if (state.refreshPrepared && !state.refreshSubmitted) { this.pendingPostal.stage = 'prepared'; continue; }
      this.onTiming?.({ name: 'postal:verified', durationMs: 0, result: 'ok', code: 'STORE_' + (['missing','unavailable','unselected','selected'].includes(state.storeState) ? state.storeState : 'unknown').toUpperCase() + '_INPUT_' + (state.inputMatches ? 'MATCHES' : 'DIFFERS') });
      reportResponse(state);
      verifiedPostalState=state;
      break;
    }
    onStage('PICKUP_POSTAL_RESPONSE_VERIFIED');
    this.pendingPostal = null;
    return verifiedPostalState;
  }
  async prepareCheckout(selection, storeId, check, onStage = () => {}) {
    if (selection.requireProductIdentity && this.confirmedSKU !== selection.sku) throw Error('PRODUCT_IDENTITY_UNVERIFIED');
    this.expected(selection, storeId);
    const store = STORES.find(s => s.id === storeId); if (!store || !selection.stores.includes(storeId)) throw Error('STORE_CHANGED');
    let state=await this.inspect({
      observeAvailability:false,check,entryRetry:true,windowRetryReason:'entry-read',
      onWindowRetry:code=>onStage(code==='SAFARI_SCRIPT_UNAVAILABLE'?'SAFARI_ENTRY_SCRIPT_READ_RETRY':'SAFARI_ENTRY_READ_RETRY'),
    }),acceptedTransition=null;
    if (state.phase !== 'authentication' && state.sessionWarning && !state.sessionExpired) { await this.renewSession(check); state = await this.inspect(); }
    if (state.phase === 'expired') throw Error('PREORDER_SESSION_EXPIRED');
    if (state.phase === 'unavailable') throw Error('PREORDER_PAGE_UNAVAILABLE');
    if (state.phase === 'authentication') throw Error('LOGIN_REQUIRED');
    if (state.phase === 'pickup') {
    if (state.fulfillmentMode !== 'pickup' || state.pending || state.ready === false) state = await this.ensureFulfillment('pickup', check);
    this.pendingMode = null; this.nextKeepaliveAt = this.now() + SESSION_INTERACTION_MS; onStage('PICKUP_READY');
    if (state.pickupUnavailable) {
      onStage('PICKUP_MODE_REFRESH_PRECHECK');
      await this.refreshPickup(check); state = await this.inspect();
      if (state.pickupUnavailable) { onStage('PICKUP_DELIVERY_ONLY'); throw Error('STOCK_FAILED'); }
    }
    let selected = false, postalApplied = false, postalRefusalVerified = false, selectionPending = false, storeGuarded = false, lastStoreState, firstObservation = state, firstCalendarSnapshot = null; const deadline = this.now() + 25000;
    const stockRefusal=()=>Object.assign(Error('STOCK_FAILED'),{freshPickupRefusalVerified:postalRefusalVerified});
    while (this.now() < deadline) {
      check(); let s;
      try {
        const observed = firstObservation && ['missing','unavailable','unselected','selected'].includes(firstObservation.storeState) ? firstObservation : await this.evaluate(pageDOM, { action: 'store-state', storeId });
        firstObservation = null;
        if (['missing','unavailable','unselected','selected'].includes(observed.storeState) && observed.storeState !== lastStoreState) {
          this.onTiming?.({ name: 'store:' + observed.storeState, durationMs: 0, result: 'ok' }); lastStoreState = observed.storeState;
        }
        if (observed.phase === 'authentication') throw Error('LOGIN_REQUIRED');
        if (observed.phase === 'expired') throw Error('PREORDER_SESSION_EXPIRED');
        if (observed.phase === 'unavailable') throw Error('PREORDER_PAGE_UNAVAILABLE');
        if (observed.phase !== 'pickup' || observed.paymentActive) throw Error('EXISTING_CHECKOUT');
        if (observed.pending || observed.ready === false) { await this.pause(100); continue; }
        if (observed.pickupUnavailable) { onStage('PICKUP_DELIVERY_ONLY'); throw stockRefusal(); }
        s = { [observed.storeState]: true };
        if (s.unselected && !selectionPending) {
          selectionPending = true;
          s = await this.evaluate(pickupFastDOM, {action:'store-calendar',selection,storeId,storeLabels:[store.name,store.localName]}, {guardPayment:true}); storeGuarded = true;
          firstCalendarSnapshot=s.calendar??null;
        }
      } catch (e) {
        if (!['SAFARI_SCRIPT_UNAVAILABLE','SAFARI_UNCERTAIN'].includes(e.message)) throw e;
        await this.pause(100); continue;
      }
      if ((s.unavailable || s.missing) && !postalApplied) {
        firstObservation=await this.refreshStoreAvailability(store, check, deadline, onStage, {fast:true}); postalApplied = true; selectionPending = false; storeGuarded = false;
        // The response fence also applies when the selected Store is refused
        // before the DOM's delivery-only banner becomes visible.
        postalRefusalVerified=firstObservation.refreshSubmitted===true&&firstObservation.refreshComplete===true&&firstObservation.phase==='pickup'&&firstObservation.fulfillmentMode==='pickup'&&!firstObservation.pending&&firstObservation.ready!==false&&!firstObservation.paymentActive&&!firstObservation.paymentObserved&&!firstObservation.paymentDispatched&&!firstObservation.paymentCompleted;
        onStage('PICKUP_AVAILABILITY_REFRESHED'); continue;
      }
      if (s.unavailable) throw stockRefusal();
      if (s.selected) {
        if (!storeGuarded) {
          requireQuietSafari(await this.paymentStatus());
          check();
        }
        selected = true; break;
      }
      if (s.requested) selectionPending = true;
      await this.pause(100, 'store');
    }
    if (!selected) throw Error('STORE_UNVERIFIED');
    onStage('STORE_VERIFIED');
    let storeResponseReported = false, readerBuildReported = false, calendarReadRetried = false;
    const read = async p => {
      check();
      if (p.action !== 'read' && this.pendingSchedule) throw Error('PICKUP_CALENDAR_TIMEOUT');
      try {
        const initial = p.action==='read'&&!this.pendingSchedule?firstCalendarSnapshot:null;firstCalendarSnapshot=null;
        const inspectCalendar = (guardPayment,strictBinding=false) => this.evaluate(pickupFastDOM, { ...p, selection,storeId, storeLabels: [store.name, store.localName] }, { guardPayment, strictBinding });
        const snapshot = initial ?? (p.action === 'read' && !calendarReadRetried
          ? await this.readBoundWindow(() => inspectCalendar(false), () => inspectCalendar(true,true), {
            check, reason:'calendar-read', retryProcessRead:true,
            onRetry:code=>{ calendarReadRetried = true; onStage(code==='SAFARI_CHANGED'?'SAFARI_CALENDAR_PROCESS_READ_RETRY':'SAFARI_CALENDAR_READ_RETRY'); }
          })
          : await inspectCalendar(p.action !== 'read'));
        if(!readerBuildReported&&/^[a-f0-9]{16}$/.test(snapshot.readinessBuild??'')){
          readerBuildReported=true;this.onTiming?.({name:'calendar:reader',durationMs:0,result:'ok',code:'BUILD_'+snapshot.readinessBuild.toUpperCase()});
        }
        if (p.action === 'read') {
          if (snapshot.storeResponseVerified && !storeResponseReported) {
            storeResponseReported = true; onStage('STORE_RESPONSE_VERIFIED');
            if (Number.isSafeInteger(snapshot.storeResponseMs)) this.onTiming?.({ name: 'calendar:store-response', durationMs: snapshot.storeResponseMs, result: 'ok', ...Object.fromEntries(['firstByteMs','downloadMs','connectMs'].filter(k=>Number.isSafeInteger(snapshot[k])).map(k=>[k,snapshot[k]])) });
          }
          const pending = this.pendingSchedule;
          if (pending) {
            const applied = pending.storeId === storeId && snapshot.selectedDateId === pending.dateId && (pending.action === 'date' || snapshot.ready && snapshot.selectedValue === pending.value);
            const replaced = pending.storeId !== storeId && snapshot.storeResponseVerified;
            if (applied || replaced) this.pendingSchedule = null;
            else return { ready: false, reason: 'selection-uncertain' };
          }
        }
        if (p.action === 'read'||snapshot.readAfterMutation===true) {
          if (snapshot.ready || snapshot.storeConfirmed) onStage('PICKUP_STORE_SELECTED');
          if (snapshot.selectedDateId && snapshot.dates?.some(d => d.id === snapshot.selectedDateId && !d.disabled)) onStage('PICKUP_DATE_SELECTED');
          if (snapshot.ready && snapshot.selectedValue && snapshot.slots?.some(slot => slot.value === snapshot.selectedValue && !slot.disabled)) onStage('PICKUP_TIME_SELECTED');
        }
        return snapshot;
      }
      catch (e) {
        if (p.action === 'read' && !storeResponseReported && Number.isSafeInteger(e.pickupDiagnostic?.storeResponseMs)) {
          storeResponseReported = true;
          this.onTiming?.({ name: 'calendar:store-response', durationMs: e.pickupDiagnostic.storeResponseMs, result: 'error', code: e.message, ...Object.fromEntries(['firstByteMs','downloadMs','connectMs'].filter(k=>Number.isSafeInteger(e.pickupDiagnostic[k])).map(k=>[k,e.pickupDiagnostic[k]])) });
        }
        if(p.action==='read'&&e.message==='STORE_UNVERIFIED'&&e.pickupDiagnostic){
          const count=key=>Number.isSafeInteger(e.pickupDiagnostic[key])?e.pickupDiagnostic[key]:'UNKNOWN';
          this.onTiming?.({name:'calendar:store-unverified',durationMs:0,result:'error',
            code:`CHECKED_${count('checkedStoreCount')}_CANDIDATES_${count('storeCandidateCount')}_DATES_${count('dateCount')}_SELECTORS_${count('selectorCount')}`});
        }
        if (!['SAFARI_SCRIPT_UNAVAILABLE','SAFARI_UNCERTAIN'].includes(e.message)) throw e;
        // Date/slot mutations are sent once, then reconciled by calendar reads.
        if (p.action !== 'read') this.pendingSchedule = { action: p.action, dateId: p.dateId, value: p.value, storeId };
        return p.action === 'read' ? { ready: false, reason: 'safari-updating' } : { requested: true, replyUncertain: true };
      }
    };
    let pickupAdvanced = false;
    for (let progress = 0; progress < 3; progress++) {
      const schedule = await choosePickupSchedule(read, { checkoutAt: this.now(), now: this.now, sleep: ms => this.pause(ms, 'calendar'), check, speedFirst:true,
        onWait: event => {
          const count = key => Number.isSafeInteger(event[key]) && event[key] >= 0 && event[key] <= 100 ? event[key] : 'UNKNOWN';
          this.onTiming?.({ name: 'calendar:wait-' + (/^[a-z-]{1,40}$/.test(event.reason) ? event.reason : 'unknown'), durationMs: 0, result: 'ok',
            code: `DATES_${count('dateCount')}_SELECTORS_${count('selectorCount')}_CHECKED_${count('checkedStoreCount')}_CANDIDATES_${count('storeCandidateCount')}` });
        } });
      onStage(schedule.windowMode === 'not-offered' ? 'PICKUP_TIME_NOT_OFFERED' : 'PICKUP_TIME_VERIFIED');
      let next;
      try {
        const continueDeadline = this.now() + 5000; let waitingReported = false;
        for (;;) {
        try {
        next = await this.transition('pickup-continue', { storeId, nonce: this.binding?.nonce, schedule }, ['pickup','contact','billing','review'], check, { pollMs: 100, accept: page => {
          if (page.phase !== 'pickup') return !page.pending && page.ready !== false;
          if (page.stockFailure || page.pickupStoreUnavailable) throw Error('STOCK_FAILED');
          if (page.errors) throw Error('PICKUP_VALIDATION_REQUIRED');
          // Apple can reveal the calendar in this same fulfillment step. Do
          // not spend 30 seconds waiting for contacts while time slots exist.
          return schedule.windowMode === 'not-offered' && page.pickupCalendarAvailable && !page.pending;
        } });
        break;
        } catch (error) {
          if (error.message !== 'PICKUP_CONTINUE_LOADING' || this.now() >= continueDeadline) throw error;
          if (!waitingReported) { waitingReported = true; onStage('PICKUP_CONTINUE_WAITING'); }
          await this.pause(Math.min(100, continueDeadline - this.now()), 'pickup-continue');
        }
        }
      } catch (error) {
        if (error.message !== 'PICKUP_TIME_REQUIRED') throw error;
        // The calendar appeared before the Continue click: no request was
        // sent. Select its real date/time on the existing Store instead.
        onStage('PICKUP_CALENDAR_APPEARED'); continue;
      }
      if (next.phase !== 'pickup') { pickupAdvanced = true; acceptedTransition = next; break; }
      onStage('PICKUP_CALENDAR_APPEARED');
      if (progress === 2) throw Error('PICKUP_CALENDAR_TIMEOUT');
    }
    if (!pickupAdvanced) throw Error('PICKUP_CALENDAR_TIMEOUT');
    }
    // transition() just inspected and accepted this exact page. Contact
    // mutations still check current native authorization and DOM readiness.
    state = acceptedTransition ?? state;
    if (state.phase === 'contact') {
      check(); let result;
      if (state.pickupNeedsAcceptance) await this.action('pickup-accepted', { storeId, nonce: this.binding?.nonce });
      if (this.pickupContact) {
        const deadline = this.now() + 5000;
        for (;;) {
          check();
          try {
            const prepared = await this.action('prepare-contact', { contact: this.pickupContact });
            if (prepared.readyForApplePay) { onStage('CONTACTS_READY'); return { store }; }
            break;
          }
          catch (e) {
            // A lost reply may follow a successful fill. Reconcile values
            // read-only below instead of sending the contact inputs again.
            if (['SAFARI_SCRIPT_UNAVAILABLE','SAFARI_UNCERTAIN'].includes(e.message)) break;
            if (e.message !== 'CONTACT_FIELDS_LOADING') throw e;
          }
          if (this.now() >= deadline) throw Error('CONTACT_REQUIRED');
          await this.pause(Math.min(50, deadline - this.now()), 'contact-fields');
        }
        for (;;) {
          check(); const contact = await this.evaluate(pageDOM, { action: 'contact-state', contact: this.pickupContact });
          if (contact.phase !== 'contact' || contact.paymentActive || contact.paymentDispatched) throw Error('EXISTING_CHECKOUT');
          if (!contact.pending && contact.ready && contact.fieldsReady && contact.valuesReady && (!contact.applePayRoute || contact.applePayReady)) break;
          if (contact.errors) throw Error('CONTACT_MANUAL');
          if (this.now() >= deadline) throw Error('CONTACT_REQUIRED');
          await this.pause(Math.min(50, deadline - this.now()), 'contact-fields');
        }
      }
      try { result = await this.action('contact-continue'); }
      catch (e) { if (!['SAFARI_SCRIPT_UNAVAILABLE','SAFARI_UNCERTAIN'].includes(e.message)) throw e; }
      if (result?.manualContact) throw Error('CONTACT_MANUAL');
      if (result?.readyForApplePay) { onStage('CONTACTS_READY'); return { store }; }
      await this.waitFor(['billing', 'review'], { check });
    }
    state = await this.inspect();
    if (state.phase === 'billing') { check(); await this.action('select-apple-pay'); await this.pause(400); await this.transition('review', {}, ['review'], check); }
    return { store };
  }
  async pressApplePay(selection, store, attempt, beforeDispatch, checkRetry) {
    if (selection.requireProductIdentity && this.confirmedSKU !== selection.sku) throw Error('PRODUCT_IDENTITY_UNVERIFIED');
    this.selection = selection; this.store = store;
    // Arming already performs the fresh native guard and validates the live
    // phase, total, pickup proof and contacts in the same guarded request.
    await this.action('arm-apple-pay', { selection, store, contact: this.pickupContact, attempt, nonce: this.binding.nonce });
    beforeDispatch(); // Durable intent precedes the native click, including a lost response.
    this.navigationUntil = this.now() + 180000;
    const binding = this.binding;
    try {
      return await this.request('press-apple-pay', { token: binding.nonce });
    } catch (error) {
      if (!checkRetry || error.message !== 'APPLE_PAY_HIT_CHANGED' || error.notDispatched !== true ||
          error.axTarget !== 'AX_ANCESTOR' || error.domTarget !== 'DOM_REACHABLE') throw error;
      const check = () => {
        checkRetry();
        if (this.binding !== binding) throw Error('SAFARI_TAB_CHANGED');
      };
      // Revalidate and reposition the same armed control before attempting a
      // second native hit test. The original durable intent still covers it.
      try {
        check();
        const result = await this.action('reposition-apple-pay', {
          selection, store, contact: this.pickupContact, attempt, nonce: binding.nonce,
        });
        if (result?.repositioned !== true) throw Error('APPLE_PAY_ARM_CHANGED');
        check();
      } catch {
        // Preparation sends no input. The first native refusal is still valid.
        throw error;
      }
      this.onTiming?.({name:'payment:retry-same-page',durationMs:0,result:'ok',code:'APPLE_PAY_HIT_CHANGED'});
      // A lost reply here must propagate without borrowing the first refusal.
      return this.request('press-apple-pay', { token: binding.nonce, allowNavigation: false });
    }
  }
}
