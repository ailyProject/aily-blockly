const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const ts = require('typescript');

const sourcePath = path.join(__dirname, '../src/app/integrations/simulator/simulator-host-provider-product.service.ts');
const text = fs.readFileSync(sourcePath, 'utf8');
const source = ts.createSourceFile(sourcePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const arrows = [];
function visit(node) {
  if (ts.isPropertyAssignment(node) && node.name.getText(source) === 'readContext'
      && ts.isArrowFunction(node.initializer)
      && node.initializer.body.getText(source) === 'callbacks.readContext({ projectIdentity }, signal)') {
    arrows.push(node.initializer);
  }
  ts.forEachChild(node, visit);
}
visit(source);
assert.equal(arrows.length, 1, 'Select the actual authority-capture readContext arrow, never a test replacement.');
assert(arrows[0].modifiers?.some(node => node.kind === ts.SyntaxKind.AsyncKeyword));
const createReadContext = new Function('callbacks', 'projectIdentity', `return (${arrows[0].getText(source)});`);
const snapshot = Object.freeze({
  schemaVersion: 1, kind: 'aily-simulator-host-project-context-snapshot',
  projectIdentity: 'promise-project', workspaceIdentity: 'promise-workspace', activeSceneId: 'main',
  activeArtifactRevision: 'a'.repeat(64), workspaceSourceSha256: 'b'.repeat(64),
});

test('actual scope readContext arrow wraps a synchronous snapshot and preserves original receiver and signal', async () => {
  const controller = new AbortController();
  let calls = 0;
  const callbacks = {
    readContext(request, signal) {
      calls++;
      assert.equal(this, callbacks);
      assert.deepEqual(request, { projectIdentity: snapshot.projectIdentity });
      assert.equal(signal, controller.signal);
      return snapshot;
    },
  };
  const readContext = createReadContext(callbacks, snapshot.projectIdentity);
  const result = readContext(controller.signal);
  assert(result instanceof Promise);
  assert.equal(await result, snapshot);
  assert.equal(calls, 1);
});

test('actual scope arrow adopts the original async result and preserves rejection, synchronous throw and abort identities', async () => {
  const controller = new AbortController();
  let resolve;
  const original = new Promise(done => { resolve = done; });
  const callbacks = { readContext(request, signal) {
    assert.equal(this, callbacks);
    assert.equal(request.projectIdentity, snapshot.projectIdentity);
    assert.equal(signal, controller.signal);
    return original;
  } };
  const readContext = createReadContext(callbacks, snapshot.projectIdentity);
  const result = readContext(controller.signal);
  resolve(snapshot);
  assert.equal(await result, snapshot);

  const asyncFailure = new Error('controlled async callback failure');
  callbacks.readContext = () => Promise.reject(asyncFailure);
  await assert.rejects(readContext(controller.signal), error => error === asyncFailure);
  const syncFailure = new Error('controlled synchronous callback failure');
  callbacks.readContext = () => { throw syncFailure; };
  let thrownResult;
  assert.doesNotThrow(() => { thrownResult = readContext(controller.signal); });
  await assert.rejects(thrownResult, error => error === syncFailure);
  const abortReason = new Error('controlled original abort reason');
  controller.abort(abortReason);
  callbacks.readContext = (request, signal) => signal.throwIfAborted();
  await assert.rejects(readContext(controller.signal), error => error === abortReason);
});
