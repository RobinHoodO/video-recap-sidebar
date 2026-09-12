import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtempSync, cpSync, symlinkSync, writeFileSync, readFileSync, readdirSync, mkdirSync, rmSync } from 'node:fs';
import { stripVTControlCharacters } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const fixture = mkdtempSync(join(tmpdir(), 'video-recap-build-'));
for (const path of ['src', 'scripts', 'package.json', 'vite.config.ts']) cpSync(path, join(fixture, path), { recursive: true });
symlinkSync(resolve('node_modules'), join(fixture, 'node_modules'));
after(() => rmSync(fixture, { recursive: true, force: true }));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('VITE_')));
env.HOME = fixture;
const configRunner = `import { loadConfigFromFile } from 'vite'; const r = await loadConfigFromFile({command: process.argv[1], mode: 'production', isPreview: process.argv[2] === 'preview'}); console.log(JSON.stringify(r.config.build ?? { outDir: 'dist' }));`;
const run = (args, extra = {}) => spawnSync(process.execPath, args, { cwd: fixture, env: { ...env, ...extra }, encoding: 'utf8' });

test('development output cannot overwrite the installed production extension', () => {
  const dev = run(['--input-type=module', '-e', configRunner, 'serve']);
  const prod = run(['--input-type=module', '-e', configRunner, 'build']);
  assert.equal(dev.status, 0, dev.stderr);
  assert.equal(prod.status, 0, prod.stderr);
  assert.equal(JSON.parse(dev.stdout).outDir, 'dist-dev');
  assert.equal(JSON.parse(prod.stdout).outDir, 'dist');
  const preview = run(['--input-type=module', '-e', configRunner, 'serve', 'preview']);
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).outDir, 'dist');
});

test('direct Vite invocation rejects unresolved secret references by key name', () => {
  for (const reference of ['op://fixture/item/key', '  op://fixture/item/key  ', '"op://fixture/item/key"', "'op://fixture/item/key'", '  " op://fixture/item/key "  ']) {
    const result = run(['--input-type=module', '-e', configRunner, 'build'], { VITE_OPENAI_KEY: reference });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /VITE_OPENAI_KEY/);
    assert.doesNotMatch(result.stderr, /op:\/\/fixture/);
  }
});

test('npm build resolves .env before bundling a standalone production extension', () => {
  writeFileSync(join(fixture, '.env'), 'VITE_OPENAI_KEY=op://fixture/item/key\n');
  const bin = join(fixture, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'oprun'), '#!/bin/sh\n[ "$1" = "--env-file" ] && [ "$2" = ".env" ] && [ "$3" = "--" ] || exit 42\nshift 3\nexport VITE_OPENAI_KEY=fixture-resolved-key\nexec "$@"\n', { mode: 0o755 });
  const output = join(fixture, 'production');
  const result = spawnSync('npm', ['run', 'build', '--', '--outDir', output], { cwd: fixture, env: { ...env, PATH: `${bin}:${env.PATH}` }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const files = readdirSync(output, { recursive: true }).filter(p => /\.(js|json)$/.test(p));
  const bundle = files.map(p => readFileSync(join(output, p), 'utf8')).join('\n');
  assert.ok(bundle.includes('fixture-resolved-key'), 'resolved fixture key must reach the bundle');
  assert.ok(!bundle.includes('op://fixture'), 'reference must not reach the bundle');
  assert.ok(!bundle.includes('localhost:5173'), 'production must work with dev server stopped');
  assert.ok(!bundle.includes('@crx/client-worker'), 'production must not depend on CRX development worker');
});

test('the launcher preserves child termination instead of reporting success', () => {
  const bin = join(fixture, 'bin');
  writeFileSync(join(bin, 'vite'), '#!/bin/sh\nkill -TERM $$\n', { mode: 0o755 });
  const result = run(['scripts/vite.mjs', 'build'], { PATH: `${bin}:${env.PATH}` });
  assert.equal(result.signal, 'SIGTERM');
  assert.equal(result.status, null);
});


test('npm preview serves the production bundle with a 1Password-backed .env', async () => {
  const bin = join(fixture, 'bin');
  // Remove the termination-test stub so npm resolves the real Vite binary.
  rmSync(join(bin, 'vite'), { force: true });
  const child = spawn('npm', ['run', 'preview', '--', '--outDir', join(fixture, 'production'), '--host', '127.0.0.1', '--port', '0'], {
    cwd: fixture, env: { ...env, PATH: `${bin}:${env.PATH}` }, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  let timer;
  try {
    const url = await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Preview did not become ready: ${stripVTControlCharacters(log)}`)), 10000);
      child.on('error', reject);
      child.on('exit', code => reject(new Error(`Preview exited with ${code}: ${log}`)));
      const collect = chunk => {
        log += chunk;
        const match = stripVTControlCharacters(log).match(/http:\/\/127\.0\.0\.1:\d+\//);
        if (match) resolve(match[0]);
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
    });
    const response = await fetch(new URL('manifest.json', url));
    assert.equal(response.status, 200);
    const manifest = await response.json();
    assert.equal(manifest.name, 'Video Recap Sidebar');
    assert.ok(manifest.background.service_worker);
  } finally {
    clearTimeout(timer);
    try { process.kill(-child.pid, 'SIGTERM'); } catch (err) { if (err.code !== 'ESRCH') throw err; }
  }
});
