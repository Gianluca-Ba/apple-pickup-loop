// Runs inside the dedicated Safari tab. Return only enums, booleans and public
// product/Store facts. Never return a URL, customer field or order reference.
export function pageDOM(p = {}) {
  const disabled = e => Boolean(e.disabled || e.matches?.(':disabled') || e.getAttribute?.('aria-disabled') === 'true');
  const visible = e => Boolean(e && e.getClientRects().length), enabled = e => visible(e) && !disabled(e);
  const all = selector => [...document.querySelectorAll(selector)], one = selector => { const a = all(selector).filter(visible); if (a.length !== 1) throw Error('CONTROL_CHANGED'); return a[0]; };
  const normal = s => String(s ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const text = normal(document.body?.innerText), u = new URL(location.href), step = u.searchParams.get('_s');
  const trusted = u.protocol === 'https:' && (u.hostname === 'www.apple.com' || /^secure\d+\.store\.apple\.com$/.test(u.hostname)) && u.pathname.startsWith('/jp/shop/');
  if (!trusted) throw Error('UNTRUSTED_PAGE');
  const headings = all('h1,h2,[role="heading"]').filter(visible).map(e => normal(e.textContent));
  const errors = all('[role="alert"],.form-alert.is-error,.rs-messages-error').filter(e => visible(e) && [e.innerText,e.getAttribute('aria-label'),e.textContent].some(value => Boolean(normal(value))));
  const busy = all('[aria-busy="true"],.rs-processing,[data-autom="processing"]').some(visible);
  const networkTimings=entry=>{const value={};const add=(k,n)=>{const v=Math.round(n);if(Number.isSafeInteger(v)&&v>=0&&v<=300000)value[k]=v;};add('connectMs',entry.connectEnd-entry.connectStart);if(entry.responseStart>0&&entry.requestStart>0){add('firstByteMs',entry.responseStart-entry.requestStart);add('downloadMs',entry.responseEnd-entry.responseStart);}return value;};
  const hook = window.__applePickupPayment;
  let phase = 'unknown';
  if (/\/signIn(?:\/|$)/i.test(u.pathname)) phase = 'authentication';
  else if (u.pathname === '/jp/shop/sorry/session_expired') phase = 'expired';
  else if (u.pathname === '/jp/shop/bag') phase = 'bag';
  else if (/\/buy-[a-z-]+\/|\/product\//.test(u.pathname)) phase = 'product';
  else if (/^\/jp\/shop\/(?:[^/]{1,250}\/)?checkout$/.test(u.pathname)) phase = ({ 'Fulfillment-init': 'pickup', 'PickupContact-init': 'contact', 'Billing-init': 'billing', Review: 'review' })[step] ?? 'loading';
  const confirmedHeading = headings.some(s => /ご注文ありがとうございます|ご注文を承りました|ご注文が完了|Thank you for your order|Your order (?:has been|is) (?:placed|confirmed)|Order confirmed/i.test(s));
  const confirmation = all('[data-autom="order-number"],[data-autom="order-confirmation-number"],.rs-confirmation-ordernumber').some(e => visible(e) && /[A-Z]\d{8,}/.test(e.textContent)) || /(?:ご注文番号|注文番号|Order Number)\s*[:：]?\s*[A-Z]\d{8,}/i.test(text);
  const compact = s => normal(s).replace(/\s/g, '').toLowerCase();
  const expectedProduct = p.selection && (p.selection.names ?? [p.selection.name]).some(name => compact(text).includes(compact(name)));
  const expectedStore = p.store && [p.store.name, p.store.localName].some(name => new RegExp('Apple\\s*' + name + '(?:\\s|$)', 'i').test(text));
  if (confirmedHeading && confirmation && expectedProduct && expectedStore && (/thank|confirm|acknowledg|order/.test(u.pathname.toLowerCase()) || /^(?:ThankYou|OrderConfirmation|Acknowledgement)(?:-init)?$/.test(step ?? ''))) phase = 'success';
  if (!['success','authentication'].includes(phase) && headings.some(s => /^(?:お探しのページは\s*見つかりません[。.]?|The page you[’']re looking for can[’']t be found\.)$/i.test(s))) phase = 'unavailable';
  const pickupUnavailable = phase === 'pickup' && headings.some(s => /^ご注文の商品のお受け取りは配送のみとなります[。.]?$/.test(s));
  const pickupRejected = phase === 'pickup' && errors.some(e => normal(e.innerText) === 'この商品は、選択した場所で受け取ることはできません。別の場所か配送オプションを選択してください。');
  const stockFailure = pickupUnavailable || pickupRejected || errors.some(e => /現在ご購入いただけません|在庫がありません|お近くでは在庫がありません|no longer available|not available|out of stock/i.test(e.innerText));
  const applePayRoute = /^\/jp\/shop\/apw\/checkout$/.test(u.pathname);
  const pickupOptionsRejected = applePayRoute && errors.some(e => {
    const message = normal(e.innerText);
    return message.includes('お客様が選択した') && message.includes('配送と受取りのオプション') &&
      message.includes('は、このご注文に対して利用できなくなりました。以下の新しいオプションを選択してください');
  });
  let merchantDiagnostics=[];
  try {
    const context=p.paymentContext;
    if(/^[a-f0-9-]{36}$/.test(context?.id??'')&&Number.isSafeInteger(context.pressedAt)&&p.observerNonce&&window.name==='ApplePickupLoop:'+p.observerNonce){
      const entry=JSON.parse(sessionStorage.getItem('apple-loop-payment-diagnostic:'+context.id));
      const jst=at=>new Date(at).toLocaleString('sv-SE',{timeZone:'Asia/Tokyo'})+' JST';
      if(entry?.attempt===context.id&&entry.owner===window.name&&entry.sku===p.selection?.sku&&typeof entry.atJST==='string'&&entry.atJST>=jst(context.pressedAt)&&entry.atJST<=jst(Date.now())&&Array.isArray(entry.codes))merchantDiagnostics=[...new Set(entry.codes.filter(c=>['PICKUP_UNAVAILABLE','PAYMENT_FAILURE','SESSION_EXPIRED'].includes(c)))];
    }
  } catch {}
  const prePaymentRejection = pickupRejected && /^\/jp\/shop\/apw\/checkout$/.test(u.pathname) && document.documentElement.hasAttribute('data-apple-loop-pay-dispatched') && Boolean(hook && !hook.observed && !hook.authorized && !hook.completed);
  const terminalFailure = errors.some(e => /お支払い.*(?:失敗|できません)|決済.*(?:失敗|キャンセル)|注文.*完了できません|payment (?:failed|declined|cancelled|canceled)|unable to (?:process|complete) (?:your )?(?:payment|order)/i.test(e.innerText));
  const payActive = Boolean(hook?.active || hook?.authorized && !hook?.completed);
  const paymentFailed = Boolean(hook?.completed && hook?.completion === 'failed');
  const paymentSucceeded = Boolean(hook?.completed && hook?.completion === 'succeeded');
  const modal = all('[aria-modal="true"],[role="alertdialog"]').some(visible);
  const fulfillmentChange = window.__applePickupFulfillmentChange;
  const fulfillmentResponsePending = Boolean(fulfillmentChange && (!fulfillmentChange.responseComplete || performance.now() - fulfillmentChange.responseAt < 150));
  const pending = payActive || busy || modal || fulfillmentResponsePending;
  const fulfillmentOptions = all('[role="radio"]').filter(visible).map(e => ({ element: e, mode: /^(お客様がご自身で受け取る|Customers receive it themselves\.|Pick up)$/i.test(normal(e.innerText)) ? 'pickup' : /^(配送を希望する|Deliver to me|Delivery|Ship)$/i.test(normal(e.innerText)) ? 'delivery' : null })).filter(o => o.mode);
  const selectedModes = fulfillmentOptions.filter(o => o.element.getAttribute('aria-checked') === 'true');
  const fulfillmentMode = phase === 'pickup' && selectedModes.length === 1 ? selectedModes[0].mode : null;
  const sessionRoots = all('.rs-checkout-sessionextender,.rs-session-expire,[role="dialog"],[role="alertdialog"],[aria-modal="true"]').filter(e => visible(e) && /session|セッション|タイムアウト|inattività|inactivity/i.test(e.innerText ?? ''));
  const sessionWarning = sessionRoots.length > 0;
  const sessionExpired = sessionRoots.some(e => /session (?:has )?expired|session has ended|セッション(?:の有効期限)?が切れました|有効期限切れ|セッションが終了しました|タイムアウトしました/i.test(e.innerText ?? ''));
  const extensionLabel = /^(?:継続|続ける|セッション(?:を|の)?延長(?:する)?|ショッピングを続ける|まだショッピング中です|Continue(?: shopping)?|Stay signed in|Extend(?: (?:your|my))? session)$/i;
  const sessionButtons = [...new Set(sessionRoots.flatMap(e => [...e.querySelectorAll('button,a[role="button"]')]))].filter(e => enabled(e) && extensionLabel.test(normal(e.innerText)));
  if (sessionExpired && phase !== 'success' && phase !== 'authentication') phase = 'expired';
  const bagRedirectReady = phase === 'product' && all('[data-autom="proceed"]').some(e => enabled(e) && /バッグを確認|Review (?:your )?bag|View bag/i.test(e.innerText));
  const applePayEntryReady = phase === 'bag' && all('button[data-autom="checkout-with-apple-pay"]').some(enabled);
  const calendarDates = all('input[name="bartPickupDateSelectorButtonGroup"]').filter(e => visible(e) || [...(e.labels ?? [])].some(visible));
  const calendarSlots = all('select[data-autom="pickup-availablewindow-dropdown"]').filter(visible);
  const pickupCalendarAvailable = phase === 'pickup' && calendarDates.length > 0 && calendarSlots.length === 1;
  const targetStore = all('input[name="store-locator-result"]').filter(e => e.value === (p.storeId ?? p.store?.id) && [...(e.labels ?? [])].some(visible));
  const pickupStoreUnavailable = phase === 'pickup' && targetStore.length === 1 && (disabled(targetStore[0]) || /現在ご購入いただけません|unavailable|not available/i.test([...targetStore[0].labels].map(e=>e.innerText).join(' ')));
  const storeState = targetStore.length !== 1 ? 'missing' : pickupStoreUnavailable ? 'unavailable' : targetStore[0].checked ? 'selected' : 'unselected';
  const snapshot = { phase, storeState, pickupCalendarAvailable, pickupStoreUnavailable, pickupUnavailable, pickupOptionsRejected, pickupNeedsAcceptance: window.__applePickupCheckoutProof?.windowMode === 'not-offered' && !window.__applePickupCheckoutProof.pickupAccepted, sessionWarning, sessionExpired, sessionExtendAvailable: !sessionExpired && sessionButtons.length === 1, fulfillmentMode, bagRedirectReady, applePayEntryReady, applePayRoute, pending, paymentActive: payActive, paymentObserved: Boolean(hook?.observed), paymentDispatched: document.documentElement.hasAttribute('data-apple-loop-pay-dispatched'), paymentCancelled: Boolean(hook?.cancelled), paymentCompleted: Boolean(hook?.completed), paymentFailed, paymentSucceeded, merchantDiagnostics, stockFailure, prePaymentRejection, terminalFailure, confirmation: phase === 'success', errors: errors.length, ready: document.readyState === 'complete' };
  const armedAttempt = document.documentElement.getAttribute('data-apple-loop-pay-dispatched');
  const checkoutReview = ['contact','billing','review'].includes(phase);
  const inputRejectionMatches = (attemptId, nonce) =>
    checkoutReview && /^[a-f0-9-]{36}$/.test(attemptId ?? '') && nonce &&
    window.name === 'ApplePickupLoop:' + nonce && armedAttempt === attemptId &&
    snapshot.ready && !snapshot.pending && !sessionWarning && hook &&
    !hook.observed && !hook.authorized && !hook.active && !hook.completed && !hook.cancelled;
  snapshot.fulfillmentResponsePending = fulfillmentResponsePending;
  snapshot.fulfillmentResponseVerified = Boolean(fulfillmentChange?.responseComplete && !fulfillmentResponsePending && fulfillmentChange.mode === fulfillmentMode);
  if (p.observeAvailability === true && Number.isFinite(fulfillmentChange?.responseAt) && Number.isFinite(performance.timeOrigin)) {
    snapshot.fulfillmentResponseAgeMs = Math.round(performance.now() - fulfillmentChange.responseAt);
    snapshot.fulfillmentResponseEpochMs = Math.floor(performance.timeOrigin + fulfillmentChange.responseAt);
  }
  const action = p.action ?? 'inspect';
  const storeSelection = window.__applePickupStoreSelection;
  snapshot.storeResponsePending = Boolean(storeSelection && !storeSelection.responseComplete);
  snapshot.pending = pending || snapshot.storeResponsePending;
  if (p.paymentContext) {
    try {
      const context = p.paymentContext;
      const proof = JSON.parse(sessionStorage.getItem('apple-loop-payment-cancel:' + context.id));
      snapshot.paymentCancelledBeforeAuthorization = Boolean(
        p.observerNonce && window.name === 'ApplePickupLoop:' + p.observerNonce &&
        proof?.owner === window.name && proof.sku === p.selection?.sku &&
        proof.at >= context.pressedAt && proof.at <= Date.now() &&
        !hook?.active && !hook?.authorized && !hook?.completed
      );
    } catch {}
    snapshot.inputRejectionReady = Boolean(inputRejectionMatches(p.paymentContext.id, p.observerNonce));
    snapshot.paymentAttemptMatches = armedAttempt === p.paymentContext.id &&
      Boolean(p.observerNonce) && window.name === 'ApplePickupLoop:' + p.observerNonce;
  }
  snapshot.storeResponseVerified = Boolean(storeSelection?.responseComplete && storeSelection.storeId === (p.storeId ?? p.store?.id));
  snapshot.fulfillmentReturnReady = Boolean(phase === 'pickup' && fulfillmentMode === 'delivery' && fulfillmentChange?.mode === 'delivery' && fulfillmentChange.responseComplete && !fulfillmentResponsePending && !payActive && !busy && !modal && !sessionWarning && !errors.length && !snapshot.storeResponsePending && !snapshot.paymentObserved && !snapshot.paymentDispatched && !snapshot.paymentCompleted && fulfillmentOptions.filter(o => o.mode === 'pickup' && enabled(o.element)).length === 1);
  const clearStoreSelection = () => { window.__applePickupStoreSelection?.observer?.disconnect(); window.__applePickupStoreSelection = null; };
  const contactNames = ['lastName','firstName','emailAddress','mobilePhone'];
  const contactField = name => document.getElementById('checkout.pickupContact.selfPickupContact.selfContact.address.' + name);
  const contactReady = () => contactNames.every(name => { const e = contactField(name); return enabled(e) && e.value.trim() && e.getAttribute('aria-invalid') !== 'true' && (!p.contact || e.value.trim() === p.contact[name]); });
  const directPayButtons = () => all('button.rs-checkout-applepay-button').filter(e => enabled(e) && /Apple\s*Pay/i.test(e.getAttribute('aria-label') ?? e.innerText));
  const amount = value => { const matches = [...normal(value).matchAll(/([0-9][0-9,]*)\s*円|[¥￥]\s*([0-9][0-9,]*)/g)]; return matches.length === 1 ? Number((matches[0][1] ?? matches[0][2]).replaceAll(',', '')) : null; };
  const selection = p.selection;
  const totalMatches = () => {
    const totals = all('.rs-companionbar-button-amount').filter(visible);
    return totals.length === 1 && amount(totals[0].textContent) === selection.priceJPY;
  };
  const productConfiguration = () => {
    const care = all('input[type="radio"]').filter(e => /applecare|apple-care|care/i.test(e.name + ' ' + e.id));
    const none = care.filter(e => /none|noapplecare|no-care|no_applecare/i.test(e.value + ' ' + e.id + ' ' + e.getAttribute('data-autom')));
    const chosen = all('input[name="partNumber"],input[name="product"],input[name="selectedPartNumber"]').filter(e => !e.disabled && e.value);
    const metrics = all('script#metrics').flatMap(e => { try { const products = JSON.parse(e.textContent)?.data?.products ?? []; return products.length === 1 && products[0].partNumber ? [products[0].partNumber] : []; } catch { return []; } });
    const identities = [...chosen.map(e => e.value), ...metrics];
    const buttons = all('button[data-autom="add-to-cart"],button[data-autom="add-to-bag"],button[name="add-to-cart"]').filter(enabled);
    return { careCount: care.length, noCareCount: none.length, noCareChecked: none.length === 1 && none[0].checked, noCareReady: none.length === 1 && enabled(none[0]), productIdentityPresent: identities.length > 0, productVerified: identities.length > 0 && identities.every(sku => sku === p.selection?.sku), addCount: buttons.length, addReady: buttons.length === 1 };
  };
  if (action === 'inspect') return snapshot;
  if (action === 'store-state') return snapshot;
  if (action === 'preferred-pickup-store') {
    const ids = p.storeIds;
    if (phase !== 'pickup' || !snapshot.applePayRoute || !snapshot.ready || fulfillmentMode !== 'pickup' ||
        snapshot.pending || sessionWarning || stockFailure || errors.length || snapshot.paymentObserved ||
        snapshot.paymentDispatched || snapshot.paymentCompleted || !totalMatches() ||
        !Array.isArray(ids) || ids.length < 2 || ids.length > 20 || new Set(ids).size !== ids.length ||
        ids.some(id => !/^R\d{3}$/.test(id) || !selection.stores.includes(id))) return {storeId:null};
    const rows=all('input[name="store-locator-result"]').filter(e=>[...(e.labels??[])].some(visible));
    // An open CAP editor or a Store selected outside this signal belongs to
    // the existing page, so keep the ordinary checkout order.
    const editor=document.getElementById('checkout.fulfillment.pickupTab.pickup.storeLocator.searchInput');
    if(visible(editor)||rows.some(e=>e.checked&&!ids.includes(e.value)))return {storeId:null};
    const state=id=>{
      const matches=rows.filter(e=>e.value===id);
      if(matches.length!==1)return matches.length?'ambiguous':'missing';
      const e=matches[0];
      return disabled(e)||/現在ご購入いただけません|unavailable|not available/i.test([...(e.labels??[])].map(l=>normal(l.innerText)).join(' '))?'unavailable':'ready';
    };
    const initial=state(ids[0]);
    if(initial!=='missing'&&initial!=='unavailable')return {storeId:null};
    return {storeId:ids.slice(1).find(id=>state(id)==='ready')??null};
  }
  if (action === 'prepared-pickup-check') {
    // Read-only verification of an already prepared, idle colour. No
    // existing checkout, Store selection or postal edit can be reused here.
    const rows = all('input[name="store-locator-result"]').filter(e => [...(e.labels ?? [])].some(visible));
    const input = document.getElementById('checkout.fulfillment.pickupTab.pickup.storeLocator.searchInput');
    const valid = phase === 'pickup' && snapshot.applePayRoute && snapshot.ready && fulfillmentMode === 'pickup' &&
      !snapshot.pending && !sessionWarning && !errors.length && !stockFailure &&
      !snapshot.paymentObserved && !snapshot.paymentDispatched && !snapshot.paymentCompleted &&
      !pickupCalendarAvailable && rows.length > 0 && !rows.some(e => e.checked) && !visible(input) && totalMatches();
    return { valid };
  }
  if (action === 'contact-state') return { ...snapshot, fieldsReady: contactNames.every(name => enabled(contactField(name))), valuesReady: contactReady(), applePayReady: directPayButtons().length === 1 };
  if (action === 'product-state') return { ...snapshot, ...productConfiguration() };
  if (action === 'postal-state') {
    const input = document.getElementById('checkout.fulfillment.pickupTab.pickup.storeLocator.searchInput');
    const search = document.getElementById('checkout.fulfillment.pickupTab.pickup.storeLocator.search');
    const refresh = window.__applePickupPostalRefresh;
    const prepared = window.__applePickupPostalPrepared;
    const edits = all('button[data-autom="fulfillment-pickup-store-search-button"]').filter(enabled);
    const storesVisible = all('input[name="store-locator-result"]').some(e => [...(e.labels ?? [])].some(visible));
    const complete = Boolean(refresh?.responseRequired && refresh.responseComplete && refresh.submitted && !pending && (pickupUnavailable || storesVisible && (!visible(input) || refresh.changed)));
    const matches = !p.refreshId || refresh?.id === p.refreshId;
    if (complete) { refresh.observer?.disconnect(); refresh.responseObserver?.disconnect(); }
    const phases=matches&&complete?{
      requestStartAfterSubmitMs:refresh.requestStartAfterSubmitMs,
      verifiedAfterResponseMs:Math.round(performance.now()-refresh.responseEnd),
    }:{};
    return { ...snapshot, inputVisible: visible(input), inputReady: enabled(input), inputHasValue: Boolean(input?.value.trim()), inputMatches: input?.value === p.postalCode, searchVisible: visible(search), searchReady: enabled(input) && enabled(search),
      storeListReady: storesVisible && !snapshot.pending && snapshot.ready, storeCount: all('input[name="store-locator-result"]').filter(e => [...(e.labels ?? [])].some(visible)).length,
      anyStoreSelected: all('input[name="store-locator-result"]').some(e => e.checked && !disabled(e)),
      pickupSelectionPromptOnly: phase === 'pickup' && fulfillmentMode === 'pickup' && !all('input[name="store-locator-result"]').some(e => e.checked) && errors.length > 0 && errors.every(e => !normal(e.innerText) || /^(?:処理を続ける前にストアを選択してください[。.]?|Please select a store before (?:continuing|proceeding)\.)$/i.test(normal(e.innerText))),
      canEdit: edits.length === 1, editorClosed: !visible(input) && edits.length === 1 && edits[0].getAttribute('aria-expanded') === 'false',
      refreshId: /^[a-f0-9-]{36}$/.test(refresh?.id ?? '') ? refresh.id : null,
      refreshPrepared: Boolean(p.refreshId && prepared?.id === p.refreshId && prepared.inputWritten && !(matches && refresh?.submitted)),
      refreshSubmitted: Boolean(matches && refresh?.responseRequired && refresh.submitted), refreshComplete: matches && complete, ...(matches&&complete?{refreshResponseMs:refresh.responseDurationMs,...Object.fromEntries(['firstByteMs','downloadMs','connectMs'].filter(k=>Number.isSafeInteger(refresh.responseNetwork?.[k])).map(k=>[k,refresh.responseNetwork[k]])),...Object.fromEntries(Object.entries(phases).filter(([,v])=>Number.isSafeInteger(v)&&v>=0&&v<=300000))}:{}) };
  }
  if (action === 'restart-success') {
    if (phase !== 'success' || pending) throw Error('CONFIRMATION_REQUIRED');
    location.assign('https://www.apple.com/jp/shop/bag'); return { requested: true };
  }
  const sessionOnlyAction = action === 'keepalive' && sessionWarning && !payActive && !document.documentElement.hasAttribute('data-apple-loop-pay-dispatched');
  const earlyPickupReturn = action === 'fulfillment-mode' && p.mode === 'pickup' && p.returnAfterDelivery === true && snapshot.fulfillmentReturnReady;
  if ((pending || snapshot.storeResponsePending && action !== 'pickup-continue') && !sessionOnlyAction && !earlyPickupReturn || phase === 'success' || phase === 'authentication') throw Error('PAGE_BUSY');
  if (sessionWarning && !sessionExpired && action !== 'keepalive') throw Error('SESSION_EXTENSION_REQUIRED');
  const click = e => { if (!enabled(e)) throw Error('CONTROL_UNAVAILABLE'); e.click(); return { requested: true }; };
  const bagTotal = () => {
    const totals = all('[data-autom="bagtotalvalue"]').filter(visible);
    const empty = /バッグは空|バッグには何も|バッグに商品はありません|バッグに商品は入っていません|Your bag is empty|bag is empty/i.test(text);
    return { valid: totals.length === 1 && amount(totals[0].textContent) === selection.priceJPY,
      empty, rendered: empty || totals.length > 0 };
  };
  if (action === 'checkout-check') { if (phase !== 'pickup' || !snapshot.applePayRoute) throw Error('PICKUP_REQUIRED'); return { valid: totalMatches() }; }
  if (action === 'bag-product-identity') {
    if (phase !== 'bag' || !bagTotal().valid) throw Error('TOTAL_CHANGED');
    const links = all('a[data-autom="bag-item-name"]');
    const matches = links.length === 1 && (() => { try { const u = new URL(links[0].href, location.href), path=decodeURIComponent(u.pathname), part=path.match(/^\/jp\/shop\/product\/([A-Z0-9]{5,12}J\/A)(?:\/|$)/i); if(u.protocol!=='https:'||u.hostname!=='www.apple.com')return false; if(part)return part[1].toUpperCase()===selection.sku; return /^\/jp\/shop\/buy-iphone\//.test(path)&&(selection.names??[selection.name]).some(name=>normal(name).replace(/\s/g,'').toLowerCase()===normal(links[0].textContent).replace(/\s/g,'').toLowerCase()); } catch { return false; } })();
    if (!matches) throw Error('PRODUCT_IDENTITY_UNVERIFIED');
    return { skuVerified: true };
  }
  if (action === 'bag-total-check') { if (phase !== 'bag') throw Error('BAG_REQUIRED'); return bagTotal(); }
  if (action === 'checkout') {
    if (phase !== 'bag' || !bagTotal().valid) throw Error('TOTAL_CHANGED');
    const buttons = all('button[data-autom="checkout-with-apple-pay"]').filter(e => enabled(e) && /Apple\s*Pay/i.test(e.innerText + ' ' + (e.getAttribute('aria-label') ?? '')));
    // Use Apple's direct Apple Pay entry, never its other-payment checkout.
    // Apple duplicates this control in the navigation and bag body.
    for (const id of ['shoppingCart.actions.navApwCheckout', 'shoppingCart.actions.apwCheckout']) {
      const matches = buttons.filter(e => e.id === id);
      if (matches.length > 1) throw Error('CHECKOUT_CONTROL_CHANGED');
      if (matches.length === 1) return { ...click(matches[0]), route: 'apple-pay' };
    }
    if (buttons.length !== 1) throw Error('CHECKOUT_CONTROL_CHANGED');
    return { ...click(buttons[0]), route: 'apple-pay' };
  }
  if (action === 'navigate') {
    const target = new URL(p.url);
    if (target.origin !== 'https://www.apple.com' || !target.pathname.startsWith('/jp/shop/') || target.search || target.hash) throw Error('UNTRUSTED_PAGE');
    const proof=p.terminalFailure;
    const now = Date.now();
    const age = now - proof?.pressedAt;
    const boundFailure = target.pathname === '/jp/shop/bag' &&
      /^[a-f0-9-]{36}$/.test(proof?.attemptId ?? '') && proof.nonce &&
      window.name === 'ApplePickupLoop:' + proof.nonce && proof.sku === p.selection?.sku &&
      Number.isSafeInteger(proof.pressedAt) && age <= 900000 && !paymentSucceeded;
    // Apple may replace the original checkout with a fulfillment rejection.
    // The message identifies the page. Wallet supplies the payment outcome.
    const replacedPickup = phase === 'loading' && pickupOptionsRejected;
    const verifiedNativeFailure = boundFailure && age >= 30000 && proof.source === 'native-wallet-completed-failure' &&
      (checkoutReview || replacedPickup && snapshot.ready && !confirmedHeading && !confirmation) &&
      (!armedAttempt || armedAttempt === proof.attemptId) && Number.isSafeInteger(proof.failedAt) &&
      proof.failedAt >= proof.pressedAt && proof.failedAt <= now;
    const verifiedInputRejection = boundFailure && age >= 2000 && proof.source === 'native-input-rejected' &&
      inputRejectionMatches(proof.attemptId, proof.nonce);
    if (proof?.source === 'operator-reviewed-pickup-refusal') {
      if (target.pathname !== '/jp/shop/bag' || phase !== 'pickup' || !applePayRoute ||
          !snapshot.ready || snapshot.pending || confirmation || confirmedHeading ||
          !/^[a-f0-9-]{36}$/.test(proof.attemptId ?? '') || armedAttempt !== proof.attemptId ||
          !proof.nonce || window.name !== 'ApplePickupLoop:' + proof.nonce || proof.sku !== selection?.sku ||
          !hook || hook.active || hook.authorized || hook.observed || hook.completed || hook.cancelled) {
        throw Error('CHECKOUT_UNCERTAIN');
      }
    }
    if (replacedPickup && !verifiedNativeFailure) throw Error('CHECKOUT_UNCERTAIN');
    if (proof?.source === 'native-input-rejected' && age < 30000 && !verifiedInputRejection) throw Error('CHECKOUT_UNCERTAIN');
    if (!['bag', 'product', 'expired', 'unavailable', 'pickup'].includes(phase) && !terminalFailure && !hook?.cancelled && !stockFailure && !paymentFailed && !verifiedNativeFailure && !verifiedInputRejection) throw Error('CHECKOUT_UNCERTAIN');
    location.assign(target.href); return { requested: true };
  }
  if (action === 'product-add') {
    if (phase !== 'product') throw Error('PRODUCT_REQUIRED');
    // Choosing no coverage may be required before Apple exposes its chosen SKU.
    // Product identity is still verified below before anything enters the bag.
    const care = all('input[type="radio"]').filter(e => /applecare|apple-care|care/i.test(e.name + ' ' + e.id));
    const none = care.filter(e => /none|noapplecare|no-care|no_applecare/i.test(e.value + ' ' + e.id + ' ' + e.getAttribute('data-autom')));
    if (care.length && (none.length !== 1 || !none[0].checked)) { if (none.length !== 1) throw Error('PRODUCT_OPTION_REQUIRED'); return { ...click(none[0]), configurationStep: true }; }
    if (!productConfiguration().productVerified) throw Error('PRODUCT_CONFIGURATION_UNVERIFIED');
    const buttons = all('button[data-autom="add-to-cart"],button[data-autom="add-to-bag"],button[name="add-to-cart"]').filter(enabled);
    if (buttons.length !== 1) throw Error('PRODUCT_CONFIGURATION_REQUIRED'); return click(buttons[0]);
  }
  if (action === 'pickup' || action === 'fulfillment-mode') {
    if (phase !== 'pickup') throw Error('PICKUP_REQUIRED');
    const mode = action === 'pickup' ? 'pickup' : p.mode;
    if (!['pickup','delivery'].includes(mode)) throw Error('FULFILLMENT_MODE_REQUIRED');
    const options = fulfillmentOptions.filter(o => o.mode === mode);
    if (options.length !== 1) throw Error('PICKUP_CONTROL_CHANGED');
    if (options[0].element.getAttribute('aria-checked') === 'true') return { selected: true, mode };
    if (!enabled(options[0].element)) throw Error('CONTROL_UNAVAILABLE');
    if (typeof PerformanceObserver !== 'function' || !PerformanceObserver.supportedEntryTypes?.includes('resource')) throw Error('FULFILLMENT_UNVERIFIED');
    // A mode acknowledgement alone does not prove that cached Store rows
    // changed. Carry the settled pickup baseline across this one D/P cycle.
    const availabilityBaseline=(()=>{try{
      if(mode==='delivery'&&fulfillmentMode==='pickup'&&selection&&totalMatches()){
        const rows=all('input[name="store-locator-result"]').filter(e=>selection.stores.includes(e.value)&&[...(e.labels??[])].some(visible));
        if(rows.length&&new Set(rows.map(e=>e.value)).size===rows.length)return{version:1,sku:selection.sku,at:performance.now(),stores:rows.map(e=>({id:e.value,available:!disabled(e)&&!/現在ご購入いただけません|unavailable|not available/i.test([...(e.labels??[])].map(l=>normal(l.innerText)).join(' '))}))};
      }
      const old=fulfillmentChange?.availabilityBaseline;
      if(mode==='pickup'&&fulfillmentChange?.mode==='delivery'&&fulfillmentChange.responseComplete===true&&old?.version===1&&old.sku===selection?.sku&&Number.isFinite(old.at)&&performance.now()-old.at>=0&&performance.now()-old.at<=30000&&Array.isArray(old.stores)&&old.stores.every(s=>s&&typeof s.id==='string'&&typeof s.available==='boolean'))return{version:1,sku:old.sku,at:old.at,stores:old.stores.map(s=>({id:s.id,available:s.available}))};
    }catch{}return undefined;})();
    const request = { mode, responseComplete: false, startedAt: performance.now(),...(availabilityBaseline?{availabilityBaseline}:{}) };
    request.observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        if (!['fetch','xmlhttprequest'].includes(entry.initiatorType) || entry.startTime < request.startedAt || entry.responseEnd <= 0) continue;
        try {
          const target = new URL(entry.name);
          if (target.protocol !== 'https:' || !(target.hostname === 'www.apple.com' || /^secure\d+\.store\.apple\.com$/.test(target.hostname)) || !target.pathname.startsWith('/jp/shop/') || target.searchParams.get('_m') !== 'checkout.fulfillment.fulfillmentOptions' || target.searchParams.get('_a') !== 'selectFulfillmentLocationAction') continue;
          request.responseComplete = true; request.responseAt = performance.now(); request.responseNetwork=networkTimings(entry); request.observer.disconnect(); break;
        } catch {}
      }
    });
    request.observer.observe({ entryTypes: ['resource'] });
    fulfillmentChange?.observer?.disconnect(); window.__applePickupFulfillmentChange = request;
    window.__applePickupCheckoutProof = null;
    clearStoreSelection();
    window.__applePickupPostalRefresh?.observer?.disconnect(); window.__applePickupPostalRefresh?.responseObserver?.disconnect(); window.__applePickupPostalRefresh = null; window.__applePickupPostalPrepared = null;
    return { ...click(options[0].element), mode };
  }
  const chosenStore = () => {
    const radios = all('input[name="store-locator-result"]').filter(e => e.checked);
    return radios.length === 1 && !disabled(radios[0]) && radios[0].value === p.storeId;
  };
  if (action === 'store') {
    if (phase !== 'pickup') throw Error('PICKUP_REQUIRED');
    const radios = all('input[name="store-locator-result"]').filter(e => e.value === p.storeId && [...(e.labels ?? [])].some(visible));
    if (radios.length !== 1) return { missing: true };
    const e = radios[0]; if (disabled(e) || /現在ご購入いただけません|unavailable|not available/i.test([...e.labels].map(l => l.innerText).join(' '))) return { unavailable: true };
    if (!e.checked) {
      if (storeSelection && !storeSelection.responseComplete) throw Error('PAGE_BUSY');
      if (typeof PerformanceObserver !== 'function' || !PerformanceObserver.supportedEntryTypes?.includes('resource')) throw Error('STORE_UNVERIFIED');
      clearStoreSelection();
      const request = { storeId: p.storeId, responseComplete: false, startedAt: performance.now() };
      request.observer = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          if (!['fetch','xmlhttprequest'].includes(entry.initiatorType) || entry.startTime < request.startedAt || entry.responseEnd <= 0) continue;
          try {
            const target = new URL(entry.name);
            if (target.protocol !== 'https:' || !(target.hostname === 'www.apple.com' || /^secure\d+\.store\.apple\.com$/.test(target.hostname)) || !target.pathname.startsWith('/jp/shop/') || target.searchParams.get('_m') !== 'checkout.fulfillment.pickupTab.pickup.storeLocator' || target.searchParams.get('_a') !== 'select') continue;
            request.responseComplete = true; request.responseAt = performance.now(); request.responseNetwork=networkTimings(entry); request.observer.disconnect(); break;
          } catch {}
        }
      });
      request.observer.observe({ entryTypes: ['resource'] });
      window.__applePickupStoreSelection = request;
      e.click(); return { requested: true, selected: e.checked && !e.disabled };
    }
    return { selected: true };
  }
  if (action === 'postal-advance') {
    if(phase==='expired')throw Error('PREORDER_SESSION_EXPIRED');
    if(phase==='unavailable')throw Error('PREORDER_PAGE_UNAVAILABLE');
    if (phase !== 'pickup' || snapshot.ready === false || fulfillmentMode !== 'pickup' || snapshot.paymentObserved || snapshot.paymentDispatched || snapshot.paymentCompleted) throw Error('EXISTING_CHECKOUT');
    if (pickupUnavailable) throw Error('STOCK_FAILED');
    const current = pageDOM({ ...p, action: 'postal-state', refreshId: undefined });
    // Reconcile an already submitted search before considering any new input.
    if (current.refreshSubmitted && !current.refreshComplete) return { submitted: true, refreshId: current.refreshId };
    if (!current.inputVisible) {
      pageDOM({ ...p, action: 'postal-open' });
      const opened = pageDOM({ ...p, action: 'postal-state' });
      if (!opened.inputReady || !opened.searchVisible) return { opening: true };
    }
    else if (!current.inputReady || !current.searchVisible) return { opening:true };
    const result = pageDOM({ ...p, action: 'postal' });
    return { ...result, readiness:pageDOM({...p,action:'postal-state'}) };
  }
  if (action === 'postal' || action === 'postal-open' || action === 'postal-submit') {
    if(phase==='expired')throw Error('PREORDER_SESSION_EXPIRED');
    if(phase==='unavailable')throw Error('PREORDER_PAGE_UNAVAILABLE');
    if (phase !== 'pickup' || fulfillmentMode !== 'pickup' || !/^\d{3}-\d{4}$/.test(p.postalCode)) throw Error('PICKUP_REQUIRED');
    const input = document.getElementById('checkout.fulfillment.pickupTab.pickup.storeLocator.searchInput');
    if (action === 'postal-open') {
      clearStoreSelection();
      window.__applePickupPostalRefresh?.observer?.disconnect(); window.__applePickupPostalRefresh?.responseObserver?.disconnect(); window.__applePickupPostalRefresh = null; window.__applePickupPostalPrepared = null;
      if (visible(input)) return { opened: true };
      const edits = all('button[data-autom="fulfillment-pickup-store-search-button"]').filter(enabled);
      if (edits.length !== 1) throw Error('POSTAL_CONTROL_CHANGED'); return { ...click(edits[0]), opening: true };
    }
    if (!enabled(input)) throw Error('POSTAL_INPUT_REQUIRED');
    const search = document.getElementById('checkout.fulfillment.pickupTab.pickup.storeLocator.search');
    if (!visible(search)) throw Error('POSTAL_CONTROL_CHANGED');
    if (action !== 'postal-submit' && input.value !== p.postalCode) {
      const prepared = { id: p.refreshId, inputWritten: false }; window.__applePickupPostalPrepared = prepared;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, p.postalCode); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
      if (input.value !== p.postalCode) throw Error('POSTAL_CHANGED');
      prepared.inputWritten = true; return { prepared: true, submitted: false };
    }
    if (input.value !== p.postalCode) throw Error('POSTAL_CHANGED');
    if (!enabled(search)) { window.__applePickupPostalPrepared = { id: p.refreshId, inputWritten: true }; return { prepared: true, submitted: false }; }
    clearStoreSelection();
    window.__applePickupCheckoutProof = null;
    window.__applePickupPostalRefresh?.observer?.disconnect(); window.__applePickupPostalRefresh?.responseObserver?.disconnect();
    if (typeof PerformanceObserver !== 'function' || !PerformanceObserver.supportedEntryTypes?.includes('resource')) throw Error('POSTAL_REFRESH_UNCERTAIN');
    const refresh = { id: p.refreshId, submitted: true, changed: false, responseRequired: true, responseComplete: false, startedAt: performance.now() };
    refresh.responseObserver = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        if (!['fetch','xmlhttprequest'].includes(entry.initiatorType) || entry.startTime < refresh.startedAt || entry.responseEnd <= 0) continue;
        try {
          const target = new URL(entry.name);
          if (target.protocol !== 'https:' || !(target.hostname === 'www.apple.com' || /^secure\d+\.store\.apple\.com$/.test(target.hostname)) || !target.pathname.startsWith('/jp/shop/') || target.searchParams.get('_m') !== 'checkout.fulfillment.pickupTab.pickup.storeLocator' || target.searchParams.get('_a') !== 'search') continue;
          refresh.responseComplete = true; refresh.responseDurationMs = Math.round(entry.duration); refresh.responseNetwork=networkTimings(entry);
          refresh.requestStartAfterSubmitMs=Math.round(entry.startTime-refresh.startedAt);refresh.responseEnd=entry.responseEnd;
          refresh.responseObserver.disconnect(); break;
        } catch {}
      }
    });
    refresh.responseObserver.observe({ entryTypes: ['resource'] });
    refresh.observer = new MutationObserver(records => {
      if (records.some(r => r.target.closest?.('.rt-storelocator-store-list') || [...r.addedNodes, ...r.removedNodes].some(e => e.matches?.('.rt-storelocator-store-list') || e.querySelector?.('.rt-storelocator-store-list')))) refresh.changed = true;
    });
    refresh.observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    window.__applePickupPostalRefresh = refresh;
    window.__applePickupPostalPrepared = null;
    return { ...click(search), submitted: true };
  }
  if (action === 'pickup-continue') {
    if (phase !== 'pickup' || fulfillmentMode !== 'pickup' || !chosenStore()) throw Error('STORE_CHANGED');
    if (snapshot.storeResponsePending) throw Error('PICKUP_CONTINUE_LOADING');
    const times = all('select[data-autom="pickup-availablewindow-dropdown"]').filter(visible);
    const next = one('button[data-autom="fulfillment-continue-button"],button[data-autom="continue-button-label"]');
    const dates = all('input[name="bartPickupDateSelectorButtonGroup"]'), selectedDates = dates.filter(e => e.checked);
    const selectedOption = times.length === 1 ? [...times[0].selectedOptions] : [];
    const scheduled = times.length === 1 && enabled(times[0]) && times[0].value && selectedOption.length === 1 && !disabled(selectedOption[0]) && !selectedOption[0].parentElement?.disabled && (!dates.length || selectedDates.length === 1 && !disabled(selectedDates[0]) && times[0].value.startsWith(selectedDates[0].value + '-'));
    const windowMode = scheduled ? 'scheduled' : snapshot.applePayRoute && !all('select[data-autom="pickup-availablewindow-dropdown"],input[name="bartPickupDateSelectorButtonGroup"]').length && !errors.length && enabled(next) ? 'not-offered' : null;
    if (!windowMode) throw Error('PICKUP_TIME_REQUIRED');
    if (p.schedule && (p.schedule.windowMode === 'not-offered' ? windowMode !== 'not-offered' : windowMode !== 'scheduled' || times[0].value !== p.schedule.value || selectedDates.length !== 1 || selectedDates[0].id !== p.schedule.dateId)) throw Error('PICKUP_TIME_REQUIRED');
    if (!enabled(next)) throw Error('PICKUP_CONTINUE_LOADING');
    if (snapshot.applePayRoute) {
      if (!totalMatches()) throw Error('REVIEW_CHANGED');
      window.__applePickupCheckoutProof = { sku: selection.sku, priceJPY: selection.priceJPY, storeId: p.storeId, mode: 'pickup', slot: windowMode === 'scheduled' ? times[0].value : null, windowMode, pickupAccepted: false, nonce: p.nonce, at: Date.now() };
      if (!window.__applePickupProofListeners) {
        window.addEventListener('popstate', () => { window.__applePickupCheckoutProof = null; });
        document.addEventListener('click', event => { const option = event.target?.closest?.('[role="radio"]'); if (option && /配送を希望する|お客様がご自身で受け取る|Deliver to me|Pick up/i.test(option.innerText)) window.__applePickupCheckoutProof = null; });
        document.addEventListener('change', event => { if (event.target?.matches?.('input[name="store-locator-result"],input[name="bartPickupDateSelectorButtonGroup"],select[data-autom="pickup-availablewindow-dropdown"]')) window.__applePickupCheckoutProof = null; });
        window.__applePickupProofListeners = true;
      }
    }
    return click(next);
  }
  if (action === 'pickup-accepted') {
    const proof = window.__applePickupCheckoutProof;
    if (phase !== 'contact' || !snapshot.applePayRoute || !proof || proof.mode !== 'pickup' || proof.storeId !== p.storeId || proof.sku !== selection.sku || proof.priceJPY !== selection.priceJPY || proof.nonce !== p.nonce || !totalMatches()) throw Error('PICKUP_ACCEPTANCE_UNVERIFIED');
    proof.pickupAccepted = true; return { accepted: true };
  }
  if (action === 'fill-contact' || action === 'prepare-contact') {
    if (phase !== 'contact' || !p.contact || Object.keys(p.contact).length !== contactNames.length || contactNames.some(k => typeof p.contact[k] !== 'string' || !p.contact[k].trim() || p.contact[k].length > 254) || Object.keys(p.contact).some(k => !contactNames.includes(k))) throw Error('PICKUP_CONTACT_INVALID');
    if (!contactNames.every(name => enabled(contactField(name)))) throw Error('CONTACT_FIELDS_LOADING');
    for (const name of contactNames) {
      const e = contactField(name);
      const value = p.contact[name].trim();
      if (e.value !== value) { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(e, value); e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); }
    }
    const filled = contactReady();
    if (action === 'prepare-contact') {
      // React may start validation synchronously during input/change. Only
      // a fresh, quiet direct Apple Pay page can use the combined fast path.
      const pay = window.__applePickupPayment;
      const blockedNow = pay?.active || pay?.authorized && !pay?.completed || document.documentElement.hasAttribute('data-apple-loop-pay-dispatched') || all('[aria-modal="true"],[role="alertdialog"],[aria-busy="true"],.rs-processing,[data-autom="processing"]').some(visible);
      const errorsNow = all('[role="alert"],.form-alert.is-error,.rs-messages-error').some(e => visible(e) && [e.innerText,e.getAttribute('aria-label'),e.textContent].some(value => Boolean(normal(value))));
      const current = new URL(location.href);
      const direct = current.pathname === '/jp/shop/apw/checkout' && current.searchParams.get('_s') === 'PickupContact-init';
      return { filled, readyForApplePay: Boolean(direct && document.readyState === 'complete' && filled && !blockedNow && !errorsNow && totalMatches() && directPayButtons().length === 1) };
    }
    return { filled };
  }
  if (action === 'contact-continue') {
    if (phase !== 'contact') throw Error('CONTACT_REQUIRED');
    if (!contactReady() || errors.length) return { manualContact: true };
    if (snapshot.applePayRoute) { if (directPayButtons().length !== 1) throw Error('APPLE_PAY_UNAVAILABLE'); return { readyForApplePay: true }; }
    return click(one('button[data-autom="continue-button-label"]'));
  }
  if (action === 'select-apple-pay') {
    if (phase !== 'billing') throw Error('BILLING_REQUIRED');
    const radios = all('input[type="radio"]').filter(e => /apple.?pay/i.test(e.getAttribute('data-autom') + ' ' + e.value));
    if (radios.length !== 1 || !enabled(radios[0])) throw Error('APPLE_PAY_UNAVAILABLE');
    if (!radios[0].checked) return click(radios[0]);
    return { selected: true };
  }
  if (action === 'review') {
    if (phase !== 'billing') throw Error('BILLING_REQUIRED');
    const chosen = all('input[type="radio"]').filter(e => e.checked && /apple.?pay/i.test(e.getAttribute('data-autom') + ' ' + e.value));
    if (chosen.length !== 1 || errors.length || all('input[aria-invalid="true"]').some(visible)) throw Error('APPLE_PAY_REQUIRED');
    const buttons = all('button[data-autom="continue-button-label"]').filter(e => enabled(e) && /^(注文の確認|Review(?: your)? order)$/i.test(normal(e.innerText)));
    if (buttons.length !== 1) throw Error('REVIEW_CONTROL_CHANGED'); return click(buttons[0]);
  }
  if (action === 'arm-apple-pay' || action === 'reposition-apple-pay') {
    if (errors.length) throw Error('REVIEW_REQUIRED');
    const store = p.store, direct = phase === 'contact' && snapshot.applePayRoute;
    if (direct) {
      const proof = window.__applePickupCheckoutProof;
      if (!contactReady() || !totalMatches() || !proof || proof.sku !== selection.sku || proof.priceJPY !== selection.priceJPY || proof.storeId !== store.id || proof.mode !== 'pickup' || proof.nonce !== p.nonce || (proof.windowMode === 'not-offered' ? !proof.pickupAccepted : !proof.slot) || Date.now() - proof.at > 600000 || !selection.stores.includes(store.id)) throw Error('REVIEW_CHANGED');
    } else {
      if (phase !== 'review') throw Error('FINAL_REVIEW_REQUIRED');
      const storeHeadings = headings.filter(s => new RegExp('^Apple\\s+(?:' + store.name + '|' + store.localName + ')(?:\\s|$)', 'i').test(s));
      if (!totalMatches() || storeHeadings.length !== 1 || !selection.stores.includes(store.id)) throw Error('REVIEW_CHANGED');
    }
    const buttons = direct ? directPayButtons() : all('button,apple-pay-button,[role="button"]').filter(e => enabled(e) && /Apple\s*Pay/i.test(e.innerText + ' ' + (e.getAttribute('aria-label') ?? '') + ' ' + e.getAttribute('data-autom')));
    if (buttons.length !== 1) throw Error('APPLE_PAY_CONTROL_CHANGED');
    if (action === 'reposition-apple-pay') {
      if (!inputRejectionMatches(p.attempt, p.nonce) ||
          buttons[0].getAttribute('data-apple-loop-pay-armed') !== p.nonce) throw Error('APPLE_PAY_ARM_CHANGED');
      // Move the existing button away from the first centered hit point.
      buttons[0].scrollIntoView({ block:'end', inline:'nearest', behavior:'instant' });
      return { repositioned: true };
    }
    if (document.documentElement.hasAttribute('data-apple-loop-pay-dispatched')) throw Error('APPLE_PAY_ALREADY_DISPATCHED');
    const state = { observed: false, active: false, authorized: false, completed: false, cancelled: false };
    window.__applePickupPayment = state;
    const cancelKey = 'apple-loop-payment-cancel:' + p.attempt;
    const owner = window.name;
    state.retainCancellation = cancelled => {
      if (window.__applePickupPayment !== state || window.name !== owner ||
          !p.nonce || owner !== 'ApplePickupLoop:' + p.nonce) return;
      try {
        if (cancelled && state.observed && !state.multipleSessions && !state.authorized && !state.completed)
          sessionStorage.setItem(cancelKey, JSON.stringify({owner, sku:selection.sku, at:Date.now()}));
        else sessionStorage.removeItem(cancelKey);
      } catch {}
    };
    if(/^[a-f0-9-]{36}$/.test(p.attempt??'')&&p.nonce&&window.name==='ApplePickupLoop:'+p.nonce){
      window.__applePickupMerchantObserver?.stop();
      const watch={timer:null},key='apple-loop-payment-diagnostic:'+p.attempt,owner=window.name;
      const capture=()=>{try{
        if(window.__applePickupMerchantObserver!==watch||window.name!==owner)return;
        const body=normal(document.body?.innerText),alerts=all('[role="alert"],.form-alert.is-error,.rs-messages-error').filter(visible).map(e=>normal(e.innerText)).join(' '),codes=[];
        if(body.includes('この商品は、選択した場所で受け取ることはできません')||alerts&&/現在ご購入いただけません|在庫がありません|no longer available|out of stock/i.test(alerts))codes.push('PICKUP_UNAVAILABLE');
        if(/お支払い.*(?:失敗|できません)|決済.*(?:失敗|キャンセル)|payment (?:failed|declined)/i.test(alerts))codes.push('PAYMENT_FAILURE');
        if(/セッションが時間切れ|セッション(?:の有効期限)?が切れました|session (?:has )?expired/i.test(body))codes.push('SESSION_EXPIRED');
        if(!codes.length)return;
        const old=JSON.parse(sessionStorage.getItem(key)),prior=old?.attempt===p.attempt&&old.owner===owner&&Array.isArray(old.codes)?old.codes.filter(c=>['PICKUP_UNAVAILABLE','PAYMENT_FAILURE','SESSION_EXPIRED'].includes(c)):[];
        sessionStorage.setItem(key,JSON.stringify({attempt:p.attempt,owner,sku:selection.sku,atJST:new Date().toLocaleString('sv-SE',{timeZone:'Asia/Tokyo'})+' JST',codes:[...new Set([...prior,...codes])]}));
      }catch{}};
      const observer=new MutationObserver(()=>{if(!watch.timer)watch.timer=setTimeout(()=>{watch.timer=null;capture();},50);});
      watch.stop=()=>{observer.disconnect();clearTimeout(watch.timer);window.removeEventListener('pagehide',capture);};
      window.__applePickupMerchantObserver=watch;observer.observe(document.documentElement,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['class','hidden','aria-hidden']});window.addEventListener('pagehide',capture);capture();
    }
    if (typeof window.ApplePaySession === 'function') {
      const Original = window.__applePickupOriginalPaySession ?? window.ApplePaySession, proto = Original.prototype;
      if (window.__applePickupObservedPayPrototype !== proto || window.__applePickupPaymentObserverVersion !== 3) {
        const methods = ['begin','abort','completePayment'].map(name => ({ name, descriptor: Object.getOwnPropertyDescriptor(proto, name) }));
        if (methods.some(({ descriptor: d }) => typeof d?.value !== 'function' || !d.writable && !d.configurable)) throw Error('APPLE_PAY_OBSERVER_UNAVAILABLE');
        const sessions = new WeakMap();
        const observe = session => {
          if (sessions.has(session)) return sessions.get(session);
          const current = window.__applePickupPayment; sessions.set(session, current);
          session.addEventListener('cancel', () => { current.active = false; current.cancelled = true; current.retainCancellation?.(true); });
          session.addEventListener('paymentauthorized', () => { current.authorized = true; current.retainCancellation?.(false); });
          return current;
        };
        for (const { name, descriptor } of methods) Object.defineProperty(proto, name, { ...descriptor, value: function(...args) {
          const current = observe(this), value = Reflect.apply(descriptor.value, this, args);
          if (name === 'begin') { if (current.observed) current.multipleSessions = true; current.retainCancellation?.(false); current.observed = true; current.active = !current.cancelled && !current.completed; }
          else if (name === 'abort') { current.active = false; current.cancelled = true; current.retainCancellation?.(true); }
          else {
            // Observe the merchant result without reading tokens, contacts,
            // errors, or invoking a status getter a second time.
            let status;
            try { status = typeof args[0] === 'number' ? args[0] : args[0] && typeof args[0] === 'object' ? Object.getOwnPropertyDescriptor(args[0], 'status')?.value : undefined; } catch {}
            current.active = false; current.completed = true; current.retainCancellation?.(false);
            current.completion = status === 0 ? 'succeeded' : status === 1 ? 'failed' : 'unknown';
          }
          return value;
        } });
        window.__applePickupOriginalPaySession = Original;
        window.__applePickupObservedPayPrototype = proto;
        window.__applePickupPaymentObserverVersion = 3;
      }
    }
    buttons[0].scrollIntoView({ block: 'center', inline: 'nearest', behavior:'instant' });
    buttons[0].setAttribute('data-apple-loop-pay-armed', p.nonce); document.documentElement.setAttribute('data-apple-loop-pay-dispatched', p.attempt);
    return { armed: true, summaryVerified: true };
  }
  if (action === 'keepalive') {
    if (sessionExpired) return { expired: true };
    if (!sessionWarning) {
      all('[data-apple-loop-session-extension]').forEach(e => e.removeAttribute('data-apple-loop-session-extension'));
      return { maintained: true };
    }
    if (!sessionOnlyAction || !['pickup','contact','billing','review'].includes(phase)) return { manual: true, reason: 'session-warning' };
    if (sessionButtons.length !== 1) return { manual: true, reason: 'extension-control' };
    const button = sessionButtons[0];
    if (button.hasAttribute('data-apple-loop-session-extension')) return { extensionPending: true };
    button.setAttribute('data-apple-loop-session-extension', 'requested');
    return { ...click(button), extensionRequested: true };
  }
  throw Error('UNKNOWN_ACTION');
}
