'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { createProjectStartupOpen } = require('../../electron/project-open-path');
const { bridgeFixture, sourceClass } = require('./fixtures/bootstrap-host-source.cjs');

const restored = path.resolve('restored');
const explicit = path.resolve('explicit');
const record = { project: restored, reason: 'interrupted' };

test('a rejected target preflight keeps the original view and releases only the provisional target', async () => {
  const { domain, window } = bridgeFixture(restored);
  const held = new Set([restored]), release = [], visits = [], preparations = [];
  let selected = restored;
  window.projectLock = {
    tryAcquire: async (target, options) => {
      held.add(target);
      if (!options?.provisional) selected = target;
      return { ok: true };
    },
    release: async target => {
      held.delete(target);
      release.push(target);
      if (selected === target) selected = null;
    },
  };
  Object.assign(domain, {
    electronService: { isElectron: true, exists: () => true },
    ensureProjectModeAllowed: async () => true,
    rememberDependencyBackend: session => session,
    assertProjectDependencySession: () => {},
    dependencyLifecycle: { isStopping: () => false, beginPreparation: target => ({ target }), finishPreparation: () => {} },
    application: {
      hasActiveProjectMutation: () => false,
      closeConnectionGraphWindows: async () => { visits.push('close'); return true; },
      settleEnvironmentBeforeOpen: async target => {
        preparations.push([target, selected]);
        throw Object.assign(Error('Target native writer is still active'), { code: 'PROJECT_FILE_BUSY' });
      },
    },
    stopProjectCommands: async () => { visits.push('stop'); },
    discardDepartingBlocklyProject: async () => { visits.push('discard'); return true; },
  });
  await assert.rejects(domain.projectOpen(explicit), { code: 'PROJECT_FILE_BUSY' });
  assert.deepEqual(preparations, [[explicit, restored]]);
  assert.deepEqual(visits, []);
  assert.deepEqual(release, [explicit]);
  assert.deepEqual([...held], [restored]);
  assert.equal(domain.currentProjectPath, restored);
  assert.equal(selected, restored);
});

test('the startup request survives only its exact dispatched renderer and physical route', () => {
  const startup = createProjectStartupOpen();
  const request = startup.stage(record);
  assert.equal(startup.consume(request.startupTicket, restored, 3), null);
  assert.equal(startup.dispatch(request, 3), true);
  assert.equal(startup.dispatch(request, 4), false);
  assert.equal(startup.consume(request.startupTicket, explicit, 3), null);
  assert.equal(startup.consume(request.startupTicket, restored, 4), null);
  assert.equal(startup.consume(request.startupTicket, restored, 3), record);
  assert.equal(startup.consume(request.startupTicket, restored, 3), null);
});

for (const project of [explicit, restored]) {
  test(`a newer file navigation of ${path.basename(project)} retires the old startup ticket`, () => {
    const startup = createProjectStartupOpen();
    const request = startup.stage(record);
    assert.equal(startup.dispatch(request, 3), true);
    startup.invalidate();
    assert.equal(startup.consume(request.startupTicket, project, 3), null);
    assert.equal(startup.consume(request.startupTicket, restored, 3), null);
    assert.equal(startup.dispatch(request, 3), false);
  });

  test(`the renderer discards a delayed startup acknowledgement before activating explicit ${path.basename(project)}`, async () => {
    const { domain, window } = bridgeFixture('');
    const startup = createProjectStartupOpen();
    const request = startup.stage(record);
    assert.equal(startup.dispatch(request, 3), true);
    const entered = Promise.withResolvers(), resume = Promise.withResolvers();
    const calls = [], activations = [], releases = [], loading = [];
    let current;
    window.projectLock = {
      checkStartupRestore: (target, ticket) => startup.isCurrent(ticket, target, 3),
      cancelStartupRestore: () => startup.invalidate(),
      tryAcquire: async () => ({ ok: true }),
      release: async target => { releases.push(target); },
      async recordActive(target, ticket) {
        calls.push({ target, ticket });
        if (ticket) {
          assert.equal(startup.consume(ticket, target, 3), record);
          current = { project: target, activationViewId: 'old-startup' };
          entered.resolve();
          await resume.promise;
          return { ok: true, activationViewId: 'old-startup', recoverySessionId: 'old-chat' };
        }
        current = { project: target, activationViewId: 'explicit' };
        return { ok: true, activationViewId: 'explicit' };
      },
      async clearActive(target, { expectedViewId }) {
        assert.equal(current.project, target);
        assert.equal(current.activationViewId, expectedViewId);
        current = undefined;
        return { ok: true, cleared: true };
      },
    };
    Object.assign(domain, {
      electronService: { isElectron: true, exists: () => true },
      ensureProjectModeAllowed: async () => true,
      rememberDependencyBackend: session => session,
      assertProjectDependencySession: () => {},
      dependencyLifecycle: { isStopping: () => false, beginPreparation: target => ({ target }), finishPreparation: () => {}, release: () => {} },
      router: { url: '/main/guide', navigate: async () => true },
      beginBlocklyProjectLoad: target => loading.push(target),
      waitForProjectOpenCompletion: async () => {},
      projectActivationSubject: { next: event => activations.push(event.path) },
    });
    const restoring = domain.projectOpen(restored, { startupRestore: request.startupTicket });
    await entered.promise;
    const choosing = domain.projectOpen(project);
    resume.resolve();
    assert.equal(await restoring, false);
    assert.equal(await choosing, true);
    assert.deepEqual(releases, [restored]);
    assert.deepEqual(calls, [{ target: restored, ticket: request.startupTicket }, { target: project, ticket: undefined }]);
    assert.deepEqual(activations, [project]);
    assert.deepEqual(loading, [project]);
    assert.equal(current.project, project);
    assert.equal(domain.recoveredCreateSession, undefined);
  });
}

for (const action of ['close', 'switch', 'switch-twice', 'same-project']) {
  test(`cold environment observation releases its original owner before ${action}`, async () => {
    const { domain, window } = bridgeFixture('');
    const startup = createProjectStartupOpen(), request = startup.stage(record);
    assert.equal(startup.dispatch(request, 3), true);
    const entered = Promise.withResolvers(), oldReply = Promise.withResolvers();
    const releases = [], retired = [], activations = [], closes = [];
    let oldPreparation = true;
    const Closed = sourceClass('src/app/services/domains/project/project.service.ts', 'ProjectService', { window }, ['close']);
    domain.close = Closed.prototype.close;
    Object.assign(domain, {
      coderOperationsSubject: { value: new Map() },
      electronService: { isElectron: true, exists: () => true },
      ensureProjectModeAllowed: async () => true,
      rememberDependencyBackend: session => session,
      assertProjectDependencySession: () => {},
      dependencyLifecycle: {
        isStopping: () => false, get: () => undefined, beginPreparation: target => ({ target }),
        finishPreparation: () => {}, release: session => retired.push(session.target),
      },
      router: { url: '/main/guide', navigate: async () => true },
      beginBlocklyProjectLoad: () => {},
      waitForProjectOpenCompletion: async () => {},
      projectActivationSubject: { next: event => activations.push(event.path) },
      stopProjectCommands: async () => {},
      discardLibraryChanges: async () => {},
      closeInternal: async () => { closes.push(true); return true; },
      application: {
        hasActiveProjectMutation: () => false,
        async settleEnvironmentBeforeOpen(target, guard, signal) {
          if (target !== restored || !oldPreparation) return;
          oldPreparation = false;
          entered.resolve();
          if (!signal) return oldReply.promise;
          const cancelled = Promise.withResolvers();
          signal.addEventListener('abort', () => cancelled.reject(signal.reason), { once: true });
          await Promise.race([oldReply.promise, cancelled.promise]);
          guard();
        },
      },
    });
    window.projectLock = {
      checkStartupRestore: (target, ticket) => startup.isCurrent(ticket, target, 3),
      cancelStartupRestore: () => startup.invalidate(),
      tryAcquire: async () => ({ ok: true }),
      release: async target => releases.push(target),
      recordActive: async (target, ticket) => {
        if (ticket) assert.equal(startup.consume(ticket, target, 3), record);
        return { ok: true, activationViewId: 'chosen' };
      },
    };
    const restoring = domain.projectOpen(restored, { startupRestore: request.startupTicket });
    await entered.promise;
    const first = action === 'close' ? domain.close() : domain.projectOpen(action === 'same-project' ? restored : explicit);
    const chosen = action === 'switch-twice' ? path.resolve('latest') : action === 'same-project' ? restored : explicit;
    const latest = action === 'switch-twice' ? domain.projectOpen(chosen) : first;
    try {
      assert.equal(await Promise.race([latest, delay(250, 'waiting')]), true);
      assert.equal(await restoring, false);
      if (latest !== first) assert.equal(await first, false);
      assert.deepEqual(retired, [restored]);
      assert.deepEqual(releases, [restored]);
      assert.deepEqual(activations, action === 'close' ? [] : [chosen]);
      assert.deepEqual(closes, action === 'close' ? [true] : []);
    } finally { oldReply.resolve(); }
  });
}
