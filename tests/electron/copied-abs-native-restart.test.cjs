'use strict';
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createRequire } = require('node:module');

const host = path.resolve(__dirname, '../..');
const requireHost = createRequire(path.join(host, 'package.json'));
const { openProjectSyncStorage } = requireHost('./electron/project-sync-storage');
const fixture = path.join(host, 'tests/electron/fixtures');
const kernelPath = process.send ? process.argv[4] : undefined;
const childrenByTest = new WeakMap();
const guard = () => {};
const scope = projectKey => ({ projectKey, pageId: 'main' });
const open = project => openProjectSyncStorage(project, guard, { timeoutMs: 1800 });
const safe = (project, key) => path.join(project, '.aily', 'abs-sync', key);
const lock = project => path.join(project, '.aily', 'project-files.write.lock');
const stateFields = ['project.abi', 'project.abs', 'project.abs.map.json', 'prepared.json', 'operation.json', 'committed.json'];
const state = async port => Object.fromEntries(await Promise.all(stateFields.map(async key => [key, await port.read(key)])));
const digest = content => require('node:crypto').createHash('sha256').update(content).digest('hex').replace(/^/, 'sha256:');
const deferred = () => Promise.withResolvers();

function build(t) {
  const temp = fs.realpathSync.native(os.tmpdir());
  const suite = fs.mkdtempSync(path.join(temp, 'aily-copy-native-'));
  const children = new Set();
  childrenByTest.set(t, children);
  t.after(async () => {
    for (const stop of children) await stop();
    assert.equal(path.dirname(fs.realpathSync.native(suite)), temp);
    assert.match(path.basename(suite), /^aily-copy-native-/);
    fs.rmSync(suite, { recursive: true });
  });
  const kernelPath = path.join(suite, 'kernel.cjs');
  const abs = path.join(host, 'src/app/integrations/blockly/abs');
  const entries = [path.join(fixture, 'r0-publication-kernel.ts'),
    path.join(abs, 'abs-project-restart.ts'), path.join(abs, 'abs-project-open.ts')];
  const alias = path.join(fixture, 'r0-publication-domain-exports.ts');
  requireHost('esbuild').buildSync({
    absWorkingDir: host, stdin: { contents: entries.map(file => 'export * from ' + JSON.stringify(file) + ';').join('\n'), loader: 'ts', resolveDir: host },
    bundle: true, platform: 'node', format: 'cjs', outfile: kernelPath, logLevel: 'silent',
    alias: { '@domain/project/public-api': alias, '@domain/project/project-data/public-api': alias },
  });
  return kernelPath;
}

async function nativeSave(project, cut, value = 900) {
  const kernel = require(kernelPath);
  const port = await open(project);
  const disk = await new kernel.AbsBaselineStore(port, scope(project)).captureDisk();
  const current = await port.read('committed.json');
  assert.equal(JSON.parse(disk.map).scope.projectKey, project);
  const before = JSON.parse(disk.abi), document = structuredClone(before);
  document.pages[0].content.blocks.blocks[0].fields.VALUE = value;
  const abi = JSON.stringify(document, null, 2), generation = 'target-native-' + randomUUID();
  const pause = async () => {
    const next = once(process, 'message', { signal: AbortSignal.timeout(18000) });
    process.send({ event: 'prepared', pid: process.pid, ref, generation, disk });
    assert.equal((await next)[0].action, 'continue');
  };
  const publisher = cut !== 'after-cleanup' ? port : { ...port, withLock: action => port.withLock(access => action({
    ...access,
    async replace(key, hash, bytes) {
      const stored = await access.replace(key, hash, bytes);
      if (stored && key === 'prepared.json' && bytes === null) await pause();
      return stored;
    },
  })) };
  const store = new kernel.AbsBaselineStore(publisher, scope(project));
  const projection = await kernel.createAbsProjection(kernel.composeBlocklyPage(document, 'main'), {
    document, generation, baselineRef: kernel.absBaselineKey(generation), scope: scope(project),
    savedAbiHash: await kernel.hashAbsText(kernel.absJson(document)),
  });
  const request = await kernel.nativeSaveIdentity(project, { version: 2, requestId: 'pub2-' + randomUUID(), operation: 'project_save' });
  await new kernel.OriginalRequestAdmissions(port, project).reserveSave(request, 3, guard);
  const journal = new kernel.AbsOperationJournal(port, project);
  const { ref } = await journal.beginDocumentSave({ request, document: before, disk }, guard);
  const applications = new kernel.AbsApplicationJournal(port, project);
  await store.stage({ projection, abi, mode: 'import', inputAbs: projection.abs, expected: disk, authorIntent: 'preserve' }, await kernel.hashAbsText(current));
  await applications.stageNativeSave({ ref, evidence: await kernel.generationEvidence(projection, abi),
    inputAbiHash: await kernel.hashAbsText(disk.abi) }, guard);
  const result = await store.commit(generation, guard, async (bytes, expected, access) => {
    assert.equal(await access.replace('project.abi', expected, bytes), true);
    if (cut !== 'after-cleanup') await pause();
  });
  assert.equal(result.status, 'COMMITTED');
  assert.equal(await applications.sealNativeSave(ref, guard), true);
  await journal.finish(ref.operationId, guard);
  process.send({ event: 'saved', pid: process.pid, ref, generation });
}

function child(t, module, args) {
  const instance = fork(module, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const exit = once(instance, 'exit', { signal: AbortSignal.timeout(35000) });
  const kill = async () => {
    if (instance.exitCode === null && instance.signalCode === null) instance.kill('SIGKILL');
    await exit;
  };
  const children = childrenByTest.get(t);
  children.add(kill);
  instance.once('exit', () => children.delete(kill));
  return {
    pid: instance.pid, exit,
    reply: async () => {
      const [value] = await once(instance, 'message', { signal: AbortSignal.timeout(16000) });
      assert.ok(!value.error, JSON.stringify(value));
      return value;
    },
    send: data => instance.send(data),
    kill,
  };
}

async function seedCopy(t, kernelPath, native = false, { cut = 'after-abi', keepPublisher = false } = {}) {
  const root = path.dirname(kernelPath);
  const source = path.join(root, 'source'), target = path.join(root, 'target');
  fs.mkdirSync(path.join(source, '.aily'), { recursive: true });
  fs.writeFileSync(path.join(source, '.aily/workspace-mode.json'), '{"version":1,"mode":"project-v1"}');
  const sourceWorker = path.join(fixture, 'r0-publication-worker.cjs');
  const seed = child(t, sourceWorker, ['fixture', source, kernelPath]);
  assert.equal((await seed.exit)[0], 0);
  const inputPath = path.join(source, 'r0-input.json');
  const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const author = native ? input.next.inputAbs : input.next.inputAbs + '\n# an unpublished author draft\n';
  if (!native) {
    input.next.inputAbs = author;
    input.next.expected.abs = author;
    input.next.authorIntent = 'candidate';
  }
  fs.writeFileSync(inputPath, JSON.stringify(input));
  fs.writeFileSync(path.join(source, 'project.abs'), author);
  const publisher = native
    ? child(t, __filename, ['native-save', source, kernelPath, cut])
    : child(t, sourceWorker, ['publish', source, kernelPath, 'project.abi']);
  const paused = await publisher.reply();
  assert.equal(native ? paused.event : paused.label, native ? 'prepared' : 'project.abi');
  fs.cpSync(source, target, { recursive: true });
  const copiedMarker = fs.readFileSync(lock(target), 'utf8');
  assert.equal(JSON.parse(copiedMarker).pid, publisher.pid);
  if (!keepPublisher) await publisher.kill();
  const sourcePort = await open(source), targetPort = await open(target);
  const initial = await state(sourcePort);
  assert.equal(initial['project.abs'], author);
  assert.deepEqual(await state(targetPort), initial);
  const originalOperation = JSON.parse(initial['operation.json']);
  return { source, target, sourcePort, targetPort, initial, originalOperation, copiedMarker, originalRequest: input.requestId, nativeResult: paused, publisher };
}

async function verifyOverlap(t, preArchive) {
  const kernelPath = build(t), kernel = require(kernelPath);
  const { source, target, sourcePort, targetPort, initial, originalOperation, copiedMarker, originalRequest } = await seedCopy(t, kernelPath);
  const snapshotKey = 'recoveries/operation-' + originalOperation.id + '.json';
  const oldSnapshot = await sourcePort.read(snapshotKey);
  const paused = deferred(), continueOld = deferred(), relocking = deferred();
  let resuming = false;
  let retirementCalls = 0;
  const stalePort = {
    ...targetPort,
    withLock(action) {
      if (resuming) relocking.resolve();
      return targetPort.withLock(action);
    },
    async retireCopiedLock(proof) {
      assert.equal(++retirementCalls, 1);
      assert.equal(proof.original.attachment.root, source);
      assert.equal(proof.expected['operation.json'], digest(initial['operation.json']));
      if (!preArchive) await targetPort.retireCopiedLock(proof);
      paused.resolve();
      await continueOld.promise;
      if (preArchive) await targetPort.retireCopiedLock(proof);
    },
  };
  const stale = kernel.recoverAbsProjectOperation(stalePort, target, guard);
  void stale.catch(() => {});
  try {
    await Promise.race([paused.promise, stale.then(() => assert.fail('Recovery completed before the contested cut'))]);
    if (preArchive) assert.equal(fs.readFileSync(lock(target), 'utf8'), copiedMarker);
    else assert.equal(fs.existsSync(lock(target)), false);

    // An independent authorized storage caller first completes the copied transaction.
    const recovery = child(t, __filename, ['recover', target, kernelPath]);
    const recovered = await recovery.reply();
    assert.equal(recovered.transaction, 'settled');
    assert.equal((await recovery.exit)[0], 0);
    const recoveredPort = await open(target);
    const adopted = await state(recoveredPort);
    assert.equal(adopted['prepared.json'], null);
    assert.equal(adopted['project.abs'], initial['project.abs']);
    assert.equal(JSON.parse(adopted['project.abs.map.json']).scope.projectKey, target);
    assert.equal(await recoveredPort.read(snapshotKey), oldSnapshot);
    assert.deepEqual(await state(sourcePort), initial);
    const archives = fs.readdirSync(safe(target, 'recoveries')).filter(file => file.startsWith('copied-lock-'));
    assert.equal(archives.length, 1);
    assert.equal(fs.readFileSync(safe(target, path.join('recoveries', archives[0])), 'utf8'), copiedMarker);

    // New writer writer uses the target attachment and real native lock with a distinct request.
    const writer = child(t, __filename, ['native-save', target, kernelPath]);
    const prepared = await writer.reply();
    assert.equal(prepared.event, 'prepared');
    assert.equal(prepared.pid, writer.pid);
    assert.equal(prepared.ref.attachment.root, target);
    assert.notEqual(prepared.ref.request.requestId, originalRequest);
    const writerMarker = fs.readFileSync(lock(target), 'utf8');
    assert.equal(JSON.parse(writerMarker).pid, writer.pid);
    const writerState = await state(recoveredPort);
    assert.equal(JSON.parse(writerState['prepared.json']).generation, prepared.generation);
    assert.equal(JSON.parse(writerState['operation.json']).id, prepared.ref.operationId);
    const writerSnapshot = await recoveredPort.read('recoveries/operation-' + prepared.ref.operationId + '.json');
    const findRequest = () => new kernel.AbsOperationJournal(recoveredPort, target).findDocumentSave(prepared.ref.request, guard);
    assert.deepEqual(await findRequest(), prepared.ref);

    const finishWriter = async () => {
      writer.send({ action: 'continue' });
      const saved = await writer.reply();
      assert.equal(saved.event, 'saved');
      assert.deepEqual(saved.ref, prepared.ref);
      assert.equal((await writer.exit)[0], 0);
    };
    if (!preArchive) await writer.kill();
    resuming = true;
    continueOld.resolve();
    if (preArchive) {
      await Promise.race([relocking.promise, stale.then(() => assert.fail('Recovery did not wait for the live target writer'))]);
      assert.equal(fs.readFileSync(lock(target), 'utf8'), writerMarker);
      assert.deepEqual(await state(recoveredPort), writerState);
      await finishWriter();
    }
    assert.equal(await stale, null);
    assert.deepEqual(await findRequest(), prepared.ref);
    assert.equal(await recoveredPort.read('recoveries/operation-' + prepared.ref.operationId + '.json'), writerSnapshot);
    assert.equal(await recoveredPort.read(snapshotKey), oldSnapshot);
    const reloaded = await open(target);
    assert.equal(await kernel.recoverAbsProjectOperation(reloaded, target, guard), null);
    const result = await kernel.observeNativePublication(reloaded, target, prepared.ref.request, { originalTargetPid: writer.pid });
    assert.equal(result.saveReceipt?.requestId, prepared.ref.request.requestId);
    assert.equal(result.result?.publication?.status, 'COMMITTED');
    assert.equal(result.result?.publication?.generation, prepared.generation);
    const final = await state(reloaded);
    assert.equal(final['prepared.json'], null);
    assert.equal(final['project.abs'], initial['project.abs']);
    assert.equal(JSON.parse(final['project.abi']).pages[0].content.blocks.blocks[0].fields.VALUE, 900);
    assert.deepEqual(await state(sourcePort), initial);
    await assert.rejects(new kernel.AbsApplicationJournal(reloaded, target).observe(originalRequest, guard), { code: 'ABS_APPLY_OBSERVATION_INVALID' });
  } finally {
    continueOld.resolve();
    await stale.catch(() => {});
  }
}

async function verifyNativeDraft(t) {
  const kernelPath = build(t), kernel = require(kernelPath);
  const { source, target, sourcePort, targetPort, initial, nativeResult, copiedMarker } = await seedCopy(t, kernelPath, true);
  const stage = JSON.parse(initial['prepared.json']);
  const generation = JSON.parse(await targetPort.read(kernel.absBaselineKey(stage.generation)));
  assert.equal(generation.authorSource.disposition, 'preserved');
  assert.equal(generation.authorSource.hash, digest(initial['project.abs']));
  assert.notEqual(generation.snapshot, initial['project.abs']);

  for (const [suffix, change] of [
    ['mixed', copy => fs.appendFileSync(path.join(copy, 'project.abs'), '\n# competing author bytes\n')],
    ['projected', copy => fs.writeFileSync(path.join(copy, 'project.abs'), generation.snapshot)],
    ['missing-stage', copy => fs.unlinkSync(safe(copy, 'recoveries/application-' + nativeResult.ref.operationId + '.json'))],
  ]) {
    const copy = target + '-' + suffix;
    fs.cpSync(target, copy, { recursive: true });
    change(copy);
    const port = await open(copy), before = await state(port);
    await assert.rejects(kernel.recoverAbsProjectOperation(port, copy, guard), { code: 'ABS_OPERATION_LOCATION_UNPROVEN' });
    assert.deepEqual(await state(port), before);
    assert.equal(fs.readFileSync(lock(copy), 'utf8'), copiedMarker);
  }

  assert.equal(await kernel.recoverAbsProjectOperation(targetPort, target, guard), null);
  assert.equal(await kernel.restoreAbsProjectCaches(targetPort, target, guard), initial['project.abi']);
  assert.equal(await kernel.recoverAbsProjectOperation(await open(target), target, guard), null);
  const recovered = await state(targetPort);
  const store = new kernel.AbsBaselineStore(targetPort, scope(target));
  const committed = await store.readCommittedSnapshot();
  const accepted = await store.acceptedSourceProof(committed.projection.map.generation);
  assert.equal(accepted.authorSource.pending, true);
  assert.equal(accepted.authorSource.hash, digest(initial['project.abs']));
  assert.deepEqual(accepted.attachment, targetPort.attachment);
  assert.equal(recovered['prepared.json'], null);
  assert.equal(recovered['project.abs'], initial['project.abs']);
  assert.equal(recovered['project.abi'], initial['project.abi']);
  assert.equal(JSON.parse(recovered['project.abs.map.json']).scope.projectKey, target);
  assert.equal(nativeResult.ref.attachment.root, source);
  assert.deepEqual(await state(sourcePort), initial);
  const archives = fs.readdirSync(safe(target, 'recoveries')).filter(file => file.startsWith('copied-lock-'));
  assert.equal(archives.length, 1);
  assert.equal(fs.readFileSync(safe(target, 'recoveries/' + archives[0]), 'utf8'), copiedMarker);
}

async function committedSourceFixture(t) {
  const kernelPath = build(t), kernel = require(kernelPath);
  const source = await seedCopy(t, kernelPath, true, { cut: 'after-cleanup', keepPublisher: true });
  assert.equal(source.initial['prepared.json'], null);
  assert.equal(JSON.parse(source.initial['committed.json']).generation, source.nativeResult.generation);
  assert.equal(JSON.parse(source.initial['operation.json']).id, source.nativeResult.ref.operationId);
  return { ...source, kernelPath, kernel };
}

async function verifyCommittedCopy(t) {
  const { kernel, kernelPath, source, target, targetPort, sourcePort, initial, copiedMarker, nativeResult, publisher } = await committedSourceFixture(t);
  const restart = () => kernel.recoverAbsProjectOperation(targetPort, target, guard);
  await assert.rejects(restart(), { code: 'ABS_OPERATION_LOCATION_UNPROVEN' });
  assert.equal(fs.readFileSync(lock(target), 'utf8'), copiedMarker);
  assert.deepEqual(await state(targetPort), initial);
  await publisher.kill();
  assert.equal((await publisher.exit)[1], 'SIGKILL');

  const operationId = nativeResult.ref.operationId;
  const stageKey = `recoveries/application-${operationId}.json`;
  let retainedProof;
  const interrupted = Error('Keep the original marker for the independent native proof checks.');
  await assert.rejects(kernel.recoverAbsProjectOperation({ ...targetPort, async retireCopiedLock(proof) {
    retainedProof = proof; throw interrupted;
  } }, target, guard), error => error === interrupted);
  assert.equal(retainedProof.phase, 'committed');
  assert.equal(retainedProof.expected['prepared.json'], null);
  const cloneChanges = [
    ['missing-stage', folder => fs.unlinkSync(safe(folder, stageKey))],
    ['different-input', folder => {
      const file = safe(folder, stageKey), stage = JSON.parse(fs.readFileSync(file, 'utf8'));
      fs.writeFileSync(file, JSON.stringify({ ...stage, inputAbiHash: 'sha256:' + '0'.repeat(64) }));
    }],
    ['different-lock-owner', folder => {
      const file = lock(folder), marker = JSON.parse(fs.readFileSync(file, 'utf8'));
      fs.writeFileSync(file, JSON.stringify({ ...marker, attachment: { ...marker.attachment, root: folder } }));
    }],
    ['different-author', folder => fs.appendFileSync(path.join(folder, 'project.abs'), '\n# competing edit\n')],
  ];
  for (const [name, change] of cloneChanges) {
    const folder = `${target}-${name}`;
    fs.cpSync(target, folder, { recursive: true }); change(folder);
    const port = await open(folder), before = await state(port), marker = fs.readFileSync(lock(folder), 'utf8');
    await assert.rejects(kernel.recoverAbsProjectOperation(port, folder, guard));
    // Fresh hashes supplied by a caller do not establish that the changed
    // bytes belong to the same original publisher or committed output.
    const expected = Object.fromEntries(await Promise.all(Object.keys(retainedProof.expected).map(async key => {
      const value = await port.read(key); return [key, value === null ? null : digest(value)];
    })));
    await assert.rejects(port.retireCopiedLock({ ...retainedProof, expected }), { code: 'PROJECT_FILE_LOCK_CHANGED' });
    assert.deepEqual(await state(port), before);
    assert.equal(fs.readFileSync(lock(folder), 'utf8'), marker);
    assert.ok(!fs.readdirSync(safe(folder, 'recoveries')).some(file => file.startsWith('copied-lock-')));
  }

  const resumed = child(t, __filename, ['recover', target, kernelPath]);
  assert.equal((await resumed.reply()).transaction, 'settled');
  assert.equal((await resumed.exit)[0], 0);
  const port = await open(target), recovered = await state(port);
  assert.equal(recovered['project.abi'], initial['project.abi']);
  assert.equal(recovered['project.abs'], initial['project.abs']);
  assert.equal(recovered['prepared.json'], null);
  assert.equal(JSON.parse(recovered['project.abs.map.json']).scope.projectKey, target);
  assert.deepEqual(await state(sourcePort), initial);
  const originalStage = await port.read(stageKey);
  const copiedArchives = fs.readdirSync(safe(target, 'recoveries')).filter(file => file.startsWith('copied-lock-'));
  assert.equal(copiedArchives.length, 1);
  assert.equal(fs.readFileSync(safe(target, `recoveries/${copiedArchives[0]}`), 'utf8'), copiedMarker);

  const newer = child(t, __filename, ['native-save', target, kernelPath, 'after-abi', '901']);
  const pending = await newer.reply(), marker = fs.readFileSync(lock(target), 'utf8');
  const observe = () => kernel.observeNativePublication(port, target, nativeResult.ref.request, { originalTargetPid: nativeResult.pid });
  await assert.rejects(observe(), { code: 'ABS_NATIVE_SAVE_OBSERVATION_INVALID' });
  assert.equal(fs.readFileSync(lock(target), 'utf8'), marker);
  assert.equal(JSON.parse(marker).pid, newer.pid);
  newer.send({ action: 'continue' });
  assert.equal((await newer.reply()).event, 'saved');
  assert.equal((await newer.exit)[0], 0);
  const receipt = await kernel.observeNativePublication(port, target, pending.ref.request, { originalTargetPid: newer.pid });
  assert.equal(receipt.saveReceipt.requestId, pending.ref.request.requestId);
  assert.equal(receipt.result.publication.status, 'COMMITTED');
  assert.equal(JSON.parse(await port.read('project.abi')).pages[0].content.blocks.blocks[0].fields.VALUE, 901);
  assert.equal(await port.read('project.abs'), initial['project.abs']);
  assert.equal(await port.read(stageKey), originalStage);
  assert.notEqual(nativeResult.ref.attachment.root, target);
  assert.equal(nativeResult.ref.attachment.root, source);
  assert.deepEqual(await state(sourcePort), initial);
}

async function verifyLateCommittedProof(t) {
  const { kernel, kernelPath, target, targetPort, initial, publisher } = await committedSourceFixture(t);
  await publisher.kill();
  const entered = deferred(), resume = deferred(), relocking = deferred();
  let continueOld = false;
  const old = kernel.recoverAbsProjectOperation({ ...targetPort,
    async retireCopiedLock(proof) {
      entered.resolve(); await resume.promise;
      return targetPort.retireCopiedLock(proof);
    },
    withLock(action) {
      if (continueOld) relocking.resolve();
      return targetPort.withLock(action);
    },
  }, target, guard);
  void old.catch(() => {});
  try {
    await Promise.race([entered.promise, old.then(() => assert.fail('The original copied proof was not intercepted.'))]);
    const first = child(t, __filename, ['recover', target, kernelPath]);
    assert.equal((await first.reply()).transaction, 'settled');
    assert.equal((await first.exit)[0], 0);
    const newer = child(t, __filename, ['native-save', target, kernelPath, 'after-abi', '901']);
    const next = await newer.reply();
    const marker = fs.readFileSync(lock(target), 'utf8'), pending = await state(targetPort);
    continueOld = true;
    resume.resolve();
    await Promise.race([relocking.promise, old.then(() => assert.fail('The old proof did not wait for the newer lock.'))]);
    assert.equal(fs.readFileSync(lock(target), 'utf8'), marker);
    assert.deepEqual(await state(targetPort), pending);
    newer.send({ action: 'continue' });
    assert.equal((await newer.reply()).event, 'saved');
    assert.equal((await newer.exit)[0], 0);
    assert.equal(await old, null);
    const result = await kernel.observeNativePublication(targetPort, target, next.ref.request, { originalTargetPid: newer.pid });
    assert.equal(result.saveReceipt.requestId, next.ref.request.requestId);
    assert.equal(result.result.publication.status, 'COMMITTED');
    assert.equal(await targetPort.read('project.abs'), initial['project.abs']);
  } finally { resume.resolve(); await old.catch(() => {}); }
}

if (process.send) {
  const [, , mode, project] = process.argv;
  (async () => {
    if (mode === 'native-save') await nativeSave(project, process.argv[5], process.argv[6] === undefined ? undefined : Number(process.argv[6]));
    else {
      assert.equal(mode, 'recover');
      await require(kernelPath).recoverAbsProjectOperation(await open(project), project, guard);
      process.send({ transaction: 'settled' });
    }
  })().then(() => process.disconnect(), error => {
    process.send({ error: error.message, code: error.code, stack: error.stack });
    process.exitCode = 1;
    process.disconnect();
  });
} else {
  test('copied marker retirement waits for an admitted local save without changing its lock', { timeout: 35000 }, t => verifyOverlap(t, true));
  test('local native save interrupted before copied recovery reacquires the project lock settles by its own request', { timeout: 35000 }, t => verifyOverlap(t, false));
  test('copied native save with an exact unpublished author draft can reopen without publishing the draft', { timeout: 35000 }, verifyNativeDraft);
  test('committed copied native save retires only its exact exited foreign lock with no prepared pointer', { timeout: 45000 }, verifyCommittedCopy);
  test('late committed copy proof waits for a newer local native save without releasing it', { timeout: 45000 }, verifyLateCommittedProof);
}
