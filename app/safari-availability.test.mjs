import test from 'node:test';
import assert from 'node:assert/strict';
import { SafariSession } from './safari.mjs';
import { pageDOM } from './page-dom.mjs';
import { freshPickupAvailability } from './pickup-availability.mjs';

const selection={sku:'AAAA1J/A',priceJPY:100000,stores:['R119']},epoch=Date.UTC(2026,10,11,0);
function fixture(){
 const s=new SafariSession({bindingPath:null,now:()=>epoch});s.binding={nonce:'00000000-0000-4000-8000-000000000001'};s.expected(selection);s.confirmedSKU=selection.sku;
 const page={phase:'pickup',fulfillmentMode:'pickup',ready:true,pending:false,sessionWarning:false,errors:0,fulfillmentResponseVerified:true,fulfillmentResponseAgeMs:200,fulfillmentResponseEpochMs:epoch-190};
 const sample={origin:'safari-pickup-response',sku:selection.sku,observedAt:epoch-200,stores:[{id:'R119',state:'available'}]},calls=[],offered=[];
 s.onAvailability=value=>{offered.push(value);return true;};
 s.evaluate=async(fn,p)=>{calls.push({fn,p});if(fn===pageDOM)return{...page};assert.equal(fn,freshPickupAvailability);return sample;};
 return{s,page,sample,calls,offered};
}
test('a fresh owned Safari response emits once and skips duplicate advisory reads',async()=>{
 const f=fixture();await f.s.inspect();await f.s.inspect();
 assert.equal(f.offered.length,1);assert.equal(f.calls.filter(c=>c.fn===freshPickupAvailability).length,1);assert.equal(f.calls.filter(c=>c.fn===pageDOM).length,2);assert.equal(f.calls[0].p.observeAvailability,true);
});
for(const kind of ['unverified-sku','payment-context','postal-transaction','suspended','pending-page','delivery','error','stale','unverified-response'])test('Safari advisory reads respect '+kind,async()=>{
 const f=fixture();let context;
 if(kind==='unverified-sku')delete f.s.confirmedSKU;if(kind==='payment-context')context={id:'fixture'};if(kind==='postal-transaction')f.s.pendingPostal={};if(kind==='suspended')f.s.keeperSuspended=true;if(kind==='pending-page')f.page.pending=true;if(kind==='delivery')f.page.fulfillmentMode='delivery';if(kind==='error')f.page.errors=1;if(kind==='stale')f.page.fulfillmentResponseAgeMs=5001;if(kind==='unverified-response')f.page.fulfillmentResponseVerified=false;
 await f.s.inspect(context?{paymentContext:context}:{});assert.equal(f.offered.length,0);assert.equal(f.calls.filter(c=>c.fn===freshPickupAvailability).length,0);
});
test('a settled pickup response can interrupt the keeper before its delivery mutation',async()=>{
 const f=fixture();f.s.pendingMode='pickup';await f.s.inspect();assert.equal(f.offered.length,1);
 f.page.pending=true;f.page.fulfillmentResponseEpochMs++;await f.s.inspect();assert.equal(f.offered.length,1);
});
test('a rejected or unreadable optional advisory leaves normal page inspection working',async()=>{
 const f=fixture();let reject=true;f.s.onAvailability=value=>{f.offered.push(value);return !reject;};
 await f.s.inspect();reject=false;await f.s.inspect();assert.equal(f.offered.length,2);
 f.page.fulfillmentResponseEpochMs++;const read=f.s.evaluate;f.s.evaluate=async(fn,p)=>{if(fn===freshPickupAvailability)throw Error('SAFARI_UNCERTAIN');return read(fn,p);};assert.equal((await f.s.inspect()).phase,'pickup');
});
test('the Safari advisory boundary drops all non-public extra payload fields',async()=>{
 const f=fixture();f.sample.privateURL='https://private.invalid';f.sample.contact='private contact';f.sample.stores[0].privateText='private';await f.s.inspect();assert.ok(!JSON.stringify(f.offered).includes('private'));
});
test('an explicit checkout-only read suppresses the redundant availability advisory',async()=>{
 const f=fixture();await f.s.inspect({observeAvailability:false});
 assert.equal(f.offered.length,0);assert.equal(f.calls.length,1);
 assert.equal(f.calls[0].fn,pageDOM);assert.equal(f.calls[0].p.observeAvailability,undefined);
});
test('suppressing one checkout read preserves the next normal availability observation',async()=>{
 const f=fixture();await f.s.inspect({observeAvailability:false});await f.s.inspect();
 assert.equal(f.offered.length,1);assert.equal(f.calls.filter(c=>c.fn===freshPickupAvailability).length,1);
});
