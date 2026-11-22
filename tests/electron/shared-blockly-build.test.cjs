'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork, spawn } = require('node:child_process');
const { once } = require('node:events');
const test = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { withSharedBuildAdmission } = require('../../electron/shared-blockly-build');
const { spawnManagedBuild } = require('../../electron/owned-process');
const execution = require('../../child/scripts/build-execution-workspace');
const { createBuildWorkspaceSupervisor, acquireBuildWorkspace } = require('../../child/scripts/build-workspace-lease');

const boardModule = '@aily-project/board-shared-test';
const writeJson = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
const readJson = file => JSON.parse(fs.readFileSync(file));
const compileConfig = (project, requestId) => ({
  currentProjectPath: project, boardModule, buildRequestId: requestId, code: 'void setup() {}\nvoid loop() {}',
});

async function until(check) {
  const deadline = Date.now() + 15000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Managed build fixture did not reach the expected boundary.');
    await delay(20);
  }
}

const [mode, project, configPath] = process.argv.slice(2);
if (mode === 'old-host') {
  const original = execution.validateSharedBuildLaunch(configPath, project, 'compile');
  withSharedBuildAdmission(project, { operation: 'compile' }, admission => {
    const supervisor = createBuildWorkspaceSupervisor(project);
    const child = spawnManagedBuild(process.execPath, [__filename, 'compiler', project, configPath], {
      cwd: project, windowsHide: true, stdio: 'ignore', env: { ...process.env, ...supervisor.environment },
    }, admission.bind(supervisor.environment.AILY_BUILD_WORKSPACE_SUPERVISOR, 'original-stream', original.execution));
    child.on('exit', code => { process.exitCode = code ?? 1; });
  }).catch(error => { console.error(error); process.exitCode = 1; });
} else if (mode === 'compiler') {
  const original = execution.validateSharedBuildLaunch(configPath, project, 'compile');
  const lease = acquireBuildWorkspace(project, 'compile');
  execution.startBuildExecution(original, lease);
  lease.markDelegated();
  const leaf = spawn(process.execPath, [__filename, 'descendant', project], { detached: true, windowsHide: true, stdio: 'ignore' });
  leaf.unref();
  writeJson(path.join(project, '.build', 'parent-ready.json'), { pid: process.pid });
  setInterval(() => {}, 1000);
} else if (mode === 'descendant') {
  writeJson(path.join(project, '.build', 'descendant-ready.json'), { pid: process.pid });
  setInterval(() => fs.appendFileSync(path.join(project, '.build', 'old-writes'), 'old\n'), 15);
} else {
  test('a restarted host retires the exact managed tree before a new request can reuse or clear the real .build', {
    skip: process.platform !== 'win32' || process.arch !== 'x64', timeout: 35000,
  }, async () => {
    const temp = fs.realpathSync(os.tmpdir());
    const owned = fs.realpathSync(fs.mkdtempSync(path.join(temp, 'aily-shared-build-')));
    const appData = path.join(owned, 'app-data'), project = path.join(owned, 'fixture');
    const priorAppData = process.env.AILY_APPDATA_PATH;
    fs.mkdirSync(appData);
    process.env.AILY_APPDATA_PATH = appData;
    let originalHost, exited;
    try {
      writeJson(path.join(project, 'package.json'), { type: 'blockly', dependencies: { [boardModule]: '1' } });
      writeJson(path.join(project, 'node_modules', boardModule, 'package.json'), { name: boardModule });
      writeJson(path.join(project, 'node_modules', boardModule, 'board.json'), { compilerParam: '-b test:test:test' });
      writeJson(path.join(project, 'project.abi'), { saved: 'unmodified' });
      const old = execution.prepareBuildExecution(compileConfig(project, 'original-request'), undefined, 'compile', { shared: true });
      originalHost = fork(__filename, ['old-host', project, old.configFilePath], {
        windowsHide: true, env: process.env, stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      });
      exited = once(originalHost, 'exit');
      const oldWrites = path.join(project, '.build', 'old-writes');
      await until(() => fs.existsSync(oldWrites));
      assert.equal(execution.inspectBuildExecution(project, 'original-request').status, 'running');
      assert.equal(originalHost.exitCode, null);
      await assert.rejects(withSharedBuildAdmission(project, { operation: 'preprocess' }, () => assert.fail('Preprocessing preempted the build')),
        { code: 'BUILD_WORKSPACE_RECOVERY_REQUIRED' });

      originalHost.kill('SIGKILL');
      await exited;
      const next = execution.prepareBuildExecution(compileConfig(project, 'next-request'), undefined, 'compile', { shared: true });
      await withSharedBuildAdmission(project, { operation: 'compile' }, () => {
        const previous = execution.inspectBuildExecution(project, 'original-request');
        const admitted = execution.validateSharedBuildLaunch(next.configFilePath, project, 'compile');
        assert.equal(previous.status, 'cancelled');
        assert.equal(admitted.currentProjectPath, project);
        const previousWrites = fs.readFileSync(oldWrites);
        fs.writeFileSync(path.join(project, '.build', 'next-uses-same-path'), 'current');
        return delay(100).then(() => assert.deepEqual(fs.readFileSync(oldWrites), previousWrites));
      });
      await withSharedBuildAdmission(project, { operation: 'clean' }, () => execution.clearSharedBuildCache(project));
      assert.equal(fs.existsSync(oldWrites), false);
      assert.deepEqual(readJson(path.join(project, 'project.abi')), { saved: 'unmodified' });
      assert.equal(execution.inspectBuildExecution(project, 'original-request').status, 'cancelled');
    } finally {
      if (originalHost && originalHost.exitCode === null && originalHost.signalCode === null) {
        originalHost.kill();
        await exited;
      }
      if (priorAppData === undefined) delete process.env.AILY_APPDATA_PATH;
      else process.env.AILY_APPDATA_PATH = priorAppData;
      assert.equal(path.dirname(fs.realpathSync(owned)), temp);
      assert.match(path.basename(owned), /^aily-shared-build-/);
      fs.rmSync(owned, { recursive: true, force: true });
    }
  });
}
