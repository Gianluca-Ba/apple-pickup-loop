import { execFileSync } from 'node:child_process';
import { existsSync, statSync, chmodSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
if (process.platform !== 'darwin') throw Error('macOS richiesto');
const source = fileURLToPath(new URL('./native/safari.m', import.meta.url)), destination = fileURLToPath(new URL('./native/safari', import.meta.url));
const guard = fileURLToPath(new URL('./native/ax-guard.h', import.meta.url));
const state = fileURLToPath(new URL('./native/application-state.h', import.meta.url));
const scriptResult = fileURLToPath(new URL('./native/script-result.h', import.meta.url));
const windowTarget = fileURLToPath(new URL('./native/window-target.h', import.meta.url));
if (!existsSync(destination) || Math.max(statSync(source).mtimeMs,statSync(guard).mtimeMs,statSync(state).mtimeMs,statSync(scriptResult).mtimeMs,statSync(windowTarget).mtimeMs) > statSync(destination).mtimeMs) {
  execFileSync('/usr/bin/clang', ['-fobjc-arc', '-O2', '-framework', 'Cocoa', '-framework', 'ScriptingBridge', '-framework', 'ApplicationServices', '-framework', 'Security', source, '-o', destination + '.new'], { timeout: 60000, stdio: ['ignore', 'ignore', 'pipe'] });
  chmodSync(destination + '.new', 0o700); renameSync(destination + '.new', destination);
}
