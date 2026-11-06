import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
const digest = document => createHash('sha256').update(JSON.stringify(canonical(document))).digest('hex')
const roots = document => [...document.pages.flatMap(page => page.content.blocks?.blocks ?? []),
  ...(document.sharedModel?.procedureBlocks ?? [])]

export async function readCustomerNativeDocument(page, project) {
  const text = await page.evaluate(project => {
    const component = window.ng.getComponent(document.querySelector('app-blockly-editor'))
    if (component.projectService.currentProjectPath !== project) throw Error('Customer replay left its owned project')
    return component.blocklyService.captureRecoverySnapshot().documentText
  }, project)
  return JSON.parse(text)
}

/** Layout is the only permitted difference: nested blocks and every model,
 * field, identity, flag, comment, page and root order are compared in full. */
export function assertCustomerRootLayoutOnly(before, after) {
  const strip = document => {
    const copy = structuredClone(document)
    for (const block of roots(copy)) { delete block.x; delete block.y }
    return copy
  }
  assert.deepEqual(strip(after), strip(before), 'Tidy must change only persisted root x/y coordinates')
  const previous = new Map(roots(before).map(block => [block.id, block]))
  const changed = roots(after).filter(block => {
    for (const key of ['x', 'y']) if (Object.hasOwn(block, key)) assert.ok(Number.isFinite(block[key]))
    const prior = previous.get(block.id)
    return prior.x !== block.x || prior.y !== block.y
  })
  return { beforeSha256: digest(before), afterSha256: digest(after), changedRoots: changed.length,
    allOtherPersistedDataExactlyPreserved: true }
}

function requireSuccess(response, operation) {
  assert.equal(response.isError, false, `${operation} failed through actual Agent tools`)
  assert.equal(response.structured?.ok, true, `${operation} has no successful host receipt`)
  return response.structured
}

/** Real SDK tools only. Native access is observation, never a state setter. */
export async function runCustomerStateLayoutOperations({ page, project, call, phase, evidence }) {
  const before = await readCustomerNativeDocument(page, project)
  await phase('tidy-current-canvas-with-original-candidate-pending')
  const tidy = requireSuccess(await call('blocks_tidy', { project }), 'Current canvas layout')
  assert.equal(tidy.workflowVerification?.candidateApplied, false, 'Tidy must retain the unapplied ABS candidate')
  const arranged = await readCustomerNativeDocument(page, project)
  const layout = assertCustomerRootLayoutOnly(before, arranged)

  await phase('inspect-and-roundtrip-existing-block-collapsed-state')
  const rootIds = [...new Set(roots(arranged).map(block => block.id))]
  let inspected, target
  const inspections = []
  // The real inspector sorts all IDs, so the first 256 arbitrary blocks need
  // not include a root in a large customer program. Filter observed native
  // roots in bounded groups, then select only the tool's returned instances.
  for (let offset = 0; offset < rootIds.length && !target; offset += 256) {
    const blockIds = rootIds.slice(offset, offset + 256)
    inspected = requireSuccess(await call('blocks_set_state', { project, action: 'inspect', blockIds,
      limit: blockIds.length }), 'Bounded root block inspection')
    inspections.push({ requested: blockIds.length, returned: inspected.instances.length,
      editable: inspected.instances.filter(instance => instance.editable).length })
    target = inspected.instances.find(instance => instance.editable && blockIds.includes(instance.blockId))
  }
  assert.ok(target, 'A real inspected editable root is required; identities must not be guessed')
  assert.equal(typeof inspected.expectedGeneration, 'string', 'Inspection must offer actual generation authority')
  const update = requireSuccess(await call('blocks_set_state', { project, action: 'update',
    expectedGeneration: inspected.expectedGeneration,
    changes: [{ blockId: target.blockId, collapsed: !target.collapsed }] }), 'Existing root collapsed-state change')
  assert.equal(update.stateVerification?.ok, true)
  assert.equal(update.stateVerification?.candidateApplied, false)
  assert.equal(update.publication?.status, 'COMMITTED')
  const changed = await readCustomerNativeDocument(page, project)
  const expectedChanged = structuredClone(arranged)
  const expectedTarget = roots(expectedChanged).find(block => block.id === target.blockId)
  if (!target.collapsed) expectedTarget.collapsed = true
  else delete expectedTarget.collapsed
  assert.deepEqual(changed, expectedChanged, 'A state change must preserve all unrelated persisted data')

  // State updates consume authority. Discover the fresh generation through the
  // real read-only tool instead of replaying the first token/generation.
  const reinspected = requireSuccess(await call('blocks_set_state', { project, action: 'inspect',
    blockIds: [target.blockId], limit: 1 }), 'Changed root reinspection')
  assert.equal(reinspected.instances.length, 1)
  assert.equal(reinspected.instances[0].collapsed, !target.collapsed)
  assert.deepEqual(reinspected.instances[0].disabledReasons, target.disabledReasons)
  assert.equal(reinspected.instances[0].manualDisabled, target.manualDisabled)
  assert.equal(typeof reinspected.expectedGeneration, 'string')
  const restored = requireSuccess(await call('blocks_set_state', { project, action: 'update',
    expectedGeneration: reinspected.expectedGeneration,
    changes: [{ blockId: target.blockId, collapsed: target.collapsed }] }), 'Original collapsed-state restoration')
  assert.equal(restored.stateVerification?.ok, true)
  assert.equal(restored.stateVerification?.candidateApplied, false)
  assert.equal(restored.publication?.status, 'COMMITTED')
  assert.deepEqual(await readCustomerNativeDocument(page, project), arranged,
    'The state roundtrip must restore the full document, retaining only the earlier intended tidy coordinates')
  evidence.dependencyOperations.layout = layout
  evidence.dependencyOperations.blockState = { actualSdkTool: true, exactInspectedIdentity: target.blockId,
    rootInspections: inspections,
    changedAndRestored: true, disabledReasonsPreserved: true, freshAuthorityForRestore: true,
    fullDocumentRestored: true, candidateApplied: false }
  return arranged
}
