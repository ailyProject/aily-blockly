import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { _electron } from '@playwright/test'
import { serveRendererBuild } from '../fixtures/build-renderer-server.mjs'
import { prepareIssue787Project, indexIssue787Document, seedIssue787ExitedBuildOwner } from './fixtures/issue787-project.mjs'
import { failIssue787RuntimeOnce } from './fixtures/issue787-native-fault.mjs'

const repo = fileURLToPath(new URL('../../', import.meta.url))
const { values } = parseArgs({ options: { ...Object.fromEntries(
  ['host-build', 'executable-path', 'test-root', 'output', 'boards-root', 'libraries-root', 'agent-root'].map(name => [name, { type: 'string' }])),
  'shortcut-only': { type: 'boolean' } } })
for (const name of ['test-root', 'output', 'boards-root', 'libraries-root'])
  assert.ok(values[name] && path.isAbsolute(values[name]), `--${name} must be absolute`)
assert.ok(values['host-build'] || values['executable-path'])
const inside = (parent, child) => { const relative = path.relative(parent, child)
  return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) }
assert.match(values['test-root'].replaceAll('\\', '/'), /\/aily-project\/dev-tests\//i)
assert.ok(inside(path.join(repo, 'e2e/test-results'), values.output))
await fs.mkdir(values['test-root'], { recursive: true })
await fs.mkdir(values.output, { recursive: false })
const suite = await fs.mkdtemp(path.join(values['test-root'], 'issue787-save-'))
const project = path.join(suite, 'project'), appData = path.join(suite, 'appdata'), home = path.join(suite, 'home')
for (const directory of [project, appData, home]) await fs.mkdir(directory)
const evidence = { ok: false, suite, project, cases: [], realElectron: true, syntheticProject: true,
  customerProgramReproduced: false, llmInvoked: false, compilerInvoked: false, userProjectsModified: false }
const digest = value => createHash('sha256').update(value).digest('hex')
const persist = () => fs.writeFile(path.join(values.output, 'result.json'), JSON.stringify(evidence, null, 2))
const phase = async name => { evidence.phase = name; await persist(); console.log('ISSUE787_PHASE=' + name) }
let app, page, renderer, hostPid
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
const hashDocument = value => digest(JSON.stringify(canonical(value)))
async function nativeDocument() {
  return page.evaluate(() => JSON.parse(window.ng.getComponent(document.querySelector('app-blockly-editor'))
    .blocklyService.captureRecoverySnapshot().documentText))
}
async function launch() {
  const { ELECTRON_RUN_AS_NODE, AILY_CHILD_PATH, NODE_PATH, AILY_AUTH_FILE, ...env } = process.env
  app = await _electron.launch({ ...(values['executable-path'] ? { executablePath: values['executable-path'] } : {}), cwd: repo,
    args: [...(values['executable-path'] ? [] : ['.']), ...(renderer ? ['--serve'] : []), `--user-data-dir=${path.join(suite, 'profile')}`],
    timeout: 60000, env: { ...env, AILY_E2E: '1', AILY_APPDATA_PATH: appData,
      AILY_NPM_PREFIX: path.join(appData, 'npm-global'), ...(renderer ? { AILY_DEV_RENDERER_URL: renderer.origin } : {}),
      HOME: home, USERPROFILE: home, npm_config_offline: 'true', npm_config_audit: 'false' } })
  hostPid = await app.evaluate(() => process.pid)
  await app.firstWindow()
  const deadline = Date.now() + 60000
  page = undefined
  while (!page && Date.now() < deadline) {
    for (const candidate of app.windows()) {
      // Packaged renderers use a private HTTP origin and need no index.html suffix.
      if (renderer ? candidate.url().startsWith(renderer.origin)
        : await candidate.locator('app-main-window').count() > 0) {
        page = candidate; break
      }
    }
    if (!page) await new Promise(resolve => setTimeout(resolve, 100))
  }
  const windowUrls = app.windows().map(candidate => {
    try { const url = new URL(candidate.url()); return url.origin + url.pathname + url.hash.split('?')[0] }
    catch { return 'unavailable' }
  })
  ;(evidence.launches ??= []).push({ phase: evidence.phase, hostPid, windowUrls })
  await persist()
  assert.ok(page, `The actual main-window component was not found: ${JSON.stringify(windowUrls)}`)
  page.on('dialog', dialog => dialog.dismiss())
  page.on('pageerror', error => { (evidence.pageErrors ??= []).push(error.message.slice(0, 800)) })
  await page.locator('app-main-window').waitFor({ timeout: 60000 })
  await page.evaluate(() => {
    const dismiss = () => { document.querySelector('app-onboarding .btn-skip')?.click(); document.querySelector('app-login .login-close')?.click() }
    new MutationObserver(dismiss).observe(document.documentElement, { childList: true, subtree: true }); dismiss()
  })
  await page.waitForFunction(() => window.ng?.getComponent(document.querySelector('app-header'))?.projectService)
  await page.evaluate(async target => {
    const domain = window.ng.getComponent(document.querySelector('app-header')).projectService
    if (domain.currentProjectPath && domain.currentProjectPath !== target) throw Error('Unexpected unrelated project')
    await domain.initializeProjectDataSchema(target)
    if (!await domain.projectOpen(target)) throw Error('Owned project failed to open')
  }, project)
  await page.waitForFunction(target => {
    const editor = window.ng.getComponent(document.querySelector('app-blockly-editor'))
    return editor?.projectService.currentProjectPath === target && editor.projectService.getBlocklyProjectLoadStatus(target)?.ready
  }, project, { timeout: 120000 })
  evidence.host = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, path: app.getAppPath(), version: app.getVersion() }))
  if (values['executable-path']) assert.match(evidence.host.path, /app\.asar$/i)
}
async function forceKillOwned() {
  assert.equal(await app.evaluate(() => process.pid), hostPid)
  const closed = app.waitForEvent('close', { timeout: 15000 })
  // The development launcher may have a different PID from the actual host.
  // Kill in the verified host itself, without running app.quit/leave handlers.
  await app.evaluate((_, expected) => {
    if (process.pid !== expected.pid || process.env.AILY_APPDATA_PATH !== expected.appData)
      throw Error('Refuse unrelated host termination')
    process.kill(process.pid, 'SIGKILL')
  }, { pid: hostPid, appData }).catch(error => {
    if (!/closed|destroyed|terminated|Target/i.test(error.message)) throw error
  })
  await closed
  app = undefined
}
async function save() {
  return page.evaluate(async target => {
    const result = await window.ng.getComponent(document.querySelector('app-header')).projectService.save(target)
    return { success: result?.success, projectSaved: result?.projectSaved, partial: result?.partial, message: result?.message }
  }, project)
}
async function pressOwnedSaveShortcut() {
  const ownedWindow = await app.browserWindow(page)
  await ownedWindow.evaluate(window => { window.show(); window.focus() })
  await page.bringToFront()
  await page.evaluate(() => {
    const header = window.ng.getComponent(document.querySelector('app-header'))
    const item = header.shortcutMap.get('ctrl+s')
    window.__issue787SaveKeys = { route: header.router.url, shortcutAction: item?.action,
      allowed: item ? header.showInRouter(item) === true : false, focused: document.hasFocus(), events: [] }
    window.__issue787SaveKeyListener = event => {
      if (event.ctrlKey && event.key.toLowerCase() === 's') window.__issue787SaveKeys.events.push({
        key: event.key, ctrl: event.ctrlKey, trusted: event.isTrusted, target: event.target?.tagName,
      })
    }
    window.addEventListener('keydown', window.__issue787SaveKeyListener, { capture: true })
  })
  await page.keyboard.press('Control+s')
  await page.evaluate(() => {
    window.removeEventListener('keydown', window.__issue787SaveKeyListener, true)
    delete window.__issue787SaveKeyListener
  })
  evidence.saveShortcut = await page.evaluate(() => window.__issue787SaveKeys)
  await persist()
  assert.equal(evidence.saveShortcut.shortcutAction, 'project-save')
  assert.equal(evidence.saveShortcut.allowed, true, 'The owned editor must expose its real save shortcut')
  assert.ok(evidence.saveShortcut.events.some(event => event.trusted), 'The actual owned renderer must receive a trusted Ctrl+S')
}
try {
  await phase('prepare')
  evidence.fixture = await prepareIssue787Project({ project, boardsRoot: values['boards-root'], librariesRoot: values['libraries-root'] })
  const legacy = await seedIssue787ExitedBuildOwner(project)
  evidence.legacyBuildOwner = { realExitedDelegatedOwner: true, markers: legacy.markers }
  const config = JSON.parse(await fs.readFile(path.join(repo, 'electron/config/config.json'), 'utf8'))
  Object.assign(config, { metricsEnabled: false, project_path: suite, recentlyProjects: [], onboardingCompleted: true,
    blocklyOnboardingCompleted: true, region: 'offline-issue787' })
  config.appdata_path[process.platform] = appData
  config.regions = { 'offline-issue787': { official: false, enabled: true, name: 'Issue787 acceptance',
    api_server: 'http://127.0.0.1:9', resource: 'http://127.0.0.1:9', web: 'http://127.0.0.1:9',
    tool_web: 'http://127.0.0.1:9', ucenter_web: 'http://127.0.0.1:9', npm_registry: 'http://127.0.0.1:9', npm_registry_linux: 'http://127.0.0.1:9' } }
  await fs.writeFile(path.join(appData, 'config.json'), JSON.stringify(config), { flag: 'wx' })
  await fs.mkdir(path.join(appData, 'npm-global/app'), { recursive: true })
  await fs.writeFile(path.join(appData, 'npm-global/app/subapp-index.json'), JSON.stringify({ dev: true }), { flag: 'wx' })
  if (values['host-build']) renderer = await serveRendererBuild(values['host-build'])
  await phase('initial-open-and-repeat-save')
  await launch()
  const initial = await nativeDocument(), indexed = indexIssue787Document(initial)
  assert.equal(indexed.size, evidence.fixture.totalBlocks)
  assert.equal(initial.sharedModel.variables.length, evidence.fixture.variableCount)
  evidence.initial = { hash: hashDocument(initial), blocks: indexed.size }
  for (let i = 0; i < 3; i++) {
    const receipt = await save()
    assert.equal(receipt.success, true, JSON.stringify(receipt))
    const disk = JSON.parse(await fs.readFile(path.join(project, 'project.abi'), 'utf8'))
    assert.equal(indexIssue787Document(disk).size, indexed.size)
    assert.equal(hashDocument(disk), hashDocument(await nativeDocument()))
    evidence.cases.push({ name: 'save-' + i, ok: true, receipt })
  }
  let completeCount = indexed.size
  if (!values['shortcut-only']) {
    const savedText = await fs.readFile(path.join(project, 'project.abi'), 'utf8')
    const savedHash = hashDocument(JSON.parse(savedText))
    await phase('force-kill-and-cold-open')
    await forceKillOwned()
    assert.equal(await fs.readFile(path.join(project, 'project.abi'), 'utf8'), savedText)
    await launch()
    const reopened = await nativeDocument()
    assert.equal(hashDocument(reopened), savedHash, 'Full persisted document must survive a cold reopen')
    assert.equal(indexIssue787Document(reopened).size, indexed.size)
    evidence.cases.push({ name: 'force-kill-reopen', ok: true, hash: savedHash, blocks: indexed.size })
    await phase('post-restart-edit-and-save')
    await page.evaluate(() => {
      const block = window.Blockly.getMainWorkspace().getBlockById('issue787-number-2449')
      if (!block) throw Error('Last root is missing')
      block.setFieldValue('1787', 'NUM')
    })
    const afterEdit = await save()
    assert.equal(afterEdit.success, true, JSON.stringify(afterEdit))
    const edited = JSON.parse(await fs.readFile(path.join(project, 'project.abi'), 'utf8'))
    assert.equal(Number(indexIssue787Document(edited).get('issue787-number-2449').fields.NUM), 1787)
    assert.equal(indexIssue787Document(edited).size, indexed.size)
    assert.equal(hashDocument(edited), hashDocument(await nativeDocument()))
    evidence.cases.push({ name: 'post-restart-edit-save', ok: true })
    const children = (await fs.readdir(suite)).filter(name => /recovered/.test(name))
    assert.deepEqual(children, [], 'The system must not hand off a recovered project')
    await phase('unsaved-edit-partial-runtime-rebuild')
    await page.evaluate(() => {
      const workspace = window.Blockly.getMainWorkspace()
      workspace.getBlockById('issue787-number-2449').setFieldValue('2787', 'NUM')
      for (let index = 0; index < 5; index++) {
        const block = workspace.newBlock('math_number', `issue787-unsaved-${index}`)
        block.setFieldValue(String(8800 + index), 'NUM'); block.initSvg(); block.render()
        block.moveBy(4200, 600 + index * 100)
      }
    })
    const beforeFailure = await nativeDocument()
    completeCount = indexIssue787Document(beforeFailure).size
    assert.equal(completeCount, indexed.size + 5)
    const failure = await failIssue787RuntimeOnce(page, project)
    assert.equal(failure.fired, true)
    assert.equal(failure.caught?.code, 'BLOCKLY_RUNTIME_RECOVERY_REQUIRED')
    assert.equal(failure.blocked, true)
    const partialCount = indexIssue787Document(await nativeDocument()).size
    assert.ok(partialCount < completeCount, 'The controlled failure must actually leave a partial native canvas')
    evidence.runtimeFault = { ...failure, beforeBlocks: completeCount, partialBlocks: partialCount, unsavedNewBlocks: 5 }
    await phase('partial-runtime-force-kill-and-auto-restore')
    await forceKillOwned()
    await launch()
    const recovered = await nativeDocument()
    assert.equal(hashDocument(recovered), hashDocument(beforeFailure), 'Cold open must recover the complete unsaved pre-operation document')
    assert.equal(indexIssue787Document(recovered).size, completeCount)
    assert.equal(Number(indexIssue787Document(recovered).get('issue787-number-2449').fields.NUM), 2787)
    assert.equal(Number(indexIssue787Document(JSON.parse(await fs.readFile(path.join(project, 'project.abi'), 'utf8')))
      .get('issue787-number-2449').fields.NUM), 1787, 'Restoring an unsaved view must not silently overwrite disk')
    await page.waitForFunction(() => window.ng.getComponent(document.querySelector('app-header')).hasUnsavedProjectChanges)
    await phase('second-force-kill-before-recovered-view-save')
    await forceKillOwned()
    await launch()
    assert.equal(hashDocument(await nativeDocument()), hashDocument(beforeFailure), 'A second restart must retain the still-unsaved recovered view')
    await page.waitForFunction(() => window.ng.getComponent(document.querySelector('app-header')).hasUnsavedProjectChanges)
    const recoveredSave = await save()
    assert.equal(recoveredSave.success, true, JSON.stringify(recoveredSave))
    assert.equal(hashDocument(JSON.parse(await fs.readFile(path.join(project, 'project.abi'), 'utf8'))), hashDocument(await nativeDocument()))
    assert.deepEqual((await fs.readdir(suite)).filter(name => /recovered/.test(name)), [])
    evidence.cases.push({ name: 'unsaved-full-document-recovered-after-partial-rebuild-and-force-kill', ok: true,
      blocks: completeCount, unsavedNewBlocks: 5, sameProject: true, manualRecoveryActions: 0 })
    if (values['agent-root']) {
      const { runIssue787ApplyReconnect } = await import('./fixtures/issue787-apply-reconnect.mjs')
      evidence.applyReconnect = await runIssue787ApplyReconnect({ app, project, suite, appData, home, hostPid,
        agentRoot: values['agent-root'], phase })
      const appliedDocument = await nativeDocument()
      assert.equal(Number(indexIssue787Document(appliedDocument).get('issue787-number-2449').fields.NUM), 3787)
      assert.equal(indexIssue787Document(appliedDocument).size, completeCount)
      evidence.cases.push({ name: 'actual-sdk-apply-reply-lost-observe-original', ...evidence.applyReconnect })
    }
  }
  await phase('real-ctrl-s-automatically-restores-and-saves')
  await page.evaluate(() => window.Blockly.getMainWorkspace().getBlockById('issue787-number-2449').setFieldValue('4787', 'NUM'))
  assert.equal((await failIssue787RuntimeOnce(page, project)).caught?.code, 'BLOCKLY_RUNTIME_RECOVERY_REQUIRED')
  await pressOwnedSaveShortcut()
  await page.waitForFunction(target => {
    const header = window.ng.getComponent(document.querySelector('app-header'))
    return header?.projectService.currentProjectPath === target && !header.projectService.hasBlocklyRuntimeRecovery(target)
      && !header.hasUnsavedProjectChanges && !header.projectSavingFromUi
  }, project, { timeout: values['shortcut-only'] ? 30000 : 120000 })
  evidence.saveShortcut = await page.evaluate(() => window.__issue787SaveKeys)
  assert.equal(Number(indexIssue787Document(JSON.parse(await fs.readFile(path.join(project, 'project.abi'), 'utf8')))
    .get('issue787-number-2449').fields.NUM), 4787)
  assert.equal(indexIssue787Document(await nativeDocument()).size, completeCount)
  assert.deepEqual((await fs.readdir(suite)).filter(name => /recovered/.test(name)), [])
  assert.equal(await page.locator('.ant-modal').filter({ hasText: /恢复副本|打开副本/ }).count(), 0)
  evidence.cases.push({ name: 'real-ctrl-s-same-project-automatic-runtime-restoration-and-save', ok: true,
    fullDocumentSaved: true, manualRecoveryActions: 0 })
  await phase('cancel-leave-then-explicit-discard-does-not-resurrect')
  await page.evaluate(() => {
    const workspace = window.Blockly.getMainWorkspace()
    workspace.getBlockById('issue787-number-2449').setFieldValue('5787', 'NUM')
    const added = workspace.newBlock('math_number', 'issue787-discarded')
    added.setFieldValue('8787', 'NUM'); added.initSvg(); added.render(); added.moveBy(4400, 1200)
  })
  assert.equal((await failIssue787RuntimeOnce(page, project)).caught?.code, 'BLOCKLY_RUNTIME_RECOVERY_REQUIRED')
  const requestClose = () => page.evaluate(() => {
    window.__issue787Close = undefined
    const header = window.ng.getComponent(document.querySelector('app-header'))
    void (async () => {
      try { window.__issue787Close = await header.checkUnsavedChanges('close') ? await header.projectService.close() : false }
      catch (error) { window.__issue787Close = { error: error.message } }
    })()
  })
  async function chooseLeave(action) {
    const modal = page.locator('app-unsave-dialog:visible')
    await modal.waitFor({ timeout: 120000 })
    const actions = await modal.evaluate(element => window.ng.getComponent(element).buttons.map(button => button.action))
    assert.ok(!actions.includes('recovery-copy'))
    const index = actions.indexOf(action)
    assert.ok(index >= 0, 'The ordinary leave decision must offer ' + action)
    await modal.locator('.footer button').nth(index).click()
  }
  await requestClose(); await chooseLeave('cancel')
  await page.waitForFunction(() => window.__issue787Close === false)
  assert.equal(indexIssue787Document(await nativeDocument()).size, completeCount + 1)
  assert.equal(Number(indexIssue787Document(JSON.parse(await fs.readFile(path.join(project, 'project.abi'), 'utf8')))
    .get('issue787-number-2449').fields.NUM), 4787)
  await requestClose(); await chooseLeave('continue')
  await page.waitForFunction(() => window.__issue787Close === true, undefined, { timeout: 30000 })
  await page.evaluate(async target => {
    const service = window.ng.getComponent(document.querySelector('app-header')).projectService
    if (!await service.projectOpen(target)) throw Error('The original project could not reopen after its explicit discard')
  }, project)
  await page.waitForFunction(target => {
    const header = window.ng.getComponent(document.querySelector('app-header'))
    return header?.projectService.getBlocklyProjectLoadStatus(target)?.ready === true
  }, project, { timeout: 120000 })
  const afterDiscard = indexIssue787Document(await nativeDocument())
  assert.equal(afterDiscard.size, completeCount)
  assert.equal(afterDiscard.has('issue787-discarded'), false)
  assert.equal(Number(afterDiscard.get('issue787-number-2449').fields.NUM), 4787)
  evidence.cases.push({ name: 'cancel-preserves-view-explicit-discard-does-not-resurrect-on-open', ok: true,
    cancellationSavedNothing: true, explicitDiscardHonored: true, sameOriginalProject: true })
  await legacy.assertPreserved()
  evidence.legacyBuildOwner.originalMarkersUnchanged = true
  evidence.ok = true
  await phase('passed')
} catch (error) {
  evidence.error = { name: error.name, message: error.message, stack: error.stack }
  if (page) evidence.saveShortcut = await page.evaluate(() => window.__issue787SaveKeys).catch(() => evidence.saveShortcut)
  if (page) evidence.failureHost = await page.evaluate(() => {
    const header = window.ng?.getComponent(document.querySelector('app-header'))
    const editor = window.ng?.getComponent(document.querySelector('app-blockly-editor'))
    return { dirty: header?.hasUnsavedProjectChanges, saving: header?.projectSavingFromUi,
      recovery: header?.projectService.hasBlocklyRuntimeRecovery(), nativeReady: editor?.blocklyService.generatorRuntime.isReady(),
      blocked: editor?.blocklyService.isWorkspaceEditBlocked(), failure: editor?._projectService.runtimeRecovery?.description?.failure }
  }).catch(() => undefined)
  await persist()
  throw error
} finally {
  if (app) {
    if (evidence.ok) await app.close()
    else await forceKillOwned().catch(error => { evidence.cleanupError = error.message })
  }
  if (renderer) await renderer.close()
  await persist()
}
