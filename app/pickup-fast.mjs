import { pageDOM } from './page-dom.mjs';
import { pickupScheduleDOM } from './pickup-time.mjs';
import { createHash } from 'node:crypto';

// Serialized with its two DOM readers. Observers only collect public readiness
// facts; every mutation still arrives through a fresh native guarded command.
function fastPickup(p, page, calendar, version) {
  const key = version + ':' + p.selection.sku + ':' + p.storeId;
  let watch = window.__applePickupReadiness;
  if (!watch || watch.key !== key || watch.body !== document.body || watch.closed) {
    watch?.close();
    watch = { key, body: document.body, revision: 0, lastUsed: performance.now(), at: -Infinity, dirty: true, closed: false };
    const update = () => {
      if (watch.closed) return;
      if (performance.now() - watch.lastUsed > 30000) { watch.close(); return; }
      watch.dirty = false; watch.at = performance.now(); watch.revision++;
      try {
        const state = page({ action: 'inspect', selection: p.selection, storeId: p.storeId });
        if (state.phase === 'authentication') throw Error('LOGIN_REQUIRED');
        if (state.phase === 'expired') throw Error('PREORDER_SESSION_EXPIRED');
        if (state.phase === 'unavailable') throw Error('PREORDER_PAGE_UNAVAILABLE');
        if (state.phase !== 'pickup' || state.paymentActive || state.paymentObserved || state.paymentDispatched || state.paymentCompleted) throw Error('EXISTING_CHECKOUT');
        if (state.sessionWarning) throw Error('SESSION_EXTENSION_REQUIRED');
        watch.value = calendar({ action: 'read', storeId: p.storeId, storeLabels: p.storeLabels }); watch.error = null;
      } catch (error) { watch.value = null; watch.error = error; }
    };
    const changed = () => { watch.dirty = true; update(); };
    const resource = () => { watch.dirty = true; if (!watch.queued) { watch.queued = true; queueMicrotask(() => { watch.queued = false; update(); }); } };
    watch.observer = new MutationObserver(changed);
    watch.observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    if (typeof PerformanceObserver === 'function' && PerformanceObserver.supportedEntryTypes?.includes('resource')) {
      watch.resources = new PerformanceObserver(resource); watch.resources.observe({ entryTypes: ['resource'] });
    }
    for (const event of ['input','change','click']) document.addEventListener(event, changed, true);
    watch.close = () => {
      watch.closed = true; watch.observer.disconnect(); watch.resources?.disconnect();
      for (const event of ['input','change','click']) document.removeEventListener(event, changed, true);
      window.removeEventListener('pagehide', watch.close);
    };
    window.addEventListener('pagehide', watch.close, { once: true }); watch.update = update;
    window.__applePickupReadiness = watch;
  }
  watch.lastUsed = performance.now();
  const read = (force = false) => {
    if (watch.observer.takeRecords().length) watch.dirty = true;
    if (force || watch.dirty || performance.now() - watch.at >= 100) watch.update();
    if (watch.error) throw watch.error;
    return { ...watch.value, readinessWatch: true, readinessRevision: watch.revision, readinessBuild:version };
  };
  if (p.action === 'store-calendar') {
    const state = page({ action: 'store-state', selection: p.selection, storeId: p.storeId });
    if (state.phase !== 'pickup' || state.pending || state.ready === false || state.sessionWarning || state.paymentObserved || state.paymentDispatched || state.paymentCompleted) throw Error('PAGE_BUSY');
    const result = page({ action: 'store', selection: p.selection, storeId: p.storeId });
    return { ...result, ...(result.selected ? { calendar: read(true) } : {}) };
  }
  if (p.action === 'date' || p.action === 'slot') {
    // Never trust a cached snapshot as permission for a date/slot mutation.
    read(true);
    const mutation=calendar({ action: p.action, storeId: p.storeId, storeLabels: p.storeLabels, dateId: p.dateId, value: p.value });
    return { ...read(true), readAfterMutation: true, selectionChanged:mutation.changed===true };
  }
  if (p.action !== 'read') throw Error('INVALID_COMMAND');
  return read();
}

export function createPickupFastDOM(pageReader=pageDOM,calendarReader=pickupScheduleDOM) {
  const source=pageReader.toString()+'\n'+calendarReader.toString()+'\n'+fastPickup.toString();
  const version=createHash('sha256').update(source).digest('hex').slice(0,16);
  return new Function('return function pickupFastDOM(p){const page=' + pageReader.toString() + ';const calendar=' + calendarReader.toString() + ';return (' + fastPickup.toString() + ')(p,page,calendar,'+JSON.stringify(version)+');}')();
}
export const pickupFastDOM = createPickupFastDOM();
