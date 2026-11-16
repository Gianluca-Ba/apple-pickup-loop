import { retryAt } from './shared.mjs';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareGuestProfile } from './guest-profile.mjs';
import { createStockIdleMedia } from './stock-idle-media.mjs';

const origin = 'https://www.apple.com';
const warmupURL = `${origin}/jp/`;
const allowedHeaders = ['content-type', 'age', 'retry-after', 'date', 'cache-control'];

function startupFailure(status, headers, now) {
  const deadline = retryAt(headers['retry-after'], now);
  if (status >= 200 && status < 300 && !(deadline > now)) return null;
  const error = Error(`Guest Chromium startup HTTP ${status}`);
  error.httpStatus = status; error.nextAllowedAt = deadline;
  error.cooldownSource = deadline === null ? null : 'apple-retry-after';
  return error;
}

export async function createChromiumStockSession(dependencies = {}) {
  let launch = dependencies.launch;
  let launchPersistentContext = dependencies.launchPersistentContext;
  const profileMode = dependencies.profileMode ?? 'isolated-context';
  if (!['isolated-context', 'temporary-normal', 'persistent-guest'].includes(profileMode)) throw Error('Unsupported guest profile mode');
  const ordinaryProfile = profileMode !== 'isolated-context';
  if ((!launch && !ordinaryProfile) || (!launchPersistentContext && ordinaryProfile)) {
    const { chromium } = await import('playwright');
    launch ??= options => chromium.launch(options);
    launchPersistentContext ??= (directory, options) => chromium.launchPersistentContext(directory, options);
  }
  const mode = dependencies.browserMode ?? 'headless';
  if (!['headed', 'headless'].includes(mode)) throw Error('Unsupported guest browser mode');
  const channel = dependencies.browserChannel ?? 'chromium';
  if (!['chromium', 'chrome'].includes(channel)) throw Error('Unsupported guest browser channel');
  const now = dependencies.now ?? Date.now;
  const monotonic = dependencies.monotonic ?? (() => performance.now());
  const sleep = dependencies.sleep ?? delay;
  const emit = value => { try { dependencies.onDiagnostic?.(value); } catch {} };
  let browser; let context; let page; let profileDirectory; let removeProfileOnClose = false; let closed = false; let busy = false; let closing; let lastRequestAt = null;
  let appleRequests = 0; let otherRequests = 0; let idle;
  const quietWhenIdle = dependencies.quietWhenIdle ?? (mode === 'headed' && channel === 'chromium' && profileMode === 'persistent-guest');
  const sessionSummary = async () => {
    const cookies = context.cookies ? await context.cookies(origin) : [];
    const persistent = cookies.filter(cookie => cookie.expires > 0);
    return { sessionCookies: cookies.length - persistent.length, persistentCookies: persistent.length,
      earliestCookieExpiryAt: persistent.length ? Math.min(...persistent.map(cookie => Math.round(cookie.expires * 1000))) : undefined,
      appleRequests, otherRequests };
  };
  const close = () => {
    if (closing) return closing;
    closed = true; dependencies.signal?.removeEventListener('abort', onAbort);
    closing = (async () => {
      try { try { await context?.close(); } finally { await browser?.close(); } }
      finally { if (removeProfileOnClose && profileDirectory) rmSync(profileDirectory, { recursive: true, force: true }); }
    })();
    return closing;
  };
  const onAbort = () => { void close().catch(() => {}); };
  try {
    dependencies.signal?.throwIfAborted();
    emit({ stage: 'browser-starting' });
    const contextOptions = { locale: 'ja-JP', timezoneId: 'Asia/Tokyo', acceptDownloads: false, ...(quietWhenIdle ? { reducedMotion:'reduce' } : {}) };
    const sandboxOptions = process.platform === 'linux' ? { chromiumSandbox: true } : {};
    if (ordinaryProfile) {
      if (profileMode === 'persistent-guest') profileDirectory = prepareGuestProfile(dependencies.guestProfileDirectory);
      else {
        profileDirectory = mkdtempSync(join(tmpdir(), 'iphone-duo-guest-')); chmodSync(profileDirectory, 0o700);
        removeProfileOnClose = true;
      }
      context = await launchPersistentContext(profileDirectory, { channel, headless: mode === 'headless', timeout: 15000, ...sandboxOptions, ...contextOptions });
      browser = context.browser();
    } else {
      browser = await launch({ channel, headless: mode === 'headless', timeout: 15000, ...sandboxOptions });
      context = await browser.newContext(contextOptions);
    }
    const version = browser.version?.();
    emit({ stage: 'browser-engine', browserMode: mode, channel, profileMode, version: typeof version === 'string' && /^\d+(?:\.\d+){1,4}$/.test(version) ? version : undefined, identityOverrides: false });
    dependencies.signal?.addEventListener('abort', onAbort, { once: true });
    dependencies.signal?.throwIfAborted();
    page = ordinaryProfile ? context.pages()[0] ?? await context.newPage() : await context.newPage();
    page.on?.('request', request => {
      try { const host = new URL(request.url()).hostname; if (host === 'apple.com' || host.endsWith('.apple.com')) appleRequests++; else otherRequests++; } catch {}
    });
    page.setDefaultTimeout(10000);
    const response = await page.goto(warmupURL, { waitUntil: 'load', timeout: 45000 });
    if (!response) throw Error('Guest Chromium startup response missing');
    const initialHeaders = await response.allHeaders();
    const safeHeaders = Object.fromEntries(allowedHeaders.filter(name => initialHeaders[name] !== undefined).map(name => [name, initialHeaders[name]]));
    emit({ stage: 'warmup-response', status: response.status(), retryAfterAt: retryAt(safeHeaders['retry-after'], now()), ...await sessionSummary() });
    const failure = startupFailure(response.status(), safeHeaders, now());
    if (failure) { failure.httpStage = 'warmup-response'; throw failure; }
    const current = new URL(page.url());
    if (current.origin !== origin || !(current.pathname === '/jp/' || current.pathname.startsWith('/jp/shop/'))) throw Error('Guest Chromium left the public Japan site');
    const challenged = await page.locator('h1,h2,[role="alert"]').allTextContents();
    if (challenged.some(text => /captcha|verify (?:you are|your identity)|access denied|unusual traffic|アクセスが拒否|ロボットではない/i.test(text))) throw Error('Guest Chromium security challenge requires user action');
    idle = createStockIdleMedia({ context, page, emit, enabled:quietWhenIdle });
    await idle.quiet();
    emit({ stage: 'browser-ready', authenticated: false, storage: profileMode === 'persistent-guest' ? 'private-persistent-guest-profile' : ordinaryProfile ? 'private-temporary-profile' : 'memory-only' });
    return {
      transport: 'chromium-guest',
      idleState: () => idle.snapshot(),
      async fetch(url, options = {}) {
        if (closed) throw Error('Guest Chromium session is closed');
        if (busy) throw Error('Guest Chromium accepts only one stock request at a time');
        if (!(url instanceof URL) || url.origin !== origin || url.pathname !== '/jp/shop/retail/pickup-message' || options.method !== 'GET') throw Error('Unexpected guest stock destination or method');
        const address = new URL(url.href);
        if (address.searchParams.has('mts.0') && address.searchParams.get('mts.0') !== 'regular') throw Error('Unexpected stock message type');
        address.searchParams.set('mts.0', 'regular');
        options.signal?.throwIfAborted();
        busy = true;
        const abort = () => { void close().catch(() => {}); };
        options.signal?.addEventListener('abort', abort, { once: true });
        try {
          while (lastRequestAt !== null && monotonic() - lastRequestAt < 2000) await sleep(Math.ceil(2000 - (monotonic() - lastRequestAt)), undefined, { signal: options.signal });
          options.signal?.throwIfAborted();
          if (closed) throw Error('Guest Chromium session is closed');
          lastRequestAt = monotonic();
          const result = await page.evaluate(async address => {
            if (location.origin !== 'https://www.apple.com' || !(location.pathname === '/jp/' || location.pathname.startsWith('/jp/shop/'))) throw Error('Guest page changed');
            const response = await fetch(address, { method: 'GET', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store', headers: { accept: 'application/json, text/javascript, */*; q=0.01', 'X-Requested-With': 'XMLHttpRequest' }, signal: AbortSignal.timeout(10000) });
            const body = await response.text();
            if (new TextEncoder().encode(body).byteLength > 1048576) throw Error('Stock response too large');
            const headers = {};
            for (const name of ['content-type', 'age', 'retry-after', 'date', 'cache-control']) { const value = response.headers.get(name); if (value !== null) headers[name] = value; }
            return { status: response.status, headers, body };
          }, address.href);
          const contentType = /^(application\/json|text\/html|text\/plain)(?:;|$)/i.exec(result.headers['content-type'] ?? '')?.[1]?.toLowerCase() ?? 'other';
          emit({ stage: 'stock-response', status: result.status, contentType, retryAfterAt: retryAt(result.headers['retry-after'], now()), ...await sessionSummary() });
          if (contentType === 'text/html' && /captcha|verify (?:you are|your identity)|unusual traffic|ロボットではない/i.test(result.body)) {
            const error = Error('Guest Chromium security challenge requires user action'); error.workerCode = 'security-challenge'; throw error;
          }
          const deadline = retryAt(result.headers['retry-after'], now());
          if (result.status >= 200 && result.status < 300 && deadline > now()) {
            const error = Error('Apple requested Retry-After during guest monitoring');
            error.httpStatus = result.status; error.nextAllowedAt = deadline; error.cooldownSource = 'apple-retry-after'; throw error;
          }
          return new Response(result.body || null, { status: result.status, headers: result.headers });
        } finally { await idle.quiet(); busy = false; options.signal?.removeEventListener('abort', abort); }
      },
      close,
    };
  } catch (error) {
    try { await close(); } catch {}
    throw error;
  }
}
