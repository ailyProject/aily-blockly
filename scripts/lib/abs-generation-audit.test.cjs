const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { installAbsGenerationAudit, compareAbsGenerationEvidence: compare } = require('./abs-generation-audit.cjs');
const evidence = () => ({ code: 'void setup() {}', artifacts: [{ fileName: 'a.h', content: 'x', sourceTag: 's' }], projectMacros: [] });

test('compares every native pass, not just the last one, including file metadata and macros', () => {
  const value = evidence();
  assert.equal(compare([value, value], [value]).status, 'matched');
  for (const field of ['code', 'artifacts', 'projectMacros']) {
    const changed = { ...value, [field]: field === 'code' ? 'changed' : ['changed'] };
    assert.deepEqual(compare([changed, value], [value]).mismatches, [field]);
  }
  const changed = evidence(); changed.artifacts[0].sourceTag = 'different';
  assert.deepEqual(compare([changed], [value]).mismatches, ['artifacts']);
});

test('missing, failed or ambiguous host preparation is not successful parity', () => {
  for (const [native, host] of [[[], []], [[evidence()], []], [[evidence()], [null]], [[evidence()], [evidence(), evidence()]],
    [[{ ...evidence(), code: null }], [evidence()]], [[{ code: 'incomplete' }], [{ code: 'incomplete' }]]]) assert.equal(compare(native, host).status, 'unavailable');
  assert.equal(compare([{ ...evidence(), projectMacros: undefined }], [evidence()]).status, 'matched');
});

test('instrumentation captures detached outputs in the owning call and does not start ports or regenerate', async () => {
  let calls = 0;
  const original = evidence();
  const editor = { async prepareProjectCode(...args) { calls++; assert.deepEqual(args, ['guard', 'lease']); return original; } };
  class Channel { constructor() { this.port1 = new EventTarget(); this.port1.start = () => { throw Error('Must not start port'); }; } }
  const window = { MessageChannel: Channel, ng: { getComponent: () => ({ blocklyService: editor }) }, auditGeneration: { native: [], host: [] } };
  vm.runInNewContext(`(${installAbsGenerationAudit.toString()})()`, { window, document: { querySelector() {} }, structuredClone });
  const first = window.auditGeneration, channel = new window.MessageChannel();
  const promise = editor.prepareProjectCode('guard', 'lease');
  window.auditGeneration = { native: [], host: [] };
  const event = new Event('message'); event.data = { ok: true, result: { generationEvidence: original } };
  channel.port1.dispatchEvent(event);
  assert.equal(await promise, original); assert.equal(calls, 1);
  original.artifacts[0].content = 'later mutation';
  assert.equal(first.native[0].artifacts[0].content, 'x'); assert.equal(first.host[0].artifacts[0].content, 'x');
  assert.equal(window.auditGeneration.host.length + window.auditGeneration.native.length, 0);
});

test('generation rejection is propagated unchanged and never produces fake evidence', async () => {
  const failure = new Error('generation failed');
  const editor = { async prepareProjectCode() { throw failure; } };
  const window = { MessageChannel: class {}, ng: { getComponent: () => ({ blocklyService: editor }) }, auditGeneration: { native: [], host: [] } };
  vm.runInNewContext(`(${installAbsGenerationAudit.toString()})()`, { window, document: { querySelector() {} }, structuredClone });
  await assert.rejects(editor.prepareProjectCode(), error => error === failure);
  assert.equal(window.auditGeneration.host.length, 0);
});
