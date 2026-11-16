import test from 'node:test';
import assert from 'node:assert/strict';
import {SafariSessions} from './safari-sessions.mjs';
const black={sku:'AAAA1J/A',name:'Test 256GB Black',currency:'JPY',priceJPY:100000,productId:'https://www.apple.com/jp/shop/buy-iphone/test',url:'https://www.apple.com/jp/shop/product/AAAA1J/A',stores:['R119'],requireProductIdentity:true};
const white={...black,sku:'BBBB2J/A',name:'Test 256GB White',url:'https://www.apple.com/jp/shop/product/BBBB2J/A'};
const session=()=>({bound:false,fulfillmentMode:'pickup',calls:[],expected(s){this.selection=s;},setPickupContact(c){this.contact=c;},snapshot(){return{bound:this.bound,phase:'pickup',fulfillmentMode:this.fulfillmentMode,pickupPreparation:{state:'stores-ready'}};},async bind(){this.bound=true;this.binding={};this.calls.push('bind');},async prepareBag(s){this.calls.push('bag:'+s.sku);this.confirmedSKU=s.sku;},async preparePickup(){this.calls.push('postal');return{state:'stores-ready'};},async maintain(){this.calls.push('maintain');return{maintained:true};},async prepareCheckout(s){this.calls.push('checkout:'+s.sku);return{store:{id:'R119'}};},async pressApplePay(s,store,id,before){before();this.calls.push('pay:'+s.sku);},async paymentStatus(){return{known:true,active:false};},async inspect(){return{phase:'pickup',ready:true};}});
const fixture=()=>{const a=session(),b=session(),r=new SafariSessions({directory:'/unused-fixture',primary:a,factory:()=>b});r.configureSelections([black,white]);return{a,b,r};};
test('separate colour sessions prepare both carts once and route a white signal to its own warmed session',async()=>{
 const{a,b,r}=fixture();await r.prepareSelections([black,white],()=>{});assert.equal(a.confirmedSKU,black.sku);assert.equal(b.confirmedSKU,white.sku);await r.prepareCheckout(white,'R119',()=>{});assert.ok(b.calls.includes('checkout:'+white.sku));assert.ok(!a.calls.some(x=>x.startsWith('checkout:')));assert.equal(r.snapshot().variants.filter(v=>v.skuVerified).length,2);
});
test('keeper rotates colour sessions only after its current operation and yields to a fresh signal',async()=>{
 const{a,b,r}=fixture();await r.prepareSelections([black,white],()=>{});await r.maintain(()=>{},()=>true);assert.equal(r.active,a);await r.maintain(()=>{},()=>false);assert.equal(r.active,b);assert.equal(b.calls.filter(x=>x==='maintain').length,0);await r.maintain(()=>{},()=>false);assert.equal(r.active,a);
});
test('an uncertain session preparation prevents fleet readiness and leaves other colour payments untouched',async()=>{
 const{a,b,r}=fixture();b.preparePickup=async()=>({waiting:true});const p=await r.prepareSelections([black,white],()=>{});assert.equal(p.waiting,true);assert.ok(!a.calls.concat(b.calls).some(v=>v.startsWith('pay:')));
});
test('after a verified white rebuild only the independent prepared black pickup can skip preparation',async()=>{
 const {a,b,r}=fixture();
 a.binding={window:1,nonce:'black',pid:1,started:1};b.binding={window:2,nonce:'white',pid:1,started:1};
 a.reusePreparedPickup=async s=>{assert.equal(s.sku,black.sku);a.calls.push('verified-reuse');return true;};
 b.reusePreparedPickup=async()=>{assert.fail('must prepare the failed colour');};
 await r.prepareSelections([black,white],()=>{},undefined,{rebuildSKU:white.sku});
 assert.deepEqual(a.calls,['verified-reuse']);assert.deepEqual(b.calls,['bind','bag:'+white.sku,'postal']);
 assert.equal(r.snapshot().preparedPickupReuses,1);assert.equal(r.active,a);
});
test('startup or an unverified sibling still uses the full preparation path',async()=>{
 for(const mode of ['startup','same-window','invalid-page']){
  const {a,b,r}=fixture();
  a.binding={window:1,nonce:'black',pid:1,started:1};b.binding={window:mode==='same-window'?1:2,nonce:'white',pid:1,started:1};
  a.reusePreparedPickup=async()=>{assert.equal(mode,'invalid-page');return false;};
  await r.prepareSelections([black,white],()=>{},undefined,{
    rebuildSKU:mode==='startup'?undefined:white.sku,
    onPreparedSibling:()=>assert.fail('a healthy independent pickup was not verified'),
  });
  assert.deepEqual(a.calls,['bind','bag:'+black.sku,'postal']);assert.equal(r.snapshot().preparedPickupReuses,0);
 }
});
test('the independent sibling is verified before starting a black pickup rebuild', async () => {
 const {a,b,r} = fixture();
 a.binding = {window:1,nonce:'black',pid:1,started:1};
 b.binding = {window:2,nonce:'white',pid:1,started:1};
 const order = [];
 b.reusePreparedPickup = async () => { order.push('verify white'); return true; };
 a.prepareBag = async () => { order.push('restore black'); };
 await r.prepareSelections([black,white],()=>{},undefined,{
   rebuildSKU:black.sku,
   onPreparedSibling:async()=>{ order.push('resume stock'); },
 });
 assert.deepEqual(order,['verify white','resume stock','restore black']);
});
for (const arrival of ['before-rebuild','after-bag']) {
  test('a fresh sibling signal defers rebuild at a safe boundary: '+arrival, async () => {
    const {a,b,r} = fixture();
    a.binding={window:1,nonce:'black',pid:1,started:1}; b.binding={window:2,nonce:'white',pid:1,started:1};
    a.reusePreparedPickup=async()=>true;
    let signal=false, resumeCount=0;
    const prepareBag=b.prepareBag.bind(b);
    b.prepareBag=async selection=>{
      await prepareBag(selection);
      if(arrival==='after-bag')signal=true;
    };
    const result=await r.prepareSelections([black,white],()=>{},()=>signal,{
      rebuildSKU:white.sku,
      onPreparedSibling:async()=>{resumeCount++;signal=arrival==='before-rebuild';},
    });
    assert.equal(result.partial,true);
    assert.equal(resumeCount,1);
    assert.equal(r.active,a);
    assert.equal(r.routeAvailable(white.sku),false);
    assert.deepEqual(b.calls,arrival==='before-rebuild'?[]:['bind','bag:'+white.sku]);
    signal=false;
    b.prepareBag=prepareBag;
    await r.maintain(()=>{},()=>signal);
    assert.equal(r.routeAvailable(white.sku),true);
    assert.equal(b.calls.filter(call=>call==='postal').length,1);
  });
}
for (const blocked of [black, white]) {
  test('an inaccessible independent colour leaves the other available and returns after verification: ' + blocked.sku, async () => {
    const {a,b,r} = fixture();
    const bind = (s,window,nonce) => async () => {
      s.binding = {window,nonce,pid:1,started:1};
      s.bound = true;
      s.calls.push('bind');
    };
    a.bind = bind(a,1,'black');
    b.bind = bind(b,2,'white');
    await a.bind();
    await b.bind();
    const broken = r.sessions.get(blocked.sku);
    const healthy = blocked === black ? b : a;
    const originalBind = broken.bind;
    broken.bind = async () => { throw Error('SAFARI_ROUTE_CHANGED'); };
    const result = await r.prepareSelections([black,white], () => {}, undefined, {allowPartial:true});
    assert.equal(result.partial,true);
    assert.equal(r.active,healthy);
    assert.equal(r.routeAvailable(blocked.sku),false);
    assert.equal(r.snapshot().variants.find(v=>v.sku===blocked.sku).routeBlocked,true);
    await assert.rejects(r.prepareCheckout(blocked), /SAFARI_ROUTE_CHANGED/);
    assert.equal((await r.maintain(() => {})).partial,true);
    assert.equal(r.active,healthy);
    broken.bind = originalBind;
    r.blockedRoutes.set(blocked.sku,0);
    assert.equal((await r.maintain(() => {})).partial,false);
    assert.equal(r.routeAvailable(blocked.sku),true);
    assert.equal(r.readyForCheckout(blocked.sku),true);
  });
}
for (const unsafe of ['same-window','native-active','native-unknown','both-unavailable','partial-disabled']) {
  test('an inaccessible colour remains blocked during ' + unsafe, async () => {
    const {a,b,r} = fixture();
    a.binding = {window:1,nonce:'black',pid:1,started:1};
    b.binding = {window:unsafe==='same-window'?1:2,nonce:'white',pid:1,started:1};
    a.bind = async () => {
      if (unsafe === 'both-unavailable') throw Error('SAFARI_ROUTE_CHANGED');
      a.bound = true;
    };
    b.bind = async () => { throw Error('SAFARI_ROUTE_CHANGED'); };
    b.paymentStatus = async () => ({ known:unsafe!=='native-unknown', active:unsafe==='native-active' });
    const expected = unsafe==='native-active' ? 'PAYMENT_ACTIVE' : unsafe==='native-unknown' ? 'ACCESSIBILITY_REQUIRED' : 'SAFARI_ROUTE_CHANGED';
    await assert.rejects(r.prepareSelections([black,white], () => {}, undefined, {
      allowPartial:unsafe !== 'partial-disabled',
    }), new RegExp(expected));
    assert.ok(!a.calls.concat(b.calls).some(v=>v.startsWith('pay:')));
  });
}
test('manual stop during the first colour prevents any second-colour preparation',async()=>{
 const{a,b,r}=fixture();let stopped=false;a.prepareBag=async()=>{stopped=true;};await assert.rejects(r.prepareSelections([black,white],()=>{if(stopped)throw Error('STOPPED');}),/STOPPED/);assert.deepEqual(b.calls,[]);
});
test('a payment cannot silently switch to another colour and unknown SKUs are rejected',async()=>{
 const{r}=fixture();let intents=0;assert.throws(()=>r.pressApplePay(white,{id:'R119'},'id',()=>intents++),/PRODUCT_IDENTITY_UNVERIFIED/);assert.throws(()=>r.expected({...white,sku:'OTHER1J/A'}),/PRODUCT_IDENTITY_UNVERIFIED/);assert.equal(intents,0);
});

test('fresh availability callbacks stay attached to both independently owned colour sessions',()=>{
 const{a,b,r}=fixture(),seen=[];const callback=value=>{seen.push(value.sku);return true;};r.onAvailability=callback;
 assert.equal(a.onAvailability,callback);assert.equal(b.onAvailability,callback);a.onAvailability({sku:black.sku});b.onAvailability({sku:white.sku});assert.deepEqual(seen,[black.sku,white.sku]);
 r.configureSelections([black,white]);assert.equal(a.onAvailability,callback);assert.equal(b.onAvailability,callback);
});

test('a warmed colour reaches its guarded checkout without another passive binding round trip',async()=>{
 const{a,b,r}=fixture();await r.prepareSelections([black,white],()=>{});const before=b.calls.filter(v=>v==='bind').length;await r.prepareCheckout(white,'R119',()=>{});assert.equal(b.calls.filter(v=>v==='bind').length,before);assert.ok(b.calls.includes('checkout:'+white.sku));assert.ok(!a.calls.some(v=>v.startsWith('checkout:')));
});

test('keeper suspension requires a separately prepared other colour and exposes a single yield',async()=>{
 const{a,b,r}=fixture();await r.prepareSelections([black,white],()=>{});let observed=false;r.priorityCandidate=()=>({sku:white.sku});a.maintain=async(check,yielding,{canSuspend})=>{observed=canSuspend();return{suspended:observed,yielded:observed};};
 const result=await r.maintain(()=>{},()=>true);assert.equal(result.suspended,true);assert.equal(observed,true);assert.equal(r.snapshot().priorityYields,1);assert.equal(r.active,a);
 b.pendingMode='pickup';a.keeperSuspended=false;await r.maintain(()=>{},()=>true);assert.equal(observed,false);
});
