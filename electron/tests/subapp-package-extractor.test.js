const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash } = require('crypto');
const { extractNpmTarball } = require('../subapp-package-extractor');
const { extractNpmTarballInBackground } = require('../subapp-package-worker-client');
const { npmTarball } = require('./npm-tarball-fixture');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-extract-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { archive: path.join(root, 'package.tgz'), output: path.join(root, '输出 source') };
}

test('extracts an npm package root without invoking npm and keeps executable modes', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.archive, npmTarball({
    'package.json': '{"name":"@aily-project/subapp-test","version":"1.0.0"}',
    'bin/run.js': '#!/usr/bin/env node\n',
  }, [{ name: 'package/empty', type: '5' }]));
  const progress = [];
  const result = extractNpmTarball(f.archive, f.output, { onProgress: value => progress.push(value) });
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.output, 'package.json'))).version, '1.0.0');
  assert.equal(fs.readFileSync(path.join(f.output, 'bin/run.js'), 'utf8'), '#!/usr/bin/env node\n');
  assert.ok(result.entries >= 3);
  assert.equal(progress.at(-1), 100);
});

test('rejects traversal, absolute, backslash, Windows-reserved and duplicate paths', (t) => {
  const f = fixture(t);
  for (const entries of [
    [{ name: 'package/../escape', value: 'x' }],
    [{ name: '/package/absolute', value: 'x' }],
    [{ name: 'package\\escape', value: 'x' }],
    [{ name: 'package/CON.txt', value: 'x' }],
    [{ name: 'package/A.txt', value: 'x' }, { name: 'package/a.txt', value: 'y' }],
  ]) {
    fs.rmSync(f.output, { recursive: true, force: true });
    fs.writeFileSync(f.archive, npmTarball({ 'package.json': '{}' }, entries));
    assert.throws(() => extractNpmTarball(f.archive, f.output), /Unsafe|Duplicate/);
  }
});

test('rejects symlinks, hard links and archives without package.json', (t) => {
  const f = fixture(t);
  for (const entries of [
    [{ name: 'package/link', type: '2', linkName: '../../outside' }],
    [{ name: 'package/link', type: '1', linkName: 'package.json' }],
    [{ name: 'package/file.js', value: 'x' }],
  ]) {
    fs.rmSync(f.output, { recursive: true, force: true });
    fs.writeFileSync(f.archive, npmTarball({}, entries));
    assert.throws(() => extractNpmTarball(f.archive, f.output), /Unsupported|hard links|incomplete/);
  }
});

test('rejects corrupt gzip data and an existing non-empty destination', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.archive, 'not gzip');
  assert.throws(() => extractNpmTarball(f.archive, f.output), /decompress/);
  fs.writeFileSync(f.archive, npmTarball({ 'package.json': '{}' }));
  fs.mkdirSync(f.output, { recursive: true });
  fs.writeFileSync(path.join(f.output, 'keep'), 'x');
  assert.throws(() => extractNpmTarball(f.archive, f.output), /not empty/);
});

test('worker extraction keeps the caller event loop responsive and verifies integrity', async (t) => {
  const f = fixture(t);
  const archive = npmTarball({
    'package.json': '{}',
    'large.bin': Buffer.alloc(32 * 1024 * 1024, 0x61),
  });
  fs.writeFileSync(f.archive, archive);
  const digest = `sha512-${createHash('sha512').update(archive).digest('base64')}`;
  let heartbeats = 0;
  const timer = setInterval(() => { heartbeats += 1; }, 1);
  try {
    await extractNpmTarballInBackground(f.archive, f.output, { integrity: digest });
  } finally {
    clearInterval(timer);
  }
  assert.ok(heartbeats > 2, `expected event-loop heartbeats during extraction, got ${heartbeats}`);
  assert.equal(fs.statSync(path.join(f.output, 'large.bin')).size, 32 * 1024 * 1024);

  const secondOutput = path.join(path.dirname(f.output), 'wrong integrity');
  await assert.rejects(
    extractNpmTarballInBackground(f.archive, secondOutput, { integrity: 'sha512-d3Jvbmc=' }),
    /integrity verification failed/,
  );
});
