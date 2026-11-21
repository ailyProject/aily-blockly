'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
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
