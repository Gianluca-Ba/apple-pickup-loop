import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNativeTransport } from './native-transport.mjs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const helper = `
import {createInterface} from 'node:readline';import {appendFileSync} from 'node:fs';
let index=0;for await(const line of createInterface({input:process.stdin})){
 const r=JSON.parse(line);index++;appendFileSync(process.argv[2],JSON.stringify({operation:r.operation,index})+'\\n');
 if(r.operation==='lost')process.exit(0);
 if(r.operation==='hang')await new Promise(()=>{});
 if(r.delay)await new Promise(a=>setTimeout(a,r.delay));
 const result=r.rejection?{ok:false,code:r.rejection,notDispatched:r.notDispatched===true,axTarget:r.axTarget,domTarget:r.domTarget}:r.operation==='deny'?{ok:false,code:'PAYMENT_ACTIVE'}:{ok:true,result:{index,pid:process.pid,value:r.value??null}};
 const text=JSON.stringify(result)+'\\n';
 if(r.operation==='malformed')process.stdout.write('not-json\\n');
 else if(r.operation==='oversize')process.stdout.write('x'.repeat(2048)+'\\n');
 else if(r.operation==='duplicate')process.stdout.write(text+text);
 else if(r.operation==='utf8'){const b=Buffer.from(text),cut=b.indexOf(Buffer.from('渋'))+1;process.stdout.write(b.subarray(0,cut));await new Promise(a=>setTimeout(a,5));process.stdout.write(b.subarray(cut));}
 else process.stdout.write(text);
}
`;
function fixture(t, options={}) {
  const dir=mkdtempSync(join(tmpdir(),'apple-native-transport-')),script=join(dir,'helper.mjs'),audit=join(dir,'audit.jsonl');writeFileSync(script,helper);writeFileSync(audit,'');let spawns=0;
  const send=createNativeTransport({executable:'offline-fixture',...options,spawn:(_file,_args,stdio)=>{spawns++;return spawn(process.execPath,[script,audit],stdio);}});
  t.after(()=>{send.close();rmSync(dir,{recursive:true,force:true});});
  return{send,script,audit,spawns:()=>spawns,rows:()=>readFileSync(audit,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)};
}
test('native transport remains disabled offline unless an explicit fixture replaces spawning',async()=>{
  assert.equal(process.env.CHECKOUT_DISABLE_NATIVE,'1');await assert.rejects(createNativeTransport({executable:'/must-not-run'})({operation:'bind'}),/NATIVE_DISABLED_OFFLINE/);
});
test('the helper is reused and queued requests wait for their own response deadline',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();
  const requests=[];let spawns=0,killed=0;child.stdin.on('data',b=>requests.push(JSON.parse(String(b))));child.kill=()=>{killed++;};
  const send=createNativeTransport({executable:'offline-fixture',timeoutMs:250,spawn:()=>{spawns++;return child;}});t.after(()=>send.close());
  const pending=Promise.all([1,2,3].map(value=>send({operation:'read',value})));
  for(let index=1;index<=3;index++){
    assert.equal(requests.length,index);assert.equal(requests[index-1].value,index);
    t.mock.timers.tick(140);
    child.stdout.write(JSON.stringify({ok:true,result:{index,pid:17,value:index}})+'\n');
  }
  const replies=await pending;
  assert.deepEqual(replies.map(r=>r.index),[1,2,3]);assert.equal(new Set(replies.map(r=>r.pid)).size,1);assert.equal(spawns,1);assert.equal(killed,0);
});
test('a native guard refusal keeps the helper alive without sending a payment click',async t=>{
  const f=fixture(t);await assert.rejects(f.send({operation:'deny'}),/PAYMENT_ACTIVE/);const r=await f.send({operation:'read'});assert.equal(r.index,2);assert.equal(f.spawns(),1);assert.deepEqual(f.rows().map(r=>r.operation),['deny','read']);
});
test('a lost reply rejects queued requests without replay and a later explicit read uses a fresh helper',async t=>{
  const f=fixture(t);const replies=await Promise.allSettled([f.send({operation:'lost'}),f.send({operation:'must-not-run'})]);assert.ok(replies.every(r=>r.status==='rejected'&&r.reason.message==='SAFARI_UNCERTAIN'));assert.deepEqual(f.rows().map(r=>r.operation),['lost']);assert.equal(f.spawns(),1);
  const next=await f.send({operation:'read'});assert.equal(next.index,1);assert.equal(f.spawns(),2);assert.deepEqual(f.rows().map(r=>r.operation),['lost','read']);
});
test('timeout kills only the helper and never retries the unanswered command',async t=>{
  const f=fixture(t,{timeoutMs:200});const r=await Promise.allSettled([f.send({operation:'hang'}),f.send({operation:'must-not-run'})]);assert.ok(r.every(x=>x.status==='rejected'&&x.reason.message==='SAFARI_UNCERTAIN'));assert.deepEqual(f.rows().map(r=>r.operation),['hang']);assert.equal(f.spawns(),1);await f.send({operation:'read'});assert.equal(f.spawns(),2);
});
test('malformed, duplicate and oversized replies cannot authorize a queued command',async t=>{
  for(const operation of ['malformed','duplicate','oversize']){const f=fixture(t,{maxOutputBytes:1024});const r=await Promise.allSettled([f.send({operation}),f.send({operation:'must-not-run'})]);assert.ok(r.every(x=>x.status==='rejected'&&x.reason.message==='SAFARI_UNCERTAIN'));assert.deepEqual(f.rows().map(r=>r.operation),[operation]);assert.equal(f.spawns(),1);}
});
test('split UTF-8 replies retain the exact public Store label',async t=>{
  const f=fixture(t);assert.equal((await f.send({operation:'utf8',value:'渋谷'})).value,'渋谷');
});
test('one-shot diagnostic parents exit normally without leaving a referenced helper',async t=>{
  const f=fixture(t);const module=fileURLToPath(new URL('./native-transport.mjs',import.meta.url));const source=`import {spawn} from 'node:child_process';import {createNativeTransport} from ${JSON.stringify(module)};const send=createNativeTransport({executable:'fixture',spawn:(_f,_a,o)=>spawn(process.execPath,[${JSON.stringify(f.script)},${JSON.stringify(f.audit)}],o)});console.log(JSON.stringify(await send({operation:'read'})));`;
  const result=await promisify(execFile)(process.execPath,['--input-type=module','-e',source],{timeout:2500});assert.equal(JSON.parse(result.stdout).index,1);
});
test('native framing accepts separate invalid requests offline without touching Safari', {skip:process.platform!=='darwin'},t=>{
  assert.equal(process.env.CHECKOUT_DISABLE_NATIVE,'1');const dir=mkdtempSync(join(tmpdir(),'apple-native-framing-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const bin=join(dir,'fixture');
  execFileSync('/usr/bin/clang',['-fobjc-arc','-O2','-framework','Cocoa','-framework','ScriptingBridge','-framework','ApplicationServices','-framework','Security',fileURLToPath(new URL('./native/safari.m',import.meta.url)),'-o',bin],{timeout:30000});
  const input='{"operation":"offline-invalid"}\nnot json\n[]\n';const replies=execFileSync(bin,['--stdio'],{input,encoding:'utf8',timeout:5000}).trim().split('\n').map(JSON.parse);assert.equal(replies.length,3);assert.ok(replies.every(r=>!r.ok&&r.code==='INVALID_COMMAND'));
  assert.equal(JSON.parse(execFileSync(bin,{input:'not json',encoding:'utf8',timeout:5000})).code,'INVALID_COMMAND');
});

test('only an explicit pre-input rejection of the payment command certifies non-dispatch',async t=>{
 const f=fixture(t);for(const operation of ['press-apple-pay','read'])for(const code of ['APPLE_PAY_HIT_CHANGED','SAFARI_UNCERTAIN'])for(const flag of [true,false])await assert.rejects(f.send({operation,rejection:code,notDispatched:flag}),e=>{assert.equal(e.notDispatched===true,operation==='press-apple-pay'&&code==='APPLE_PAY_HIT_CHANGED'&&flag);return true;});
});

test('a rejected payment target only exports enumerated diagnostics',async t=>{
  const f=fixture(t);
  const request={operation:'press-apple-pay',rejection:'APPLE_PAY_HIT_CHANGED',notDispatched:true,axTarget:'AX_ANCESTOR',domTarget:'DOM_REACHABLE'};
  await assert.rejects(f.send(request),e=>e.axTarget==='AX_ANCESTOR'&&e.domTarget==='DOM_REACHABLE'&&e.notDispatched===true);
  for(const overrides of [{axTarget:'PRIVATE_CONTROL',domTarget:'PRIVATE_TEXT'},{operation:'read'},{notDispatched:false},{rejection:'SAFARI_UNCERTAIN'}]){
    await assert.rejects(f.send({...request,...overrides}),e=>e.axTarget===undefined&&e.domTarget===undefined);
  }
});
