import {request} from 'node:http';
import {existsSync,readFileSync,writeFileSync,renameSync,appendFileSync} from 'node:fs';
import {safeBrowserFailureMetadata} from './browser-failure.mjs';
const safeStockDiagnostic = () => null;

export function containerRPC(socketPath,path,body={},timeout=65000) {
 return new Promise((resolve,reject)=>{
  const req=request({socketPath,path,method:'POST',timeout,headers:{'content-type':'application/json'}},res=>{
   let text='';res.on('data',b=>{text+=b;if(Buffer.byteLength(text)>1500000)req.destroy(Error('Container response too large'))});
   res.on('end',()=>{try{resolve(JSON.parse(text))}catch{reject(Error('Invalid container response'))}});
  });req.on('error',reject);req.on('timeout',()=>req.destroy(Error('Container timeout')));req.end(JSON.stringify(body));
 });
}

// Both processes share the native VM worker's ledger, VPN proof, 65-second
// schedule and request-id ledger. Containers never schedule their own samples.
export function createContainerBrowserPool(dependencies={}) {
 const rpc=dependencies.rpc??containerRPC;
 const sockets=dependencies.sockets??['/home/monitor/.iphone-container-ipc/a.sock','/home/monitor/.iphone-container-ipc/b.sock'];
 const pointerPath=dependencies.pointerPath;
 let next=pointerPath&&existsSync(pointerPath)?JSON.parse(readFileSync(pointerPath)).next:0;
 if(sockets.length===1&&next===1)next=0;
 if(![1,2].includes(sockets.length)||!Number.isInteger(next)||next<0||next>=sockets.length)throw Error('Invalid container pool');
 let closed=false,busy=false,refused=false,closing;
 let telemetry=dependencies.statusPath&&existsSync(dependencies.statusPath)?JSON.parse(readFileSync(dependencies.statusPath)):{containers:[{id:'1',state:'idle',checks:0,lastStatus:null},{id:'2',state:'idle',checks:0,lastStatus:null}]};
 const publish=()=>{telemetry.at=Date.now();telemetry.nextContainer=String(next+1);if(dependencies.statusPath){writeFileSync(dependencies.statusPath+'.tmp',JSON.stringify(telemetry),{mode:0o600});renameSync(dependencies.statusPath+'.tmp',dependencies.statusPath)}};
 const log=event=>{if(dependencies.logPath)appendFileSync(dependencies.logPath,JSON.stringify({at:Date.now(),...event})+'\n',{mode:0o600});dependencies.onEvent?.(event)};
 const remainingSockets=new Set(sockets);
 const close=()=>closing??=(async()=>{
  closed=true;
  await Promise.allSettled([...remainingSockets].map(async socket=>{
   if((await rpc(socket,'/close'))?.ok===true)remainingSockets.delete(socket);
  }));
  if(remainingSockets.size)throw Error('Container closure unverified');
  for(const c of telemetry.containers)if(c.state==='active')c.state='idle';
  publish();log({stage:'closed-both'});
 })().catch(error=>{closing=null;throw error;});
 // The worker must receive the refusal even if one browser failed to close.
 // Its explicit close still requires a positive acknowledgement from both.
 const closeAfterRefusal=()=>close().catch(()=>{});

 dependencies.signal?.addEventListener('abort',()=>{void close().catch(()=>{})},{once:true});
 return {
  async fetch(url,options={}) {
   if(closed||refused)throw Error('Container pool stopped');if(busy)throw Error('Container pool busy');
   if(!(url instanceof URL)||url.origin!=='https://www.apple.com'||url.pathname!=='/jp/shop/retail/pickup-message'||options.method!=='GET')throw Error('Unapproved container destination');
   options.signal?.throwIfAborted();busy=true;const index=next;telemetry.containers[index].state='active';publish();
   try{
    const result=await rpc(sockets[index],'/fetch',{url:url.href});
    for(const e of result.diagnostics??[]){const safe=safeStockDiagnostic(e);if(safe)dependencies.onDiagnostic?.(safe)}
    if(!result.ok){
     log({stage:'worker-error',container:index?'b':'a',category:['profile-lock','profile-marker','permissions','missing-library','missing-module','sandbox','tls','network','browser-startup'].includes(result.failureCategory)?result.failureCategory:'unknown'});
     const error=Error(result.httpStatus?'Container HTTP '+result.httpStatus:'Container request failed');
     for(const key of ['httpStatus','nextAllowedAt','workerCode','httpStage'])if(result[key]!=null)error[key]=result[key];
     error.failureCategory=['profile-lock','profile-marker','permissions','missing-library','missing-module','sandbox','tls','network','browser-startup'].includes(result.failureCategory)?result.failureCategory:'unknown';
     Object.assign(error,safeBrowserFailureMetadata(result));
     refused=Boolean(result.httpStatus||result.workerCode==='security-challenge');Object.assign(telemetry.containers[index],{state:'error',lastStatus:result.httpStatus??null,lastCheckedAt:Date.now(),checks:telemetry.containers[index].checks+1});publish();
     if(refused){log({stage:'refusal',container:index?'b':'a',status:result.httpStatus??null,securityChallenge:result.workerCode==='security-challenge'});await closeAfterRefusal()}
     throw error;
    }
    if(!Number.isInteger(result.status)||result.status<200||result.status>599||typeof result.body!=='string'||Buffer.byteLength(result.body)>1048576)throw Error('Invalid container stock response');
    const headers=Object.fromEntries(['content-type','age','retry-after','date','cache-control'].filter(k=>typeof result.headers?.[k]==='string').map(k=>[k,result.headers[k]]));
    Object.assign(telemetry.containers[index],{state:result.status>=400?'error':'idle',lastStatus:result.status,lastCheckedAt:Date.now(),checks:telemetry.containers[index].checks+1});publish();
    log({stage:'response',container:index?'b':'a',status:result.status});
    if(result.status>=400||headers['retry-after']){refused=true;log({stage:'shared-stop',container:index?'b':'a',status:result.status});await closeAfterRefusal()}
    else {next=index;publish()}
    return new Response(result.body||null,{status:result.status,headers});
   }catch(error){if(!refused){next=sockets.length===2?1-index:0;if(pointerPath){writeFileSync(pointerPath+'.tmp',JSON.stringify({next}),{mode:0o600});renameSync(pointerPath+'.tmp',pointerPath)}}if(telemetry.containers[index].state==='active'){telemetry.containers[index].state='error';publish()}throw error}finally{busy=false}
  },close,
 };
}
