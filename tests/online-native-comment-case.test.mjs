import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import test from 'node:test'
import { assertOnlineNativeReceipts, assertNativeCommentEditPreserved } from '../e2e/fixtures/online-native-comment-case.mjs'

const project = path.join(os.tmpdir(), 'online-native-comment-fixture')
function session() {
  const candidate = { hash: 'sha256:' + 'a'.repeat(64), bytes: 100 }, base = { generation: 'original-generation' }
  const messages = []
  const add = (id, name, result, details = {}) => {
    messages.push({ role: 'assistant', content: [{ type: 'toolCall', id, name: 'tool_invoke', arguments: { name, arguments: { project } } }] })
    messages.push({ role: 'toolResult', toolCallId: id, toolName: name, isError: false, content: [], details: { ...details, result } })
  }
  add('edit', 'edit', undefined, { absEdits: [{ path: path.join(project, 'project.abs'), publication: 'published', changed: true, after: candidate }] })
  messages[0].content[0] = { type: 'toolCall', id: 'edit', name: 'edit', arguments: { path: path.join(project, 'project.abs') } }
  add('validate', 'abs_validate', { ok: true, project, receipt: { base, candidate, validation: { ok: true, scope: 'prepared-generation' } } })
  add('apply', 'abs_apply', { ok: true, project, applyVerification: { ok: true },
    receipt: { base, candidate, validation: { ok: true, scope: 'complete-generation' } } })
  add('build', 'project_build', { ok: true, project, verification: { scope: 'project-compilation', status: 'passed' },
    buildReceipt: { version: 1, project, requestId: 'real-original-build', state: 'completed' } })
  return { messages }
}
function native() {
  const workspace = { blocks: { blocks: [{ id: 'setup', type: 'arduino_setup', x: 30, y: 40, deletable: false,
    icons: { comment: { text: 'closed', pinned: false, x: 300, y: 200, width: 260, height: 130 } },
    extraState: { opaque: { x: 9, y: 8 } } }] } }
  return { workspace, document: { schemaVersion: 3, activePageId: 'one', openedPageIds: ['one'], extension: { retained: true },
    pages: [{ id: 'one', title: 'Main', content: structuredClone(workspace), viewState: { scale: 1 } },
      { id: 'other', title: 'Inactive', content: { blocks: { blocks: [] }, retained: 'data' } }], sharedModel: { procedureBlocks: [], retained: [1, 2] } },
  activity: { blocked: false, recoveryRequired: false } }
}
function edited(before) {
  const after = structuredClone(before)
  after.workspace.blocks.blocks[0].inputs = { BODY: { block: { id: 'print', type: 'serial_print',
    inputs: { TEXT: { block: { id: 'text', type: 'text', fields: { TEXT: 'marker' } } } } } } }
  after.document.pages[0].content = structuredClone(after.workspace)
  return after
}
test('accepts original SDK IDs with matching native edit, validate, apply and completed build evidence', () => {
  const result = assertOnlineNativeReceipts(session(), project)
  assert.equal(result.evidence.matchedOriginalToolIds, true)
})
test('an assistant completion claim cannot replace real tool results', () => {
  assert.throws(() => assertOnlineNativeReceipts({ messages: [{ role: 'assistant', content: [{ type: 'text', text: 'compiled successfully' }] }] }, project))
})
test('accepts only an exact owned workspace-history overlay bound to the logical ABS edit and candidate', () => {
  const value = session(), relative = '.workspace-history/overlays/1a40ce77-3f99-4eec-8db3-97d0c2032a95/view/project.abs'
  value.messages[1].details.absEdits[0].path = path.join(project, relative)
  assert.equal(assertOnlineNativeReceipts(value, project).evidence.matchedOriginalToolIds, true)
  const external = structuredClone(value); external.messages[1].details.absEdits[0].path = path.join(project, '../another', relative)
  assert.throws(() => assertOnlineNativeReceipts(external, project))
  const wrongLogical = structuredClone(value); wrongLogical.messages[0].content[0].arguments.path = path.join(project, 'other.abs')
  assert.throws(() => assertOnlineNativeReceipts(wrongLogical, project))
  const preprocess = session(); preprocess.messages.at(-1).details.result.verification.scope = 'project-preprocessing'
  assert.throws(() => assertOnlineNativeReceipts(preprocess, project))
})
test('refuses failed/unknown builds, duplicate results and a candidate unrelated to the native edit', () => {
  const failed = session(); failed.messages.at(-1).details.result.ok = false
  assert.throws(() => assertOnlineNativeReceipts(failed, project))
  const pending = session(); pending.messages.at(-1).details.result.buildReceipt.state = 'unknown'
  assert.throws(() => assertOnlineNativeReceipts(pending, project))
  const duplicate = session(); duplicate.messages.push(structuredClone(duplicate.messages.at(-1)))
  assert.throws(() => assertOnlineNativeReceipts(duplicate, project))
  const mismatched = session(); mismatched.messages[1].details.absEdits[0].after = { hash: 'sha256:' + 'b'.repeat(64), bytes: 100 }
  assert.throws(() => assertOnlineNativeReceipts(mismatched, project))
})
test('preserves complete comments and opaque/inactive/shared metadata across the intended two-block addition', () => {
  const before = native(); assert.equal(assertNativeCommentEditPreserved(before, edited(before), 'marker').allOriginalAttributesPreserved, true)
})
test('refuses lost closed coordinates or unrelated document metadata', () => {
  const before = native(), lost = edited(before); delete lost.workspace.blocks.blocks[0].icons.comment.x
  assert.throws(() => assertNativeCommentEditPreserved(before, lost, 'marker'))
  const inactive = edited(before); delete inactive.document.pages[1].content.retained
  assert.throws(() => assertNativeCommentEditPreserved(before, inactive, 'marker'))
  const shared = edited(before); shared.document.sharedModel.retained.pop()
  assert.throws(() => assertNativeCommentEditPreserved(before, shared, 'marker'))
})
