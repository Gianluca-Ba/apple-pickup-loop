import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {LinuxFleet} from './fleet.mjs';
const proof=x=>({vpn:'protected',fingerprint:createHash('sha256').update(String(x)).digest('hex')});
const selection={sku:'MK254J/A',currency:'JPY',priceJPY:364800,name:'fixture',url:'https://www.apple.com/jp/shop/buy-iphone/iphone-duo',stores:['R119']};
const settle=()=>new Promise(r=>setImmediate(r));
function fixture(t) {
 let at=1000000,route=0,reads=0,samples=0,refresh=async()=>proof(route);const events=[];
 const adapters=[{network:async()=>{reads++;return reads===1?proof(0):refresh();},sample:async(s,expected)=>{samples++;if(expected!==proof(route).fingerprint)throw Object.assign(Error('ROUTE_CHANGED'),{code:'ROUTE_CHANGED'});return{sku:s.sku,observedAt:at,stores:[]};},close:async()=>{}},{network:async()=>proof(100),close:async()=>{}}];
 const f=new LinuxFleet({workerCount:1,positions:1,vpnLimit:1,nordLimit:8,adapters,now:()=>at,canChange:()=>true,control:async op=>{events.push(op);return{1:{connected:true,pinned:true,provider:'nordvpn'}};}});
 t.after(()=>f.stop());
 return{f,events,get reads(){return reads;},get samples(){return samples;},get at(){return at;},set refresh(fn){refresh=fn;},elapse(){at+=65001;},age(){at+=65001;route=1;},start(){f.enabled=true;f.generation++;f.selections=[selection];f.selection=selection;f.selectionCursor=0;f.nextMaintenance=Infinity;f.tick();}};
}
test('an aged startup proof is refreshed once before the first stock request and never changes a server',async t=>{
 const x=fixture(t);await x.f.inspect();x.age();x.start();await Promise.allSettled([...x.f.jobs.values()]);
 assert.equal(x.reads,2);assert.equal(x.samples,1);assert.equal(x.f.nodes[0].checks,1);assert.equal(x.f.snapshot().diagnostics.counters.transport,0);assert.ok(x.events.every(op=>op==='inventory'));
});
test('a recent initial proof adds no redundant network request',async t=>{
 const x=fixture(t);await x.f.inspect();x.start();await Promise.allSettled([...x.f.jobs.values()]);assert.equal(x.reads,1);assert.equal(x.samples,1);
});
test('a route used before a long checkout is verified again on resume',async t=>{
 const x=fixture(t);await x.f.inspect();x.start();await Promise.allSettled([...x.f.jobs.values()]);await x.f.quiesce();x.age();x.start();await Promise.allSettled([...x.f.jobs.values()]);
 assert.equal(x.reads,2);assert.equal(x.samples,2);assert.equal(x.f.nodes[0].checks,2);assert.equal(x.f.snapshot().diagnostics.counters.transport,0);
});
test('a previously used cooldown route gets a current proof when entering the roster again',async t=>{
 const x=fixture(t);await x.f.inspect();x.start();await Promise.allSettled([...x.f.jobs.values()]);x.age();x.f.roster=[];x.f.nodes[0].phase='cooldown';x.f.tick();await Promise.allSettled([...x.f.jobs.values()]);
 assert.equal(x.reads,2);assert.equal(x.f.nodes[0].checks,2);assert.equal(x.f.snapshot().diagnostics.counters.transport,0);
});
test('continuous healthy cycles retain the ordinary one worker preflight without an extra host proof',async t=>{
 const x=fixture(t);await x.f.inspect();x.start();await Promise.allSettled([...x.f.jobs.values()]);x.elapse();x.f.tick();await Promise.allSettled([...x.f.jobs.values()]);assert.equal(x.reads,1);assert.equal(x.samples,2);assert.equal(x.f.nodes[0].checks,2);
});
test('manual stop during the startup proof refresh drains it without starting stock',async t=>{
 const x=fixture(t);await x.f.inspect();x.age();let release;x.refresh=()=>new Promise(r=>{release=r;});x.start();await settle();
 const stopped=x.f.quiesce();release?.(proof(1));await stopped;assert.equal(x.samples,0);assert.equal(x.f.enabled,false);assert.equal(x.f.snapshot().diagnostics.counters.transport,0);
});
test('a refreshed initial proof honors the worker Apple pause before dispatch',async t=>{
 const x=fixture(t);await x.f.inspect();x.age();x.refresh=async()=>({...proof(1),nextAllowedInMs:180000,pauseHttpStatus:541});x.start();await Promise.allSettled([...x.f.jobs.values()]);
 assert.equal(x.samples,0);assert.equal(x.f.nodes[0].nextAllowedAt,x.at+180000);assert.equal(x.f.nodes[0].pauseHttpStatus,541);assert.equal(x.f.nodes[0].connected,true);assert.ok(x.events.every(op=>op==='inventory'));
});
for(const bad of ['duplicate','unprotected'])test('an initial proof refresh rejects '+bad+' before any stock request',async t=>{
 const x=fixture(t);await x.f.inspect();x.age();if(bad==='duplicate'){x.f.nodes[1].verified=true;x.f.proofs.set(1,proof(1));}else x.refresh=async()=>({...proof(1),vpn:'host'});
 x.start();await Promise.allSettled([...x.f.jobs.values()]);assert.equal(x.samples,0);assert.equal(x.f.nodes[0].checks,0);assert.ok(x.events.every(op=>op==='inventory'));
});
