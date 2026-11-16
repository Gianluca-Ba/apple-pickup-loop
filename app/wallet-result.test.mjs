import test from 'node:test';
import assert from 'node:assert/strict';
import {parseNativeWalletFailure,readNativeWalletFailure} from './wallet-result.mjs';

const pressedAt=Date.parse('2026-11-10T19:19:33+09:00'),openedAt=pressedAt+2000,now=pressedAt+60000,context={pressedAt,openedAt,now};
const common={subsystem:'com.apple.passkit',processImagePath:'/System/Library/com.apple.PassKit.PaymentAuthorizationUIExtension',processID:123};
const decline={...common,category:'PaymentAuth',senderImagePath:'/System/Library/PassKitCore',timestamp:'2026-11-10 19:19:46.261296+0900',eventMessage:'Failed to process transaction. Transaction declined.'};
const finish={...common,category:'PaymentUI',senderImagePath:'/System/Library/PassKitMacHelper',timestamp:'2026-11-10 19:19:48.659439+0900',eventMessage:'Failure UI completed.'};
test('native Wallet proof requires one decline and final failure from the same Apple UI process in this attempt',()=>{
 assert.deepEqual(parseNativeWalletFailure([decline,finish],context),{source:'native-wallet-completed-failure',failedAt:Date.parse('2026-11-10T19:19:48.659+09:00')});
 for(const records of [[],[decline],[finish],[decline,finish,finish],[decline,{...finish,processID:124}],[{...decline,senderImagePath:'/tmp/other'},finish],[decline,{...finish,processImagePath:'/tmp/other'}],[decline,{...finish,eventMessage:'Success UI completed.'}],[decline,finish,{...finish,eventMessage:'Success UI completed.'}],[{...decline,timestamp:'2026-11-10 19:19:20+0900'},finish],[decline,{...finish,timestamp:'2026-11-10 19:20:50+0900'}]])assert.equal(parseNativeWalletFailure(records,context),null);
 for(const patch of [{openedAt:undefined},{openedAt:pressedAt-1},{pressedAt:now-900001},{now:pressedAt-1}])assert.equal(parseNativeWalletFailure([decline,finish],{...context,...patch}),null);
});
function setTestTimeZone(t, timeZone) {
 const previousTimeZone = process.env.TZ;
 process.env.TZ = timeZone;
 t.after(() => {
  if (previousTimeZone === undefined) delete process.env.TZ;
  else process.env.TZ = previousTimeZone;
 });
}

test('the log reader returns only a filtered terminal proof and treats missing, malformed or unavailable logs as uncertain',async t=>{
 setTestTimeZone(t, 'Asia/Tokyo');
 const calls=[],run=async(...args)=>{calls.push(args);return{stdout:JSON.stringify([decline,finish])};};
 const value=await readNativeWalletFailure(context,{run});assert.equal(value.source,'native-wallet-completed-failure');assert.deepEqual(Object.keys(value).sort(),['failedAt','source']);assert.equal(calls[0][0],'/usr/bin/log');assert.ok(calls[0][2].timeout<=8000);
 for(const run of [async()=>{throw Error('private diagnostics');},async()=>({stdout:'not json'}),async()=>({stdout:'[]'})])assert.equal(await readNativeWalletFailure(context,{run}),null);
});

test('the log reader leaves the result uncertain outside its supported time zone', async t => {
 setTestTimeZone(t, 'UTC');
 let logReads = 0;
 const run = async () => {
  logReads++;
  return {stdout: JSON.stringify([decline, finish])};
 };
 assert.equal(await readNativeWalletFailure(context, {run}), null);
 assert.equal(logReads, 0);
});
