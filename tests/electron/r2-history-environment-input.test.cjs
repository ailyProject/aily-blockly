const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const { createHash, webcrypto } = require('node:crypto');
const { buildSync } = require('esbuild');

// Execute the actual pure helper and shared SHA-256 implementation. The
// unrelated Angular project-data port is external and is never called here.
const bundled = buildSync({ entryPoints: [path.resolve('src/app/integrations/blockly/history-environment.ts')],
  bundle: true, platform: 'node', format: 'cjs', target: 'node22', write: false, logLevel: 'silent', external: ['@domain/*'] });
const moduleValue = { exports: {} };
vm.runInNewContext(`(function(require,module,exports){${bundled.outputFiles[0].text}\n})`, {
  crypto: webcrypto, TextEncoder, TextDecoder, Uint8Array, console,
})(name => { assert.match(name, /^@domain\//); return {}; }, moduleValue, moduleValue.exports);
const { readHistoryEnvironment, readHistoryEnvironmentInput, hydrateHistoryEnvironment, historyEnvironmentIdentity } = moduleValue.exports;
const plain = value => value === undefined ? value : JSON.parse(JSON.stringify(value));
const hash = text => 'sha256:' + createHash('sha256').update(text).digest('hex');
const invalid = { code: 'ABS_HISTORY_ENVIRONMENT_INVALID' };
const plan = files => ({ version: 1, requestId: 'history-original-environment', files });
const field = content => ({ expectedHash: null, content });
const reference = content => ({ expectedHash: null, contentHash: content === null ? null : hash(content) });

test('a large environment uses existing immutable object references and hydrates to the unchanged Main content plan', async () => {
  const packageText = '{"name":"reference-environment"}', lock = JSON.stringify({ lockfileVersion: 3, packages: {}, retained: 'x'.repeat(1024 * 1024 + 32) });
  const npmrc = 'registry=https://example.invalid\n# 中文 😀\n', yarn = '# yarn lockfile v1\n', shrinkwrap = '{"lockfileVersion":3,"packages":{}}';
  const bodies = { 'package.json': packageText, 'package-lock.json': lock, '.npmrc': npmrc, 'npm-shrinkwrap.json': shrinkwrap, 'yarn.lock': yarn };
  const inline = plan(Object.fromEntries(Object.entries(bodies).map(([name, body]) => [name, field(body)])));
  const refs = plan(Object.fromEntries(Object.entries(bodies).map(([name, body]) => [name, reference(body)])));
  assert.ok(Buffer.byteLength(JSON.stringify(inline)) > 1024 * 1024); assert.ok(Buffer.byteLength(JSON.stringify(refs)) < 2048);
  const objects = new Map(Object.values(bodies).map(body => [hash(body), body])), reads = [];
  const hydrated = await hydrateHistoryEnvironment(readHistoryEnvironmentInput(refs), async digest => { reads.push(digest); return objects.get(digest) ?? null; });
  assert.deepEqual(plain(hydrated), inline); assert.equal(reads.length, 5);
  assert.deepEqual(plain(readHistoryEnvironment(hydrated)), inline);
  reads.length = 0;
  assert.deepEqual(plain(await historyEnvironmentIdentity(refs)), plain(await historyEnvironmentIdentity(inline)));
  assert.deepEqual(plain(await historyEnvironmentIdentity(refs)), refs); assert.equal(reads.length, 0, 'Observation identity reads no objects');
  assert.ok(Object.values(hydrated.files).every(value => Object.hasOwn(value, 'content') && !Object.hasOwn(value, 'contentHash')));
});

test('missing, corrupt, non-JSON and invalid UTF-8 referenced objects never become a content plan', async () => {
  const text = '{"name":"verified"}', refs = plan({ 'package.json': reference(text) });
  await assert.rejects(hydrateHistoryEnvironment(refs, async () => null), invalid);
  await assert.rejects(hydrateHistoryEnvironment(refs, async () => text + ' '), invalid);
  await assert.rejects(hydrateHistoryEnvironment(plan({ 'package.json': reference('not JSON') }), async () => 'not JSON'), invalid);
  const malformed = '\uD800';
  await assert.rejects(hydrateHistoryEnvironment(plan({ 'package.json': field(text), '.npmrc': reference(malformed) }), async () => malformed), invalid);
});

test('optional null references mean deletion, while package.json cannot be deleted', async () => {
  const input = plan({ 'package.json': field('{"name":"kept"}'), 'package-lock.json': { expectedHash: hash('old lock'), contentHash: null } });
  let reads = 0;
  assert.deepEqual(plain(await hydrateHistoryEnvironment(input, async () => { reads++; throw Error('Deletion is not an object read'); })),
    plan({ 'package.json': field('{"name":"kept"}'), 'package-lock.json': { expectedHash: hash('old lock'), content: null } }));
  assert.equal(reads, 0); assert.throws(() => readHistoryEnvironmentInput(plan({ 'package.json': { expectedHash: null, contentHash: null } })), invalid);
});

test('descriptors contain exactly one body or hash and cannot supply paths, unsupported files or malformed hashes', async () => {
  const valid = reference('{"name":"valid"}');
  for (const bad of [
    { ...valid, path: '../outside' }, { ...valid, content: '{}' }, { expectedHash: null },
    { ...valid, contentHash: 'sha256:../outside' }, { ...valid, contentHash: valid.contentHash + '\n' },
    { ...valid, expectedHash: 'sha256:' + 'A'.repeat(64) },
  ]) {
    assert.throws(() => readHistoryEnvironmentInput(plan({ 'package.json': bad })), invalid);
    let reads = 0;
    await assert.rejects(hydrateHistoryEnvironment(plan({ 'package.json': bad }), async () => { reads++; return '{}'; }), invalid);
    assert.equal(reads, 0);
  }
  assert.throws(() => readHistoryEnvironmentInput(plan({ 'package.json': valid, '../package.json': valid })), invalid);
  assert.throws(() => readHistoryEnvironmentInput(plan({ 'package.json': valid, 'pnpm-lock.yaml': reference('unowned') })), invalid);
  assert.equal(readHistoryEnvironmentInput(undefined), undefined);
  assert.equal(await hydrateHistoryEnvironment(undefined, async () => { throw Error('No environment'); }), undefined);
  assert.equal(await historyEnvironmentIdentity(undefined), undefined);
});
