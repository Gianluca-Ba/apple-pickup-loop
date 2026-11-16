import {createServer} from 'node:http';
import {unlinkSync,chmodSync} from 'node:fs';
import {createChromiumStockSession} from './chromium-session.mjs';

import {safeBrowserFailureCode} from './browser-failure.mjs';
const id=process.env.STOCK_CONTAINER_ID;
if(!['a','b'].includes(id))throw Error('Invalid container identity');
const socket='/ipc/'+id+'.sock';let browser,opening,openingController,busy=false;
const diagnostics=[];
function emit(event) {
 if (!['browser-starting','browser-ready','warmup-response','stock-response'].includes(event?.stage)) return;
 const diagnostic = {stage: event.stage};
 if (Number.isInteger(event.status) && event.status >= 100 && event.status <= 599) diagnostic.status = event.status;
 if (Number.isSafeInteger(event.retryAfterAt)) diagnostic.retryAfterAt = event.retryAfterAt;
 diagnostics.push(diagnostic);
 if (diagnostics.length > 30) diagnostics.shift();
}
const close=async()=>{openingController?.abort();try{await opening}catch{}const previous=browser;await previous?.close();if(browser===previous)browser=null};
try{unlinkSync(socket)}catch(e){if(e.code!=='ENOENT')throw e}
const server=createServer(async(req,res)=>{
 const send=value=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(value))};
 if(req.method!=='POST')return send({ok:false});
 if(req.url==='/close'){try{await close();send({ok:true})}catch{send({ok:false})}return}
 if(req.url==='/status')return send({ok:true,id,browserReady:Boolean(browser),busy,idleState:browser?.idleState?.()??null});
 if(req.url!=='/fetch'||busy)return send({ok:false});busy=true;diagnostics.length=0;
 let browserStage='request-validation';
 try{
  let text='';for await(const b of req){text+=b;if(Buffer.byteLength(text)>4096)throw Error('Request too large')}
  const data=JSON.parse(text),url=new URL(data.url);
  if(url.origin!=='https://www.apple.com'||url.pathname!=='/jp/shop/retail/pickup-message'||url.username||url.password)throw Error('Unapproved destination');
  if(!browser){
   browserStage='browser-open';const controller=new AbortController();openingController=controller;
   opening=createChromiumStockSession({browserChannel:'chromium',browserMode:'headed',profileMode:'persistent-guest',guestProfileDirectory:'/profile',onDiagnostic:emit,signal:controller.signal});
   try{browser=await opening}finally{opening=null;if(openingController===controller)openingController=null}
  }
  browserStage='stock-request';const response=await browser.fetch(url,{method:'GET'});browserStage='response-body';const body=await response.text();
  send({ok:true,status:response.status,headers:Object.fromEntries(['content-type','age','retry-after','date','cache-control'].filter(k=>response.headers.has(k)).map(k=>[k,response.headers.get(k)])),body,diagnostics});
 }catch(e){
  const category=[['profile-lock',/SingletonLock|profile.*(?:in use|locked)|process singleton/i],['profile-marker',/profile.*(?:owned|ownership|marker)/i],['permissions',/permission denied|EACCES|EROFS/i],['missing-library',/shared libraries|cannot open shared object/i],['missing-module',/Cannot find module|ERR_MODULE_NOT_FOUND/i],['sandbox',/sandbox|namespace|chroot/i],['tls',/certificate|SSL|TLS/i],['network',/timeout|net::|fetch failed/i]].find(([,pattern])=>pattern.test(e.message))?.[0]??'browser-startup';
  send({ok:false,httpStatus:Number.isInteger(e.httpStatus)?e.httpStatus:undefined,nextAllowedAt:Number.isSafeInteger(e.nextAllowedAt)?e.nextAllowedAt:undefined,workerCode:e.workerCode==='security-challenge'||/security challenge/i.test(e.message)?'security-challenge':!e.httpStatus?'worker-transport':undefined,failureCategory:category,failureCode:safeBrowserFailureCode(e),browserStage,httpStage:['warmup-response','stock-response'].includes(e.httpStage)?e.httpStage:undefined,diagnostics})}
 finally{busy=false}
});
server.requestTimeout=5000;server.listen(socket,()=>chmodSync(socket,0o600));
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,async()=>{await close();server.close()});
