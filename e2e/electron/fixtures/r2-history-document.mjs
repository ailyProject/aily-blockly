import assert from 'node:assert/strict'
import { indexCustomerProject } from './customer-project-baseline-case.mjs'

export function historyFieldPlans(document, visibleIds) {
  const visible = new Set(visibleIds)
  const blocks = [...indexCustomerProject(document).values()].filter(block => visible.has(block.id) &&
    block.type === 'math_number' && Number.isSafeInteger(block.fields?.NUM) && block.fields.NUM >= 0 && block.fields.NUM < 10000)
  assert.ok(blocks.length >= 2, 'History oracle needs two genuine distinct numeric blocks in the actual visible workspace')
  const plan = (block, increment) => ({ blockId: block.id, field: 'NUM', oldValue: block.fields.NUM, valueA: block.fields.NUM + increment })
  return { A: plan(blocks[0], 1), C: plan(blocks[1], 7) }
}

export function historyExpectedDocument(document, plan, value) {
  const copy = structuredClone(document), block = indexCustomerProject(copy).get(plan.blockId)
  assert.ok(block && Object.hasOwn(block.fields ?? {}, plan.field))
  block.fields[plan.field] = value
  return copy
}

/** Same original transaction identity; this does not authorize another publish. */
export function pendingHistoryStep(transactions) {
  const entries = transactions.filter(value => value.programNavigation && value.status !== 'committed')
  assert.equal(entries.length, 1, 'The isolated History run must own exactly one unfinished native transaction')
  const steps = entries[0].programNavigation.steps.filter(step => step.state === 'dispatched')
  assert.equal(steps.length, 1)
  assert.match(steps[0].request?.requestId ?? '', /^pub2-[0-9a-f-]{36}$/i)
  assert.ok(Number.isSafeInteger(steps[0].executorPid) && steps[0].executorPid > 0)
  return { transactionId: entries[0].id, requestId: steps[0].request.requestId, executorPid: steps[0].executorPid }
}
