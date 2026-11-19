import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { _electron } from '@playwright/test'
import { serveRendererBuild } from '../fixtures/build-renderer-server.mjs'

// Actual Angular components, notification DOM and native workspace leases.
// The child Runtime is suppressed in this disposable renderer: Stop is a local
// protocol port, never a provider request or authority to clear a recovery grant.
const repo = fileURLToPath(new URL('../../', import.meta.url))
const { values } = parseArgs({ options: Object.fromEntries(
  ['host-build', 'library-root', 'installed-root', 'test-root', 'output'].map(name => [name, { type: 'string' }]),
) })
for (const name of ['host-build', 'library-root', 'installed-root', 'test-root', 'output'])
  assert.ok(values[name] && path.isAbsolute(values[name]), `--${name} must be an absolute private path`)
const inside = (parent, child) => {
  const relative = path.relative(parent, child)
  return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
}
assert.match(values['test-root'].replaceAll('\\', '/'), /\/aily-project\/dev-tests\//i)
assert.ok(inside(path.join(repo, 'e2e/test-results'), values.output))
await fs.mkdir(values['test-root'], { recursive: true })
await fs.mkdir(values.output, { recursive: false })
const suite = await fs.mkdtemp(path.join(values['test-root'], 'stop-state-'))
const project = path.join(suite, 'project'), appData = path.join(suite, 'appdata')
const home = path.join(suite, 'home'), temp = path.join(suite, 'temp')
for (const directory of [project, appData, home, temp]) await fs.mkdir(directory)
const sha = value => createHash('sha256').update(value).digest('hex')
const report = { ok: false, realElectron: true, actualAngularComponents: true, actualNativeLeases: true,
  childRuntimeSuppressed: true, localStopProtocolPort: true, realSdk: false, llmInvoked: false,
  credentialsUsed: false, userProjectUsed: false, actualCompilerInvoked: false, suite, project,
  startedAt: Date.now(), stages: [], blockedExternalRequests: [], checks: [] }
const persist = () => fs.writeFile(path.join(values.output, 'result.json'), JSON.stringify(report, null, 2))
const stage = async name => { report.stages.push({ name, at: Date.now() }); await persist(); console.log('PHASE=' + name) }
const hashes = async () => Object.fromEntries(await Promise.all(['package.json', 'project.abi', 'project.abs', 'project.abs.map.json'].map(async name => {
  try { return [name, sha(await fs.readFile(path.join(project, name)))] }
  catch (error) { if (error.code === 'ENOENT') return [name, null]; throw error }
})))
let app, renderer, page, hostPid
try {
  await stage('self-created-offline-project')
  const board = '@aily-project/board-arduino_uno'
  const boardRoot = path.join(values['installed-root'], 'node_modules', board)
  const manifest = JSON.parse(await fs.readFile(path.join(boardRoot, 'template/package.json'), 'utf8'))
  manifest.name = 'isolated-stop-state-acceptance'
  for (const name of Object.keys(manifest.dependencies)) {
    const source = name === board ? boardRoot : path.join(values['library-root'], name.replace('@aily-project/lib-', ''))
    const target = path.join(project, 'node_modules', name)
    await fs.cp(source, target, { recursive: true, dereference: true, force: false, errorOnExist: true })
    manifest.dependencies[name] = JSON.parse(await fs.readFile(path.join(target, 'package.json'), 'utf8')).version
  }
  await fs.writeFile(path.join(project, 'package.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' })
  await fs.copyFile(path.join(boardRoot, 'template/project.abi'), path.join(project, 'project.abi'))
  const config = JSON.parse(await fs.readFile(path.join(repo, 'electron/config/config.json'), 'utf8'))
  config.metricsEnabled = false; config.project_path = suite; config.recentlyProjects = []
  config.appdata_path[process.platform] = appData; config.region = 'stop-state-offline'
  config.regions = { 'stop-state-offline': { official: false, enabled: true, name: 'Offline stop acceptance',
    api_server: 'http://127.0.0.1:9', resource: 'http://127.0.0.1:9', web: 'http://127.0.0.1:9',
    tool_web: 'http://127.0.0.1:9', ucenter_web: 'http://127.0.0.1:9',
    npm_registry: 'http://127.0.0.1:9', npm_registry_linux: 'http://127.0.0.1:9' } }
  await fs.writeFile(path.join(appData, 'config.json'), JSON.stringify(config, null, 2), { flag: 'wx' })
  // This suite tests the host surface, not default Subapp installation. An
  // explicit empty local catalog keeps cold startup offline and install-free.
  const installRoot = path.join(appData, 'npm-global', 'app')
  await fs.mkdir(installRoot, { recursive: true })
  await fs.writeFile(path.join(installRoot, 'subapp-index.json'), JSON.stringify({ dev: true }), { flag: 'wx' })
  renderer = await serveRendererBuild(values['host-build'])
  const { ELECTRON_RUN_AS_NODE, AILY_CHILD_PATH, NODE_PATH, AILY_PORTABLE_ROOT, AILY_AUTH_FILE, ...parentEnv } = process.env
  await stage('owned-real-renderer')
  app = await _electron.launch({ args: ['.', '--serve', `--user-data-dir=${path.join(suite, 'electron-profile')}`], cwd: repo,
    timeout: 60000, env: { ...parentEnv, AILY_E2E: '1', AILY_APPDATA_PATH: appData,
      AILY_NPM_PREFIX: path.join(appData, 'npm-global'), AILY_DEV_RENDERER_URL: renderer.origin,
      HOME: home, USERPROFILE: home, TEMP: temp, TMP: temp, npm_config_offline: 'true', npm_config_audit: 'false' } })
  hostPid = await app.evaluate(() => process.pid); report.hostPid = hostPid
  await app.context().route('**/*', route => {
    const url = new URL(route.request().url())
    if (!['http:', 'https:'].includes(url.protocol) || ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return route.continue()
    report.blockedExternalRequests.push({ origin: url.origin, path: url.pathname }); return route.abort()
  })
  const until = Date.now() + 60000
  while (!page && Date.now() < until) {
    page = app.windows().find(window => window.url().startsWith(renderer.origin))
    if (!page) await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(page, 'The owned renderer must start')
  page.on('dialog', dialog => dialog.dismiss())
  page.on('pageerror', error => { (report.pageErrors ??= []).push(error.message) })
  await page.goto(renderer.origin, { waitUntil: 'domcontentloaded' })
  await page.locator('app-main-window').waitFor({ timeout: 60000 })
  await page.evaluate(() => {
    const dismiss = () => { document.querySelector('app-onboarding .btn-skip')?.click(); document.querySelector('app-login .login-close')?.click() }
    new MutationObserver(dismiss).observe(document.documentElement, { childList: true, subtree: true }); dismiss()
  })
  await page.waitForFunction(() => window.ng?.getComponent(document.querySelector('app-header'))?.projectService)
  await page.evaluate(async target => {
    const service = window.ng.getComponent(document.querySelector('app-header')).projectService
    await service.initializeProjectDataSchema(target)
    if (!await service.projectOpen(target)) throw Error('The isolated project did not open')
  }, project)
  await page.waitForFunction(target => {
    const editor = window.ng.getComponent(document.querySelector('app-blockly-editor'))
    return editor?.projectService.currentProjectPath === target && editor.projectService.getBlocklyProjectLoadStatus(target)?.ready
  }, project, { timeout: 120000 })
  report.before = await hashes()
  await stage('actual-child-host-with-local-stop-port')
  report.componentSetup = await page.evaluate(() => {
    const main = window.ng.getComponent(document.querySelector('app-main-window'))
    const definitions = main.constructor.ɵcmp.directiveDefs?.() ?? []
    const Host = definitions.map(item => item.type).find(type => type.ɵcmp?.selectors?.some(row => row.includes('app-child-tool-host')))
    if (!Host) throw Error('Actual ChildToolHost component definition is unavailable')
    // Suppress only child process startup in this isolated renderer. The actual
    // component constructor, subscriptions, protocol and notice methods run.
    Host.prototype.initTool = async function () { this.resolvedToolId = 'aily-chat'; this.refreshAiOperationNotice() }
    if (!main.uiService.openToolList.includes('aily-chat')) main.uiService.openToolList.push('aily-chat')
    main.uiService.actionSubject.next({ action: 'open', type: 'tool', data: 'aily-chat' })
    window.ng.applyChanges(main)
    return { childRuntimeSuppressed: true }
  })
  await page.locator('app-child-tool-host').waitFor({ timeout: 15000 })
  await page.waitForFunction(() => window.ng.getComponent(document.querySelector('app-child-tool-host'))?.resolvedToolId === 'aily-chat')
  await page.evaluate(() => {
    const host = window.ng.getComponent(document.querySelector('app-child-tool-host'))
    const component = window.ng.getComponent(document.querySelector('app-blockly-editor'))
    const state = window.__stopStateAcceptance = { host, component, editor: component.blocklyService,
      revision: 0, stops: [], compilerStops: 0, run: null, lease: null, grant: null }
    host.remoteApi = { async stopActiveTurn(owner) { state.stops.push(owner); return { ok: true, requestAccepted: true, settled: false, ...owner } } }
    state.report = run => host.ngZone.run(() => {
      state.run = run
      return host.reportAiOperationState({ version: 2, scope: host.aiOperationStateScope,
        bridgeInstanceId: 'isolated-stop-bridge', revision: ++state.revision,
        visibleSessionId: 'visible-other-session', runs: run ? [run] : [] })
    })
    state.begin = () => state.report({ sessionId: 'actual-operation-owner', turnId: 'isolated-turn-' + state.revision,
      running: true, active: true, phase: 'running' })
    state.snapshot = () => {
      const editor = state.editor
      const notification = window.ng.getComponent(document.querySelector('app-notification'))
      const event = new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true })
      editor.workspace.getParentSvg().dispatchEvent(event)
      return { aiWriting: editor.aiWriting, aiWaiting: editor.aiWaiting, aiWaitWriting: editor.aiWaitWriting,
        busy: editor.isWorkspaceEditInProgress(), blocked: editor.isWorkspaceEditBlocked(),
        recoveryRequired: editor.isWorkspaceRecoveryRequired(), writingSources: [...editor.aiWritingSources],
        executionSources: [...editor.aiExecutionActiveSources], inputFenced: event.defaultPrevented,
        notice: notification?.data ? { title: notification.data.title, state: notification.data.state,
          closable: notification.isClosable, hasStop: typeof notification.data.stop === 'function' } : null,
        stopCount: state.stops.length, compilerStops: state.compilerStops }
    }
  })
  const state = () => page.evaluate(() => window.__stopStateAcceptance.snapshot())
  const notice = title => page.locator('app-notification .notification-box').filter({ hasText: title })

  await page.waitForFunction(() => {
    const notice = window.ng.getComponent(document.querySelector('app-notification'))
    return notice?.data?.state !== 'doing'
  }, undefined, { timeout: 30000 })

  await stage('normal-writer-control')
  await page.evaluate(() => { const s = window.__stopStateAcceptance; s.begin(); s.lease = s.editor.acquireWorkspaceEditLease(); s.report(null) })
  assert.equal((await state()).notice.title, '正在结束工作区操作')
  await page.evaluate(() => { const s = window.__stopStateAcceptance; try {} finally { s.lease.release(); s.lease = null } })
  const normal = await state()
  assert.equal(normal.aiWriting, false); assert.equal(normal.busy, false); assert.equal(normal.blocked, false)
  assert.equal(normal.notice, null); assert.equal(normal.inputFenced, false)
  report.checks.push({ name: 'normal-finally-clears-writing-notice', ...normal })

  await stage('library-manager-two-second-generation')
  await page.evaluate(() => { const s = window.__stopStateAcceptance; s.begin(); s.component.openProjectManager() })
  assert.equal((await state()).aiWaitWriting, true)
  await page.waitForTimeout(1100)
  await page.evaluate(() => window.__stopStateAcceptance.component.openProjectManager())
  await page.waitForTimeout(1100)
  assert.equal((await state()).aiWaitWriting, true, 'An obsolete timeout cannot clear the newer hint')
  await page.waitForTimeout(1100)
  assert.equal((await state()).aiWaitWriting, false)
  await page.evaluate(() => { const s = window.__stopStateAcceptance; s.component.openProjectManager(); s.lease = s.editor.acquireWorkspaceEditLease() })
  await page.waitForTimeout(2100)
  assert.equal((await state()).aiWaitWriting, false, 'A wait hint expires while a genuine writer still owns its own overlay')
  assert.equal((await state()).aiWriting, true)
  await page.evaluate(() => { const s = window.__stopStateAcceptance; try {} finally { s.lease.release(); s.lease = null }; s.report(null) })
  const waiting = await state()
  assert.equal(waiting.aiWaitWriting, false); assert.equal(waiting.aiWriting, false); assert.equal(waiting.notice, null)
  report.checks.push({ name: 'library-manager-hint-generation-and-write-overlap', ...waiting })

  await stage('compiler-notice-ownership')
  await page.evaluate(() => {
    const s = window.__stopStateAcceptance; s.begin()
    s.host.noticeService.update({ title: 'Isolated compiler ownership control', state: 'doing', sendToLog: false,
      stop: () => { s.compilerStops++ } })
    s.host.refreshAiOperationNotice()
  })
  await notice('Isolated compiler ownership control').locator('.btn.red').click()
  assert.equal((await state()).compilerStops, 1); assert.equal((await state()).stopCount, 0)
  await page.evaluate(() => window.__stopStateAcceptance.host.noticeService.clear())
  await notice('AI正在操作').waitFor()
  await notice('AI正在操作').locator('.btn.red').click()
  await notice('正在停止 AI').waitFor()
  assert.equal((await state()).stopCount, 1)
  assert.equal((await state()).compilerStops, 1)
  await page.evaluate(() => window.__stopStateAcceptance.report(null))
  assert.equal((await state()).notice, null)
  report.checks.push({ name: 'compiler-presentation-restores-ai-with-exact-stop-owner', ...await state() })

  await stage('actual-quarantine-finally-and-stop')
  await page.evaluate(() => { const s = window.__stopStateAcceptance; s.begin(); s.lease = s.editor.acquireWorkspaceEditLease() })
  await notice('AI正在操作').locator('.btn.red').click()
  await notice('正在停止 AI').waitFor()
  assert.equal((await state()).busy, true, 'An accepted Stop does not pretend the native operation settled')
  await page.evaluate(() => {
    const s = window.__stopStateAcceptance
    try { throw Error('Controlled native recovery failure in this isolated lease') }
    catch (error) { s.grant = s.lease.quarantine(error.message) }
    finally { s.lease.release(); s.lease = null }
    s.report(null)
  })
  const quarantined = await state()
  assert.equal(quarantined.aiWriting, false); assert.equal(quarantined.aiWaiting, false)
  assert.equal(quarantined.busy, false); assert.equal(quarantined.blocked, true)
  assert.equal(quarantined.recoveryRequired, true); assert.equal(quarantined.inputFenced, true)
  assert.equal(quarantined.notice.title, '工作区需要恢复'); assert.equal(quarantined.notice.state, 'warn')
  assert.equal(quarantined.notice.closable, true); assert.equal(quarantined.notice.hasStop, false)
  await page.screenshot({ path: path.join(values.output, 'recovery-warning.png'), fullPage: true })
  await notice('工作区需要恢复').locator('.close').click()
  await page.waitForTimeout(600)
  const dismissed = await state()
  assert.equal(dismissed.notice, null); assert.equal(dismissed.blocked, true)
  assert.equal(dismissed.recoveryRequired, true); assert.equal(dismissed.inputFenced, true)
  assert.equal(dismissed.stopCount, 2)
  report.checks.push({ name: 'quarantine-is-dismissible-recovery-not-running', beforeDismissal: quarantined, afterDismissal: dismissed })

  await stage('verified-recovery-owner-control')
  await page.evaluate(() => {
    const s = window.__stopStateAcceptance, lease = s.editor.acquireWorkspaceRecoveryLease(s.grant)
    try { lease.completeRecovery() } finally { lease.release() }
  })
  const recovered = await state()
  assert.equal(recovered.blocked, false); assert.equal(recovered.recoveryRequired, false)
  assert.equal(recovered.aiWriting, false); assert.equal(recovered.busy, false); assert.equal(recovered.inputFenced, false)
  report.checks.push({ name: 'only-exact-recovery-owner-releases-protection', ...recovered })
  const stops = await page.evaluate(() => window.__stopStateAcceptance.stops)
  assert.equal(stops.length, 2)
  assert.ok(stops.every(owner => owner.version === 2 && owner.sessionId === 'actual-operation-owner'
    && owner.bridgeInstanceId === 'isolated-stop-bridge' && owner.turnId.startsWith('isolated-turn-') && owner.scope))
  report.exactStopOwners = stops
  report.after = await hashes()
  assert.deepEqual(report.after, report.before, 'The stop/recovery presentation acceptance must not rewrite project files')
  report.projectFilesPreserved = true
  report.ok = true
  await page.screenshot({ path: path.join(values.output, 'final.png'), fullPage: true })
} catch (error) {
  report.error = error.stack ?? String(error); process.exitCode = 1
  console.error(error.message)
  await page?.screenshot({ path: path.join(values.output, 'failure.png'), fullPage: true }).catch(() => {})
} finally {
  if (app) await app.evaluate(({ app }, owned) => {
    if (process.pid !== owned.pid || process.env.AILY_APPDATA_PATH !== owned.appData) throw Error('Refuse unrelated host exit')
    app.exit(0)
  }, { pid: hostPid, appData }).catch(error => { (report.cleanupErrors ??= []).push(error.message) })
  await renderer?.close().catch(error => { (report.cleanupErrors ??= []).push(error.message) })
  report.finishedAt = Date.now(); await persist()
  console.log(JSON.stringify({ ok: report.ok, checks: report.checks.length, output: values.output }))
}
