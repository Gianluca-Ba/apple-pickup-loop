import test from 'node:test';
import assert from 'node:assert/strict';
import { SafariSession } from './safari.mjs';

const selection={sku:'AAAA1J/A',priceJPY:100000,stores:['R119'],requireProductIdentity:true};
function fixture({firstError='SAFARI_TAB_CHANGED',retryError,afterWait=()=>{}}={}){
 let now=1000;const calls=[],waits=[],stages=[];
 const session=new SafariSession({bindingPath:null,now:()=>now,sleep:async ms=>{waits.push(ms);now+=ms;await afterWait(session);},invoke:async r=>{
  calls.push(r);assert.ok(['evaluate','evaluate-guarded'].includes(r.operation),'entry read must never bind, navigate or press payment');
  if(calls.length===1&&firstError)throw Error(firstError);
  if(calls.length===2&&retryError)throw Error(retryError);
  return{appleLoopEnvelope:1,ok:true,value:{phase:'authentication',pending:false,ready:true}};
 }});
 session.binding=Object.freeze({pid:123,window:456,nonce:'00000000-0000-4000-8000-000000000001'});session.confirmedSKU=selection.sku;
 return{session,calls,waits,stages,run:(check=()=>{})=>session.prepareCheckout(selection,'R119',check,s=>stages.push(s))};
}

test('a short same-binding entry read retry replaces the slow controller retry',async()=>{
 const f=fixture(),binding=f.session.binding;
 await assert.rejects(f.run(),/LOGIN_REQUIRED/);
 assert.deepEqual(f.waits,[100]);assert.equal(f.calls.length,2);
 assert.deepEqual(f.calls.map(r=>r.operation),['evaluate','evaluate-guarded']);
 assert.ok(f.calls.every(r=>r.binding===binding&&r.allowNavigation===false));
 assert.equal(f.session.binding,binding);assert.deepEqual(f.stages,['SAFARI_ENTRY_READ_RETRY']);
});
test('an entry that stays unverifiable fails after one bounded read retry',async()=>{
 const f=fixture({retryError:'SAFARI_TAB_CHANGED'});await assert.rejects(f.run(),/SAFARI_TAB_CHANGED/);
 assert.equal(f.calls.length,2);assert.deepEqual(f.waits,[100]);
});
test('a missing checkout script reply gets one guarded same-target read without owner adoption',async()=>{
 const f=fixture({firstError:'SAFARI_SCRIPT_UNAVAILABLE'}),binding=f.session.binding;f.session.navigationUntil=5000;
 await assert.rejects(f.run(),/LOGIN_REQUIRED/);
 assert.deepEqual(f.calls.map(r=>[r.operation,r.allowNavigation]),[['evaluate',true],['evaluate-guarded',false]]);
 assert.ok(f.calls.every(r=>r.binding===binding));assert.deepEqual(f.waits,[100]);
 assert.deepEqual(f.stages,['SAFARI_ENTRY_SCRIPT_READ_RETRY']);
});
test('a second missing checkout script reply cannot advance checkout',async()=>{
 const f=fixture({firstError:'SAFARI_SCRIPT_UNAVAILABLE',retryError:'SAFARI_SCRIPT_UNAVAILABLE'});
 await assert.rejects(f.run(),/SAFARI_SCRIPT_UNAVAILABLE/);assert.equal(f.calls.length,2);assert.deepEqual(f.waits,[100]);
});
for(const code of ['SAFARI_FOREIGN_OWNER','SAFARI_CHANGED','SAFARI_ROUTE_CHANGED'])test('the entry retry never relaxes '+code,async()=>{
 const f=fixture({firstError:code});await assert.rejects(f.run(),new RegExp(code));assert.equal(f.calls.length,1);assert.deepEqual(f.waits,[]);
});
test('a manual stop during the entry wait prevents the second native read',async()=>{
 let stopped=false;const f=fixture({afterWait:()=>{stopped=true;}});
 await assert.rejects(f.run(()=>{if(stopped)throw Error('STOPPED');}),/STOPPED/);assert.equal(f.calls.length,1);
});
test('changing the binding while waiting prevents adoption of another tab',async()=>{
 const f=fixture({afterWait:s=>{s.binding={...s.binding,window:999};}});await assert.rejects(f.run(),/SAFARI_TAB_CHANGED/);assert.equal(f.calls.length,1);
});
for(const code of ['PAYMENT_ACTIVE','ACCESSIBILITY_REQUIRED'])test('the guarded retry stops before DOM work for '+code,async()=>{
 const f=fixture({retryError:code});await assert.rejects(f.run(),new RegExp(code));assert.equal(f.calls[1].operation,'evaluate-guarded');assert.equal(f.calls.length,2);
});
test('a successful first read adds no wait or second native operation',async()=>{
 const f=fixture({firstError:null});await assert.rejects(f.run(),/LOGIN_REQUIRED/);assert.equal(f.calls.length,1);assert.deepEqual(f.waits,[]);assert.deepEqual(f.stages,[]);
});
test('unverified product identity still fails before any native entry read',async()=>{
 const f=fixture();delete f.session.confirmedSKU;await assert.rejects(f.run(),/PRODUCT_IDENTITY_UNVERIFIED/);assert.equal(f.calls.length,0);assert.deepEqual(f.waits,[]);
});
test('checkout entry disables availability discovery for its initial read',async()=>{
 const f=fixture(),options=[];f.session.inspect=async p=>{options.push(p);return{phase:'expired'};};
 await assert.rejects(f.run(),/PREORDER_SESSION_EXPIRED/);assert.equal(options.length,1);assert.equal(options[0].observeAvailability,false);
});
test('the guarded checkout entry retry also disables availability discovery',async()=>{
 const f=fixture(),options=[];f.session.evaluate=async(fn,p,guard)=>{options.push({p,guard});if(options.length===1)throw Error('SAFARI_TAB_CHANGED');return{phase:'expired'};};
 await assert.rejects(f.run(),/PREORDER_SESSION_EXPIRED/);
 assert.equal(options.length,2);assert.ok(options.every(v=>v.p.observeAvailability!==true));assert.equal(options[1].guard.guardPayment,true);assert.deepEqual(f.waits,[100]);
});
