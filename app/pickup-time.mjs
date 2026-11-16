const dayMs = 86400000;
const tokyoOffset = 9 * 3600000;
const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

export function pickupDate(label, now) {
  const text = label.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
  const english = text.match(/^([a-z]+)\s*(\d{1,2})$/);
  const japanese = text.match(/^(\d{1,2})月\s*(\d{1,2})(?:日)?$/);
  const month = english ? months.indexOf(english[1]) + 1 : Number(japanese?.[1]);
  const day = Number(english?.[2] ?? japanese?.[2]);
  if (!month || !day || month > 12 || day > 31) throw Error('Unrecognized pickup date');
  const today = new Date(now + tokyoOffset);
  const midnight = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) - tokyoOffset;
  const dates = [today.getUTCFullYear(), today.getUTCFullYear() + 1].map(year => Date.UTC(year, month - 1, day) - tokyoOffset);
  const result = dates.find(value => value >= midnight && value <= midnight + 14 * dayMs && new Date(value + tokyoOffset).getUTCMonth() === month - 1);
  if (result === undefined) throw Error('Pickup date outside the observed booking window');
  return result;
}

export function nearestPickupSlot(days, checkoutAt, now = checkoutAt) {
  if (!Number.isFinite(checkoutAt) || !Number.isFinite(now) || now < checkoutAt) throw Error('Invalid checkout clock');
  const target = checkoutAt + 3600000;
  const candidates = [];
  for (const day of days) {
    if (day.disabled) continue;
    const date = pickupDate(day.label, checkoutAt);
    const dateNumber = new Date(date + tokyoOffset).getUTCDate();
    for (const slot of day.slots) {
      if (slot.disabled || !slot.value) continue;
      const match = slot.value.match(/^(\d{1,2})-(\d{2}):(\d{2})-(\d{2}):(\d{2})$/);
      if (!match || Number(match[1]) !== dateNumber) throw Error('Pickup slot does not match its date');
      const [, , hour, minute, endHour, endMinute] = match.map(Number);
      if (hour > 23 || minute > 59 || endHour > 23 || endMinute > 59 || endHour * 60 + endMinute <= hour * 60 + minute) throw Error('Invalid pickup time');
      const startsAt = date + (hour * 60 + minute) * 60000;
      if (startsAt <= now) continue;
      candidates.push({ dateId: day.id, dateLabel: day.label, value: slot.value, label: slot.label, startsAt, targetAt: target, distance: Math.abs(startsAt - target) });
    }
  }
  candidates.sort((left, right) => left.distance - right.distance || right.startsAt - left.startsAt);
  if (!candidates.length) throw Error('No future pickup slot available');
  return candidates[0];
}

// Runs only in the already validated Apple checkout; never touches contact or payment inputs.
export function pickupScheduleDOM({ action = 'read', dateId, value, storeLabels, storeId = null } = {}) {
  const visible = element => typeof element?.getClientRects === 'function' ? element.getClientRects().length > 0 : true;
  const disabled = element => Boolean(element.disabled || element.matches?.(':disabled') || element.getAttribute?.('aria-disabled') === 'true');
  const errorPresent = [...document.querySelectorAll('[role="alert"],.form-alert.is-error,.rs-messages-error')].some(e => visible(e) && [e.innerText,e.getAttribute('aria-label'),e.textContent].some(value => String(value??'').trim().length > 0));
  const pay=window.__applePickupPayment;
  const blocked=pay?.active || pay?.authorized && !pay?.completed || document.documentElement.hasAttribute('data-apple-loop-pay-dispatched') || [...document.querySelectorAll('[aria-modal="true"],[role="alertdialog"],[aria-busy="true"],.rs-processing,[data-autom="processing"]')].some(visible);
  if(blocked){if(action==='read')return{ready:false,reason:'page-busy'};throw Error('PAGE_BUSY');}
  const fulfillmentChange = window.__applePickupFulfillmentChange;
  const storeSelection = window.__applePickupStoreSelection;
  const storeResponseVerified = Boolean(storeSelection?.responseComplete && storeSelection.storeId === storeId);
  const storeResponseMs = storeResponseVerified ? Math.max(0, Math.round(storeSelection.responseAt - storeSelection.startedAt)) : undefined;
  const labelMatches = label => {
    const titles = [...(label.querySelectorAll?.('.form-selector-title') ?? [])];
    if (titles.length > 1) return false;
    const text = String(titles.length ? titles[0].innerText : label.innerText).normalize('NFKC').replace(/\s+/g, ' ').trim();
    return storeLabels?.some(name => new RegExp(`^(?:\\d+\\s*)?Apple\\s+${name}(?=\\s|$)`, 'i').test(text));
  };
  const pickup = [...document.querySelectorAll('[role="radio"]')].filter(element => /^(お客様がご自身で受け取る|Customers receive it themselves\.)$/.test(element.innerText.trim()));
  const storeElements = [...document.querySelectorAll('input[name="store-locator-result"]')];
  const stores = storeElements.filter(element => element.checked);
  const targetStores = storeElements.filter(element => (storeId === null || element.value === storeId) && [...(element.labels ?? [])].some(label => visible(label) && labelMatches(label)));
  const unavailable = element => disabled(element) || [...(element.labels ?? [])].some(label => /現在ご購入いただけません|unavailable|not available/i.test(label.innerText ?? ''));
  const dateElements = [...document.querySelectorAll('input[name="bartPickupDateSelectorButtonGroup"]')];
  const selectorElements = [...document.querySelectorAll('select[data-autom="pickup-availablewindow-dropdown"]')];
  const dates = dateElements.filter(element => visible(element) || [...(element.labels ?? [])].some(visible));
  const selectors = selectorElements.filter(element => element.getClientRects().length);
  const diagnostic = { dateCount: dates.length, selectorCount: selectors.length, dateElementCount: dateElements.length, selectorElementCount: selectorElements.length, checkedStoreCount: stores.length, storeCandidateCount: targetStores.length, storeVisibleCandidateCount: targetStores.length, dateLabelVisibleCount: dateElements.filter(element => [...(element.labels ?? [])].some(label => label.getClientRects?.().length)).length, ...(Number.isSafeInteger(storeResponseMs) ? { storeResponseMs, ...Object.fromEntries(['firstByteMs','downloadMs','connectMs'].filter(k=>Number.isSafeInteger(storeSelection.responseNetwork?.[k])&&storeSelection.responseNetwork[k]>=0&&storeSelection.responseNetwork[k]<=300000).map(k=>[k,storeSelection.responseNetwork[k]])) } : {}) };
  // Count controls while a response is pending, but keep every date/time
  // mutation behind the same response fence. Counts are diagnostic only.
  if (fulfillmentChange && (!fulfillmentChange.responseComplete || performance.now() - fulfillmentChange.responseAt < 150)) { if (action === 'read') return { ready: false, reason: 'fulfillment-response-pending', ...diagnostic }; throw Error('PAGE_BUSY'); }
  if (storeSelection && !storeSelection.responseComplete) { if (action === 'read') return { ready: false, reason: 'store-response-pending', ...diagnostic }; throw Error('PAGE_BUSY'); }
  const pickupConfirmed = pickup.length === 1 && pickup[0].getAttribute('aria-checked') === 'true';
  const responseAge=storeResponseVerified?performance.now()-storeSelection.responseAt:Infinity;
  // An exact Store response can briefly unmount its entire panel. Observe
  // that short gap without replaying the Store click or the postal search.
  if(action==='read'&&pickupConfirmed&&storeResponseVerified&&responseAge>=0&&responseAge<350&&
    !errorPresent&&stores.length===0&&targetStores.length===0){
    return {ready:false,reason:'store-panel-remounting',...diagnostic,storeResponseVerified,storeConfirmed:false};
  }
  // Apple controls the radio selection while its Store response rebuilds the
  // panel. A temporarily unchecked, still available exact Store must be read
  // again, never clicked again or used to select a date/time.
  if (action === 'read' && pickupConfirmed && stores.length === 0 && targetStores.length === 1 && !unavailable(targetStores[0])) return { ready: false, reason: 'store-selection-pending', ...diagnostic, storeConfirmed: false };
  const disabledTarget = pickupConfirmed && stores.length <= 1 && targetStores.length === 1 && unavailable(targetStores[0]) && (stores.length === 0 || stores[0] === targetStores[0]);
  if (disabledTarget) throw Object.assign(Error('STOCK_FAILED'), { pickupDiagnostic: { ...diagnostic, storeConfirmed: false, readinessReason: 'store-disabled' } });
  if (!pickupConfirmed || stores.length !== 1 || targetStores.length !== 1 || stores[0] !== targetStores[0] || unavailable(stores[0])) throw Object.assign(Error('STORE_UNVERIFIED'), { pickupDiagnostic: { ...diagnostic, storeConfirmed: false, readinessReason: 'store-not-confirmed' } });
  diagnostic.storeConfirmed = true;
  const publicDates=()=>dates.map(element=>({id:element.id,label:[...element.labels].map(label=>label.innerText).join(' '),disabled:disabled(element)}));
  if (action === 'date') {
    const matches = dates.filter(element => element.id === dateId && !disabled(element));
    if (matches.length !== 1) throw Error('PICKUP_DATE_UNAVAILABLE');
    const changed=!matches[0].checked;if(changed)matches[0].click();
    return { requested: true, changed };
  }
  const selectedDates = dates.filter(element => element.checked);
  if(action==='read'&&dates.some(element=>!disabled(element))&&selectedDates.length===0)return{ready:true,needsDate:true,selectedDateId:null,dates:publicDates(),slots:[],storeResponseVerified,...diagnostic};
  // An empty day may settle without offering a dropdown. Expose its dates so
  // the planner can observe a quiet interval and try another available day.
  const emptyDay = action === 'read' && selectedDates.length === 1 && dates.some(e => !disabled(e)) && (!selectorElements.length || selectors.length === 1 && (disabled(selectors[0]) || ![...selectors[0].options].some(o => o.value)));
  if (emptyDay && !errorPresent) return { ready: false, reason: 'date-no-slots', selectedDateId: selectedDates[0].id, dates: publicDates(), slots: [], ...diagnostic, storeResponseVerified };
  if (!dates.length || selectors.length !== 1 || disabled(selectors[0])) {
    const next = [...document.querySelectorAll('button[data-autom="fulfillment-continue-button"],button[data-autom="continue-button-label"]')].filter(e => visible(e) && !disabled(e));
    if (action === 'read' && !dateElements.length && !selectorElements.length && storeSelection?.responseComplete && performance.now() - storeSelection.responseAt < 150) return { ready: false, reason: 'store-response-settling', ...diagnostic, storeResponseVerified };
    if (action === 'read' && new URL(location.href).pathname === '/jp/shop/apw/checkout' && !dateElements.length && !selectorElements.length && next.length === 1 && !errorPresent && ![...document.querySelectorAll('[aria-busy="true"],.rs-processing,[data-autom="processing"]')].some(visible)) return { ready: true, windowMode: 'not-offered', storeConfirmed: true, storeResponseVerified, ...diagnostic };
    const reason = !dateElements.length && !selectorElements.length ? 'calendar-absent' : (!dates.length && dateElements.length || !selectors.length && selectorElements.length) ? 'calendar-hidden' : selectors.length === 1 && disabled(selectors[0]) ? 'calendar-disabled' : 'calendar-controls';
    return { ready: false, reason, ...diagnostic, storeConfirmed: true, selectedDateId: selectedDates.length === 1 ? selectedDates[0].id : null };
  }
  if (selectedDates.length !== 1) return { ready: false, reason: 'selected-date-count', selectedDateCount: selectedDates.length };
  const selectedDate = selectedDates[0];
  const select = selectors[0];
  const slots = [...select.options].map(option => ({ value: option.value, label: option.text, disabled: disabled(option) || Boolean(option.parentElement?.disabled) }));
  if (!slots.some(slot => slot.value && slot.value.startsWith(`${selectedDate.value}-`)) || slots.some(slot => slot.value && !slot.value.startsWith(`${selectedDate.value}-`))) return { ready: false, reason: 'slot-date-mismatch', selectedDateId: selectedDate.id, selectedDateValue: selectedDate.value, optionValues: slots.slice(0,4).map(slot => slot.value) };
  let changed=false;
  if (action === 'slot') {
    if (selectedDate.id !== dateId || disabled(selectedDate) || !slots.some(slot => slot.value === value && !slot.disabled)) throw Error('PICKUP_SLOT_CHANGED');
    changed=select.value!==value;
    if(changed){Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, value);
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));}
  } else if (action !== 'read') throw Error('Unknown pickup action');
  return { ready: true, selectedDateId: selectedDate.id, selectedValue: select.value, dates: publicDates(), slots, storeResponseVerified, ...diagnostic,...(action==='slot'?{changed}:{}) };
}

export async function choosePickupSchedule(read, { checkoutAt, now = Date.now, sleep, check = () => {}, onWait = () => {}, speedFirst = false }) {
  const wait = async (dateId, uncertainValue) => {
    let lastReason = 'not-ready';
    let lastDiagnostic = {};
    let reportedReason;
    const startedAt=now(),deadline=startedAt+20000; let emptySignature = null, emptySince = null;
    for (let attempt = 0; attempt < 400 && now() < deadline; attempt += 1) {
      check();
      const readStartedAt = now();
      const snapshot = await read({ action: 'read' });
      if (dateId && snapshot.ready && snapshot.dates && !snapshot.dates.some(date => date.id === dateId && !date.disabled) && uncertainValue === undefined) throw Error('PICKUP_DATE_UNAVAILABLE');
      if (snapshot.ready && (!dateId || snapshot.selectedDateId === dateId) && (uncertainValue === undefined || snapshot.selectedValue === uncertainValue)) return snapshot;
      if (uncertainValue === undefined && snapshot.reason === 'date-no-slots' && (!dateId || snapshot.selectedDateId === dateId)) {
        const signature = JSON.stringify([snapshot.selectedDateId, snapshot.dates]);
        if (signature !== emptySignature) { emptySignature = signature; emptySince = now(); }
        else if (now() - emptySince >= 300) return { ...snapshot, ready: true, emptyDate: true };
      } else { emptySignature = null; emptySince = null; }
      lastReason = uncertainValue !== undefined && snapshot.ready ? 'selection-uncertain' : snapshot.reason ?? 'date-loading';
      lastDiagnostic = Object.fromEntries(['dateCount','selectorCount','dateElementCount','selectorElementCount','checkedStoreCount','dateLabelVisibleCount','storeCandidateCount','storeVisibleCandidateCount','storeConfirmed'].filter(key => snapshot[key] !== undefined).map(key => [key, snapshot[key]]));
      if(lastReason!==reportedReason||attempt%10===9){onWait({reason:lastReason,attempts:attempt+1,waitMs:Math.max(0,now()-startedAt),...lastDiagnostic});reportedReason=lastReason;}
      if(now()>=deadline)break;
      // Native Safari reads already consume part of the polling interval.
      // Passive page observers permit a 50 ms start-to-start cadence; plain
      // readers retain 100 ms. Slow reads never create overlapping requests.
      const cadence=snapshot.readinessWatch===true?50:100;
      const delay = Math.min(Math.max(0, cadence - (now() - readStartedAt)), deadline - now());
      if (delay > 0) await sleep(delay);
    }
    throw Object.assign(Error('PICKUP_CALENDAR_TIMEOUT'), { pickupDiagnostic: { ...lastDiagnostic, readinessReason: lastReason } });
  };
  const rejected = new Set();
  const key = slot => slot.dateId + ':' + slot.value;
  const available = (snapshot, chosen) => chosen.startsAt > now() && snapshot.selectedDateId === chosen.dateId && snapshot.dates.some(date => date.id === chosen.dateId && !date.disabled) && snapshot.slots.some(slot => slot.value === chosen.value && !slot.disabled);
  const plan = async () => {
  const initial = await wait();
  if (initial.windowMode === 'not-offered') { check(); return { windowMode: 'not-offered' }; }
  let current = initial;
  const days = [];
  let best = null;
  const dates = initial.dates.filter(item => !item.disabled);
  dates.sort((a,b) => Number(b.id === initial.selectedDateId) - Number(a.id === initial.selectedDateId));
  for (const date of dates) {
    check();
    // Midnight is a conservative lower bound for every slot on a later day.
    // Skip only when even that bound is strictly worse than a still-future
    // observed choice; equal-distance days retain the existing later-slot tie.
    const midnight=pickupDate(date.label,checkoutAt),target=checkoutAt+3600000;
    if(best&&best.startsAt>now()&&midnight>=target&&midnight-target>best.distance)continue;
    if (current.selectedDateId !== date.id) {
      const changed=await read({ action: 'date', dateId: date.id });
      current = changed?.readAfterMutation&&changed.ready&&changed.selectedDateId===date.id?changed:await wait(date.id);
    }
    const snapshot = current;
    const liveDate = snapshot.dates.find(item => item.id === date.id && !item.disabled);
    if (!liveDate) throw Error('PICKUP_DATE_UNAVAILABLE');
    days.push({ ...liveDate, slots: snapshot.slots.filter(slot => !rejected.has(key({ dateId: date.id, value: slot.value }))) });
    try{best=nearestPickupSlot(days,checkoutAt,now());}
    catch(error){if(error.message!=='No future pickup slot available')throw error;best=null;}
    if(speedFirst&&best)break;
  }
  let chosen;
  try { chosen = nearestPickupSlot(days, checkoutAt, now()); }
  catch (error) { if (error.message === 'No future pickup slot available') throw Error('STOCK_FAILED'); throw error; }
  check();
  if (current.selectedDateId !== chosen.dateId) {
    const changed=await read({ action: 'date', dateId: chosen.dateId });
    current = changed?.readAfterMutation&&changed.ready&&changed.selectedDateId===chosen.dateId?changed:await wait(chosen.dateId);
  }
  check();
  if (!available(current, chosen)) { rejected.add(key(chosen)); throw Error('PICKUP_SLOT_CHANGED'); }
  if (current.selectedValue === chosen.value) return chosen;
  let result;
  try { result = await read({ action: 'slot', dateId: chosen.dateId, value: chosen.value }); }
  catch (error) { if (error.message === 'PICKUP_SLOT_CHANGED') rejected.add(key(chosen)); throw error; }
  const confirmed = result?.readAfterMutation&&result.ready&&result.selectedDateId===chosen.dateId&&result.selectedValue===chosen.value?result:await wait(chosen.dateId, result?.replyUncertain ? chosen.value : undefined);
  check();
  if (!available(confirmed, chosen) || confirmed.selectedValue !== chosen.value) { rejected.add(key(chosen)); throw Error('PICKUP_SLOT_CHANGED'); }
  return chosen;
  };
  // Only explicit, pre-payment availability changes justify a fresh plan.
  // Lost mutation replies remain the caller's read-only reconciliation job.
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await plan(); }
    catch (error) {
      if (!['PICKUP_SLOT_CHANGED','PICKUP_DATE_UNAVAILABLE'].includes(error.message)) throw error;
      check(); onWait({ reason: 'availability-changed', attempts: attempt + 1 });
    }
  }
  throw Error('STOCK_FAILED');
}
