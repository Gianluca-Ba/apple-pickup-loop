import test from 'node:test';
import assert from 'node:assert/strict';
import { fleetGrowthPlan,growthResourceGate,chooseWarmReserves,queueRetiredNode } from './fleet-growth.mjs';
const GiB=1024**3;
test('growth prepares all twenty-nine tunnels before raising the active roster in pairs to twenty',()=>{
  const plan=fleetGrowthPlan(); assert.equal(plan.length,15);
  assert.ok(plan.every(s=>s.addTunnels<=2&&s.active<=20&&s.connected<=29));
  assert.ok(plan.every(s=>s.active===10||s.connected===29));
  assert.deepEqual(plan[0],{addTunnels:2,connected:12,active:10,standby:2});
  assert.deepEqual(plan.at(-1),{addTunnels:0,connected:29,active:20,standby:9});
  assert.throws(()=>fleetGrowthPlan({targetActive:22}),/FLEET_GROWTH_INVALID/);
});
test('an already prepared fleet raises only the active roster, with no extra tunnel or thirtieth node',()=>{
  const plan=fleetGrowthPlan({connected:29,active:10});
  assert.deepEqual(plan.map(s=>s.active),[12,14,16,18,20]);
  assert.ok(plan.every(s=>s.addTunnels===0&&s.connected===29));
});
test('every rollout step requires fresh measured headroom and two response-based worker cycles',()=>{
  const sample={at:1000,guestRamBytes:12*GiB,guestAvailableBytes:3*GiB,guestFreeDiskBytes:24*GiB,hostFreeDiskBytes:60*GiB,hostMemoryHeadroomPercent:60,cpuPressureAvg60:1,memoryPressureAvg60:0,ioPressureAvg60:0};
  assert.equal(growthResourceGate(sample,{now:1000,stabilizedForMs:130000}).ready,true);
  for(const bad of [{guestAvailableBytes:GiB},{guestFreeDiskBytes:GiB},{hostFreeDiskBytes:GiB},{memoryPressureAvg60:2},{hostMemoryHeadroomPercent:10},{cpuPressureAvg60:15},{at:1001}]) assert.equal(growthResourceGate({...sample,...bad},{now:1000,stabilizedForMs:130000}).ready,false);
  assert.equal(growthResourceGate(sample,{now:1000,stabilizedForMs:65000}).ready,false);
  assert.equal(growthResourceGate(sample,{now:62000,stabilizedForMs:130000}).ready,false);
});
test('only a verified idle warm reserve can replace an active sampler',()=>{
  const ready={id:'pilot20',connected:true,verified:true,nextAllowedAt:0,phase:'standby',checks:0};
  const rows=[ready,{...ready,id:'pilot21',connected:false},{...ready,id:'pilot22',verified:false},{...ready,id:'pilot23',nextAllowedAt:2000},{...ready,id:'pilot24',rotationPending:true},{...ready,id:'mac'}];
  assert.deepEqual(chooseWarmReserves(rows,{now:1000}).map(n=>n.id),['pilot20']);
  assert.equal(chooseWarmReserves(rows,{now:1000,inFlight:['pilot20']}).length,0);
});
test('failed node returns at the queue tail without shortening Apple Retry-After, including after server replacement',()=>{
  const old={id:'pilot2',connected:true,verified:true,nextAllowedAt:900000,checks:0};
  const retired=queueRetiredNode(old,{httpStatus:541,nextAllowedAt:1200000},{now:1000,sequence:1});
  assert.equal(retired.nextAllowedAt,1200000);assert.equal(retired.rotationPending,true);
  const recovered={...retired,rotationPending:false,verified:true,phase:'standby'};
  const idle={...recovered,id:'pilot3',reserveSequence:0,checks:10,nextAllowedAt:0};
  assert.deepEqual(chooseWarmReserves([recovered,idle],{now:1300000,limit:2}).map(n=>n.id),['pilot3','pilot2']);
  assert.deepEqual(chooseWarmReserves([recovered],{now:1199999}),[]);
  assert.equal(queueRetiredNode({...old,id:'pilot1'},{httpStatus:541},{now:1000,sequence:2}).rotationPending,false);
});
