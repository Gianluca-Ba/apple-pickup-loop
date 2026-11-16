import { existsSync, readdirSync, readFileSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { STORES, jst } from './shared.mjs';
import { writeJSON } from './storage.mjs';
const privateKey = /password|credential|username|email|phone|mobile|address|street|city|postal|card|cvc|cvv|cookie|token|secret|fingerprint|ipaddress|order.?number|order.?id|billing|url|href|sessionid|authorization/i;
const numericKey = /(?:At|Ms|Bytes|MiB|KiB|Count|Requests|Checks|Successes|Attempts|Failures|Percent|Seconds|Total|Memory|Duration|Latency|CPU|RSS|Heap|Pause|Interval|Cycle|Samples|Limit|Active|Ready|Available|Unavailable|Progress|Started|Finished|Observed|Updates|Errors|Connections|Tunnels|VMs|Workers|Containers|Nodes|Slots|Tests|Pass|Fail|Requests|checks|successes|attempts|failures|cpu|rss|heap|memory|duration|latency|cycle)$/i;
const enumKey = /^(?:phase|state|step|result|type|stage|source|code|status|id|partNumber|sku)$/;
export function statisticalProjection(value, key = '', depth = 0) {
  if (privateKey.test(key) || depth > 18) return undefined;
  if (typeof value === 'number') return Number.isFinite(value) && numericKey.test(key) ? value : undefined;
  if (typeof value === 'boolean') return /^(?:ok|passed|failed|closedByGap|enabled|active|ready|busy|available|verified|confirmed)$/.test(key) ? value : undefined;
  if (typeof value === 'string') return enumKey.test(key) && /^(?:[a-z][a-z0-9-]{0,60}|R\d{3}|[A-Z0-9]{5,12}J\/A)$/.test(value) ? value : undefined;
  if (Array.isArray(value)) { const projected = value.map(v => statisticalProjection(v, key, depth + 1)).filter(v => v !== undefined); return projected.length ? projected : undefined; }
  if (value && typeof value === 'object') { const projected = {}; for (const [k, v] of Object.entries(value)) { const p = statisticalProjection(v, k, depth + 1); if (p !== undefined) projected[k] = p; } return Object.keys(projected).length ? projected : undefined; }
  return undefined;
}
export function collectPreviousStatistics(root, additionalWorkers = []) {
  const workerTotals = new Map(additionalWorkers.filter(w => /^(?:mac|pilot(?:[1-9]|1[0-9])|vm[1-9]|win(?:[1-9]|10))$/.test(w.id)).map(w => [w.id, { id: w.id, attempts: Number.isSafeInteger(w.attempts) ? w.attempts : 0, successes: Number.isSafeInteger(w.successes) ? w.successes : 0 }]));
  let highestCounter = 0;
  const scan = value => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { for (const child of value) scan(child); return; }
    const id = value.id;
    if (typeof id === 'string' && /^(?:mac|pilot(?:[1-9]|1[0-9])|vm[1-9]|win(?:[1-9]|10))$/.test(id)) {
      const old = workerTotals.get(id) ?? { id, successes: 0, attempts: 0 };
      for (const [field, candidates] of Object.entries({ successes: ['workerSuccesses', 'successes', 'completedChecks', 'checks'], attempts: ['workerAttempts', 'attempts'] })) for (const candidate of candidates) if (Number.isSafeInteger(value[candidate]) && value[candidate] >= 0) old[field] = Math.max(old[field], value[candidate]);
      workerTotals.set(id, old);
    }
    for (const key of ['totalRequests','totalChecks','checks']) if (Number.isSafeInteger(value[key]) && value[key] >= 0) highestCounter = Math.max(highestCounter, value[key]);
    for (const [key, child] of Object.entries(value)) if (!privateKey.test(key)) scan(child);
  };
  const files = [], logs = join(root, 'logs');
  if (existsSync(logs)) for (const name of readdirSync(logs)) {
    if (!/^[a-zA-Z0-9_.-]+\.(json|txt|jsonl)$/.test(name)) continue;
    const path = join(logs, name); if (!statSync(path).isFile() || statSync(path).size > 20000000) continue;
    const raw = readFileSync(path, 'utf8'); const rows = [];
    try { rows.push(JSON.parse(raw)); } catch { for (const line of raw.split('\n')) try { rows.push(JSON.parse(line)); } catch {} }
    for (const row of rows) scan(row);
    const projected = statisticalProjection(rows); if (projected) files.push({ name, metrics: projected });
  }
  const macPath = join(root, 'fleet-mac-ledger.json');
  if (existsSync(macPath)) { const mac = JSON.parse(readFileSync(macPath)); scan({ id: 'mac', attempts: mac.attempts, successes: mac.successes }); }
  let stockDrops = null, dropCount = 0; const dropPath = join(logs, 'stock-drop-history.json');
  if (existsSync(dropPath)) {
    const raw = JSON.parse(readFileSync(dropPath));
    const drops = {};
    for (const store of STORES) {
      const rows = raw.drops?.[store.id]; if (!Array.isArray(rows)) continue;
      drops[store.id] = rows.flatMap(row => {
        if (!Number.isSafeInteger(row.firstAvailableAt) || !Number.isSafeInteger(row.lastAvailableAt)) return [];
        dropCount++; return [{ firstAvailableAt: row.firstAvailableAt, lastAvailableAt: row.lastAvailableAt, firstUnavailableAt: Number.isSafeInteger(row.firstUnavailableAt) ? row.firstUnavailableAt : null, closedByGap: row.closedByGap === true }];
      });
    }
    stockDrops = { version: 1, partNumber: /^[A-Z0-9]{5,12}J\/A$/.test(raw.partNumber) ? raw.partNumber : null, drops };
  }
  const workers = [...workerTotals.values()];
  return { version: 2, migratedAt: jst(), checks: Math.max(highestCounter, workers.reduce((n, w) => n + w.successes, 0)), dropCount, workers, stockDrops, files };
}
export function savePreviousStatistics(root, storage, additionalWorkers) {
  const statistics = collectPreviousStatistics(root, additionalWorkers); writeJSON(join(root, 'data', 'previous-statistics.json'), statistics);
  storage.statistics.previous = { checks: statistics.checks, dropCount: statistics.dropCount }; storage.saveStatistics(); return statistics;
}
export function removeLegacyPersonalFiles(root) {
  const directories = ['logs','work','fixtures','private-browser-profile','private-browser-profile-backup','.stock-guest-profile','dashboard','vm','native','__pycache__'];
  for (const name of directories) rmSync(join(root, name), { recursive: true, force: true });
  const keep = new Set(['package.json','package-lock.json','fleet-mac-ledger.json','stock-monitor-state.json','monitor-fleet.json']);
  let count = 0;
  for (const name of readdirSync(root)) {
    if (name === 'app' || name === 'node_modules' || name === 'data' || name === '.git' || name === '.gitignore' || name === 'README.md' || name === 'dashboard-server.mjs' || keep.has(name)) continue;
    if (/\.(?:mjs|js|py|json|jsonl|txt|html|png|jpe?g|webp|har|zip|log|pdf)$/.test(name) || name.startsWith('.env') || /local|profile-backup/.test(name)) { rmSync(join(root, name), { recursive: true, force: true }); count++; }
  }
  return { removedRootFiles: count, removedDirectories: directories.length };
}
