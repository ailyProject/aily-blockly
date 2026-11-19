import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

const hash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex')
const inside = (root, file) => {
  const relative = path.relative(root, file)
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep)
}
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()

/** Observe actual native receipts; never write or reconstruct the test project. */
export async function assertCumulativeNativeEditChain({ session, agentProfile, marker, candidate }) {
  const edits = session.messages.filter(message => message.role === 'toolResult' && message.toolName === 'edit' && !message.isError)
    .flatMap(message => message.details?.absEdits ?? [])
  assert.equal(edits.length, 3, 'Every cumulative edit must return its own bounded change evidence')
  for (const [index, edit] of edits.entries()) {
    assert.equal(edit.publication, 'published'); assert.equal(edit.changed, true)
    assert.equal(edit.previousDraft?.status, 'available'); assert.equal(edit.previousDraft.readOnly, true)
    assert.ok(inside(agentProfile, edit.previousDraft.path), 'Only this isolated Agent profile owns its retained drafts')
    const previous = await fs.readFile(edit.previousDraft.path)
    assert.equal(hash(previous), edit.before.hash)
    assert.equal(edit.previousDraft.hash, edit.before.hash); assert.equal(previous.length, edit.before.bytes)
    if (index > 0) assert.deepEqual(edit.before, edits[index - 1].after, 'Cumulative edits must form one actual version chain')
  }
  const beforeComment = await fs.readFile(edits[2].previousDraft.path, 'utf8')
  assert.ok(beforeComment.includes(marker + ' phase-one') && !beforeComment.includes(marker + ' comments-only'))
  assert.equal(hash(beforeComment.replace(marker + ' phase-one', marker + ' comments-only')), edits[2].after.hash,
    'The third edit must change only the requested comment, not reconstruct an older program')
  assert.ok(candidate.includes(marker + ' comments-only') && !candidate.includes(marker + ' phase-one'),
    'The final comment change must reach the committed candidate')
  const calls = session.messages.filter(message => message.role === 'assistant').flatMap(message => message.content ?? [])
    .filter(item => item.type === 'toolCall')
  assert.ok(calls.some(call => call.name === 'read' && typeof call.arguments?.path === 'string'
    && same(call.arguments.path, edits[2].previousDraft.path)
    && session.messages.some(message => message.role === 'toolResult' && message.toolCallId === call.id && !message.isError)),
  'The Agent itself must read the readonly previous draft through its normal tool')
  return { edits: edits.map(({ before, after, editType, publication }) => ({ before, after, editType, publication })),
    previousDraftReadByAgent: true, commentOnly: true }
}
