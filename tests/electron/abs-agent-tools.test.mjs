import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { createRecoveredAgentHarness } from '../../e2e/fixtures/abs-agent-tools.mjs'

test('R4 Agent harness retains real permissions, private-file fences and persistent session ownership', async () => {
  const agentRoot = process.env.AILY_ABS_AGENT_ROOT
  const outputRoot = process.env.AILY_ABS_AGENT_TEST_ROOT
  assert.ok(agentRoot && path.isAbsolute(agentRoot), 'AILY_ABS_AGENT_ROOT must identify the private built Agent')
  assert.ok(outputRoot && path.isAbsolute(outputRoot), 'AILY_ABS_AGENT_TEST_ROOT must identify private test output')
  const permitted = path.resolve('tests/test-results')
  const relative = path.relative(permitted, path.resolve(outputRoot))
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Use a distinct tests/test-results child')
  const root = path.join(outputRoot, `agent-helper-${Date.now()}`)
  const source = path.join(root, 'source')
  const profile = path.join(root, 'profile')
  const notes = path.join(source, 'notes.txt')
  const privateFile = path.join(source, '.workspace-history', 'fixture-protected.txt')
  await mkdir(source, { recursive: true })
  await mkdir(profile)
  await mkdir(path.dirname(privateFile))
  // Fixture bootstrap precedes the SDK session. All exercised reads/writes use tools.
  await writeFile(path.join(source, 'package.json'), '{"name":"agent-helper-fixture","type":"arduino"}')
  await writeFile(notes, 'before\n')
  await writeFile(privateFile, 'private history sentinel\n')
  process.env.PI_CODING_AGENT_DIR = profile
  process.env.PI_OFFLINE = '1'
  const originalFetch = globalThis.fetch
  let externalFetches = 0
  globalThis.fetch = async () => { externalFetches++; throw new Error('This module integration test is offline') }
  let harness
  let approveWrites = true
  const legacyObservation = { version: 1, project: source, status: 'blocked', absHash: 'a'.repeat(64), updatedAt: 1,
    error: 'Historical observation only; this DTO must not become a current writer or permission override' }
  const configure = {
    agentRoot, sourceProject: source, globalRoot: root, profileRoot: profile, persistToolTranscript: true,
    async configureRegistry(context) {
      const libraryTools = await import(pathToFileURL(path.join(agentRoot,
        'dist/blockly/tools/registrars/library/lib-install-local.js')).href)
      libraryTools.registerLibInstallLocal(context)
    },
    permissionApproval(request) {
      assert.equal(request.permissionMode, 'default')
      // Even explicit UI approval cannot grant a generic writer private History IO.
      return ['read', 'write', 'edit'].includes(request.toolName)
        && [notes, privateFile].includes(request.input?.path)
        && (request.toolName === 'read' || approveWrites)
    }
  }
  try {
    harness = await createRecoveredAgentHarness({
      ...configure, initialEntries: [{ type: 'custom', customType: 'aily.abs-workflow', data: legacyObservation }]
    })
    assert.ok(harness.registry.definitions().some(tool => tool.name === 'lib_install_local'),
      'The product acceptance can register the actual managed local-library tool')
    assert.equal((await harness.readText(notes)).trim(), 'before')
    await harness.write(notes, 'written\n')
    await harness.edit(notes, 'written', 'edited')
    assert.equal((await harness.readText(notes)).trim(), 'edited')
    assert.equal(typeof harness.guard.recordConflict, 'undefined', 'Retired guard must not authorize or block new writes')
    assert.deepEqual(harness.guard.snapshot(source), legacyObservation, 'Real session_start restores historical observations')
    approveWrites = false
    await harness.call('write', { path: notes, content: 'must not execute' }, { expectError: true })
    assert.equal((await harness.readText(notes)).trim(), 'edited')
    approveWrites = true
    await harness.call('write', { path: privateFile, content: 'must not overwrite private History' }, { expectError: true })
    assert.equal(await readFile(privateFile, 'utf8'), 'private history sentinel\n')
    assert.deepEqual(harness.guard.snapshot(source), legacyObservation)
    const proof = harness.proof()
    assert.equal(proof.permissionMode, 'default')
    assert.equal(proof.sessionUserMessages, 0)
    assert.ok(proof.permissionPrompts > 0)
    assert.ok(proof.permissionDecisions.every(decision => decision.sessionGrant === false))
    assert.ok(proof.permissionDecisions.some(decision => decision.approved === false))
    await harness.settle()
    const started = await harness.beginTurn('Observe the existing notes without changing the project.')
    assert.equal(started.actualSdkBeforeAgentStart, true)
    assert.equal(harness.history.hasCandidateOwner, true, 'Current candidates require a genuine SDK user branch')
    const sessionFile = harness.sessionFile(), snapshot = harness.sessionSnapshot(), sessionId = snapshot[0].id
    assert.ok(path.isAbsolute(sessionFile))
    assert.ok((await readFile(sessionFile, 'utf8')).includes('Observe the existing notes'))
    await harness.settle()
    await harness.dispose()
    harness = await createRecoveredAgentHarness({ ...configure, sessionFile, restoreHistory: true })
    assert.equal(harness.sessionSnapshot()[0].id, sessionId, 'Resume the exact persistent SDK session, not a replacement owner')
    assert.deepEqual(harness.guard.snapshot(source), legacyObservation)
    assert.equal(harness.proof().sessionUserMessages, 1)
    assert.equal((await harness.readText(notes)).trim(), 'edited')
    const restoredSnapshot = harness.sessionSnapshot()
    await harness.dispose()
    harness = await createRecoveredAgentHarness({ ...configure, sessionSnapshot: restoredSnapshot, restoreHistory: true })
    assert.equal(harness.sessionSnapshot()[0].id, sessionId, 'Snapshot compatibility retains the original SDK owner identity')
    assert.deepEqual(harness.guard.snapshot(source), legacyObservation)
    assert.equal(harness.proof().sessionUserMessages, 1, 'Restoration must not invent another user turn')
    assert.notEqual(harness.sessionFile(), sessionFile)
    assert.ok((await readFile(harness.sessionFile(), 'utf8')).includes(sessionId))
    assert.equal(externalFetches, 0)
    console.log(JSON.stringify({ ok: true, actualSdkCoreReadWriteEdit: true,
      deniedWritePreservesSource: true, privateHistoryWriteDenied: true,
      historicalObservationRestored: true, persistentSessionResumed: true,
      snapshotResumedWithOriginalOwner: true, restoredUserMessages: harness.proof().sessionUserMessages, externalFetches, proof }))
  } finally {
    await harness?.dispose()
    globalThis.fetch = originalFetch
  }
})
