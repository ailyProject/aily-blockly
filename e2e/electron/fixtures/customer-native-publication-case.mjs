import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { createRecoveredAgentHarness } from '../../fixtures/abs-agent-tools.mjs'
import { verifyCustomerCandidateRecord } from './customer-local-library.mjs'
import { assertCustomerRootLayoutOnly } from './customer-state-layout.mjs'

const mirrors = ['project.abi', 'project.abs', 'project.abs.map.json']
const hash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex')
const same = (a, b) => typeof a === 'string' && typeof b === 'string'
  && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
const snapshots = project => Promise.all(mirrors.map(name => fs.readFile(path.join(project, name))))

/** Real non-apply publication and cancellation. All native writes go through
 * registered SDK tools; the renderer callback is a complete read-only observer. */
export async function runCustomerNativePublicationCase({ project, suite, home, appData, agentRoot,
  hostPid, phase, evidence, originalDocument, readNativeDocument }) {
  assert.equal(typeof readNativeDocument, 'function')
  const absPath = path.join(project, 'project.abs'), candidateBackups = []
  const summary = evidence.nativePublication = { actualSdkTools: true, actualHistoryAbort: true,
    llmInvoked: false, noAbsApplyToolInvoked: true, cases: [] }
  const traces = evidence.tools = []
  let expected = structuredClone(originalDocument)
  for (const draft of [false, true]) {
    const label = draft ? 'pending-draft' : 'clean', profileRoot = path.join(suite, 'agent-profile-' + label)
    Object.assign(process.env, { AILY_LIBRARY_HOST_PID: String(hostPid), AILY_APPDATA_PATH: appData,
      PI_CODING_AGENT_DIR: profileRoot, HOME: home, USERPROFILE: home, PI_OFFLINE: '1' })
    const harness = await createRecoveredAgentHarness({ agentRoot, sourceProject: project, globalRoot: suite, profileRoot,
      persistToolTranscript: true,
      async configureRegistry(context) {
        const module = await import(pathToFileURL(path.join(agentRoot, 'dist/blockly/tools/registrars/project/blocks-tidy.js')).href)
        module.registerBlocksTidy(context)
      },
      permissionApproval(request) {
        assert.equal(request.permissionMode, 'default')
        if (['read', 'edit'].includes(request.toolName)) return same(request.input?.path, absPath)
        return same(request.input?.project, project)
          && ['abs_export', 'project_save', 'blocks_tidy', 'blocks_set_state'].includes(request.toolName)
      } })
    const call = async (name, input, structured = true) => {
      assert.notEqual(name, 'abs_apply', 'This case must never apply a candidate')
      await phase('native-no-apply-' + label + '-' + name)
      const result = await harness.call(name, input, { allowError: true })
      traces.push({ case: label, tool: name, action: input.action, isError: result.isError,
        result: { ok: result.structured?.ok, code: result.structured?.code,
          publication: result.structured?.publication, generation: result.structured?.generation,
          ...(result.isError ? { error: result.text.slice(0, 1800) } : {}) } })
      assert.equal(result.isError, false, name + ': ' + result.text.slice(0, 1500))
      if (structured) assert.equal(result.structured?.ok, true)
      return result.structured
    }
    let failure, stoppedMirrors
    try {
      assert.deepEqual(await readNativeDocument(), expected)
      const exported = await call('abs_export', { project })
      assert.equal(exported.publication?.status, 'COMMITTED')
      let candidateHash
      if (draft) {
        await call('read', { path: absPath, offset: 1, limit: 100 }, false)
        const source = await fs.readFile(harness.history.mapWorkspaceReadPath(absPath), 'utf8')
        const oldText = 'text("native_dependency_original")', newText = 'text("native_publication_draft_retained")'
        assert.equal(source.split(oldText).length, 2)
        await call('edit', { path: absPath, edits: [{ oldText, newText }] }, false)
        candidateHash = hash(source.replace(oldText, newText))
        assert.equal(hash(await fs.readFile(harness.history.mapWorkspaceReadPath(absPath))), candidateHash)
        const saved = await call('project_save', { project })
        assert.equal(saved.workflowVerification?.candidateApplied, false)
      } else {
        await call('blocks_tidy', { project })
        const arranged = await readNativeDocument()
        assertCustomerRootLayoutOnly(expected, arranged)
        expected = arranged
      }
      const root = expected.pages[0].content.blocks.blocks[0]
      const inspected = await call('blocks_set_state', { project, action: 'inspect', blockIds: [root.id], limit: 1 })
      assert.equal(inspected.instances.length, 1)
      const target = inspected.instances[0]
      assert.equal(target.blockId, root.id)
      assert.equal(target.editable, true)
      assert.equal(typeof inspected.expectedGeneration, 'string')
      const updated = await call('blocks_set_state', { project, action: 'update', expectedGeneration: inspected.expectedGeneration,
        changes: [{ blockId: target.blockId, collapsed: !target.collapsed }] })
      assert.equal(updated.publication?.status, 'COMMITTED')
      assert.equal(updated.stateVerification?.candidateApplied, false)
      const nextExpected = structuredClone(expected)
      if (!target.collapsed) nextExpected.pages[0].content.blocks.blocks[0].collapsed = true
      else delete nextExpected.pages[0].content.blocks.blocks[0].collapsed
      assert.deepEqual(await readNativeDocument(), nextExpected)
      expected = nextExpected
      if (!draft) await call('project_save', { project })

      let retained
      if (draft) {
        assert.equal(hash(await fs.readFile(harness.history.mapWorkspaceReadPath(absPath))), candidateHash,
          'Saving or changing native state cannot replace the tracked candidate')
        const guard = harness.guard.snapshot(project)
        assert.notEqual(guard.status, 'verified', 'No ABS candidate was applied')
        retained = await verifyCustomerCandidateRecord({ project, backup: guard.retainedCandidateBackup,
          candidateHash, intentGeneration: exported.generation })
        candidateBackups.push(retained)
      }
      const before = await snapshots(project)
      await phase('native-no-apply-' + label + '-abort-real-history')
      assert.equal(harness.history.hasActiveTurn, true)
      assert.equal(harness.history.isActiveTurnPreserved, false)
      await harness.history.abort()
      assert.equal(harness.history.hasActiveTurn, false)
      const after = await snapshots(project)
      for (let index = 0; index < mirrors.length; index++)
        assert.ok(after[index].equals(before[index]), 'Cancel changed the latest real native publication: ' + mirrors[index])
      assert.deepEqual(await readNativeDocument(), expected)
      stoppedMirrors = after
      assert.equal(expected.pages[0].content.blocks.blocks[0].fields.TEXT, 'native_dependency_original')
      if (retained) await verifyCustomerCandidateRecord({ project, backup: retained,
        candidateHash, intentGeneration: exported.generation })
      const proof = harness.proof()
      assert.equal(proof.calls.some(call => call.name === 'abs_apply'), false)
      summary.cases.push({ name: label, ok: true, exactThreeMirrorsPreserved: true, candidateApplied: false,
        draftPreservedInProjectBackup: !!retained,
        mirrors: mirrors.map((name, index) => ({ name, hash: hash(after[index]) })), sdkProof: proof })
    } catch (error) {
      failure = error
      summary.failure = { case: label, name: error.name, code: error.code,
        message: String(error.message).slice(0, 1800), ...(error.details ? { details: error.details } : {}),
        guard: harness.guard.snapshot(project) }
      throw error
    } finally {
      try { await harness.dispose() }
      catch (error) {
        summary.cleanupFailure = { case: label, name: error.name, message: String(error.message).slice(0, 1200) }
        if (!failure) throw error
      }
    }
    const afterShutdown = await snapshots(project)
    for (let index = 0; index < mirrors.length; index++)
      assert.ok(afterShutdown[index].equals(stoppedMirrors[index]), 'SDK shutdown changed the stopped native publication: ' + mirrors[index])
    summary.cases.at(-1).exactThreeMirrorsPreservedAfterSdkShutdown = true
  }
  evidence.cases.push({ name: 'native-save-tidy-state-export-stop-without-apply-preserves-native-and-pending-draft', ok: true })
  return { expectedDocument: expected, candidateBackups }
}
