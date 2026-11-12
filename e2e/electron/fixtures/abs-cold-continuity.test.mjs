import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import vm from 'node:vm'
import crypto from 'node:crypto'
import { assertColdCandidateProof, assertColdPendingIntent, assertPostAdoptionArchiveFailure, installColdCandidateArchiveRenameFault, sourceHash, waitForColdSessionOpen } from './abs-cold-continuity.mjs'

const project = path.resolve('owned/cold-project'), baseSource = 'number(100)\nnumber(200)\n'
const source = baseSource.replace('100', '101'), generation = 'original-g0'
const args = { project, sessionId: 'same-chat', generation, source }
const pending = { project, status: 'blocked', intentGeneration: generation,
  retainedCandidate: { hash: sourceHash(source) }, retainedCandidateBackup: { recordHash: sourceHash('record') } }
const snapshot = () => ({ sessionId: args.sessionId, cwd: project,
  entries: [{ type: 'custom', customType: 'aily.abs-workflow', data: structuredClone(pending) }] })
const record = () => ({ candidate: { source, hash: sourceHash(source), intentGeneration: generation,
  sourceEdits: [[{ start: 7, end: 10, text: '101' }]], editProof: { version: 2,
    key: path.join(project, 'project.abs'), hash: sourceHash(source), mapHash: 'saved-map',
    origin: { sourceKey: path.join(project, 'project.abs'), generation, baseAbsHash: sourceHash(baseSource),
      mapHash: 'original-map', acceptedMapHash: 'saved-map' },
    steps: [{ before: sourceHash(baseSource), after: sourceHash(source), edits: [{ start: 7, end: 10, text: '101' }] }] } } })

test('accepts a real-shaped original pending A across cold continuation', () => {
  assert.deepEqual(assertColdPendingIntent(snapshot(), args), pending)
  assert.equal(assertColdCandidateProof(record(), { ...args, baseSource }).acceptedMapHash, 'saved-map')
})

test('rejects a fresh session, substituted intent, missing archive and an in-flight application', () => {
  for (const mutate of [value => { value.sessionId = 'new-chat' },
    value => { value.entries[0].data.intentGeneration = 'new-g1' },
    value => { delete value.entries[0].data.retainedCandidateBackup },
    value => { value.entries[0].data.applicationRequestId = 'unsettled' }]) {
    const value = snapshot(); mutate(value); assert.throws(() => assertColdPendingIntent(value, args))
  }
})

test('requires complete replayable source evidence and the old proven origin', () => {
  for (const mutate of [value => { value.candidate.sourceEdits[0][0].text = '999' },
    value => { value.candidate.editProof.origin.generation = 'new-g1' },
    value => { delete value.candidate.editProof },
    value => { value.candidate.editProof.origin.baseAbsHash = sourceHash(source) }]) {
    const value = record(); mutate(value); assert.throws(() => assertColdCandidateProof(value, { ...args, baseSource }))
  }
})

function isolatedFaultFixture(mutate = () => {}) {
  const root = path.resolve('aily-project/dev-tests/owned/project'), canonical = 'number(100)\n'
  const oldMapHash = sourceHash('old-map').slice(7), mapBytes = Buffer.from(JSON.stringify({ generation: 'actual-g1', baseAbsHash: sourceHash(canonical) }))
  const archive = record(); archive.version = 1; archive.kind = 'abs-candidate'; archive.project = root
  archive.candidate.editProof.origin.sourceKey = path.join(root, 'project.abs')
  archive.candidate.editProof.origin.mapHash = oldMapHash
  archive.candidate.editProof.mapHash = sourceHash(mapBytes).slice(7)
  archive.candidate.editProof.origin.acceptedMapHash = sourceHash(mapBytes).slice(7)
  mutate(archive)
  const archiveBytes = Buffer.from(JSON.stringify(archive)), directory = path.join(root, '.aily/abs-sync/recoveries')
  const target = path.join(directory, 'candidate-' + sourceHash(archiveBytes).slice(7) + '.json'), temporary = path.join(directory, '.abs-sync-1234.tmp')
  const files = new Map([[temporary, archiveBytes], [path.join(root, 'project.abs.map.json'), mapBytes],
    [path.join(root, 'project.abi'), Buffer.from('{"actual":"native"}')], [path.join(root, 'project.abs'), Buffer.from(canonical)]])
  const delegated = [], original = (...args) => delegated.push(args)
  const fakeFs = { renameSync: original, realpathSync: value => value, readFileSync: value => { assert.ok(files.has(value)); return files.get(value) } }
  const context = vm.createContext({ process: { getBuiltinModule: name => ({ fs: fakeFs, path, crypto })[name] } })
  const config = { project: root, candidateHash: sourceHash(source), generation, initialMapHash: oldMapHash }
  const result = vm.runInContext(`(${installColdCandidateArchiveRenameFault.toString()})(${JSON.stringify(config)})`, context)
  return { context, fakeFs, delegated, original, result, target, temporary }
}

test('real-IO seam fails only the exact verified successor proof append once, then delegates and restores', () => {
  const fixture = isolatedFaultFixture()
  assert.equal(fixture.result.available, true)
  assert.throws(() => fixture.fakeFs.renameSync(fixture.temporary, fixture.target), error => error.code === 'EIO')
  fixture.fakeFs.renameSync(fixture.temporary, fixture.target)
  assert.equal(fixture.context.__ailyColdArchiveFault.snapshot().injected, 1)
  assert.equal(fixture.delegated.length, 1)
  fixture.context.__ailyColdArchiveFault.restore()
  assert.equal(fixture.fakeFs.renameSync, fixture.original)
})

test('a missing overlay-local map does not prevent the exact accepted canonical successor fault', () => {
  const fixture = isolatedFaultFixture(value => { value.candidate.editProof.mapHash = null })
  assert.throws(() => fixture.fakeFs.renameSync(fixture.temporary, fixture.target), error => error.code === 'EIO')
  assert.equal(fixture.context.__ailyColdArchiveFault.snapshot().injected, 1)
})

test('archive fault never replaces absent preload capabilities or unrelated/old proof writes', () => {
  const unavailable = vm.runInNewContext(`(${installColdCandidateArchiveRenameFault.toString()})({})`)
  assert.equal(unavailable.available, false)
  for (const mutate of [value => { value.candidate.intentGeneration = 'other-g' },
    value => { delete value.candidate.editProof.origin.acceptedMapHash },
    value => { value.candidate.editProof.origin.acceptedMapHash = sourceHash('unrelated-map').slice(7) },
    value => { value.candidate.editProof.origin.generation = 'actual-g1' }]) {
    const fixture = isolatedFaultFixture(mutate)
    fixture.fakeFs.renameSync(fixture.temporary, fixture.target)
    fixture.fakeFs.renameSync('/unrelated/source', '/unrelated/target')
    assert.equal(fixture.context.__ailyColdArchiveFault.snapshot().injected, 0)
    assert.equal(fixture.delegated.length, 2)
  }
})

test('archive failure requires a real COMMITTED native save and successful History adoption', () => {
  const tool = { isError: true, result: { ok: false, code: 'ABS_CANDIDATE_PROOF_ARCHIVE_FAILED',
    publication: { status: 'COMMITTED' }, stateVerification: { ok: true, candidateApplied: false },
    historySynchronization: { ok: true, canonicalWritten: false }, receipt: { version: 2, output: { binding: { generation: 'actual-g1' } } } } }
  assert.equal(assertPostAdoptionArchiveFailure(tool).generation, 'actual-g1')
  for (const mutate of [value => { value.result.publication.status = 'UNKNOWN' },
    value => { value.result.historySynchronization.ok = false },
    value => { value.result.code = 'ABS_HISTORY_ADOPTION_FAILED' },
    value => { value.result.stateVerification.candidateApplied = true }]) {
    const value = structuredClone(tool); mutate(value); assert.throws(() => assertPostAdoptionArchiveFailure(value))
  }
})

test('waits for the exact UI open acknowledgement and registry before reading its session', async () => {
  const events = [], replies = [], command = { id: 'ui-open-1', attempt: 1, sessionId: 'same-chat', cwd: project, type: 'session.openSubscribe' }
  let clock = 0, registryReads = 0
  const result = await waitForColdSessionOpen({ commands: () => [command], responses: () => replies,
    project, sessionId: 'same-chat', attempt: 1, timeoutMs: 20, now: () => clock,
    sleep: async () => { clock++; if (clock === 1) { events.push('actual-ui-ack'); replies.push({ id: command.id, ok: true, subscribed: true }) } },
    readRegistry: async () => { assert.ok(events.includes('actual-ui-ack')); events.push('registry'); return ++registryReads === 1 ? [] : [{ sessionId: 'same-chat' }] } })
  assert.equal(result.registryReady, true)
  events.push('session.read')
  assert.deepEqual(events, ['actual-ui-ack', 'registry', 'registry', 'session.read'])
})

test('a failed original UI open is never repaired or followed by a registry/session read', async () => {
  let reads = 0
  await assert.rejects(waitForColdSessionOpen({ project, sessionId: 'same-chat', attempt: 1,
    commands: () => [{ id: 'failed-ui-open', attempt: 1, sessionId: 'same-chat', cwd: project, type: 'session.openSubscribe' }],
    responses: () => [{ id: 'failed-ui-open', ok: false, errorCode: 'REAL_OPEN_FAILURE' }],
    readRegistry: async () => { reads++; return [] } }), /REAL_OPEN_FAILURE/)
  assert.equal(reads, 0)
})

test('unrelated acknowledgements cannot stand in for the original open', async () => {
  let clock = 0, reads = 0
  await assert.rejects(waitForColdSessionOpen({ project, sessionId: 'same-chat', attempt: 1, timeoutMs: 3,
    now: () => clock, sleep: async () => { clock++ },
    commands: () => [{ id: 'original-ui-open', attempt: 1, sessionId: 'same-chat', cwd: project, type: 'session.openSubscribe' }],
    responses: () => [{ id: 'another-ui-open', ok: true, subscribed: true }],
    readRegistry: async () => { reads++; return [] } }), /automatically reopen/)
  assert.equal(reads, 0)
})
