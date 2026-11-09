import assert from 'node:assert/strict'
import test from 'node:test'
import { customerNaturalCases, customerDependencyVersionMatches, expectedCustomerNaturalDocument, verifyCustomerGeneratedSource } from './r4-customer-natural.mjs'

test('original customer requests are fixed natural goals with no tool names, physical path or block IDs', () => {
  for (const goal of Object.values(customerNaturalCases)) {
    assert.ok(goal.prompt.includes(goal.variable))
    assert.ok(goal.prompt.includes(String(goal.before)) && goal.prompt.includes(String(goal.after)))
    assert.equal(goal.prompt.includes(goal.blockId), false)
    assert.doesNotMatch(goal.prompt, /abs_apply|project_build|tool_load|read|[A-Z]:\\/)
  }
})

test('the original-project oracle permits exactly the requested field and retains all unknown native content', () => {
  const goal = customerNaturalCases['787']
  const originalDocument = { schemaVersion: 3, activePageId: 'main',
    pages: [{ id: 'main', content: { blocks: { blocks: [{ id: goal.blockId, type: 'math_number', fields: { NUM: goal.before },
      comment: 'retain 中文😀', x: 17, y: 23, extraState: { hidden: ['opaque'] } }] } } },
    { id: 'other', content: { variables: [{ id: 'shared', name: 'shared model' }], workspaceComments: [{ id: 'note', text: 'keep' }] } }],
    sharedModel: { resources: [{ hash: 'unmodified resource' }], opaqueFutureVersion: true } }
  const fixture = { customer: { ...goal, originalDocument } }
  const expected = expectedCustomerNaturalDocument(originalDocument, fixture)
  const independentlyExpected = structuredClone(originalDocument)
  independentlyExpected.pages[0].content.blocks.blocks[0].fields.NUM = goal.after
  assert.deepEqual(expected, independentlyExpected)
  assert.deepEqual(originalDocument.pages[0].content.blocks.blocks[0].fields, { NUM: goal.before })
  const changedBeforePrompt = structuredClone(originalDocument)
  changedBeforePrompt.pages[1].content.workspaceComments[0].text = 'silently lost'
  assert.throws(() => expectedCustomerNaturalDocument(changedBeforePrompt, fixture), /preserve every original/)
})

test('compiler source evidence must contain the correct requested variable value rather than an old-success marker', () => {
  for (const goal of Object.values(customerNaturalCases)) {
    const fixture = { customer: goal }
    assert.equal(verifyCustomerGeneratedSource(fixture, `int ${goal.variable} = ${goal.before};`).value, goal.before)
    assert.equal(verifyCustomerGeneratedSource(fixture, `int ${goal.variable} = ${goal.after};`, true).value, goal.after)
    assert.throws(() => verifyCustomerGeneratedSource(fixture, `int ${goal.variable} = ${goal.before};`, true))
    assert.throws(() => verifyCustomerGeneratedSource(fixture, `int unrelated = ${goal.after};`, true))
  }
})

test('dependency qualification follows real declaration ranges and rejects the observed exact ESP32 mismatch', () => {
  assert.equal(customerDependencyVersionMatches('3.3.10', '3.3.12'), false)
  assert.equal(customerDependencyVersionMatches('3.3.12', '3.3.12'), true)
  assert.equal(customerDependencyVersionMatches('1.0.3', '^1.0.0'), true)
  assert.equal(customerDependencyVersionMatches('0.0.3', '^0.0.2'), false)
  assert.equal(customerDependencyVersionMatches('1.0.4-beta', '^1.0.3'), true)
  assert.equal(customerDependencyVersionMatches('invalid', '^1.0.0'), false)
  assert.equal(customerDependencyVersionMatches('1.0.0', 'file:local-library'), false)
})
