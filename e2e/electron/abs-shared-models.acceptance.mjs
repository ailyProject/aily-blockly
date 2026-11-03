import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { _electron } from '@playwright/test'
import { serveRendererBuild } from '../fixtures/build-renderer-server.mjs'
import { createRecoveredAgentHarness } from '../fixtures/abs-agent-tools.mjs'

// Reuse only a previous successful, suite-owned C3 fixture and its warm compiler
// cache. Program writes go through actual SDK read/write/edit tools, never fs.
const repo = fileURLToPath(new URL('../../', import.meta.url))
const root = path.resolve(process.env.AILY_SHARED_ROOT ?? '')
const project = path.resolve(process.env.AILY_SHARED_PROJECT ?? '')
const agentRoot = path.resolve(process.env.AILY_SHARED_AGENT ?? '')
const build = path.resolve(process.env.AILY_SHARED_HOST_BUILD ?? '')
const output = path.resolve(process.env.AILY_SHARED_OUTPUT ?? '')
const inside = (parent, file) => { const relative = path.relative(parent, file); return relative && relative !== '..'
  && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) }
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
const hash = value => createHash('sha256').update(value).digest('hex')
const log = (...values) => console.log(new Date().toISOString(), ...values)
assert.match(root.replaceAll('\\', '/'), /^C:\/.*\/aily-project\/dev-tests\//i)
assert.ok(inside(root, project) && /[\\/]serial-agent-[^\\/]+[\\/]project$/.test(project))
assert.ok(inside(path.join(repo, 'e2e/test-results'), output))
assert.ok(same(root, await fs.realpath(root)) && same(project, await fs.realpath(project)))
await fs.mkdir(output, { recursive: true })
const suite = await fs.mkdtemp(path.join(root, 'shared-models-'))
const home = path.join(suite, 'home'), profileRoot = path.join(suite, 'agent-profile')
const appData = path.join(root, 'appdata'), library = path.join(suite, 'pid-library')
await fs.mkdir(home)
await fs.cp(path.resolve(repo, '../aily-blockly-libraries/pid'), library, { recursive: true, force: false, errorOnExist: true })
assert.equal(JSON.parse(await fs.readFile(path.join(library, 'package.json'))).name, '@aily-project/lib-pid')
const seed = path.join(root, 'archive-user-project/esp32-c3-HANTAI')
const sourceHashes = async () => Object.fromEntries(await Promise.all(['package.json', 'package-lock.json', 'project.abi', 'project.abs', 'project.abs.map.json']
  .map(async name => [name, hash(await fs.readFile(path.join(seed, name)))])))
const sourceBefore = await sourceHashes()
const index = state => {
  const blocks = new Map()
  const visit = node => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) return node.forEach(visit)
    if (typeof node.type === 'string' && typeof node.id === 'string') {
      assert.ok(!blocks.has(node.id))
      const { inputs, next, x, y, ...rest } = node
      blocks.set(node.id, rest)
    }
    for (const [key, value] of Object.entries(node)) if (!['fields', 'extraState', 'variables'].includes(key)) visit(value)
  }
  visit(state)
  return blocks
}
const evidence = { ok: false, project, llmInvoked: false, realSdkTools: true, calls: [],
  userProjectsModified: false, hardwareUsed: false, simulatorUsed: false, dailyInstallReplaced: false }
let app, page, harness, renderer, hostPid
const call = async (name, input, options) => {
  log('AGENT_TOOL', name)
  const reply = await harness.call(name, input, options)
  evidence.calls.push({ name, isError: reply.isError })
  await fs.appendFile(path.join(output, 'tool-results.jsonl'), JSON.stringify({ name, input, ...reply }) + '\n')
  return reply.structured ?? reply
}
try {
  renderer = await serveRendererBuild(build)
  const { ELECTRON_RUN_AS_NODE, AILY_CHILD_PATH, NODE_PATH, ...env } = process.env
  app = await _electron.launch({ args: ['.', '--serve', `--user-data-dir=${path.join(suite, 'electron-profile')}`], cwd: repo,
    timeout: 60000, env: { ...env, AILY_E2E: '1', AILY_APPDATA_PATH: appData, HOME: home, USERPROFILE: home,
      AILY_DEV_RENDERER_URL: renderer.origin, npm_config_offline: 'true', npm_config_audit: 'false' } })
  hostPid = await app.evaluate(() => process.pid)
  evidence.hostPid = hostPid
  await app.firstWindow()
  const deadline = Date.now() + 60000
  while (!page && Date.now() < deadline) {
    page = app.windows().find(candidate => candidate.url().startsWith(renderer.origin))
    if (!page) await new Promise(resolve => setTimeout(resolve, 200))
  }
  assert.ok(page)
  page.on('dialog', dialog => dialog.dismiss())
  await page.goto(renderer.origin, { waitUntil: 'domcontentloaded' })
  await page.locator('app-main-window').waitFor({ timeout: 60000 })
  const ready = () => page.waitForFunction(target => {
    const element = document.querySelector('blockly-main')
    const service = element && window.ng?.getComponent(element)?.projectService
    return service?.currentProjectPath?.replaceAll('\\', '/') === target.replaceAll('\\', '/')
      && service.getBlocklyProjectLoadStatus(target)?.ready === true
  }, project, { timeout: 60000 })
  await page.evaluate(target => { location.hash = '#/main/blockly-editor?path=' + encodeURIComponent(target) }, project)
  await ready()
  Object.assign(process.env, { AILY_LIBRARY_HOST_PID: String(hostPid), AILY_APPDATA_PATH: appData,
    PI_CODING_AGENT_DIR: profileRoot, HOME: home, USERPROFILE: home, PI_OFFLINE: '1', npm_config_offline: 'true', npm_config_audit: 'false' })
  harness = await createRecoveredAgentHarness({ agentRoot, sourceProject: project, globalRoot: root, profileRoot,
    persistToolTranscript: true,
    async configureRegistry(context) {
      const module = await import(pathToFileURL(path.join(agentRoot, 'dist/blockly/tools/registrars/library/lib-install-local.js')).href)
      module.registerLibInstallLocal(context)
    },
    permissionApproval(request) {
      assert.equal(request.permissionMode, 'default')
      const input = request.input ?? {}
      if (['read', 'write', 'edit'].includes(request.toolName)) return typeof input.path === 'string'
        && (request.toolName === 'read' ? inside(project, input.path) : same(input.path, path.join(project, 'project.abs')))
      if (!['lib_install_local', 'app_reload', 'app_close', 'abs_export', 'abs_validate', 'abs_apply', 'project_build'].includes(request.toolName)
        || typeof input.project !== 'string' || !same(input.project, project)) return false
      return request.toolName !== 'lib_install_local' || same(input.source ?? '', library)
    } })
  const installed = await call('lib_install_local', { project, source: library, force: true })
  assert.equal(installed.runtimeSync?.ready, true)
  assert.equal((await call('app_reload', { project })).ok, true)
  await ready()
  const canvas = () => page.evaluate(() => JSON.parse(JSON.stringify(window.Blockly.serialization.workspaces.save(window.Blockly.getMainWorkspace()))))
  const previous = await canvas(), previousBlocks = index(previous), previousIds = new Set(previous.variables.map(model => model.id))
  evidence.baseline = { blocks: previousBlocks.size, models: previous.variables.length }
  const exported = await call('abs_export', { project })
  assert.equal(exported.ok, true)
  const absPath = path.join(project, 'project.abs')
  await call('read', { path: absPath, limit: 30 })
  assert.equal(exported.evidence.binding.absHash, 'sha256:' + hash(exported.abs))
  const suffix = randomUUID().slice(0, 8).replaceAll('-', '')
  const names = Object.fromEntries(['first', 'second', 'input', 'target', 'left', 'right'].map(key => [key, `shared_${key}_${suffix}`]))
  const additions = `\n    pid_init($${names.first}, $${names.input}, $${names.left}, $${names.target}, custom, 2, 5, 1, DIRECT)`
    + `\n    pid_init($${names.second}, $${names.input}, $${names.right}, $${names.target}, custom, 3, 5, 1, DIRECT)`
  assert.equal(exported.abs.split('arduino_global()').length, 2)
  const anchor = exported.abs.match(/^arduino_global\(\).*$/m)[0]
  const candidate = exported.abs.replace(anchor, anchor + additions)
  await call('write', { path: absPath, content: candidate })
  const oldText = `pid_init($${names.second}, $${names.input}, $${names.right}, $${names.target}, custom, 3, 5, 1, DIRECT)`
  const newText = oldText.replace('custom, 3,', 'custom, 4,')
  await call('edit', { path: absPath, edits: [{ oldText, newText }] })
  const validated = await call('abs_validate', { project, generation: exported.generation, absPath })
  assert.equal(validated.ok, true)
  const applied = await call('abs_apply', { project, generation: exported.generation, absPath })
  assert.equal(applied.ok, true)
  assert.equal(applied.receipt.candidate.hash, 'sha256:' + hash(candidate.replace(oldText, newText)))
  const assertPreserved = state => {
    const current = index(state)
    for (const [id, block] of previousBlocks) assert.deepEqual(current.get(id), block, 'Preserve fields, extraState, disabled/collapsed/protected blocks')
    assert.deepEqual(state.variables.filter(model => previousIds.has(model.id)), previous.variables)
    const added = state.variables.filter(model => !previousIds.has(model.id))
    assert.equal(added.length, 6)
    assert.deepEqual(added.map(model => model.name).sort(), Object.values(names).sort())
    for (const model of added) assert.equal(model.type, [names.first, names.second].includes(model.name) ? 'PID' : 'double')
    return { blocks: current.size, models: state.variables.length, added }
  }
  evidence.applied = assertPreserved(await canvas())
  await harness.settle()
  assert.equal((await call('app_reload', { project })).ok, true)
  await ready()
  evidence.reopened = assertPreserved(await canvas())
  assert.deepEqual(evidence.reopened.added, evidence.applied.added)
  // Graphical readiness precedes the loader's independent dependency-settled
  // notification. Observe that real state before compiling; no lock deletion,
  // repeated compile or optimistic fixed sleep.
  await page.waitForFunction(() => {
    const component = window.ng?.getComponent(document.querySelector('app-blockly-editor'))
    return component?._builderService?.isInstallInProgress() === false
  }, undefined, { timeout: 60000 })
  let built = await call('project_build', { project }, { allowError: true })
  const compileDeadline = Date.now() + 12 * 60 * 1000
  while (built.buildOutcome === 'unknown' && built.pendingBuild?.resumable === true) {
    assert.ok(Date.now() < compileDeadline)
    const observation = built.pendingBuild
    assert.equal(observation.arguments?.build_target_pid, hostPid)
    assert.ok(same(observation.arguments?.project ?? '', project))
    built = await call(observation.tool, observation.arguments, { allowError: true })
  }
  assert.equal(built.ok, true, JSON.stringify(built))
  assert.equal(built.buildReceipt?.state, 'completed')
  const sketch = await fs.readFile(path.join(project, '.temp/sketch/sketch.ino'), 'utf8')
  for (const name of [names.first, names.second]) assert.match(sketch, new RegExp('PID\\s+' + name + '\\s*\\('))
  evidence.compile = built
  evidence.proof = harness.proof()
  await harness.settle()
  await call('app_close', { project })
  evidence.ok = true
} catch (error) {
  evidence.failure = { message: error.message, stack: error.stack }
  process.exitCode = 1
} finally {
  await harness?.dispose().catch(error => { evidence.cleanupFailure = error.message; process.exitCode = 1 })
  if (app) await app.evaluate(({ app }, expected) => {
    if (process.pid !== expected.pid || process.env.AILY_APPDATA_PATH !== expected.appData) throw new Error('Refuse unrelated host shutdown')
    app.exit(0)
  }, { pid: hostPid, appData }).catch(error => { evidence.cleanupFailure = error.message; process.exitCode = 1 })
  await renderer?.close()
  assert.deepEqual(await sourceHashes(), sourceBefore)
  evidence.sourceSeedPreserved = true
  evidence.ok &&= process.exitCode !== 1
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(evidence, null, 2))
  log(evidence.ok ? 'PASS' : 'FAIL', path.join(output, 'result.json'))
}
