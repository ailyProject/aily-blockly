import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { onlineSaveServiceToolEvidence, onlineSaveToolEvidence, savedProgramHash } from '../../e2e/fixtures/online-project-save-receipt.mjs'

const project = path.resolve('tests/test-results/owned-online-save/project')
const document = () => ({ pages: [{ id: 'main', title: 'Main', viewState: { scale: 1 }, content: { blocks: { blocks: [
  { type: 'math_number', id: 'number-1', x: 10, y: 20, fields: { NUM: 61 }, collapsed: true, deletable: false,
    disabled: true, extraState: { nested: { x: 30, y: 40 } } },
] } } }], sharedModel: { variables: [{ id: 'v1', name: 'counter', type: 'int' }] } })
const snapshot = (deferred = false) => {
  const result = { ok: true, projectSaved: true, generatedCodePublished: true, partial: false,
    saveReceipt: { version: 1, requestId: 'original-save', project, operation: 'project_save', state: 'completed' },
    workspaceSaveVerification: { ok: true, candidateApplied: false } }
  return { messages: [
    { role: 'assistant', content: [{ type: 'toolCall', id: 'call-1', name: deferred ? 'tool_invoke' : 'project_save',
      arguments: deferred ? { name: 'project_save', arguments: { project } } : { project } }] },
    { role: 'toolResult', toolName: deferred ? 'tool_invoke' : 'project_save', toolCallId: 'call-1', isError: false,
      details: { result }, content: [{ type: 'text', text: JSON.stringify(result) }] },
  ] }
}

test('program proof ignores block layout and page view only, preserving real source data', () => {
  const a = document(), b = document()
  b.pages[0].viewState.scale = 0.75; b.pages[0].content.blocks.blocks[0].x = 900
  assert.equal(savedProgramHash(a), savedProgramHash(b))
  for (const mutate of [
    item => { item.pages[0].content.blocks.blocks[0].fields.NUM++ },
    item => { item.pages[0].content.blocks.blocks[0].collapsed = false },
    item => { item.pages[0].content.blocks.blocks[0].disabled = false },
    item => { item.pages[0].content.blocks.blocks[0].deletable = true },
    item => { item.pages[0].content.blocks.blocks[0].extraState.nested.x++ },
    item => { item.sharedModel.variables[0].name = 'other' },
    item => { item.pages[0].content.blocks.blocks[0].next = { block: { id: 'new', type: 'math_number' } } },
  ]) {
    const changed = document(); mutate(changed)
    assert.notEqual(savedProgramHash(a), savedProgramHash(changed))
  }
})

test('id/type inside fields, extraState, plugin payloads and variable models remain opaque ordered data', () => {
  const source = document(), target = source.pages[0].content.blocks.blocks[0]
  const rows = [{ id: 'b', type: 'point', x: 1, y: 2 }, { id: 'a', type: 'point', x: 3, y: 4 }]
  target.fields.PAYLOAD = { id: 'field-value', type: 'position', x: 5, y: 6 }
  target.extraState.rows = structuredClone(rows)
  source.pages[0].content.customPlugin = { blocks: { blocks: structuredClone(rows) } }
  source.sharedModel.variables = structuredClone(rows)
  for (const mutate of [
    item => { item.pages[0].content.blocks.blocks[0].fields.PAYLOAD.x++ },
    item => { item.pages[0].content.blocks.blocks[0].fields.PAYLOAD.y++ },
    item => { item.pages[0].content.blocks.blocks[0].extraState.rows[0].x++ },
    item => { item.pages[0].content.blocks.blocks[0].extraState.rows.reverse() },
    item => { item.pages[0].content.customPlugin.blocks.blocks[0].y++ },
    item => { item.pages[0].content.customPlugin.blocks.blocks.reverse() },
    item => { item.sharedModel.variables[0].x++ },
    item => { item.sharedModel.variables.reverse() },
  ]) {
    const changed = structuredClone(source); mutate(changed)
    assert.notEqual(savedProgramHash(source), savedProgramHash(changed))
  }
})

test('only declared Blockly roots and structural child links normalize layout', () => {
  const a = document(), b = document()
  for (const item of [a, b]) {
    item.pages[0].content.blocks.blocks.push({ id: 'a-root', type: 'math_number', x: 10, fields: { NUM: 2 } })
    item.pages[0].content.blocks.blocks[0].inputs = { VALUE: { block: { id: 'child', type: 'math_number', x: 20, fields: { NUM: 3 } } } }
    item.sharedModel.procedureBlocks = [{ id: 'proc', type: 'procedure', x: 10, next: { block: { id: 'stmt', type: 'statement', y: 3 } } }]
  }
  b.pages[0].content.blocks.blocks[0].inputs.VALUE.block.x = 999
  b.pages[0].content.blocks.blocks.reverse()
  b.sharedModel.procedureBlocks[0].next.block.y = 999
  assert.equal(savedProgramHash(a), savedProgramHash(b))
  b.sharedModel.procedureBlocks[0].next.block.disabled = true
  assert.notEqual(savedProgramHash(a), savedProgramHash(b))
})

for (const deferred of [false, true]) test(`real SDK ${deferred ? 'deferred' : 'direct'} save result is matched by original ID`, () => {
  const proof = onlineSaveToolEvidence(snapshot(deferred), project)
  assert.equal(proof.toolCalls, 1); assert.equal(proof.toolResults, 1)
  assert.equal(proof.sdkTool, deferred ? 'tool_invoke' : 'project_save')
  assert.equal(proof.saved.workspaceSaveVerification.ok, true)
})

test('service proof binds the exact SDK call ID before accepting a deferred stream label', () => {
  const sdk = onlineSaveToolEvidence(snapshot(), project), idHash = sdk.toolCallIdSha256
  for (const name of ['project_save', 'tool_invoke']) {
    const proof = onlineSaveServiceToolEvidence({ operations: [{ toolCalls: [{ name: 'read', idHash: 'other' }, { name, idHash }] }] }, sdk)
    assert.equal(proof.serviceToolCalls, 1); assert.equal(proof.wireToolName, name)
  }
  for (const operations of [
    [{ toolCalls: [{ name: 'project_save', idHash: 'another-id' }] }],
    [{ toolCalls: [{ name: 'project_save', idHash }] }, { toolCalls: [{ name: 'tool_invoke', idHash }] }],
    [{ toolCalls: [{ name: 'write', idHash }] }],
  ]) assert.throws(() => onlineSaveServiceToolEvidence({ operations }, sdk))
})

test('text-only SDK business result retains partial and is never mistaken for verified save', () => {
  const source = snapshot(); delete source.messages[1].details
  assert.equal(onlineSaveToolEvidence(source, project).saved.ok, true)
  const partial = JSON.parse(source.messages[1].content[0].text); partial.partial = true
  source.messages[1].content[0].text = JSON.stringify(partial)
  assert.throws(() => onlineSaveToolEvidence(source, project))
})

test('duplicate model calls, duplicate committed results, wrong target and mutation tools fail closed', () => {
  for (const mutate of [
    item => { item.messages[0].content.push({ ...item.messages[0].content[0], id: 'replayed' }) },
    item => { item.messages.push(item.messages[1]) },
    item => { item.messages[0].content[0].arguments.project = path.join(project, 'another') },
    item => { item.messages[0].content[0].arguments.save_request_id = 'another-model-issued-tool' },
    item => { item.messages[1].isError = true },
    item => { item.messages[1].details.result.partial = true },
    item => { item.messages[1].details.result.ok = false },
    item => { item.messages[1].details.result.saveReceipt.state = 'unknown' },
    item => { item.messages[1].details.result.workspaceSaveVerification.ok = false },
    item => { item.messages[1].details.result.workspaceSaveVerification.candidateApplied = true },
    item => { item.messages[0].content.push({ type: 'toolCall', id: 'write-call', name: 'tool_invoke', arguments: { name: 'write', arguments: {} } }) },
  ]) {
    const source = snapshot(); mutate(source)
    assert.throws(() => onlineSaveToolEvidence(source, project))
  }
})
