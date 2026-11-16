import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The stable vendor CLI accepts credentials as positional arguments. Keep
// those arguments inside the isolated container, never in Docker/SDK metadata.
export function authenticateWindscribe(credential, { launch = spawn, status = () => spawnSync('/opt/windscribe/windscribe-cli', ['status'], { encoding:'utf8', timeout:15000, maxBuffer:65536 }), timeoutMs = 60000 } = {}) {
  if (!/^0x[a-f0-9]{32}$/.test(credential)) throw Error('WINDSCRIBE_CREDENTIAL_INVALID');
  if (process.env.CHECKOUT_DISABLE_NATIVE === '1' && launch === spawn) throw Error('NATIVE_DISABLED_OFFLINE');
  return new Promise(resolve => {
    const child = launch('/opt/windscribe/windscribe-cli', ['login', credential, credential], { stdio:['ignore','pipe','pipe'] });
    let output = '', challenge = false, timedOut = false, done = false;
    const finish = code => {
      if (done) return; done = true; clearTimeout(timer);
      if (challenge || timedOut) return resolve({ result:challenge?'human-challenge-required':'authentication-unverified', proReported:false });
      const state = status(), text = String(state.stdout ?? '') + String(state.stderr ?? '');
      const rejected = /incorrect|invalid (?:user|password|credential)|authentication failed/i.test(output);
      const accepted = /already logged in|logged in|login successful/i.test(output) && !/not logged in|logged out|login error/i.test(output);
      const confirmed = code === 0 && accepted && state.status === 0 && !/not logged in|logged out|logging in/i.test(text);
      resolve({ result:rejected?'credentials-not-accepted':confirmed?'authenticated':'authentication-unverified', proReported:/unlimited|pro account/i.test(text) });
    };
    const observe = chunk => {
      output = (output + String(chunk)).slice(-65536);
      if (!challenge && /captcha|2fa code|two.factor.*code|type the numbers/i.test(output)) { challenge = true; child.kill('SIGTERM'); }
    };
    child.stdout.on('data', observe); child.stderr.on('data', observe);
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeoutMs);
    child.once('error', () => finish(null)); child.once('close', finish);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await authenticateWindscribe(readFileSync(0,'utf8').trim()))); }
  catch { console.log(JSON.stringify({result:'authentication-unverified',proReported:false})); }
}
