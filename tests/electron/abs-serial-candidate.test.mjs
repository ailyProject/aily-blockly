import assert from 'node:assert/strict'
import test from 'node:test'
import { fanTaskCandidate } from '../../e2e/electron/abs-serial-initialization.acceptance.mjs'

const call = '    custom_function_call_advance($风扇处理) @extra:{"funcVarId":"retained::FUNC","extraCount":0}'
const program = ['# ABS Schema: 2', 'custom_function_def("风扇处理", void)', '    serial_read(Serial, read)',
  'arduino_setup()', '    io_pinmode(math_number(5), io_mode(OUTPUT))',
  '    serial_begin_esp32_custom("hmiSerial", UART0, "9600", "20", "21")',
  'arduino_loop()', call, '    time_delay(math_number(20))'].join('\n')
const footer = '\n# @project-state:' + JSON.stringify({ opaque: 'x'.repeat(60000), variables: [{ id: 'retained::FUNC' }] })

test('serial acceptance moves the retained call into a root task and starts only after initialization', () => {
  const value = fanTaskCandidate(program + footer, 20)
  assert.equal(value.slice(value.indexOf('\n# @project-state:')), footer)
  assert.ok(value.indexOf('serial_begin_esp32_custom(') < value.indexOf('    esp32_task_start('))
  assert.ok(value.indexOf('    esp32_task_start(') < value.indexOf('arduino_loop()'))
  assert.match(value, /\nesp32_task_new\("fanTask"\)\n    @LOOP:\n/)
  assert.equal(value.match(/custom_function_call_advance\(\$风扇处理\)/gu).length, 1)
  assert.ok(value.includes('        ' + call.trimStart()))
  assert.match(value, /esp32_task_delay\(math_number\(20\)\)/)
})

test('candidate fixture refuses a partial or duplicated footer instead of discarding state', () => {
  assert.throws(() => fanTaskCandidate(program))
  assert.throws(() => fanTaskCandidate(program + footer + footer))
})

test('candidate fixture refuses ambiguous, already-disabled or missing fan calls', () => {
  for (const body of [program + '\n' + call, program.replace(call, call + ' @disabled'), program.replace(call, '')])
    assert.throws(() => fanTaskCandidate(body + footer))
})

test('candidate fixture refuses to move task startup ahead of absent hardware initialization', () => {
  assert.throws(() => fanTaskCandidate(program.replace('serial_begin_esp32_custom(', 'other_initializer(') + footer))
})
