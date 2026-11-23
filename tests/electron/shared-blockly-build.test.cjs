'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork, spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { once } = require('node:events');
const test = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { withSharedBuildAdmission } = require('../../electron/shared-blockly-build');
const { spawnManagedBuild, stopOwnedProcess } = require('../../electron/owned-process');
const execution = require('../../child/scripts/build-execution-workspace');
const { createBuildWorkspaceSupervisor, acquireBuildWorkspace, releaseManagedBuildWorkspace } = require('../../child/scripts/build-workspace-lease');
const { holdWindowsFileWithoutDeleteSharing } = require('../fixtures/windows-file-sharing.cjs');

const boardModule = '@aily-project/board-shared-test';
const writeJson = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
const readJson = file => JSON.parse(fs.readFileSync(file));
const compileConfig = (project, requestId) => ({
  currentProjectPath: project, boardModule, buildRequestId: requestId, code: 'void setup() {}\nvoid loop() {}',
});

async function until(check, timeout = 15000) {
  const deadline = Date.now() + timeout;
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
} else if (mode === 'finish-build' || mode === 'finish-before-workspace-release' || mode === 'exit-unsettled') {
  const original = execution.validateSharedBuildLaunch(configPath, project, 'compile');
  const lease = acquireBuildWorkspace(project, 'compile');
  try {
    execution.startBuildExecution(original, lease);
    if (mode !== 'exit-unsettled') execution.finishBuildExecution(original, false);
  } finally { if (mode === 'finish-build') lease.release(); }
} else if (mode === 'controlled-completion') {
  const original = execution.validateSharedBuildLaunch(configPath, project, 'compile');
  const lease = acquireBuildWorkspace(project, 'compile');
  execution.startBuildExecution(original, lease);
  lease.markDelegated();
  until(() => fs.existsSync(process.argv[5]))
    .then(() => execution.finishBuildExecution(original, true))
    .catch(error => { console.error(error); process.exitCode = 1; });
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

  test('a drained native build with a partial legacy receipt releases only its original admission', {
    skip: process.platform !== 'win32' || process.arch !== 'x64', timeout: 25000,
  }, async t => {
    const temp = fs.realpathSync(os.tmpdir());
    const owned = fs.realpathSync(fs.mkdtempSync(path.join(temp, 'aily-shared-build-')));
    const appData = path.join(owned, 'app-data'), project = path.join(owned, 'fixture');
    const priorAppData = process.env.AILY_APPDATA_PATH;
    fs.mkdirSync(appData);
    process.env.AILY_APPDATA_PATH = appData;
    t.after(() => {
      if (priorAppData === undefined) delete process.env.AILY_APPDATA_PATH;
      else process.env.AILY_APPDATA_PATH = priorAppData;
      assert.equal(path.dirname(fs.realpathSync(owned)), temp);
      assert.match(path.basename(owned), /^aily-shared-build-/);
      fs.rmSync(owned, { recursive: true, force: true });
    });
    writeJson(path.join(project, 'package.json'), { type: 'blockly', dependencies: { [boardModule]: '1' } });
    writeJson(path.join(project, 'node_modules', boardModule, 'package.json'), { name: boardModule });
    writeJson(path.join(project, 'node_modules', boardModule, 'board.json'), { compilerParam: '-b test:test:test' });
    writeJson(path.join(project, 'project.abi'), { saved: 'legacy-unchanged' });
    const old = execution.prepareBuildExecution(compileConfig(project, 'legacy-damaged-outcome'), undefined, 'compile', { shared: true });
    let receiptPath;
    const child = await withSharedBuildAdmission(project, { operation: 'compile' }, admission => {
      const supervisor = createBuildWorkspaceSupervisor(project);
      const binding = admission.bind(supervisor.environment.AILY_BUILD_WORKSPACE_SUPERVISOR, 'legacy-damaged-outcome', old.execution);
      receiptPath = binding.receiptPath;
      return spawnManagedBuild(process.execPath, [__filename, 'finish-build', project, old.configFilePath], {
        cwd: project, windowsHide: true, stdio: 'ignore', env: { ...process.env, ...supervisor.environment },
      }, binding);
    });
    assert.equal((await once(child, 'exit'))[0], 0);
    await until(() => fs.existsSync(receiptPath));
    const outcomePath = path.join(path.dirname(old.configFilePath), 'outcome.json');
    const damaged = Buffer.from('{"version":');
    fs.writeFileSync(outcomePath, damaged);
    fs.writeFileSync(path.join(project, '.build', 'old-cache.bin'), 'old');
    const next = execution.prepareBuildExecution(compileConfig(project, 'after-damaged-outcome'), undefined, 'compile', { shared: true });
    const competing = acquireBuildWorkspace(project, 'verify');
    try {
      await assert.rejects(withSharedBuildAdmission(project, { operation: 'compile' }, () => assert.fail('An active owner was released')),
        { code: 'BUILD_WORKSPACE_BUSY' });
      competing.assertOwned();
    } finally { competing.release(); }
    await withSharedBuildAdmission(project, { operation: 'compile' }, () => {
      assert.equal(execution.validateSharedBuildLaunch(next.configFilePath, project, 'compile').execution.id, next.execution.id);
    });
    const original = execution.inspectBuildExecution(project, 'legacy-damaged-outcome');
    assert.equal(original.executionId, old.execution.id);
    assert.equal(original.status, 'unconfirmed');
    assert.equal(original.ownerState, 'outcome-unreadable');
    assert.deepEqual(fs.readFileSync(outcomePath), damaged);
    await withSharedBuildAdmission(project, { operation: 'clean' }, () => execution.clearSharedBuildCache(project));
    assert.equal(fs.existsSync(path.join(project, '.build', 'old-cache.bin')), false);
    assert.deepEqual(readJson(path.join(project, 'project.abi')), { saved: 'legacy-unchanged' });
    assert.deepEqual(fs.readFileSync(outcomePath), damaged);
  });

  test('a drained native build releases admission even when Windows cannot delete its old config', {
    skip: process.platform !== 'win32' || process.arch !== 'x64', timeout: 25000,
  }, async t => {
    const temp = fs.realpathSync(os.tmpdir());
    const owned = fs.realpathSync(fs.mkdtempSync(path.join(temp, 'aily-shared-build-')));
    const appData = path.join(owned, 'app-data'), project = path.join(owned, 'fixture');
    const priorAppData = process.env.AILY_APPDATA_PATH;
    fs.mkdirSync(appData);
    process.env.AILY_APPDATA_PATH = appData;
    t.after(() => {
      if (priorAppData === undefined) delete process.env.AILY_APPDATA_PATH;
      else process.env.AILY_APPDATA_PATH = priorAppData;
      assert.equal(path.dirname(fs.realpathSync(owned)), temp);
      assert.match(path.basename(owned), /^aily-shared-build-/);
      fs.rmSync(owned, { recursive: true, force: true });
    });
    writeJson(path.join(project, 'package.json'), { type: 'blockly', dependencies: { [boardModule]: '1' } });
    writeJson(path.join(project, 'node_modules', boardModule, 'package.json'), { name: boardModule });
    writeJson(path.join(project, 'node_modules', boardModule, 'board.json'), { compilerParam: '-b test:test:test' });
    const old = execution.prepareBuildExecution(compileConfig(project, 'old-sharing-refusal'), undefined, 'compile', { shared: true });
    let receiptPath;
    const child = await withSharedBuildAdmission(project, { operation: 'compile' }, admission => {
      const supervisor = createBuildWorkspaceSupervisor(project);
      const binding = admission.bind(supervisor.environment.AILY_BUILD_WORKSPACE_SUPERVISOR, 'old-sharing-refusal', old.execution);
      receiptPath = binding.receiptPath;
      return spawnManagedBuild(process.execPath, [__filename, 'exit-unsettled', project, old.configFilePath], {
        cwd: project, windowsHide: true, stdio: 'ignore', env: { ...process.env, ...supervisor.environment },
      }, binding);
    });
    assert.equal((await once(child, 'exit'))[0], 0);
    await until(() => fs.existsSync(receiptPath));
    const bindingPath = path.join(path.dirname(receiptPath), createHash('sha256').update(project.toLowerCase()).digest('hex') + '.json');
    assert.equal(fs.readFileSync(receiptPath, 'utf8'), readJson(bindingPath).proof.job);
    const workspaceOwner = path.join(project, '.build', 'aily-workspace.lock');
    assert.ok(fs.existsSync(workspaceOwner));
    const next = execution.prepareBuildExecution(compileConfig(project, 'next-after-sharing-refusal'), undefined, 'compile', { shared: true });

    const originalConfig = fs.readFileSync(old.configFilePath);
    fs.unlinkSync(old.configFilePath);
    fs.mkdirSync(old.configFilePath);
    await assert.rejects(withSharedBuildAdmission(project, { operation: 'compile' }, () => assert.fail('Unsafe history was accepted')),
      { code: 'BUILD_EXECUTION_INVALID' });
    assert.ok(fs.lstatSync(old.configFilePath).isDirectory());
    assert.ok(fs.existsSync(bindingPath));
    fs.rmdirSync(old.configFilePath);
    fs.writeFileSync(old.configFilePath, originalConfig);

    const release = await holdWindowsFileWithoutDeleteSharing(old.configFilePath);
    try {
      await withSharedBuildAdmission(project, { operation: 'compile' }, () => {
        assert.equal(execution.validateSharedBuildLaunch(next.configFilePath, project, 'compile').execution.id, next.execution.id);
      });
      assert.equal(execution.inspectBuildExecution(project, old.execution.buildRequestId).status, 'cancelled');
      assert.deepEqual(fs.readFileSync(old.configFilePath), originalConfig);
      assert.ok(!fs.existsSync(workspaceOwner));
      assert.ok(!fs.existsSync(bindingPath));
    } finally { await release(); }
  });

  for (const heldFile of ['execution status', 'drain receipt']) {
    test(`a verified old build does not block the successor when Windows holds its ${heldFile}`, {
      skip: process.platform !== 'win32' || process.arch !== 'x64', timeout: 25000,
    }, async t => {
      const temp = fs.realpathSync(os.tmpdir());
      const owned = fs.realpathSync(fs.mkdtempSync(path.join(temp, 'aily-shared-build-')));
      const appData = path.join(owned, 'app-data'), project = path.join(owned, 'fixture');
      const priorAppData = process.env.AILY_APPDATA_PATH;
      fs.mkdirSync(appData);
      process.env.AILY_APPDATA_PATH = appData;
      t.after(() => {
        if (priorAppData === undefined) delete process.env.AILY_APPDATA_PATH;
        else process.env.AILY_APPDATA_PATH = priorAppData;
        assert.equal(path.dirname(fs.realpathSync(owned)), temp);
        assert.match(path.basename(owned), /^aily-shared-build-/);
        fs.rmSync(owned, { recursive: true, force: true });
      });
      writeJson(path.join(project, 'package.json'), { type: 'blockly', dependencies: { [boardModule]: '1' } });
      writeJson(path.join(project, 'node_modules', boardModule, 'package.json'), { name: boardModule });
      writeJson(path.join(project, 'node_modules', boardModule, 'board.json'), { compilerParam: '-b test:test:test' });
      writeJson(path.join(project, 'project.abi'), { saved: 'unmodified' });
      const prepare = id => execution.prepareBuildExecution(compileConfig(project, id), undefined, 'compile', { shared: true });
      const status = config => execution.inspectBuildExecution(project, config.execution.buildRequestId);
      const finish = path.join(owned, 'finish-successor');
      const start = (config, childMode) => withSharedBuildAdmission(project, { operation: 'compile' }, admission => {
        const supervisor = createBuildWorkspaceSupervisor(project);
        const binding = admission.bind(supervisor.environment.AILY_BUILD_WORKSPACE_SUPERVISOR, config.execution.buildRequestId, config.execution);
        const child = spawnManagedBuild(process.execPath, [__filename, childMode, project, config.configFilePath, finish], {
          cwd: project, windowsHide: true, stdio: 'ignore', env: { ...process.env, ...supervisor.environment },
        }, binding);
        return { child, exited: once(child, 'exit'), receiptPath: binding.receiptPath };
      });
      const old = prepare('old-request'), original = await start(old, 'exit-unsettled');
      assert.equal((await original.exited)[0], 0);
      await until(() => fs.existsSync(original.receiptPath));
      const bindingPath = path.join(path.dirname(original.receiptPath), createHash('sha256').update(project.toLowerCase()).digest('hex') + '.json');
      const oldBinding = readJson(bindingPath), workspaceOwner = path.join(project, '.build', 'aily-workspace.lock');
      assert.equal(fs.readFileSync(original.receiptPath, 'utf8'), oldBinding.proof.job);
      assert.ok(fs.existsSync(workspaceOwner));
      const oldFolder = path.dirname(old.configFilePath);
      const held = heldFile === 'execution status' ? path.join(oldFolder, 'execution.json') : original.receiptPath;
      const retained = fs.readFileSync(held);
      let release = await holdWindowsFileWithoutDeleteSharing(held);
      let successor;
      try {
        assert.throws(() => fs.unlinkSync(held), error => ['EBUSY', 'EPERM', 'EACCES'].includes(error.code));
        const next = prepare('next-request');
        successor = await start(next, 'controlled-completion');
        await until(() => status(next)?.status === 'running');
        assert.equal(status(old).status, 'cancelled');
        assert.equal(status(old).current, false);
        assert.deepEqual(fs.readFileSync(held), retained);
        const oldOutcome = fs.readFileSync(path.join(oldFolder, 'outcome.json'));
        const nextOwner = fs.readFileSync(workspaceOwner), nextBinding = fs.readFileSync(bindingPath);
        assert.notEqual(readJson(bindingPath).supervisor, oldBinding.supervisor);
        await assert.rejects(withSharedBuildAdmission(project, { operation: 'preprocess' }, () => assert.fail('Preprocessing preempted the build')),
          { code: 'BUILD_WORKSPACE_RECOVERY_REQUIRED' });
        assert.equal(releaseManagedBuildWorkspace(project, oldBinding.supervisor), false);
        assert.equal(execution.cancelBuildExecution(old).status, 'cancelled');
        assert.deepEqual(fs.readFileSync(workspaceOwner), nextOwner);
        assert.deepEqual(fs.readFileSync(bindingPath), nextBinding);
        assert.deepEqual(fs.readFileSync(path.join(oldFolder, 'outcome.json')), oldOutcome);
        assert.equal(status(next).status, 'running');
        await release();
        release = undefined;
        await until(() => heldFile === 'execution status'
          ? readJson(held).status === 'cancelled' : !fs.existsSync(held), 3500);
        assert.deepEqual(fs.readFileSync(workspaceOwner), nextOwner);
        assert.deepEqual(fs.readFileSync(bindingPath), nextBinding);
        assert.deepEqual(fs.readFileSync(path.join(oldFolder, 'outcome.json')), oldOutcome);
        assert.equal(status(next).status, 'running');
        writeJson(finish, true);
        assert.equal((await successor.exited)[0], 0);
        assert.equal(status(next).status, 'completed');
      } finally {
        await release?.();
        if (successor) await stopOwnedProcess(successor.child);
      }
    });
  }

  for (const fault of ['truncated', 'missing', 'wrong-type']) {
    test(`a drained build with ${fault} execution history cannot settle an unverified result`, {
      skip: process.platform !== 'win32' || process.arch !== 'x64', timeout: 25000,
    }, async t => {
      const temp = fs.realpathSync(os.tmpdir());
      const owned = fs.realpathSync(fs.mkdtempSync(path.join(temp, 'aily-shared-build-')));
      const appData = path.join(owned, 'app-data'), project = path.join(owned, 'fixture');
      const priorAppData = process.env.AILY_APPDATA_PATH;
      fs.mkdirSync(appData);
      process.env.AILY_APPDATA_PATH = appData;
      t.after(() => {
        if (priorAppData === undefined) delete process.env.AILY_APPDATA_PATH;
        else process.env.AILY_APPDATA_PATH = priorAppData;
        assert.equal(path.dirname(fs.realpathSync(owned)), temp);
        assert.match(path.basename(owned), /^aily-shared-build-/);
        fs.rmSync(owned, { recursive: true, force: true });
      });
      const abi = { saved: 'original project' };
      writeJson(path.join(project, 'package.json'), { type: 'blockly', dependencies: { [boardModule]: '1' } });
      writeJson(path.join(project, 'node_modules', boardModule, 'package.json'), { name: boardModule });
      writeJson(path.join(project, 'node_modules', boardModule, 'board.json'), { compilerParam: '-b test:test:test' });
      writeJson(path.join(project, 'project.abi'), abi);
      const old = execution.prepareBuildExecution(compileConfig(project, 'old-history'), undefined, 'compile', { shared: true });
      let receiptPath;
      const child = await withSharedBuildAdmission(project, { operation: 'compile' }, admission => {
        const supervisor = createBuildWorkspaceSupervisor(project);
        const binding = admission.bind(supervisor.environment.AILY_BUILD_WORKSPACE_SUPERVISOR, 'old-history-stream', old.execution);
        receiptPath = binding.receiptPath;
        return spawnManagedBuild(process.execPath, [__filename, 'finish-before-workspace-release', project, old.configFilePath], {
          cwd: project, windowsHide: true, stdio: 'ignore', env: { ...process.env, ...supervisor.environment },
        }, binding);
      });
      assert.equal((await once(child, 'exit'))[0], 0);
      await until(() => fs.existsSync(receiptPath));
      const bindingPath = path.join(path.dirname(receiptPath), createHash('sha256').update(project.toLowerCase()).digest('hex') + '.json');
      assert.equal(fs.readFileSync(receiptPath, 'utf8'), readJson(bindingPath).proof.job);
      const workspaceOwner = path.join(project, '.build', 'aily-workspace.lock');
      assert.ok(fs.existsSync(workspaceOwner));
      const cache = path.join(project, '.build', 'old-cache.bin');
      fs.writeFileSync(cache, 'old');
      const folder = path.dirname(old.configFilePath);
      const outcomePath = path.join(folder, 'outcome.json'), recordPath = path.join(folder, 'execution.json');
      const outcome = fs.readFileSync(outcomePath), record = fs.readFileSync(recordPath);
      assert.equal(JSON.parse(outcome).status, 'failed');
      const truncated = Buffer.from('{"version":');
      if (fault === 'truncated') fs.writeFileSync(recordPath, truncated);
      else fs.unlinkSync(recordPath);

      if (fault === 'wrong-type') {
        fs.mkdirSync(recordPath);
        await assert.rejects(withSharedBuildAdmission(project, { operation: 'clean' }, () => assert.fail('Unsafe history was accepted')),
          { code: 'BUILD_EXECUTION_INVALID' });
        assert.ok(fs.existsSync(bindingPath));
        assert.ok(fs.lstatSync(recordPath).isDirectory());
        assert.equal(fs.readFileSync(cache, 'utf8'), 'old');
        fs.rmdirSync(recordPath);
        fs.writeFileSync(recordPath, record);
      }

      const startNext = async () => {
        const next = execution.prepareBuildExecution(compileConfig(project, 'next-history'), undefined, 'compile', { shared: true });
        await withSharedBuildAdmission(project, { operation: 'compile' }, () => {
          assert.equal(execution.validateSharedBuildLaunch(next.configFilePath, project, 'compile').execution.id, next.execution.id);
        });
      };
      if (fault === 'truncated') await startNext();
      await withSharedBuildAdmission(project, { operation: 'clean' }, () => execution.clearSharedBuildCache(project));
      if (fault !== 'truncated') await startNext();
      assert.ok(!fs.existsSync(workspaceOwner));
      assert.ok(!fs.existsSync(bindingPath));
      assert.ok(!fs.existsSync(cache));
      assert.deepEqual(readJson(path.join(project, 'project.abi')), abi);
      assert.deepEqual(fs.readFileSync(outcomePath), outcome);
      if (fault === 'wrong-type') assert.equal(execution.inspectBuildExecution(project, 'old-history').status, 'failed');
      else {
        assert.equal(execution.inspectBuildExecution(project, 'old-history'), null);
        if (fault === 'missing') assert.ok(!fs.existsSync(recordPath));
        else assert.deepEqual(fs.readFileSync(recordPath), truncated);
      }
    });
  }
}
