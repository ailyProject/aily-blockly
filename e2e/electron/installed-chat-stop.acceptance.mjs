import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { _electron } from '@playwright/test'
import { serveRendererBuild } from '../fixtures/build-renderer-server.mjs'
import { prepareInstalledChatProfile, assertInstalledChatLoaded } from '../fixtures/installed-chat-ui.mjs'
import { createStartupFaultProxy } from '../fixtures/create-startup-fault-proxy.mjs'
import { observeOnlineModelCatalog, explicitOnlineModelId, resolveOnlineModelPreset,
  selectOnlineModelFromUi, assertSelectedOnlineModel } from '../fixtures/online-model-selection.mjs'

// Explicit, paid, real-upstream acceptance. The actual composer submits and the
// actual selected UI surface stops. Observation never invokes a model or tool.
assert.equal(process.env.AILY_ONLINE_ACCEPTANCE, '1', 'Online acceptance must be explicitly enabled')
const repo = fileURLToPath(new URL('../../', import.meta.url))
const names = ['connection-profile', 'installed-root', 'seed-project', 'test-root', 'resource-root', 'host-build', 'lex-root', 'output']
const { values } = parseArgs({ options: { ...Object.fromEntries(names.map(name => [name, { type: 'string' }])),
  'stop-surface': { type: 'string', default: 'host' } } })
for (const name of names) assert.ok(values[name] && path.isAbsolute(values[name]), `--${name} must be absolute`)
assert.ok(['chat', 'host'].includes(values['stop-surface']))
const inside = (root, value) => { const relative = path.relative(root, value)
  return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) }
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
assert.ok(inside(path.join(values['resource-root'], 'dev-tests'), values['test-root']))
assert.ok(inside(values['test-root'], values['seed-project']))
assert.ok(inside(path.join(repo, 'e2e/test-results'), values.output))
const sha = value => createHash('sha256').update(value).digest('hex')
const textOf = message => (message?.content ?? []).filter(item => item.type === 'text').map(item => item.text).join('')
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
const uncovered = message => Object.assign(new Error(message), { code: 'SCENARIO_NOT_COVERED' })
const connection = JSON.parse(await fs.readFile(values['connection-profile'], 'utf8'))
assert.ok(connection && typeof connection.apiBase === 'string' && path.isAbsolute(connection.authFile ?? '')
  && path.isAbsolute(connection.configFile ?? ''), 'Explicit profile requires apiBase, authFile and configFile')
const api = new URL(connection.apiBase)
assert.ok(['http:', 'https:'].includes(api.protocol) && api.pathname === '/' && !api.username && !api.password && !api.search && !api.hash)
assert.ok(!same(connection.authFile, path.join(values['resource-root'], '.aily')), 'Do not use daily credentials')
await fs.mkdir(values.output, { recursive: false })
const suite = await fs.mkdtemp(path.join(values['test-root'], 'online-stop-' + values['stop-surface'] + '-'))
const project = path.join(suite, 'project'), appData = path.join(suite, 'appdata'), home = path.join(suite, 'home')
const agentProfile = path.join(suite, 'agent-profile'), agentTemp = path.join(suite, 'agent-temp')
const evidence = { ok: false, suite, project, stopSurface: values['stop-surface'], actualIframeComposer: true,
  realInstalledUi: true, onlineLlm: false, syntheticOutput: false, syntheticIdentity: false, syntheticProof: false,
  replacementStopHandler: false, fabricatedToolResults: false, userProjectsModified: false, sdkTimeoutsOverridden: false,
  abortCommands: [], abortResponses: [], settledSessions: [], eventCounts: {}, hostReports: [], coverage: { userStop: false }, cleanupFailures: [] }
const protectedFiles = new Map()
let app, page, renderer, proxy, loaded, hostPid, sessionId, snapshot, selectedModel, catalog, artifact, verifyPortableBuild
let accessToken, sourceBefore, projectBefore, stopAt
const phase = value => { evidence.phase = value; console.log('PHASE=' + value) }
const safeError = error => {
  let message = String(error?.message ?? error)
  if (accessToken) message = message.replaceAll(accessToken, '[private credential]')
  return { name: error?.name, code: error?.code, message: message.replace(/([?&]token=|Bearer\s+)[^\s"'&]+/gi, '$1[private credential]') }
}
const hashes = async directory => {
  const result = {}
  for (const name of ['package.json', 'package-lock.json', 'project.abi', 'project.abs', 'project.abs.map.json', 'sketch.ino']) {
    try { result[name] = sha(await fs.readFile(path.join(directory, name))) }
    catch (error) { if (error.code !== 'ENOENT') throw error; result[name] = null }
  }
  return result
}
const hostState = () => page.evaluate(() => {
  const service = window.ng.getComponent(document.querySelector('app-blockly-editor')).blocklyService
  const host = window.ng.getComponent(document.querySelector('app-child-tool-host'))
  const notices = [...document.querySelectorAll('app-notification .notification-box')]
  return { writing: service.aiWriting, waitWriting: service.aiWaitWriting, busy: service.isWorkspaceEditInProgress(),
    blocked: service.isWorkspaceEditBlocked(), recoveryRequired: service.isWorkspaceRecoveryRequired(),
    hasRunning: host.aiOperationProtocol?.hasRunning, owner: host.aiOperationProtocol?.selected?.owner,
    aiNoticeCount: notices.filter(node => /AI正在操作|正在停止 AI|正在同步 AI 状态/.test(node.textContent)).length,
    overlayCount: document.querySelectorAll('.blockly-spin.show').length,
    reports: (window.__onlineStopReports ?? []).map(item => ({ request: item.request, ack: item.ack })) }
})
async function canonical() {
  const transport = proxy.snapshot(), operation = transport.operations.toSorted((a, b) => a.step - b.step).at(-1)
  if (!operation) return undefined
  const response = await fetch(`${proxy.origin}/api/v3/interactions/${transport.interactionId}/operations/${operation.step}/state`, {
    headers: { authorization: 'Bearer ' + accessToken }, signal: AbortSignal.timeout(5000) })
  assert.equal(response.status, 200, 'The original real operation must remain observable')
  const value = await response.json()
  assert.equal(value.operationId, operation.operationId)
  return { operationId: value.operationId, status: value.status, streamState: value.streamState }
}
async function trustOnlyThisProject() {
  for (const dialog of await loaded.frame.locator('.pi-extension-dialog').all()) if (await dialog.isVisible()) {
    const lines = String(await dialog.getAttribute('aria-label')).split(/\r?\n/)
    assert.equal(lines[0], 'Trust project folder?'); assert.ok(same(lines[1], project))
    await dialog.getByRole('button', { name: 'Trust (this session only)', exact: true }).click()
  }
  assert.equal(await loaded.frame.locator('.full-access-permission-dialog').isVisible(), false)
}
async function readOwnedSession() {
  if (!sessionId) {
    const listed = await loaded.e2e('session.list'), candidates = listed.sessions.filter(item => same(item.cwd, project))
    assert.ok(candidates.length <= 1); sessionId = candidates[0]?.sessionId
  }
  if (sessionId) snapshot = (await loaded.e2e('session.read', { sessionId })).session
  return snapshot
}
try {
  for (const directory of [appData, home, agentProfile, agentTemp]) await fs.mkdir(directory)
  for (const file of new Set([values['connection-profile'], connection.configFile, connection.authFile,
    path.join(values['resource-root'], 'config.json'), path.join(values['resource-root'], '.aily'),
    path.join(values['resource-root'], 'npm-global/app/store/subapp-aily-chat/active.json'),
    path.join(values['resource-root'], 'npm-global/app/subapp-index.json')])) {
    protectedFiles.set(file, await fs.readFile(file).then(sha).catch(error => { if (error.code === 'ENOENT') return null; throw error }))
  }
  const config = JSON.parse(await fs.readFile(connection.configFile, 'utf8'))
  assert.equal(new URL(config.regions?.[config.region]?.api_server).origin, api.origin, 'Do not send credentials to another API origin')
  const auth = JSON.parse(await fs.readFile(connection.authFile, 'utf8'))
  assert.ok(typeof auth.access_token === 'string' && auth.access_token.length > 0); accessToken = auth.access_token
  ;({ verifyPortableBuild } = await import(pathToFileURL(path.join(values['lex-root'], 'packages/aily-chat/server/portable-integrity.ts'))))
  artifact = await verifyPortableBuild(values['installed-root'])
  const { captureBuildInputs } = await import(pathToFileURL(path.join(values['lex-root'], 'packages/aily-chat/scripts/portable-build-inputs.mjs')))
  assert.equal(artifact.inputHash, sha(JSON.stringify(await captureBuildInputs(values['lex-root']))), 'Installed Chat must match current build inputs')
  evidence.installed = artifact; evidence.upstream = { apiBase: api.origin, configuredRegion: config.region, explicitConnectionProfile: true }
  phase('real-api-preflight')
  const me = await fetch(api.origin + '/api/v1/auth/me', { headers: { authorization: 'Bearer ' + accessToken }, signal: AbortSignal.timeout(15000) })
  evidence.authStatus = me.status; await me.body?.cancel(); assert.equal(me.status, 200)
  sourceBefore = await hashes(values['seed-project'])
  await fs.cp(values['seed-project'], project, { recursive: true, dereference: true, errorOnExist: true })
  // Model-visible tools cannot read credentials or mutate the copied workspace.
  const policy = path.join(agentProfile, 'extensions/pi-permission-system/config.json')
  await fs.mkdir(path.dirname(policy), { recursive: true })
  await fs.writeFile(policy, JSON.stringify({ permission: { '*': 'deny' } }), { flag: 'wx' })
  proxy = await createStartupFaultProxy({ upstreamOrigin: api.origin, mode: 'passive' })
  const profile = await prepareInstalledChatProfile({ appData, installedRoot: values['installed-root'], apiBase: proxy.origin,
    baseConfigPath: connection.configFile, resourceAppData: values['resource-root'], token: accessToken })
  renderer = await serveRendererBuild(values['host-build'])
  const { ELECTRON_RUN_AS_NODE, AILY_CHILD_PATH, NODE_PATH, AILY_PORTABLE_ROOT, AILY_AUTH_FILE, ...env } = process.env
  phase('cold-installed-chat')
  app = await _electron.launch({ args: ['.', '--serve', `--user-data-dir=${path.join(suite, 'electron-profile')}`], cwd: repo,
    timeout: 60000, env: { ...env, ...profile.env, AILY_E2E: '1', AILY_DEV_RENDERER_URL: renderer.origin,
      HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentProfile, TEMP: agentTemp, TMP: agentTemp,
      npm_config_offline: 'true', npm_config_audit: 'false' } })
  hostPid = await app.evaluate(() => process.pid); evidence.hostPid = hostPid
  await app.context().route('**/*', async route => {
    const request = route.request(), url = new URL(request.url())
    if (!['http:', 'https:'].includes(url.protocol) || ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return route.continue()
    if (url.origin !== api.origin || !url.pathname.startsWith('/api/')) return route.abort('blockedbyclient')
    const headers = { ...request.headers() }; delete headers.host; delete headers.connection; delete headers['content-length']
    try {
      const response = await fetch(proxy.origin + url.pathname + url.search, { method: request.method(), headers,
        ...(['GET', 'HEAD'].includes(request.method()) ? {} : { body: request.postDataBuffer() }), signal: AbortSignal.timeout(15000) })
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) })
    } catch { await route.abort('connectionfailed') }
  })
  const pageDeadline = Date.now() + 60000
  while (!page && Date.now() < pageDeadline) { page = app.windows().find(candidate => candidate.url().startsWith(renderer.origin)); if (!page) await wait(100) }
  assert.ok(page)
  const commands = new Set()
  page.on('websocket', socket => {
    let url; try { url = new URL(socket.url()) } catch { return }
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.pathname !== '/ws') return
    socket.on('framesent', ({ payload }) => {
      let value; try { value = JSON.parse(String(payload)) } catch { return }
      if (value.channel !== 'agent' || value.command?.type !== 'abort') return
      commands.add(value.id); evidence.abortCommands.push({ id: value.id, sessionId: value.command.sessionId,
        source: value.command.source, reason: value.command.reason, waitForSettle: value.command.waitForSettle })
    })
    socket.on('framereceived', ({ payload }) => {
      let value; try { value = JSON.parse(String(payload)) } catch { return }
      if (value.channel !== 'agent') return
      if (value.type === 'response' && commands.has(value.id)) evidence.abortResponses.push({ id: value.id,
        ok: value.ok, accepted: value.result?.accepted, settled: value.result?.settled })
      if (value.type === 'event' && typeof value.event?.type === 'string')
        evidence.eventCounts[value.event.type] = (evidence.eventCounts[value.event.type] ?? 0) + 1
      if (value.type === 'event' && value.event?.type === 'agent_settled') evidence.settledSessions.push(value.sessionId)
    })
  })
  if (explicitOnlineModelId(connection.model)) catalog = observeOnlineModelCatalog(page, project)
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
    if (!await service.projectOpen(target)) throw Error('The copied online project did not open')
  }, project)
  await page.waitForFunction(target => {
    const editor = window.ng.getComponent(document.querySelector('app-blockly-editor'))
    return editor?.projectService.currentProjectPath === target && editor.projectService.getBlocklyProjectLoadStatus(target)?.ready
  }, project, { timeout: 120000 })
  loaded = await assertInstalledChatLoaded(page, { installedRoot: values['installed-root'], expectedApiBase: proxy.origin,
    expectedInputHash: artifact.inputHash, expectedOutputHash: artifact.outputHash })
  evidence.chat = { ...loaded.evidence, syntheticIdentity: false }; delete evidence.chat.buildEvidence
  if (catalog) {
    const response = await fetch(proxy.origin + '/api/v2/model_catalog', { headers: { authorization: 'Bearer ' + accessToken }, signal: AbortSignal.timeout(15000) })
    assert.equal(response.status, 200); selectedModel = resolveOnlineModelPreset(await response.json(), connection.model)
    evidence.modelCatalog = await catalog.waitUntilReady(selectedModel, { deadline: Date.now() + 60000 })
    evidence.selectedModel = await selectOnlineModelFromUi(loaded.frame, selectedModel)
  }
  await page.evaluate(() => {
    const host = window.ng.getComponent(document.querySelector('app-child-tool-host')), original = host.reportAiOperationState.bind(host)
    window.__onlineStopReports = []
    // Observe actual implementation and ACK; the stop RPC remains untouched.
    host.reportAiOperationState = (...args) => { const ack = original(...args)
      window.__onlineStopReports.push({ request: args[0], ack }); return ack }
  })
  projectBefore = await hashes(project)
  evidence.before = projectBefore
  await loaded.frame.locator('.aily-chat-composer-input[role="textbox"]').fill(
    '这是隔离工程中的纯文本取消验收。请不要读取文件、不要调用任何工具、不要修改工程、不要访问网络或设备。仅依据下面完整输入分析：一个 Arduino 温控循环用 now >= last + 250 检测250ms周期，温度断路返回NaN，PWM未更新时保持上次输出，串口读行可能阻塞1000ms。请详细推导 uint32_t 回绕、NaN保持加热、串口阻塞、过温后复位四种风险，并给出约150行的非阻塞状态机伪代码和20条时序测试用例。无需询问用户，不要执行任何代码；只输出文本。我将在回答过程中点击停止。')
  await loaded.frame.locator('button.primary-action.send-action').click()
  phase('one-real-composer-prompt')
  const readyDeadline = Date.now() + 120000
  while (!stopAt && Date.now() < readyDeadline) {
    await trustOnlyThisProject(); await readOwnedSession()
    if (snapshot) {
      assertSelectedOnlineModel(snapshot, selectedModel)
      const transport = proxy.snapshot(), current = await hostState()
      const hasSemantic = transport.operations.some(operation => operation.semanticEvents > 0 && !operation.terminal)
      const acknowledged = current.reports.some(item => item.request.version === 2 && item.request.runs.some(run => run.sessionId === sessionId) && item.ack.applied)
      if (!snapshot.isIdle && snapshot.isStreaming && hasSemantic && acknowledged && current.owner?.sessionId === sessionId) {
        const state = await canonical()
        if (state?.status === 'running' && state.streamState === 'open') {
          evidence.beforeStop = current; evidence.canonicalBeforeStop = state
          const applied = current.reports.filter(item => item.request.version === 2 && item.ack.applied
            && item.request.runs.some(run => run.sessionId === sessionId)).at(-1)
          evidence.runningSnapshot = { scope: applied.request.scope, bridgeInstanceId: applied.request.bridgeInstanceId,
            revision: applied.request.revision, owner: current.owner }
          assert.deepEqual({ writing: current.writing, waitWriting: current.waitWriting, busy: current.busy,
            blocked: current.blocked, recoveryRequired: current.recoveryRequired, overlayCount: current.overlayCount },
          { writing: false, waitWriting: false, busy: false, blocked: false, recoveryRequired: false, overlayCount: 0 })
          assert.equal(current.aiNoticeCount, 1)
          if (values['stop-surface'] === 'chat') await loaded.frame.locator('button.primary-action.stop-action').click()
          else await page.locator('app-notification .notification-box').filter({ hasText: 'AI正在操作' }).locator('.btn.red').click()
          stopAt = Date.now(); evidence.stopAt = stopAt; evidence.sessionId = sessionId; phase('actual-ui-stop-clicked')
        }
      }
      if (!stopAt && snapshot.isIdle && snapshot.messages.some(message => message.role === 'assistant'))
        throw uncovered('The real model settled before a running stream could be stopped; no additional model call is made')
    }
    if (!stopAt) await wait(100)
  }
  if (!stopAt) throw uncovered('A real semantic running stream was not available inside the original startup deadline')
  const isIdleAck = item => item.request.version === 2 && item.request.scope === evidence.runningSnapshot.scope
    && item.request.bridgeInstanceId === evidence.runningSnapshot.bridgeInstanceId
    && item.request.revision > evidence.runningSnapshot.revision && item.request.runs.length === 0 && item.ack.applied
  const settledDeadline = Date.now() + 30000
  let finalHost, finalCanonical
  while (Date.now() < settledDeadline) {
    await readOwnedSession(); finalHost = await hostState(); finalCanonical = await canonical()
    const idleAck = finalHost.reports.some(isIdleAck)
    if (snapshot?.isIdle && !snapshot.isStreaming && !finalHost.hasRunning && idleAck && finalHost.aiNoticeCount === 0
      && !finalHost.writing && !finalHost.waitWriting && !finalHost.busy && finalCanonical?.status === 'interrupted') break
    await wait(100)
  }
  const final = snapshot?.messages.filter(message => message.role === 'assistant').at(-1)
  evidence.hostReports = finalHost?.reports ?? []
  if (finalHost) { const { reports, ...state } = finalHost; evidence.finalHost = state }
  evidence.canonical = finalCanonical
  evidence.final = { isIdle: snapshot?.isIdle, isStreaming: snapshot?.isStreaming, stopReason: final?.stopReason,
    textSha256: sha(textOf(final)), textBytes: Buffer.byteLength(textOf(final)),
    toolResults: snapshot?.messages.filter(message => message.role === 'toolResult').length }
  assert.ok(snapshot?.isIdle && !snapshot.isStreaming, 'Actual session must settle after UI Stop')
  assert.equal(final?.stopReason, 'aborted')
  assert.equal(snapshot.messages.filter(message => message.role === 'user').length, 1)
  assert.equal(snapshot.messages.filter(message => message.role === 'toolResult').length, 0)
  assert.equal(snapshot.messages.some(message => message.role === 'assistant' && message.content?.some(part => part.type === 'toolCall')), false)
  assert.equal(evidence.abortCommands.length, 1); assert.equal(evidence.abortCommands[0].sessionId, sessionId)
  assert.equal(evidence.abortCommands[0].reason, 'user_stop')
  assert.ok(evidence.abortResponses.some(response => response.ok && response.accepted === true))
  assert.ok(evidence.settledSessions.includes(sessionId), 'The stopped owner must emit a real settled event')
  evidence.transport = proxy.snapshot()
  assert.equal(evidence.transport.createCount, 1); assert.equal(evidence.transport.interruptCount, 1)
  assert.deepEqual(evidence.transport.failures, []); assert.equal(evidence.transport.operations.length, 1)
  assert.equal(finalCanonical?.status, 'interrupted')
  assert.deepEqual({ writing: finalHost.writing, waitWriting: finalHost.waitWriting, busy: finalHost.busy,
    blocked: finalHost.blocked, recoveryRequired: finalHost.recoveryRequired, hasRunning: finalHost.hasRunning,
    aiNoticeCount: finalHost.aiNoticeCount, overlayCount: finalHost.overlayCount },
  { writing: false, waitWriting: false, busy: false, blocked: false, recoveryRequired: false,
    hasRunning: false, aiNoticeCount: 0, overlayCount: 0 })
  assert.ok(finalHost.reports.some(isIdleAck), 'A newer empty snapshot from the same connection must be applied')
  await loaded.frame.locator('button.stop-action').waitFor({ state: 'hidden', timeout: 5000 })
  evidence.after = await hashes(project); assert.deepEqual(evidence.after, projectBefore)
  evidence.coverage.userStop = true; evidence.ok = true
  phase('settled-v2-empty-notice-gone')
} catch (error) {
  evidence.failure = safeError(error); if (error.catalogReadiness) evidence.modelCatalog = error.catalogReadiness
  console.error('ACCEPTANCE_FAILED', evidence.failure.message); process.exitCode = 1
} finally {
  const finish = async (label, action) => { try { await action() } catch (error) {
    evidence.cleanupFailures.push({ label, ...safeError(error) }); evidence.ok = false; process.exitCode = 1 } }
  catalog?.close()
  if (loaded && (!snapshot?.isIdle || snapshot?.isStreaming)) await finish('settle-owned-session', async () => {
    // One stop request only. Never repeat interrupt after the tested click.
    if (!stopAt) {
      const stop = loaded.frame.locator('button.primary-action.stop-action')
      if (await stop.isVisible()) { await stop.click({ timeout: 3000 }); evidence.cleanupStopRequested = true }
    }
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      await readOwnedSession(); const state = await canonical()
      if (snapshot?.isIdle && !snapshot.isStreaming && (!state || state.status !== 'running')) {
        evidence.cleanupSettlement = { isIdle: true, isStreaming: false, canonicalStatus: state?.status ?? 'not-started' }; return
      }
      await wait(200)
    }
    throw Error('The original owned session did not settle within cleanup deadline')
  })
  if (page) await finish('screenshot', () => page.screenshot({ path: path.join(values.output, 'final.png'), fullPage: true }))
  evidence.transport = proxy?.snapshot()
  evidence.onlineLlm = evidence.transport?.operations.some(operation => operation.semanticEvents > 0) ?? false
  if (evidence.chat) evidence.chat.realModelInvoked = evidence.onlineLlm
  if (app) await finish('close-owned-host', () => app.evaluate(({ app }, owned) => {
    if (process.pid !== owned.pid || process.env.AILY_APPDATA_PATH !== owned.appData) throw Error('Refuse unrelated host shutdown')
    app.exit(0)
  }, { pid: hostPid, appData }))
  await finish('close-owned-renderer', () => renderer?.close())
  await finish('close-owned-proxy', () => proxy?.close())
  await finish('remove-private-access-token', () => fs.unlink(path.join(appData, '.aily')).catch(error => { if (error.code !== 'ENOENT') throw error }))
  await finish('preserve-inputs-and-artifact', async () => {
    if (sourceBefore) assert.deepEqual(await hashes(values['seed-project']), sourceBefore)
    for (const [file, original] of protectedFiles) {
      const current = await fs.readFile(file).then(sha).catch(error => { if (error.code === 'ENOENT') return null; throw error })
      assert.equal(current, original, 'Protected input changed: ' + path.basename(file))
    }
    if (artifact) assert.deepEqual(await verifyPortableBuild(values['installed-root']), artifact)
    evidence.sourceAndDailyConfigurationUnchanged = true
  })
  await fs.writeFile(path.join(values.output, 'result.json'), JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify({ ok: evidence.ok, coverage: evidence.coverage, phase: evidence.phase, output: values.output,
    failure: evidence.failure?.message, cleanupFailures: evidence.cleanupFailures.length }))
}
