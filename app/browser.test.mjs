import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { pageDOM } from './page-dom.mjs';
import { createApplication, createHTTPServer } from './server.mjs';
import { AppStorage } from './storage.mjs';
import { STORES } from './shared.mjs';
import { SafariSession } from './safari.mjs';
import { pickupScheduleDOM } from './pickup-time.mjs';
import { pickupFastDOM, createPickupFastDOM } from './pickup-fast.mjs';
import { freshPickupAvailability } from './pickup-availability.mjs';
const selection = { sku: 'AAAA1J/A', name: 'Test Device 256GB Black', names: ['Test Device 256GB Black','Test Device 256GB ブラック'], priceJPY: 100000, currency: 'JPY', category: 'iphone', productId: 'https://www.apple.com/jp/shop/buy-iphone/test-device', url: 'https://www.apple.com/jp/shop/product/AAAA1J/A', stores: ['R119'] };
const contact = { lastName: 'Fixture', firstName: 'Operator', emailAddress: 'operator@example.invalid', mobilePhone: '08000000000' };
const apwSummary = () => `<div role="radio" aria-checked="true">お客様がご自身で受け取る</div><div role="radio" aria-checked="false">配送を希望する</div><span class="rs-companionbar-button-amount">100,000円</span><script id="init_data" type="application/json">${JSON.stringify({ checkout: { fulfillment: { deliveryTab: { delivery: { shipmentGroups: { group: { shipmentOptionsGroups: { options: { items: { product: { d: { sku: selection.sku, name: selection.names[1], unitPrice: '100,000円', totalPrice: '100,000円', hasAppleCareInstallment: false } } } } } } } } } }, companionBar: { orderSummary: { d: { total: '100,000円', subtotal: '100,000円' } } } } })}</script>`;
const contactForm = () => ['lastName','firstName','emailAddress','mobilePhone'].map(k => `<input id="checkout.pickupContact.selfPickupContact.selfContact.address.${k}" autocomplete="off">`).join('');
const item = `<ul data-autom="bag-items"><li><h2 class="rs-iteminfo-title"><a data-autom="bag-item-name" href="https://www.apple.com/jp/shop/product/AAAA1J/A/test-device">Test Device 256GB ブラック</a></h2><p>数量 1</p><select data-autom="item-quantity-dropdown"><option value="1">1</option></select></li></ul><span data-autom="bagtotalvalue">100,000円</span>`;
let browser;
test.before(async () => { browser = await chromium.launch({ channel: 'chrome', headless: true }); });
test.after(async () => { await browser?.close(); });
async function fixture(t, { path = '/jp/shop/bag', body = item, postalResponseDelayMs = 0, fulfillmentResponseDelayMs = 0 } = {}) {
  const context = await browser.newContext(); t.after(() => context.close());
  const page = await context.newPage(); let outbound = 0, postalRequests = 0, fulfillmentRequests = 0;
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('_m') === 'checkout.fulfillment.fulfillmentOptions' && url.searchParams.get('_a') === 'selectFulfillmentLocationAction') {
      fulfillmentRequests++;if(fulfillmentResponseDelayMs)await new Promise(r=>setTimeout(r,fulfillmentResponseDelayMs)); await route.fulfill({status:200,contentType:'application/json',body:'{}'}); return;
    }
    if (url.searchParams.get('_m') === 'checkout.fulfillment.pickupTab.pickup.storeLocator' && url.searchParams.get('_a') === 'search') {
      postalRequests++; if (postalResponseDelayMs) await new Promise(resolve => setTimeout(resolve, postalResponseDelayMs));
      try { await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }); } catch {}
      return;
    }
    outbound++; return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: `<html lang="ja"><head><meta charset="utf-8"></head><body>${body}</body></html>` });
  });
  await page.addInitScript(() => {
    window.__fixturePostalResponseDone = false;
    document.addEventListener('click', event => {
      if (event.target?.closest?.('button')?.id !== 'checkout.fulfillment.pickupTab.pickup.storeLocator.search') return;
      window.__fixturePostalResponseDone = false;
      void fetch('/jp/shop/apw/checkoutx?_a=search&_m=checkout.fulfillment.pickupTab.pickup.storeLocator').then(r => r.json()).then(() => { window.__fixturePostalResponseDone = true; document.dispatchEvent(new Event('fixture-postal-response')); }).catch(() => {});
    }, true);
  });
  await page.goto('https://www.apple.com' + path);
  const run = p => page.evaluate(({ source, p }) => (0, eval)('(' + source + ')')(p), { source: pageDOM.toString(), p: { selection, ...p } });
  return { page, run, outbound: () => outbound, postalRequests: () => postalRequests, fulfillmentRequests: () => fulfillmentRequests };
}
function fixtureSafari(f, options = {}) {
  const s = new SafariSession({ bindingPath: null, ...options, invoke: async request => {
    if (request.operation === 'payment-status') return options.nativeStatus ?? { known: true, active: false, kind: 'none' };
    assert.ok(['evaluate','evaluate-guarded'].includes(request.operation));
    if (request.operation === 'evaluate-guarded') {
      const ui = options.nativeStatus ?? { known: true, active: false, kind: 'none' };
      if (!ui.known) throw Error('ACCESSIBILITY_REQUIRED');
      if (ui.active && !(request.allowSessionModal && ui.kind === 'safari-modal')) throw Error('PAYMENT_ACTIVE');
    }
    await options.beforeEvaluate?.(request.script);
    const result = JSON.parse(await f.page.evaluate(script => (0, eval)(script), request.script));
    await options.afterEvaluate?.(request.script);
    if (options.loseReply?.(request.script)) throw Error('SAFARI_SCRIPT_UNAVAILABLE');
    return result;
  } });
  s.binding = {}; s.expected(selection, 'R119'); return s;
}
const postalFixture = available => apwSummary() + `
  <button data-autom="fulfillment-pickup-store-search-button" onclick="setTimeout(()=>document.getElementById('postal-editor').hidden=false,20)">変更</button>
  <div id="postal-editor" hidden><input id="checkout.fulfillment.pickupTab.pickup.storeLocator.searchInput"><button id="checkout.fulfillment.pickupTab.pickup.storeLocator.search" onclick="window.searches++;document.body.setAttribute('aria-busy','true');setTimeout(()=>{document.getElementById('store').disabled=${!available};document.getElementById('postal-editor').hidden=true;document.body.removeAttribute('aria-busy')},100)">適用</button></div>
  <div class="rt-storelocator-store-list"><input id="store" type="radio" name="store-locator-result" value="R119" disabled><label for="store">Apple 渋谷</label></div>
  <script>window.searches=0;window.storeClicks=0;document.getElementById('store').onclick=()=>window.storeClicks++;</script>`;

const noSlotBody = () => apwSummary() + '<input id="store" type="radio" name="store-locator-result" value="R119" checked><label for="store"><span class="form-selector-title">Apple 渋谷</span></label><button data-autom="fulfillment-continue-button" id="next">続ける</button>';
test('an already selectable Store from the same signal can be preferred without a CAP action or click',async t=>{
 const f=await fixture(t,{path:'/jp/shop/apw/checkout?_s=Fulfillment-init',body:postalFixture(false)+'<input type="radio" id="alternate" name="store-locator-result" value="R224"><label for="alternate">Apple 表参道</label>'});
 const s=fixtureSafari(f),scope={...selection,stores:['R119','R224']};s.confirmedSKU=scope.sku;
 assert.equal(await s.preferredPickupStore(scope,scope.stores),'R224');
 await f.page.locator('#store').evaluate(e=>{e.disabled=false;});
 assert.equal(await s.preferredPickupStore(scope,scope.stores),null,'keep original Store order when it is usable');
 await f.page.locator('#store').evaluate(e=>{e.disabled=true;});
 await f.page.locator('#postal-editor').evaluate(e=>{e.hidden=false;});
 assert.equal(await s.preferredPickupStore(scope,scope.stores),null,'leave a postal edit alone');
 assert.deepEqual(await f.page.evaluate(()=>[window.searches,window.storeClicks]),[0,0]);assert.equal(f.outbound(),1);
});
test('a warmed sibling reuses only an idle bound pickup page at the expected total',async t=>{
 const f=await fixture(t,{path:'/jp/shop/apw/checkout?_s=Fulfillment-init',body:postalFixture(false)});
 const s=fixtureSafari(f);s.confirmedSKU=selection.sku;s.pickupPreparation={state:'stores-ready'};
 const lease=s.nextKeepaliveAt=Date.now()+30000;
 assert.equal(await s.reusePreparedPickup(selection,()=>{}),true);assert.equal(s.nextKeepaliveAt,lease);
 await f.page.locator('.rs-companionbar-button-amount').evaluate(e=>{e.textContent='200,000円';});
 assert.equal(await s.reusePreparedPickup(selection,()=>{}),false);
 await f.page.locator('.rs-companionbar-button-amount').evaluate(e=>{e.textContent='100,000円';});
 await f.page.locator('#postal-editor').evaluate(e=>{e.hidden=false;});
 assert.equal(await s.reusePreparedPickup(selection,()=>{}),false);
 await f.page.locator('#postal-editor').evaluate(e=>{e.hidden=true;window.__applePickupPayment={observed:true};});
 assert.equal(await s.reusePreparedPickup(selection,()=>{}),false);
 assert.deepEqual(await f.page.evaluate(()=>[window.searches,window.storeClicks]),[0,0]);assert.equal(f.outbound(),1);
});
test('sibling revalidation stops on native payment activity and on an expired keeper lease',async t=>{
 const f=await fixture(t,{path:'/jp/shop/apw/checkout?_s=Fulfillment-init',body:postalFixture(false)});
 const s=fixtureSafari(f,{nativeStatus:{known:true,active:true,kind:'apple-pay'}});
 s.confirmedSKU=selection.sku;s.pickupPreparation={state:'stores-ready'};s.nextKeepaliveAt=Date.now()+30000;
 await assert.rejects(s.reusePreparedPickup(selection,()=>{}),/PAYMENT_ACTIVE/);
 s.nextKeepaliveAt=Date.now();
 assert.equal(await s.reusePreparedPickup(selection,()=>{}),false);
 assert.equal(f.outbound(),1);
});
async function emptyPostalFixture(t,{available=false,collapsed=false,deliveryOnly=false}={}) {
 const f=await fixture(t,{path:'/jp/shop/apw/checkout?_s=Fulfillment-init',body:apwSummary()+`<button data-autom="fulfillment-pickup-store-search-button" aria-expanded="false">変更</button><div id="postal-editor" ${collapsed?'hidden':''}><input id="checkout.fulfillment.pickupTab.pickup.storeLocator.searchInput"><button disabled id="checkout.fulfillment.pickupTab.pickup.storeLocator.search">適用</button></div><div class="rt-storelocator-store-list" id="warm-stores"></div>`});
 await f.page.evaluate(({available,deliveryOnly})=>{
  window.searches=0;window.storeClicks=0;
  const input=document.getElementById('checkout.fulfillment.pickupTab.pickup.storeLocator.searchInput'),search=document.getElementById('checkout.fulfillment.pickupTab.pickup.storeLocator.search'),edit=document.querySelector('[data-autom="fulfillment-pickup-store-search-button"]');
  input.oninput=()=>{search.disabled=input.value.replaceAll('-','').length!==7;};
  edit.onclick=()=>{document.getElementById('postal-editor').hidden=false;edit.setAttribute('aria-expanded','true');};
  search.onclick=()=>{window.searches++;document.body.setAttribute('aria-busy','true');document.addEventListener('fixture-postal-response',()=>{
   document.getElementById('postal-editor').hidden=true;document.body.removeAttribute('aria-busy');
   if(deliveryOnly){document.getElementById('warm-stores').remove();const h=document.createElement('h2');h.textContent='ご注文の商品のお受け取りは配送のみとなります。';document.body.append(h);return;}
   document.getElementById('warm-stores').innerHTML='<input id="store" type="radio" name="store-locator-result" value="R119"><label for="store">Apple 渋谷</label>';
   const store=document.getElementById('store');store.disabled=!available;store.onclick=()=>{window.storeClicks++;window.onFixtureStoreClick?.();};
  },{once:true});};
 },{available,deliveryOnly});return f;
}
test('pickup preparation applies an empty CAP and loads Store options before any stock signal',async t=>{
 const f=await emptyPostalFixture(t),s=fixtureSafari(f);
 await s.preparePickup();await s.maintain();await s.preparePickup();
 assert.equal(await f.page.locator('[id="checkout.fulfillment.pickupTab.pickup.storeLocator.searchInput"]').inputValue(),STORES[0].postalCode);
 assert.equal(f.postalRequests(),1);assert.deepEqual(await f.page.evaluate(()=>[window.searches,window.storeClicks]),[1,0]);
 assert.deepEqual(s.snapshot().pickupPreparation,{state:'stores-ready',postalReady:true,storesReady:true,calendarReady:false,storeCount:1});assert.equal(f.outbound(),1);
});
test('pickup preparation reloads CAP only after the keeper clears the existing Store response',async t=>{
 const f=await emptyPostalFixture(t),s=fixtureSafari(f);await s.preparePickup();
 await f.page.evaluate(()=>{document.getElementById('warm-stores').innerHTML='';document.getElementById('postal-editor').hidden=false;document.getElementById('checkout.fulfillment.pickupTab.pickup.storeLocator.searchInput').value='';window.__applePickupPostalRefresh=null;window.__applePickupPostalPrepared=null;});
 await s.preparePickup();await s.preparePickup();assert.equal(f.postalRequests(),2);assert.equal(await f.page.evaluate(()=>window.storeClicks),0);
});
test('the Store-selection prompt after keeper refresh leaves a prepared CAP ready without resubmitting',async t=>{
 const f=await emptyPostalFixture(t),s=fixtureSafari(f);await s.preparePickup();
 await f.page.evaluate(()=>document.body.insertAdjacentHTML('beforeend','<div role="alert">処理を続ける前にストアを選択してください。</div><div role="alert" style="height:1px;width:1px"></div>'));
 const r=await s.preparePickup();assert.equal(r.prepared,true);assert.equal(s.snapshot().pickupPreparation.state,'stores-ready');assert.equal(f.postalRequests(),1);assert.equal(await f.page.evaluate(()=>window.storeClicks),0);
});
test('another Apple error alongside the Store-selection prompt keeps pickup preparation blocked',async t=>{
 const f=await emptyPostalFixture(t),s=fixtureSafari(f);await s.preparePickup();
 await f.page.evaluate(()=>document.body.insertAdjacentHTML('beforeend','<div role="alert">処理を続ける前にストアを選択してください。</div><div role="alert">Unknown checkout error</div>'));
 const r=await s.preparePickup();assert.equal(r.waiting,true);assert.equal(s.snapshot().pickupPreparation.state,'waiting');assert.equal(f.postalRequests(),1);assert.equal(await f.page.evaluate(()=>window.storeClicks),0);
});
test('a prepared CAP lets the availability signal select Store, date and time without another postal request',async t=>{
 const f=await emptyPostalFixture(t,{available:true});let storeRequests=0;
 await f.page.route('**/*',async route=>{const u=new URL(route.request().url());if(u.searchParams.get('_a')==='select'){storeRequests++;await route.fulfill({status:200,contentType:'application/json',body:'{}'});}else await route.fallback();});
 await f.page.evaluate(()=>{window.onFixtureStoreClick=()=>{void fetch('/jp/shop/apw/checkoutx?_a=select&_m=checkout.fulfillment.pickupTab.pickup.storeLocator').then(r=>r.json()).then(()=>{document.body.insertAdjacentHTML('beforeend','<input id="date8" type="radio" name="bartPickupDateSelectorButtonGroup" value="8"><label for="date8">November8</label><select data-autom="pickup-availablewindow-dropdown"><option value="">選択</option><option value="8-17:30-17:45">17:30</option></select>');});};});
 const s=fixtureSafari(f,{now:()=>Date.UTC(2026,10,8,6)}),stages=[];await s.preparePickup();
 await assert.rejects(s.prepareCheckout(selection,'R119',()=>{},stage=>{stages.push(stage);if(stage==='PICKUP_TIME_VERIFIED')throw Error('FIXTURE_CALENDAR_COMPLETE');}),/FIXTURE_CALENDAR_COMPLETE/);
 assert.equal(f.postalRequests(),1);assert.equal(storeRequests,1);assert.deepEqual(await f.page.evaluate(()=>[window.storeClicks,document.getElementById('store').checked,document.getElementById('date8').checked,document.querySelector('select').value]),[1,true,true,'8-17:30-17:45']);
 assert.ok(stages.includes('PICKUP_STORE_SELECTED'));assert.ok(stages.includes('PICKUP_DATE_SELECTED'));assert.ok(stages.includes('PICKUP_TIME_SELECTED'));
});
test('pickup preparation never overwrites an already selected Store and calendar',async t=>{
 const f=await fixture(t,{path:'/jp/shop/apw/checkout?_s=Fulfillment-init',body:noSlotBody()+'<input id="date8" type="radio" name="bartPickupDateSelectorButtonGroup" value="8" checked><label for="date8">November8</label><select data-autom="pickup-availablewindow-dropdown"><option selected value="8-17:30-17:45">17:30</option></select>'}),s=fixtureSafari(f);
 await s.preparePickup();assert.equal(s.snapshot().pickupPreparation.state,'calendar-ready');assert.equal(f.postalRequests(),0);assert.equal(await f.page.locator('select').inputValue(),'8-17:30-17:45');
});
test('pickup preparation yields to an availability signal before sending a CAP query',async t=>{
 const f=await emptyPostalFixture(t),s=fixtureSafari(f);const r=await s.preparePickup(()=>{},()=>true);assert.equal(r.yielded,true);assert.equal(f.postalRequests(),0);assert.equal(await f.page.locator('[id="checkout.fulfillment.pickupTab.pickup.storeLocator.searchInput"]').inputValue(),'');
});
test('availability arriving while opening CAP yields without leaving a pending query for a different Store',async t=>{
 const f=await emptyPostalFixture(t,{collapsed:true});let incoming=false;
 const s=fixtureSafari(f,{afterEvaluate:async script=>{if(script.includes('"action":"postal-open"'))incoming=true;}});
 const r=await s.preparePickup(()=>{},()=>incoming);assert.equal(r.yielded,true);assert.equal(s.pendingPostal,null);assert.equal(f.postalRequests(),0);
});
test('a lost CAP preparation reply is reconciled without duplicate queries',async t=>{
 const f=await emptyPostalFixture(t);let lost=false;const s=fixtureSafari(f,{loseReply:script=>{if(!lost&&script.includes('"action":"postal"')){lost=true;return true;}return false;}});
 await s.preparePickup();assert.equal(f.postalRequests(),1);assert.equal(s.snapshot().pickupPreparation.storesReady,true);
});
for(const active of [false,true])test('pickup preparation preserves '+(active?'active':'unknown')+' native payment authorization',async t=>{
 const f=await emptyPostalFixture(t),s=fixtureSafari(f,{nativeStatus:{known:active,active}});
 await assert.rejects(s.preparePickup(),active?/PAYMENT_ACTIVE/:/ACCESSIBILITY_REQUIRED/);assert.equal(f.postalRequests(),0);assert.equal(await f.page.locator('[id="checkout.fulfillment.pickupTab.pickup.storeLocator.searchInput"]').inputValue(),'');
});
test('a verified delivery-only CAP result stays observable without a preparation retry loop',async t=>{
 const f=await emptyPostalFixture(t,{deliveryOnly:true}),s=fixtureSafari(f);await s.preparePickup();await s.preparePickup();
 assert.equal(f.postalRequests(),1);assert.equal(s.snapshot().pickupPreparation.state,'pickup-unavailable');assert.equal(s.snapshot().pickupPreparation.postalReady,true);assert.equal(s.snapshot().pickupPreparation.storesReady,false);
});
const scheduleRead = f => f.page.evaluate(({ source }) => (0,eval)('('+source+')')({action:'read',storeId:'R119',storeLabels:['Shibuya','渋谷']}),{source:pickupScheduleDOM.toString()});

for (const missing of [false, true]) test('verified CAP diagnostics distinguish a target Store ' + (missing ? 'omitted from the response' : 'returned unavailable') + ' without recording postal or contact values', async t => {
  const f = await fixture(t, { path: '/jp/shop/apw/checkout?_s=Fulfillment-init', body: postalFixture(false) });
  if (missing) await f.page.evaluate(() => {
    document.getElementById('checkout.fulfillment.pickupTab.pickup.storeLocator.search').onclick = () => {
      window.searches++; document.body.setAttribute('aria-busy', 'true');
      setTimeout(() => {
        document.getElementById('store').remove();
        document.querySelector('.rt-storelocator-store-list').insertAdjacentHTML('beforeend', '<input id="neighbor-store" type="radio" name="store-locator-result" value="R224"><label for="neighbor-store">Apple 表参道</label>');
        document.getElementById('postal-editor').hidden = true; document.body.removeAttribute('aria-busy');
      }, 100);
    };
  });
  const s = fixtureSafari(f), timings = []; s.onTiming = step => timings.push(step);
  await s.refreshStoreAvailability(STORES[0], () => {});
  const diagnostic = timings.find(step => step.name === 'postal:verified');
  assert.equal(diagnostic?.code, 'STORE_' + (missing ? 'MISSING' : 'UNAVAILABLE') + '_INPUT_MATCHES');
  assert.equal(f.postalRequests(), 1); assert.equal(await f.page.evaluate(() => window.storeClicks), 0);
  assert.ok(!JSON.stringify(timings).includes(STORES[0].postalCode));
  assert.ok(!JSON.stringify(timings).includes(contact.emailAddress));
});

test('a pending Store reply is exposed as pending before CAP recovery can replace its evidence', async t => {
  const f = await fixture(t, { path: '/jp/shop/apw/checkout?_s=Fulfillment-init', body: postalFixture(false) });
  await f.page.evaluate(() => { window.__applePickupStoreSelection = { storeId: 'R119', responseComplete: false }; });
  const state = await f.run({ action: 'inspect' });
  assert.equal(state.storeResponsePending, true); assert.equal(state.pending, true);
  await assert.rejects(f.run({ action: 'postal-open', postalCode: STORES[0].postalCode }), /PAGE_BUSY/);
  assert.equal(await f.page.evaluate(() => window.__applePickupStoreSelection?.responseComplete), false);
  assert.equal(await f.page.locator('#postal-editor').isVisible(), false);
});

test('an unresolved Store reply prevents CAP submission, mode changes and bag navigation', async t => {
  for (const action of ['postal-submit', 'fulfillment-mode', 'navigate']) {
    const f = await fixture(t, { path: '/jp/shop/apw/checkout?_s=Fulfillment-init', body: postalFixture(false) });
    await f.page.evaluate(postalCode => {
      document.getElementById('postal-editor').hidden = false;
      document.getElementById('checkout.fulfillment.pickupTab.pickup.storeLocator.searchInput').value = postalCode;
      window.__applePickupStoreSelection = { storeId: 'R119', responseComplete: false };
    }, STORES[0].postalCode);
    await assert.rejects(f.run({ action, postalCode: STORES[0].postalCode, refreshId: 'fixture-refresh', mode: 'delivery', url: 'https://www.apple.com/jp/shop/bag' }), /PAGE_BUSY/);
    assert.equal(await f.page.evaluate(() => window.__applePickupStoreSelection?.responseComplete), false);
    assert.equal(await f.page.evaluate(() => window.searches), 0);
    assert.equal(f.postalRequests(), 0); assert.equal(f.outbound(), 1);
  }
});

test('CAP recovery observes a pending Store reply without mutation and resumes once it is complete', async t => {
  const f = await fixture(t, { path: '/jp/shop/apw/checkout?_s=Fulfillment-init', body: postalFixture(false) });
  await f.page.evaluate(() => { window.__applePickupStoreSelection = { storeId: 'R119', responseComplete: false }; });
  let clock = 1000000;
  const s = fixtureSafari(f, { now: () => clock, sleep: async ms => { clock += ms; await new Promise(resolve => setTimeout(resolve, 20)); } });
  await assert.rejects(s.refreshStoreAvailability(STORES[0], () => {}, clock + 300), /POSTAL_REFRESH_UNCERTAIN/);
  assert.equal(await f.page.evaluate(() => window.searches), 0);
  assert.equal(await f.page.locator('#postal-editor').isVisible(), false);
  assert.equal(await f.page.evaluate(() => window.__applePickupStoreSelection?.responseComplete), false);
  await f.page.evaluate(() => { window.__applePickupStoreSelection.responseComplete = true; });
  await s.refreshStoreAvailability(STORES[0], () => {}, clock + 5000);
  assert.equal(await f.page.evaluate(() => window.searches), 1); assert.equal(f.postalRequests(), 1);
});

test('the normal session-extension control remains usable while a Store reply is pending', async t => {
  const body = postalFixture(false) + '<div role="dialog" aria-modal="true">セッション<button onclick="window.extensions++;this.parentElement.remove()">まだショッピング中です</button></div><script>window.extensions=0</script>';
  const f = await fixture(t, { path: '/jp/shop/apw/checkout?_s=Fulfillment-init', body });
  await f.page.evaluate(() => { window.__applePickupStoreSelection = { storeId: 'R119', responseComplete: false }; });
  const result = await f.run({ action: 'keepalive' });
  assert.equal(result.extensionRequested, true);
  assert.equal(await f.page.evaluate(() => window.extensions), 1);
  assert.equal(await f.page.evaluate(() => window.__applePickupStoreSelection?.responseComplete), false);
  assert.equal(f.postalRequests(), 0);
});

test('live Pro calendar selectors recover a disabled selection and hidden date radios without a second Store click', async t => {
  const body=apwSummary()+'<input id="store" type="radio" name="store-locator-result" value="R119" checked><label for="store"><span class="form-selector-title">Apple 渋谷</span></label><input style="display:none" id="bartPickupDateSelector9" type="radio" name="bartPickupDateSelectorButtonGroup" value="9" checked><label for="bartPickupDateSelector9">November9</label><select data-autom="pickup-availablewindow-dropdown"><option value="">選択</option><option value="9-10:00-10:15">10:00 – 10:15</option><option value="9-10:15-10:30">10:15 – 10:30</option></select>';
  const f=await fixture(t,{path:'/jp/shop/apw/checkout?_s=Fulfillment-init',body});
  await f.page.evaluate(()=>{window.slotChanges=0;window.storeClicks=0;document.getElementById('store').onclick=()=>window.storeClicks++;document.querySelector('select').onchange=e=>{window.slotChanges++;if(window.slotChanges===1)e.target.selectedOptions[0].disabled=true;};});
  const s=fixtureSafari(f),{choosePickupSchedule}=await import('./pickup-time.mjs'),began=Date.UTC(2026,10,8,13);
  const chosen=await choosePickupSchedule(p=>s.evaluate(pickupScheduleDOM,{...p,storeId:'R119',storeLabels:['渋谷']},{guardPayment:p.action!=='read'}),{checkoutAt:began,now:()=>began,sleep:async()=>{}});
  assert.equal(chosen.value,'9-10:15-10:30');assert.deepEqual(await f.page.evaluate(()=>[window.slotChanges,window.storeClicks]),[2,0]);assert.equal(f.outbound(),1);
});

test('Continue never submits a time or date withdrawn after the last calendar read', async t => {
  const body=apwSummary()+'<input id="store" type="radio" name="store-locator-result" value="R119" checked><label for="store">Apple 渋谷</label><input id="date9" type="radio" name="bartPickupDateSelectorButtonGroup" value="9" checked><label for="date9">November9</label><select data-autom="pickup-availablewindow-dropdown"><option value="9-10:00-10:15">10:00</option></select><button data-autom="fulfillment-continue-button" onclick="window.continues++">続ける</button><script>window.continues=0</script>';
  const f=await fixture(t,{path:'/jp/shop/apw/checkout?_s=Fulfillment-init',body});
  for(const kind of ['slot','date','date-mismatch','select']){
    await f.page.evaluate(kind=>{const date=document.getElementById('date9'),select=document.querySelector('select'),option=select.options[0];date.disabled=kind==='date';date.value=kind==='date-mismatch'?'10':'9';select.disabled=kind==='select';option.disabled=kind==='slot';},kind);
    await assert.rejects(f.run({action:'pickup-continue',storeId:'R119'}),/PICKUP_TIME_REQUIRED/);
  }
  assert.equal(await f.page.evaluate(()=>window.continues),0);assert.equal(f.outbound(),1);
});

test('Apple Pay appearing during a calendar replan prevents the replacement slot mutation', async t => {
  const body=apwSummary()+'<input id="store" type="radio" name="store-locator-result" value="R119" checked><label for="store"><span class="form-selector-title">Apple 渋谷</span></label><input id="date9" type="radio" name="bartPickupDateSelectorButtonGroup" value="9" checked><label for="date9">November9</label><select data-autom="pickup-availablewindow-dropdown"><option value="">選択</option><option value="9-10:00-10:15">10:00</option><option value="9-10:15-10:30">10:15</option></select>';
  const f=await fixture(t,{path:'/jp/shop/apw/checkout?_s=Fulfillment-init',body}),ui={known:true,active:false,kind:'none'};let changes=0;
  const s=fixtureSafari(f,{nativeStatus:ui,afterEvaluate:async script=>{if(script.includes('function pickupScheduleDOM')&&script.includes('"action":"slot"')){changes++;await f.page.locator('select').evaluate(e=>e.selectedOptions[0].disabled=true);ui.active=true;ui.kind='apple-pay';}}}),{choosePickupSchedule}=await import('./pickup-time.mjs'),began=Date.UTC(2026,10,8,13);
  await assert.rejects(choosePickupSchedule(p=>s.evaluate(pickupScheduleDOM,{...p,storeId:'R119',storeLabels:['渋谷']},{guardPayment:p.action!=='read'}),{checkoutAt:began,now:()=>began,sleep:async()=>{}}),/PAYMENT_ACTIVE/);
  assert.equal(changes,1);assert.equal(await f.page.locator('select').inputValue(),'9-10:00-10:15');assert.equal(f.outbound(),1);
});

test('a Pro date change waits for matching new options and a lost reply never repeats the date click', async t => {
  const body=apwSummary()+'<input id="store" type="radio" name="store-locator-result" value="R119" checked><label for="store"><span class="form-selector-title">Apple 渋谷</span></label><input id="bartPickupDateSelector9" type="radio" name="bartPickupDateSelectorButtonGroup" value="9" checked><label for="bartPickupDateSelector9">November9</label><input id="bartPickupDateSelector8" type="radio" name="bartPickupDateSelectorButtonGroup" value="8"><label for="bartPickupDateSelector8">November8</label><select data-autom="pickup-availablewindow-dropdown"><option value="9-10:00-10:15">10:00</option></select>';
  const f=await fixture(t,{path:'/jp/shop/apw/checkout?_s=Fulfillment-init',body});
  await f.page.evaluate(()=>{window.dateClicks=0;document.getElementById('bartPickupDateSelector8').onclick=()=>{window.dateClicks++;setTimeout(()=>{document.querySelector('select').innerHTML='<option value="">選択</option><option value="8-17:00-17:15">17:00</option>';},80)};});
  let lost=false;const s=fixtureSafari(f,{loseReply:script=>{if(!lost&&script.includes('function pickupScheduleDOM')&&script.includes('"action":"date"')){lost=true;return true;}return false;}}),{choosePickupSchedule}=await import('./pickup-time.mjs'),began=Date.UTC(2026,10,8,7);
  const read=async p=>{try{return await s.evaluate(pickupScheduleDOM,{...p,storeId:'R119',storeLabels:['渋谷']},{guardPayment:p.action!=='read'});}catch(e){if(e.message!=='SAFARI_SCRIPT_UNAVAILABLE')throw e;return{requested:true,replyUncertain:true};}};
  const chosen=await choosePickupSchedule(read,{checkoutAt:began,now:()=>began,sleep:ms=>new Promise(r=>setTimeout(r,ms))});
  assert.equal(chosen.value,'8-17:00-17:15');assert.equal(await f.page.evaluate(()=>window.dateClicks),1);assert.equal(lost,true);assert.equal(f.outbound(),1);
});

test('late contact fields are filled in the existing checkout after readiness without another Continue or payment click', async t => {
  const f=await fixture(t,{path:'/jp/shop/apw/checkout?_s=PickupContact-init',body:'<span class="rs-companionbar-button-amount">100,000円</span><button class="rs-checkout-applepay-button" aria-label="Apple Pay">Apple Pay</button>'});
  let clock=0,inserted=false;const s=fixtureSafari(f,{now:()=>clock,sleep:async ms=>{clock+=ms;if(!inserted&&clock>=200){inserted=true;await f.page.evaluate(body=>document.body.insertAdjacentHTML('beforeend',body),contactForm());}}});s.setPickupContact(contact);
  const stages=[];await s.prepareCheckout(selection,'R119',()=>{},code=>stages.push(code));
  assert.ok(stages.includes('CONTACTS_READY'));assert.equal(inserted,true);assert.ok(clock<1000);assert.equal(f.outbound(),1);
  assert.equal(await f.page.evaluate(()=>document.getElementById('checkout.pickupContact.selfPickupContact.selfContact.address.emailAddress').value),contact.emailAddress);
});

test('contact validation can stay busy after filling while passive readiness waits without refilling or authorizing payment', async t => {
  const f=await fixture(t,{path:'/jp/shop/apw/checkout?_s=PickupContact-init',body:'<span class="rs-companionbar-button-amount">100,000円</span>'+contactForm()+'<button class="rs-checkout-applepay-button" aria-label="Apple Pay">Apple Pay</button>'});
  await f.page.evaluate(()=>{document.querySelectorAll('input').forEach(e=>e.addEventListener('change',()=>{document.body.setAttribute('aria-busy','true');setTimeout(()=>document.body.removeAttribute('aria-busy'),200)}));});
  let fills=0;const s=fixtureSafari(f,{beforeEvaluate:async script=>{if(script.includes('"action":"prepare-contact"'))fills++;}});s.setPickupContact(contact);const stages=[];
  await s.prepareCheckout(selection,'R119',()=>{},code=>stages.push(code));
  assert.equal(fills,1);assert.ok(stages.includes('CONTACTS_READY'));assert.equal(f.outbound(),1);assert.equal(await f.page.locator('body').getAttribute('aria-busy'),null);
});
test('ready direct Apple Pay contacts use one guarded preparation and omit redundant reads',async t=>{
  const f=await fixture(t,{path:'/jp/shop/apw/checkout?_s=PickupContact-init',body:'<span class="rs-companionbar-button-amount">100,000円</span>'+contactForm()+'<button class="rs-checkout-applepay-button" aria-label="Apple Pay">Apple Pay</button>'}),actions=[];
  const s=fixtureSafari(f,{beforeEvaluate:script=>{const action=script.match(/"action":"([a-z-]+)"/)?.[1];if(action)actions.push(action);}});s.setPickupContact(contact);
  await s.prepareCheckout(selection,'R119',()=>{});
  assert.deepEqual(actions,['inspect','prepare-contact']);assert.equal(f.outbound(),1);
});
test('a lost combined contact reply reconciles field values without filling them twice',async t=>{
  const f=await fixture(t,{path:'/jp/shop/apw/checkout?_s=PickupContact-init',body:'<span class="rs-companionbar-button-amount">100,000円</span>'+contactForm()+'<button class="rs-checkout-applepay-button" aria-label="Apple Pay">Apple Pay</button>'}),actions=[];let lost=false;
  const s=fixtureSafari(f,{beforeEvaluate:script=>{const action=script.match(/"action":"([a-z-]+)"/)?.[1];if(action)actions.push(action);},loseReply:script=>{if(!lost&&script.includes('"action":"prepare-contact"')){lost=true;return true;}return false;}});s.setPickupContact(contact);await s.prepareCheckout(selection,'R119',()=>{});
  assert.equal(lost,true);assert.equal(actions.filter(a=>a==='prepare-contact').length,1);assert.ok(actions.includes('contact-state'));assert.ok(actions.includes('contact-continue'));assert.equal(f.outbound(),1);
});
for(const change of ['busy','error','payment','price'])test('combined contact preparation refuses a page that becomes '+change+' during input',async t=>{
  const f=await fixture(t,{path:'/jp/shop/apw/checkout?_s=PickupContact-init',body:'<span class="rs-companionbar-button-amount">100,000円</span>'+contactForm()+'<button class="rs-checkout-applepay-button" aria-label="Apple Pay">Apple Pay</button>'});
  await f.page.evaluate(change=>{document.querySelector('input').addEventListener('change',()=>{if(change==='busy')document.body.setAttribute('aria-busy','true');if(change==='error')document.body.insertAdjacentHTML('beforeend','<div role="alert">Invalid contact</div>');if(change==='payment')window.__applePickupPayment={active:true};if(change==='price')document.querySelector('.rs-companionbar-button-amount').textContent='200,000円';});},change);
  const result=await f.run({action:'prepare-contact',contact});assert.equal(result.readyForApplePay,false);assert.ok(!JSON.stringify(result).includes(contact.emailAddress));assert.equal(f.outbound(),1);
});

test('the exact APW pickup rejection proves pre-payment failure only before an observed or authorized payment', async t => {
  const body=apwSummary()+'<div role="alert">この商品は、選択した場所で受け取ることはできません。別の場所か配送オプションを選択してください。</div>';
  const f=await fixture(t,{path:'/jp/shop/apw/checkout?_s=Fulfillment-init',body});
  assert.equal((await f.run({action:'inspect'})).prePaymentRejection,false);
  await f.page.evaluate(()=>{document.documentElement.setAttribute('data-apple-loop-pay-dispatched','fixture-attempt');window.__applePickupPayment={observed:false,authorized:false,completed:false};});
  const failed=await f.run({action:'inspect'});assert.equal(failed.stockFailure,true);assert.equal(failed.prePaymentRejection,true);
  for(const key of ['observed','authorized','completed']){await f.page.evaluate(key=>{window.__applePickupPayment={observed:false,authorized:false,completed:false,[key]:true};},key);assert.equal((await f.run({action:'inspect'})).prePaymentRejection,false);}
  await f.page.evaluate(()=>{window.__applePickupPayment={observed:false,authorized:false,completed:false};history.replaceState({},'', '/jp/shop/apw/checkout?_s=PickupContact-init');});assert.equal((await f.run({action:'inspect'})).prePaymentRejection,false);
});

test('a partial contact form is not modified until all four inputs are available', async t => {
  const f=await fixture(t,{path:'/jp/shop/apw/checkout?_s=PickupContact-init',body:contactForm().replace(/<input[^>]*mobilePhone[^>]*>/,'')});
  await assert.rejects(f.run({action:'fill-contact',contact}),/CONTACT_FIELDS_LOADING/);
  assert.deepEqual(await f.page.locator('input').evaluateAll(es=>es.map(e=>e.value)),['','','']);
});

test('Apple Pay pickup without offered appointment controls advances only after Apple accepts pickup', async t => {
  const f = await fixture(t, { path: '/jp/shop/apw/checkout?_s=Fulfillment-init', body: noSlotBody() });
  const nextBody = '<span class="rs-companionbar-button-amount">100,000円</span>'+contactForm()+'<button class="rs-checkout-applepay-button" aria-label="Apple Pay">Apple Pay</button>';
  await f.page.evaluate(body => { document.getElementById('next').onclick=()=>{history.replaceState({},'', '/jp/shop/apw/checkout?_s=PickupContact-init');document.body.innerHTML=body;window.payClicks=0;document.querySelector('.rs-checkout-applepay-button').onclick=()=>window.payClicks++}; },nextBody);
  const s=fixtureSafari(f),stages=[];s.binding.nonce='fixture-nonce';s.setPickupContact(contact);await s.prepareCheckout(selection,'R119',()=>{},code=>stages.push(code));
  assert.ok(stages.includes('PICKUP_TIME_NOT_OFFERED'));assert.ok(stages.includes('CONTACTS_READY'));const proof=await f.page.evaluate(()=>window.__applePickupCheckoutProof);assert.equal(proof.slot,null);assert.equal(proof.windowMode,'not-offered');assert.equal(proof.pickupAccepted,true);
  await f.run({action:'arm-apple-pay',store:STORES[0],contact,nonce:'fixture-nonce',attempt:'fixture-attempt'});assert.equal(await f.page.evaluate(()=>window.payClicks),0);assert.equal(f.outbound(),1);
});

test('missing appointment controls cannot arm Apple Pay before pickup acceptance is verified', async t => {
  const f=await fixture(t,{path:'/jp/shop/apw/checkout?_s=Fulfillment-init',body:noSlotBody()});assert.equal((await scheduleRead(f)).windowMode,'not-offered');
  await f.run({action:'pickup-continue',storeId:'R119',nonce:'fixture-nonce'});
  await f.page.evaluate(body=>{history.replaceState({},'', '/jp/shop/apw/checkout?_s=PickupContact-init');document.body.innerHTML=body},'<span class="rs-companionbar-button-amount">100,000円</span>'+contactForm()+'<button class="rs-checkout-applepay-button" aria-label="Apple Pay">Apple Pay</button>');
  await f.run({action:'fill-contact',contact});assert.equal((await f.run({action:'inspect'})).pickupNeedsAcceptance,true);
  await assert.rejects(f.run({action:'arm-apple-pay',store:STORES[0],contact,nonce:'fixture-nonce',attempt:'fixture-attempt'}),/REVIEW_CHANGED/);
  await assert.rejects(f.run({action:'pickup-accepted',storeId:'R119',nonce:'wrong-nonce'}),/PICKUP_ACCEPTANCE_UNVERIFIED/);assert.equal((await f.run({action:'pickup-accepted',storeId:'R119',nonce:'fixture-nonce'})).accepted,true);
});

test('accepted contact transition reuses its verified page without an immediate duplicate Safari read', async t => {
  const f = await fixture(t, { path: '/jp/shop/apw/checkout?_s=Fulfillment-init', body: noSlotBody() });
  await f.page.evaluate(body => { document.getElementById('next').onclick = () => { history.replaceState({}, '', '/jp/shop/apw/checkout?_s=PickupContact-init'); document.body.innerHTML = body; }; }, '<span class="rs-companionbar-button-amount">100,000円</span>' + contactForm() + '<button class="rs-checkout-applepay-button">Apple Pay</button>');
  let contactReads = 0;
  const s = fixtureSafari(f, { afterEvaluate: async script => {
    if (script.includes('"action":"inspect"') && f.page.url().includes('PickupContact-init')) contactReads++;
  } });
  s.binding.nonce = 'fixture-nonce'; s.setPickupContact(contact);
  await s.prepareCheckout(selection, 'R119', () => {});
  assert.equal(contactReads, 1);
  assert.deepEqual(await f.page.locator('input').evaluateAll(elements => elements.map(e => e.value)), Object.values(contact));
  assert.equal(f.outbound(), 1);
});

test('accepted contact transition still guards native authorization before filling contacts', async t => {
  for (const known of [false, true]) {
    const f = await fixture(t, { path: '/jp/shop/apw/checkout?_s=Fulfillment-init', body: noSlotBody() });
    await f.page.evaluate(body => { document.getElementById('next').onclick = () => { history.replaceState({}, '', '/jp/shop/apw/checkout?_s=PickupContact-init'); document.body.innerHTML = body; }; }, '<span class="rs-companionbar-button-amount">100,000円</span>' + contactForm() + '<button class="rs-checkout-applepay-button">Apple Pay</button>');
    let contactReads = 0; const ui = { known: true, active: false, kind: 'none' };
    const s = fixtureSafari(f, { nativeStatus: ui, afterEvaluate: async script => {
      if (script.includes('"action":"inspect"') && f.page.url().includes('PickupContact-init')) { contactReads++; Object.assign(ui, { known, active: known, kind: known ? 'authorization' : 'unknown' }); }
    } });
    s.binding.nonce = 'fixture-nonce'; s.setPickupContact(contact);
    await assert.rejects(s.prepareCheckout(selection, 'R119', () => {}), known ? /PAYMENT_ACTIVE/ : /ACCESSIBILITY_REQUIRED/);
    assert.equal(contactReads, 1);
    assert.deepEqual(await f.page.locator('input').evaluateAll(elements => elements.map(e => e.value)), ['', '', '', '']);
    assert.equal(f.outbound(), 1);
  }
});

test('accepted contact transition honors a manual stop before any contact mutation or redundant read', async t => {
  const f = await fixture(t, { path: '/jp/shop/apw/checkout?_s=Fulfillment-init', body: noSlotBody() });
  await f.page.evaluate(body => { document.getElementById('next').onclick = () => { history.replaceState({}, '', '/jp/shop/apw/checkout?_s=PickupContact-init'); document.body.innerHTML = body; }; }, '<span class="rs-companionbar-button-amount">100,000円</span>' + contactForm() + '<button class="rs-checkout-applepay-button">Apple Pay</button>');
  let stopped = false, contactReads = 0;
  const s = fixtureSafari(f, { afterEvaluate: async script => {
    if (script.includes('"action":"inspect"') && f.page.url().includes('PickupContact-init')) { contactReads++; stopped = true; }
  } });
  s.binding.nonce = 'fixture-nonce'; s.setPickupContact(contact);
  await assert.rejects(s.prepareCheckout(selection, 'R119', () => { if (stopped) throw Error('STOPPED'); }), /STOPPED/);
  assert.equal(contactReads, 1);
  assert.deepEqual(await f.page.locator('input').evaluateAll(elements => elements.map(e => e.value)), ['', '', '', '']);
  assert.equal(f.outbound(), 1);
});

test('hidden appointment controls or a disabled Continue still require calendar readiness', async t => {
  for(const extra of ['<input name="bartPickupDateSelectorButtonGroup" hidden>','<script>document.getElementById("next").disabled=true</script>']){
    const f=await fixture(t,{path:'/jp/shop/apw/checkout?_s=Fulfillment-init',body:noSlotBody()+extra});assert.equal((await scheduleRead(f)).ready,false);await assert.rejects(f.run({action:'pickup-continue',storeId:'R119',nonce:'fixture-nonce'}),/PICKUP_TIME_REQUIRED/);
  }
});
test('a calendar revealed by Continue is selected in the same pickup step without the 30 second contact timeout', async t => {
  for(const emptyAlert of [false,true])for(const loseReply of [false,true]){
  const f=await fixture(t,{path:'/jp/shop/apw/checkout?_s=Fulfillment-init',body:noSlotBody()+(emptyAlert?'<div role="alert" style="height:1px;width:1px"></div>':'')});
  const calendar='<input id="date8" type="radio" name="bartPickupDateSelectorButtonGroup" value="8" checked><label for="date8">November8</label><select data-autom="pickup-availablewindow-dropdown"><option value="">選択</option><option value="8-17:30-17:45">17:30</option></select>';
  const contactBody='<span class="rs-companionbar-button-amount">100,000円</span>'+contactForm()+'<button class="rs-checkout-applepay-button" aria-label="Apple Pay">Apple Pay</button>';
  await f.page.evaluate(({calendar,contactBody})=>{window.continues=0;document.getElementById('next').onclick=()=>{window.continues++;if(window.continues===1){document.body.insertAdjacentHTML('beforeend',calendar)}else{history.replaceState({},'', '/jp/shop/apw/checkout?_s=PickupContact-init');document.body.innerHTML=contactBody}}},{calendar,contactBody});
  let clock=Date.UTC(2026,10,8,6),lost=false;const s=fixtureSafari(f,{now:()=>clock,sleep:async ms=>{clock+=ms},loseReply:script=>{if(loseReply&&!lost&&script.includes('"action":"pickup-continue"')){lost=true;return true}return false}}),stages=[];s.setPickupContact(contact);s.binding.nonce='fixture-nonce';await s.prepareCheckout(selection,'R119',()=>{},code=>stages.push(code));
  assert.ok(stages.includes('PICKUP_CALENDAR_APPEARED'));assert.ok(stages.includes('PICKUP_TIME_VERIFIED'));assert.ok(stages.includes('CONTACTS_READY'));assert.equal(await f.page.evaluate(()=>window.continues),2);assert.ok(clock-Date.UTC(2026,10,8,6)<2000);assert.equal(f.outbound(),1);
  }
});
test('a real Apple error or an accessible error label still blocks the no-calendar continuation',async t=>{
 for(const alert of ['<div role="alert">Checkout error</div>','<div role="alert" aria-label="Checkout error" style="height:1px;width:1px"></div>']){
  const f=await fixture(t,{path:'/jp/shop/apw/checkout?_s=Fulfillment-init',body:noSlotBody()+alert});
  const read=await scheduleRead(f);assert.equal(read.ready,false);assert.notEqual(read.windowMode,'not-offered');
  await assert.rejects(f.run({action:'pickup-continue',storeId:'R119',nonce:'fixture-nonce'}),/PICKUP_TIME_REQUIRED/);
 }
});
test('a calendar appearing just before Continue is selected before the first continuation request', async t => {
  const f=await fixture(t,{path:'/jp/shop/apw/checkout?_s=Fulfillment-init',body:noSlotBody()});const nextBody='<span class="rs-companionbar-button-amount">100,000円</span>'+contactForm()+'<button class="rs-checkout-applepay-button" aria-label="Apple Pay">Apple Pay</button>';
  await f.page.evaluate(body=>{window.continues=0;document.getElementById('next').onclick=()=>{window.continues++;history.replaceState({},'', '/jp/shop/apw/checkout?_s=PickupContact-init');document.body.innerHTML=body}},nextBody);
  let inserted=false;const stages=[];const s=fixtureSafari(f,{now:()=>Date.UTC(2026,10,8,6),sleep:async()=>{},beforeEvaluate:async script=>{if(!inserted&&script.includes('"action":"pickup-continue"')){inserted=true;await f.page.evaluate(()=>document.body.insertAdjacentHTML('beforeend','<input id="date8" type="radio" name="bartPickupDateSelectorButtonGroup" value="8" checked><label for="date8">November8</label><select data-autom="pickup-availablewindow-dropdown"><option value="">選択</option><option value="8-17:30-17:45">17:30</option></select>'))}}});s.setPickupContact(contact);s.binding.nonce='fixture-nonce';await s.prepareCheckout(selection,'R119',()=>{},code=>stages.push(code));assert.equal(await f.page.evaluate(()=>window.continues),1);assert.ok(stages.includes('PICKUP_CALENDAR_APPEARED'));assert.ok(stages.includes('PICKUP_TIME_VERIFIED'));
});
test('stock lost after Continue is detected in pickup without waiting for contacts or replaying Continue', async t => {
  const f=await fixture(t,{path:'/jp/shop/apw/checkout?_s=Fulfillment-init',body:noSlotBody()});await f.page.evaluate(()=>{window.continues=0;document.getElementById('next').onclick=()=>{window.continues++;document.getElementById('store').disabled=true}});
  let clock=0;const s=fixtureSafari(f,{now:()=>clock,sleep:async ms=>{clock+=ms}});await assert.rejects(s.prepareCheckout(selection,'R119',()=>{}),/STOCK_FAILED/);assert.equal(await f.page.evaluate(()=>window.continues),1);assert.ok(clock<1000);
});
test('a visible date can be chosen before Apple creates its time dropdown, including radios represented by labels', async t => {
  const body=apwSummary()+'<input id="store" type="radio" name="store-locator-result" value="R119" checked><label for="store"><span class="form-selector-title">Apple 渋谷</span></label><input id="date8" style="display:none" type="radio" name="bartPickupDateSelectorButtonGroup" value="8"><label for="date8">November8</label>';
  const f=await fixture(t,{path:'/jp/shop/apw/checkout?_s=Fulfillment-init',body});await f.page.evaluate(()=>{document.getElementById('date8').onclick=()=>{document.body.insertAdjacentHTML('beforeend','<select data-autom="pickup-availablewindow-dropdown"><option value="">選択</option><option value="8-17:30-17:45">17:30</option></select>')}});
  const s=fixtureSafari(f);const {choosePickupSchedule}=await import('./pickup-time.mjs');const chosen=await choosePickupSchedule(p=>s.evaluate(pickupScheduleDOM,{...p,storeId:'R119',storeLabels:['渋谷']}),{checkoutAt:Date.UTC(2026,10,8,6),now:()=>Date.UTC(2026,10,8,6),sleep:async()=>{}});assert.equal(chosen.value,'8-17:30-17:45');assert.equal(f.outbound(),1);
});
test('web modal dialogs preserve CAP, Store and calendar controls while native checks skip page content', async t => {
  const f=await fixture(t,{path:'/jp/shop/apw/checkout?_s=Fulfillment-init',body:noSlotBody()+'<div role="dialog" aria-modal="true">Operator action</div>'});
  for(const action of ['store','postal-open','pickup-continue'])await assert.rejects(f.run({action,storeId:'R119',postalCode:'150-0041'}),/PAGE_BUSY/);
  const read=()=>f.page.evaluate(source=>(0,eval)('('+source+')')({action:'read',storeId:'R119',storeLabels:['渋谷']}),pickupScheduleDOM.toString());assert.equal((await read()).reason,'page-busy');
});

test('stale disabled Store is refreshed through CAP before the checkout declares stock lost', async t => {
  const f = await fixture(t, { path: '/jp/shop/apw/checkout?_s=Fulfillment-init', body: postalFixture(true) });
  const s = fixtureSafari(f), stages = [];
  await assert.rejects(s.prepareCheckout(selection, 'R119', () => {}, stage => { stages.push(stage); if (stage === 'STORE_VERIFIED') throw Error('FIXTURE_STOP_BEFORE_PAYMENT'); }), /FIXTURE_STOP_BEFORE_PAYMENT/);
  assert.deepEqual(stages, ['PICKUP_READY','PICKUP_POSTAL_EDITOR_READY','PICKUP_POSTAL_RESPONSE_VERIFIED','PICKUP_AVAILABILITY_REFRESHED','STORE_VERIFIED']);
  assert.deepEqual(await f.page.evaluate(() => [window.searches,window.storeClicks]), [1,1]);
  assert.equal((await f.run({ action: 'inspect' })).fulfillmentMode, 'pickup'); assert.equal(f.outbound(), 1);
});
test('stock still unavailable after the refreshed list fails once without a CAP retry loop', async t => {
  const f = await fixture(t, { path: '/jp/shop/apw/checkout?_s=Fulfillment-init', body: postalFixture(false) });
  const s = fixtureSafari(f), stages = [];
  await assert.rejects(s.prepareCheckout(selection, 'R119', () => {}, stage => stages.push(stage)), /STOCK_FAILED/);
  assert.ok(stages.includes('PICKUP_AVAILABILITY_REFRESHED')); assert.deepEqual(await f.page.evaluate(() => [window.searches,window.storeClicks]), [1,0]); assert.equal(f.outbound(), 1);
});

test('Apple delivery-only response after CAP is a terminal pickup failure even when all locator controls disappear', async t => {
  const f = await fixture(t, { path: '/jp/shop/apw/checkout?_s=Fulfillment-init', body: postalFixture(false) });
  await f.page.evaluate(() => { document.getElementById('checkout.fulfillment.pickupTab.pickup.storeLocator.search').onclick = () => { window.searches++; document.querySelector('.rt-storelocator-store-list').remove(); document.getElementById('postal-editor').remove(); document.querySelector('[data-autom="fulfillment-pickup-store-search-button"]').remove(); const h=document.createElement('h2'); h.textContent='ご注文の商品のお受け取りは配送のみとなります。'; document.body.append(h); }; });
  const s = fixtureSafari(f), stages = []; await assert.rejects(s.prepareCheckout(selection, 'R119', () => {}, stage => stages.push(stage)), /STOCK_FAILED/);
  assert.ok(stages.includes('PICKUP_DELIVERY_ONLY')); assert.equal((await f.run({ action: 'inspect' })).pickupUnavailable, true); assert.equal((await f.run({ action: 'postal-state' })).refreshComplete, true); assert.equal(s.pendingPostal, null); assert.equal(await f.page.evaluate(() => window.searches), 1); assert.equal(f.outbound(), 1);
});

test('an existing delivery-only response is refreshed once in place and never proceeds to shipping or payment', async t => {
  const body = apwSummary() + '<h2>ご注文の商品のお受け取りは配送のみとなります。</h2><script>document.querySelectorAll("[role=radio]").forEach(e=>e.onclick=()=>{document.querySelectorAll("[role=radio]").forEach(r=>r.setAttribute("aria-checked",String(r===e)));void fetch("/jp/shop/apw/checkoutx?_a=selectFulfillmentLocationAction&_m=checkout.fulfillment.fulfillmentOptions").then(r=>r.json());})</script>';
  const f = await fixture(t, { path: '/jp/shop/apw/checkout?_s=Fulfillment-init', body }), s = fixtureSafari(f, { sleep: async () => {} }), stages = [];
  await assert.rejects(s.prepareCheckout(selection, 'R119', () => {}, stage => stages.push(stage)), /STOCK_FAILED/); assert.ok(stages.includes('PICKUP_DELIVERY_ONLY')); assert.equal((await f.run({ action: 'inspect' })).fulfillmentMode, 'pickup'); assert.equal(f.outbound(), 1);
});
test('a lost CAP submission reply is reconciled from the list without a second submit', async t => {
  for (const stage of ['fill','inline-submit','prepared-submit']) {
    const f = await fixture(t, { path: '/jp/shop/apw/checkout?_s=Fulfillment-init', body: postalFixture(true) });
    if (stage === 'inline-submit') await f.page.locator('[id="checkout.fulfillment.pickupTab.pickup.storeLocator.searchInput"]').evaluate((e,value)=>{e.value=value;},STORES[0].postalCode);
    const s = fixtureSafari(f, { loseReply: script => script.includes('"action":"' + (stage === 'prepared-submit' ? 'postal-submit' : 'postal') + '"') });
    await s.refreshStoreAvailability(STORES[0]); assert.equal(await f.page.evaluate(() => window.searches), 1); assert.equal((await f.run({ action: 'postal-state' })).refreshComplete, true); assert.equal(f.postalRequests(),1);
  }
});
test('a collapsed CAP editor and its old Store list do not prove the search response has arrived', async t => {
  const f = await fixture(t, { path: '/jp/shop/apw/checkout?_s=Fulfillment-init', body: postalFixture(true), postalResponseDelayMs: 300 });
  await f.page.evaluate(() => {
    document.getElementById('checkout.fulfillment.pickupTab.pickup.storeLocator.search').onclick = () => {
      window.searches++; document.getElementById('postal-editor').hidden = true;
      void fetch('/jp/shop/apw/checkoutx?_a=search&_m=checkout.fulfillment.fulfillmentOptions');
      document.addEventListener('fixture-postal-response', () => { document.getElementById('store').disabled = false; }, { once: true });
    };
  });
  const s = fixtureSafari(f); await s.refreshStoreAvailability(STORES[0]);
  assert.equal(await f.page.evaluate(() => window.__fixturePostalResponseDone), true);
  assert.equal(await f.page.locator('#store').isDisabled(), false); assert.equal(f.postalRequests(), 1); assert.equal(f.outbound(), 2);
});
test('a changed CAP is committed to the page model before its single Apply click', async t => {
  const f = await fixture(t, { path: '/jp/shop/apw/checkout?_s=Fulfillment-init', body: postalFixture(true) });
  await f.page.evaluate(() => {
    const input = document.getElementById('checkout.fulfillment.pickupTab.pickup.storeLocator.searchInput'), search = document.getElementById('checkout.fulfillment.pickupTab.pickup.storeLocator.search');
    input.value = '150-0001'; window.modelPostal = input.value;
    input.oninput = () => { const value = input.value; setTimeout(() => { window.modelPostal = value; }, 0); };
    const original = search.onclick; search.onclick = () => { window.submittedPostal = window.modelPostal; original(); };
  });
  const s = fixtureSafari(f); await s.refreshStoreAvailability(STORES[0]);
  assert.equal(await f.page.evaluate(() => window.submittedPostal), STORES[0].postalCode); assert.equal(f.postalRequests(), 1); assert.equal(f.outbound(), 1);
});
test('a completed CAP response is consumed immediately without a fixed delay or another search', async t => {
  const f = await fixture(t, { path: '/jp/shop/apw/checkout?_s=Fulfillment-init', body: postalFixture(true) });
  await f.page.evaluate(() => {
    document.querySelector('[data-autom="fulfillment-pickup-store-search-button"]').onclick = () => { document.getElementById('postal-editor').hidden = false; };
    document.getElementById('checkout.fulfillment.pickupTab.pickup.storeLocator.search').onclick = () => {
      window.searches++; document.getElementById('store').disabled = false; document.getElementById('postal-editor').hidden = true;
    };
  });
  const pauses = [], steps=[], s = fixtureSafari(f, { sleep: async ms => { pauses.push(ms); }, afterEvaluate: async script => {
    if (script.includes('"action":"postal-submit"')) {
      await f.page.waitForFunction(() => window.__applePickupPostalRefresh?.responseComplete);
      await new Promise(resolve=>setTimeout(resolve,120));
    }
  } });
  s.onTiming=step=>steps.push(step);
  await s.refreshStoreAvailability(STORES[0]);
  assert.deepEqual(pauses, []); assert.equal(s.pendingPostal, null);
  assert.equal(await f.page.evaluate(() => window.searches), 1); assert.equal(f.outbound(), 1);
  const response=steps.find(step=>step.name==='postal:response');
  assert.ok(Number.isSafeInteger(response.requestStartAfterSubmitMs)&&response.requestStartAfterSubmitMs>=0);
  assert.ok(response.verifiedAfterResponseMs>=100,'the delay after the response is not counted as Apple response duration');
});
for(const repeated of [false,true])test('a CAP editor that disappears before Apply is reopened only after an explicit pre-click rejection: '+repeated,async t=>{
 const f=await emptyPostalFixture(t,{available:true}),stages=[];
 let calls=0;
 const s=fixtureSafari(f,{beforeEvaluate:async script=>{
   if(!script.includes('"action":"postal-submit"'))return;
   calls++;
   if(calls===1||repeated)await f.page.evaluate(()=>{
     document.getElementById('postal-editor').hidden=true;
     document.querySelector('[data-autom="fulfillment-pickup-store-search-button"]').setAttribute('aria-expanded','false');
     const input=document.getElementById('checkout.fulfillment.pickupTab.pickup.storeLocator.searchInput');
     input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));
   });
 }});
 const result=s.refreshStoreAvailability(STORES[0],()=>{},undefined,stage=>stages.push(stage),{fast:true});
 if(repeated)await assert.rejects(result,/POSTAL_REFRESH_UNCERTAIN/);else assert.equal((await result).refreshComplete,true);
 assert.equal(calls,2);assert.equal(stages.filter(e=>e==='PICKUP_POSTAL_SUBMIT_REMOUNT_RECONCILED').length,1);
 assert.equal(stages.filter(e=>e==='PICKUP_POSTAL_EDITOR_RECOVERED').length,1);
 assert.equal(f.postalRequests(),repeated?0:1);assert.equal(f.outbound(),1);
});
test('fast CAP observation waits for a real reply and never consumes or replays the old Store list', async t => {
  const f = await fixture(t, { path: '/jp/shop/apw/checkout?_s=Fulfillment-init', body: postalFixture(true) });
  await f.page.evaluate(() => {
    document.querySelector('[data-autom="fulfillment-pickup-store-search-button"]').onclick = () => { document.getElementById('postal-editor').hidden = false; };
    document.getElementById('checkout.fulfillment.pickupTab.pickup.storeLocator.search').onclick = () => { window.searches++; document.body.setAttribute('aria-busy','true'); };
  });
  let responseReads = 0, clock = 0; const pauses = [];
  const s = fixtureSafari(f, { now: () => clock, sleep: async ms => { pauses.push(ms); clock += ms; }, afterEvaluate: async script => {
    if (script.includes('"action":"postal-submit"')) await f.page.waitForFunction(() => window.__applePickupPostalRefresh?.responseComplete);
  }, beforeEvaluate: async script => {
    if (!script.includes('"action":"postal-state"') || !await f.page.evaluate(() => window.searches)) return;
    responseReads++;
    if (responseReads === 3) await f.page.evaluate(() => { document.getElementById('store').disabled = false; document.getElementById('postal-editor').hidden = true; document.body.removeAttribute('aria-busy'); });
  } });
  await s.refreshStoreAvailability(STORES[0], () => {}, 1000);
  assert.equal(responseReads, 3); assert.deepEqual(pauses, [50,50]);
  assert.equal(await f.page.evaluate(() => window.searches), 1); assert.equal(s.pendingPostal, null); assert.equal(f.outbound(), 1);
});
test('an uncertain CAP response remains read-only when checkout recovery calls it again', async t => {
  const f = await fixture(t, { path: '/jp/shop/apw/checkout?_s=Fulfillment-init', body: postalFixture(false) });
  await f.page.evaluate(() => { document.getElementById('checkout.fulfillment.pickupTab.pickup.storeLocator.search').onclick = () => window.searches++; });
  let clock = 0; const s = fixtureSafari(f, { now: () => clock, sleep: async ms => { clock += ms; await f.page.waitForTimeout(25); } });
  await assert.rejects(s.refreshStoreAvailability(STORES[0], () => {}, 1500), /POSTAL_REFRESH_UNCERTAIN/);
  await assert.rejects(s.refreshStoreAvailability(STORES[0], () => {}, clock + 500), /POSTAL_REFRESH_UNCERTAIN/);
  assert.equal(await f.page.evaluate(() => window.searches), 1);
});
test('a lost new CAP dispatch cannot consume a completed response from an earlier refresh or replay search', async t => {
  const f = await fixture(t, { path: '/jp/shop/apw/checkout?_s=Fulfillment-init', body: postalFixture(false) });
  await f.page.evaluate(() => {
    document.getElementById('postal-editor').hidden = false;
    window.__applePickupPostalRefresh = { id: crypto.randomUUID(), submitted: true, changed: true, responseRequired: true, responseComplete: true };
  });
  let clock = 0, dispatches = 0;
  const s = fixtureSafari(f, { now: () => clock, sleep: async ms => { clock += ms; }, beforeEvaluate: script => {
    if (script.includes('"action":"postal"')) { dispatches++; throw Error('SAFARI_SCRIPT_UNAVAILABLE'); }
  } });
  await assert.rejects(s.refreshStoreAvailability(STORES[0], () => {}, 500), /POSTAL_REFRESH_UNCERTAIN/);
  await assert.rejects(s.refreshStoreAvailability(STORES[0], () => {}, clock + 500), /POSTAL_REFRESH_UNCERTAIN/);
  assert.equal(dispatches, 1); assert.equal(await f.page.evaluate(() => window.searches), 0); assert.equal(f.outbound(), 1);
});
test('a lost CAP editor opening recovers from a verified collapsed editor without replaying search', async t => {
  const f=await fixture(t,{path:'/jp/shop/apw/checkout?_s=Fulfillment-init',body:postalFixture(true)});
  await f.page.evaluate(()=>{const edit=document.querySelector('[data-autom="fulfillment-pickup-store-search-button"]');edit.setAttribute('aria-expanded','false');const open=edit.onclick;window.opens=0;edit.onclick=()=>{window.opens++;edit.setAttribute('aria-expanded','true');open()};});
  let clock=0,dropped=false;
  const s=fixtureSafari(f,{now:()=>clock,sleep:async ms=>{clock+=ms;await f.page.waitForTimeout(25)},beforeEvaluate:async script=>{if(!dropped&&script.includes('"action":"postal-open"')){dropped=true;throw Error('SAFARI_SCRIPT_UNAVAILABLE')}}});
  await s.refreshStoreAvailability(STORES[0],()=>{},5000);
  assert.equal(dropped,true);assert.deepEqual(await f.page.evaluate(()=>[window.opens,window.searches]),[1,1]);assert.equal(s.pendingPostal,null);assert.equal(f.outbound(),1);
});
test('a session expiring while CAP opens is classified immediately without sending a search',async t=>{
 const f=await fixture(t,{path:'/jp/shop/apw/checkout?_s=Fulfillment-init',body:postalFixture(true)});let clock=0;
 const s=fixtureSafari(f,{now:()=>clock,sleep:async ms=>{clock+=ms},beforeEvaluate:async script=>{if(script.includes('"action":"postal-open"'))await f.page.evaluate(()=>{history.replaceState({},'','/jp/shop/sorry/session_expired');document.body.innerHTML='<h1>セッションが時間切れになりました。</h1>';});}});
 await assert.rejects(s.refreshStoreAvailability(STORES[0],()=>{},25000),/PREORDER_SESSION_EXPIRED/);assert.equal(f.postalRequests(),0);assert.ok(clock<1000);
});
test('a verified expired document discards only the old CAP marker and leaves a pending document protected',async t=>{
 const f=await fixture(t,{path:'/jp/shop/sorry/session_expired',body:'<h1>セッションが時間切れになりました。</h1>'}),s=fixtureSafari(f);
 s.pendingPostal={storeId:'R079',id:'fixture',stage:'submitted'};await f.page.evaluate(()=>document.body.setAttribute('aria-busy','true'));await s.inspect();assert.ok(s.pendingPostal);
 await f.page.evaluate(()=>document.body.removeAttribute('aria-busy'));await s.inspect();assert.equal(s.pendingPostal,null);assert.equal(f.postalRequests(),0);
});
test('an empty CAP enables Apply only after filling and submits once after React updates', async t => {
  const f=await fixture(t,{path:'/jp/shop/apw/checkout?_s=Fulfillment-init',body:postalFixture(true)});
  await f.page.evaluate(()=>{const input=document.getElementById('checkout.fulfillment.pickupTab.pickup.storeLocator.searchInput'),button=document.getElementById('checkout.fulfillment.pickupTab.pickup.storeLocator.search');button.disabled=true;input.oninput=()=>setTimeout(()=>{button.disabled=false},30)});
  let clock=0;const s=fixtureSafari(f,{now:()=>clock,sleep:async ms=>{clock+=ms;await f.page.waitForTimeout(25)}});await s.refreshStoreAvailability(STORES[0],()=>{},5000);
  assert.equal(await f.page.evaluate(()=>window.searches),1);assert.equal(s.pendingPostal,null);assert.equal(f.outbound(),1);
});
test('CAP waits for its locator controls to mount instead of treating a loading panel as a changed control', async t => {
  const f=await fixture(t,{path:'/jp/shop/apw/checkout?_s=Fulfillment-init',body:postalFixture(true)});
  await f.page.evaluate(()=>{const button=document.querySelector('[data-autom="fulfillment-pickup-store-search-button"]');button.hidden=true;setTimeout(()=>{button.hidden=false},100)});
  const s=fixtureSafari(f);await s.refreshStoreAvailability(STORES[0]);assert.equal(await f.page.evaluate(()=>window.searches),1);assert.equal(s.pendingPostal,null);assert.equal(f.outbound(),1);
});
test('CAP waits for Apply to mount even when its input is already visible and ready', async t => {
  const f = await fixture(t, { path: '/jp/shop/apw/checkout?_s=Fulfillment-init', body: postalFixture(true) });
  await f.page.evaluate(() => {
    document.getElementById('postal-editor').hidden = false;
    const button = document.getElementById('checkout.fulfillment.pickupTab.pickup.storeLocator.search');
    button.hidden = true; setTimeout(() => { button.hidden = false; }, 100);
  });
  const s = fixtureSafari(f); await s.refreshStoreAvailability(STORES[0]);
  assert.equal(await f.page.evaluate(() => window.searches), 1); assert.equal(s.pendingPostal, null); assert.equal(f.outbound(), 1);
});
test('an explicit pre-submit Apply remount retries readiness without treating the old CAP result as a new response', async t => {
  const f = await fixture(t, { path: '/jp/shop/apw/checkout?_s=Fulfillment-init', body: postalFixture(true) });
  let remounted = false; const stages = [];
  const s = fixtureSafari(f, { beforeEvaluate: async script => {
    if (remounted || !script.includes('"action":"postal"')) return;
    remounted = true;
    await f.page.evaluate(() => {
      const button = document.getElementById('checkout.fulfillment.pickupTab.pickup.storeLocator.search');
      button.hidden = true; setTimeout(() => { button.hidden = false; }, 100);
    });
  } });
  await s.refreshStoreAvailability(STORES[0], () => {}, Date.now() + 5000, stage => stages.push(stage));
  assert.equal(remounted, true); assert.ok(stages.includes('PICKUP_POSTAL_CONTROLS_LOADING'));
  assert.equal(await f.page.evaluate(() => window.searches), 1); assert.equal(s.pendingPostal, null); assert.equal(f.outbound(), 1);
});
test('calendar read and lost slot replies reconcile on the selected Store without restarting checkout', async t => {
  const body = apwSummary() + '<input id="store" type="radio" name="store-locator-result" value="R119" checked><label for="store"><span class="form-selector-title">Apple 渋谷</span></label><input id="date8" type="radio" name="bartPickupDateSelectorButtonGroup" value="8" checked><label for="date8">11月8日</label><select data-autom="pickup-availablewindow-dropdown"><option value="">選択</option><option value="8-13:00-14:00">13:00</option></select>';
  const f = await fixture(t, { path: '/jp/shop/apw/checkout?_s=Fulfillment-init', body }); let lostRead = false, lostSlot = false, slotCalls = 0;
  const s = fixtureSafari(f, { now: () => Date.UTC(2026,10,8,3), sleep: async () => {}, loseReply: script => {
    if (!script.includes('function pickupScheduleDOM')) return false;
    if (script.includes('"action":"read"') && !lostRead) { lostRead = true; return true; }
    if (script.includes('"action":"slot"')) { slotCalls++; if (!lostSlot) { lostSlot = true; return true; } }
    return false;
  } });
  await assert.rejects(s.prepareCheckout(selection, 'R119', () => {}, stage => { if (stage === 'PICKUP_TIME_VERIFIED') throw Error('FIXTURE_STOP_BEFORE_PAYMENT'); }), /FIXTURE_STOP_BEFORE_PAYMENT/);
  assert.equal(lostRead, true); assert.equal(lostSlot, true); assert.equal(slotCalls, 1); assert.equal(f.outbound(), 1);
});
test('Store lost while its calendar loads is reported as stock loss through the Safari envelope', async t => {
  const body = apwSummary() + '<input id="store" type="radio" name="store-locator-result" value="R119" checked><label for="store"><span class="form-selector-title">Apple 渋谷</span></label>';
  const f = await fixture(t, { path: '/jp/shop/apw/checkout?_s=Fulfillment-init', body });
  const s = fixtureSafari(f, { beforeEvaluate: async script => { if (script.includes('function pickupScheduleDOM')) await f.page.locator('#store').evaluate(e => e.disabled = true); } });
  const timings = []; s.onTiming = step => timings.push(step);
  await assert.rejects(s.prepareCheckout(selection, 'R119', () => {}), /STOCK_FAILED/); assert.equal(f.outbound(), 1);
  assert.equal(timings.at(-1).name, 'calendar:read'); assert.equal(timings.at(-1).result, 'error'); assert.equal(timings.at(-1).code, 'STOCK_FAILED');
});
for(const mode of ['transient','persistent','different-store'])test('Store panel remount keeps the same checkout read-only: '+mode,async t=>{
 const body=apwSummary()+'<div id="store-panel"><input id="store" type="radio" name="store-locator-result" value="R119" checked><label for="store">Apple 渋谷</label></div>'+
  '<input id="date11" name="bartPickupDateSelectorButtonGroup" type="radio" value="11" checked><label for="date11">November11</label><select data-autom="pickup-availablewindow-dropdown"><option selected value="11-18:00-18:15">18:00</option></select>';
 const f=await fixture(t,{path:'/jp/shop/apw/checkout?_s=Fulfillment-init',body}),reads=[],timings=[];
 const s=fixtureSafari(f,{now:()=>Date.UTC(2026,10,11,7),beforeEvaluate:async script=>{
   if(!script.includes('function pickupScheduleDOM')||!script.includes('"action":"read"'))return;
   reads.push(true);
   if(reads.length===1)await f.page.evaluate(mode=>{
     const p=document.getElementById('store-panel'),at=performance.now()-(mode==='persistent'?500:0);
     window.__savedStorePanel=p.innerHTML;
     p.innerHTML=mode==='different-store'?'<input id="other" type="radio" name="store-locator-result" value="R224" checked><label for="other">Apple 表参道</label>':'';
     window.__applePickupStoreSelection={storeId:'R119',responseComplete:true,responseAt:at,startedAt:at-5000};
   },mode);
   if(reads.length===2&&mode==='transient')await f.page.evaluate(()=>{document.getElementById('store-panel').innerHTML=window.__savedStorePanel;});
 }});
 s.onTiming=step=>timings.push(step);
 await assert.rejects(s.prepareCheckout(selection,'R119',()=>{},stage=>{if(stage==='PICKUP_TIME_VERIFIED')throw Error('FIXTURE_STOP_BEFORE_PAYMENT');}),
   mode==='transient'?/FIXTURE_STOP_BEFORE_PAYMENT/:/STORE_UNVERIFIED/);
 assert.equal(reads.length,mode==='transient'?2:1);
 assert.equal(timings.some(e=>e.name==='calendar:wait-store-panel-remounting'),mode==='transient');
 if(mode==='different-store')assert.equal(timings.find(e=>e.name==='calendar:store-unverified').code,'CHECKED_1_CANDIDATES_0_DATES_1_SELECTORS_1');
 assert.ok(!timings.some(e=>['calendar:store-calendar','calendar:date','calendar:slot','dom:postal-submit','dom:pickup-continue'].includes(e.name)));
 assert.equal(f.outbound(),1);
});
test('Safari error diagnostics export only bounded calendar facts and never arbitrary page data',async t=>{
  const f=await fixture(t),s=fixtureSafari(f);
  await assert.rejects(s.evaluate(()=>{throw Object.assign(Error('STOCK_FAILED'),{pickupDiagnostic:{dateCount:3,selectorCount:-1,checkedStoreCount:1,storeResponseMs:9400,storeConfirmed:false,readinessReason:'store-disabled',privateURL:'https://example.invalid/private',contact:'private-fixture-value'}});},{action:'read'}),error=>{
    assert.equal(error.message,'STOCK_FAILED');
    assert.deepEqual(error.pickupDiagnostic,{dateCount:3,checkedStoreCount:1,storeResponseMs:9400,storeConfirmed:false,readinessReason:'store-disabled'});
    return true;
  });
});
for(const matching of [true,false])test('a rejected Store records response duration only for the matching request: '+matching,async t=>{
  const body=apwSummary()+'<input id="store" type="radio" name="store-locator-result" value="R119" checked><label for="store"><span class="form-selector-title">Apple 渋谷</span></label>';
  const f=await fixture(t,{path:'/jp/shop/apw/checkout?_s=Fulfillment-init',body}),timings=[];
  const s=fixtureSafari(f,{beforeEvaluate:async script=>{if(script.includes('function pickupScheduleDOM'))await f.page.evaluate(matching=>{const at=performance.now();window.__applePickupStoreSelection={storeId:matching?'R119':'R224',responseComplete:true,responseAt:at,startedAt:at-9400};document.getElementById('store').disabled=true;},matching);}});
  s.onTiming=step=>timings.push(step);await assert.rejects(s.prepareCheckout(selection,'R119',()=>{}),/STOCK_FAILED/);
  const response=timings.filter(step=>step.name==='calendar:store-response');
  assert.equal(response.length,matching?1:0);
  if(matching)assert.deepEqual(response[0],{name:'calendar:store-response',durationMs:9400,result:'error',code:'STOCK_FAILED'});
  assert.equal(f.outbound(),1);
});
test('Store selection waits for React and reconciles a lost reply without clicking the radio twice', async t => {
  for (const loseReply of [false,true]) {
    const body = apwSummary() + '<input id="store" type="radio" name="store-locator-result" value="R119"><label for="store">Apple 渋谷</label><script>window.clicks=0;document.getElementById("store").onclick=e=>{window.clicks++;const input=e.target;input.checked=false;void fetch("/jp/shop/apw/checkoutx?_a=select&_m=checkout.fulfillment.pickupTab.pickup.storeLocator").then(r=>r.json()).then(()=>setTimeout(()=>input.checked=true,30))};</script>';
    const f = await fixture(t, { path: '/jp/shop/apw/checkout?_s=Fulfillment-init', body });
    let storeRequests = 0;
    await f.page.route('**/jp/shop/apw/checkoutx?*', async route => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('_a') !== 'select') return route.fallback();
      storeRequests++; await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
    const s = fixtureSafari(f, { loseReply: script => loseReply && script.includes('"action":"store"') });
    await assert.rejects(s.prepareCheckout(selection, 'R119', () => {}, stage => { if (stage === 'STORE_VERIFIED') throw Error('FIXTURE_STOP_BEFORE_PAYMENT'); }), /FIXTURE_STOP_BEFORE_PAYMENT/);
    assert.equal(await f.page.evaluate(() => window.clicks), 1); assert.equal(storeRequests, 1); assert.equal(f.outbound(), 1);
  }
});
test('the first verified pickup observation is reused for Store selection, including after returning from delivery', async t => {
  for(const mode of ['selected','unselected','delivery']){
    const store='<input id="store" type="radio" name="store-locator-result" value="R119" '+(mode==='selected'?'checked':'')+'><label for="store">Apple 渋谷</label>';
    const f=await fixture(t,{path:'/jp/shop/apw/checkout?_s=Fulfillment-init',body:apwSummary()+(mode==='delivery'?'':store)});
    if(mode==='delivery')await f.page.evaluate(store=>{
      const options=[...document.querySelectorAll('[role="radio"]')];options[0].setAttribute('aria-checked','false');options[1].setAttribute('aria-checked','true');
      options[0].onclick=()=>{options[0].setAttribute('aria-checked','true');options[1].setAttribute('aria-checked','false');document.body.insertAdjacentHTML('beforeend',store);void fetch('/jp/shop/apw/checkoutx?_a=selectFulfillmentLocationAction&_m=checkout.fulfillment.fulfillmentOptions').then(r=>r.json());};
    },store);
    let extraStoreReads=0;const s=fixtureSafari(f,{beforeEvaluate:script=>{if(script.includes('"action":"store-state"'))extraStoreReads++;}});
    await assert.rejects(s.prepareCheckout(selection,'R119',()=>{},stage=>{if(stage==='STORE_VERIFIED')throw Error('FIXTURE_STOP_BEFORE_PAYMENT');}),/FIXTURE_STOP_BEFORE_PAYMENT/);
    assert.equal(extraStoreReads,0,mode);assert.equal(await f.page.locator('#store').isChecked(),true);assert.equal(f.outbound(),1);
  }
});
test('read-only Store inspection never permits CAP, calendar or Store changes behind active Apple Pay', async t => {
  for (const state of ['checked','','disabled']) {
    const body = postalFixture(false).replace('value="R119" disabled', 'value="R119" ' + state);
    const f = await fixture(t, { path: '/jp/shop/apw/checkout?_s=Fulfillment-init', body });
    let calendarCalls = 0;
    const s = fixtureSafari(f, { nativeStatus: { known: true, active: true, kind: 'apple-pay' }, beforeEvaluate: script => { if (script.includes('function pickupScheduleDOM')) calendarCalls++; } });
    await assert.rejects(s.prepareCheckout(selection, 'R119', () => {}), /PAYMENT_ACTIVE/);
    assert.equal(calendarCalls, 0); assert.deepEqual(await f.page.evaluate(() => [window.searches,window.storeClicks]), [0,0]); assert.equal(f.outbound(), 1);
  }
});
test('native authorization appearing after a calendar read blocks both date and time mutations', async t => {
  for(const mutation of ['date','slot'])for(const inaccessible of [false,true]){
    const body=apwSummary()+'<input id="store" type="radio" name="store-locator-result" value="R119" checked><label for="store"><span class="form-selector-title">Apple 渋谷</span></label><input id="date8" type="radio" name="bartPickupDateSelectorButtonGroup" value="8" '+(mutation==='slot'?'checked':'')+'><label for="date8">11月8日</label><select data-autom="pickup-availablewindow-dropdown"><option value="">選択</option><option value="8-17:30-17:45">17:30</option></select><button data-autom="fulfillment-continue-button">続ける</button>';
    const f=await fixture(t,{path:'/jp/shop/apw/checkout?_s=Fulfillment-init',body});
    const nativeStatus={known:true,active:false,kind:'none'};
    const s=fixtureSafari(f,{nativeStatus,now:()=>Date.UTC(2026,10,8,7,30),sleep:async()=>{},beforeEvaluate:script=>{
      if(script.includes('function pickupScheduleDOM')&&script.includes('"action":"read"'))Object.assign(nativeStatus,inaccessible?{known:false,active:false,kind:'unknown'}:{known:true,active:true,kind:'apple-pay'});
    }});
    await assert.rejects(s.prepareCheckout(selection,'R119',()=>{}),new RegExp(inaccessible?'ACCESSIBILITY_REQUIRED':'PAYMENT_ACTIVE'));
    assert.equal(await f.page.locator('#date8').isChecked(),mutation==='slot');
    assert.equal(await f.page.locator('select').inputValue(),''); assert.equal(f.outbound(),1);
  }
});
test('nested Apple inactivity warning extends once and never clicks payment or changes checkout mode', async t => {
  const body = apwSummary() + '<div class="rs-checkout-sessionextender"><div role="alertdialog">セッションの有効期限がまもなく切れます<button id="extend" onclick="window.extensions++">セッションを延長する</button></div></div><script>window.extensions=0;</script>';
  const f = await fixture(t, { path: '/jp/shop/apw/checkout?_s=Fulfillment-init', body });
  const before = await f.run({ action: 'inspect' }); assert.equal(before.sessionWarning, true); assert.equal(before.sessionExpired, false); assert.equal(before.sessionExtendAvailable, true);
  assert.equal((await f.run({ action: 'keepalive' })).extensionRequested, true); assert.equal((await f.run({ action: 'keepalive' })).extensionPending, true); assert.equal(await f.page.evaluate(() => window.extensions), 1);
  await f.page.locator('.rs-checkout-sessionextender').evaluate(e => e.remove()); assert.equal((await f.run({ action: 'keepalive' })).maintained, true); assert.equal((await f.run({ action: 'inspect' })).fulfillmentMode, 'pickup');
});
test('the observed Japanese still-shopping session control extends once and leaves Apple Pay untouched', async t => {
  const body=apwSummary()+'<div role="dialog" aria-modal="true"><h2 id="rs-sessionextender-overlay-header">セッションの有効期限がまもなく切れます</h2><button id="checkout.session.extendSession" onclick="window.extensions++">まだショッピング中です</button></div><button class="rs-checkout-applepay-button" onclick="window.payClicks++">Apple Pay</button><script>window.extensions=0;window.payClicks=0;</script>';
  const f=await fixture(t,{path:'/jp/shop/apw/checkout?_s=Fulfillment-init',body});
  assert.equal((await f.run({action:'inspect'})).sessionExtendAvailable,true);
  assert.equal((await f.run({action:'keepalive'})).extensionRequested,true);
  assert.equal((await f.run({action:'keepalive'})).extensionPending,true);
  assert.deepEqual(await f.page.evaluate(()=>[window.extensions,window.payClicks]),[1,0]);assert.equal(f.outbound(),1);
});
test('a session control mounting late or a warning disappearing is observed before requesting intervention', async t => {
  for(const outcome of ['appears','dismissed']){
    const body=apwSummary()+'<div class="rs-checkout-sessionextender" role="alertdialog">セッションの有効期限がまもなく切れます<button id="extend" hidden>セッションを延長する</button></div><script>window.extensions=0;document.getElementById("extend").onclick=()=>{window.extensions++;document.querySelector(".rs-checkout-sessionextender").remove()};</script>';
    const f=await fixture(t,{path:'/jp/shop/apw/checkout?_s=Fulfillment-init',body});
    await f.page.evaluate(outcome=>setTimeout(()=>{if(outcome==='appears')document.getElementById('extend').hidden=false;else document.querySelector('.rs-checkout-sessionextender').remove();},100),outcome);
    const s=fixtureSafari(f),result=await s.renewSession();
    assert.equal(result.maintained,true);assert.equal(await f.page.evaluate(()=>window.extensions),outcome==='appears'?1:0);assert.equal((await s.inspect()).fulfillmentMode,'pickup');assert.equal(f.outbound(),1);
  }
});
test('unknown or expired session warning and active Apple Pay never trigger CAP or extension clicks', async t => {
  const f = await fixture(t, { path: '/jp/shop/apw/checkout?_s=Fulfillment-init', body: apwSummary() + '<div role="alertdialog">Session is about to expire<button onclick="window.clicks++">Unknown action</button></div><script>window.clicks=0;</script>' });
  assert.equal((await f.run({ action: 'keepalive' })).manual, true);
  await f.page.locator('[role="alertdialog"]').evaluate(e => e.firstChild.textContent = 'Session has expired'); assert.equal((await f.run({ action: 'keepalive' })).expired, true);
  await f.page.locator('[role="alertdialog"]').evaluate(e => { e.firstChild.textContent = 'Session is about to expire'; e.querySelector('button').textContent = 'Continue'; });
  await f.page.evaluate(() => { window.__applePickupPayment = { active: true }; });
  for (const action of ['keepalive','postal-open','postal']) await assert.rejects(f.run({ action, postalCode: '150-0041' }), /PAGE_BUSY/);
  assert.equal(await f.page.evaluate(() => window.clicks), 0);
});
test('bag entry validates only its visible total without product-row inspection', async t => {
  const f = await fixture(t); assert.equal((await f.run({ action: 'bag-total-check' })).valid, true);
  await f.page.locator('[data-autom="bagtotalvalue"]').evaluate(e => e.textContent = '100,001円'); assert.equal((await f.run({ action: 'bag-total-check' })).valid, false);
  assert.equal(f.outbound(), 1);
});
test('the current Japanese empty bag heading is recognized before adding the selected product', async t => {
  const f=await fixture(t,{body:'<h1>バッグに商品はありません。</h1>'});assert.equal((await f.run({action:'bag-total-check'})).empty,true);
});
test('the explicit Japanese Apple page-not-found screen is recoverable before payment', async t => {
  const f=await fixture(t,{path:'/jp/shop/unavailable-fixture',body:'<h1>お探しのページは<br>見つかりません。</h1>'});assert.equal((await f.run({action:'inspect'})).phase,'unavailable');
});
test('the English Apple not-found page overrides bag and fulfillment routes without overriding authentication', async t => {
  for(const path of ['/jp/shop/bag','/jp/shop/apw/checkout?_s=Fulfillment-init','/jp/shop/missing-fixture']){
    const f=await fixture(t,{path,body:'<h1>The page you’re looking for can’t be found.</h1>'});assert.equal((await f.run({action:'inspect'})).phase,'unavailable');
  }
  const auth=await fixture(t,{path:'/jp/shop/signIn',body:'<h1>The page you’re looking for can’t be found.</h1>'});assert.equal((await auth.run({action:'inspect'})).phase,'authentication');
});
test('matching total is accepted independently of bag rows and services as requested', async t => {
  const f = await fixture(t, { body: item + '<div class="rs-servicesection-coverageplan">Extra service</div>' });
  await f.page.locator('[data-autom="bag-items"]').evaluate(e => e.append(e.firstElementChild.cloneNode(true)));
  await f.page.evaluate(() => { const query=document.querySelectorAll.bind(document);document.querySelectorAll=selector=>{if(/bag-items|bag-item-name|item-quantity|coverageplan/.test(selector))throw Error('BAG_ROWS_MUST_NOT_BE_READ');return query(selector)}; });
  assert.equal((await f.run({action:'bag-total-check'})).valid,true);
});
test('ordinary checkout controls cannot substitute the direct Apple Pay entry', async t => {
  const f = await fixture(t, { body: item + '<button id="shoppingCart.actions.navCheckoutOtherPayments" data-autom="checkout">注文手続きへ</button><button id="shoppingCart.actions.checkoutOtherPayments" data-autom="checkout">注文手続きへ</button><script>window.clicked=[];document.querySelectorAll("button").forEach(b=>b.onclick=()=>window.clicked.push(b.id))</script>' });
  await assert.rejects(f.run({ action: 'checkout' }), /CHECKOUT_CONTROL_CHANGED/); assert.deepEqual(await f.page.evaluate(() => window.clicked), []);
});
test('real bag with duplicate black Apple Pay and blue checkout buttons clicks only the direct Apple Pay navigation entry', async t => {
  const f = await fixture(t, { body: item + '<button id="shoppingCart.actions.navApwCheckout" data-autom="checkout-with-apple-pay">Apple Payで注文手続きを行う</button><button id="shoppingCart.actions.apwCheckout" data-autom="checkout-with-apple-pay">Apple Payで注文手続きを行う</button><button id="shoppingCart.actions.navCheckoutOtherPayments" data-autom="checkout">注文手続きへ</button><button id="shoppingCart.actions.checkoutOtherPayments" data-autom="checkout">注文手続きへ</button><script>window.clicked=[];document.querySelectorAll("button").forEach(b=>b.onclick=()=>window.clicked.push(b.id))</script>' });
  const result = await f.run({ action: 'checkout' }); assert.equal(result.route, 'apple-pay'); assert.deepEqual(await f.page.evaluate(() => window.clicked), ['shoppingCart.actions.navApwCheckout']);
});
test('confirmation requires a completed order heading, order reference, selected product, Store and confirmation route', async t => {
  const body = '<h1>ご注文ありがとうございます</h1><p>ご注文番号: W000000000</p><h2>Test Device 256GB ブラック</h2><h2>Apple 渋谷</h2>';
  const f = await fixture(t, { path: '/jp/shop/order/thankyou', body });
  const store = STORES[0]; const state = await f.run({ action: 'inspect', store }); assert.equal(state.confirmation, true); assert.equal(state.phase, 'success');
  assert.ok(!JSON.stringify(state).includes('W000000000'));
  assert.equal((await f.run({ action: 'inspect', store: STORES[2] })).confirmation, false);
  assert.equal((await f.run({ action: 'inspect', store, selection: { ...selection, names: ['Different product'], name: 'Different product' } })).confirmation, false);
});
test('a generic thank-you or payment-completed label alone never claims a successful order', async t => { const f = await fixture(t, { path: '/jp/shop/order/thankyou', body: '<h1>ご注文ありがとうございます</h1><p>Payment complete</p>' }); assert.equal((await f.run({ action: 'inspect', store: STORES[0] })).confirmation, false); });
test('active Apple Pay prevents every bag navigation and checkout action', async t => {
  const f = await fixture(t); await f.page.evaluate(() => { window.__applePickupPayment = { active: true, observed: true }; });
  for (const action of ['navigate','checkout','product-add','contact-continue']) await assert.rejects(f.run({ action, url: 'https://www.apple.com/jp/shop/bag' }), /PAGE_BUSY/);
});
test('account authentication stays manual', async t => {
  const f = await fixture(t, { path: '/jp/shop/signIn/account', body: '<h1>Sign in</h1><input type="password" value="fixture-only">' });
  assert.equal((await f.run({ action: 'inspect' })).phase, 'authentication'); await assert.rejects(f.run({ action: 'contact-continue' }), /PAGE_BUSY/); assert.ok(!JSON.stringify(await f.run({ action: 'inspect' })).includes('fixture-only'));
});
test('Safari recognizes Apple checkout with an opaque route segment without exposing that segment', async t => {
  const f = await fixture(t, { path: '/jp/shop/fixture-session/checkout?_s=Fulfillment-init', body: '<h1>受け取り方法</h1>' });
  const result = await f.run({ action: 'inspect' }); assert.equal(result.phase, 'pickup'); assert.ok(!JSON.stringify(result).includes('fixture-session'));
});
test('direct Apple Pay checkout is distinguishable from an ordinary pickup checkout without exporting its URL', async t => {
  const f = await fixture(t, { path: '/jp/shop/apw/checkout?_s=Fulfillment-init', body: '<h1>受け取り方法</h1>' }); const state = await f.run({ action: 'inspect' }); assert.equal(state.phase, 'pickup'); assert.equal(state.applePayRoute, true); assert.ok(!JSON.stringify(state).includes('https://'));
});
test('final review can arm Apple Pay once; the DOM never clicks the payment button', async t => {
  const f = await fixture(t, { path: '/jp/shop/checkout?_s=Review', body: '<span class="rs-companionbar-button-amount">100,000円</span>' + item + '<h2>Apple 渋谷</h2><button id="pay" aria-label="Apple Payで支払う">Apple Payで支払う</button><script>window.payClicks=0;document.getElementById("pay").onclick=()=>window.payClicks++;</script>' });
  const attempt = '00000000-0000-4000-8000-000000000001'; const p = { action: 'arm-apple-pay', store: STORES[0], nonce: attempt, attempt };
  assert.equal((await f.run(p)).armed, true); assert.equal(await f.page.evaluate(() => window.payClicks), 0); await assert.rejects(f.run(p), /ALREADY_DISPATCHED/);
});

test('the final Apple Pay boundary preserves native and summary guards before intent and a single trusted click', async t => {
  for(const unsafe of [null,'native-active','native-unknown','wrong-total','wrong-store','pending','authentication']){
    const path=unsafe==='authentication'?'/jp/shop/signIn/account':'/jp/shop/checkout?_s=Review';
    const f=await fixture(t,{path,body:'<span class="rs-companionbar-button-amount">'+(unsafe==='wrong-total'?'200,000円':'100,000円')+'</span>'+item+'<h2>Apple '+(unsafe==='wrong-store'?'銀座':'渋谷')+'</h2><button aria-label="Apple Pay">Apple Pay</button>'});
    if(unsafe==='pending')await f.page.evaluate(()=>document.body.setAttribute('aria-busy','true'));
    const nativeStatus={known:unsafe!=='native-unknown',active:unsafe==='native-active',kind:unsafe==='native-active'?'apple-pay':'none'};
    const s=fixtureSafari(f,{nativeStatus});s.binding.nonce='fixture-nonce';const invoke=s.invoke;let intent=false,clicks=0;
    s.invoke=async request=>{if(request.operation==='press-apple-pay'){assert.equal(intent,true);clicks++;return{dispatched:true};}return invoke(request);};
    const run=()=>s.pressApplePay(selection,STORES[0],'fixture-attempt',()=>{intent=true;});
    if(unsafe){await assert.rejects(run());assert.equal(intent,false);assert.equal(clicks,0);}else{assert.deepEqual(await run(),{dispatched:true});assert.equal(clicks,1);}
    assert.equal(f.outbound(),1);
  }
});

test('a verified unposted hit gets one same-page Apple Pay retry with the original intent', async t => {
  for (const boundary of ['none','lost-first-reply','lost-second-reply','wallet','changed-total','changed-document','stopped','repeat-refusal']) {
    const nonce='00000000-0000-4000-8000-000000000001';
    const f=await fixture(t,{path:'/jp/shop/checkout?_s=Review',body:'<span class="rs-companionbar-button-amount">100,000円</span>'+item+'<h2>Apple 渋谷</h2><button aria-label="Apple Pay">Apple Pay</button>'});
    await f.page.evaluate(nonce=>window.name='ApplePickupLoop:'+nonce,nonce);
    const nativeStatus={known:true,active:false,kind:'none'};
    const s=fixtureSafari(f,{nativeStatus});
    s.binding.nonce=nonce;
    const invoke=s.invoke;
    const refused=()=>Object.assign(Error('APPLE_PAY_HIT_CHANGED'),{notDispatched:true,axTarget:'AX_ANCESTOR',domTarget:'DOM_REACHABLE'});
    let requests=0,intents=0;
    s.invoke=async request=>{
      if(request.operation!=='press-apple-pay')return invoke(request);
      assert.equal(intents,1);
      if(++requests===2){
        assert.equal(request.allowNavigation,false);
        if(boundary==='lost-second-reply')throw Error('SAFARI_UNCERTAIN');
        if(boundary==='repeat-refusal')throw refused();
        return {dispatched:true};
      }
      if(boundary==='lost-first-reply')throw Error('SAFARI_UNCERTAIN');
      if(boundary==='wallet')nativeStatus.active=true;
      if(boundary==='changed-total')await f.page.locator('.rs-companionbar-button-amount').evaluate(e=>e.textContent='200,000円');
      if(boundary==='changed-document')await f.page.evaluate(()=>document.documentElement.removeAttribute('data-apple-loop-pay-dispatched'));
      throw refused();
    };
    const run=()=>s.pressApplePay(selection,STORES[0],nonce,()=>intents++,()=>{
      if(boundary==='stopped')throw Error('STOPPED');
    });
    if(boundary==='none')assert.deepEqual(await run(),{dispatched:true});
    else await assert.rejects(run(),e=>['lost-first-reply','lost-second-reply'].includes(boundary)
      ? e.message==='SAFARI_UNCERTAIN' && !e.notDispatched
      : e.message==='APPLE_PAY_HIT_CHANGED' && e.notDispatched===true);
    assert.equal(requests,['none','lost-second-reply','repeat-refusal'].includes(boundary)?2:1,boundary);
    assert.equal(intents,1);
    assert.equal(f.outbound(),1);
  }
});

test('Apple Pay observation also covers a constructor or session cached before arming without changing authorization behavior', async t => {
  for(const cachedInstance of [false,true]){
    const f=await fixture(t,{path:'/jp/shop/checkout?_s=Review',body:'<span class="rs-companionbar-button-amount">100,000円</span>'+item+'<h2>Apple 渋谷</h2><button aria-label="Apple Pay">Apple Pay</button>'});
    await f.page.evaluate(cached=>{window.payCalls=[];window.ApplePaySession=class extends EventTarget{begin(){window.payCalls.push('begin');return 'begun'}abort(){window.payCalls.push('abort');return 'aborted'}completePayment(value){window.payCalls.push(['complete',value]);return 'completed'}};window.cachedConstructor=window.ApplePaySession;if(cached)window.cachedSession=new window.cachedConstructor;},cachedInstance);
    await f.run({action:'arm-apple-pay',store:STORES[0],nonce:'fixture-nonce',attempt:'fixture-attempt'});
    assert.equal(await f.page.evaluate(()=>window.payCalls.length),0);
    assert.equal(await f.page.evaluate(()=>{window.testSession=window.cachedSession??new window.cachedConstructor;return window.testSession.begin();}),'begun');
    let state=await f.run({action:'inspect'});assert.equal(state.paymentObserved,true);assert.equal(state.paymentActive,true);
    await f.page.evaluate(()=>window.testSession.dispatchEvent(new Event('paymentauthorized')));assert.equal(await f.page.evaluate(()=>window.__applePickupPayment.authorized),true);
    assert.equal(await f.page.evaluate(()=>window.testSession.completePayment(0)),'completed');state=await f.run({action:'inspect'});assert.equal(state.paymentCompleted,true);assert.equal(state.paymentActive,false);
    assert.deepEqual(await f.page.evaluate(()=>window.payCalls),['begin',['complete',0]]);
    assert.equal(await f.page.evaluate(()=>window.ApplePaySession===window.cachedConstructor),true);
  }
});

test('Apple Pay observation preserves native exceptions and cancellation and isolates old session events from a new attempt', async t => {
  const f=await fixture(t,{path:'/jp/shop/checkout?_s=Review',body:'<span class="rs-companionbar-button-amount">100,000円</span>'+item+'<h2>Apple 渋谷</h2><button aria-label="Apple Pay">Apple Pay</button>'});
  await f.page.evaluate(()=>{window.ApplePaySession=class extends EventTarget{begin(){if(this.fail)throw Error('FixtureBeginFailure');return 1}abort(){return 2}completePayment(){return 3}};});
  const arm={action:'arm-apple-pay',store:STORES[0],nonce:'fixture',attempt:'fixture-one'};await f.run(arm);
  await assert.rejects(f.page.evaluate(()=>{window.oldSession=new window.ApplePaySession;window.oldSession.fail=true;window.oldSession.begin();}),/FixtureBeginFailure/);assert.equal((await f.run({action:'inspect'})).paymentObserved,false);
  assert.equal(await f.page.evaluate(()=>{window.oldSession.fail=false;return window.oldSession.begin();}),1);
  assert.equal(await f.page.evaluate(()=>window.oldSession.abort()),2);assert.equal((await f.run({action:'inspect'})).paymentCancelled,true);
  await f.page.evaluate(()=>document.documentElement.removeAttribute('data-apple-loop-pay-dispatched'));await f.run({...arm,attempt:'fixture-two'});
  await f.page.evaluate(()=>window.oldSession.dispatchEvent(new Event('paymentauthorized')));assert.equal(await f.page.evaluate(()=>window.__applePickupPayment.authorized),false);assert.equal((await f.run({action:'inspect'})).paymentCancelled,false);
  await f.page.evaluate(()=>{const s=new window.ApplePaySession;s.begin();s.dispatchEvent(new Event('cancel'));});assert.equal((await f.run({action:'inspect'})).paymentCancelled,true);
});
test('cancellation evidence survives document replacement and is scoped to the exact attempt', async t => {
  const f = await fixture(t, { path:'/jp/shop/checkout?_s=Review', body:'<span class="rs-companionbar-button-amount">100,000円</span>'+item+'<h2>Apple 渋谷</h2><button aria-label="Apple Pay">Apple Pay</button>' });
  const id='12345678-1234-1234-1234-123456789012';
  const pressedAt=await f.page.evaluate(()=>{
    window.name='ApplePickupLoop:fixture';
    window.ApplePaySession=class extends EventTarget { begin(){} abort(){} completePayment(){} };
    return Date.now();
  });
  await f.run({action:'arm-apple-pay',store:STORES[0],nonce:'fixture',attempt:id});
  await f.page.evaluate(()=>{
    window.sessionUnderTest=new window.ApplePaySession();
    window.sessionUnderTest.begin();
    window.sessionUnderTest.dispatchEvent(new Event('cancel'));
    window.savedObserver=window.__applePickupPayment;
    delete window.__applePickupPayment;
    history.replaceState(null,'','/jp/shop/bag');
  });
  const inspect={action:'inspect',observerNonce:'fixture',paymentContext:{id,pressedAt}};
  assert.equal((await f.run(inspect)).paymentCancelledBeforeAuthorization,true);
  assert.equal((await f.run({...inspect,observerNonce:'other'})).paymentCancelledBeforeAuthorization,false);
  await f.page.evaluate(()=>{
    window.__applePickupPayment=window.savedObserver;
    window.sessionUnderTest.dispatchEvent(new Event('paymentauthorized'));
    window.sessionUnderTest.dispatchEvent(new Event('cancel'));
    delete window.__applePickupPayment;
  });
  assert.equal((await f.run(inspect)).paymentCancelledBeforeAuthorization,false);
});

test('a conventional card place-order button is never accepted as Apple Pay', async t => {
  const f = await fixture(t, { path: '/jp/shop/checkout?_s=Review', body: '<span class="rs-companionbar-button-amount">100,000円</span>' + item + '<h2>Apple 渋谷</h2><button data-autom="continue-button-placeOrder">注文する</button>' }); await assert.rejects(f.run({ action: 'arm-apple-pay', store: STORES[0], nonce: 'test', attempt: 'test' }), /APPLE_PAY_CONTROL_CHANGED/);
});
test('offline dashboard has one activation button, responsive layout, no card/login inputs, and functioning on/off', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'apple-loop-ui-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const storage = new AppStorage(dir); storage.settings.selection = selection; storage.settings.pickupContact = contact; storage.saveSettings();
  const category = { id: 'iphone', name: 'iPhone' }, product = { id: selection.productId, url: selection.productId, category: 'iphone', name: 'Test Device' };
  const catalog = { updatedAt: Date.now(), snapshot() { return { updatedAt: this.updatedAt, categories: [category], products: [product], errors: [], loading: false }; }, async configurations() { return [selection]; }, async resolve() { return selection; } };
  const safari = { snapshot: () => ({ bound: false, browser: 'Safari' }), async bind() {}, async prepareBag() {}, async inspect() { return { phase: 'pickup' }; }, async action() { return {}; } };
  const app = createApplication({ storage, catalog, safari, notify: () => {} }); app.fleet.start = async () => {}; app.fleet.stop = async () => {};
  const server = createHTTPServer(app, { port: 0 }); server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(r => server.close(r)));
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } }); t.after(() => context.close()); const page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => { if (new URL(route.request().url()).hostname !== '127.0.0.1') return route.abort(); return route.continue(); });
  await page.goto('http://127.0.0.1:' + server.address().port);
  await page.waitForFunction(() => !document.getElementById('activation').disabled);
  assert.equal(await page.locator('button').count(), 1);
  await page.locator('#pickup-firstName').fill('Updated operator'); await page.locator('#pickup-firstName').blur(); await page.waitForFunction(() => document.getElementById('contact-save-state').textContent.includes('Dati salvati')); assert.equal(new AppStorage(dir).settings.pickupContact.firstName, 'Updated operator'); assert.equal(await page.locator('input[type="password"],input[name="card"],input[name="cvc"]').count(), 0);
  app.controller.storage.statistics.checkoutAttempts = 3; app.controller.storage.saveStatistics(); app.controller.signal({ observedAt: Date.now(), stores: [{ id: 'R119', state: 'available' }] });
  await page.waitForFunction(() => document.getElementById('checkout-attempts').textContent === '3' && document.querySelector('#store-options label[data-store-id="R119"]').classList.contains('available'));
  assert.match(await page.locator('#stock-signal').innerText(), /Shibuya/); assert.match(await page.locator('#store-options label[data-store-id="R119"] .store-availability').innerText(), /Disponibile/);
  assert.equal(new AppStorage(dir).statistics.checkoutAttempts, 3);
  app.controller.currentStore='R119';
  for(const code of ['PICKUP_STORE_SELECTED','PICKUP_DATE_SELECTED','PICKUP_TIME_SELECTED','PICKUP_STORE_SELECTED'])app.controller.recordCheckoutEvent(code);
  app.controller.currentStore=null;
  await page.waitForFunction(()=>['store','date','time'].every(k=>document.getElementById('selected-'+k+'-count').textContent==='1'));
  assert.match(await page.locator('#checkout-progress-note').innerText(),/una volta per tentativo/);
  assert.deepEqual(['store','date','time'].map(k=>new AppStorage(dir).statistics.checkoutProgress[k]),[1,1,1]);
  app.controller.storage.saveCheckoutTiming({ attempt: 3, sku: selection.sku, storeId: 'R119', startedAtJST: '2026-11-08 12:00:00 JST', endedAtJST: '2026-11-08 12:00:01 JST', totalMs: 1100, code: 'STOCK_FAILED', steps: [{ name: 'dom:store', offsetMs: 0, durationMs: 1000, result: 'ok' }, { name: 'native:payment-status', offsetMs: 1000, durationMs: 100, result: 'ok' }] });
  await page.locator('summary').filter({ hasText: 'Tempi dell’ultimo checkout' }).click(); await page.waitForFunction(() => document.getElementById('timing-summary').textContent.includes('1,10 s')); assert.match(await page.locator('#timing-breakdown').innerText(), /Scelta Store: 1,00 s/);
  app.controller.storage.saveCheckoutTiming({attempt:3,sku:selection.sku,storeId:'R119',startedAtJST:'2026-11-08 12:00:00 JST',endedAtJST:'2026-11-08 12:00:01 JST',totalMs:1000,code:'STOCK_FAILED',steps:[{name:'dom:store',offsetMs:0,durationMs:100,result:'ok'},{name:'calendar:read',offsetMs:100,durationMs:300,result:'ok'},{name:'wait:calendar',offsetMs:400,durationMs:400,result:'ok'},{name:'calendar:store-response',offsetMs:150,durationMs:650,result:'error',code:'STOCK_FAILED'},{name:'dom:prepare-contact',offsetMs:800,durationMs:200,result:'ok'}]});
  await page.waitForFunction(()=>document.getElementById('timing-summary').textContent.includes('1,00 s'));
  const measured=await page.locator('#timing-breakdown').innerText();assert.match(measured,/Calendario del ritiro: 0,30 s/);assert.match(measured,/Attese della pagina: 0,40 s/);assert.match(measured,/Compilazione contatti: 0,20 s/);assert.match(measured,/Risposta Apple allo Store: 0,65 s · già compresa/);
  await page.getByRole('button', { name: /Attivazione/ }).click(); await page.waitForFunction(() => document.getElementById('activation').getAttribute('aria-pressed') === 'true');
  assert.equal(app.controller.enabled, true); await app.controller.tick();
  assert.equal(await page.locator('#activation-label').innerText(), 'Attivo');
  await page.getByRole('button', { name: 'Attivo', exact: true }).click(); await page.waitForFunction(() => document.getElementById('activation').getAttribute('aria-pressed') === 'false'); assert.equal(await page.locator('#activation-label').innerText(), 'Attivazione'); assert.equal(app.controller.enabled, false);
  await page.setViewportSize({ width: 390, height: 844 }); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); assert.deepEqual(errors, []);
});

test('live iPhone no-AppleCare data-autom choice reveals the selected SKU before a single add', async t => {
  const f = await fixture(t, { path: '/jp/shop/buy-iphone/test-device/configuration', body: `<input type="radio" name="applecare-options" data-autom="acptl"><input type="radio" name="applecare-options" data-autom="noapplecare"><input name="product" disabled><button data-autom="add-to-cart" disabled>Add</button><script>window.adds=0;document.querySelector('[data-autom="noapplecare"]').onclick=()=>{const p=document.querySelector('[name="product"]');p.disabled=false;p.value='AAAA1J/A';document.querySelector('button').disabled=false};document.querySelector('button').onclick=()=>window.adds++;</script>` });
  assert.equal((await f.run({ action: 'product-add' })).configurationStep, true);
  assert.equal(await f.page.evaluate(() => window.adds), 0);
  await f.run({ action: 'product-add' }); assert.equal(await f.page.evaluate(() => window.adds), 1);
  await f.page.locator('[name="product"]').evaluate(e => e.value = 'OTHER1J/A');
  await assert.rejects(f.run({ action: 'product-add' }), /PRODUCT_CONFIGURATION_UNVERIFIED/); assert.equal(await f.page.evaluate(() => window.adds), 1);
});

test('late Pro product controls select no AppleCare and add once as soon as the verified SKU mounts', async t => {
  const f=await fixture(t,{path:'/jp/shop/buy-iphone/test-device/configuration',body:'<div id="configuration"></div>'});
  let clock=0,mounted=false;const s=fixtureSafari(f,{now:()=>clock,sleep:async ms=>{clock+=ms;if(!mounted){mounted=true;await f.page.evaluate(()=>{document.getElementById('configuration').innerHTML='<input type="radio" name="applecare-options" data-autom="acptl"><input type="radio" name="applecare-options" data-autom="noapplecare"><input name="product" disabled><button data-autom="add-to-cart" disabled>Add</button>';window.adds=0;window.noCareClicks=0;document.querySelector('[data-autom="noapplecare"]').onclick=()=>{window.noCareClicks++;const p=document.querySelector('[name="product"]');p.disabled=false;p.value='AAAA1J/A';document.querySelector('button').disabled=false;};document.querySelector('button').onclick=()=>window.adds++;});}}});
  await s.addConfiguredProduct(selection);assert.equal(clock,100);assert.deepEqual(await f.page.evaluate(()=>[window.noCareClicks,window.adds]),[1,1]);assert.equal(f.outbound(),1);
  await f.page.locator('[name="product"]').evaluate(e=>e.value='OTHER1J/A');await assert.rejects(s.addConfiguredProduct(selection),/PRODUCT_CONFIGURATION_UNVERIFIED/);assert.equal(await f.page.evaluate(()=>window.adds),1);
});

test('late product controls retain a single uncertain add and never replay it', async t => {
  const f=await fixture(t,{path:'/jp/shop/buy-iphone/test-device/configuration',body:'<input name="product" value="AAAA1J/A"><button data-autom="add-to-cart" onclick="window.adds++">Add</button><script>window.adds=0</script>'});
  const s=fixtureSafari(f,{loseReply:script=>script.includes('"action":"product-add"')});await s.addConfiguredProduct(selection);assert.equal(await f.page.evaluate(()=>window.adds),1);assert.equal(f.outbound(),1);
});

test('a delayed no-AppleCare page-model update never repeats the option request', async t => {
  const f=await fixture(t,{path:'/jp/shop/buy-iphone/test-device/configuration',body:'<input type="radio" name="applecare-options" data-autom="acptl"><input type="radio" name="applecare-options" data-autom="noapplecare"><input name="product" disabled><button data-autom="add-to-cart" disabled>Add</button>'});
  await f.page.evaluate(()=>{window.noCareClicks=0;window.adds=0;document.querySelector('[data-autom="noapplecare"]').onclick=e=>{window.noCareClicks++;e.preventDefault();};document.querySelector('button').onclick=()=>window.adds++;});
  let clock=0;const s=fixtureSafari(f,{now:()=>clock,sleep:async ms=>{clock+=ms;if(clock>=100)await f.page.evaluate(()=>{document.querySelector('[data-autom="noapplecare"]').checked=true;const p=document.querySelector('[name="product"]');p.disabled=false;p.value='AAAA1J/A';document.querySelector('button').disabled=false;});}});
  await s.addConfiguredProduct(selection);assert.equal(clock,100);assert.deepEqual(await f.page.evaluate(()=>[window.noCareClicks,window.adds]),[1,1]);assert.equal(f.outbound(),1);
});

test('direct Apple Pay pickup uses its fulfillment continue button after Store and time verification', async t => {
  const f = await fixture(t, { path: '/jp/shop/apw/checkout?_s=Fulfillment-init', body: apwSummary() + '<input name="store-locator-result" value="R119" checked type="radio"><select data-autom="pickup-availablewindow-dropdown"><option value="8-12:00-12:15">12:00</option></select><button data-autom="fulfillment-continue-button">受け取りの詳細に進む</button><script>window.continues=0;document.querySelector("button").onclick=()=>window.continues++</script>' });
  await f.page.evaluate(() => { const e = document.querySelector('#init_data'), d = JSON.parse(e.textContent), f = d.checkout.fulfillment; f.pickupTab = { pickup: { items: f.deliveryTab.delivery.shipmentGroups.group.shipmentOptionsGroups.options.items } }; delete f.deliveryTab; e.textContent = JSON.stringify(d); });
  await f.run({ action: 'pickup-continue', storeId: 'R119' }); assert.equal(await f.page.evaluate(() => window.continues), 1);
  await assert.rejects(f.run({ action: 'pickup-continue', storeId: 'R224' }), /STORE_CHANGED/); assert.equal(await f.page.evaluate(() => window.continues), 1);
});

test('direct Apple Pay fills visible pickup contact fields, validates the pickup proof, and only arms the native click', async t => {
  const f = await fixture(t, { path: '/jp/shop/apw/checkout?_s=Fulfillment-init', body: apwSummary() + '<input type="radio" checked name="store-locator-result" value="R119"><select data-autom="pickup-availablewindow-dropdown"><option value="8-12:00-12:15">12:00</option></select><button data-autom="fulfillment-continue-button">受け取りの詳細に進む</button>' + contactForm() + '<button class="rs-checkout-applepay-button" aria-label="Apple Payで購入"></button><script>window.payClicks=0;document.querySelector(".rs-checkout-applepay-button").onclick=()=>window.payClicks++;document.querySelector("[data-autom=fulfillment-continue-button]").onclick=()=>history.pushState({},"","?_s=PickupContact-init");</script>' });
  const nonce = '00000000-0000-4000-8000-000000000001';
  await f.run({ action: 'pickup-continue', storeId: 'R119', nonce });
  const filled = await f.run({ action: 'fill-contact', contact }); assert.deepEqual(filled, { filled: true }); assert.ok(!JSON.stringify(filled).includes(contact.emailAddress));
  assert.deepEqual(await f.run({ action: 'contact-continue' }), { readyForApplePay: true }); assert.equal(await f.page.evaluate(() => window.payClicks), 0);
  const p = { action: 'arm-apple-pay', nonce, attempt: nonce, contact, store: STORES[0] };
  await assert.rejects(f.run({ ...p, store: STORES[1] }), /REVIEW_CHANGED/);
  await f.page.locator('.rs-companionbar-button-amount').evaluate(e => e.textContent = '200,000円'); await assert.rejects(f.run(p), /REVIEW_CHANGED/);
  await f.page.locator('.rs-companionbar-button-amount').evaluate(e => e.textContent = '100,000円'); assert.equal((await f.run(p)).summaryVerified, true); assert.equal(await f.page.evaluate(() => window.payClicks), 0);
});
test('editing pickup Store invalidates the carried proof before Apple Pay', async t => {
  const f = await fixture(t, { path: '/jp/shop/apw/checkout?_s=Fulfillment-init', body: apwSummary() + '<input type="radio" checked name="store-locator-result" value="R119"><select data-autom="pickup-availablewindow-dropdown"><option value="8-12:00-12:15">12:00</option></select><button data-autom="fulfillment-continue-button">受け取りの詳細に進む</button>' + contactForm() + '<button class="rs-checkout-applepay-button" aria-label="Apple Payで購入"></button><script>document.querySelector("button").onclick=()=>history.pushState({},"","?_s=PickupContact-init")</script>' });
  await f.run({ action: 'pickup-continue', storeId: 'R119', nonce: 'test' }); await f.run({ action: 'fill-contact', contact });
  await f.page.locator('[name="store-locator-result"]').dispatchEvent('change');
  await assert.rejects(f.run({ action: 'arm-apple-pay', store: STORES[0], nonce: 'test', contact, attempt: 'test' }), /REVIEW_CHANGED/);
});

test('delivery/pickup mode changes keep the checkout page and block final continuation while on delivery', async t => {
  const f=await fixture(t,{path:'/jp/shop/apw/checkout?_s=Fulfillment-init',body:apwSummary()+'<input name="store-locator-result" value="R119" type="radio" checked><select data-autom="pickup-availablewindow-dropdown"><option value="8-12:00-12:15">12:00</option></select><button data-autom="fulfillment-continue-button">受け取りの詳細に進む</button><script>document.querySelectorAll("[role=radio]").forEach(e=>e.onclick=()=>{document.querySelectorAll("[role=radio]").forEach(n=>n.setAttribute("aria-checked",String(n===e)));void fetch("/jp/shop/apw/checkoutx?_a=selectFulfillmentLocationAction&_m=checkout.fulfillment.fulfillmentOptions").then(r=>r.json());});window.continues=0;document.querySelector("button").onclick=()=>window.continues++;</script>'});
  assert.equal((await f.run({action:'inspect'})).fulfillmentMode,'pickup');await f.run({action:'fulfillment-mode',mode:'delivery'});await f.page.waitForFunction(()=>window.__applePickupFulfillmentChange?.responseComplete&&performance.now()-window.__applePickupFulfillmentChange.responseAt>=150);assert.equal((await f.run({action:'inspect'})).fulfillmentMode,'delivery');await assert.rejects(f.run({action:'pickup-continue',storeId:'R119'}),/STORE_CHANGED/);assert.equal(await f.page.evaluate(()=>window.continues),0);await f.run({action:'fulfillment-mode',mode:'pickup'});await f.page.waitForFunction(()=>window.__applePickupFulfillmentChange?.responseComplete&&performance.now()-window.__applePickupFulfillmentChange.responseAt>=150);assert.equal(f.fulfillmentRequests(),2);assert.equal((await f.run({action:'checkout-check'})).valid,true);assert.equal(f.outbound(),1);
  await f.page.evaluate(()=>window.__applePickupPayment={active:true});await assert.rejects(f.run({action:'fulfillment-mode',mode:'delivery'}),/PAGE_BUSY/);assert.equal((await f.run({action:'inspect'})).fulfillmentMode,'pickup');
});

test('checkout total uses the top-right live amount and never reads bag rows or cached product metadata', async t => {
  const f=await fixture(t,{path:'/jp/shop/apw/checkout?_s=Fulfillment-init',body:'<span class="rs-companionbar-button-amount">100,000円</span><script id="init_data">invalid metadata</script><div class="rs-servicesection-coverageplan">Ignored rows</div>'});
  await f.page.evaluate(()=>{const all=document.querySelectorAll.bind(document),one=document.querySelector.bind(document);document.querySelectorAll=s=>{if(/bag-items|bag-item|quantity|coverageplan/.test(s))throw Error('BAG_ROWS_MUST_NOT_BE_READ');return all(s)};document.querySelector=s=>{if(s.includes('init_data'))throw Error('METADATA_MUST_NOT_BE_READ');return one(s)}});
  assert.equal((await f.run({action:'checkout-check'})).valid,true);
  await f.page.locator('.rs-companionbar-button-amount').evaluate(e=>e.textContent='100,001円');assert.equal((await f.run({action:'checkout-check'})).valid,false);
  await f.page.locator('.rs-companionbar-button-amount').evaluate(e=>e.textContent='100,000円');await f.page.locator('.rs-companionbar-button-amount').evaluate(e=>e.after(e.cloneNode(true)));assert.equal((await f.run({action:'checkout-check'})).valid,false);
});

test('alternative-colour preparation verifies the public SKU even when the other colour has the same total',async t=>{
 const f=await fixture(t);assert.deepEqual(await f.run({action:'bag-product-identity',selection}),{skuVerified:true});
 await f.page.locator('a[data-autom="bag-item-name"]').evaluate(e=>e.href=e.href.toLowerCase());assert.deepEqual(await f.run({action:'bag-product-identity',selection}),{skuVerified:true});
 await f.page.locator('a[data-autom="bag-item-name"]').evaluate(e=>e.href='https://www.apple.com/jp/shop/product/BBBB2J/A/test-white');
 await assert.rejects(f.run({action:'bag-product-identity',selection}),/PRODUCT_IDENTITY_UNVERIFIED/);assert.equal(f.outbound(),1);
});
test('alternative-colour Apple Pay cannot use another session identity before any native intent',async()=>{
 const s=new SafariSession({bindingPath:null});let intents=0;s.confirmedSKU='OTHER1J/A';
 await assert.rejects(s.pressApplePay({...selection,requireProductIdentity:true},{id:'R119'},'fixture',()=>intents++),/PRODUCT_IDENTITY_UNVERIFIED/);assert.equal(intents,0);
});

test('a fresh other-colour signal yields before a slow keeper response and later restores pickup without a replay',async t=>{
 const measured=[];
 for(const suspend of [false,true]){
  const body=`<button role="radio" id="pickup" aria-checked="true">お客様がご自身で受け取る</button><button role="radio" id="delivery" aria-checked="false">配送を希望する</button><input id="store" name="store-locator-result" type="radio" value="R119"><label for="store">Apple 渋谷</label><script>window.clicks={pickup:0,delivery:0};for(const mode of ['pickup','delivery'])document.getElementById(mode).onclick=()=>{window.clicks[mode]++;document.body.setAttribute('aria-busy','true');void fetch('/jp/shop/apw/checkoutx?_a=selectFulfillmentLocationAction&_m=checkout.fulfillment.fulfillmentOptions').then(r=>r.json()).then(()=>{for(const other of ['pickup','delivery'])document.getElementById(other).setAttribute('aria-checked',String(other===mode));document.body.removeAttribute('aria-busy');});};</script>`;
  const f=await fixture(t,{path:'/jp/shop/apw/checkout?_s=Fulfillment-init',body,fulfillmentResponseDelayMs:300});let priority=false,receivedAt;
  const s=fixtureSafari(f,{afterEvaluate:async script=>{if(script.includes('"action":"fulfillment-mode"')&&script.includes('"mode":"delivery"')){receivedAt=Date.now();priority=true;}}});
  const result=await s.refreshPickup(()=>{},()=>priority,{canSuspend:()=>suspend});const dispatchWaitMs=Date.now()-receivedAt;
  measured.push({mode:suspend?'other-colour-priority':'wait-for-owner',dispatchWaitMs});
  if(suspend){assert.equal(result.suspended,true);assert.equal(s.pendingMode,'pickup');assert.equal(await f.page.evaluate(()=>window.__applePickupFulfillmentChange.responseComplete),false);await f.page.waitForFunction(()=>window.__applePickupFulfillmentChange.responseComplete);await s.waitFor(['pickup'],{pollMs:25,accept:p=>!p.pending});priority=false;await s.maintain();}
  else assert.notEqual(result.suspended,true);
  assert.equal((await f.run({action:'inspect'})).fulfillmentMode,'pickup');assert.deepEqual(await f.page.evaluate(()=>window.clicks),{pickup:1,delivery:1});assert.equal(f.fulfillmentRequests(),2);assert.equal(f.outbound(),1);
 }
 t.diagnostic(JSON.stringify({offlineKeeperPriorityBenchmark:measured}));
});

test('fast checkout CAP combines opening and filling but yields a browser turn before a single search',async t=>{
 const f=await emptyPostalFixture(t,{available:true,collapsed:true});const calls=[];
 await f.page.evaluate(()=>{const input=document.getElementById('checkout.fulfillment.pickupTab.pickup.storeLocator.searchInput'),search=document.getElementById('checkout.fulfillment.pickupTab.pickup.storeLocator.search');window.modelPostal='';const oldInput=input.oninput;input.oninput=()=>{oldInput();const value=input.value;setTimeout(()=>window.modelPostal=value,0);};const oldSearch=search.onclick;search.onclick=()=>{window.submittedPostal=window.modelPostal;oldSearch();};});
 const s=fixtureSafari(f,{beforeEvaluate:async script=>{calls.push(script.match(/"action":"([a-z-]+)"/)?.[1]);}});
 await s.refreshStoreAvailability(STORES[0],()=>{},Date.now()+5000,()=>{},{fast:true});
 assert.equal(await f.page.evaluate(()=>window.submittedPostal),STORES[0].postalCode);assert.equal(f.postalRequests(),1);assert.equal(await f.page.evaluate(()=>window.searches),1);
 assert.ok(calls.includes('postal-advance'));assert.ok(calls.includes('postal-submit'));assert.ok(!calls.includes('postal-open'));assert.ok(!calls.includes('postal'));assert.equal(calls.filter(x=>x==='postal-state').slice(0,calls.indexOf('postal-submit')).length<=2,true);
});

test('a lost fast CAP reply reconciles its preparation marker instead of replaying the combined action',async t=>{
 const f=await emptyPostalFixture(t,{available:true,collapsed:true});let lost=false,advances=0;
 const s=fixtureSafari(f,{loseReply:script=>{if(script.includes('"action":"postal-advance"')){advances++;if(!lost){lost=true;return true;}}return false;}});
 await s.refreshStoreAvailability(STORES[0],()=>{},Date.now()+5000,()=>{},{fast:true});
 assert.equal(lost,true);assert.equal(advances,1);assert.equal(f.postalRequests(),1);assert.equal(await f.page.evaluate(()=>window.searches),1);
});

for(const active of [false,true])test('fast CAP preserves '+(active?'active':'unknown')+' native payment authorization',async t=>{
 const f=await emptyPostalFixture(t,{collapsed:true}),s=fixtureSafari(f,{nativeStatus:{known:active,active}});
 await assert.rejects(s.refreshStoreAvailability(STORES[0],()=>{},Date.now()+5000,()=>{},{fast:true}),active?/PAYMENT_ACTIVE/:/ACCESSIBILITY_REQUIRED/);
 assert.equal(f.postalRequests(),0);assert.equal(await f.page.evaluate(()=>window.searches),0);
});

test('passive calendar observers react to remounts without clicking Store, dates, slots or payment',async t=>{
 const f=await fixture(t,{path:'/jp/shop/apw/checkout?_s=Fulfillment-init',body:noSlotBody()});const s=fixtureSafari(f);
 const args={selection,storeId:'R119',storeLabels:['Shibuya','渋谷']};
 const first=await s.evaluate(pickupFastDOM,{...args,action:'read'});
 await f.page.evaluate(()=>{window.slotEvents=0;const wrap=document.createElement('div');wrap.innerHTML='<input id="date8" type="radio" name="bartPickupDateSelectorButtonGroup" value="8" checked><label for="date8">November8</label><select data-autom="pickup-availablewindow-dropdown"><option value="">選択</option><option value="8-17:30-17:45">17:30</option></select>';document.body.append(wrap);wrap.addEventListener('change',()=>window.slotEvents++);});
 const second=await s.evaluate(pickupFastDOM,{...args,action:'read'});
 assert.equal(second.ready,true);assert.ok(second.readinessRevision>first.readinessRevision);assert.equal(second.selectedValue,'');assert.equal(await f.page.evaluate(()=>window.slotEvents),0);assert.equal(f.outbound(),1);
});

test('a cached ready calendar cannot authorize a slot after the page enters payment observation',async t=>{
 const f=await fixture(t,{path:'/jp/shop/apw/checkout?_s=Fulfillment-init',body:noSlotBody()+'<input id="date8" type="radio" name="bartPickupDateSelectorButtonGroup" value="8" checked><label for="date8">November8</label><select data-autom="pickup-availablewindow-dropdown"><option value="">選択</option><option value="8-17:30-17:45">17:30</option></select>'}),s=fixtureSafari(f);
 const args={selection,storeId:'R119',storeLabels:['Shibuya','渋谷']};assert.equal((await s.evaluate(pickupFastDOM,{...args,action:'read'})).ready,true);
 await f.page.evaluate(()=>document.documentElement.setAttribute('data-apple-loop-pay-dispatched','1'));
 await assert.rejects(s.evaluate(pickupFastDOM,{...args,action:'slot',dateId:'date8',value:'8-17:30-17:45'},{guardPayment:true}),/EXISTING_CHECKOUT/);
 assert.equal(await f.page.locator('select').inputValue(),'');
});

test('a fast slot command returns a fresh confirmed snapshot without a second native read',async t=>{
 const f=await fixture(t,{path:'/jp/shop/apw/checkout?_s=Fulfillment-init',body:noSlotBody()+'<input id="date8" type="radio" name="bartPickupDateSelectorButtonGroup" value="8" checked><label for="date8">November8</label><select data-autom="pickup-availablewindow-dropdown"><option value="">選択</option><option value="8-17:30-17:45">17:30</option></select>'}),s=fixtureSafari(f);
 const result=await s.evaluate(pickupFastDOM,{selection,storeId:'R119',storeLabels:['Shibuya','渋谷'],action:'slot',dateId:'date8',value:'8-17:30-17:45'},{guardPayment:true});
 assert.equal(result.readAfterMutation,true);assert.equal(result.selectedValue,'8-17:30-17:45');assert.equal(result.ready,true);assert.equal(f.outbound(),1);
});

test('fast CAP waits for a late Apply button and preserves manual stop after filling',async t=>{
 for(const stop of [false,true]){
  const f=await emptyPostalFixture(t,{available:true,collapsed:true});let stopped=false;
  if(!stop)await f.page.evaluate(()=>{const search=document.getElementById('checkout.fulfillment.pickupTab.pickup.storeLocator.search');search.hidden=true;setTimeout(()=>search.hidden=false,100);});
  const s=fixtureSafari(f,{afterEvaluate:async script=>{if(stop&&script.includes('"action":"postal-advance"'))stopped=true;}});
  const run=()=>s.refreshStoreAvailability(STORES[0],()=>{if(stopped)throw Error('STOPPED');},Date.now()+5000,()=>{},{fast:true});
  if(stop){await assert.rejects(run(),/STOPPED/);assert.equal(f.postalRequests(),0);}else{await run();assert.equal(f.postalRequests(),1);}
 }
});

test('fast slot selection revalidates withdrawn options despite a previously ready observer snapshot',async t=>{
 const f=await fixture(t,{path:'/jp/shop/apw/checkout?_s=Fulfillment-init',body:noSlotBody()+'<input id="date8" type="radio" name="bartPickupDateSelectorButtonGroup" value="8" checked><label for="date8">November8</label><select data-autom="pickup-availablewindow-dropdown"><option value="">選択</option><option value="8-17:30-17:45">17:30</option></select>'}),s=fixtureSafari(f);
 const args={selection,storeId:'R119',storeLabels:['Shibuya','渋谷']};assert.equal((await s.evaluate(pickupFastDOM,{...args,action:'read'})).ready,true);
 await f.page.evaluate(()=>document.querySelector('option[value="8-17:30-17:45"]').disabled=true);
 await assert.rejects(s.evaluate(pickupFastDOM,{...args,action:'slot',dateId:'date8',value:'8-17:30-17:45'},{guardPayment:true}),/PICKUP_SLOT_CHANGED/);
 assert.equal(await f.page.locator('select').inputValue(),'');
});

test('CAP round-trip benchmark compares identical collapsed editors without live requests',async t=>{
 const measurements=[];
 for(const fast of [false,true]){
  const f=await emptyPostalFixture(t,{available:true,collapsed:true});let calls=0,callsToSearch=0;const began=performance.now();let timeToSearchMs;
  const s=fixtureSafari(f,{beforeEvaluate:async()=>{calls++;await new Promise(r=>setTimeout(r,55));},afterEvaluate:async()=>{if(!callsToSearch&&await f.page.evaluate(()=>window.searches>0)){callsToSearch=calls;timeToSearchMs=Math.round(performance.now()-began);}}});
  await s.refreshStoreAvailability(STORES[0],()=>{},Date.now()+5000,()=>{},{fast});
  assert.equal(f.postalRequests(),1);measurements.push({mode:fast?'combined-open-fill':'separate-open-fill',callsToSearch,totalNativeCalls:calls,timeToSearchMs});
 }
 assert.ok(measurements[1].callsToSearch<=measurements[0].callsToSearch-2);t.diagnostic(JSON.stringify({offlineCAPBenchmark:measurements}));
});

test('a reader upgrade replaces passive cached callbacks for the same product and Store',async t=>{
 const f=await fixture(t,{path:'/jp/shop/apw/checkout?_s=Fulfillment-init',body:noSlotBody()}),s=fixtureSafari(f);
 const firstCalendar=function firstCalendar(){return{ready:false,reason:'fixture-old-reader'};};
 const nextCalendar=function nextCalendar(){return{ready:false,reason:'fixture-new-reader'};};
 const build=reader=>createPickupFastDOM(pageDOM,reader);
 const args={action:'read',selection,storeId:'R119',storeLabels:['Shibuya','渋谷']};
 assert.equal((await s.evaluate(build(firstCalendar),args)).reason,'fixture-old-reader');
 await f.page.evaluate(()=>window.__fixturePreviousReader=window.__applePickupReadiness);
 assert.equal((await s.evaluate(build(nextCalendar),args)).reason,'fixture-new-reader');
 assert.equal(await f.page.evaluate(()=>window.__fixturePreviousReader.closed),true);
 assert.equal(f.outbound(),1);
});

test('calendar action origin distinguishes an automatic change from an already selected operator or default value',async t=>{
 const f=await fixture(t,{path:'/jp/shop/apw/checkout?_s=Fulfillment-init',body:noSlotBody()+'<input id="date8" type="radio" name="bartPickupDateSelectorButtonGroup" value="8" checked><label for="date8">November8</label><select data-autom="pickup-availablewindow-dropdown"><option value="">選択</option><option value="8-17:30-17:45">17:30</option></select>'}),s=fixtureSafari(f),timings=[];s.onTiming=x=>timings.push(x);
 await f.page.evaluate(()=>{window.actualSlotChanges=0;document.querySelector('select').onchange=()=>window.actualSlotChanges++;});
 const args={selection,storeId:'R119',storeLabels:['Shibuya','渋谷'],action:'slot',dateId:'date8',value:'8-17:30-17:45'};
 assert.equal((await s.evaluate(pickupFastDOM,args,{guardPayment:true})).selectionChanged,true);
 assert.equal((await s.evaluate(pickupFastDOM,args,{guardPayment:true})).selectionChanged,false);
 assert.deepEqual(timings.filter(x=>x.name==='calendar:slot-origin').map(x=>x.code),['AUTOMATION','ALREADY_SELECTED']);
 assert.equal(await f.page.evaluate(()=>window.actualSlotChanges),1);assert.equal(f.outbound(),1);
});


test('Apple Pay completion exposes only a validated terminal result and preserves the merchant call',async t=>{
 for(const [result,failed,succeeded] of [[1,true,false],[{status:1},true,false],[0,false,true],[{status:0},false,true],[{status:6},false,false],[{status:'1'},false,false],[{},false,false]]){
  const f=await fixture(t,{path:'/jp/shop/checkout?_s=Review',body:'<span class="rs-companionbar-button-amount">100,000円</span>'+item+'<h2>Apple 渋谷</h2><button aria-label="Apple Pay">Apple Pay</button>'});
  await f.page.evaluate(()=>{window.merchantResult=null;window.ApplePaySession=class extends EventTarget{begin(){}abort(){}completePayment(value){window.merchantResult=value;return 123;}};});
  await f.run({action:'arm-apple-pay',store:STORES[0],nonce:'fixture',attempt:'fixture-completion'});
  const returned=await f.page.evaluate(result=>{const session=new window.ApplePaySession;session.begin();session.dispatchEvent(new Event('paymentauthorized'));return session.completePayment(result);},result);
  assert.equal(returned,123);assert.deepEqual(await f.page.evaluate(()=>window.merchantResult),result);
  const p=await f.run({action:'inspect'});assert.equal(p.paymentFailed,failed);assert.equal(p.paymentSucceeded,succeeded);assert.equal(p.paymentActive,false);assert.equal(p.confirmation,false);
 }
});


test('a reloaded contact page returns to the bag only with an exact native terminal-failure proof',async t=>{
 const id='00000000-0000-4000-8000-000000000001',nonce='00000000-0000-4000-8000-000000000002';
 for(const unsafe of ['none','missing','wrong-owner','wrong-sku','future','too-early','different-dispatch','payment-success']){
  const f=await fixture(t,{path:'/jp/shop/apw/checkout?_s=PickupContact-init',body:'<h1>Contact</h1>'+contactForm()});const session=fixtureSafari(f);session.binding.nonce=nonce;const invoke=session.invoke;let navigationCalls=0;session.invoke=async r=>{if(r.script?.includes('\"action\":\"navigate\"'))navigationCalls++;try{return await invoke(r);}catch(e){if(e.message.includes('Execution context was destroyed'))throw Error('SAFARI_SCRIPT_UNAVAILABLE');throw e;}};
  await f.page.evaluate(({nonce,unsafe})=>{window.name='ApplePickupLoop:'+(unsafe==='wrong-owner'?'other':nonce);if(unsafe==='different-dispatch')document.documentElement.setAttribute('data-apple-loop-pay-dispatched','other');if(unsafe==='payment-success')window.__applePickupPayment={completed:true,completion:'succeeded'};},{nonce,unsafe});
  const terminalFailure={source:'native-wallet-completed-failure',attemptId:id,pressedAt:Date.now()-60000,failedAt:Date.now()-10000};if(unsafe==='wrong-sku')session.selection={...selection,sku:'OTHER1J/A'};if(unsafe==='future')terminalFailure.failedAt=Date.now()+60000;if(unsafe==='too-early')terminalFailure.pressedAt=Date.now()-1000;
  if(unsafe==='wrong-sku'){await assert.rejects(session.action('navigate',{url:'https://www.apple.com/jp/shop/bag',terminalFailure:{...terminalFailure,nonce,sku:selection.sku}}),/CHECKOUT_UNCERTAIN/);continue;}
  const run=()=>session.navigateBag(unsafe==='missing'?{}:{terminalFailure});
  if(unsafe==='none'){await run();assert.match(f.page.url(),/\/jp\/shop\/bag$/);assert.equal(navigationCalls,1);}
  else await assert.rejects(run(),/CHECKOUT_UNCERTAIN/);
 }
});

test('contact recovery after rejected input requires the original armed document and no payment observation', async t => {
  const attemptId = '00000000-0000-4000-8000-000000000001';
  const nonce = '00000000-0000-4000-8000-000000000002';
  for (const unsafe of ['none','wrong-owner','wrong-attempt','observed','authorized','completed','no-observer','too-early','missing-proof-with-error']) {
    const f = await fixture(t, {path:'/jp/shop/apw/checkout?_s=PickupContact-init',body:'<h1>Contact</h1>'+contactForm()});
    const session = fixtureSafari(f);
    session.binding.nonce = nonce;
    const invoke = session.invoke;
    session.invoke = async request => {
      try { return await invoke(request); }
      catch (error) {
        if (error.message.includes('Execution context was destroyed')) throw Error('SAFARI_SCRIPT_UNAVAILABLE');
        throw error;
      }
    };
    await f.page.evaluate(({nonce,attemptId,unsafe}) => {
      window.name = 'ApplePickupLoop:' + (unsafe === 'wrong-owner' ? 'other' : nonce);
      document.documentElement.setAttribute('data-apple-loop-pay-dispatched', ['wrong-attempt','missing-proof-with-error'].includes(unsafe) ? 'other' : attemptId);
      if (unsafe !== 'no-observer') window.__applePickupPayment = { [unsafe]:true };
      if (unsafe === 'missing-proof-with-error') {
        const alert = document.createElement('p');
        alert.setAttribute('role','alert'); alert.textContent = 'Payment failed';
        document.body.append(alert);
      }
    }, {nonce,attemptId,unsafe});
    const proof = {source:'native-input-rejected',attemptId,pressedAt:Date.now()-(unsafe==='too-early'?1000:3000)};
    const reading = await session.inspect({paymentContext:{id:attemptId,pressedAt:proof.pressedAt}});
    assert.equal(reading.inputRejectionReady,['none','too-early'].includes(unsafe),unsafe);
    if (unsafe === 'none') {
      await session.navigateBag({terminalFailure:proof});
      assert.match(f.page.url(), /\/jp\/shop\/bag$/);
    } else {
      await assert.rejects(session.navigateBag({terminalFailure:proof}), /CHECKOUT_UNCERTAIN|PAGE_BUSY/);
    }
  }
});

test('a replaced Apple Pay page with unavailable pickup options needs the scoped terminal Wallet failure', async t => {
  const attemptId='00000000-0000-4000-8000-000000000001';
  const nonce='00000000-0000-4000-8000-000000000002';
  const refusal='お客様が選択した「Delivery & Pickup Options（配送と受取りのオプション）」は、このご注文に対して利用できなくなりました。以下の新しいオプションを選択してください。';
  for (const boundary of ['none','no-proof','unrelated-page','other-owner','other-attempt','unknown-message','busy','successful-payment']) {
    const f=await fixture(t,{
      path:boundary==='unrelated-page'?'/jp/shop/checkout?_s=Fulfillment-error':'/jp/shop/apw/checkout?_s=Fulfillment-error',
      body:'<div role="alert">'+(boundary==='unknown-message'?'Choose a new option.':refusal)+'</div>',
    });
    const session=fixtureSafari(f);session.binding.nonce=nonce;
    const invoke=session.invoke;
    session.invoke=async request=>{
      try{return await invoke(request);}
      catch(error){
        if(error.message.includes('Execution context was destroyed'))throw Error('SAFARI_SCRIPT_UNAVAILABLE');
        throw error;
      }
    };
    await f.page.evaluate(({nonce,boundary})=>{
      window.name='ApplePickupLoop:'+(boundary==='other-owner'?'other':nonce);
      if(boundary==='other-attempt')document.documentElement.setAttribute('data-apple-loop-pay-dispatched','another-attempt');
      if(boundary==='busy')document.body.setAttribute('aria-busy','true');
      if(boundary==='successful-payment')window.__applePickupPayment={completed:true,completion:'succeeded'};
    },{nonce,boundary});
    const page=await session.inspect();
    assert.equal(page.pickupOptionsRejected,!['unrelated-page','unknown-message'].includes(boundary),boundary);
    const terminalFailure={source:'native-wallet-completed-failure',attemptId,pressedAt:Date.now()-60000,failedAt:Date.now()-20000};
    if(boundary==='none'){
      await session.navigateBag({terminalFailure});
      assert.match(f.page.url(),/\/jp\/shop\/bag$/);
    }else{
      await assert.rejects(session.navigateBag(boundary==='no-proof'?{}:{terminalFailure}),/CHECKOUT_UNCERTAIN|PAGE_BUSY/,boundary);
      assert.match(f.page.url(),/checkout/);
    }
  }
});

test('reviewed pickup refusal only leaves the exact armed pickup page when payment activity is absent',async t=>{
 const id='00000000-0000-4000-8000-000000000001',nonce='00000000-0000-4000-8000-000000000002';
 for(const boundary of ['none','wrong-attempt','authorized','busy','wrong-sku']){
  const f=await fixture(t,{path:'/jp/shop/apw/checkout?_s=Fulfillment-init',body:apwSummary()});
  const s=fixtureSafari(f);s.binding.nonce=nonce;
  const invoke=s.invoke;
  s.invoke=async request=>{
   assert.equal(request.allowNavigation,false);
   try{return await invoke(request);}
   catch(error){
    if(error.message.includes('Execution context was destroyed'))throw Error('SAFARI_SCRIPT_UNAVAILABLE');
    throw error;
   }
  };
  await f.page.evaluate(({id,nonce,boundary})=>{
   window.name='ApplePickupLoop:'+nonce;
   document.documentElement.setAttribute('data-apple-loop-pay-dispatched',boundary==='wrong-attempt'?'other':id);
   window.__applePickupPayment={authorized:boundary==='authorized'};
   if(boundary==='busy')document.body.setAttribute('aria-busy','true');
  },{id,nonce,boundary});
  const terminalFailure={source:'operator-reviewed-pickup-refusal',attemptId:id,pressedAt:Date.now()-60000,nonce,sku:boundary==='wrong-sku'?'OTHER1J/A':selection.sku};
  const run=()=>s.action('navigate',{url:'https://www.apple.com/jp/shop/bag',terminalFailure});
  if(boundary==='none'){
   try{await run();}catch(error){assert.equal(error.message,'SAFARI_SCRIPT_UNAVAILABLE');}
   await f.page.waitForURL('https://www.apple.com/jp/shop/bag');
  }else{
   await assert.rejects(run(),/CHECKOUT_UNCERTAIN|PAGE_BUSY/);
   assert.match(f.page.url(),/checkout/);
  }
 }
});

test('merchant pickup refusal diagnostics survive a replaced page and remain scoped to the exact payment attempt',async t=>{
 const f=await fixture(t,{path:'/jp/shop/checkout?_s=Review',body:'<span class="rs-companionbar-button-amount">100,000円</span>'+item+'<h2>Apple 渋谷</h2><button aria-label="Apple Pay">Apple Pay</button>'});
 const id='00000000-0000-4000-8000-000000000001',nonce='00000000-0000-4000-8000-000000000002',pressedAt=Date.now();await f.page.evaluate(n=>window.name='ApplePickupLoop:'+n,nonce);
 await f.run({action:'arm-apple-pay',store:STORES[0],nonce,attempt:id});
 await f.page.evaluate(()=>{document.body.innerHTML='<div role="alert">この商品は、選択した場所で受け取ることはできません。別の場所か配送オプションを選択してください。</div><div>fixture-secret operator@example.invalid 08000000000</div>';window.dispatchEvent(new Event('pagehide'));});
 const stored=await f.page.evaluate(()=>sessionStorage.getItem('apple-loop-payment-diagnostic:00000000-0000-4000-8000-000000000001'));
 assert.ok(stored);assert.ok(!stored.includes('fixture-secret'));assert.ok(!stored.includes('@'));assert.ok(!stored.includes('08000000000'));assert.ok(!stored.includes('http'));assert.ok(!stored.includes('この商品'));
 await f.page.reload();const context={id,pressedAt};
 const state=await f.run({action:'inspect',paymentContext:context,observerNonce:nonce});assert.deepEqual(state.merchantDiagnostics,['PICKUP_UNAVAILABLE']);
 for(const patch of [{paymentContext:{...context,id:'00000000-0000-4000-8000-000000000003'}},{observerNonce:'other'},{selection:{...selection,sku:'OTHER1J/A'}}])assert.deepEqual((await f.run({action:'inspect',paymentContext:context,observerNonce:nonce,...patch})).merchantDiagnostics,[]);
});


test('an old merchant observer cannot attribute a later attempt failure to an earlier payment',async t=>{
 const body='<span class="rs-companionbar-button-amount">100,000円</span>'+item+'<h2>Apple 渋谷</h2><button aria-label="Apple Pay">Apple Pay</button>',f=await fixture(t,{path:'/jp/shop/checkout?_s=Review',body});
 const nonce='00000000-0000-4000-8000-000000000002',one='00000000-0000-4000-8000-000000000001',two='00000000-0000-4000-8000-000000000003';await f.page.evaluate(n=>window.name='ApplePickupLoop:'+n,nonce);
 await f.run({action:'arm-apple-pay',store:STORES[0],nonce,attempt:one});
 await f.page.evaluate(()=>document.documentElement.removeAttribute('data-apple-loop-pay-dispatched'));await f.run({action:'arm-apple-pay',store:STORES[0],nonce,attempt:two});
 await f.page.evaluate(()=>{document.body.innerHTML='<div role="alert">この商品は、選択した場所で受け取ることはできません。</div>';window.dispatchEvent(new Event('pagehide'));});
 const stored=await f.page.evaluate(({one,two})=>({old:sessionStorage.getItem('apple-loop-payment-diagnostic:'+one),current:JSON.parse(sessionStorage.getItem('apple-loop-payment-diagnostic:'+two))}),{one,two});
 assert.equal(stored.old,null);assert.deepEqual(stored.current.codes,['PICKUP_UNAVAILABLE']);assert.equal(stored.current.attempt,two);
});


test('a merchant error revealed only by a visibility attribute is captured without any page action',async t=>{
 const id='00000000-0000-4000-8000-000000000001',nonce='00000000-0000-4000-8000-000000000002';
 const f=await fixture(t,{path:'/jp/shop/checkout?_s=Review',body:'<span class="rs-companionbar-button-amount">100,000円</span>'+item+'<h2>Apple 渋谷</h2><button aria-label="Apple Pay">Apple Pay</button><div hidden id="merchant-error" role="alert">この商品は、選択した場所で受け取ることはできません。</div>'});
 await f.page.evaluate(n=>window.name='ApplePickupLoop:'+n,nonce);await f.run({action:'arm-apple-pay',store:STORES[0],nonce,attempt:id});
 await f.page.evaluate(()=>document.getElementById('merchant-error').hidden=false);
 await f.page.waitForFunction(()=>sessionStorage.getItem('apple-loop-payment-diagnostic:00000000-0000-4000-8000-000000000001'));
 const saved=await f.page.evaluate(()=>JSON.parse(sessionStorage.getItem('apple-loop-payment-diagnostic:00000000-0000-4000-8000-000000000001')));assert.deepEqual(saved.codes,['PICKUP_UNAVAILABLE']);assert.equal(f.outbound(),1);
});

test('fresh pickup advisories use a real browser response and remain strictly read-only',async t=>{
 const nonce='00000000-0000-4000-8000-000000000001';
 const f=await fixture(t,{path:'/jp/shop/apw/checkout?_s=Fulfillment-init',body:apwSummary()+'<label><input name="store-locator-result" type="radio" value="R119" disabled>Apple Shibuya</label>'});
 await f.page.evaluate(n=>{
  window.name='ApplePickupLoop:'+n;
  document.addEventListener('click',event=>{const option=event.target.closest('[role="radio"]');if(!option)return;for(const e of document.querySelectorAll('[role="radio"]'))e.setAttribute('aria-checked',String(e===option));void fetch('/jp/shop/apw/checkoutx?_m=checkout.fulfillment.fulfillmentOptions&_a=selectFulfillmentLocationAction').then(r=>r.json()).then(()=>{if(option.innerText.includes('受け取る'))document.querySelector('input[name="store-locator-result"]').disabled=false;});});
 },nonce);
 await f.run({action:'fulfillment-mode',mode:'delivery'});await new Promise(r=>setTimeout(r,180));
 await f.run({action:'fulfillment-mode',mode:'pickup'});await new Promise(r=>setTimeout(r,180));
 const read=()=>f.page.evaluate(({source,p})=>(0,eval)('('+source+')')(p),{source:freshPickupAvailability.toString(),p:{nonce,sku:selection.sku,priceJPY:selection.priceJPY,stores:selection.stores}});
 const before=f.fulfillmentRequests(),first=await read(),second=await read();
 assert.equal(before,2);assert.equal(first?.sku,selection.sku);assert.deepEqual(first?.stores,[{id:'R119',state:'available'}]);assert.equal(first.observedAt,second.observedAt);
 assert.ok(Date.now()-first.observedAt>=150&&Date.now()-first.observedAt<=5000);assert.equal(f.fulfillmentRequests(),before);assert.equal(f.postalRequests(),0);assert.equal(f.outbound(),1);
 const session=fixtureSafari(f),offered=[];session.binding={nonce};session.expected(selection);session.confirmedSKU=selection.sku;session.onAvailability=value=>{offered.push(value);return true;};
 await session.inspect();await session.inspect();assert.equal(offered.length,1);assert.deepEqual(offered[0].stores,[{id:'R119',state:'available'}]);assert.equal(offered[0].observedAt,first.observedAt);assert.equal(f.fulfillmentRequests(),before);
 await f.page.evaluate(()=>{const real=performance.now.bind(performance);Object.defineProperty(performance,'now',{value:()=>real()+6000});window.__applePickupFulfillmentChange.responseAt=performance.now()-200;document.querySelector('label').append(' new DOM text');});
 assert.equal(await read(),null,'a new DOM mutation and late completion marker cannot freshen the old network response');assert.equal(f.fulfillmentRequests(),before);
});

test('mode-only responses cannot reissue an unchanged old availability list',async t=>{
 const nonce='00000000-0000-4000-8000-000000000001';
 const f=await fixture(t,{path:'/jp/shop/apw/checkout?_s=Fulfillment-init',body:apwSummary()+'<label><input name="store-locator-result" type="radio" value="R119">Apple Shibuya</label>'});
 await f.page.evaluate(n=>{
  window.name='ApplePickupLoop:'+n;
  document.addEventListener('click',event=>{const option=event.target.closest('[role="radio"]');if(!option)return;for(const e of document.querySelectorAll('[role="radio"]'))e.setAttribute('aria-checked',String(e===option));void fetch('/jp/shop/apw/checkoutx?_m=checkout.fulfillment.fulfillmentOptions&_a=selectFulfillmentLocationAction').then(r=>r.json());});
 },nonce);
 await f.run({action:'fulfillment-mode',mode:'delivery'});await new Promise(r=>setTimeout(r,180));await f.run({action:'fulfillment-mode',mode:'pickup'});await new Promise(r=>setTimeout(r,180));
 const baseline=await f.page.evaluate(()=>window.__applePickupFulfillmentChange.availabilityBaseline);assert.equal(baseline.stores[0].available,true);
 const value=await f.page.evaluate(({source,p})=>(0,eval)('('+source+')')(p),{source:freshPickupAvailability.toString(),p:{nonce,sku:selection.sku,priceJPY:selection.priceJPY,stores:selection.stores}});
 assert.equal(value,null);assert.equal(f.fulfillmentRequests(),2);assert.equal(f.postalRequests(),0);assert.equal(f.outbound(),1);
});
