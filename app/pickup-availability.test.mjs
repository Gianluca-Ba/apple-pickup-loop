import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { freshPickupAvailability } from './pickup-availability.mjs';

function fixture(){
 const epoch=Date.UTC(2026,10,11,0),nonce='00000000-0000-4000-8000-000000000001';
 const element=(text='',attrs={})=>({innerText:text,textContent:text,attrs,disabled:false,shown:true,getClientRects(){return this.shown?[{}]:[];},getAttribute(k){return this.attrs[k]??null;},matches(){return this.fieldsetDisabled===true;}});
 const label=element('Apple Shibuya'),row=element();Object.assign(row,{value:'R119',labels:[label]});
 const groups={modes:[element('お客様がご自身で受け取る',{'aria-checked':'true'}),element('配送を希望する',{'aria-checked':'false'})],rows:[row],totals:[element('100,000円')],busy:[],errors:[]};
 const change={mode:'pickup',responseComplete:true,startedAt:9700,responseAt:9800,availabilityBaseline:{version:1,sku:'AAAA1J/A',at:9600,stores:[{id:'R119',available:false}]}};
 const entries=[{initiatorType:'fetch',startTime:9701,responseEnd:9800,name:'https://secure1.store.apple.com/jp/shop/apw/checkoutx?_m=checkout.fulfillment.fulfillmentOptions&_a=selectFulfillmentLocationAction'}];
 const state={now:10000,clock:epoch,origin:epoch-10000,input:null,dispatched:false,requests:0};
 const document={readyState:'complete',documentElement:{hasAttribute:()=>state.dispatched},getElementById:()=>state.input,querySelectorAll:s=>s==='[role="radio"]'?groups.modes:s==='.rs-companionbar-button-amount'?groups.totals:s==='input[name="store-locator-result"]'?groups.rows:s.startsWith('[aria-busy=')?groups.busy:s.startsWith('[role="alert"]')?groups.errors:[]};
 const window={name:'ApplePickupLoop:'+nonce,__applePickupFulfillmentChange:change};
 const context={window,document,location:{href:'https://secure1.store.apple.com/jp/shop/apw/checkout?_s=Fulfillment-init'},URL,Date:class extends Date{static now(){return state.clock;}},performance:{now:()=>state.now,get timeOrigin(){return state.origin;},getEntriesByType:()=>entries},fetch(){state.requests++;throw Error('NETWORK_FORBIDDEN');}};
 const parameters={nonce,sku:'AAAA1J/A',priceJPY:100000,stores:['R119','R224']};
 const run=()=>JSON.parse(JSON.stringify(vm.runInNewContext('('+freshPickupAvailability.toString()+')(parameters)',{...context,parameters})));
 return{run,context,parameters,state,groups,change,entries,row,label,element,epoch};
}

test('one fresh owned pickup response offers only public availability facts without issuing a request',()=>{
 const f=fixture(),value=f.run();assert.deepEqual(value,{sku:'AAAA1J/A',observedAt:f.epoch-200,stores:[{id:'R119',state:'available'}],origin:'safari-pickup-response'});assert.equal(f.state.requests,0);
 const text=JSON.stringify(value);assert.ok(!text.includes(f.parameters.nonce));assert.ok(!text.includes('https:'));assert.ok(!text.includes('Shibuya'));
});

test('a fresh mode acknowledgement cannot freshen a Store that was already available before the cycle',()=>{
 const f=fixture();f.change.availabilityBaseline={version:1,sku:f.parameters.sku,at:9600,stores:[{id:'R119',available:true}]};assert.equal(f.run(),null);
});

for(const [name,change]of Object.entries({
 'foreign host':f=>{f.context.location.href='https://foreign.invalid/jp/shop/apw/checkout?_s=Fulfillment-init';},
 'wrong checkout step':f=>{f.context.location.href='https://secure1.store.apple.com/jp/shop/apw/checkout?_s=PickupContact-init';},
 'unowned tab':f=>{f.context.window.name='other';},
 'invalid nonce':f=>{f.parameters.nonce='other';},
 'wrong total':f=>{f.groups.totals[0].textContent='200,000円';},
 'multiple totals':f=>{f.groups.totals.push(f.element('100,000円'));},
 'ambiguous amount':f=>{f.groups.totals[0].textContent='100,000円 100,000円';},
 'delivery mode':f=>{f.groups.modes[0].attrs['aria-checked']='false';f.groups.modes[1].attrs['aria-checked']='true';},
 'ambiguous mode':f=>{f.groups.modes[1].attrs['aria-checked']='true';},
 'busy page':f=>{f.groups.busy.push(f.element());},
 'page error':f=>{f.groups.errors.push(f.element('private message'));},
 'unfinished postal edit':f=>{f.state.input=f.element();},
 'missing response marker':f=>{delete f.context.window.__applePickupFulfillmentChange;},
 'incomplete response':f=>{f.change.responseComplete=false;},
 'missing availability baseline':f=>{delete f.change.availabilityBaseline;},
 'foreign baseline SKU':f=>{f.change.availabilityBaseline.sku='OTHER1J/A';},
 'unknown baseline version':f=>{f.change.availabilityBaseline.version=2;},
 'nonboolean baseline':f=>{f.change.availabilityBaseline.stores[0].available='false';},
 'unconfigured baseline Store':f=>{f.change.availabilityBaseline.stores[0].id='R999';},
 'duplicate baseline Store':f=>{f.change.availabilityBaseline.stores.push({...f.change.availabilityBaseline.stores[0]});},
 'baseline from an older cycle':f=>{f.change.availabilityBaseline.at=-20301;},
 'baseline created after pickup started':f=>{f.change.availabilityBaseline.at=9701;},
 'Store missing from the baseline':f=>{f.change.availabilityBaseline.stores[0].id='R224';},
 'wrong response mode':f=>{f.change.mode='delivery';},
 'pending Store response':f=>{f.context.window.__applePickupStoreSelection={responseComplete:false};},
 'missing timing entry':f=>{f.entries.length=0;},
 'ambiguous timing entries':f=>{f.entries.push({...f.entries[0]});},
 'untrusted response URL':f=>{f.entries[0].name='https://foreign.invalid/jp/shop/apw/checkoutx?_m=checkout.fulfillment.fulfillmentOptions&_a=selectFulfillmentLocationAction';},
 'wrong response action':f=>{f.entries[0].name=f.entries[0].name.replace('selectFulfillmentLocationAction','other');},
 'response before owned request':f=>{f.entries[0].startTime=9699;},
 'response after observed completion':f=>{f.entries[0].responseEnd=9801;},
 'stale response with a recent observer callback':f=>{f.entries[0].responseEnd=4000;f.entries[0].startTime=3900;f.change.startedAt=3800;},
 'unapplied response':f=>{f.change.responseAt=9900;},
 'missing time origin':f=>{f.state.origin=NaN;},
 'future wall-clock observation':f=>{f.state.clock-=1000;},
 'duplicate Store identifiers':f=>{f.groups.rows.push({...f.row});},
 'disabled Store':f=>{f.row.disabled=true;},
 'disabled fieldset':f=>{f.row.fieldsetDisabled=true;},
 'aria-disabled Store':f=>{f.row.attrs['aria-disabled']='true';},
 'hidden Store label':f=>{f.label.shown=false;},
 'unavailable Store label':f=>{f.label.innerText='Apple Shibuya not available';},
 'unconfigured Store':f=>{f.row.value='R999';},
 'already dispatched payment':f=>{f.state.dispatched=true;},
})){test('fresh pickup advisories reject '+name,()=>{const f=fixture();change(f);assert.equal(f.run(),null);assert.equal(f.state.requests,0);});}

for(const flag of ['observed','active','authorized','completed'])test('fresh pickup advisories never act on a '+flag+' payment session',()=>{const f=fixture();f.context.window.__applePickupPayment={[flag]:true};assert.equal(f.run(),null);});
for(const [age,expected]of [[149,false],[150,true],[5000,true],[5001,false]])test('fresh pickup response age boundary '+age+'ms',()=>{
 const f=fixture();f.entries[0].responseEnd=10000-age;f.entries[0].startTime=10000-age-10;f.change.startedAt=10000-age-20;f.change.responseAt=10000-age;f.change.availabilityBaseline.at=f.change.startedAt-100;
 assert.equal(Boolean(f.run()),expected);
});
