import assert from 'node:assert/strict'
import test from 'node:test'
import { hantaiControlSource, hantaiColdFieldPlans } from './hantai-control-source.mjs'

const native = { pages: [{ content: { blocks: { blocks: [{ type: 'time_delay', id: 'delay', inputs: {
  DELAY_TIME: { block: { type: 'math_number', id: 'milliseconds', fields: { NUM: 20 } } }
} }] } } }], sharedModel: { variables: [{ id: 'keep', name: 'temperature' }] } }
const source = '# ABS Schema: 2\narduino_loop()\n    time_delay(math_number(20))\n# @project-state: opaque-original-state\n'

test('original control submits the exact whole source and expects the whole unchanged Native', () => {
  const result = hantaiControlSource(native, source, 'original')
  assert.equal(result.source, source); assert.deepEqual(result.expectedNative, native)
  assert.equal(result.edit, null); assert.notEqual(result.expectedNative, native)
})
test('minimal control changes only the unique executable 20 to 21, preserving IDs, other models and host state', () => {
  const result = hantaiControlSource(native, source, 'minimal-field')
  assert.equal(result.source, source.replace('math_number(20)', 'math_number(21)'))
  const expected = structuredClone(native)
  expected.pages[0].content.blocks.blocks[0].inputs.DELAY_TIME.block.fields.NUM = 21
  assert.deepEqual(result.expectedNative, expected)
  assert.equal(result.edit.blockId, 'milliseconds'); assert.equal(native.pages[0].content.blocks.blocks[0].inputs.DELAY_TIME.block.fields.NUM, 20)
})
test('ambiguous calls and preview-only ABS are rejected before any operation', () => {
  assert.throws(() => hantaiControlSource(native, source + 'time_delay(math_number(20))\n', 'minimal-field'), /uniquely/)
  assert.throws(() => hantaiControlSource(native, 'time_delay(math_number(20))', 'original'), /complete original/)
})
test('cold boundary plans use three existing delay literals without introducing a library or model', () => {
  const document = structuredClone(native), values = document.pages[0].content.blocks.blocks
  for (const value of [120, 80]) values.push({ type: 'time_delay', id: 'delay-' + value, inputs: {
    DELAY_TIME: { block: { type: 'math_number', id: 'milliseconds-' + value, fields: { NUM: value } } }
  } })
  const before = structuredClone(document), plans = hantaiColdFieldPlans(document)
  assert.deepEqual(Object.values(plans).map(plan => [plan.field, plan.oldValue, plan.value]), [['NUM', 20, 21], ['NUM', 120, 121], ['NUM', 80, 81]])
  assert.equal(plans.A.blockId, 'milliseconds'); assert.equal(plans.C.oldText, 'time_delay(math_number(80))')
  assert.deepEqual(document, before)
})
