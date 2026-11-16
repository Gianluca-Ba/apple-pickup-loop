import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { authenticateWindscribe } from './windscribe-auth.mjs';
const credential = '0x' + '1'.repeat(32);
function fixture(output, statusText, code=0) {
  let killed=0, starts=0;
  const launch=(_binary,args)=>{starts++;assert.deepEqual(args,['login',credential,credential]);const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.kill=()=>{killed++;queueMicrotask(()=>child.emit('close',null));};queueMicrotask(()=>{child.stdout.emit('data',output);child.emit('close',code);});return child;};
  return {launch,status:()=>({status:0,stdout:statusText,stderr:''}),counts:()=>({starts,killed})};
}
test('Windscribe authentication emits only safe results even if the vendor echoes the credential',async()=>{
  const f=fixture('Logged in as '+credential,'Disconnected · Unlimited');const result=await authenticateWindscribe(credential,f);
  assert.deepEqual(result,{result:'authenticated',proReported:true});assert.ok(!JSON.stringify(result).includes(credential));assert.deepEqual(f.counts(),{starts:1,killed:0});
});
test('Windscribe human challenge stops the client without resubmitting credentials or solving it',async()=>{
  const f=fixture('Please type the numbers above: CAPTCHA','Logged out');assert.equal((await authenticateWindscribe(credential,f)).result,'human-challenge-required');assert.deepEqual(f.counts(),{starts:1,killed:1});
});
test('Windscribe vendor exit zero cannot turn a rejected login into verified authentication',async()=>{
  const f=fixture('Incorrect username/password','Logged out',0);assert.equal((await authenticateWindscribe(credential,f)).result,'credentials-not-accepted');assert.deepEqual(f.counts(),{starts:1,killed:0});
});
