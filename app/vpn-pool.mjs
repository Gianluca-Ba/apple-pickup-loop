const workerId = id => Number(/^pilot([1-9]|[12][0-9]|30)$/.exec(id)?.[1]);

export function createLinuxVpnPool({ agents, adapters, control, canChange, canPromote = () => true, isStandby = () => false, onRetired = () => {}, onProofFailure = () => {}, now = Date.now, vpnLimit = 10,nordLimit = 10 }) {
  if (!Number.isInteger(vpnLimit) || vpnLimit < 1 || vpnLimit > 30) throw Error('Invalid VPN limit');
  if(!Number.isInteger(nordLimit)||nordLimit<0||nordLimit>10)throw Error('Invalid NordVPN limit');
  const indices = agents.flatMap((agent, i) => workerId(agent.id) ? [i] : []);
  let live = new Map();
  const proofs = new Map();
  const unavailableUntil = new Map();
  const rotationRetryUsed = new Set();
  let pending = Promise.resolve();
  const failedProof=(i,error,stage)=>{try{onProofFailure(i,error,stage);}catch{}};

  async function refresh() {
    const inventory = await control('inventory');
    const entries = indices.map(i => {
      const status = inventory?.[workerId(agents[i].id)];
      return [i, status?.connected === false || status?.connected === true && status.pinned === true
        ? status : {connected:null}];
    });
    if (entries.filter(([, status]) => status.connected === true).length > vpnLimit || entries.filter(([,s])=>s.connected===true&&(s.provider??'nordvpn')==='nordvpn').length>nordLimit) {
      live.clear();
      throw Error('Troppe connessioni VPN.');
    }
    live = new Map(entries);
    for (const [i, status] of live) {
      if (status.connected !== true) proofs.delete(i);
      if (status.connected !== false) continue;
      const agent = agents[i];
      const connectDelay = status.connectNextAllowedInMs ?? 0;
      if (!Number.isSafeInteger(connectDelay) || connectDelay < 0) throw Error('VPN_CONNECT_PAUSE_UNVERIFIED');
      agent.nextVpnAllowedAt = now() + connectDelay;
      const delay = status.nextAllowedInMs ?? 0;
      if (Number.isSafeInteger(delay) && delay > 0) {
        agent.nextAllowedAt = Math.max(agent.nextAllowedAt ?? 0, now() + delay);
      }
    }
  }

  async function release(i, allowed) {
    live.delete(i);
    proofs.delete(i);
    if (!allowed()) return false;
    try { await control('disconnect', workerId(agents[i].id)); } catch {}
    await refresh();
    return live.get(i)?.connected === false;
  }

  function hasFreeSeat() {
    const states = [...live.values()];
    return live.size === indices.length && states.every(status => status.connected !== null) &&
      states.filter(status => status.connected === true).length < vpnLimit;
  }

  async function promote(excluded, isEligible, allowed, allowWarm = true) {
    if (!allowed() || !canPromote()) return {status:'skipped'};
    const at = now();
    const count = i => live.get(i).completedChecks ?? agents[i].workerSuccesses ?? agents[i].checks ?? 0;
    const order=(a,b)=>(agents[a].reserveSequence??0)-(agents[b].reserveSequence??0)||(agents[a].checks??0)-(agents[b].checks??0)||count(a)-count(b);
    const warmCandidates=allowWarm?indices.filter(i=>i!==excluded&&live.get(i)?.connected===true&&proofs.has(i)&&isStandby(i)&&isEligible(i,at)).sort(order):[];
    // A warm handoff reuses a connected route after a fresh proof. Only
    // opening a new tunnel requires the inventory to have no unknown states.
    for(const warm of warmCandidates) {
      let proof,failure;
      try { proof=await adapters[warm].network(); } catch(error){failure=error;}
      if(!allowed()||!canPromote())return {status:'skipped'};
      const unique=proof&&![...proofs.entries()].some(([i,p])=>i!==warm&&p.fingerprint===proof.fingerprint);
      if(live.get(warm)?.connected===true&&proof?.vpn==='protected'&&/^[a-f0-9]{64}$/.test(proof.fingerprint??'')&&unique) {
        proofs.set(warm,proof);
        return {status:'ready',index:warm,proof};
      }
      // Keep an unproved warm tunnel out of dispatch; normal maintenance can
      // reconcile it without disconnecting it for this failed observation.
      failedProof(warm,failure??Error(!proof||proof.vpn!=='protected'?'TUNNEL_UNVERIFIED':'ROUTE_DUPLICATE'),'warm-handoff');
      proofs.delete(warm);agents[warm].verified=false;agents[warm].phase='recovering';
    }
    if(!hasFreeSeat())return {status:'skipped'};
    const nordCount=[...live.values()].filter(s=>s.connected===true&&(s.provider??'nordvpn')==='nordvpn').length;
    const [j] = indices.filter(index => index !== excluded && live.get(index)?.connected === false &&
      live.get(index).authReady!==false&&((live.get(index).provider??'nordvpn')!=='nordvpn'||nordCount<nordLimit)&&
      (unavailableUntil.get(index) ?? 0) <= at && isEligible(index, at))
      .sort(order);
    if (j === undefined) return {status:'released'};

    try {
      if(unavailableUntil.has(j)&&unavailableUntil.get(j)<=at)rotationRetryUsed.delete(j);
      try { await control('connect', workerId(agents[j].id)); } catch {}
      await refresh();
      if (!allowed() || live.get(j)?.connected !== true) throw Error('TUNNEL_UNVERIFIED');
      const proof = await adapters[j].network();
      const unique = ![...proofs.entries()].some(([index, other]) =>
        index !== j && other.fingerprint === proof.fingerprint);
      if (allowed() && live.get(j)?.connected === true && proof.vpn === 'protected' &&
          /^[a-f0-9]{64}$/.test(proof.fingerprint ?? '') && unique) {
        proofs.set(j, proof);unavailableUntil.delete(j);rotationRetryUsed.delete(j);
        return {status:'ready', index:j, proof};
      }
      if(allowed())failedProof(j,Error(live.get(j)?.connected!==true||proof.vpn!=='protected'?'TUNNEL_UNVERIFIED':'ROUTE_DUPLICATE'),'connect-proof');
    } catch(error){failedProof(j,error,'connect-proof');}
    // Resolve ambiguous connects by checking the real inventory before
    // disconnecting the candidate and making its seat available again.
    unavailableUntil.set(j, now() + 300000);
    if (allowed()) {
      if (await release(j, allowed) && j !== 0) onRetired(j);
    }
    else live.delete(j);
    return {status:'connect-unverified', index:j};
  }

  function enqueue(operation) {
    const job = pending.then(operation);
    pending = job.catch(() => {});
    return job;
  }

  return {
    refresh,
    record(i, proof) { if (proof) {proofs.set(i, proof);rotationRetryUsed.delete(i);}else proofs.delete(i); },
    // A confirmed new server invalidates only the old pin's local failure delay.
    // Provider Retry-After and the worker's Apple ledger remain independent.
    rotated(i) { if(!rotationRetryUsed.has(i)&&unavailableUntil.has(i)){unavailableUntil.delete(i);rotationRetryUsed.add(i);}proofs.delete(i); },
    manages: i => indices.includes(i),
    usable: i => !indices.includes(i) || live.get(i)?.connected === true,
    hasFreeSeat,
    drain: () => pending,
    releaseOnly(i, {isStopping}) {
      return enqueue(async () => {
        const allowed = () => !isStopping() && canChange();
        if (i === 0 || !indices.includes(i) || !allowed()) return {status:'skipped'};
        unavailableUntil.set(i, now() + 300000);
        const released = await release(i, allowed);
        if (released) onRetired(i);
        return {status: released ? 'released' : 'disconnect-unverified'};
      });
    },
    fill({isEligible, isStopping}) {
      return enqueue(async () => {
        const allowed = () => !isStopping() && canChange();
        if (!allowed()) return {status:'skipped'};
        await refresh();
        return promote(null, isEligible, allowed, false);
      });
    },
    replace(i, {isEligible, isStopping}) {
      return enqueue(async () => {
        const allowed = () => !isStopping() && canChange();
        if (!indices.includes(i) || !allowed()) return {status:'skipped'};
        if (!await release(i, allowed)) return {status:'disconnect-unverified'};
        const result = await promote(i, isEligible, allowed);
        return result.status === 'skipped' ? {status:'released'} : result;
      });
    }
  };
}
