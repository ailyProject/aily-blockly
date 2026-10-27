import assert from 'node:assert/strict'
import test from 'node:test'

import { withoutRepairRoute, withoutPreservationEntry, withLegacyPreservationOnly, resumeRepairTarget } from '../../e2e/fixtures/repair-environment-acceptance.mjs'

test('missing preservation index retains paired strong tool proof and reparents only removed metadata', () => {
  const body = { sourceViewPreservation: { sourceView: { reference: { manifestHash: 'actual-complete-proof' } } } }
  const snapshot = [{ type: 'session', id: 'actual-session' },
    { type: 'message', id: 'call', parentId: null, message: { role: 'assistant' } },
    { type: 'custom', id: 'index', parentId: 'call', customType: 'aily.workspace-history-preserved' },
    { type: 'message', id: 'result', parentId: 'index', message: { role: 'toolResult', details: { result: body } } }]
  const result = withoutPreservationEntry(snapshot)
  assert.equal(result[2].parentId, 'call')
  assert.deepEqual(result[2].message.details.result, body)
  assert.equal(snapshot[3].parentId, 'index')
})

test('legacy fault changes proof metadata without inventing candidate bytes or hashes', () => {
  const body = { sourceViewPreservation: { sourceView: { candidateHash: 'historical-hash',
    reference: { manifestHash: 'new-manifest' } } }, candidateArtifact: { hash: 'historical-hash', bytes: 23 } }
  const snapshot = [{ type: 'session', id: 'same-session' },
    { type: 'custom', customType: 'aily.workspace-history-preserved', data: { manifestHash: 'new-manifest' } },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'actual-call' }] } },
    { type: 'message', message: { role: 'toolResult', toolName: 'project_recover', toolCallId: 'actual-call',
      content: [{ type: 'text', text: JSON.stringify(body) }], details: { aily: { operation: 'project_recover' }, result: body } } }]
  const before = structuredClone(snapshot), result = withLegacyPreservationOnly(snapshot)
  assert.equal(result.length, 3)
  const migrated = result[2].message.details.result
  assert.equal(migrated.sourceViewPreservation.sourceView.reference, undefined)
  assert.equal(migrated.sourceViewPreservation.sourceView.candidateHash, body.candidateArtifact.hash)
  assert.deepEqual(migrated.candidateArtifact, body.candidateArtifact)
  assert.equal(result[2].message.toolCallId, 'actual-call')
  assert.deepEqual(snapshot, before)
})

test('route-loss fault retains exact session identity, association and source protection', () => {
  const snapshot = [{ type: 'session', id: 'actual-session' },
    { type: 'custom', customType: 'aily.workspace-history-preserved', data: { manifestHash: 'sealed' } },
    { type: 'custom', customType: 'aily.recovery-runtime-route', data: { environmentId: 'old-route' } },
    { type: 'custom', customType: 'aily.session-project-association', data: { projects: ['source', 'target'] } },
    { type: 'custom', customType: 'aily.abs-workflow', data: { concurrentEdit: true } }]
  const before = structuredClone(snapshot), result = withoutRepairRoute(snapshot)
  assert.deepEqual(result, [snapshot[0], snapshot[1], snapshot[3], snapshot[4]])
  assert.deepEqual(snapshot, before)
  assert.throws(() => withoutRepairRoute(result), /must have persisted/)
})

test('removed capability metadata does not break the actual SDK session branch', () => {
  const snapshot = [{ type: 'session', id: 'session-header' },
    { type: 'message', id: 'tool-call', parentId: null, message: { role: 'assistant' } },
    { type: 'custom', id: 'route', parentId: 'tool-call', customType: 'aily.recovery-runtime-route' },
    { type: 'message', id: 'tool-result', parentId: 'route', message: { role: 'toolResult' } }]
  const result = withoutRepairRoute(snapshot)
  assert.equal(result[2].parentId, 'tool-call')
  assert.equal(snapshot[3].parentId, 'route')
})

test('environment acceptance follows exact tool actions without manufacturing a new fork', async () => {
  const project = 'target', calls = [], environments = []
  const environment = { version: 2, project, hostPid: 123, epoch: 2 }
  const result = await resumeRepairTarget(async (name, input) => {
    calls.push({ name, input })
    return calls.length === 1 ? { nextAction: { tool: 'project_recover', input: {
      project, action: 'resume_environment', requestId: 'original-fork', resumeRequestId: 'stable-resume'
    } } } : { runtimeAssociation: { ok: true }, repairEnvironment: environment }
  }, project, value => environments.push(value))
  assert.equal(result.repairEnvironment, environment)
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[1].input, { project, action: 'resume_environment', requestId: 'original-fork',
    resumeRequestId: 'stable-resume' })
  assert.deepEqual(environments, [environment])
})

test('environment acceptance rejects a data fork or an action on a different target', async () => {
  for (const input of [{ project: 'target', action: 'fork' }, { project: 'different', action: 'resume_environment' }])
    await assert.rejects(resumeRepairTarget(async () => ({ nextAction: { tool: 'project_recover', input } }),
      'target', () => {}))
})
