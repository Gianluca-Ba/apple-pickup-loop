import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {mkdtempSync,writeFileSync,rmSync,readFileSync,copyFileSync,existsSync} from 'node:fs';
import {spawn as spawnHelperTest} from 'node:child_process';
import {request as helperTestRequest} from 'node:http';
import {safeBrowserFailureCode,safeBrowserFailureMetadata} from './browser-failure.mjs';
import {tmpdir} from 'node:os';
import { parseWindscribeStatus } from './vpn-provider.mjs';
import { linuxNetwork, PickupWorker, safeWorkerFailure } from './worker.mjs';
import { createContainerBrowserPool } from './browser-pool.mjs';
import { createLinuxVpnPool } from './vpn-pool.mjs';
import { LinuxFleet, createLinuxAdapter } from './fleet.mjs';
import { parseGuestReply, readGuestCommand, createLinuxVpnControl } from './linux-control.mjs';
import { workerClientReply, WorkerJobs } from './worker-server.mjs';
const text='Login state: Logged in\nConnect state: Connected to Japan - Tokyo - Shinkansen\nFirewall state: On (Always On)';
const proof=i=>({vpn:'protected',fingerprint:createHash('sha256').update(String(i)).digest('hex')});
const selection={sku:'MK254J/A',currency:'JPY',priceJPY:364800,name:'fixture',url:'https://www.apple.com/jp/shop/buy-iphone/iphone-duo',stores:['R119']};
const settle=()=>new Promise(r=>setImmediate(r));
test('ready warm reserves fill response-related idle starts without changing twenty positions or any node deadline',async()=>{
 const run=async loans=>{
  let at=1000000,first=at,maxJobs=0,macCalls=0;const pending=[],starts=[],responses=new Map(),controls=[];
  const adapters=Array.from({length:30},(_,i)=>({network:async()=>proof(i),close:async()=>{},sample:async s=>{
   if(i===29)macCalls++;assert.ok(!responses.has(i)||at-responses.get(i)>=65000,'response-based node pause');
   if(starts.length)assert.ok(at-starts.at(-1).at>=3250,'global start spacing');starts.push({i,at});
   return new Promise(resolve=>pending.push({i,due:at+8000,selection:s,resolve}));
  }}));
  const f=new LinuxFleet({workerCount:29,positions:20,vpnLimit:29,standbyTarget:9,nordLimit:8,now:()=>at,adapters,canChange:()=>true,control:async(op)=>{controls.push(op);return{};}});
  f.maintain=()=>{};if(!loans)f.promoteReadyReserve=()=>{};f.enabled=true;f.selection=selection;
  for(let i=0;i<29;i++){f.nodes[i].connected=true;await f.prove(i);}f.syncRoster();
  for(;at<first+600000;at+=125){
   for(const job of pending.filter(x=>x.resolve&&x.due<=at)){responses.set(job.i,at);job.resolve({sku:job.selection.sku,observedAt:at,stores:[]});job.resolve=null;}
   await settle();f.tick();maxJobs=Math.max(maxJobs,f.jobs.size);await settle();
  }
  const window=starts.filter(x=>x.at>=first+120000&&x.at<first+600000),steady=(window.length-1)*60000/(window.at(-1).at-window[0].at);
  assert.ok(maxJobs<=20);assert.equal(macCalls,0);assert.deepEqual(controls,[]);assert.equal(f.snapshot().verifiedTunnels,29);
  f.enabled=false;for(const job of pending.filter(x=>x.resolve)){job.resolve({sku:job.selection.sku,observedAt:at,stores:[]});job.resolve=null;}await settle();await f.stop();
  return{steadyPerMinute:steady,uniqueWorkers:new Set(starts.map(x=>x.i)).size,maxJobs};
 };
 const fixed=await run(false),rotating=await run(true);
 assert.ok(rotating.steadyPerMinute>=18,JSON.stringify({fixed,rotating}));assert.ok(rotating.steadyPerMinute>fixed.steadyPerMinute*1.08);assert.equal(rotating.uniqueWorkers,29);
 console.log(JSON.stringify({offlineReadyReserveCadence:{fixed,rotating}}));
});
async function readyReserveFixture(t){
 const at=1000000,samples=[],closes=[],controls=[];let allowed=true;
 const adapters=Array.from({length:5},(_,i)=>({network:async()=>proof(i),close:async()=>{closes.push(i);},sample:async s=>{samples.push(i);return{sku:s.sku,observedAt:at,stores:[]};}}));
 const f=new LinuxFleet({workerCount:4,positions:2,vpnLimit:4,standbyTarget:2,nordLimit:4,now:()=>at,adapters,canChange:()=>allowed,control:async op=>{controls.push(op);return{};}});
 f.enabled=true;f.selection=selection;f.maintain=()=>{};
 for(let i=0;i<4;i++){f.nodes[i].connected=true;await f.prove(i);}
 f.roster=[0,1];Object.assign(f.nodes[0],{phase:'cooldown',nextAllowedAt:at+10000});Object.assign(f.nodes[1],{phase:'cooldown',nextAllowedAt:at+20000});
 Object.assign(f.nodes[2],{phase:'standby',workerSuccesses:9});Object.assign(f.nodes[3],{phase:'standby',workerSuccesses:2});
 t.after(async()=>{f.maintenance=null;f.jobs.clear();await f.stop();});
 return{f,at,samples,closes,controls,setAllowed:v=>{allowed=v;}};
}
async function nativePauseFixture(t){
 const x=await readyReserveFixture(t),{f,at}=x;
 Object.assign(f.nodes[0],{pauseHttpStatus:541,nextAllowedAt:at+300000});f.syncRoster();assert.deepEqual(f.roster,[1]);return x;
}
test('a native Apple pause fills the vacant stock position from a freshly proved standby without changing any tunnel',async t=>{
 const x=await nativePauseFixture(t),{f,at}=x;let release;const deadline=f.nodes[0].nextAllowedAt;
 f.adapters[3].network=()=>new Promise(r=>{release=r;});t.after(()=>release?.(proof(3)));
 f.tick();await settle();assert.deepEqual(f.roster,[1,3]);assert.equal(f.active.length,2);assert.deepEqual(x.samples,[]);
 assert.equal(f.nodes[0].connected,true);assert.equal(f.nodes[0].verified,true);assert.equal(f.nodes[0].nextAllowedAt,deadline);assert.deepEqual(x.closes,[]);assert.deepEqual(x.controls,[]);
 release(proof(3));await settle();await settle();assert.deepEqual(x.samples,[3]);assert.equal(f.nodes[3].nextAllowedAt,at+65000);assert.equal(f.snapshot().verifiedTunnels,4);assert.equal(f.nodes[0].nextAllowedAt,deadline);
});
for(const guard of ['checkout','maintenance','inspection','uncertain','retirement','cadence','manual-stop','native-unverified','off-roster-job','failed-route-cleanup','native-not-paused'])test('a vacant warm position still respects '+guard,async t=>{
 const x=await nativePauseFixture(t),{f,at}=x;
 if(guard==='checkout')x.setAllowed(false);if(guard==='maintenance')f.maintenance=Promise.resolve();if(guard==='inspection')f.inspection=Promise.resolve();if(guard==='uncertain')f.nodes[2].connected=null;if(guard==='retirement')f.retirements.add(1);if(guard==='cadence')f.lastStart=at-1000;if(guard==='manual-stop')f.enabled=false;if(guard==='native-unverified')f.nodes[0].verified=false;
 if(guard==='off-roster-job')f.jobs.set(0,Promise.resolve());if(guard==='failed-route-cleanup')Object.assign(f.nodes[2],{verified:false,rotationPending:true});if(guard==='native-not-paused')f.nodes[0].pauseHttpStatus=null;
 assert.equal(f.promoteReadyReserve(),false);assert.deepEqual(f.roster,[1]);assert.deepEqual(x.samples,[]);assert.deepEqual(x.controls,[]);
});
for(const guard of ['apple-pause','vpn-wait','rotation','busy','disconnected','unverified'])test('a vacant position excludes a reserve with '+guard,async t=>{
 const x=await nativePauseFixture(t),{f,at}=x;
 for(const i of [2,3]){if(guard==='apple-pause')Object.assign(f.nodes[i],{pauseHttpStatus:541,nextAllowedAt:at+300000});if(guard==='vpn-wait')f.nodes[i].nextVpnAllowedAt=at+300000;if(guard==='rotation')f.nodes[i].rotationPending=true;if(guard==='busy')f.jobs.set(i,Promise.resolve());if(guard==='disconnected')f.nodes[i].connected=false;if(guard==='unverified')f.nodes[i].verified=false;}
 assert.equal(f.promoteReadyReserve(),false);assert.deepEqual(f.roster,[1]);assert.deepEqual(x.samples,[]);
});
test('a duplicate fresh proof for a vacant position cannot launch stock or alter the native pause',async t=>{
 const x=await nativePauseFixture(t),{f}=x;let release;const deadline=f.nodes[0].nextAllowedAt;
 f.adapters[3].network=()=>new Promise(r=>{release=r;});t.after(()=>release?.(proof(0)));f.tick();await settle();assert.equal(typeof release,'function');x.setAllowed(false);release(proof(0));await settle();await settle();
 assert.deepEqual(x.samples,[]);assert.equal(f.nodes[3].verified,false);assert.equal(f.nodes[0].connected,true);assert.equal(f.nodes[0].nextAllowedAt,deadline);assert.equal(f.proofFailures.at(-1).code,'ROUTE_DUPLICATE');assert.deepEqual(x.controls,[]);
});
test('a manual stop while proving a vacant stock position prevents its delayed stock request',async t=>{
 const x=await nativePauseFixture(t),{f}=x;let release;f.adapters[3].network=()=>new Promise(r=>{release=r;});t.after(()=>release?.(proof(3)));f.tick();await settle();assert.equal(typeof release,'function');
 const stopped=f.quiesce();release(proof(3));await stopped;assert.deepEqual(x.samples,[]);assert.equal(f.enabled,false);assert.deepEqual(x.controls,[]);assert.equal(f.nodes[0].connected,true);
});
for (const paused of [0,19]) test('twenty stock positions recover with all twenty-nine tunnels and a reconciled Apple pause on pilot'+(paused+1),async t=>{
 let at=1000000;const samples=[],controls=[];
 const adapters=Array.from({length:30},(_,i)=>({network:async()=>proof(i),close:async()=>{},sample:async s=>{samples.push(i);return{sku:s.sku,observedAt:at,stores:[]};}}));
 const f=new LinuxFleet({workerCount:29,positions:20,vpnLimit:29,standbyTarget:9,nordLimit:8,adapters,canChange:()=>true,now:()=>at,control:async op=>{controls.push(op);return{};}});f.maintain=()=>{};f.enabled=true;f.selection=selection;f.selections=[selection];
 t.after(()=>f.stop());for(let i=0;i<29;i++){f.nodes[i].connected=true;await f.prove(i);}await f.prove(29,{...proof(99),vpn:'host'});f.syncRoster();
 for(const i of f.roster)Object.assign(f.nodes[i],{phase:'cooldown',nextAllowedAt:at+65000});
 const refused=f.nodes[paused];
 Object.assign(refused,{pauseHttpStatus:541,nextAllowedAt:at+300000});
 if(paused>0){
  f.syncRoster();
  assert.equal(f.promoteReadyReserve(),false,'rotation has not been verified');
  refused.rotationCoversPause=true;
 }
 f.tick();await settle();await settle();
 assert.equal(f.roster.length,20);assert.equal(f.active.length,20);assert.equal(f.snapshot().verifiedTunnels,29);
 assert.equal(refused.connected,true);assert.equal(refused.nextAllowedAt,at+300000);assert.equal(refused.pauseHttpStatus,541);
 assert.deepEqual(samples,[20]);assert.deepEqual(controls,[]);
});
test('a borrowed Mac finishes its request before a freshly verified Linux standby takes the vacant native position',async t=>{
 const x=await nativePauseFixture(t),{f,at}=x;let finishMac;const pending=new Promise(r=>{finishMac=r;});t.after(()=>finishMac());
 Object.assign(f.nodes[4],{verified:true,phase:'checking'});f.active=[1,4];f.jobs.set(4,pending);
 f.tick();await settle();assert.deepEqual(x.samples,[]);assert.ok(f.active.includes(4));assert.equal(f.roster.length,1);
 finishMac();await pending;f.jobs.delete(4);Object.assign(f.nodes[4],{phase:'cooldown',nextAllowedAt:at+65000});
 f.tick();await settle();await settle();assert.deepEqual(f.roster,[1,3]);assert.deepEqual(x.samples,[3]);assert.ok(!f.active.includes(4));assert.equal(f.nodes[4].nextAllowedAt,at+65000);assert.deepEqual(x.controls,[]);
});
for(const guard of ['checkout','maintenance','inspection','uncertain','ready-position','all-busy','reserve-paused','vpn-wait','retirement','cadence','manual-stop'])test('healthy reserve position transfer respects '+guard,async t=>{
 const x=await readyReserveFixture(t),{f,at}=x;
 if(guard==='checkout')x.setAllowed(false);
 if(guard==='maintenance')f.maintenance=Promise.resolve();
 if(guard==='inspection')f.inspection=Promise.resolve();
 if(guard==='uncertain')f.nodes[3].connected=null;
 if(guard==='ready-position')f.nodes[0].nextAllowedAt=at;
 if(guard==='all-busy'){f.jobs.set(0,Promise.resolve());f.jobs.set(1,Promise.resolve());}
 if(guard==='reserve-paused')for(const i of [2,3])Object.assign(f.nodes[i],{pauseHttpStatus:541,nextAllowedAt:at+300000});
 if(guard==='vpn-wait')for(const i of [2,3])f.nodes[i].nextVpnAllowedAt=at+300000;
 if(guard==='retirement')f.retirements.add(0);
 if(guard==='cadence')f.lastStart=at-1000;
 if(guard==='manual-stop')f.enabled=false;
 f.tick();await settle();assert.deepEqual(f.roster,[0,1]);assert.ok(!x.samples.some(i=>i===2||i===3));assert.deepEqual(x.controls,[]);assert.equal(f.recoveryCounts.readyReserveDispatches,0);
});
test('healthy reserve transfer preserves a native tunnel and ledger and proves the least-used eligible reserve before stock',async t=>{
 const x=await readyReserveFixture(t),{f,at}=x;let release,proofReads=0;
 f.nodes[0].nextAllowedAt=at+30000;const nativeDeadline=f.nodes[0].nextAllowedAt;
 f.adapters[3].network=()=>{proofReads++;return new Promise(resolve=>{release=resolve;});};
 f.tick();await settle();assert.deepEqual(f.roster,[3,1]);assert.equal(f.nodes[0].phase,'standby');assert.equal(f.nodes[0].connected,true);assert.equal(f.nodes[0].nextAllowedAt,nativeDeadline);assert.equal(proofReads,1);assert.deepEqual(x.samples,[]);assert.deepEqual(x.closes,[]);assert.deepEqual(x.controls,[]);
 release(proof(3));await settle();await settle();assert.deepEqual(x.samples,[3]);assert.equal(f.nodes[3].nextAllowedAt,at+65000);assert.equal(f.snapshot().verifiedTunnels,4);assert.equal(f.roster.length,2);
});
test('a duplicate fresh proof from a healthy reserve never sends stock or changes the outgoing node deadline',async t=>{
 const x=await readyReserveFixture(t),{f}=x;let release;const deadlines=f.nodes.slice(0,2).map(n=>n.nextAllowedAt);
 f.adapters[3].network=()=>new Promise(resolve=>{release=resolve;});f.tick();await settle();x.setAllowed(false);release(proof(0));await settle();await settle();
 assert.deepEqual(x.samples,[]);assert.deepEqual(f.nodes.slice(0,2).map(n=>n.nextAllowedAt),deadlines);assert.equal(f.nodes[3].verified,false);assert.equal(f.snapshot().diagnostics.proofFailures.at(-1).code,'ROUTE_DUPLICATE');assert.deepEqual(x.controls,[]);
});
test('a manual stop during healthy reserve proof cannot start its delayed stock request',async t=>{
 const x=await readyReserveFixture(t),{f}=x;let release;f.adapters[3].network=()=>new Promise(resolve=>{release=resolve;});f.tick();await settle();const stopped=f.quiesce();release(proof(3));await stopped;assert.deepEqual(x.samples,[]);assert.equal(f.enabled,false);assert.equal(f.jobs.size,0);assert.deepEqual(x.controls,[]);
});
test('duplicate route rejection records a safe proof diagnostic and never starts stock',async()=>{
 let samples=0;const adapters=Array.from({length:3},()=>({network:async()=>proof(1),sample:async()=>{samples++;}}));
 const f=new LinuxFleet({workerCount:2,positions:1,vpnLimit:2,now:()=>1000000,adapters,control:async()=>({})});
 f.nodes[0].connected=f.nodes[1].connected=true;await f.prove(0);
 await assert.rejects(f.prove(1),/ROUTE_DUPLICATE/);
 assert.equal(f.nodes[1].verified,false);assert.equal(samples,0);
 assert.deepEqual(f.snapshot().diagnostics.proofFailures.map(({node,code,stage})=>({node,code,stage})),[{node:'pilot2',code:'ROUTE_DUPLICATE',stage:'route-proof'}]);
});
test('proof diagnostics bound retained records, preserve the original error and exclude private text',async()=>{
 const original=Object.freeze(Error('https://private.invalid cookie=secret')),f=new LinuxFleet({workerCount:1,positions:1,vpnLimit:1,now:()=>1000000,adapters:[{network:async()=>{throw original;}},{}],control:async()=>({})});
 for(let i=0;i<55;i++)await assert.rejects(f.prove(0),error=>error===original);
 const records=f.snapshot().diagnostics.proofFailures;assert.equal(records.length,50);assert.equal(records[0].sequence,6);assert.equal(records.at(-1).sequence,55);assert.ok(records.every(x=>x.code==='NETWORK_PROOF_FAILED'));assert.ok(!JSON.stringify(records).includes('private'));assert.ok(!JSON.stringify(records).includes('secret'));
 records[0].code='mutated';assert.equal(f.snapshot().diagnostics.proofFailures[0].code,'NETWORK_PROOF_FAILED');
});
test('pool proof diagnostics observe warm and newly connected failures without changing handoff or retries',async()=>{
 const records=[],events=[],agents=Array.from({length:3},(_,i)=>({id:'pilot'+(i+1),verified:true}));
 const inventory={1:{connected:true,pinned:true},2:{connected:true,pinned:true},3:{connected:true,pinned:true}};
 const pool=createLinuxVpnPool({agents,adapters:agents.map((_,i)=>({network:async()=>{events.push(['proof',i]);if(i===1)throw Object.freeze(Error('private network output'));return proof(0);}})),vpnLimit:3,canChange:()=>true,isStandby:i=>i===1,onProofFailure:(i,error,stage)=>{records.push({i,stage,duplicate:error.message==='ROUTE_DUPLICATE'});throw Error('observer failure');},control:async(op,id)=>{events.push([op,id]);if(op==='disconnect')inventory[id].connected=false;if(op==='connect')inventory[id].connected=true;return op==='inventory'?structuredClone(inventory):{};}});
 for(let i=0;i<3;i++)pool.record(i,proof(i));await pool.refresh();
 const warm=await pool.replace(2,{isEligible:i=>i!==2,isStopping:()=>false});assert.equal(warm.status,'released');assert.deepEqual(records[0],{i:1,stage:'warm-handoff',duplicate:false});assert.equal(agents[1].verified,false);assert.ok(!events.some(x=>x[0]==='disconnect'&&x[1]===2),'failed warm observation leaves its tunnel connected');
 const cold=await pool.fill({isEligible:i=>i===2,isStopping:()=>false});assert.equal(cold.status,'connect-unverified');assert.deepEqual(records.at(-1),{i:2,stage:'connect-proof',duplicate:true});assert.equal(events.filter(x=>x[0]==='connect'&&x[1]===3).length,1);assert.equal((await pool.fill({isEligible:i=>i===2,isStopping:()=>false})).status,'released');
});
test('a browser failure category survives worker journaling, guest receipts and fleet diagnostics without replay',async t=>{
 let fetches=0,starts=0;const at=Date.now();
 const pool=createContainerBrowserPool({sockets:['fixture'],rpc:async(_socket,path)=>path==='/fetch'?(fetches++,{ok:false,failureCategory:'tls',failureCode:'ERR_CERT_AUTHORITY_INVALID',browserStage:'browser-open',httpStage:'warmup-response',failureMessage:'https://private.invalid/token'}):{ok:true}});
 const worker=new PickupWorker({now:()=>at,network:async()=>proof(1),browserFactory:async()=>pool});t.after(()=>worker.close());
 const jobs=new WorkerJobs(worker,null,()=>at);
 const run=async(_bin,args)=>{const tokens=[...args.at(-1).matchAll(/'([^']*)'/g)].map(x=>x[1]),data=JSON.parse(Buffer.from(tokens.at(-1),'base64'));const result=tokens.includes('/start')?(starts++,jobs.start(data.id,data.operation,data.data)):jobs.result(data.id);return{stdout:JSON.stringify(workerClientReply(data.id,result))};};
 const adapter=createLinuxAdapter(1,{run,requireReceipt:true,sleep:settle});let failure;
 await assert.rejects(adapter.sample(selection,proof(1).fingerprint),e=>{failure=e;return e.code==='transport'&&e.workerStage==='stock-request'&&e.failureCategory==='tls';});
 assert.equal(starts,1);assert.equal(fetches,1);assert.equal(worker.ledger.nextAllowedAt,at+65000);
 const f=new LinuxFleet({workerCount:1,positions:1,vpnLimit:1,now:()=>at,adapters:[{},{}],control:async()=>({})});f.recordFailure(0,failure,at-100,0);const diagnostic=f.snapshot().diagnostics.faults[0];
 assert.equal(diagnostic.workerStage,'stock-request');assert.equal(diagnostic.failureCategory,'tls');assert.equal(diagnostic.kind,'transport');assert.ok(!JSON.stringify(diagnostic).includes('private.invalid'));
 assert.equal(diagnostic.failureCode,'ERR_CERT_AUTHORITY_INVALID');assert.equal(diagnostic.browserStage,'browser-open');assert.equal(diagnostic.httpStage,'warmup-response');
});
for(const stage of ['network-proof','browser-startup','browser-reset'])test('worker reports '+stage+' failures without starting a stock request',async()=>{
 const at=1000000;let fetches=0;const failure=Error('private provider output');
 const worker=new PickupWorker({now:()=>at,network:async()=>{if(stage==='network-proof')throw failure;return proof(1);},browserFactory:async()=>{if(stage==='browser-startup')throw failure;return{fetch:async()=>{fetches++;}};}});
 if(stage==='browser-reset'){worker.browserNeedsReset=true;worker.browser={close:async()=>{throw failure;}};}
 await assert.rejects(worker.sample(selection,proof(1).fingerprint),e=>e.workerStage===stage);
 assert.equal(fetches,0);assert.equal(worker.ledger.nextAllowedAt,at+65000);assert.equal(safeWorkerFailure(failure,at).workerStage,stage);
});
test('failure context retains a real Apple 541 deadline and cannot cause a request replay',async()=>{
 const at=1000000;let calls=0;const worker=new PickupWorker({now:()=>at,network:async()=>proof(1),browserFactory:async()=>({fetch:async()=>{calls++;throw Object.assign(Error('refused'),{httpStatus:541,nextAllowedAt:at+400000});},close:async()=>{}})});
 let failure;await assert.rejects(worker.sample(selection,proof(1).fingerprint),e=>{failure=e;return e.httpStatus===541;});
 assert.deepEqual(safeWorkerFailure(failure,at),{ok:false,code:'transport',httpStatus:541,nextAllowedInMs:400000,workerStage:'stock-request'});
 await assert.rejects(worker.sample(selection,proof(1).fingerprint),/NODE_WAIT/);assert.equal(calls,1);assert.equal(worker.ledger.pauseHttpStatus,541);
});
test('untrusted diagnostic labels and error text never enter guest or fleet diagnostics',()=>{
 const e=Object.assign(Error('cookie=private-value https://private.invalid/checkout'),{workerStage:'https://private.invalid',failureCategory:'private-value',failureCode:'ERR_PRIVATE_VALUE',browserStage:'private-value',httpStage:'https://private.invalid'}),value=safeWorkerFailure(e,0);
 assert.deepEqual(value,{ok:false,code:'transport',httpStatus:null,nextAllowedInMs:0});
 const f=new LinuxFleet({workerCount:1,positions:1,vpnLimit:1,now:()=>1000000,adapters:[{},{}],control:async()=>({})});f.recordFailure(0,e,1000000,0);assert.ok(!JSON.stringify(f.snapshot().diagnostics).includes('private'));
});
test('standalone route proof failures report only their local stage',async()=>{
 const worker=new PickupWorker({network:async()=>{throw Error('private provider output');}});await assert.rejects(worker.network(),e=>safeWorkerFailure(e,0).workerStage==='network-proof');
});
test('diagnostic annotations never replace an immutable provider failure',async()=>{
 const original=Object.freeze(Error('immutable provider failure')),worker=new PickupWorker({network:async()=>{throw original;}});await assert.rejects(worker.network(),e=>e===original);
});
test('browser diagnostic codes reject arbitrary message text and retain only known technical enums',()=>{
 for(const[message,expected]of [['net::ERR_HTTP2_PROTOCOL_ERROR at https://private.invalid/cookie','ERR_HTTP2_PROTOCOL_ERROR'],['net::ERR_QUIC_PROTOCOL_ERROR at https://private.invalid','ERR_QUIC_PROTOCOL_ERROR'],['net::ERR_PRIVATE_VALUE at https://private.invalid','UNKNOWN'],['Target page, context or browser has been closed','BROWSER_CLOSED'],['Guest Chromium left the public Japan site','WARMUP_ROUTE'],['Guest Chromium startup response missing','WARMUP_EMPTY'],['private-value cookie=secret','UNKNOWN']]){
  const code=safeBrowserFailureCode(Error(message));assert.equal(code,expected);assert.deepEqual(safeBrowserFailureMetadata({failureCode:code}),{failureCode:expected});
 }
 assert.equal(safeBrowserFailureCode(Object.assign(Error('private-value'),{name:'TimeoutError'})),'BROWSER_TIMEOUT');
 assert.deepEqual(safeBrowserFailureMetadata({failureCode:'ERR_PRIVATE_VALUE',browserStage:'private-value',httpStage:'private-value'}),{});
});
for(const scenario of [
 {stage:'browser-open',code:'ERR_HTTP2_PROTOCOL_ERROR',factory:"throw Error('net::ERR_HTTP2_PROTOCOL_ERROR at https://private.invalid/token');"},
 {stage:'stock-request',code:'ERR_QUIC_PROTOCOL_ERROR',factory:"return {fetch:async()=>{throw Error('net::ERR_QUIC_PROTOCOL_ERROR at https://private.invalid/token');},close:async()=>{}};"},
 {stage:'response-body',code:'BROWSER_CLOSED',factory:"return {fetch:async()=>({text:async()=>{throw Error('Target page, context or browser has been closed');}}),close:async()=>{}};"}
])test('the real browser helper reports a private-free '+scenario.stage+' failure without an online request',async t=>{
 const dir=mkdtempSync(tmpdir()+'/apple-helper-offline-'),socket=dir+'/a.sock';
 const original=readFileSync(new URL('./container-browser-server.mjs',import.meta.url),'utf8'),source=original.replace("const socket='/ipc/'+id+'.sock';",'const socket='+JSON.stringify(socket)+';');
 assert.notEqual(source,original,'test must replace the production IPC path');
 writeFileSync(dir+'/helper.mjs',source);copyFileSync(new URL('./browser-failure.mjs',import.meta.url),dir+'/browser-failure.mjs');
 writeFileSync(dir+'/chromium-session.mjs','export async function createChromiumStockSession(){'+scenario.factory+'}');
 const child=spawnHelperTest(process.execPath,[dir+'/helper.mjs'],{env:{...process.env,CHECKOUT_DISABLE_NATIVE:'1',STOCK_CONTAINER_ID:'a'},stdio:'ignore'});
 t.after(async()=>{if(child.exitCode===null)await new Promise(resolve=>{const timer=setTimeout(()=>child.kill('SIGKILL'),3000);child.once('exit',()=>{clearTimeout(timer);resolve();});child.kill('SIGTERM');});rmSync(dir,{recursive:true,force:true});});
 const deadline=Date.now()+5000;while(!existsSync(socket)&&Date.now()<deadline&&child.exitCode===null)await new Promise(r=>setTimeout(r,10));assert.ok(existsSync(socket),'offline helper must be ready');
 const result=await new Promise((resolve,reject)=>{const request=helperTestRequest({socketPath:socket,path:'/fetch',method:'POST',timeout:2000,headers:{'Content-Type':'application/json'}},response=>{let text='';response.on('data',v=>text+=v);response.on('end',()=>{try{resolve(JSON.parse(text));}catch(e){reject(e);}});});request.on('error',reject);request.on('timeout',()=>request.destroy(Error('OFFLINE_HELPER_TIMEOUT')));request.end(JSON.stringify({url:'https://www.apple.com/jp/shop/retail/pickup-message'}));});
 assert.equal(result.ok,false);assert.equal(result.failureCode,scenario.code);assert.equal(result.browserStage,scenario.stage);assert.ok(!JSON.stringify(result).includes('private.invalid'));assert.ok(!JSON.stringify(result).includes('token'));
});
for(const mode of ['close','SIGTERM'])test('the real helper cancels unfinished browser startup on '+mode+' and never acknowledges it while still opening',async t=>{
 const dir=mkdtempSync(tmpdir()+'/apple-helper-cancel-offline-'),socket=dir+'/a.sock',started=dir+'/started',cancelled=dir+'/cancelled';
 const original=readFileSync(new URL('./container-browser-server.mjs',import.meta.url),'utf8'),source=original.replace("const socket='/ipc/'+id+'.sock';",'const socket='+JSON.stringify(socket)+';');assert.notEqual(source,original);
 writeFileSync(dir+'/helper.mjs',source);copyFileSync(new URL('./browser-failure.mjs',import.meta.url),dir+'/browser-failure.mjs');
 writeFileSync(dir+'/chromium-session.mjs',"import{writeFileSync}from'node:fs';export async function createChromiumStockSession({signal}={}){return new Promise((resolve,reject)=>{writeFileSync("+JSON.stringify(started)+",'1');signal?.addEventListener('abort',()=>{setTimeout(()=>{writeFileSync("+JSON.stringify(cancelled)+",'1');reject(Error('Aborted'));},150);},{once:true});});}");
 const child=spawnHelperTest(process.execPath,[dir+'/helper.mjs'],{env:{...process.env,CHECKOUT_DISABLE_NATIVE:'1',STOCK_CONTAINER_ID:'a'},stdio:'ignore'});
 const exited=new Promise(resolve=>child.once('exit',resolve));
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited;}rmSync(dir,{recursive:true,force:true});});
 const call=(path,body={})=>new Promise((resolve,reject)=>{const request=helperTestRequest({socketPath:socket,path,method:'POST',timeout:1000,headers:{'Content-Type':'application/json'}},response=>{let text='';response.on('data',v=>text+=v);response.on('end',()=>{try{resolve(JSON.parse(text));}catch(e){reject(e);}});});request.on('error',reject);request.on('timeout',()=>request.destroy(Error('OFFLINE_CANCEL_TIMEOUT')));request.end(JSON.stringify(body));});
 let deadline=Date.now()+3000;while(!existsSync(socket)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));assert.ok(existsSync(socket));
 const pending=call('/fetch',{url:'https://www.apple.com/jp/shop/retail/pickup-message'}).catch(error=>({transportError:error.message}));
 deadline=Date.now()+1000;while(!existsSync(started)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,5));assert.ok(existsSync(started));assert.equal((await call('/status')).busy,true);
 if(mode==='close'){
  assert.equal((await call('/close')).ok,true);assert.ok(existsSync(cancelled));const state=await call('/status');assert.equal(state.busy,false);assert.equal(state.browserReady,false);
 }else{
  child.kill('SIGTERM');let timer;await Promise.race([exited,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('OFFLINE_SHUTDOWN_TIMEOUT')),1000);})]).finally(()=>clearTimeout(timer));assert.ok(existsSync(cancelled));assert.equal(child.exitCode,0);
 }
 assert.equal((await pending).ok,false);assert.equal(readFileSync(started,'utf8'),'1');assert.equal(readFileSync(cancelled,'utf8'),'1');
});
test('a failed browser close retains its handle and retries cannot acknowledge an unclosed browser',async t=>{
 const dir=mkdtempSync(tmpdir()+'/apple-helper-close-offline-'),socket=dir+'/a.sock',calls=dir+'/calls',closed=dir+'/closed';
 const original=readFileSync(new URL('./container-browser-server.mjs',import.meta.url),'utf8'),source=original.replace("const socket='/ipc/'+id+'.sock';",'const socket='+JSON.stringify(socket)+';');assert.notEqual(source,original);
 writeFileSync(dir+'/helper.mjs',source);copyFileSync(new URL('./browser-failure.mjs',import.meta.url),dir+'/browser-failure.mjs');
 writeFileSync(dir+'/chromium-session.mjs',"import{writeFileSync}from'node:fs';let calls=0;export async function createChromiumStockSession(){return{idleState:()=> 'quiet',fetch:async()=>({status:200,headers:new Headers({'content-type':'application/json'}),text:async()=> '{}'}),close:async()=>{writeFileSync("+JSON.stringify(calls)+",String(++calls));if(calls<3)throw Error('fixture-close-failed');writeFileSync("+JSON.stringify(closed)+",'1');}};}");
 const child=spawnHelperTest(process.execPath,[dir+'/helper.mjs'],{env:{...process.env,CHECKOUT_DISABLE_NATIVE:'1',STOCK_CONTAINER_ID:'a'},stdio:'ignore'}),exited=new Promise(resolve=>child.once('exit',resolve));
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited;}rmSync(dir,{recursive:true,force:true});});
 const call=(path,body={})=>new Promise((resolve,reject)=>{const request=helperTestRequest({socketPath:socket,path,method:'POST',timeout:1000,headers:{'Content-Type':'application/json'}},response=>{let text='';response.on('data',v=>text+=v);response.on('end',()=>{try{resolve(JSON.parse(text));}catch(e){reject(e);}});});request.on('error',reject);request.on('timeout',()=>request.destroy(Error('OFFLINE_CLOSE_TIMEOUT')));request.end(JSON.stringify(body));});
 const end=Date.now()+3000;while(!existsSync(socket)&&Date.now()<end)await new Promise(r=>setTimeout(r,10));assert.ok(existsSync(socket));
 assert.equal((await call('/fetch',{url:'https://www.apple.com/jp/shop/retail/pickup-message'})).ok,true);
 for(let i=1;i<=2;i++){assert.equal((await call('/close')).ok,false);assert.equal((await call('/status')).browserReady,true);assert.equal(readFileSync(calls,'utf8'),String(i));assert.equal(existsSync(closed),false);}
 assert.equal((await call('/close')).ok,true);assert.equal((await call('/status')).browserReady,false);assert.equal(readFileSync(calls,'utf8'),'3');assert.equal(readFileSync(closed,'utf8'),'1');
 assert.equal((await call('/close')).ok,true);assert.equal(readFileSync(calls,'utf8'),'3');
});
test('production guest replies require both the operation id and the correct channel',()=>{
 const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',context={id,channel:'stock-worker-v1'};
 assert.throws(()=>parseGuestReply('{"ok":true}',context),/CONTEXT_MISMATCH/);
 for(const value of [{ok:true,requestId:'other',channel:context.channel},{ok:true,requestId:id,channel:'vpn-control-v1'}])assert.throws(()=>parseGuestReply(JSON.stringify(value),context),/CONTEXT_MISMATCH/);
 assert.deepEqual(parseGuestReply('{"ok":true}',{...context,required:false}),{ok:true});
});
test('a failed guest process can still deliver its own definitive result but not another operation result',async()=>{
 const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',context={id,channel:'vpn-control-v1'};
 const run=value=>async()=>{throw Object.assign(Error('transport exit'),{stdout:JSON.stringify(value)});};
 const value={ok:false,code:'VPN_INVENTORY_UNVERIFIED',requestId:id,channel:context.channel};
 assert.deepEqual(await readGuestCommand(run(value),'fake',[],{},context),value);
 await assert.rejects(readGuestCommand(run({...value,requestId:'other'}),'fake',[],{},context),/CONTEXT_MISMATCH/);
});
test('a terminal negative VPN job result on nonzero exit is reconciled immediately without replay or polling',async()=>{
 let starts=0,reads=0,sleeps=0;
 const run=async(_bin,args)=>{const cmd=args.at(-1),id=/'(?:start|result)' '([^']+)'/.exec(cmd)[1],start=cmd.includes("'start'");if(start)starts++;else reads++;const value={...(start?{ok:true,pending:true}:{ok:false,code:'VPN_INVENTORY_UNVERIFIED'}),requestId:id,channel:'vpn-control-v1'};if(!start)throw Object.assign(Error('exit 1'),{stdout:JSON.stringify(value)});return{stdout:JSON.stringify(value)};};
 const control=createLinuxVpnControl({execFile:run,requireReceipt:true,sleep:async()=>{sleeps++;throw Error('UNEXPECTED_POLL');}});
 await assert.rejects(control('inventory'),e=>e.code==='VPN_INVENTORY_UNVERIFIED');assert.equal(starts,1);assert.equal(reads,1);assert.equal(sleeps,0);
});
test('a lost worker process exit preserves its correctly receipted result',async()=>{
 let calls=0;
 const run=async(_bin,args)=>{calls++;const tokens=[...args.at(-1).matchAll(/'([^']*)'/g)].map(x=>x[1]),data=JSON.parse(Buffer.from(tokens.at(-1),'base64'));const value={...(tokens.includes('/start')?{ok:true,pending:true}:{ok:true,result:proof(1)}),requestId:data.id,channel:'stock-worker-v1'};throw Object.assign(Error('exit 255'),{stdout:JSON.stringify(value)});};
 const worker=createLinuxAdapter(1,{run,requireReceipt:true,sleep:async()=>{}});assert.deepEqual(await worker.network(),proof(1));assert.equal(calls,2);
});
for(const acknowledged of [false,true])test('an operation-missing receipt on nonzero exit '+(acknowledged?'never replays an accepted VPN job':'retries only the unaccepted VPN job id'),async()=>{
 let starts=0,reads=0;const ids=new Set();
 const run=async(_bin,args)=>{const cmd=args.at(-1),id=/'(?:start|result)' '([^']+)'/.exec(cmd)[1];ids.add(id);
  if(cmd.includes("'start'")){starts++;if(!acknowledged&&starts===1)throw Error('unaccepted start');return{stdout:JSON.stringify({ok:true,pending:true,requestId:id,channel:'vpn-control-v1'})};}
  const value=++reads===1?{ok:false,code:'operation-missing'}:{ok:true,result:{connected:true}};
  const stdout=JSON.stringify({...value,requestId:id,channel:'vpn-control-v1'});if(!value.ok)throw Object.assign(Error('exit 1'),{stdout});return{stdout};
 };
 const control=createLinuxVpnControl({execFile:run,requireReceipt:true,sleep:async()=>{}});
 if(acknowledged)await assert.rejects(control('inventory'),/non confermato/);else assert.deepEqual(await control('inventory'),{connected:true});
 assert.equal(starts,acknowledged?1:2);assert.equal(reads,acknowledged?1:2);assert.equal(ids.size,1);
});
test('offline mode rejects real guest executors before launching native commands',async()=>{
 const old=process.env.CHECKOUT_DISABLE_NATIVE;process.env.CHECKOUT_DISABLE_NATIVE='1';
 try{await assert.rejects(createLinuxAdapter(1).network(),/NATIVE_DISABLED/);await assert.rejects(createLinuxVpnControl()('inventory'),/NATIVE_DISABLED/);}finally{if(old===undefined)delete process.env.CHECKOUT_DISABLE_NATIVE;else process.env.CHECKOUT_DISABLE_NATIVE=old;}
});
test('manual stop and rearm refresh the route proof before the first new stock request',async t=>{
 let at=1000000,route=1;const received=[];
 const adapters=[{network:async()=>proof(route),sample:async(s,fingerprint)=>{received.push(fingerprint);if(fingerprint!==proof(route).fingerprint)throw Error('ROUTE_CHANGED');return{sku:s.sku,observedAt:at,stores:[]};},close:async()=>{}},{network:async()=>proof(100),close:async()=>{}}];
 const f=new LinuxFleet({workerCount:1,positions:1,vpnLimit:1,nordLimit:8,adapters,now:()=>at,canChange:()=>true,control:async()=>({1:{connected:true,pinned:true,provider:'nordvpn'}})});t.after(()=>f.stop());
 await f.inspect();await f.start(selection);clearInterval(f.timer);if(f.maintenance)await f.maintenance;await settle();await f.stop();
 route=2;at+=65001;received.length=0;
 await f.start(selection);clearInterval(f.timer);if(f.maintenance)await f.maintenance;await settle();
 assert.equal(received[0],proof(2).fingerprint);assert.equal(f.snapshot().diagnostics.counters.transport,0);
});
test('manual stop drains an in-progress route inspection and cancels its pending rearm',async()=>{
 let reads=0,release;const adapters=[{network:async()=>{if(++reads===1)return proof(1);return new Promise(r=>{release=r;});},close:async()=>{}},{network:async()=>proof(100),close:async()=>{}}];
 const f=new LinuxFleet({workerCount:1,positions:1,vpnLimit:1,nordLimit:8,adapters,now:()=>1000000,control:async()=>({1:{connected:true,pinned:true,provider:'nordvpn'}})});f.tick=()=>{};
 await f.inspect();await f.stop();const rearm=f.start(selection);await settle();let stopped=false;const stop=f.stop().then(()=>{stopped=true;});await settle();const drainedBeforeProof=stopped;
 release?.(proof(2));await Promise.all([rearm,stop]);clearInterval(f.timer);
 assert.equal(reads,2);assert.equal(drainedBeforeProof,false);assert.equal(f.enabled,false);
});
test('checkout quiesce and resume keep the warm route proof without a new fleet preflight',async t=>{
 let reads=0;const adapters=[{network:async()=>{reads++;return proof(1);},close:async()=>{}},{network:async()=>proof(100),close:async()=>{}}];
 const f=new LinuxFleet({workerCount:1,positions:1,vpnLimit:1,nordLimit:8,adapters,now:()=>1000000,control:async()=>({1:{connected:true,pinned:true,provider:'nordvpn'}})});f.tick=()=>{};t.after(()=>f.stop());
 await f.inspect();await f.start(selection);await f.quiesce();await f.start(selection);assert.equal(reads,1);
});
test('guest client replies attest the requested operation context without altering its result',()=>{
 const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',value={ok:true,result:{ready:true}};
 assert.deepEqual(workerClientReply(id,value),{...value,requestId:id,channel:'stock-worker-v1'});assert.equal('requestId' in value,false);
});
test('guest client receipts override stale metadata and cover pending or failed operations',()=>{
 const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 for(const value of [{ok:true,pending:true},{ok:false,code:'operation-missing'},{ok:false,code:'worker-unreachable'}]){
  const reply=workerClientReply(id,{...value,requestId:'stale',channel:'other'});assert.equal(reply.requestId,id);assert.equal(reply.channel,'stock-worker-v1');assert.equal(reply.ok,value.ok);assert.equal(reply.code,value.code);
 }
});
test('guest client receipts reject unidentified and malformed responses',()=>{
 const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';assert.throws(()=>workerClientReply('invalid',{ok:true}),/INVALID_RESPONSE/);
 for(const value of [null,[],{},'unexpected'])assert.throws(()=>workerClientReply(id,value),/INVALID_RESPONSE/);
});
for(const failure of ['ROUTE_CHANGED','TUNNEL_UNVERIFIED','NETWORK'])test('an expired Apple pause is not revived by '+failure,async()=>{
 let at=500000,reads=0,stockStarts=0;
 const worker=new PickupWorker({now:()=>at,network:async()=>{reads++;if(reads===1&&failure!=='ROUTE_CHANGED')throw Error(failure);return proof(2);},browserFactory:async()=>{stockStarts++;throw Error('UNEXPECTED_STOCK');}});
 worker.ledger={nextAllowedAt:400000,pauseHttpStatus:541,lastStartedAt:100000};
 await assert.rejects(worker.sample(selection,proof(1).fingerprint),new RegExp(failure));
 const status=await worker.network();
 assert.equal(status.pauseHttpStatus,null);assert.equal(status.nextAllowedInMs,65000);assert.equal(stockStarts,0);
});
test('an unexpired Apple pause keeps its reason and deadline without any network request',async()=>{
 let reads=0;const worker=new PickupWorker({now:()=>500000,network:async()=>{reads++;return proof(1);}});
 worker.ledger={nextAllowedAt:900000,pauseHttpStatus:541,lastStartedAt:100000};
 await assert.rejects(worker.sample(selection,proof(1).fingerprint),e=>e.message==='NODE_WAIT'&&e.nextAllowedAt===900000);
 assert.equal(reads,0);assert.equal(worker.ledger.pauseHttpStatus,541);assert.equal(worker.ledger.nextAllowedAt,900000);
});
test('the expired pause correction survives a worker restart and preserves its ledger history',async t=>{
 const dir=mkdtempSync(tmpdir()+'/expired-541-');t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=dir+'/ledger.json';
 writeFileSync(path,JSON.stringify({nextAllowedAt:400000,pauseHttpStatus:541,lastStartedAt:100000,attempts:7,successes:5}));
 const settings={ledgerPath:path,now:()=>500000,network:async()=>proof(2)};
 const worker=new PickupWorker(settings);await assert.rejects(worker.sample(selection,proof(1).fingerprint),/ROUTE_CHANGED/);
 const restarted=new PickupWorker(settings),status=await restarted.network();
 assert.equal(status.pauseHttpStatus,null);assert.equal(status.nextAllowedInMs,65000);assert.equal(status.completedChecks,5);assert.equal(restarted.ledger.attempts,7);assert.equal(restarted.ledger.lastStartedAt,100000);
});
test('a new Apple 541 after an expired pause retains its new Retry-After deadline',async()=>{
 const at=500000;let closed=0;
 const worker=new PickupWorker({now:()=>at,network:async()=>proof(1),browserFactory:async()=>({fetch:async()=>{throw Object.assign(Error('APPLE_PAUSE'),{httpStatus:541,nextAllowedAt:1400000});},close:async()=>{closed++;}})});
 worker.ledger={nextAllowedAt:400000,pauseHttpStatus:541,lastStartedAt:100000};
 await assert.rejects(worker.sample(selection,proof(1).fingerprint),e=>e.httpStatus===541);
 const status=await worker.network();assert.equal(status.pauseHttpStatus,541);assert.equal(status.nextAllowedInMs,900000);assert.equal(closed,1);
});
for(const [status,workerCode,kind] of [[541,null,'http541'],[429,null,'http429'],[null,'sample-uncertain','transport'],[null,'NODE_WAIT','nodeWait']])test('passive fleet diagnostics retain the real '+kind+' outcome without exposing worker error details',async t=>{
 const now=()=>1000000,adapters=[{network:async()=>proof(0),sample:async()=>{throw Object.assign(Error('private worker response'),{httpStatus:status,code:workerCode,nextAllowedAt:1900000});},close:async()=>{}},{network:async()=>proof(1),close:async()=>{}}];
 const f=new LinuxFleet({workerCount:1,positions:1,vpnLimit:1,nordLimit:8,adapters,now,canChange:()=>true,control:async()=>({1:{connected:true,pinned:true,provider:'nordvpn'}})});t.after(()=>f.stop());await f.inspect();await f.start(selection);clearInterval(f.timer);if(f.maintenance)await f.maintenance;await settle();
 const d=f.snapshot().diagnostics;assert.equal(d.counters.started,1);assert.equal(d.counters.valid,0);assert.equal(d.counters[kind],1);assert.equal(d.faults[0].httpStatus,status);assert.equal(d.faults[0].duringSearch,true);assert.match(d.faults[0].atJST,/JST$/);assert.equal(d.faults[0].waitMs,900000);assert.equal(JSON.stringify(d).includes('private worker response'),false);
 if(status===429)assert.equal(d.counters.http541,0);
 f.nodes[0].pauseHttpStatus=null;assert.equal(f.snapshot().diagnostics.counters[kind],1);
});
test('a late HTTP 541 after ordinary disarm is retained but excluded from active search exposure',async t=>{
 let reject;const adapters=[{network:async()=>proof(0),sample:()=>new Promise((_,r)=>{reject=r;}),close:async()=>{}},{network:async()=>proof(1),close:async()=>{}}];
 const f=new LinuxFleet({workerCount:1,positions:1,vpnLimit:1,nordLimit:8,adapters,now:()=>1000000,canChange:()=>true,control:async()=>({1:{connected:true,pinned:true,provider:'nordvpn'}})});t.after(()=>f.stop());await f.inspect();await f.start(selection);clearInterval(f.timer);if(f.maintenance)await f.maintenance;await settle();const draining=f.quiesce();reject(Object.assign(Error('failed'),{httpStatus:541}));await draining;await settle();assert.equal(f.snapshot().diagnostics.counters.http541,1);assert.equal(f.snapshot().diagnostics.faults[0].duringSearch,false);
});
test('a warm reserve leaves standby only after its current route is verified for promotion',async()=>{
 const inventory=Object.fromEntries(Array.from({length:29},(_,i)=>[i+1,{connected:true,pinned:true,provider:i<8?'nordvpn':'windscribe'}]));
 const adapters=Array.from({length:30},(_,i)=>({network:async()=>proof(i),close:async()=>{}}));
 const f=new LinuxFleet({workerCount:29,positions:20,vpnLimit:29,standbyTarget:9,nordLimit:8,adapters,now:()=>1000000,control:async()=>structuredClone(inventory)});
 await f.inspect();f.syncRoster();assert.equal(f.snapshot().standbyReady,9);
 f.nodes[1].connected=false;f.nodes[1].verified=false;f.nodes[1].phase='recovering';f.syncRoster();
 assert.equal(f.roster.length,19);assert.equal(f.snapshot().verifiedTunnels,28);assert.equal(f.snapshot().standbyReady,9);
 await f.prove(20);f.syncRoster();
 assert.equal(f.roster.length,20);assert.equal(f.snapshot().standbyReady,8);
});
test('warm handoff verifies the current route instead of returning an older cached proof',async()=>{
 const agents=[{id:'pilot1'},{id:'pilot2'},{id:'pilot3'}],events=[];
 const inventory={1:{connected:true,pinned:true},2:{connected:true,pinned:true},3:{connected:true,pinned:true,provider:'windscribe'}};
 const pool=createLinuxVpnPool({agents,vpnLimit:3,canChange:()=>true,isStandby:i=>i===2,
  adapters:agents.map((_,i)=>({network:async()=>{events.push(['network',i+1]);return proof(i===2?'current-route':i);}})),
  control:async(op,id)=>{events.push([op,id]);if(op==='disconnect')inventory[id].connected=false;return op==='inventory'?structuredClone(inventory):inventory[id];}});
 pool.record(0,proof(0));pool.record(1,proof(1));pool.record(2,proof('previous-route'));
 await pool.refresh();const result=await pool.replace(1,{isEligible:()=>true,isStopping:()=>false});
 assert.equal(result.status,'ready');assert.equal(result.index,2);assert.equal(result.proof.fingerprint,proof('current-route').fingerprint);
 assert.deepEqual(events.filter(([op])=>op==='network'),[['network',3]]);
 assert.ok(!events.some(([op,id])=>(op==='connect'||op==='disconnect')&&id===3));
});
for(const failure of ['transport','duplicate'])test('warm handoff skips a reserve with '+failure+' and verifies the next one',async()=>{
 const agents=Array.from({length:4},(_,i)=>({id:'pilot'+(i+1),verified:true})),events=[];
 const inventory=Object.fromEntries(agents.map((_,i)=>[i+1,{connected:true,pinned:true}]));
 const pool=createLinuxVpnPool({agents,vpnLimit:4,canChange:()=>true,isStandby:i=>i>=2,
  adapters:agents.map((_,i)=>({network:async()=>{events.push(['network',i+1]);if(i===2&&failure==='transport')throw Error('transport');return proof(i===2?0:i);}})),
  control:async(op,id)=>{events.push([op,id]);if(op==='disconnect')inventory[id].connected=false;return op==='inventory'?structuredClone(inventory):inventory[id];}});
 agents.forEach((_,i)=>pool.record(i,proof(i)));await pool.refresh();
 const result=await pool.replace(1,{isEligible:()=>true,isStopping:()=>false});
 assert.equal(result.status,'ready');assert.equal(result.index,3);assert.equal(agents[2].verified,false);assert.equal(agents[2].phase,'recovering');
 assert.deepEqual(events.filter(([op])=>op==='network'),[['network',3],['network',4]]);
 assert.deepEqual(events.filter(([op])=>op==='connect'||op==='disconnect'),[['disconnect',2]]);
});
test('a manual stop while verifying a warm reserve prevents its promotion',async()=>{
 let allowed=true;const agents=[{id:'pilot1'},{id:'pilot2'},{id:'pilot3'}],events=[];
 const inventory={1:{connected:true,pinned:true},2:{connected:true,pinned:true},3:{connected:true,pinned:true}};
 const pool=createLinuxVpnPool({agents,vpnLimit:3,canChange:()=>allowed,isStandby:i=>i===2,
  adapters:agents.map((_,i)=>({network:async()=>{allowed=false;return proof(i);}})),
  control:async(op,id)=>{events.push([op,id]);if(op==='disconnect')inventory[id].connected=false;return op==='inventory'?structuredClone(inventory):inventory[id];}});
 pool.record(2,proof(2));await pool.refresh();const result=await pool.replace(1,{isEligible:()=>true,isStopping:()=>false});
 assert.equal(result.status,'released');assert.ok(!events.some(([op])=>op==='connect'));assert.ok(!events.some(([op,id])=>op==='disconnect'&&id!==2));
});
test('an uncertain inventory invalidates a cached warm proof before a later promotion',async()=>{
 const agents=[{id:'pilot1'},{id:'pilot2'},{id:'pilot3'}],events=[];
 const inventory={1:{connected:true,pinned:true},2:{connected:true,pinned:true},3:{connected:null}};
 const pool=createLinuxVpnPool({agents,vpnLimit:3,canChange:()=>true,isStandby:i=>i===2,
  adapters:agents.map((_,i)=>({network:async()=>{events.push(['network',i+1]);return proof(i);}})),
  control:async(op,id)=>{events.push([op,id]);if(op==='disconnect')inventory[id].connected=false;return op==='inventory'?structuredClone(inventory):inventory[id];}});
 pool.record(2,proof(2));await pool.refresh();inventory[3]={connected:true,pinned:true};await pool.refresh();
 const result=await pool.replace(1,{isEligible:()=>true,isStopping:()=>false});
 assert.notEqual(result.index,2);assert.deepEqual(events.filter(([op])=>op==='network'),[]);
});
for (const scenario of ['other-node-unknown', 'outgoing-unknown', 'native-unknown', 'duplicate-proof']) {
  test('a verified warm handoff under partial inventory respects ' + scenario, async () => {
    const agents = Array.from({ length:5 }, (_, i) => ({ id:'pilot' + (i + 1), verified:true }));
    const inventory = {
      1:{ connected:scenario === 'native-unknown' ? null : true, pinned:true },
      2:{ connected:true, pinned:true },
      3:{ connected:true, pinned:true },
      4:{ connected:null },
      5:{ connected:false },
    };
    const events = [];
    const pool = createLinuxVpnPool({
      agents, vpnLimit:5, canChange:() => true, canPromote:() => inventory[1].connected === true,
      isStandby:i => i === 2,
      adapters:agents.map((_, i) => ({ network:async () => {
        events.push(['network', i + 1]);
        return proof(scenario === 'duplicate-proof' ? 0 : i);
      } })),
      control:async (op, id) => {
        events.push([op, id]);
        if (op === 'disconnect') inventory[id].connected = scenario === 'outgoing-unknown' ? null : false;
        return op === 'inventory' ? structuredClone(inventory) : inventory[id];
      },
    });
    agents.forEach((_, i) => pool.record(i, proof(i)));
    await pool.refresh();
    const result = await pool.replace(1, { isEligible:() => true, isStopping:() => false });
    if (scenario === 'other-node-unknown') {
      assert.equal(result.status, 'ready');
      assert.equal(result.index, 2);
    } else {
      assert.equal(result.status, scenario === 'outgoing-unknown' ? 'disconnect-unverified' : 'released');
    }
    assert.deepEqual(events.filter(([op]) => ['connect', 'disconnect', 'network'].includes(op)),
      ['other-node-unknown', 'duplicate-proof'].includes(scenario)
        ? [['disconnect', 2], ['network', 3]] : [['disconnect', 2]]);
    assert.equal(pool.hasFreeSeat(), false);
  });
}
for(const checkout of [false,true])test('disabled assignment rotates after verified release; checkout='+checkout,async t=>{
 let now=1000000;const events=[],inventory={1:{connected:true,pinned:true},2:{connected:false,assignmentUnavailable:true,provider:'windscribe'},3:{connected:true,pinned:true,provider:'windscribe'}};
 const adapters=Array.from({length:4},(_,i)=>({network:async()=>proof(i),close:async()=>events.push(['close',i+1]),sample:async s=>({sku:s.sku,observedAt:now,stores:[]})}));
 const f=new LinuxFleet({workerCount:3,positions:2,vpnLimit:3,standbyTarget:1,nordLimit:8,adapters,now:()=>now,canChange:()=>!checkout,control:async(op,id)=>{
  events.push([op,id]);if(op==='rotate')inventory[id].assignmentUnavailable=false;if(op==='connect'){assert.equal(inventory[id].assignmentUnavailable,false);inventory[id]={...inventory[id],connected:true,pinned:true};}return op==='inventory'?structuredClone(inventory):op==='rotate'?{rotated:true}:{};
 }});t.after(()=>f.stop());await f.inspect();await f.start(selection);clearInterval(f.timer);if(f.maintenance)await f.maintenance;await settle();
 if(checkout){assert.ok(!events.some(([op])=>['connect','disconnect','rotate'].includes(op)));return;}
 const index=op=>events.findIndex(([x,id])=>x===op&&id===2);assert.ok(index('close')>=0&&index('disconnect')>index('close')&&index('rotate')>index('disconnect')&&index('connect')>index('rotate'));
 assert.equal(f.nodes[1].verified,true);assert.ok(!events.some(([op,id])=>op==='disconnect'&&id===1));
});
for(const scenario of ['verified-release','uncertain-release','checkout-active'])test('terminal VPN error recovery: '+scenario,async t=>{
 let now=1000000;const events=[],inventory={1:{connected:true,pinned:true},2:{connected:null,connectionError:true,provider:'windscribe'},3:{connected:false,provider:'windscribe',authReady:true}};
 const adapters=Array.from({length:4},(_,i)=>({network:async()=>proof(i),close:async()=>events.push(['close',i+1]),sample:async s=>({sku:s.sku,observedAt:now,stores:[]})}));
 const f=new LinuxFleet({workerCount:3,positions:2,vpnLimit:2,standbyTarget:0,nordLimit:8,adapters,now:()=>now,canChange:()=>scenario!=='checkout-active',control:async(op,id)=>{
  events.push([op,id]);if(op==='disconnect'&&scenario!=='uncertain-release')inventory[id]={...inventory[id],connected:false,connectionError:false};if(op==='connect')inventory[id]={...inventory[id],connected:true,pinned:true};return op==='inventory'?structuredClone(inventory):op==='rotate'?{rotated:true}:{};
 }});t.after(()=>f.stop());await f.inspect();assert.equal(f.nodes[1].connected,null);await f.start(selection);clearInterval(f.timer);if(f.maintenance)await f.maintenance;await settle();
 assert.ok(!events.some(([op,id])=>op==='disconnect'&&id===1));
 if(scenario==='checkout-active'){assert.ok(!events.some(([op])=>op==='disconnect'||op==='connect'));return;}
 const closed=events.findIndex(([op,id])=>op==='close'&&id===2),released=events.findIndex(([op,id])=>op==='disconnect'&&id===2);assert.ok(released>closed&&closed>=0);
 if(scenario==='uncertain-release'){assert.equal(f.nodes[1].connected,null);assert.ok(!events.some(([op])=>op==='connect'||op==='rotate'));return;}
 const promoted=events.findIndex(([op,id])=>op==='connect'&&id===3);assert.ok(promoted>released);assert.equal(f.nodes[2].verified,true);assert.equal(f.nodes[1].connected,false);assert.ok(f.nodes[1].reserveSequence>0);
});
test('Windscribe proof requires authenticated matching connection, firewall and HTTPS',async()=>{
 const calls=[];const run=async(bin,args)=>{calls.push([bin,args]);return bin.endsWith('flock')?{stdout:text}:{stdout:'{"ip":"192.0.2.1"}'};};
 const p=await linuxNetwork({run,readProvider:()=>({provider:'windscribe',location:'Shinkansen'})});assert.equal(p.vpn,'protected');assert.ok(!JSON.stringify(p).includes('192.0.2.1'));assert.ok(calls[1][1].includes('=https'));
 for(const bad of [text.replace('On (Always On)','Off'),text.replace('Shinkansen','Other'),text.replace('Logged in','Logged out'),text.replace('Connected to','Connecting to')])await assert.rejects(linuxNetwork({readProvider:()=>({provider:'windscribe',location:'Shinkansen'}),run:async()=>({stdout:bad})}),/TUNNEL_UNVERIFIED/);
 assert.equal(parseWindscribeStatus('Login state: Logged in\nConnect state: Disconnected\nFirewall state: On','Shinkansen').connected,false);
 const colon=text.replace('Connected to Japan - Tokyo - Shinkansen','Connected: Tokyo - Shinkansen');
 assert.equal(parseWindscribeStatus(colon,'Shinkansen').connected,true);
 assert.equal(parseWindscribeStatus(colon,'Wabi-sabi').pinned,false);
 assert.equal((await linuxNetwork({readProvider:()=>({provider:'windscribe',location:'Shinkansen'}),run:async bin=>({stdout:bin.endsWith('flock')?colon:'{"ip":"192.0.2.1"}'})})).vpn,'protected');
});
test('successful samples reuse one browser while transport errors never replay the GET',async t=>{
 const calls=[];let failed=false;const rpc=async(socket,path)=>{if(path==='/close')return{ok:true};calls.push(socket);if(failed)throw Error('transport');return{ok:true,status:200,body:'{}',headers:{'content-type':'application/json'}};};
 const p=createContainerBrowserPool({rpc,sockets:['a','b']});const url=new URL('https://www.apple.com/jp/shop/retail/pickup-message');await p.fetch(url,{method:'GET'});await p.fetch(url,{method:'GET'});assert.deepEqual(calls,['a','a']);failed=true;await assert.rejects(p.fetch(url,{method:'GET'}),/transport/);assert.equal(calls.length,3);await p.close();
 const dir=mkdtempSync(tmpdir()+'/single-browser-');t.after(()=>rmSync(dir,{recursive:true,force:true}));writeFileSync(dir+'/pointer.json','{"next":1}');
 const single=createContainerBrowserPool({rpc:async()=>({ok:true,status:200,body:'{}'}),sockets:['a'],pointerPath:dir+'/pointer.json'});await single.fetch(url,{method:'GET'});await single.close();
});
test('eight NordVPN seats cannot be refilled while Windscribe can add the next verified route',async()=>{
 const agents=Array.from({length:12},(_,i)=>({id:'pilot'+(i+1),checks:0}));const inventory=Object.fromEntries(agents.map((_,i)=>[i+1,{connected:i<8,pinned:true,provider:i>=10?'windscribe':'nordvpn'}]));const events=[];
 const pool=createLinuxVpnPool({agents,adapters:agents.map((_,i)=>({network:async()=>proof(i)})),vpnLimit:10,nordLimit:8,canChange:()=>true,control:async(op,id)=>{events.push([op,id]);if(op==='connect')inventory[id].connected=true;return op==='inventory'?structuredClone(inventory):inventory[id];}});
 await pool.fill({isEligible:()=>true,isStopping:()=>false});assert.deepEqual(events.find(([op])=>op==='connect'),['connect',11]);
});
test('filling a missing tunnel does not repeatedly reselect an already connected warm reserve',async()=>{
 const agents=Array.from({length:12},(_,i)=>({id:'pilot'+(i+1),checks:0}));
 const inventory=Object.fromEntries(agents.map((_,i)=>[i+1,{connected:i<11,pinned:true,provider:i<8?'nordvpn':'windscribe'}]));
 const events=[],pool=createLinuxVpnPool({agents,adapters:agents.map((_,i)=>({network:async()=>proof(i)})),vpnLimit:12,nordLimit:8,canChange:()=>true,isStandby:i=>i===10,control:async(op,id)=>{events.push([op,id]);if(op==='connect')inventory[id].connected=true;return op==='inventory'?structuredClone(inventory):inventory[id];}});
 pool.record(10,proof(10));const result=await pool.fill({isEligible:()=>true,isStopping:()=>false});
 assert.deepEqual(events.filter(([op])=>op==='connect'),[['connect',12]]);assert.equal(result.index,11);
});
function failedReserve({recovered=false,uncertainRelease=false}={}){
 const agents=[{id:'pilot1'},{id:'pilot2'}],events=[],inventory={1:{connected:true,pinned:true},2:{connected:false,provider:'windscribe',authReady:true}};
 const pool=createLinuxVpnPool({agents,adapters:agents.map((_,i)=>({network:async()=>proof(i)})),vpnLimit:2,canChange:()=>true,onRetired:i=>events.push(['retired',i]),control:async(op,id)=>{
  events.push([op,id]);if(op==='connect'){if(recovered){inventory[id]={...inventory[id],connected:true,pinned:true};throw Error('lost reply');}}
  if(op==='disconnect')inventory[id]={...inventory[id],connected:uncertainRelease?null:false};return op==='inventory'?structuredClone(inventory):inventory[id];
 }});return{pool,events};
}
test('failed VPN connection retires its reserve only after disconnection is confirmed',async()=>{
 const f=failedReserve();const r=await f.pool.fill({isEligible:()=>true,isStopping:()=>false});assert.equal(r.status,'connect-unverified');
 const disconnect=f.events.findIndex(([op])=>op==='disconnect'),retired=f.events.findIndex(([op])=>op==='retired');assert.ok(disconnect>=0&&retired>disconnect);assert.deepEqual(f.events[retired-1],['inventory',undefined]);assert.deepEqual(f.events[retired],['retired',1]);
});
test('an uncertain disconnection cannot schedule a server rotation',async()=>{
 const f=failedReserve({uncertainRelease:true});await f.pool.fill({isEligible:()=>true,isStopping:()=>false});assert.equal(f.events.some(([op])=>op==='retired'),false);assert.equal(f.pool.hasFreeSeat(),false);
});
test('a recovered transport reply keeps the verified connection and never retires it',async()=>{
 const f=failedReserve({recovered:true});const r=await f.pool.fill({isEligible:()=>true,isStopping:()=>false});assert.equal(r.status,'ready');assert.equal(f.events.some(([op])=>['disconnect','retired'].includes(op)),false);
});
test('a failed reserve queues behind a ready reserve and rotates only after its verified release',async t=>{
 let now=1000000;const events=[],inventory={1:{connected:true,pinned:true},2:{connected:false,provider:'windscribe',authReady:true},3:{connected:false,provider:'windscribe',authReady:true}};
 const adapters=Array.from({length:4},(_,i)=>({network:async()=>proof(i),close:async()=>{},sample:async s=>({sku:s.sku,observedAt:now,stores:[]})}));
 const f=new LinuxFleet({workerCount:3,positions:2,vpnLimit:3,standbyTarget:1,nordLimit:8,adapters,now:()=>now,canChange:()=>true,control:async(op,id)=>{events.push([op,id]);if(op==='connect'&&id===3)inventory[id].connected=true;if(op==='connect'&&id===3)inventory[id].pinned=true;if(op==='disconnect')inventory[id].connected=false;return op==='inventory'?structuredClone(inventory):op==='rotate'?{rotated:true}:{};}});
 t.after(()=>f.stop());await f.inspect();await f.start(selection);clearInterval(f.timer);if(f.maintenance)await f.maintenance;await settle();assert.ok(f.roster.includes(2));assert.equal(f.nodes[1].rotationPending,true);assert.ok(f.nodes[1].reserveSequence>0);
 now+=30000;f.nextMaintenance=0;f.tick();if(f.maintenance)await f.maintenance;await settle();const released=events.findIndex(([op,id])=>op==='disconnect'&&id===2),rotated=events.findIndex(([op,id])=>op==='rotate'&&id===2);assert.ok(rotated>released&&released>=0);assert.equal(events.some(([op,id])=>op==='disconnect'&&id===1),false);
});
test('a fully migrated pool accepts zero NordVPN seats and never promotes a NordVPN reserve',async()=>{
 const agents=[{id:'pilot1'},{id:'pilot2'},{id:'pilot3'}],events=[],inventory={1:{connected:true,pinned:true,provider:'windscribe'},2:{connected:false,provider:'nordvpn'},3:{connected:false,provider:'windscribe'}};
 const pool=createLinuxVpnPool({agents,adapters:agents.map((_,i)=>({network:async()=>proof(i)})),vpnLimit:2,nordLimit:0,canChange:()=>true,control:async(op,id)=>{events.push([op,id]);if(op==='connect')inventory[id].connected=true;return op==='inventory'?structuredClone(inventory):inventory[id];}});
 const result=await pool.fill({isEligible:()=>true,isStopping:()=>false});assert.equal(result.index,2);assert.deepEqual(events.filter(([op])=>op==='connect'),[['connect',3]]);
});
test('thirty verified tunnels keep exactly twenty samplers and ten warm reserves across worker cycles',async t=>{
 let now=1000000;const calls=[],counts=new Map(),inventory=Object.fromEntries(Array.from({length:30},(_,i)=>[i+1,{connected:true,pinned:true,provider:i<8?'nordvpn':'windscribe'}]));
 const adapters=Array.from({length:31},(_,i)=>({network:async()=>proof(i),sample:async s=>{const last=counts.get(i);if(last!==undefined)assert.ok(now-last>=65000);counts.set(i,now);calls.push(i);return{sku:s.sku,observedAt:now,stores:[]};},close:async()=>{}}));
 const f=new LinuxFleet({workerCount:30,positions:20,vpnLimit:30,standbyTarget:10,nordLimit:8,adapters,canChange:()=>true,now:()=>now,control:async()=>structuredClone(inventory)});t.after(()=>f.stop());await f.inspect();await f.start(selection);clearInterval(f.timer);await f.maintenance;await settle();
 for(let n=0;n<90;n++){now+=3250;f.tick();await settle();if(f.maintenance)await f.maintenance;}
 assert.equal(f.snapshot().verifiedTunnels,30);assert.equal(f.snapshot().standbyReady,10);assert.equal(f.roster.length,20);assert.equal(new Set(calls).size,20);assert.ok(!calls.some(i=>i>=20));assert.equal(f.dispatchInterval(),3250);
});

test('a transport failure deferred by checkout releases its tunnel after checkout is idle',async t=>{
 let now=1000000,canChange=true,fail=true;const events=[],inventory={1:{connected:true,pinned:true},2:{connected:true,pinned:true},3:{connected:true,pinned:true}};
 const adapters=Array.from({length:4},(_,i)=>({network:async()=>proof(i),close:async()=>{events.push(['close',i+1]);},sample:async s=>{if(i===1&&fail){fail=false;canChange=false;throw Error('transport');}return{sku:s.sku,observedAt:now,stores:[]};}}));
 const f=new LinuxFleet({workerCount:3,positions:2,vpnLimit:3,standbyTarget:1,nordLimit:8,adapters,now:()=>now,canChange:()=>canChange,control:async(op,id)=>{events.push([op,id]);if(op==='disconnect')inventory[id].connected=false;if(op==='connect')inventory[id].connected=true;return op==='inventory'?structuredClone(inventory):op==='rotate'?{rotated:true}:{};}});
 t.after(()=>f.stop());await f.inspect();await f.start(selection);clearInterval(f.timer);if(f.maintenance)await f.maintenance;await settle();
 now+=32500;f.tick();if(f.maintenance)await f.maintenance;await settle();
 assert.equal(canChange,false);assert.equal(f.nodes[1].rotationPending,true);assert.equal(inventory[2].connected,true);assert.ok(!events.some(([op])=>op==='disconnect'));
 canChange=true;f.nextMaintenance=0;f.tick();if(f.maintenance)await f.maintenance;await settle();
 const disconnected=events.findIndex(([op,id])=>op==='disconnect'&&id===2),rotated=events.findIndex(([op,id])=>op==='rotate'&&id===2);
 assert.ok(disconnected>=0,'deferred failed worker must release the still-connected tunnel');assert.ok(rotated>disconnected,'rotation follows verified disconnect');assert.equal(f.nodes[1].rotationPending,false);assert.ok(f.roster.includes(2),'the verified warm reserve must enter the roster');assert.ok(!events.some(([op,id])=>op==='disconnect'&&id===1),'native underlay stays connected');
});

test('a verified new server clears the old pin failure delay while preserving Apple and provider pauses',async()=>{
 let now=1000000,connects=0,failed=true;const inventory={1:{connected:true,pinned:true},2:{connected:false,provider:'windscribe',authReady:true}},agents=[{id:'pilot1'},{id:'pilot2',nextAllowedAt:1300000}],adapters=[{network:async()=>proof(1)},{network:async()=>proof(2)}];
 const pool=createLinuxVpnPool({agents,adapters,vpnLimit:2,nordLimit:8,now:()=>now,canChange:()=>true,control:async(op,id)=>{if(op==='connect'){connects++;if(!failed)inventory[id]={...inventory[id],connected:true,pinned:true};}if(op==='disconnect')inventory[id].connected=false;return op==='inventory'?structuredClone(inventory):{};}});
 pool.record(0,proof(1));await pool.fill({isEligible:()=>true,isStopping:()=>false});assert.equal(connects,1);failed=false;await pool.fill({isEligible:()=>true,isStopping:()=>false});assert.equal(connects,1,'failed old assignment remains in backoff');
 pool.rotated(1);const result=await pool.fill({isEligible:()=>true,isStopping:()=>false});assert.equal(connects,2);assert.equal(result.status,'ready');assert.equal(agents[1].nextAllowedAt,1300000,'Apple stock deadline is unchanged');
 inventory[2]={connected:false,provider:'windscribe',authReady:true,connectNextAllowedInMs:60000};pool.rotated(1);await pool.fill({isEligible:i=>(agents[i].nextVpnAllowedAt??0)<=now,isStopping:()=>false});assert.equal(connects,2,'provider connect deadline still applies');
 inventory[2]={connected:null};pool.rotated(1);await pool.fill({isEligible:()=>true,isStopping:()=>false});assert.equal(connects,2,'unknown inventory still blocks new connections');
});

test('repeated failed new assignments cannot clear connection backoff through more rotations',async()=>{
 let now=1000000,connects=0;const inventory={1:{connected:true,pinned:true},2:{connected:false,provider:'windscribe',authReady:true}},agents=[{id:'pilot1'},{id:'pilot2'}];
 const pool=createLinuxVpnPool({agents,adapters:agents.map((_,i)=>({network:async()=>proof(i+1)})),vpnLimit:2,nordLimit:8,now:()=>now,canChange:()=>true,control:async(op,id)=>{if(op==='connect')connects++;if(op==='disconnect')inventory[id].connected=false;return op==='inventory'?structuredClone(inventory):{};}});
 await pool.fill({isEligible:()=>true,isStopping:()=>false});pool.rotated(1);await pool.fill({isEligible:()=>true,isStopping:()=>false});assert.equal(connects,2);pool.rotated(1);await pool.fill({isEligible:()=>true,isStopping:()=>false});assert.equal(connects,2);now+=300001;await pool.fill({isEligible:()=>true,isStopping:()=>false});assert.equal(connects,3);
});

async function macDuringApplePauseFixture(t,{uncertain=false,limited=true,wait=false,held=false}={}) {
 let at=1000000,release;const samples=[];const gate=new Promise(r=>{release=r;});
 const adapters=Array.from({length:6},(_,i)=>({network:async()=>proof(i),close:async()=>{},sample:async selection=>{samples.push(i);if(i===5&&held)await gate;return{sku:selection.sku,observedAt:at,stores:[]};}}));
 const inventory=Object.fromEntries(Array.from({length:5},(_,i)=>[i+1,{connected:true,pinned:true,provider:i===0?'nordvpn':'windscribe'}]));
 const f=new LinuxFleet({workerCount:5,positions:3,vpnLimit:5,standbyTarget:2,nordLimit:8,adapters,now:()=>at,canChange:()=>true,control:async()=>structuredClone(inventory)});
 await f.inspect();f.syncRoster();
 for(const i of limited?[2,3,4]:[3,4])Object.assign(f.nodes[i],{phase:'cooldown',pauseHttpStatus:541,nextAllowedAt:at+300000});
 if(!limited)Object.assign(f.nodes[2],{verified:false,phase:'recovering'});
 for(const i of [0,1])f.nodes[i].nextAllowedAt=at+1000000;
 if(uncertain)f.nodes[4].connected=null;
 Object.assign(f.nodes[5],{verified:true,phase:'ready',nextAllowedAt:wait?at+65000:0});f.proofs.set(5,{...proof(100),vpn:'host'});
 f.enabled=true;f.generation++;f.selections=[selection];f.selection=selection;f.selectionCursor=0;f.nextMaintenance=Infinity;f.maintenance=new Promise(()=>{});
 t.after(async()=>{release();f.maintenance=null;await f.stop();});
 return{f,samples,release,advance:()=>{at+=70000;}};
}
test('a verified Mac can sample during VPN recovery when Apple pauses make the Linux target impossible',async t=>{
 const x=await macDuringApplePauseFixture(t);x.f.tick();await settle();assert.deepEqual(x.samples,[5]);assert.equal(x.f.nodes[5].checks,1);
});
test('an admitted Mac reserve receives a fair dispatch turn while verified Linux nodes are also ready',async t=>{
 const x=await macDuringApplePauseFixture(t);
 for(const i of [0,1])Object.assign(x.f.nodes[i],{nextAllowedAt:0,checks:10,workerSuccesses:100});
 x.f.tick();await settle();assert.deepEqual(x.samples,[5]);assert.equal(x.f.nodes[5].checks,1);assert.equal(x.f.nodes[5].nextAllowedAt,1065000);
 x.f.tick();await settle();assert.deepEqual(x.samples,[5],'global spacing and the Mac ledger still prevent another start');
});
test('Mac dispatch fairness never admits it when verified Linux nodes fill every position',async t=>{
 const x=await macDuringApplePauseFixture(t);
 for(const i of [0,1,2])Object.assign(x.f.nodes[i],{nextAllowedAt:0,pauseHttpStatus:null,phase:'ready',checks:10});
 x.f.tick();await settle();assert.ok(x.samples.length===1&&x.samples[0]<5);assert.equal(x.f.nodes[5].checks,0);assert.ok(!x.f.active.includes(5));
});
for(const options of [{uncertain:true},{limited:false},{wait:true}])test('Mac recovery fallback retains inventory, last-reserve and ledger guards: '+JSON.stringify(options),async t=>{
 const x=await macDuringApplePauseFixture(t,options);x.f.tick();await settle();assert.deepEqual(x.samples,[]);
});
test('a Mac request finishes before yielding to verified Linux restored during recovery',async t=>{
 const x=await macDuringApplePauseFixture(t,{held:true});x.f.tick();await settle();const macJob=x.f.jobs.get(5);assert.ok(macJob);assert.deepEqual(x.samples,[5]);
 Object.assign(x.f.nodes[2],{pauseHttpStatus:null,nextAllowedAt:0,verified:true,phase:'ready'});x.advance();x.f.tick();await settle();assert.ok(x.f.jobs.has(5));
 x.release();await macJob;x.f.tick();assert.equal(x.f.active.includes(5),false);assert.equal(x.f.roster.length,3);assert.equal(x.f.nodes[5].checks,1);
});

for(const ledgerWait of [false,true])test('cold Mac proof precedes slow paused VPN reconnect and preserves its own ledger; wait='+ledgerWait,async t=>{
 const x=await macDuringApplePauseFixture(t);x.f.maintenance=null;Object.assign(x.f.nodes[5],{verified:false,nextAllowedAt:0});x.f.proofs.delete(5);
 const inventory=Object.fromEntries(Array.from({length:5},(_,i)=>[i+1,{connected:i!==2,pinned:true,provider:i===0?'nordvpn':'windscribe'}]));
 let began,release;const started=new Promise(r=>{began=r;}),gate=new Promise(r=>{release=r;});
 x.f.adapters[5].network=async()=>({...proof(100),vpn:'host',nextAllowedInMs:ledgerWait?65000:0});
 x.f.control=async(op,id)=>{if(op==='rotate'){began();await gate;return{rotated:true};}if(op==='connect')inventory[id].connected=true;if(op==='disconnect')inventory[id].connected=false;return op==='inventory'?structuredClone(inventory):{};};
 x.f.pool=x.f.makePool();for(const[i,p]of x.f.proofs)x.f.pool.record(i,p);
 t.after(()=>release());x.f.maintain();await started;
 assert.equal(x.f.nodes[5].verified,true);x.f.tick();await settle();assert.deepEqual(x.samples,ledgerWait?[]:[5]);release();await x.f.maintenance;
});

test('a Mac under its own Apple 541 pause is neither dispatched nor counted as stock capacity',async t=>{
 const x=await macDuringApplePauseFixture(t,{wait:true});x.f.nodes[5].pauseHttpStatus=541;x.f.tick();await settle();assert.deepEqual(x.samples,[]);assert.equal(x.f.samplingCapacity(),2);
});

for(const scenario of ['healthy','route-changed','unprotected','stop','required-refresh','stale-route','unknown-proof','recent-proof'])test('a trusted Linux sample keeps its real fresh preflight without a duplicate VM proof: '+scenario,async t=>{
 const x=await readyReserveFixture(t),{f,at}=x;let release,reads=0,gets=0,browsers=0;const gate=new Promise(resolve=>{release=resolve;}),operations=[],signals=[];
 const worker=new PickupWorker({now:()=>at,network:async()=>{if(++reads===1)await gate;if(scenario==='unprotected')throw Error('TUNNEL_UNVERIFIED');return proof(scenario==='route-changed'?0:scenario==='stale-route'?400:3);},browserFactory:async()=>{browsers++;return{close:async()=>{},fetch:async()=>{gets++;const part={partNumber:selection.sku,pickupDisplay:'unavailable',storePickEligible:false,messageTypes:{regular:{storeSelectionEnabled:false,storePickupProductTitle:'offline fixture'}}};return new Response(JSON.stringify({head:{status:200},body:{stores:[{storeNumber:'R119',partsAvailability:{[selection.sku]:part}}]}}),{status:200,headers:{'content-type':'application/json'}});}};}});t.after(()=>worker.close());
 const jobs=new WorkerJobs(worker,null,()=>at),run=async(_bin,args)=>{const tokens=[...args.at(-1).matchAll(/'([^']*)'/g)].map(x=>x[1]),data=JSON.parse(Buffer.from(tokens.at(-1),'base64'));if(tokens.includes('/start'))operations.push(data.operation);const result=tokens.includes('/start')?jobs.start(data.id,data.operation,data.data):jobs.result(data.id);return{stdout:JSON.stringify(workerClientReply(data.id,result))};};
 f.adapters[3]=createLinuxAdapter(4,{run,requireReceipt:true,sleep:settle,spacing:()=>0});f.onSignal=signal=>signals.push(signal);
 if(scenario==='required-refresh'){f.nodes[3].dispatchProofPending=true;f.nodes[3].provedAt=at-65001;}
 if(scenario==='stale-route')f.nodes[3].provedAt=at-65000;
 if(scenario==='unknown-proof')delete f.nodes[3].provedAt;
 if(scenario==='recent-proof')f.nodes[3].provedAt=at-64999;
 let stopped;
 try {
  f.tick();for(let i=0;i<50&&reads===0;i++)await settle();assert.equal(reads,1);assert.equal(gets,0);
  if(scenario==='stop')stopped=f.quiesce();if(['route-changed','unprotected'].includes(scenario))x.setAllowed(false);
 } finally {release();}
 await Promise.allSettled([...f.jobs.values()]);if(stopped)await stopped;
 const refresh=['required-refresh','stale-route','unknown-proof'].includes(scenario);const expected=refresh?['network','sample']:['sample'];assert.deepEqual(operations.filter(op=>op!=='close'),expected);
 assert.equal(reads,refresh?2:1);
 if(['route-changed','unprotected'].includes(scenario)){assert.equal(gets,0);assert.equal(browsers,0);assert.equal(signals.length,0);assert.equal(f.nodes[3].verified,false);}
 else{assert.equal(gets,1);assert.equal(browsers,1);assert.equal(signals.length,1);assert.equal(signals[0].canCheckout,scenario!=='stop');assert.equal(worker.ledger.nextAllowedAt,at+65000);}
 assert.deepEqual(x.controls,[]);
});

test('guest timing diagnostics retain only bounded numbers and cannot replace a correctly receipted reply',async()=>{
 const metrics=[],run=async(_bin,args)=>{const tokens=[...args.at(-1).matchAll(/'([^']*)'/g)].map(x=>x[1]),data=JSON.parse(Buffer.from(tokens.at(-1),'base64'));return{stdout:JSON.stringify(workerClientReply(data.id,tokens.includes('/start')?{ok:true,pending:true}:{ok:true,result:proof(1)}))};};
 const worker=createLinuxAdapter(1,{run,requireReceipt:true,sleep:settle,onMetric:value=>{metrics.push(value);throw Error('ignored observer failure');}});assert.deepEqual(await worker.network(),proof(1));assert.equal(metrics.length,2);
 const f=new LinuxFleet({workerCount:1,positions:1,vpnLimit:1,adapters:[{},{}],control:async()=>({})});
 for(const value of metrics){assert.deepEqual(Object.keys(value).sort(),['command','executionMs','operation','outcome','paced','queueMs','transportCode']);assert.ok(value.queueMs>=0&&value.executionMs>=0);f.recordGuestMetric({...value,privateValue:'private.invalid'});}
 f.recordGuestMetric({operation:'private.invalid',command:'result',paced:false,queueMs:0,executionMs:0});const timing=f.snapshot().diagnostics.guestRPC;assert.equal(timing.calls,2);assert.equal(timing.recentCalls,2);assert.ok(!JSON.stringify(f.guestMetrics).includes('private.invalid'));
 for(let i=0;i<250;i++)f.recordGuestMetric(metrics[0]);assert.equal(f.guestMetrics.length,200);assert.equal(f.snapshot().diagnostics.guestRPC.calls,252);
});

test('guest reply metrics identify a rejected receipt and confirmed unaccepted sample without replaying an accepted job',async()=>{
 const metrics=[];let starts=0,polls=0,identity,reclaims=0;
 const run=async(_bin,args)=>{
  const tokens=[...args.at(-1).matchAll(/'([^']*)'/g)].map(x=>x[1]),data=JSON.parse(Buffer.from(tokens.at(-1),'base64'));
  identity??=data.id;assert.equal(data.id,identity);
  if(tokens.includes('/start')){
   if(++starts===1)return{stdout:JSON.stringify(workerClientReply('00000000-0000-0000-0000-000000000000',{ok:true,pending:true}))};
   return{stdout:JSON.stringify(workerClientReply(data.id,{ok:true,pending:true}))};
  }
  return{stdout:JSON.stringify(workerClientReply(data.id,++polls===1?{ok:false,code:'operation-missing'}:{ok:true,result:{sku:selection.sku,observedAt:Date.now(),stores:[]}}))};
 };
 const adapter=createLinuxAdapter(1,{run,requireReceipt:true,sleep:settle,spacing:()=>0,onMetric:value=>metrics.push(value),onPaceReclaim:()=>{reclaims++;throw Error('ignored observer failure');}});
 await adapter.sample(selection,proof(1).fingerprint);assert.equal(starts,2);assert.equal(polls,2);assert.equal(reclaims,1);
 assert.deepEqual(metrics.map(v=>v.outcome),['unreadable','missing','pending','complete']);
 assert.equal(metrics[0].transportCode,'GUEST_REPLY_CONTEXT_MISMATCH');
 const f=new LinuxFleet({workerCount:1,positions:1,vpnLimit:1,adapters:[{},{}],control:async()=>({})});
 for(const value of metrics)f.recordGuestMetric({...value,privateValue:'wrong-private-context'});
 const result=f.snapshot().diagnostics.guestRPC;
 assert.equal(result.sampleStartCalls,2);assert.equal(result.sampleStartAccepted,1);assert.equal(result.missingSampleResults,1);
 assert.deepEqual(result.replyCounts,{pending:1,complete:1,missing:1,failed:0,unreadable:1});
 assert.deepEqual(result.transportCounts,{GUEST_REPLY_CONTEXT_MISMATCH:1});
 f.recordGuestMetric({...metrics[0],transportCode:'wrong-private-context'});assert.equal(f.snapshot().diagnostics.guestRPC.calls,4);
 assert.ok(!JSON.stringify(f.guestMetrics).includes('wrong-private-context'));
});

test('a confirmed unaccepted start returns only its unused turn; the Mac shares cadence without blocking guest results',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.now()});
 const {runLinuxGuestCommand:queue,reclaimUnacceptedLinuxSample:reclaim,runPacedHostSample:host}=await import('./linux-control.mjs?unused-slot-fixture');
 const id='11111111-1111-1111-1111-111111111111',spacing=()=>3250,starts=[];let reservation,release,controlRead=false;
 await queue(()=>starts.push({kind:'accepted-linux',at:Date.now()}),spacing);
 const failed=queue(()=>starts.push({kind:'unaccepted',at:Date.now()}),spacing,false,{id,onStart:value=>{reservation=value;}});
 t.mock.timers.tick(3250);await settle();await failed;
 const receipt={ok:false,code:'operation-missing',requestId:id,channel:'stock-worker-v1'};
 assert.equal(reclaim(reservation,receipt,id,false),true);assert.equal(reclaim(reservation,receipt,id,false),false);
 const mac=host(()=>{starts.push({kind:'mac',at:Date.now()});return new Promise(r=>{release=r;});},spacing);
 await settle();await queue(()=>{controlRead=true;});assert.equal(controlRead,true);assert.equal(starts.at(-1).kind,'mac');
 const next=queue(()=>starts.push({kind:'accepted-linux',at:Date.now()}),spacing);
 t.mock.timers.tick(3249);await settle();assert.equal(starts.length,3);
 t.mock.timers.tick(1);await settle();await next;release();await mac;
 const accepted=starts.filter(x=>x.kind!=='unaccepted');for(let i=1;i<accepted.length;i++)assert.ok(accepted[i].at-accepted[i-1].at>=3250);
 assert.equal(accepted[1].at,starts[1].at,'the unused turn was reclaimed rather than charged twice');
});
test('a pacing reservation cannot be returned for an older, accepted, mismatched or uncertain request',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.now()});
 const {runLinuxGuestCommand:queue,reclaimUnacceptedLinuxSample:reclaim}=await import('./linux-control.mjs?unused-slot-guards');
 const a='22222222-2222-2222-2222-222222222222',b='33333333-3333-3333-3333-333333333333',spacing=()=>3250;let first,last;
 const receipt=id=>({ok:false,code:'operation-missing',requestId:id,channel:'stock-worker-v1'});
 await queue(()=>{},spacing,false,{id:a,onStart:r=>{first=r;}});
 const second=queue(()=>{},spacing,false,{id:b,onStart:r=>{last=r;}});t.mock.timers.tick(3250);await settle();await second;
 assert.equal(reclaim(first,receipt(a),a,false),false);
 assert.equal(reclaim(last,receipt(b),b,true),false);
 assert.equal(reclaim(last,receipt(a),b,false),false);
 assert.equal(reclaim(last,{...receipt(b),channel:'wrong-channel'},b,false),false);
 assert.equal(reclaim(last,{...receipt(b),code:'sample-uncertain'},b,false),false);
 assert.equal(reclaim(last,receipt(b),b,false),true);
});
test('an accepted sample whose journal later disappears never returns a pacing turn or relaunches',async()=>{
 let starts=0,reclaims=0;
 const run=async(_bin,args)=>{const tokens=[...args.at(-1).matchAll(/'([^']*)'/g)].map(x=>x[1]),data=JSON.parse(Buffer.from(tokens.at(-1),'base64'));if(tokens.includes('/start'))starts++;return{stdout:JSON.stringify(workerClientReply(data.id,tokens.includes('/start')?{ok:true,pending:true}:{ok:false,code:'operation-missing'}))};};
 const adapter=createLinuxAdapter(1,{run,requireReceipt:true,sleep:settle,spacing:()=>0,onPaceReclaim:()=>{reclaims++;}});
 await assert.rejects(adapter.sample(selection,proof(1).fingerprint),e=>e.code==='sample-uncertain');assert.equal(starts,1);assert.equal(reclaims,0);
});

for(const mode of ['never-accepted','accepted-reply-lost','read-fails-once','all-launches-fail'])test('an unreadable sample launch reconciles once immediately and preserves backoff: '+mode,async()=>{
 const events=[],sleeps=[];let starts=0,reads=0;
 const run=async(_bin,args)=>{
  const tokens=[...args.at(-1).matchAll(/'([^']*)'/g)].map(x=>x[1]),data=JSON.parse(Buffer.from(tokens.at(-1),'base64'));
  let reply;
  if(tokens.includes('/start')){events.push('start');if(++starts===1||mode==='all-launches-fail')throw Error('TRANSPORT');reply={ok:true,pending:true};}
  else{
   events.push('read');reads++;
   if(mode==='read-fails-once'&&reads===1)throw Error('TRANSPORT');
   reply=mode==='all-launches-fail'?{ok:false,code:'operation-missing'}:reads===1?(mode==='never-accepted'?{ok:false,code:'operation-missing'}:{ok:true,pending:true}):{ok:true,result:{sku:selection.sku,observedAt:Date.now(),stores:[]}};
  }
  return{stdout:JSON.stringify(workerClientReply(data.id,reply))};
 };
 const adapter=createLinuxAdapter(1,{run,requireReceipt:true,spacing:()=>0,pollInterval:()=>800,sleep:async ms=>{events.push('wait');sleeps.push(ms);await settle();}});
 if(mode==='all-launches-fail'){
  await assert.rejects(adapter.sample(selection,proof(1).fingerprint),error=>error.code==='operation-missing');
  assert.equal(starts,3);assert.equal(reads,3);assert.deepEqual(sleeps,[]);return;
 }
 await adapter.sample(selection,proof(1).fingerprint);
 assert.deepEqual(events.slice(0,2),['start','read'],'the first reconciliation is not delayed');
 assert.deepEqual(sleeps,[800],'pending or uncertain result reads still back off');
 assert.equal(starts,mode==='never-accepted'?2:1);assert.equal(reads,2);
});
