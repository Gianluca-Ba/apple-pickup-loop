import { execFile as execCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { publicAppleURL, validSKU } from './shared.mjs';
const execFile = promisify(execCallback);
export const CATEGORIES = Object.freeze([
  { id: 'iphone', name: 'iPhone', url: '/jp/shop/buy-iphone' },
  { id: 'ipad', name: 'iPad', url: '/jp/shop/buy-ipad' },
  { id: 'mac', name: 'Mac', url: '/jp/shop/buy-mac' },
  { id: 'watch', name: 'Apple Watch', url: '/jp/shop/buy-watch' },
  { id: 'airpods', name: 'AirPods', url: '/jp/airpods/' },
  { id: 'home', name: 'HomePod e Apple TV', url: '/jp/tv-home/' },
  { id: 'vision', name: 'Apple Vision', url: '/jp/apple-vision-pro/' },
]);
const clean = s => String(s ?? '').replace(/<as-footnote\b[\s\S]*?<\/as-footnote>/g, '').replace(/<sup\b[\s\S]*?<\/sup>/g, '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;|\u00a0/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
export function jsonObjectAt(source, offset) {
  const start = source.indexOf('{', offset); if (start < 0) return null;
  let depth = 0, quoted = false, escaped = false;
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; }
    else if (c === '"') quoted = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) { try { return JSON.parse(source.slice(start, i + 1)); } catch { return null; } }
  }
  return null;
}
export function parseCatalogIndex(html, category) {
  html = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html)?.[1] ?? html;
  const products = new Map();
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let url; try { url = publicAppleURL(m[1].replaceAll('&amp;', '&')); } catch { continue; }
    const path = new URL(url).pathname;
    const family = /^\/jp\/shop\/buy-[a-z-]+\/[^/]+$/.test(path) || ['watch', 'vision'].includes(category.id) && /^\/jp\/shop\/buy-[a-z-]+\/[^/]+\/[^/]+$/.test(path);
    const device = /^\/jp\/shop\/(?:product\/|goto\/buy_(?:airpods|homepod|tv|vision)\/)/.test(path) && /airpods|homepod|apple.?tv|vision|buy_tv/i.test(decodeURIComponent(path) + ' ' + clean(m[2]));
    if (!family && !device || /carrier-offers|accessories|bands/.test(path)) continue;
    if (category.id === 'iphone' && !path.includes('/buy-iphone/')) continue;
    if (['mac', 'ipad', 'watch'].includes(category.id) && !path.includes('/buy-' + category.id + '/')) continue;
    if (category.id === 'vision' && !path.includes('vision')) continue;
    const name = clean(m[2]).replace(/^NEW\s+/i, '').replace(/(?:購入|Buy|詳しく).*$/i, '').trim();
    if (!products.has(url) || name && name.length < (products.get(url).name.length || 1000)) products.set(url, { id: url, category: category.id, name: name && name.length <= 100 ? name : decodeURIComponent(path.split('/').at(-1)).replaceAll('-', ' '), url });
  }
  return [...products.values()];
}
export function parseConfigurations(html, product) {
  let metrics = {}, selection = null, structured = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/id=["']metrics["']/.test(m[1])) { try { metrics = JSON.parse(m[2]).data ?? {}; } catch {} }
    if (/application\/ld\+json/.test(m[1])) { try { const value = JSON.parse(m[2]); structured.push(...(Array.isArray(value) ? value : [value])); } catch {} }
    const i = m[2].indexOf('productSelectionData:');
    if (i >= 0) selection = jsonObjectAt(m[2], i);
  }
  const official = structured.find(p => p['@type'] === 'Product');
  const canonicalURL = official?.url ? (() => { try { return publicAppleURL(official.url); } catch { return product.url; } })() : product.url;
  const prices = new Map((metrics.products ?? []).filter(p => validSKU(p.partNumber)).map(p => [p.partNumber, p]));
  const offers = official?.offers ? Array.isArray(official.offers) ? official.offers : [official.offers] : [];
  for (const offer of offers) if (!prices.has(offer.sku) && validSKU(offer.sku) && offer.priceCurrency === 'JPY' && Number.isSafeInteger(Number(offer.price))) prices.set(offer.sku, { name: official.name, price: { fullPrice: Number(offer.price) } });
  const variants = new Map();
  for (const p of selection?.products ?? []) {
    const sku = p.partNumber ?? p.btrOrFdPartNumber;
    if (!validSKU(sku) || p.isCarrierDevice === true || p.carrierPolicyType === 'POSTPAID' || p.isComingSoon || p.comingSoon) continue;
    const metric = prices.get(sku);
    const priceJPY = Number(metric?.price?.fullPrice ?? selection?.mainDisplayValues?.prices?.[p.priceKey]?.amount ?? (typeof p.fullPrice === 'number' ? p.fullPrice : NaN));
    const dimensions = {};
    for (const [key, value] of Object.entries(p.dimensions ?? p)) {
      if (/^(dimension|chassis-dimension|processor-cpu)/.test(key) && typeof value === 'string' && value.length < 150) dimensions[key] = clean(selection?.displayValues?.[key]?.[value]?.value ?? selection?.mainDisplayValues?.[key]?.[value]?.header ?? value);
    }
    const name = clean(metric?.name ?? [product.name, ...Object.values(dimensions)].join(' · '));
    const url = p.seoUrlToken ? publicAppleURL(canonicalURL.replace(/\/$/, '') + '/' + encodeURIComponent(p.seoUrlToken)) : publicAppleURL('https://www.apple.com/jp/shop/product/' + sku);
    const local = product.category === 'iphone' && metric?.name ? metric.name.replace(/\b(?:256GB|512GB|1TB|2TB)\b.*$/, '').trim() + ' ' + (dimensions.dimensionCapacity ?? '') + ' ' + (dimensions.dimensionColor ?? '') : null;
    variants.set(sku, { sku, name, names: [...new Set([name, local].filter(Boolean))], priceJPY: Number.isSafeInteger(priceJPY) && priceJPY > 0 ? priceJPY : null, currency: 'JPY', url, category: product.category, productId: product.id, dimensions });
  }
  for (const [sku, p] of prices) if (!variants.has(sku)) {
    if ((selection?.products ?? []).some(v => (v.partNumber ?? v.btrOrFdPartNumber) === sku)) continue;
    const priceJPY = Number(p.price?.fullPrice);
    if (!Number.isSafeInteger(priceJPY) || priceJPY <= 0) continue;
    variants.set(sku, { sku, name: clean(p.name), priceJPY, currency: 'JPY', url: publicAppleURL('https://www.apple.com/jp/shop/product/' + sku), category: product.category, productId: product.id, dimensions: {} });
  }
  return [...variants.values()].sort((a, b) => (a.priceJPY ?? Infinity) - (b.priceJPY ?? Infinity) || a.name.localeCompare(b.name));
}
export async function fetchPublicPage(value) {
  const u = new URL(value, 'https://www.apple.com');
  if (u.origin !== 'https://www.apple.com' || !u.pathname.startsWith('/jp/') || u.search || u.hash) throw Error('CATALOG_URL');
  // macOS curl uses the system trust store, including this Mac's trusted roots.
  const { stdout: output } = await execFile('/usr/bin/curl', ['--fail', '--silent', '--show-error', '--location', '--max-redirs', '3', '--max-time', '25', '--max-filesize', '5000000', '--proto', '=https', '--proto-redir', '=https', '--write-out', '\n%{url_effective}', u.href], { timeout: 28000, maxBuffer: 5000000 });
  const line = output.lastIndexOf('\n'), final = new URL(output.slice(line + 1)), stdout = output.slice(0, line);
  if (final.origin !== 'https://www.apple.com' || !final.pathname.startsWith('/jp/')) throw Error('CATALOG_URL');
  if (!/<html\b/i.test(stdout) || /<title>[^<]*(?:Access Denied|403|CAPTCHA)/i.test(stdout)) throw Error('CATALOG_UNAVAILABLE');
  return stdout;
}
export class AppleCatalog {
  constructor({ fetchPage = fetchPublicPage, now = Date.now } = {}) { this.fetchPage = fetchPage; this.now = now; this.categories = []; this.products = []; this.variants = new Map(); this.updatedAt = null; this.loading = false; this.errors = []; this.loadingTask = null; }
  snapshot() { return { categories: this.categories, products: this.products, updatedAt: this.updatedAt, loading: this.loading, errors: this.errors }; }
  async refresh() {
    if (this.loadingTask) return this.loadingTask;
    this.loading = true;
    this.loadingTask = (async () => {
      const products = [], categories = [], errors = []; let refreshed = 0;
      for (const category of CATEGORIES) {
        try { const found = parseCatalogIndex(await this.fetchPage('https://www.apple.com' + category.url), category); if (!found.length) throw Error('CATALOG_SCHEMA'); products.push(...found); categories.push({ id: category.id, name: category.name }); refreshed++; }
        catch {
          errors.push(category.id);
          // A temporary failure of one index must not erase its verified
          // families. Configuration caches are still invalidated below, so
          // activation rechecks the selected SKU and price on Apple's page.
          const previous = this.products.filter(p => p.category === category.id);
          if (previous.length) { products.push(...previous); categories.push({ id: category.id, name: category.name }); }
        }
      }
      if (!refreshed) throw Error('CATALOG_UNAVAILABLE');
      this.products = products; this.categories = categories; this.errors = errors; this.variants.clear(); this.updatedAt = this.now();
      return this.snapshot();
    })().finally(() => { this.loading = false; this.loadingTask = null; });
    return this.loadingTask;
  }
  async configurations(id) {
    const product = this.products.find(p => p.id === id); if (!product) throw Error('PRODUCT_NOT_IN_CATALOG');
    if (!this.variants.has(id)) this.variants.set(id, parseConfigurations(await this.fetchPage(product.url), product));
    return this.variants.get(id);
  }
  async resolve(id, sku) {
    const variant = (await this.configurations(id)).find(v => v.sku === sku);
    if (!variant?.priceJPY) throw Error('CONFIGURATION_PRICE_UNVERIFIED');
    return structuredClone(variant);
  }
}
