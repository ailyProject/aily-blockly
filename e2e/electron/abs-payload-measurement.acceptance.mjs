import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { _electron } from '@playwright/test'
import { serveRendererBuild } from '../fixtures/build-renderer-server.mjs'
import { createRecoveredAgentHarness } from '../fixtures/abs-agent-tools.mjs'

const repo = fileURLToPath(new URL('../../', import.meta.url))
const root = 'C:/Users/LENOVO/AppData/Local/aily-project/dev-tests/abs-serial-analysis-20261028'
const out = path.join(repo, 'e2e/test-results/abs-payload-20261029')
const suite = await fs.mkdtemp(path.join(root, 'payload-ojbadge-'))
const project = path.join(suite, 'project'), appData = path.join(suite, 'appdata')
const board = 'D:/codes/aily-blockly-boards/oj_badge'
const libraries = 'D:/codes/aily-blockly-libraries'
const build = process.env.AILY_PAYLOAD_HOST_BUILD ?? path.join(repo, 'tests/test-results/abs-third-reconciliation-20261028/host-build/browser')
const evidence = { ok: false, project, suite, userProjectsModified: false, compiled: false }
let app, renderer, pid, harness
await fs.mkdir(out, { recursive: true })
async function ordinaryTree(file) {
  const stat = await fs.lstat(file)
  assert.equal(stat.isSymbolicLink(), false, 'Only ordinary private fixture sources')
  if (stat.isDirectory()) for (const name of await fs.readdir(file)) await ordinaryTree(path.join(file, name))
  else assert.equal(stat.isFile(), true)
}
try {
  const seedInput = process.env.AILY_PAYLOAD_RECOVERY_SEED
  if (seedInput) {
    const seed = await fs.realpath(seedInput), relative = path.relative(root, seed)
    assert.ok(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))
    await fs.mkdir(project)
    for (const name of ['package.json', 'package-lock.json', 'project.abi', 'node_modules']) {
      await ordinaryTree(path.join(seed, name))
      await fs.cp(path.join(seed, name), path.join(project, name), { recursive: true, force: false, errorOnExist: true })
    }
    const manifest = JSON.parse(await fs.readFile(path.join(seed, 'package.json'), 'utf8'))
    for (const spec of Object.values(manifest.dependencies ?? {})) if (typeof spec === 'string' && spec.startsWith('file:')) {
      const local = spec.slice(5), source = path.resolve(seed, local), destination = path.resolve(project, local)
      assert.ok(!path.win32.isAbsolute(local) && !path.relative(seed, source).startsWith('..') && !path.relative(project, destination).startsWith('..'))
      await ordinaryTree(source)
      await fs.cp(source, destination, { recursive: true, force: false, errorOnExist: true })
    }
    evidence.fixture = 'existing-private-c3-seed'
  } else {
  const manifest = JSON.parse(await fs.readFile(path.join(board, 'template/package.json'), 'utf8'))
  const byName = new Map()
  for (const name of await fs.readdir(libraries)) {
    try { const dir = path.join(libraries, name), pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8')); byName.set(pkg.name, { dir, pkg }) } catch {}
  }
  byName.set('@aily-project/board-ojbadge', { dir: board, pkg: JSON.parse(await fs.readFile(path.join(board, 'package.json'), 'utf8')) })
  for (const name of Object.keys(manifest.dependencies)) {
    const entry = byName.get(name)
    assert.ok(entry, 'Available local package ' + name)
    const destination = path.join(project, 'node_modules/@aily-project', name.slice('@aily-project/'.length))
    await fs.mkdir(path.dirname(destination), { recursive: true })
    await fs.cp(entry.dir, destination, { recursive: true, force: false, errorOnExist: true })
    manifest.dependencies[name] = entry.pkg.version
  }
  await fs.copyFile(path.join(board, 'template/project.abi'), path.join(project, 'project.abi'))
  await fs.writeFile(path.join(project, 'package.json'), JSON.stringify(manifest, null, 2))
  await fs.writeFile(path.join(project, 'package-lock.json'), JSON.stringify({ name: manifest.name, lockfileVersion: 3, packages: { '': { dependencies: manifest.dependencies } } }))
  evidence.fixture = 'ojbadge-current-libraries'
  }
  await fs.mkdir(appData)
  renderer = await serveRendererBuild(build)
  const { ELECTRON_RUN_AS_NODE, AILY_CHILD_PATH, NODE_PATH, ...env } = process.env
  const home = path.join(suite, 'home'); await fs.mkdir(home)
  app = await _electron.launch({ args: ['.', '--serve', '--user-data-dir=' + path.join(suite, 'electron-profile')], cwd: repo,
    env: { ...env, AILY_E2E: '1', AILY_APPDATA_PATH: appData, HOME: home, USERPROFILE: home,
      AILY_DEV_RENDERER_URL: renderer.origin, npm_config_offline: 'true', npm_config_audit: 'false' }, timeout: 60000 })
  pid = await app.evaluate(() => process.pid)
  let page
  for (let until = Date.now() + 60000; !page && Date.now() < until;) {
    page = app.windows().find(window => window.url().startsWith(renderer.origin))
    if (!page) await new Promise(resolve => setTimeout(resolve, 200))
  }
  assert.ok(page)
  page.on('dialog', dialog => dialog.dismiss())
  await page.goto(renderer.origin)
  await page.locator('app-main-window').waitFor({ timeout: 60000 })
  await page.evaluate(project => { location.hash = '#/main/blockly-editor?path=' + encodeURIComponent(project) }, project)
  await page.waitForFunction(project => {
    const element = document.querySelector('blockly-main')
    const component = element && window.ng?.getComponent(element)
    return component?.projectService?.getBlocklyProjectLoadStatus(project)?.ready === true
  }, project, { timeout: 90000 })
  evidence.parts = await page.evaluate(() => {
    const component = window.ng.getComponent(document.querySelector('blockly-main'))
    const service = component.blocklyService ?? component.projectService.blocklyService
    const replay = service.captureNativeReplay()
    const size = value => JSON.stringify(value)?.length ?? 0
    const steps = replay.steps.map(step => ({ kind: step.kind, label: step.kind === 'script' ? step.label.replace(/^.*[/\\]/, '') : undefined,
      library: step.kind === 'definitions' ? step.libraryName : step.kind === 'i18n' ? step.packageName : undefined, characters: size(step) }))
    const byKind = {}
    for (const step of steps) byKind[step.kind] = (byKind[step.kind] ?? 0) + step.characters
    const request = { steps: replay.steps, graphics: replay.graphics, blocks: [], abs: '# ABS Schema: 2\narduino_global()\narduino_setup()\narduino_loop()' }
    replay.assertCurrent()
    return { requestCharacters: size(request), requestUtf8Bytes: new TextEncoder().encode(JSON.stringify(request)).byteLength,
      stepCount: steps.length, stepsCharacters: size(replay.steps), graphicsCharacters: size(replay.graphics),
      byKind, largest: steps.sort((a, b) => b.characters - a.characters).slice(0, 12),
      graphicsParts: Object.fromEntries(Object.entries(replay.graphics ?? {}).map(([key, value]) => [key, size(value)])) }
  })
  let exported, candidate, call
  const agentRoot = process.env.AILY_PAYLOAD_RECOVERY_AGENT
  if (agentRoot) {
    assert.ok(path.isAbsolute(agentRoot))
    await fs.access(path.join(agentRoot, 'package.json')); await fs.access(path.join(agentRoot, 'dist/index.js'))
    const profileRoot = path.join(suite, 'agent-profile')
    const temporary = path.join(suite, 'temporary'); await fs.mkdir(temporary)
    Object.assign(process.env, { AILY_LIBRARY_HOST_PID: String(pid), AILY_APPDATA_PATH: appData,
      PI_CODING_AGENT_DIR: profileRoot, HOME: home, USERPROFILE: home, PI_OFFLINE: '1', TEMP: temporary, TMP: temporary })
    const inside = value => { const relative = path.relative(suite, value); return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep) }
    harness = await createRecoveredAgentHarness({ agentRoot, sourceProject: project, globalRoot: suite, profileRoot,
      permissionApproval(request) {
        assert.equal(request.permissionMode, 'default')
        if (['read', 'write', 'edit'].includes(request.toolName)) {
          const input = request.input ?? {}
          return typeof input.path === 'string' && path.isAbsolute(input.path) && inside(input.path)
            && (request.toolName === 'read' || path.resolve(input.path) === path.join(project, 'project.abs'))
        }
        return ['abs_export', 'abs_validate', 'abs_apply', 'project_recover', 'app_reload'].includes(request.toolName)
      } })
    call = async (name, input, options = {}) => {
      console.log('AGENT_TOOL', name, input.action ?? '')
      const result = await harness.call(name, input, options)
      const value = result.structured ?? result
      ;(evidence.calls ??= []).push({ name, isError: result.isError, code: value.code, ok: value.ok })
      await fs.appendFile(path.join(out, 'recovery-tools.jsonl'), JSON.stringify({ name, isError: result.isError, result: value }) + '\n')
      return value
    }
    exported = await call('abs_export', { project })
    assert.equal(exported.ok, true); assert.equal(typeof exported.abs, 'string')
    await call('read', { path: path.join(project, 'project.abs'), limit: 15 })
    await call('write', { path: path.join(project, 'project.abs'), content: exported.abs })
    const header = exported.abs.split('\n').find(line => line.startsWith('arduino_setup()'))
    assert.ok(header)
    const edit = { oldText: header, newText: header + '\n    time_delay(math_number(1))' }
    await call('edit', { path: path.join(project, 'project.abs'), edits: [edit] })
    candidate = exported.abs.replace(edit.oldText, edit.newText)
  }
  evidence.repeatedContext = await page.evaluate(async () => {
    const component = window.ng.getComponent(document.querySelector('blockly-main'))
    const runtime = component.generatorRuntime
    const size = value => JSON.stringify(value).length
    let replay = runtime.captureNativeReplay()
    const initial = size({ steps: replay.steps, graphics: replay.graphics, blocks: [] })
    const context = replay.steps.filter(step => step.kind === 'context').at(-1)
    const amount = Math.ceil((16 * 1024 * 1024 - initial) / (size(context) + 1)) + 1
    for (let i = 0; i < amount; i++) runtime.updateContext({})
    replay = runtime.captureNativeReplay()
    const request = { steps: replay.steps, graphics: replay.graphics, blocks: [] }
    const messageCounts = new Map()
    for (const step of replay.steps) {
      const value = step.kind === 'context' ? step.messages : step.kind === 'messages' ? step.value : undefined
      if (value) { const json = JSON.stringify(value); messageCounts.set(json, (messageCounts.get(json) ?? 0) + 1) }
    }
    const result = { initialCharacters: initial, appendedContexts: amount, contextCharacters: size(context),
      requestCharacters: size(request), contextTotalCharacters: replay.steps.filter(step => step.kind === 'context').reduce((sum, step) => sum + size(step), 0),
      requestUtf8Bytes: new TextEncoder().encode(JSON.stringify(request)).byteLength,
      messageSnapshotCount: [...messageCounts.values()].reduce((a, b) => a + b, 0), distinctMessageSnapshots: messageCounts.size,
      repeatedMessageCharacters: [...messageCounts].reduce((sum, [json, count]) => sum + (count - 1) * json.length, 0),
      actualLimit: 16 * 1024 * 1024 }
    try {
      await runtime.evaluateNativeCandidate([], { assertCurrent() {} })
      return { ...result, rejected: false }
    } catch (error) {
      return { ...result, rejected: true, code: error.code, message: error.message }
    }
  })
  assert.equal(evidence.repeatedContext.rejected, true)
  assert.match(evidence.repeatedContext.message, /requestCharacters count/)
  if (harness) {
    const failure = await call('abs_validate', { project, generation: exported.generation, absPath: path.join(project, 'project.abs') }, { expectError: true })
    assert.equal(failure.code, 'ABS_LIMIT')
    const beforeCanvas = await page.evaluate(() => {
      const workspace = window.Blockly.getMainWorkspace()
      workspace.getTopBlocks(false)[0].setCollapsed(true)
      const block = workspace.newBlock('math_number', 'capacity-user-unsaved-number')
      block.setFieldValue(19, 'NUM'); block.initSvg(); block.render(); block.moveBy(550, 120)
      return JSON.parse(JSON.stringify(window.Blockly.serialization.workspaces.save(workspace)))
    })
    const inspection = await call('project_recover', { project, action: 'inspect' })
    const offer = inspection.diagnostics?.repair
    evidence.recovery = { inspection: { ok: inspection.ok, status: inspection.diagnostics?.status, issues: inspection.diagnostics?.issues,
      offeredRepair: !!offer }, actualAgentTools: true, userCanvasUnsaved: true, originalDraftBytes: Buffer.byteLength(candidate) }
    assert.ok(offer?.token && offer.authority === 'workspace', 'Only an actual preserving repair offer authorizes repair')
    const repaired = await call('project_recover', { project, action: 'repair', token: offer.token, authority: offer.authority })
    assert.equal(repaired.ok, true)
    assert.deepEqual(await page.evaluate(() => JSON.parse(JSON.stringify(window.Blockly.serialization.workspaces.save(window.Blockly.getMainWorkspace())))), beforeCanvas)
    const archived = await call('project_recover', { project, action: 'read_repair', generation: repaired.recoveryArchive.generation })
    assert.equal(archived.ok, true); assert.equal(archived.draft.abs, exported.abs)
    assert.equal(typeof repaired.candidateFile, 'string')
    const artifact = await call('read', { path: repaired.candidateFile, limit: 15 })
    assert.equal(repaired.candidateArtifact.hash, 'sha256:' + createHash('sha256').update(candidate).digest('hex'))
    assert.equal(repaired.candidateArtifact.bytes, Buffer.byteLength(candidate))
    assert.ok(artifact.text.startsWith(candidate.split('\n').slice(0, 5).join('\n')),
      'Core read previews the authenticated complete candidate; never treat a truncated footer as a complete candidate')
    const reloaded = await call('app_reload', { project })
    assert.equal(reloaded.ok, true)
    await page.waitForFunction(project => {
      const element = document.querySelector('blockly-main'), component = element && window.ng?.getComponent(element)
      return component?.projectService?.getBlocklyProjectLoadStatus(project)?.ready === true
    }, project, { timeout: 60000 })
    assert.deepEqual(await page.evaluate(() => JSON.parse(JSON.stringify(window.Blockly.serialization.workspaces.save(window.Blockly.getMainWorkspace())))), beforeCanvas)
    const fresh = await call('abs_export', { project })
    assert.equal(fresh.ok, true)
    await call('read', { path: path.join(project, 'project.abs'), limit: 15 })
    const freshHeader = fresh.abs.split('\n').find(line => line.startsWith('arduino_setup()'))
    await call('edit', { path: path.join(project, 'project.abs'), edits: [{ oldText: freshHeader, newText: freshHeader + '\n    time_delay(math_number(1))' }] })
    const validation = await call('abs_validate', { project, generation: fresh.generation, absPath: path.join(project, 'project.abs') })
    assert.equal(validation.ok, true)
    const applied = await call('abs_apply', { project, generation: fresh.generation, absPath: path.join(project, 'project.abs') })
    assert.equal(applied.ok, true)
    const after = await page.evaluate(() => {
      const component = window.ng.getComponent(document.querySelector('blockly-main'))
      const replay = component.generatorRuntime.captureNativeReplay()
      return { steps: replay.steps.length, characters: JSON.stringify({ steps: replay.steps, graphics: replay.graphics, blocks: [] }).length,
        userNumber: window.Blockly.getMainWorkspace().getBlockById('capacity-user-unsaved-number')?.getFieldValue('NUM') }
    })
    assert.equal(after.userNumber, 19); assert.ok(after.characters < 16777216)
    Object.assign(evidence.recovery, { repaired: true, archiveExact: true, candidateArtifactRead: 'bounded-preview-and-authenticated-full-hash', canvasPreservedAfterRepairAndReload: true,
      freshValidation: validation.ok, freshApply: applied.ok, after, proof: harness.proof() })
    await harness.settle()
  }
  evidence.ok = true
} catch (error) {
  evidence.failure = { name: error.name, message: error.message }
  process.exitCode = 1
} finally {
  await harness?.dispose()
  if (app) await app.evaluate(({ app }, expected) => {
    if (process.pid !== expected.pid || process.env.AILY_APPDATA_PATH !== expected.appData) throw Error('Refuse unrelated process cleanup')
    app.exit(0)
  }, { pid, appData }).catch(error => { evidence.cleanupError = error.message; process.exitCode = 1 })
  await renderer?.close()
  await fs.writeFile(path.join(out, 'measurement.json'), JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify(evidence))
}
