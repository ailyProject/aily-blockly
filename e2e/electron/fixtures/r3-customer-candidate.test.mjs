import test from 'node:test';
import assert from 'node:assert/strict';
import { exactCandidateFieldEdit, expectedCandidateDocument, observeCandidateCommand } from './r3-customer-candidate.mjs';

// These are edit-planner inputs only. They do not grant Candidate/Host authority
// and are never passed to native validate/apply.
function planner(source) {
  const nodes = [];
  let at = 0;
  for (const match of source.matchAll(/math_number\((-?\d+)\)/g))
    nodes.push({ blockId: 'number-' + at++, start: match.index, end: match.index + match[0].length });
  const root = { ref: { id: 'planner', revisionHash: 'base' }, source,
    record: { base: { map: { hash: 'map' } }, derivation: { kind: 'capture' } } };
  const revisions = new Map([['base', root]]), objects = new Map([['map', JSON.stringify({ nodes })]]);
  return { root, nodes,
    history: {
      async readCandidate(ref) { assert.ok(revisions.has(ref.revisionHash)); return revisions.get(ref.revisionHash); },
      async readCandidateObject(_ref, object) { assert.ok(objects.has(object.hash)); return Buffer.from(objects.get(object.hash)); },
    },
    next(previous, edits, id = 'next') {
      let updated = previous.source;
      for (const edit of [...edits].reverse()) updated = updated.slice(0, edit.start) + edit.text + updated.slice(edit.end);
      objects.set(id, JSON.stringify(edits));
      const result = { ref: { id: 'planner', revisionHash: id }, source: updated,
        record: { base: root.record.base, parent: previous.ref, derivation: { kind: 'splices', edits: { hash: id } } } };
      revisions.set(id, result); return result;
    },
  };
}

test('planner follows genuine baseline ID after preceding UTF16/length-changing edits', async () => {
  const fixture = planner('😀 first math_number(7)\n' + 'context '.repeat(24) + 'second math_number(7)\nopaque: {"keep":"😀"}');
  const firstNumber = fixture.root.source.indexOf('(7)') + 1;
  const selected = fixture.next(fixture.root, [{ start: firstNumber, end: firstNumber + 1, text: '123456' }]);
  const edit = await exactCandidateFieldEdit(fixture.history, selected,
    { blockId: 'number-1', oldValue: 7, value: 9 });
  assert.equal(selected.source.split(edit.oldText).length, 2);
  assert.equal(selected.source.replace(edit.oldText, edit.newText),
    selected.source.replace('second math_number(7)', 'second math_number(9)'));
  assert.ok(edit.newText.includes('9'));
});

test('planner expands repeated numeric context until exactly one occurrence', async () => {
  const fixture = planner('left ' + 'same math_number(7) '.repeat(40) + 'right');
  const edit = await exactCandidateFieldEdit(fixture.history, fixture.root,
    { blockId: 'number-20', oldValue: 7, value: 10 });
  assert.equal(fixture.root.source.split(edit.oldText).length, 2);
  const expectedAt = fixture.nodes[20].start + 'math_number('.length;
  assert.equal(fixture.root.source.replace(edit.oldText, edit.newText),
    fixture.root.source.slice(0, expectedAt) + '10' + fixture.root.source.slice(expectedAt + 1));
});

test('planner rejects earlier overlap and unresolved replacement rather than inventing correspondence', async () => {
  const fixture = planner('math_number(7)');
  const overlap = fixture.next(fixture.root, [{ start: 12, end: 13, text: '8' }]);
  await assert.rejects(exactCandidateFieldEdit(fixture.history, overlap,
    { blockId: 'number-0', oldValue: 7, value: 9 }), /overlap/);
  const unresolved = { ...overlap, record: { ...overlap.record, derivation: { kind: 'replace', mapping: 'unresolved' } } };
  await assert.rejects(exactCandidateFieldEdit(fixture.history, unresolved,
    { blockId: 'number-0', oldValue: 7, value: 9 }), /unresolved replacement/);
});

test('complete expected document changes selected fields and retains other pages/models/opaque bytes', () => {
  const document = { schemaVersion: 3, activePageId: 'one', pages: [
    { id: 'one', content: { blocks: { blocks: [{ id: 'a', type: 'math_number', fields: { NUM: 7 }, unknown: { id: 'opaque-id', text: '😀' } }] } } },
    { id: 'two', content: { blocks: { blocks: [{ id: 'b', type: 'math_number', fields: { NUM: 8 } }] } } },
  ], sharedModel: { variables: [{ id: 'v', name: 'preserved' }], procedureBlocks: [] }, unknown: { untouched: true } };
  const before = JSON.stringify(document), expected = structuredClone(document);
  expected.pages[0].content.blocks.blocks[0].fields.NUM = 10;
  assert.deepEqual(expectedCandidateDocument(document, { blockId: 'a', field: 'NUM', value: 10 }), expected);
  assert.equal(JSON.stringify(document), before);
});

test('save observer delegates awaited original pub2 admission before dispatch and preserves the real result', async () => {
  const audit = [], payload = { operation: 'project_save', params: { saveRequest: { version: 1, requestId: 'unselected', operation: 'project_save' } } },
    selected = { pid: 12345, nativeSaveReceiptVersion: 2, token: 'never-log-target-token' },
    result = { ok: true, saveReceipt: { version: 2, requestId: 'pub2-original', state: 'completed' }, result: { publication: { status: 'COMMITTED' } } };
  let release, dispatched = 0;
  const admission = new Promise(resolve => { release = resolve; });
  const command = observeCandidateCommand(async (action, project, actualPayload, options) => {
    assert.equal(action, 'blockly-live-operation'); assert.equal(project, 'owned-project'); assert.equal(actualPayload, payload);
    await options.onTarget(selected); dispatched++; return result;
  }, audit);
  const pending = command('blockly-live-operation', 'owned-project', payload, { onTarget: async () => {
    Object.assign(payload.params.saveRequest, { version: 2, requestId: 'pub2-original' }); await admission;
  } });
  await Promise.resolve(); assert.equal(dispatched, 0); assert.equal(audit[0].requestId, undefined);
  release(); assert.equal(await pending, result); assert.equal(dispatched, 1);
  assert.equal(audit[0].requestId, 'pub2-original'); assert.equal(audit[0].requestVersion, 2); assert.equal(audit[0].targetPid, selected.pid);
  assert.equal(audit[0].result.saveReceipt, result.saveReceipt); assert.equal(JSON.stringify(audit).includes(selected.token), false);
});

test('original admission failure prevents dispatch and is not replaced by a successful receipt', async () => {
  let dispatched = 0; const audit = [], error = Object.assign(Error('original checkpoint failed'), { code: 'EIO' });
  const command = observeCandidateCommand(async (_action, _project, _payload, options) => {
    await options.onTarget({ pid: 12345, nativeSaveReceiptVersion: 2 }); dispatched++; return { ok: true };
  }, audit);
  await assert.rejects(command('blockly-live-operation', 'owned-project', { operation: 'project_save', params: {} },
    { onTarget: async () => { throw error; } }), value => value === error);
  assert.equal(dispatched, 0); assert.equal(audit[0].result, undefined); assert.equal(audit[0].error.code, 'EIO');
});
