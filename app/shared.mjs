export const REGION = Object.freeze({ country: 'JP', currency: 'JPY', locale: 'ja-JP', timezone: 'Asia/Tokyo' });
export const INTERVAL = 65000;
export const STORES = Object.freeze([
  { id: 'R119', name: 'Shibuya', localName: '渋谷', postalCode: '150-0041' },
  { id: 'R224', name: 'Omotesando', localName: '表参道', postalCode: '150-0001' },
  { id: 'R128', name: 'Shinjuku', localName: '新宿', postalCode: '160-0022' },
  { id: 'R079', name: 'Ginza', localName: '銀座', postalCode: '104-0061' },
  { id: 'R718', name: 'Marunouchi', localName: '丸の内', postalCode: '100-0005' },
  { id: 'R710', name: 'Kawasaki', localName: '川崎', postalCode: '212-0013' },
]);
export const validSKU = value => typeof value === 'string' && /^[A-Z0-9]{5,12}J\/A$/.test(value);
export function publicAppleURL(value) {
  const u = new URL(value, 'https://www.apple.com');
  if (u.origin !== 'https://www.apple.com' || u.username || u.password || !/^\/jp\/shop\/(?:buy-[a-z-]+(?:\/[^?#]*)?|product\/[^?#]+|goto\/buy_(?:airpods|homepod|tv|vision)(?:\/[a-z0-9_/-]+)?)$/.test(u.pathname)) throw Error('CATALOG_URL');
  u.search = ''; u.hash = ''; return u.href;
}
export function validateSelection(selection) {
  if (!selection || !validSKU(selection.sku) || selection.currency !== 'JPY' || !Number.isSafeInteger(selection.priceJPY) || selection.priceJPY <= 0 || typeof selection.name !== 'string' || !selection.name.trim() || selection.name.length > 300 || !Array.isArray(selection.stores) || !selection.stores.length || selection.stores.some(id => !STORES.some(s => s.id === id)) || new Set(selection.stores).size !== selection.stores.length) throw Error('SELECTION_INVALID');
  publicAppleURL(selection.url);
  return selection;
}
export function retryAt(value, now = Date.now()) {
  if (!value) return null;
  const n = /^\d+$/.test(value) ? now + Number(value) * 1000 : Date.parse(value);
  return Number.isSafeInteger(n) ? Math.max(now, n) : null;
}
export function parsePickup(data, selection, observedAt = Date.now()) {
  validateSelection(selection);
  if (String(data?.head?.status) !== '200' || !Array.isArray(data?.body?.stores)) throw Error('STOCK_UNKNOWN');
  const stores = selection.stores.map(id => {
    const matches = data.body.stores.filter(s => s.storeNumber === id);
    const part = matches.length === 1 ? matches[0].partsAvailability?.[selection.sku] : null;
    const regular = part?.messageTypes?.regular;
    if (part?.partNumber !== selection.sku || typeof regular?.storePickupProductTitle !== 'string' || !regular.storePickupProductTitle.trim()) throw Error('STOCK_WRONG_PRODUCT');
    let state = 'unknown';
    if (part.pickupDisplay === 'available' && part.storePickEligible === true && regular.storeSelectionEnabled === true) state = 'available';
    if (part.pickupDisplay === 'unavailable' && regular.storeSelectionEnabled === false) state = 'unavailable';
    if (state === 'unknown') throw Error('STOCK_UNKNOWN');
    return { id, state };
  });
  return { sku: selection.sku, observedAt, stores };
}
export async function pickupRequest(selection, fetcher, now = Date.now) {
  validateSelection(selection);
  const url = new URL('https://www.apple.com/jp/shop/retail/pickup-message');
  url.search = new URLSearchParams({ pl: 'true', location: STORES.find(s => s.id === selection.stores[0]).postalCode, 'parts.0': selection.sku, 'mts.0': 'regular' }).toString();
  const response = await fetcher(url, { method: 'GET', redirect: 'error', cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(15000) });
  const at = now(), deadline = retryAt(response.headers.get('retry-after'), at);
  if (!response.ok || deadline > at) throw Object.assign(Error('APPLE_PAUSE'), { httpStatus: response.status, nextAllowedAt: Math.max(deadline ?? 0, response.status === 541 ? at + 300000 : 0) || null });
  if (!response.headers.get('content-type')?.includes('application/json')) throw Object.assign(Error('APPLE_CHALLENGE'), { code: 'challenge' });
  const age = response.headers.get('age');
  if (age !== null && (!/^\d+$/.test(age) || Number(age) > 5)) throw Error('STOCK_STALE');
  return parsePickup(await response.json(), selection, now());
}
export function jst(at = Date.now()) { return new Intl.DateTimeFormat('sv-SE', { timeZone: REGION.timezone, dateStyle: 'short', timeStyle: 'medium' }).format(at) + ' JST'; }

export function validatePickupContact(contact) {
  const keys = ['lastName','firstName','emailAddress','mobilePhone'];
  if (!contact || typeof contact !== 'object' || Array.isArray(contact) || Object.keys(contact).length !== keys.length || Object.keys(contact).some(k => !keys.includes(k)) || keys.some(k => typeof contact[k] !== 'string')) throw Error('PICKUP_CONTACT_INVALID');
  const clean = Object.fromEntries(keys.map(k => [k, contact[k].trim()]));
  if ([clean.lastName,clean.firstName].some(v => !v || v.length > 100 || /[\x00-\x1f<>]/.test(v)) || clean.emailAddress.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(clean.emailAddress) || !/^\+?[0-9 ()-]{8,20}$/.test(clean.mobilePhone) || clean.mobilePhone.replace(/\D/g,'').length < 8) throw Error('PICKUP_CONTACT_INVALID');
  return clean;
}
