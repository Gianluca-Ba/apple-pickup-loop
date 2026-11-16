import { readFileSync, existsSync } from 'node:fs';
import { execFile as execCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { INTERVAL, pickupRequest, validateSelection } from './shared.mjs';
import { writeJSON, readJSON } from './storage.mjs';
import { parseWindscribeStatus, validateVpnProvider } from './vpn-provider.mjs';
import { safeBrowserFailureMetadata } from './browser-failure.mjs';
const execFile = promisify(execCallback);
const markWorkerStage=(error,stage)=>{try{if(error&&typeof error==='object')error.workerStage=stage;}catch{}};
export class PickupWorker {
  constructor({ ledgerPath, browserFactory, network, now = Date.now } = {}) {
    this.path = ledgerPath; this.ledger = ledgerPath ? readJSON(ledgerPath, {}) : {}; this.browserFactory = browserFactory; this.networkRead = network; this.now = now; this.browser = null; this.busy = false; this.stopping = false;
  }
  save() { if (this.path) writeJSON(this.path, this.ledger); }
  async network() {
    try {
    const proof = await this.networkRead();
    if (!/^[a-f0-9]{64}$/.test(proof?.fingerprint ?? '') || !['protected', 'host'].includes(proof?.vpn)) throw Error('TUNNEL_UNVERIFIED');
    return { ...proof, nextAllowedInMs: Math.max(0, (this.ledger.nextAllowedAt ?? 0) - this.now(), (this.ledger.lastStartedAt ?? 0) + INTERVAL - this.now()), pauseHttpStatus: (this.ledger.nextAllowedAt ?? 0) > this.now() && this.ledger.pauseHttpStatus === 541 ? 541 : null, completedChecks: this.ledger.successes ?? 0 };
    } catch(error) { markWorkerStage(error,'network-proof');throw error; }
  }
  async sample(selection, expectedFingerprint) {
    validateSelection(selection);
    if (this.busy || this.stopping) throw Error('WORKER_BUSY');
    const next = Math.max(this.ledger.nextAllowedAt ?? 0, (this.ledger.lastStartedAt ?? 0) + INTERVAL);
    if (next > this.now()) throw Object.assign(Error('NODE_WAIT'), { nextAllowedAt: next });
    // A later transport failure has its own cooldown. It must not revive
    // the reason of an Apple pause that has already expired.
    if (this.ledger.pauseHttpStatus === 541) this.ledger.pauseHttpStatus = null;
    this.busy = true;
    let workerStage='network-proof';
    try {
      const proof = await this.network();
      if (proof.fingerprint !== expectedFingerprint) throw Error('ROUTE_CHANGED');
      if (this.browserNeedsReset) {
        workerStage='browser-reset';
        await this.browser?.close(); this.browser = null; this.browserNeedsReset = false;
      }
      this.ledger.lastStartedAt = this.now(); this.ledger.nextAllowedAt = this.now() + INTERVAL; this.ledger.attempts = (this.ledger.attempts ?? 0) + 1; this.save();
      workerStage='browser-startup';this.browser ??= await this.browserFactory();
      workerStage='stock-request';
      const result = await pickupRequest(selection, this.browser.fetch.bind(this.browser), this.now);
      this.ledger.successes = (this.ledger.successes ?? 0) + 1; this.ledger.pauseHttpStatus = null;
      return { ...result, nextAllowedInMs: INTERVAL };
    } catch (e) {
      markWorkerStage(e,workerStage);
      this.ledger.nextAllowedAt = Math.max(this.ledger.nextAllowedAt ?? 0, e.nextAllowedAt ?? 0, e.httpStatus === 541 ? this.now() + 300000 : 0);
      if (e.httpStatus === 541) this.ledger.pauseHttpStatus = 541;
      if (e.httpStatus === 541 && this.browser) {
        // The pool closes on an Apple refusal. Reuse is forbidden even after
        // the server pause ends; retain it only until closure is verified.
        this.browserNeedsReset = true;
        try { await this.browser.close(); this.browser = null; this.browserNeedsReset = false; } catch {}
      }
      throw e;
    } finally { this.ledger.nextAllowedAt = Math.max(this.ledger.nextAllowedAt ?? 0, this.now() + INTERVAL); this.save(); this.busy = false; }
  }
  async close() { this.stopping = true; while (this.busy) await new Promise(r => setTimeout(r, 50)); try { await this.browser?.close(); this.browser = null; this.browserNeedsReset = false; } finally { this.stopping = false; } }
}
export async function linuxNetwork({ run = execFile, readProvider = () => existsSync('/etc/iphone-stock/vpn-provider.json') ? JSON.parse(readFileSync('/etc/iphone-stock/vpn-provider.json','utf8')) : {provider:'nordvpn'} } = {}) {
  const options = { timeout: 12000, maxBuffer: 8192, env: { ...process.env, LC_ALL: 'C', LANG: 'C' } };
  const provider=validateVpnProvider(readProvider());
  if(provider.provider==='windscribe') {
    const result=await run('/usr/bin/flock',['-w','10','/run/lock/apple-loop-vpn-cli.lock','/opt/windscribe/windscribe-cli','status'],options);
    const state=parseWindscribeStatus(String(result.stdout??'')+String(result.stderr??''),provider.location);
    if(!state.loggedIn||state.connected!==true||!state.pinned||!state.firewallOn)throw Error('TUNNEL_UNVERIFIED');
    const ip=JSON.parse((await run('/usr/bin/curl',['-fsS','--max-time','10','--proto','=https','https://api4.ipify.org?format=json'],options)).stdout).ip;
    if(isIP(ip)!==4)throw Error('TUNNEL_UNVERIFIED');
    return {fingerprint:createHash('sha256').update(ip).digest('hex'),vpn:'protected'};
  }
  const status = (await run('/usr/bin/nordvpn', ['status'], options)).stdout;
  const settings = (await run('/usr/bin/nordvpn', ['settings'], options)).stdout;
  const pin = readFileSync('/etc/iphone-stock/nordvpn-server', 'utf8').trim();
  const server = /^Hostname: (jp[0-9]+)\.nordvpn\.com\s*$/m.exec(status)?.[1];
  if (!/^jp\d+$/.test(pin) || server !== pin || !/^Status: Connected\s*$/m.test(status) || !/^Kill Switch: enabled\s*$/im.test(settings)) throw Error('TUNNEL_UNVERIFIED');
  const ip = JSON.parse((await run('/usr/bin/curl', ['-fsS', '--max-time', '10', '--proto', '=https', 'https://api4.ipify.org?format=json'], options)).stdout).ip;
  if (isIP(ip) !== 4) throw Error('TUNNEL_UNVERIFIED');
  return { fingerprint: createHash('sha256').update(ip).digest('hex'), vpn: 'protected' };
}
export function safeWorkerFailure(error, now = Date.now()) {
  const status = Number.isInteger(error?.httpStatus) ? error.httpStatus : null;
  const code = error?.code === 'challenge' || error?.workerCode === 'security-challenge' ? 'challenge' : ['ROUTE_CHANGED', 'NODE_WAIT', 'WORKER_BUSY', 'TUNNEL_UNVERIFIED', 'STOCK_STALE', 'STOCK_UNKNOWN', 'STOCK_WRONG_PRODUCT'].includes(error?.message) ? error.message : 'transport';
  return { ok: false, code, httpStatus: status, nextAllowedInMs: Math.max(0, (error?.nextAllowedAt ?? 0) - now),...safeWorkerContext(error) };
}
// Diagnostic enums only: provider/browser text may contain private URLs or IPs.
export function safeWorkerContext(value) {
  return {...(['network-proof','browser-reset','browser-startup','stock-request'].includes(value?.workerStage)?{workerStage:value.workerStage}:{}),...(['profile-lock','profile-marker','permissions','missing-library','missing-module','sandbox','tls','network','browser-startup','unknown'].includes(value?.failureCategory)?{failureCategory:value.failureCategory}:{}),...safeBrowserFailureMetadata(value)};
}
