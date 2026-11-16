import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename } from 'node:path';

const runLog = promisify(execFile);
const timestamp = value => typeof value === 'string' ? Date.parse(value.replace(' ', 'T').replace(/([+-]\d{2})(\d{2})$/, '$1:$2')) : NaN;
export const WALLET_EVIDENCE_WINDOW_MS = 900000;
const extension = 'com.apple.PassKit.PaymentAuthorizationUIExtension';
export function parseNativeWalletFailure(records, { pressedAt, openedAt, now }) {
  if (!Array.isArray(records) || !Number.isSafeInteger(pressedAt) || !Number.isSafeInteger(openedAt) || openedAt < pressedAt || openedAt > now || now - pressedAt > WALLET_EVIDENCE_WINDOW_MS) return null;
  const scoped = records.filter(x => x?.subsystem === 'com.apple.passkit' && basename(x.processImagePath ?? '') === extension && Number.isSafeInteger(x.processID) && x.processID > 0 && timestamp(x.timestamp) >= pressedAt && timestamp(x.timestamp) <= now);
  const finishes = scoped.filter(x => x.category === 'PaymentUI' && basename(x.senderImagePath ?? '') === 'PassKitMacHelper' && /\bfailure\b.*\bcompleted\b|\bcompleted\b.*\bfailure\b/i.test(x.eventMessage ?? '') && timestamp(x.timestamp) >= openedAt);
  if (finishes.length !== 1 || scoped.some(x => x.category === 'PaymentUI' && /\b(?:success|succeeded)\b.*\bcompleted\b|\bcompleted\b.*\b(?:success|succeeded)\b/i.test(x.eventMessage ?? ''))) return null;
  const final = finishes[0], failedAt = Math.trunc(timestamp(final.timestamp));
  const decline = scoped.filter(x => x.category === 'PaymentAuth' && basename(x.senderImagePath ?? '') === 'PassKitCore' && x.processID === final.processID && /\btransaction\b.*\bdeclined\b/i.test(x.eventMessage ?? '') && timestamp(x.timestamp) >= openedAt && timestamp(x.timestamp) <= failedAt && failedAt - timestamp(x.timestamp) <= 10000);
  return decline.length === 1 ? { source:'native-wallet-completed-failure', failedAt } : null;
}

export async function readNativeWalletFailure(context, { run = runLog } = {}) {
  if (process.env.CHECKOUT_DISABLE_NATIVE === '1' && run === runLog) return null;
  const now = context.now;
  if (!Number.isSafeInteger(context.pressedAt) || !Number.isSafeInteger(context.openedAt) || now - context.pressedAt > WALLET_EVIDENCE_WINDOW_MS || now - context.pressedAt < 30000 || Intl.DateTimeFormat().resolvedOptions().timeZone !== 'Asia/Tokyo') return null;
  const local = at => new Date(at).toLocaleString('sv-SE', { timeZone:'Asia/Tokyo', hour12:false });
  try {
    const { stdout } = await run('/usr/bin/log', ['show','--start',local(context.pressedAt - 1000),'--end',local(now + 1000),'--style','json','--predicate','subsystem == "com.apple.passkit"'], { timeout:8000,maxBuffer:8000000 });
    // Raw messages remain in memory. Only a terminal enum and JST-compatible
    // timestamp can leave this module; no payment fields or log text are saved.
    return parseNativeWalletFailure(JSON.parse(stdout), context);
  } catch { return null; }
}
