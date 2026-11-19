import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from '@playwright/test'
import { createRecoveredAgentHarness } from '../fixtures/abs-agent-tools.mjs'
import { serveRendererBuild } from '../fixtures/build-renderer-server.mjs'
import { runRuntimeSnapshotRecoveryCase } from '../fixtures/runtime-snapshot-recovery-case.mjs'

const require = createRequire(import.meta.url)
const { installAbsTimeoutFault } = require('../fixtures/abs/abs-timeout-fault.cjs')
const { seedPrivateData } = require('../../electron/project-repair-environment.js')
const repo = fileURLToPath(new URL('../../', import.meta.url))
const required = name => { assert.ok(process.env[name] && path.isAbsolute(process.env[name]), `${name} must be explicit and absolute`); return path.resolve(process.env[name]) }
const root = required('AILY_NATIVE_RECOVERY_ROOT')
const project = required('AILY_NATIVE_RECOVERY_PROJECT')
const hostBuild = required('AILY_NATIVE_RECOVERY_HOST_BUILD')
const agentRoot = required('AILY_NATIVE_RECOVERY_AGENT_ROOT')
const output = required('AILY_NATIVE_RECOVERY_OUTPUT')
const sourceProject = required('AILY_NATIVE_RECOVERY_SOURCE')
const dailyConfig = required('AILY_NATIVE_RECOVERY_DAILY_CONFIG')
const scenario = process.env.AILY_NATIVE_RECOVERY_SCENARIO ?? 'watchdog'
assert.ok(['watchdog', 'runtime-snapshot'].includes(scenario), 'Unknown native recovery acceptance scenario')
const inside = (parent, child) => { const relative = path.relative(parent, child); return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) }
assert.match(root.replaceAll('\\', '/'), /\/aily-project\/dev-tests\/[^/]+$/i)
assert.ok(inside(root, project) && /[\\/]native-recovery-20261102-[0-9a-f-]{36}[\\/]project$/.test(project), 'Only a new isolated native-recovery project is allowed')
assert.ok(inside(path.join(repo, 'e2e/test-results'), output))
assert.ok(inside(path.join(root, 'archive-user-project'), sourceProject), 'Only the read-only acceptance source archive may seed this project')
const sourceFingerprint = async () => {
  const entries = []
  const visit = async (directory, prefix = '') => {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const filename = path.join(directory, entry.name), relative = prefix ? `${prefix}/${entry.name}` : entry.name
      const stat = await fs.lstat(filename)
      if (stat.isSymbolicLink()) entries.push([relative, 'link', createHash('sha256').update(await fs.readlink(filename)).digest('hex')])
      else if (stat.isDirectory()) await visit(filename, relative)
      else if (stat.isFile()) entries.push([relative, createHash('sha256').update(await fs.readFile(filename)).digest('hex')])
    }
  }
  await visit(sourceProject)
  return { files: entries.length, sha256: createHash('sha256').update(JSON.stringify(entries)).digest('hex') }
}
const sourceBefore = await sourceFingerprint(), dailyBefore = createHash('sha256').update(await fs.readFile(dailyConfig)).digest('hex')
await assert.rejects(fs.lstat(project), { code: 'ENOENT' })
const excluded = new Set(['.git', '.temp', '.build', '.log', '.workspace-history', 'test-results', 'playwright-report'])
async function copyInitialSource(from, to) {
  await fs.mkdir(to, { recursive: true })
  for (const entry of await fs.readdir(from, { withFileTypes: true })) {
    const original = path.join(from, entry.name), target = path.join(to, entry.name), stat = await fs.lstat(original)
    if (excluded.has(entry.name) || stat.isSymbolicLink()) continue
    if (stat.isDirectory()) await copyInitialSource(original, target)
    else if (stat.isFile()) await fs.copyFile(original, target, fs.constants.COPYFILE_EXCL)
  }
}
await copyInitialSource(sourceProject, project) // Initial isolated copy only; all subsequent ABS edits use real SDK tools.
assert.equal((await fs.realpath(project)).toLowerCase(), project.toLowerCase())
await fs.mkdir(output, { recursive: true })
const suite = await fs.mkdtemp(path.join(root, 'native-recovery-'))
const home = path.join(suite, 'home'), profileRoot = path.join(suite, 'agent-profile'), appData = path.join(suite, 'appdata')
await fs.mkdir(home)
// Reuse the product's anonymous repair-profile seeding, not an active test or
// daily writable appdata tree. Only existing immutable compilation resources
// are referenced; board manifests and configuration are private copies.
const resourceRoot = path.join(root, 'appdata')
seedPrivateData({ privateAppData: appData, profile: path.join(suite, 'electron-profile'), project }, path.dirname(dailyConfig))
const privateConfig = JSON.parse(await fs.readFile(path.join(appData, 'config.json'), 'utf8'))
Object.assign(privateConfig, { onboardingCompleted: true, blocklyOnboardingCompleted: true })
await fs.writeFile(path.join(appData, 'config.json'), JSON.stringify(privateConfig))
for (const relative of ['sdk', 'tools', 'npm-global/node_modules']) {
  const resource = await fs.realpath(path.join(resourceRoot, relative)), destination = path.join(appData, relative)
  await fs.mkdir(path.dirname(destination), { recursive: true })
  await fs.symlink(resource, destination, process.platform === 'win32' ? 'junction' : 'dir')
}
for (const entry of await fs.readdir(path.join(resourceRoot, 'npm-global'), { withFileTypes: true })) {
  if (entry.isFile() && /^(?:aily-builder|aily-linter|aily-connector)(?:\.cmd|\.ps1)?$/.test(entry.name))
    await fs.copyFile(path.join(resourceRoot, 'npm-global', entry.name), path.join(appData, 'npm-global', entry.name), fs.constants.COPYFILE_EXCL)
}
const absPath = path.join(project, 'project.abs')
const sha = value => createHash('sha256').update(value).digest('hex')
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
const canonicalHash = value => sha(JSON.stringify(canonical(value)))
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
const blocks = document => {
  const result = new Map()
  const visit = value => {
    if (!value || typeof value.type !== 'string' || typeof value.id !== 'string') return
    assert.equal(result.has(value.id), false, 'Native block IDs must be unique')
    const { inputs, next, x, y, ...attributes } = value
    result.set(value.id, attributes)
    for (const input of Object.values(inputs ?? {})) { visit(input?.block); visit(input?.shadow) }
    visit(next?.block)
  }
  for (const page of document.pages) for (const block of page.content?.blocks?.blocks ?? []) visit(block)
  for (const block of document.sharedModel?.procedureBlocks ?? []) visit(block)
  return result
}
const evidence = { ok: false, actualSdkTools: true, llmInvoked: false, hardwareUsed: false, simulatorUsed: false,
  userProjectsModified: false, dailyInstallReplaced: false, scenario, project, suite, hostBuild, agentRoot, stages: [] }
let renderer, app, page, hostPid, harness
const stage = async name => { evidence.stages.push({ name, at: Date.now() }); await fs.writeFile(path.join(output, 'progress.json'), JSON.stringify(evidence, null, 2)); console.log(`NATIVE_RECOVERY_PHASE=${name}`) }
const nativeDocument = () => page.evaluate(() => JSON.parse(window.ng.getComponent(document.querySelector('app-blockly-editor')).blocklyService.captureRecoverySnapshot().documentText))
async function stopOwned() {
  if (!app) return
  const closed = app.waitForEvent('close', { timeout: 15000 })
  await app.evaluate(({ app }, expected) => {
    if (process.pid !== expected.pid || process.env.AILY_APPDATA_PATH !== expected.appData) throw new Error('Refuse unrelated host shutdown')
    app.exit(0)
  }, { pid: hostPid, appData })
  await closed
  app = undefined
}
try {
  await stage('launch')
  renderer = await serveRendererBuild(hostBuild)
  const { ELECTRON_RUN_AS_NODE, AILY_CHILD_PATH, NODE_PATH, AILY_AUTH_FILE, AILY_API_SERVER, AILY_LIBRARY_HOST_PID, ...env } = process.env
  app = await _electron.launch({ cwd: repo, args: ['.', '--serve', `--user-data-dir=${path.join(suite, 'electron-profile')}`],
    timeout: 60000, env: { ...env, AILY_E2E: '1', AILY_APPDATA_PATH: appData, AILY_MAIN_APPDATA_PATH: appData,
      AILY_NPM_PREFIX: path.join(appData, 'npm-global'), AILY_SDK_PATH: path.join(appData, 'sdk'), AILY_TOOLS_PATH: path.join(appData, 'tools'),
      AILY_COMPILERS_PATH: path.join(appData, 'tools'), AILY_BUILDER_PATH: path.join(suite, 'builder-cache'), npm_config_cache: path.join(suite, 'npm-cache'), HOME: home, USERPROFILE: home,
      AILY_DEV_RENDERER_URL: renderer.origin, npm_config_offline: 'true', npm_config_audit: 'false' } })
  hostPid = await app.evaluate(() => process.pid)
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
  await page.evaluate(target => { location.hash = '#/main/blockly-editor?path=' + encodeURIComponent(target) }, project)
  await page.waitForFunction(target => {
    const mainElement = document.querySelector('blockly-main'), editorElement = document.querySelector('app-blockly-editor')
    const main = mainElement && window.ng?.getComponent(mainElement)
    const editor = editorElement && window.ng?.getComponent(editorElement)
    return main?.projectService?.currentProjectPath?.replaceAll('\\', '/') === target.replaceAll('\\', '/')
      && main.projectService.getBlocklyProjectLoadStatus(target)?.ready === true && editor?._builderService?.isInstallInProgress() === false
  }, project, { timeout: 60000 })
  Object.assign(process.env, { AILY_LIBRARY_HOST_PID: String(hostPid), AILY_APPDATA_PATH: appData, AILY_NPM_PREFIX: path.join(appData, 'npm-global'),
    PI_CODING_AGENT_DIR: profileRoot, HOME: home, USERPROFILE: home, PI_OFFLINE: '1', npm_config_offline: 'true', npm_config_audit: 'false' })
  harness = await createRecoveredAgentHarness({ agentRoot, sourceProject: project, globalRoot: root, profileRoot, persistToolTranscript: true,
    permissionApproval(request) {
      if (['read', 'write', 'edit'].includes(request.toolName)) return typeof request.input?.path === 'string' &&
        (same(request.input.path, absPath) || same(request.input.path, path.join(project, '.log/compile/latest-result.json')))
      return typeof request.input?.project === 'string' && same(request.input.project, project) &&
        ['project_recover', 'project_build', 'abs_export', 'abs_validate', 'abs_apply'].includes(request.toolName)
    } })
  const inspection = (await harness.call('project_recover', { project, action: 'inspect' })).structured
  if (inspection.diagnostics?.repair) {
    const offer = inspection.diagnostics.repair
    assert.equal((await harness.call('project_recover', { project, action: 'repair', token: offer.token, authority: offer.authority })).structured.ok, true)
  }
  const exported = (await harness.call('abs_export', { project })).structured
  assert.equal(exported.ok, true)
  const before = await nativeDocument(), oldBlocks = blocks(before), oldModels = before.sharedModel?.variables ?? []
  await stage('actual-sdk-file-edit')
  await harness.call('read', { path: absPath, limit: 16 })
  await harness.write(absPath, exported.abs)
  const anchor = exported.abs.match(/^arduino_loop\(\).*$/m)?.[0]
  assert.ok(anchor, 'The isolated seed must have an Arduino loop root')
  const marker = `NATIVE_RECOVERY_${path.basename(suite).replaceAll('-', '_')}`
  await harness.edit(absPath, anchor, `${anchor}\n    serial_print(Serial, text("${marker}"))`)
  const candidateHash = sha(await fs.readFile(absPath))

  await page.evaluate(expected => {
    const main = window.ng.getComponent(document.querySelector('blockly-main'))
    if (main.projectService.currentProjectPath.replaceAll('\\', '/').toLowerCase() !== expected.replaceAll('\\', '/').toLowerCase()) throw new Error('Refuse another project')
    const editor = window.ng.getComponent(document.querySelector('app-blockly-editor')).blocklyService
    const original = editor.rebuildLibraryRuntimeInPlace
    if (typeof original !== 'function') throw new Error('The actual runtime rebuilding method is unavailable')
    window.__nativeRecoveryAudit = { rebuilds: [], requests: [] }
    editor.rebuildLibraryRuntimeInPlace = async function (...args) {
      const record = { started: Date.now(), before: this.getProjectDocument(args[1]), beforeSession: this.generatorRuntime?.session?.id,
        disposableRealmsBeforeRecovery: document.querySelectorAll('[data-blockly-native-candidate]').length }
      window.__nativeRecoveryAudit.rebuilds.push(record)
      try {
        const result = await original.apply(this, args)
        record.after = this.getProjectDocument(args[1]); record.afterSession = this.generatorRuntime?.session?.id
        record.completed = true
        return result
      } finally { record.finished = Date.now() }
    }
    const ipc = window.ipcRenderer ?? window.electronAPI?.ipcRenderer
    if (!ipc?.on) throw new Error('Actual renderer IPC observations are unavailable')
    ipc.on('cli-bridge:blockly-live-operation', (_event, payload) => {
      if (['abs_validate', 'abs_apply', 'abs_recovery'].includes(payload?.operation)) window.__nativeRecoveryAudit.requests.push({
        operation: payload.operation, action: payload.params?.action, requestId: payload.params?.requestId,
        observe: payload.params?.observe === true, candidateHash: payload.params?.candidate?.hash })
    })
  }, project)
  if (scenario === 'runtime-snapshot') {
    const recovered = await runRuntimeSnapshotRecoveryCase({ page, harness, project, generation: exported.generation,
      absPath, before, canonicalHash, candidateHash, readCandidateHash: async () => sha(await fs.readFile(absPath)), nativeDocument, stage,
      captureUi: name => page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true }),
      changeRuntimeInput: async () => {
        // Test-only input fault, never an ABS edit or a shared library mutation.
        const generator = path.join(project, 'node_modules/@aily-project/lib-core-serial/generator.js')
        assert.ok(inside(project, generator))
        const original = await fs.readFile(generator)
        await fs.writeFile(generator, Buffer.concat([original, Buffer.from('\n// isolated runtime acknowledgement fault\n')]))
        return () => fs.writeFile(generator, original)
      } })
    evidence.recovery = recovered.recovery
  } else {
  await page.evaluate(installAbsTimeoutFault, 'always')
  await page.evaluate(() => {
    const fault = window.absTimeoutFault, state = fault.evidence
    let fired = state.fired
    // Fire the two existing disposable-execution watchdogs, then remove all
    // instrumentation before the real protected runtime rebuild begins.
    Object.defineProperty(state, 'fired', { enumerable: true, get: () => fired, set(value) {
      fired = value
      if (fired === 2) queueMicrotask(() => { window.__nativeRecoveryFault = fault.restore() })
    } })
  })
  await stage('native-fault-and-protected-recovery')
  const validated = (await harness.call('abs_validate', { project, generation: exported.generation, absPath })).structured
  assert.equal(validated.ok, true, JSON.stringify(validated))
  assert.equal(validated.finalValidation?.scope, 'prepared-generation')
  assert.equal(validated.nativeRecovery?.verified, true, 'The failure must be handled by the actual tool-internal protected recovery')
  assert.equal(validated.nativeRecovery.candidateApplied, false)
  const observed = await page.evaluate(() => ({ ...window.__nativeRecoveryAudit, fault: window.__nativeRecoveryFault }))
  assert.equal(observed.fault?.fired, 2)
  assert.deepEqual(observed.fault.budgets, [10000, 30000])
  assert.equal(observed.rebuilds.length, 1, 'Exactly one real library-runtime rebuild is required')
  const rebuild = observed.rebuilds[0]
  assert.equal(rebuild.completed, true)
  assert.equal(rebuild.disposableRealmsBeforeRecovery, 0, 'Both failed native realms must be disposed before protected recovery')
  assert.ok(rebuild.beforeSession && rebuild.afterSession && rebuild.beforeSession !== rebuild.afterSession)
  assert.equal(canonicalHash(rebuild.before), canonicalHash(rebuild.after), 'Runtime recovery must preserve the complete current canvas')
  assert.equal(canonicalHash(await nativeDocument()), canonicalHash(before), 'Candidate preparation must not apply to the canvas')
  assert.equal(sha(await fs.readFile(absPath)), candidateHash)
  const recoveryStarts = observed.requests.filter(item => item.operation === 'abs_recovery' && item.action === 'prepare_native' && !item.observe)
  assert.equal(recoveryStarts.length, 1)
  assert.equal(observed.requests.filter(item => item.operation === 'abs_validate').length, 1)
  evidence.recovery = { watchdogsFired: 2, budgets: observed.fault.budgets, realRuntimeRebuilds: 1,
    runtimeSessionChanged: true, completeCanvasPreserved: true, candidateBytesPreserved: true,
    originalRequestIdSha256: sha(recoveryStarts[0].requestId), validation: validated }
  }

  await stage('ordinary-apply')
  const applied = (await harness.call('abs_apply', { project, generation: exported.generation, absPath })).structured
  assert.equal(applied.ok, true, JSON.stringify(applied))
  assert.equal(applied.applyVerification?.ok, true)
  const after = await nativeDocument(), afterBlocks = blocks(after), oldIds = new Set(oldModels.map(value => value.id))
  for (const [id, value] of oldBlocks) assert.deepEqual(afterBlocks.get(id), value, `Original native block ${id} must retain fields, extraState and protections`)
  assert.deepEqual((after.sharedModel?.variables ?? []).filter(value => oldIds.has(value.id)), oldModels)
  assert.deepEqual(after.openedPageIds, before.openedPageIds)
  assert.deepEqual(after.pages.map(({ id, title }) => ({ id, title })), before.pages.map(({ id, title }) => ({ id, title })))
  evidence.apply = { count: 1, completeReadbackVerified: true, originalNativeBlocksPreserved: oldBlocks.size,
    finalNativeBlocks: afterBlocks.size, originalModelsPreserved: oldModels.length, pagesPreserved: before.pages.length }
  await stage('fresh-compilation')
  const compileStarted = Date.now(), resultFile = path.join(project, '.log/compile/latest-result.json')
  const previousCompile = await fs.readFile(resultFile, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return null })
  let built = (await harness.call('project_build', { project }, { allowError: true })).structured
  const buildDeadline = Date.now() + 12 * 60_000
  while (built.buildOutcome === 'unknown' && built.pendingBuild?.resumable === true) {
    assert.ok(Date.now() < buildDeadline)
    const original = built.pendingBuild
    assert.equal(original.tool, 'project_build'); assert.ok(same(original.arguments.project, project))
    assert.equal(original.arguments.build_target_pid, hostPid)
    built = (await harness.call(original.tool, original.arguments, { allowError: true })).structured
  }
  assert.equal(built.ok, true, JSON.stringify(built))
  const compileText = await fs.readFile(resultFile, 'utf8'), compile = JSON.parse(compileText)
  assert.equal(compile.success, true); assert.ok(compile.finishedAt >= compileStarted); assert.notEqual(compileText, previousCompile)
  const code = await fs.readFile(path.join(project, '.temp/sketch/sketch.ino'), 'utf8')
  assert.ok(code.includes(marker))
  evidence.compile = { success: true, finishedAt: compile.finishedAt, freshResultVerified: true, markerPresent: true }
  evidence.actualSdkProof = harness.proof()
  assert.equal(evidence.actualSdkProof.calls.filter(item => item.name === 'abs_apply').length, 1)
  assert.equal(evidence.actualSdkProof.calls.filter(item => item.name === 'abs_validate').length, 1)
  await harness.settle()
  if (scenario === 'runtime-snapshot') {
    await stage('manual-save-restored-canvas-and-native-exit')
    await page.evaluate(() => {
      const service = window.ng.getComponent(document.querySelector('blockly-main')).projectService
      const original = service.save
      const audit = window.__runtimeRecoveryManualSave = { started: false, settled: false }
      service.save = async function (...args) {
        audit.started = true
        try {
          const result = await original.apply(this, args)
          audit.success = result?.success === true
          audit.receipt = result?.saveReceipt && { version: result.saveReceipt.version,
            requestId: result.saveReceipt.requestId, state: result.saveReceipt.state }
          return result
        } finally { audit.settled = true; service.save = original }
      }
    })
    await page.keyboard.press('Control+s')
    await page.waitForFunction(() => {
      const header = window.ng.getComponent(document.querySelector('app-header'))
      const saved = window.__runtimeRecoveryManualSave
      // Poll synchronous receipt facts, never the truthiness of an async
      // predicate's Promise in Playwright's poller.
      return saved?.started && saved.settled && saved.success && saved.receipt?.state === 'completed'
        && header && !header.projectSavingFromUi && !header.unsaveDialogOpen
    }, undefined, { timeout: 30000 })
    assert.equal(await page.evaluate(() => window.ng.getComponent(document.querySelector('blockly-main'))
      .projectService.hasUnsavedChanges()), false)
    evidence.manualSaveReceipt = await page.evaluate(() => window.__runtimeRecoveryManualSave.receipt)
    assert.equal(evidence.manualSaveReceipt?.state, 'completed')
    await harness.dispose(); harness = undefined
    await app.evaluate(({ app, ipcMain, BrowserWindow }) => {
      app.__runtimeRecoveryExitAudit = { events: [], windows: [] }
      const record = (name, details = {}) => app.__runtimeRecoveryExitAudit.events.push({ name, at: Date.now(), ...details })
      for (const name of ['before-quit', 'will-quit', 'window-all-closed']) app.on(name, () => record(name))
      for (const name of ['window-close', 'window-close-checking', 'window-close-confirmed'])
        ipcMain.on(name, (_event, reply) => record(name, { ...(typeof reply?.allowed === 'boolean' ? { allowed: reply.allowed } : {}) }))
      app.__runtimeRecoveryExitAudit.windows = BrowserWindow.getAllWindows().map(win => ({ id: win.id, title: win.getTitle() }))
    })
    const closed = app.waitForEvent('close', { timeout: 15000 })
    await page.evaluate(() => window.iWindow.close())
    await closed; app = undefined
    evidence.manualSaveAndNativeExit = { sourceSaved: true, nativeExitAcknowledged: true }
  }
  evidence.ok = true
} catch (error) {
  evidence.failure = { message: error.message, stack: error.stack }
  process.exitCode = 1
  if (app) evidence.exitAudit = await app.evaluate(({ app, BrowserWindow }) => ({
    ...app.__runtimeRecoveryExitAudit, remainingWindows: BrowserWindow.getAllWindows().map(win => ({ id: win.id, title: win.getTitle() }))
  })).catch(error => ({ observationError: String(error) }))
  if (page && !page.isClosed()) evidence.failureObservation = await page.evaluate(() => ({
    fault: window.absTimeoutFault?.restore(), audit: window.__nativeRecoveryAudit,
    modals: [...document.querySelectorAll('.ant-modal')].filter(node => node.getClientRects().length).map(node => node.innerText?.slice(0, 1200)),
    header: (() => { const header = window.ng?.getComponent(document.querySelector('app-header')); return header && {
      saving: header.projectSavingFromUi, saveAs: header.projectSavingAs, dialog: header.unsaveDialogOpen,
    } })(),
    manualSave: window.__runtimeRecoveryManualSave,
    notices: [...document.querySelectorAll('.ant-message-notice-content')].map(node => node.textContent?.slice(0, 500))
  })).catch(error => ({ observationError: String(error) }))
} finally {
  await harness?.dispose().catch(error => { evidence.cleanupFailure = error.message; process.exitCode = 1 })
  await stopOwned().catch(error => { evidence.cleanupFailure = error.message; process.exitCode = 1 })
  await renderer?.close()
  const sourceAfter = await sourceFingerprint(), dailyAfter = sha(await fs.readFile(dailyConfig))
  evidence.sourceAndDailyConfigurationUnchanged = sourceAfter.sha256 === sourceBefore.sha256 && dailyAfter === dailyBefore
  evidence.originalSource = { files: sourceBefore.files, sha256: sourceBefore.sha256, preserved: sourceAfter.sha256 === sourceBefore.sha256 }
  if (!evidence.sourceAndDailyConfigurationUnchanged) { evidence.ok = false; process.exitCode = 1 }
  evidence.ok &&= process.exitCode !== 1
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify({ ok: evidence.ok, output, failure: evidence.failure?.message }))
}
