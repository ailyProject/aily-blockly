import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { _electron } from '@playwright/test'
import { serveRendererBuild } from '../fixtures/build-renderer-server.mjs'
import { createChatCancelModel } from '../fixtures/chat-cancel-model.mjs'
import { createLocalChatApiRouter, prepareInstalledChatProfile, assertInstalledChatLoaded } from '../fixtures/installed-chat-ui.mjs'

const repo = fileURLToPath(new URL('../../', import.meta.url))
const { values } = parseArgs({ options: Object.fromEntries(
  ['host-build', 'portable-root', 'seed-project', 'resource-root', 'test-root', 'lex-root', 'output'].map(name => [name, { type: 'string' }]),
) })
for (const name of ['host-build', 'portable-root', 'seed-project', 'resource-root', 'test-root', 'lex-root', 'output'])
  assert.ok(values[name] && path.isAbsolute(values[name]), `--${name} must be absolute`)
const inside = (root, value) => { const relative = path.relative(root, value)
  return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) }
assert.match(values['test-root'].replaceAll('\\', '/'), /\/aily-project\/dev-tests\//i)
assert.ok(inside(values['test-root'], values['seed-project']))
assert.ok(inside(path.join(repo, 'e2e/test-results'), values.output))
await fs.mkdir(values.output, { recursive: false })
const { verifyPortableBuild } = await import(pathToFileURL(path.join(values['lex-root'], 'packages/aily-chat/server/portable-integrity.ts')))
const artifact = await verifyPortableBuild(values['portable-root'])
const sha = value => createHash('sha256').update(value).digest('hex')
const seedBefore = sha(await fs.readFile(path.join(values['seed-project'], 'project.abi')))
const evidence = { ok: false, realElectron: true, realPortableChat: true, actualIframeComposer: true,
  deterministicLocalThinking: true, llmInvoked: false, syntheticIdentity: true, userProjectUsed: false,
  replacementStopHandler: false, fabricatedToolResults: false, artifact, cases: [] }
const phase = (mode, value) => console.log(`PHASE=${mode}:${value}`)
const files = ['package.json', 'project.abi', 'project.abs', 'project.abs.map.json']
const hashes = async project => Object.fromEntries(await Promise.all(files.map(async name => {
  try { return [name, sha(await fs.readFile(path.join(project, name)))] }
  catch (error) { if (error.code === 'ENOENT') return [name, null]; throw error }
})))

async function runCase(mode) {
  const suite = await fs.mkdtemp(path.join(values['test-root'], 'portable-stop-' + mode + '-'))
  const project = path.join(suite, 'project'), appData = path.join(suite, 'appdata')
  const home = path.join(suite, 'home'), temp = path.join(suite, 'temp'), output = path.join(values.output, mode)
  await fs.cp(values['seed-project'], project, { recursive: true, dereference: true, errorOnExist: true })
  for (const directory of [appData, home, temp, output]) await fs.mkdir(directory)
  const result = { mode, ok: false, suite, project, abortCommands: [], abortResponses: [], eventCounts: {},
    hostReports: [], externalRequestsBlocked: 0, stages: [] }; evidence.cases.push(result)
  let app, page, renderer, router, model, hostPid, sessionId
  const stage = value => { result.stages.push(value); phase(mode, value) }
  try {
    model = await createChatCancelModel()
    router = await createLocalChatApiRouter({ operationOrigin: model.origin, installedRoot: values['portable-root'] })
    const profile = await prepareInstalledChatProfile({ appData, installedRoot: values['portable-root'], apiBase: router.origin,
      baseConfigPath: path.join(repo, 'electron/config/config.json'), resourceAppData: values['resource-root'], token: router.token })
    renderer = await serveRendererBuild(values['host-build'])
    const { ELECTRON_RUN_AS_NODE, AILY_CHILD_PATH, NODE_PATH, AILY_PORTABLE_ROOT, AILY_AUTH_FILE, ...env } = process.env
    stage('cold-portable-iframe')
    app = await _electron.launch({ args: ['.', '--serve', `--user-data-dir=${path.join(suite, 'electron-profile')}`], cwd: repo,
      timeout: 60000, env: { ...env, ...profile.env, AILY_E2E: '1', AILY_DEV_RENDERER_URL: renderer.origin,
        HOME: home, USERPROFILE: home, TEMP: temp, TMP: temp, npm_config_offline: 'true', npm_config_audit: 'false' } })
    hostPid = await app.evaluate(() => process.pid); result.hostPid = hostPid
    await app.context().route('**/*', async route => {
      const request = route.request(), url = new URL(request.url())
      if (!['http:', 'https:'].includes(url.protocol) || ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return route.continue()
      if (!url.pathname.startsWith('/api/')) { result.externalRequestsBlocked++; return route.abort('blockedbyclient') }
      const headers = { ...request.headers() }; delete headers.host; delete headers['content-length']; delete headers.connection
      const response = await fetch(router.origin + url.pathname + url.search, { method: request.method(), headers,
        ...(['GET', 'HEAD'].includes(request.method()) ? {} : { body: request.postDataBuffer() }), signal: AbortSignal.timeout(15000) })
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) })
    })
    const deadline = Date.now() + 60000
    while (!page && Date.now() < deadline) {
      page = app.windows().find(window => window.url().startsWith(renderer.origin))
      if (!page) await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.ok(page)
    const commandIds = new Set()
    page.on('websocket', socket => {
      socket.on('framesent', ({ payload }) => {
        let value; try { value = JSON.parse(String(payload)) } catch { return }
        if (value.channel !== 'agent' || value.command?.type !== 'abort') return
        commandIds.add(value.id)
        result.abortCommands.push({ id: value.id, sessionId: value.command.sessionId,
          source: value.command.source, reason: value.command.reason, waitForSettle: value.command.waitForSettle })
      })
      socket.on('framereceived', ({ payload }) => {
        let value; try { value = JSON.parse(String(payload)) } catch { return }
        if (value.channel !== 'agent') return
        if (value.type === 'response' && commandIds.has(value.id))
          result.abortResponses.push({ id: value.id, ok: value.ok, accepted: value.result?.accepted, settled: value.result?.settled })
        if (value.type === 'event' && typeof value.event?.type === 'string')
          result.eventCounts[value.event.type] = (result.eventCounts[value.event.type] ?? 0) + 1
      })
    })
    page.on('dialog', dialog => dialog.dismiss())
    await page.goto(renderer.origin, { waitUntil: 'domcontentloaded' })
    await page.locator('app-main-window').waitFor({ timeout: 60000 })
    await page.evaluate(() => {
      const dismiss = () => document.querySelector('app-onboarding .btn-skip')?.click()
      new MutationObserver(dismiss).observe(document.documentElement, { childList: true, subtree: true }); dismiss()
    })
    await page.waitForFunction(() => window.ng?.getComponent(document.querySelector('app-header'))?.projectService)
    await page.evaluate(async target => {
      const service = window.ng.getComponent(document.querySelector('app-header')).projectService
      await service.initializeProjectDataSchema(target)
      if (!await service.projectOpen(target)) throw Error('The copied stop project did not open')
    }, project)
    await page.waitForFunction(target => {
      const editor = window.ng.getComponent(document.querySelector('app-blockly-editor'))
      return editor?.projectService.currentProjectPath === target && editor.projectService.getBlocklyProjectLoadStatus(target)?.ready
    }, project, { timeout: 120000 })
    const loaded = await assertInstalledChatLoaded(page, { installedRoot: values['portable-root'], output,
      expectedApiBase: router.origin, expectedInputHash: artifact.inputHash, expectedOutputHash: artifact.outputHash })
    result.chat = loaded.evidence
    await page.evaluate(() => {
      const host = window.ng.getComponent(document.querySelector('app-child-tool-host')), original = host.reportAiOperationState.bind(host)
      window.__portableStopReports = []
      // Read-only observation: the actual method and ACK are returned unchanged.
      host.reportAiOperationState = (...args) => {
        const ack = original(...args); window.__portableStopReports.push({ request: args[0], ack }); return ack
      }
    })
    result.before = await hashes(project)
    const composer = loaded.frame.locator('.aily-chat-composer-input[role="textbox"]')
    await composer.fill('This is an isolated cancellation acceptance. Do not call any tool or edit any file; wait while I press Stop.')
    await loaded.frame.locator('button.primary-action.send-action').click()
    stage('one-real-composer-prompt')
    const awaiting = Date.now() + 45000
    while (model.snapshot().createCount === 0 && Date.now() < awaiting) {
      const dialogs = loaded.frame.locator('.pi-extension-dialog')
      for (let index = 0; index < await dialogs.count(); index++) {
        const dialog = dialogs.nth(index)
        if (!await dialog.isVisible()) continue
        const title = await dialog.getAttribute('aria-label'), lines = String(title).split(/\r?\n/)
        assert.equal(lines[0], 'Trust project folder?'); assert.equal(path.resolve(lines[1]), path.resolve(project))
        await dialog.getByRole('button', { name: 'Trust (this session only)', exact: true }).click()
      }
      assert.equal(await loaded.frame.locator('.full-access-permission-dialog').isVisible(), false)
      await page.waitForTimeout(100)
    }
    assert.equal(model.snapshot().createCount, 1)
    await loaded.frame.locator('button.stop-action').waitFor({ state: 'visible', timeout: 15000 })
    await page.waitForFunction(() => (window.__portableStopReports ?? []).some(item =>
      item.request.version === 2 && item.request.runs.length === 1 && item.ack.applied), undefined, { timeout: 15000 })
    const listed = await loaded.e2e('session.list')
    const candidates = listed.sessions.filter(item => path.resolve(item.cwd).toLowerCase() === project.toLowerCase())
    assert.equal(candidates.length, 1); sessionId = candidates[0].sessionId
    result.sessionId = sessionId
    const running = await loaded.e2e('session.read', { sessionId })
    assert.equal(running.session.isIdle, false)
    assert.equal(running.session.messages.filter(message => message.role === 'user').length, 1)
    const beforeStop = await page.evaluate(() => {
      const editor = window.ng.getComponent(document.querySelector('app-blockly-editor')).blocklyService
      const host = window.ng.getComponent(document.querySelector('app-child-tool-host'))
      return { writing: editor.aiWriting, waitWriting: editor.aiWaitWriting, blocked: editor.isWorkspaceEditBlocked(),
        nativeBusy: editor.isWorkspaceEditInProgress(), owner: host.aiOperationProtocol?.selected?.owner }
    })
    assert.deepEqual({ ...beforeStop, owner: undefined }, { writing: false, waitWriting: false, blocked: false, nativeBusy: false, owner: undefined })
    assert.equal(beforeStop.owner.sessionId, sessionId); result.beforeStop = beforeStop
    assert.equal(await page.locator('.blockly-spin.show').count(), 0)
    stage('actual-' + mode + '-stop')
    if (mode === 'chat') await loaded.frame.locator('button.stop-action').click()
    else await page.locator('app-notification .notification-box').filter({ hasText: 'AI正在操作' }).locator('.btn.red').click()
    const settlingDeadline = Date.now() + 30000
    let settled
    while (Date.now() < settlingDeadline) {
      const value = await loaded.e2e('session.read', { sessionId })
      if (value.session.isIdle && !value.session.isStreaming) { settled = value.session; break }
      await page.waitForTimeout(100)
    }
    assert.ok(settled, 'The actual backend session must settle after its UI abort command')
    const final = settled.messages.filter(message => message.role === 'assistant').at(-1)
    assert.equal(final?.stopReason, 'aborted')
    assert.equal(settled.messages.filter(message => message.role === 'toolResult').length, 0)
    assert.equal(settled.messages.some(message => message.role === 'assistant' && message.content?.some(part => part.type === 'toolCall')), false)
    await page.waitForFunction(() => {
      const host = window.ng.getComponent(document.querySelector('app-child-tool-host'))
      return !host.aiOperationProtocol?.hasRunning && (window.__portableStopReports ?? []).some(item =>
        item.request.version === 2 && item.request.runs.length === 0 && item.ack.applied)
    }, undefined, { timeout: 15000 })
    await loaded.frame.locator('button.stop-action').waitFor({ state: 'hidden', timeout: 15000 })
    assert.equal(await page.locator('app-notification .notification-box').filter({ hasText: /AI正在操作|正在停止 AI|正在同步 AI 状态/ }).count(), 0)
    assert.equal(await page.locator('.blockly-spin.show').count(), 0)
    assert.equal(result.abortCommands.length, 1); assert.equal(result.abortCommands[0].sessionId, sessionId)
    assert.ok(result.abortResponses.some(response => response.ok && response.accepted === true))
    assert.ok(result.eventCounts.agent_settled >= 1)
    result.hostReports = await page.evaluate(() => window.__portableStopReports)
    result.transport = model.snapshot()
    assert.deepEqual(result.transport.failures, []); assert.equal(result.transport.createCount, 1)
    assert.equal(result.transport.interruptCount, 1); assert.equal(result.transport.active, false)
    result.after = await hashes(project); assert.deepEqual(result.after, result.before)
    result.finalState = { isIdle: settled.isIdle, isStreaming: settled.isStreaming, stopReason: final.stopReason,
      userMessages: settled.messages.filter(message => message.role === 'user').length, toolResults: 0,
      providerCancellationMatchedOriginalIdentity: true, hostV2RunsCleared: true, nativeOverlayBlocked: false }
    result.ok = true
    await page.screenshot({ path: path.join(output, 'stopped.png'), fullPage: true })
    stage('settled-and-host-table-cleared')
  } catch (error) {
    result.error = error.stack ?? String(error); throw error
  } finally {
    result.transport = model?.snapshot()
    if (app) await app.evaluate(({ app }, owned) => {
      if (process.pid !== owned.pid || process.env.AILY_APPDATA_PATH !== owned.appData) throw Error('Refuse unrelated host exit')
      app.exit(0)
    }, { pid: hostPid, appData }).catch(error => { result.cleanupError = error.message; process.exitCode = 1 })
    await renderer?.close(); await router?.close(); await model?.close()
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2))
  }
}

try {
  for (const mode of ['chat', 'host']) await runCase(mode)
  assert.equal(sha(await fs.readFile(path.join(values['seed-project'], 'project.abi'))), seedBefore)
  assert.deepEqual(await verifyPortableBuild(values['portable-root']), artifact)
  evidence.ok = evidence.cases.length === 2 && evidence.cases.every(item => item.ok)
} catch (error) { evidence.error = error.stack ?? String(error); process.exitCode = 1; console.error(error.message) }
finally {
  await fs.writeFile(path.join(values.output, 'result.json'), JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify({ ok: evidence.ok, cases: evidence.cases.length, output: values.output }))
}
