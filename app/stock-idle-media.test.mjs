import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as wait } from 'node:timers/promises';
import { chromium } from 'playwright';
import { createStockIdleMedia } from './stock-idle-media.mjs';
import { createChromiumStockSession } from './chromium-session.mjs';

test('authentication, checkout, security challenges and popups prevent media changes',async()=>{
  for(const option of [{url:'https://www.apple.com/jp/shop/checkout'},{sensitive:1},{pages:2},{heading:'Verify your identity'},{heading:'CAPTCHA'}]){
    let changes=0;const page={url:()=>option.url??'https://www.apple.com/jp/',locator:selector=>({count:async()=>option.sensitive??0,allTextContents:async()=>[option.heading??'Public fixture']}),evaluate:async()=>{changes++;}};
    const context={pages:()=>Array(option.pages??1).fill(page)};await createStockIdleMedia({context,page}).quiet();assert.equal(changes,0);
  }
});
test('a page failure cannot replace the stock response with a media cleanup error',async()=>{
  const page={url:()=>{throw Error('PRIVATE_FIXTURE');}};const diagnostics=[];const idle=createStockIdleMedia({page,context:{},emit:e=>diagnostics.push(e)});await idle.quiet();assert.equal(idle.snapshot(),'disabled');assert.deepEqual(diagnostics,[{stage:'stock-idle-media-unavailable'}]);
});
test('offline Chromium pauses media and animations while ordinary page timers keep running',async t=>{
  assert.equal(process.env.CHECKOUT_DISABLE_NATIVE,'1');const browser=await chromium.launch({headless:true});t.after(()=>browser.close());const context=await browser.newContext();
  await context.route('**/*',r=>r.fulfill({contentType:'text/html',body:'<style>@keyframes spin{to{transform:rotate(360deg)}}#a{animation:spin 1s infinite}</style><h1>Offline fixture</h1><div id="a">A</div><video id="v" autoplay muted></video><script>globalThis.ticks=0;setInterval(()=>ticks++,10)</script>'}));
  const page=await context.newPage();await page.goto('https://www.apple.com/jp/');await page.evaluate(async()=>{const c=document.createElement('canvas');c.width=c.height=8;c.getContext('2d').fillRect(0,0,8,8);v.srcObject=c.captureStream(10);await v.play();});
  assert.equal(await page.evaluate(()=>v.paused),false);const idle=createStockIdleMedia({context,page});await idle.quiet();assert.equal(idle.snapshot(),'quiet');const before=await page.evaluate(()=>({paused:v.paused,autoplay:v.autoplay,animations:document.getAnimations().map(a=>a.playState),ticks}));assert.equal(before.paused,true);assert.equal(before.autoplay,false);assert.ok(before.animations.every(s=>s==='paused'));await wait(120);assert.ok(await page.evaluate(()=>ticks)>before.ticks+2);await context.close();
});
test('offline stock transport preserves each response and sends only its requested GET',async t=>{
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close());let requests=0,clock=0;const newContext=browser.newContext.bind(browser);
  browser.newContext=async options=>{assert.equal(options.reducedMotion,'reduce');const context=await newContext(options);await context.route('**/*',route=>{
    if(new URL(route.request().url()).pathname==='/jp/shop/retail/pickup-message'){requests++;return route.fulfill({contentType:'application/json',body:JSON.stringify({fixture:requests})});}
    return route.fulfill({contentType:'text/html',body:'<h1>Offline fixture</h1>'});
  });return context;};
  const session=await createChromiumStockSession({launch:async()=>browser,quietWhenIdle:true,monotonic:()=>clock});t.after(()=>session.close());assert.equal(session.idleState(),'quiet');const url=new URL('https://www.apple.com/jp/shop/retail/pickup-message');
  assert.deepEqual(await(await session.fetch(url,{method:'GET'})).json(),{fixture:1});clock=2100;assert.deepEqual(await(await session.fetch(url,{method:'GET'})).json(),{fixture:2});assert.equal(requests,2);assert.equal(session.idleState(),'quiet');
});
