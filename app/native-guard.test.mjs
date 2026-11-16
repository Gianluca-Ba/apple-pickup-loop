import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
test('native window references remain bound to their unique ID across z-order changes offline',{skip:process.platform!=='darwin'},t=>{
 assert.equal(process.env.CHECKOUT_DISABLE_NATIVE,'1');const dir=mkdtempSync(join(tmpdir(),'apple-window-target-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const bin=join(dir,'fixture');
 execFileSync('/usr/bin/clang',['-fobjc-arc','-O2','-framework','Foundation',fileURLToPath(new URL('./native/window-target-tests.m',import.meta.url)),'-o',bin],{timeout:30000});
 assert.match(execFileSync(bin,{encoding:'utf8',timeout:5000}),/Stable window target fixtures passed/);
});
test('native guard preserves native sheets, prunes web content and refuses incomplete trees offline', { skip: process.platform !== 'darwin' }, t => {
  assert.equal(process.env.CHECKOUT_DISABLE_NATIVE,'1');
  const dir=mkdtempSync(join(tmpdir(),'apple-native-guard-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const bin=join(dir,'fixture');
  execFileSync('/usr/bin/clang',['-fobjc-arc','-O2','-framework','Foundation','-framework','ApplicationServices',fileURLToPath(new URL('./native/ax-guard-tests.m',import.meta.url)),'-o',bin],{timeout:30000});
  assert.match(execFileSync(bin,{encoding:'utf8',timeout:5000}),/Native guard fixtures passed/);
});
test('persistent native commands process fresh application-state notifications before each guard', { skip:process.platform!=='darwin' },t=>{
  assert.equal(process.env.CHECKOUT_DISABLE_NATIVE,'1');const dir=mkdtempSync(join(tmpdir(),'apple-application-state-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const bin=join(dir,'fixture');
  execFileSync('/usr/bin/clang',['-fobjc-arc','-O2','-framework','Foundation',fileURLToPath(new URL('./native/application-state-tests.m',import.meta.url)),'-o',bin],{timeout:30000});
  assert.match(execFileSync(bin,{encoding:'utf8',timeout:5000}),/Application state refresh fixtures passed/);
});
test('native boolean probes distinguish unavailable replies from verified ownership loss offline', { skip:process.platform!=='darwin' },t=>{
  assert.equal(process.env.CHECKOUT_DISABLE_NATIVE,'1');const dir=mkdtempSync(join(tmpdir(),'apple-script-result-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const bin=join(dir,'fixture');
  execFileSync('/usr/bin/clang',['-fobjc-arc','-O2','-framework','Foundation',fileURLToPath(new URL('./native/script-result-tests.m',import.meta.url)),'-o',bin],{timeout:30000});
  assert.match(execFileSync(bin,{encoding:'utf8',timeout:5000}),/Boolean script reply fixtures passed/);
});
