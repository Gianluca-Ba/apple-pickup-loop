import vm from 'node:vm';
import { abortStaleKeeper } from './keeper-recovery.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { parseCatalogIndex, parseConfigurations, AppleCatalog } from './catalog.mjs';
import { parsePickup, validateSelection, validatePickupContact, pickupRequest, INTERVAL } from './shared.mjs';
import { PurchaseController, paymentDecision } from './controller.mjs';
import { AppStorage } from './storage.mjs';
import { PickupWorker } from './worker.mjs';
import { WorkerJobs } from './worker-server.mjs';
import { LinuxFleet, createLinuxAdapter } from './fleet.mjs';
import { createLinuxVpnPool } from './vpn-pool.mjs';
import { createApplication, createHTTPServer } from './server.mjs';
import { createLinuxVpnControl, runLinuxGuestCommand } from './linux-control.mjs';
import { nativeRequest, SafariSession } from './safari.mjs';
import { statisticalProjection, collectPreviousStatistics } from './migration.mjs';
import { desktopNotification } from './notifications.mjs';
import { choosePickupSchedule, nearestPickupSlot } from './pickup-time.mjs';

test('read-only native payment observation survives tab loss without allowing a binding refresh',async()=>{
  const calls=[],s=new SafariSession({bindingPath:null,invoke:async r=>{calls.push(r);if(r.operation==='payment-status'&&r.observeOnly===true)return{known:true,active:true,kind:'apple-pay'};throw Error('SAFARI_TAB_CHANGED');}});s.binding={nonce:'fixture'};
  assert.equal((await s.paymentStatus()).kind,'apple-pay');await assert.rejects(s.bind(),/PAYMENT_ACTIVE/);
  assert.ok(calls.every(r=>r.operation==='payment-status'));
  assert.equal(calls.filter(r=>r.observeOnly!==true).length,1);
  assert.equal(calls.filter(r=>r.observeOnly===true).length,2);
});

test('expected Safari navigation reconciles one refused ownership read without replaying its action',async()=>{
  let clock=0,reads=0,actions=0;const s=new SafariSession({bindingPath:null,now:()=>clock,sleep:async ms=>{clock+=ms;}});
  s.action=async()=>{actions++;s.navigationUntil=30000;return{requested:true};};
  s.inspect=async()=>{if(++reads===1)throw Error('SAFARI_FOREIGN_OWNER');return{phase:'contact',ready:true,pending:false};};
  const p=await s.transition('pickup-continue',{},['contact']);assert.equal(p.phase,'contact');assert.equal(actions,1);assert.equal(reads,2);assert.equal(clock,100);
});
for(const expected of [true,false])test('persistent or unexpected Safari ownership loss remains blocked: '+expected,async()=>{
  let clock=0,reads=0;const s=new SafariSession({bindingPath:null,now:()=>clock,sleep:async ms=>{clock+=ms;}});s.navigationUntil=expected?30000:0;s.inspect=async()=>{reads++;throw Error('SAFARI_FOREIGN_OWNER');};
  await assert.rejects(s.waitFor(['contact']),/SAFARI_FOREIGN_OWNER/);assert.equal(reads,expected?3:1);assert.equal(clock,expected?200:0);
});

for (const latency of [0, 90, 150]) test('calendar polling includes a ' + latency + ' ms Safari read in its cadence', async () => {
  const began = Date.UTC(2026, 10, 8, 3), starts = [], sleeps = [];
  let clock = began;
  const snapshot = { ready: true, selectedDateId: 'date8', selectedValue: '8-13:00-13:15', dates: [{ id: 'date8', label: 'November8', disabled: false }], slots: [{ value: '8-13:00-13:15', disabled: false }] };
  const chosen = await choosePickupSchedule(async p => {
    assert.equal(p.action, 'read', 'the already selected valid slot requires no mutation');
    starts.push(clock - began); clock += latency;
    return starts.length === 1 ? { ready: false, reason: 'store-response-pending' } : snapshot;
  }, { checkoutAt: began, now: () => clock, sleep: async ms => { sleeps.push(ms); clock += ms; } });
  assert.equal(chosen.value, snapshot.selectedValue);
  assert.deepEqual(starts, [0, Math.max(100, latency)]);
  assert.deepEqual(sleeps, latency < 100 ? [100 - latency] : []);
  assert.equal(clock - began, Math.max(100, latency) + latency);
});

test('calendar polling preserves the deadline with slow, serial read-only observations', async () => {
  const began = Date.UTC(2026, 10, 8, 3); let clock = began, reads = 0, sleeps = 0;
  await assert.rejects(choosePickupSchedule(async p => {
    assert.equal(p.action, 'read'); reads++; clock += 150;
    return { ready: false, reason: 'store-response-pending' };
  }, { checkoutAt: began, now: () => clock, sleep: async () => { sleeps++; } }), /PICKUP_CALENDAR_TIMEOUT/);
  assert.equal(sleeps, 0); assert.equal(reads, 134); assert.equal(clock - began, 20100);
});

test('calendar choice matches an independent timestamp oracle over 2000 month, year, midnight and withdrawal cases', () => {
  let seed=803;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  const bases=[Date.UTC(2026,10,8,14,55),Date.UTC(2026,11,31,14,55),Date.UTC(2028,1,28,14,55),Date.UTC(2026,3,30,14,55)];
  for(let trial=0;trial<2000;trial++){
    const began=bases[trial%bases.length]+Math.floor(random()*86400000),now=began+Math.floor(random()*3600000),target=began+3600000,days=[],oracle=[];
    const local=new Date(began+32400000),midnight=Date.UTC(local.getUTCFullYear(),local.getUTCMonth(),local.getUTCDate())-32400000;
    for(let d=0;d<3;d++){
      const date=new Date(midnight+d*86400000+32400000),disabled=random()<0.15,day={id:'d'+d,label:(date.getUTCMonth()+1)+'月'+date.getUTCDate()+'日',disabled,slots:[]};
      for(let n=0;n<12;n++){const minute=600+n*60,value=date.getUTCDate()+'-'+String(Math.floor(minute/60)).padStart(2,'0')+':00-'+String(Math.floor(minute/60)).padStart(2,'0')+':15',off=random()<0.3,startsAt=midnight+d*86400000+minute*60000;day.slots.push({value,disabled:off});if(!disabled&&!off&&startsAt>now)oracle.push({value,startsAt,dateId:day.id});}
      days.push(day);
    }
    oracle.sort((a,b)=>Math.abs(a.startsAt-target)-Math.abs(b.startsAt-target)||b.startsAt-a.startsAt);
    if(!oracle.length)assert.throws(()=>nearestPickupSlot(days,began,now),/No future/);
    else{const result=nearestPickupSlot(days,began,now);assert.equal(result.value,oracle[0].value);assert.equal(result.dateId,oracle[0].dateId);assert.equal(result.startsAt,oracle[0].startsAt);}
  }
});

test('calendar planning matches the timestamp oracle across 300 reordered and delayed date panels', async () => {
  let seed=193;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  const bases=[Date.UTC(2026,10,8,13),Date.UTC(2026,11,31,14,58),Date.UTC(2028,1,28,5),Date.UTC(2026,3,30,4)];
  for(let trial=0;trial<300;trial++){
    const began=bases[trial%bases.length],local=new Date(began+32400000),midnight=Date.UTC(local.getUTCFullYear(),local.getUTCMonth(),local.getUTCDate())-32400000,days=[],oracle=[];let clock=began;
    for(let d=0;d<3;d++){
      const date=new Date(midnight+d*86400000+32400000),day={id:'date'+d,label:(date.getUTCMonth()+1)+'月'+date.getUTCDate()+'日',disabled:false,slots:[]};
      for(let hour=10;hour<21;hour++){const value=date.getUTCDate()+'-'+String(hour).padStart(2,'0')+':00-'+String(hour).padStart(2,'0')+':15',disabled=random()<0.35,startsAt=midnight+d*86400000+hour*3600000;day.slots.push({value,disabled});if(!disabled&&startsAt>began)oracle.push({dateId:day.id,value,startsAt});}
      days.push(day);
    }
    if(trial%2)days.reverse();let current=days[Math.floor(random()*days.length)].id,selected='',loading=0,dateClicks=0,slotClicks=0;
    const read=async p=>{if(p.action==='date'){current=p.dateId;selected='';loading=2;dateClicks++;}if(p.action==='slot'){selected=p.value;slotClicks++;}if(p.action==='read'&&loading-->0)return{ready:false,reason:'slot-date-mismatch'};const day=days.find(d=>d.id===current);return{ready:true,selectedDateId:current,selectedValue:selected,dates:days.map(({slots,...d})=>d),slots:day.slots};};
    const result=await choosePickupSchedule(read,{checkoutAt:began,now:()=>clock,sleep:async ms=>{clock+=ms;}});
    oracle.sort((a,b)=>Math.abs(a.startsAt-began-3600000)-Math.abs(b.startsAt-began-3600000)||b.startsAt-a.startsAt);
    assert.equal(result.value,oracle[0].value);assert.equal(result.dateId,oracle[0].dateId);assert.ok(dateClicks<=4);assert.equal(slotClicks,1);assert.ok(clock-began<=800);
  }
});

for (const change of ['disabled','removed','expired','date-disabled']) test('calendar revalidates a slot that becomes '+change+' during selection', async () => {
  const began=Date.UTC(2026,10,8,3),first='8-13:00-13:15',second='8-13:15-13:30';let clock=began,selected='',changed=false;const clicks=[];
  const snapshot=()=>({ready:true,selectedDateId:'date8',selectedValue:selected,dates:[{id:'date8',label:'November8',disabled:changed&&change==='date-disabled'}],slots:[...(changed&&change==='removed'?[]:[{value:first,label:'13:00',disabled:changed&&change==='disabled'}]),{value:second,label:'13:15',disabled:false}]});
  const read=async p=>{if(p.action==='slot'){clicks.push(p.value);selected=p.value;if(!changed){changed=true;if(change==='expired')clock=began+3600000;}}return snapshot();};
  if(change==='date-disabled')await assert.rejects(choosePickupSchedule(read,{checkoutAt:began,now:()=>clock,sleep:async()=>{}}),/STOCK_FAILED/);
  else {const result=await choosePickupSchedule(read,{checkoutAt:began,now:()=>clock,sleep:async()=>{}});assert.equal(result.value,second);assert.deepEqual(clicks,[first,second]);}
});

test('a slot withdrawn immediately before its mutation is replanned from fresh options', async () => {
  const began=Date.UTC(2026,10,8,3),first='8-13:00-13:15',second='8-13:15-13:30';let withdrawn=false,selected='';const clicks=[];
  const read=async p=>{if(p.action==='slot'){if(!withdrawn){withdrawn=true;throw Error('PICKUP_SLOT_CHANGED');}clicks.push(p.value);selected=p.value;}return{ready:true,selectedDateId:'date8',selectedValue:selected,dates:[{id:'date8',label:'November8',disabled:false}],slots:(withdrawn?[second]:[first,second]).map(value=>({value,disabled:false}))};};
  const result=await choosePickupSchedule(read,{checkoutAt:began,now:()=>began,sleep:async()=>{}});assert.equal(result.value,second);assert.deepEqual(clicks,[second]);
});

test('no future calendar windows is ordinary stock loss rather than an indefinite operator stop', async () => {
  const began=Date.UTC(2026,10,8,4),read=async()=>({ready:true,selectedDateId:'date8',selectedValue:'',dates:[{id:'date8',label:'November8',disabled:false}],slots:[{value:'8-13:00-13:15',disabled:false}]});
  await assert.rejects(choosePickupSchedule(read,{checkoutAt:began,now:()=>began,sleep:async()=>{}}),/^Error: STOCK_FAILED$/);
});

test('fulfillment waits for a mounted mode after history navigation and uses no unnecessary mode click', async () => {
  let clock=0,reads=0,clicks=0;const s=new SafariSession({bindingPath:null,now:()=>clock,sleep:async ms=>{clock+=ms;}});
  s.inspect=async()=>({phase:'pickup',ready:true,pending:false,fulfillmentMode:++reads<3?null:'pickup'});s.action=async()=>{clicks++;throw Error('EARLY_CLICK');};
  await s.ensureFulfillment('pickup');assert.equal(clicks,0);assert.equal(clock,200);
});

test('a bag with a late total waits but a fully rendered wrong total is rejected without checkout', async () => {
  let clock=0,reads=0;const s=new SafariSession({bindingPath:null,now:()=>clock,sleep:async ms=>{clock+=ms;}});
  s.evaluate=async()=>++reads<3?{rendered:false,valid:false}:{rendered:true,valid:true};assert.equal((await s.waitBagTotal(selection)).valid,true);assert.equal(clock,200);
  s.evaluate=async()=>({rendered:true,valid:false});assert.equal((await s.waitBagTotal(selection)).valid,false);assert.equal(clock,200);
});

test('calendar rescans are bounded and preserve an unknown mutation outcome without replay', async () => {
  const began=Date.UTC(2026,10,8,3);let changes=0;
  const read=async p=>{if(p.action==='slot'){changes++;throw Error('PICKUP_SLOT_CHANGED');}return{ready:true,selectedDateId:'date8',selectedValue:'',dates:[{id:'date8',label:'November8',disabled:false}],slots:[{value:'8-13:00-13:15',disabled:false}]};};
  await assert.rejects(choosePickupSchedule(read,{checkoutAt:began,now:()=>began,sleep:async()=>{}}),/STOCK_FAILED/);assert.ok(changes<=3);
  await assert.rejects(choosePickupSchedule(async p=>{if(p.action==='slot')throw Error('SAFARI_UNCERTAIN');return read(p);},{checkoutAt:began,now:()=>began,sleep:async()=>{}}),/SAFARI_UNCERTAIN/);
});

test('manual stop during a calendar withdrawal aborts before choosing a replacement', async () => {
  const began=Date.UTC(2026,10,8,3);let stopped=false,changes=0;
  const read=async p=>{if(p.action==='slot'){changes++;stopped=true;throw Error('PICKUP_SLOT_CHANGED');}return{ready:true,selectedDateId:'date8',selectedValue:'',dates:[{id:'date8',label:'November8',disabled:false}],slots:[{value:'8-13:00-13:15',disabled:false},{value:'8-13:15-13:30',disabled:false}]};};
  await assert.rejects(choosePickupSchedule(read,{checkoutAt:began,now:()=>began,sleep:async()=>{},check:()=>{if(stopped)throw Error('STOPPED');}}),/^Error: STOPPED$/);assert.equal(changes,1);
});
const selection = Object.freeze({ sku: 'AAAA1J/A', name: 'Test device 256GB Black', names: ['Test device 256GB Black', 'Test device 256GB ブラック'], currency: 'JPY', priceJPY: 100000, category: 'iphone', productId: 'https://www.apple.com/jp/shop/buy-iphone/test-device', url: 'https://www.apple.com/jp/shop/product/AAAA1J/A', stores: ['R119'] });
const contact = { lastName: 'Fixture', firstName: 'Operator', emailAddress: 'operator@example.invalid', mobilePhone: '08000000000' };
const proof = n => ({ vpn: 'protected', fingerprint: n.toString(16).padStart(64, '0'), completedChecks: n, nextAllowedInMs: 0 });
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r)); };
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'apple-loop-test-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  let clock = 1000000; const now = () => clock, advance = n => clock += n;
  const storage = new AppStorage(dir); storage.settings.selection = structuredClone(selection); storage.settings.pickupContact = structuredClone(contact);
  const safari = { page: { phase: 'review', ready: true, pending: false }, ui: { known: true, active: false }, clicks: 0, bagVisits: 0,
    snapshot: () => ({ bound: true, browser: 'Safari' }), async bind() {}, async inspect() { return this.page; }, async paymentStatus() { return this.ui; }, async prepareBag() { this.page = { phase: 'pickup', ready: true }; }, async prepareCheckout() { this.page = { phase: 'review', ready: true }; return { store: { id: 'R119' } }; }, async pressApplePay(s, store, id, before) { before(); this.clicks++; }, async navigateBag() { this.bagVisits++; this.page = { phase: 'bag', ready: true }; }, async action(action) { if (action === 'restart-success') { this.bagVisits++; this.page = { phase: 'bag', ready: true }; } return {}; }
  };
  const fleet = { enabled: false, stops: 0, snapshot: () => ({}), async start() { this.enabled = true; }, async stop() { this.enabled = false; this.stops++; } };
  const catalog = { updatedAt: now(), async resolve() { return structuredClone(selection); }, snapshot: () => ({}) };
  const notices = []; const c = new PurchaseController({ storage, safari, fleet, catalog, now, notify: n => notices.push(n) });
  return { c, storage, safari, fleet, catalog, notices, advance, now, dir };
}
const metrics = products => `<script id="metrics" type="application/json">${JSON.stringify({ data: { products } })}</script>`;
const bootstrap = products => `<script>window.PRODUCT_SELECTION_BOOTSTRAP={productSelectionData:${JSON.stringify({ products, displayValues: { dimensionColor: { black: { value: 'ブラック' } } } })}};</script>`;
test('a manual stop during the fleet preflight cannot restore the watching state',async t=>{
 const f=fixture(t);let release,entered;const waiting=new Promise(r=>{release=r;}),began=new Promise(r=>{entered=r;});
 f.fleet.start=async()=>{entered();await waiting;};await f.c.activation(true);const tick=f.c.tick();await began;
 await f.c.activation(false);release();await tick;
 assert.equal(f.c.enabled,false);assert.equal(f.c.phase,'stopped');assert.equal(f.fleet.enabled,false);assert.equal(f.safari.clicks,0);
});
test('catalog discovers current families, without nav/footer, foreign links or carrier promotions', () => {
  const html = '<nav><a href="/jp/shop/buy-iphone/obsolete">Old</a></nav><main><a href="https://evil.invalid/jp/shop/buy-iphone/evil">Evil</a><a href="/jp/shop/buy-iphone/future-model">Future iPhone</a><a href="/jp/shop/buy-iphone/carrier-offers">Carrier</a></main>';
  const list = parseCatalogIndex(html, { id: 'iphone' }); assert.deepEqual(list.map(p => p.name), ['Future iPhone']);
});
test('an exhausted CAP wait restores pickup and releases the old signal before restarting search', async t => {
  for(const entry of ['signal','tick']){
    const f=fixture(t);f.c.enabled=true;f.c.phase=entry==='signal'?'watching':'intervention';f.safari.page={phase:'pickup',ready:true,pending:false,fulfillmentMode:'pickup'};f.safari.prepareCheckout=async()=>{throw Error('POSTAL_REFRESH_UNCERTAIN')};
    let restored=0;f.safari.refreshPickup=async check=>{check();restored++;return{maintained:true,mode:'pickup'}};
    if(entry==='signal'){f.c.startCheckout('R119');await settle()}else{f.c.currentStore='R119';await f.c.tick()}
    assert.equal(restored,1);assert.equal(f.c.phase,'watching');assert.equal(f.c.currentStore,null);assert.equal(f.fleet.enabled,true);assert.equal(f.safari.clicks,0);assert.ok(f.storage.statistics.checkoutHistory.some(e=>e.code==='PICKUP_REFRESH_RECOVERED'));
  }
});
test('a session expiring during a previous CAP or stock recovery rebuilds through normal preparation',async t=>{
 for(const phase of ['expired','unavailable'])for(const original of ['POSTAL_REFRESH_UNCERTAIN','STOCK_FAILED']){
  const f=fixture(t);f.c.enabled=true;f.c.phase='intervention';f.c.currentStore='R119';f.c.pendingRecovery=original;f.safari.page={phase,ready:true,pending:false};
  f.safari.refreshPickup=async()=>{throw Error('must not toggle an expired session')};await f.c.tick();
  assert.equal(f.c.phase,'preparing');assert.equal(f.c.currentStore,null);assert.equal(f.c.pendingRecovery,null);assert.equal(f.fleet.enabled,false);assert.equal(f.safari.clicks,0);
  f.advance(5001);await f.c.tick();assert.equal(f.c.phase,'watching');assert.equal(f.fleet.enabled,true);assert.equal(f.safari.clicks,0);
 }
});
test('expiry detected during recovery preserves payment and page-transition guards',async t=>{
 for(const unsafe of ['intent','native-active','native-unknown','pending']){
  const f=fixture(t);f.c.enabled=true;f.c.phase='intervention';f.c.currentStore='R119';f.safari.page={phase:'expired',ready:true,pending:false};
  if(unsafe==='intent')f.storage.setGuard('intent',{id:'fixture-attempt'});if(unsafe==='native-active')f.safari.ui.active=true;if(unsafe==='native-unknown')f.safari.ui.known=false;if(unsafe==='pending')f.safari.page.pending=true;
  await assert.rejects(f.c.recoverCheckout('POSTAL_REFRESH_UNCERTAIN',()=>{}),/EXISTING_CHECKOUT/);assert.equal(f.c.currentStore,'R119');assert.equal(f.fleet.enabled,false);assert.equal(f.safari.clicks,0);
 }
});
test('CAP recovery preserves payment, unknown native status and checkout steps beyond pickup', async t => {
  for(const unsafe of ['intent','waiting','uncertain','completed','current','native-active','native-unknown','pending','contact','observed','dispatched']){
    const f=fixture(t);f.c.enabled=true;f.c.currentStore='R119';f.safari.page={phase:'pickup',ready:true,pending:false,fulfillmentMode:'pickup'};
    if(['intent','waiting','uncertain','completed'].includes(unsafe))f.storage.setGuard(unsafe,{id:'fixture-attempt'});
    if(unsafe==='current')f.c.current={id:'fixture-attempt'};
    if(unsafe==='native-active')f.safari.ui.active=true;if(unsafe==='native-unknown')f.safari.ui.known=false;
    if(unsafe==='pending')f.safari.page.pending=true;if(unsafe==='contact')f.safari.page.phase='contact';
    if(unsafe==='observed')f.safari.page.paymentObserved=true;if(unsafe==='dispatched')f.safari.page.paymentDispatched=true;
    f.safari.refreshPickup=async()=>{throw Error('MUST_NOT_CHANGE_PAGE')};
    await assert.rejects(f.c.resumeAfterPostalFailure(()=>{}),/EXISTING_CHECKOUT/);assert.equal(f.c.currentStore,'R119');assert.equal(f.fleet.enabled,false);
  }
});
test('catalog resolves a previously unknown SKU/configuration from Apple data and excludes carrier variants', () => {
  const product = { id: selection.productId, url: selection.productId, category: 'iphone', name: 'Test device' };
  const html = metrics([{ partNumber: selection.sku, name: selection.name, price: { fullPrice: 100000 } }]) + bootstrap([{ partNumber: selection.sku, isCarrierDevice: true, seoUrlToken: 'carrier' }, { partNumber: selection.sku, isCarrierDevice: false, seoUrlToken: 'unlocked', dimensionColor: 'black', dimensionCapacity: '256gb' }]);
  const [v] = parseConfigurations(html, product); assert.equal(v.sku, selection.sku); assert.equal(v.priceJPY, 100000); assert.ok(v.url.endsWith('/unlocked')); assert.equal(v.dimensions.dimensionColor, 'ブラック');
});
test('catalog refuses an unverified price instead of inventing a configuration', async () => {
  const c = new AppleCatalog({ fetchPage: async () => bootstrap([{ partNumber: selection.sku }]) }); c.products = [{ id: selection.productId, url: selection.productId, category: 'iphone', name: 'Test' }]; await assert.rejects(c.resolve(selection.productId, selection.sku), /PRICE_UNVERIFIED/);
});
test('catalog rejects non-Apple/unknown product requests', async () => { const c = new AppleCatalog(); await assert.rejects(c.configurations('https://evil.invalid'), /NOT_IN_CATALOG/); });
test('a carrier-only SKU cannot reenter the catalog through the price fallback', () => {
  const html = metrics([{ partNumber: selection.sku, name: selection.name, price: { fullPrice: 100000 } }]) + bootstrap([{ partNumber: selection.sku, isCarrierDevice: true }]);
  assert.deepEqual(parseConfigurations(html, { id: selection.productId, url: selection.productId, category: 'iphone', name: 'Test' }), []);
});
test('pickup parser uses selected dynamic SKU and requires matching part plus explicit availability', () => {
  const body = { head: { status: '200' }, body: { stores: [{ storeNumber: 'R119', partsAvailability: { [selection.sku]: { partNumber: selection.sku, pickupDisplay: 'available', storePickEligible: true, messageTypes: { regular: { storeSelectionEnabled: true, storePickupProductTitle: selection.name } } } } }] } };
  assert.equal(parsePickup(body, selection, 100).stores[0].state, 'available'); body.body.stores[0].partsAvailability[selection.sku].partNumber = 'OTHERJ/A'; assert.throws(() => parsePickup(body, selection), /WRONG_PRODUCT/);
});
test('pickup never treats challenge/non-JSON or stale cache as stock', async () => {
  for (const response of [new Response('challenge', { headers: { 'content-type': 'text/html' } }), new Response('{}', { headers: { 'content-type': 'application/json', age: '10' } })]) await assert.rejects(pickupRequest(selection, async () => response));
});
test('HTTP 541 and Retry-After preserve the longer server pause', async () => {
  await assert.rejects(pickupRequest(selection, async () => new Response('', { status: 541, headers: { 'retry-after': '900' } }), () => 1000), e => e.httpStatus === 541 && e.nextAllowedAt === 901000);
});
test('selection rejects shipping, foreign currency, unknown Store, duplicate Store and malformed SKU', () => {
  for (const patch of [{ currency: 'USD' }, { sku: '../bad' }, { stores: ['R000'] }, { stores: ['R119','R119'] }, { priceJPY: null }]) assert.throws(() => validateSelection({ ...selection, ...patch }));
});
for (const [name, patch, expected] of [
  ['waits all 30 seconds', { elapsed: 29999 }, 'wait'],
  ['preserves open native Apple Pay sheet', { ui: { known: true, active: true } }, 'wait'],
  ['preserves merchant processing after sheet closes', { page: { phase: 'review', ready: true, pending: true } }, 'wait'],
  ['never infers closed payment without Accessibility proof', { ui: { known: false, active: false } }, 'wait'],
  ['requires stable observations before retry', { stable: false }, 'uncertain'],
  ['keeps an unclassified cancellation blocked', { page: {phase:'bag', ready:true, paymentCancelled:true} }, 'uncertain'],
  ['recovers retained cancellation after a redirect', { page: {phase:'bag', ready:true, paymentCancelledBeforeAuthorization:true} }, 'retry'],
  ['retries confirmed cancellation', {}, 'retry'],
  ['retries terminal merchant failure', { page: { phase: 'billing', ready: true, terminalFailure: true } }, 'retry'],
  ['keeps plain final review uncertain', { page: { phase: 'review', ready: true } }, 'uncertain'],
  ['recognizes a verified order without another click', { page: { phase: 'success', confirmation: true } }, 'success'],
]) test('payment decision ' + name, () => assert.equal(paymentDecision({ page: { phase: 'review', ready: true, paymentCancelledBeforeAuthorization: true }, ui: { known: true, active: false }, elapsed: 30000, stable: true, ...patch }), expected));
test('one activation starts keeper/search; no native payment click before a verified stock signal', async t => { const f = fixture(t); await f.c.activation(true); await f.c.tick(); assert.equal(f.c.phase, 'watching'); assert.equal(f.fleet.enabled, true); assert.equal(f.safari.clicks, 0); });
for(const manualStop of [false,true])test('activation waits for CAP and Store preparation before stock dispatch; manual stop='+manualStop,async t=>{
 const f=fixture(t),events=[];let complete;const pending=new Promise(resolve=>{complete=resolve;});
 f.safari.preparePickup=async()=>{events.push('postal-start');await pending;events.push('postal-ready');};
 f.fleet.start=async()=>{events.push('stock-start');f.fleet.enabled=true;};
 await f.c.activation(true);const task=f.c.tick();await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(events,['postal-start']);assert.equal(f.fleet.enabled,false);
 if(manualStop)await f.c.activation(false);complete();await task;
 assert.deepEqual(events,manualStop?['postal-start','postal-ready']:['postal-start','postal-ready','stock-start']);
 assert.equal(f.fleet.enabled,!manualStop);assert.equal(f.safari.clicks,0);
});
test('an unfinished CAP preparation cannot report the pickup page ready or start stock dispatch',async t=>{
 const f=fixture(t);f.safari.preparePickup=async()=>({waiting:true});await f.c.activation(true);await f.c.tick();
 assert.equal(f.c.phase,'preparing');assert.equal(f.fleet.enabled,false);assert.equal(f.safari.clicks,0);
});
test('a verified no-stock pickup preparation keeps search active without claiming pickup readiness',async t=>{
 const f=fixture(t);f.safari.preparePickup=async()=>({prepared:false,pickupUnavailable:true});await f.c.activation(true);await f.c.tick();
 assert.equal(f.c.phase,'watching');assert.equal(f.fleet.enabled,true);assert.match(f.c.message,/non offre ancora il ritiro/);assert.equal(f.safari.clicks,0);
});
test('reactivation discards an interrupted pre-payment availability signal and awaits a fresh one', async t => {
  const f=fixture(t);f.c.enabled=true;f.c.phase='checkout';f.c.currentStore='R119';f.c.checkoutStartedAt=f.now();f.c.pendingAvailability={storeId:'R119',observedAt:f.now()};
  await f.c.activation(false);f.advance(600000);await f.c.activation(true);await f.c.tick();
  assert.equal(f.c.currentStore,null);assert.equal(f.c.pendingAvailability,null);assert.equal(f.c.phase,'watching');assert.equal(f.safari.clicks,0);assert.equal(f.storage.statistics.checkoutAttempts,0);
});
test('stock arriving during the final pickup read prevents the keeper delivery click', async () => {
  let pending=false,reads=0;const actions=[],s=new SafariSession({bindingPath:null});
  s.inspect=async()=>{reads++;pending=true;return{phase:'pickup',fulfillmentMode:'pickup',pending:false,ready:true,fulfillmentResponseVerified:true};};
  s.action=async action=>{actions.push(action);return{requested:true};};
  const result=await s.refreshPickup(()=>{},()=>pending);
  assert.equal(result.yielded,true);assert.ok(reads>0);assert.deepEqual(actions,[]);assert.equal(s.pendingMode,null);
});
test('the keeper yields to a fresh availability signal and restores pickup when a cycle has already started', async () => {
  let mode='pickup',pending=true,clock=1000000;const actions=[],pauses=[];const s=new SafariSession({bindingPath:null,now:()=>clock,sleep:async ms=>{clock+=ms;pauses.push(ms)}});s.inspect=async()=>({phase:'pickup',fulfillmentMode:mode,pending:false,ready:true});s.renewSession=async()=>({maintained:true});s.nextKeepaliveAt=0;s.action=async(a,p)=>{actions.push([a,p?.mode]);if(a==='fulfillment-mode'){mode=p.mode;if(mode==='delivery')pending=true}return{maintained:true}};
  assert.equal((await s.maintain(()=>{},()=>pending)).yielded,true);assert.equal(actions.length,0);
  pending=false;await s.maintain(()=>{},()=>pending);assert.equal(mode,'pickup');assert.ok(!pauses.includes(750));assert.ok(pauses.includes(250));assert.deepEqual(actions.filter(([a])=>a==='fulfillment-mode').map(([,m])=>m),['delivery','pickup']);
});
test('keeper mode cycles follow the observed five-minute Apple interval while expiry stays checked every tick', async () => {
  let clock=1000000,mode='pickup';const began=clock,actions=[];
  const s=new SafariSession({bindingPath:null,now:()=>clock,sleep:async ms=>{clock+=ms;}});
  s.inspect=async()=>({phase:'pickup',fulfillmentMode:mode,pending:false,ready:true});s.renewSession=async()=>({maintained:true});
  s.action=async(action,p)=>{if(action==='fulfillment-mode'){actions.push(p.mode);mode=p.mode;}return{maintained:true};};
  await s.maintain();clock=began+240000;await s.maintain();assert.deepEqual(actions,[]);
  clock=began+300000;await s.maintain();assert.deepEqual(actions,['delivery','pickup']);assert.equal(mode,'pickup');
  s.renewSession=async()=>({expired:true});clock+=1000;assert.equal((await s.maintain()).expired,true);assert.equal(actions.length,2);
});
test('an already selected optimal pickup slot is verified without rewriting the date or dispatching another change', async () => {
  const {choosePickupSchedule}=await import('./pickup-time.mjs');const calls=[];const snapshot={ready:true,selectedDateId:'date8',selectedValue:'8-17:30-17:45',dates:[{id:'date8',label:'November8',disabled:false}],slots:[{value:'8-17:30-17:45',label:'17:30',disabled:false}]};const now=Date.UTC(2026,10,8,7,30);
  const chosen=await choosePickupSchedule(async p=>{calls.push(p.action);return snapshot},{checkoutAt:now,now:()=>now,sleep:async()=>{}});assert.equal(chosen.value,snapshot.selectedValue);assert.deepEqual(calls,['read']);
});
test('a page-not-found screen before any payment restarts preparation, while a payment intent stays under observation', async t => {
  const f=fixture(t);f.c.enabled=true;f.c.phase='watching';f.safari.page={phase:'unavailable',ready:true,pending:false};await f.c.tick();assert.equal(f.c.phase,'preparing');assert.equal(f.safari.clicks,0);f.advance(6000);await f.c.tick();assert.equal(f.c.phase,'watching');
  const g=fixture(t);g.c.enabled=true;g.c.current={id:'fixture-attempt',pressedAt:g.now()-60000,storeId:'R119'};g.storage.setGuard('intent',g.c.current);g.safari.page={phase:'unavailable',ready:true,pending:false};await g.c.tick();assert.equal(g.c.phase,'payment-observation');assert.equal(g.storage.guard.phase,'uncertain');assert.equal(g.safari.bagVisits,0);
});
test('durable payment intent is written before click and transport loss is observed without replay', async t => {
  const f = fixture(t); f.c.enabled = true; f.c.phase = 'watching'; f.safari.pressApplePay = async (s, store, id, before) => { before(); assert.equal(JSON.parse(readFileSync(f.dir + '/payment-guard.json')).phase, 'intent'); f.safari.clicks++; throw Error('lost reply'); };
  f.c.signal({ stores: [{ id: 'R119', state: 'available' }] }); await settle(); assert.equal(f.safari.clicks, 1); assert.equal(f.storage.guard.phase, 'uncertain');
  for (let i = 0; i < 5; i++) { f.advance(6000); await f.c.tick(); } assert.equal(f.safari.clicks, 1); assert.equal(f.safari.bagVisits, 0);
});
test('cancellation cannot reset bag before 30 seconds, then requires two quiet observations', async t => {
  const f = fixture(t); f.c.enabled = true; await f.c.checkout('R119', () => {}); f.safari.page.paymentCancelledBeforeAuthorization = true;
  await f.c.observePayment(); f.advance(29999); await f.c.observePayment(); assert.equal(f.safari.bagVisits, 0); f.advance(1); await f.c.observePayment(); assert.equal(f.safari.bagVisits, 1); assert.equal(f.c.phase, 'preparing');
});
test('manual deactivation during Apple Pay preserves it and forbids retry', async t => {
  const f = fixture(t); f.c.enabled = true; await f.c.checkout('R119', () => {}); f.safari.ui.active = true; await f.c.activation(false); f.advance(60000); await f.c.observePayment(); assert.equal(f.safari.bagVisits, 0); assert.equal(f.safari.clicks, 1); assert.equal(f.c.enabled, false);
  f.safari.ui.active = false; f.safari.page.paymentCancelledBeforeAuthorization = true; await f.c.observePayment(); f.advance(3000); await f.c.observePayment(); assert.equal(f.safari.bagVisits, 0); assert.equal(f.c.phase, 'stopped');
});
test('a pending payment is observed and announced even when its tab can no longer bind',async t=>{
  const f=fixture(t);f.c.enabled=true;await f.c.checkout('R119',()=>{});let binds=0;f.safari.bind=async()=>{binds++;throw Error('SAFARI_TAB_CHANGED');};f.safari.ui={known:true,active:true,kind:'apple-pay'};
  f.advance(5000);await f.c.tick();assert.equal(binds,0);assert.equal(f.safari.clicks,1);assert.equal(f.safari.bagVisits,0);assert.equal(f.storage.guard.phase,'waiting');assert.equal(f.notices.filter(n=>n.code==='PAYMENT_AUTHORIZE').length,1);
});
test('verified success is notified once and stops the single-purchase cycle without returning to bag', async t => {
  const f = fixture(t); f.c.enabled = true; await f.c.checkout('R119', () => {}); f.safari.page = { phase: 'success', confirmation: true, ready: true };
  await f.c.observePayment(); assert.equal(f.storage.statistics.successes, 1); assert.equal(f.notices.filter(n => n.type === 'success').length, 1); assert.equal(f.safari.bagVisits, 0); assert.equal(f.c.phase, 'success'); assert.equal(f.c.enabled, false);assert.equal(f.storage.guard.phase,'completed');assert.equal(f.c.current,null);
  await assert.rejects(f.c.activation(true),/ORDER_ALREADY_CONFIRMED/);
  const restored=new PurchaseController({storage:new AppStorage(f.dir),safari:f.safari,fleet:f.fleet,catalog:f.catalog,now:f.now});await restored.tick();assert.equal(restored.phase,'success');assert.equal(restored.enabled,false);assert.equal(f.safari.clicks,1);await assert.rejects(restored.activation(true),/ORDER_ALREADY_CONFIRMED/);
});
test('a success saved immediately before a crash restores the completed guard without another order',async t=>{
  const f=fixture(t);f.c.enabled=true;await f.c.checkout('R119',()=>{});const id=f.c.current.id;
  f.storage.statistics.successes=1;f.storage.statistics.history.push({attempt:id,at:f.now(),sku:selection.sku,storeId:'R119',result:'success'});f.storage.saveStatistics();f.safari.page={phase:'bag',ready:true,pending:false};
  const restored=new PurchaseController({storage:new AppStorage(f.dir),safari:f.safari,fleet:f.fleet,catalog:f.catalog,now:f.now});await restored.tick();assert.equal(restored.phase,'success');assert.equal(restored.enabled,false);assert.equal(restored.storage.guard.phase,'completed');assert.equal(f.safari.clicks,1);assert.equal(f.safari.bagVisits,0);
});
test('persisted uncertain payment survives restart and no search/checkout is rearmed', async t => {
  const f = fixture(t); f.storage.setGuard('uncertain', { id: randomUUID(), pressedAt: f.now() - 60000, storeId: 'R119' });
  const c = new PurchaseController({ storage: new AppStorage(f.dir), safari: f.safari, fleet: f.fleet, catalog: f.catalog, now: f.now }); await c.tick(); assert.equal(c.enabled, false); assert.equal(f.safari.clicks, 0); assert.equal(f.fleet.enabled, false);
});
test('notifications are deduplicated while intervention is unchanged', async t => { const f = fixture(t); f.c.notice('action', 'LOGIN', 'Login required'); f.c.notice('action', 'LOGIN', 'Login required'); assert.equal(f.notices.length, 1); });
test('configuration is locked during an active or uncertain payment', async t => { const f = fixture(t); f.c.enabled = true; await assert.rejects(f.c.select(selection), /LOCKED/); f.c.enabled = false; f.storage.setGuard('uncertain', { id: randomUUID() }); await assert.rejects(f.c.select(selection), /LOCKED/); });
test('worker honors inherited ledger and 65 seconds from response, including browser/network failures', async t => {
  const f = fixture(t); const path = f.dir + '/ledger.json'; writeFileSync(path, JSON.stringify({ successes: 18, attempts: 20, nextAllowedAt: f.now() + 50000 })); let networkCalls = 0;
  const worker = new PickupWorker({ ledgerPath: path, now: f.now, network: async () => { networkCalls++; return proof(1); }, browserFactory: async () => { throw Error('browser unavailable'); } });
  await assert.rejects(worker.sample(selection, proof(1).fingerprint), /NODE_WAIT/); assert.equal(networkCalls, 0); f.advance(50001); await assert.rejects(worker.sample(selection, proof(1).fingerprint)); const saved = JSON.parse(readFileSync(path)); assert.equal(saved.successes, 18); assert.equal(saved.nextAllowedAt, f.now() + 65000); assert.equal(saved.attempts, 21);
});
test('guest job id reconciles lost replies, never resamples, and stores no network fingerprint', async t => {
  const f = fixture(t); let calls = 0; const jobs = new WorkerJobs({ async sample() { calls++; return { sku: selection.sku, observedAt: f.now(), stores: [] }; }, async network() { return proof(7); } }, f.dir + '/jobs.json', f.now);
  const id = randomUUID(); jobs.start(id, 'sample', { selection, fingerprint: proof(1).fingerprint }); jobs.start(id, 'sample', { selection, fingerprint: proof(1).fingerprint }); await settle(); assert.equal(calls, 1); assert.equal(jobs.result(id).ok, true);
  const network = randomUUID(); jobs.start(network, 'network'); await settle(); assert.equal(jobs.result(network).result.fingerprint, proof(7).fingerprint); assert.ok(!readFileSync(f.dir + '/jobs.json', 'utf8').includes('fingerprint'));
});
test('an orphaned guest request is uncertain after restart rather than resent', async t => { const f = fixture(t), id = randomUUID(), path = f.dir + '/jobs.json'; writeFileSync(path, JSON.stringify([{ id, identity: JSON.stringify({ operation: 'sample', sku: selection.sku, stores: selection.stores }), state: 'pending' }])); let calls = 0; const jobs = new WorkerJobs({ sample() { calls++; } }, path); assert.equal(jobs.start(id, 'sample', { selection, fingerprint: proof(1).fingerprint }).code, 'sample-uncertain'); assert.equal(calls, 0); });
test('offline mode categorically disables native Safari operations', async () => { assert.equal(process.env.CHECKOUT_DISABLE_NATIVE, '1'); await assert.rejects(nativeRequest({ operation: 'press-apple-pay' }), /NATIVE_DISABLED/); });
function fleetFixture(options = {}) {
  let clock = 1000000; const inventory = Object.fromEntries(Array.from({ length: 19 }, (_, i) => [i + 1, { connected: i < 6, pinned: i < 6 }])); const events = [], samples = [], adapters = Array.from({ length: 20 }, (_, i) => ({ async network() { return i === 19 ? { ...proof(99), vpn: 'host' } : proof(i + 1); }, async sample(s) { samples.push(i); return { sku: s.sku, observedAt: clock, stores: [] }; }, async close() { events.push(['close', i + 1]); } }));
  const control = async (op, worker) => { events.push([op, worker]); if (op === 'connect') inventory[worker] = { connected: true, pinned: true }; if (op === 'disconnect') inventory[worker] = { connected: false }; return op === 'inventory' ? structuredClone(inventory) : inventory[worker]; };
  const f = new LinuxFleet({ ...options, adapters, control, canChange: () => true, now: () => clock }); return { f, inventory, events, adapters, samples, advance: n => clock += n };
}
test('six simultaneous positions use eight verified routes while Mac remains the last reserve', async () => {
  const { f, events, samples, advance } = fleetFixture(); await f.start(selection); await f.maintenance; await settle();
  for (let i = 0; i < 8; i++) { advance(10834); f.tick(); await settle(); }
  assert.equal(f.snapshot().verifiedTunnels, 8); assert.ok(f.active.length <= 6); assert.equal(events.filter(e => e[0] === 'connect').length, 2); assert.ok(!samples.includes(19)); await f.stop();
});
test('unknown tunnel inventory blocks new connections', async () => {
  const { f, inventory, events } = fleetFixture(); inventory[2] = { connected: null }; await f.start(selection); await f.maintenance; assert.ok(!events.some(e => e[0] === 'connect')); await f.stop();
});
test('a confirmed failed reserve connection skips network proof and immediately permits the next eligible reserve', async () => {
  const agents=[1,2,3].map(id=>({id:'pilot'+id,checks:0,workerSuccesses:id}));const inventory={1:{connected:true,pinned:true},2:{connected:false},3:{connected:false}};const events=[];
  const adapters=agents.map((_,i)=>({network:async()=>{events.push(['proof',i+1]);return proof(i+1)}}));
  const control=async(op,worker)=>{events.push([op,worker]);if(op==='connect'&&worker===3)inventory[3]={connected:true,pinned:true};if(op==='disconnect')inventory[worker]={connected:false};return op==='inventory'?structuredClone(inventory):inventory[worker]};
  const pool=createLinuxVpnPool({agents,adapters,control,canChange:()=>true,vpnLimit:3});const options={isEligible:()=>true,isStopping:()=>false};
  const failed=await pool.fill(options);assert.equal(failed.status,'connect-unverified');assert.equal(failed.index,1);assert.ok(!events.some(e=>e[0]==='proof'&&e[1]===2));
  const next=await pool.fill(options);assert.equal(next.status,'ready');assert.equal(next.index,2);assert.deepEqual(events.filter(e=>e[0]==='proof'),[['proof',3]]);
});
test('native pilot1 is never disconnected on transport failure', async () => {
  const { f, adapters, events, advance } = fleetFixture(); adapters[0].sample = async () => { throw Error('transport'); }; await f.start(selection); await f.maintenance; advance(10834); f.tick(); await settle(); assert.ok(!events.some(e => e[0] === 'disconnect' && e[1] === 1)); await f.stop();
});
test('guest transport polls a detached job while slow VPN work does not hold its execution slot', async () => {
  const starts = [], ids = new Set(); let networkPolls = 0;
  const run = async (bin, args) => { const tokens = [...args.at(-1).matchAll(/'([^']*)'/g)].map(m => m[1]); const payload = JSON.parse(Buffer.from(tokens.at(-1), 'base64')); if (tokens.includes('/start')) { ids.add(payload.id); starts.push('start'); return { stdout: '{"ok":true,"pending":true}' }; } networkPolls++; return { stdout: JSON.stringify({ ok: true, result: proof(1) }) }; };
  const a = createLinuxAdapter(1, { run, sleep: async () => {} }); assert.equal((await a.network()).vpn, 'protected'); assert.equal(ids.size, 1); assert.equal(networkPolls, 1);
});
test('HTTP server rejects cross-origin mutations, legacy purchase routes and unexpected secret fields', async t => {
  const f = fixture(t), app = { controller: f.c, catalog: { ...f.catalog, configurations: async () => [] } };
  const server = createHTTPServer(app, { port: 0 }); server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(r => server.close(r))); const base = 'http://127.0.0.1:' + server.address().port;
  for (const path of ['/api/authorize','/api/arm','/api/order','/api/security-code']) assert.equal((await fetch(base + path, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: '{}' })).status, 404);
  assert.equal((await fetch(base + '/api/activation', { method: 'POST', headers: { Origin: 'https://evil.invalid', 'Content-Type': 'application/json' }, body: '{"enabled":true}' })).status, 403);
  assert.equal((await fetch(base + '/api/activation', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: '{"enabled":true,"card":"blocked"}' })).status, 400);
});
test('historical migration keeps statistics while removing personal values and private URLs', t => {
  const f = fixture(t); const input = { checks: 20, attempts: 23, durationMs: 450, email: 'private@example.invalid', phone: '00000000000', cvc: 123, cardNumber: 'fixture-card', address: { city: 'fixture-city' }, url: 'https://secure.example.invalid/private', nodes: [{ id: 'pilot2', workerSuccesses: 22, fingerprint: 'private-fingerprint', phase: 'ready' }] };
  const result = statisticalProjection(input), encoded = JSON.stringify(result); assert.equal(result.checks, 20); assert.equal(result.durationMs, 450); assert.equal(result.nodes[0].workerSuccesses, 22); assert.ok(!/private|fixture|00000000000|123/.test(encoded));
});
test('historical aggregate preserves inherited Mac and Linux counts without duplicating a worker', t => {
  const f = fixture(t); writeFileSync(f.dir + '/fleet-mac-ledger.json', JSON.stringify({ attempts: 9, successes: 8, vpnLocation: 'private' })); const result = collectPreviousStatistics(f.dir, [{ id: 'pilot1', attempts: 10, successes: 7 }]); assert.equal(result.checks, 15); assert.equal(result.workers.length, 2); assert.ok(!JSON.stringify(result).includes('private'));
});
test('TLS failure closes the stock process, releases the failed container, and tries another eligible reserve', async () => {
  const { f, inventory, events, adapters } = fleetFixture(); adapters[1].network = async () => { throw Error('TLS'); }; await f.start(selection); await f.maintenance; await settle();
  const close = events.findIndex(e => e[0] === 'close' && e[1] === 2), disconnect = events.findIndex(e => e[0] === 'disconnect' && e[1] === 2), connect = events.findIndex(e => e[0] === 'connect'); assert.ok(close >= 0 && disconnect > close && connect > disconnect); assert.equal(f.snapshot().verifiedTunnels, 8); assert.equal(inventory[1].connected, true); await f.stop();
});
test('Mac fills only the final missing Linux slot and yields after its running request completes', async () => {
  const { f, inventory, adapters, advance, samples } = fleetFixture(); for (let i = 6; i <= 19; i++) inventory[i] = { connected: false, nextAllowedInMs: 300000 };
  let finishMac; adapters[19].sample = async s => { samples.push(19); return new Promise(resolve => { finishMac = () => resolve({ sku: s.sku, observedAt: f.now(), stores: [] }); }); };
  await f.start(selection); await f.maintenance;
  // Put Linux nodes into their ordinary node wait without making them unavailable.
  for (let i = 0; i < 5; i++) f.nodes[i].nextAllowedAt = f.now() + 65000;
  advance(10834); f.tick(); await settle(); assert.ok(samples.includes(19));
  inventory[6] = { connected: true, pinned: true }; f.nodes[5].connected = true; await f.prove(5); f.tick(); assert.ok(f.active.includes(19));
  finishMac(); await settle(); advance(10834); f.tick(); await settle(); assert.ok(!f.active.includes(19)); assert.ok(f.active.includes(5)); await f.stop();
});
test('operator-completed pickup contacts resume the same checkout without going back to pickup', async () => {
  const safari = new SafariSession({ bindingPath: null }), actions = []; let phase = 'contact';
  safari.inspect = async () => ({ phase }); safari.action = async action => { actions.push(action); if (action === 'contact-continue') phase = 'billing'; if (action === 'review') phase = 'review'; return {}; }; safari.sleep = async () => {};
  await safari.prepareCheckout(selection, 'R119', () => {}); assert.deepEqual(actions, ['contact-continue','select-apple-pay','review']);
});
test('manual stop at the last boundary prevents the native Apple Pay click', async () => {
  const safari = new SafariSession({ bindingPath: null }), native = []; safari.binding = { nonce: randomUUID() }; safari.paymentStatus = async () => ({ known: true, active: false }); safari.inspect = async () => ({ phase: 'review' }); safari.action = async () => ({ armed: true }); safari.request = async op => native.push(op);
  await assert.rejects(safari.pressApplePay(selection, { id: 'R119' }, randomUUID(), () => { throw Error('STOPPED'); }), /STOPPED/); assert.equal(native.length, 0);
});
test('corrupt payment guard fails closed instead of resetting consent or replaying a payment', t => { const f = fixture(t); writeFileSync(f.dir + '/payment-guard.json', JSON.stringify({ version: 2, phase: 'unexpected' })); assert.throws(() => new AppStorage(f.dir), /GUARD_INVALID/); });
test('guest restart quarantines new sample IDs while an earlier request is uncertain', t => {
  const f = fixture(t), path = f.dir + '/pending.json'; writeFileSync(path, JSON.stringify([{ id: randomUUID(), identity: JSON.stringify({ operation: 'sample', sku: selection.sku, stores: selection.stores }), state: 'pending' }])); let calls = 0;
  const jobs = new WorkerJobs({ sample() { calls++; } }, path, f.now); const result = jobs.start(randomUUID(), 'sample', { selection, fingerprint: proof(1).fingerprint }); assert.equal(result.code, 'sample-uncertain'); assert.equal(result.nextAllowedInMs, 65000); assert.equal(calls, 0);
});
test('native Linux connectivity is restored before any lower-use container reserve', async () => {
  const { f, inventory, events } = fleetFixture(); inventory[1] = { connected: false }; await f.start(selection); await f.maintenance; assert.deepEqual(events.find(e => e[0] === 'connect'), ['connect',1]); assert.equal(f.nodes[0].verified, true); await f.stop();
});
test('Mac remains a working last reserve after a confirmed native tunnel failure and yields when Linux recovers', async t => {
  const { f, inventory, events, adapters, samples, advance } = fleetFixture(); t.after(() => f.stop());
  for (let i = 1; i <= 19; i++) inventory[i] = { connected: false };
  const control = f.control; let nativeFails = true, macProofs = 0;
  f.control = async (op, worker) => { if (op === 'connect' && worker === 1 && nativeFails) { events.push(['native-connect-failed', 1]); throw Error('NATIVE_CONNECT_FAILED'); } return control(op, worker); };
  const network = adapters[19].network; adapters[19].network = async () => { macProofs++; return network(); };
  await f.start(selection); clearInterval(f.timer); await f.maintenance;
  assert.equal(f.snapshot().uncertainTunnels, 0); assert.equal(f.snapshot().verifiedTunnels, 0);
  assert.equal(f.nodes[19].verified, true); assert.equal(macProofs, 1);
  f.tick(); await settle(); assert.deepEqual(samples, [19]);
  assert.ok(!events.some(e => e[0] === 'disconnect' || e[0] === 'connect' && e[1] !== 1));
  nativeFails = false; advance(30000); f.maintain(); await f.maintenance;
  f.tick(); await settle();
  assert.equal(f.snapshot().verifiedTunnels, 8); assert.ok(!f.active.includes(19)); assert.ok(samples.some(i => i < 19));
  assert.equal(macProofs, 1); assert.ok(!events.some(e => e[0] === 'disconnect' && e[1] === 1));
});
test('Mac can sample during a failed native connectivity proof without replacing container tunnels', async t => {
  const { f, adapters, events, samples } = fleetFixture(); t.after(() => f.stop());
  adapters[0].network = async () => { throw Error('NATIVE_TLS_FAILED'); };
  await f.start(selection); clearInterval(f.timer); await f.maintenance;
  assert.equal(f.nodes[0].connected, true); assert.equal(f.nodes[0].verified, false);
  assert.equal(f.nodes[19].verified, true);
  f.tick(); await settle(); assert.deepEqual(samples, [19]);
  assert.ok(!events.some(e => e[0] === 'disconnect' || e[0] === 'connect'));
});
test('an ambiguous native connection never authorizes Mac fallback while inventory is uncertain', async t => {
  const { f, inventory, adapters, samples } = fleetFixture(); t.after(() => f.stop());
  for (let i = 1; i <= 19; i++) inventory[i] = { connected: false };
  const control = f.control; let macProofs = 0;
  f.control = async (op, worker) => { if (op === 'connect' && worker === 1) { inventory[1] = { connected: null, connecting: true }; throw Error('NATIVE_CONNECT_UNCERTAIN'); } return control(op, worker); };
  adapters[19].network = async () => { macProofs++; return { ...proof(99), vpn: 'host' }; };
  await f.start(selection); clearInterval(f.timer); await f.maintenance; f.tick(); await settle();
  assert.equal(f.snapshot().uncertainTunnels, 1); assert.equal(f.nodes[19].verified, false); assert.equal(macProofs, 0); assert.deepEqual(samples, []);
});
test('a checkout or manual stop guard raised during native failure prevents a Mac fallback proof', async t => {
  const { f, inventory, adapters, samples } = fleetFixture(); t.after(() => f.stop());
  for (let i = 1; i <= 19; i++) inventory[i] = { connected: false };
  const control = f.control; let macProofs = 0;
  f.control = async (op, worker) => { if (op === 'connect' && worker === 1) { f.canChange = () => false; throw Error('NATIVE_CONNECT_FAILED'); } return control(op, worker); };
  adapters[19].network = async () => { macProofs++; return { ...proof(99), vpn: 'host' }; };
  await f.start(selection); clearInterval(f.timer); await f.maintenance; f.tick(); await settle();
  assert.equal(f.nodes[19].verified, false); assert.equal(macProofs, 0); assert.deepEqual(samples, []);
});
test('Safari reconciles a lost checkout navigation reply and transient reads without a second click', async () => {
  let now = 1000, actions = 0, reads = 0;
  const s = new SafariSession({ bindingPath: null, now: () => now, sleep: async ms => { now += ms; } });
  s.action = async () => { actions++; throw Error('SAFARI_SCRIPT_UNAVAILABLE'); };
  s.inspect = async () => { reads++; if (reads === 1) throw Error('SAFARI_SCRIPT_UNAVAILABLE'); return { phase: 'pickup' }; };
  await s.transition('checkout', { selection }, ['pickup']); assert.equal(actions, 1); assert.equal(reads, 2);
});
test('a login redirect after a lost navigation reply requires the operator and never repeats checkout', async () => {
  const s = new SafariSession({ bindingPath: null }); let clicks = 0;
  s.action = async () => { clicks++; throw Error('SAFARI_SCRIPT_UNAVAILABLE'); }; s.inspect = async () => ({ phase: 'authentication' });
  await assert.rejects(s.transition('checkout', { selection }, ['pickup']), /LOGIN_REQUIRED/); assert.equal(clicks, 1);
});
test('Safari preserves public DOM error codes instead of misreporting every selector failure as lost navigation', async () => {
  const s = new SafariSession({ bindingPath: null, invoke: async request => JSON.parse((0,eval)(request.script)) }); s.binding = {};
  await assert.rejects(s.evaluate(() => { throw Error('POSTAL_CONTROL_CHANGED'); }, {}), /^Error: POSTAL_CONTROL_CHANGED$/);
  await assert.rejects(s.evaluate(() => { throw Error('fixture-private@example.invalid'); }, {}), /^Error: DOM_ACTION_FAILED$/);
});
test('automatic preparation refuses ordinary checkout even if it reaches the pickup page', async () => {
  const s = new SafariSession({ bindingPath: null }); let actions = 0;
  s.inspect = async () => ({ phase: 'bag' }); s.evaluate = async () => ({ valid: true }); s.transition = async () => ({ phase: 'pickup', applePayRoute: false }); s.action = async () => { actions++; };
  await assert.rejects(s.prepareBag(selection, () => {}), /APPLE_PAY_ROUTE_REQUIRED/); assert.equal(actions, 0);
});

test('product add with a lost reply proceeds through the accessories page without adding twice', async () => {
  const s = new SafariSession({ bindingPath: null }); let phase = 'bag', bagReads = 0, adds = 0; const actions = [];
  s.sleep = async () => {};
  s.inspect = async () => ({ phase, bagRedirectReady: phase === 'product' && adds === 1 });
  s.evaluate = async (_,p) => p.action==='product-state' ? {phase:'product',productIdentityPresent:true,productVerified:true,addReady:true,careCount:0} : ++bagReads === 1 ? { empty: true } : { valid: true };
  s.action = async (action, options) => { actions.push(action); if (action === 'navigate') phase = options.url.endsWith('/bag') ? 'bag' : 'product'; if (action === 'product-add') { adds++; throw Error('SAFARI_SCRIPT_UNAVAILABLE'); } if (action === 'checkout') phase = 'pickup'; return {}; };
  const inspect = s.inspect; s.inspect = async () => ({ ...await inspect(), applePayRoute: phase === 'pickup', fulfillmentMode: phase === 'pickup' ? 'pickup' : null });
  await s.prepareBag(selection, () => {}); assert.equal(adds, 1); assert.deepEqual(actions, ['navigate','product-add','navigate','checkout']);
});

test('pickup contact persists separately from statistical history and remains editable only while stopped', async t => {
  const f = fixture(t); await f.c.setPickupContact(contact); const saved = new AppStorage(f.dir); assert.deepEqual(saved.settings.pickupContact, contact); assert.deepEqual(f.c.snapshot().pickupContact, contact);
  assert.ok(!JSON.stringify(saved.statistics).includes(contact.emailAddress));
  for (const patch of [{ mobilePhone: 'invalid' }, { emailAddress: 'invalid' }, { lastName: '' }, { card: 'forbidden' }]) assert.throws(() => validatePickupContact({ ...contact, ...patch }), /CONTACT_INVALID/);
  f.c.enabled = true; await assert.rejects(f.c.setPickupContact(contact), /LOCKED/);
});
test('direct Apple Pay pickup contact is filled without dispatching a conventional checkout continue', async () => {
  const s = new SafariSession({ bindingPath: null }), actions = []; s.setPickupContact(contact); s.inspect = async () => ({ phase: 'contact', applePayRoute: true });
  s.evaluate=async(_,p)=>{assert.equal(p.action,'contact-state');return{phase:'contact',ready:true,fieldsReady:true,valuesReady:true,applePayReady:true,applePayRoute:true};};
  s.action = async (a, p) => { actions.push(a); if (a === 'prepare-contact') assert.deepEqual(p.contact, contact); return a === 'contact-continue' ? { readyForApplePay: true } : { filled: true }; };
  const result = await s.prepareCheckout(selection, 'R119', () => {}); assert.equal(result.store.id, 'R119'); assert.deepEqual(actions, ['prepare-contact','contact-continue']);
});

test('a recovered Apple Pay opening-only verification cannot activate purchases and never retries or asks for authorization', async t => {
  const f = fixture(t), attempt = { id: randomUUID(), pressedAt: f.now() - 60000, storeId: 'R119', purpose: 'open-apple-pay-only', selection };
  f.storage.setGuard('waiting', attempt); const c = new PurchaseController({ storage: new AppStorage(f.dir), safari: f.safari, fleet: f.fleet, catalog: f.catalog, now: f.now, notify: n => f.notices.push(n) });
  await assert.rejects(c.activation(true), /VERIFICATION_ACTIVE/); f.safari.ui = { known: true, active: true, kind: 'apple-pay' }; await c.tick(); assert.equal(c.snapshot().payment.verification, true); assert.equal(f.safari.clicks, 0); assert.equal(f.notices.length, 0);
  f.safari.ui.active = false; f.safari.page.paymentCancelledBeforeAuthorization = true; f.advance(6000); await c.tick(); f.advance(6000); await c.tick(); assert.equal(c.current, null); assert.equal(c.enabled, false); assert.equal(f.safari.bagVisits, 0); assert.equal(c.storage.statistics.failures, 0); assert.equal(c.storage.guard.attempt.purpose, 'open-apple-pay-only');
});

test('eight verified routes overlap slow responses within six positions and keep 8125 ms between starts', async () => {
  const { f, inventory, adapters, advance } = fleetFixture(); for (let i=1;i<=8;i++) inventory[i]={connected:true,pinned:true};
  const pending = new Map(), starts=[];
  for(let i=0;i<8;i++) adapters[i].sample=async s=>{starts.push({i,at:f.now()});return new Promise(resolve=>pending.set(i,()=>resolve({sku:s.sku,observedAt:f.now(),stores:[]})))};
  await f.start(selection); clearInterval(f.timer); await f.maintenance; await settle(); f.tick(); await settle();
  assert.equal(f.dispatchInterval(),8125); assert.equal(starts.length,1);
  advance(8124); f.tick(); await settle(); assert.equal(starts.length,1);
  advance(1); f.tick(); await settle(); assert.equal(starts.length,2); assert.equal(f.jobs.size,2);
  for(let n=0;n<4;n++){advance(8125);f.tick();await settle()}; assert.equal(f.jobs.size,6);
  advance(8125);f.tick();await settle(); assert.equal(starts.length,6);
  const first=starts[0].i; pending.get(first)();pending.delete(first);await settle(); const responseAt=f.now();
  f.tick();await settle();assert.equal(starts.length,7);assert.equal(starts[6].at,responseAt);assert.notEqual(starts[6].i,first);assert.equal(f.nodes[first].nextAllowedAt,responseAt+65000);
  assert.ok(starts.every((v,i)=>i===0||v.at-starts[i-1].at>=8125));assert.ok(f.jobs.size<=6);
  for(const finish of pending.values())finish();await settle();await f.stop();
});

test('zero-latency verified nodes reach the theoretical schedule without shortening any node ledger', async () => {
  const {f,inventory,adapters,advance}=fleetFixture();for(let i=1;i<=8;i++)inventory[i]={connected:true,pinned:true};const starts=[];
  for(let i=0;i<8;i++)adapters[i].sample=async s=>{starts.push({i,at:f.now()});return {sku:s.sku,observedAt:f.now(),stores:[]}};
  await f.start(selection);clearInterval(f.timer);await f.maintenance;await settle();
  for(let n=0;n<40;n++){if(n)advance(8125);f.tick();await settle()}
  assert.equal(starts.length,40);for(let i=0;i<8;i++){const own=starts.filter(s=>s.i===i);assert.equal(own.length,5);assert.ok(own.every((s,j)=>j===0||s.at-own[j-1].at>=65000))}
  assert.equal(f.snapshot().throughput.theoreticalPerMinute,8*60000/65000);assert.ok(f.snapshot().throughput.validLastMinute<=8);await f.stop();
});

test('with twelve-second responses dispatch saturates node eligibility rather than waiting after each reply', async () => {
  const {f,inventory,adapters,advance}=fleetFixture();for(let i=1;i<=8;i++)inventory[i]={connected:true,pinned:true};const pending=[],completed=[],starts=[];
  for(let i=0;i<8;i++)adapters[i].sample=async s=>{starts.push({i,at:f.now()});return new Promise(resolve=>pending.push({i,due:f.now()+12000,finish:()=>resolve({sku:s.sku,observedAt:f.now(),stores:[]})}))};
  await f.start(selection);clearInterval(f.timer);await f.maintenance;await settle();const began=f.now();let peak=0;
  for(let elapsed=0;elapsed<=600000;elapsed+=125){for(let j=pending.length-1;j>=0;j--)if(pending[j].due<=f.now()){completed.push({i:pending[j].i,at:f.now()});pending[j].finish();pending.splice(j,1)}await settle();f.tick();await settle();peak=Math.max(peak,f.jobs.size);advance(125)}
  const measured=completed.filter(r=>r.at>=began+120000).length,ceiling=8*480000/77000;assert.ok(measured>=ceiling*.95,`${measured} below ${ceiling}`);assert.ok(peak>1&&peak<=6);
  for(let i=0;i<8;i++){const own=starts.filter(s=>s.i===i);assert.ok(own.every((v,j)=>j===0||v.at-own[j-1].at>=77000))}
  for(const job of pending)job.finish();await settle();await f.stop();
});

test('native HTTP 541 pauses only its sampling and preserves its tunnel while other verified routes advance', async () => {
  const {f,inventory,adapters,events,advance}=fleetFixture();for(let i=1;i<=8;i++)inventory[i]={connected:true,pinned:true};let nativeCalls=0;
  adapters[0].sample=async()=>{nativeCalls++;throw Object.assign(Error('pause'),{httpStatus:541})};
  await f.start(selection);clearInterval(f.timer);await f.maintenance;await settle();f.nodes.forEach((n,i)=>{n.workerSuccesses=i});f.tick();await settle();const pausedUntil=f.nodes[0].nextAllowedAt;
  for(let n=0;n<16;n++){advance(8125);f.tick();await settle()}
  assert.equal(nativeCalls,1);assert.ok(pausedUntil>=1000000+300000);assert.equal(f.nodes[0].connected,true);assert.ok(!events.some(e=>e[0]==='disconnect'&&e[1]===1));assert.ok(f.nodes.slice(1,8).some(n=>n.checks>1));await f.stop();
});
test('native HTTP 541 stays in tunnel inventory while usable capacity and Mac fallback exclude its paused sampler', async t => {
  const {f,inventory,adapters,events,samples,advance}=fleetFixture();t.after(()=>f.stop());
  for(let i=7;i<=19;i++)inventory[i]={connected:false,nextAllowedInMs:300000};
  adapters[0].network=async()=>({...proof(1),pauseHttpStatus:541,nextAllowedInMs:200000});
  await f.start(selection);clearInterval(f.timer);await f.maintenance;await settle();
  assert.equal(f.snapshot().connected,6);assert.equal(f.snapshot().verifiedTunnels,6);assert.equal(f.nodes[0].connected,true);
  assert.equal(f.usable().length,5);assert.equal(f.samplingCapacity(),6);assert.equal(f.nodes[19].verified,true);
  assert.ok(!events.some(e=>e[0]==='disconnect'&&e[1]===1));
  for(let i=1;i<6;i++)f.nodes[i].nextAllowedAt=f.now()+65000;
  advance(10834);f.tick();await settle();assert.ok(samples.includes(19));assert.ok(!samples.includes(0));
  inventory[7]={connected:true,pinned:true};f.nodes[6].connected=true;await f.prove(6);advance(10834);f.tick();await settle();
  assert.ok(!f.active.includes(19));assert.equal(f.usable().length,6);assert.equal(f.nodes[0].connected,true);
  advance(200000);f.tick();await settle();assert.equal(f.usable().length,7);
});

test('successful inventory reconciliation removes only the old inventory warning', async () => {
  const {f}=fleetFixture();await f.start(selection);clearInterval(f.timer);await f.maintenance;f.block='Inventario o connettività Linux da verificare';f.maintain();await f.maintenance;assert.equal(f.block,null);await f.stop();
});

for(const code of ['SAFARI_SCRIPT_UNAVAILABLE','SAFARI_AX_UNAVAILABLE'])test('transient Safari observation failure stays on the existing page: '+code, async t => {
  const f=fixture(t);f.c.enabled=true;f.c.phase='watching';f.safari.inspect=async()=>{throw Error(code)};
  await f.c.tick();assert.equal(f.c.phase,'watching');assert.equal(f.notices.length,0);f.advance(6000);await f.c.tick();f.advance(6000);await f.c.tick();assert.equal(f.notices.filter(n=>n.code==='SAFARI_OBSERVATION_DELAY').length,1);assert.equal(f.safari.bagVisits,0);assert.equal(f.fleet.stops,0);
  f.safari.inspect=async()=>({phase:'pickup',pending:false});f.advance(6000);await f.c.tick();assert.equal(f.c.observationFailures,0);assert.equal(f.c.phase,'watching');
});

test('keeper performs a brief delivery/pickup round trip at the Apple interaction interval and always rests on pickup', async () => {
  let now=1000000,mode='pickup';const actions=[];const s=new SafariSession({bindingPath:null,now:()=>now,sleep:async ms=>{now+=ms}});
  s.inspect=async()=>({phase:'pickup',applePayRoute:true,fulfillmentMode:mode,ready:true,pending:false});
  s.action=async(a,p)=>{actions.push(a);if(a==='fulfillment-mode')mode=p.mode;return {maintained:true}};
  await s.maintain();now+=299999;await s.maintain();assert.equal(mode,'pickup');now++;await s.maintain();assert.equal(mode,'pickup');assert.equal(actions.filter(a=>a==='fulfillment-mode').length,2);now+=5000;await s.maintain();assert.equal(actions.filter(a=>a==='fulfillment-mode').length,2);now+=295000;await s.maintain();assert.equal(mode,'pickup');assert.equal(actions.filter(a=>a==='fulfillment-mode').length,4);assert.ok(!actions.includes('navigate'));
});

test('an existing matching Apple Pay checkout is reused and switched to pickup instead of reopening the bag', async () => {
  let mode='delivery';const s=new SafariSession({bindingPath:null}),actions=[];
  s.inspect=async()=>({phase:'pickup',applePayRoute:true,fulfillmentMode:mode,pending:false,ready:true});s.evaluate=async()=>({valid:true});s.action=async(a,p)=>{actions.push(a);if(a==='fulfillment-mode')mode=p.mode;return {requested:true}};
  await s.prepareBag(selection,()=>{});assert.equal(mode,'pickup');assert.deepEqual(actions,['fulfillment-mode']);
});

test('final pickup checkout verifies pickup mode before attempting Store selection', async () => {
  const s=new SafariSession({bindingPath:null}),actions=[];s.inspect=async()=>({phase:'pickup',fulfillmentMode:'delivery'});s.ensureFulfillment=async mode=>actions.push(mode);s.sleep=async()=>{};s.action=async a=>{actions.push(a);if(a==='store')throw Error('STOCK_FAILED');return {}};
  s.evaluate=async(_fn,p)=>{if(p.action==='store-calendar'){actions.push('store');throw Error('STOCK_FAILED');}return{phase:'pickup',storeState:'unselected'};};
  await assert.rejects(s.prepareCheckout(selection,'R119',()=>{}),/STOCK_FAILED/);assert.deepEqual(actions,['pickup','store']);
});

test('a keeper selector error is observed in place rather than calling initial bag preparation', async t => {
  const f=fixture(t);f.c.enabled=true;f.c.phase='watching';let prepares=0,calls=0;f.safari.prepareBag=async()=>prepares++;f.safari.inspect=async()=>({phase:'pickup',pending:false});f.safari.action=async()=>{if(calls++===0)throw Error('PICKUP_CONTROL_CHANGED');return {maintained:true}};
  await f.c.tick();assert.equal(f.c.phase,'intervention');assert.equal(f.c.resumePhase,'watching');f.advance(6000);await f.c.tick();assert.equal(f.c.phase,'watching');assert.equal(prepares,0);assert.equal(f.safari.bagVisits,0);assert.equal(f.notices[0].code,'PICKUP_CONTROL_CHANGED');
});

test('pickup stock lost before payment restarts Linux search on the same page', async t => {
  const f=fixture(t);f.c.enabled=true;f.c.phase='watching';f.safari.page={phase:'pickup',pending:false,ready:true};f.safari.prepareCheckout=async()=>{throw Error('STOCK_FAILED')};f.c.signal({stores:[{id:'R119',state:'available'}]});await settle();assert.equal(f.c.phase,'watching');assert.equal(f.c.currentStore,null);assert.equal(f.fleet.enabled,true);assert.equal(f.safari.bagVisits,0);assert.equal(f.safari.clicks,0);
});

test('checkout attempt counter persists and resuming manual contact does not count the same checkout twice', async t => {
  const f=fixture(t);f.c.enabled=true;let calls=0;f.safari.prepareCheckout=async()=>{if(calls++===0)throw Error('CONTACT_MANUAL');return {store:{id:'R119'}}};
  await assert.rejects(f.c.checkout('R119',()=>{}),/CONTACT_MANUAL/);assert.equal(f.storage.statistics.checkoutAttempts,1);assert.equal(f.storage.statistics.attempts,0);
  await f.c.checkout('R119',()=>{});assert.equal(f.storage.statistics.checkoutAttempts,1);assert.equal(f.storage.statistics.attempts,1);assert.equal(new AppStorage(f.dir).statistics.checkoutAttempts,1);
});

test('a stopped checkout boundary cannot increment the purchase attempt counter', async t => {
  const f=fixture(t);await assert.rejects(f.c.checkout('R119',()=>{throw Error('STOPPED')}),/STOPPED/);assert.equal(f.storage.statistics.checkoutAttempts,0);assert.equal(f.safari.clicks,0);
});

test('store signals update availability without initiating a checkout while disabled and expire after 90 seconds', t => {
  const f=fixture(t);f.c.signal({observedAt:f.now(),stores:[{id:'R119',state:'available'},{id:'R000',state:'available'}]});assert.deepEqual(f.c.snapshot().availability,[{id:'R119',state:'available',observedAt:f.now()}]);assert.equal(f.storage.statistics.checkoutAttempts,0);assert.equal(f.safari.clicks,0);f.advance(90001);assert.equal(f.c.snapshot().availability[0].state,'unknown');
  f.c.signal({stores:[{id:'R119',state:'unavailable'}]});assert.equal(f.c.snapshot().availability[0].state,'unavailable');assert.ok(!JSON.stringify(f.storage.statistics).includes('observedAt'));
});

test('ordinary busy fulfillment refreshes preserve Linux search and never reopen the bag', async t => {
  const f=fixture(t);f.c.enabled=true;f.c.phase='watching';f.safari.page={phase:'pickup',pending:true,paymentActive:false};await f.c.tick();assert.equal(f.c.phase,'watching');assert.equal(f.fleet.stops,0);assert.equal(f.safari.bagVisits,0);assert.equal(f.notices.length,0);
});

test('a keeper found on delivery restores pickup immediately even before its scheduled keepalive', async () => {
  let mode='delivery';const actions=[],s=new SafariSession({bindingPath:null});s.nextKeepaliveAt=Date.now()+60000;s.inspect=async()=>({phase:'pickup',fulfillmentMode:mode,pending:false,ready:true});s.action=async(a,p)=>{actions.push([a,p?.mode]);if(a==='fulfillment-mode')mode=p.mode;return {maintained:true}};
  await s.maintain();assert.equal(mode,'pickup');assert.deepEqual(actions.filter(([a])=>a==='fulfillment-mode'),[['fulfillment-mode','pickup']]);
});

test('a failed brief delivery step still restores pickup without navigating or sending Apple Pay', async () => {
  let mode='pickup';const calls=[],s=new SafariSession({bindingPath:null,sleep:async()=>{}});s.ensureFulfillment=async requested=>{calls.push(requested);mode=requested;if(requested==='delivery')throw Error('PAGE_TRANSITION_UNCERTAIN');return {phase:'pickup',fulfillmentMode:requested}};
  await assert.rejects(s.refreshPickup(),/PAGE_TRANSITION_UNCERTAIN/);assert.equal(mode,'pickup');assert.deepEqual(calls,['delivery','pickup','pickup']);
});

test('pre-payment failure history records Store, phase and public reason once with JST and no personal data', async t => {
  const f=fixture(t);f.c.enabled=true;f.c.phase='watching';f.safari.page={phase:'pickup',pending:false,ready:true};f.safari.prepareCheckout=async()=>{throw Error('STOCK_FAILED')};f.c.signal({stores:[{id:'R119',state:'available'}]});await settle();const history=new AppStorage(f.dir).statistics.checkoutHistory;assert.deepEqual(history.map(e=>e.code),['CHECKOUT_STARTED','SAFARI_STARTED','STOCK_FAILED']);assert.equal(history[2].storeId,'R119');assert.equal(history[2].stage,'before-payment');assert.match(history[2].atJST,/JST$/);assert.ok(!JSON.stringify(history).includes(contact.emailAddress));
});

test('checkout starts Safari immediately without waiting for public stock reads or closing warm browsers', async t => {
  const f=fixture(t);f.c.enabled=true;let finishDrain,quiesced=false,prepared=false;
  f.fleet.quiesce=()=>{quiesced=true;return new Promise(r=>{finishDrain=r})};f.fleet.stop=async()=>{throw Error('FULL_STOP_MUST_NOT_RUN')};f.safari.prepareCheckout=async()=>{assert.equal(quiesced,true);prepared=true;return {store:{id:'R119'}}};
  await f.c.checkout('R119',()=>{});assert.equal(prepared,true);assert.equal(f.safari.clicks,1);assert.equal(f.storage.statistics.checkoutTimings,undefined);assert.equal(f.storage.checkoutTimings.at(-1).code,'APPLE_PAY_DISPATCHED');finishDrain();await f.c.stockDrain;
});

test('quiesce stops new dispatch synchronously, keeps sessions warm, and full stop still drains and closes', async () => {
  const {f,adapters,events,advance}=fleetFixture();let finish;const arrivals=[];f.onSignal=s=>arrivals.push(s);
  adapters[0].sample=async s=>new Promise(resolve=>{finish=()=>resolve({sku:s.sku,observedAt:f.now(),stores:[]})});
  await f.start(selection);clearInterval(f.timer);await f.maintenance;await settle();f.tick();await settle();assert.equal(f.jobs.size,1);const drain=f.quiesce();assert.equal(f.enabled,false);assert.equal(events.filter(e=>e[0]==='close').length,0);advance(65000);f.tick();assert.equal(f.jobs.size,1);finish();await drain;assert.equal(arrivals.length,1);assert.equal(arrivals[0].canCheckout,false);assert.equal(events.filter(e=>e[0]==='close').length,0);await f.stop();assert.ok(events.filter(e=>e[0]==='close').length>=8);
});

test('a stock response finishing after quiesce is counted without starting another checkout', t => {
  const f=fixture(t);f.c.enabled=true;f.c.phase='watching';f.c.signal({canCheckout:false,stores:[{id:'R119',state:'available'}]});assert.equal(f.storage.statistics.checks,1);assert.equal(f.storage.statistics.checkoutAttempts,0);assert.equal(f.safari.clicks,0);
});

test('a stock response from before quiesce remains observational after the fleet resumes', async t => {
  const { f, adapters, advance } = fleetFixture(); t.after(() => f.stop());
  let finish; const arrivals = []; f.onSignal = sample => arrivals.push(sample);
  adapters[0].sample = async s => new Promise(resolve => { finish = () => resolve({ sku: s.sku, observedAt: f.now(), stores: [{ id: 'R119', state: 'available' }] }); });
  await f.start(selection); clearInterval(f.timer); await f.maintenance; await settle(); f.tick(); await settle();
  assert.equal(typeof finish, 'function');
  const drain = f.quiesce({queueCheckoutAlternatives:true});
  await f.start(selection); clearInterval(f.timer); await f.maintenance;
  finish(); await drain; await settle();
  assert.equal(arrivals.length, 1);
  assert.equal(arrivals[0].canCheckout, false);
  assert.equal(arrivals[0].canQueueDuringCheckout, false);
  assert.equal(f.nodes[0].checks, 1);
  advance(9000); f.tick(); await settle();
  assert.equal(arrivals.length, 2);
  assert.equal(arrivals[1].canCheckout, true);
});

test('a late stock response from an earlier fleet generation updates UI and counters without purchasing after resume', async t => {
  const controller = fixture(t), { f, adapters } = fleetFixture(); t.after(() => f.stop());
  controller.c.enabled = true; controller.c.phase = 'watching';
  f.onSignal = sample => controller.c.signal(sample); let finish;
  adapters[0].sample = async s => new Promise(resolve => { finish = () => resolve({ sku: s.sku, observedAt: f.now(), stores: [{ id: 'R119', state: 'available' }] }); });
  await f.start(selection); clearInterval(f.timer); await f.maintenance; await settle(); f.tick(); await settle();
  assert.equal(typeof finish, 'function');
  const drain = f.quiesce();
  await f.start(selection); clearInterval(f.timer); await f.maintenance;
  finish(); await drain; await settle();
  assert.equal(controller.storage.statistics.checks, 1);
  assert.equal(controller.c.snapshot().availability[0].state, 'available');
  assert.equal(controller.storage.statistics.checkoutAttempts, 0);
  assert.equal(controller.safari.clicks, 0);
});

for(const pagePhase of ['expired','unavailable','bag']) test('keeper restores '+pagePhase+' Safari page without waiting for independent stock requests to drain', async t => {
  const f=fixture(t);f.c.enabled=true;f.c.phase='watching';f.safari.page={phase:pagePhase,pending:false,ready:true};let finishDrain,quiesced=0,prepared=0;
  f.fleet.quiesce=()=>{quiesced++;f.fleet.enabled=false;return new Promise(resolve=>{finishDrain=resolve;});};
  f.fleet.stop=async()=>{throw Error('STOCK_CLOSE_MUST_NOT_BLOCK_PAGE_RECOVERY');};
  f.safari.prepareBag=async()=>{prepared++;f.safari.page={phase:'pickup',pending:false,ready:true,fulfillmentMode:'pickup'};};
  await f.c.tick();assert.equal(f.c.phase,'preparing');assert.equal(quiesced,1);assert.equal(prepared,0);assert.equal(f.safari.clicks,0);
  f.advance(5001);await f.c.tick();assert.equal(prepared,1);assert.equal(f.c.phase,'watching');assert.equal(f.fleet.enabled,true);assert.equal(f.safari.clicks,0);assert.equal(f.storage.statistics.checkoutAttempts,0);
  finishDrain();await f.c.stockDrain;
});

test('a failed keeper stock drain is recorded without restarting a checkout from its late positive reply', async t => {
  const f=fixture(t);f.c.enabled=true;f.c.phase='watching';f.safari.page={phase:'unavailable',pending:false,ready:true};let rejectDrain;
  f.fleet.quiesce=()=>new Promise((_resolve,reject)=>{rejectDrain=reject;});await f.c.tick();assert.equal(f.c.phase,'preparing');
  assert.equal(typeof rejectDrain,'function');rejectDrain(Error('WORKER_UNCERTAIN'));await f.c.stockDrain;assert.equal(f.c.stockDrainUnverified,true);
  f.advance(5001);await f.c.tick();f.c.signal({canCheckout:false,observedAt:f.now(),stores:[{id:'R119',state:'available'}]});await settle();
  assert.equal(f.c.phase,'watching');assert.equal(f.storage.statistics.checks,1);assert.equal(f.storage.statistics.checkoutAttempts,0);assert.equal(f.safari.clicks,0);
});

test('low host disk suspends stock once without waiting for replies or touching Safari', async t => {
  const f=fixture(t);f.c.enabled=true;f.c.phase='watching';f.c.readDiskBytes=()=>1000000000;let quiesces=0,rejectDrain;
  f.fleet.quiesce=()=>{quiesces++;f.fleet.enabled=false;return new Promise((_resolve,reject)=>{rejectDrain=reject;});};
  f.safari.bind=async()=>{throw Error('SAFARI_MUST_NOT_BE_TOUCHED');};
  await f.c.tick();assert.equal(f.c.phase,'intervention');assert.equal(quiesces,1);assert.equal(f.notices.at(-1).code,'HOST_DISK_LOW');assert.equal(f.c.pendingAvailability,null);
  rejectDrain(Error('WORKER_UNCERTAIN'));await f.c.stockDrain;assert.equal(f.c.stockDrainUnverified,true);
  f.advance(5001);await f.c.tick();assert.equal(quiesces,1);assert.equal(f.notices.length,1);assert.equal(f.safari.clicks,0);assert.equal(f.storage.guard.phase,'idle');
});

test('disk recovery waits for three GB and resumes without consuming an old queued availability', async t => {
  const f=fixture(t);let free=1000000000,prepared=0;f.c.readDiskBytes=()=>free;f.c.enabled=true;f.c.phase='watching';f.c.pendingAvailability={storeId:'R119',observedAt:f.now()};
  f.fleet.quiesce=async()=>{f.fleet.enabled=false;};f.safari.prepareBag=async()=>{prepared++;f.safari.page={phase:'pickup',ready:true,pending:false};};
  await f.c.tick();free=2500000000;f.advance(5001);await f.c.tick();assert.equal(prepared,0);assert.equal(f.c.phase,'intervention');
  free=3000000000;f.advance(5001);await f.c.tick();await settle();assert.equal(prepared,1);assert.equal(f.c.phase,'watching');assert.equal(f.fleet.enabled,true);assert.equal(f.safari.clicks,0);assert.equal(f.storage.statistics.checkoutAttempts,0);
  free=1000000000;f.advance(5001);await f.c.tick();assert.equal(f.notices.filter(n=>n.code==='HOST_DISK_LOW').length,2);
});

test('a fresh availability cannot start a checkout when the host disk is critically low', async t => {
  const f=fixture(t);f.c.enabled=true;f.c.phase='watching';f.c.readDiskBytes=()=>1999999999;let quiesces=0;f.fleet.quiesce=async()=>{quiesces++;};
  f.c.signal({observedAt:f.now(),stores:[{id:'R119',state:'available'}]});await settle();
  assert.equal(f.storage.statistics.checks,1);assert.equal(f.storage.statistics.checkoutAttempts,0);assert.equal(f.safari.clicks,0);assert.equal(f.c.currentStore??null,null);assert.equal(f.c.phase,'intervention');assert.equal(quiesces,1);
});

test('low disk never interrupts an existing native Apple Pay observation', async t => {
  const f=fixture(t);f.c.enabled=true;f.c.phase='watching';f.c.readDiskBytes=()=>10000000000;await f.c.checkout('R119',()=>{});
  const id=f.c.current.id;let budgetReads=0,quiesces=0;f.c.readDiskBytes=()=>{budgetReads++;return 0;};f.fleet.quiesce=async()=>{quiesces++;};f.safari.ui={known:true,active:true,kind:'apple-pay'};
  f.advance(31000);await f.c.tick();assert.equal(f.c.current.id,id);assert.equal(f.storage.guard.phase,'waiting');assert.equal(f.c.phase,'payment-observation');assert.equal(budgetReads,0);assert.equal(quiesces,0);assert.equal(f.safari.clicks,1);
});

test('manual disarm while disk is low cannot be undone by newly freed disk space', async t => {
  const f=fixture(t);let free=1000000000;f.c.readDiskBytes=()=>free;f.c.enabled=true;f.c.phase='watching';f.fleet.quiesce=async()=>{f.fleet.enabled=false;};
  await f.c.tick();await f.c.activation(false);free=10000000000;f.advance(5001);await f.c.tick();assert.equal(f.c.enabled,false);assert.equal(f.c.phase,'stopped');assert.equal(f.fleet.enabled,false);assert.equal(f.safari.clicks,0);
});

for(const failure of ['throw','invalid']) test('unverified host disk '+failure+' pauses stock without a Safari mutation', async t => {
  const f=fixture(t);f.c.enabled=true;f.c.phase='watching';f.c.readDiskBytes=()=>{if(failure==='throw')throw Error('FS_UNAVAILABLE');return NaN;};let quiesces=0;f.fleet.quiesce=async()=>{quiesces++;};f.safari.bind=async()=>{throw Error('SAFARI_MUST_NOT_BE_TOUCHED');};
  await f.c.tick();assert.equal(quiesces,1);assert.equal(f.c.phase,'intervention');assert.equal(f.notices.at(-1).code,'HOST_DISK_CHECK_REQUIRED');assert.equal(f.safari.clicks,0);
});

test('availability observed during keeper work is dispatched once immediately after the keeper finishes', async t => {
  const f=fixture(t);f.c.enabled=true;f.c.phase='watching';f.safari.page={phase:'pickup',pending:false};let finish;f.safari.maintain=async()=>new Promise(r=>{finish=r});const tick=f.c.tick();await settle();f.c.signal({observedAt:f.now(),stores:[{id:'R119',state:'available'}]});assert.equal(f.safari.clicks,0);assert.equal(f.storage.statistics.checks,1);finish({maintained:true});await tick;await settle();assert.equal(f.storage.statistics.checkoutAttempts,1);assert.equal(f.storage.statistics.checks,1);assert.equal(f.safari.clicks,1);
});
test('availability arriving during Safari observation skips redundant keeper work on a verified resting pickup page', async t => {
  const f=fixture(t);f.c.enabled=true;f.c.phase='watching';f.safari.page={phase:'pickup',pending:false,ready:true,fulfillmentMode:'pickup'};
  let finishBinding,maintains=0;f.safari.bind=async()=>new Promise(resolve=>{finishBinding=resolve;});f.safari.maintain=async()=>{maintains++;return{maintained:true};};
  const tick=f.c.tick();await settle();f.c.signal({observedAt:f.now(),stores:[{id:'R119',state:'available'}]});finishBinding();await tick;await settle();
  assert.equal(maintains,0);assert.equal(f.storage.statistics.checkoutAttempts,1);assert.equal(f.safari.clicks,1);
});
for (const sameStore of [true, false]) test('keeper queue retains a fresh signal when an older positive arrives for ' + (sameStore ? 'the same Store' : 'another Store'), async t => {
  const f=fixture(t);f.storage.settings.selection={...selection,stores:['R119','R224']};f.c.enabled=true;f.c.phase='watching';f.safari.page={phase:'pickup',pending:false,ready:true,fulfillmentMode:'pickup'};
  let finish;f.safari.maintain=async()=>new Promise(resolve=>{finish=resolve;});const visited=[];f.safari.prepareCheckout=async(_s,id)=>{visited.push(id);return{store:{id}};};
  const tick=f.c.tick();await settle();f.c.signal({observedAt:f.now(),stores:[{id:'R224',state:'available'}]});
  f.advance(1000);f.c.signal({observedAt:f.now()-3500,stores:[{id:sameStore?'R224':'R119',state:'available'}]});
  f.advance(3000);finish({maintained:true});await tick;await settle();
  assert.deepEqual(visited,['R224']);assert.equal(f.storage.statistics.checkoutAttempts,1);assert.equal(f.safari.clicks,1);assert.equal(f.storage.statistics.checks,2);
});
test('keeper queue can use an older still-fresh alternative after a newer reply withdraws the pending Store', async t => {
  const f=fixture(t);f.storage.settings.selection={...selection,stores:['R119','R224']};f.c.enabled=true;f.c.phase='watching';f.c.busy=true;const visited=[];f.safari.prepareCheckout=async(_s,id)=>{visited.push(id);return{store:{id}};};
  f.c.signal({observedAt:f.now(),stores:[{id:'R224',state:'available'}]});f.advance(1000);
  f.c.signal({canCheckout:false,observedAt:f.now(),stores:[{id:'R224',state:'unavailable'}]});
  f.c.signal({observedAt:f.now()-2000,stores:[{id:'R119',state:'available'}]});f.c.busy=false;f.c.dispatchPendingAvailability();await settle();
  assert.deepEqual(visited,['R119']);assert.equal(f.storage.statistics.checkoutAttempts,1);assert.equal(f.safari.clicks,1);
});
test('keeper queue replaces the pending Store with a genuinely newer positive signal', async t => {
  const f=fixture(t);f.storage.settings.selection={...selection,stores:['R119','R224']};f.c.enabled=true;f.c.phase='watching';f.c.busy=true;const visited=[];f.safari.prepareCheckout=async(_s,id)=>{visited.push(id);return{store:{id}};};
  f.c.signal({observedAt:f.now(),stores:[{id:'R224',state:'available'}]});f.advance(1000);f.c.signal({observedAt:f.now(),stores:[{id:'R119',state:'available'}]});f.c.busy=false;f.c.dispatchPendingAvailability();await settle();
  assert.deepEqual(visited,['R119']);assert.equal(f.storage.statistics.checkoutAttempts,1);assert.equal(f.safari.clicks,1);
});
test('a queued Store signal never skips a session warning or a manual stop', async t => {
  for(const stop of [false,true]){
    const f=fixture(t);f.c.enabled=true;f.c.phase='watching';f.safari.page={phase:'pickup',pending:true,ready:true,fulfillmentMode:'pickup',sessionWarning:true};
    let finishBinding,maintains=0;f.safari.bind=async()=>new Promise(resolve=>{finishBinding=resolve;});f.safari.maintain=async()=>{maintains++;return{manual:true};};
    const tick=f.c.tick();await settle();f.c.signal({observedAt:f.now(),stores:[{id:'R119',state:'available'}]});if(stop)await f.c.activation(false);finishBinding();await tick;await settle();
    assert.equal(f.storage.statistics.checkoutAttempts,0);assert.equal(f.safari.clicks,0);assert.equal(maintains,stop?0:1);
  }
});

test('a stale queued availability or a manual stop cannot start a deferred checkout', async t => {
  const f=fixture(t);f.c.enabled=true;f.c.phase='watching';f.c.busy=true;f.c.signal({observedAt:f.now(),stores:[{id:'R119',state:'available'}]});f.advance(5001);f.c.busy=false;f.c.dispatchPendingAvailability();await settle();assert.equal(f.storage.statistics.checkoutAttempts,0);f.c.busy=true;f.c.signal({observedAt:f.now(),stores:[{id:'R119',state:'available'}]});f.c.enabled=false;f.c.busy=false;f.c.dispatchPendingAvailability();await settle();assert.equal(f.safari.clicks,0);
});
test('one fresh multi-Store result tries the next configured Store after a verified pre-payment stock loss', async t => {
  for(const busy of [false,true]){
    const f=fixture(t);f.storage.settings.selection={...selection,stores:['R119','R224']};f.c.enabled=true;f.c.phase='watching';f.c.busy=busy;f.safari.page={phase:'pickup',ready:true,pending:false};const visited=[];
    f.safari.prepareCheckout=async(_selection,id)=>{visited.push(id);if(id==='R119')throw Error('STOCK_FAILED');return{store:{id}};};
    f.c.signal({observedAt:f.now(),stores:['R000','R119','R224','R224'].map(id=>({id,state:'available'}))});
    if(busy){f.c.busy=false;f.c.dispatchPendingAvailability();}await settle();
    assert.deepEqual(visited,['R119','R224']);assert.equal(f.storage.statistics.checkoutAttempts,2);assert.equal(f.safari.clicks,1);assert.equal(f.storage.guard.phase,'waiting');assert.equal(f.c.pendingAvailability,null);
  }
});
test('a multi-Store alternative expires with the original signal instead of being refreshed by checkout failure', async t => {
  const f=fixture(t);f.storage.settings.selection={...selection,stores:['R119','R224']};f.c.enabled=true;f.c.phase='watching';f.safari.page={phase:'pickup',ready:true,pending:false};const visited=[];
  f.safari.prepareCheckout=async(_selection,id)=>{visited.push(id);f.advance(5001);throw Error('STOCK_FAILED');};
  f.c.signal({observedAt:f.now(),stores:['R119','R224'].map(id=>({id,state:'available'}))});await settle();
  assert.deepEqual(visited,['R119']);assert.equal(f.safari.clicks,0);assert.equal(f.c.pendingAvailability,null);assert.equal(f.c.phase,'watching');
});
test('a newer unavailable result withdraws the pending Store without authorizing checkout from a quiesced response', async t => {
  const f=fixture(t);f.storage.settings.selection={...selection,stores:['R119','R224']};f.c.enabled=true;f.c.phase='watching';f.safari.page={phase:'pickup',ready:true,pending:false};const visited=[];
  f.safari.prepareCheckout=async(_selection,id)=>{visited.push(id);f.advance(1);f.c.signal({canCheckout:false,observedAt:f.now(),stores:[{id:'R224',state:'unavailable'}]});throw Error('STOCK_FAILED');};
  f.c.signal({observedAt:f.now(),stores:['R119','R224'].map(id=>({id,state:'available'}))});await settle();
  assert.deepEqual(visited,['R119']);assert.equal(f.safari.clicks,0);assert.equal(f.storage.statistics.checkoutAttempts,1);assert.equal(f.c.pendingAvailability,null);
});
test('availability ordering rejects an older positive response after a newer stock withdrawal', async t => {
  for (const busy of [false, true]) {
    const f = fixture(t); f.c.enabled = true; f.c.phase = 'watching'; f.c.busy = busy;
    f.c.signal({ canCheckout: false, observedAt: f.now(), stores: [{ id: 'R119', state: 'unavailable' }] });
    f.c.signal({ observedAt: f.now() - 1, stores: [{ id: 'R119', state: 'available' }] });
    if (busy) { f.c.busy = false; f.c.dispatchPendingAvailability(); }
    await settle();
    assert.equal(f.storage.statistics.checkoutAttempts, 0);
    assert.equal(f.safari.clicks, 0);
    assert.deepEqual(f.c.snapshot().availability, [{ id: 'R119', state: 'unavailable', observedAt: f.now() }]);
    assert.equal(f.storage.statistics.checks, 2);
  }
});
test('availability ordering gives a stock withdrawal priority over a positive reply with the same observation time', async t => {
  for (const busy of [false, true]) {
    const f = fixture(t); f.c.enabled = true; f.c.phase = 'watching'; f.c.busy = busy;
    f.c.signal({ canCheckout: false, observedAt: f.now(), stores: [{ id: 'R119', state: 'unavailable' }] });
    f.c.signal({ observedAt: f.now(), stores: [{ id: 'R119', state: 'available' }] });
    if (busy) { f.c.busy = false; f.c.dispatchPendingAvailability(); }
    await settle();
    assert.equal(f.storage.statistics.checkoutAttempts, 0);
    assert.equal(f.safari.clicks, 0);
    assert.equal(f.c.snapshot().availability[0].state, 'unavailable');
  }
});
test('availability ordering preserves the newer positive UI state when an older negative reply arrives', t => {
  const f = fixture(t);
  f.c.signal({ observedAt: f.now(), stores: [{ id: 'R119', state: 'available' }] });
  f.c.signal({ observedAt: f.now() - 1, stores: [{ id: 'R119', state: 'unavailable' }] });
  assert.deepEqual(f.c.snapshot().availability, [{ id: 'R119', state: 'available', observedAt: f.now() }]);
  assert.equal(f.storage.statistics.checks, 2);
  assert.equal(f.safari.clicks, 0);
});
test('availability ordering immediately uses another fresh Store while a newer reply rules out the first', async t => {
  const f = fixture(t); f.storage.settings.selection = { ...selection, stores: ['R119', 'R224'] };
  f.c.enabled = true; f.c.phase = 'watching'; const visited = [];
  f.safari.prepareCheckout = async (_selection, id) => { visited.push(id); return { store: { id } }; };
  f.c.signal({ canCheckout: false, observedAt: f.now(), stores: [{ id: 'R119', state: 'unavailable' }] });
  f.c.signal({ observedAt: f.now() - 1, stores: ['R119', 'R224'].map(id => ({ id, state: 'available' })) });
  await settle();
  assert.deepEqual(visited, ['R224']);
  assert.equal(f.storage.statistics.checkoutAttempts, 1);
  assert.equal(f.safari.clicks, 1);
  assert.equal(f.storage.guard.phase, 'waiting');
});
test('availability ordering permits a genuinely newer positive response after stock withdrawal', async t => {
  const f = fixture(t); f.c.enabled = true; f.c.phase = 'watching';
  f.c.signal({ canCheckout: false, observedAt: f.now(), stores: [{ id: 'R119', state: 'unavailable' }] });
  f.advance(1);
  f.c.signal({ observedAt: f.now(), stores: [{ id: 'R119', state: 'available' }] });
  await settle();
  assert.equal(f.c.snapshot().availability[0].state, 'available');
  assert.equal(f.storage.statistics.checkoutAttempts, 1);
  assert.equal(f.safari.clicks, 1);
});
test('Store alternatives preserve financial guards, active or unknown native UI, page processing and manual stop', async t => {
  for(const unsafe of ['intent','waiting','uncertain','completed','native-active','native-unknown','pending','not-ready','contact','observed','dispatched','completed-marker','stop']){
    const f=fixture(t);f.storage.settings.selection={...selection,stores:['R119','R224']};f.c.enabled=true;f.c.phase='watching';f.safari.page={phase:'pickup',ready:true,pending:false};const visited=[];
    f.safari.prepareCheckout=async(_selection,id)=>{
      visited.push(id);
      if(['intent','waiting','uncertain','completed'].includes(unsafe))f.storage.setGuard(unsafe,{id:randomUUID(),pressedAt:f.now(),storeId:id});
      if(unsafe==='native-active')f.safari.ui.active=true;if(unsafe==='native-unknown')f.safari.ui.known=false;if(unsafe==='pending')f.safari.page.pending=true;
      if(unsafe==='not-ready')f.safari.page.ready=false;if(unsafe==='contact')f.safari.page.phase='contact';
      if(unsafe==='observed')f.safari.page.paymentObserved=true;if(unsafe==='dispatched')f.safari.page.paymentDispatched=true;if(unsafe==='completed-marker')f.safari.page.paymentCompleted=true;
      if(unsafe==='stop')await f.c.activation(false);
      throw Error('STOCK_FAILED');
    };
    f.c.signal({observedAt:f.now(),stores:['R119','R224'].map(id=>({id,state:'available'}))});await settle();
    assert.deepEqual(visited,['R119'],unsafe);assert.equal(f.safari.clicks,0,unsafe);assert.equal(f.storage.statistics.checkoutAttempts,1,unsafe);
  }
});
test('a payment intent clears all Store alternatives even when the native dispatch reply is lost', async t => {
  const f=fixture(t);f.storage.settings.selection={...selection,stores:['R119','R224']};f.c.enabled=true;f.c.phase='watching';const visited=[];
  f.safari.prepareCheckout=async(_selection,id)=>{visited.push(id);return{store:{id}};};
  f.safari.pressApplePay=async(_selection,_store,_id,before)=>{before();throw Error('SAFARI_UNCERTAIN');};
  f.c.signal({observedAt:f.now(),stores:['R119','R224'].map(id=>({id,state:'available'}))});await settle();
  assert.deepEqual(visited,['R119']);assert.equal(f.storage.guard.phase,'uncertain');assert.equal(f.c.pendingAvailability,null);assert.equal(f.storage.statistics.checkoutAttempts,1);
});

test('queued VPN mutations from an earlier generation cannot execute after checkout pause and resume', async () => {
  let release;const block=runLinuxGuestCommand(()=>new Promise(r=>{release=r}));await settle();let epoch=0,mutations=0;
  const control=createLinuxVpnControl({canChange:()=>true,getGeneration:()=>epoch,sleep:async()=>{},execFile:async(_bin,args)=>{const text=args.at(-1);if(text.includes("'start'")){mutations++;return {stdout:'{"ok":true,"pending":true}'}}return {stdout:'{"ok":false,"code":"operation-missing"}'}}});
  const operation=control('connect',2);epoch++;release();await block;await assert.rejects(operation);assert.equal(mutations,0);
});

test('checkout timing logs keep public operation durations and exclude contacts, private URLs and payloads', t => {
  const f=fixture(t);f.storage.saveCheckoutTiming({attempt:1,sku:selection.sku,storeId:'R119',startedAtJST:'2026-11-08 12:00:00 JST',endedAtJST:'2026-11-08 12:00:01 JST',totalMs:1000,code:'STOCK_FAILED',email:contact.emailAddress,url:'https://secure.example.invalid/private',steps:[{name:'dom:store',offsetMs:0,durationMs:1000,result:'ok',payload:contact},{name:'https://secure.example.invalid/private',offsetMs:0,durationMs:0,result:'error',code:contact.emailAddress}]});
  const raw=readFileSync(f.dir+'/checkout-timings.json','utf8');assert.ok(!raw.includes(contact.emailAddress));assert.ok(!raw.includes('https://'));assert.ok(!raw.includes('mobilePhone'));const saved=JSON.parse(raw)[0];assert.equal(saved.steps[0].name,'dom:store');assert.equal(saved.steps[0].durationMs,1000);assert.equal(saved.steps[1].name,'unknown');
});
test('long checkout traces retain initial CAP context and the latest outcome within their bounded private-data-free record', t => {
  const f = fixture(t); f.c.traceStartedAt = f.now();
  f.c.activeTrace = { attempt: 1, sku: selection.sku, storeId: 'R119', startedAtJST: '2026-11-09 07:00:00 JST', steps: [] };
  f.c.traceStep({ name: 'postal:verified', durationMs: 0, result: 'ok', code: 'STORE_MISSING_INPUT_MATCHES', payload: contact });
  for (let i = 0; i < 500; i++) { f.advance(100); f.c.traceStep({ name: i % 2 ? 'dom:postal-state' : 'wait:postal', durationMs: 50, result: 'ok' }); }
  f.c.traceStep({ name: 'dom:postal', durationMs: 50, result: 'error', code: 'POSTAL_REFRESH_UNCERTAIN' });
  f.c.finishCheckoutTrace('POSTAL_REFRESH_UNCERTAIN');
  const raw = readFileSync(f.dir + '/checkout-timings.json', 'utf8'), saved = JSON.parse(raw)[0];
  assert.equal(saved.steps.length, 300);
  assert.equal(saved.steps[0].name, 'postal:verified');
  assert.equal(saved.steps[0].code, 'STORE_MISSING_INPUT_MATCHES');
  assert.equal(saved.steps[0].offsetMs, 0);
  assert.equal(saved.steps.at(-1).code, 'POSTAL_REFRESH_UNCERTAIN');
  assert.equal(saved.steps.at(-1).offsetMs, 49950);
  assert.ok(!raw.includes(contact.emailAddress)); assert.ok(!raw.includes('mobilePhone'));
});

test('Safari operations measure transport and explicit polling waits without logging scripts or parameters', async () => {
  let clock=1000;const timings=[];const s=new SafariSession({bindingPath:null,now:()=>clock,sleep:async ms=>{clock+=ms},invoke:async()=>{clock+=12;return {appleLoopEnvelope:1,ok:true,value:{phase:'pickup'}}}});s.binding={};s.onTiming=step=>timings.push(step);await s.evaluate(()=>true,{action:'store',contact});await s.pause(250);assert.equal(timings[0].name,'dom:store');assert.equal(timings[0].durationMs,12);assert.equal(timings[1].name,'wait:poll');assert.equal(timings[1].durationMs,250);assert.ok(!JSON.stringify(timings).includes(contact.emailAddress));
});

test('session extension allows only the identified Safari modal, preserving active Apple Pay', async () => {
  let kind = 'safari-modal', calls = 0, requests = 0;
  const s = new SafariSession({ bindingPath: null, invoke: async request => {
    requests++; assert.equal(request.operation,'evaluate-guarded');
    if (!(request.allowSessionModal && kind === 'safari-modal')) throw Error('PAYMENT_ACTIVE');
    calls++; return { appleLoopEnvelope: 1, ok: true, value: { extensionRequested: true } };
  } }); s.binding = {};
  assert.equal((await s.action('keepalive')).extensionRequested, true);
  await assert.rejects(s.action('postal', { postalCode: '150-0041' }), /PAYMENT_ACTIVE/);
  kind = 'apple-pay'; await assert.rejects(s.action('keepalive'), /PAYMENT_ACTIVE/); assert.equal(calls, 1); assert.equal(requests, 3);
});
test('a DOM action carries its native payment guard in the same request while passive observation stays read-only', async () => {
  const requests = [];
  const s = new SafariSession({ bindingPath: null, invoke: async request => {
    requests.push({ operation: request.operation, allowSessionModal: request.allowSessionModal });
    return { appleLoopEnvelope: 1, ok: true, value: { phase: 'pickup' } };
  } }); s.binding = {};
  await s.action('store',{storeId:'R119'}); await s.inspect();
  assert.deepEqual(requests,[{operation:'evaluate-guarded',allowSessionModal:false},{operation:'evaluate',allowSessionModal:undefined}]);
});
test('native guard refusal preserves the prior navigation allowance while a lost dispatch reply remains reconcilable', async () => {
  for(const code of ['PAYMENT_ACTIVE','ACCESSIBILITY_REQUIRED','SAFARI_AX_UNAVAILABLE','INVALID_COMMAND','SAFARI_SCRIPT_UNAVAILABLE']){
    const s=new SafariSession({bindingPath:null,now:()=>1000,invoke:async()=>{throw Error(code);}});s.binding={};s.navigationUntil=1500;
    await assert.rejects(s.action('navigate',{url:'https://www.apple.com/jp/shop/bag'}),new RegExp(code));
    assert.equal(s.navigationUntil,code==='SAFARI_SCRIPT_UNAVAILABLE'?31000:1500);
  }
});
test('lost session extension reply is observed without clicking the warning again', async () => {
  for(const phase of ['pickup','expired']){
    const s = new SafariSession({ bindingPath: null }); let clicks = 0, reads = 0;
    s.action = async () => { clicks++; throw Error('SAFARI_SCRIPT_UNAVAILABLE'); }; s.inspect = async () => { reads++; return { phase, pending: false, sessionWarning: false, ready: true }; };
    const result=await s.renewSession();assert.equal(phase==='expired'?result.expired:result.maintained,true);assert.equal(clicks,1);assert.equal(reads,1);
  }
});
test('Apple authentication remains manual even in the presence of a session warning', async () => {
  const s = new SafariSession({ bindingPath: null }); s.inspect = async () => ({ phase: 'authentication', sessionWarning: true }); s.action = async () => { throw Error('MUST_NOT_CLICK'); };
  await assert.rejects(s.prepareBag(selection, () => {}), /LOGIN_REQUIRED/); await assert.rejects(s.prepareCheckout(selection, 'R119', () => {}), /LOGIN_REQUIRED/);
});
test('inactivity extension needing intervention is not reported as a missing Apple login', async t => {
  const f = fixture(t); f.c.enabled = true; f.c.phase = 'watching'; f.safari.page = { phase: 'pickup', sessionWarning: true, pending: true };
  f.safari.maintain = async () => ({ manual: true }); await f.c.tick(); assert.equal(f.c.phase, 'intervention'); assert.equal(f.notices[0].code, 'SESSION_EXTENSION_REQUIRED'); assert.equal(f.safari.bagVisits, 0);
});
test('the checkout timing retains earlier operations and elapsed waiting across a resumed attempt', async t => {
  const f = fixture(t); f.c.enabled = true; let prepares = 0;
  f.safari.prepareCheckout = async () => { f.c.traceStep({ name: 'dom:inspect', durationMs: 100, result: 'ok' }); f.advance(1000); if (prepares++ === 0) throw Error('CONTACT_MANUAL'); return { store: { id: 'R119' } }; };
  await assert.rejects(f.c.checkout('R119', () => {}), /CONTACT_MANUAL/); f.advance(5000); await f.c.checkout('R119', () => {});
  const traces = new AppStorage(f.dir).checkoutTimings; assert.equal(traces.length, 1); assert.equal(traces[0].totalMs, 7000); assert.equal(traces[0].steps.filter(s => s.name === 'dom:inspect').length, 2); assert.equal(traces[0].code, 'APPLE_PAY_DISPATCHED');
});

test('a keeper finishing after deactivation cannot restore the watching phase', async t => {
  const f = fixture(t); f.c.enabled = true; f.c.phase = 'watching'; f.safari.page = { phase: 'pickup', ready: true };
  let finish; f.safari.maintain = async () => new Promise(resolve => { finish = resolve; });
  const tick = f.c.tick(); await settle(); await f.c.activation(false); finish({ maintained: true }); await tick;
  assert.equal(f.c.enabled, false); assert.equal(f.c.phase, 'stopped'); assert.equal(f.fleet.enabled, false);
});

test('HTTP 541 retires the refused browser and resumes the same worker only after the Apple pause', async t => {
  const f = fixture(t); let factories = 0, requests = 0, closed = false;
  const body = { head: { status: '200' }, body: { stores: [{ storeNumber: 'R119', partsAvailability: { [selection.sku]: { partNumber: selection.sku, pickupDisplay: 'available', storePickEligible: true, messageTypes: { regular: { storeSelectionEnabled: true, storePickupProductTitle: selection.name } } } } }] } };
  const w = new PickupWorker({ now: f.now, network: async () => proof(1), browserFactory: async () => {
    const first = ++factories === 1;
    return { close: async () => { if (first) closed = true; }, fetch: async () => {
      if (first && closed) throw Error('Container pool stopped'); requests++;
      if (first) { closed = true; return new Response('', { status: 541 }); }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    } };
  } });
  await assert.rejects(w.sample(selection, proof(1).fingerprint), e => e.httpStatus === 541);
  f.advance(299999); await assert.rejects(w.sample(selection, proof(1).fingerprint), /NODE_WAIT/); assert.equal(requests, 1);
  f.advance(1); assert.equal((await w.sample(selection, proof(1).fingerprint)).stores[0].state, 'available'); assert.equal(factories, 2); assert.equal(requests, 2);
});

test('an unverified refused-browser closure cannot create a replacement browser', async t => {
  const f = fixture(t); let factories = 0, closes = 0;
  const w = new PickupWorker({ now: f.now, network: async () => proof(1), browserFactory: async () => { factories++; return { fetch: async () => new Response('', { status: 541 }), close: async () => { if (++closes < 3) throw Error('CLOSE_UNVERIFIED'); } }; } });
  await assert.rejects(w.sample(selection, proof(1).fingerprint), e => e.httpStatus === 541); f.advance(300000);
  await assert.rejects(w.sample(selection, proof(1).fingerprint), /CLOSE_UNVERIFIED/); assert.equal(factories, 1); assert.ok(w.browser);
  await w.close(); assert.equal(w.browser, null); assert.equal(w.browserNeedsReset, false);
});

test('a container HTTP 541 closes and disconnects it before promoting the lowest-use eligible reserve', async t => {
  const { f, inventory, adapters, events } = fleetFixture(); t.after(() => f.stop());
  for (let i = 1; i <= 8; i++) inventory[i] = { connected: true, pinned: true };
  f.nodes[0].checks = 10; for (let i = 8; i < 19; i++) f.nodes[i].workerSuccesses = 100; f.nodes[8].workerSuccesses = 90; f.nodes[9].workerSuccesses = 2;
  adapters[1].sample = async () => { throw Object.assign(Error('APPLE_PAUSE'), { httpStatus: 541, nextAllowedAt: 1600000 }); };
  await f.start(selection); clearInterval(f.timer); await f.maintenance; f.tick(); await settle(); await f.pool.drain(); await settle();
  const close = events.findIndex(e => e[0] === 'close' && e[1] === 2), disconnect = events.findIndex(e => e[0] === 'disconnect' && e[1] === 2), connect = events.findIndex(e => e[0] === 'connect' && e[1] === 10);
  assert.ok(close >= 0 && disconnect > close && connect > disconnect); assert.equal(f.nodes[1].connected, false); assert.equal(f.nodes[1].nextAllowedAt, 1600000); assert.equal(f.eligible(1), false); assert.equal(f.nodes[9].verified, true); assert.equal(f.nodes.filter(n => n.connected === true).length, 8); assert.ok(!events.some(e => e[0] === 'disconnect' && e[1] === 1));
});

test('HTTP 541 handoff waits for the checkout guard and resumes from the pending retirement', async t => {
  const { f, inventory, adapters, events } = fleetFixture(); t.after(() => f.stop()); let allowed = true;
  for (let i = 1; i <= 8; i++) inventory[i] = { connected: true, pinned: true };
  f.canChange = () => allowed; f.nodes[0].checks = 10;
  adapters[1].sample = async () => { allowed = false; throw Object.assign(Error('APPLE_PAUSE'), { httpStatus: 541 }); };
  await f.start(selection); clearInterval(f.timer); await f.maintenance; f.tick(); await settle();
  assert.equal(f.retirements.has(1), true); assert.ok(!events.some(e => e[0] === 'disconnect'));
  allowed = true; f.maintain(); await f.maintenance; assert.equal(f.nodes[1].connected, false); assert.equal(f.retirements.has(1), false); assert.ok(events.some(e => e[0] === 'connect'));
});

test('a persisted HTTP 541 is recovered from its ledger before any new stock request after restart', async t => {
  const { f, inventory, adapters, events, samples } = fleetFixture(); t.after(() => f.stop());
  for (let i = 1; i <= 8; i++) inventory[i] = { connected: true, pinned: true };
  adapters[1].network = async () => ({ ...proof(2), pauseHttpStatus: 541, nextAllowedInMs: 200000 });
  await f.inspect(); assert.equal(f.retirements.has(1), true); assert.ok(!events.some(e => e[0] === 'disconnect'));
  await f.start(selection); clearInterval(f.timer); await f.maintenance;
  assert.equal(f.nodes[1].connected, false); assert.equal(f.nodes[1].nextAllowedAt, 1200000); assert.ok(!samples.includes(1)); assert.ok(events.some(e => e[0] === 'connect'));
});

test('a stuck Connecting reserve is closed and reconciled after its grace period, only outside checkout', async t => {
  const { f, inventory, events, advance } = fleetFixture(); t.after(() => f.stop()); let allowed = true; f.canChange = () => allowed;
  for (let i = 1; i <= 8; i++) inventory[i] = { connected: true, pinned: true }; inventory[2] = { connected: null, connecting: true };
  await f.start(selection); clearInterval(f.timer); await f.maintenance;
  advance(29999); f.maintain(); await f.maintenance; assert.ok(!events.some(e => e[0] === 'disconnect'));
  advance(1); allowed = false; f.maintain(); await f.maintenance; assert.ok(!events.some(e => e[0] === 'disconnect'));
  allowed = true; f.maintain(); await f.maintenance;
  const close = events.findIndex(e => e[0] === 'close' && e[1] === 2), release = events.findIndex(e => e[0] === 'disconnect' && e[1] === 2), connect = events.findIndex(e => e[0] === 'connect');
  assert.ok(close >= 0 && release > close && connect > release); assert.equal(f.nodes[1].connected, false); assert.equal(f.eligible(1), false); assert.equal(f.snapshot().verifiedTunnels, 8); assert.ok(!events.some(e => e[0] === 'disconnect' && e[1] === 1));
});

test('an unreadable inventory is held for reconciliation without guessing a disconnect or opening more tunnels', async t => {
  const { f, inventory, events, advance } = fleetFixture(); t.after(() => f.stop()); inventory[2] = { connected: null };
  await f.start(selection); clearInterval(f.timer); await f.maintenance; advance(60000); f.maintain(); await f.maintenance;
  assert.ok(!events.some(e => ['disconnect','connect'].includes(e[0]))); assert.equal(f.nodes[0].connected, true); assert.equal(f.snapshot().uncertainTunnels, 1);
});

test('a failed container cannot promote another reserve until native connectivity is verified again', async t => {
  const { f, inventory, adapters, events } = fleetFixture(); t.after(() => f.stop());
  for (let i = 1; i <= 8; i++) inventory[i] = { connected: true, pinned: true }; f.nodes[0].checks = 10;
  adapters[1].sample = async () => { f.nodes[0].verified = false; throw Error('TRANSPORT_FAILED'); };
  await f.start(selection); clearInterval(f.timer); await f.maintenance; events.length = 0; f.tick(); await settle(); await f.pool.drain();
  assert.ok(events.some(e => e[0] === 'disconnect' && e[1] === 2)); assert.ok(!events.some(e => e[0] === 'connect'));
  f.maintain(); await f.maintenance; assert.equal(f.nodes[0].verified, true); assert.ok(events.some(e => e[0] === 'connect')); assert.ok(!events.some(e => e[0] === 'disconnect' && e[1] === 1));
});

test('expiry before any payment abandons the failed checkout and restores the normal Apple Pay preparation', async t => {
  const f=fixture(t);f.c.enabled=true;f.c.phase='watching';f.safari.page={phase:'expired',ready:true,pending:false};f.safari.prepareCheckout=async()=>{throw Error('PREORDER_SESSION_EXPIRED')};
  f.c.signal({stores:[{id:'R119',state:'available'}]});await settle();assert.equal(f.c.currentStore,null);assert.equal(f.c.phase,'preparing');assert.equal(f.safari.clicks,0);assert.equal(f.storage.statistics.attempts,0);
  f.advance(2000);await f.c.tick();assert.equal(f.c.phase,'watching');assert.equal(f.fleet.enabled,true);assert.equal(f.safari.page.phase,'pickup');assert.ok(f.storage.statistics.checkoutHistory.some(e=>e.code==='PREORDER_SESSION_EXPIRED'));
});

test('expired Safari pickup raises the pre-payment expiry code without touching any checkout control', async()=>{
  const s=new SafariSession({bindingPath:null});s.inspect=async()=>({phase:'expired'});s.action=async()=>{throw Error('MUST_NOT_CLICK')};await assert.rejects(s.prepareCheckout(selection,'R119',()=>{}),/PREORDER_SESSION_EXPIRED/);
});

test('expired pre-order recovery preserves uncertain payment guards and open native sheets', async t=>{
  const f=fixture(t);f.c.enabled=true;f.c.currentStore='R119';f.safari.page={phase:'expired',ready:true};f.safari.ui={known:true,active:true};await assert.rejects(f.c.resumeAfterExpiredSession(()=>{}),/EXISTING_CHECKOUT/);assert.equal(f.c.currentStore,'R119');assert.equal(f.fleet.stops,0);
  f.safari.ui.active=false;f.storage.setGuard('uncertain',{id:randomUUID(),storeId:'R119',pressedAt:f.now()});await assert.rejects(f.c.resumeAfterExpiredSession(()=>{}),/EXISTING_CHECKOUT/);assert.equal(f.storage.guard.phase,'uncertain');assert.equal(f.c.currentStore,'R119');
});

test('expiry, bag return or stock disappearance after a payment intent do not prove an order failed',()=>{
  for(const page of [{phase:'expired'},{phase:'bag'},{phase:'pickup',stockFailure:true}])assert.equal(paymentDecision({page:{...page,ready:true},ui:{known:true,active:false},elapsed:60000,stable:true}),'uncertain');
});

test('a dispatched click is not reported as an opened Apple Pay sheet', async t => {
  const f=fixture(t);f.c.enabled=true;await f.c.checkout('R119',()=>{});
  assert.equal(f.storage.checkoutTimings.at(-1).code,'APPLE_PAY_DISPATCHED');
  assert.ok(!f.notices.some(n=>n.code==='PAYMENT_AUTHORIZE'));
  assert.ok(!f.storage.statistics.checkoutHistory.some(e=>e.code==='APPLE_PAY_OPENED'));
  f.safari.ui={known:true,active:true,kind:'safari-modal'};await f.c.observePayment();
  assert.ok(!f.notices.some(n=>n.code==='PAYMENT_AUTHORIZE'));
  f.safari.ui={known:true,active:true,kind:'apple-pay'};await f.c.observePayment();await f.c.observePayment();
  assert.equal(f.notices.filter(n=>n.code==='PAYMENT_AUTHORIZE').length,1);
  assert.equal(f.storage.statistics.checkoutHistory.filter(e=>e.code==='APPLE_PAY_OPENED').length,1);
  assert.equal(f.safari.clicks,1);
});

test('native Apple Pay is alerted once even when its sheet makes page JavaScript unreadable', async t => {
  const f=fixture(t);f.c.enabled=true;await f.c.checkout('R119',()=>{});const inspect=f.safari.inspect;let pageReads=0;
  f.safari.ui={known:true,active:true,kind:'apple-pay'};f.safari.inspect=async()=>{pageReads++;throw Error('SAFARI_SCRIPT_UNAVAILABLE');};
  await f.c.observePayment();await f.c.observePayment();assert.equal(pageReads,0);assert.equal(f.notices.filter(n=>n.code==='PAYMENT_AUTHORIZE').length,1);assert.ok(f.storage.guard.attempt.alertedAt);assert.equal(f.storage.guard.phase,'waiting');assert.equal(f.safari.bagVisits,0);assert.equal(f.safari.clicks,1);
  f.safari.inspect=inspect;f.safari.ui.active=false;f.safari.page.paymentCancelledBeforeAuthorization=true;f.advance(60000);await f.c.observePayment();f.advance(3000);await f.c.observePayment();assert.equal(f.safari.bagVisits,1);assert.equal(f.safari.clicks,1);
});

for(const nativeState of ['authentication','unknown'])test('payment observation stays read-only while native status is '+nativeState,async t=>{
  const f=fixture(t);f.c.enabled=true;await f.c.checkout('R119',()=>{});let reads=0;f.safari.inspect=async()=>{reads++;throw Error('SAFARI_SCRIPT_UNAVAILABLE');};f.safari.ui=nativeState==='unknown'?{known:false,active:false,kind:'unknown'}:{known:true,active:true,kind:'safari-modal'};
  f.advance(60000);await f.c.observePayment();assert.equal(reads,0);assert.equal(f.safari.bagVisits,0);assert.equal(f.safari.clicks,1);assert.equal(f.storage.guard.phase,'waiting');assert.ok(!f.notices.some(n=>n.code==='PAYMENT_AUTHORIZE'));
});

test('a payment sheet opening between observations is detected at the next second without shortening the order wait',async t=>{
  const f=fixture(t);f.c.enabled=true;await f.c.checkout('R119',()=>{});f.advance(1000);await f.c.tick();assert.ok(!f.notices.some(n=>n.code==='PAYMENT_AUTHORIZE'));
  f.safari.ui={known:true,active:true,kind:'apple-pay'};f.advance(1000);await f.c.tick();assert.equal(f.notices.filter(n=>n.code==='PAYMENT_AUTHORIZE').length,1);assert.equal(f.safari.bagVisits,0);assert.equal(f.safari.clicks,1);assert.equal(f.storage.guard.phase,'waiting');
});

test('a newly visible Wallet sheet triggers the siren before the first timer tick, without a page read',async t=>{
 for(const first of ['wallet','quiet','unknown','modal','read-failed']){
  const f=fixture(t);f.c.enabled=true;f.c.phase='watching';let reads=0,domReads=0;
  f.safari.inspect=async()=>{domReads++;throw Error('PAGE_MUST_NOT_BE_READ');};
  f.safari.paymentStatus=async()=>{
   reads++;
   if(reads>1||first==='wallet')return{known:true,active:true,kind:'apple-pay'};
   if(first==='read-failed')throw Error('SAFARI_SCRIPT_UNAVAILABLE');
   if(first==='unknown')return{known:false,active:false,kind:'unknown'};
   if(first==='modal')return{known:true,active:true,kind:'safari-modal'};
   return{known:true,active:false,kind:'none'};
  };
  f.c.startCheckout('R119');await settle();
  assert.equal(reads,1);assert.equal(domReads,0);assert.equal(f.storage.guard.phase,'waiting');
  assert.equal(f.safari.clicks,1);assert.equal(f.safari.bagVisits,0);
  assert.equal(f.notices.filter(n=>n.code==='PAYMENT_AUTHORIZE').length,first==='wallet'?1:0);
  if(first==='wallet')f.advance(1000);
  else assert.equal(f.c.nextTick,f.now(),'unseen native sheet is eligible at the next normal tick');
  await f.c.tick();f.advance(1000);await f.c.tick();
  assert.equal(f.notices.filter(n=>n.code==='PAYMENT_AUTHORIZE').length,1);
  assert.equal(f.storage.statistics.checkoutHistory.filter(e=>e.code==='APPLE_PAY_OPENED').length,1);
  assert.equal(domReads,0);assert.equal(f.safari.clicks,1);assert.equal(f.safari.bagVisits,0);
 }
});

test('temporarily blocked pre-payment recovery resumes its verified recovery instead of stranding an old Store', async t => {
  for(const code of ['STOCK_FAILED','POSTAL_REFRESH_UNCERTAIN','PREORDER_SESSION_EXPIRED']){
    const f=fixture(t);f.c.enabled=true;f.c.phase='watching';f.safari.page={phase:code==='PREORDER_SESSION_EXPIRED'?'expired':'pickup',ready:true,pending:true,fulfillmentMode:'pickup'};
    f.safari.prepareCheckout=async()=>{throw Error(code)};
    let refreshes=0;f.safari.refreshPickup=async check=>{check();refreshes++;return{maintained:true,mode:'pickup'}};
    f.c.startCheckout('R119');await settle();assert.equal(f.c.currentStore,'R119');assert.equal(f.c.phase,'intervention');
    f.advance(2000);await f.c.tick();assert.equal(f.c.phase,'intervention');assert.equal(f.c.currentStore,'R119');assert.equal(f.fleet.enabled,false);
    f.safari.page.pending=false;f.advance(6000);await f.c.tick();
    assert.equal(f.c.currentStore,null);assert.equal(f.c.phase,code==='PREORDER_SESSION_EXPIRED'?'preparing':'watching');
    assert.equal(f.fleet.enabled,code!=='PREORDER_SESSION_EXPIRED');assert.equal(f.safari.clicks,0);assert.equal(refreshes,code==='POSTAL_REFRESH_UNCERTAIN'?1:0);
  }
});

test('the pre-Apple-Pay fulfillment rejection retries only after stable quiet proof and never after an observed opening', () => {
  const input={page:{phase:'pickup',ready:true,prePaymentRejection:true},ui:{known:true,active:false},elapsed:30000,stable:true};
  assert.equal(paymentDecision(input),'retry');
  assert.equal(paymentDecision({...input,opened:true}),'uncertain');
  assert.equal(paymentDecision({...input,stable:false}),'uncertain');
  assert.equal(paymentDecision({...input,elapsed:29999}),'wait');
  assert.equal(paymentDecision({...input,ui:{known:false,active:false}}),'wait');
  assert.equal(paymentDecision({...input,ui:{known:true,active:true}}),'wait');
});

test('an observed Apple Pay opening survives restart and does not repeat the authorization alert', async t => {
  const f=fixture(t);f.c.enabled=true;await f.c.checkout('R119',()=>{});f.safari.ui={known:true,active:true,kind:'apple-pay'};await f.c.observePayment();
  const c=new PurchaseController({storage:new AppStorage(f.dir),safari:f.safari,fleet:f.fleet,catalog:f.catalog,now:f.now,notify:n=>f.notices.push(n)});
  assert.ok(c.current.openedAt);await c.observePayment();assert.equal(f.notices.filter(n=>n.code==='PAYMENT_AUTHORIZE').length,1);
  f.advance(60000);f.safari.ui.active=false;f.safari.page={phase:'pickup',ready:true,prePaymentRejection:true};await c.observePayment();f.advance(3000);await c.observePayment();assert.equal(c.storage.guard.phase,'uncertain');assert.equal(f.safari.bagVisits,0);
});

test('the Apple Pay alert plays a three-second siren while unrelated notifications retain their normal sound', () => {
  const calls=[];const run=(bin,args,options)=>{const call={bin,args,options,script:''};calls.push(call);return{stdin:{on(){},end(s){call.script=s;}}};};
  desktopNotification({type:'action',code:'PAYMENT_AUTHORIZE',message:'Autorizza Apple Pay.'},{run});
  assert.deepEqual(calls.map(c=>c.bin),['/usr/bin/osascript','/usr/bin/afplay']);assert.ok(!calls[0].script.includes('sound name'));assert.equal(calls[1].options.timeout,5000);
  const wav=readFileSync(calls[1].args[0]);assert.equal(wav.toString('ascii',0,4),'RIFF');const rate=wav.readUInt32LE(24),bytesPerSample=wav.readUInt16LE(34)/8,channels=wav.readUInt16LE(22),dataBytes=wav.readUInt32LE(40);assert.equal(dataBytes/bytesPerSample/channels/rate,3);
  calls.length=0;desktopNotification({type:'action',code:'PAYMENT_UNCERTAIN',message:'Verifica Safari.'},{run});assert.equal(calls.length,1);assert.ok(calls[0].script.includes('sound name "Glass"'));
  calls.length=0;desktopNotification({type:'success',code:'ORDER_CONFIRMED',message:'Confermato.'},{run});assert.equal(calls.length,1);assert.ok(calls[0].script.includes('sound name "Hero"'));
});

test('a failed native connectivity proof preserves container tunnels until the native retry succeeds', async t => {
  const {f,adapters,events,advance,inventory}=fleetFixture();t.after(()=>f.stop());
  let nativeReady=false;const proofs=[];
  for(let i=0;i<19;i++){const network=adapters[i].network;adapters[i].network=async()=>{proofs.push(i);if(!nativeReady)throw Error('transport');return network();};}
  await f.start(selection);clearInterval(f.timer);await f.maintenance;
  assert.equal(f.nodes[0].connected,true);assert.equal(f.nodes[0].verified,false);
  assert.ok(!events.some(e=>['close','disconnect','connect'].includes(e[0])));
  assert.deepEqual(proofs,[0]);
  advance(30000);f.maintain();await f.maintenance;
  assert.ok(!events.some(e=>['close','disconnect','connect'].includes(e[0])));
  nativeReady=true;advance(30000);f.maintain();await f.maintenance;
  assert.equal(f.nodes[0].verified,true);assert.equal(f.snapshot().verifiedTunnels,8);
  assert.ok(!events.some(e=>e[0]==='disconnect'));assert.equal(inventory[1].connected,true);
});

test('a promoted reserve reuses its fresh verified proof instead of querying the same route twice', async t => {
  const {f,adapters}=fleetFixture();t.after(()=>f.stop());const calls=Array(20).fill(0);
  for(let i=0;i<adapters.length;i++){const network=adapters[i].network;adapters[i].network=async()=>{calls[i]++;return network();};}
  await f.start(selection);clearInterval(f.timer);await f.maintenance;
  assert.equal(f.snapshot().verifiedTunnels,8);assert.equal(calls[6],1);assert.equal(calls[7],1);assert.equal(calls.reduce((a,b)=>a+b,0),8);
});

test('a started web payment session holds the guard but the siren waits for a visible native Apple Pay sheet', async t => {
  const f=fixture(t);f.c.enabled=true;await f.c.checkout('R119',()=>{});f.safari.page={phase:'contact',ready:true,paymentObserved:true,paymentActive:true,pending:true};
  await f.c.observePayment();assert.ok(f.c.current.openedAt);assert.ok(!f.c.current.alertedAt);assert.ok(!f.notices.some(n=>n.code==='PAYMENT_AUTHORIZE'));
  f.safari.ui={known:true,active:true,kind:'apple-pay'};await f.c.observePayment();await f.c.observePayment();assert.equal(f.notices.filter(n=>n.code==='PAYMENT_AUTHORIZE').length,1);assert.ok(f.storage.guard.attempt.alertedAt);
});

test('a verified fresh CAP refusal rebuilds without a redundant delivery round trip',async t=>{
  const f=fixture(t);f.c.enabled=true;f.c.phase='watching';f.safari.page={phase:'pickup',ready:true,pending:false,pickupUnavailable:true,fulfillmentMode:'pickup'};
  f.safari.prepareCheckout=async()=>{throw Object.assign(Error('STOCK_FAILED'),{freshPickupRefusalVerified:true});};f.safari.refreshPickup=async()=>{throw Error('MUST_NOT_SWITCH_DELIVERY')};
  f.safari.transition=async()=>{f.safari.bagVisits++;f.safari.page={phase:'bag',ready:true,pending:false};return f.safari.page;};
  f.c.startCheckout('R119');await settle();assert.equal(f.c.phase,'preparing');assert.equal(f.safari.bagVisits,1);assert.equal(f.safari.clicks,0);assert.equal(f.storage.guard.phase,'idle');assert.ok(f.storage.statistics.checkoutHistory.some(e=>e.code==='PICKUP_MODE_RECOVERY_SKIPPED'));
  assert.equal(f.c.nextTick,f.now());
  await f.c.tick();assert.equal(f.c.phase,'watching');assert.equal(f.fleet.enabled,true);assert.equal(f.safari.bagVisits,1);assert.equal(f.safari.clicks,0);
});
for(const complete of [false,true])test('CAP refusal freshness requires the submitted response fence: '+complete,async()=>{
  const s=new SafariSession({bindingPath:null});s.pendingPostal={storeId:'R119',id:randomUUID(),stage:complete?'submitted':'opening',openingAt:Date.now()};
  s.evaluate=async()=>({phase:'pickup',ready:true,pending:false,fulfillmentMode:'pickup',pickupUnavailable:true,refreshComplete:complete});s.action=async()=>{throw Error('MUST_NOT_MUTATE')};
  await assert.rejects(s.refreshStoreAvailability({id:'R119',postalCode:'150-0041'}),e=>e.message==='STOCK_FAILED'&&e.freshPickupRefusalVerified===complete);
});
test('delivery-only stock failure restores pickup or rebuilds from the observed bag without repeating a lost navigation', async t => {
  for(const remainsUnavailable of [false,true]){
    const f=fixture(t);f.c.enabled=true;f.c.currentStore='R119';f.safari.page={phase:'pickup',ready:true,pickupUnavailable:true};let refreshes=0;
    f.safari.refreshPickup=async check=>{check();refreshes++;if(!remainsUnavailable)f.safari.page.pickupUnavailable=false;};
    if(remainsUnavailable){f.safari.transition=async()=>{f.safari.bagVisits++;f.safari.page={phase:'bag',ready:true};throw Error('SAFARI_UNCERTAIN');};await assert.rejects(f.c.resumeAfterStockFailure(()=>{}),/SAFARI_UNCERTAIN/);await f.c.resumeAfterStockFailure(()=>{});assert.equal(f.c.currentStore,null);assert.equal(f.c.phase,'preparing');assert.equal(f.fleet.enabled,false);assert.equal(f.safari.bagVisits,1);await f.c.tick();assert.equal(f.c.phase,'watching');assert.equal(f.fleet.enabled,true);}
    else{await f.c.resumeAfterStockFailure(()=>{});assert.equal(f.c.currentStore,null);assert.equal(f.c.phase,'watching');assert.equal(f.fleet.enabled,true);assert.ok(f.storage.statistics.checkoutHistory.some(e=>e.code==='PICKUP_PAGE_RESTORED'));}
    assert.equal(refreshes,1);assert.equal(f.safari.bagVisits,remainsUnavailable?1:0);assert.equal(f.safari.clicks,0);
  }
});

test('a persistent inline stock rejection rebuilds once without claiming that the rejected pickup page was restored', async t => {
  const f=fixture(t);f.c.enabled=true;f.c.currentStore='R119';f.safari.page={phase:'pickup',ready:true,pickupUnavailable:false,stockFailure:true,errors:2};
  f.safari.refreshPickup=async()=>{throw Error('MUST_NOT_FLIP_AGAIN')};f.safari.transition=async()=>{f.safari.bagVisits++;f.safari.page={phase:'bag',ready:true};return f.safari.page;};
  await f.c.resumeAfterStockFailure(()=>{});assert.equal(f.c.phase,'preparing');assert.equal(f.c.currentStore,null);assert.equal(f.safari.bagVisits,1);assert.equal(f.safari.clicks,0);
  assert.ok(!f.storage.statistics.checkoutHistory.some(e=>e.code==='PICKUP_PAGE_RESTORED'));assert.ok(f.storage.statistics.checkoutHistory.some(e=>e.code==='PICKUP_PAGE_REBUILD_STARTED'));
});
test('only a verified prepayment bag rebuild identifies its colour to the next preparation', async t=>{
 const f=fixture(t),white=whiteSelection();await f.c.select(selection,[white]);f.c.enabled=true;f.c.phase='watching';
 f.safari.page={phase:'pickup',ready:true,pending:false,fulfillmentMode:'pickup',stockFailure:true,errors:1};
 f.safari.prepareCheckout=async()=>{throw Error('STOCK_FAILED');};
 f.safari.transition=async()=>{f.safari.page={phase:'bag',ready:true,pending:false};return f.safari.page;};
 const rebuilds=[];f.safari.prepareSelections=async(_s,check,_yield,options)=>{check();rebuilds.push(options.rebuildSKU);};
 f.c.signal({sku:white.sku,stores:[{id:'R119',state:'available'}]});await settle();
 assert.equal(f.c.phase,'preparing');assert.equal(f.storage.guard.phase,'idle');assert.equal(f.safari.clicks,0);
 await f.c.tick();assert.deepEqual(rebuilds,[white.sku]);assert.equal(f.c.pickupRebuild,null);assert.equal(f.c.phase,'watching');
});
test('loss of one independent Safari route keeps stock and accepts only the available colour', async t => {
  const f = fixture(t), white = whiteSelection();
  await f.c.select(selection, [white]);
  f.c.enabled = true;
  f.c.phase = 'watching';
  f.fleet.enabled = true;
  f.safari.bind = async () => { throw Error('SAFARI_ROUTE_CHANGED'); };
  f.safari.routeAvailable = sku => sku !== white.sku;
  f.safari.prepareSelections = async (selections, check, _yield, options) => {
    check();
    assert.equal(selections.length,2);
    assert.equal(options.allowPartial,true);
    return { partial:true };
  };
  await f.c.tick();
  assert.equal(f.c.phase,'preparing');
  assert.equal(f.fleet.enabled,true);
  f.advance(5001);
  await f.c.tick();
  assert.equal(f.c.phase,'watching');
  assert.match(f.c.message,/Una sola finestra/);
  const available = [{id:'R119',state:'available'}];
  f.c.signal({sku:white.sku,stores:available});
  await settle();
  assert.equal(f.storage.statistics.checkoutAttempts,0);
  assert.equal(f.fleet.enabled,true);
  f.c.signal({sku:selection.sku,stores:available});
  await settle();
  assert.equal(f.storage.statistics.checkoutAttempts,1);
  assert.equal(f.safari.clicks,1);
});

for (const outcome of ['ready', 'stale', 'checkout-present', 'apple-wait', 'manual-stop']) {
  test('stock during verified sibling recovery respects ' + outcome, async t => {
    const f = fixture(t), white = whiteSelection();
    await f.c.select(selection, [white]);
    f.c.enabled = true;
    f.c.phase = 'watching';
    f.safari.page = { phase:'pickup', ready:true, pending:false, pickupUnavailable:true };
    f.safari.readyForCheckout = sku => sku === selection.sku;
    f.safari.prepareCheckout = async (chosen,storeId) => {
      if(chosen.sku === selection.sku) return {store:{id:storeId}};
      throw Object.assign(Error('STOCK_FAILED'), { freshPickupRefusalVerified:true });
    };
    f.safari.transition = async () => f.safari.page = { phase:'bag', ready:true, pending:false };
    f.c.signal({ sku:white.sku, stores:[{ id:'R119', state:'available' }] });
    await settle();
    assert.equal(f.c.phase, 'preparing');
    assert.equal(f.fleet.enabled, false);

    let entered, finish;
    const preparing = new Promise(resolve => { entered = resolve; });
    const pending = new Promise(resolve => { finish = resolve; });
    f.safari.prepareSelections = async (_selections, check, shouldYield, { rebuildSKU, onPreparedSibling }) => {
      assert.equal(rebuildSKU, white.sku);
      await onPreparedSibling();
      entered();
      await pending;
      check();
      if (outcome === 'checkout-present') throw Error('EXISTING_CHECKOUT');
      assert.equal(shouldYield(),outcome==='ready');
      return { prepared:true };
    };
    const tick = f.c.tick();
    await preparing;
    assert.equal(f.fleet.enabled, true);
    assert.equal(f.c.phase, 'preparing');
    f.c.signal({ sku:selection.sku, stores:[{ id:'R119', state:'available' }] });
    assert.equal(f.storage.statistics.checks, 2);
    assert.equal(f.storage.statistics.checkoutAttempts, 1);
    assert.equal(f.c.pendingAvailability.sku,selection.sku);
    if (outcome === 'stale') f.advance(5001);
    if (outcome === 'manual-stop') await f.c.activation(false);
    if (outcome === 'apple-wait') {
      f.fleet.paused = true;
      f.c.state('intervention', 'Apple richiede attesa.');
    }
    finish();
    await tick;
    await settle();
    assert.equal(f.c.phase, outcome === 'ready' ? 'payment-observation' : outcome === 'stale' ? 'watching' : outcome === 'manual-stop' ? 'stopped' : 'intervention');
    assert.equal(f.fleet.enabled, outcome === 'stale' || outcome === 'apple-wait');
    if (outcome === 'apple-wait') {
      f.advance(5001);
      await f.c.tick();
      assert.equal(f.c.phase, 'intervention');
      assert.equal(f.fleet.paused, true);
    }
    assert.equal(f.safari.clicks, outcome === 'ready' ? 1 : 0);
    assert.equal(f.storage.guard.phase, outcome === 'ready' ? 'waiting' : 'idle');
  });
}

test('bag preparation reconciles a lost read and a loading document without replaying navigation or checkout', async()=>{
  let clock=0,reads=0,phase='bag';const actions=[];const s=new SafariSession({bindingPath:null,now:()=>clock,sleep:async ms=>{clock+=ms;}});
  s.inspect=async()=>{reads++;if(reads===1)throw Error('SAFARI_SCRIPT_UNAVAILABLE');return{phase,ready:reads>2,pending:false,applePayEntryReady:true,applePayRoute:phase==='pickup',fulfillmentMode:phase==='pickup'?'pickup':null};};
  s.evaluate=async(_,p)=>{assert.equal(p.action,'bag-total-check');return{valid:true,empty:false};};s.action=async a=>{actions.push(a);if(a==='checkout')phase='pickup';return{requested:true};};
  await s.prepareBag(selection,()=>{});assert.equal(phase,'pickup');assert.deepEqual(actions,['checkout']);assert.ok(clock<=300);
});

test('preparation rebuilds a pickup page with a residual stock rejection while preserving the healthy-page fast path', async()=>{
  let phase='pickup',rejected=true;const actions=[];const s=new SafariSession({bindingPath:null});
  s.inspect=async()=>({phase,ready:true,pending:false,applePayRoute:phase==='pickup',applePayEntryReady:true,fulfillmentMode:'pickup',stockFailure:rejected,errors:rejected?2:0});
  s.evaluate=async(_,p)=>{assert.equal(p.action,'bag-total-check');return{valid:true,empty:false};};s.action=async a=>{actions.push(a);if(a==='navigate')phase='bag';if(a==='checkout'){phase='pickup';rejected=false;}return{requested:true};};
  await s.prepareBag(selection,()=>{});assert.deepEqual(actions,['navigate','checkout']);assert.equal(rejected,false);
});

test('transport retirement reuses the verified replacement proof while preserving close-disconnect-connect ordering', async t=>{
  const {f,adapters,events,advance}=fleetFixture();t.after(()=>f.stop());const proofs=Array(20).fill(0);
  for(let i=0;i<adapters.length;i++){const network=adapters[i].network;adapters[i].network=async()=>{proofs[i]++;return network();};}
  await f.start(selection);clearInterval(f.timer);await f.maintenance;proofs.fill(0);events.length=0;
  adapters[1].sample=async()=>{throw Error('transport')};f.nodes[0].nextAllowedAt=f.now()+65000;advance(1);f.tick();await settle();await f.pool.drain();await settle();
  assert.equal(f.nodes[8].verified,true);assert.equal(proofs[8],1);assert.equal(f.nodes[0].connected,true);
  const close=events.findIndex(e=>e[0]==='close'&&e[1]===2),disconnect=events.findIndex(e=>e[0]==='disconnect'&&e[1]===2),connect=events.findIndex(e=>e[0]==='connect'&&e[1]===9);assert.ok(close>=0&&disconnect>close&&connect>disconnect);
});

test('manual deactivation while restoring delivery-only pickup prevents recovery from reactivating search', async t => {
  const f=fixture(t);f.c.enabled=true;f.c.phase='watching';f.safari.page={phase:'pickup',ready:true,pickupUnavailable:true};f.safari.prepareCheckout=async()=>{throw Error('STOCK_FAILED')};let finish;
  f.safari.refreshPickup=async check=>{await new Promise(resolve=>{finish=resolve});check();f.safari.page.pickupUnavailable=false;};
  f.c.startCheckout('R119');await settle();assert.equal(typeof finish,'function');await f.c.activation(false);finish();await settle();
  assert.equal(f.c.enabled,false);assert.equal(f.c.phase,'stopped');assert.equal(f.fleet.enabled,false);assert.equal(f.safari.clicks,0);
});

test('fresh verified pickup availability resumes the same attempt immediately, through normal payment guards', async t=>{
  for(const failsAgain of [false,true]){
    const f=fixture(t);f.c.enabled=true;f.c.phase='watching';let prepares=0,refreshes=0;
    f.safari.page={phase:'pickup',ready:true,pending:false,fulfillmentMode:'pickup'};
    f.safari.prepareCheckout=async()=>{prepares++;if(prepares===1||failsAgain){f.safari.page={phase:'pickup',ready:true,pending:false,pickupUnavailable:true};throw Error('STOCK_FAILED');}return{store:{id:'R119'}};};
    f.safari.refreshPickup=async check=>{check();refreshes++;f.safari.page={phase:'pickup',ready:true,pending:false,fulfillmentMode:'pickup',fulfillmentResponseVerified:true,storeState:'unselected',errors:0};};
    f.safari.transition=async()=>{f.safari.bagVisits++;f.safari.page={phase:'bag',ready:true,pending:false};return f.safari.page;};
    f.c.startCheckout('R119');await settle();
    assert.equal(prepares,2);assert.equal(refreshes,1);assert.equal(f.storage.statistics.checkoutAttempts,1);
    assert.ok(f.storage.statistics.checkoutHistory.some(e=>e.code==='PICKUP_AVAILABILITY_RECOVERED'));
    assert.equal(f.safari.clicks,failsAgain?0:1);assert.equal(f.safari.bagVisits,failsAgain?1:0);
    if(!failsAgain)assert.equal(f.storage.guard.phase,'waiting');
  }
});
test('pickup availability recovery requires a verified response and preserves manual stop and payment uncertainty', async t=>{
  for(const unsafe of ['unverified','unavailable','missing','manual-stop','native-active','intent']){
    const f=fixture(t);f.c.enabled=true;f.c.currentStore='R119';f.c.checkoutStartedAt=f.now();f.safari.page={phase:'pickup',ready:true,pending:false,pickupUnavailable:true};
    f.safari.refreshPickup=async()=>{f.safari.page={phase:'pickup',ready:true,pending:false,fulfillmentMode:'pickup',fulfillmentResponseVerified:unsafe!=='unverified',storeState:['missing','unavailable'].includes(unsafe)?unsafe:'unselected',errors:0};if(unsafe==='manual-stop')f.c.enabled=false;if(unsafe==='native-active')f.safari.ui.active=true;if(unsafe==='intent')f.storage.guard.phase='intent';};
    const run=f.c.resumeAfterStockFailure(()=>{if(!f.c.enabled)throw Error('STOPPED')});
    if(['manual-stop','native-active','intent'].includes(unsafe))await assert.rejects(run,/STOPPED|EXISTING_CHECKOUT/);else await run;
    assert.ok(!f.c.recoveredPickupReady);assert.equal(f.safari.clicks,0);assert.ok(!f.storage.statistics.checkoutHistory.some(e=>e.code==='PICKUP_AVAILABILITY_RECOVERED'));
  }
});

test('verified checkout milestones persist once per attempt across recovery and process reload',async t=>{
  const f=fixture(t);f.storage.saveSettings();f.storage.statistics.checkoutAttempts=1;f.c.currentStore='R119';
  for(const code of ['STORE_VERIFIED','PICKUP_TIME_NOT_OFFERED'])f.c.recordCheckoutEvent(code);
  assert.equal(f.storage.statistics.checkoutProgress.store,0);
  for(const code of ['PICKUP_STORE_SELECTED','PICKUP_DATE_SELECTED','PICKUP_TIME_SELECTED','PICKUP_DATE_SELECTED','PICKUP_TIME_SELECTED','PICKUP_STORE_SELECTED'])f.c.recordCheckoutEvent(code);
  let storage=new AppStorage(f.dir);assert.deepEqual(['store','date','time'].map(k=>storage.statistics.checkoutProgress[k]),[1,1,1]);
  const c=new PurchaseController({storage,safari:f.safari,fleet:f.fleet,catalog:f.catalog,now:f.now});c.currentStore='R119';c.recordCheckoutEvent('PICKUP_STORE_SELECTED');
  storage.statistics.checkoutAttempts=2;c.recordCheckoutEvent('PICKUP_STORE_SELECTED');c.recordCheckoutEvent('PICKUP_DATE_SELECTED');
  storage=new AppStorage(f.dir);assert.deepEqual(['store','date','time'].map(k=>storage.statistics.checkoutProgress[k]),[2,2,1]);
  assert.equal(storage.statistics.checkoutHistory.filter(e=>e.attempt===1&&e.code==='PICKUP_DATE_SELECTED').length,1);
});
test('new progress statistics preserve historical attempts without inventing missing selections',t=>{
  const f=fixture(t),path=f.dir+'/statistics.json',old=structuredClone(f.storage.statistics);delete old.checkoutProgress;old.checkoutAttempts=77;old.checks=4000;writeFileSync(path,JSON.stringify(old));
  const storage=new AppStorage(f.dir);assert.equal(storage.statistics.checkoutAttempts,77);assert.equal(storage.statistics.checks,4000);assert.equal(storage.statistics.checkoutProgress.store,0);assert.match(storage.statistics.checkoutProgress.sinceJST,/ JST$/);assert.deepEqual(new AppStorage(f.dir).statistics.checkoutProgress,storage.statistics.checkoutProgress);
});
test('fleet configuration uses ten positions and ten verified tunnels while preserving timing limits',async t=>{
  const f=fixture(t);
  Object.assign(f.storage.settings, {positions:10, vpnLimit:10, workerCount:19, nordLimit:10});
  f.storage.saveSettings();
  const app=createApplication({storage:new AppStorage(f.dir),catalog:f.catalog,safari:f.safari,notify:()=>{},now:f.now}).fleet;
  for(let i=0;i<10;i++)Object.assign(app.nodes[i],{connected:true,verified:true,phase:'ready'});
  assert.equal(app.snapshot().vpnLimit,10);assert.equal(app.snapshot().positions,10);assert.equal(app.dispatchInterval(),6500);assert.equal(app.snapshot().throughput.theoreticalPerMinute,600000/65000);
  for(const invalid of [{positions:11,vpnLimit:10},{positions:10,vpnLimit:11},{positions:10,vpnLimit:8}]){f.storage.settings={...f.storage.settings,...invalid};f.storage.saveSettings();assert.throws(()=>new AppStorage(f.dir),/SETTINGS_INVALID/);}
});

test('ten-node dispatch stays stable for six simulated cycles, never samples a reserve or shortens a ledger',async()=>{
  const {f,inventory,events,adapters,advance}=fleetFixture({positions:10,vpnLimit:10}),starts=[];
  for(let i=0;i<19;i++)adapters[i].sample=async s=>{starts.push({i,at:f.now()});return{sku:s.sku,observedAt:f.now(),stores:[]};};
  await f.start(selection);clearInterval(f.timer);await f.maintenance;await settle();
  assert.equal(f.snapshot().verifiedTunnels,10);assert.equal(Object.values(inventory).filter(n=>n.connected).length,10);
  for(let n=0;n<60;n++){if(n)advance(6500);f.tick();await settle();assert.equal(f.snapshot().verifiedTunnels,10);assert.ok(f.active.length<=10);}
  assert.equal(starts.length,60);assert.equal(new Set(starts.map(s=>s.i)).size,10);
  for(let i=0;i<10;i++){const own=starts.filter(s=>s.i===i);assert.equal(own.length,6);assert.ok(own.every((s,j)=>j===0||s.at-own[j-1].at>=65000));}
  assert.ok(starts.every((s,j)=>j===0||s.at-starts[j-1].at>=6500));assert.ok(!events.some(([op,n])=>op==='disconnect'&&n===1));await f.stop();
});

test('account connection pause preserves stock progress and later fills the tenth verified route without a restart',async()=>{
  const {f,inventory,events,adapters,advance,samples}=fleetFixture({positions:10,vpnLimit:10});
  for(let i=1;i<=19;i++)inventory[i]=i<=8?{connected:true,pinned:true}:{connected:false,connectNextAllowedInMs:600000};
  adapters[19].network=async()=>{throw Error('HOST_UNVERIFIED')};
  await f.start(selection);clearInterval(f.timer);await f.maintenance;await settle();
  assert.equal(f.snapshot().verifiedTunnels,8);assert.ok(!events.some(([op])=>op==='connect'));
  for(let n=0;n<16;n++){if(n)advance(8125);f.tick();await settle();}
  assert.equal(samples.length,16);assert.ok(!events.some(([op])=>op==='connect'));
  advance(600001);for(let i=9;i<=19;i++)inventory[i].connectNextAllowedInMs=0;
  f.maintain();await f.maintenance;await settle();assert.equal(f.snapshot().verifiedTunnels,10);
  assert.equal(events.filter(([op])=>op==='connect').length,2);assert.ok(!events.some(([op])=>op==='disconnect'));await f.stop();
});

test('VPN reserve pause remains separate from the Apple ledger and malformed pause data blocks promotion',async()=>{
  const {f,inventory,events}=fleetFixture({positions:10,vpnLimit:10});
  inventory[9]={connected:false,connectNextAllowedInMs:600000,nextAllowedInMs:65000};await f.pool.refresh();
  assert.equal(f.nodes[8].nextAllowedAt,f.now()+65000);assert.equal(f.nodes[8].nextVpnAllowedAt,f.now()+600000);assert.equal(f.eligible(8,f.now()+65001),false);assert.equal(f.eligible(8,f.now()+600001),true);
  assert.equal(f.snapshot().nodes[8].nextVpnAllowedAt,f.now()+600000);
  inventory[9].connectNextAllowedInMs='unknown';await assert.rejects(f.pool.refresh(),/VPN_CONNECT_PAUSE_UNVERIFIED/);assert.ok(!events.some(([op])=>op==='connect'));
});

const whiteSelection = () => ({...selection,sku:'BBBB2J/A',name:'Test device 256GB White',names:['Test device 256GB White'],url:'https://www.apple.com/jp/shop/product/BBBB2J/A'});
test('two colours select the first live signal and share one durable payment intent',async t=>{
 const f=fixture(t),white=whiteSelection();await f.c.select(selection,[white]);f.c.enabled=true;f.c.phase='watching';let release,chosen;const gate=new Promise(r=>release=r);
 f.safari.prepareCheckout=async s=>{chosen=s;await gate;return{store:{id:'R119'}};};
 f.c.signal({sku:white.sku,observedAt:f.now(),stores:[{id:'R119',state:'available'}]});
 f.c.signal({sku:selection.sku,observedAt:f.now(),stores:[{id:'R119',state:'available'}]});
 assert.equal(chosen.sku,white.sku);assert.equal(f.safari.clicks,0);release();await settle();
 assert.equal(f.safari.clicks,1);assert.equal(f.storage.guard.attempt.selection.sku,white.sku);assert.equal(f.c.snapshot().targetQuantity,1);
 f.c.signal({sku:selection.sku,stores:[{id:'R119',state:'available'}]});await settle();assert.equal(f.safari.clicks,1);
});
test('a withdrawal for black does not withdraw a queued white signal at the same Store',async t=>{
 const f=fixture(t),white=whiteSelection();await f.c.select(selection,[white]);f.c.enabled=true;f.c.phase='watching';f.c.busy=true;
 f.c.signal({sku:white.sku,observedAt:f.now(),stores:[{id:'R119',state:'available'}]});
 f.advance(1);f.c.signal({sku:selection.sku,observedAt:f.now(),stores:[{id:'R119',state:'unavailable'}]});
 assert.equal(f.c.pendingAvailability.sku,white.sku);f.c.busy=false;f.c.dispatchPendingAvailability();await settle();assert.equal(f.storage.guard.attempt.selection.sku,white.sku);
});
test('a recovered white payment preserves its SKU and a confirmed order stops both colours',async t=>{
 const f=fixture(t),white=whiteSelection();await f.c.select(selection,[white]);f.c.enabled=true;f.c.phase='watching';f.c.signal({sku:white.sku,stores:[{id:'R119',state:'available'}]});await settle();f.storage.saveSettings();
 const reloaded=new AppStorage(f.dir),calls=[];f.safari.expected=(s,id)=>calls.push([s.sku,id]);
 const recovered=new PurchaseController({storage:reloaded,safari:f.safari,fleet:f.fleet,catalog:f.catalog,now:f.now});assert.equal(calls[0][0],white.sku);assert.equal(recovered.current.selection.sku,white.sku);
 f.safari.page={phase:'success',confirmation:true,ready:true,pending:false};await recovered.observePayment();assert.equal(recovered.storage.guard.phase,'completed');assert.equal(recovered.storage.statistics.history.at(-1).sku,white.sku);
 await assert.rejects(recovered.activation(true),/ORDER_ALREADY_CONFIRMED/);assert.equal(f.safari.clicks,1);
});
test('alternative configurations reject changed price, product, capacity and duplicate SKU',async t=>{
 const f=fixture(t);for(const a of [{...whiteSelection(),priceJPY:99999},{...whiteSelection(),productId:selection.productId+'-other'},{...whiteSelection(),name:'Test device 512GB White'},{...selection}])await assert.rejects(f.c.select(selection,[a]),/SELECTION_INVALID/);
});
test('queued alternative colour never ages or supersedes an earlier still-fresh colour',async t=>{
 const f=fixture(t),white=whiteSelection();await f.c.select(selection,[white]);f.c.enabled=true;f.c.phase='watching';f.c.busy=true;
 f.c.signal({sku:selection.sku,observedAt:f.now(),stores:[{id:'R119',state:'available'}]});f.advance(100);f.c.signal({sku:white.sku,observedAt:f.now(),stores:[{id:'R119',state:'available'}]});assert.equal(f.c.pendingAvailability.sku,selection.sku);
 f.advance(5100);f.c.busy=false;f.c.dispatchPendingAvailability();await settle();assert.equal(f.safari.clicks,0);
});
test('fleet alternates colours without changing dispatch spacing or per-node response ledgers',async t=>{
 const {f,adapters,advance}=fleetFixture({positions:6,vpnLimit:6}),seen=[];t.after(()=>f.stop());for(const a of adapters)a.sample=async s=>{seen.push(s.sku);return{sku:s.sku,observedAt:f.now(),stores:[]};};
 await f.start([selection,whiteSelection()]);await f.maintenance;await settle();for(let i=0;i<6;i++){advance(10834);f.tick();await settle();}
 assert.ok(seen.length>=4);for(let i=1;i<seen.length;i++)assert.notEqual(seen[i],seen[i-1]);assert.equal(f.outcomes.stockValidation,0);assert.equal(f.dispatchInterval(),10834);
});

test('selection API resolves both colours from the catalogue and persists only one alternative',async t=>{
 const f=fixture(t),white=whiteSelection();f.catalog.resolve=async(p,sku)=>{if(p!==selection.productId||![selection.sku,white.sku].includes(sku))throw Error('PRODUCT_NOT_IN_CATALOG');return structuredClone(sku===white.sku?white:selection);};
 const server=createHTTPServer({controller:f.c,catalog:f.catalog},{port:0});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(r=>server.close(r)));const base='http://127.0.0.1:'+server.address().port;
 const post=body=>fetch(base+'/api/selection',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify(body)});
 let r=await post({productId:selection.productId,sku:selection.sku,stores:['R119'],alternativeSkus:[white.sku]});assert.equal(r.status,200);let v=await r.json();assert.deepEqual(v.selections.map(s=>s.sku),[selection.sku,white.sku]);assert.equal(v.targetQuantity,1);assert.equal(new AppStorage(f.dir).settings.alternativeSelections[0].sku,white.sku);
 r=await post({productId:selection.productId,sku:selection.sku,stores:['R119'],alternativeSkus:[white.sku,white.sku]});assert.equal(r.status,400);
});

test('a failed first colour immediately consumes the still-fresh other-colour candidate',async t=>{
 const f=fixture(t),white=whiteSelection(),visited=[];await f.c.select(selection,[white]);f.c.enabled=true;f.c.phase='watching';f.c.busy=true;f.safari.page={phase:'pickup',ready:true,pending:false,fulfillmentMode:'pickup'};
 f.safari.prepareCheckout=async(s,id)=>{visited.push(s.sku);if(s.sku===selection.sku)throw Error('STOCK_FAILED');return{store:{id}};};
 f.c.signal({sku:selection.sku,observedAt:f.now(),stores:[{id:'R119',state:'available'}]});f.advance(1);f.c.signal({sku:white.sku,observedAt:f.now(),stores:[{id:'R119',state:'available'}]});assert.equal(f.c.signalQueue.size,2);
 f.c.busy=false;f.c.dispatchPendingAvailability();await settle();assert.deepEqual(visited,[selection.sku,white.sku]);assert.equal(f.safari.clicks,1);assert.equal(f.storage.guard.attempt.selection.sku,white.sku);
});
test('a live other-colour reply draining during checkout survives a verified refusal and skips mode recovery', async t => {
 const app=fixture(t), {f,adapters,advance}=fleetFixture(), white=whiteSelection();
 const replies=[], deliveries=new Map(), visited=[];
 t.after(async()=>{const stopped=f.stop();for(const deliver of deliveries.values())deliver();await stopped;});
 app.c.fleet=f;
 await app.c.select(selection,[white]);
 app.c.enabled=true;app.c.phase='watching';
 f.onSignal=sample=>{replies.push(sample);app.c.signal(sample);};
 for (const adapter of adapters) adapter.sample=s=>new Promise(resolve=>{
   deliveries.set(s.sku,()=>resolve({sku:s.sku,observedAt:f.now(),stores:[{id:'R119',state:'available'}]}));
 });
 let refuse;
 app.safari.prepareCheckout=async(s,storeId)=>{
   visited.push(s.sku);
   if(s.sku===selection.sku)await new Promise((_resolve,reject)=>{refuse=()=>reject(Error('STOCK_FAILED'));});
   return {store:{id:storeId}};
 };
 app.safari.readyForCheckout=sku=>sku===white.sku;
 app.safari.page={phase:'pickup',fulfillmentMode:'pickup',ready:true,pending:false,pickupUnavailable:true,errors:1};
 let refreshed=0;
 app.safari.refreshPickup=async()=>{refreshed++;throw Error('UNNECESSARY_MODE_RECOVERY');};
 await f.start([selection,white]);
 clearInterval(f.timer);
 await f.maintenance;await settle();
 f.tick();
 const spacing=f.dispatchInterval();
 advance(spacing);app.advance(spacing);f.tick();
 assert.equal(deliveries.size,2);
 deliveries.get(selection.sku)();await settle();
 assert.deepEqual(visited,[selection.sku]);assert.equal(f.enabled,false);
 deliveries.get(white.sku)();await settle();
 assert.equal(replies[1].canCheckout,false);assert.equal(replies[1].canQueueDuringCheckout,true);
 assert.equal(app.c.pendingAvailability.sku,white.sku);assert.equal(app.safari.clicks,0);
 refuse();await settle();
 assert.deepEqual(visited,[selection.sku,white.sku]);assert.equal(refreshed,0);
 assert.equal(app.safari.clicks,1);assert.equal(app.storage.guard.attempt.selection.sku,white.sku);
 assert.equal(app.c.pendingAvailability,null);
});
test('drained other-colour signals still expire, respect withdrawals and cannot cross a payment intent', async t => {
 for (const boundary of ['stale','withdrawn','payment-intent']) {
   const app=fixture(t), white=whiteSelection();
   await app.c.select(selection,[white]);app.c.enabled=true;app.c.phase='watching';
   let finish;
   app.safari.prepareCheckout=()=>new Promise((resolve,reject)=>{finish=()=>boundary==='payment-intent'?resolve({store:{id:'R119'}}):reject(Error('STOCK_FAILED'));});
   app.safari.page={phase:'pickup',fulfillmentMode:'pickup',ready:true,pending:false};
   app.c.signal({sku:selection.sku,stores:[{id:'R119',state:'available'}]});
   const other={sku:white.sku,observedAt:app.now(),canCheckout:false,canQueueDuringCheckout:true,stores:[{id:'R119',state:'available'}]};
   if(boundary==='payment-intent'){finish();await settle();}
   app.c.signal(other);
   if(boundary==='stale')app.advance(5001);
   if(boundary==='withdrawn')app.c.signal({...other,stores:[{id:'R119',state:'unavailable'}]});
   assert.equal(app.c.pendingAvailability,null);
   if(boundary!=='payment-intent')finish();
   await settle();
   assert.equal(app.storage.statistics.checkoutAttempts,1);
   assert.equal(app.safari.clicks,boundary==='payment-intent'?1:0);
 }
});
test('the pipeline trace separates signal delivery, queue wait and end-to-end latency',async t=>{
 const f=fixture(t);f.c.enabled=true;f.c.phase='watching';f.c.busy=true;f.c.signal({sku:selection.sku,observedAt:f.now()-1500,node:'pilot2',requestStartedAt:f.now()-3000,stores:[{id:'R119',state:'available'}]});f.advance(500);f.c.busy=false;f.c.dispatchPendingAvailability();await settle();
 const trace=f.storage.checkoutTimings.at(-1);assert.equal(trace.signalAgeAtReceiptMs,1500);assert.equal(trace.queueWaitMs,500);assert.equal(trace.signalToStartMs,2000);assert.equal(trace.endToEndMs,trace.totalMs+2000);assert.equal(trace.nodeRequestMs,1500);assert.equal(trace.node,'pilot2');
 f.storage.saveCheckoutTiming({...trace,privateURL:'https://private.invalid',firstName:'private-contact',queueBlockedBy:'private-value'});assert.ok(!readFileSync(f.dir+'/checkout-timings.json','utf8').includes('private'));
});
test('a faster prepared Store gets one checkout and the original remains a fresh fallback',async t=>{
 const f=fixture(t),visited=[],stores=['R119','R224'];
 await f.c.select({...selection,stores});f.c.enabled=true;f.c.phase='watching';
 f.safari.page={phase:'pickup',ready:true,pending:false,fulfillmentMode:'pickup'};
 f.safari.preferredPickupStore=async(s,ids)=>{assert.equal(s.sku,selection.sku);assert.deepEqual(ids,stores);return 'R224';};
 f.safari.prepareCheckout=async(_s,id)=>{visited.push(id);if(id==='R224')throw Error('STOCK_FAILED');return{store:{id}};};
 f.c.signal({sku:selection.sku,stores:stores.map(id=>({id,state:'available'}))});
 await settle();
 assert.deepEqual(visited,['R224','R119']);assert.equal(f.safari.clicks,1);
 assert.equal(f.storage.guard.attempt.storeId,'R119');
 assert.ok(f.storage.statistics.checkoutHistory.some(e=>e.storeId==='R224'&&e.code==='PICKUP_PREPARED_STORE_PREFERRED'));
});
test('a withdrawal arriving while prepared Stores are read cannot select the withdrawn Store',async t=>{
 const f=fixture(t),visited=[],stores=['R119','R224'];
 await f.c.select({...selection,stores});f.c.enabled=true;f.c.phase='watching';
 let release;f.safari.preferredPickupStore=()=>new Promise(r=>{release=r;});
 f.safari.prepareCheckout=async(_s,id)=>{visited.push(id);return{store:{id}};};
 f.c.signal({sku:selection.sku,stores:stores.map(id=>({id,state:'available'}))});
 await settle();f.advance(1);
 f.c.signal({sku:selection.sku,stores:[{id:'R224',state:'unavailable'}]});release('R224');
 await settle();assert.deepEqual(visited,['R119']);assert.equal(f.safari.clicks,1);
});
test('a full prepayment page rebuild can yield to the other prepared colour without closing warm stock workers',async t=>{
 const f=fixture(t),white=whiteSelection(),visited=[];await f.c.select(selection,[white]);f.c.enabled=true;f.c.phase='watching';f.c.busy=true;let quiesces=0;
 f.fleet.quiesce=()=>{quiesces++;f.fleet.enabled=false;return Promise.resolve();};f.fleet.stop=async()=>{throw Error('WARM_WORKERS_MUST_NOT_CLOSE');};f.safari.readyForCheckout=sku=>sku===white.sku;f.safari.page={phase:'pickup',ready:true,pending:false,fulfillmentMode:'pickup',stockFailure:true,errors:1};
 f.safari.transition=async()=>{f.safari.page={phase:'bag',ready:true,pending:false};return f.safari.page;};f.safari.prepareCheckout=async s=>{visited.push(s.sku);if(s.sku===selection.sku)throw Error('STOCK_FAILED');return{store:{id:'R119'}};};
 f.c.signal({sku:selection.sku,observedAt:f.now(),stores:[{id:'R119',state:'available'}]});f.advance(1);f.c.signal({sku:white.sku,observedAt:f.now(),stores:[{id:'R119',state:'available'}]});f.c.busy=false;f.c.dispatchPendingAvailability();await settle();assert.deepEqual(visited,[selection.sku,white.sku]);assert.equal(f.safari.clicks,1);assert.ok(quiesces>=1);
});

for(const unsafe of ['none','lost-reply','active-wallet','unknown-native','authentication','observed-session'])test('a certified pre-input refusal is reconciled only after quiet observations: '+unsafe,async t=>{
 const f=fixture(t);f.c.enabled=true;f.c.phase='watching';f.safari.prepareCheckout=async()=>({store:{id:'R119'}});f.safari.pressApplePay=async(s,store,id,before)=>{before();f.safari.clicks++;throw Object.assign(Error('APPLE_PAY_HIT_CHANGED'),unsafe==='lost-reply'?{}:{notDispatched:true});};
 f.c.signal({sku:selection.sku,stores:[{id:'R119',state:'available'}]});await settle();assert.equal(f.storage.guard.phase,'uncertain');assert.equal(f.storage.guard.attempt.dispatchRejected===true,unsafe!=='lost-reply');
 f.safari.page={phase:unsafe==='authentication'?'authentication':'contact',ready:true,pending:false,paymentObserved:unsafe==='observed-session',paymentActive:false,paymentCompleted:false};f.safari.ui={known:unsafe!=='unknown-native',active:unsafe==='active-wallet'};
 await f.c.observePayment();assert.equal(f.safari.bagVisits,0);f.advance(30001);await f.c.observePayment();assert.equal(f.safari.bagVisits,unsafe==='none'?1:0);assert.equal(f.safari.clicks,1);
});

test('stock result polling adapts to guest load without resending a job or accelerating VPN control',async()=>{
 for(const operation of ['sample','network','close']){
  const sleeps=[],ids=new Set();let starts=0,polls=0;const cadence=[200,800,500];
  const run=async(_bin,args)=>{const tokens=[...args.at(-1).matchAll(/'([^']*)'/g)].map(m=>m[1]),body=JSON.parse(Buffer.from(tokens.at(-1),'base64'));ids.add(body.id);if(tokens.includes('/start')){starts++;return{stdout:JSON.stringify({ok:true,pending:true})};}polls++;return{stdout:JSON.stringify(polls<3?{ok:true,pending:true}:{ok:true,result:operation==='sample'?{sku:selection.sku,observedAt:Date.now(),stores:[]}:proof(1)})};};
  const a=createLinuxAdapter(1,{run,spacing:()=>0,sleep:async ms=>sleeps.push(ms),pollInterval:()=>cadence[Math.min(polls,2)]});await(operation==='sample'?a.sample(selection,proof(1).fingerprint):a[operation]());assert.deepEqual(sleeps,operation==='sample'?[200,800,500]:[500,500,500]);assert.equal(starts,1);assert.equal(ids.size,1);
 }
});
test('stock result polling refuses an unbounded or invalid cadence',async()=>{
 for(const [value,want]of [[0,200],[100000,2000],[NaN,500]]){const sleeps=[];const run=async(_bin,args)=>({stdout:JSON.stringify(args.at(-1).includes("'/start'")?{ok:true,pending:true}:{ok:true,result:{sku:selection.sku,observedAt:Date.now(),stores:[]}})});const a=createLinuxAdapter(1,{run,spacing:()=>0,sleep:async ms=>sleeps.push(ms),pollInterval:()=>value});await a.sample(selection,proof(1).fingerprint);assert.deepEqual(sleeps,[want]);}
});

test('an unarmed inventory inspection cannot overwrite a proof after activation changes generation',async t=>{
 const {f,adapters}=fleetFixture();t.after(()=>f.stop());let release,started;const pending=new Promise(r=>release=r),began=new Promise(r=>started=r);adapters[1].network=async()=>{started();await pending;return proof(2);};
 const inspection=f.inspect();await began;f.enabled=true;f.generation++;f.nodes[1].verified=false;release();await inspection;assert.equal(f.nodes[1].verified,false);assert.equal(f.proofs.has(1),false);
});

test('speed-first calendar keeps the open day when it already offers an acceptable future slot',async()=>{
 const began=Date.UTC(2026,10,8,3),calls=[];let selected='';
 const dates=[{id:'date9',label:'November9',disabled:false},{id:'date8',label:'November8',disabled:false}];
 const read=async p=>{calls.push(p.action);assert.notEqual(p.action,'date');if(p.action==='slot')selected=p.value;return{ready:true,selectedDateId:'date9',selectedValue:selected,dates,slots:[{value:'9-10:00-10:15',disabled:false}]};};
 const result=await choosePickupSchedule(read,{checkoutAt:began,now:()=>began,sleep:async()=>{},speedFirst:true});
 assert.equal(result.dateId,'date9');assert.deepEqual(calls,['read','slot','read']);
});

test('speed-first calendar still checks later days if the open day has no future slots',async()=>{
 const began=Date.UTC(2026,10,8,3);let current='date8',selected='';const clicks=[];
 const dates=[{id:'date8',label:'November8',disabled:false},{id:'date9',label:'November9',disabled:false}];
 const read=async p=>{if(p.action==='date'){current=p.dateId;clicks.push(current);}if(p.action==='slot')selected=p.value;return{ready:true,selectedDateId:current,selectedValue:selected,dates,slots:[{value:current==='date8'?'8-10:00-10:15':'9-10:00-10:15',disabled:false}]};};
 assert.equal((await choosePickupSchedule(read,{checkoutAt:began,now:()=>began,sleep:async()=>{},speedFirst:true})).dateId,'date9');assert.deepEqual(clicks,['date9']);
});

test('observed calendar readiness uses a serial 50ms cadence without extending its deadline',async()=>{
 const began=Date.UTC(2026,10,8,3);let clock=began,max=0,inflight=0,reads=0;
 const read=async()=>{inflight++;max=Math.max(max,inflight);reads++;clock+=20;inflight--;return{ready:false,reason:'store-response-pending',readinessWatch:true};};
 await assert.rejects(choosePickupSchedule(read,{checkoutAt:began,now:()=>clock,sleep:async ms=>{clock+=ms;}}),/PICKUP_CALENDAR_TIMEOUT/);
 assert.equal(max,1);assert.equal(reads,400);assert.equal(clock-began,20000);
});

test('an acknowledged guest job that disappears is never relaunched',async()=>{
 let starts=0;const run=async(_bin,args)=>{if(args.at(-1).includes("'/start'")){starts++;return{stdout:'{"ok":true,"pending":true}'}}return{stdout:'{"ok":false,"code":"operation-missing"}'}};
 const a=createLinuxAdapter(1,{run,spacing:()=>0,sleep:async()=>{}});await assert.rejects(a.sample(selection,proof(1).fingerprint));assert.equal(starts,1);
});

test('a lost launch acknowledgement followed by a pending result also prevents relaunch after disappearance',async()=>{
 let starts=0,polls=0;const run=async(_bin,args)=>{if(args.at(-1).includes("'/start'")){starts++;throw Error('LOST_ACK');}return{stdout:JSON.stringify(++polls===1?{ok:true,pending:true}:{ok:false,code:'operation-missing'})};};
 const a=createLinuxAdapter(1,{run,spacing:()=>0,sleep:async()=>{}});await assert.rejects(a.sample(selection,proof(1).fingerprint),e=>e.code==='sample-uncertain');assert.equal(starts,1);assert.equal(polls,2);
});

test('a missing unaccepted job may reuse its ID but produces only one stock request',async()=>{
 let starts=0,polls=0;const ids=new Set();const run=async(_bin,args)=>{const tokens=[...args.at(-1).matchAll(/'([^']*)'/g)].map(x=>x[1]),payload=JSON.parse(Buffer.from(tokens.at(-1),'base64'));ids.add(payload.id);if(tokens.includes('/start')){if(++starts===1)throw Error('NOT_ACCEPTED');return{stdout:'{"ok":true,"pending":true}'}}return{stdout:JSON.stringify(++polls===1?{ok:false,code:'operation-missing'}:{ok:true,result:{sku:selection.sku,observedAt:Date.now(),stores:[]}})}};
 const a=createLinuxAdapter(1,{run,spacing:()=>0,sleep:async()=>{}});await a.sample(selection,proof(1).fingerprint);assert.equal(starts,2);assert.equal(ids.size,1);assert.equal(polls,2);
});


test('transient Safari window loss keeps the original binding when rebinding is ambiguous',async()=>{
  const original={pid:123,window:45,nonce:'original'},calls=[];let lost=true;
  const s=new SafariSession({bindingPath:null,invoke:async r=>{calls.push(r);if(r.operation==='bind')throw Error('SAFARI_AMBIGUOUS');if(lost)throw Error('SAFARI_TAB_CHANGED');return{known:true,active:false};}});
  s.binding=original;s.canRebind=()=>true;
  await assert.rejects(s.bind(),/SAFARI_AMBIGUOUS/);assert.equal(s.binding,original);
  lost=false;await s.bind();assert.equal(s.binding,original);assert.equal(calls.filter(c=>c.operation==='bind').length,1);
});

test('an unsuccessful Apple Pay opening records its proven retry reason before returning to the bag',async t=>{
  for(const [flags,code] of [
    [{terminalFailure:true},'APPLE_PAY_TERMINAL_FAILURE'],
    [{paymentCancelledBeforeAuthorization:true},'APPLE_PAY_CANCELLED'],
    [{prePaymentRejection:true},'APPLE_PAY_PREPAYMENT_REJECTED'],
    [{notDispatched:true},'APPLE_PAY_INPUT_REJECTED']
  ]){
    const f=fixture(t);f.c.enabled=true;await f.c.checkout('R119',()=>{});
    f.safari.page={phase:'pickup',ready:true,pending:false,...flags};
    if(flags.notDispatched)f.c.current.dispatchRejected=true;
    f.advance(30000);await f.c.observePayment();f.advance(2001);await f.c.observePayment();
    assert.equal(f.safari.bagVisits,1);assert.equal(f.storage.statistics.failures,1);
    const events=f.storage.statistics.checkoutHistory.filter(e=>e.code===code);assert.equal(events.length,1);assert.equal(events[0].stage,'payment');assert.equal(events[0].sku,selection.sku);assert.equal(events[0].storeId,'R119');
    assert.equal(f.notices.filter(n=>n.code==='PAYMENT_AUTHORIZE').length,0);
  }
});

test('a rejected native input supplies exact recovery proof and counts the failure once across navigation retries', async t => {
  const f = fixture(t);
  f.c.enabled = true;
  await f.c.checkout('R119', () => {});
  const { id, pressedAt } = f.c.current;
  f.c.current.dispatchRejected = true;
  f.safari.page = { phase:'contact', ready:true, pending:false, paymentDispatched:true };
  const original = f.safari.navigateBag.bind(f.safari);
  let navigations = 0;
  f.safari.navigateBag = async proof => {
    assert.deepEqual(proof, { terminalFailure:{source:'native-input-rejected',attemptId:id,pressedAt} });
    if (++navigations === 1) throw Error('SAFARI_SCRIPT_UNAVAILABLE');
    await original();
  };
  f.advance(30000);
  await f.c.observePayment();
  f.advance(2001);
  await assert.rejects(f.c.observePayment(), /SAFARI_SCRIPT_UNAVAILABLE/);
  await f.c.observePayment();
  assert.equal(navigations,2);
  assert.equal(f.storage.statistics.failures,1);
  assert.equal(f.storage.guard.phase,'idle');
  assert.equal(f.c.phase,'preparing');
});

test('a proven unposted Apple Pay click resumes only after two quiet readings of the original checkout', async t => {
  for (const boundary of ['none','no-native-proof','no-document-proof','active','observed','pending','previously-opened']) {
    const f = fixture(t);
    f.c.enabled = true; f.c.phase = 'watching';
    f.safari.pressApplePay = async (_selection,_store,_attempt,before) => {
      before();
      throw Object.assign(Error('APPLE_PAY_HIT_CHANGED'),{notDispatched:boundary!=='no-native-proof'});
    };
    f.c.signal({sku:selection.sku,stores:[{id:'R119',state:'available'}]});
    await settle();
    assert.equal(f.storage.guard.phase,'uncertain');
    f.safari.page = {phase:'contact',ready:true,pending:boundary==='pending',
      inputRejectionReady:boundary!=='no-document-proof',paymentObserved:boundary==='observed'};
    f.safari.ui = {known:true,active:boundary==='active',kind:boundary==='active'?'apple-pay':'none'};
    if(boundary==='previously-opened')f.c.current.openedAt=f.now();
    f.advance(1000); await f.c.observePayment();
    assert.equal(f.safari.bagVisits,0);
    f.advance(1999); await f.c.observePayment();
    assert.equal(f.safari.bagVisits,0);
    f.advance(1); await f.c.observePayment();
    assert.equal(f.safari.bagVisits,boundary==='none'?1:0,boundary);
    assert.equal(f.storage.guard.phase,boundary==='none'?'idle':'uncertain');
    assert.equal(f.safari.clicks,0);
    if(boundary==='none')assert.equal(f.notices.filter(n=>n.code==='PAYMENT_UNCERTAIN').length,0);
  }
});

test('only explicit failed Apple Pay completion permits a retry after authorization and quiet observations',async t=>{
 const input={page:{phase:'pickup',ready:true,pending:false,paymentFailed:true},ui:{known:true,active:false},elapsed:30000,stable:true,opened:true};
 assert.equal(paymentDecision(input),'retry');
 for(const patch of [{page:{...input.page,paymentFailed:false,stockFailure:true}},{page:{...input.page,paymentFailed:false,paymentSucceeded:true}},{page:{...input.page,paymentSucceeded:true,paymentCancelledBeforeAuthorization:true,terminalFailure:true}},{stable:false}])assert.equal(paymentDecision({...input,...patch}),'uncertain');
 for(const patch of [{ui:{known:false,active:false}},{ui:{known:true,active:true}},{elapsed:29999},{page:{...input.page,pending:true}}])assert.equal(paymentDecision({...input,...patch}),'wait');
 const f=fixture(t);f.c.enabled=true;await f.c.checkout('R119',()=>{});f.safari.ui={known:true,active:true,kind:'apple-pay'};await f.c.observePayment();f.safari.ui.active=false;f.safari.page=input.page;
 await f.c.observePayment();f.advance(30001);await f.c.observePayment();assert.equal(f.safari.bagVisits,1);assert.equal(f.safari.clicks,1);assert.equal(f.storage.statistics.checkoutHistory.at(-1).code,'APPLE_PAY_COMPLETED_FAILED');
});


test('reviewed native Wallet failure can be reconciled only while stopped, on the same attempt, with a quiet page',async t=>{
 for(const unsafe of ['none','enabled','busy','wrong-attempt','no-review','before-attempt','future','native-active','native-unknown','pending','page-success','page-payment','already-confirmed']){
  const f=fixture(t);f.c.enabled=true;await f.c.checkout('R119',()=>{});const id=f.c.current.id,pressedAt=f.c.current.pressedAt;f.c.enabled=false;f.storage.setGuard('uncertain',f.c.guardAttempt());f.safari.page={phase:'pickup',ready:true,pending:false};f.advance(60000);
  const proof={source:'native-wallet-completed-failure',attemptId:id,failedAt:pressedAt+10000,reviewedNoOrder:true};
  if(unsafe==='enabled')f.c.enabled=true;if(unsafe==='busy')f.c.busy=true;if(unsafe==='wrong-attempt')proof.attemptId='other';if(unsafe==='no-review')proof.reviewedNoOrder=false;if(unsafe==='before-attempt')proof.failedAt=pressedAt-1;if(unsafe==='future')proof.failedAt=f.now()+1;
  if(unsafe==='native-active')f.safari.ui.active=true;if(unsafe==='native-unknown')f.safari.ui.known=false;if(unsafe==='pending')f.safari.page.pending=true;if(unsafe==='page-success')f.safari.page={phase:'success',ready:true,confirmation:true};if(unsafe==='page-payment')f.safari.page.paymentDispatched=true;if(unsafe==='already-confirmed')f.storage.statistics.successes=1;
  if(unsafe!=='none'){await assert.rejects(f.c.reconcileFailedPayment(proof),/PAYMENT_RECONCILIATION_BLOCKED/);assert.equal(f.storage.guard.phase,'uncertain');assert.ok(f.c.current);assert.equal(f.safari.bagVisits,0);continue;}
  await f.c.reconcileFailedPayment(proof);assert.equal(f.storage.guard.phase,'failed');assert.equal(f.storage.guard.attempt.id,id);assert.equal(f.storage.guard.attempt.resolution.source,proof.source);assert.equal(f.storage.statistics.failures,1);assert.equal(f.c.phase,'stopped');assert.equal(f.c.current,null);assert.equal(f.safari.bagVisits,0);assert.equal(f.safari.clicks,1);
 }
});

test('reviewed pickup refusal requires the same inactive payment attempt and a verified return to the bag',async t=>{
 for(const boundary of ['none','no-review','wrong-attempt','no-refusal','native-active','page-completed','failed-navigation']){
  const f=fixture(t);f.c.enabled=true;await f.c.checkout('R119',()=>{});
  f.c.enabled=false;f.storage.setGuard('uncertain',f.c.guardAttempt());
  const {id,pressedAt}=f.c.current;
  f.safari.page={phase:'pickup',applePayRoute:true,ready:true,paymentAttemptMatches:boundary!=='wrong-attempt',
    merchantDiagnostics:boundary==='no-refusal'?[]:['PICKUP_UNAVAILABLE'],paymentCompleted:boundary==='page-completed'};
  f.safari.ui.active=boundary==='native-active';
  const navigate=f.safari.navigateBag.bind(f.safari);
  f.safari.navigateBag=async options=>{
   assert.deepEqual(options,{terminalFailure:{source:'operator-reviewed-pickup-refusal',attemptId:id,pressedAt}});
   if(boundary==='failed-navigation')throw Error('PAGE_TRANSITION_UNCERTAIN');
   return navigate();
  };
  const proof={source:'operator-reviewed-pickup-refusal',attemptId:id,reviewedNoOrder:boundary!=='no-review',pickupRefusalReported:true};
  if(boundary==='none'){
   await f.c.reconcileFailedPayment(proof);
   assert.equal(f.storage.guard.phase,'failed');
   assert.equal(f.storage.guard.attempt.id,id);
   assert.equal(f.storage.guard.attempt.resolution.source,proof.source);
   assert.equal(f.c.prepaymentGuardClear(),true);
  }else{
   await assert.rejects(f.c.reconcileFailedPayment(proof),/PAYMENT_RECONCILIATION_BLOCKED|PAGE_TRANSITION_UNCERTAIN/);
   assert.equal(f.storage.guard.phase,'uncertain');
  }
  assert.equal(f.safari.bagVisits,boundary==='none'?1:0);
  assert.equal(f.safari.clicks,1);
 }
});


test('a verified terminal native Wallet failure resumes after a page replacement without replaying payment',async t=>{
 for(const unsafe of ['none','no-proof','reopened','success']){
  const f=fixture(t);f.c.enabled=true;await f.c.checkout('R119',()=>{});f.safari.ui={known:true,active:true,kind:'apple-pay'};await f.c.observePayment();f.safari.ui.active=false;f.safari.page={phase:'contact',ready:true,pending:false,paymentSucceeded:unsafe==='success'};f.advance(30000);let reads=0;
  f.c.readWalletFailure=async()=>{reads++;if(unsafe==='reopened')f.safari.ui.active=true;return unsafe==='no-proof'?null:{source:'native-wallet-completed-failure',failedAt:f.c.current.pressedAt+10000};};
  await f.c.observePayment();
  if(unsafe==='none'){
   assert.equal(f.storage.guard.phase,'uncertain');assert.equal(f.safari.bagVisits,0);
   assert.equal(f.notices.some(n=>n.code==='PAYMENT_UNCERTAIN'),false);
  }
  if(unsafe==='no-proof')assert.ok(f.notices.some(n=>n.code==='PAYMENT_UNCERTAIN'));
  f.advance(2001);await f.c.observePayment();
  assert.equal(reads,unsafe==='success'?0:1);assert.equal(f.safari.clicks,1);assert.equal(f.safari.bagVisits,unsafe==='none'?1:0);
  if(unsafe==='none'){assert.equal(f.c.phase,'preparing');assert.equal(f.storage.statistics.failures,1);assert.ok(f.storage.statistics.checkoutHistory.some(e=>e.code==='APPLE_PAY_NATIVE_FAILURE_VERIFIED'));}
  else assert.ok(['uncertain','waiting'].includes(f.storage.guard.phase));
 }
});

test('a late Wallet failure can unblock a replaced pickup page after earlier empty log reads', async t => {
  const f = fixture(t);
  f.c.enabled = true;
  await f.c.checkout('R119', () => {});
  f.safari.ui = { known:true, active:true, kind:'apple-pay' };
  await f.c.observePayment();
  f.safari.ui = { known:true, active:false, kind:'none' };
  f.safari.page = { phase:'pickup', ready:true, pending:false, stockFailure:true };
  let reads = 0;
  const failedAt = f.c.current.pressedAt + 765000;
  f.c.readWalletFailure = async () => {
    reads++;
    return f.now() >= failedAt ? { source:'native-wallet-completed-failure', failedAt } : null;
  };
  f.advance(30000);
  await f.c.observePayment();
  f.advance(4999);
  await f.c.observePayment();
  assert.equal(reads, 1);
  assert.equal(f.storage.guard.phase, 'uncertain');
  assert.equal(f.safari.bagVisits, 0);
  f.advance(735001);
  await f.c.observePayment();
  assert.equal(reads, 2);
  assert.equal(f.storage.guard.phase, 'uncertain');
  f.advance(2001);
  await f.c.observePayment();
  assert.equal(f.storage.guard.phase, 'idle');
  assert.equal(f.safari.bagVisits, 1);
  assert.equal(f.safari.clicks, 1);
});

test('an empty Wallet read leaves the guard blocked when the log window ends', async t => {
  const f = fixture(t);
  f.c.enabled = true;
  await f.c.checkout('R119', () => {});
  f.safari.ui = { known:true, active:true, kind:'apple-pay' };
  await f.c.observePayment();
  f.safari.ui = { known:true, active:false, kind:'none' };
  f.safari.page = { phase:'pickup', ready:true, pending:false, stockFailure:true };
  let reads = 0;
  f.c.readWalletFailure = async () => { reads++; return null; };
  f.advance(30000);
  await f.c.observePayment();
  f.advance(870001);
  await f.c.observePayment();
  assert.equal(reads, 1);
  assert.equal(f.storage.guard.phase, 'uncertain');
  assert.equal(f.safari.bagVisits, 0);
});

test('native failure proof survives restart and a later active sheet invalidates it',async t=>{
 const f=fixture(t);f.c.enabled=true;await f.c.checkout('R119',()=>{});f.safari.ui={known:true,active:true,kind:'apple-pay'};await f.c.observePayment();f.safari.ui.active=false;f.safari.page={phase:'contact',ready:true,pending:false};f.advance(30000);f.c.readWalletFailure=async()=>({source:'native-wallet-completed-failure',failedAt:f.c.current.pressedAt+10000});await f.c.observePayment();
 const c=new PurchaseController({storage:new AppStorage(f.dir),safari:f.safari,fleet:f.fleet,catalog:f.catalog,now:f.now});assert.ok(c.current.nativeFailureAt);assert.equal(c.currentStore,'R119');f.safari.ui.active=true;await c.observePayment();assert.equal(c.current.nativeFailureAt,undefined);assert.equal(c.storage.guard.attempt.nativeFailureAt,undefined);assert.equal(f.safari.bagVisits,0);
 const afterReopen=new PurchaseController({storage:new AppStorage(f.dir),safari:f.safari,fleet:f.fleet,catalog:f.catalog,now:f.now,readWalletFailure:async()=>assert.fail('reopened sheet invalidated the old proof')});
 f.safari.ui.active=false;f.advance(5001);await afterReopen.observePayment();assert.equal(afterReopen.storage.guard.phase,'uncertain');assert.equal(f.safari.bagVisits,0);
});

test('a conflicting or persistently unstable Wallet failure still alerts without a retry',async t=>{
 for(const conflicting of [true,false]){
  const f=fixture(t);f.c.enabled=true;await f.c.checkout('R119',()=>{});
  f.safari.ui={known:true,active:true,kind:'apple-pay'};await f.c.observePayment();
  f.safari.ui.active=false;f.safari.page={phase:'contact',ready:true,pending:false};f.advance(30000);
  f.c.readWalletFailure=async()=>({source:'native-wallet-completed-failure',failedAt:f.c.current.pressedAt+10000});
  await f.c.observePayment();
  assert.equal(f.notices.some(n=>n.code==='PAYMENT_UNCERTAIN'),false);
  f.advance(conflicting?1000:3500);f.safari.page={...f.safari.page,...(conflicting?{paymentSucceeded:true}:{stockFailure:true})};
  await f.c.observePayment();
  assert.ok(f.notices.some(n=>n.code==='PAYMENT_UNCERTAIN'));
  assert.equal(f.storage.guard.phase,'uncertain');assert.equal(f.safari.bagVisits,0);assert.equal(f.safari.clicks,1);
 }
});
for(const gap of [{known:false,active:false},{known:true,active:true,kind:'safari-modal'},'thrown-read'])test('a Wallet failure is reverified after a temporary observation gap: '+(typeof gap==='string'?gap:gap.kind??'unknown'),async t=>{
 const f=fixture(t);f.c.enabled=true;await f.c.checkout('R119',()=>{});
 f.safari.ui={known:true,active:true,kind:'apple-pay'};await f.c.observePayment();
 f.safari.ui={known:true,active:false,kind:'none'};f.safari.page={phase:'contact',ready:true,pending:false};
 const at=f.c.current.pressedAt+10000;let reads=0;f.c.readWalletFailure=async()=>{reads++;return{source:'native-wallet-completed-failure',failedAt:at};};
 f.advance(30000);await f.c.observePayment();assert.equal(f.c.current.nativeFailureAt,at);
 if(gap==='thrown-read'){
  const status=f.safari.paymentStatus;f.safari.paymentStatus=async()=>{throw Error('SAFARI_UNCERTAIN');};
  await assert.rejects(f.c.observePayment(),/SAFARI_UNCERTAIN/);f.safari.paymentStatus=status;
 }else{f.safari.ui=gap;await f.c.observePayment();}
 assert.equal(f.storage.guard.phase,'uncertain');
 assert.equal(f.storage.guard.attempt.nativeFailureAt,at);assert.equal(f.storage.guard.attempt.nativeFailureNeedsRecheck,true);
 assert.equal(f.safari.bagVisits,0);assert.equal(reads,1);
 f.safari.ui={known:true,active:false,kind:'none'};f.advance(1000);await f.c.observePayment();
 assert.equal(reads,2);assert.equal(f.storage.guard.attempt.nativeFailureNeedsRecheck,undefined);assert.equal(f.safari.bagVisits,0);
 f.advance(2001);await f.c.observePayment();
 assert.equal(f.storage.guard.phase,'idle');assert.equal(f.safari.bagVisits,1);assert.equal(f.safari.clicks,1);
});
test('an unconfirmed old failure cannot clear a Wallet observation gap',async t=>{
 const f=fixture(t);f.c.enabled=true;await f.c.checkout('R119',()=>{});
 f.safari.ui={known:true,active:true,kind:'apple-pay'};await f.c.observePayment();
 f.safari.ui={known:true,active:false,kind:'none'};f.safari.page={phase:'contact',ready:true,pending:false};
 const at=f.c.current.pressedAt+10000;let reads=0;f.c.readWalletFailure=async()=>({source:'native-wallet-completed-failure',failedAt:at+reads++});
 f.advance(30000);await f.c.observePayment();
 f.safari.ui={known:false,active:false};await f.c.observePayment();
 f.safari.ui={known:true,active:false,kind:'none'};for(let i=0;i<5;i++){f.advance(2100);await f.c.observePayment();}
 assert.equal(f.storage.guard.phase,'uncertain');assert.equal(f.storage.guard.attempt.nativeFailureNeedsRecheck,true);
 assert.equal(reads,3);assert.equal(f.safari.bagVisits,0);assert.equal(f.safari.clicks,1);
});

test('a verified payment failure permits preparation on the next tick, unless the owner stops during bag recovery',async t=>{
 for(const stopped of [false,true]){
  const f=fixture(t);f.c.enabled=true;await f.c.checkout('R119',()=>{});
  f.safari.page={phase:'contact',ready:true,pending:false,paymentFailed:true};
  f.advance(30000);await f.c.observePayment();f.advance(2001);
  const navigate=f.safari.navigateBag.bind(f.safari);
  let entered,release;
  const started=new Promise(r=>{entered=r;}),allow=new Promise(r=>{release=r;});
  f.safari.navigateBag=async()=>{entered();await allow;return navigate();};
  const completion=f.c.tick();await started;
  assert.equal(f.storage.guard.phase,'failed');assert.equal(f.fleet.enabled,false);
  if(stopped)await f.c.activation(false);
  release();await completion;
  if(stopped){
   assert.equal(f.c.phase,'stopped');assert.equal(f.storage.guard.phase,'failed');
   await f.c.tick();assert.equal(f.fleet.enabled,false);
  }else{
   assert.equal(f.c.phase,'preparing');assert.equal(f.storage.guard.phase,'idle');assert.equal(f.c.nextTick,f.now());
   await f.c.tick();assert.equal(f.c.phase,'watching');assert.equal(f.fleet.enabled,true);
  }
  assert.equal(f.safari.bagVisits,1);assert.equal(f.safari.clicks,1);
 }
});


test('controller forwards its retained native proof to bag recovery after a failed payment',async t=>{
 const f=fixture(t);f.c.enabled=true;await f.c.checkout('R119',()=>{});f.c.current.openedAt=f.now();f.c.current.nativeFailureAt=f.now()+1000;f.advance(30000);f.safari.page={phase:'contact',ready:true,pending:false};let passed;
 f.safari.navigateBag=async options=>{passed=options;};const id=f.c.current.id,pressedAt=f.c.current.pressedAt;
 await f.c.observePayment();f.advance(2001);await f.c.observePayment();assert.deepEqual(passed,{terminalFailure:{source:'native-wallet-completed-failure',attemptId:id,pressedAt,failedAt:pressedAt+1000}});assert.equal(f.storage.guard.phase,'idle');assert.equal(f.c.phase,'preparing');
});


test('a VPN operation acknowledged by the guest is never relaunched after its reply journal disappears',async()=>{
 for(const acknowledgement of ['start','pending-result']){
  let starts=0,reads=0;const ids=[];
  const control=createLinuxVpnControl({canChange:()=>true,sleep:async()=>{},execFile:async(_bin,args)=>{const command=args.at(-1);if(command.includes("'start'")){starts++;ids.push(/'start' '([^']+)'/.exec(command)?.[1]);if(acknowledgement==='pending-result')throw Error('lost start reply');return{stdout:'{"ok":true,"pending":true}'};}reads++;return{stdout:JSON.stringify(acknowledgement==='pending-result'&&reads===1?{ok:true,pending:true}:{ok:false,code:'operation-missing'})};}});
  await assert.rejects(control('connect',2));assert.equal(starts,1,acknowledgement);assert.equal(new Set(ids).size,1);
 }
});

test('a VPN operation with no known acceptance can reconcile a missing launch using the same request ID',async()=>{
 let starts=0,reads=0;const ids=[];const control=createLinuxVpnControl({canChange:()=>true,sleep:async()=>{},execFile:async(_bin,args)=>{const command=args.at(-1);if(command.includes("'start'")){starts++;ids.push(/'start' '([^']+)'/.exec(command)?.[1]);if(starts===1)throw Error('unaccepted transport');return{stdout:'{"ok":true,"pending":true}'};}reads++;return{stdout:JSON.stringify(reads===1?{ok:false,code:'operation-missing'}:{ok:true,result:{connected:true,pinned:true}})};}});
 assert.deepEqual(await control('connect',2),{connected:true,pinned:true});assert.equal(starts,2);assert.equal(new Set(ids).size,1);
});


test('merchant diagnostics log only public reasons once and never authorize a payment retry',async t=>{
 const f=fixture(t);f.c.enabled=true;await f.c.checkout('R119',()=>{});f.safari.ui={known:true,active:true,kind:'apple-pay'};await f.c.observePayment();f.safari.ui.active=false;f.safari.page={phase:'contact',ready:true,pending:false,merchantDiagnostics:['PICKUP_UNAVAILABLE','PAYMENT_FAILURE','operator@example.invalid']};f.c.readWalletFailure=async()=>null;f.advance(30000);
 await f.c.observePayment();f.advance(2001);await f.c.observePayment();await f.c.observePayment();
 assert.equal(f.storage.guard.phase,'uncertain');assert.equal(f.safari.bagVisits,0);assert.equal(f.safari.clicks,1);assert.equal(f.storage.statistics.failures,0);
 for(const code of ['MERCHANT_PICKUP_UNAVAILABLE','MERCHANT_PAYMENT_FAILURE'])assert.equal(f.storage.statistics.checkoutHistory.filter(e=>e.code===code).length,1);
 assert.ok(!readFileSync(f.dir+'/statistics.json','utf8').includes('operator@example.invalid'));
});

test('live stock error flags remain diagnostic after authorization, without permitting a payment retry',async t=>{
 const f=fixture(t);f.c.enabled=true;await f.c.checkout('R119',()=>{});
 f.safari.ui={known:true,active:true,kind:'apple-pay'};await f.c.observePayment();
 f.safari.ui.active=false;f.safari.page={phase:'contact',ready:true,pending:false,stockFailure:true,merchantDiagnostics:[]};f.c.readWalletFailure=async()=>null;f.advance(30000);
 await f.c.observePayment();f.advance(2001);await f.c.observePayment();await f.c.observePayment();
 assert.equal(f.storage.statistics.checkoutHistory.filter(e=>e.code==='MERCHANT_STOCK_FAILURE_OBSERVED').length,1);
 assert.equal(f.storage.guard.phase,'uncertain');assert.equal(f.safari.bagVisits,0);assert.equal(f.safari.clicks,1);assert.equal(f.storage.statistics.failures,0);
});

test('a live terminal checkout flag is recorded once during the mandatory payment observation window',async t=>{
 const f=fixture(t);f.c.enabled=true;await f.c.checkout('R119',()=>{});
 f.safari.ui={known:true,active:false,kind:'none'};f.safari.page={phase:'contact',ready:true,pending:false,terminalFailure:true};
 await f.c.observePayment();await f.c.observePayment();
 assert.equal(f.storage.statistics.checkoutHistory.filter(e=>e.code==='MERCHANT_TERMINAL_FAILURE_OBSERVED').length,1);
 assert.equal(f.storage.guard.phase,'waiting');assert.equal(f.safari.bagVisits,0);assert.equal(f.safari.clicks,1);
});

test('diagnostic flags require booleans and never persist merchant text as a reason',async t=>{
 const f=fixture(t);f.c.enabled=true;await f.c.checkout('R119',()=>{});
 f.safari.ui={known:true,active:false,kind:'none'};f.safari.page={phase:'contact',ready:true,pending:false,stockFailure:'private-stock-error',terminalFailure:'private-checkout-error'};
 await f.c.observePayment();
 assert.equal(f.storage.statistics.checkoutHistory.some(e=>['MERCHANT_STOCK_FAILURE_OBSERVED','MERCHANT_TERMINAL_FAILURE_OBSERVED'].includes(e.code)),false);
 const saved=readFileSync(f.dir+'/statistics.json','utf8');assert.ok(!saved.includes('private-stock-error'));assert.ok(!saved.includes('private-checkout-error'));
});

test('an active native authorization sheet is never inspected for new merchant diagnostics',async t=>{
 const f=fixture(t);f.c.enabled=true;await f.c.checkout('R119',()=>{});
 f.safari.ui={known:true,active:true,kind:'apple-pay'};let reads=0;f.safari.inspect=async()=>{reads++;throw Error('AUTHORIZATION_MUST_NOT_BE_INTERRUPTED');};
 await f.c.observePayment();assert.equal(reads,0);
 assert.equal(f.storage.statistics.checkoutHistory.some(e=>['MERCHANT_STOCK_FAILURE_OBSERVED','MERCHANT_TERMINAL_FAILURE_OBSERVED'].includes(e.code)),false);
 assert.equal(f.safari.clicks,1);
});

test('fresh Safari availability queues the normal checkout without incrementing stock-request statistics',async t=>{
 const f=fixture(t);f.c.enabled=true;f.c.phase='watching';f.c.busy=true;const before=f.storage.statistics.checks;
 assert.equal(f.safari.onAvailability({origin:'safari-pickup-response',sku:selection.sku,observedAt:f.now(),stores:[{id:'R119',state:'available'}]}),true);
 assert.equal(f.storage.statistics.checks,before);assert.equal(f.storage.statistics.checksBySKU?.[selection.sku]??0,0);assert.equal(f.c.pendingAvailability.storeId,'R119');assert.equal(f.c.pendingAvailability.origin,'safari-pickup-response');assert.equal(f.safari.clicks,0);
 f.c.busy=false;f.c.pendingAvailability=null;f.c.enabled=false;
});

for(const unsafe of ['stopped','payment','checkout','stale','future','wrong-sku','wrong-store','unavailable','wrong-origin'])test('Safari availability cannot bypass the '+unsafe+' guard',async t=>{
 const f=fixture(t);f.c.enabled=true;f.c.phase='watching';f.c.busy=true;const sample={origin:'safari-pickup-response',sku:selection.sku,observedAt:f.now(),stores:[{id:'R119',state:'available'}]};
 if(unsafe==='stopped')f.c.enabled=false;if(unsafe==='payment')f.storage.guard.phase='uncertain';if(unsafe==='checkout')f.c.currentStore='R119';if(unsafe==='stale')sample.observedAt-=5001;if(unsafe==='future')sample.observedAt++;if(unsafe==='wrong-sku')sample.sku='OTHER1J/A';if(unsafe==='wrong-store')sample.stores[0].id='R999';if(unsafe==='unavailable')sample.stores[0].state='unavailable';if(unsafe==='wrong-origin')sample.origin='private-value';
 assert.equal(f.safari.onAvailability(sample),false);assert.equal(f.c.pendingAvailability,null);assert.equal(f.storage.statistics.checks,0);assert.equal(f.safari.clicks,0);f.c.busy=false;f.c.enabled=false;
});

test('fresh Safari availability cannot override a newer stock withdrawal',async t=>{
 const f=fixture(t);f.c.enabled=true;f.c.phase='watching';f.c.busy=true;const earlier=f.now();f.advance(100);
 f.c.signal({sku:selection.sku,observedAt:f.now(),stores:[{id:'R119',state:'unavailable'}]});const count=f.storage.statistics.checks;
 f.safari.onAvailability({origin:'safari-pickup-response',sku:selection.sku,observedAt:earlier,stores:[{id:'R119',state:'available'}]});assert.equal(f.c.pendingAvailability,null);assert.equal(f.storage.statistics.checks,count);f.c.busy=false;f.c.enabled=false;
});

test('a fresh Safari signal received during inspection yields before a keeper mode change',async t=>{
 const f=fixture(t);f.c.enabled=true;f.c.phase='watching';let maintained=0,offered=false;
 f.safari.page={phase:'pickup',fulfillmentMode:'pickup',ready:true,pending:false};
 f.safari.maintain=async()=>{maintained++;return{maintained:true};};const inspect=f.safari.inspect.bind(f.safari);
 f.safari.inspect=async()=>{const state=await inspect();if(!offered){offered=true;f.safari.onAvailability({origin:'safari-pickup-response',sku:selection.sku,observedAt:f.now(),stores:[{id:'R119',state:'available'}]});}return state;};
 await f.c.tick();for(let i=0;i<20&&f.storage.guard.phase!=='waiting';i++)await new Promise(setImmediate);
 assert.equal(maintained,0);assert.equal(f.storage.statistics.checks,0);assert.equal(f.safari.clicks,1);assert.equal(f.storage.guard.phase,'waiting');
 const trace=f.storage.checkoutTimings.at(-1);assert.ok(trace.steps.some(s=>s.name==='signal:safari-pickup-response'));
 f.c.enabled=false;
});

for (const lost of [false,true]) test('session renewal reads use checkout cadence without repeating the extension; lost='+lost, async () => {
  let at=0,clicks=0;
  const session=new SafariSession({bindingPath:null,now:()=>at,sleep:async ms=>{at+=ms;}});
  session.action=async()=>{clicks++;if(lost)throw Error('SAFARI_UNCERTAIN');return{extensionRequested:true};};
  session.inspect=async()=>({phase:'pickup',sessionWarning:at<180,pending:false,ready:true});
  const result=await session.renewSession();
  assert.equal(result.maintained,true);assert.equal(clicks,1);assert.equal(at,200);
});
test('session renewal polling notices a manual stop before another read or click',async()=>{
  let at=0,clicks=0,reads=0;
  const session=new SafariSession({bindingPath:null,now:()=>at,sleep:async ms=>{at+=ms;}});
  session.action=async()=>{clicks++;return{extensionRequested:true};};
  session.inspect=async()=>{reads++;return{phase:'pickup',sessionWarning:true,pending:false,ready:true};};
  await assert.rejects(session.renewSession(()=>{if(at>=100)throw Error('STOPPED');}),/STOPPED/);
  assert.equal(at,100);assert.equal(reads,1);assert.equal(clicks,1);
});

for(const complete of [false,true])test('fresh store refusal preserves the submitted CAP response fence: '+complete,async()=>{
 const base={phase:'pickup',ready:true,pending:false,fulfillmentMode:'pickup',storeState:'unavailable'},session=new SafariSession({bindingPath:null});let queries=0;
 session.inspect=async()=>({...base});
 session.refreshStoreAvailability=async()=>{queries++;return{...base,refreshSubmitted:true,refreshComplete:complete};};
 await assert.rejects(session.prepareCheckout(selection,'R119',()=>{}),error=>error.message==='STOCK_FAILED'&&error.freshPickupRefusalVerified===complete);
 assert.equal(queries,1);
});
test('fresh store refusal reaches controller recovery without repeating a delivery round trip when its banner appears later',async t=>{
 const f=fixture(t),base={phase:'pickup',ready:true,pending:false,fulfillmentMode:'pickup',storeState:'unavailable'},session=new SafariSession({bindingPath:null});let queries=0;
 session.inspect=async()=>({...base});
 session.refreshStoreAvailability=async()=>{queries++;return{...base,refreshSubmitted:true,refreshComplete:true};};
 f.c.enabled=true;f.c.phase='watching';f.safari.page={...base,pickupUnavailable:true};
 f.safari.prepareCheckout=(...args)=>session.prepareCheckout(...args);
 f.safari.refreshPickup=async()=>{throw Error('MUST_NOT_REPEAT_DELIVERY')};
 f.safari.transition=async()=>{f.safari.bagVisits++;f.safari.page={phase:'bag',ready:true,pending:false};return f.safari.page;};
 f.c.startCheckout('R119');await settle();
 assert.equal(queries,1);assert.equal(f.c.phase,'preparing');assert.equal(f.safari.bagVisits,1);assert.equal(f.safari.clicks,0);assert.equal(f.storage.guard.phase,'idle');
 for(const code of ['PICKUP_FRESH_REFUSAL_VERIFIED','PICKUP_MODE_RECOVERY_SKIPPED'])assert.ok(f.storage.statistics.checkoutHistory.some(x=>x.code===code));
});

for(const mode of ['quiet','read-only','repeat','busy','modal','young','missing-marker','completed-request','active-pay','authorized-pay','observed-pay','completed-pay','dispatched-pay','pending-store','authentication','wrong-owner','untrusted','selected-store','calendar','not-ready'])test('stale keeper abort DOM guard: '+mode,()=>{
 const nonce='11111111-1111-1111-1111-111111111111';let nav=0;
 const ctx={URL,Number,Error,p:{nonce,observeOnly:mode==='read-only'},location:{href:mode==='authentication'?'https://www.apple.com/jp/shop/apw/checkout?_s=PickupContact-init':mode==='untrusted'?'https://untrusted.invalid/jp/shop/apw/checkout?_s=Fulfillment-init':'https://www.apple.com/jp/shop/apw/checkout?_s=Fulfillment-init',assign:url=>{assert.equal(url,'https://www.apple.com/jp/shop/bag');nav++;}},window:{name:'ApplePickupLoop:'+(mode==='wrong-owner'?'wrong':nonce),__applePickupFulfillmentChange:mode==='missing-marker'?null:{mode:'pickup',responseComplete:mode==='completed-request',startedAt:mode==='young'?190000:100000},__applePickupPayment:{active:mode==='active-pay',authorized:mode==='authorized-pay',observed:mode==='observed-pay',completed:mode==='completed-pay'},__applePickupStoreSelection:mode==='pending-store'?{responseComplete:false}:null},performance:{now:()=>200000},document:{readyState:mode==='not-ready'?'interactive':'complete',documentElement:{hasAttribute:()=>mode==='dispatched-pay'},querySelectorAll:selector=>mode==='busy'&&selector.startsWith('[aria-busy')||mode==='modal'&&selector.includes('[aria-modal')||mode==='selected-store'&&selector.includes(':checked')||mode==='calendar'&&selector.startsWith('select')?[{getClientRects:()=>[1]}]:[]}};
 const call=()=>vm.runInNewContext('('+abortStaleKeeper.toString()+')(p)',ctx);
 if(['quiet','read-only','repeat'].includes(mode)){call();if(mode==='repeat')call();assert.equal(nav,mode==='read-only'?0:1);}
 else{assert.throws(call,/KEEPER_RECOVERY_UNVERIFIED/);assert.equal(nav,0);}
});
test('stale keeper restoration reconciles a lost abort reply without repeating navigation',async()=>{
 const s=new SafariSession({bindingPath:null});s.binding={nonce:'11111111-1111-1111-1111-111111111111'};s.pendingMode='pickup';let evaluations=0,pauses=0,reads=0;
 s.paymentStatus=async()=>({known:true,active:false});s.inspect=async()=>({phase:'pickup',pending:true});
 s.evaluate=async(_fn,p)=>{evaluations++;if(p.observeOnly)return{eligible:true};throw Error('SAFARI_UNCERTAIN');};
 s.waitFor=async()=>{reads++;return{phase:'bag',ready:true,pending:false};};
 const result=await s.restoreStaleKeeper(()=>{},()=>{pauses++;});assert.equal(result.aborted,true);assert.equal(evaluations,2);assert.equal(reads,1);assert.equal(pauses,1);assert.equal(s.pendingMode,null);
});
test('stale keeper restoration does not pause stock or navigate when its DOM guard rejects',async()=>{
 const s=new SafariSession({bindingPath:null});s.binding={nonce:'11111111-1111-1111-1111-111111111111'};let pauses=0;
 s.paymentStatus=async()=>({known:true,active:false});s.inspect=async()=>({phase:'pickup',pending:true});s.evaluate=async()=>{throw Error('KEEPER_RECOVERY_UNVERIFIED');};
 await assert.rejects(s.restoreStaleKeeper(()=>{},()=>{pauses++;}),/KEEPER_RECOVERY_UNVERIFIED/);assert.equal(pauses,0);
});
test('stale keeper restoration cannot interrupt an active native payment',async()=>{
 const s=new SafariSession({bindingPath:null});let reads=0;s.paymentStatus=async()=>({known:true,active:true});s.inspect=async()=>{reads++;return{phase:'pickup'};};
 await assert.rejects(s.restoreStaleKeeper(),/PAYMENT_ACTIVE/);assert.equal(reads,0);
});
test('stale keeper restoration respects a manual stop raised after its read-only preflight',async()=>{
 const s=new SafariSession({bindingPath:null});s.binding={nonce:'11111111-1111-1111-1111-111111111111'};let stopped=false,evaluations=0;
 s.paymentStatus=async()=>({known:true,active:false});s.inspect=async()=>({phase:'pickup',pending:true});s.evaluate=async()=>{evaluations++;return{eligible:true};};
 await assert.rejects(s.restoreStaleKeeper(()=>{if(stopped)throw Error('STOPPED');},()=>{stopped=true;}),/STOPPED/);assert.equal(evaluations,1);
});
test('stale keeper controller recovery re-prepares instead of leaving checkout indefinitely in intervention',async t=>{
 const f=fixture(t);f.c.enabled=true;f.c.phase='watching';f.safari.page={phase:'pickup',ready:true,pending:false,fulfillmentMode:'pickup'};
 f.safari.maintain=async()=>{throw Error('PAGE_TRANSITION_UNCERTAIN');};
 f.safari.restoreStaleKeeper=async(check,before)=>{check();before();f.safari.page={phase:'bag',ready:true,pending:false};return{needsPreparation:true,aborted:true};};
 await f.c.tick();assert.equal(f.c.phase,'preparing');assert.equal(f.c.snapshot().keeper.recoveries,1);assert.equal(f.safari.clicks,0);assert.equal(f.storage.guard.phase,'idle');
 f.advance(5001);await f.c.tick();assert.equal(f.c.phase,'watching');assert.equal(f.fleet.enabled,true);
});
for(const protectedState of ['store','guard'])test('stale keeper controller recovery preserves an existing '+protectedState,async t=>{
 const f=fixture(t);let recoveries=0;f.c.enabled=true;f.c.phase='watching';f.safari.page={phase:'pickup',ready:true,pending:false,fulfillmentMode:'pickup'};
 if(protectedState==='store')f.c.currentStore='R119';else f.storage.guard.phase='uncertain';
 f.safari.maintain=async()=>{throw Error('PAGE_TRANSITION_UNCERTAIN');};f.safari.restoreStaleKeeper=async()=>{recoveries++;return{needsPreparation:true};};
 await f.c.tick();assert.equal(recoveries,0);assert.equal(f.safari.clicks,0);
});
test('stale keeper pending reconciliation observes an earlier abort instead of replaying the mode change',async t=>{
 const f=fixture(t);f.c.enabled=true;f.c.phase='intervention';f.c.resumePhase='watching';f.c.keeperRecoveryPending=true;f.safari.page={phase:'pickup',ready:true,pending:true,fulfillmentMode:'pickup'};let restores=0;
 f.safari.restoreStaleKeeper=async(check,before)=>{check();restores++;before();return{needsPreparation:true,aborted:true};};
 await f.c.tick();assert.equal(restores,1);assert.equal(f.c.phase,'preparing');assert.equal(f.c.keeperRecoveryPending,false);assert.equal(f.safari.clicks,0);
});

for(const problem of ['late-response','lost-navigation-reply'])test('keeper resumes stock after '+problem+' settles after quiescing',async t=>{
 const f=fixture(t);f.c.enabled=true;f.c.phase='watching';f.fleet.enabled=true;
 f.safari.page={phase:'pickup',ready:true,pending:false,fulfillmentMode:'pickup'};
 let restores=0,starts=0;f.fleet.start=async()=>{starts++;f.fleet.enabled=true;};
 f.safari.maintain=async()=>{throw Error('PAGE_TRANSITION_UNCERTAIN');};
 f.safari.restoreStaleKeeper=async(check,before)=>{check();if(++restores===1){before();throw Error(problem==='late-response'?'KEEPER_RECOVERY_UNVERIFIED':'PAGE_TRANSITION_UNCERTAIN');}return{ready:true};};
 await f.c.tick();assert.equal(f.fleet.enabled,false);
 f.safari.maintain=async()=>({maintained:true});f.advance(5001);await f.c.tick();
 assert.equal(f.c.phase,'watching');assert.equal(f.fleet.enabled,true);assert.equal(starts,1);assert.equal(f.safari.clicks,0);assert.equal(f.c.keeperRecoveryPending,false);
});
test('keeper reconciliation leaves already-running stock alone',async t=>{
 const f=fixture(t);f.c.enabled=true;f.c.phase='intervention';f.c.resumePhase='watching';f.c.keeperRecoveryPending=true;f.fleet.enabled=true;let starts=0;
 f.safari.page={phase:'pickup',ready:true,pending:false,fulfillmentMode:'pickup'};f.fleet.start=async()=>{starts++;};f.safari.restoreStaleKeeper=async()=>({ready:true});
 await f.c.tick();assert.equal(f.c.phase,'watching');assert.equal(starts,0);assert.equal(f.fleet.enabled,true);assert.equal(f.c.keeperRecoveryPending,false);
});
for(const block of ['guard','contact'])test('quiesced keeper cannot restart stock with '+block+' active',async t=>{
 const f=fixture(t);f.c.enabled=true;f.c.phase='intervention';f.c.resumePhase='watching';f.c.keeperRecoveryPending=true;f.c.keeperStockPaused=true;let starts=0,restores=0;
 f.fleet.start=async()=>{starts++;};f.safari.page={phase:block==='contact'?'contact':'pickup',ready:true,pending:false,fulfillmentMode:'pickup'};
 if(block==='guard')f.storage.guard.phase='uncertain';f.safari.restoreStaleKeeper=async()=>{restores++;return{ready:true};};
 await f.c.tick();assert.equal(starts,0);assert.equal(restores,0);assert.equal(f.fleet.enabled,false);assert.equal(f.safari.clicks,0);
});
test('manual stop during keeper stock restart cannot restore watching',async t=>{
 const f=fixture(t);f.c.enabled=true;f.c.phase='intervention';f.c.resumePhase='watching';f.c.keeperRecoveryPending=true;f.c.keeperStockPaused=true;f.safari.page={phase:'pickup',ready:true,pending:false,fulfillmentMode:'pickup'};
 let entered,release;const began=new Promise(r=>{entered=r;}),gate=new Promise(r=>{release=r;});f.fleet.start=async()=>{entered();await gate;};f.safari.restoreStaleKeeper=async()=>({ready:true});
 const tick=f.c.tick();await began;await f.c.activation(false);release();await tick;
 assert.equal(f.c.enabled,false);assert.equal(f.c.phase,'stopped');assert.equal(f.fleet.enabled,false);assert.equal(f.safari.clicks,0);
});

test('failed keeper stock restart remains pending until canonical preflight succeeds',async t=>{
 const f=fixture(t);f.c.enabled=true;f.c.phase='intervention';f.c.resumePhase='watching';f.c.keeperRecoveryPending=true;f.c.keeperStockPaused=true;f.safari.page={phase:'pickup',ready:true,pending:false,fulfillmentMode:'pickup'};let starts=0;
 f.fleet.start=async()=>{if(++starts===1)throw Error('FLEET_PREFLIGHT_REQUIRED');f.fleet.enabled=true;};f.safari.restoreStaleKeeper=async()=>({ready:true});
 await f.c.tick();assert.equal(f.c.phase,'intervention');assert.equal(f.c.snapshot().keeper.recoveryPending,true);assert.equal(f.c.snapshot().keeper.stockPaused,true);assert.equal(f.fleet.enabled,false);
 f.advance(5001);await f.c.tick();assert.equal(f.c.phase,'watching');assert.equal(starts,2);assert.equal(f.c.snapshot().keeper.recoveryPending,false);assert.equal(f.c.snapshot().keeper.stockPaused,false);assert.equal(f.fleet.enabled,true);assert.equal(f.safari.clicks,0);
});

for(const reviewed of [true,false])test('keeper recovery after a closed Wallet failure requires review: '+reviewed,async t=>{
 const f=fixture(t),failure={id:'11111111-1111-4111-8111-111111111111',storeId:'R119',pressedAt:f.now()-45000,openedAt:f.now()-43000,selection};
 const record={...failure,resolution:{source:'native-wallet-completed-failure',reviewedNoOrder:reviewed,failedAtJST:'1970-01-01 09:16:08 JST'}};
 f.storage.setGuard('failed',record);f.c.enabled=true;f.c.phase='watching';
 f.safari.page={phase:'pickup',ready:true,pending:false,fulfillmentMode:'pickup'};
 let recovered=0;
 f.safari.maintain=async()=>{throw Error('PAGE_TRANSITION_UNCERTAIN');};
 f.safari.restoreStaleKeeper=async(check,before)=>{check();before();recovered++;return{needsPreparation:true,aborted:true};};
 await f.c.tick();assert.equal(recovered,reviewed?1:0);assert.equal(f.c.phase,reviewed?'preparing':'intervention');
 assert.deepEqual(f.storage.guard.attempt,record);assert.equal(f.safari.clicks,0);
});

test('a new verified CAP refusal after owner reconciliation skips redundant delivery without erasing the payment journal',async t=>{
 const f=fixture(t),id='22222222-2222-4222-8222-222222222222',pressedAt=f.now()-45000;
 const attempt={id,pressedAt,openedAt:pressedAt+1000,storeId:'R119',selection};
 f.storage.setGuard('uncertain',attempt);f.c.current=attempt;f.c.currentStore='R119';
 f.safari.page={phase:'expired',ready:true,pending:false};
 await f.c.reconcileFailedPayment({source:'native-wallet-completed-failure',attemptId:id,failedAt:pressedAt+10000,reviewedNoOrder:true});
 const preserved=structuredClone(f.storage.guard);
 f.c.enabled=true;f.c.phase='watching';f.safari.page={phase:'pickup',ready:true,pending:false,fulfillmentMode:'pickup',pickupUnavailable:true};
 f.safari.prepareCheckout=async()=>{throw Object.assign(Error('STOCK_FAILED'),{freshPickupRefusalVerified:true});};
 let switched=0;
 f.safari.refreshPickup=async()=>{switched++;throw Error('MUST_NOT_REPEAT_DELIVERY');};
 f.safari.transition=async()=>{f.safari.bagVisits++;f.safari.page={phase:'bag',ready:true,pending:false};return f.safari.page;};
 f.c.startCheckout('R119');await settle();
 assert.equal(switched,0);assert.equal(f.safari.bagVisits,1);assert.equal(f.safari.clicks,0);
 assert.ok(f.storage.statistics.checkoutHistory.some(e=>e.code==='PICKUP_MODE_RECOVERY_SKIPPED'));
 assert.deepEqual(f.storage.guard,preserved);
});
