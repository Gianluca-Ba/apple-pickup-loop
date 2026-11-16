const GiB = 1024 ** 3;
export function fleetGrowthPlan({ connected = 10, active = 10, targetActive = 20, targetStandby = 9 } = {}) {
  if ([connected,active,targetActive,targetStandby].some(n => !Number.isSafeInteger(n) || n < 0) || active < 1 || active > connected || targetActive < active || targetActive > 20 || targetActive + targetStandby > 30 || connected > targetActive + targetStandby) throw Error('FLEET_GROWTH_INVALID');
  const rows = [];
  let total = connected;
  for (; total < targetActive + targetStandby;) {
    const next = Math.min(total + 2, targetActive + targetStandby);
    // Prepare the whole verified fleet before increasing the sampling roster.
    rows.push({ addTunnels:next-total, connected:next, active, standby:next-active }); total = next;
  }
  for (let positions = active; positions < targetActive;) {
    positions = Math.min(positions + 2, targetActive);
    rows.push({ addTunnels:0, connected:total, active:positions, standby:total-positions });
  }
  return rows;
}

export function growthResourceGate(sample, { now = Date.now(), stabilizedForMs = 0 } = {}) {
  const fields = ['at','guestRamBytes','guestAvailableBytes','guestFreeDiskBytes','hostFreeDiskBytes','hostMemoryHeadroomPercent','cpuPressureAvg60','memoryPressureAvg60','ioPressureAvg60'];
  if (!sample || fields.some(k => !Number.isFinite(sample[k]) || sample[k] < 0) || sample.at > now || now-sample.at > 60000) return { ready:false, reason:'resource-reading-unverified' };
  if (sample.guestAvailableBytes < Math.max(1.5*GiB, sample.guestRamBytes*0.15)) return { ready:false, reason:'guest-memory-headroom' };
  if (sample.guestFreeDiskBytes < 3*GiB || sample.hostFreeDiskBytes < 15*GiB) return { ready:false, reason:'disk-headroom' };
  if (sample.hostMemoryHeadroomPercent < 25 || sample.memoryPressureAvg60 >= 1 || sample.cpuPressureAvg60 >= 10 || sample.ioPressureAvg60 >= 10) return { ready:false, reason:'resource-pressure' };
  if (!Number.isFinite(stabilizedForMs) || stabilizedForMs < 130000) return { ready:false, reason:'two-worker-cycles-required' };
  return { ready:true, reason:'verified-headroom' };
}

export function chooseWarmReserves(nodes, { now = Date.now(), active = [], inFlight = [], limit = 1 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 0) throw Error('RESERVE_LIMIT_INVALID');
  const excluded = new Set([...active,...inFlight]);
  return nodes.filter(n => n.id !== 'mac' && !excluded.has(n.id) && n.connected === true && n.verified === true &&
    Number.isFinite(n.nextAllowedAt) && n.nextAllowedAt <= now && !n.rotationPending && !['blocked','retiring','recovering'].includes(n.phase))
    .sort((a,b) => (a.reserveSequence??0)-(b.reserveSequence??0) || (a.checks??0)-(b.checks??0) || (a.workerSuccesses??0)-(b.workerSuccesses??0)).slice(0,limit);
}

export function queueRetiredNode(node, error, { now = Date.now(), sequence } = {}) {
  if (!Number.isSafeInteger(sequence) || sequence < 1 || !Number.isFinite(now)) throw Error('RESERVE_SEQUENCE_INVALID');
  const requested = Number.isFinite(error?.nextAllowedAt) ? error.nextAllowedAt : 0;
  return { ...node, reserveSequence:sequence, nextAllowedAt:Math.max(node.nextAllowedAt??0, requested, now+65000, error?.httpStatus===541?now+300000:0),
    phase:'recovering', pauseHttpStatus:error?.httpStatus===541?541:null, rotationPending:node.id!=='pilot1', verified:node.id==='pilot1'?node.verified:false };
}
