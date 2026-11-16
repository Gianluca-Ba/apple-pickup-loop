import { execFile as callback } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { guestExecArguments, runGuestStream, validateGuestArgv } from './guest-stream.mjs';
const execFile = promisify(callback);
export const quoteGuestArgument = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
// The one-shot fallback uses the same restricted commands as the stream.
export const guestClientArguments = argv => guestExecArguments([
  '/bin/sh', '-c', argv.map(quoteGuestArgument).join(' '),
]);

export function parseGuestReply(stdout, {id, channel, required = true}) {
  const value = JSON.parse(stdout);
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.ok !== 'boolean') throw Error('GUEST_REPLY_INVALID');
  if ((required || Object.hasOwn(value, 'requestId') || Object.hasOwn(value, 'channel')) && (value.requestId !== id || value.channel !== channel)) throw Error('GUEST_REPLY_CONTEXT_MISMATCH');
  return value;
}
export async function readGuestCommand(run, bin, args, options, context, { stream = runGuestStream } = {}) {
  let response;
  const persistent = context.usePersistent === true && process.env.APPLE_LOOP_GUEST_TRANSPORT !== 'exec';
  if (context.usePersistent === true) {
    const expectedArgs = guestClientArguments(validateGuestArgv(context.guestArgv));
    if (bin !== 'multipass' || args.length !== expectedArgs.length ||
        args.some((argument, index) => argument !== expectedArgs[index])) throw Error('GUEST_TRANSPORT_SCOPE');
  }
  try { if(!persistent)context.beforeDispatch?.();response = await (persistent ? stream(context.guestArgv, {...options,beforeDispatch:context.beforeDispatch}) : run(bin, args, options)); }
  catch (error) {
    // A nonzero guest exit can still contain the definitive result. Its
    // operation receipt must match before that result is used.
    if (typeof error.stdout !== 'string' || !error.stdout.trim()) throw error;
    return parseGuestReply(error.stdout, context);
  }
  return parseGuestReply(response.stdout, context);
}
// Serialize short guest commands and pace stock launches independently of result reads.
const linuxGuestCommands = [];
let linuxGuestCommandRunning = false, lastLinuxSampleStart = -Infinity, linuxGuestWake, lastLinuxSampleReservation;
function drainLinuxGuestCommands() {
  clearTimeout(linuxGuestWake);
  if (linuxGuestCommandRunning || !linuxGuestCommands.length) return;
  const now = Date.now();
  const sample = linuxGuestCommands.findIndex(job => job.sampleSpacing);
  const wait = sample < 0 ? Infinity : lastLinuxSampleStart + linuxGuestCommands[sample].sampleSpacing() - now;
  // Use the interval before the next stock start for control work. UI
  // telemetry always yields to both when they're queued.
  let index = wait <= 0 ? sample : linuxGuestCommands.findIndex(job => !job.sampleSpacing && !job.telemetry);
  if (index < 0) index = linuxGuestCommands.findIndex(job => job.telemetry);
  if (index < 0) {
    linuxGuestWake = setTimeout(drainLinuxGuestCommands, wait);
    return;
  }
  const [{run, resolve, reject, sampleSpacing, sampleContext}] = linuxGuestCommands.splice(index, 1);
  linuxGuestCommandRunning = true;
  if (sampleSpacing) {
    const reservation={id:sampleContext?.id,previousStart:lastLinuxSampleStart,startedAt:now};
    lastLinuxSampleStart=now;lastLinuxSampleReservation=reservation;
    try{sampleContext?.onStart?.(reservation);}catch{}
  }
  void Promise.resolve().then(run).then(resolve, reject).finally(() => {
    linuxGuestCommandRunning = false;
    drainLinuxGuestCommands();
  });
}
export function runLinuxGuestCommand(run, sampleSpacing, telemetry = false, sampleContext) {
  return new Promise((resolve, reject) => {
    linuxGuestCommands.push({run, resolve, reject, sampleSpacing, telemetry, sampleContext});
    drainLinuxGuestCommands();
  });
}

// Starting a replacement stream can take time. Anchor the next dispatch to
// the actual write, retaining the original reservation for receipt recovery.
export function refreshLinuxSampleStart(reservation, at = Date.now()) {
  if (!reservation || lastLinuxSampleReservation !== reservation || !Number.isFinite(at) || at < reservation.startedAt) return false;
  lastLinuxSampleStart = at; reservation.startedAt = at; return true;
}

// Only the latest reservation may be returned, and only after this guest
// explicitly proves that this unacknowledged ID was never accepted.
export function reclaimUnacceptedLinuxSample(reservation, receipt, requestId, accepted) {
  if(accepted!==false||!reservation||lastLinuxSampleReservation!==reservation||
     !/^[a-f0-9-]{36}$/.test(requestId??'')||reservation.id!==requestId||
     receipt?.requestId!==requestId||receipt?.channel!=='stock-worker-v1'||
     receipt?.ok!==false||receipt?.code!=='operation-missing')return false;
  lastLinuxSampleStart=reservation.previousStart;lastLinuxSampleReservation=null;
  drainLinuxGuestCommands();return true;
}
// A host fallback shares the actual stock-start cadence without holding the
// guest command lane while its independent HTTP operation is running.
export function runPacedHostSample(run, spacing) {
  return new Promise((resolve,reject)=>{
    void runLinuxGuestCommand(()=>{void Promise.resolve().then(run).then(resolve,reject);},spacing).catch(reject);
  });
}


export function createLinuxVpnControl({execFile: run=execFile, sleep=delay, canChange=()=>false,getGeneration=()=>0,workerCount=()=>19,requireReceipt=run===execFile}={}) {
  return async (operation,worker) => {
    if (process.env.CHECKOUT_DISABLE_NATIVE === '1' && run === execFile) throw Error('NATIVE_DISABLED');
    if (!['inventory','connect','disconnect','rotate'].includes(operation) ||
        (operation==='inventory' ? worker!==undefined : !Number.isInteger(worker)||worker<1||worker>workerCount()||operation==='rotate'&&worker===1)) {
      throw Error('Operazione tunnel non valida.');
    }
    const generation=getGeneration(),requestId=randomUUID();
    const invoke=(command,args=[])=>runLinuxGuestCommand(()=>{
      const beforeDispatch=()=>{if(command==='start'&&operation!=='inventory'&&(!canChange(operation, worker)||getGeneration()!==generation))throw Error('Cambio tunnel sospeso.');};beforeDispatch();
      const guestArgs=['/usr/bin/python3','/opt/iphone-stock-pool/linux-vpn-control.py',command,requestId,...args];
      return readGuestCommand(run,'multipass',guestClientArguments(guestArgs),
                 {timeout:5000,maxBuffer:8192},{id:requestId,channel:'vpn-control-v1',required:requireReceipt,guestArgv:guestArgs,usePersistent:run===execFile,beforeDispatch});
    });
    let launches=0,accepted=false;
    const launch=async()=>{
      launches++;
      try { const reply=await invoke('start',[operation,...(worker===undefined?[]:[String(worker)])]);if(reply?.ok===true)accepted=true; } catch {}
    };
    await launch();
    const deadline=Date.now()+90000;
    for (;;) {
      let value;
      try { value=await invoke('result'); } catch {}
      if(value?.ok===true)accepted=true;
      // A lost journal after acknowledgement does not prove the operation
      // never ran. Leave reconciliation to the coordinator's inventory read.
      if(value?.code==='operation-missing'&&accepted)throw Error('Esito operazione tunnel non confermato.');
      // Retry the same id only when the guest confirms it never accepted the request.
      if(value?.code==='operation-missing'&&launches<3){
        await sleep(500);
        await launch();
        continue;
      }
      if(value?.ok===false)throw Object.assign(Error('Operazione tunnel da verificare.'),{code:/^[A-Z_]{1,50}$/.test(value.code??'')?value.code:'CONTROL_FAILED'});
      if(value?.ok===true&&value.pending!==true){
        if(!Object.hasOwn(value,'result'))throw Error('Risposta operazione tunnel non valida.');
        return value.result;
      }
      if(Date.now()>=deadline)throw Error('Esito operazione tunnel non confermato.');
      await sleep(500);
    }
  };
}
