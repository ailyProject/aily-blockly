// Diagnostic reproduction only. Downloads pinned publisher artifacts, calls the
// real generators/materializer, and runs real C++ syntax checks in a fresh tree.
// It does not install packages, edit libraries, invoke models or access devices.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const { parseArgs } = require('node:util');
const tar = require('tar');
const { collectDependencyLibraryPackages, processLibrariesParallel } = require('../../child/scripts/preprocess');
const run = promisify(execFile);
const repo = path.resolve(__dirname, '../..');
const { values } = parseArgs({ options: { output: { type: 'string' }, 'resource-root': { type: 'string' } } });
const inside = (root, file) => { const relative = path.relative(root, file);
  return !!relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };
assert.ok(path.isAbsolute(values.output || '') && inside(path.join(repo, 'tests/test-results'), values.output));
assert.ok(path.isAbsolute(values['resource-root'] || ''));
const output = values.output, resources = values['resource-root'];
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const report = { ok: false, diagnosticReproduction: true, productionLogicModified: false,
  modelCalls: 0, hardwareUsed: false, cases: [], artifacts: [] };
const persist = () => fs.writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2));

async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, 200, `Download failed: ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

async function artifact(name) {
  const registry = 'https://registry.yiyu.pro/';
  const metadataUrl = registry + '@aily-project%2f' + name;
  const metadata = JSON.parse((await download(metadataUrl)).toString());
  const manifest = metadata.versions['1.0.0'];
  assert.equal(manifest.name, '@aily-project/' + name);
  assert.equal(manifest.version, '1.0.0');
  const url = new URL(manifest.dist.tarball);
  assert.equal(url.origin, new URL(registry).origin);
  const bytes = await download(url.href), [algorithm, digest] = manifest.dist.integrity.split('-');
  assert.equal(crypto.createHash(algorithm).update(bytes).digest('base64'), digest);
  const archive = path.join(output, name + '.tgz');
  await fs.writeFile(archive, bytes, { flag: 'wx' });
  const members = [];
  await tar.t({ file: archive, onentry(entry) {
    assert.ok(entry.path.startsWith('package/') && !entry.path.split('/').includes('..'));
    assert.ok(['Directory', 'File', 'OldFile'].includes(entry.type), 'No package links or special files');
    members.push({ name: entry.path, type: entry.type, size: entry.size });
  } });
  const destination = path.join(output, 'project/node_modules/@aily-project', name);
  await fs.mkdir(destination, { recursive: true });
  await tar.x({ file: archive, cwd: destination, strip: 1, strict: true, preservePaths: false });
  const evidence = { name: manifest.name, version: manifest.version, metadataUrl, tarballUrl: url.href,
    integrity: manifest.dist.integrity, sha256: sha(bytes), published: metadata.time?.[manifest.version], members };
  report.artifacts.push(evidence);
  return { root: destination, evidence };
}

async function generator(root) {
  const source = await fs.readFile(path.join(root, 'generator.js'), 'utf8');
  const context = { Arduino: { forBlock: {} }, Blockly: {}, window: {}, registerVariableToBlockly() {} };
  vm.runInNewContext(source, context, { filename: path.join(root, 'generator.js'), timeout: 1000 });
  return { functions: context.Arduino.forBlock, sha256: sha(source) };
}

function generate(fn, expressions, name) {
  const includes = new Map(), variables = new Map();
  const block = { getFieldValue: () => name, getField: () => ({ getText: () => name }),
    workspace: { getVariablesOfType: type => type === 'PubSubClient' ? [{ name }] : [] } };
  const api = { ORDER_ATOMIC: 0, addLibrary: (key, value) => includes.set(key, value),
    addVariable: (key, value) => variables.set(key, value), valueToCode: (_, field) => expressions[field] };
  return { code: fn(block, api), includes: [...includes.values()], variables: [...variables.values()] };
}

function toolchains() {
  const avr = path.join(resources, 'sdk/avr_1.8.6');
  const esp = path.join(resources, 'sdk/esp32_3.3.1');
  const idf = path.join(resources, 'tools/esp32-arduino-libs@5.5.1/esp32c3');
  return [
    { name: 'avr-arduino', executable: path.join(resources, 'compiler/avr-gcc@7.3.0/bin/avr-g++.exe'),
      args: ['-std=gnu++11', '-fsyntax-only', '-mmcu=atmega328p', '-DF_CPU=16000000L', '-DARDUINO=10819',
        '-DARDUINO_ARCH_AVR', '-I' + path.join(avr, 'cores/arduino'), '-I' + path.join(avr, 'variants/standard')] },
    { name: 'esp32c3-arduino', executable: path.join(resources, 'compiler/esp-rv32@14.2.0/bin/riscv32-esp-elf-g++.exe'),
      args: ['@' + path.join(idf, 'flags/cpp_flags'), '@' + path.join(idf, 'flags/defines'), '-fsyntax-only',
        '-DF_CPU=160000000L', '-DARDUINO=10819', '-DARDUINO_ARCH_ESP32', '-DARDUINO_ESP32C3_DEV',
        '-iprefix', path.join(idf, 'include') + path.sep, '@' + path.join(idf, 'flags/includes'),
        '-I' + path.join(idf, 'qio_qspi/include'), '-I' + path.join(esp, 'cores/esp32'),
        '-I' + path.join(esp, 'variants/esp32c3')] },
  ];
}

async function compile(chain, name, source, includes, expected, pattern) {
  const file = path.join(output, chain.name + '-' + name + '.cpp');
  await fs.writeFile(file, source, { flag: 'wx' });
  const args = [...chain.args, ...includes.map(folder => '-I' + folder), file];
  let exitCode = 0, stdout = '', stderr = '';
  try { ({ stdout, stderr } = await run(chain.executable, args, { timeout: 30000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 })); }
  catch (error) { exitCode = typeof error.code === 'number' ? error.code : error.code || 'unknown'; stdout = error.stdout || ''; stderr = error.stderr || ''; }
  await fs.writeFile(file + '.log', stdout + stderr);
  const row = { chain: chain.name, name, exitCode, expected, sourceSha256: sha(source),
    diagnostic: stderr.split(/\r?\n/).filter(line => /fatal error:|error:|note: candidate/.test(line)).slice(0, 8) };
  report.cases.push(row); await persist();
  assert.equal(exitCode === 0, expected === 'pass', `${chain.name}/${name}: ${stderr.slice(0, 1600)}`);
  if (pattern) assert.match(stderr, pattern);
}

(async () => {
  await fs.mkdir(output, { recursive: false });
  try {
    const ds = await artifact('lib-ds1302'), pubsub = await artifact('lib-pubsubclient');
    const project = path.join(output, 'project'), libraries = path.join(project, '.temp/libraries');
    await fs.mkdir(libraries, { recursive: true });
    const dependencies = { '@aily-project/lib-ds1302': '1.0.0', '@aily-project/lib-pubsubclient': '1.0.0' };
    await fs.writeFile(path.join(project, 'package.json'), JSON.stringify({ name: 'owned-cpp-repro', dependencies }));
    const materialized = await processLibrariesParallel(collectDependencyLibraryPackages(dependencies, project),
      libraries, project, path.join(repo, 'child/7za.exe'), false, {});
    report.materialization = { productionModule: 'child/scripts/preprocess.js', targets: materialized,
      dsSourceMembers: ds.evidence.members.filter(entry => /(?:^|\/)src(?:\/|\.7z$)|DS1302\.(?:h|cpp)$/.test(entry.name)) };
    assert.deepEqual(report.materialization.dsSourceMembers, []);
    assert.ok(!materialized.some(name => /ds1302/i.test(name)), 'Current preprocessor silently skips the headerless package');
    const pubHeader = path.join(libraries, 'PubSubClient/PubSubClient.h');
    await fs.access(pubHeader);
    const pubGenerator = await generator(pubsub.root), dsGenerator = await generator(ds.root);
    report.generators = { pubsubSha256: pubGenerator.sha256, ds1302Sha256: dsGenerator.sha256 };
    const dsGenerated = generate(dsGenerator.functions.ds1302_setup, { CE_PIN: '5', IO_PIN: '6', SCLK_PIN: '7' }, 'rtc');
    const dsSource = '#include <Arduino.h>\n' + dsGenerated.includes.join('\n') + '\n' + dsGenerated.variables.join('\n')
      + '\nvoid probe() { rtc.writeProtect(false); rtc.halt(false); auto value = rtc.time(); (void)value; }\n';
    const upstreamRepo = JSON.parse((await download('https://api.github.com/repos/msparks/arduino-ds1302')).toString());
    const commit = JSON.parse((await download('https://api.github.com/repos/msparks/arduino-ds1302/commits/' + upstreamRepo.default_branch)).toString());
    assert.match(commit.sha, /^[a-f0-9]{40}$/);
    const driver = path.join(output, 'isolated-upstream-driver'); await fs.mkdir(driver);
    report.ds1302Control = { revision: commit.sha, repository: 'https://github.com/msparks/arduino-ds1302',
      isolatedOnly: true, publishedOrInstalled: false, files: {} };
    for (const name of ['DS1302.h', 'DS1302.cpp']) {
      const bytes = await download('https://raw.githubusercontent.com/msparks/arduino-ds1302/' + commit.sha + '/' + name);
      await fs.writeFile(path.join(driver, name), bytes, { flag: 'wx' }); report.ds1302Control.files[name] = sha(bytes);
    }
    const cppAdapter = 'inline const char* aily_mqtt_cstr(const char* value) { return value; }\n'
      + 'inline const char* aily_mqtt_cstr(const String& value) { return value.c_str(); }\n';
    for (const chain of toolchains()) {
      await fs.access(chain.executable);
      await compile(chain, 'ds1302-published-missing', dsSource, materialized.map(name => path.join(libraries, name)),
        'fail', /DS1302\.h: No such file or directory/);
      await compile(chain, 'ds1302-isolated-header-control', dsSource, [driver], 'pass');
      await compile(chain, 'ds1302-isolated-driver-control', await fs.readFile(path.join(driver, 'DS1302.cpp'), 'utf8'), [driver], 'pass');
      for (const [name, topic, payload, expected] of [
        ['literals', '"ceshi"', '"hello"', 'pass'],
        ['string-payload', '"ceshi"', 'payload', 'fail'],
        ['string-topic', 'topic', '"hello"', 'fail'],
        ['strings', 'topic', 'payload', 'fail'],
        ['temporary-strings', 'String("ceshi") + String(1)', 'String("hello") + String(2)', 'fail'],
      ]) {
        const generated = generate(pubGenerator.functions.pubsub_publish, { TOPIC: topic, PAYLOAD: payload }, 'mqttClient');
        const prefix = '#include <Arduino.h>\n' + generated.includes.join('\n')
          + '\nextern PubSubClient mqttClient;\nString topic("ceshi"), payload("hello");\n';
        await compile(chain, 'mqtt-' + name, prefix + '\nvoid probe() { ' + generated.code + ' }\n',
          [path.dirname(pubHeader)], expected, expected === 'fail' ? /no matching function|cannot convert/ : undefined);
        // Experiment changes only this standalone generated C++ expression.
        const converted = generated.code.replace('.publish(', '.publish(aily_mqtt_cstr(')
          .replace(', ' + payload + ');', '), aily_mqtt_cstr(' + payload + '));');
        await compile(chain, 'mqtt-' + name + '-adapter-control', prefix + '\n' + cppAdapter + '\nvoid probe() { ' + converted + ' }\n',
          [path.dirname(pubHeader)], 'pass');
      }
    }
    report.ok = true;
    report.scope = 'Actual publisher packages, production generator/materializer and real AVR/ESP32-C3 syntax compilation. No firmware link, hardware, MQTT broker or original user-project validation.';
  } catch (error) { report.failure = error.stack || String(error); process.exitCode = 1; }
  await persist(); console.log(JSON.stringify({ ok: report.ok, cases: report.cases.length, output, failure: report.failure?.split('\n')[0] }));
})();
