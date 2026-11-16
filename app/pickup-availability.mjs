// Runs only inside an already owned checkout tab. No requests, clicks, or
// payment decisions: this returns an advisory from a recent pickup response.
export function freshPickupAvailability(p = {}) {
  try {
    const visible = e => Boolean(e && e.getClientRects().length);
    const disabled = e => Boolean(e.disabled || e.matches?.(':disabled') || e.getAttribute('aria-disabled') === 'true');
    const all = s => [...document.querySelectorAll(s)];
    const normal = s => String(s ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
    const trusted = u => u.protocol === 'https:' && (u.hostname === 'www.apple.com' || /^secure\d+\.store\.apple\.com$/.test(u.hostname)) && u.pathname.startsWith('/jp/shop/');
    const url = new URL(location.href);
    if (!trusted(url) || url.pathname !== '/jp/shop/apw/checkout' || url.searchParams.get('_s') !== 'Fulfillment-init' || document.readyState !== 'complete') return null;
    if (!/^[a-f0-9-]{36}$/.test(p.nonce ?? '') || window.name !== 'ApplePickupLoop:' + p.nonce || !/^[A-Z0-9]{5,12}J\/A$/.test(p.sku ?? '') || !Number.isSafeInteger(p.priceJPY) || p.priceJPY <= 0 || !Array.isArray(p.stores) || !p.stores.length || p.stores.length > 20 || p.stores.some(id => !/^R\d{3}$/.test(id))) return null;
    const payment = window.__applePickupPayment;
    if (payment?.observed || payment?.active || payment?.authorized || payment?.completed || document.documentElement.hasAttribute('data-apple-loop-pay-dispatched')) return null;
    if (all('[aria-busy="true"],.rs-processing,[data-autom="processing"],[aria-modal="true"],[role="alertdialog"],.rs-checkout-sessionextender,.rs-session-expire').some(visible)) return null;
    if (all('[role="alert"],.form-alert.is-error,.rs-messages-error').some(e => visible(e) && [e.innerText, e.getAttribute('aria-label'), e.textContent].some(v => Boolean(normal(v))))) return null;
    const modes = all('[role="radio"]').filter(e => visible(e) && e.getAttribute('aria-checked') === 'true');
    if (modes.length !== 1 || !/^(?:お客様がご自身で受け取る|Customers receive it themselves\.|Pick up)$/i.test(normal(modes[0].innerText))) return null;
    const input = document.getElementById('checkout.fulfillment.pickupTab.pickup.storeLocator.searchInput');
    if (visible(input)) return null; // Leave an unfinished postal edit alone.
    const totals = all('.rs-companionbar-button-amount').filter(visible);
    if (totals.length !== 1) return null;
    const amounts = [...normal(totals[0].textContent).matchAll(/([0-9][0-9,]*)\s*円|[¥￥]\s*([0-9][0-9,]*)/g)];
    if (amounts.length !== 1 || Number((amounts[0][1] ?? amounts[0][2]).replaceAll(',', '')) !== p.priceJPY) return null;
    const change = window.__applePickupFulfillmentChange, selection = window.__applePickupStoreSelection;
    if (selection && selection.responseComplete !== true) return null;
    const now = performance.now();
    if (!change || change.mode !== 'pickup' || change.responseComplete !== true || !Number.isFinite(change.startedAt) || !Number.isFinite(change.responseAt) || now - change.responseAt < 150 || !Number.isFinite(performance.timeOrigin)) return null;
    const baseline=change.availabilityBaseline;
    if(baseline?.version!==1||baseline.sku!==p.sku||!Number.isFinite(baseline.at)||baseline.at>change.startedAt||change.startedAt-baseline.at>30000||now-baseline.at>35000||!Array.isArray(baseline.stores)||!baseline.stores.length||baseline.stores.length>20||baseline.stores.some(s=>!s||!p.stores.includes(s.id)||typeof s.available!=='boolean')||new Set(baseline.stores.map(s=>s.id)).size!==baseline.stores.length)return null;
    const previous=new Map(baseline.stores.map(s=>[s.id,s.available]));
    const responses = performance.getEntriesByType('resource').filter(entry => {
      if (!['fetch','xmlhttprequest'].includes(entry.initiatorType) || entry.startTime < change.startedAt || entry.responseEnd <= 0 || entry.responseEnd > change.responseAt) return false;
      try { const u = new URL(entry.name); return trusted(u) && u.searchParams.get('_m') === 'checkout.fulfillment.fulfillmentOptions' && u.searchParams.get('_a') === 'selectFulfillmentLocationAction'; } catch { return false; }
    });
    if (responses.length !== 1) return null;
    const response = responses[0], age = now - response.responseEnd, observedAt = Math.floor(performance.timeOrigin + response.responseEnd);
    // Actual responseEnd controls freshness; a late observer callback cannot
    // turn an old response or a new DOM mutation into a fresh availability.
    if (age < 150 || age > 5000 || !Number.isSafeInteger(observedAt) || observedAt <= 0 || Date.now() - observedAt < -250 || Date.now() - observedAt > 5000) return null;
    const rows = all('input[name="store-locator-result"]').filter(e => p.stores.includes(e.value) && [...(e.labels ?? [])].some(visible));
    if (new Set(rows.map(e => e.value)).size !== rows.length) return null;
    const stores = rows.filter(e => previous.get(e.value)===false && !disabled(e) && !/現在ご購入いただけません|unavailable|not available/i.test([...(e.labels ?? [])].map(label => normal(label.innerText)).join(' '))).map(e => ({ id:e.value, state:'available' }));
    return stores.length ? { sku:p.sku, observedAt, stores, origin:'safari-pickup-response' } : null;
  } catch { return null; }
}
