import test from 'node:test';
import assert from 'node:assert/strict';
import { AppleCatalog } from './catalog.mjs';

const phone='https://www.apple.com/jp/shop/buy-iphone/fixture-phone';
const sku='AB123J/A';
const index=(category,family)=>'<main><a href="/jp/shop/buy-'+category+'/'+family+'">Fixture device</a></main>';
const variants=price=>'<script id="metrics">'+JSON.stringify({data:{products:[{partNumber:sku,name:'Fixture phone',price:{fullPrice:price}}]}})+'</script>';
function fixture(){
  let now=1000,failed=false,allFailed=false,family='fixture-phone',price=100000;
  const requests=[];
  const catalog=new AppleCatalog({now:()=>now,fetchPage:async url=>{
    requests.push(url);
    if(allFailed)throw Error('OFFLINE_UNAVAILABLE');
    if(url.endsWith('/buy-iphone')){if(failed)throw Error('OFFLINE_UNAVAILABLE');return index('iphone',family);}
    if(url.endsWith('/buy-ipad'))return index('ipad','fixture-pad');
    if(url===phone)return variants(price);
    throw Error('OFFLINE_UNAVAILABLE');
  }});
  return {catalog,requests,set(values){if('now'in values)now=values.now;if('failed'in values)failed=values.failed;if('allFailed'in values)allFailed=values.allFailed;if('family'in values)family=values.family;if('price'in values)price=values.price;}};
}

test('a failed category refresh preserves its last verified family while rechecking configuration prices',async()=>{
  const f=fixture();await f.catalog.refresh();assert.equal((await f.catalog.resolve(phone,sku)).priceJPY,100000);
  f.set({now:2000,failed:true,price:120000});await f.catalog.refresh();
  assert.equal(f.catalog.products.some(p=>p.id===phone),true);
  assert.equal(f.catalog.categories.some(c=>c.id==='iphone'),true);
  assert.equal(f.catalog.snapshot().errors.includes('iphone'),true);
  assert.equal((await f.catalog.resolve(phone,sku)).priceJPY,120000,'retained families must not retain stale configuration prices');
  assert.equal(f.requests.filter(u=>u===phone).length,2);
});

test('a successful category refresh removes a family Apple no longer lists',async()=>{
  const f=fixture();await f.catalog.refresh();f.set({now:2000,family:'replacement-phone'});await f.catalog.refresh();
  assert.equal(f.catalog.products.some(p=>p.id===phone),false);
  await assert.rejects(f.catalog.resolve(phone,sku),/PRODUCT_NOT_IN_CATALOG/);
  assert.equal(f.catalog.errors.includes('iphone'),false);
});

test('complete refresh failure does not advance freshness or discard a working catalog',async()=>{
  const f=fixture();await f.catalog.refresh();const before=f.catalog.snapshot();
  f.set({now:2000,allFailed:true});await assert.rejects(f.catalog.refresh(),/CATALOG_UNAVAILABLE/);
  assert.deepEqual(f.catalog.products,before.products);assert.deepEqual(f.catalog.categories,before.categories);
  assert.equal(f.catalog.updatedAt,1000);assert.equal(f.catalog.loading,false);assert.equal(f.catalog.loadingTask,null);
});

test('a failed category at first startup never manufactures a product or category',async()=>{
  const f=fixture();f.set({failed:true});await f.catalog.refresh();
  assert.equal(f.catalog.products.some(p=>p.category==='iphone'),false);
  assert.equal(f.catalog.categories.some(c=>c.id==='iphone'),false);
  assert.equal(f.catalog.errors.includes('iphone'),true);
  await assert.rejects(f.catalog.resolve(phone,sku),/PRODUCT_NOT_IN_CATALOG/);
});

test('category recovery clears its failure and accepts only freshly fetched configuration data',async()=>{
  const f=fixture();await f.catalog.refresh();f.set({now:2000,failed:true});await f.catalog.refresh();
  f.set({now:3000,failed:false,price:130000});await f.catalog.refresh();
  assert.equal(f.catalog.errors.includes('iphone'),false);assert.equal(f.catalog.updatedAt,3000);
  assert.equal((await f.catalog.resolve(phone,sku)).priceJPY,130000);
});
