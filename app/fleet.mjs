import { execFile as callback } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { createLinuxVpnControl, runLinuxGuestCommand, guestClientArguments, readGuestCommand, reclaimUnacceptedLinuxSample, refreshLinuxSampleStart, runPacedHostSample } from './linux-control.mjs';
import { createLinuxVpnPool } from './vpn-pool.mjs';
import { INTERVAL, jst } from './shared.mjs';
import { PickupWorker, safeWorkerContext } from './worker.mjs';
import { fileURLToPath } from 'node:url';
import { guestStreamSnapshot } from './guest-stream.mjs';
const execFile = promisify(callback), delay = ms => new Promise(r => setTimeout(r, ms));
export function createLinuxAdapter(worker, { run = execFile, sleep = delay, spacing = () => 10834, pollInterval = () => 500, requireReceipt = run === execFile, onMetric = () => {}, onPaceReclaim = () => {} } = {}) {
  const call = async (operation, data = {}) => {
    if (process.env.CHECKOUT_DISABLE_NATIVE === '1' && run === execFile) throw Error('NATIVE_DISABLED');
    const id = randomUUID();
    let accepted=false,lastLaunchReservation;
    const invoke = async (path, body, sample = false) => {
      const encoded = Buffer.from(JSON.stringify(body)).toString('base64');
      const command = ['/opt/iphone-stock/app/worker-server.mjs', '--client', path, encoded];
      const args = worker === 1 ? ['/usr/sbin/runuser', '-u', 'monitor', '--', '/usr/local/bin/node', ...command] : ['/usr/bin/docker', 'exec', 'iphone-linux-vpn-' + worker, '/opt/node22/bin/node', ...command];
      const queuedAt=Date.now();
      return runLinuxGuestCommand(async()=>{
        const startedAt=Date.now();let outcome='unreadable',transportCode=null;
        try {
          const reply=await readGuestCommand(run, 'multipass', guestClientArguments(args), { timeout: 5000, maxBuffer: 32768 },{id,channel:'stock-worker-v1',required:requireReceipt,guestArgv:args,usePersistent:run===execFile,beforeDispatch:sample?()=>refreshLinuxSampleStart(lastLaunchReservation):undefined});
          outcome=reply.ok===true?(reply.pending===true?'pending':'complete'):reply.code==='operation-missing'?'missing':'failed';
          return reply;
        } catch(error) {
          transportCode=['GUEST_REPLY_INVALID','GUEST_REPLY_CONTEXT_MISMATCH'].includes(error?.message)?error.message:error instanceof SyntaxError?'GUEST_REPLY_JSON':['ETIMEDOUT','ENOENT','EACCES'].includes(error?.code)?error.code:'TRANSPORT';
          throw error;
        } finally {try{onMetric({operation,command:path==='/start'?'start':'result',paced:sample,queueMs:Math.max(0,startedAt-queuedAt),executionMs:Math.max(0,Date.now()-startedAt),outcome,transportCode});}catch{}}
      }, sample ? spacing : undefined,false,sample?{id,onStart:reservation=>{lastLaunchReservation=reservation;}}:undefined);
    };
    const launch = async () => {const value=await invoke('/start', { id, operation, data }, operation === 'sample');if(value?.ok===true)accepted=true;return value;};
    let result; try { result = await launch(); } catch {}
    // An unreadable launch needs reconciliation, not a stock-completion wait.
    // Do this once per launch; uncertain result reads retain ordinary backoff.
    let reconcileNow=operation==='sample'&&!result;
    let launches = 1; const end = Date.now() + 100000;
    while (!result || result.pending) {
      const requested=operation==='sample'?Number(pollInterval()):500;
      if(reconcileNow)reconcileNow=false;else await sleep(Number.isFinite(requested)?Math.max(200,Math.min(2000,requested)):500);
      try { result = await invoke('/result', { id }); } catch { result = null; }
      if(result?.ok===true)accepted=true;
      // Acknowledged jobs can disappear after a guest restart. A missing
      // result is no longer proof that this ID was never accepted.
      if(result?.code==='operation-missing'&&accepted)throw Object.assign(Error('WORKER_UNCERTAIN'),{code:'sample-uncertain',nextAllowedAt:Date.now()+INTERVAL});
      if(operation==='sample'&&result?.code==='operation-missing'&&reclaimUnacceptedLinuxSample(lastLaunchReservation,result,id,accepted)){try{onPaceReclaim();}catch{}}
      if (result?.code === 'operation-missing' && launches < 3) { launches++; try { result = await launch(); } catch { result = null; } reconcileNow=operation==='sample'&&!result; }
      if (Date.now() > end) throw Object.assign(Error('WORKER_UNCERTAIN'), { code: 'sample-uncertain', nextAllowedAt: Date.now() + INTERVAL });
    }
    if (result.ok !== true) throw Object.assign(Error('WORKER_FAILED'), { code: result.code, httpStatus: result.httpStatus, nextAllowedAt: Date.now() + Math.max(0, result.nextAllowedInMs ?? 0),...safeWorkerContext(result) });
    return result.result;
  };
  // The Linux worker always proves its protected route and matches this
  // fingerprint before browser startup or a stock GET. This is not a cached read.
  return { verifiesExpectedRouteBeforeSample:true, network: () => call('network'), sample: (selection, fingerprint) => call('sample', { selection, fingerprint }), close: () => call('close') };
}
export function createMacAdapter({ ledgerPath = fileURLToPath(new URL('../fleet-mac-ledger.json', import.meta.url)), spacing = () => 6500 } = {}) {
  const worker = new PickupWorker({ ledgerPath, network: async () => {
    if (process.env.APPLE_LOOP_ALLOW_MAC_FALLBACK !== '1') throw Error('HOST_FALLBACK_DISABLED');
    const { stdout } = await execFile('/usr/bin/curl', ['-fsS', '--max-time', '10', 'https://api4.ipify.org?format=json'], { timeout: 12000, maxBuffer: 1024 });
    const { ip } = JSON.parse(stdout); if (isIP(ip) !== 4) throw Error('NETWORK'); return { vpn: 'host', fingerprint: createHash('sha256').update(ip).digest('hex') };
  }, browserFactory: async () => { const { createChromiumStockSession } = await import('./chromium-session.mjs'); return createChromiumStockSession({ browserChannel: 'chrome', browserMode: 'headed', profileMode: 'persistent-guest' }); } });
  const sample=worker.sample.bind(worker);worker.sample=(...args)=>runPacedHostSample(()=>sample(...args),spacing);
  return worker;
}
export class LinuxFleet {
  constructor({ onChange = () => {}, onSignal = () => {}, onBlocked = () => {}, canChange = () => false, now = Date.now, adapters, control, positions = 6, vpnLimit = 8, workerCount = 19, standbyTarget = 0, nordLimit = 10 } = {}) {
    if (!Number.isInteger(workerCount)||workerCount<1||workerCount>30||!Number.isInteger(positions)||positions<1||positions>20||!Number.isInteger(vpnLimit)||vpnLimit<positions||vpnLimit>workerCount||!Number.isInteger(standbyTarget)||standbyTarget<0||standbyTarget>vpnLimit-positions) throw Error('FLEET_CAPACITY_INVALID');
    this.workerCount=workerCount;this.nordLimit=nordLimit;this.standbyTarget=standbyTarget;this.warmStandby=standbyTarget>0||nordLimit<10;this.roster=[];this.reserveSequence=0;
    this.now = now; this.onChange = onChange; this.onSignal = onSignal; this.onBlocked = onBlocked; this.canChange = canChange; this.positions = positions; this.vpnLimit = vpnLimit;
    this.nodes = Array.from({ length: this.workerCount }, (_, i) => ({ id: 'pilot' + (i + 1), name: 'Linux ' + (i + 1), pilotWorker: i + 1, phase: 'unverified', checks: 0, workerSuccesses: 0, nextAllowedAt: 0, connected: null, verified: false }));
    this.nodes.push({ id: 'mac', name: 'Questo Mac', phase: 'reserve', checks: 0, workerSuccesses: 0, nextAllowedAt: 0, verified: false });
    this.guestMetrics=[];this.guestCalls=0;this.guestReplyCounts={pending:0,complete:0,missing:0,failed:0,unreadable:0};this.guestTransportCounts={};this.sampleStartCalls=0;this.sampleStartAccepted=0;this.missingSampleResults=0;
    this.adapters = adapters ?? [...this.nodes.slice(0, this.workerCount).map((_, i) => createLinuxAdapter(i + 1, { spacing: () => this.dispatchInterval(),pollInterval:()=>Math.max(200,(this.jobs?.size??1)*100),onMetric:value=>this.recordGuestMetric(value),onPaceReclaim:()=>{this.recoveryCounts.unacceptedPaceReclaims++;} })), createMacAdapter({spacing:()=>this.macDispatchInterval()})];
    this.generation = 0; this.inspection = null; this.refreshProofsBeforeStart = false;
    this.recoveryCounts={retired:0,rotated:0,connectFailures:0,staleProofsReleased:0,initialProofRefreshes:0,handoffProofRefreshes:0,readyReserveDispatches:0,workerPreflightOnlyReserveStarts:0,unacceptedPaceReclaims:0,sharedRouteFences:0,sharedRouteRecoveries:0,sharedRouteProofRefreshes:0};
    this.outcomes={started:0,valid:0,http541:0,http429:0,httpOther:0,challenge:0,nodeWait:0,stockValidation:0,transport:0};this.faultSequence=0;this.faults=[];this.proofFailureSequence=0;this.proofFailures=[];
    this.control = control ?? createLinuxVpnControl({ workerCount: () => this.workerCount, getGeneration: () => this.generation, canChange: (_operation, worker) => this.enabled && !this.paused && this.canChange() && (worker === 1 || !this.nativeProofFence) });
    this.pool = this.makePool();
    this.proofs = new Map(); this.jobs = new Map(); this.retirements = new Set(); this.recentStarts = []; this.recentResponses = []; this.responseDurations = []; this.active = []; this.enabled = false; this.paused = false; this.lastStart = -Infinity; this.maintenance = null; this.nextMaintenance = 0; this.block = null;
  }
  makePool() {
    return createLinuxVpnPool({ agents: this.nodes, adapters: this.adapters, control: async (op, worker) => {
      const value = await this.control(op, worker);
      if (op === 'inventory') for (let i = 0; i < this.workerCount; i++) {
        const entry = value?.[i + 1], node = this.nodes[i];
        node.provider=entry?.provider??'nordvpn';node.rotationCoversPause=entry?.rotationCoversPause===true;
        if(entry?.pauseHttpStatus===541)node.pauseHttpStatus=541;
        node.connecting = entry?.connecting === true;
        node.connectionError = entry?.connectionError === true;
        node.connectingSince = node.connecting ? node.connectingSince ?? this.now() : null;
        node.connected = entry?.connected === true && entry.pinned === true ? true : entry?.connected === false ? false : null;
        if (node.connected !== true) node.verified = false;
        if(node.connected===false&&this.proofs?.has(i)){this.proofs.delete(i);this.recoveryCounts.staleProofsReleased++;}
        if (i>0 && entry?.assignmentUnavailable && node.connected === false && !node.rotationPending) { node.rotationPending=true;node.reserveSequence=++this.reserveSequence;node.phase='recovering';this.retirements.add(i);this.roster=this.roster.filter(j=>j!==i); }
      }
      return value;
    }, onProofFailure:(i,error,stage)=>this.recordProofFailure(i,error,stage), canChange: () => this.enabled && !this.paused && this.canChangeContainer(), canPromote: () => this.nodes[0].connected === true && this.nodes[0].verified, now:this.now, vpnLimit:this.vpnLimit,nordLimit:this.nordLimit, isStandby:i=>this.warmStandby&&this.nodes[i].phase==='standby'&&!this.jobs.has(i)&&!this.roster.includes(i), onRetired:i=>{
      if(!this.warmStandby||i===0||i>=this.workerCount)return;
      const n=this.nodes[i];this.recoveryCounts.retired++;n.rotationPending=true;n.reserveSequence=++this.reserveSequence;n.phase='recovering';
      this.roster=this.roster.filter(j=>j!==i);
    } });
  }
  canChangeContainer() { return !this.nativeProofFence && this.canChange(); }
  noteNetworkProofFailure(i, error, generation) {
    if (!this.warmStandby || i <= 0 || i >= this.workerCount || !this.enabled || this.paused || generation !== this.generation || error.httpStatus || error.code !== 'transport' || error.workerStage !== 'network-proof') return false;
    const at = this.now(), prior = this.lastNetworkProofFailure, native = this.nodes[0];
    this.lastNetworkProofFailure = { i, at, generation };
    // Independent, explicit preflight failures can share the native route.
    // Recheck that route before retiring more containers or sending stock.
    if (!this.nativeProofFence && native.connected === true && native.verified && prior?.generation === generation && prior.i !== i && at >= prior.at && at - prior.at <= 15000) {
      this.nativeProofFence = true;
      native.verified = false; native.phase = 'recovering'; native.nextProofAt = 0;
      this.nextMaintenance = 0; this.recoveryCounts.sharedRouteFences++;
    }
    return this.nativeProofFence === true;
  }
  snapshot() {
    const at = this.now(), recent = rows => rows.filter(t => t > at - 60000 && t <= at).length;
    return { diagnostics: { counters:{...this.outcomes},recovery:{...this.recoveryCounts},lastSequence:this.faultSequence,faults:this.faults.map(e=>({...e})),proofFailures:this.proofFailures.map(e=>({...e})),guestRPC:this.guestTimingSnapshot() }, throughput: { validLastMinute: recent(this.recentResponses), startsLastMinute: recent(this.recentStarts), dispatchIntervalMs: this.dispatchInterval(), samplingNodes: this.samplingCapacity(), theoreticalPerMinute: this.samplingCapacity() * 60000 / INTERVAL, averageResponseMs: this.responseDurations.length ? Math.round(this.responseDurations.reduce((a,b) => a+b, 0) / this.responseDurations.length) : null, maxConcurrent: this.positions }, enabled: this.enabled, paused: this.paused, workerCount:this.workerCount,nordLimit:this.nordLimit,providers:{nordvpn:this.nodes.filter(n=>n.connected===true&&(n.provider??'nordvpn')==='nordvpn').length,windscribe:this.nodes.filter(n=>n.connected===true&&n.provider==='windscribe').length}, standbyReady:this.nodes.filter((n,i)=>i<this.workerCount&&n.phase==='standby'&&n.connected===true&&n.verified&&!this.roster.includes(i)&&!this.active.includes(i)&&!this.jobs.has(i)&&n.nextAllowedAt<=at).length, positions: this.positions, vpnLimit: this.vpnLimit, connected: this.nodes.slice(0, this.workerCount).filter(n => n.connected === true).length, verifiedTunnels: this.nodes.slice(0, this.workerCount).filter(n => n.connected === true && n.verified).length, uncertainTunnels: this.nodes.slice(0, this.workerCount).filter(n => n.connected === null).length, assigned: this.active.length, inFlight: this.jobs.size, recovering: Boolean(this.maintenance || this.inspection), block: this.block, nodes: this.nodes.map(({ id, name, phase, checks, workerSuccesses, nextAllowedAt, nextVpnAllowedAt, connected, verified, pauseHttpStatus, provider }) => ({ id, name, phase,provider:provider??(id==='mac'?'host':'nordvpn'), checks, workerSuccesses, nextAllowedAt, nextVpnAllowedAt: nextVpnAllowedAt ?? 0, connected, verified, pauseHttpStatus: nextAllowedAt > at ? pauseHttpStatus ?? null : null })) };
  }
  recordGuestMetric(value) {
    if(!['network','sample','close'].includes(value?.operation)||!['start','result'].includes(value?.command)||typeof value.paced!=='boolean'||![value.queueMs,value.executionMs].every(v=>Number.isFinite(v)&&v>=0&&v<=300000))return;
    if(!Object.hasOwn(this.guestReplyCounts,value.outcome)||value.transportCode!==null&&!['GUEST_REPLY_INVALID','GUEST_REPLY_CONTEXT_MISMATCH','GUEST_REPLY_JSON','ETIMEDOUT','ENOENT','EACCES','TRANSPORT'].includes(value.transportCode))return;
    this.guestCalls++;this.guestReplyCounts[value.outcome]++;
    if(value.transportCode)this.guestTransportCounts[value.transportCode]=(this.guestTransportCounts[value.transportCode]??0)+1;
    if(value.operation==='sample'&&value.command==='start'){this.sampleStartCalls++;if(['pending','complete'].includes(value.outcome))this.sampleStartAccepted++;}
    if(value.operation==='sample'&&value.command==='result'&&value.outcome==='missing')this.missingSampleResults++;
    this.guestMetrics.push({operation:value.operation,command:value.command,paced:value.paced,queueMs:value.queueMs,executionMs:value.executionMs,outcome:value.outcome,transportCode:value.transportCode});this.guestMetrics=this.guestMetrics.slice(-200);
  }
  guestTimingSnapshot() {
    const rows=this.guestMetrics,results=rows.filter(r=>r.command==='result'),paced=rows.filter(r=>r.paced),mean=(list,key)=>list.length?Math.round(list.reduce((sum,r)=>sum+r[key],0)/list.length):null;
    const transport=guestStreamSnapshot();return{calls:this.guestCalls,recentCalls:rows.length,replyCounts:{...this.guestReplyCounts},transportCounts:{...this.guestTransportCounts},sampleStartCalls:this.sampleStartCalls,sampleStartAccepted:this.sampleStartAccepted,missingSampleResults:this.missingSampleResults,meanResultQueueMs:mean(results,'queueMs'),meanPacedStartQueueMs:mean(paced,'queueMs'),meanExecutionMs:mean(rows,'executionMs'),maxQueueMs:rows.length?Math.round(Math.max(...rows.map(r=>r.queueMs))):null,...(transport?{transport}:{})};
  }
  async inspect() {
    if (this.inspection) return this.inspection;
    if (this.enabled || this.maintenance || this.jobs.size) return;
    const generation=this.generation,current=()=>!this.enabled&&this.generation===generation&&!this.maintenance&&!this.jobs.size;
    const inspection = (async () => {
      await this.pool.refresh();
      for (let i=0;i<this.workerCount&&current();i++) if(this.nodes[i].connected===true){
        try {let proof;try{proof=await this.adapters[i].network();}catch(error){this.recordProofFailure(i,error,'inspection');throw error;}if(!current())return;await this.prove(i,proof);}
        catch {if(!current())return;this.nodes[i].verified=false;this.nodes[i].phase='recovering';}
        this.onChange();
      }
      if (current()) this.refreshProofsBeforeStart = false;
    })();
    this.inspection = inspection;
    try { await inspection; } finally { if (this.inspection === inspection) this.inspection = null; }
  }
  async start(selection) { if (this.enabled) return; const generation=this.generation;if(this.refreshProofsBeforeStart||this.inspection)await this.inspect();if(this.generation!==generation||this.enabled)return;this.selections = structuredClone(Array.isArray(selection) ? selection : [selection]); this.selection = this.selections[0]; this.selectionCursor ??= 0; this.generation++; this.enabled = true; this.paused = false; this.block = null; this.nextMaintenance = 0; this.timer = setInterval(() => this.tick(), 125); this.tick(); }
  configure({workerCount=this.workerCount,positions=this.positions,vpnLimit=this.vpnLimit,standbyTarget=this.standbyTarget,nordLimit=this.nordLimit}={}) {
    if(this.enabled||this.jobs.size||this.maintenance||this.inspection)throw Error('FLEET_CAPACITY_BUSY');
    if(!Number.isInteger(workerCount)||workerCount<this.workerCount||workerCount>30||!Number.isInteger(positions)||positions<1||positions>20||!Number.isInteger(vpnLimit)||vpnLimit<positions||vpnLimit>workerCount||!Number.isInteger(standbyTarget)||standbyTarget<0||standbyTarget>vpnLimit-positions)throw Error('FLEET_CAPACITY_INVALID');
    if(!Number.isInteger(nordLimit)||nordLimit<0||nordLimit>10)throw Error('FLEET_CAPACITY_INVALID');
    const old=this.workerCount,mac=this.nodes.pop(),adapter=this.adapters.pop(),macProof=this.proofs.get(old);this.proofs.delete(old);
    for(let i=old;i<workerCount;i++){this.nodes.push({id:'pilot'+(i+1),name:'Linux '+(i+1),pilotWorker:i+1,phase:'unverified',checks:0,workerSuccesses:0,nextAllowedAt:0,connected:null,verified:false});this.adapters.push(createLinuxAdapter(i+1,{spacing:()=>this.dispatchInterval(),pollInterval:()=>Math.max(200,(this.jobs?.size??1)*100),onMetric:value=>this.recordGuestMetric(value),onPaceReclaim:()=>{this.recoveryCounts.unacceptedPaceReclaims++;}}));}
    this.nodes.push(mac);this.adapters.push(adapter);if(macProof)this.proofs.set(workerCount,macProof);
    this.workerCount=workerCount;this.nordLimit=nordLimit;this.positions=positions;this.vpnLimit=vpnLimit;this.standbyTarget=standbyTarget;this.warmStandby=standbyTarget>0||nordLimit<10;this.roster=[];this.active=[];this.pool=this.makePool();
    for(const [i,p] of this.proofs)if(i<workerCount&&this.nodes[i].verified)this.pool.record(i,p);
  }
  connectionEligible(i,at=this.now()) {return this.warmStandby?i<this.workerCount&&!this.nodes[i].rotationPending&&(this.nodes[i].nextVpnAllowedAt??0)<=at&&!this.retirements.has(i)&&!this.jobs.has(i)&&!['blocked','retiring'].includes(this.nodes[i].phase):this.eligible(i,at);}
  promoteReadyReserve() {
    const at=this.now();
    if(!this.warmStandby||!this.enabled||this.paused||!this.canChangeContainer()||this.maintenance||this.inspection||this.retirements.size||this.nodes.slice(0,this.workerCount).some(n=>n.connected===null)||at-this.lastStart<this.dispatchInterval())return false;
    const vacancy=this.roster.length<this.positions;
    if(vacancy){
      const native=this.nodes[0];
      const closing=[...this.jobs.keys()].some(i=>!this.roster.includes(i))||this.nodes.slice(1,this.workerCount).some(n=>n.connected===true&&(n.rotationPending||!n.verified||['retiring','recovering'].includes(n.phase)));
      if(native.connected!==true||!native.verified||closing)return false;
      const reconciledPause=this.nodes.slice(0,this.workerCount).some((node,index)=>
        node.pauseHttpStatus===541 && node.nextAllowedAt>at &&
        (index===0 || node.phase==='cooldown' &&
          (node.connected===false || node.connected===true && node.verified && node.rotationCoversPause===true)));
      if(!reconciledPause)return false;
    }
    else if(this.roster.length!==this.positions||this.roster.some(i=>!this.jobs.has(i)&&this.nodes[i].nextAllowedAt<=at))return false;
    const reserves=this.verifiedLinux().filter(i=>!this.roster.includes(i)&&this.nodes[i].phase==='standby'&&!this.nodes[i].rotationPending&&!this.jobs.has(i)&&this.nodes[i].nextAllowedAt<=at&&(this.nodes[i].nextVpnAllowedAt??0)<=at).sort((a,b)=>(this.nodes[a].reserveSequence??0)-(this.nodes[b].reserveSequence??0)||this.nodes[a].checks-this.nodes[b].checks||this.nodes[a].workerSuccesses-this.nodes[b].workerSuccesses);
    const resting=this.roster.filter(i=>!this.jobs.has(i)&&this.nodes[i].connected===true&&this.nodes[i].verified&&this.nodes[i].phase==='cooldown'&&!this.nodes[i].pauseHttpStatus&&!this.nodes[i].rotationPending&&this.nodes[i].nextAllowedAt>at).sort((a,b)=>this.nodes[b].nextAllowedAt-this.nodes[a].nextAllowedAt);
    const incoming=reserves[0],outgoing=resting[0];if(incoming===undefined||!vacancy&&outgoing===undefined)return false;
    // Transfer only a sampling position. Both tunnels and their response-based
    // ledgers remain intact; the incoming route is proved before its stock GET.
    if(vacancy)this.roster.push(incoming);
    else{this.roster=this.roster.map(i=>i===outgoing?incoming:i);Object.assign(this.nodes[outgoing],{phase:'standby',reserveSequence:++this.reserveSequence});}
    // A reconciled Apple pause can leave a stock position vacant even after
    // tunnel recovery. Prove the warm reserve before its first GET.
    const requiredProof=vacancy||this.nodes[incoming].dispatchProofPending===true||this.nodes[incoming].readyReserveProofPending===true;
    const proofAge=at-this.nodes[incoming].provedAt;
    const recentProof=Number.isFinite(proofAge)&&proofAge>=0&&proofAge<INTERVAL;
    const workerPreflight=this.adapters[incoming].verifiesExpectedRouteBeforeSample===true&&!requiredProof&&recentProof;
    // Healthy position loans leave the pin unchanged. A recent unique
    // fingerprint can use the worker's mandatory fresh check once; an aged
    // standby proof needs coordinator reconciliation before the worker checks it.
    Object.assign(this.nodes[incoming],{phase:'ready',dispatchProofPending:!workerPreflight,readyReserveProofPending:!workerPreflight});
    if(workerPreflight)this.recoveryCounts.workerPreflightOnlyReserveStarts++;
    this.recoveryCounts.readyReserveDispatches++;return true;
  }
  syncRoster() {
    if(!this.warmStandby)return;
    const all=this.verifiedLinux(),available=new Set(all);
    this.roster=this.roster.filter(i=>available.has(i)).slice(0,this.positions);
    // A standby proof predates the handoff. Leave that candidate to the pool,
    // which closes/releases the old worker and verifies the current unique
    // route before prove() changes the reserve back to ready/cooldown.
    const candidates=all.filter(i=>!this.roster.includes(i)&&this.nodes[i].phase!=='standby'&&!this.jobs.has(i)&&this.nodes[i].nextAllowedAt<=this.now()&&!this.nodes[i].rotationPending).sort((a,b)=>(this.nodes[a].reserveSequence??0)-(this.nodes[b].reserveSequence??0)||this.nodes[a].checks-this.nodes[b].checks||this.nodes[a].workerSuccesses-this.nodes[b].workerSuccesses);
    for(const i of candidates)if(this.roster.length<this.positions){this.roster.push(i);this.nodes[i].dispatchProofPending=true;}
    for(const i of all)if(!this.roster.includes(i)&&!this.jobs.has(i)&&this.nodes[i].nextAllowedAt<=this.now())this.nodes[i].phase='standby';
  }
  eligible(i, at = this.now()) { const n = this.nodes[i]; return i < this.workerCount && n.nextAllowedAt <= at && (n.nextVpnAllowedAt ?? 0) <= at && !this.retirements.has(i) && !this.jobs.has(i) && !['blocked', 'retiring'].includes(n.phase); }
  recordProofFailure(i,error,stage='route-proof') {
    const known=new Set(['TUNNEL_UNVERIFIED','ROUTE_DUPLICATE','worker-unreachable','proof-expired','operation-missing','sample-uncertain']);
    const code=[error?.code,error?.message].find(value=>known.has(value))??'NETWORK_PROOF_FAILED';
    const node=this.nodes[i];if(!node)return;
    this.proofFailures.push({sequence:++this.proofFailureSequence,atJST:jst(this.now()),node:node.id,provider:['nordvpn','windscribe','host'].includes(node.provider)?node.provider:i===this.workerCount?'host':'nordvpn',stage:['route-proof','warm-handoff','connect-proof','inspection'].includes(stage)?stage:'route-proof',code});
    this.proofFailures=this.proofFailures.slice(-50);
  }
  async prove(i, verifiedProof) {
    try { return await this.acceptProof(i,verifiedProof); }
    catch(error){this.recordProofFailure(i,error);throw error;}
  }
  async acceptProof(i, verifiedProof) {
    const n = this.nodes[i], proof = verifiedProof ?? await this.adapters[i].network();
    if (i < this.workerCount && (n.connected !== true || proof.vpn !== 'protected')) throw Error('TUNNEL_UNVERIFIED');
    if (!/^[a-f0-9]{64}$/.test(proof.fingerprint ?? '') || [...this.proofs].some(([j, p]) => j !== i && this.nodes[j].verified && p.fingerprint === proof.fingerprint)) throw Error('ROUTE_DUPLICATE');
    this.proofs.set(i, proof); this.pool.record(i, proof); n.verified = true; n.provedAt = this.now(); n.workerSuccesses = proof.completedChecks ?? n.workerSuccesses; n.nextAllowedAt = Math.max(n.nextAllowedAt, this.now() + (proof.nextAllowedInMs ?? 0)); n.phase = n.nextAllowedAt > this.now() ? 'cooldown' : 'ready';
    n.sharedRouteProofPending = false;
    n.pauseHttpStatus = proof.pauseHttpStatus === 541 && n.nextAllowedAt > this.now() ? 541 : null;
    if (i > 0 && i < this.workerCount && n.pauseHttpStatus === 541 && !n.rotationCoversPause) { this.retirements.add(i); n.phase = 'recovering'; }
  }
  async releasePausedNode(i, current) {
    if (i === 0 || !current() || !this.canChangeContainer()) return;
    const n = this.nodes[i];
    await this.adapters[i].close();
    if (!current() || !this.canChangeContainer()) return;
    const result = await this.pool.replace(i, { isStopping: () => !current(), isEligible: j => this.connectionEligible(j) });
    if (n.connected === false) { this.retirements.delete(i); n.phase = 'cooldown'; }
    if (result.status === 'ready' && current()) { this.nodes[result.index].connected = true; await this.prove(result.index, result.proof); }
    this.onChange();
  }
  checkSharedRoute() {
    const native = this.nodes[0];
    if (!this.nativeProofFence || !this.enabled || this.paused || !this.canChange()) return;
    const generation = this.generation;
    const current = () => this.enabled && !this.paused && this.generation === generation && this.nativeProofFence && this.canChange();
    this.checkEmergencyMac(current);
    if (this.sharedRouteCheck || native.connected !== true || this.jobs.has(0) || (native.nextProofAt ?? 0) > this.now()) return;
    const check = async () => {
      try {
        const proof = await this.adapters[0].network();
        if (!current() || native.connected !== true) return;
        await this.acceptProof(0, proof);
        if (!current()) return;
        // The shared route can recover with different container exits.
        // Revalidate each old proof at its next scheduled stock dispatch.
        for (let i = 1; i < this.workerCount; i++) {
          const node = this.nodes[i];
          if (node.connected === true && node.verified) node.sharedRouteProofPending = true;
        }
        this.nativeProofFence = false;
        this.lastNetworkProofFailure = null;
        this.recoveryCounts.sharedRouteRecoveries++;
        this.nextMaintenance = 0;
        if (this.block === 'Inventario o connettività Linux da verificare') this.block = null;
      } catch (error) {
        if (!current()) return;
        this.recordProofFailure(0, error);
        native.verified = false;
        native.phase = 'recovering';
        native.nextProofAt = this.now() + 15000;
        this.block = 'Inventario o connettività Linux da verificare';
      }
    };
    this.sharedRouteCheck = check().finally(() => {
      this.sharedRouteCheck = null;
      this.onChange();
    });
  }

  checkEmergencyMac(current) {
    const i = this.workerCount, mac = this.nodes[i];
    if (this.emergencyMacCheck || mac.verified || this.jobs.has(i) || (mac.nextProofAt ?? 0) > this.now()) return;
    const check = async () => {
      try {
        const proof = await this.adapters[i].network();
        if (current()) await this.acceptProof(i, proof);
      } catch (error) {
        if (!current()) return;
        this.recordProofFailure(i, error);
        mac.phase = 'offline';
        mac.nextProofAt = this.now() + 30000;
      }
    };
    this.emergencyMacCheck = check().finally(() => {
      this.emergencyMacCheck = null;
      this.onChange();
    });
  }

  maintain() {
    this.checkSharedRoute();
    if (this.maintenance || !this.enabled || this.paused || !this.canChange() ||
        this.nativeProofFence && this.nodes[0].connected === true) return;
    const generation = this.generation, current = () => generation === this.generation && this.enabled && !this.paused;
    this.maintenance = (async () => {
      await this.pool.refresh();
      // Reconcile the common route before touching any dependent container.
      if (!current()) return;
      if (this.nodes[0].connected === false && this.pool.hasFreeSeat() && this.canChange()) {
        try { await this.control('connect', 1); } catch {}
        await this.pool.refresh();
      }
      if (!current()) return;
      if (this.nodes[0].connected !== true) throw Error('NATIVE_TUNNEL_UNVERIFIED');
      if (this.nativeProofFence) {
        this.checkSharedRoute();
        throw Error('NATIVE_CONNECTIVITY_UNVERIFIED');
      }
      if (!this.nodes[0].verified && (this.nodes[0].nextProofAt ?? 0) > this.now()) throw Error('NATIVE_CONNECTIVITY_UNVERIFIED');
      for (let i = 1; i < this.workerCount && current() && this.canChangeContainer(); i++) {
        const node = this.nodes[i];
        const stuckConnecting = node.connecting && this.now() - node.connectingSince >= 30000;
        if ((!stuckConnecting && !node.connectionError) || this.jobs.has(i) || !this.canChange()) continue;
        try {
          await this.adapters[i].close();
          await this.pool.releaseOnly(i, { isStopping: () => !current() });
          if (node.connected === false) { this.retirements.delete(i); node.phase = 'recovering'; node.nextAllowedAt = Math.max(node.nextAllowedAt, this.now() + 300000); }
        } catch { node.phase = 'recovering'; }
        this.onChange();
      }
      if (!current() || this.nativeProofFence) return;
      // Apple-paused Linux routes cannot reclaim this seat during recovery.
      // Prove the independent last reserve before long reconnect operations.
      if(current()&&this.applePauseDeficit()&&this.canChange()&&!this.nodes[this.workerCount].verified&&!this.nodes.slice(0,this.workerCount).some(n=>n.connected===null)) {
        try { await this.prove(this.workerCount); } catch { this.nodes[this.workerCount].phase='offline'; }
      }
      // A failed sample may finish while checkout prevents VPN changes.
      // Retire that deferred route before proving or selecting it again.
      for (let i = 1; i < this.workerCount; i++) if (this.nodes[i].rotationPending && this.nodes[i].connected === true && !this.jobs.has(i)) {
        this.retirements.add(i);
        this.roster = this.roster.filter(j => j !== i);
      }
      for (let i = 0; i < this.workerCount; i++) if (this.nodes[i].connected === true && !this.nodes[i].verified && !this.retirements.has(i) && (this.nodes[i].nextProofAt ?? 0) <= this.now() && current() && this.canChangeContainer()) {
        try { await this.prove(i); }
        catch {
          const node = this.nodes[i]; node.phase = 'recovering'; node.nextProofAt = this.now() + 60000; node.nextAllowedAt = Math.max(node.nextAllowedAt, this.now() + 60000);
          if (i === 0) throw Error('NATIVE_CONNECTIVITY_UNVERIFIED');
          if (i > 0 && current() && this.canChangeContainer()) {
            try {
              await this.adapters[i].close();
              const replacement = await this.pool.replace(i, { isStopping: () => !current(), isEligible: j => this.connectionEligible(j) });
              if (replacement.status === 'ready') { this.nodes[replacement.index].connected = true; await this.prove(replacement.index, replacement.proof); }
            } catch {}
          }
        }
        this.onChange();
      }
      let attempts = 0;
      const replenishKnownSeats = async (onlyIndependent = false) => {
        if(this.warmStandby)for(let i=1;i<this.workerCount&&current()&&this.canChangeContainer();i++){if(onlyIndependent&&this.retirements.has(i))continue;const n=this.nodes[i];if(n.connected===false&&n.pauseHttpStatus===541&&n.nextAllowedAt>this.now()&&!n.rotationCoversPause)n.rotationPending=true;if(!n.rotationPending||n.connected!==false||this.jobs.has(i)||(n.nextRotationAt??0)>this.now())continue;try{const rotated=await this.control('rotate',i+1);if(rotated?.rotated!==true)throw Error('ROTATION_UNVERIFIED');this.pool.rotated(i);this.recoveryCounts.rotated++;n.rotationPending=false;n.rotationCoversPause=true;}catch{n.nextRotationAt=this.now()+60000;}}
        while (current() && this.canChangeContainer() && this.usable().length < this.vpnLimit && this.pool.hasFreeSeat() && attempts++ < this.workerCount) {
          const result = await this.pool.fill({ isStopping: () => !current(), isEligible: i => this.connectionEligible(i) });
          if (result.status === 'ready') { this.nodes[result.index].connected = true; await this.prove(result.index, result.proof); }
          else if(result.status==='connect-unverified')this.recoveryCounts.connectFailures++;
          else break;
          this.onChange();
        }
      };
      // A confirmed free VPN seat is independent of another worker whose
      // browser has not closed. Refill it before waiting on that worker, while
      // the closing worker's tunnel continues to count against the same cap.
      if(this.warmStandby&&this.retirements.size&&this.pool.hasFreeSeat())await replenishKnownSeats(true);
      for (const i of [...this.retirements]) if (current() && !this.jobs.has(i)) {
        try { await this.releasePausedNode(i, current); } catch { this.nodes[i].phase = 'recovering'; }
      }
      await replenishKnownSeats();
      this.syncRoster();
      if (current() && this.block === 'Inventario o connettività Linux da verificare') this.block = null;
      if (current() && this.usable().length < this.positions && !this.nodes[this.workerCount].verified) { try { await this.prove(this.workerCount); } catch { this.nodes[this.workerCount].phase = 'offline'; } }
    })().catch(async error => {
      if (!current()) return;
      this.block = 'Inventario o connettività Linux da verificare';
      // Native recovery failure must not block the independent Mac reserve
      // when known, verified Linux capacity remains insufficient.
      if (['NATIVE_TUNNEL_UNVERIFIED','NATIVE_CONNECTIVITY_UNVERIFIED'].includes(error.message) && !this.nativeProofFence && this.canChange() && !this.nodes.slice(0, this.workerCount).some(n => n.connected === null) && this.usable().length < this.positions && !this.nodes[this.workerCount].verified) {
        try { await this.prove(this.workerCount); } catch { this.nodes[this.workerCount].phase = 'offline'; }
      }
    }).finally(() => { this.nextMaintenance = current() ? this.now() + 30000 : 0; this.maintenance = null; this.onChange(); });
  }
  verifiedLinux() { const at = this.now(); return this.nodes.slice(0, this.workerCount).flatMap((n, i) => n.connected === true && n.verified && !['blocked', 'retiring', 'recovering'].includes(n.phase) && !(n.pauseHttpStatus === 541 && n.nextAllowedAt > at) ? [i] : []); }
  usable() {if(this.nativeProofFence)return [];const all=this.verifiedLinux();return this.warmStandby?all.filter(i=>this.roster.includes(i)):all;}
  samplingCapacity() { const linux = this.usable().length,mac=this.nodes[this.workerCount]; return linux + (linux < this.positions && mac.verified && !(mac.pauseHttpStatus===541&&mac.nextAllowedAt>this.now()) && (this.nativeProofFence || !this.nodes.slice(0,this.workerCount).some(n => n.connected === null)) ? 1 : 0); }
  applePauseDeficit(at=this.now()) { return this.warmStandby&&this.workerCount-this.nodes.slice(0,this.workerCount).filter(n=>n.pauseHttpStatus===541&&n.nextAllowedAt>at).length<this.positions; }
  dispatchInterval() { return Math.max(this.warmStandby?3250:6500, Math.ceil(INTERVAL / Math.max(1, this.samplingCapacity()))); }
  macDispatchInterval() {
    // During a shared Linux outage the Mac keeps its own response ledger.
    // Apply the configured spacing between starts when first taking over.
    return this.nativeProofFence ? (this.warmStandby ? 3250 : 6500) : this.dispatchInterval();
  }
  async sampleAfterDispatchProof(i, selection, generation) {
    const current=()=>this.enabled&&!this.paused&&!this.nativeProofFence&&this.generation===generation;
    const n = this.nodes[i];
    const counter = n.sharedRouteProofPending ? 'sharedRouteProofRefreshes' :
      n.checks === 0 ? 'initialProofRefreshes' : 'handoffProofRefreshes';
    this.recoveryCounts[counter]++;
    const proof=await this.adapters[i].network();
    if(!current())return null;
    await this.prove(i,proof);
    if(!current())return null;
    if(n.nextAllowedAt>this.now())throw Object.assign(Error('NODE_WAIT'),{code:'NODE_WAIT',nextAllowedAt:n.nextAllowedAt});
    n.dispatchProofPending=false;n.readyReserveProofPending=false;n.phase='checking';
    return this.adapters[i].sample(selection,this.proofs.get(i).fingerprint);
  }
  recordFailure(i,error,startedAt,sampleGeneration) {
    const at=this.now(),httpStatus=Number.isInteger(error.httpStatus)?error.httpStatus:null;
    const code=/^[a-zA-Z0-9_-]{1,40}$/.test(error.code??'')?error.code:['STOCK_STALE','STOCK_UNKNOWN','STOCK_WRONG_PRODUCT'].includes(error.message)?error.message:'transport';
    const kind=httpStatus===541?'http541':httpStatus===429?'http429':httpStatus===403||code==='challenge'?'challenge':code==='NODE_WAIT'?'nodeWait':httpStatus?'httpOther':code.startsWith('STOCK_')?'stockValidation':'transport';
    this.outcomes[kind]++;
    const proofAge=at-this.nodes[i].provedAt;
    this.faults.push({sequence:++this.faultSequence,atJST:jst(at),node:this.nodes[i].id,provider:this.nodes[i].provider??(i===this.workerCount?'host':'nordvpn'),kind,httpStatus,code,stage:code==='ROUTE_CHANGED'?'network-preflight':httpStatus?'apple-response':'transport',proofAgeMs:Number.isSafeInteger(proofAge)&&proofAge>=0?proofAge:null,durationMs:Math.max(0,at-startedAt),waitMs:Math.max(INTERVAL,(error.nextAllowedAt??0)-at,httpStatus===541?300000:0),duringSearch:this.enabled&&!this.paused&&sampleGeneration===this.generation,...safeWorkerContext(error)});
    this.faults=this.faults.slice(-500);
  }
  tick() {
    if (!this.enabled || this.paused) return;
    this.checkSharedRoute();
    if (this.now() >= this.nextMaintenance) this.maintain();
    this.syncRoster();
    this.promoteReadyReserve();
    const at = this.now(), ready = i => !this.jobs.has(i) && this.nodes[i].nextAllowedAt <= at;
    const candidates = this.usable().sort((a, b) => Number(ready(b)) - Number(ready(a)) || this.nodes[a].checks - this.nodes[b].checks || this.nodes[a].workerSuccesses - this.nodes[b].workerSuccesses);
    // An in-flight Mac request finishes before its slot is handed to Linux.
    this.active = this.active.filter(i => this.jobs.has(i));
    for (const i of candidates) if (!this.active.includes(i) && this.active.length < this.positions) this.active.push(i);
    // Reconnecting paused tunnels cannot restore Linux stock capacity before
    // their Apple deadlines. The independently verified Mac need not wait for
    // that maintenance; ordinary warm Linux promotion still takes precedence.
    const appleLimited=this.applePauseDeficit(at);
    const mac = this.nodes[this.workerCount];
    const emergencyMac = this.nativeProofFence && !(mac.pauseHttpStatus === 541 && mac.nextAllowedAt > at);
    const normalMac = mac.nextAllowedAt <= at && (!this.maintenance || appleLimited) &&
      !this.nodes.slice(0, this.workerCount).some(n => n.connected === null);
    if (this.active.length < this.positions && mac.verified && !this.active.includes(this.workerCount) && (emergencyMac || normalMac)) this.active.push(this.workerCount);
    // Space starts across verified routes while slow responses overlap within
    // the configured position limit. Every node keeps its response-based ledger.
    if (this.jobs.size >= this.positions) return;
    // Last-reserve admission is decided above. Once admitted, the Mac shares
    // dispatch turns with Linux; ready Linux arrivals must not postpone it.
    const i = this.active.filter(i => !this.jobs.has(i) && this.nodes[i].nextAllowedAt <= this.now()).sort((a,b)=>this.nodes[a].checks-this.nodes[b].checks||this.nodes[a].workerSuccesses-this.nodes[b].workerSuccesses)[0];
    if (i === undefined || at - this.lastStart < (i === this.workerCount ? this.macDispatchInterval() : this.dispatchInterval())) return;
    const n = this.nodes[i]; n.phase = 'checking'; const startedAt = this.now(), sampleGeneration = this.generation; this.lastStart = startedAt; this.recentStarts.push(startedAt); this.recentStarts = this.recentStarts.slice(-500);
    this.outcomes.started++;
    const selection = this.selections?.[(this.selectionCursor++) % this.selections.length] ?? this.selection;
    // Startup, checkout pauses and reserve cooldowns can age a route before
    // its next dispatch. Refresh only when entering/resuming service, leaving
    // continuous cycles on the worker's ordinary independent preflight.
    const refreshProof=this.warmStandby&&i<this.workerCount&&(n.sharedRouteProofPending===true||
      n.dispatchProofPending===true&&(n.readyReserveProofPending===true||Number.isFinite(n.provedAt)&&this.now()-n.provedAt>=INTERVAL));
    if(!refreshProof)n.dispatchProofPending=false;
    const request=refreshProof?this.sampleAfterDispatchProof(i,selection,sampleGeneration):this.adapters[i].sample(selection,this.proofs.get(i).fingerprint);
    const job = request.then(sample => {
      if(refreshProof&&sample===null)return;
      if (sample.sku !== selection.sku || !Number.isFinite(sample.observedAt) || sample.observedAt > this.now() + 1000 || this.now() - sample.observedAt > 5000) throw Error('STOCK_STALE');
      this.outcomes.valid++;
      this.recentResponses.push(this.now()); this.recentResponses = this.recentResponses.slice(-500); this.responseDurations.push(this.now() - startedAt); this.responseDurations = this.responseDurations.slice(-100);
      n.checks++; n.workerSuccesses++; n.phase = 'cooldown'; n.pauseHttpStatus = null; n.nextAllowedAt = this.now() + INTERVAL;
      this.onSignal({
        ...sample, requestStartedAt:startedAt, node:n.id,
        canCheckout:this.enabled && !this.paused && this.generation === sampleGeneration,
        canQueueDuringCheckout:!this.enabled && !this.paused && this.checkoutDrainGeneration === sampleGeneration,
      });
    }).catch(async e => {
      this.recordFailure(i,e,startedAt,sampleGeneration);
      n.nextAllowedAt = Math.max(this.now() + INTERVAL, e.nextAllowedAt ?? 0);
      if (this.noteNetworkProofFailure(i,e,sampleGeneration)) {
        // This worker failed before contacting Apple. Keep its connected
        // tunnel out of stock until a fresh, unique proof can restore it.
        n.verified = false; n.phase = 'recovering'; n.reserveSequence = ++this.reserveSequence;
        return;
      }
      if (i < this.workerCount && e.code === 'ROUTE_CHANGED') {
        // The worker observed a different protected exit before the stock GET.
        // Verify the new exit before using it instead of changing the server.
        n.verified = false;
        n.phase = 'recovering';
        n.nextProofAt = 0;
        this.nextMaintenance = 0;
        return;
      }
      if(e.code!=='NODE_WAIT'&&!(e.code==='challenge'||e.httpStatus===403)){n.reserveSequence=++this.reserveSequence;if(this.warmStandby&&i>0&&i<this.workerCount)n.rotationPending=true;}
      if (e.httpStatus === 541 || this.warmStandby&&e.httpStatus===429) {
        n.phase = 'cooldown'; n.pauseHttpStatus = 541; n.nextAllowedAt = Math.max(n.nextAllowedAt, this.now() + 300000);
        if (i > 0 && i < this.workerCount) {
          n.phase = 'recovering'; this.retirements.add(i);
          try { await this.releasePausedNode(i, () => this.generation === sampleGeneration && this.enabled && !this.paused); } catch {}
          this.nextMaintenance = 0;
        }
        return;
      }
      if (e.code === 'NODE_WAIT') { n.phase = 'cooldown'; return; }
      if ((!this.warmStandby&&e.httpStatus)||e.httpStatus===403||e.code === 'challenge') { n.phase = 'blocked'; this.paused = true; this.block = 'Apple richiede attesa o verifica manuale'; this.onBlocked(this.block); return; }
      n.phase = 'retiring'; n.verified = false;
      try {
        await this.adapters[i].close();
        n.phase = 'recovering';
        if (i > 0 && i < this.workerCount && this.enabled && !this.paused && this.canChangeContainer()) {
          const result = await this.pool.replace(i, { isStopping: () => !this.enabled || this.paused, isEligible: j => this.connectionEligible(j) });
          if (result.status === 'ready') { this.nodes[result.index].connected = true; await this.prove(result.index, result.proof); }
        }
      } catch { n.phase = 'recovering'; }
      this.nextMaintenance = 0;
    }).finally(() => { this.jobs.delete(i); this.onChange(); });
    this.jobs.set(i, job); this.onChange();
  }
  quiesce({ queueCheckoutAlternatives = false } = {}) {
    this.checkoutDrainGeneration = queueCheckoutAlternatives && this.enabled && !this.paused ? this.generation : null;
    this.enabled = false; this.generation++; clearInterval(this.timer); this.onChange();
    if(this.warmStandby)for(const i of this.roster)this.nodes[i].dispatchProofPending=true;
    // Only the in-flight generation at checkout entry can contribute an
    // alternate colour. A stop or another quiesce invalidates this permission.
    return Promise.allSettled([...this.jobs.values(), this.maintenance, this.inspection, this.sharedRouteCheck, this.emergencyMacCheck, this.pool.drain()]);
  }
  async stop() {
    this.refreshProofsBeforeStart = true;
    await this.quiesce();
    const used = [...this.proofs.keys()]; const closed = await Promise.allSettled(used.map(i => this.adapters[i].close()));
    if (closed.some(r => r.status === 'rejected')) throw Error('WORKER_CLOSE_UNVERIFIED');
    this.active = [];this.roster=[]; this.onChange();
  }
}
