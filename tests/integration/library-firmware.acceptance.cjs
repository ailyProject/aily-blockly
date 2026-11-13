// Full offline firmware links from packed libraries and the owned native fixture.
// Resource SDKs/tools are read only; all builder caches and output stay isolated.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { parseArgs } = require('node:util');
const { values } = parseArgs({ options: Object.fromEntries(
  ['output', 'contract-output', 'native-result', 'builder-root', 'resource-root'].map(name => [name, { type: 'string' }])) });
const repo = path.resolve(__dirname, '../..');
const inside = (root, target) => { const relative = path.relative(root, target);
  return !!relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep); };
for (const name of Object.keys(values)) assert.ok(path.isAbsolute(values[name]));
assert.ok(inside(path.join(repo, 'tests/test-results'), values.output));
assert.ok(inside(path.join(repo, 'tests/test-results'), values['contract-output']));
assert.ok(inside(path.join(repo, 'e2e/test-results'), values['native-result']));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const report = { ok: false, modelCalls: 0, hardwareUsed: false, cases: [] };
const resources = values['resource-root'], libraries = path.join(values['contract-output'], 'candidate-project/.temp/libraries');
const builder = path.join(values['builder-root'], 'dist/main.js');
const env = { ...process.env, AILY_APPDATA_PATH: path.join(values.output, 'appdata'),
  AILY_BUILDER_PATH: path.join(values.output, 'builder-cache'), AILY_COMPILERS_PATH: path.join(resources, 'tools') };
for (const key of ['AILY_CHILD_PATH', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'COMPILER_PATH']) delete env[key];

async function run(args, log) {
  const chunks = [];
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [builder, ...args], { cwd: values.output, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', data => chunks.push(data)); child.stderr.on('data', data => chunks.push(data));
    child.once('error', reject); child.once('close', resolve);
  });
  const output = Buffer.concat(chunks);
  await fs.writeFile(path.join(values.output, log), output);
  assert.equal(exitCode, 0, log + ': ' + output.toString().slice(-1800));
}

async function generate(folder, type, expressions, name) {
  const source = await fs.readFile(path.join(values['contract-output'], 'candidate-project/node_modules/@aily-project', folder, 'generator.js'), 'utf8');
  const context = { Arduino: { forBlock: {} }, Blockly: {}, window: {}, registerVariableToBlockly() {} };
  vm.runInNewContext(source, context, { timeout: 1000 });
  const includes = new Map(), variables = new Map(), functions = new Map();
  const block = { getFieldValue: () => name, getField: () => ({ getText: () => name }),
    workspace: { getVariablesOfType: () => [{ name }] } };
  const api = { ORDER_ATOMIC: 0, addLibrary: (key, value) => includes.set(key, value),
    addVariable: (key, value) => variables.set(key, value), addFunction: (key, value) => functions.set(key, value),
    valueToCode: (_, field) => expressions[field] };
  const code = context.Arduino.forBlock[type](block, api);
  return { declarations: [...includes.values(), ...variables.values(), ...functions.values()].join('\n'), code, sourceSha256: sha(source) };
}

(async () => {
  await fs.mkdir(values.output, { recursive: false });
  try {
    const native = JSON.parse(await fs.readFile(values['native-result'], 'utf8'));
    assert.equal(native.regressionPassed, true);
    const nativeCase = native.cases.find(item => item.name === 'real-custom-serial-dependency' && !item.variant);
    assert.equal(nativeCase.fullReadback, true);
    const nativeCode = nativeCase.generationEvidence.code;
    assert.equal(typeof nativeCode, 'string');
    const rtc = await generate('lib-ds1302', 'ds1302_setup', { CE_PIN: '5', IO_PIN: '6', SCLK_PIN: '7' }, 'rtc');
    const mqtt = await generate('lib-pubsubclient', 'pubsub_publish',
      { TOPIC: 'String("topic") + String(1)', PAYLOAD: 'String("payload") + String(2)' }, 'mqttClient');
    const declarations = '#include <Arduino.h>\n' + rtc.declarations + '\n' + mqtt.declarations
      + '\nPubSubClient mqttClient;\nvoid libraryProbe() { rtc.writeProtect(false); rtc.halt(false); '
      + mqtt.code + ' }\n';
    const chains = [
      { name: 'avr', board: 'arduino:avr:uno', sdk: 'avr_1.8.6', tools: 'avr-gcc@7.3.0,avrdude@6.3.0-arduino17,ctags@5.8.0' },
      { name: 'esp32c3', board: 'esp32:esp32:esp32c3', sdk: 'esp32_3.3.1',
        tools: 'esp-rv32@14.2.0,esp-x32@14.2.0,esp32-arduino-libs@5.5.1,esptool_py@5.1.0,ctags@5.8.0' }
    ];
    for (const chain of chains) {
      const source = chain.name === 'avr' ? declarations + '\nvoid setup() { libraryProbe(); }\nvoid loop() {}\n'
        : declarations + '\n' + nativeCode.replace(/void\s+setup\s*\(\s*\)\s*\{/, 'void setup() {\n  libraryProbe();');
      assert.equal((source.match(/void\s+setup\s*\(\s*\)\s*\{/g) ?? []).length, 1);
      // Arduino merges every .ino in one sketch folder. Each board owns one
      // separate project so control sketches cannot be concatenated together.
      const project = path.join(values.output, chain.name + '-project');
      await fs.mkdir(project);
      const sketch = path.join(project, chain.name + '.ino'), build = path.join(values.output, chain.name);
      const preprocess = path.join(values.output, chain.name + '-preprocess.json');
      await fs.writeFile(sketch, source);
      await run(['preprocess', sketch, '--board', chain.board, '--sdk-path', path.join(resources, 'sdk', chain.sdk),
        '--tools-path', path.join(resources, 'tools'), '--tool-versions', chain.tools, '--libraries-path', libraries,
        '--build-path', build, '--save-result', preprocess], chain.name + '-preprocess.log');
      await run(['compile', sketch, '--board', chain.board, '--build-path', build, '--preprocess-result', preprocess,
        '--jobs', '4', '--no-archive-cloud-cache', '--no-fetch-archive-cloud-cache'], chain.name + '-compile.log');
      const artifacts = [];
      for (const name of (await fs.readdir(build)).filter(name => /\.(elf|hex|bin)$/.test(name))) {
        const bytes = await fs.readFile(path.join(build, name)); artifacts.push({ name, size: bytes.length, sha256: sha(bytes) });
      }
      assert.ok(artifacts.some(item => item.name.endsWith('.elf') && item.size > 0));
      report.cases.push({ board: chain.board, ok: true, generatedSourceSha256: sha(source), artifacts,
        nativeFixtureIncluded: chain.name === 'esp32c3' });
      console.log(JSON.stringify({ board: chain.board, ok: true, artifacts: artifacts.length }));
    }
    report.ok = true;
  } catch (error) { report.error = error.stack || String(error); process.exitCode = 1; }
  await fs.writeFile(path.join(values.output, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: report.ok, output: values.output, error: report.error?.split('\n')[0] }));
})();
