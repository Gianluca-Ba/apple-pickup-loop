import { chmodSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const guestProfileDirectory = resolve(fileURLToPath(new URL('./.stock-guest-profile/', import.meta.url)));
const markerName = 'stock-profile-owner.json';
const owner = { purpose: 'iphone-duo-unauthenticated-stock', version: 1 };

// Never adopt an existing unmarked directory or follow a profile symlink.
export function prepareGuestProfile(directory = guestProfileDirectory) {
  directory = resolve(directory);
  const existing = lstatSync(directory, { throwIfNoEntry: false });
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) throw Error('Guest profile must be a dedicated directory, not a link');
  if (!existing) {
    mkdirSync(directory, { mode: 0o700 });
    writeFileSync(join(directory, markerName), JSON.stringify(owner) + '\n', { mode: 0o600, flag: 'wx' });
  }
  const marker = join(directory, markerName);
  const info = lstatSync(marker, { throwIfNoEntry: false });
  if (!info?.isFile() || info.isSymbolicLink()) throw Error('Existing guest profile is not owned by this monitor');
  let data;
  try { data = JSON.parse(readFileSync(marker, 'utf8')); } catch { throw Error('Guest profile ownership marker is invalid'); }
  if (data.purpose !== owner.purpose || data.version !== owner.version) throw Error('Guest profile ownership marker does not match');
  chmodSync(directory, 0o700); chmodSync(marker, 0o600);
  return directory;
}
