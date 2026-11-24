const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createSimulatorSubappHost } = require('../../electron/simulator-subapp-host');

function fixture(t, { useDefaultResolver = false } = {}) {
  const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aily-sim-build-')));
  const control = [];
  const launches = [];
  const launchId = `launch-v1-${'a'.repeat(64)}`;
  const artifactHandle = `artifact-v1-${'b'.repeat(64)}`;
  const origin = 'http://127.0.0.1:23456';
  let current = null;
  let onImport = () => {};

  function putArtifact(directory, manifest) {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'aily-artifact-manifest.json'), manifest);
  }

  const host = createSimulatorSubappHost({
    ...(useDefaultResolver ? {} : { buildResolver: () => current }),
    runtimeResolver: () => ({
      productionEntry: 'service.js', qemuExecutable: 'qemu', gdbExecutable: 'gdb',
      entitlementConfigPath: 'entitlement.json', instrumentAssetsDirectory: 'instruments',
      simulatorRoot: projectRoot, workRoot: path.join(projectRoot, 'simulator'),
    }),
    spawnProcess(_, args) {
      launches.push(args);
      const child = new EventEmitter();
      Object.assign(child, { stdout: new EventEmitter(), exitCode: null, signalCode: null, connected: true });
      child.send = (message, callback) => {
        if (message.type === 'aily-simulator-subapp.shutdown') {
          child.exitCode = 0;
          queueMicrotask(() => child.emit('exit', 0, null));
          return;
        }
        const { request } = message;
        control.push(request);
        if (request.operation === 'import-artifact') onImport();
        const session = { sessionId: request.sessionId, state: 'ready', sceneRevision: null };
        const state = request.operation === 'open-project-scene' ? 'opening' : 'attached';
        queueMicrotask(() => {
          callback?.();
          child.emit('message', {
            type: 'aily-simulator-subapp.control.response', version: 2,
            response: { ...request, kind: 'aily-simulator-subapp-control-success', launchId, artifactHandle, session, state },
          });
        });
      };
      queueMicrotask(() => child.stdout.emit('data', `${JSON.stringify({
        event: 'ready',
        data: { schemaVersion: 1, kind: 'aily-simulator-subapp-ready', mode: 'serve', service: 'aily-simulator',
          controlProtocolVersion: 2, controlTransport: 'parent-ipc', url: origin, origin, port: 23456, pid: 1,
          shellPath: '/subapp' },
      })}\n`));
      return child;
    },
  });
  t.after(async () => {
    await host.close();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  return {
    host, projectRoot, control, launches, putArtifact,
    open: tool => host.open({ projectPath: projectRoot, rendererOrigin: origin, tool }),
    openScene: () => host.openProjectScene({ projectPath: projectRoot, rendererOrigin: origin }),
    accept: (buildPath, buildRequestId) => { current = { buildPath, buildRequestId }; },
    discard: () => { current = null; },
    onImport: callback => { onImport = callback; },
  };
}

test('simulator debugger selects the accepted isolated artifact and reads the logical project debug config', async t => {
  const f = fixture(t);
  const isolated = path.join(f.projectRoot, '.aily', 'build-executions', 'old', 'project', '.build');
  f.putArtifact(isolated, 'isolated artifact');
  f.putArtifact(path.join(f.projectRoot, '.build'), 'unaccepted project artifact');
  const debug = { schemaVersion: 1, kind: 'aily-project-debug-configuration', breakpoints: [] };
  fs.writeFileSync(path.join(f.projectRoot, 'aily-debug.json'), JSON.stringify(debug));
  f.accept(isolated, 'accepted');

  assert.equal((await f.open('debugger')).tool, 'debugger');
  const args = f.launches[0];
  assert.equal(args[args.indexOf('--artifact-root') + 1], isolated);
  assert.equal(f.control.find(request => request.operation === 'import-artifact').sourceArtifactDirectory, '.');
  assert.deepEqual(f.control.find(request => request.operation === 'prepare-session').projectDebugConfiguration, debug);
});

test('project scene attaches an isolated artifact with a portable project-relative path', async t => {
  const f = fixture(t);
  const relative = '.aily/build-executions/old/project/.build';
  const isolated = path.join(f.projectRoot, ...relative.split('/'));
  f.putArtifact(isolated, 'isolated artifact');
  f.accept(isolated, 'accepted');

  await f.openScene();
  assert.equal((await f.host.attachProjectSceneSession()).state, 'attached');
  assert.equal(f.control.find(request => request.operation === 'import-artifact').sourceArtifactDirectory, relative);
});

test('project scene opens without firmware and retains only an accepted immutable attachment', async t => {
  const f = fixture(t);
  const shared = path.join(f.projectRoot, '.build');
  f.putArtifact(shared, 'same artifact bytes');
  assert.equal((await f.openScene()).state, 'ready');
  await assert.rejects(f.host.attachProjectSceneSession(), /No current compiled Artifact/);
  assert.equal(f.control.some(request => request.operation === 'import-artifact'), false);

  f.accept(shared, 'first');
  f.onImport(() => f.accept(shared, 'second'));
  await assert.rejects(f.host.attachProjectSceneSession(), /changed during simulator import/);
  assert.equal(f.control.at(-1).operation, 'release-artifact');
  assert.equal(f.control.some(request => request.operation === 'attach-project-scene-session'), false);

  assert.equal((await f.host.attachProjectSceneSession()).state, 'attached');
  assert.equal(f.control.find(request => request.operation === 'import-artifact').sourceArtifactDirectory, '.build');
  const completed = f.control.length;
  f.discard();
  fs.rmSync(shared, { recursive: true });
  assert.equal((await f.host.attachProjectSceneSession()).state, 'attached');
  assert.equal(f.control.length, completed);
});

test('production resolver ignores a raw Blockly artifact and preserves Coder root artifacts', async t => {
  const f = fixture(t, { useDefaultResolver: true });
  const manifest = path.join(f.projectRoot, 'package.json');
  f.putArtifact(path.join(f.projectRoot, '.build'), 'root artifact');
  fs.writeFileSync(manifest, JSON.stringify({ type: 'blockly' }));
  await assert.rejects(f.open('scene'), /No current compiled Artifact/);
  assert.equal(f.launches.length, 0);

  fs.writeFileSync(manifest, JSON.stringify({ type: 'coder' }));
  assert.equal((await f.open('scene')).state, 'ready');
  const args = f.launches[0];
  assert.equal(args[args.indexOf('--artifact-root') + 1], path.join(f.projectRoot, '.build'));
});
