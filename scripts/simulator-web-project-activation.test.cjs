const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');
const { test } = require('node:test');

// These are source boundary tests with explicit Project/Publication doubles.
// They do not open a real project, account, Browser, IDB or MCU.
const text = fs.readFileSync(path.join(__dirname,
  '../src/app/integrations/simulator/simulator-web-project-activation.ts'), 'utf8');
const subject = import('data:text/javascript;base64,' + Buffer.from(
  stripTypeScriptTypes(text, { mode: 'transform' })).toString('base64'));

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function events(initial) {
  const listeners = new Set();
  return {
    subscribe(listener) {
      listeners.add(listener);
      if (initial !== undefined) listener(initial);
      return { unsubscribe() { listeners.delete(listener); } };
    },
    emit(value) { for (const listener of [...listeners]) listener(value); },
    get size() { return listeners.size; },
  };
}

function fixture() {
  const session = new AbortController(), request = new AbortController();
  const currentProjectPath$ = events('/normally-opened'), projectActivation$ = events();
  const counts = { captures: 0, publications: 0, guards: 0, publicationOwner: 0 };
  let current = true;
  const captured = { path: '/normally-opened', projectSessionId: 'original-session', signal: session.signal,
    requireCurrent() {
      assert.equal(this, captured); counts.guards++; session.signal.throwIfAborted();
      if (!current) throw Error('Original selected project is no longer current.');
    } };
  const selected = { activation: new AbortController().signal,
    startupOptions: { owner: { requireCurrent() { counts.publicationOwner++; } } },
    project: { context: { original: true }, storage: { databaseName: 'explicit-test-double' }, artifact: null } };
  const project = { currentProjectPath$, projectActivation$,
    captureCurrentProjectActivation() { assert.equal(this, project); counts.captures++; return captured; } };
  const publication = { async readPublication(projectPath, signal) {
    assert.equal(this, publication); counts.publications++; signal.throwIfAborted();
    return { projectPath, activation: selected };
  } };
  return { project, publication, counts, captured, selected, session, request,
    changePath(path) { current = false; currentProjectPath$.emit(path); },
    get subscriptions() { return currentProjectPath$.size + projectActivation$.size; } };
}

test('reader uses the exact original activation and preserves method receivers', async () => {
  const { createSimulatorWebProjectActivationReader } = await subject;
  const f = fixture(), reader = createSimulatorWebProjectActivationReader(f);
  const activation = await reader.readActivation(f.request.signal);
  assert.equal(f.counts.captures, 1); assert.equal(f.counts.publications, 1);
  assert.equal(activation.project, f.selected.project); activation.startupOptions.owner.requireCurrent();
  assert(f.counts.guards >= 3); assert.equal(f.counts.publicationOwner, 2);
  await reader.close(); assert.equal(f.subscriptions, 0); assert.equal(activation.activation.aborted, true);
});

test('missing original activation fails without manufacturing a session or publication', async () => {
  const { createSimulatorWebProjectActivationReader } = await subject;
  const f = fixture(); f.project.captureCurrentProjectActivation = () => null;
  const reader = createSimulatorWebProjectActivationReader(f);
  await assert.rejects(reader.readActivation(f.request.signal), { code: 'project-unavailable' });
  assert.equal(f.counts.publications, 0); assert.equal(f.subscriptions, 0);
  await reader.close(); assert.equal(reader.snapshot().retainedCleanupResponsibility, false);
});

test('a real selected-path event revokes only this reader binding and retires subscriptions', async () => {
  const { createSimulatorWebProjectActivationReader } = await subject;
  const f = fixture(), reader = createSimulatorWebProjectActivationReader(f);
  const activation = await reader.readActivation(f.request.signal);
  f.changePath('/another-project');
  assert.equal(activation.activation.aborted, true); assert.equal(f.subscriptions, 0);
  assert.throws(() => activation.startupOptions.owner.requireCurrent());
  assert.equal(f.session.signal.aborted, false); await reader.close();
});

test('same-path reload events revoke the caller even while the original session remains alive', async () => {
  const { createSimulatorWebProjectActivationReader } = await subject;
  const f = fixture(), reader = createSimulatorWebProjectActivationReader(f);
  const activation = await reader.readActivation(f.request.signal);
  f.project.projectActivation$.emit({ path: f.captured.path, previousPath: f.captured.path, reason: 'reload' });
  assert.equal(activation.activation.aborted, true); assert.equal(f.session.signal.aborted, false);
  assert.equal(f.subscriptions, 0); await reader.close();
});

test('a late publication cannot escape cancellation and failed reads release subscriptions', async () => {
  const { createSimulatorWebProjectActivationReader } = await subject;
  const f = fixture(), waiting = deferred(), entered = deferred();
  f.publication.readPublication = async () => { entered.resolve(); return waiting.promise; };
  const reader = createSimulatorWebProjectActivationReader(f), reading = reader.readActivation(f.request.signal);
  await entered.promise; f.request.abort(new DOMException('Original request cancelled.', 'AbortError'));
  assert.equal(f.subscriptions, 0);
  waiting.resolve({ projectPath: f.captured.path, activation: f.selected });
  await assert.rejects(reading, { name: 'AbortError' });
  assert.equal(reader.snapshot().pendingReads, 0); assert.equal(reader.snapshot().retainedCleanupResponsibility, false);
  await reader.close();
});

test('close cancels subscriptions immediately and joins the original still-pending publication', async () => {
  const { createSimulatorWebProjectActivationReader } = await subject;
  const f = fixture(), waiting = deferred(), entered = deferred();
  f.publication.readPublication = async () => { entered.resolve(); return waiting.promise; };
  const reader = createSimulatorWebProjectActivationReader(f), reading = reader.readActivation(f.request.signal);
  void reading.catch(() => undefined); await entered.promise;
  const closing = reader.close(); let completed = false; void closing.then(() => { completed = true; });
  await Promise.resolve(); assert.equal(completed, false); assert.equal(f.subscriptions, 0);
  assert.equal(reader.snapshot().pendingReads, 1); assert.equal(reader.snapshot().retainedCleanupResponsibility, true);
  waiting.resolve({ projectPath: f.captured.path, activation: f.selected });
  await assert.rejects(reading, { name: 'AbortError' }); await closing;
  assert.equal(reader.snapshot().pendingReads, 0); assert.equal(reader.snapshot().retainedCleanupResponsibility, false);
  assert.equal(reader.snapshot().NodeBusinessACK, false); assert.equal(reader.snapshot().MainBusinessACK, false);
});
