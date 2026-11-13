const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash, webcrypto } = require('node:crypto');
const test = require('node:test');
const ts = require('typescript');

const repo = path.resolve(__dirname, '../..');
const outputs = path.join(repo, 'tests/test-results/build-log-reference');
fs.mkdirSync(outputs, { recursive: true });
function production(relative, window, imports = {}) {
  const module = { exports: {} };
  const source = ts.transpileModule(fs.readFileSync(path.join(repo, relative), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  vm.runInNewContext(source, { module, exports: module.exports, window, TextEncoder, setTimeout, clearTimeout,
    require(name) { assert.ok(imports[name], `Unexpected runtime import ${name}`); return imports[name]; } });
  return module.exports;
}
function fixture(t, replacement) {
  const root = fs.mkdtempSync(path.join(outputs, 'owned-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const api = replacement ? replacement(root) : fs;
  const window = { fs: api, path, crypto: webcrypto };
  const crypto = production('src/app/utils/crypto.utils.ts', window);
  return { root, window, create: production('src/app/services/domains/build/project-build-log.ts', window,
    { '../../../utils/crypto.utils': crypto }).createProjectBuildLog };
}
const expectedPath = (root, id) => path.join(root, '.log/compile/requests', createHash('sha256').update(id).digest('hex') + '.log');

test('each admitted request preserves complete raw stdout/stderr and its control outcome', async t => {
  const f = fixture(t), id = 'actual-request:123';
  const log = await f.create(f.root, id);
  const stdout = 'command\n\n  source  with whitespace\r\n';
  const stderr = '\u001b[31mcompiler candidate(String&)\u001b[0m\n'.repeat(100_000);
  log.append(stdout); log.append(stderr);
  const answer = await log.run(async () => ({ state: 'error', text: 'Compiler exited with code 1' }));
  assert.equal(answer.state, 'error');
  assert.equal(answer.buildLog.requestId, id);
  assert.equal(answer.buildLog.complete, true);
  assert.equal(answer.buildLog.path, expectedPath(f.root, id));
  const content = fs.readFileSync(answer.buildLog.path, 'utf8');
  assert.equal(content, `Build request: ${id}\nProject: ${f.root}\n\n` + stdout + stderr + '\nBuild finished: error Compiler exited with code 1\n');
  log.append('late stale stream');
  assert.equal(fs.readFileSync(answer.buildLog.path, 'utf8'), content);
});

test('parallel requests in one project cannot capture or overwrite one another', async t => {
  const f = fixture(t);
  const a = await f.create(f.root, 'A'), b = await f.create(f.root, 'B');
  a.append('owned-a\n'); b.append('owned-b\n'); a.append('still-a\n');
  const [first, second] = await Promise.all([a.run(async () => ({ state: 'done' })), b.run(async () => ({ state: 'error' }))]);
  assert(fs.readFileSync(first.buildLog.path, 'utf8').includes('owned-a\nstill-a'));
  assert(!fs.readFileSync(first.buildLog.path, 'utf8').includes('owned-b'));
  assert(!fs.readFileSync(second.buildLog.path, 'utf8').includes('owned-a'));
});

test('re-executing a used ID fails log creation without changing the prior immutable log or compilation result', async t => {
  const f = fixture(t), first = await f.create(f.root, 'used');
  const answer = await first.run(async () => ({ state: 'done' }));
  const original = fs.readFileSync(answer.buildLog.path);
  const duplicate = await f.create(f.root, 'used'); duplicate.append('wrong replacement');
  const repeated = await duplicate.run(async () => ({ state: 'error', text: 'actual second outcome' }));
  assert.equal(repeated.state, 'error');
  assert.equal(repeated.buildLog.complete, false);
  assert.equal(repeated.buildLog.path, undefined);
  assert.match(repeated.buildLog.error, /exist/i);
  assert.deepEqual(fs.readFileSync(answer.buildLog.path), original);
});

test('filenames remain distinct on case-insensitive disks and fit maximum-length valid IDs', async t => {
  const f = fixture(t), paths = [];
  for (const id of ['AAE', 'AA_', 'a'.repeat(127) + ':']) {
    const log = await f.create(f.root, id);
    const result = await log.run(async () => ({ state: 'done' }));
    assert.equal(result.buildLog.complete, true);
    assert.match(path.basename(result.buildLog.path), /^[a-f0-9]{64}\.log$/);
    paths.push(result.buildLog.path.toLowerCase());
  }
  assert.equal(new Set(paths).size, 3);
});

test('manual compilation receives its own request ID and never reuses a previous path', async t => {
  const f = fixture(t);
  const first = await (await f.create(f.root)).run(async () => ({ state: 'done' }));
  const second = await (await f.create(f.root)).run(async () => ({ state: 'done' }));
  assert.match(first.buildLog.requestId, /^[a-f0-9-]{36}$/);
  assert.notEqual(first.buildLog.requestId, second.buildLog.requestId);
});

test('manual completion snapshot retains the exact request and log reference', async t => {
  const f = fixture(t);
  const answer = await (await f.create(f.root)).run(async () => ({ state: 'done', text: 'Compiled' }));
  const cancellation = production('src/app/services/domains/build/build-cancellation.ts', f.window);
  const snapshot = production('src/app/services/domains/build/build-result-snapshot.ts', f.window,
    { './build-cancellation': cancellation });
  snapshot.persistBuildResult(f.root, true, answer, undefined, undefined, 'manual');
  const stored = JSON.parse(fs.readFileSync(path.join(f.root, '.log/compile/latest-result.json'), 'utf8'));
  assert.equal(stored.source, 'manual');
  assert.equal(stored.buildRequestId, answer.buildLog.requestId);
  assert.equal(stored.buildLog.requestId, stored.buildRequestId);
  assert.equal(stored.buildLog.path, answer.buildLog.path);
  assert.equal(stored.buildLog.complete, true);
});

for (const failedOperation of ['creation', 'append']) {
  test(`${failedOperation} errors report incomplete logging while preserving the actual compiler outcome`, async t => {
    const f = fixture(t, () => ({ ...fs,
      ...(failedOperation === 'creation'
        ? { writeFileSync() { throw Object.assign(new Error('storage denied'), { code: 'EACCES' }); } }
        : { appendFileSync() { throw Object.assign(new Error('storage full'), { code: 'ENOSPC' }); } }) }));
    const log = await f.create(f.root, 'failure'); log.append('raw');
    const answer = await log.run(async () => ({ state: 'done', text: 'real success' }));
    assert.equal(answer.state, 'done');
    assert.equal(answer.buildLog.complete, false);
    assert.match(answer.buildLog.error, /storage/);
    assert.equal(typeof answer.buildLog.path, failedOperation === 'append' ? 'string' : 'undefined');
  });
}

test('cancelled and rejected execution preserve their status and request log', async t => {
  const f = fixture(t), log = await f.create(f.root, 'cancel');
  log.append('output before stopping\n');
  try {
    await log.run(async () => { throw { state: 'warn', text: 'Stopped by user', code: 'BUILD_CANCELLED', buildOutcome: 'cancelled' }; });
    assert.fail('Expected the actual cancellation');
  } catch (error) {
    assert.equal(error.code, 'BUILD_CANCELLED');
    assert.equal(error.buildOutcome, 'cancelled');
    assert.equal(error.buildLog.complete, true);
    assert(fs.readFileSync(error.buildLog.path, 'utf8').includes('output before stopping'));
  }
});

test('partial capture keeps accepting later owned output without changing the build outcome', async t => {
  const f = fixture(t), log = await f.create(f.root, 'partial');
  log.append('before interruption\n');
  log.markIncomplete('process termination was not fully observed');
  log.append('later owned output\n');
  const result = await log.run(async () => ({ state: 'done' }));
  assert.equal(result.state, 'done');
  assert.equal(result.buildLog.complete, false);
  assert.match(result.buildLog.error, /termination/);
  assert(fs.readFileSync(result.buildLog.path, 'utf8').includes('later owned output'));
});

test('cloud raw output survives UI buffering and cloud-to-local handoff in the same request', async t => {
  const f = fixture(t), log = await f.create(f.root, 'handoff');
  const { runCloudBuildWithProgress, CLOUD_BUILD_LOCAL_REQUESTED } = production('src/app/utils/cloud-build-progress.utils.ts', f.window);
  let progress, switchToLocal, finish;
  const remote = new Promise(resolve => { finish = resolve; });
  const ui = [];
  const task = log.run(async () => {
    try {
      await runCloudBuildWithProgress({ requestId: 'remote-stage' }, {
        run: () => remote, cancel: () => Promise.resolve(), onProgress: callback => { progress = callback; return () => {}; }
      }, { isCurrent: () => true, log: text => ui.push(text), progress() {}, localSwitch: callback => { switchToLocal = callback; },
        rawLog: text => log.append(text + '\n'), logIncomplete: reason => log.markIncomplete(reason) });
      assert.fail('Expected handoff');
    } catch (error) { assert.equal(error.code, CLOUD_BUILD_LOCAL_REQUESTED); }
    log.append('local compiler output\n');
    return { state: 'done' };
  });
  await new Promise(resolve => setImmediate(resolve));
  progress({ requestId: 'remote-stage', stage: 'compiling', progress: 20 });
  progress({ requestId: 'foreign-request', log: 'foreign compiler output' });
  progress({ requestId: 'remote-stage', log: 'cloud first' });
  progress({ requestId: 'remote-stage', log: '' });
  progress({ requestId: 'remote-stage', log: 'cloud buffered tail', stream: 'stderr' });
  assert.equal(switchToLocal(), true);
  progress({ requestId: 'remote-stage', log: 'cloud cancellation tail' });
  finish({ success: false, logComplete: true });
  const result = await task;
  assert.equal(result.buildLog.complete, true);
  const raw = fs.readFileSync(result.buildLog.path, 'utf8');
  assert(raw.includes('cloud buffered tail'));
  assert(raw.includes('cloud first\n\ncloud buffered tail\n'));
  assert(raw.includes('cloud cancellation tail'));
  assert(raw.includes('local compiler output'));
  assert(!raw.includes('foreign compiler output'));
  assert.deepEqual(ui, []);
});

for (const logComplete of [true, false, undefined]) {
  test(`cloud terminal output reports proven completeness (${String(logComplete)})`, async t => {
    const f = fixture(t), log = await f.create(f.root, 'terminal');
    const { runCloudBuildWithProgress } = production('src/app/utils/cloud-build-progress.utils.ts', f.window);
    const result = await log.run(async () => {
      await runCloudBuildWithProgress({ requestId: 'remote' }, {
        run: async () => ({ success: true, fullStdErr: 'complete terminal compiler output', logComplete }),
        cancel() {}, onProgress() { return () => {}; }
      }, { isCurrent: () => true, log() {}, progress() {}, rawLog: text => log.append(text + '\n'),
        logIncomplete: reason => log.markIncomplete(reason) });
      return { state: 'done' };
    });
    assert.equal(result.state, 'done');
    assert.equal(result.buildLog.complete, logComplete === true);
    assert(fs.readFileSync(result.buildLog.path, 'utf8').includes('complete terminal compiler output'));
  });
}

test('linked log directories cannot redirect request output outside the project', async t => {
  const f = fixture(t), outside = fs.mkdtempSync(path.join(outputs, 'outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.symlinkSync(outside, path.join(f.root, '.log'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = await (await f.create(f.root, 'escape')).run(async () => ({ state: 'done' }));
  assert.equal(result.buildLog.complete, false);
  assert.equal(result.buildLog.path, undefined);
  assert.deepEqual(fs.readdirSync(outside), []);
});
