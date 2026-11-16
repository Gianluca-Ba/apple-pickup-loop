import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function desktopNotification(n, { run = execFile } = {}) {
  if (process.env.CHECKOUT_DISABLE_NATIVE === '1' && run === execFile) return;
  const title = n.type === 'success' ? 'Acquisto Apple confermato' : 'Apple Loop · Intervento richiesto';
  const quote = value => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
  const payOpened = n.code === 'PAYMENT_AUTHORIZE';
  const sound = n.type === 'success' ? 'Hero' : 'Glass';
  const child = run('/usr/bin/osascript', ['-'], { timeout: 5000, maxBuffer: 1024 }, () => {});
  child.stdin?.on('error', () => {});
  child.stdin?.end(`display notification ${quote(n.message)} with title ${quote(title)}${payOpened ? '' : ' sound name ' + quote(sound)}`);
  if (payOpened) run('/usr/bin/afplay', [fileURLToPath(new URL('./assets/apple-pay-siren.wav', import.meta.url))], { timeout: 5000, maxBuffer: 1024 }, () => {});
}
