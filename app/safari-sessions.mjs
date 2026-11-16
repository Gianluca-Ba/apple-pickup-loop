import { SafariSession, requireQuietSafari } from './safari.mjs';
import { validateSelection } from './shared.mjs';
import { join } from 'node:path';

function independentWindows(first, second) {
  return first && second && Number.isSafeInteger(first.window) && Number.isSafeInteger(second.window) &&
    first.window !== second.window && typeof first.nonce === 'string' && typeof second.nonce === 'string' &&
    first.nonce !== second.nonce && Number.isSafeInteger(first.pid) && first.pid === second.pid &&
    Number.isFinite(first.started) && first.started === second.started;
}

// Separate Safari profiles keep the two carts independent. The controller is
// still the sole payment arbiter; this router never starts a checkout itself.
export class SafariSessions {
  constructor({ directory, primary = new SafariSession({bindingPath:join(directory,'safari-binding.json')}), factory = selection => new SafariSession({bindingPath:join(directory,'safari-alternative-'+selection.sku.replaceAll('/','-')+'.json')}) } = {}) {
    this.primary=primary; this.factory=factory; this.sessions=new Map(); this.configured=[]; this.active=primary;
    this.blockedRoutes = new Map();
  }
  configureSelections(selections) {
    if (!Array.isArray(selections)||selections.length>2)throw Error('SELECTION_INVALID');
    for(const s of selections)validateSelection(s);
    const old=this.sessions, next=new Map();
    selections.forEach((s,i)=>{const session=old.get(s.sku)??(i===0?this.primary:this.factory(s));session.expected(s);session.onTiming=this.onTiming;session.onAvailability=this.onAvailability;session.canRebind=this.canRebind??(()=>false);session.setPickupContact?.(this.contact);next.set(s.sku,session);});
    this.configured=structuredClone(selections);this.sessions=next;
    for (const sku of this.blockedRoutes.keys()) if (!next.has(sku)) this.blockedRoutes.delete(sku);
    if(![...next.values()].includes(this.active))this.active=next.values().next().value??this.primary;
  }
  use(selection) {
    const session=this.sessions.get(selection?.sku);
    if(!session){if(this.configured.length>1)throw Error('PRODUCT_IDENTITY_UNVERIFIED');this.active=this.primary;}
    else this.active=session;
    return this.active;
  }
  expected(selection,storeId){if(selection)this.use(selection).expected(selection,storeId);}
  set onTiming(value){this.timing=value;for(const s of new Set([this.primary,...this.sessions?.values()??[]]))s.onTiming=value;}
  get onTiming(){return this.timing;}
  set onAvailability(value){this.availabilityCallback=value;for(const s of new Set([this.primary,...this.sessions?.values()??[]]))s.onAvailability=value;}
  get onAvailability(){return this.availabilityCallback;}
  set canRebind(value){this.rebind=value;for(const s of new Set([this.primary,...this.sessions?.values()??[]]))s.canRebind=value;}
  get canRebind(){return this.rebind;}
  get binding(){return this.active.binding;}
  setPickupContact(value){this.contact=value;for(const s of new Set([this.primary,...this.sessions.values()]))s.setPickupContact?.(value);}
  snapshot(){return{...this.active.snapshot(),priorityYields:this.priorityYields??0,preparedPickupReuses:this.preparedPickupReuses??0,variants:this.configured.map(v=>({sku:v.sku,name:v.name,active:this.sessions.get(v.sku)===this.active,suspended:this.sessions.get(v.sku).keeperSuspended===true,skuVerified:this.sessions.get(v.sku).confirmedSKU===v.sku,...this.sessions.get(v.sku).snapshot(),...(this.blockedRoutes.has(v.sku)?{phase:'unavailable',fulfillmentMode:null,routeBlocked:true}:{})}))};}
  bind(){return this.active.bind();}
  inspect(...args){return this.active.inspect(...args);}
  paymentStatus(){return this.active.paymentStatus();}
  action(...args){return this.active.action(...args);}
  transition(...args){return this.active.transition(...args);}
  navigateBag(...args){return this.active.navigateBag(...args);}
  refreshPickup(...args){return this.active.refreshPickup(...args);}
  async prepareBag(selection,check){const s=this.use(selection);await s.bind();return s.prepareBag(selection,check);}
  preparePickup(...args){return this.active.preparePickup(...args);}
  async prepareSelections(selections,check,shouldYield=()=>false,{rebuildSKU,onPreparedSibling,allowPartial=false}={}){
    const previous=this.active;
    const rebuild=selections.length===2&&selections.find(s=>s.sku===rebuildSKU);
    const preparationOrder = rebuild ? [selections.find(s => s !== rebuild), rebuild] : selections;
    const prepared = [];
    let reusedSibling = null;
    for(const selection of preparationOrder){
      check();const s=this.use(selection);
      if(rebuild&&selection!==rebuild&&s.reusePreparedPickup){
        if(independentWindows(this.sessions.get(rebuild.sku)?.binding,s.binding)&&await s.reusePreparedPickup(selection,check)){
          check();this.preparedPickupReuses=(this.preparedPickupReuses??0)+1;
          await onPreparedSibling?.();
          check();reusedSibling=s;prepared.push(s);continue;
        }
      }
      try {
        const canDefer = selection === rebuild && reusedSibling !== null;
        const p = canDefer && shouldYield() ? { yielded:true } :
          await this.prepareVariant(s, selection, check, shouldYield, { canDefer });
        if (canDefer && p?.yielded) {
          // The healthy profile can act on its stock signal. Revisit the
          // other profile through ordinary maintenance after that attempt.
          this.blockedRoutes.set(selection.sku, Date.now());
          this.active = reusedSibling;
          return {...reusedSibling.snapshot().pickupPreparation,partial:true};
        }
        if (p?.waiting) return p;
        this.blockedRoutes.delete(selection.sku);
        prepared.push(s);
      } catch (error) {
        const sibling = selections.find(other => other.sku !== selection.sku);
        if (error.message !== 'SAFARI_ROUTE_CHANGED' || !allowPartial ||
            !independentWindows(s.binding, this.sessions.get(sibling?.sku)?.binding)) throw error;
        const ui = await s.paymentStatus();
        check();
        requireQuietSafari(ui);
        this.blockedRoutes.set(selection.sku, Date.now() + 20000);
      }
    }
    if (!prepared.length) throw Error('SAFARI_ROUTE_CHANGED');
    this.active = prepared.includes(previous) ? previous : prepared[0];
    return {...this.active.snapshot().pickupPreparation, partial:this.blockedRoutes.size > 0};
  }
  async prepareVariant(session, selection, check, shouldYield, { canDefer = false } = {}) {
    await session.bind(); check();
    if (canDefer && shouldYield()) return { yielded:true };
    await session.prepareBag(selection, check); check();
    if (canDefer && shouldYield()) return { yielded:true };
    const result = await session.preparePickup?.(check, shouldYield); check();
    return result;
  }
  routeAvailable(sku) { return !this.blockedRoutes.has(sku); }
  readyForCheckout(sku){const s=this.sessions.get(sku),p=s?.snapshot();return Boolean(this.routeAvailable(sku)&&s&&s.binding!==null&&p.bound&&s.confirmedSKU===sku&&(s.lastPagePhase??p.phase)==='pickup'&&p.fulfillmentMode==='pickup'&&!s.pendingMode&&!s.pendingPostal&&!s.keeperSuspended);}
  preferredPickupStore(selection,storeIds){return this.sessions.get(selection.sku)?.preferredPickupStore?.(selection,storeIds)??null;}
  restoreStaleKeeper(...args){return this.active.restoreStaleKeeper(...args);}
  async maintain(check,shouldYield=()=>false){
    const owner=this.active;
    const canSuspend=()=>{const candidate=this.priorityCandidate?.();return Boolean(candidate&&candidate.sku!==owner.selection?.sku&&this.readyForCheckout(candidate.sku));};
    const result=await owner.maintain(check,shouldYield,{canSuspend});check();
    owner.keeperSuspended=result.suspended===true;
    if(result.suspended)this.priorityYields=(this.priorityYields??0)+1;
    if(result.suspended)this.onTiming?.({name:'keeper:yield-other-colour',durationMs:0,result:'ok'});
    if(!shouldYield()&&this.configured.length>1&&!result.expired&&!result.manual){
      const [blocked] = this.configured.filter(s => this.blockedRoutes.has(s.sku));
      if (blocked && this.blockedRoutes.get(blocked.sku) <= Date.now()) {
        this.blockedRoutes.set(blocked.sku, Date.now() + 20000);
        const session = this.sessions.get(blocked.sku);
        try {
          const recovered = await this.prepareVariant(session, blocked, check, shouldYield);
          if (!recovered?.waiting && !recovered?.yielded) this.blockedRoutes.delete(blocked.sku);
        } catch (error) {
          if (!['SAFARI_ROUTE_CHANGED','SAFARI_SCRIPT_UNAVAILABLE','PAGE_TRANSITION_UNCERTAIN','LOGIN_REQUIRED'].includes(error.message)) throw error;
        }
      }
      const entries=[...this.sessions].filter(([sku])=>this.routeAvailable(sku)).map(([,session])=>session);
      const index=entries.indexOf(this.active);this.active=entries[(index+1)%entries.length];
    }
    return {...result,partial:this.blockedRoutes.size > 0};
  }
  async prepareCheckout(selection,...args){if(!this.routeAvailable(selection.sku))throw Error('SAFARI_ROUTE_CHANGED');const s=this.use(selection),started=s.now?.()??Date.now();let result='ok',code;try{if(!s.binding)await s.bind();}catch(error){result='error';code=/^[A-Z][A-Z_0-9]{0,79}$/.test(error.message)?error.message:'SESSION_UNVERIFIED';throw error;}finally{this.onTiming?.({name:'session:activate',durationMs:Math.max(0,(s.now?.()??Date.now())-started),result,...(code?{code}:{})});}return s.prepareCheckout(selection,...args);}
  pressApplePay(selection,...args){if(this.sessions.size>1&&this.sessions.get(selection.sku)!==this.active)throw Error('PRODUCT_IDENTITY_UNVERIFIED');return this.active.pressApplePay(selection,...args);}
}
