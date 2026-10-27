import assert from 'node:assert/strict'

function withoutCustomEntries(snapshot, customType) {
  const entries = structuredClone(snapshot), byId = new Map(entries.filter(entry => entry.id).map(entry => [entry.id, entry]))
  const removed = new Set(entries.filter(entry => entry.type === 'custom' && entry.customType === customType).map(entry => entry.id))
  return entries.filter(entry => entry.type !== 'custom' || entry.customType !== customType).map(entry => {
    let parent = entry.parentId
    const visited = new Set()
    while (parent && removed.has(parent)) {
      assert.ok(!visited.has(parent), 'The fixture session branch must be acyclic')
      visited.add(parent)
      parent = byId.get(parent)?.parentId ?? null
    }
    return entry.parentId === parent ? entry : { ...entry, parentId: parent }
  })
}

/** Fault injection removes only the route hint, never history, guards or scope. */
export function withoutRepairRoute(snapshot) {
  const result = withoutCustomEntries(snapshot, 'aily.recovery-runtime-route')
  assert.ok(result.length < snapshot.length, 'The real session must have persisted a repair route')
  return result
}

/** Lose only the redundant custom index; real paired tool proof stays intact. */
export function withoutPreservationEntry(snapshot) {
  const result = withoutCustomEntries(snapshot, 'aily.workspace-history-preserved')
  assert.ok(result.length < snapshot.length, 'The session must contain a real preservation entry')
  return result
}

/** Downgrade only capability metadata on real messages to model old clients. */
export function withLegacyPreservationOnly(snapshot) {
  const result = withoutCustomEntries(snapshot, 'aily.workspace-history-preserved')
  let changed = 0
  const downgrade = body => {
    const view = body?.sourceViewPreservation?.sourceView
    if (view?.reference?.manifestHash) { delete view.reference; changed++ }
    return body
  }
  for (const entry of result) {
    const message = entry.message
    if (message?.role !== 'toolResult' || message.toolName !== 'project_recover') continue
    if (message.details?.aily?.operation === 'project_recover') downgrade(message.details.result)
    for (const item of message.content ?? []) if (item.type === 'text') {
      try { item.text = JSON.stringify(downgrade(JSON.parse(item.text))) } catch {}
    }
  }
  assert.ok(changed > 0, 'Legacy fault injection requires real recovery messages with modern proof')
  return result
}

/** Follow actual tool-issued actions; never synthesize a replacement fork. */
export async function resumeRepairTarget(call, project, onEnvironment) {
  let result = await call('project_recover', { project, action: 'inspect_environment' }, false, true)
  const deadline = Date.now() + 90000
  while (!result.runtimeAssociation?.ok) {
    if (result.repairEnvironment?.hostPid) onEnvironment(result.repairEnvironment)
    assert.ok(Date.now() < deadline, 'A known-idle repair host must resume within the test deadline')
    assert.equal(result.nextAction?.tool, 'project_recover', JSON.stringify(result))
    assert.ok(['inspect_environment', 'resume_environment'].includes(result.nextAction.input?.action),
      'Environment recovery must not replay an old data fork')
    assert.equal(result.nextAction.input.project, project)
    await new Promise(resolve => setTimeout(resolve, 300))
    result = await call(result.nextAction.tool, result.nextAction.input, false, true)
  }
  assert.equal(result.repairEnvironment.version, 2)
  assert.equal(result.repairEnvironment.project, project)
  onEnvironment(result.repairEnvironment)
  return result
}
