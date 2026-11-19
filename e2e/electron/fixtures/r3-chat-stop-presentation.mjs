import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { assertUserStoppedUi, assertUserStopTerminalUi } from './abs-stop-presentation.mjs'

/** A cancelled observer cannot turn an UNKNOWN publication into either a
 * committed success or a confirmed rollback. Keep its exact raw tool facts. */
export function classifyR3StoppedApplication(tool) {
  assert.ok(tool?.result)
  const result = tool.result
  if (result.ok === true && result.publication?.status === 'COMMITTED') {
    assert.equal(tool.isError, false)
    return { publication: 'COMMITTED', observationCancelled: false }
  }
  assert.equal(tool.isError, true)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'ABS_OPERATION_CANCELLED')
  assert.equal(result.cancelled, true)
  assert.equal(result.publication?.status, 'UNKNOWN')
  return { publication: 'UNKNOWN', observationCancelled: true }
}

export function assertR3StoppedUi(ui, mode, tool) {
  if (mode === 'recovery-owner') return assertUserStoppedUi(ui, mode)
  assert.equal(mode, 'apply-chat')
  assertUserStopTerminalUi(ui)
  const classification = classifyR3StoppedApplication(tool)
  const applied = ui.toolCards.filter(item => /^(?:Abs Apply|abs_apply)$/iu.test(item.title.trim()))
  assert.equal(applied.length, 1)
  if (classification.publication === 'COMMITTED') {
    assert.notEqual(applied[0].tone, 'error')
    assert.equal(applied[0].status, '')
  } else {
    assert.equal(applied[0].tone, 'neutral')
    assert.match(applied[0].status.trim(), /^(?:已中断|已中斷|Interrupted)$/iu)
  }
  return { terminalAssistantNeutral: true, classification, toolCards: ui.toolCards }
}

export function assertR3StopApplicationDispatches(audit, originalRequestId, nextRequestId) {
  assert.ok(originalRequestId && nextRequestId && originalRequestId !== nextRequestId)
  const writes = audit.commands.filter(value => value.operation === 'abs_apply')
  assert.deepEqual(writes.map(value => value.requestId), [originalRequestId, nextRequestId],
    'One original apply and one fresh successor apply; no original replay')
}

/** The authoritative single publication table may contain acceptance even
 * when cancellation prevented its Pi checkpoint acknowledgement. Read only. */
export async function readR3CandidatePublication(project, requestId, ref) {
  const directory = path.join(project, '.workspace-history'), directoryStat = await fs.lstat(directory)
  assert.ok(directoryStat.isDirectory() && !directoryStat.isSymbolicLink())
  const filename = path.join(directory, 'workspace.json'), stat = await fs.lstat(filename)
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1)
  const workspace = JSON.parse(await fs.readFile(filename, 'utf8'))
  assert.equal(workspace.version, 1)
  assert.equal(path.resolve(workspace.root).toLowerCase(), path.resolve(project).toLowerCase())
  const publication = workspace.candidatePublications?.[requestId]
  assert.equal(publication?.version, 1); assert.equal(publication.kind, 'abs_apply')
  assert.equal(publication.requestId, requestId); assert.deepEqual(publication.ref, ref)
  return publication
}
