import { spawn as spawnChild } from 'node:child_process';

const AX_TARGETS = new Set(['AX_NO_HIT','AX_OTHER_APP','AX_ANCESTOR','AX_WEB_AREA','AX_OTHER_CONTROL','AX_NO_RECT','AX_CONTROL_MOVED']);
const DOM_TARGETS = new Set(['DOM_CHANGED','DOM_REACHABLE','DOM_OBSCURED','DOM_UNAVAILABLE']);

// One request at a time. An unanswered request is rejected, never replayed.
export function createNativeTransport({ executable, spawn = spawnChild, timeoutMs = 18000, maxOutputBytes = 200000 } = {}) {
  let child = null, active = null, buffer = '', queue = [];
  const fail = (process, code = 'SAFARI_UNCERTAIN') => {
    if (child !== process) return;
    child = null; buffer = '';
    const waiting = [...(active ? [active] : []), ...queue]; active = null; queue = [];
    for (const job of waiting) { clearTimeout(job.timer); job.reject(Error(code)); }
    process.stdin?.destroy(); process.stdout?.destroy(); process.stderr?.destroy();
    try { process.kill('SIGTERM'); } catch {}
  };
  const start = () => {
    const process = spawn(executable, ['--stdio'], { stdio: ['pipe','pipe','pipe'] });
    child = process; buffer = '';
    // The desktop server keeps its helper alive. One-shot diagnostic clients
    // can exit normally; EOF then closes their helper instead of orphaning it.
    process.unref?.();
    for (const stream of [process.stdin, process.stdout, process.stderr]) stream?.unref?.();
    process.stderr?.resume(); process.stdout.setEncoding('utf8');
    process.on('error', () => fail(process, 'SAFARI_UNAVAILABLE'));
    process.on('close', () => fail(process));
    process.stdin.on('error', () => fail(process));
    process.stdout.on('error', () => fail(process));
    process.stdout.on('data', chunk => {
      if (child !== process) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > maxOutputBytes) { fail(process); return; }
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const line = buffer.slice(0, newline), extra = buffer.slice(newline + 1);
      // Unsolicited/duplicate frames cannot be mistaken for a queued reply.
      if (!active || extra.trim()) { fail(process); return; }
      let response;
      try { response = JSON.parse(line); }
      catch { fail(process); return; }
      if (!response || typeof response.ok !== 'boolean' || response.ok && !Object.hasOwn(response,'result') || !response.ok && !/^[A-Z][A-Z_0-9]{0,79}$/.test(response.code ?? '')) { fail(process); return; }
      const job = active; active = null; buffer = ''; clearTimeout(job.timer);
      if (response.ok) job.resolve(response.result);
      else {
        const error=Error(response.code);
        if(job.operation==='press-apple-pay'&&response.notDispatched===true&&['APPLE_PAY_CHANGED','APPLE_PAY_HIT_CHANGED','APPLE_PAY_ARM_CHANGED','APPLE_PAY_WINDOW_AMBIGUOUS','APPLE_PAY_WINDOW_NOT_FOCUSED','APPLE_PAY_CONTROL_AMBIGUOUS','APPLE_PAY_CONTROL_UNAVAILABLE'].includes(response.code)) {
          error.notDispatched=true;
          if(response.code==='APPLE_PAY_HIT_CHANGED') {
            if(AX_TARGETS.has(response.axTarget)) error.axTarget=response.axTarget;
            if(DOM_TARGETS.has(response.domTarget)) error.domTarget=response.domTarget;
          }
        }
        job.reject(error);
      }
      pump();
    });
    return process;
  };
  const pump = () => {
    if (active || !queue.length) return;
    let process;
    try { process = child ?? start(); }
    catch { const jobs=queue;queue=[];for(const job of jobs)job.reject(Error('SAFARI_UNAVAILABLE'));return; }
    const job = active = queue.shift();
    job.timer = setTimeout(() => fail(process), timeoutMs);
    try { process.stdin.write(job.encoded + '\n', error => { if (error) fail(process); }); }
    catch { fail(process); }
  };
  const send = request => {
    if (process.env.CHECKOUT_DISABLE_NATIVE === '1' && spawn === spawnChild) return Promise.reject(Error('NATIVE_DISABLED_OFFLINE'));
    let encoded;
    try { encoded = JSON.stringify(request); if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > 250000) throw Error(); }
    catch { return Promise.reject(Error('INVALID_COMMAND')); }
    return new Promise((resolve,reject) => { queue.push({encoded,operation:request.operation,resolve,reject}); pump(); });
  };
  send.close = () => { if (child) fail(child); };
  return send;
}
