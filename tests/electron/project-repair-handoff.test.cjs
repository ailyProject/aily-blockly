const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createProjectRecoveryReceipts } = require('../../electron/project-recovery-receipts');
const { createRepairEnvironmentController, readRepairBootstrap } = require('../../electron/project-repair-environment');
const { createRepairContinuationController, checkRepairProjectOpen } = require('../../electron/project-repair-lineage');
const { createRepairHandoffController, repairForkPolicy } = require('../../electron/project-repair-handoff');
const { createNativeRepairPrimary } = require('../../electron/project-repair-primary');
const loadViewLocks = require('./fixtures/project-view-locks.cjs');
const hash = text => 'sha256:' + createHash('sha256').update(text).digest('hex');
const output = path.resolve(__dirname, '../test-results/agent-tools-repair-20261027/native-handoff');
fs.mkdirSync(output, { recursive: true });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(output, 'case-'));
  t.after(() => { if (!path.resolve(root).startsWith(output + path.sep)) throw new Error('Unsafe fixture cleanup'); fs.rmSync(root, { recursive: true, force: true }); });
  const appData = path.join(root, 'data'), appPath = path.join(root, 'app');
  const source = path.join(root, 'A'), repair = path.join(root, 'B'), target = path.join(root, 'C');
  const sourceText = '{"program":"A"}', workspaceText = '{"unsaved":"B-new-canvas"}';
  for (const directory of [appData, appPath, source, repair, target]) fs.mkdirSync(directory);
  fs.writeFileSync(path.join(appPath, 'package.json'), '{}');
  for (const project of [source, repair, target]) {
    fs.writeFileSync(path.join(project, 'project.abi'), sourceText); fs.writeFileSync(path.join(project, 'package.json'), '{"name":"fixture"}');
  }
  const archive = path.join(repair, 'recovery-source-fixture.json');
  fs.writeFileSync(archive, JSON.stringify({ version: 1, sourceProject: source, files: { 'project.abi': sourceText }, partialCanvas: { captured: false } }));
  const store = createProjectRecoveryReceipts(appData), originalRequest = 'original-fork-fixture';
  store.begin(source, originalRequest, '[]', hash(sourceText));
  store.complete(source, originalRequest, '[]', { projectSaved: true, activated: false, project: repair, sourceProject: source,
    recoveryArchive: archive, activationBlocked: { reason: 'partial-canvas-unavailable' },
    recoverySource: { version: 1, kind: 'saved-document', complete: true, loadFailed: true, partialCanvas: 'unavailable' } }, hash(sourceText));
  let launches = [], children = new Map();
  const params = record => ({ version: 2, project: record.project, requestId: record.requestId, environmentId: record.environmentId,
    parentHostPid: record.parentHostPid, lineageId: record.lineageId, epoch: record.epoch });
  const options = { appDataPath: appData, appPath, execPath: process.execPath, pid: 101, env: {},
    processState: pid => pid === 101 || children.has(pid), sourceViewRetained: () => false,
    projectViewLocks: loadViewLocks(), queryChild: async record => {
      const response = children.get(record.hostPid)?.identity(params(record));
      return response?.ok ? response.repairEnvironment : null;
    }, spawnChild: (_exe, _args, launch) => { const pid = launches.length ? 303 : 202; launches.push(launch); return { pid, once() {}, unref() {} }; } };
  const environments = createRepairEnvironmentController(options), continuation = createRepairContinuationController(options);
  async function startB() {
    await environments.ensure(source, originalRequest);
    const begun = await continuation.resume({ version: 1, project: repair, sourceProject: source,
      requestId: originalRequest, resumeRequestId: 'original-resume-fixture' });
    assert.equal(begun.repairEnvironment.hostPid, 202);
    const child = readRepairBootstrap(launches[0].env.AILY_REPAIR_BOOTSTRAP, { execPath: process.execPath, appPath, pid: 202 });
    children.set(202, child); child.complete({ project: repair, ready: true });
    const observed = await continuation.inspect({ version: 1, project: repair });
    return { child, environment: observed.repairEnvironment };
  }
  function completeC(child, kind = 'workspace') {
    const requestId = 'nested-complete-fork';
    const store = createProjectRecoveryReceipts(child.record.privateAppData);
    const text = kind === 'workspace' ? workspaceText : sourceText;
    fs.writeFileSync(path.join(target, 'project.abi'), text);
    const result = { projectSaved: true, activated: false, project: target, sourceProject: repair,
      activationDeferred: { reason: 'isolated-repair-host' }, recoverySource: {
        version: 1, kind, complete: true, loadFailed: kind === 'saved-document', partialCanvas: kind === 'workspace' ? 'not-applicable' : 'archived' } };
    if (kind === 'saved-document') {
      result.recoveryArchive = path.join(target, 'recovery-source-nested.json');
      fs.writeFileSync(result.recoveryArchive, JSON.stringify({ version: 1, sourceProject: repair,
        files: { 'project.abi': sourceText }, partialCanvas: { captured: true } }));
    }
    store.begin(repair, requestId, '[]', hash(sourceText)); store.complete(repair, requestId, '[]', result, hash(text));
    return { requestId, store, result, text };
  }
  return { root, appData, appPath, source, repair, target, sourceText, options, environments, continuation, startB, completeC,
    launches, children, params };
}

for (const kind of ['workspace', 'saved-document']) test(`nested ${kind} fork prepares C under root, retaining A/B and exact child navigation restriction`, async t => {
  const f = fixture(t), b = await f.startB(), nested = f.completeC(b.child, kind);
  const receiptBefore = nested.store.status(f.repair, nested.requestId);
  const sourceBytes = fs.readFileSync(path.join(f.source, 'project.abi')), repairBytes = fs.readFileSync(path.join(f.repair, 'project.abi'));
  assert.equal(checkRepairProjectOpen(b.child.record, f.target, 202).code, 'PROJECT_REPAIR_TARGET_MISMATCH');
  assert.equal(repairForkPolicy(b.child.record, { sourceProject: f.repair, project: f.target }, f.repair, 202).activation, 'deferred');
  const controller = createRepairHandoffController({ continuation: f.continuation, environments: f.environments, pid: 101 });
  const params = { version: 1, sourceProject: f.repair, project: f.target, requestId: nested.requestId, sourceEnvironment: b.environment };
  const result = await controller.prepare(params);
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.repairEnvironment.version, 2);
  assert.equal(result.repairEnvironment.epoch, 0); assert.equal(result.repairEnvironment.hostPid, undefined);
  assert.equal(result.repairEnvironment.parentHostPid, 101); assert.equal(f.launches.length, 1, 'Preparing C must not launch it');
  assert.equal(result.handoffVerification.sourceEnvironmentId, b.environment.environmentId);
  assert.equal(result.handoffVerification.sourceEpoch, 1); assert.equal(result.handoffVerification.sourceHostPid, 202);
  assert.equal(result.handoffVerification.currentAbiHash, hash(nested.text));
  const repeated = await controller.prepare(params);
  assert.equal(repeated.repairEnvironment.lineageId, result.repairEnvironment.lineageId);
  const c = await f.continuation.resume({ version: 1, project: f.target, sourceProject: f.repair,
    requestId: nested.requestId, resumeRequestId: 'nested-resume-fixture' });
  assert.equal(c.repairEnvironment.hostPid, 303); assert.equal(c.repairEnvironment.epoch, 1);
  const child = readRepairBootstrap(f.launches[1].env.AILY_REPAIR_BOOTSTRAP, { execPath: process.execPath, appPath: f.appPath, pid: 303 });
  const admission = child.admission();
  assert.equal(admission.recoverySource.kind, kind); assert.equal(child.record.project, f.target);
  if (kind === 'workspace') {
    assert.equal(admission.nativePrimaryProof.kind, 'native-completed-fork-primary');
    assert.equal(admission.nativePrimaryProof.archive, admission.recoveryArchive);
    assert.equal(JSON.parse(fs.readFileSync(admission.recoveryArchive)).primary.text, nested.text);
  }
  assert.equal(checkRepairProjectOpen(child.record, f.repair, 303).code, 'PROJECT_REPAIR_TARGET_MISMATCH');
  assert.deepEqual(nested.store.status(f.repair, nested.requestId), receiptBefore, 'Do not rewrite the immutable workspace/saved-document receipt');
  assert.deepEqual(fs.readFileSync(path.join(f.source, 'project.abi')), sourceBytes);
  assert.deepEqual(fs.readFileSync(path.join(f.repair, 'project.abi')), repairBytes);
});
for (const invalid of ['epoch', 'parent', 'target', 'hash', 'extra-root']) test(`handoff refuses ${invalid} without a new process or source mutation`, async t => {
  const f = fixture(t), b = await f.startB(), nested = f.completeC(b.child);
  const params = { version: 1, sourceProject: f.repair, project: f.target, requestId: nested.requestId, sourceEnvironment: { ...b.environment } };
  if (invalid === 'epoch') params.sourceEnvironment.epoch++;
  if (invalid === 'parent') params.sourceEnvironment.parentHostPid++;
  if (invalid === 'target') params.project = f.source;
  if (invalid === 'hash') fs.writeFileSync(path.join(f.target, 'project.abi'), '{"changed":true}');
  if (invalid === 'extra-root') params.receiptRoot = f.appData;
  const result = await createRepairHandoffController({ continuation: f.continuation, environments: f.environments, pid: 101 }).prepare(params);
  assert.equal(result.ok, false); assert.equal(f.launches.length, 1);
  assert.equal(fs.readFileSync(path.join(f.repair, 'project.abi'), 'utf8'), f.sourceText);
});
for (const sourceExited of [false, true]) test(`completed handoff replay observes C current lineage after legitimate edits${sourceExited ? ' even after B exits' : ''}`, async t => {
  const f = fixture(t), b = await f.startB(), nested = f.completeC(b.child);
  const controller = createRepairHandoffController({ continuation: f.continuation, environments: f.environments, pid: 101 });
  const params = { version: 1, sourceProject: f.repair, project: f.target, requestId: nested.requestId, sourceEnvironment: b.environment };
  const first = await controller.prepare(params); assert.equal(first.ok, true);
  const receiptBefore = nested.store.status(f.repair, nested.requestId);
  await f.continuation.resume({ version: 1, project: f.target, sourceProject: f.repair,
    requestId: nested.requestId, resumeRequestId: 'handoff-replay-resume' });
  const child = readRepairBootstrap(f.launches[1].env.AILY_REPAIR_BOOTSTRAP, { execPath: process.execPath, appPath: f.appPath, pid: 303 });
  f.children.set(303, child); child.complete({ project: f.target, ready: true });
  const started = await controller.prepare(params);
  assert.equal(started.ok, true, JSON.stringify(started)); assert.equal(started.repairEnvironment.epoch, 1);
  const current = '{"legitimateTarget":"second program"}'; fs.writeFileSync(path.join(f.target, 'project.abi'), current);
  if (sourceExited) f.children.delete(202);
  const replay = await controller.prepare(params);
  assert.equal(replay.ok, true, JSON.stringify(replay)); assert.equal(replay.repairEnvironment.state, 'ready');
  assert.equal(replay.handoffVerification.currentAbiHash, hash(current)); assert.equal(replay.handoffVerification.epoch, 1);
  assert.equal(replay.handoffVerification.sourceEnvironmentId, b.environment.environmentId);
  assert.equal(replay.recoveryContinuation.currentAbiHash, hash(current)); assert.equal(f.launches.length, 2);
  assert.deepEqual(nested.store.status(f.repair, nested.requestId), receiptBefore);
  assert.equal(fs.readFileSync(path.join(f.source, 'project.abi'), 'utf8'), f.sourceText);
  assert.equal(fs.readFileSync(path.join(f.repair, 'project.abi'), 'utf8'), f.sourceText);
  const stale = await controller.prepare({ ...params, sourceEnvironment: { ...b.environment, epoch: b.environment.epoch + 1 } });
  assert.equal(stale.ok, true, 'C continuation does not depend on B remaining on its old epoch');
  assert.equal(stale.observationOnly, true);
  assert.equal(stale.handoffVerification.sourceEpoch, b.environment.epoch, 'Return the native historical origin, never the caller-supplied newer B epoch');
  assert.equal(stale.handoffVerification.sourceEnvironmentId, b.environment.environmentId);
  assert.equal(stale.handoffVerification.observationOnly, true);
  const unrelated = await controller.prepare({ ...params, requestId: 'different-fork-request' });
  assert.equal(unrelated.ok, false, 'Existing C lineage must bind the original request, not any completed sibling fork');
  assert.equal(f.launches.length, 2);
});
test('handoff replay of an exited C reports its own current snapshot and leaves restart to standard resume', async t => {
  const f = fixture(t), b = await f.startB(), nested = f.completeC(b.child);
  const controller = createRepairHandoffController({ continuation: f.continuation, environments: f.environments, pid: 101 });
  const params = { version: 1, sourceProject: f.repair, project: f.target, requestId: nested.requestId, sourceEnvironment: b.environment };
  assert.equal((await controller.prepare(params)).ok, true);
  await f.continuation.resume({ version: 1, project: f.target, sourceProject: f.repair,
    requestId: nested.requestId, resumeRequestId: 'handoff-exited-fixture' });
  const replay = await controller.prepare(params);
  assert.equal(replay.ok, true, JSON.stringify(replay)); assert.equal(replay.observationOnly, true);
  assert.equal(replay.repairEnvironment.state, 'failed'); assert.equal(replay.repairEnvironment.epoch, 1);
  assert.equal(replay.recoveryContinuation.currentAbiHash, hash(nested.text)); assert.equal(f.launches.length, 2);
});
test('native primary archive proves C workspace snapshot, never B historical ABI, and refuses changed data', async t => {
  const f = fixture(t), b = await f.startB(), nested = f.completeC(b.child), receipt = nested.store.status(f.repair, nested.requestId);
  const record = { project: f.target, sourceProject: f.repair, requestId: nested.requestId, targetAbiHash: hash(nested.text) };
  const proof = createNativeRepairPrimary(record, receipt, nested.result), archive = JSON.parse(fs.readFileSync(proof.archive));
  assert.equal(archive.primary.text, nested.text); assert.notEqual(archive.primary.text, f.sourceText);
  assert.equal(proof.origin.sourceKind, 'workspace'); assert.equal(proof.origin.sourceAbiHash, hash(f.sourceText));
  assert.deepEqual(createNativeRepairPrimary(record, receipt, nested.result), proof);
  const bytes = fs.readFileSync(proof.archive);
  fs.writeFileSync(path.join(f.target, 'project.abi'), '{"newer":true}');
  assert.throws(() => createNativeRepairPrimary(record, receipt, nested.result), /differs/);
  assert.deepEqual(fs.readFileSync(proof.archive), bytes);
});
test('native primary archive rejects an inner directory link without writing outside C', async t => {
  const f = fixture(t), b = await f.startB(), nested = f.completeC(b.child), receipt = nested.store.status(f.repair, nested.requestId);
  const external = path.join(f.root, 'external'); fs.mkdirSync(external); fs.mkdirSync(path.join(f.target, '.aily'));
  fs.symlinkSync(external, path.join(f.target, '.aily', 'recovery-primary'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => createNativeRepairPrimary({ project: f.target, sourceProject: f.repair, requestId: nested.requestId,
    targetAbiHash: hash(nested.text) }, receipt, nested.result), /directory identity changed or is linked/);
  assert.deepEqual(fs.readdirSync(external), []);
});
test('fork policy is native exact-source only; ordinary host behavior remains same-host', () => {
  const source = path.resolve('source'), target = path.resolve('target');
  assert.equal(repairForkPolicy(null, { sourceProject: source, project: target }, source).activation, 'same-host');
  assert.throws(() => repairForkPolicy({ project: source, hostPid: 202 }, { sourceProject: source, project: target }, target, 202), /exact current source/);
  assert.throws(() => repairForkPolicy({ project: source, hostPid: 202 }, { sourceProject: source, project: target, override: true }, source, 202), /absolute source/);
});
test('ordinary parent with no current view can defer closed-source ownership to the existing Domain gate, unlike a repair child', () => {
  const source = path.resolve('closed-source'), target = path.resolve('closed-recovery');
  assert.equal(repairForkPolicy(null, { sourceProject: source, project: target }, '', 101).activation, 'same-host');
  assert.throws(() => repairForkPolicy({ project: source, hostPid: 202 }, { sourceProject: source, project: target }, '', 202), /exact current source/);
  assert.throws(() => repairForkPolicy(null, { sourceProject: source, project: source }, '', 101), /distinct absolute target/);
  assert.throws(() => repairForkPolicy(null, { sourceProject: 'relative', project: target }, '', 101), /absolute source/);
});
