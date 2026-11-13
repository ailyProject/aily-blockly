import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import path from 'node:path'

export const sourceHash = source => 'sha256:' + createHash('sha256').update(source).digest('hex')
const same = (left, right) => typeof left === 'string' && typeof right === 'string'
  && path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()

/** Read-only assertions over real session records; never restores a view or
 * manufactures a generation, origin, application receipt, or tool result. */
export function assertColdPendingIntent(snapshot, { project, sessionId, generation, source }) {
  assert.equal(snapshot.sessionId, sessionId, 'Cold continuation must keep the original Chat session')
  assert.ok(same(snapshot.cwd, project), 'Cold continuation must keep the original project root')
  const records = (snapshot.entries ?? []).filter(entry => entry.type === 'custom'
    && entry.customType === 'aily.abs-workflow' && same(entry.data?.project, project))
  const pending = records.at(-1)?.data
  assert.ok(pending, 'The actual tool-created pending workflow must have a persistent session entry')
  assert.equal(pending.status, 'blocked')
  assert.equal(pending.intentGeneration, generation, 'Saving and restarting cannot replace the original requested intent')
  assert.equal(pending.retainedCandidate?.hash, sourceHash(source))
  assert.equal(pending.applicationRequestId, undefined, 'The first turn must not have applied or submitted A')
  for (const field of ['concurrentEdit', 'historyPending', 'resolutionPending'])
    assert.ok(!pending[field], `The pending candidate cannot carry an unrelated ${field} gate`)
  assert.ok(pending.retainedCandidateBackup, 'Cold recovery needs the actual immutable project-local backup')
  return structuredClone(pending)
}

export function assertColdCandidateProof(record, { project, source, baseSource, generation }) {
  const candidate = record.candidate
  assert.equal(candidate.source, source)
  assert.equal(candidate.hash, sourceHash(source))
  assert.equal(candidate.intentGeneration, generation)
  let replay = baseSource
  assert.ok(candidate.sourceEdits?.length > 0, 'The actual tracked edit must retain its source edits')
  for (const batch of candidate.sourceEdits) {
    let previousStart = replay.length + 1
    for (const edit of [...batch].sort((a, b) => b.start - a.start)) {
      assert.ok(Number.isSafeInteger(edit.start) && Number.isSafeInteger(edit.end)
        && edit.start >= 0 && edit.start <= edit.end && edit.end <= replay.length && edit.end <= previousStart)
      previousStart = edit.start
      replay = replay.slice(0, edit.start) + edit.text + replay.slice(edit.end)
    }
  }
  assert.equal(replay, source, 'Source evidence must exactly replay the original baseline into A')
  const proof = candidate.editProof
  assert.equal(proof?.version, 2)
  assert.ok(path.isAbsolute(proof.key) && path.basename(proof.key) === 'project.abs',
    'The proof key identifies the actual working view, which may live in the SDK overlay')
  assert.equal(proof.hash, sourceHash(source))
  assert.equal(proof.origin?.generation, generation)
  assert.ok(same(proof.origin.sourceKey, path.join(project, 'project.abs')))
  assert.equal(proof.origin.baseAbsHash, sourceHash(baseSource))
  assert.ok(proof.steps?.length > 0)
  return { hash: proof.hash, generation: proof.origin.generation, baseAbsHash: proof.origin.baseAbsHash,
    mapHash: proof.mapHash, originMapHash: proof.origin.mapHash,
    acceptedMapHash: proof.origin.acceptedMapHash ?? null, steps: proof.steps.length,
    sourceEditBatches: candidate.sourceEdits.length }
}

export function assertPostAdoptionArchiveFailure(tool) {
  assert.equal(tool?.isError, true, 'Keep the actual archive failure tool result')
  const result = tool.result
  assert.equal(result?.ok, false)
  assert.equal(result.code, 'ABS_CANDIDATE_PROOF_ARCHIVE_FAILED')
  assert.equal(result.publication?.status, 'COMMITTED', 'The preceding native save really completed')
  assert.equal(result.stateVerification?.ok, true)
  assert.equal(result.stateVerification?.candidateApplied, false)
  assert.equal(result.historySynchronization?.ok, true, 'The fault must follow verified History adoption')
  assert.equal(result.historySynchronization?.canonicalWritten, false)
  assert.equal(result.receipt?.version, 2)
  assert.ok(result.receipt.output?.binding)
  return result.receipt.output.binding
}

/** The UI sending an open command is not a completed open. Observe its exact
 * response before asking the read-only registry for the resulting session. */
export async function waitForColdSessionOpen({ commands, responses, project, sessionId, attempt, readRegistry,
  timeoutMs = 60000, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const deadline = now() + timeoutMs
  let command, response
  while (now() < deadline) {
    command = commands().find(value => value.attempt === attempt && value.sessionId === sessionId
      && ['session.open', 'session.openSubscribe'].includes(value.type))
    if (command) {
      assert.ok(same(command.cwd, project), 'The product must reopen the exact original project association')
      assert.ok(command.id, 'Correlate the real UI open response by command id')
      response = responses().find(value => value.id === command.id)
      if (response) {
        assert.equal(response.ok, true, `The original UI open failed: ${response.errorCode ?? 'unknown'} ${response.errorMessage ?? ''}`)
        if (command.type === 'session.openSubscribe') assert.equal(response.subscribed, true)
        else assert.equal(response.sessionId, sessionId)
        break
      }
    }
    await sleep(100)
  }
  assert.ok(command && response, 'The real Chat UI must automatically reopen its original session and receive a successful response')
  while (now() < deadline) {
    const sessions = await readRegistry()
    assert.ok(sessions.length <= 1, 'No replacement Chat session may stand in for the original')
    if (sessions.some(value => value.sessionId === sessionId)) return { command: structuredClone(command), response: structuredClone(response), registryReady: true }
    await sleep(100)
  }
  throw new Error('The UI open succeeded but the original session never became available in the actual runtime registry')
}

/** Self-contained so its source can run only in the real preload isolated
 * world. This fails one actual archive rename, not a controller/result/proof.
 * If Node fs is unavailable the caller must report this boundary uncovered. */
export function installColdCandidateArchiveRenameFault(config) {
  if (typeof globalThis.process?.getBuiltinModule !== 'function')
    return { available: false, reason: 'isolated_world_node_fs_unavailable' }
  const fs = globalThis.process.getBuiltinModule('fs'), path = globalThis.process.getBuiltinModule('path')
  const crypto = globalThis.process.getBuiltinModule('crypto')
  if (!fs?.renameSync || !path?.resolve || !crypto?.createHash)
    return { available: false, reason: 'isolated_world_node_fs_unavailable' }
  if (globalThis.__ailyColdArchiveFault) throw new Error('Do not install a second archive fault')
  const same = (left, right) => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
  if (!path.isAbsolute(config.project) || !/[/\\]aily-project[/\\]dev-tests[/\\]/i.test(config.project)
    || !same(fs.realpathSync(config.project), config.project)) throw new Error('Archive fault requires an exact owned physical root')
  if (!/^sha256:[a-f0-9]{64}$/.test(config.candidateHash) || !/^[a-f0-9]{64}$/.test(config.initialMapHash)
    || typeof config.generation !== 'string' || !config.generation) throw new Error('Archive fault requires exact original identities')
  const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
  const directory = path.join(config.project, '.aily', 'abs-sync', 'recoveries'), original = fs.renameSync
  const state = { available: true, renameCalls: 0, delegatedCalls: 0, candidateRenameCalls: 0, injected: 0, matches: [] }
  const delegate = args => { state.delegatedCalls++; return original.apply(fs, args) }
  const hook = function (...args) {
    state.renameCalls++
    const [from, target] = args
    if (typeof from !== 'string' || typeof target !== 'string'
      || !same(path.dirname(target), directory) || !same(path.dirname(from), directory)
      || !/^candidate-[a-f0-9]{64}\.json$/.test(path.basename(target))
      || !/^\.abs-sync-[a-f0-9-]+\.tmp$/.test(path.basename(from))) return delegate(args)
    state.candidateRenameCalls++
    if (state.injected) return delegate(args)
    const bytes = fs.readFileSync(from), record = JSON.parse(bytes.toString('utf8')), candidate = record.candidate
    const proof = candidate?.editProof, origin = proof?.origin
    const mapBytes = fs.readFileSync(path.join(config.project, 'project.abs.map.json')), mapHash = hash(mapBytes), map = JSON.parse(mapBytes.toString('utf8'))
    if (record.version !== 1 || record.kind !== 'abs-candidate' || !same(record.project, config.project)
      || path.basename(target) !== `candidate-${hash(bytes)}.json`
      || candidate?.hash !== config.candidateHash || 'sha256:' + hash(candidate.source) !== config.candidateHash
      || candidate.intentGeneration !== config.generation || proof?.hash !== config.candidateHash
      || origin?.generation !== config.generation || origin.mapHash !== config.initialMapHash
      || !same(origin.sourceKey, path.join(config.project, 'project.abs'))
      || !map.generation || map.generation === config.generation || mapHash === config.initialMapHash
      || origin.acceptedMapHash !== mapHash) return delegate(args)
    const abi = fs.readFileSync(path.join(config.project, 'project.abi')), abs = fs.readFileSync(path.join(config.project, 'project.abs'))
    if (map.baseAbsHash !== 'sha256:' + hash(abs)) throw new Error('Do not inject into an already inconsistent native publication')
    state.injected++
    state.matches.push({ target, recordHash: 'sha256:' + hash(bytes), candidateHash: candidate.hash,
      intentGeneration: candidate.intentGeneration, currentGeneration: map.generation, mapHash: 'sha256:' + mapHash,
      abiHash: 'sha256:' + hash(abi), absHash: 'sha256:' + hash(abs), code: 'EIO' })
    throw Object.assign(new Error('TEST_ONCE_POST_ADOPTION_CANDIDATE_ARCHIVE_EIO'), { code: 'EIO' })
  }
  fs.renameSync = hook
  globalThis.__ailyColdArchiveFault = {
    snapshot: () => JSON.parse(JSON.stringify(state)),
    restore: () => { if (fs.renameSync !== hook) throw new Error('Archive fault hook ownership changed'); fs.renameSync = original; return state.injected }
  }
  return { available: true, injected: 0 }
}
