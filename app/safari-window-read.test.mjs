import test from 'node:test';
import assert from 'node:assert/strict';
import { SafariSession } from './safari.mjs';
import { STORES } from './shared.mjs';

function fixture({kind='inspect',firstError='SAFARI_TAB_CHANGED',secondError,ui={known:true,active:false},afterWait=()=>{}}={}){
 let clock=1000,targetReads=0;const calls=[],waits=[];
 const s=new SafariSession({bindingPath:null,now:()=>clock,sleep:async ms=>{waits.push(ms);clock+=ms;await afterWait(s);},invoke:async r=>{
  calls.push(r);
  if(r.observeOnly!==true){targetReads++;if(targetReads===1&&firstError)throw Error(firstError);if(targetReads===2&&secondError)throw Error(secondError);}
  if(r.operation==='payment-status')return ui;
  assert.ok(['evaluate','evaluate-guarded'].includes(r.operation));
  return{appleLoopEnvelope:1,ok:true,value:{phase:'pickup',fulfillmentMode:'pickup',ready:true,pending:false}};
 }});
 s.binding=Object.freeze({pid:123,started:456,window:789,nonce:'00000000-0000-4000-8000-000000000001'});
 return{s,calls,waits,run:()=>kind==='bind'?s.bind():s.inspect()};
}

for(const kind of ['inspect','bind'])test('transient '+kind+' loss retries only the original bound window',async()=>{
 const f=fixture({kind}),binding=f.s.binding;let discovered=0;f.s.canRebind=()=>{discovered++;return false;};
 await f.run();assert.equal(f.calls.length,kind==='bind'?3:2);assert.deepEqual(f.waits,[100]);assert.equal(discovered,0);
 assert.ok(f.calls.every(r=>r.binding===binding&&r.allowNavigation===false));assert.equal(f.s.binding,binding);
 if(kind==='inspect')assert.equal(f.calls[1].operation,'evaluate-guarded');
});
for(const kind of ['inspect','bind'])test('persistent '+kind+' loss remains bounded and never adopts a tab',async()=>{
 const f=fixture({kind,secondError:'SAFARI_TAB_CHANGED'});await assert.rejects(f.run(),/SAFARI_TAB_CHANGED/);assert.equal(f.calls.length,kind==='bind'?3:2);assert.deepEqual(f.waits,[100]);
});
for(const kind of ['inspect','bind'])test('changing ownership while '+kind+' waits prevents its retry',async()=>{
 const f=fixture({kind,afterWait:s=>{s.binding={...s.binding,nonce:'different-owner'};}});await assert.rejects(f.run(),/SAFARI_TAB_CHANGED/);assert.equal(f.calls.length,1);
});
test('an ownership change while waiting prevents even otherwise permitted discovery',async()=>{
 const f=fixture({kind:'bind',afterWait:s=>{s.binding={...s.binding,window:999};}});f.s.canRebind=()=>true;
 await assert.rejects(f.run(),error=>error.message==='SAFARI_TAB_CHANGED'&&error.bindingChanged===true);assert.equal(f.calls.length,1);
});
for(const code of ['SAFARI_FOREIGN_OWNER','SAFARI_ROUTE_CHANGED','SAFARI_SCRIPT_UNAVAILABLE','SAFARI_CHANGED'])test('ordinary inspection never retries '+code,async()=>{
 const f=fixture({firstError:code});await assert.rejects(f.run(),new RegExp(code));assert.equal(f.calls.length,1);assert.deepEqual(f.waits,[]);
});
for(const ui of [{known:true,active:true},{known:false,active:false}])test('bound-window retry stops for native state '+JSON.stringify(ui),async()=>{
 const f=fixture({kind:'bind',ui});await assert.rejects(f.run(),ui.active?/PAYMENT_ACTIVE/:/ACCESSIBILITY_REQUIRED/);assert.equal(f.calls.length,2);assert.ok(f.calls.every(r=>r.operation==='payment-status'));
});
test('a missing native status cannot establish a successful bound-window retry',async()=>{
 const f=fixture({kind:'bind',ui:null});await assert.rejects(f.run(),/ACCESSIBILITY_REQUIRED/);assert.equal(f.calls.length,2);
});
test('an incomplete native window read is distinct from a denied Accessibility permission',async()=>{
 const f=fixture({kind:'bind',ui:{known:false,active:false,code:'SAFARI_AX_UNAVAILABLE'}});
 await assert.rejects(f.run(),/^Error: SAFARI_AX_UNAVAILABLE$/);
 assert.equal(f.calls.length,2);
});
test('a failed discovery keeps an existing binding and its original window error',async()=>{
 const f=fixture({kind:'bind'}), binding=f.s.binding;
 f.s.canRebind=()=>true;
 f.s.invoke=async request=>{
  if(request.operation==='bind')throw Error('SAFARI_TAB_REQUIRED');
  if(request.observeOnly)return {known:true,active:false};
  throw Error('SAFARI_TAB_CHANGED');
 };
 await assert.rejects(f.run(),/^Error: SAFARI_TAB_CHANGED$/);
 assert.equal(f.s.binding,binding);
});
test('a transient CAP status read recovers in the same guarded window without resubmitting CAP',async()=>{
 const f=fixture(), binding=f.s.binding, calls=[], stages=[];
 const id='00000000-0000-4000-8000-000000000002';
 f.s.pendingPostal={storeId:STORES[0].id,id,stage:'submitted'};
 f.s.evaluate=async(_fn,p,options)=>{
  calls.push({p,options,binding:f.s.binding});
  if(calls.length===1)throw Error('SAFARI_TAB_CHANGED');
  return {phase:'pickup',fulfillmentMode:'pickup',ready:true,refreshSubmitted:true,refreshComplete:true};
 };
 f.s.action=async()=>assert.fail('CAP was submitted twice');
 await f.s.refreshStoreAvailability(STORES[0],()=>{},25000,code=>stages.push(code));
 assert.deepEqual(stages,['SAFARI_POSTAL_READ_RETRY','PICKUP_POSTAL_RESPONSE_VERIFIED']);
 assert.equal(calls.length,2);
 assert.ok(calls.every(r=>r.binding===binding&&r.p.action==='postal-state'&&r.p.refreshId===id));
 assert.deepEqual(calls[1].options,{guardPayment:true,strictBinding:true});
 assert.equal(f.s.pendingPostal,null);
});
test('authorization appearing after the quiet observation still blocks binding recovery',async()=>{
 const f=fixture({kind:'bind'});let targetReads=0;
 f.s.invoke=async r=>{f.calls.push(r);if(r.observeOnly===true)return{known:true,active:false};if(++targetReads===1)throw Error('SAFARI_TAB_CHANGED');return{known:true,active:true};};
 await assert.rejects(f.run(),/PAYMENT_ACTIVE/);assert.equal(targetReads,2);assert.equal(f.calls.length,3);assert.ok(f.calls.every(r=>r.operation==='payment-status'));
});
test('a payment-result inspection retains its existing no-retry boundary',async()=>{
 const f=fixture();await assert.rejects(f.s.inspect({paymentContext:{id:'fixture'}}),/SAFARI_TAB_CHANGED/);assert.equal(f.calls.length,1);assert.deepEqual(f.waits,[]);
});
for(const kind of ['inspect','bind'])test('healthy '+kind+' reads add no retry or delay',async()=>{
 const f=fixture({kind,firstError:null});await f.run();assert.equal(f.calls.length,1);assert.deepEqual(f.waits,[]);
});

function calendarFixture(mode){
 let clock=Date.UTC(2026,10,11,3),stopped=false,reads=0;
 const waits=[],calls=[],stages=[],moves=[];
 const binding=Object.freeze({pid:123,window:456,nonce:'00000000-0000-4000-8000-000000000001'});
 const s=new SafariSession({bindingPath:null,now:()=>clock,sleep:async ms=>{
  waits.push(ms);clock+=ms;
  if(mode==='stop')stopped=true;
  if(mode==='binding-changed')s.binding={...binding,window:999};
 }});
 s.binding=binding;s.pickupContact={};s.inspect=async()=>({phase:'pickup',fulfillmentMode:'pickup',storeState:'selected',pending:false,ready:true});
 s.paymentStatus=async()=>({known:true,active:false});
 s.evaluate=async(_fn,p,{guardPayment,strictBinding})=>{
  calls.push({action:p.action,guardPayment,strictBinding,binding:s.binding});
  if(p.action!=='read')throw Error('SAFARI_TAB_CHANGED');
  reads++;
  if(mode.startsWith('process-')&&(reads===1||mode==='process-persistent'))throw Error('SAFARI_CHANGED');
  if((mode!=='healthy'&&mode!=='lost-mutation'&&reads===1)||mode==='persistent'&&reads===2||mode==='second-loss'&&reads===3)throw Error('SAFARI_TAB_CHANGED');
  if(mode==='native-active')throw Error('PAYMENT_ACTIVE');
  if(mode==='native-unknown')throw Error('ACCESSIBILITY_REQUIRED');
  if(mode==='second-loss')return{ready:false,reason:'store-response-pending'};
  return{ready:true,storeResponseVerified:true,selectedDateId:'date11',selectedValue:mode==='lost-mutation'?null:'11-15:00-15:15',dates:[{id:'date11',label:'November11',disabled:false}],slots:[{value:'11-15:00-15:15',disabled:false}]};
 };
 s.transition=async action=>{moves.push(action);return{phase:'contact',pending:false,ready:true};};
 s.action=async action=>{moves.push(action);return{readyForApplePay:true};};
 const selection={sku:'AAAA1J/A',priceJPY:100000,stores:['R119']};
 return{calls,waits,stages,moves,binding,run:()=>s.prepareCheckout(selection,'R119',()=>{if(stopped)throw Error('STOPPED');},code=>stages.push(code))};
}

test('the calendar reconciles one lost read without repeating CAP, Store or slot selection',async()=>{
 const f=calendarFixture('recovered');await f.run();
 assert.deepEqual(f.calls.map(x=>[x.action,x.guardPayment]),[['read',false],['read',true]]);
 assert.ok(f.calls.every(x=>x.binding===f.binding));assert.deepEqual(f.waits,[100]);
 assert.ok(f.stages.includes('SAFARI_CALENDAR_READ_RETRY'));assert.deepEqual(f.moves,['pickup-continue','prepare-contact']);
});
test('a transient process check retries the same owned calendar with no navigation allowance',async()=>{
 const f=calendarFixture('process-recovered');await f.run();
 assert.deepEqual(f.calls.map(x=>[x.action,x.guardPayment,x.strictBinding]),[['read',false,false],['read',true,true]]);
 assert.ok(f.calls.every(x=>x.binding===f.binding));assert.deepEqual(f.waits,[100]);
 assert.deepEqual(f.stages.filter(x=>x.includes('READ_RETRY')),['SAFARI_CALENDAR_PROCESS_READ_RETRY']);
 assert.deepEqual(f.moves,['pickup-continue','prepare-contact']);
});
test('a repeated process identity failure cannot advance the calendar or checkout',async()=>{
 const f=calendarFixture('process-persistent');await assert.rejects(f.run(),/SAFARI_CHANGED/);
 assert.equal(f.calls.length,2);assert.ok(f.calls.every(x=>x.action==='read'&&x.binding===f.binding));
 assert.deepEqual(f.moves,[]);assert.deepEqual(f.waits,[100]);
});
test('the strict guarded retry disables owner adoption even in a navigation window',async()=>{
 const s=new SafariSession({bindingPath:null,now:()=>1000,invoke:async r=>{
  assert.equal(r.operation,'evaluate-guarded');assert.equal(r.allowNavigation,false);
  assert.equal(r.binding,s.binding);
  return {appleLoopEnvelope:1,ok:true,value:{ready:true}};
 }});
 s.binding=Object.freeze({pid:123,started:456,window:789,nonce:'fixture'});s.navigationUntil=2000;
 await s.evaluate(()=>({ready:true}),{action:'read'},{guardPayment:true,strictBinding:true});
});
test('a healthy calendar has no extra read, delay or advisory event',async()=>{
 const f=calendarFixture('healthy');await f.run();assert.equal(f.calls.length,1);assert.deepEqual(f.waits,[]);
 assert.ok(!f.stages.includes('SAFARI_CALENDAR_READ_RETRY'));
});
for(const [mode,code,count] of [
 ['persistent','SAFARI_TAB_CHANGED',2],['second-loss','SAFARI_TAB_CHANGED',3],['binding-changed','SAFARI_TAB_CHANGED',1],['stop','STOPPED',1],
 ['native-active','PAYMENT_ACTIVE',2],['native-unknown','ACCESSIBILITY_REQUIRED',2],['lost-mutation','SAFARI_TAB_CHANGED',2]
])test('calendar read recovery preserves the boundary for '+mode,async()=>{
 const f=calendarFixture(mode);await assert.rejects(f.run(),new RegExp(code));assert.equal(f.calls.length,count);assert.deepEqual(f.moves,[]);
 if(mode==='lost-mutation'){assert.deepEqual(f.calls.map(x=>x.action),['read','slot']);assert.deepEqual(f.waits,[]);}
 else assert.ok(f.calls.every(x=>x.action==='read'&&x.binding===f.binding));
 assert.ok(f.stages.filter(x=>x==='SAFARI_CALENDAR_READ_RETRY').length<=1);
});
