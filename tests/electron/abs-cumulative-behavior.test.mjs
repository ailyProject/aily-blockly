import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import { assertCumulativeGeneratedBehavior } from '../../e2e/fixtures/abs-cumulative-behavior.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(import.meta.url)
const Blockly = require('blockly')
require('blockly/blocks')
const original = { id: 'original-output', pin: '2', value: 'LOW' }
const one = { id: 'first-addition', pin: '12', value: 'HIGH' }
const two = { id: 'second-addition', pin: '13', value: 'HIGH' }
const libraryRoot = path.resolve(process.env.AILY_CUMULATIVE_LIBRARY_ROOT || path.join(root, '../aily-blockly-libraries'))
const cxxHelper = path.resolve(process.env.AILY_CUMULATIVE_CXX_HELPER ||
  path.join(root, '../aily-lex-pro/packages/aily-agent/src/skills/aily-project-testing/scripts/host-cxx.mjs'))

test('the explicit artifact contract rejects comments/literals, not legitimate deletion or undo', () => {
  for (const fake of [
    '// digitalWrite(12, HIGH);', '/*\ndigitalWrite(12, HIGH);\n*/',
    'const char* text = "digitalWrite(12, HIGH);";',
    'const char* text = R"tag(digitalWrite(12, HIGH);)tag";',
  ]) assert.throws(() => assertCumulativeGeneratedBehavior(fake, { required: [one] }), { code: 'CUMULATIVE_BEHAVIOR_MISSING' })
  const sketch = 'digitalWrite(2, LOW);\ndigitalWrite(12, HIGH);\n'
  assert.equal(assertCumulativeGeneratedBehavior(sketch, { required: [original, one], absent: [two] }).scope, 'artifact-contract')
  assert.throws(() => assertCumulativeGeneratedBehavior(sketch, { absent: [one] }), { code: 'CUMULATIVE_BEHAVIOR_UNEXPECTED' })
  assert.equal(assertCumulativeGeneratedBehavior('digitalWrite(2, LOW);', { required: [original], absent: [one, two] }).ok, true)
  assert.throws(() => assertCumulativeGeneratedBehavior(sketch, { required: [{ ...one, pin: '12);bad()' }] }), /pin token/)
  assert.throws(() => assertCumulativeGeneratedBehavior(sketch, { required: [one, one] }), /unique behavior IDs/)
})

// Load the production generator unchanged, including its real local helpers.
// No copied generator algorithm or replacement ABS parser is used in this test.
function arduinoGenerator() {
  const modules = new Map()
  const load = filename => {
    if (modules.has(filename)) return modules.get(filename).exports
    const module = { exports: {} }; modules.set(filename, module)
    const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText
    const localRequire = id => id.startsWith('.') ? load(path.resolve(path.dirname(filename), `${id}.ts`)) : require(id)
    vm.runInThisContext(`(function(require,module,exports){${compiled}\n})`, { filename })(localRequire, module, module.exports)
    return module.exports
  }
  const { ArduinoGenerator } = load(path.join(root, 'src/app/editors/blockly-editor/components/blockly/generators/arduino/arduino.ts'))
  return new ArduinoGenerator()
}

function generatedStages() {
  const Arduino = arduinoGenerator(), savedDefinitions = new Map()
  const selected = new Set(['arduino_setup', 'arduino_loop', 'arduino_global', 'io_digitalwrite', 'io_state', 'math_number'])
  const inputs = []
  for (const library of ['core-loop', 'core-io', 'core-math']) {
    const directory = path.join(libraryRoot, library)
    for (const filename of ['block.json', 'generator.js']) inputs.push(path.join(directory, filename))
    const definitions = JSON.parse(fs.readFileSync(path.join(directory, 'block.json'), 'utf8')).filter(definition => selected.has(definition.type))
    for (const definition of definitions) {
      savedDefinitions.set(definition.type, Blockly.Blocks[definition.type])
      delete Blockly.Blocks[definition.type]
    }
    Blockly.common.defineBlocksWithJsonArray(definitions)
    vm.runInNewContext(fs.readFileSync(path.join(directory, 'generator.js'), 'utf8'), { Blockly, Arduino, console },
      { filename: path.join(directory, 'generator.js') })
  }
  const workspace = new Blockly.Workspace(), stages = {}
  const emit = name => {
    // Exercise the real serialized-workspace boundary on every generation.
    const document = Blockly.serialization.workspaces.save(workspace)
    Blockly.serialization.workspaces.load(document, workspace)
    stages[name] = { document, sketch: Arduino.workspaceToCode(workspace) }
  }
  const append = (behavior, previous) => {
    const statement = workspace.newBlock('io_digitalwrite', behavior.id)
    const pin = workspace.newBlock('math_number', `${behavior.id}-pin`)
    const level = workspace.newBlock('io_state', `${behavior.id}-level`)
    pin.setFieldValue(behavior.pin, 'NUM'); level.setFieldValue(behavior.value, 'STATE')
    statement.getInput('PIN').connection.connect(pin.outputConnection)
    statement.getInput('STATE').connection.connect(level.outputConnection)
    if (previous) workspace.getBlockById(previous).nextConnection.connect(statement.previousConnection)
    else workspace.getBlockById('loop-root').getInput('ARDUINO_LOOP').connection.connect(statement.previousConnection)
  }
  Blockly.Events.disable()
  try {
    workspace.newBlock('arduino_global', 'global-root')
    workspace.newBlock('arduino_setup', 'setup-root')
    workspace.newBlock('arduino_loop', 'loop-root')
    append(original); emit('A')
    append(one, original.id); emit('B')
    append(two, one.id); emit('C')
    workspace.getBlockById(one.id).setCommentText('Only documentation changed; retain both additions.')
    emit('D')
    emit('unchanged')
    workspace.getBlockById(two.id).dispose(true)
    emit('deleted')
    Blockly.serialization.workspaces.load(stages.A.document, workspace)
    workspace.getBlockById(original.id).setCommentText('Old A plus a comment remains a syntactically valid sketch.')
    emit('regressed')
    return { stages, inputs }
  } finally {
    workspace.dispose(); Blockly.Events.enable()
    for (const [type, definition] of savedDefinitions) {
      if (definition) Blockly.Blocks[type] = definition
      else delete Blockly.Blocks[type]
    }
  }
}

const librariesAvailable = ['core-loop', 'core-io', 'core-math'].every(library =>
  ['block.json', 'generator.js'].every(file => fs.existsSync(path.join(libraryRoot, library, file))))

test('real Blockly and unchanged library generators retain A → B → C through a comment-only D',
  { skip: !librariesAvailable && 'Supply the readonly library checkout with AILY_CUMULATIVE_LIBRARY_ROOT' }, () => {
    const { stages } = generatedStages()
    for (const [name, required] of [['A', [original]], ['B', [original, one]], ['C', [original, one, two]], ['D', [original, one, two]]])
      assert.equal(assertCumulativeGeneratedBehavior(stages[name].sketch, { required }).ok, true, name)
    assert.notEqual(stages.C.sketch, stages.D.sketch, 'A real comment must reach generated output')
    assert.equal(stages.D.sketch, stages.unchanged.sketch, 'A no-change edit retains the generated artifact')
    assert.equal(assertCumulativeGeneratedBehavior(stages.regressed.sketch, { required: [original], absent: [one, two] }).ok, true)
    assert.throws(() => assertCumulativeGeneratedBehavior(stages.regressed.sketch, { required: [original, one, two] }),
      { code: 'CUMULATIVE_BEHAVIOR_MISSING', behaviorId: one.id })
    // A legitimate deletion or explicit undo has a different current contract.
    assert.equal(assertCumulativeGeneratedBehavior(stages.deleted.sketch, { required: [original, one], absent: [two] }).ok, true)
    assert.equal(assertCumulativeGeneratedBehavior(stages.A.sketch, { required: [original], absent: [one, two] }).ok, true)
  })

test('actual generated sketches compile, while independent host GPIO assertions catch the valid A+comment regression',
  { skip: !(librariesAvailable && fs.existsSync(cxxHelper)) && 'Readonly libraries and the existing host-cxx helper are required' }, async t => {
    const { discoverHostCompiler, compileAndRun } = await import(pathToFileURL(cxxHelper).href)
    const discovery = discoverHostCompiler()
    if (discovery.status !== 'available') { t.skip(discovery.reason); return }
    const { stages } = generatedStages(), directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-cumulative-gpio-'))
    try {
      fs.writeFileSync(path.join(directory, 'Arduino.h'), `#pragma once
extern int observedWrites[64];
constexpr int LOW=0, HIGH=1, INPUT=0, OUTPUT=1;
inline void pinMode(int, int) {}
inline void digitalWrite(int pin, int value) { if(pin>=0 && pin<64) observedWrites[pin]=value; }
`)
      const source = path.join(directory, 'actual-generated.cpp')
      const actualPrograms = Object.entries(stages).map(([name, stage]) => `namespace ${name} {\n${stage.sketch}\n}\n`).join('\n')
      fs.writeFileSync(source, `#include "Arduino.h"
#include <iostream>
int observedWrites[64];
${actualPrograms}
void reset() { for(int &value:observedWrites) value=-1; }
bool additions() { return observedWrites[2]==LOW && observedWrites[12]==HIGH && observedWrites[13]==HIGH; }
int main() {
  reset(); A::setup(); A::loop(); if(observedWrites[2]!=LOW) return 1;
  reset(); B::setup(); B::loop(); if(observedWrites[2]!=LOW || observedWrites[12]!=HIGH || observedWrites[13]!=-1) return 2;
  reset(); C::setup(); C::loop(); if(!additions()) return 3;
  reset(); D::setup(); D::loop(); if(!additions()) return 4;
  reset(); regressed::setup(); regressed::loop(); if(additions()) return 5;
  reset(); deleted::setup(); deleted::loop(); if(observedWrites[2]!=LOW || observedWrites[12]!=HIGH || observedWrites[13]!=-1) return 6;
  reset(); unchanged::setup(); unchanged::loop(); if(!additions()) return 7;
  std::cout << "CUMULATIVE_GPIO_EXECUTION_OK;REGRESSION_DETECTED";
}
`)
      const executed = compileAndRun(discovery.toolchain, { sources: [source], includeDirs: [directory] })
      assert.equal(executed.stdout.trim(), 'CUMULATIVE_GPIO_EXECUTION_OK;REGRESSION_DETECTED')
      t.diagnostic(JSON.stringify({ scope: 'host-simulation', compiler: discovery.identity,
        generatedStagesExecuted: Object.keys(stages), regressionCompiled: true, regressionBehaviorRejected: true,
        limitations: ['Narrow Arduino GPIO replacement; no board SDK, physical I/O, timing, ABS application or LLM execution claim.'] }))
    } finally {
      assert.equal(path.dirname(directory), path.resolve(os.tmpdir()))
      assert.match(path.basename(directory), /^aily-cumulative-gpio-/)
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
