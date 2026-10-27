import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { createRecoveredAgentHarness } from '../../e2e/fixtures/abs-agent-tools.mjs'

test('actual Agent SDK/core tools retain normal permissions and source protection', async () => {
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
  await mkdir(source, { recursive: true })
  await mkdir(profile)
  // Fixture bootstrap precedes the SDK session. All exercised reads/writes use tools.
  await writeFile(path.join(source, 'package.json'), '{"name":"agent-helper-fixture","type":"arduino"}')
  await writeFile(notes, 'before\n')
  process.env.PI_CODING_AGENT_DIR = profile
  process.env.PI_OFFLINE = '1'
  const originalFetch = globalThis.fetch
  let externalFetches = 0
  globalThis.fetch = async () => { externalFetches++; throw new Error('This module integration test is offline') }
  let harness
  try {
    harness = await createRecoveredAgentHarness({
      agentRoot, sourceProject: source, globalRoot: root, profileRoot: profile,
      async configureRegistry(context) {
        const libraryTools = await import(pathToFileURL(path.join(agentRoot,
          'dist/blockly/tools/registrars/library/lib-install-local.js')).href)
        libraryTools.registerLibInstallLocal(context)
      },
      permissionApproval(request) {
        assert.equal(request.permissionMode, 'default')
        return ['read', 'write', 'edit'].includes(request.toolName)
          && request.input?.path === notes
          && (request.toolName === 'read' || !harness?.guard.snapshot(source)?.concurrentEdit)
      }
    })
    assert.ok(harness.registry.definitions().some(tool => tool.name === 'lib_install_local'),
      'The product acceptance can register the actual managed local-library tool')
    assert.equal((await harness.readText(notes)).trim(), 'before')
    await harness.write(notes, 'written\n')
    await harness.edit(notes, 'written', 'edited')
    assert.equal((await harness.readText(notes)).trim(), 'edited')
    harness.guard.recordConflict(source, { ok: false, code: 'ABS_SOURCE_CONFLICT', error: 'Retain source protection' })
    const before = harness.guard.snapshot(source)
    await harness.call('write', { path: notes, content: 'must not execute' }, { expectError: true })
    assert.deepEqual(harness.guard.snapshot(source), before)
    assert.equal((await harness.readText(notes)).trim(), 'edited')
    const proof = harness.proof()
    assert.equal(proof.permissionMode, 'default')
    assert.equal(proof.sessionUserMessages, 0)
    assert.ok(proof.permissionPrompts > 0)
    assert.ok(proof.permissionDecisions.every(decision => decision.sessionGrant === false))
    assert.equal(proof.calls.length, 6)
    assert.equal(externalFetches, 0)
    console.log(JSON.stringify({ ok: true, actualSdkCoreReadWriteEdit: true,
      protectedSourceWriteDenied: true, externalFetches, proof }))
  } finally {
    await harness?.dispose()
    globalThis.fetch = originalFetch
  }
})
