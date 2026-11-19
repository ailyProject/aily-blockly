const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { fork } = require('node:child_process');
const { before, after, test } = require('node:test');
const { buildSync } = require('esbuild');

const repo = path.resolve(__dirname, '../..');
const root = path.join(repo, 'tests/test-results', `r0-publication-${Date.now()}-${randomUUID().slice(0, 8)}`);
const bundle = path.join(root, 'kernel.cjs');
const workerFile = path.join(__dirname, 'fixtures/r0-publication-worker.cjs');
const children = new Set(), evidence = [];
const digest = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const write = (filename, value) => fs.writeFileSync(filename, JSON.stringify(value, null, 2));

before(() => {
  fs.mkdirSync(root, { recursive: true });
  // Test-only pure TS compilation. No production dist, SDK, renderer or installed artifact is written.
  const result = buildSync({ absWorkingDir: repo, entryPoints: ['tests/electron/fixtures/r0-publication-kernel.ts'],
    bundle: true, platform: 'node', format: 'cjs', target: 'node22', tsconfig: 'tsconfig.json',
    alias: { '@domain/project/public-api': path.join(__dirname, 'fixtures/r0-publication-domain-exports.ts'),
      '@domain/project/project-data/public-api': path.join(__dirname, 'fixtures/r0-publication-domain-exports.ts') },
    outfile: bundle, write: false, metafile: true, logLevel: 'silent' });
  fs.writeFileSync(bundle, result.outputFiles[0].contents);
  write(path.join(root, 'source-manifest.json'), { version: 1, capturedAt: new Date().toISOString(),
    node: process.version, bundleHash: digest(result.outputFiles[0].contents),
    inputs: Object.keys(result.metafile.inputs).map(relative => ({ relative,
      hash: digest(fs.readFileSync(path.resolve(repo, relative))) })),
    nativeInputs: ['electron/project-sync-storage.js', 'electron/project-file-access.js',
      'tests/electron/fixtures/r0-publication-worker.cjs', 'tests/electron/r0-publication-boundaries.test.cjs']
      .map(relative => ({ relative, hash: digest(fs.readFileSync(path.join(repo, relative))) })) });
});

function launch(mode, project, point) {
  const child = fork(workerFile, [mode, project, bundle, point || ''], {
    execPath: process.execPath, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  children.add(child);
  let stdout = '', stderr = '';
  const messages = [], waiters = new Set();
  child.stdout.on('data', value => { stdout += value; });
  child.stderr.on('data', value => { stderr += value; });
  child.on('message', message => { messages.push(message); for (const notify of waiters) notify(); });
  const closed = new Promise(resolve => child.once('exit', (code, signal) => {
    children.delete(child); resolve({ code, signal }); for (const notify of waiters) notify();
  }));
  const until = (predicate, label) => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { waiters.delete(check); reject(new Error(`R0 worker timeout: ${label}\n${stderr}`)); }, 15000);
    const check = () => {
      const failure = messages.find(message => message.event === 'failure');
      const match = messages.find(predicate);
      if (failure || match || child.exitCode !== null || child.signalCode !== null) {
        clearTimeout(timeout); waiters.delete(check);
        if (failure) reject(Object.assign(new Error(failure.error.message), failure.error));
        else if (match) resolve(match);
        else reject(new Error(`Worker exited before ${label}: ${child.exitCode}/${child.signalCode}\n${stderr}`));
      }
    };
    waiters.add(check); check();
  });
  return { child, messages, closed, until, output: () => ({ stdout, stderr }) };
}

async function run(mode, project, point) {
  const owned = launch(mode, project, point);
  try {
    const { result } = await owned.until(message => message.event === 'result', mode);
    const exit = await owned.closed;
    assert.equal(exit.code, 0, owned.output().stderr);
    return result;
  } finally { await owned.closed; }
}

async function fixture(name) {
  const project = path.join(root, name); fs.mkdirSync(project);
  assert.equal((await run('fixture', project)).publication.status, 'COMMITTED');
  return { project, input: JSON.parse(fs.readFileSync(path.join(project, 'r0-input.json'), 'utf8')) };
}

async function killAt(project, mode, point) {
  const owned = launch(mode, project, point);
  await owned.until(message => message.event === 'paused' && message.label === point, point);
  assert.equal(owned.child.kill('SIGKILL'), true, 'Only the exact owned worker is killed.');
  const exit = await owned.closed;
  assert.ok(exit.code !== 0 || exit.signal === 'SIGKILL', 'Must actually terminate without finally cleanup.');
  return { pid: owned.child.pid, exit, messages: owned.messages, output: owned.output() };
}

function record(name, data) {
  write(path.join(root, `${name}.json`), data); evidence.push({ name, ...data.summary });
}

for (const point of ['prepared.json', 'project.abi', 'project.abs', 'project.abs.map.json', 'committed.json']) {
  test(`real owned process kill after ${point}: immutable reader is coherent and verified dead-owner recovery completes`, async () => {
    const { project, input } = await fixture(`kill-${point.replaceAll('.', '-')}`);
    const killed = await killAt(project, 'publish', point);
    const inspected = await run('inspect', project);
    const target = point === 'committed.json';
    assert.equal(inspected.committed.projection.map.generation, target ? 'r0-next' : 'r0-base');
    assert.deepEqual(inspected.committed.projection.document, target ? input.next.projection.document : input.baseProjection.document);
    assert.equal(inspected.lockPresent, false);
    assert.equal(inspected.prepared, null);
    if (point === 'prepared.json') {
      assert.equal(inspected.recovery.action, 'abandon');
      assert.deepEqual(inspected.after, input.next.expected);
      assert.equal(inspected.afterPointer, input.expectedPointer);
    } else {
      assert.equal(inspected.recovery.result.status, 'COMMITTED');
      assert.equal(inspected.after.abi, input.next.abi);
      assert.equal(inspected.after.abs, input.next.projection.abs);
      assert.deepEqual(JSON.parse(inspected.after.map), input.next.projection.map);
    }
    assert.equal(inspected.observation.result.publication.status, target ? 'COMMITTED' : 'UNKNOWN');
    if (point === 'project.abi') {
      assert.equal(inspected.before.abi, input.next.abi);
      assert.equal(inspected.before.abs, input.next.expected.abs);
      assert.equal(inspected.pointer, input.expectedPointer, 'ABI can be new while the authoritative head is still old.');
    }
    record(`kill-${point.replaceAll('.', '-')}`, { killed, inspected,
      summary: { kind: 'actual-process-kill', point, coherentHead: true, userProgramRetained: true,
        automaticRecoveryComplete: true,
        originalRequestObservation: inspected.observation.result.publication.status } });
  });
}

test('released-lock persisted boundary faults use real kernel abandon/recover, never replaying the ABI commit callback', async () => {
  for (const point of ['prepared.json', 'project.abi', 'project.abs', 'project.abs.map.json', 'committed.json']) {
    const { project, input } = await fixture(`released-${point.replaceAll('.', '-')}`);
    let failed;
    if (point === 'prepared.json') {
      await assert.rejects(run('throw', project, point), error => {
        failed = { code: error.code, message: error.message };
        return error.code === 'R0_INJECTED_AFTER_WRITE';
      });
    } else failed = await run('throw', project, point);
    const inspected = await run('inspect', project);
    assert.equal(inspected.lockPresent, false);
    assert.equal(inspected.prepared, null);
    if (point === 'prepared.json') {
      assert.equal(inspected.recovery.action, 'abandon');
      assert.deepEqual(inspected.after, input.next.expected);
      assert.equal(inspected.afterPointer, input.expectedPointer);
      assert.equal(inspected.afterObservation.result.publication.status, 'UNKNOWN');
    } else {
      assert.equal(inspected.recovery.result.status, 'COMMITTED');
      assert.equal(inspected.after.abi, input.next.abi);
      assert.equal(inspected.after.abs, input.next.projection.abs);
      assert.deepEqual(JSON.parse(inspected.after.map), input.next.projection.map);
      assert.equal(inspected.afterObservation.result.publication.status, 'COMMITTED');
    }
    record(`released-${point.replaceAll('.', '-')}`, { failed, inspected,
      summary: { kind: 'post-write-exception-with-finally', point, recovered: true,
        actualProcessCrash: false, abiCallbackReplayed: false } });
  }
});

test('a foreign mirror after ABI publication is retained; recovery cannot overwrite it or advance the old pointer', async () => {
  const { project, input } = await fixture('foreign-mirror');
  await run('throw', project, 'project.abi');
  const foreign = '{"foreign":"retain this external map version"}';
  fs.writeFileSync(path.join(project, 'project.abs.map.json'), foreign);
  const inspected = await run('inspect', project);
  assert.equal(inspected.recovery.result.status, 'CONFLICT');
  assert.equal(inspected.after.map, foreign);
  assert.equal(inspected.after.abi, input.next.abi);
  assert.equal(inspected.afterPointer, input.expectedPointer);
  assert.notEqual(inspected.prepared, null);
  assert.equal(inspected.afterObservation.result.publication.status, 'UNKNOWN');
  record('foreign-mirror', { inspected, summary: { foreignBytesRetained: true,
    preparedRetained: true, staleOperationPublished: false } });
});

test('reply lost after real commit lock release: the original ABS request is durably observed without another apply', async () => {
  const { project, input } = await fixture('reply-loss');
  const killed = await killAt(project, 'publish', 'reply-loss');
  const inspected = await run('inspect', project);
  assert.equal(inspected.lockPresent, false);
  assert.equal(inspected.prepared, null);
  assert.equal(inspected.recovery.result, null);
  assert.equal(inspected.observation.result.publication.status, 'COMMITTED');
  assert.equal(inspected.observation.result.receipt.requestId, input.requestId);
  assert.equal(inspected.observation.result.receipt.output.binding.generation, 'r0-next');
  assert.equal(inspected.observation.result.applicationObservation.current, true);
  assert.equal(inspected.observation.result.derivedOutputs.published, false, 'Source success must not invent derived output success.');
  record('reply-loss', { killed, inspected, summary: { kind: 'actual-process-kill-after-release',
    originalRequestDurable: true, applyReplayed: false } });
});

test('native save registry loses completed request ownership after process death despite an intact committed source', async () => {
  const { project } = await fixture('native-reply-loss');
  const killed = await killAt(project, 'native', 'native-reply-loss');
  const completed = killed.messages.find(message => message.event === 'native-completed').result;
  assert.equal(completed.saveReceipt.state, 'completed');
  const restarted = await run('native-observe', project);
  assert.equal(restarted.observed.saveReceipt.state, 'unknown');
  assert.equal(restarted.observed.code, 'PROJECT_SAVE_RECEIPT_UNKNOWN');
  assert.equal(restarted.reentered, 1, 'Fresh registry can re-admit the old consumed ID; the probe only counts callback entry.');
  assert.equal(fs.existsSync(path.join(project, '.aily/project-files.write.lock')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(project, '.aily/abs-sync/committed.json'))).generation, 'r0-next');
  record('native-reply-loss', { killed, restarted, summary: { kind: 'actual-process-memory-reset',
    sourceCommitted: true, nativeRequestDurable: false, oldIdReadmitted: true,
    actualSecondNativeSave: false, electronUiExercised: false } });
});

test('two actual processes share the physical writer lock and stale predecessor checks', async () => {
  const { project } = await fixture('competing-writers');
  const writer = launch('publish', project, 'prepared.json');
  await writer.until(message => message.event === 'paused', 'first writer owns lock');
  const blocked = await run('compete', project);
  assert.equal(blocked.accepted, false); assert.equal(blocked.code, 'PROJECT_FILE_BUSY');
  writer.child.send({ action: 'continue' });
  assert.equal((await writer.until(message => message.event === 'result', 'first completion')).result.publication.status, 'COMMITTED');
  assert.equal((await writer.closed).code, 0);
  const stale = await run('compete', project);
  assert.equal(stale.accepted, false); assert.equal(stale.code, 'ABS_BASELINE_STALE');
  record('competing-writers', { blocked, stale, summary: { actualProcesses: 2, physicalLockExclusive: true,
    staleExpectedHeadRejected: true, dualGuiRuntimeCovered: false } });
});

test('the existing journal persists complete unsaved Working S1 while candidate intent and published disk remain S0', async () => {
  const { project, input } = await fixture('dirty-working-journal');
  const result = await run('dirty-journal', project);
  assert.deepEqual(result.retained.document, result.working);
  assert.notDeepEqual(result.retained.document, input.baseProjection.document);
  assert.equal(result.retained.document.pages[1].title, 'unsaved real-working S1');
  assert.equal(result.retained.candidate.generation, 'r0-base');
  assert.equal(result.retained.candidate.source, input.next.inputAbs);
  assert.deepEqual(result.disk, input.next.expected);
  assert.equal(result.pointer, input.expectedPointer);
  assert.equal(result.prepared, null, 'Snapshot preservation alone does not start publication.');
  assert.equal(JSON.parse(fs.readFileSync(path.join(project, '.aily/abs-sync/operation.json'))).id, result.operationId);
  record('dirty-working-journal', { result, summary: { workingS1Durable: true,
    publishedS0Untouched: true, oldCandidateIntentRetained: true, newRecoveryStack: false,
    guiCaptureExercised: false } });
});

after(async () => {
  const pending = [...children];
  for (const child of pending) child.kill('SIGKILL');
  await Promise.all(pending.map(child => new Promise(resolve => child.exitCode !== null || child.signalCode !== null
    ? resolve() : child.once('exit', resolve))));
  write(path.join(root, 'summary.json'), { generatedAt: new Date().toISOString(), output: root,
    cases: evidence, ownedChildrenRemaining: children.size,
    scope: 'Node process + actual pure kernel + physical ProjectFileAccess; no Electron GUI, model or power-loss claim.' });
  console.log(`R0_PUBLICATION_OUTPUT=${root}`);
  assert.equal(children.size, 0);
});
