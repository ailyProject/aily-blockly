import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { classifyR3StoppedApplication, assertR3StoppedUi, assertR3StopApplicationDispatches,
  readR3CandidatePublication } from './r3-chat-stop-presentation.mjs'

const terminal = { interruptions: [{ text: '用户暂停', visible: true }], terminalErrorCards: [], abortErrorAlerts: [], terminalRetryButtons: 0 }
const unknown = { isError: true, result: { ok: false, code: 'ABS_OPERATION_CANCELLED', cancelled: true, publication: { status: 'UNKNOWN' } } }
const committed = { isError: false, result: { ok: true, publication: { status: 'COMMITTED' } } }
const ui = (status, tone) => ({ ...terminal, toolCards: [{ title: 'Abs Apply', status, tone }] })

test('R3 only shows a success card for actual COMMITTED and a neutral interrupted card for cancelled UNKNOWN', () => {
  assert.equal(assertR3StoppedUi(ui('', ''), 'apply-chat', committed).classification.publication, 'COMMITTED')
  assert.equal(assertR3StoppedUi(ui('已中断', 'neutral'), 'apply-chat', unknown).classification.publication, 'UNKNOWN')
  assert.equal(unknown.result.publication.status, 'UNKNOWN')
  assert.throws(() => assertR3StoppedUi(ui('', ''), 'apply-chat', unknown))
  assert.throws(() => assertR3StoppedUi(ui('已中断', 'error'), 'apply-chat', unknown))
  assert.throws(() => assertR3StoppedUi(ui('已中断', 'neutral'), 'apply-chat', committed))
  assert.throws(() => assertR3StoppedUi({ ...ui('已中断', 'neutral'), terminalErrorCards: ['Request failed'] }, 'apply-chat', unknown))
  for (const result of [
    { ...unknown.result, code: 'ABS_REAL_FAILURE' }, { ...unknown.result, cancelled: false },
    { ...unknown.result, publication: { status: 'NOT_COMMITTED' } },
    { ...unknown.result, publication: { status: 'COMMITTED' } },
  ]) assert.throws(() => classifyR3StoppedApplication({ ...unknown, result }))
})

test('R3 keeps recovery-owner cancellation and injected native failure under the existing strict contract', () => {
  const recovery = { ...ui('已中断', 'neutral'), toolCards: [
    { title: 'Abs Apply', status: '已中断', tone: 'neutral' }, { title: 'App Reload', status: '失败', tone: 'error' },
  ] }
  assert.equal(assertR3StoppedUi(recovery, 'recovery-owner').realNativeFailureRetained, true)
  assert.throws(() => assertR3StoppedUi({ ...recovery, toolCards: [recovery.toolCards[0], { ...recovery.toolCards[1], tone: 'neutral' }] }, 'recovery-owner'))
})

test('same-ID replay is rejected even when the two model tool calls appear valid', () => {
  const commands = [{ operation: 'abs_apply', requestId: 'old' }, { operation: 'abs_recovery', requestId: 'old' }, { operation: 'abs_apply', requestId: 'new' }]
  assertR3StopApplicationDispatches({ commands }, 'old', 'new')
  assert.throws(() => assertR3StopApplicationDispatches({ commands: [...commands, commands[0]] }, 'old', 'new'))
  assert.throws(() => assertR3StopApplicationDispatches({ commands }, 'old', 'old'))
})

test('actual publication-table read distinguishes accepted background fact without changing raw UNKNOWN or writing metadata', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'r3-stop-publication-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.mkdir(path.join(root, '.workspace-history'))
  const filename = path.join(root, '.workspace-history/workspace.json'), ref = { version: 1, id: 'original', revisionHash: 'a'.repeat(64) }
  const record = { version: 1, kind: 'abs_apply', requestId: 'old', ref, acceptance: { hash: 'b'.repeat(64), bytes: 100 } }
  const bytes = JSON.stringify({ version: 1, root, candidatePublications: { old: record } })
  await fs.writeFile(filename, bytes)
  assert.deepEqual(await readR3CandidatePublication(root, 'old', ref), record)
  assert.equal(await fs.readFile(filename, 'utf8'), bytes)
  assert.equal(unknown.result.publication.status, 'UNKNOWN')
  await assert.rejects(readR3CandidatePublication(root, 'foreign', ref))
  await assert.rejects(readR3CandidatePublication(root, 'old', { ...ref, revisionHash: 'c'.repeat(64) }))
  await fs.writeFile(filename, JSON.stringify({ version: 1, root: path.dirname(root), candidatePublications: { old: record } }))
  await assert.rejects(readR3CandidatePublication(root, 'old', ref))
})

test('R3 Stop source gates new B on exact original acceptance and actual Working successor', async () => {
  const source = await fs.readFile(new URL('../r3-chat-stop.acceptance.mjs', import.meta.url), 'utf8')
  const observer = source.slice(source.indexOf('const observe = async'), source.indexOf('const settle = async'))
  assert.match(observer, /readCandidateAcceptanceEvidence/)
  assert.match(observer, /if \(!originalWasAcceptedAtStop\)/)
  assert.match(observer, /observed\.at <= captured\.at/)
  assert.match(observer, /successor\.record\.base\.document/)
  assert.ok(observer.indexOf('evidence.originalAcceptance = accepted') < observer.indexOf('gates.release(message.toolCallId)'))
  assert.doesNotMatch(source, /await assertApplied\(evidence\.tools\.find[^\n]+\n\s*assert\.deepEqual\(evidence\.afterStop/)
  assert.match(source, /firstRawCommitted \? 2 : 1/)
  assert.match(source, /assertR3StopApplicationDispatches/)
})
