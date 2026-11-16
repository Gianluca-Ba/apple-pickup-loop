import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {LinuxFleet} from './fleet.mjs';
const proof=x=>({vpn:'protected',fingerprint:createHash('sha256').update(String(x)).digest('hex')});
const selection={sku:'MK254J/A',currency:'JPY',priceJPY:364800,name:'fixture',url:'https://www.apple.com/jp/shop/buy-iphone/iphone-duo',stores:['R119']};
const settle=()=>new Promise(r=>setImmediate(r));
function fixture(t,{duplicate=false,mac=false}={}) {
  let at=1000000,startedClosing,releaseClose;
  const closing=new Promise(r=>{startedClosing=r;}),gate=new Promise(r=>{releaseClose=r;});
  const events=[],routes=[0,1,2,3,100];let held=false;
  const inventory=Object.fromEntries(Array.from({length:4},(_,i)=>[i+1,{connected:true,pinned:true,provider:i===0?'nordvpn':'windscribe'}]));
  const adapters=Array.from({length:5},(_,i)=>({network:async()=>{events.push(['network',i]);return proof(routes[i]);},close:async()=>{events.push(['close',i]);if(i===1&&!held){held=true;startedClosing();await gate;}},sample:async(s,fingerprint)=>{events.push(['sample',i]);if(i===1)throw Object.assign(Error('transport'),{code:'transport'});if(fingerprint!==proof(routes[i]).fingerprint)throw Object.assign(Error('ROUTE_CHANGED'),{code:'ROUTE_CHANGED'});return{sku:s.sku,observedAt:at,stores:[]};}}));
  const f=new LinuxFleet({workerCount:4,positions:2,vpnLimit:4,standbyTarget:2,nordLimit:8,adapters,now:()=>at,canChange:()=>true,control:async(op,id)=>{events.push([op,id]);if(op==='disconnect')inventory[id].connected=false;return op==='inventory'?structuredClone(inventory):{};}});
  t.after(async()=>{releaseClose();await f.stop();});
  return{f,events,routes,closing,releaseClose,advance:()=>{at+=65001;},async start(){await f.inspect();f.syncRoster();routes[2]=duplicate?0:20;f.nodes[0].nextAllowedAt=at+1000000;if(mac){f.nodes[4].verified=true;f.proofs.set(4,proof(100));}f.enabled=true;f.selections=[selection];f.selection=selection;f.selectionCursor=0;f.nextMaintenance=Infinity;f.tick();await closing;}};
}
for(const duplicate of [false,true])test('the dispatcher waits for close, disconnect and a fresh unique warm proof before dispatch; duplicate='+duplicate,async t=>{
  const x=fixture(t,{duplicate});await x.start();const failed=x.f.jobs.get(1);
  x.advance();x.f.tick();await settle();
  assert.ok(!x.events.some(([op,i])=>op==='sample'&&i>=2),'no standby stock before the coordinator handoff');
  assert.equal(x.f.roster.length,1);
  x.releaseClose();await failed;x.f.nextMaintenance=Infinity;x.f.syncRoster();
  const expected=duplicate?3:2;
  assert.ok(x.f.roster.includes(expected));assert.equal(x.f.proofs.get(expected).fingerprint,proof(x.routes[expected]).fingerprint);
  const disconnected=x.events.findIndex(([op,id])=>op==='disconnect'&&id===2),fresh=x.events.findLastIndex(([op,id])=>op==='network'&&id===expected);
  assert.ok(disconnected>=0&&fresh>disconnected);
  x.advance();x.f.tick();await settle();
  assert.ok(x.events.some(([op,i])=>op==='sample'&&i===expected));
  assert.equal(x.f.nodes[expected].checks,1);assert.equal(x.f.snapshot().diagnostics.faults.filter(v=>v.code==='ROUTE_CHANGED').length,0);
  if(duplicate)assert.equal(x.f.nodes[2].verified,false);
});
test('a verified Mac does not take a slot while an eligible warm Linux handoff is pending',async t=>{
  const x=fixture(t,{mac:true});await x.start();x.advance();x.f.tick();await settle();
  assert.ok(!x.events.some(([op,i])=>op==='sample'&&i===4));
  x.releaseClose();await x.f.jobs.get(1);x.f.nextMaintenance=Infinity;x.f.syncRoster();
  assert.equal(x.f.roster.length,2);assert.ok(!x.f.roster.includes(4));
});
test('manual stop during cleanup cannot promote a warm route or start another request',async t=>{
  const x=fixture(t);await x.start();const stopped=x.f.quiesce();x.releaseClose();await stopped;x.advance();x.f.tick();await settle();
  assert.equal(x.f.enabled,false);assert.deepEqual(x.events.filter(([op])=>op==='sample'),[['sample',1]]);
  assert.ok(!x.events.some(([op])=>op==='disconnect'||op==='connect'));
});
test('native Apple pause cannot bypass a concurrent container cleanup or its verified disconnect',async t=>{
 const x=fixture(t);await x.start();const failed=x.f.jobs.get(1),deadline=x.f.nodes[0].nextAllowedAt;x.f.nodes[0].pauseHttpStatus=541;
 x.advance();x.f.tick();await settle();assert.ok(!x.events.some(([op,i])=>op==='sample'&&i>=2));assert.ok(!x.events.some(([op])=>op==='disconnect'));
 x.releaseClose();await failed;x.f.nextMaintenance=Infinity;x.f.syncRoster();x.advance();x.f.tick();await settle();await settle();
 const released=x.events.findIndex(([op,id])=>op==='disconnect'&&id===2),started=x.events.findIndex(([op,i])=>op==='sample'&&i>=2);
 assert.ok(released>=0&&started>released);assert.equal(x.f.nodes[0].connected,true);assert.equal(x.f.nodes[0].nextAllowedAt,deadline);assert.ok(!x.events.some(([op,id])=>op==='disconnect'&&id===1));
});

test('clustered preflight transport failures reprove the shared native route before rotating another tunnel',async t=>{
 let at=1_000_000,failNative=false,closeReady,releaseClose;
 const events=[],pending=new Map();
 const firstClose=new Promise(r=>{closeReady=r;}),closeGate=new Promise(r=>{releaseClose=r;});
 const inventory=Object.fromEntries(Array.from({length:29},(_,i)=>[i+1,{connected:true,pinned:true,provider:i===0?'nordvpn':'windscribe'}]));
 const adapters=Array.from({length:30},(_,i)=>({
  async network(){events.push(['network',i]);if(i===0&&failNative)throw Error('probe timeout');return i===29?{...proof(i),vpn:'host'}:proof(i);},
  async close(){events.push(['close',i]);if(i===1){closeReady();await closeGate;}},
  async sample(s){events.push(['sample',i]);if(i===1||i===2)await new Promise((_,reject)=>pending.set(i,reject));return{sku:s.sku,observedAt:at,stores:[]};}
 }));
 const f=new LinuxFleet({workerCount:29,positions:20,vpnLimit:29,standbyTarget:9,nordLimit:8,adapters,now:()=>at,canChange:()=>true,control:async(op,id)=>{
  events.push([op,id]);if(op==='inventory')return structuredClone(inventory);if(op==='disconnect')inventory[id].connected=false;if(op==='connect')inventory[id].connected=true;if(op==='rotate')return{rotated:true};return{};
 }});
 t.after(async()=>{releaseClose();await f.stop();});
 await f.inspect();f.syncRoster();f.enabled=true;f.selections=[selection];f.selection=selection;f.selectionCursor=0;f.nextMaintenance=Infinity;
 f.nodes[0].nextAllowedAt=at+300000;
 // Exercise the same paced dispatch of two different workers.
 f.tick();at+=3250;f.tick();assert.deepEqual([...pending.keys()],[1,2]);
 const timeout=()=>Object.assign(Error('preflight timed out'),{code:'transport',workerStage:'network-proof'});
 at+=10000;pending.get(1)(timeout());await firstClose;
 assert.equal(f.recoveryCounts.sharedRouteFences,0);
 const second=f.jobs.get(2);pending.get(2)(timeout());await second;
 assert.equal(f.recoveryCounts.sharedRouteFences,1);assert.equal(f.nodes[0].verified,false);assert.equal(f.nodes[0].connected,true);
 assert.equal(f.nodes[2].connected,true);assert.equal(f.nodes[2].verified,false);assert.equal(f.nodes[2].nextAllowedAt,at+65000);
 assert.ok(!events.some(([op,id])=>op==='close'&&id===2));
 const failedFirst=f.jobs.get(1);releaseClose();await failedFirst;
 assert.ok(!events.some(([op])=>['disconnect','connect','rotate'].includes(op)));
 let finishMaintenance;
 f.maintenance=new Promise(resolve=>{finishMaintenance=resolve;});
 failNative=true;f.maintain();
 assert.ok(f.sharedRouteCheck,'the native proof does not wait for old maintenance');
 await Promise.all([f.sharedRouteCheck,f.emergencyMacCheck]);
 assert.equal(f.nativeProofFence,true);assert.equal(f.usable().length,0);assert.equal(f.nodes[29].verified,true);
 assert.ok(!events.some(([op])=>['disconnect','connect','rotate'].includes(op)));
 assert.ok(events.filter(([op,i])=>op==='network'&&i===0).length>=2);
 const saved=f.nodes[5].connected;f.nodes[5].connected=null;
 f.lastStart=at-3250;f.tick();await f.jobs.get(29);
 assert.deepEqual(events.filter(([op])=>op==='sample').at(-1),['sample',29],'the Mac is independent of the Linux inventory during the outage');
 const samples=events.filter(([op])=>op==='sample').length;
 const retryAt=f.nodes[0].nextProofAt;
 assert.equal(retryAt,at+15000);
 at+=14999;failNative=false;f.tick();assert.equal(f.sharedRouteCheck,null);
 assert.equal(events.filter(([op])=>op==='sample').length,samples,'Mac cooldown still applies');
 at++;f.nodes[5].connected=saved;f.maintain();await f.sharedRouteCheck;
 finishMaintenance();await f.maintenance;f.maintenance=null;
 assert.equal(f.nativeProofFence,false);assert.equal(f.recoveryCounts.sharedRouteRecoveries,1);
 assert.equal(f.nodes[0].connected,true);assert.equal(f.nodes[0].verified,true);
 assert.equal(f.nodes[2].connected,true);assert.equal(f.nodes[2].verified,false);assert.ok(f.nodes[2].nextAllowedAt>at);
 f.maintain();await f.maintenance;assert.equal(f.nodes[2].verified,true);
 assert.ok(!events.some(([op,id])=>['disconnect','rotate'].includes(op)&&(id===1||id===3)));
 assert.equal(f.nodes[2].sharedRouteProofPending,false,'a route already reverified during recovery needs no second coordinator proof');
 const next=f.roster.find(i=>i>=3);
 assert.equal(f.nodes[next].sharedRouteProofPending,true);
 let sampledFingerprint;
 const verifiedAgain=proof(100);
 f.adapters[next].network=async()=>{events.push(['network',next]);return verifiedAgain;};
 f.adapters[next].sample=async(s,fingerprint)=>{
  events.push(['sample',next]);sampledFingerprint=fingerprint;return{sku:s.sku,observedAt:at,stores:[]};
 };
 for(const i of f.roster)f.nodes[i].nextAllowedAt=i===next?at:Math.max(f.nodes[i].nextAllowedAt,at+65000);
 f.nextMaintenance=Infinity;
 f.lastStart=at-f.dispatchInterval();
 const before=events.length;
 f.tick();await settle();await settle();
 assert.deepEqual(events.slice(before),[['network',next],['sample',next]]);
 assert.equal(sampledFingerprint,verifiedAgain.fingerprint);
 assert.equal(f.nodes[next].sharedRouteProofPending,false);
 assert.equal(f.recoveryCounts.sharedRouteProofRefreshes,1);
});

for(const knownFree of [true,false])test('a slow retirement leaves only independently verified VPN vacancies refillable: '+knownFree,async t=>{
 const events=[],at=1_000_000;
 const inventory=Object.fromEntries(Array.from({length:4},(_,i)=>[i+1,{connected:true,pinned:true,provider:i===0?'nordvpn':'windscribe'}]));
 let resolveClose,enteredClose;
 const closeGate=new Promise(r=>{resolveClose=r;}),entered=new Promise(r=>{enteredClose=r;});
 const adapters=Array.from({length:5},(_,i)=>({
  async network(){events.push(['network',i+1]);return i===4?{...proof(i),vpn:'host'}:proof(i);},
  async close(){events.push(['close',i+1]);if(i===1){enteredClose();await closeGate;}},
  async sample(){throw Error('STOCK_MUST_NOT_RUN');}
 }));
 const f=new LinuxFleet({workerCount:4,positions:2,vpnLimit:4,standbyTarget:2,nordLimit:8,adapters,now:()=>at,canChange:()=>true,control:async(op,id)=>{
  events.push([op,id]);if(op==='inventory')return structuredClone(inventory);
  if(op==='disconnect')inventory[id].connected=false;
  if(op==='connect')inventory[id].connected=true;
  if(op==='rotate')return{rotated:true};return{};
 }});
 t.after(async()=>{resolveClose();await f.stop();});
 await f.inspect();f.syncRoster();
 const pause=at+300000;
 inventory[4].connected=knownFree?false:null;f.nodes[3].rotationPending=true;f.nodes[3].phase='recovering';
 f.nodes[3].pauseHttpStatus=541;f.nodes[3].nextAllowedAt=pause;
 f.nodes[1].rotationPending=true;f.nodes[1].phase='recovering';f.retirements.add(1);
 f.enabled=true;f.maintain();await entered;
 const closing=events.findIndex(e=>e[0]==='close'&&e[1]===2);
 if(knownFree){
  const rotated=events.findIndex(e=>e[0]==='rotate'&&e[1]===4),connected=events.findIndex(e=>e[0]==='connect'&&e[1]===4);
  assert.ok(rotated>=0&&connected>rotated&&closing>connected);
  assert.equal(f.nodes[3].verified,true);assert.equal(f.nodes[3].nextAllowedAt,pause);
  assert.equal(Object.values(inventory).filter(v=>v.connected===true).length,4);
 }else assert.ok(!events.some(([op])=>op==='connect'||op==='rotate'));
 assert.equal(inventory[2].connected,true);assert.ok(!events.some(([op,id])=>op==='disconnect'&&id===2));
 assert.ok(!events.some(([op,id])=>['connect','disconnect','rotate'].includes(op)&&id===1));
 const drained=f.quiesce();resolveClose();await drained;
 assert.ok(!events.some(([op,id])=>op==='disconnect'&&id===2));
});

test('a changed protected exit is reproved without closing or rotating its tunnel', async t => {
  let now = 1000000;
  const operations = [];
  const inventory = {
    1: { connected: true, pinned: true, provider: 'nordvpn' },
    2: { connected: true, pinned: true, provider: 'windscribe' }
  };
  let route = 2;
  const adapters = [
    { network: async () => proof(1), close: async () => {}, sample: async () => { throw Error('native stock is not due'); } },
    {
      network: async () => proof(route),
      close: async () => { operations.push('close'); },
      sample: async (product, expected) => {
        if (expected !== proof(route).fingerprint) throw Object.assign(Error('ROUTE_CHANGED'), { code: 'ROUTE_CHANGED' });
        return { sku: product.sku, observedAt: now, stores: [] };
      }
    },
    { network: async () => ({ ...proof(100), vpn: 'host' }), close: async () => {} }
  ];
  const fleet = new LinuxFleet({
    workerCount: 2, positions: 2, vpnLimit: 2, nordLimit: 8, adapters,
    now: () => now, canChange: () => true,
    control: async operation => {
      if (operation === 'inventory') return structuredClone(inventory);
      operations.push(operation);
    }
  });
  t.after(() => fleet.stop());
  await fleet.inspect();
  fleet.syncRoster();
  fleet.nodes[0].nextAllowedAt = now + 300000;
  fleet.enabled = true;
  fleet.selection = selection;
  fleet.nextMaintenance = Infinity;
  route = 3;
  fleet.tick();
  await fleet.jobs.get(1);
  assert.equal(fleet.nodes[1].verified, false);
  assert.equal(fleet.nodes[1].nextAllowedAt, now + 65000);
  fleet.maintain();
  await fleet.maintenance;
  assert.equal(fleet.nodes[1].verified, true);
  assert.equal(fleet.proofs.get(1).fingerprint, proof(3).fingerprint);
  assert.deepEqual(operations, []);
  now += 65000;
  fleet.nextMaintenance = Infinity;
  fleet.tick();
  await fleet.jobs.get(1);
  assert.equal(fleet.nodes[1].checks, 1);
});
