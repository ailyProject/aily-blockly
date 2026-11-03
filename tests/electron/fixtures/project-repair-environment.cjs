const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createProjectRecoveryReceipts } = require('../../../electron/project-recovery-receipts');
const { createRepairEnvironmentController } = require('../../../electron/project-repair-environment');
const { createRepairContinuationController } = require('../../../electron/project-repair-lineage');
const loadProjectViewLocks = require('./project-view-locks.cjs');
const hash = text => 'sha256:' + createHash('sha256').update(text).digest('hex');
const output = path.resolve(__dirname, '../../test-results/abs-recovery-next-20261026/native-repair');
fs.mkdirSync(output, { recursive: true });

module.exports = function fixture(t) {
  const root = fs.mkdtempSync(path.join(output, 'case-'));
  t.after(() => { if (!path.resolve(root).startsWith(output + path.sep)) throw new Error('Invalid test cleanup root'); fs.rmSync(root, { recursive: true, force: true }); });
  const source = path.join(root, 'source'), target = path.join(root, 'target'), appData = path.join(root, 'parent-data'), appPath = path.join(root, 'same-app');
  for (const dir of [source, target, appData, path.join(appPath, 'electron')]) fs.mkdirSync(dir, { recursive: true });
  for (const name of ['main.js', 'preload.js']) fs.writeFileSync(path.join(appPath, 'electron', name), 'same code');
  for (const relative of ['electron/project-repair-environment.js', 'electron/project-repair-lineage.js', 'electron/project-repair-commit.js',
    'electron/project-repair-normalization.js', 'electron/project-recovery-receipts.js', 'electron/project-repair-handoff.js', 'electron/project-repair-primary.js',
    'electron/project-file-access.js', 'electron/project-lock.js', 'electron/project-copy-admission.js', 'electron/project-copy-source.js', 'electron/child-script-path.js', 'child/scripts/native-file-lock.js',
    'child/scripts/build-workspace-lease.js', 'child/scripts/system-boot-id.js', 'child/scripts/process-state.js']) {
    const file = path.join(appPath, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'same protocol code');
  }
  fs.writeFileSync(path.join(appPath, 'package.json'), '{"main":"electron/main.js"}');
  const abi = JSON.stringify({ blocks: { blocks: [{ type: 'missing_block' }] } });
  for (const project of [source, target]) { fs.writeFileSync(path.join(project, 'project.abi'), abi); fs.writeFileSync(path.join(project, 'package.json'), '{"name":"fixture"}'); }
  fs.writeFileSync(path.join(source, 'project.abs'), Buffer.from([0xff, 0xfe, 0x41]));
  const archive = path.join(target, 'recovery-source-fixture.json');
  fs.writeFileSync(archive, JSON.stringify({ version: 1, sourceProject: source, files: { 'project.abi': abi }, partialCanvas: { captured: false } }));
  const store = createProjectRecoveryReceipts(appData), request = 'fixture-request-123';
  const result = { ok: true, sourceProject: source, project: target, projectSaved: true, activated: false, recoveryArchive: archive,
    activationBlocked: { reason: 'partial-canvas-unavailable' }, recoverySource: { version: 1, kind: 'saved-document', complete: true, loadFailed: true, partialCanvas: 'unavailable' } };
  store.begin(source, request, '[]', hash(abi)); store.complete(source, request, '[]', result, hash(abi));
  let spawned = 0, launch;
  const opts = { appDataPath: appData, appPath, execPath: process.execPath, pid: 100, serve: true,
    env: { AILY_DEV_RENDERER_URL: 'http://127.0.0.1:4205', AILY_NPM_PREFIX: path.join(appData, 'managed') },
    spawnChild: (exe, args, options) => { spawned++; launch = { exe, args, options }; return { pid: 200, once() {}, unref() {} }; },
    observeChild: async () => null, queryChild: async () => null, processState: pid => pid === 100 || pid === 200,
    sourceViewRetained: () => true, sourceRendererGeneration: () => 1, projectViewLocks: loadProjectViewLocks() };
  const prepare = createRepairEnvironmentController(opts), continuation = createRepairContinuationController(opts);
  const resume = { version: 1, project: target, sourceProject: source, requestId: request, resumeRequestId: 'fixture-resume-123' };
  let activation;
  const controller = { ensure: () => activation ??= (async () => {
    await prepare.ensure(source, request); const result = await continuation.resume(resume);
    assert.equal(result.code, 'PROJECT_REPAIR_ENVIRONMENT_STARTING', JSON.stringify(result)); return result.repairEnvironment;
  })() };
  return { root, source, target, abi, appData, appPath, request, opts, controller, prepare, continuation, resume,
    launch: () => launch, spawned: () => spawned };
};
