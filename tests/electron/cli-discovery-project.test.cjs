'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const test = require('node:test');
const { getBridgeDir, startCliBridge } = require('../../electron/cli-bridge');

test('only actual project changes update discovery while original requests settle', { timeout: 10000 }, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-cli-project-'));
  t.mock.method(os, 'homedir', () => home);
  const projectA = path.join(home, 'project-a');
  const projectB = path.join(home, 'project-b');
  let activeProject = projectA;
  const dispatched = Promise.withResolvers();
  const pending = Promise.withResolvers();
  const bridge = startCliBridge({
    handleCommand: (action, payload) => {
      if (payload.delayed) {
        dispatched.resolve();
        return pending.promise;
      }
      return { ok: action === 'project_save_status', project: payload.path };
    },
    getStatus: () => ({ project: activeProject }),
    logger: { log() {}, warn() {}, error() {} },
  });
  t.after(() => {
    pending.resolve({ ok: false });
    bridge.close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  const signal = AbortSignal.timeout(8000);
  while (!bridge.getPort()) await delay(10, undefined, { signal });
  const base = `http://127.0.0.1:${bridge.getPort()}`;
  const readDiscovery = () => JSON.parse(fs.readFileSync(path.join(getBridgeDir(), `${process.pid}.json`), 'utf8'));
  const initial = readDiscovery();
  assert.equal(initial.project, projectA);
  const command = (action, params) => fetch(`${base}/command`, {
    method: 'POST', signal,
    body: JSON.stringify({ token: initial.token, action, ...params }),
  });

  const observation = command('project_save_status', { path: projectA, delayed: true });
  await dispatched.promise;
  activeProject = projectB;
  bridge.updateProject(activeProject);
  const opened = readDiscovery();
  assert.equal(opened.project, projectB);

  pending.resolve({ ok: true, project: projectA, requestId: 'original-save' });
  assert.deepEqual(await (await observation).json(), { ok: true, project: projectA, requestId: 'original-save' });
  const rejected = await command('open', { path: projectA });
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json()).project, projectA);
  assert.deepEqual(readDiscovery(), opened);
  assert.equal((await (await fetch(`${base}/ping`, { signal })).json()).project, projectB);

  activeProject = null;
  bridge.updateProject(null);
  assert.equal(readDiscovery().project, null);
});
