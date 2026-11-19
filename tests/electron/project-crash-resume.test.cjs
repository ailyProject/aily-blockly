'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createProjectCrashResume } = require('../../electron/project-crash-resume');

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

test('a genuinely killed recording Node leaves only navigation metadata and the next process can select the exact project', async t => {
  const f = fixture('real-kill'), modulePath = require.resolve('../../electron/project-crash-resume');
  const child = spawn(process.execPath, ['-e', `const api=require(process.argv[1]);
    const controller=api.createProjectCrashResume({stateDirectory:process.argv[2],profileKey:process.argv[3]});
    const result=controller.record(process.argv[4]);if(!result.ok)throw Error(JSON.stringify(result));
    process.send({recorded:true});setInterval(()=>{},1000);`, modulePath, f.stateDirectory,
    path.join(f.folder, 'chromium-profile'), f.project], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
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
  assert.equal(observer.clear().cleared, false, 'the observer has not yet acquired/recorded this project');
});

process.on('exit', () => console.log(`Project crash navigation artifacts: ${root}`));
