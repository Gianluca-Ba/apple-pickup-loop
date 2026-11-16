import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { MultipassGuestStream, validateGuestArgv, GUEST_STREAM_SOURCE, runGuestStream, closeGuestStream } from './guest-stream.mjs';
import { readGuestCommand, guestClientArguments, runLinuxGuestCommand, refreshLinuxSampleStart, reclaimUnacceptedLinuxSample } from './linux-control.mjs';

const channel='linux-guest-stream-v1',id='11111111-1111-1111-1111-111111111111';
const encoded = value => Buffer.from(JSON.stringify(value)).toString('base64');
const stock = (path='/start',operation='network',worker=2) => [
  ...(worker===1?['/usr/sbin/runuser','-u','monitor','--','/usr/local/bin/node']:['/usr/bin/docker','exec','iphone-linux-vpn-'+worker,'/opt/node22/bin/node']),
  '/opt/iphone-stock/app/worker-server.mjs','--client',path,encoded(path==='/result'?{id}:{id,operation,data:{}}),
];
const control = (command='start',operation='inventory',worker='2') => ['/usr/bin/python3','/opt/iphone-stock-pool/linux-vpn-control.py',command,id,...(command==='result'?[]:operation==='inventory'?[operation]:[operation,worker])];
const outer = guestClientArguments;
const receipt = {ok:true,requestId:id,channel:'stock-worker-v1',result:{safe:true}};
const context = argv => ({id,channel:'stock-worker-v1',required:true,usePersistent:true,guestArgv:argv});

function fakeTransport(handler, {ready=true}={}) {
  const children=[],requests=[];
  const spawn=(_bin,args)=>{
    const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.killed=0;
    assert.equal(_bin, 'multipass'); child.token=args.at(-1);
    const send=value=>child.stdout.write(JSON.stringify({channel,session:child.token,...value})+'\n');
    child.send=send;child.finish=()=>{if(child.finished)return;child.finished=true;child.stdout.end();child.stderr.end();child.emit('close',0);};
    child.stdin=new Writable({write(chunk,_encoding,done){try{for(const line of chunk.toString().trim().split('\n')){const r=JSON.parse(line);requests.push(r);handler(child,r,value=>send({seq:r.seq,exitCode:0,stdout:'{}',...value}));}done();}catch(e){done(e);}},final(done){done();setImmediate(child.finish);}});
    child.kill=()=>{child.killed++;setImmediate(child.finish);return true;};
    children.push(child);if(ready)setImmediate(()=>send({ready:true}));return child;
  };
  return {spawn,children,requests};
}

const validCommands=[stock(),stock('/start','close',1),stock('/start','sample',29),stock('/result'),control(),control('result'),control('start','connect','1'),control('start','disconnect','29'),control('start','rotate','2')];
const invalidCommands=[['/bin/sh','-c','anything'],control('start','rotate','1'),control('start','connect','31'),['/usr/bin/python3','/opt/other.py','result',id],stock('/start','order'),stock('/other'),[...stock().slice(0,-1),'bad base64'],[...stock().slice(0,-1),encoded({id:'wrong',operation:'network',data:{}})],[...stock('/result').slice(0,-1),encoded({id,operation:'sample'})],[...stock().slice(0,-1),encoded({id,operation:'network',data:[],extra:'bad'})],['/usr/bin/docker','exec','iphone-linux-vpn-1',...stock().slice(3)],['/usr/bin/docker','exec','iphone-linux-vpn-2\nother',...stock().slice(3)]];
for(const [i,argv]of validCommands.entries())test('stream accepts only scoped coordinator command '+i,()=>assert.deepEqual(validateGuestArgv(argv),argv));
for(const [i,argv]of invalidCommands.entries())test('stream rejects unscoped command '+i,()=>assert.throws(()=>validateGuestArgv(argv),/GUEST_SCOPE/));

test('guest independently enforces the same command scope without running any real client',()=>{
  const token=randomUUID(),commands=[...validCommands,...invalidCommands];
  const prelude="import socket,subprocess,types\nsocket.gethostname=lambda:'apple-pickup-linux'\nsubprocess.run=lambda argv,**kw:types.SimpleNamespace(returncode=0,stdout=b'{}')\n";
  const input=commands.map(argv=>JSON.stringify({channel,session:token,seq:randomUUID(),argv,timeoutMs:100,maxBuffer:32768})).join('\n')+'\n';
  const r=spawnSync('python3',['-c',prelude+GUEST_STREAM_SOURCE,token],{input,encoding:'utf8',timeout:3000,maxBuffer:65536});
  assert.equal(r.status,0,r.stderr);const frames=r.stdout.trim().split('\n').map(JSON.parse);assert.equal(frames[0].ready,true);assert.equal(frames.length,commands.length+1);
  frames.slice(1).forEach((f,i)=>assert.equal(f.error===undefined,i<validCommands.length,'scope case '+i));
});

test('one interactive process handles consecutive commands with separate correlated frames',async()=>{
  const fake=fakeTransport((_c,_r,reply)=>reply({stdout:JSON.stringify(receipt)})),client=new MultipassGuestStream({spawn:fake.spawn});
  try{assert.equal((await client.run(stock())).stdout,JSON.stringify(receipt));assert.equal((await client.run(stock('/result'))).stdout,JSON.stringify(receipt));assert.equal(fake.children.length,1);assert.equal(fake.requests.length,2);assert.notEqual(fake.requests[0].seq,fake.requests[1].seq);assert.equal(client.snapshot().commandReplies,2);}finally{await client.close();}
});
test('concurrent callers cannot bypass the existing serial command queue',async()=>{
  let respond;const fake=fakeTransport((_c,_r,reply)=>{respond=reply;}),client=new MultipassGuestStream({spawn:fake.spawn});
  try{const first=client.run(stock());while(!respond)await new Promise(r=>setImmediate(r));await assert.rejects(client.run(stock('/result')),/GUEST_STREAM_BUSY/);assert.equal(fake.requests.length,1);respond({});await first;}finally{await client.close();}
});
test('a stream lost after write is not replayed and the next explicit call can reconcile its result',async()=>{
  const fake=fakeTransport((c,_r,reply)=>{if(fake.requests.length===1)setImmediate(c.finish);else reply({stdout:JSON.stringify(receipt)});}),client=new MultipassGuestStream({spawn:fake.spawn});
  try{await assert.rejects(client.run(stock()),/GUEST_TRANSPORT_CLOSED/);assert.equal(fake.requests.length,1);await client.run(stock('/result'));assert.equal(fake.children.length,2);assert.equal(fake.requests.length,2);assert.equal(fake.requests[1].argv.at(-2),'/result');}finally{await client.close();}
});
test('timeouts terminate only the owned stream and never resend the pending command',async()=>{
  const fake=fakeTransport(()=>{}),client=new MultipassGuestStream({spawn:fake.spawn});
  try{await assert.rejects(client.run(stock(),{timeout:30}),e=>e.code==='ETIMEDOUT');assert.equal(fake.requests.length,1);assert.equal(fake.children[0].killed,1);}finally{await client.close();}
});

for(const kind of ['session','sequence','json'])test('a mismatched '+kind+' frame cannot satisfy a command or trigger a replay',async()=>{
  const fake=fakeTransport((c,r)=>c.stdout.write(kind==='json'?'broken-json\n':JSON.stringify({channel,session:kind==='session'?'other':c.token,seq:kind==='sequence'?'other':r.seq,exitCode:0,stdout:'{}'})+'\n')),client=new MultipassGuestStream({spawn:fake.spawn});
  try{await assert.rejects(client.run(stock()),/GUEST_PROTOCOL/);assert.equal(fake.requests.length,1);assert.equal(fake.children[0].killed,1);}finally{await client.close();}
});
test('fragmented UTF-8 frames and escaped newlines preserve the exact client reply',async()=>{
  const stdout=JSON.stringify({value:'日本語\nsecond line'}),fake=fakeTransport((c,r)=>{const wire=JSON.stringify({channel,session:c.token,seq:r.seq,exitCode:0,stdout})+'\n';c.stdout.write(wire.slice(0,37));setImmediate(()=>c.stdout.write(wire.slice(37)));}),client=new MultipassGuestStream({spawn:fake.spawn});
  try{assert.equal((await client.run(stock())).stdout,stdout);assert.equal(fake.requests.length,1);}finally{await client.close();}
});
test('the original per-command output limit also applies to a malformed stream peer',async()=>{
  const fake=fakeTransport((_c,_r,reply)=>reply({stdout:'x'.repeat(2048)})),client=new MultipassGuestStream({spawn:fake.spawn});
  try{await assert.rejects(client.run(stock(),{maxBuffer:1024}),/GUEST_OUTPUT_LIMIT/);assert.equal(fake.requests.length,1);}finally{await client.close();}
});
test('provider stderr and client output never enter the diagnostic snapshot',async()=>{
  const marker='fixture-private-output',fake=fakeTransport((c,_r,reply)=>{c.stderr.write(marker);reply({stdout:JSON.stringify({value:marker})});}),client=new MultipassGuestStream({spawn:fake.spawn});
  try{await client.run(stock());assert.ok(!JSON.stringify(client.snapshot()).includes(marker));assert.deepEqual(Object.keys(client.snapshot()).sort(),['commandErrors','commandReplies','kind','meanRoundTripMs','protocolErrors','ready','recentRoundTrips','sessionsStarted','timeouts'].sort());}finally{await client.close();}
});
test('native transport remains disabled during offline tests',async()=>{
  assert.equal(process.env.CHECKOUT_DISABLE_NATIVE,'1');await assert.rejects(runGuestStream(stock()),/NATIVE_DISABLED_OFFLINE/);await closeGuestStream();
});
test('a newly active checkout or manual stop is rechecked after stream startup before a VPN command',async()=>{
  let allowed=true;const fake=fakeTransport((_c,_r,reply)=>reply({})),client=new MultipassGuestStream({spawn:fake.spawn});
  try{const request=client.run(control('start','connect','2'),{beforeDispatch:()=>{if(!allowed)throw Error('CHECKOUT_ACTIVE');}});allowed=false;await assert.rejects(request,/CHECKOUT_ACTIVE/);assert.equal(fake.requests.length,0);}finally{await client.close();}
});
test('explicit stream closure cancels a pending command without reissuing it',async()=>{
  let entered;const began=new Promise(r=>{entered=r;}),fake=fakeTransport(()=>entered()),client=new MultipassGuestStream({spawn:fake.spawn});
  const request=client.run(stock());const rejected=assert.rejects(request,/GUEST_TRANSPORT_CLOSED/);await began;await client.close();await rejected;assert.equal(fake.requests.length,1);assert.equal(fake.children[0].killed,1);
});
test('stream shutdown while starting cannot write a command after shutdown',async()=>{
  const fake=fakeTransport(()=>{}, {ready:false}),client=new MultipassGuestStream({spawn:fake.spawn});
  const request=client.run(stock());const rejected=assert.rejects(request,/GUEST_TRANSPORT_CLOSED|ETIMEDOUT/);await client.close();await rejected;assert.equal(fake.requests.length,0);
});

test('readGuestCommand routes only the canonical argv through the stream and still validates worker receipts',async()=>{
  const argv=stock('/result');let calls=0;const stream=async(a)=>{calls++;assert.deepEqual(a,argv);return{stdout:JSON.stringify(receipt)};};
  const value=await readGuestCommand(()=>{throw Error('LEGACY_NOT_EXPECTED');},'multipass',outer(argv),{},context(argv),{stream});assert.deepEqual(value,receipt);assert.equal(calls,1);
  await assert.rejects(readGuestCommand(()=>{},'multipass',outer(argv),{},context(argv),{stream:async()=>({stdout:JSON.stringify({...receipt,requestId:'other'})})}),/GUEST_REPLY_CONTEXT_MISMATCH/);
});
for(const code of [255,'ETIMEDOUT'])test('a '+code+' stream exit with a matching receipt remains authoritative',async()=>{
  const argv=stock('/result');const value=await readGuestCommand(()=>{},'multipass',outer(argv),{},context(argv),{stream:async()=>{throw Object.assign(Error('guest exit'),{code,stdout:JSON.stringify(receipt)});}});assert.deepEqual(value,receipt);
});
test('an uncertain stream command never falls back to replaying legacy exec',async()=>{
  const argv=stock();let legacy=0,streams=0;await assert.rejects(readGuestCommand(()=>{legacy++;},'multipass',outer(argv),{},context(argv),{stream:async()=>{streams++;throw Error('GUEST_TRANSPORT_CLOSED');}}),/GUEST_TRANSPORT_CLOSED/);assert.equal(legacy,0);assert.equal(streams,1);
});
test('stream route rejects a foreign VM and argv mismatch before any command',async()=>{
  const argv=stock();for(const args of [[...outer(argv).slice(0,1),'other-vm',...outer(argv).slice(2)],[...outer(argv).slice(0,-1),'different command']])await assert.rejects(readGuestCommand(()=>{throw Error('UNEXPECTED');},'multipass',args,{},context(argv),{stream:()=>{throw Error('UNEXPECTED');}}),/GUEST_(?:TRANSPORT_)?SCOPE/);
});
test('the explicit exec rollback selects legacy transport before dispatch',async()=>{
  const before=process.env.APPLE_LOOP_GUEST_TRANSPORT;process.env.APPLE_LOOP_GUEST_TRANSPORT='exec';const argv=stock('/result');let guards=0;
  try{const value=await readGuestCommand(async()=>({stdout:JSON.stringify(receipt)}),'multipass',outer(argv),{},{...context(argv),beforeDispatch:()=>{guards++;}},{stream:()=>{throw Error('UNEXPECTED_STREAM');}});assert.deepEqual(value,receipt);assert.equal(guards,1);}finally{if(before===undefined)delete process.env.APPLE_LOOP_GUEST_TRANSPORT;else process.env.APPLE_LOOP_GUEST_TRANSPORT=before;}
});

test('stream startup cannot compress stock dispatch spacing and a confirmed unused reservation remains reclaimable',async()=>{
  const starts=[],tokens=[],ids=[randomUUID(),randomUUID()];
  const first=runLinuxGuestCommand(async()=>{await new Promise(r=>setTimeout(r,30));assert.equal(refreshLinuxSampleStart(tokens[0]),true);starts.push(Date.now());},()=>25,false,{id:ids[0],onStart:r=>tokens.push(r)});
  const second=runLinuxGuestCommand(()=>{starts.push(Date.now());},()=>25,false,{id:ids[1],onStart:r=>tokens.push(r)});
  await Promise.all([first,second]);assert.ok(starts[1]-starts[0]>=25);assert.equal(refreshLinuxSampleStart(tokens[0]),false);
  assert.equal(refreshLinuxSampleStart(tokens[1],tokens[1].startedAt-1),false);
  assert.equal(reclaimUnacceptedLinuxSample(tokens[1],{ok:false,code:'operation-missing',requestId:ids[1],channel:'stock-worker-v1'},ids[1],false),true);
});

for(const kind of ['timeout','output-limit'])test('guest reports only bounded safe metadata on '+kind,()=>{
  const token=randomUUID(),prelude="import socket,subprocess,types\nsocket.gethostname=lambda:'apple-pickup-linux'\n"+(kind==='timeout'?"def execute(*a,**kw):raise subprocess.TimeoutExpired(a[0],1,output=b'{}')\nsubprocess.run=execute\n":"subprocess.run=lambda *a,**kw:types.SimpleNamespace(returncode=0,stdout=b'x'*2048)\n");
  const input=JSON.stringify({channel,session:token,seq:randomUUID(),argv:stock(),timeoutMs:100,maxBuffer:1024})+'\n';
  const r=spawnSync('python3',['-c',prelude+GUEST_STREAM_SOURCE,token],{input,encoding:'utf8',timeout:3000,maxBuffer:8192});assert.equal(r.status,0,r.stderr);const value=r.stdout.trim().split('\n').map(JSON.parse)[1];assert.equal(value.error,kind==='timeout'?'ETIMEDOUT':'GUEST_OUTPUT_LIMIT');assert.ok(!value.stdout||Buffer.byteLength(value.stdout)<=1024);
});
test('shutdown waits for a failed earlier owned session as well as the current stream',async()=>{
  const fake=fakeTransport(c=>{c.kill=()=>{c.killed++;return true;};setImmediate(()=>c.emit('error',Error('fixture')));}),client=new MultipassGuestStream({spawn:fake.spawn});
  await assert.rejects(client.run(stock()),/GUEST_TRANSPORT_CLOSED/);assert.equal(client.session,null);setImmediate(fake.children[0].finish);await client.close();assert.equal(fake.children[0].finished,true);assert.equal(client.children.size,0);
});
