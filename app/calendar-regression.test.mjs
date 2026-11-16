import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { choosePickupSchedule, pickupScheduleDOM } from './pickup-time.mjs';
import { SafariSession } from './safari.mjs';

// This file never opens a native transport, application server, or live URL.
// Chrome sees only documents/resources fulfilled by the context route below.
const CHECKOUT_URL = 'https://www.apple.com/jp/shop/apw/checkout?_s=Fulfillment-init';
const SELECT_URL = '/jp/shop/apw/checkoutx?_a=select&_m=checkout.fulfillment.pickupTab.pickup.storeLocator';
const BASE = Date.UTC(2026, 10, 8, 3); // 12:00 JST; target is 13:00 JST.
const A = '8-13:00-13:15';
const B = '8-13:15-13:30';
const NEXT_DAY = '9-10:00-10:15';
const selection = Object.freeze({
  sku: 'AAAA1J/A', name: 'Test Device 256GB Black',
  names: ['Test Device 256GB Black', 'Test Device 256GB ブラック'],
  priceJPY: 100000, currency: 'JPY', category: 'iphone',
  productId: 'https://www.apple.com/jp/shop/buy-iphone/test-device',
  url: 'https://www.apple.com/jp/shop/product/AAAA1J/A', stores: ['R119'],
});
const contact = Object.freeze({
  lastName: 'Fixture', firstName: 'Operator',
  emailAddress: 'calendar-regression@example.invalid', mobilePhone: '08000000000',
});
const schedule = { dateId: 'date8', value: A };
const summary = '<div role="radio" aria-checked="true">お客様がご自身で受け取る</div>'
  + '<div role="radio" aria-checked="false">配送を希望する</div>'
  + '<span class="rs-companionbar-button-amount">100,000円</span>';
const store = (checked = true) => '<input id="store" type="radio" name="store-locator-result" value="R119"'
  + (checked ? ' checked' : '') + '><label for="store"><span class="form-selector-title">Apple 渋谷</span></label>';
const date = (day, checked = false) => '<input id="date' + day
  + '" type="radio" name="bartPickupDateSelectorButtonGroup" value="' + day + '"'
  + (checked ? ' checked' : '') + '><label for="date' + day + '">November' + day + '</label>';
const option = value => '<option value="' + value + '">' + value + '</option>';
const dropdown = (options, attributes = '') => '<select data-autom="pickup-availablewindow-dropdown" '
  + attributes + '>' + options + '</select>';
const placeholder = '<option value="">選択</option>';
const next = '<button id="next" data-autom="fulfillment-continue-button">続ける</button>';
const body = calendar => summary + store() + calendar + next;
const contactBody = () => '<span class="rs-companionbar-button-amount">100,000円</span>'
  + Object.keys(contact).map(name => '<input id="checkout.pickupContact.selfPickupContact.selfContact.address.'
    + name + '" autocomplete="off">').join('')
  + '<button id="fixture-pay" class="rs-checkout-applepay-button" aria-label="Apple Pay">Apple Pay</button>';
const errorCode = code => error => error instanceof Error && error.message === code;
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
let browser;

test.before(async () => {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
});
test.after(async () => { await browser?.close(); });

async function fixture(t, html, { onSelect, onFulfillment } = {}) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  t.after(() => context.close());
  const unexpected = [], requests = [];
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    requests.push({ pathname: url.pathname, action: url.searchParams.get('_a') });
    if (request.isNavigationRequest() && request.url() === CHECKOUT_URL) {
      await route.fulfill({
        status: 200, contentType: 'text/html; charset=utf-8',
        body: '<!doctype html><html lang="ja"><head><meta charset="utf-8"></head><body>' + html + '</body></html>',
      });
      return;
    }
    if (url.origin === 'https://www.apple.com' && url.pathname === '/jp/shop/apw/checkoutx'
      && url.searchParams.get('_m') === 'checkout.fulfillment.pickupTab.pickup.storeLocator'
      && url.searchParams.get('_a') === 'select' && onSelect) {
      await onSelect(route);
      return;
    }
    if (url.origin === 'https://www.apple.com' && url.pathname === '/jp/shop/apw/checkoutx'
      && url.searchParams.get('_m') === 'checkout.fulfillment.fulfillmentOptions'
      && url.searchParams.get('_a') === 'selectFulfillmentLocationAction' && onFulfillment) {
      await onFulfillment(route); return;
    }
    unexpected.push(request.url());
    await route.abort();
  });
  t.after(() => assert.deepEqual(unexpected, [], 'every request must be explicitly intercepted'));
  const page = await context.newPage();
  page.setDefaultTimeout(4000);
  // Freeze only Date.now. Playwright's installed clock also replaces the
  // Performance APIs, hiding real intercepted-resource entries from observers.
  await page.addInitScript(base => { window.__calendarRegressionNow = base; Date.now = () => window.__calendarRegressionNow; }, BASE);
  await page.addInitScript(() => {
    window.__calendarRegression = { dateClicks: [], storeClicks: 0, slotChanges: [], continues: [], payClicks: 0 };
    document.addEventListener('click', event => {
      const target = event.target;
      if (target?.matches?.('input[name="store-locator-result"]')) window.__calendarRegression.storeClicks++;
      if (target?.matches?.('input[name="bartPickupDateSelectorButtonGroup"]')) {
        window.__calendarRegression.dateClicks.push({ id: target.id, at: Date.now() });
      }
      if (target?.closest?.('#next')) {
        window.__calendarRegression.continues.push({
          at: Date.now(),
          value: document.querySelector('select[data-autom="pickup-availablewindow-dropdown"]')?.value ?? null,
          beforeSelect: window.__fixtureSelectApplied === false,
        });
      }
    }, true);
    document.addEventListener('change', event => {
      if (event.target?.matches?.('select[data-autom="pickup-availablewindow-dropdown"]')) {
        window.__calendarRegression.slotChanges.push(event.target.value);
      }
    });
  });
  await page.goto(CHECKOUT_URL);
  let current = BASE;
  const f = {
    page, requests, sleeps: [], onSleep: null,
    now: () => current,
    elapsed: () => current - BASE,
    counters: () => page.evaluate(() => window.__calendarRegression),
    async sleep(ms) {
      assert.ok(Number.isFinite(ms) && ms >= 0, 'invalid fake sleep');
      f.sleeps.push(ms);
      current += ms;
      await page.evaluate(value => { window.__calendarRegressionNow = value; }, current);
      await f.onSleep?.();
    },
  };
  return f;
}

function safariFor(f, { beforeEvaluate, loseReply } = {}) {
  const calls = [];
  const session = new SafariSession({
    bindingPath: null, now: f.now, sleep: f.sleep,
    invoke: async request => {
      if (request.operation === 'payment-status') return { known: true, active: false, kind: 'none' };
      assert.ok(['evaluate', 'evaluate-guarded'].includes(request.operation), 'no native operation is permitted');
      const script = request.script;
      const action = script.match(/"action":"([a-z-]+)"/)?.[1] ?? 'unknown';
      assert.ok(!['arm-apple-pay', 'select-apple-pay', 'review'].includes(action), 'fixture must stop before payment');
      const call = {
        action, script, operation: request.operation,
        calendar: script.includes('function pickupScheduleDOM'), at: f.now(),
      };
      if (call.calendar && action !== 'read' || ['fulfillment-mode', 'store', 'pickup-continue', 'fill-contact', 'prepare-contact', 'contact-continue'].includes(action)) {
        assert.equal(request.operation, 'evaluate-guarded', 'mutations retain the native payment guard');
      }
      calls.push(call);
      await beforeEvaluate?.(call);
      const result = JSON.parse(await f.page.evaluate(source => (0, eval)(source), script));
      call.result = result;
      if (loseReply?.(call)) throw Error('SAFARI_SCRIPT_UNAVAILABLE');
      return result;
    },
  });
  session.binding = { nonce: 'calendar-regression-fixture' };
  session.expected(selection, 'R119');
  session.setPickupContact(contact);
  return { session, calls };
}

const calendarRead = session => parameters => session.evaluate(
  pickupScheduleDOM, { ...parameters, storeId: 'R119', storeLabels: ['Shibuya', '渋谷'] },
  { guardPayment: parameters.action !== 'read' },
);
const choose = (f, read) => choosePickupSchedule(read, {
  checkoutAt: BASE, now: f.now, sleep: f.sleep,
});
const slotAttempts = calls => calls.filter(call => call.calendar && call.action === 'slot')
  .map(call => call.script.match(/"value":"([^"]*)"/)?.[1]);
const dateAttempts = calls => calls.filter(call => call.calendar && call.action === 'date');
const continuePickup = (session, expected = schedule) => session.action('pickup-continue', {
  storeId: 'R119', nonce: session.binding.nonce, schedule: expected,
});

async function installContactTransition(f) {
  await f.page.evaluate(html => {
    document.getElementById('next').onclick = () => {
      // A premature Continue is recorded, but cannot invent a successful
      // response while the independent Store selection request is pending.
      if (window.__fixtureSelectApplied === false) return;
      history.replaceState({}, '', '/jp/shop/apw/checkout?_s=PickupContact-init');
      document.body.innerHTML = html;
      document.getElementById('fixture-pay').onclick = () => window.__calendarRegression.payClicks++;
    };
  }, contactBody());
}

async function assertNoPayment(f) {
  assert.equal((await f.counters()).payClicks, 0);
  assert.equal(await f.page.evaluate(() =>
    document.documentElement.hasAttribute('data-apple-loop-pay-dispatched')), false);
}

test('pending Store response exposes calendar counts without allowing date or time mutations', async t => {
  const f = await fixture(t, body(date(8, true) + dropdown(placeholder + option(A))));
  await f.page.evaluate(() => {
    window.__applePickupStoreSelection = { storeId: 'R119', startedAt: performance.now(), responseComplete: false };
  });
  const { session } = safariFor(f), read = calendarRead(session);
  const pending = await read({ action: 'read' });
  assert.equal(pending.ready, false); assert.equal(pending.reason, 'store-response-pending');
  assert.equal(pending.dateCount, 1); assert.equal(pending.selectorCount, 1); assert.equal(pending.checkedStoreCount, 1);
  await assert.rejects(read({ action: 'date', dateId: 'date8' }), errorCode('PAGE_BUSY'));
  await assert.rejects(read({ action: 'slot', dateId: 'date8', value: A }), errorCode('PAGE_BUSY'));
  await f.page.evaluate(() => {
    const r = window.__applePickupStoreSelection;
    r.responseComplete = true; r.responseAt = performance.now() - 200; r.startedAt = r.responseAt - 500;
  });
  const settled = await read({ action: 'read' });
  assert.equal(settled.ready, true); assert.equal(settled.storeResponseVerified, true); assert.equal(settled.storeResponseMs, 500);
  assert.deepEqual((await f.counters()).slotChanges, []);
  assert.deepEqual((await f.counters()).dateClicks, []);
  await assertNoPayment(f);
});

test('planned slot removed before guarded Continue cannot silently submit a valid replacement', { timeout: 15000 }, async t => {
  const f = await fixture(t, body(date(8, true) + dropdown(option(A) + option(B))));
  const { session } = safariFor(f);
  const chosen = await choose(f, calendarRead(session));
  assert.deepEqual({ dateId: chosen.dateId, value: chosen.value }, schedule);
  await f.page.evaluate(value => {
    const select = document.querySelector('select');
    [...select.options].find(item => item.value !== value).remove();
    select.value = value;
  }, B);
  assert.equal(await f.page.locator('select').inputValue(), B);
  await assert.rejects(continuePickup(session, chosen), errorCode('PICKUP_TIME_REQUIRED'));
  assert.equal((await f.counters()).continues.length, 0);
  await assertNoPayment(f);
});

test('uncertain slot outcome before apply waits read-only for the expected value', { timeout: 15000 }, async t => {
  const f = await fixture(t, body(date(8, true) + dropdown(placeholder + option(A) + option(B))));
  const { session } = safariFor(f), mutations = [];
  const read = calendarRead(session);
  await assert.rejects(choose(f, async parameters => {
    if (parameters.action !== 'read') {
      mutations.push(parameters);
      // The request may have been lost before dispatch; no DOM action runs.
      return { requested: true, replyUncertain: true };
    }
    return read(parameters);
  }), errorCode('PICKUP_CALENDAR_TIMEOUT'));
  assert.deepEqual(mutations, [{ action: 'slot', dateId: 'date8', value: A }]);
  assert.ok(f.elapsed() >= 20000 && f.elapsed() <= 21000);
  assert.equal(await f.page.locator('select').inputValue(), '');
  assert.deepEqual((await f.counters()).slotChanges, []);
  await assertNoPayment(f);
});

test('prepareCheckout reentry preserves an unapplied uncertain slot and never mutates an alternative', { timeout: 15000 }, async t => {
  const f = await fixture(t, body(date(8, true) + dropdown(placeholder + option(A) + option(B))));
  const { session, calls } = safariFor(f, {
    beforeEvaluate(call) {
      if (call.calendar && call.action === 'slot') throw Error('SAFARI_UNCERTAIN');
    },
  });
  const outcomes = [];
  for (let entry = 0; entry < 2; entry++) {
    try {
      await session.prepareCheckout(selection, 'R119', () => {});
      outcomes.push('unexpected-success');
    } catch (error) {
      outcomes.push(error.message);
    }
  }
  const counters = await f.counters();
  assert.deepEqual({
    outcomes, slotAttempts: slotAttempts(calls), dateAttempts: dateAttempts(calls).length,
    slotChanges: counters.slotChanges, continues: counters.continues, storeClicks: counters.storeClicks,
  }, {
    outcomes: ['PICKUP_CALENDAR_TIMEOUT', 'PICKUP_CALENDAR_TIMEOUT'],
    slotAttempts: [A], dateAttempts: 0, slotChanges: [], continues: [], storeClicks: 0,
  });
  assert.equal(await f.page.locator('select').inputValue(), '');
  await assertNoPayment(f);
});

for (const kind of ['empty', 'disabled', 'missing']) {
  test('checked day with ' + kind + ' dropdown settles passively then permits the next enabled date', { timeout: 15000 }, async t => {
    const initial = kind === 'missing' ? '' : dropdown(kind === 'empty' ? placeholder : option(A), kind === 'disabled' ? 'disabled' : '');
    const f = await fixture(t, body(date(8, true) + date(9) + '<div id="calendar-window">' + initial + '</div>'));
    const { session, calls } = safariFor(f);
    await f.page.evaluate(html => {
      document.getElementById('date9').onclick = () => {
        document.getElementById('calendar-window').innerHTML = html;
      };
    }, dropdown(placeholder + option(NEXT_DAY)));
    const initialSnapshot = await calendarRead(session)({ action: 'read' });
    assert.equal(initialSnapshot.reason, 'date-no-slots');
    assert.equal(initialSnapshot.ready, false);
    const chosen = await choose(f, calendarRead(session));
    assert.equal(chosen.dateId, 'date9');
    assert.equal(chosen.value, NEXT_DAY);
    assert.deepEqual(slotAttempts(calls), [NEXT_DAY]);
    const counters = await f.counters();
    assert.deepEqual(counters.dateClicks.map(click => click.id), ['date9']);
    assert.ok(counters.dateClicks[0].at - BASE >= 300, 'empty day must first settle passively');
    assert.ok(f.elapsed() < 20000, 'a usable alternate day must not consume the calendar timeout');
    assert.equal(counters.storeClicks, 0);
    await assertNoPayment(f);
  });
}

test('hidden existing dropdown with options stays unready and cannot be treated as an empty day', { timeout: 15000 }, async t => {
  const f = await fixture(t, body(date(8, true) + date(9) + dropdown(option(A), 'hidden')));
  const { session, calls } = safariFor(f);
  const snapshot = await calendarRead(session)({ action: 'read' });
  assert.equal(snapshot.ready, false);
  assert.notEqual(snapshot.reason, 'date-no-slots');
  await assert.rejects(choose(f, calendarRead(session)), errorCode('PICKUP_CALENDAR_TIMEOUT'));
  assert.deepEqual(dateAttempts(calls), []);
  assert.deepEqual(slotAttempts(calls), []);
  await assertNoPayment(f);
});

test('planner ignores the closest option inherited from a disabled optgroup', { timeout: 15000 }, async t => {
  const f = await fixture(t, body(date(8, true) + dropdown(placeholder
    + '<optgroup label="Unavailable" disabled>' + option(A) + '</optgroup>' + option(B))));
  const { session, calls } = safariFor(f);
  const snapshot = await calendarRead(session)({ action: 'read' });
  assert.equal(snapshot.slots.some(slot => slot.value === A && !slot.disabled), false);
  const chosen = await choose(f, calendarRead(session));
  assert.equal(chosen.value, B);
  assert.deepEqual(slotAttempts(calls), [B]);
  await continuePickup(session, chosen);
  assert.deepEqual((await f.counters()).continues.map(click => click.value), [B]);
  await assertNoPayment(f);
});

test('disabled scheduled Continue reports the explicit pre-dispatch loading result', { timeout: 15000 }, async t => {
  const f = await fixture(t, body(date(8, true) + dropdown(option(A))));
  const { session } = safariFor(f);
  await f.page.locator('#next').evaluate(element => { element.disabled = true; });
  await assert.rejects(continuePickup(session), errorCode('PICKUP_CONTINUE_LOADING'));
  assert.equal((await f.counters()).continues.length, 0);
  await assertNoPayment(f);
});

test('Continue disabled for 200 fake milliseconds waits without another slot mutation', { timeout: 15000 }, async t => {
  const f = await fixture(t, body(date(8, true) + dropdown(placeholder + option(A))));
  const { session, calls } = safariFor(f);
  await installContactTransition(f);
  await f.page.evaluate(() => {
    document.querySelector('select').addEventListener('change', () => {
      document.getElementById('next').disabled = true;
      window.__calendarRegression.continueReadyAt = Date.now() + 200;
    });
  });
  f.onSleep = () => f.page.evaluate(() => {
    if (Date.now() >= window.__calendarRegression.continueReadyAt) {
      const button = document.getElementById('next');
      if (button) button.disabled = false;
    }
  });
  const result = await session.prepareCheckout(selection, 'R119', () => {});
  assert.equal(result.store.id, 'R119');
  const counters = await f.counters();
  assert.deepEqual(counters.slotChanges, [A]);
  assert.deepEqual(slotAttempts(calls), [A]);
  assert.deepEqual(counters.dateClicks, []);
  assert.equal(counters.continues.length, 1);
  assert.ok(counters.continues[0].at >= counters.continueReadyAt);
  assert.ok(f.elapsed() >= 200 && f.elapsed() < 2000);
  assert.ok(calls.some(call => call.action === 'pickup-continue'
    && call.result?.ok === false && call.result.code === 'PICKUP_CONTINUE_LOADING'));
  await assertNoPayment(f);
});

test('already selected optimal date seeds planning even when DOM dates are reversed', { timeout: 15000 }, async t => {
  const f = await fixture(t, body(date(9) + date(8, true) + dropdown(option(A))));
  const { session, calls } = safariFor(f);
  await f.page.evaluate(({ today, tomorrow }) => {
    for (const day of [8, 9]) {
      document.getElementById('date' + day).onclick = () => {
        document.querySelector('select').innerHTML = day === 8 ? today : tomorrow;
      };
    }
  }, { today: option(A), tomorrow: option(NEXT_DAY) });
  const chosen = await choose(f, calendarRead(session));
  assert.equal(chosen.dateId, 'date8');
  assert.equal(chosen.value, A);
  assert.deepEqual(dateAttempts(calls), []);
  assert.deepEqual(slotAttempts(calls), []);
  assert.deepEqual((await f.counters()).dateClicks, []);
  assert.equal(f.elapsed(), 0);
  await assertNoPayment(f);
});

for (const disabledBy of ['fieldset', 'aria']) {
  test('calendar skips a date disabled by ' + disabledBy + ' without waiting for its impossible click', { timeout: 15000 }, async t => {
    const disabledDate = disabledBy === 'fieldset' ? '<fieldset disabled>' + date(8) + '</fieldset>'
      : date(8).replace('type="radio"', 'type="radio" aria-disabled="true"');
    const f = await fixture(t, body(disabledDate + date(9) + dropdown(placeholder + option(NEXT_DAY))));
    const { session, calls } = safariFor(f);
    const chosen = await choose(f, calendarRead(session));
    assert.equal(chosen.dateId, 'date9');
    assert.equal(chosen.value, NEXT_DAY);
    assert.deepEqual((await f.counters()).dateClicks.map(event => event.id), ['date9']);
    assert.deepEqual(slotAttempts(calls), [NEXT_DAY]);
    assert.equal(f.elapsed(), 0, 'disabled date must not consume a calendar timeout');
    await assertNoPayment(f);
  });
}

test('calendar waits for an inherited disabled slot selector before changing its value', { timeout: 15000 }, async t => {
  const f = await fixture(t, body(date(8, true) + '<fieldset id="slot-fieldset" disabled>'
    + dropdown(placeholder + option(A)) + '</fieldset>'));
  const { session } = safariFor(f);
  await f.page.evaluate(() => {
    document.querySelector('select').addEventListener('change', event => {
      window.__calendarRegression.changedWhileDisabled = event.target.matches(':disabled');
    });
  });
  // The independent fixture clock controls when Apple enables the selector.
  f.onSleep = async () => {
    if (f.elapsed() >= 200) await f.page.locator('#slot-fieldset').evaluate(element => { element.disabled = false; });
  };
  const chosen = await choose(f, calendarRead(session));
  assert.equal(chosen.value, A);
  assert.equal(await f.page.evaluate(() => window.__calendarRegression.changedWhileDisabled), false);
  assert.ok(f.elapsed() >= 200 && f.elapsed() < 20000);
  assert.deepEqual((await f.counters()).slotChanges, [A]);
  await assertNoPayment(f);
});

for (const disabledControl of ['date-fieldset', 'date-aria', 'slot-fieldset', 'slot-aria']) {
  test('guarded Continue rejects a planned control withdrawn through ' + disabledControl, { timeout: 15000 }, async t => {
    const f = await fixture(t, body(date(8, true) + dropdown(option(A))));
    const { session } = safariFor(f);
    const chosen = await choose(f, calendarRead(session));
    await f.page.evaluate(kind => {
      const element = document.querySelector(kind.startsWith('date') ? '#date8' : 'select');
      if (kind.endsWith('aria')) element.setAttribute('aria-disabled', 'true');
      else {
        const fieldset = document.createElement('fieldset'); fieldset.disabled = true;
        element.before(fieldset); fieldset.append(element);
      }
    }, disabledControl);
    await assert.rejects(continuePickup(session, chosen), errorCode('PICKUP_TIME_REQUIRED'));
    assert.equal((await f.counters()).continues.length, 0);
    await assertNoPayment(f);
  });
}

test('Continue inherited disabled state waits before any submission', { timeout: 15000 }, async t => {
  const f = await fixture(t, body(date(8, true) + dropdown(option(A))));
  const { session } = safariFor(f);
  await f.page.locator('#next').evaluate(element => {
    const fieldset = document.createElement('fieldset'); fieldset.disabled = true;
    element.before(fieldset); fieldset.append(element);
  });
  await assert.rejects(continuePickup(session), errorCode('PICKUP_CONTINUE_LOADING'));
  assert.equal((await f.counters()).continues.length, 0);
  await assertNoPayment(f);
});

for (const offered of [true, false]) for (const loseStoreReply of [false, true]) {
  test('cold Store response fences ' + (offered ? 'calendar' : 'not-offered')
    + ' and Continue' + (loseStoreReply ? ' after a lost Store JavaScript reply' : ''), { timeout: 15000 }, async t => {
    const arrived = deferred(), release = deferred();
    let responseReleased = false, selectRequests = 0, lost = false;
    const f = await fixture(t, summary + store(false) + '<div id="calendar-window"></div>' + next, {
      async onSelect(route) {
        selectRequests++;
        arrived.resolve();
        await release.promise;
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      },
    });
    t.after(() => release.resolve());
    await installContactTransition(f);
    await f.page.evaluate(({ url, html, offered }) => {
      window.__fixtureSelectApplied = false;
      document.getElementById('store').onclick = () => {
        // Native radio selection is immediate. No busy marker is added.
        window.__fixtureSelectTask = fetch(url).then(response => response.json()).then(() => {
          window.__fixtureSelectApplied = true;
          window.__fixtureSelectAppliedAt = Date.now();
          if (offered) document.getElementById('calendar-window').innerHTML = html;
        });
      };
    }, { url: SELECT_URL, html: date(8, true) + dropdown(placeholder + option(A)), offered });
    const { session } = safariFor(f, {
      loseReply(call) {
        if (loseStoreReply && !lost && ['store','store-calendar'].includes(call.action)) { lost = true; return true; }
        return false;
      },
    });
    const stages = [], pendingReadiness = [];
    let continueGuardChecked = false;
    f.onSleep = async () => {
      await arrived.promise;
      if (responseReleased) return;
      const snapshot = await calendarRead(session)({ action: 'read' });
      pendingReadiness.push({ ready: snapshot.ready, windowMode: snapshot.windowMode });
      if (!continueGuardChecked) {
        continueGuardChecked = true;
        await assert.rejects(continuePickup(session, { windowMode: 'not-offered' }),
          errorCode('PICKUP_CONTINUE_LOADING'));
      }
      if (f.elapsed() >= 10000) {
        responseReleased = true;
        release.resolve();
        await f.page.evaluate(() => window.__fixtureSelectTask);
        // Fetch/body completion can precede Chrome's delivery of resource
        // PerformanceObserver callbacks. Synchronize with the actual observer;
        // never manufacture or change its response-completion metadata.
        await f.page.waitForFunction(() =>
          window.__applePickupStoreSelection?.responseComplete === true, undefined, { polling: 10 });
        // NoOffer alone uses a 150 ms performance.now grace. Date-only fake
        // sleeps do not advance that clock; scheduled calendars need no grace.
        if (!offered) await new Promise(resolve => setTimeout(resolve, 160));
      }
    };
    const result = await session.prepareCheckout(selection, 'R119', () => {}, code => {
      stages.push({ code, at: f.now(), responseReleased });
    });
    assert.equal(result.store.id, 'R119');
    assert.equal(selectRequests, 1);
    assert.equal(lost, loseStoreReply);
    assert.ok(pendingReadiness.length >= 2, 'selection response must remain pending across multiple reads');
    assert.ok(pendingReadiness.every(snapshot => !snapshot.ready && snapshot.windowMode !== 'not-offered'));
    const counters = await f.counters();
    assert.equal(counters.storeClicks, 1);
    assert.equal(counters.continues.length, 1);
    assert.equal(counters.continues[0].beforeSelect, false);
    assert.ok(counters.continues[0].at >= BASE + 10000);
    assert.ok(stages.filter(stage => ['PICKUP_TIME_NOT_OFFERED', 'PICKUP_TIME_VERIFIED'].includes(stage.code))
      .every(stage => stage.responseReleased), 'neither schedule result may precede the Store response');
    assert.ok(stages.some(stage => stage.code === (offered ? 'PICKUP_TIME_VERIFIED' : 'PICKUP_TIME_NOT_OFFERED')));
    assert.ok(stages.filter(stage => ['PICKUP_STORE_SELECTED','PICKUP_DATE_SELECTED','PICKUP_TIME_SELECTED'].includes(stage.code)).every(stage => stage.responseReleased));
    assert.ok(stages.some(stage => stage.code === 'PICKUP_STORE_SELECTED'));
    for (const code of ['PICKUP_DATE_SELECTED','PICKUP_TIME_SELECTED']) assert.equal(stages.some(stage => stage.code === code), offered);
    if (offered) {
      assert.equal(stages.some(stage => stage.code === 'PICKUP_TIME_NOT_OFFERED'), false);
      assert.deepEqual(counters.slotChanges, [A]);
      assert.equal(counters.continues[0].value, A);
    } else {
      assert.deepEqual(counters.slotChanges, []);
      assert.equal(counters.continues[0].value, null);
    }
    await assertNoPayment(f);
  });
}

const modeURL = '/jp/shop/apw/checkoutx?_a=selectFulfillmentLocationAction&_m=checkout.fulfillment.fulfillmentOptions';
const modeFixture = summary + store() + date(8, true) + dropdown(option(A)) + next
  + '<script>window.modeClicks=[];document.querySelectorAll("[role=radio]").forEach((e,i)=>e.onclick=()=>{window.modeClicks.push(i);document.querySelectorAll("[role=radio]").forEach(n=>n.setAttribute("aria-checked",String(n===e)));void fetch(' + JSON.stringify(modeURL) + ').then(r=>r.json());});</script>';
for (const lost of [false, true]) test('fulfillment response fence waits for Apple despite optimistic radio and ' + (lost ? 'lost reply' : 'normal reply'), async t => {
  const release = deferred(); let received = false, completed = false;
  const f = await fixture(t, modeFixture, { onFulfillment: async route => { received = true; await release.promise; await route.fulfill({ status:200,contentType:'application/json',body:'{}' }); } });
  const {session:s} = safariFor(f, {loseReply: c => lost && c.action==='fulfillment-mode'});
  f.onSleep = async () => {
    if (f.elapsed() < 1000) assert.equal(completed, false);
    if (f.elapsed() >= 1000) { release.resolve(); await f.page.waitForFunction(()=>window.__applePickupFulfillmentChange?.responseComplete); await f.page.waitForTimeout(170); }
  };
  const result = await s.ensureFulfillment('delivery'); completed = true; release.resolve();
  assert.ok(received); assert.ok(f.elapsed() >= 1000); assert.equal(result.fulfillmentResponseVerified,true);
  assert.deepEqual(await f.page.evaluate(()=>window.modeClicks), [1]); await assertNoPayment(f);
});
test('pending fulfillment response blocks reverse mode, CAP, Store and calendar without replay', async t => {
  const release=deferred();let count=0;
  const f=await fixture(t,modeFixture,{onFulfillment:async route=>{count++;await release.promise;await route.fulfill({status:200,contentType:'application/json',body:'{}'});}});
  const {session:s}=safariFor(f);await s.action('fulfillment-mode',{mode:'delivery'});
  try {
    assert.equal((await s.inspect()).pending,true);
    for(const p of [{action:'fulfillment-mode',mode:'pickup'},{action:'fulfillment-mode',mode:'pickup',returnAfterDelivery:true},{action:'store',storeId:'R119'},{action:'postal-open',postalCode:'150-0041'},{action:'pickup-continue',storeId:'R119'}])await assert.rejects(s.action(p.action,p),/PAGE_BUSY/);
    const read=await f.page.evaluate(source=>(0,eval)('('+source+')')({action:'read',storeId:'R119',storeLabels:['渋谷']}),pickupScheduleDOM.toString());
    assert.equal(read.reason,'fulfillment-response-pending');
  } finally {release.resolve();await f.page.waitForTimeout(30);}
  assert.equal(count,1);await assertNoPayment(f);
});
test('pickup refresh serializes actual responses and removes fixed mode sleeps after verification', async t=>{
  let inFlight=0,max=0;const pending=[];
  const f=await fixture(t,modeFixture,{onFulfillment:async route=>{const release=deferred();pending.push(release);inFlight++;max=Math.max(max,inFlight);await release.promise;await route.fulfill({status:200,contentType:'application/json',body:'{}'});inFlight--;}});
  const {session:s}=safariFor(f);let releases=0;
  f.onSleep=async()=>{if(pending.length>releases&&f.elapsed()>=(releases+1)*1000){pending[releases++].resolve();await f.page.waitForFunction(()=>window.__applePickupFulfillmentChange?.responseComplete);await f.page.waitForTimeout(170);}};
  await s.refreshPickup();pending.forEach(p=>p.resolve());
  assert.deepEqual(await f.page.evaluate(()=>window.modeClicks),[1,0]);assert.equal(max,1);assert.equal(releases,2);
  assert.ok(!f.sleeps.includes(750)&&!f.sleeps.includes(250));assert.equal((await s.inspect()).fulfillmentMode,'pickup');await assertNoPayment(f);
});
for(const lost of [false,true])test('pickup returns before delivery document load, with '+(lost?'lost':'normal')+' reply',async t=>{
  const release=deferred();let requests=0,released=false,inFlight=0,max=0;
  const html=summary+store()+date(8,true)+dropdown(option(A))+next+'<script>window.modeClicks=[];window.modeReady="complete";Object.defineProperty(document,"readyState",{get:()=>window.modeReady,configurable:true});document.querySelectorAll("[role=radio]").forEach((e,i)=>e.onclick=()=>{window.modeClicks.push(i);if(i===0)window.returnedBeforeDeliveryLoaded=window.modeReady==="interactive";window.modeReady=i===1?"interactive":"complete";document.querySelectorAll("[role=radio]").forEach(n=>n.setAttribute("aria-checked",String(n===e)));void fetch('+JSON.stringify(modeURL)+').then(r=>r.json());});</script>';
  const f=await fixture(t,html,{onFulfillment:async route=>{requests++;inFlight++;max=Math.max(max,inFlight);if(requests===1)await release.promise;await route.fulfill({status:200,contentType:'application/json',body:'{}'});inFlight--;}});
  const {session:s}=safariFor(f,{loseReply:c=>lost&&c.action==='fulfillment-mode'&&c.mode==='pickup'});
  // Date is virtual; PerformanceObserver and its application window use real browser time.
  // Settle the intercepted response before advancing more virtual polling turns.
  f.onSleep=async()=>{if(requests===1&&!released&&f.elapsed()>=500){released=true;release.resolve();await f.page.waitForFunction(()=>window.__applePickupFulfillmentChange?.responseComplete);await f.page.waitForTimeout(170);}if(requests>=2)await f.page.waitForTimeout(180);};
  try{await s.refreshPickup();}finally{release.resolve();}
  assert.deepEqual(await f.page.evaluate(()=>window.modeClicks),[1,0]);assert.equal(await f.page.evaluate(()=>window.returnedBeforeDeliveryLoaded),true);assert.equal(max,1);assert.equal(requests,2);assert.ok(f.elapsed()<2000);assert.ok(!f.sleeps.includes(750));assert.equal((await s.inspect()).fulfillmentMode,'pickup');await assertNoPayment(f);
});

test('early pickup return respects response application while delivery document is still loading',async t=>{
 const f=await fixture(t,modeFixture),{session:s}=safariFor(f);
 await f.page.evaluate(()=>{window.fixtureClock=1000;Object.defineProperty(performance,'now',{value:()=>window.fixtureClock,configurable:true});Object.defineProperty(document,'readyState',{get:()=> 'interactive',configurable:true});document.querySelectorAll('[role=radio]').forEach((e,i)=>e.setAttribute('aria-checked',String(i===1)));window.__applePickupFulfillmentChange={mode:'delivery',responseComplete:true,responseAt:1000,startedAt:900};});
 for(const [clock,want]of [[1000,false],[1149,false],[1150,true]]){await f.page.evaluate(at=>{window.fixtureClock=at;},clock);const state=await s.inspect();assert.equal(state.fulfillmentReturnReady,want);assert.equal(state.ready,false);}
 await assertNoPayment(f);
});
