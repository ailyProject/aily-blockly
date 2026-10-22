const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { Worker } = require('node:worker_threads');
const { createHash } = require('node:crypto');
const { npmTarball } = require('./npm-tarball-fixture');
const store = require('../subapp-version-store');

function fixture(t, source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-worker-lifecycle-'));
  const script = source && path.join(root, 'worker.cjs');
  if (script) fs.writeFileSync(script, source);
  let worker;
  const events = [];
  let exited = false;
  let resolveMessage;
  let resolveExit;
  const firstMessage = new Promise(resolve => { resolveMessage = resolve; });
  const exit = new Promise(resolve => { resolveExit = resolve; });
  class ObservedWorker extends Worker {
    constructor(filename, options) {
      assert.deepEqual(options.execArgv, []);
      super(script || filename, options);
      worker = this;
      this.on('message', message => { events.push({ event: 'message', type: message.type }); resolveMessage(message); });
      this.on('error', error => { events.push({ event: 'error', message: error.message }); });
      this.once('exit', code => { exited = true; events.push({ event: 'actual-worker-exit', code }); resolveExit(code); });
    }
  }
  const filename = path.join(__dirname, '..', 'subapp-package-worker-client.js');
  const client = new Module(filename, module);
  client.filename = filename;
  client.paths = Module._nodeModulePaths(path.dirname(filename));
  const ordinaryRequire = client.require.bind(client);
  client.require = name => name === 'worker_threads' ? { Worker: ObservedWorker } : ordinaryRequire(name);
  client._compile(fs.readFileSync(filename, 'utf8'), filename);
  t.after(async () => {
    if (worker && !exited) await worker.terminate();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.match(path.basename(root), /^aily-worker-lifecycle-/);
    fs.rmSync(root, { recursive: true, force: true });
    t.diagnostic(JSON.stringify({ fixture: t.name, events, exited }));
  });
  return { root, extract: client.exports.extractNpmTarballInBackground, firstMessage, exit, events, get worker() { return worker; }, get exited() { return exited; } };
}

const port = "const { parentPort } = require('node:worker_threads');\n";

test('complete message retains directory ownership until actual Worker exit', { timeout: 5000 }, async t => {
  const f = fixture(t, port + "parentPort.on('message', () => parentPort.close()); parentPort.postMessage({ type: 'complete', result: { entries: 3, extractedBytes: 85 } });");
  let settled = false;
  const pending = f.extract('unused.tgz', 'unused-output').then(value => { settled = true; return value; });
  await f.firstMessage;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(f.exited, false);
  f.worker.postMessage('release');
  assert.deepEqual(await pending, { entries: 3, extractedBytes: 85 });
  assert.equal(f.exited, true);
  assert.equal(await f.exit, 0);
});

test('complete followed by actual nonzero exit is rejected', { timeout: 5000 }, async t => {
  const f = fixture(t, port + "parentPort.postMessage({ type: 'complete', result: { entries: 1 } }); process.exitCode = 7; parentPort.close();");
  await assert.rejects(f.extract('unused.tgz', 'unused-output'), /successful completion \(7\)/);
  assert.equal(f.exited, true);
  assert.equal(await f.exit, 7);
});

test('serialized failure retains code and rejects only after actual Worker exit', { timeout: 5000 }, async t => {
  const f = fixture(t, port + "parentPort.on('message', () => parentPort.close()); parentPort.postMessage({ type: 'error', error: { name: 'ArchiveError', code: 'EBADARCHIVE', message: 'invalid archive', stack: 'original worker stack' } });");
  let settled = false;
  const pending = f.extract('unused.tgz', 'unused-output');
  pending.then(() => { settled = true; }, () => { settled = true; });
  await f.firstMessage;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(f.exited, false);
  f.worker.postMessage('release');
  await assert.rejects(pending, error => error.name === 'ArchiveError' && error.code === 'EBADARCHIVE'
    && error.message === 'invalid archive' && error.stack === 'original worker stack');
  assert.equal(f.exited, true);
});

test('uncaught Worker error is retained through actual exit', { timeout: 5000 }, async t => {
  const f = fixture(t, "throw new Error('worker crashed');");
  await assert.rejects(f.extract('unused.tgz', 'unused-output'), /worker crashed/);
  assert.equal(f.exited, true);
  assert.equal(await f.exit, 1);
});

test('actual zero exit without a completion message fails closed', { timeout: 5000 }, async t => {
  const f = fixture(t, '// no protocol completion\n');
  await assert.rejects(f.extract('unused.tgz', 'unused-output'), /successful completion \(0\)/);
  assert.equal(f.exited, true);
});

test('tiny real package Worker returns before original version-store publication only after exit', { timeout: 5000 }, async t => {
  const f = fixture(t);
  const entry = { id: 'worker-fixture', package: '@aily-project/worker-fixture', version: '0.1.0' };
  const root = path.join(f.root, 'npm-global', 'app');
  const candidate = store.createCandidate(root, entry);
  const archive = npmTarball({
    'package.json': JSON.stringify({ name: entry.package, version: entry.version }),
    'index.js': '// inert fixture\n',
    'nested/deeper/data.txt': 'tiny bytes\n',
  });
  fs.writeFileSync(candidate.tarball, archive);
  const integrity = `sha512-${createHash('sha512').update(archive).digest('base64')}`;
  const progress = [];
  const result = await f.extract(candidate.tarball, candidate.source, { integrity, onProgress: value => progress.push(value) });
  assert.equal(result.entries, 3);
  assert.equal(f.exited, true);
  assert.equal(await f.exit, 0);
  assert.equal(progress.at(-1), 100);
  const prepared = store.publishCandidate(root, entry, candidate, { integrity });
  assert.equal(fs.existsSync(candidate.project), false);
  assert.equal(fs.readFileSync(path.join(prepared.packagePath, 'nested', 'deeper', 'data.txt'), 'utf8'), 'tiny bytes\n');
  assert.equal(store.readPrepared(root, entry).packagePath, prepared.packagePath);
});
