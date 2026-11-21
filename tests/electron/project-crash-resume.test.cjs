'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createProjectCrashResume } = require('../../electron/project-crash-resume');
const { rootAttachment } = require('../../electron/project-file-lock-owner');

const root = path.resolve(__dirname, '../test-results', `project-crash-resume-${randomUUID()}`);
fs.mkdirSync(root, { recursive: true });
const boot = 'win32:11111111-1111-4111-8111-111111111111';
const otherBoot = 'win32:22222222-2222-4222-8222-222222222222';
const owner = (pid = 41001, instanceId = randomUUID()) => ({ version: 1, hostPid: pid, storagePid: pid,
  instanceId, processIdentity: `win32:${pid}`, bootId: boot });

function fixture(name) {
  const folder = path.join(root, name), stateDirectory = path.join(folder, 'appdata'), project = path.join(folder, 'project');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'project.abi'), '{"fullDocument":"untouched"}');
  const warnings = [];
  const make = (executor = owner(), extra = {}) => createProjectCrashResume({
    stateDirectory, profileKey: path.join(folder, 'chromium-profile'), executor,
    processState: () => false, processIdentity: pid => `win32:${pid}`, bootId: () => boot,
    onWarning: value => warnings.push(value), ...extra,
  });
  return { folder, stateDirectory, project, warnings, make };
}

function createClaim(sourceProject = null) {
  return { createRequest: { version: 1, requestId: randomUUID(), rendererGeneration: 7, deadlineAt: Date.now() + 300_000 },
    recoverySessionId: '01a1f768-6bb5-703d-9496-344d2845159f', originalInstanceId: randomUUID(), sourceProject };
}

test('the original create follows exact automatic restore across two ownership changes and is retired on project switch', () => {
  const f = fixture('create-exact-restore'), original = owner(), first = f.make(original);
  const source = path.join(f.folder, 'source'), other = path.join(f.folder, 'other');
  fs.mkdirSync(source); fs.mkdirSync(other);
  const creation = createClaim(source), attachment = rootAttachment(fs.realpathSync(f.project));
  assert.equal(first.record(source).ok, true);
  const recorded = first.record(f.project, { creation, createdAttachment: attachment });
  assert.equal(recorded.ok, true); assert.equal(recorded.recoverySessionId, undefined, 'live creation does not suggest a startup session');
  const secondOwner = owner(41002);
  const live = f.make(secondOwner, { processState: () => true });
  assert.equal(live.interruptedProject().reason, 'owner-active');
  assert.equal(live.observeCreation(f.project, creation).project, null);
  assert.equal(live.record(f.project).ok, false);

  const second = f.make(secondOwner), restore = second.interruptedProject();
  assert.deepEqual(restore.creation, creation);
  assert.equal(second.observeCreation(f.project, creation).project, null, 'project must first be activated by the restarted owner');
  assert.equal(second.record(f.project, { restore }).recoverySessionId, creation.recoverySessionId);
  assert.deepEqual(second.observeCreation(f.project, creation).attachment, attachment);
  assert.equal(second.record(f.project).recoverySessionId, undefined, 'same-owner navigation does not reissue the startup selection');

  const third = f.make(owner(41003)), again = third.interruptedProject();
  assert.deepEqual(again.creation, creation);
  assert.equal(third.record(f.project, { restore: again }).recoverySessionId, creation.recoverySessionId);
  for (const different of [{ ...creation, recoverySessionId: randomUUID() }, { ...creation, originalInstanceId: randomUUID() },
    { ...creation, createRequest: { ...creation.createRequest, rendererGeneration: 8 } },
    { ...creation, createRequest: { ...creation.createRequest, deadlineAt: creation.createRequest.deadlineAt + 1 } }]) {
    assert.equal(third.observeCreation(f.project, different).project, null);
  }
  const otherProfile = f.make(owner(41004), { profileKey: 'other-desktop-profile' });
  assert.equal(otherProfile.observeCreation(f.project, creation).project, null);
  assert.equal(third.record(other).ok, true);
  assert.equal(third.record(f.project).ok, true);
  assert.equal(third.observeCreation(f.project, creation).project, null, 'ordinary navigation cannot revive a retired create receipt');
});

test('a same-path replacement or explicit startup cannot acquire the original create proof', () => {
  const f = fixture('create-replacement'), original = owner(), first = f.make(original);
  const creation = createClaim(), attachment = rootAttachment(fs.realpathSync(f.project));
  assert.equal(first.record(f.project, { creation, createdAttachment: attachment }).ok, true);
  const second = f.make(owner(41002)), restore = second.interruptedProject();
  assert.deepEqual(restore.creation, creation);
  const archived = path.join(f.folder, 'original');
  fs.renameSync(f.project, archived); fs.mkdirSync(f.project);
  fs.copyFileSync(path.join(archived, 'project.abi'), path.join(f.project, 'project.abi'));
  assert.equal(first.observeCreation(f.project, creation).reason, 'attachment-mismatch');
  assert.equal(first.record(f.project, { creation, createdAttachment: attachment }).ok, false);
  assert.equal(second.record(f.project, { restore }).recoverySessionId, undefined);
  assert.equal(second.observeCreation(f.project, creation).project, null);

  const explicit = fixture('create-explicit-reopen'), starting = explicit.make(owner());
  assert.equal(starting.record(explicit.project, { creation, createdAttachment: rootAttachment(fs.realpathSync(explicit.project)) }).ok, true);
  const manuallyOpened = explicit.make(owner(41002));
  assert.equal(manuallyOpened.record(explicit.project).recoverySessionId, undefined);
  assert.equal(manuallyOpened.observeCreation(explicit.project, creation).project, null);
});

test('acknowledging one exact creation removes only its session hint and retains crash navigation', () => {
  const f = fixture('create-acknowledge'), first = f.make(owner());
  const other = path.join(f.folder, 'next-project'); fs.mkdirSync(other);
  const creation = createClaim(), next = createClaim(f.project);
  assert.equal(first.record(f.project, { creation, createdAttachment: rootAttachment(fs.realpathSync(f.project)) }).ok, true);
  assert.equal(first.record(other, { creation: next, createdAttachment: rootAttachment(fs.realpathSync(other)) }).ok, true);
  assert.equal(first.acknowledgeCreation(f.project, creation).acknowledged, false);
  assert.equal(first.acknowledgeCreation(other, creation).acknowledged, false);
  assert.deepEqual(first.observeCreation(other, next).creation, next);
  assert.equal(first.acknowledgeCreation(other, next).acknowledged, true);
  assert.equal(first.acknowledgeCreation(other, next).acknowledged, false);
  assert.equal(first.observeCreation(other, next).project, null);
  const later = f.make(owner(41002)).interruptedProject();
  assert.equal(later.project, fs.realpathSync(other));
  assert.equal(later.creation, undefined);
});

test('no previous record is inert; an exact interrupted project is returned without opening or changing it', () => {
  const f = fixture('interrupted'), first = f.make(owner());
  assert.equal(first.interruptedProject().project, null);
  assert.equal(fs.existsSync(f.stateDirectory), false, 'legacy startup does not create navigation storage');
  assert.equal(first.record(f.project).ok, true);
  const before = fs.readFileSync(path.join(f.project, 'project.abi'));
  const resumed = f.make(owner(41002)).interruptedProject();
  assert.equal(resumed.project, fs.realpathSync(f.project));
  assert.equal(resumed.executor.hostPid, 41001);
  assert.equal(resumed.attachment.identity.ino, String(fs.statSync(f.project, { bigint: true }).ino));
  assert.deepEqual(fs.readFileSync(path.join(f.project, 'project.abi')), before);
  assert.deepEqual(fs.readdirSync(f.project), ['project.abi'], 'navigation does not write a baseline, candidate or project clone');
});

test('live, denied and unverified owners never auto-resume; PID reuse and a changed boot are distinguished', () => {
  const f = fixture('owner-status'), old = owner(); assert.equal(f.make(old).record(f.project).ok, true);
  for (const [state, identity] of [[true, old.processIdentity], ['unknown', old.processIdentity], [true, null]]) {
    const result = f.make(owner(41002), { processState: () => state, processIdentity: () => identity }).interruptedProject();
    assert.equal(result.project, null);
  }
  const reused = f.make(owner(41002), { processState: () => true, processIdentity: () => 'win32:999999' }).interruptedProject();
  assert.equal(reused.project, fs.realpathSync(f.project));
  const rebooted = f.make(owner(41002), { processState: () => true, bootId: () => otherBoot }).interruptedProject();
  assert.equal(rebooted.project, fs.realpathSync(f.project));
});

test('copying old project bytes back to the same path does not preserve physical attachment', () => {
  const f = fixture('replacement'); assert.equal(f.make().record(f.project).ok, true);
  const archived = path.join(f.folder, 'original-project');
  fs.renameSync(f.project, archived); fs.mkdirSync(f.project);
  fs.copyFileSync(path.join(archived, 'project.abi'), path.join(f.project, 'project.abi'));
  const result = f.make(owner(41002)).interruptedProject();
  assert.equal(result.project, null); assert.equal(result.reason, 'attachment-mismatch');
  assert.deepEqual(fs.readFileSync(path.join(archived, 'project.abi')), fs.readFileSync(path.join(f.project, 'project.abi')));
});

test('restarted navigation reads the original terminal separately from the active view', () => {
  const f = fixture('navigation-durable'), original = owner(), first = f.make(original);
  const destination = path.join(f.folder, 'destination'); fs.mkdirSync(destination);
  const reference = { version: 1, originalTargetPid: original.hostPid, originalInstanceId: original.instanceId,
    sessionId: randomUUID(), navigationRequest: { version: 1, requestId: randomUUID(),
      rendererGeneration: 7, deadlineAt: Date.now() + 300_000, operation: 'project_open',
      sourceProject: f.project, targetProject: destination } };
  assert.equal(first.record(f.project).ok, true);
  assert.equal(first.record(destination).ok, true);
  const attachment = rootAttachment(destination);
  assert.equal(first.recordNavigation(reference, { state: 'open', project: destination, attachment },
    rootAttachment(f.project)).ok, true);
  assert.equal(first.finishNavigation(reference, { ok: true, project: destination, projectType: 'blockly' }).ok, true);
  const next = f.make(owner(41002)), restore = next.interruptedProject();
  assert.equal(restore.project, destination);
  assert.equal(next.record(destination, { restore }).recoverySessionId, reference.sessionId);
  const recovered = next.observeNavigation(destination, reference);
  assert.equal(recovered.result.ok, true);
  assert.equal(recovered.navigationReceipt.state, 'completed');
  assert.equal(recovered.activationCurrent, true);
  assert.equal(next.observeNavigation(destination, { ...reference, sessionId: randomUUID() }).navigationReceipt, undefined);
  assert.ok(recovered.activationViewId);
  next.record(f.project);
  next.record(destination);
  const superseded = next.observeNavigation(destination, reference);
  assert.equal(superseded.result.ok, true);
  assert.equal(superseded.navigationReceipt.state, 'completed');
  assert.equal(superseded.activationCurrent, false);
});

test('a cold empty view only reopens the exact closed physical source from the original session', () => {
  const f = fixture('navigation-durable-close'), original = owner(), first = f.make(original);
  const reference = { version: 1, originalTargetPid: original.hostPid, originalInstanceId: original.instanceId,
    sessionId: randomUUID(), navigationRequest: { version: 1, requestId: randomUUID(),
      rendererGeneration: 7, deadlineAt: Date.now() + 300_000, operation: 'project_close',
      sourceProject: f.project, targetProject: null } };
  assert.equal(first.record(f.project).ok, true);
  const attachment = rootAttachment(f.project);
  assert.equal(first.clear(f.project).cleared, true);
  assert.equal(first.recordNavigation(reference, { state: 'closed', project: null }, attachment).ok, true);
  assert.equal(first.finishNavigation(reference, { ok: true, project: null }).ok, true);
  first.suspend();
  const next = f.make(owner(41002));
  assert.equal(next.interruptedProject().project, null);
  assert.deepEqual(next.closedSessionHint(), { project: attachment.root, sessionId: reference.sessionId });
  const observed = next.observeNavigation(null, reference);
  assert.equal(observed.activationCurrent, true);
  assert.equal(observed.navigationReceipt.state, 'completed');
  assert.equal(next.canReopenFrom(reference, f.project), true);
  assert.equal(next.canReopenFrom({ ...reference, originalInstanceId: randomUUID() }, f.project), false);
  fs.renameSync(f.project, path.join(f.folder, 'different'));
  fs.mkdirSync(f.project);
  assert.equal(next.canReopenFrom(reference, f.project), false);
  assert.equal(next.closedSessionHint(), null);
});

function interruptedOpen(name) {
  const f = fixture(name), original = owner(), first = f.make(original);
  const destination = path.join(f.folder, 'destination'); fs.mkdirSync(destination);
  const reference = { version: 1, originalTargetPid: original.hostPid, originalInstanceId: original.instanceId,
    sessionId: randomUUID(), navigationRequest: { version: 1, requestId: randomUUID(),
      rendererGeneration: 7, deadlineAt: Date.now() + 300_000, operation: 'project_open',
      sourceProject: f.project, targetProject: destination } };
  assert.equal(first.record(f.project).ok, true);
  assert.equal(first.recordNavigation(reference, null, rootAttachment(f.project)).ok, true);
  assert.equal(first.record(destination).ok, true);
  assert.equal(first.recordNavigation(reference, { state: 'open', project: destination, attachment: rootAttachment(destination) },
    rootAttachment(f.project)).ok, true);
  const next = f.make(owner(41002));
  const restore = next.interruptedProject();
  assert.equal(next.record(destination, { restore }).recoverySessionId, reference.sessionId);
  return { f, next, reference, destination };
}

test('closing an unfinished restart activation retains only its original session source', async () => {
  const { f, next, reference, destination } = interruptedOpen('close-unfinished-restart');
  const recovered = next.observeNavigation(destination, reference);
  assert.equal(recovered.activationDisposition, 'current');
  assert.equal(recovered.navigationReceipt.state, 'pending');
  assert.equal(next.clear(destination, { retainInterruptedSource: true }).cleared, true);
  const observation = next.observeNavigation(null, reference);
  assert.equal(observation.activationDisposition, 'superseded');
  assert.equal(observation.navigationReceipt.state, 'pending', 'manual close cannot decide the old tool result');
  assert.equal(observation.result, undefined);
  assert.deepEqual(observation.resumeSource, { project: f.project });
  assert.equal(next.canReopenFrom(reference, f.project), true);
  assert.equal(next.canReopenFrom(reference, destination), false);
  assert.equal(next.canReopenFrom({ ...reference, sessionId: randomUUID() }, f.project), false);
  assert.deepEqual(next.closedSessionHint(), { project: f.project, sessionId: reference.sessionId });
  const restarted = f.make(owner(41003));
  assert.equal(restarted.interruptedProject().project, null, 'the user closed the canvas and did not request a replay');
  assert.equal(restarted.canReopenFrom(reference, f.project), true);
  const reader = await restarted.observeClosedWorkspaceProtocol(f.project, reference, () => 3,
    async project => ({ ok: true, project, protocol: { workspaceMode: 'project-v1' } }));
  assert.equal(reader.ok, true);
  assert.equal(restarted.record(destination).ok, true);
  assert.equal(restarted.clear(destination, { retainInterruptedSource: true }).cleared, true);
  assert.equal(restarted.observeNavigation(null, reference).resumeSource, undefined);
  assert.equal(restarted.closedSessionHint(), null);
  assert.equal(restarted.canReopenFrom(reference, f.project), false);
});

test('a new project supersedes unfinished activation and cannot inherit the original source', () => {
  const { f, next, reference, destination } = interruptedOpen('switch-unfinished-restart');
  const selected = path.join(f.folder, 'selected'); fs.mkdirSync(selected);
  assert.equal(next.record(selected).ok, true);
  const historical = next.observeNavigation(selected, reference);
  assert.equal(historical.activationDisposition, 'superseded');
  assert.equal(historical.navigationReceipt.state, 'pending');
  assert.equal(historical.resumeSource, undefined);
  const repeated = next.observeNavigation(destination, reference);
  assert.equal(repeated.activationDisposition, 'superseded', 'a different reader view cannot undo retirement');
  assert.equal(repeated.activationCurrent, false);
  assert.equal(next.canReopenFrom(reference, f.project), false);
});

test('the original interrupted source survives switch and close without reusing the old activation', () => {
  const { f, next, reference, destination } = interruptedOpen('switch-close-unfinished-restart');
  const selected = path.join(f.folder, 'selected'); fs.mkdirSync(selected);
  const draft = path.join(f.project, 'project.abs');
  fs.writeFileSync(draft, 'retained exact draft');
  assert.equal(next.record(selected).ok, true);
  assert.equal(next.observeNavigation(selected, reference).resumeSource, undefined);
  assert.equal(next.clear(selected, { retainInterruptedSource: true }).cleared, true);
  const blank = next.observeNavigation(null, reference);
  assert.equal(blank.activationDisposition, 'superseded');
  assert.equal(blank.activationCurrent, false);
  assert.deepEqual(blank.writerDisposition, { version: 1, state: 'retired', reason: 'activation-superseded' });
  assert.equal(blank.navigationReceipt.state, 'pending');
  assert.equal(blank.result, undefined);
  assert.deepEqual(blank.resumeSource, { project: f.project });
  assert.deepEqual(next.closedSessionHint(), { project: f.project, sessionId: reference.sessionId });
  const latest = f.make(owner(41003));
  assert.equal(latest.canReopenFrom(reference, f.project), true);
  assert.equal(latest.canReopenFrom(reference, destination), false);
  assert.equal(latest.canReopenFrom({ ...reference, sessionId: randomUUID() }, f.project), false);
  assert.equal(latest.record(selected).ok, true);
  assert.equal(latest.clear(selected, { retainInterruptedSource: true }).cleared, true);
  const historical = latest.observeNavigation(null, reference);
  assert.deepEqual(historical.writerDisposition, blank.writerDisposition);
  assert.equal(historical.activationDisposition, 'superseded');
  assert.equal(historical.resumeSource, undefined, 'leaving the retained blank view must not recreate its authority');
  assert.equal(fs.readFileSync(draft, 'utf8'), 'retained exact draft');
});

test('an original navigation without activation retires independently when its executor exits', () => {
  const f = fixture('intent-executor-exit'), original = owner(), first = f.make(original);
  const targetProject = path.join(f.folder, 'destination'); fs.mkdirSync(targetProject);
  const reference = { version: 1, originalTargetPid: original.hostPid, originalInstanceId: original.instanceId,
    sessionId: randomUUID(), navigationRequest: { version: 1, requestId: randomUUID(),
      rendererGeneration: 7, deadlineAt: Date.now() + 300_000, operation: 'project_open',
      sourceProject: f.project, targetProject } };
  assert.equal(first.record(f.project).ok, true);
  assert.equal(first.recordNavigation(reference, null, rootAttachment(f.project)).ok, true);
  const olderLive = f.make(owner(41002), { processState: () => true });
  assert.equal(olderLive.observeNavigation(f.project, reference).writerDisposition, undefined);
  const next = f.make(owner(41002));
  const exited = next.observeNavigation(f.project, reference);
  assert.equal(exited.navigationReceipt.state, 'pending');
  assert.equal(exited.navigationReceipt.activation, undefined);
  assert.equal(exited.result, undefined);
  assert.deepEqual(exited.writerDisposition, { version: 1, state: 'retired', reason: 'executor-exited' });
  assert.equal(next.observeNavigation(null, { ...reference, sessionId: randomUUID() }).writerDisposition, undefined);
  assert.deepEqual(olderLive.observeNavigation(f.project, reference).writerDisposition, exited.writerDisposition,
    'a previously proven exit must survive future process observation changes');
  assert.equal(next.record(targetProject).ok, true);
  assert.equal(next.clear(targetProject, { retainInterruptedSource: true }).cleared, true);
  assert.equal(next.observeNavigation(null, reference).activationDisposition, 'unconfirmed');
  assert.deepEqual(next.observeNavigation(null, reference).resumeSource, { project: f.project });
  assert.equal(next.canReopenFrom(reference, f.project), true);
});

test('a legacy navigation intent retires when its original PID is positively absent', () => {
  const f = fixture('legacy-intent-executor-exit'), original = owner(), first = f.make(original);
  const targetProject = path.join(f.folder, 'destination'); fs.mkdirSync(targetProject);
  const requestId = randomUUID(), reference = { version: 1, originalTargetPid: original.hostPid,
    originalInstanceId: original.instanceId, sessionId: randomUUID(), navigationRequest: { version: 1, requestId,
      rendererGeneration: 7, deadlineAt: Date.now() + 300_000, operation: 'project_open',
      sourceProject: f.project, targetProject } };
  assert.equal(first.record(f.project).ok, true);
  assert.equal(first.recordNavigation(reference, null, rootAttachment(f.project)).ok, true);
  const profiles = path.join(f.stateDirectory, 'project-crash-resume');
  const file = path.join(profiles, fs.readdirSync(profiles)[0], `navigation-${requestId}.json`);
  const { executor: _newFormat, checksum: _hash, ...legacy } = JSON.parse(fs.readFileSync(file));
  const ordered = JSON.stringify(legacy, (_key, value) => value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : value);
  fs.writeFileSync(file, JSON.stringify({ ...legacy, checksum: createHash('sha256').update(ordered).digest('hex') }));
  const reused = f.make(owner(41002), { processState: () => true, processIdentity: () => 'win32:99999' });
  assert.equal(reused.observeNavigation(f.project, reference).writerDisposition, undefined);
  const absent = f.make(owner(41002)).observeNavigation(f.project, reference);
  assert.equal(absent.navigationReceipt.state, 'pending');
  assert.deepEqual(absent.writerDisposition, { version: 1, state: 'retired', reason: 'executor-exited' });
  assert.equal(absent.resumeSource, undefined);
});

test('a completed creation remains observable after the active cursor is cleared or replaced', () => {
  const f = fixture('create-observe-after-close'), original = owner(), first = f.make(original);
  const creation = createClaim();
  assert.equal(first.record(f.project, { creation, createdAttachment: rootAttachment(f.project) }).ok, true);
  assert.equal(first.clear(f.project).cleared, true);
  first.suspend();
  const next = f.make(owner(41002));
  const historical = next.observeOriginalCreation(null, creation);
  assert.equal(historical.project, f.project);
  assert.equal(historical.activationCurrent, false);
  assert.equal(next.observeOriginalCreation(null, { ...creation, recoverySessionId: randomUUID() }).project, null);
  const newIdentity = path.join(f.folder, 'former'); fs.renameSync(f.project, newIdentity); fs.mkdirSync(f.project);
  assert.equal(next.observeOriginalCreation(null, creation).project, null);
});

test('the current empty view grants only its original closed workspace a read-only mode observation', async () => {
  const f = fixture('navigation-closed-mode'), original = owner(), first = f.make(original);
  const reference = { version: 1, originalTargetPid: original.hostPid, originalInstanceId: original.instanceId,
    sessionId: randomUUID(), navigationRequest: { version: 1, requestId: randomUUID(),
      rendererGeneration: 7, deadlineAt: Date.now() + 300_000, operation: 'project_close',
      sourceProject: f.project, targetProject: null } };
  first.record(f.project);
  first.clear(f.project);
  first.recordNavigation(reference, { state: 'closed', project: null }, rootAttachment(f.project));
  first.finishNavigation(reference, { ok: true, project: null });
  first.suspend();
  const next = f.make(owner(41002));
  let blankGeneration = 3, reads = 0;
  const currentView = () => blankGeneration;
  const protocol = { workspaceMode: 'project-v1' };
  const read = async project => { assert.equal(project, f.project); reads++; return { ok: true, project, protocol }; };
  const inspect = (ref = reference, scope = f.project, reader = read) =>
    next.observeClosedWorkspaceProtocol(scope, ref, currentView, reader);
  assert.equal((await inspect({ ...reference, sessionId: randomUUID() })).ok, false);
  assert.equal((await inspect(reference, f.folder)).ok, false);
  assert.equal(reads, 0);
  const confirmed = await inspect();
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.rendererGeneration, 3);
  assert.equal(confirmed.navigationRecovery.sessionId, reference.sessionId);
  assert.equal(confirmed.activationCurrent, undefined);
  assert.deepEqual(confirmed.protocol, protocol);
  assert.equal((await inspect(reference, f.project, async project => {
    const result = await read(project);
    blankGeneration = 4;
    return result;
  })).ok, false);
  assert.equal((await inspect(reference, f.project, async project => {
    const result = await read(project);
    fs.renameSync(f.project, path.join(f.folder, 'replaced'));
    fs.mkdirSync(f.project);
    return result;
  })).ok, false);
  assert.equal(reads, 3);
});

test('profile buckets are independent; only the exact recording owner can clear its matching project', () => {
  const f = fixture('profile-clear'), original = owner(), a = f.make(original);
  assert.equal(a.record(f.project).ok, true);
  const otherProfile = f.make(owner(41002), { profileKey: 'unrelated-profile' });
  assert.equal(otherProfile.interruptedProject().project, null);
  assert.equal(otherProfile.clear().cleared, false);
  assert.equal(f.make(owner(41002)).clear(f.project).cleared, false, 'new observer cannot erase a prior owner record');
  assert.equal(a.clear(path.join(f.folder, 'another-project')).cleared, false);
  assert.equal(a.clear(f.project).cleared, true);
  assert.equal(f.make(owner(41002)).interruptedProject().project, null);
});

test('recording the same active physical root and exact owner is idempotent without replacing its record', () => {
  const f = fixture('idempotent'), current = f.make(owner());
  assert.equal(current.record(f.project).recorded, true);
  const buckets = path.join(f.stateDirectory, 'project-crash-resume');
  const metadata = path.join(buckets, fs.readdirSync(buckets)[0], 'active.json');
  const bytes = fs.readFileSync(metadata), before = fs.statSync(metadata, { bigint: true });
  const again = current.record(f.project), after = fs.statSync(metadata, { bigint: true });
  assert.equal(again.ok, true); assert.equal(again.recorded, false); assert.equal(again.reason, 'unchanged');
  assert.deepEqual(fs.readFileSync(metadata), bytes);
  assert.equal(after.ino, before.ino); assert.equal(after.mtimeNs, before.mtimeNs);
});

test('late old-owner clear cannot delete a newly recorded owner and a live foreign owner is not overwritten', () => {
  const f = fixture('late-clear'), original = owner(), old = f.make(original);
  assert.equal(old.record(f.project).ok, true);
  const newOwner = f.make(owner(41002), { processState: () => true, processIdentity: () => original.processIdentity });
  assert.equal(newOwner.record(f.project).ok, false);
  const current = f.make(owner(41002)); assert.equal(current.record(f.project).ok, true);
  assert.equal(old.clear().cleared, false);
  assert.equal(f.make(owner(41003)).interruptedProject().executor.hostPid, 41002);
});

test('atomic write failure retains the previous valid navigation record and reports a warning', () => {
  const f = fixture('write-failure'), original = owner(), first = f.make(original);
  assert.equal(first.record(f.project).ok, true);
  const nextProject = path.join(f.folder, 'next-project'); fs.mkdirSync(nextProject);
  const failing = f.make(original, { files: { ...fs, renameSync() { throw Object.assign(new Error('controlled EIO'), { code: 'EIO' }); } } });
  const failed = failing.record(nextProject);
  assert.equal(failed.ok, false); assert.ok(f.warnings.length > 0);
  assert.equal(f.make(owner(41002)).interruptedProject().project, fs.realpathSync(f.project));
});

test('metadata replacement/corruption and a linked project root do not authorize auto-navigation', () => {
  const f = fixture('unsafe'), controller = f.make(); assert.equal(controller.record(f.project).ok, true);
  const metadata = fs.readdirSync(path.join(f.stateDirectory, 'project-crash-resume')).map(name =>
    path.join(f.stateDirectory, 'project-crash-resume', name, 'active.json'))[0];
  fs.writeFileSync(metadata, '{"version":1,"project":"/forged"}');
  assert.equal(f.make(owner(41002)).interruptedProject().project, null);
  assert.ok(f.warnings.length > 0);
  const clean = fixture('linked'), link = path.join(clean.folder, 'project-alias');
  fs.symlinkSync(clean.project, link, process.platform === 'win32' ? 'junction' : 'dir');
  const linked = clean.make().record(link);
  assert.equal(linked.ok, false, 'a caller must identify the physical project, not silently grant a linked attachment');
});

test('a genuinely killed recording Node leaves the exact create for the next main executor to adopt', async t => {
  const f = fixture('real-kill'), modulePath = require.resolve('../../electron/project-crash-resume');
  const creation = createClaim(), attachment = rootAttachment(fs.realpathSync(f.project));
  const child = spawn(process.execPath, ['-e', `const api=require(process.argv[1]);
    const controller=api.createProjectCrashResume({stateDirectory:process.argv[2],profileKey:process.argv[3]});
    const result=controller.record(process.argv[4],JSON.parse(process.argv[5]));if(!result.ok)throw Error(JSON.stringify(result));
    process.send({recorded:true});setInterval(()=>{},1000);`, modulePath, f.stateDirectory,
    path.join(f.folder, 'chromium-profile'), f.project, JSON.stringify({ creation, createdAttachment: attachment })],
  { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr.on('data', value => { stderr += value; });
  const exit = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exit; });
  const ready = await Promise.race([
    once(child, 'message').then(([value]) => value),
    exit.then(([code]) => { throw new Error(`recording child exited ${code}: ${stderr}`); }),
  ]);
  assert.equal(ready.recorded, true);
  child.kill('SIGKILL'); await exit;
  const observer = createProjectCrashResume({ stateDirectory: f.stateDirectory, profileKey: path.join(f.folder, 'chromium-profile') });
  const resumed = observer.interruptedProject();
  assert.equal(resumed.project, fs.realpathSync(f.project));
  assert.equal(resumed.executor.hostPid, child.pid);
  assert.deepEqual(resumed.creation, creation);
  assert.equal(observer.clear().cleared, false, 'the observer has not yet acquired/recorded this project');
  assert.equal(observer.record(f.project, { restore: resumed }).recoverySessionId, creation.recoverySessionId);
  assert.deepEqual(observer.observeCreation(f.project, creation).attachment, attachment);
  assert.deepEqual(fs.readdirSync(f.project), ['project.abi']);
});

process.on('exit', () => console.log(`Project crash navigation artifacts: ${root}`));
