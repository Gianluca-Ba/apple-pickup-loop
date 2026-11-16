import { validatePickupContact, validateSelection, jst } from './shared.mjs';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { dirname } from 'node:path';
export function readJSON(path, fallback) { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : structuredClone(fallback); }
export function writeJSON(path, data) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path + '.tmp', 'w', 0o600);
  try { writeFileSync(fd, JSON.stringify(data) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(path + '.tmp', path);
  const directory = openSync(dirname(path), 'r');
  try { try { fsyncSync(directory); } catch (e) { if (!['EINVAL','ENOTSUP'].includes(e.code)) throw e; } } finally { closeSync(directory); }
}
export class AppStorage {
  constructor(directory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.directory = directory;
    this.settings = readJSON(directory + '/settings.json', { version: 2, selection: null, positions: 1, vpnLimit: 1, workerCount: 1, nordLimit: 1 });
    this.settings.workerCount??=19;this.settings.standbyTarget??=0;this.settings.nordLimit??=10;
    if(!Number.isInteger(this.settings.nordLimit)||this.settings.nordLimit<0||this.settings.nordLimit>10)throw Error('SETTINGS_INVALID');
    if(this.settings.standbyTarget===0&&this.settings.vpnLimit>10)throw Error('SETTINGS_INVALID');
    if (this.settings.version !== 2 || !Number.isInteger(this.settings.workerCount)||this.settings.workerCount<1||this.settings.workerCount>30||!Number.isInteger(this.settings.standbyTarget)||this.settings.standbyTarget<0||!Number.isInteger(this.settings.positions) || !Number.isInteger(this.settings.vpnLimit) || this.settings.positions < 1 || this.settings.positions>20||this.settings.positions > this.settings.vpnLimit || this.settings.vpnLimit > this.settings.workerCount||this.settings.standbyTarget>this.settings.vpnLimit-this.settings.positions) throw Error('SETTINGS_INVALID');
    this.settings.alternativeSelections ??= [];
    if (!Array.isArray(this.settings.alternativeSelections) || this.settings.alternativeSelections.length > 1) throw Error('SETTINGS_INVALID');
    for (const alternative of this.settings.alternativeSelections) { validateSelection(alternative); if (!this.settings.selection || alternative.sku === this.settings.selection.sku || alternative.productId !== this.settings.selection.productId || alternative.priceJPY !== this.settings.selection.priceJPY || !/256\s*GB/i.test(alternative.name) || !/256\s*GB/i.test(this.settings.selection.name)) throw Error('SETTINGS_INVALID'); }
    this.settings.pickupContact = this.settings.pickupContact ? validatePickupContact(this.settings.pickupContact) : null;
    this.statistics = readJSON(directory + '/statistics.json', { version: 2, checks: 0, attempts: 0, failures: 0, successes: 0, history: [] });
    const migrateAttempts = !Object.hasOwn(this.statistics, 'checkoutAttempts');
    if (migrateAttempts) this.statistics.checkoutAttempts = 0;
    const migrateProgress = !Object.hasOwn(this.statistics, 'checkoutProgress');
    if (migrateProgress) this.statistics.checkoutProgress = { store:0, date:0, time:0, sinceJST:jst(Date.now()), attempt:0, stages:[] };
    const progress = this.statistics.checkoutProgress;
    if (!progress || ['store','date','time','attempt'].some(k => !Number.isSafeInteger(progress[k]) || progress[k] < 0 || progress[k] > this.statistics.checkoutAttempts) || !Array.isArray(progress.stages) || progress.stages.some(k => !['store','date','time'].includes(k)) || new Set(progress.stages).size !== progress.stages.length || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} JST$/.test(progress.sinceJST ?? '')) throw Error('STATISTICS_INVALID');
    this.statistics.checkoutHistory ??= [];
    if (!Array.isArray(this.statistics.checkoutHistory)) throw Error('STATISTICS_INVALID');
    this.checkoutTimings = readJSON(directory + '/checkout-timings.json', []);
    if (!Array.isArray(this.checkoutTimings)) this.checkoutTimings = [];
    this.guard = readJSON(directory + '/payment-guard.json', { version: 2, phase: 'idle', attempt: null });
    if (this.guard.version !== 2 || !['idle','intent','waiting','uncertain','failed','completed'].includes(this.guard.phase) || ['intent','waiting','uncertain','completed','failed'].includes(this.guard.phase) && (!/^[a-f0-9-]{36}$/.test(this.guard.attempt?.id ?? '') || !Number.isSafeInteger(this.guard.attempt?.pressedAt) || !/^R\d{3}$/.test(this.guard.attempt?.storeId ?? ''))) throw Error('PAYMENT_GUARD_INVALID');
    if (this.guard.attempt?.selection) validateSelection(this.guard.attempt.selection);
    if (this.guard.attempt?.purpose) { if (this.guard.attempt.purpose !== 'open-apple-pay-only') throw Error('PAYMENT_GUARD_INVALID'); validateSelection(this.guard.attempt.selection); }
    if (!Array.isArray(this.statistics.history) || ['checks','checkoutAttempts','attempts','failures','successes'].some(k => !Number.isSafeInteger(this.statistics[k]) || this.statistics[k] < 0)) throw Error('STATISTICS_INVALID');
    if (migrateAttempts || migrateProgress) this.saveStatistics();
  }
  saveCheckoutTiming(input) {
    const number = n => Number.isSafeInteger(n) && n >= 0 ? n : 0;
    const code = s => typeof s === 'string' && /^[A-Z][A-Z_0-9]{0,79}$/.test(s) ? s : 'UNKNOWN';
    const date = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} JST$/.test(s) ? s : null;
    const networkFields=v=>Object.fromEntries(['firstByteMs','downloadMs','connectMs','requestStartAfterSubmitMs','verifiedAfterResponseMs'].filter(k=>Number.isSafeInteger(v[k])&&v[k]>=0&&v[k]<=300000).map(k=>[k,v[k]]));
    const trace = { attempt: number(input.attempt), sku: /^[A-Z0-9]{5,12}J\/A$/.test(input.sku ?? '') ? input.sku : 'unknown', storeId: /^R\d{3}$/.test(input.storeId ?? '') ? input.storeId : 'unknown', startedAtJST: date(input.startedAtJST), endedAtJST: date(input.endedAtJST), totalMs: number(input.totalMs), code: code(input.code), steps: (Array.isArray(input.steps) ? input.steps : []).slice(-300).map(step => ({ name: typeof step.name === 'string' && /^[a-z][a-z0-9:-]{0,63}$/.test(step.name) ? step.name : 'unknown', offsetMs: number(step.offsetMs), durationMs: number(step.durationMs), result: step.result === 'ok' ? 'ok' : 'error', ...(step.code ? { code: code(step.code) } : {}),...networkFields(step),...(step.notDispatched===true?{notDispatched:true}:{}) })) };
    for(const k of ['signalAgeAtReceiptMs','queueWaitMs','signalToStartMs','endToEndMs','nodeRequestMs'])if(Number.isSafeInteger(input[k])&&input[k]>=0&&input[k]<=3600000)trace[k]=input[k];
    for(const k of ['signalObservedAtJST','signalReceivedAtJST'])if(date(input[k]))trace[k]=date(input[k]);
    if(['keeper','checkout','idle'].includes(input.queueBlockedBy))trace.queueBlockedBy=input.queueBlockedBy;
    if(/^pilot(?:[1-9]|[12]\d|30)$|^mac$/.test(input.node??''))trace.node=input.node;
    const previous = this.checkoutTimings.at(-1);
    if (trace.attempt > 0 && previous?.attempt === trace.attempt && previous.sku === trace.sku && previous.storeId === trace.storeId && previous.startedAtJST === trace.startedAtJST) this.checkoutTimings[this.checkoutTimings.length - 1] = trace;
    else this.checkoutTimings.push(trace);
    this.checkoutTimings = this.checkoutTimings.slice(-30); writeJSON(this.directory + '/checkout-timings.json', this.checkoutTimings); return trace;
  }
  saveSettings() { writeJSON(this.directory + '/settings.json', this.settings); }
  saveStatistics() { writeJSON(this.directory + '/statistics.json', this.statistics); }
  setGuard(phase, attempt = null) { this.guard = { version: 2, phase, attempt }; writeJSON(this.directory + '/payment-guard.json', this.guard); }
}
