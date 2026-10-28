const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const fixture = require('./fixtures/project-repair-environment.cjs');
const native = require('../../electron/project-repair-environment');
const { createRepairContinuationController } = require('../../electron/project-repair-lineage');
const { createRepairHandoffController } = require('../../electron/project-repair-handoff');
const { createRepairCommitStore } = require('../../electron/project-repair-commit');

const identity = record => ({ version: 2, project: record.project, requestId: record.requestId,
  environmentId: record.environmentId, parentHostPid: record.parentHostPid, lineageId: record.lineageId, epoch: record.epoch });
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const hash = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
const sourceBytes = f => ['project.abi', 'project.abs'].map(name => fs.readFileSync(path.join(f.source, name)));

function claimFixture(t) {
  const f = fixture(t), directory = path.join(f.root, 'atomic-owner-ledger'); fs.mkdirSync(directory);
  const owner = { version: 1, lineageId: 'atomic-owner-lineage', epoch: 2, ownerHostPid: 101,
    environmentId: 'atomic-owner-environment', recordFile: path.join(directory, 'attempt.json'), hostPid: 200 };
  const store = createRepairCommitStore({ readJson: native.readJson, writeNew: native.writeNew,
    writeRecord: native.writeRecord, processState: () => false });
  const filename = path.join(directory, 'owners', '2.json');
  const isPublication = file => typeof file === 'string' && path.dirname(file) === path.dirname(filename)
    && (file === filename || path.basename(file).startsWith('.2.json.') && file.endsWith('.tmp'));
  return { directory, owner, store, filename, isPublication };
}

for (const interruption of ['partial-write', 'write-ack', 'sync', 'install', 'install-ack', 'cleanup'])
  test(`immutable owner ${interruption} failure cannot publish partial bytes or permanently poison its epoch`, t => {
    const f = claimFixture(t), original = { writeFileSync: fs.writeFileSync, fsyncSync: fs.fsyncSync,
      linkSync: fs.linkSync, unlinkSync: fs.unlinkSync };
    let injected = false;
    const interrupted = () => { injected = true; throw Object.assign(new Error('Injected immutable owner publication interruption'), { code: 'EIO' }); };
    try {
      if (interruption === 'partial-write' || interruption === 'write-ack') fs.writeFileSync = function (file, bytes, ...args) {
        if (!injected && f.isPublication(file)) {
          original.writeFileSync(file, interruption === 'partial-write' ? Buffer.from(bytes).subarray(0, 12) : bytes, ...args);
          return interrupted();
        }
        return original.writeFileSync(file, bytes, ...args);
      };
      else if (interruption === 'sync') fs.fsyncSync = function (...args) { if (!injected) return interrupted(); return original.fsyncSync(...args); };
      else if (interruption === 'install' || interruption === 'install-ack') fs.linkSync = function (...args) {
        if (!injected && args[1] === f.filename) {
          if (interruption === 'install-ack') original.linkSync(...args);
          return interrupted();
        }
        return original.linkSync(...args);
      };
      else fs.unlinkSync = function (file, ...args) {
        if (!injected && f.isPublication(file) && file !== f.filename) return interrupted();
        return original.unlinkSync(file, ...args);
      };
      assert.throws(() => f.store.recordEpoch(f.directory, f.owner), { code: 'EIO' });
      assert.equal(injected, true, 'The intended publication phase must actually execute');
    } finally { Object.assign(fs, original); }
    if (fs.existsSync(f.filename)) assert.deepEqual(JSON.parse(fs.readFileSync(f.filename, 'utf8')), f.owner);
    else assert.equal(['partial-write', 'write-ack', 'sync', 'install'].includes(interruption), true);
    f.store.recordEpoch(f.directory, f.owner);
    assert.deepEqual(native.readJson(f.filename), f.owner); assert.equal(fs.lstatSync(f.filename).nlink, 1);
    const previous = fs.readFileSync(f.filename); f.store.recordEpoch(f.directory, f.owner);
    assert.deepEqual(fs.readFileSync(f.filename), previous);
  });

test('an incomplete pre-existing owner claim is preserved and never skipped or replaced', t => {
  const f = claimFixture(t); fs.mkdirSync(path.dirname(f.filename)); const bytes = '{"version":1'; fs.writeFileSync(f.filename, bytes);
  assert.throws(() => f.store.recordEpoch(f.directory, f.owner));
  assert.equal(fs.readFileSync(f.filename, 'utf8'), bytes);
});

test('an unknown extra owner hard link is not treated as an owned publication stage', t => {
  const f = claimFixture(t); f.store.recordEpoch(f.directory, f.owner);
  const unrelated = path.join(f.directory, 'unrelated-link'); fs.linkSync(f.filename, unrelated);
  assert.throws(() => f.store.recordEpoch(f.directory, f.owner));
  assert.equal(fs.existsSync(unrelated), true); assert.equal(fs.lstatSync(f.filename).nlink, 2);
});

test('cleanup resumes only the installed inode while older complete staging evidence is retained', t => {
  const f = claimFixture(t), write = fs.writeFileSync, unlink = fs.unlinkSync;
  try {
    fs.writeFileSync = function (file, ...args) {
      const result = write(file, ...args);
      if (f.isPublication(file)) throw Object.assign(new Error('Lost staging write acknowledgement'), { code: 'EIO' });
      return result;
    };
    assert.throws(() => f.store.recordEpoch(f.directory, f.owner), { code: 'EIO' });
  } finally { fs.writeFileSync = write; }
  const old = fs.readdirSync(path.dirname(f.filename)).map(name => path.join(path.dirname(f.filename), name));
  assert.equal(old.length, 1); const bytes = fs.readFileSync(old[0]);
  try {
    fs.unlinkSync = file => { if (f.isPublication(file)) throw Object.assign(new Error('Busy installed staging link'), { code: 'EBUSY' }); return unlink(file); };
    assert.throws(() => f.store.recordEpoch(f.directory, f.owner), { code: 'EBUSY' });
  } finally { fs.unlinkSync = unlink; }
  f.store.recordEpoch(f.directory, f.owner);
  assert.deepEqual(native.readJson(f.filename), f.owner); assert.equal(fs.lstatSync(f.filename).nlink, 1);
  assert.deepEqual(fs.readFileSync(old[0]), bytes); assert.equal(fs.lstatSync(old[0]).nlink, 1);
});

function paths(f) {
  const recordFile = f.launch().options.env.AILY_REPAIR_BOOTSTRAP, record = read(recordFile);
  const directory = path.join(f.appData, 'agent-repair-environments', 'lineages', record.lineageId);
  return { recordFile, record, directory, current: path.join(directory, 'current.json'),
    request: path.join(directory, 'requests', f.resume.resumeRequestId + '.json'),
    spawn: path.join(path.dirname(recordFile), record.environmentId, 'spawn.json') };
}
async function failOnce(target, method, predicate, action, phase) {
  const original = target[method]; let injected = false;
  try {
    target[method] = function (...args) {
      if (!injected && predicate(...args)) { injected = true; throw Object.assign(new Error('Injected native commit interruption'), { code: 'EIO' }); }
      return original.apply(this, args);
    };
    const result = await action(); assert.equal(injected, true, 'The intended durable boundary must actually be reached');
    assert.equal(result.ok, false); assert.equal(result.code, phase ? 'PROJECT_REPAIR_COMMIT_UNCONFIRMED' : 'EIO');
    if (phase) {
      assert.equal(result.details.phase, phase); assert.equal(result.details.cause, 'EIO');
      assert.equal(result.recoverability.state, 'metadata-commit-unconfirmed');
      assert.deepEqual(result.nextAction, result.observeAction);
      assert.equal(result.nextAction.input.action, 'inspect_environment');
      assert.equal(result.nextAction.input.project, result.project);
      assert.match(result.resumeCondition, /Inspect the original request first/);
    } else assert.notEqual(result.recoverability?.state, 'metadata-commit-unconfirmed');
    return result;
  } finally { target[method] = original; }
}
function query(child, transform = value => value) {
  return async (record, _root, operation) => {
    const actual = child.identity(identity(record));
    if (!actual.ok) return null;
    return transform({ ...actual.repairEnvironment,
      ...(operation === 'project_repair_adoptable' ? { ownerStatus: { idle: true } } : {}) }, operation);
  };
}
async function interruptRequestFile(filename, state, boundary, action) {
  const write = fs.writeFileSync, rename = fs.renameSync; let injected = false;
  try {
    if (boundary === 'short-write') fs.writeFileSync = function (file, bytes, ...args) {
      if (!injected && typeof file === 'string' && file.startsWith(filename + '.') && file.endsWith('.tmp')
        && JSON.parse(String(bytes)).state === state) {
        injected = true; write(file, Buffer.from(bytes).subarray(0, 12), ...args);
        throw Object.assign(new Error('Partial request staging write'), { code: 'EIO' });
      }
      return write(file, bytes, ...args);
    };
    else fs.renameSync = function (stage, destination) {
      if (!injected && destination === filename && read(stage).state === state) {
        injected = true; rename(stage, destination);
        throw Object.assign(new Error('Lost request rename acknowledgement'), { code: 'EIO' });
      }
      return rename(stage, destination);
    };
    const result = await action(); assert.equal(injected, true, 'The exact request publication boundary must execute');
    assert.equal(result.ok, false); return result;
  } finally { fs.writeFileSync = write; fs.renameSync = rename; }
}

for (const boundary of ['short-write', 'rename-ack']) test(`first preparing request ${boundary} remains known unstarted and resumes the same nonce`, async t => {
  const f = fixture(t), prepared = await f.prepare.ensure(f.source, f.request), before = sourceBytes(f);
  const directory = path.join(f.appData, 'agent-repair-environments', 'lineages', prepared.environmentId);
  const filename = path.join(directory, 'requests', f.resume.resumeRequestId + '.json');
  const interrupted = await interruptRequestFile(filename, 'preparing', boundary, () => f.continuation.resume(f.resume));
  assert.equal(interrupted.code, 'EIO'); assert.equal(f.spawned(), 0);
  if (boundary === 'short-write') assert.equal(fs.existsSync(filename), false);
  else assert.equal(read(filename).state, 'preparing');
  const observed = await f.continuation.inspect({ version: 1, project: f.target });
  assert.equal(observed.ok, true, JSON.stringify(observed)); assert.equal(observed.pendingResume, undefined);
  if (boundary === 'rename-ack') assert.equal(observed.retryableResume.resumeRequestId, f.resume.resumeRequestId);
  const retried = await f.continuation.resume(f.resume);
  assert.equal(retried.code, 'PROJECT_REPAIR_ENVIRONMENT_STARTING'); assert.equal(f.spawned(), 1);
  assert.equal(read(filename).state, 'completed'); assert.equal(read(filename).resumeRequestId, f.resume.resumeRequestId);
  await f.continuation.resume(f.resume); assert.equal(f.spawned(), 1); assert.deepEqual(sourceBytes(f), before);
});

for (const boundary of ['short-write', 'rename-ack']) test(`authenticated final request ${boundary} remains observable and never restarts the same child`, async t => {
  const f = fixture(t); await f.controller.ensure(); const p = paths(f), before = sourceBytes(f);
  const child = native.readRepairBootstrap(p.recordFile, { execPath: process.execPath, appPath: f.appPath, pid: 200 });
  child.complete({ project: f.target, ready: true });
  const controller = createRepairContinuationController({ ...f.opts, pid: 101, processState: pid => pid !== 100, queryChild: query(child) });
  const request = { ...f.resume, resumeRequestId: 'atomic-adoption-' + boundary };
  const filename = path.join(p.directory, 'requests', request.resumeRequestId + '.json');
  const interrupted = await interruptRequestFile(filename, 'completed', boundary, () => controller.resume(request));
  assert.equal(interrupted.code, 'PROJECT_REPAIR_COMMIT_UNCONFIRMED'); assert.equal(interrupted.details.phase, 'final-ack');
  assert.equal(interrupted.details.cause, 'EIO'); assert.equal(interrupted.nextAction.input.action, 'inspect_environment');
  assert.equal(interrupted.recoverability.state, 'metadata-commit-unconfirmed'); assert.equal(read(p.current).epoch, 2);
  if (boundary === 'short-write') assert.equal(fs.existsSync(filename), false);
  else assert.equal(read(filename).state, 'completed');
  const observed = await controller.inspect({ version: 1, project: f.target });
  assert.equal(observed.ok, true, JSON.stringify(observed)); assert.equal(observed.pendingResume, undefined);
  const retried = await controller.resume(request);
  assert.equal(retried.ok, true, JSON.stringify(retried)); assert.equal(retried.repairEnvironment.epoch, 2);
  assert.equal(read(filename).state, 'completed'); assert.equal(read(filename).resumeRequestId, request.resumeRequestId);
  assert.equal(f.spawned(), 1); assert.deepEqual(sourceBytes(f), before);
  assert.equal(retried.recoveryContinuation.sourceGuardReleased, false);
  assert.equal(retried.recoveryContinuation.originalWorkspaceRebound, false);
});

for (const prior of ['malformed', 'foreign-nonce']) test(`atomic request publication never repairs or overwrites a ${prior} prior record`, async t => {
  const f = fixture(t); await f.controller.ensure(); const p = paths(f), before = sourceBytes(f);
  const child = native.readRepairBootstrap(p.recordFile, { execPath: process.execPath, appPath: f.appPath, pid: 200 });
  child.complete({ project: f.target, ready: true });
  const request = { ...f.resume, resumeRequestId: 'preserve-prior-request' };
  const filename = path.join(p.directory, 'requests', request.resumeRequestId + '.json');
  const bytes = prior === 'malformed' ? '{"version":1' : JSON.stringify({ version: 1, state: 'completed',
    requestId: 'foreign-original-request', resumeRequestId: request.resumeRequestId, epoch: 1 });
  fs.writeFileSync(filename, bytes);
  const rejected = await createRepairContinuationController({ ...f.opts, queryChild: query(child) }).resume(request);
  assert.equal(rejected.ok, false); assert.notEqual(rejected.recoverability.state, 'metadata-commit-unconfirmed');
  assert.equal(fs.readFileSync(filename, 'utf8'), bytes); assert.equal(read(p.current).epoch, 1);
  assert.equal(f.spawned(), 1); assert.deepEqual(sourceBytes(f), before);
});

async function completedWithPendingAck(t) {
  const f = fixture(t); await f.prepare.ensure(f.source, f.request);
  await failOnce(native, 'writeRecord', (file, data) => file.endsWith(f.resume.resumeRequestId + '.json') && data.state === 'completed',
    () => f.continuation.resume(f.resume), 'final-ack');
  const p = paths(f);
  const child = native.readRepairBootstrap(p.recordFile, { execPath: process.execPath, appPath: f.appPath, pid: 200 });
  child.complete({ project: f.target, ready: true });
  assert.equal(read(p.request).state, 'pending'); assert.equal(read(p.current).epoch, 1);
  return { f, p, child };
}

for (const entry of ['inspect', 'same-request', 'new-request']) test(`settles a fully proven launched attempt through ${entry}, without launching or rebinding source`, async t => {
  const { f, p, child } = await completedWithPendingAck(t), before = sourceBytes(f);
  const controller = createRepairContinuationController({ ...f.opts, queryChild: query(child) });
  const result = entry === 'inspect' ? await controller.inspect({ version: 1, project: f.target })
    : await controller.resume(entry === 'same-request' ? f.resume : { ...f.resume, resumeRequestId: 'after-final-ack-failure' });
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.pendingResume, undefined);
  assert.equal(result.repairEnvironment.state, 'ready'); assert.equal(result.repairEnvironment.epoch, 1);
  assert.equal(result.childState, 'authenticated'); assert.equal(read(p.request).state, 'completed');
  assert.equal(f.spawned(), 1); assert.deepEqual(sourceBytes(f), before);
  assert.equal(result.recoveryContinuation.sourceGuardReleased, false);
  assert.equal(result.recoveryContinuation.originalWorkspaceRebound, false);
  const again = await controller.resume(f.resume); assert.equal(again.ok, true); assert.equal(f.spawned(), 1);
});

test('a restarted parent can settle the previous completion before an ordinary protected child adoption', async t => {
  const { f, p, child } = await completedWithPendingAck(t), before = sourceBytes(f);
  const controller = createRepairContinuationController({ ...f.opts, pid: 101,
    processState: pid => pid === 100 ? false : true, queryChild: query(child) });
  const result = await controller.resume({ ...f.resume, resumeRequestId: 'after-ack-parent-restart' });
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(read(p.request).state, 'completed');
  assert.equal(result.repairEnvironment.parentHostPid, 101); assert.equal(result.repairEnvironment.epoch, 2);
  assert.equal(f.spawned(), 1); assert.deepEqual(sourceBytes(f), before);
});

test('completion observation does not require releasing an unrelated current project writer', async t => {
  const { f, p, child } = await completedWithPendingAck(t);
  const file = path.join(f.target, '.aily', 'project-files.write.lock'), bytes = JSON.stringify({ pid: 200, token: 'retain-current-writer' });
  fs.writeFileSync(file, bytes);
  const result = await createRepairContinuationController({ ...f.opts, queryChild: query(child) }).inspect({ version: 1, project: f.target });
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(read(p.request).state, 'completed');
  assert.equal(result.repairEnvironment.parentHostPid, 100); assert.equal(result.repairEnvironment.epoch, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), bytes); assert.equal(f.spawned(), 1);
});

test('a reconciliation write failure can be observed again after I/O recovers without another launch', async t => {
  const { f, p, child } = await completedWithPendingAck(t);
  const controller = createRepairContinuationController({ ...f.opts, queryChild: query(child) });
  await failOnce(native, 'writeRecord', (file, data) => file === p.request && data.state === 'completed',
    () => controller.inspect({ version: 1, project: f.target }), 'final-ack-reconcile');
  assert.equal(read(p.request).state, 'pending');
  const recovered = await controller.inspect({ version: 1, project: f.target });
  assert.equal(recovered.ok, true, JSON.stringify(recovered)); assert.equal(read(p.request).state, 'completed'); assert.equal(f.spawned(), 1);
});

for (const mismatch of ['version', 'hostPid', 'environmentId', 'project', 'sourceProject', 'requestId', 'hostCodeIdentity', 'epoch', 'parentHostPid', 'lineageId'])
  test(`does not settle a pending attempt from mismatched authenticated ${mismatch}`, async t => {
    const { f, p, child } = await completedWithPendingAck(t), original = fs.readFileSync(p.request);
    const controller = createRepairContinuationController({ ...f.opts, queryChild: query(child, value => ({ ...value,
      [mismatch]: typeof value[mismatch] === 'number' ? value[mismatch] + 1 : mismatch === 'project' ? f.source : 'wrong-native-identity' })) });
    const result = await controller.inspect({ version: 1, project: f.target });
    assert.equal(result.ok, false); assert.equal(read(p.request).state, 'pending');
    assert.deepEqual(fs.readFileSync(p.request), original); assert.equal(f.spawned(), 1);
  });

test('a pending attempt cannot use a record path alias as current-attempt evidence', async t => {
  const { f, p, child } = await completedWithPendingAck(t), alias = path.join(f.root, 'epoch-alias');
  fs.symlinkSync(path.dirname(p.recordFile), alias, process.platform === 'win32' ? 'junction' : 'dir');
  const request = read(p.request); request.recordFile = path.join(alias, path.basename(p.recordFile));
  fs.writeFileSync(p.request, JSON.stringify(request));
  const controller = createRepairContinuationController({ ...f.opts, queryChild: query(child) });
  const result = await controller.inspect({ version: 1, project: f.target });
  assert.equal(result.ok, false); assert.equal(read(p.request).state, 'pending'); assert.equal(f.spawned(), 1);
});

test('a mismatched durable spawn proof is not promoted to a completed request', async t => {
  const { f, p, child } = await completedWithPendingAck(t);
  fs.writeFileSync(p.spawn, JSON.stringify({ pid: 201, environmentId: p.record.environmentId }));
  const controller = createRepairContinuationController({ ...f.opts, queryChild: query(child) });
  assert.equal((await controller.inspect({ version: 1, project: f.target })).ok, false);
  assert.equal(read(p.request).state, 'pending'); assert.equal(f.spawned(), 1);
});

test('baseline pending attempts settle from their complete core proof without newly added redundant fields', async t => {
  const { f, p, child } = await completedWithPendingAck(t), before = sourceBytes(f);
  const attempt = read(p.recordFile); delete attempt.resumeRequestId;
  fs.writeFileSync(p.recordFile, JSON.stringify(attempt));
  const spawn = read(p.spawn); delete spawn.epoch; delete spawn.requestId; delete spawn.resumeRequestId;
  fs.writeFileSync(p.spawn, JSON.stringify(spawn));
  const controller = createRepairContinuationController({ ...f.opts, queryChild: query(child) });
  const result = await controller.inspect({ version: 1, project: f.target });
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(read(p.request).state, 'completed');
  assert.equal(result.repairEnvironment.epoch, 1); assert.equal(result.repairEnvironment.hostPid, 200);
  assert.equal(f.spawned(), 1); assert.deepEqual(sourceBytes(f), before);
});

for (const field of ['attempt.resumeRequestId', 'spawn.epoch', 'spawn.requestId', 'spawn.resumeRequestId'])
  test(`a present but mismatched redundant ${field} still prevents completion settlement`, async t => {
    const { f, p, child } = await completedWithPendingAck(t), [kind, name] = field.split('.');
    const filename = kind === 'attempt' ? p.recordFile : p.spawn, value = read(filename);
    value[name] = name === 'epoch' ? 99 : 'wrong-present-identity'; fs.writeFileSync(filename, JSON.stringify(value));
    const pending = fs.readFileSync(p.request);
    const controller = createRepairContinuationController({ ...f.opts, queryChild: query(child) });
    assert.equal((await controller.inspect({ version: 1, project: f.target })).ok, false);
    assert.deepEqual(fs.readFileSync(p.request), pending); assert.equal(read(p.request).state, 'pending'); assert.equal(f.spawned(), 1);
  });

for (const directory of ['requests', 'owners']) test(`an aliased ${directory} proof directory cannot settle a pending completion`, async t => {
  const { f, p, child } = await completedWithPendingAck(t);
  const original = path.join(p.directory, directory), preserved = original + '-preserved';
  fs.renameSync(original, preserved); fs.symlinkSync(preserved, original, process.platform === 'win32' ? 'junction' : 'dir');
  const bytes = fs.readFileSync(p.request);
  const controller = createRepairContinuationController({ ...f.opts, queryChild: query(child) });
  assert.equal((await controller.inspect({ version: 1, project: f.target })).ok, false);
  assert.equal(read(p.request).state, 'pending'); assert.deepEqual(fs.readFileSync(p.request), bytes); assert.equal(f.spawned(), 1);
});

test('an active-current change after identity observation cannot settle the earlier attempt', async t => {
  const { f, p, child } = await completedWithPendingAck(t), pending = fs.readFileSync(p.request);
  let changed;
  const controller = createRepairContinuationController({ ...f.opts, queryChild: query(child, actual => {
    const current = read(p.current); current.ownerHostPid = 101; changed = JSON.stringify(current);
    fs.writeFileSync(p.current, changed); return actual;
  }) });
  const result = await controller.inspect({ version: 1, project: f.target });
  assert.equal(result.ok, false); assert.equal(read(p.request).state, 'pending');
  assert.deepEqual(fs.readFileSync(p.request), pending); assert.equal(fs.readFileSync(p.current, 'utf8'), changed); assert.equal(f.spawned(), 1);
});

test('a conflicting committed owner claim is not silently replaced while settling ACK metadata', async t => {
  const { f, p, child } = await completedWithPendingAck(t), ownerFile = path.join(p.directory, 'owners', '1.json');
  const owner = read(ownerFile); owner.hostPid = 201; const bytes = JSON.stringify(owner); fs.writeFileSync(ownerFile, bytes);
  const controller = createRepairContinuationController({ ...f.opts, queryChild: query(child) });
  assert.equal((await controller.inspect({ version: 1, project: f.target })).ok, false);
  assert.equal(read(p.request).state, 'pending'); assert.equal(fs.readFileSync(ownerFile, 'utf8'), bytes); assert.equal(f.spawned(), 1);
});

for (const boundary of ['spawn-record', 'attempt-pid', 'old-owner-claim', 'new-owner-claim', 'current-pointer'])
  test(`an interrupted ${boundary} without complete active identity remains unknown and never spawns again`, async t => {
    const f = fixture(t); await f.prepare.ensure(f.source, f.request);
    const rootHas = file => typeof file === 'string' && file.startsWith(f.appData + path.sep);
    const action = () => f.continuation.resume(f.resume);
    if (boundary === 'spawn-record') await failOnce(native, 'writeNew', file => path.basename(file) === 'spawn.json', action);
    else if (boundary === 'attempt-pid') await failOnce(native, 'writeRecord', (file, data) => rootHas(file) && data.hostPid === 200 && path.basename(file) !== 'current.json', action);
    else if (boundary === 'current-pointer') await failOnce(native, 'writeRecord', (file, data) => path.basename(file) === 'current.json' && data.epoch === 1, action);
    else await failOnce(fs, 'linkSync', (_stage, file) => rootHas(file) && file.endsWith(path.join('owners', boundary === 'old-owner-claim' ? '0.json' : '1.json')), action);
    const result = await f.continuation.inspect({ version: 1, project: f.target });
    assert.equal(result.ok, false); assert.equal(result.code, 'PROJECT_REPAIR_ENVIRONMENT_STARTING');
    assert.equal(result.pendingResume.resumeRequestId, f.resume.resumeRequestId);
    await f.continuation.resume(f.resume);
    await f.continuation.resume({ ...f.resume, resumeRequestId: 'must-not-repeat-launch' });
    assert.equal(f.spawned(), 1);
  });

async function uncommittedAdoption(t) {
  const f = fixture(t); await f.controller.ensure(); const p = paths(f);
  const child = native.readRepairBootstrap(p.recordFile, { execPath: process.execPath, appPath: f.appPath, pid: 200 });
  child.complete({ project: f.target, ready: true });
  const options = { ...f.opts, pid: 101, processState: pid => pid === 100 ? false : true, queryChild: query(child) };
  await failOnce(native, 'writeRecord', (file, data) => path.basename(file) === 'current.json' && data.ownerHostPid === 101 && data.epoch === 2,
    () => createRepairContinuationController(options).resume({ ...f.resume, resumeRequestId: 'first-adoption-request' }), 'adoption-current');
  const claim = path.join(p.directory, 'owners', '2.json');
  assert.equal(read(claim).ownerHostPid, 101); assert.equal(read(p.current).epoch, 1);
  return { f, p, child, options, claim, bytes: fs.readFileSync(claim) };
}

test('a partial owner write stays outside the epoch namespace and another idle parent can resume without deleting it', async t => {
  const f = fixture(t); await f.controller.ensure(); const p = paths(f), before = sourceBytes(f);
  const child = native.readRepairBootstrap(p.recordFile, { execPath: process.execPath, appPath: f.appPath, pid: 200 });
  child.complete({ project: f.target, ready: true });
  const ownerDirectory = path.join(p.directory, 'owners'), claim = path.join(ownerDirectory, '2.json');
  const write = fs.writeFileSync; let partial;
  try {
    fs.writeFileSync = function (filename, bytes, ...args) {
      if (!partial && typeof filename === 'string' && path.dirname(filename) === ownerDirectory && path.basename(filename).startsWith('.2.json.')) {
        partial = filename; write(filename, Buffer.from(bytes).subarray(0, 12), ...args);
        throw Object.assign(new Error('Partial owner staging write'), { code: 'EIO' });
      }
      return write(filename, bytes, ...args);
    };
    const first = await createRepairContinuationController({ ...f.opts, pid: 101, processState: pid => pid !== 100,
      queryChild: query(child) }).resume({ ...f.resume, resumeRequestId: 'partial-stage-first-owner' });
    assert.equal(first.code, 'EIO'); assert.equal(fs.existsSync(claim), false); assert.equal(read(p.current).epoch, 1);
  } finally { fs.writeFileSync = write; }
  assert.ok(partial); const preserved = fs.readFileSync(partial);
  const result = await createRepairContinuationController({ ...f.opts, pid: 102, processState: pid => pid !== 100 && pid !== 101,
    queryChild: query(child) }).resume({ ...f.resume, resumeRequestId: 'partial-stage-next-owner' });
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.repairEnvironment.epoch, 2);
  assert.equal(result.repairEnvironment.parentHostPid, 102); assert.equal(result.repairEnvironment.hostPid, 200);
  assert.deepEqual(fs.readFileSync(partial), preserved); assert.deepEqual(sourceBytes(f), before); assert.equal(f.spawned(), 1);
});

for (const boundary of ['owner-reservation', 'current-pointer', 'request-receipt'])
  test(`authenticated adoption resumes the same nonce after an interrupted ${boundary}, preserving old claims and both sources`, async t => {
    const f = fixture(t); await f.controller.ensure(); const p = paths(f), before = sourceBytes(f);
    const child = native.readRepairBootstrap(p.recordFile, { execPath: process.execPath, appPath: f.appPath, pid: 200 });
    child.complete({ project: f.target, ready: true });
    const controller = createRepairContinuationController({ ...f.opts, pid: 101,
      processState: pid => pid === 100 ? false : true, queryChild: query(child) });
    const request = { ...f.resume, resumeRequestId: 'adoption-io-' + boundary };
    const claim = path.join(p.directory, 'owners', '2.json');
    if (boundary === 'owner-reservation') await failOnce(fs, 'linkSync', (_stage, filename) => filename === claim, () => controller.resume(request));
    else if (boundary === 'current-pointer') await failOnce(native, 'writeRecord', (filename, data) => filename === p.current && data.epoch === 2,
      () => controller.resume(request), 'adoption-current');
    else await failOnce(native, 'writeRecord', filename => filename.endsWith(request.resumeRequestId + '.json'), () => controller.resume(request), 'final-ack');
    const previousClaim = fs.existsSync(claim) ? fs.readFileSync(claim) : null;
    const recovered = await controller.resume(request);
    assert.equal(recovered.ok, true, JSON.stringify(recovered));
    assert.equal(recovered.repairEnvironment.parentHostPid, 101);
    assert.equal(recovered.repairEnvironment.epoch, boundary === 'current-pointer' ? 3 : 2);
    assert.equal(recovered.repairEnvironment.hostPid, 200); assert.equal(f.spawned(), 1);
    if (previousClaim) assert.deepEqual(fs.readFileSync(claim), previousClaim);
    assert.equal((await controller.resume(request)).ok, true);
    assert.equal((await controller.resume({ ...request, resumeRequestId: request.resumeRequestId + '-next' })).ok, true);
    assert.deepEqual(sourceBytes(f), before);
    assert.equal(recovered.recoveryContinuation.sourceGuardReleased, false);
    assert.equal(recovered.recoveryContinuation.originalWorkspaceRebound, false);
  });

for (const sameParent of [true, false]) test(`skips an uncommitted owner reservation after I/O recovery in ${sameParent ? 'the same parent' : 'a restarted parent'}`, async t => {
  const { f, p, child, options, claim, bytes } = await uncommittedAdoption(t), before = sourceBytes(f);
  const owner = sameParent ? 101 : 102;
  const controller = createRepairContinuationController({ ...options, pid: owner,
    processState: pid => pid === 100 || !sameParent && pid === 101 ? false : true });
  const request = { ...f.resume, resumeRequestId: sameParent ? 'same-parent-after-io' : 'new-parent-after-io' };
  const result = await controller.resume(request);
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.repairEnvironment.epoch, 3);
  assert.equal(result.repairEnvironment.parentHostPid, owner); assert.equal(result.repairEnvironment.hostPid, 200);
  assert.equal(child.identity(identity(result.repairEnvironment)).ok, true);
  assert.deepEqual(fs.readFileSync(claim), bytes); assert.equal(read(p.current).epoch, 3);
  assert.equal((await controller.resume(request)).ok, true);
  assert.equal((await controller.resume({ ...request, resumeRequestId: 'next-observation-request' })).ok, true);
  assert.equal(f.spawned(), 1); assert.deepEqual(sourceBytes(f), before);
});
for (const state of [true, 'unknown']) test(`an uncommitted reservation held by an ${state === true ? 'alive' : 'unconfirmed'} foreign parent remains protected`, async t => {
  const { f, p, options, claim, bytes } = await uncommittedAdoption(t);
  const controller = createRepairContinuationController({ ...options, pid: 102,
    processState: pid => pid === 100 ? false : pid === 101 ? state : true });
  const result = await controller.resume({ ...f.resume, resumeRequestId: 'foreign-claim-still-owned' });
  assert.equal(result.ok, false); assert.equal(read(p.current).epoch, 1);
  assert.deepEqual(fs.readFileSync(claim), bytes); assert.equal(f.spawned(), 1);
});
test('active project writers still prevent new owner adoption even when a prior claim is uncommitted', async t => {
  const { f, p, options, claim, bytes } = await uncommittedAdoption(t);
  const filename = path.join(f.target, '.aily', 'project-files.write.lock');
  const writer = JSON.stringify({ pid: 200, token: 'preserve-live-writer' }); fs.writeFileSync(filename, writer);
  const controller = createRepairContinuationController({ ...options, pid: 102, processState: pid => pid === 100 || pid === 101 ? false : true });
  const result = await controller.resume({ ...f.resume, resumeRequestId: 'claim-with-active-writer' });
  assert.equal(result.code, 'PROJECT_REPAIR_TARGET_BUSY'); assert.equal(read(p.current).epoch, 1);
  assert.equal(fs.readFileSync(filename, 'utf8'), writer); assert.deepEqual(fs.readFileSync(claim), bytes); assert.equal(f.spawned(), 1);
});

for (const state of [true, 'unknown']) test(`an orphan claim for a different ${state === true ? 'alive' : 'unconfirmed'} child cannot be skipped`, async t => {
  const { f, p, options, claim } = await uncommittedAdoption(t);
  const reserved = read(claim); reserved.hostPid = 201; reserved.environmentId = 'different-child-environment';
  fs.writeFileSync(claim, JSON.stringify(reserved)); const bytes = fs.readFileSync(claim);
  const controller = createRepairContinuationController({ ...options, pid: 102,
    processState: pid => pid === 100 || pid === 101 ? false : pid === 201 ? state : true });
  const result = await controller.resume({ ...f.resume, resumeRequestId: 'different-child-still-owned' });
  assert.equal(result.ok, false); assert.equal(read(p.current).epoch, 1);
  assert.deepEqual(fs.readFileSync(claim), bytes); assert.equal(f.spawned(), 1);
});

test('a same-caller orphan reservation still requires the actual child to be idle', async t => {
  const { f, p, child, options, claim, bytes } = await uncommittedAdoption(t);
  const controller = createRepairContinuationController({ ...options, queryChild: query(child, (value, operation) =>
    operation === 'project_repair_adoptable' ? { ...value, ownerStatus: { idle: false } } : value) });
  const result = await controller.resume({ ...f.resume, resumeRequestId: 'same-parent-child-still-busy' });
  assert.equal(result.ok, false); assert.equal(read(p.current).epoch, 1);
  assert.deepEqual(fs.readFileSync(claim), bytes); assert.equal(f.spawned(), 1);
});

test('a nested workspace handoff can settle its child ACK and survive a parent restart without altering either source', async t => {
  const f = fixture(t); await f.controller.ensure(); const source = paths(f);
  const sourceChild = native.readRepairBootstrap(source.recordFile, { execPath: process.execPath, appPath: f.appPath, pid: 200 });
  sourceChild.complete({ project: f.target, ready: true });
  const children = new Map([[200, sourceChild]]);
  const nativeQuery = async (record, _root, operation) => {
    const actual = children.get(record.hostPid)?.identity(identity(record));
    return actual?.ok ? { ...actual.repairEnvironment, ...(operation === 'project_repair_adoptable' ? { ownerStatus: { idle: true } } : {}) } : null;
  };
  let launched, launches = 0;
  const options = { ...f.opts, queryChild: nativeQuery, spawnChild: (_exe, _args, launch) => {
    launched = launch; launches++; return { pid: 303, once() {}, unref() {} };
  } };
  const controller = createRepairContinuationController(options);
  const sourceEnvironment = (await controller.inspect({ version: 1, project: f.target })).repairEnvironment;
  const project = path.join(f.root, 'nested-C'), text = '{"workspace":"saved-current-C"}', requestId = 'nested-ack-interruption';
  fs.mkdirSync(project); fs.writeFileSync(path.join(project, 'project.abi'), text); fs.writeFileSync(path.join(project, 'package.json'), '{"name":"nested"}');
  const store = require('../../electron/project-recovery-receipts').createProjectRecoveryReceipts(sourceChild.record.privateAppData);
  store.begin(f.target, requestId, '[]', hash(f.abi)); store.complete(f.target, requestId, '[]', {
    projectSaved: true, activated: false, project, sourceProject: f.target,
    recoverySource: { version: 1, kind: 'workspace', complete: true, loadFailed: false, partialCanvas: 'not-applicable' },
  }, hash(text));
  const handoff = await createRepairHandoffController({ continuation: controller, environments: f.prepare, pid: 100 }).prepare({
    version: 1, project, sourceProject: f.target, requestId, sourceEnvironment });
  assert.equal(handoff.ok, true, JSON.stringify(handoff));
  const request = { version: 1, project, sourceProject: f.target, requestId, resumeRequestId: 'nested-native-resume' };
  await failOnce(native, 'writeRecord', (file, data) => file.endsWith(request.resumeRequestId + '.json') && data.state === 'completed',
    () => controller.resume(request), 'final-ack');
  const child = native.readRepairBootstrap(launched.env.AILY_REPAIR_BOOTSTRAP, { execPath: process.execPath, appPath: f.appPath, pid: 303 });
  assert.equal(child.admission().nativePrimaryProof.abiHash, hash(text));
  children.set(303, child); child.complete({ project, ready: true });
  const restarted = createRepairContinuationController({ ...options, pid: 101, processState: pid => pid === 100 ? false : true });
  const result = await restarted.resume({ ...request, resumeRequestId: 'nested-restarted-parent' });
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.repairEnvironment.parentHostPid, 101);
  assert.equal(result.repairEnvironment.epoch, 2); assert.equal(result.repairEnvironment.hostPid, 303); assert.equal(launches, 1);
  assert.equal(fs.readFileSync(path.join(f.source, 'project.abi'), 'utf8'), f.abi);
  assert.equal(fs.readFileSync(path.join(f.target, 'project.abi'), 'utf8'), f.abi);
  assert.equal(fs.readFileSync(path.join(project, 'project.abi'), 'utf8'), text);
});
