import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { _electron } from '@playwright/test'

import { createRecoveredAgentHarness } from '../fixtures/abs-agent-tools.mjs'
import { serveRendererBuild } from '../fixtures/build-renderer-server.mjs'

// Required absolute paths: AILY_ABS_SERIAL_{TEST_ROOT,SEED,AGENT_ROOT,HOST_BUILD,
// TASK_LIBRARY,OUTPUT}. APPDATA optionally selects a prepared private root;
// otherwise TEST_ROOT/appdata is used. No installed Chat package is replaced.
const repo = fileURLToPath(new URL('../../', import.meta.url))
const inside = (root, child) => {
  const relative = path.relative(root, child)
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
}
const same = (left, right) => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const log = (...items) => console.log(new Date().toISOString(), ...items)

function configuration() {
  const required = name => {
    const value = process.env['AILY_ABS_SERIAL_' + name]
    assert.ok(value && path.isAbsolute(value), `AILY_ABS_SERIAL_${name} must be an explicit absolute test path`)
    return path.resolve(value)
  }
  const root = required('TEST_ROOT'), output = required('OUTPUT')
  assert.match(root.replaceAll('\\', '/'), /^C:\/.*\/aily-project\/dev-tests\//i, 'Use only a C-drive private dev-tests root')
  assert.ok(inside(path.join(repo, 'e2e/test-results'), output), 'Keep reports in ignored E2E outputs')
  return { root, output, seed: required('SEED'), agent: required('AGENT_ROOT'), build: required('HOST_BUILD'),
    library: required('TASK_LIBRARY'), unicode: process.env.AILY_ABS_SERIAL_UNICODE === '1', appData: process.env.AILY_ABS_SERIAL_APPDATA
      ? required('APPDATA') : path.join(root, 'appdata') }
}

async function ordinaryTree(directory) {
  const stat = await fs.lstat(directory)
  assert.equal(stat.isSymbolicLink(), false, 'Fixture sources must not follow links')
  if (stat.isDirectory()) for (const entry of await fs.readdir(directory)) await ordinaryTree(path.join(directory, entry))
  else assert.equal(stat.isFile(), true, 'Copy only ordinary files/directories')
}

async function sourceHashes(seed) {
  return Object.fromEntries(await Promise.all(['package.json', 'package-lock.json', 'project.abi', 'project.abs', 'project.abs.map.json']
    .map(async name => [name, hash(await fs.readFile(path.join(seed, name)))])))
}

function indexBlocks(document) {
  const result = new Map()
  const visit = value => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) return value.forEach(visit)
    if (typeof value.type === 'string' && typeof value.id === 'string') {
      assert.ok(!result.has(value.id), 'Canonical state must have unique block identities')
      const { inputs, next, x, y, ...state } = value
      result.set(value.id, state)
    }
    for (const [key, child] of Object.entries(value))
      if (!['fields', 'extraState', 'variables'].includes(key)) visit(child)
  }
  visit(document)
  return result
}

function variableTable(state) {
  const records = state.variables ?? []
  assert.ok(Array.isArray(records))
  assert.equal(new Set(records.map(record => record.id)).size, records.length)
  return [...records].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

/** Transform only the program. The opaque baseline footer and moved call's
 * metadata remain exact; actual candidate publication is done by SDK tools. */
export function fanTaskCandidate(abs, delay = 25) {
  const marker = '\n# @project-state:'
  const boundary = abs.indexOf(marker)
  assert.ok(boundary > 0 && abs.indexOf(marker, boundary + marker.length) === -1, 'Keep one complete baseline footer')
  const footer = abs.slice(boundary)
  const lines = abs.slice(0, boundary).split(/\r?\n/)
  const sections = () => lines.flatMap((line, index) => /^[A-Za-z_]\w*\(/.test(line) ? [{ index, type: line.slice(0, line.indexOf('(')) }] : [])
  const section = type => {
    const roots = sections(), matching = roots.filter(root => root.type === type)
    assert.equal(matching.length, 1, `Expected one ${type} root`)
    const at = roots.indexOf(matching[0])
    return { start: matching[0].index, end: roots[at + 1]?.index ?? lines.length }
  }
  assert.equal(lines.some(line => line.includes('esp32_task_new("fanTask")')), false, 'Seed must not already contain the candidate')
  const loop = section('arduino_loop')
  const calls = lines.flatMap((line, index) => /^\s+custom_function_call_advance\(\$风扇处理\)/u.test(line) ? [{ line, index }] : [])
  assert.equal(calls.length, 1, 'Move the original unique fan call instead of recreating it')
  const call = calls[0]
  assert.ok(call.index > loop.start && call.index < loop.end && !call.line.includes('@disabled'))
  lines.splice(call.index, 1)
  const setup = section('arduino_setup')
  assert.ok(lines.slice(setup.start, setup.end).some(line => line.includes('serial_begin_esp32_custom(')), 'Keep source hardware initialization')
  lines.splice(setup.end, 0, '    esp32_task_start(text("fanTask"))')
  while (lines.length && !lines.at(-1).trim()) lines.pop()
  const task = ['esp32_task_new("fanTask")', '    @LOOP:', '        ' + call.line.trimStart(),
    `        esp32_task_delay(math_number(${delay}))`].join('\n')
  const candidate = lines.join('\n') + '\n\n' + task + footer
  assert.equal(candidate.slice(candidate.indexOf(marker)), footer)
  return candidate
}

export async function runSerialInitializationAcceptance(options = {}) {
  const config = configuration()
  const root = await fs.realpath(config.root), seed = await fs.realpath(config.seed)
  assert.match(root.replaceAll('\\', '/'), /^C:\/.*\/aily-project\/dev-tests\//i)
  assert.ok(inside(root, seed), 'The seed must be a private extracted copy inside this test root')
  assert.ok(inside(root, config.appData), 'Never use daily appdata')
  await fs.mkdir(config.appData, { recursive: true })
  assert.ok(inside(root, await fs.realpath(config.appData)), 'Private appdata itself must not point outside this root')
  const suite = await fs.mkdtemp(path.join(root, 'serial-agent-'))
  const project = path.join(suite, 'project'), library = path.join(suite, 'task-library')
  const evidence = { ok: false, suite, project, isolation: { userProjectsModified: false, uploaded: false,
    simulatorInvoked: false, dailyInstallReplaced: false }, boundaries: {
    llmInvoked: false, hardwareTested: false, priorityControlImplemented: false,
    serialParserChanged: false, serialBufferOverflowPrevented: false,
    note: 'Only task migration and the real ABS/application/compilation chain are verified.' } }
  let app, page, harness, renderer, hostPid
  let before
  const calls = []
  await fs.mkdir(config.output, { recursive: true })
  const call = async (name, input, options = {}) => {
    log('AGENT_TOOL', name)
    const result = await harness.call(name, input, options)
    calls.push({ name, isError: result.isError })
    await fs.appendFile(path.join(config.output, 'tool-results.jsonl'), JSON.stringify({ name, input,
      isError: result.isError, structured: result.structured, ...(!result.structured ? { text: result.text } : {}) }) + '\n')
    return result.structured ?? result
  }
  const ready = async () => page.waitForFunction(target => {
    const element = document.querySelector('blockly-main')
    if (!element || !window.ng) return false
    const service = window.ng.getComponent(element)?.projectService
    return service?.currentProjectPath?.replaceAll('\\', '/') === target.replaceAll('\\', '/')
      && service.getBlocklyProjectLoadStatus(target)?.ready === true
  }, project, { timeout: 60000 })
  const canvas = async () => JSON.parse(await page.evaluate(() =>
    JSON.stringify(window.Blockly.serialization.workspaces.save(window.Blockly.getMainWorkspace()))))
  const installedLibrary = async phase => {
    const manifest = JSON.parse(await fs.readFile(path.join(project, 'package.json'), 'utf8'))
    const packageRoot = path.join(project, 'node_modules/@aily-project/lib-esp32-task')
    const files = Object.fromEntries(await Promise.all(['package.json', 'generator.js', 'src.7z'].map(async name =>
      [name, hash(await fs.readFile(path.join(packageRoot, name)))])))
    const dependency = manifest.dependencies?.['@aily-project/lib-esp32-task']
    assert.equal(typeof dependency, 'string', `Task dependency must persist after ${phase}`)
    ;(evidence.librarySnapshots ??= []).push({ phase, dependency, files })
  }

  try {
    before = await sourceHashes(seed)
    evidence.seedHashes = before
    const builder = path.join(config.appData, 'npm-global/node_modules/@aily-project/aily-builder')
    const builderPackage = JSON.parse(await fs.readFile(path.join(builder, 'package.json'), 'utf8'))
    evidence.builder = { version: builderPackage.version, entryHash: hash(await fs.readFile(path.join(builder, 'aily-builder.js'))) }
    assert.equal(indexBlocks(JSON.parse(await fs.readFile(path.join(seed, 'project.abi'), 'utf8'))).size, 115,
      'This regression requires the original 115-block ABI, not the edited ABS draft')
    await fs.mkdir(project)
    for (const name of ['package.json', 'package-lock.json', 'project.abi', 'node_modules']) {
      await ordinaryTree(path.join(seed, name))
      await fs.cp(path.join(seed, name), path.join(project, name), { recursive: true, errorOnExist: true, force: false })
    }
    const manifest = JSON.parse(await fs.readFile(path.join(seed, 'package.json'), 'utf8'))
    for (const spec of Object.values(manifest.dependencies ?? {})) if (typeof spec === 'string' && spec.startsWith('file:')) {
      const local = spec.slice(5), source = path.resolve(seed, local), target = path.resolve(project, local)
      assert.ok(!path.win32.isAbsolute(local) && inside(seed, source) && inside(project, target), 'Keep local file dependencies private')
      await ordinaryTree(source)
      await fs.cp(source, target, { recursive: true, errorOnExist: true, force: false })
    }
    await ordinaryTree(config.library)
    assert.equal(JSON.parse(await fs.readFile(path.join(config.library, 'package.json'), 'utf8')).name, '@aily-project/lib-esp32-task')
    await fs.cp(config.library, library, { recursive: true, errorOnExist: true, force: false })
    evidence.taskLibrary = { package: '@aily-project/lib-esp32-task', generatorHash: hash(await fs.readFile(path.join(library, 'generator.js'))),
      sourceArchiveHash: hash(await fs.readFile(path.join(library, 'src.7z'))) }

    renderer = await serveRendererBuild(config.build)
    const { ELECTRON_RUN_AS_NODE, AILY_CHILD_PATH, NODE_PATH, ...env } = process.env
    const home = path.join(suite, 'home')
    await fs.mkdir(home)
    app = await _electron.launch({ args: ['.', '--serve', `--user-data-dir=${path.join(suite, 'electron-profile')}`],
      cwd: repo, timeout: 60000, env: { ...env, AILY_E2E: '1', AILY_APPDATA_PATH: config.appData,
        HOME: home, USERPROFILE: home, AILY_DEV_RENDERER_URL: renderer.origin, npm_config_offline: 'true', npm_config_audit: 'false' } })
    hostPid = await app.evaluate(() => process.pid)
    evidence.hostPid = hostPid
    await app.firstWindow()
    const windowDeadline = Date.now() + 60000
    while (!page && Date.now() < windowDeadline) {
      page = app.windows().find(window => window.url().startsWith(renderer.origin) || /^chrome-error:/.test(window.url()))
      if (!page) await new Promise(resolve => setTimeout(resolve, 200))
    }
    assert.ok(page, 'Own renderer must start')
    page.on('dialog', dialog => dialog.dismiss())
    page.on('console', event => { if (event.type() === 'error') log('RENDERER_ERROR', event.text().slice(0, 1200)) })
    await page.goto(renderer.origin, { waitUntil: 'domcontentloaded' })
    await page.locator('app-main-window').waitFor({ timeout: 60000 })
    await page.evaluate(target => { location.hash = '#/main/blockly-editor?path=' + encodeURIComponent(target) }, project)
    await ready()
    const profileRoot = path.join(suite, 'agent-profile')
    Object.assign(process.env, { AILY_LIBRARY_HOST_PID: String(hostPid), AILY_APPDATA_PATH: config.appData,
      PI_CODING_AGENT_DIR: profileRoot, HOME: home, USERPROFILE: home, PI_OFFLINE: '1', npm_config_offline: 'true', npm_config_audit: 'false' })
    harness = await createRecoveredAgentHarness({ agentRoot: config.agent, sourceProject: project, globalRoot: suite, profileRoot,
      persistToolTranscript: true, onStage: stage => log('AGENT_STAGE', stage),
      async configureRegistry(context) {
        const module = await import(pathToFileURL(path.join(config.agent, 'dist/blockly/tools/registrars/library/lib-install-local.js')).href)
        module.registerLibInstallLocal(context)
        const docs = await import(pathToFileURL(path.join(config.agent, 'dist/blockly/tools/registrars/library/library-docs.js')).href)
        docs.registerLibraryDocs(context)
      },
      permissionApproval(request) {
        assert.equal(request.permissionMode, 'default')
        const input = request.input ?? {}
        if (['read', 'write', 'edit'].includes(request.toolName)) {
          if (typeof input.path !== 'string' || !path.isAbsolute(input.path)) return false
          if (request.toolName === 'read') return inside(project, input.path)
            || (inside(suite, input.path) && harness?.history.retainedReadRoots?.some(view => inside(view, input.path)))
          return same(input.path, path.join(project, 'project.abs'))
        }
        if (!['lib_install_local', 'library_docs', 'app_reload', 'app_close', 'abs_export', 'abs_apply', 'project_build'].includes(request.toolName)
          || typeof input.project !== 'string' || !same(input.project, project)) return false
        return request.toolName !== 'lib_install_local' || same(input.source ?? '', library)
          || (options.additionalLocalLibraries ?? []).some(name => /^[\w-]+$/.test(name)
            && same(input.source ?? '', path.join(suite, name)))
      } })

    await call('abs_export', { project, initialize: true })
    const installed = await call('lib_install_local', { project, source: library })
    assert.equal(installed.filesInstalled, true)
    assert.equal(installed.runtimeSync?.ready, true)
    await installedLibrary('install')
    const reloaded = await call('app_reload', { project })
    assert.equal(reloaded.ok, true)
    await ready()
    await installedLibrary('reload')
    const docs = await call('library_docs', { project, library: 'lib-esp32-task', maxChars: 1000 })
    assert.equal(docs.ok, true)
    assert.ok(inside(project, docs.file) && !docs.file.includes('.workspace-history'))
    const documentation = await call('read', { path: docs.file, limit: 5 })
    assert.ok(documentation.text.length > 0, 'The public documentation reference must work through core read')
    const exported = await call('abs_export', { project })
    assert.equal(exported.ok, true)
    assert.equal(typeof exported.generation, 'string')
    const canonicalState = await canvas()
    const canonical = indexBlocks(canonicalState)
    const canonicalVariables = variableTable(canonicalState)
    assert.ok([...canonical.values()].some(block => block.disabledReasons?.includes('MANUALLY_DISABLED')))
    assert.ok([...canonical.values()].some(block => block.collapsed === true))
    assert.ok([...canonical.values()].some(block => block.deletable === false))

    const absPath = path.join(project, 'project.abs')
    // Large opaque footers can exceed the core read tool's single-line limit.
    // Use the complete authenticated export, never a truncated read or fs, as
    // candidate input; the core read still observes the actual file version.
    const read = await call('read', { path: absPath, limit: 10 })
    assert.equal(typeof exported.abs, 'string')
    assert.equal(Buffer.byteLength(exported.abs), exported.bytes)
    assert.equal('sha256:' + hash(exported.abs), exported.evidence.binding.absHash)
    assert.ok(read.text.startsWith(exported.abs.split('\n').slice(0, 5).join('\n')))
    const originalAbs = exported.abs
    const candidate = fanTaskCandidate(originalAbs, 25)
    await call('write', { path: absPath, content: candidate })
    const edits = [{ oldText: 'esp32_task_delay(math_number(25))', newText: 'esp32_task_delay(math_number(20))' }]
    let finalCandidate = fanTaskCandidate(originalAbs, 20)
    if (config.unicode) {
      assert.equal(finalCandidate.split('arduino_global()').length, 2)
      const edit = { oldText: 'arduino_global()', newText: 'arduino_global()\n    variable_define("验收温度", int, math_number(7))' }
      edits.push(edit)
      finalCandidate = finalCandidate.replace(edit.oldText, edit.newText)
    }
    await call('edit', { path: absPath, edits })
    const readback = await call('read', { path: absPath, limit: 10 })
    assert.ok(readback.text.startsWith(finalCandidate.split('\n').slice(0, 5).join('\n')))
    const applied = await call('abs_apply', { project, generation: exported.generation, absPath })
    assert.equal(applied.ok, true)
    assert.equal(applied.receipt.candidate.hash, 'sha256:' + hash(finalCandidate))
    assert.equal(calls.filter(item => item.name === 'abs_apply').length, 1, 'Acceptance must not retry a failed apply')
    const afterState = await canvas()
    const after = indexBlocks(afterState)
    const afterVariables = variableTable(afterState), oldVariableIds = new Set(canonicalVariables.map(model => model.id))
    assert.deepEqual(afterVariables.filter(model => oldVariableIds.has(model.id)), canonicalVariables,
      'Preserve every complete variable record, not just its position')
    const addedVariables = afterVariables.filter(model => !oldVariableIds.has(model.id))
    if (config.unicode) {
      assert.equal(addedVariables.length, 1)
      assert.equal(addedVariables[0].name, '验收温度')
      assert.equal(addedVariables[0].type ?? '', '')
    } else assert.deepEqual(addedVariables, [])
    for (const [id, state] of canonical) assert.deepEqual(after.get(id), state,
      `Preserve canonical old block ${id}, including fields, extraState, disabled/collapsed/deletable state`)
    evidence.apply = { ok: true, count: 1, generation: exported.generation, canonicalOldBlocksPreserved: canonical.size,
      opaqueFooterPreserved: true, originalCallMetadataPreserved: true, actualAgentReadWriteEdit: true,
      completeBaselineSource: 'verified-abs-export', coreRead: 'bounded-program-preview', exactCandidateHashVerified: true,
      variableModelsPreserved: canonicalVariables.length, ...(config.unicode ? { unicodeDeclaration: '验收温度' } : {}) }
    await installedLibrary('apply')
    const buildDeadline = Date.now() + 12 * 60 * 1000
    let built = await call('project_build', { project }, { allowError: true })
    while (built.buildOutcome === 'unknown' && built.pendingBuild?.resumable === true) {
      const observation = built.pendingBuild
      assert.ok(Date.now() < buildDeadline, 'Observe only this compilation within the acceptance deadline')
      assert.equal(observation.tool, 'project_build')
      assert.ok(same(observation.arguments?.project ?? '', project))
      assert.equal(observation.arguments?.build_target_pid, hostPid)
      assert.equal(observation.arguments?.build_request_id, observation.requestId)
      await new Promise(resolve => setTimeout(resolve, 300))
      built = await call(observation.tool, observation.arguments, { allowError: true })
    }
    evidence.compileObservation = built
    assert.equal(built.ok, true, `Actual project_build failed: ${JSON.stringify(built)}`)
    assert.equal(built.buildExecutionKind, 'compilation')
    assert.equal(built.buildReceipt?.state, 'completed')
    assert.ok(same(built.buildReceipt.project, project))
    assert.equal(built.verification?.scope, 'project-compilation')
    assert.equal(built.verification?.status, 'passed')
    const code = await fs.readFile(path.join(project, '.temp/sketch/sketch.ino'), 'utf8')
    for (const pattern of [/#include\s*<DFRobot_Task\.h>/, /newTask\(fanTask\)/, /taskStart\(fanTask\)/,
      /void fanTask::loop\(\)/, /风扇处理\(\);\s*delay\(20\);/u]) assert.match(code, pattern)
    if (config.unicode) assert.match(code, /int\s+验收温度\s*=\s*7/u)
    const logPath = path.join(project, '.log/compile/latest-result.json')
    const buildLog = await call('read', { path: logPath, limit: 20 })
    assert.equal(buildLog.success, true)
    assert.equal(buildLog.state, 'done')
    assert.ok(same(buildLog.projectPath, project))
    evidence.publicReferences = { documentationRead: true, liveCompileResultRead: true }
    await harness.settle()
    evidence.proof = harness.proof()
    evidence.compile = { ok: true, buildReceipt: built.buildReceipt, verification: built.verification, sketchHash: hash(code) }
    evidence.libraryRuntime = { installed: true, ready: true, normalProjectReload: true }
    if (options.afterCompile) evidence.additionalAcceptance = await options.afterCompile({
      project, suite, hostPid, page, config, tools: harness, call,
    })
    await call('app_close', { project })
    evidence.ok = true
  } catch (error) {
    evidence.failure = { message: error.message, stack: error.stack, outcome: error.outcome }
    if (evidence.librarySnapshots?.length) await installedLibrary('failure-before-cleanup').catch(snapshotError => {
      evidence.librarySnapshotFailure = snapshotError.message
    })
    await page?.screenshot({ path: path.join(config.output, 'failure.png') }).catch(() => {})
    process.exitCode = 1
  } finally {
    const cleanupError = error => { (evidence.cleanupErrors ??= []).push(error.message); process.exitCode = 1 }
    await harness?.dispose().catch(cleanupError)
    if (app) {
      const native = app.process()
      let timer
      const exited = new Promise((resolve, reject) => {
        if (native.exitCode !== null || native.signalCode !== null) return resolve()
        native.once('exit', resolve)
        timer = setTimeout(() => reject(new Error('Suite-owned Electron did not exit')), 15000)
      })
      await app.evaluate(({ app }, expected) => {
        if (process.pid !== expected.pid || process.env.AILY_APPDATA_PATH !== expected.appData) throw new Error('Refuse to close an unrelated host')
        app.exit(0)
      }, { pid: hostPid ?? native.pid, appData: config.appData }).catch(cleanupError)
      await exited.catch(cleanupError).finally(() => clearTimeout(timer))
    }
    await renderer?.close().catch(cleanupError)
    if (before) {
      try { assert.deepEqual(await sourceHashes(seed), before); evidence.seedFilesPreservedAfterCleanup = true }
      catch (error) { cleanupError(error) }
    }
    evidence.ok = evidence.ok && process.exitCode !== 1
    await fs.writeFile(path.join(config.output, 'result.json'), JSON.stringify(evidence, null, 2))
    log(evidence.ok ? 'PASS' : 'FAIL', path.join(config.output, 'result.json'))
  }
  return evidence
}

if (process.argv[1] && same(fileURLToPath(import.meta.url), process.argv[1]))
  await runSerialInitializationAcceptance().catch(error => { console.error(error); process.exitCode = 1 })
