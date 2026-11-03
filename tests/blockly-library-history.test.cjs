const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { transformSync } = require('esbuild');
const Blockly = require('blockly');
const { randomUUID } = require('node:crypto');
const source = fs.readFileSync('src/app/editors/blockly-editor/services/blockly-library-history.ts', 'utf8');
const moduleValue = { exports: {} };
vm.runInNewContext('(function(require,module,exports){' + transformSync(source, {loader:'ts',format:'cjs',target:'es2022'}).code + '\n})', {crypto:{randomUUID}})(() => Blockly,moduleValue,moduleValue.exports);
const { recordLibraryMutation, retainBlocklyHistory } = moduleValue.exports;
const tick = () => new Promise(resolve => setImmediate(resolve));
const fixture = () => {
  const undo = [], redo = [];
  return { id:'fixture', getUndoStack:()=>undo, getRedoStack:()=>redo, undo(forward = false) {
    const from = forward ? redo : undo, to = forward ? undo : redo;
    const event = from.pop(); if(event) { event.run(forward); to.push(event); }
  } };
};

test('async library undo moves only after verified restore, retains prior block edits and supports redo', async () => {
  const workspace = fixture(), failures = [], directions = [];
  const earlier = {run(){}}; workspace.getUndoStack().push(earlier);
  let complete;
  recordLibraryMutation(workspace, forward => { directions.push(forward); return new Promise(resolve => {complete=resolve}); }, e=>failures.push(e));
  const marker=workspace.getUndoStack().at(-1);
  workspace.undo(false); workspace.undo(false);
  assert.equal(workspace.getUndoStack().at(-1),marker);
  assert.equal(workspace.getRedoStack().length,0);
  complete(); await tick();
  assert.equal(workspace.getUndoStack().at(-1),earlier);
  assert.equal(workspace.getRedoStack().at(-1),marker);
  workspace.undo(true); complete(); await tick();
  assert.equal(workspace.getUndoStack().at(-1),marker);
  assert.deepEqual(directions,[false,true]); assert.deepEqual(failures,[]);
});

test('a failed restore keeps the marker retryable and hydration preserves both native stacks', async () => {
  const workspace = fixture(), failures=[];
  let fail = true;
  recordLibraryMutation(workspace, async ()=>{if(fail)throw new Error('newer source retained');},e=>failures.push(e));
  const marker=workspace.getUndoStack().at(-1), restore=retainBlocklyHistory(workspace);
  workspace.getUndoStack().length=0; restore();
  assert.equal(workspace.getUndoStack().at(-1),marker);
  workspace.undo(false); await tick();
  assert.equal(workspace.getUndoStack().at(-1),marker); assert.equal(failures.length,1);
  fail=false; workspace.undo(false); await tick();
  assert.equal(workspace.getUndoStack().length,0);
  assert.equal(workspace.getRedoStack().at(-1),marker);
});
