import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { build as bundle } from 'esbuild'
import { _electron } from '@playwright/test'
import { serveRendererBuild } from '../fixtures/build-renderer-server.mjs'
import { createRecoveredAgentHarness } from '../fixtures/abs-agent-tools.mjs'

const repo = fileURLToPath(new URL('../../', import.meta.url))
const root = path.resolve(process.env.AILY_SAVE_TEST_ROOT ?? '')
const project = path.resolve(process.env.AILY_SAVE_PROJECT ?? '')
const hostBuild = path.resolve(process.env.AILY_SAVE_HOST_BUILD ?? '')
const agentRoot = path.resolve(process.env.AILY_SAVE_AGENT_ROOT ?? '')
const output = path.resolve(process.env.AILY_SAVE_OUTPUT ?? '')
const inside = (parent, value) => { const r = path.relative(parent, value); return r && !r.startsWith('..') && !path.isAbsolute(r) }
assert.match(root.replaceAll('\\', '/'), /\/aily-project\/dev-tests\/[^/]+$/i)
assert.ok(inside(root, project) && /[\\/]serial-agent-[^\\/]+[\\/]project$/.test(project))
assert.ok(inside(path.join(repo, 'e2e/test-results'), output))
assert.ok(process.env.AILY_SAVE_HOST_BUILD && process.env.AILY_SAVE_AGENT_ROOT)
assert.equal((await fs.realpath(project)).toLowerCase(), project.toLowerCase())
await fs.mkdir(output, { recursive: true })
const suite = await fs.mkdtemp(path.join(root, 'save-consistency-'))
const home = path.join(suite, 'home'), profileRoot = path.join(suite, 'agent-profile'), appData = path.join(root, 'appdata')
await fs.mkdir(home)
const sha = value => createHash('sha256').update(value).digest('hex')
const findBlock = (value, id) => value && typeof value === 'object'
  ? value.id === id && typeof value.type === 'string' ? value : Object.values(value).map(child => findBlock(child, id)).find(Boolean) : undefined
const abiPath = path.join(project, 'project.abi'), mapPath = path.join(project, 'project.abs.map.json')
const evidence = { ok: false, project, suite, hardwareUsed: false, simulatorUsed: false,
  userProjectsModified: false, dailyInstallReplaced: false, actualSdkTools: true, llmInvoked: false, saves: [] }
let renderer, app, page, hostPid, harness
const snapshot = async () => page.evaluate(() => {
  const main = window.ng.getComponent(document.querySelector('blockly-main'))
  const header = window.ng.getComponent(document.querySelector('app-header'))
  return { star: header.hasUnsavedProjectChanges, state: main.projectService.stateSubject.value,
    blocks: window.Blockly.getMainWorkspace().getAllBlocks(false).length }
})
async function launch() {
  const { ELECTRON_RUN_AS_NODE, AILY_CHILD_PATH, NODE_PATH, ...env } = process.env
  app = await _electron.launch({ cwd: repo, args: ['.', '--serve', `--user-data-dir=${path.join(suite, 'electron-profile')}`],
    timeout: 60000, env: { ...env, AILY_E2E: '1', AILY_APPDATA_PATH: appData, HOME: home, USERPROFILE: home,
      AILY_DEV_RENDERER_URL: renderer.origin, npm_config_offline: 'true', npm_config_audit: 'false' } })
  hostPid = await app.evaluate(() => process.pid)
  await app.firstWindow()
  const deadline = Date.now() + 60000
  page = undefined
  while (!page && Date.now() < deadline) {
    page = app.windows().find(value => value.url().startsWith(renderer.origin))
    if (!page) await new Promise(resolve => setTimeout(resolve, 200))
  }
  assert.ok(page)
  page.on('dialog', dialog => dialog.dismiss())
  page.on('console', message => {
    if (/Normalization|项目保存失败|Saved ABI and workspace diverged/.test(message.text())) {
      ;(evidence.console ??= []).push({ type: message.type(), text: message.text().slice(0, 1000) })
    }
  })
  await page.goto(renderer.origin, { waitUntil: 'domcontentloaded' })
  await page.locator('app-main-window').waitFor({ timeout: 60000 })
  await page.evaluate(target => { location.hash = '#/main/blockly-editor?path=' + encodeURIComponent(target) }, project)
  await page.waitForFunction(target => {
    const mainElement = document.querySelector('blockly-main'), editorElement = document.querySelector('app-blockly-editor')
    const main = mainElement && window.ng?.getComponent(mainElement)
    const editor = editorElement && window.ng?.getComponent(editorElement)
    return main?.projectService?.currentProjectPath?.replaceAll('\\', '/') === target.replaceAll('\\', '/')
      && main.projectService.getBlocklyProjectLoadStatus(target)?.ready === true
      && editor?._builderService?.isInstallInProgress() === false
  }, project, { timeout: 60000 })
  await page.evaluate(() => {
    const service = window.ng.getComponent(document.querySelector('blockly-main')).projectService
    const save = service.save.bind(service)
    window.__acceptanceSaves = []
    // Observe the actual UI-triggered operation without changing its arguments,
    // receipt, rejection or timing. Never substitute a scripted file write.
    service.save = (...args) => {
      const observed = { started: Date.now() }
      window.__acceptanceSaves.push(observed)
      return save(...args).then(value => {
        Object.assign(observed, { settled: Date.now(), success: value?.success === true })
        return value
      }, error => {
        Object.assign(observed, { settled: Date.now(), success: false, error: String(error) })
        throw error
      })
    }
  })
}
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
async function diskDrift(kind) {
  const value = JSON.parse(await fs.readFile(abiPath, 'utf8'))
  if (kind === 'root-layout') {
    const root = value.pages.flatMap(page => page.content?.blocks?.blocks ?? [])[0]
    assert.ok(root); root.x = (root.x ?? 0) + 23
  } else {
    value.pages[0].viewState = { ...value.pages[0].viewState, scale: 0.92, scrollX: 13, scrollY: 21 }
  }
  await fs.writeFile(abiPath, JSON.stringify(value)) // Explicit external-writer fault in this owned fixture only.
}
async function editNumber(value) {
  return page.evaluate(value => {
    const block = window.Blockly.getMainWorkspace().getAllBlocks(false).find(block => block.type === 'math_number' && !block.isShadow())
    if (!block) throw new Error('The C3 acceptance seed requires an ordinary number block')
    block.setFieldValue(String(value), 'NUM')
    return block.id
  }, value)
}
async function awaitSave(action, id, value) {
  const before = JSON.parse(await fs.readFile(mapPath, 'utf8')), since = Date.now()
  await action()
  await page.waitForFunction(since => window.__acceptanceSaves.some(save => save.started >= since && save.settled && save.success), since,
    { timeout: 15000 })
  await page.waitForFunction(() => {
    const header = window.ng.getComponent(document.querySelector('app-header'))
    const main = window.ng.getComponent(document.querySelector('blockly-main'))
    return !header.hasUnsavedProjectChanges && main.projectService.stateSubject.value !== 'saving'
  }, undefined, { timeout: 15000 })
  const receiptMs = Date.now() - since
  const abi = JSON.parse(await fs.readFile(abiPath, 'utf8')), map = JSON.parse(await fs.readFile(mapPath, 'utf8'))
  assert.equal(Number(findBlock(abi, id)?.fields?.NUM), value)
  assert.notEqual(map.generation, before.generation)
  const samples = []
  for (const delay of [0, 1000, 2000, 2000]) { if (delay) await page.waitForTimeout(delay); samples.push(await snapshot()) }
  assert.ok(samples.every(value => !value.star && value.state !== 'saving'))
  return { receiptMs, verificationMs: Date.now() - since, generation: map.generation, samples }
}
try {
  renderer = await serveRendererBuild(hostBuild)
  await launch()
  Object.assign(process.env, { AILY_LIBRARY_HOST_PID: String(hostPid), AILY_APPDATA_PATH: appData,
    PI_CODING_AGENT_DIR: profileRoot, HOME: home, USERPROFILE: home, PI_OFFLINE: '1', npm_config_offline: 'true', npm_config_audit: 'false' })
  harness = await createRecoveredAgentHarness({ agentRoot, sourceProject: project, globalRoot: root, profileRoot,
    permissionApproval: request => request.input?.project === project && ['project_recover', 'abs_export'].includes(request.toolName) })
  const inspected = (await harness.call('project_recover', { project, action: 'inspect' })).structured
  const repair = inspected?.diagnostics?.repair
  if (repair) assert.equal((await harness.call('project_recover', { project, action: 'repair', token: repair.token, authority: repair.authority })).structured?.ok, true)
  const exported = (await harness.call('abs_export', { project })).structured
  assert.equal(exported.ok, true)
  await harness.settle(); await harness.dispose(); harness = undefined
  for (const [index, kind] of ['root-layout', 'viewport'].entries()) {
    await diskDrift(kind)
    const value = 37 + index, id = await editNumber(value)
    await page.waitForFunction(() => window.ng.getComponent(document.querySelector('app-header')).hasUnsavedProjectChanges)
    const action = index === 0 ? () => page.keyboard.press('Control+s') : async () => {
      await page.locator('app-header .header-box > .menu').click()
      await page.locator('.menu-item').filter({ has: page.locator('.text', { hasText: /^Ctrl\s*\+\s*S$/i }) }).click()
    }
    evidence.saves.push({ kind, trigger: index === 0 ? 'Ctrl+S' : 'menu', ...(await awaitSave(action, id, value)) })
  }
  // Publish a legal historical unmarked generation; do not counterfeit a new hash in an old baseline.
  const seeded = await bundle({ entryPoints: [path.join(repo, 'e2e/fixtures/abs-save-load-fixture.ts')],
    bundle: true, write: false, format: 'iife', globalName: '__absSaveFixture', platform: 'browser',
    target: 'es2022', tsconfig: path.join(repo, 'tsconfig.json'), logLevel: 'silent',
    alias: { '@domain/project/public-api': path.join(repo, 'e2e/fixtures/abs-save-project-data.ts') } })
  await page.addScriptTag({ content: seeded.outputFiles[0].text })
  const legacy = await page.evaluate(project => window.__absSaveFixture.seedUnmarkedGeneration(project), project)
  evidence.loadMigration = { seededGeneration: legacy.generation, legitimateJournal: true }
  await stopOwned()
  await launch()
  const migrated = JSON.parse(await fs.readFile(abiPath, 'utf8')), map = JSON.parse(await fs.readFile(mapPath, 'utf8'))
  assert.ok(migrated.$ailyProjectData)
  assert.notEqual(map.generation, legacy.generation)
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
  assert.equal(map.savedAbiHash, 'sha256:' + sha(JSON.stringify(canonical(migrated))))
  const archive = JSON.parse(await fs.readFile(path.join(project, '.aily/abs-sync/recoveries', `${map.generation}.json`), 'utf8'))
  assert.equal(archive.disk.abi, legacy.abiText)
  assert.equal(archive.disk.map, legacy.mapText)
  assert.equal(archive.committed.pointer, legacy.pointerText)
  await page.waitForTimeout(1200)
  assert.equal((await snapshot()).star, false)
  Object.assign(evidence.loadMigration, { committedGeneration: map.generation, oldAbiAndMapAndPointerArchived: true,
    savedAbiHashVerified: true, star: false })
  // A genuine external program edit must still block manual save and native quit/save.
  const external = JSON.parse(await fs.readFile(abiPath, 'utf8'))
  const originalText = JSON.stringify(external)
  external.externalAcceptanceExtension = { preserved: true }
  const conflictText = JSON.stringify(external)
  await fs.writeFile(abiPath, conflictText)
  const finalId = await editNumber(39)
  await page.waitForFunction(() => window.ng.getComponent(document.querySelector('app-header')).hasUnsavedProjectChanges)
  const negativeSince = Date.now()
  await page.keyboard.press('Control+s')
  await page.waitForFunction(since => window.__acceptanceSaves.some(save => save.started >= since && save.settled && !save.success), negativeSince,
    { timeout: 15000 })
  assert.equal(await fs.readFile(abiPath, 'utf8'), conflictText)
  assert.equal((await snapshot()).star, true)
  await page.evaluate(() => window.ng.getComponent(document.querySelector('app-header')).close())
  const modal = page.locator('app-unsave-dialog')
  await modal.waitFor({ state: 'visible', timeout: 5000 })
  const conflictDialog = await modal.evaluate(element => {
    const component = window.ng.getComponent(element)
    return { actions: component.buttons.map(value => value.action), detail: component.detail }
  })
  if (conflictDialog.actions.includes('save')) {
    const negativeQuitSince = Date.now()
    assert.equal(conflictDialog.actions.at(-1), 'save')
    await modal.locator('button').last().click()
    await modal.waitFor({ state: 'hidden', timeout: 5000 })
    await page.waitForFunction(since => window.__acceptanceSaves.some(save => save.started >= since && save.settled && !save.success), negativeQuitSince,
      { timeout: 15000 })
  } else {
    // When authoritative dirty inspection itself sees the competing external
    // edit, the native dialog deliberately offers only cancel/explicit discard.
    // Never click that last discard button and call it a tested save.
    assert.deepEqual(conflictDialog.actions, ['cancel', 'continue'])
    assert.ok(conflictDialog.detail)
    await modal.locator('button').first().click()
    await modal.waitFor({ state: 'hidden', timeout: 5000 })
  }
  assert.equal(await fs.readFile(abiPath, 'utf8'), conflictText)
  assert.equal((await snapshot()).star, true)
  evidence.conflict = { manualSaveRefused: true, nativeQuitBlocked: true, conflictDialog, diskRetained: true, canvasRetained: true }
  // Remove only the test-injected competing edit, then exercise real native quit/save.
  await fs.writeFile(abiPath, originalText)
  await diskDrift('root-layout')
  const exited = app.waitForEvent('close', { timeout: 20000 })
  await page.evaluate(() => window.ng.getComponent(document.querySelector('app-header')).close())
  await modal.waitFor({ state: 'visible', timeout: 5000 })
  assert.equal(await modal.evaluate(element => window.ng.getComponent(element).buttons.at(-1)?.action), 'save')
  await modal.locator('button').last().click()
  await exited
  app = undefined
  assert.equal(Number(findBlock(JSON.parse(await fs.readFile(abiPath, 'utf8')), finalId)?.fields?.NUM), 39)
  evidence.nativeQuit = { saveAndContinueClosedOwnedHost: true, codeSaved: true }
  evidence.ok = true
} catch (error) {
  evidence.failure = { message: error.message, stack: error.stack }; process.exitCode = 1
} finally {
  await harness?.dispose().catch(error => { evidence.cleanupFailure = error.message; process.exitCode = 1 })
  await stopOwned().catch(error => { evidence.cleanupFailure = error.message; process.exitCode = 1 })
  await renderer?.close()
  evidence.ok &&= process.exitCode !== 1
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify({ ok: evidence.ok, output, failure: evidence.failure?.message }))
}
