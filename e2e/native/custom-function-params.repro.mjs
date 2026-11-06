import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import http from 'node:http'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { parseArgs } from 'node:util'
import { chromium } from '@playwright/test'
import { functionParamsCase } from './fixtures/custom-function-params-cases.mjs'
import { buildParamsBoundary } from './fixtures/custom-function-params-boundary-build.mjs'

const repo = fileURLToPath(new URL('../../', import.meta.url)), require = createRequire(import.meta.url)
const esbuild = createRequire(require.resolve('@angular/build/package.json'))('esbuild')
const { values } = parseArgs({ options: { 'library-root': { type: 'string' }, output: { type: 'string' }, log: { type: 'string' } } })
for (const name of ['library-root', 'output']) assert.ok(path.isAbsolute(values[name] ?? ''))
const relative = path.relative(path.join(repo, 'e2e/test-results'), values.output)
assert.ok(relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep))
await fs.mkdir(values.output, { recursive: true })
const sha = value => createHash('sha256').update(value).digest('hex')
const libraries = []
for (const name of ['core-variables', 'core-math', 'core-text', 'core-loop', 'core-logic', 'core-time', 'core-serial', 'core-functions']) {
  const root = path.join(values['library-root'], name), manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
  const source = await fs.readFile(path.join(root, 'generator.js'), 'utf8')
  libraries.push({ name: manifest.name, version: manifest.version, source, sha256: sha(source.replaceAll('\r\n', '\n')),
    blocks: JSON.parse(await fs.readFile(path.join(root, 'block.json'), 'utf8')),
    i18n: JSON.parse(await fs.readFile(path.join(root, 'i18n/en.json'), 'utf8')) })
}
assert.equal(libraries.at(-1).sha256, '4d3a8f44d8fbeffc76bdfe6648fa076e2474505ab359a81cd64bfa98aaef592b', 'Use the actual attested function library')
const production = await fs.readFile(path.join(repo, '.generated/blockly-runtime/native-candidate.js'))
const manifest = JSON.parse(await fs.readFile(path.join(repo, '.generated/blockly-runtime/manifest.json'), 'utf8'))
assert.equal(sha(production), manifest.sha256)
const harnessBuild = await esbuild.build({ absWorkingDir: repo, entryPoints: ['e2e/native/fixtures/custom-function-params.harness.ts'],
  bundle: true, platform: 'browser', format: 'esm', target: 'es2022', tsconfig: 'tsconfig.json', write: false, logLevel: 'error' })
const harness = harnessBuild.outputFiles[0].contents
await fs.writeFile(path.join(values.output, 'harness.js'), harness)
const variants = new Map()
for (const [name, legacyOrder] of [['observed-fixed', false], ['legacy-order-control', true]]) {
  const variant = await buildParamsBoundary(repo, esbuild, legacyOrder)
  variants.set(name, variant)
  await fs.mkdir(path.join(values.output, name), { recursive: true })
  await fs.writeFile(path.join(values.output, name, 'native-candidate.js'), variant.runtime)
  await fs.writeFile(path.join(values.output, name, 'harness.js'), variant.harness)
}
const report = { experimentCompleted: false, regressionPassed: false, reproduced: false, userOriginalReproduced: false, userProjectUsed: false, loggedCommandsExecuted: false,
  modelCalls: 0, productionSourcesWrittenByTest: false, runtimeSha256: manifest.sha256,
  libraries: libraries.map(({ name, version, sha256 }) => ({ name, version, sha256 })), cases: [] }
const server = http.createServer((request, response) => {
  const route = new URL(request.url, 'http://127.0.0.1').pathname
  const variant = variants.get(route.split('/')[1])
  if (variant) {
    if (route.endsWith('/')) { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><script type="module" src="harness.js"></script>') }
    else if (route.endsWith('/harness.js')) { response.setHeader('content-type', 'text/javascript'); response.end(variant.harness) }
    else if (route.endsWith('/blockly/runtime/native-candidate.js')) { response.setHeader('content-type', 'text/javascript'); response.end(variant.runtime) }
    else { response.statusCode = 404; response.end() }
  }
  else if (route === '/') { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><script type="module" src="/harness.js"></script>') }
  else if (route === '/harness.js') { response.setHeader('content-type', 'text/javascript'); response.end(harness) }
  else if (route === '/blockly/runtime/native-candidate.js') { response.setHeader('content-type', 'text/javascript'); response.end(production) }
  else { response.statusCode = 404; response.end() }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = 'http://127.0.0.1:' + server.address().port
let browser
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  const page = await browser.newPage()
  page.on('pageerror', error => { (report.pageErrors ??= []).push(error.message) })
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
  await page.goto(origin); await page.waitForFunction(() => window.NativeParamsRepro)
  const boardConfig = { core: 'esp32:esp32', uploadParam: '--chip esp32s3', serialPort: [['Serial', 'Serial']],
    serialSpeed: [['115200', '115200'], ['9600', '9600']], digitalPins: [['0', '0'], ['21', '21'], ['22', '22']] }
  const steps = await page.evaluate(({ libraries, boardConfig }) => window.NativeParamsRepro.prepare(libraries, boardConfig), { libraries, boardConfig })
  if (values.log) {
    const bytes = await fs.readFile(values.log), records = bytes.toString('utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
    const tool = line => records[line - 1].message.content.find(value => value.type === 'toolCall')
    let source = tool(269).arguments.content
    const replay = [{ line: 269, sha256: sha(source), characters: source.length }]
    for (const line of [273, 277, 281]) {
      for (const edit of tool(line).arguments.edits) {
        const before = edit.oldText ?? edit.old_text, after = edit.newText ?? edit.new_text
        assert.equal(typeof before, 'string'); assert.equal(typeof after, 'string')
        assert.equal(source.split(before).length - 1, 1, 'Logged edit requires exact unique matching data')
        source = source.replace(before, after)
      }
      replay.push({ line, sha256: sha(source), characters: source.length })
    }
    const findFailure = value => value && typeof value === 'object'
      ? value.nativeCandidateFailure ?? Object.values(value).map(findFailure).find(Boolean) : undefined
    const failure = records[287].message.content.filter(value => value.type === 'text').map(value => JSON.parse(value.text)).map(findFailure).find(Boolean)
    assert.equal('sha256:' + sha(source), failure.candidate.hash)
    assert.equal(Buffer.byteLength(source), failure.candidate.bytes)
    report.loggedCandidate = { logSha256: sha(bytes), reconstructedFrom: replay, matchesOriginalFailureHash: true,
      rawSourceWritten: false, executed: false, signatures: await page.evaluate(({ source, steps }) => window.NativeParamsRepro.inspectLogged(source, steps), { source, steps }) }
  }
  for (const name of ['zero-parameter-control', 'parameter-definition-first', 'nested-forward-call', 'nested-definition-first',
    'nested-parameterized-outer', 'nested-shared-parameter', 'nested-many-definitions']) {
    const request = { ...functionParamsCase(name), steps }
    const result = await page.evaluate(request => window.NativeParamsRepro.run(request), request)
    report.cases.push({ name, variant: 'production-runtime', requestSha256: sha(JSON.stringify(request)),
      expected: request.verify.state, ...result })
    assert.equal(result.ok, true, name + ' must retain its unchanged complete readback')
    if (result.failure?.code === 'ABS_NATIVE_UI_CONTRACT_CHANGED' && /extraState\/params/.test(result.failure.diagnostic?.path ?? '')) report.reproduced = true
    console.log(JSON.stringify({ name, ok: result.ok, failure: result.failure, elapsedMs: result.elapsedMs }))
  }
  const declaration = 'custom_function_def("pad", String, int, "n", text("probe"))'
  const outer = 'custom_function_def("format", String, int, "i", text_join(ADD0=custom_function_call_return_advance(FUNC_NAME=$pad, INPUT0=math_number(7)), ADD1=text("suffix")) @extra:{"itemCount":2})'
  const inconsistent = outer.replace('INPUT0=math_number(7))', 'INPUT0=math_number(7)) @extra:{"params":[{"name":"n","type":"float"}]}')
  for (const [name, roots, expectedOk] of [['raw-definition-first', [declaration, outer], true], ['raw-forward-call', [outer, declaration], true],
    ['raw-inconsistent-signature-negative', [declaration, inconsistent], false]]) {
    const source = '# ABS Schema: 2\n' + roots.join('\n')
    const variables = [{ name: 'pad', type: 'FUNC' }, { name: 'format', type: 'FUNC' }, { name: 'n' }, { name: 'i' }]
    const result = await page.evaluate(({ source, steps, variables }) => window.NativeParamsRepro.runReconciled(source, steps, variables), { source, steps, variables })
    report.cases.push({ name, stage: 'actual-host-reconciliation', source, sourceSha256: sha(source), ...result })
    console.log(JSON.stringify({ name, ok: result.ok, stages: result.stages, failure: result.failure }))
    assert.equal(result.ok, expectedOk, name + ' expected result')
    if (!expectedOk) assert.equal(result.stages.some(stage => stage.stage === 'verify-complete-ABI'), false, 'Malformed signature must be rejected before native verification')
  }
  const serialSource = `# ABS Schema: 2
arduino_global()
    variable_define("probeOut", String, text(""))
arduino_setup()
    serial_begin(Serial, 115200)
    serial_begin_esp32_custom("probeSerial", UART1, 115200, 22, 21)
    variables_set($probeOut, custom_function_call_return_advance(FUNC_NAME=$pad, INPUT0=math_number(7)) @extra:{"params":[{"name":"n","type":"int"}]})
arduino_loop()
    time_delay(math_number(10))
custom_function_def("pad", String, int, "n", text("probe"))
custom_function_def("reply", void, String, "message", String, "origin")
    serial_println(probeSerial, variables_get($message))`
  const serialVariables = [{ name: 'pad', type: 'FUNC' }, { name: 'reply', type: 'FUNC' }, { name: 'n' }, { name: 'message' }, { name: 'origin' }]
  const serialResult = await page.evaluate(({ source, steps, variables }) => window.NativeParamsRepro.runReconciled(source, steps, variables),
    { source: serialSource, steps, variables: serialVariables })
  report.cases.push({ name: 'real-custom-serial-dependency', stage: 'actual-host-reconciliation',
    sameTopologyAsLastLoggedProbe: true, exactUserCandidate: false, source: serialSource, sourceSha256: sha(serialSource), ...serialResult })
  console.log(JSON.stringify({ name: 'real-custom-serial-dependency', ok: serialResult.ok, stages: serialResult.stages, failure: serialResult.failure }))
  assert.equal(serialResult.ok, true, 'The original custom serial/function graph must complete on the production runtime')
  assert.equal(serialResult.fullReadback, true)
  for (const [variant, built] of variants) {
    await page.goto(origin + '/' + variant + '/'); await page.waitForFunction(() => window.NativeParamsRepro)
    const result = await page.evaluate(({ source, steps, variables }) => window.NativeParamsRepro.runReconciled(source, steps, variables),
      { source: serialSource, steps, variables: serialVariables })
    report.cases.push({ name: 'real-custom-serial-dependency', variant, privateArtifact: true, runtimeSha256: built.hash,
      privateSourceTransforms: built.edits, ...result })
    console.log(JSON.stringify({ name: 'real-custom-serial-dependency', variant, ok: result.ok, stages: result.stages, failure: result.failure }))
    assert.equal(result.ok, variant === 'observed-fixed')
    if (variant === 'legacy-order-control') {
      assert.equal(result.failure?.code, 'ABS_NATIVE_UI_CONTRACT_CHANGED')
      assert.ok(result.failure.diagnostic.path.endsWith('/extraState/params'))
      report.reproduced = true
      const change = result.traces.find(value => value.stage === 'existing-semantic-change')
      const read = (value, pointer) => pointer.split('/').slice(1).reduce((value, key) => value?.[key.replaceAll('~1', '/').replaceAll('~0', '~')], value)
      const pointer = result.failure.diagnostic.path
      assert.equal(read(change.before, pointer), undefined)
      assert.deepEqual(read(change.after, pointer), [{ name: 'n', type: 'int' }])
      const owner = pointer.slice(0, -'/extraState/params'.length)
      assert.deepEqual(read(change.before, owner + '/fields/FUNC_NAME'), read(change.after, owner + '/fields/FUNC_NAME'))
      assert.equal(read(change.before, owner + '/extraState/extraCount'), read(change.after, owner + '/extraState/extraCount'))
      const firstDefinitions = result.traces.find(value => value.stage === 'existing-prepare-serialization' && value.definitions.length)
      assert.equal(firstDefinitions.commitLoadedNames, false)
      assert.ok(firstDefinitions.definitions.some(value => value.name !== value.liveName))
    } else {
      assert.equal(result.fullReadback, true)
      const firstDefinitions = result.traces.find(value => value.stage === 'existing-prepare-serialization' && value.definitions.length)
      assert.equal(firstDefinitions.commitLoadedNames, true)
      assert.ok(firstDefinitions.definitions.every(value => value.name === value.liveName))
    }
  }
  await page.goto(origin); await page.waitForFunction(() => window.NativeParamsRepro)
  for (const name of ['parameter-definition-first', 'nested-forward-call']) {
    const alteredSteps = steps.map(step => step.kind === 'script' && step.label.includes('lib-core-functions/')
      ? { ...step, source: step.source + '\n// isolated equivalent-code attestation boundary\n' } : step)
    assert.notEqual(sha(alteredSteps.find(step => step.kind === 'script' && step.label.includes('lib-core-functions/')).source.replaceAll('\r\n', '\n')), libraries.at(-1).sha256)
    const request = { ...functionParamsCase(name), steps: alteredSteps }
    const result = await page.evaluate(request => window.NativeParamsRepro.run(request), request)
    report.cases.push({ name, stage: 'test-only-source-attestation-boundary', isUserOriginal: false,
      equivalentLibraryCommentAdded: true, expected: request.verify.state, ...result })
    console.log(JSON.stringify({ name, stage: 'test-only-source-attestation-boundary', ok: result.ok, failure: result.failure }))
    assert.equal(result.failure?.code, 'ABS_READBACK_MISMATCH', 'Unattested library must not silently lose caller params')
    assert.equal(result.failure?.diagnostic?.received, 'undefined')
  }
  report.checksPassed = report.cases.length
  report.experimentCompleted = true
  report.regressionPassed = true
} catch (error) { report.error = { message: error.message, stack: error.stack }; process.exitCode = 1 }
finally {
  await browser?.close(); await new Promise(resolve => server.close(resolve)); server.closeAllConnections()
  assert.equal(sha(await fs.readFile(path.join(repo, '.generated/blockly-runtime/native-candidate.js'))), manifest.sha256)
  await fs.writeFile(path.join(values.output, 'result.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ regressionPassed: report.regressionPassed, legacyBoundaryReproduced: report.reproduced, output: values.output }))
}
