import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { indexCustomerProject } from './customer-project-baseline-case.mjs'

export const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
export const documentHash = document => sha(JSON.stringify(canonical(document)))
export const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

export async function inventory(root) {
  const entries = []
  const visit = async directory => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      assert.equal(entry.isSymbolicLink(), false, 'R1 input must be detached, not a live source link')
      if (entry.isDirectory()) await visit(file)
      else { assert.equal(entry.isFile(), true); entries.push({ path: path.relative(root, file), sha256: sha(await fs.readFile(file)) }) }
    }
  }
  await visit(root)
  return entries.sort((a, b) => a.path.localeCompare(b.path))
}

export function fieldPlan(document) {
  const target = [...indexCustomerProject(document).values()].find(block => block.type === 'math_number'
    && typeof block.fields?.NUM === 'number' && Number.isSafeInteger(block.fields.NUM) && block.fields.NUM >= 0 && block.fields.NUM < 10000)
  assert.ok(target, 'Use one genuine numeric field, not private model/identity state')
  const root = document.pages.find(page => page.id === document.activePageId)?.content?.blocks?.blocks?.[0]
  assert.ok(root && typeof root.id === 'string')
  return { blockId: target.id, field: 'NUM', oldValue: target.fields.NUM, valueA: target.fields.NUM + 1,
    valueB: target.fields.NUM + 2, rootId: root.id, dx: 1234, dy: 777 }
}

export function expectedEdit(original, plan, value, move = false) {
  const expected = structuredClone(original)
  const target = indexCustomerProject(expected).get(plan.blockId)
  assert.ok(target); target.fields[plan.field] = value
  if (move) {
    const root = expected.pages.flatMap(page => page.content?.blocks?.blocks ?? []).find(block => block.id === plan.rootId)
    assert.ok(root); root.x = (root.x ?? 0) + plan.dx; root.y = (root.y ?? 0) + plan.dy
  }
  return expected
}

export async function nativeDocument(page, project) {
  const result = await page.waitForFunction(target => {
    const editor = window.ng?.getComponent(document.querySelector('app-blockly-editor'))
    if (editor?.projectService.currentProjectPath !== target || !editor.projectService.getBlocklyProjectLoadStatus(target)?.ready) return false
    try { return editor.blocklyService.captureRecoverySnapshot().documentText }
    catch (error) { if (error.code === 'BLOCKLY_EDIT_BUSY' || error.code === 'BLOCKLY_EDIT_STALE') return false; throw error }
  }, project, { timeout: 120000 })
  try { return JSON.parse(await result.jsonValue()) } finally { await result.dispose() }
}

export async function editWorking(page, project, plan, value, move = false) {
  return page.evaluate(({ project, plan, value, move }) => {
    const editor = window.ng.getComponent(document.querySelector('app-blockly-editor'))
    if (editor.projectService.currentProjectPath !== project) throw Error('Unexpected project')
    const service = editor.blocklyService, before = service.captureProjectSnapshot()
    const block = window.Blockly.getMainWorkspace().getBlockById(plan.blockId)
    if (!block || !block.getField(plan.field)) throw Error('Original GUI field unavailable')
    block.setFieldValue(value, plan.field)
    if (move) {
      const root = window.Blockly.getMainWorkspace().getBlockById(plan.rootId)
      if (!root) throw Error('Original visible root unavailable')
      root.moveBy(plan.dx, plan.dy)
    }
    const after = service.captureProjectSnapshot()
    return { beforeRevision: before.revision, afterRevision: after.revision, documentText: after.documentText }
  }, { project, plan, value, move })
}
