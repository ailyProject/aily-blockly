import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { _electron } from '@playwright/test'
import { serveRendererBuild } from '../fixtures/build-renderer-server.mjs'
import { prepareInstalledChatProfile, assertInstalledChatLoaded } from '../fixtures/installed-chat-ui.mjs'
import { createOnlineOperationFaultProxy } from '../fixtures/online-operation-fault-proxy.mjs'

// Explicit paid acceptance only. Real installed UI/provider, real upstream
// model, native tools and compiler; the proxy never manufactures model output.
// AILY_ONLINE_CONNECTION_PROFILE is an operator-owned JSON file containing
// {apiBase, authFile, configFile, model?, thinkingLevel?}. authFile contains only
// the test account's access_token; configFile selects that same API region.
// AILY_ONLINE_FAULT_MODE independently selects unclaimed-retry-ack (default)
// or live-disconnect (two real stream breaks separated by >=32s live output).
assert.equal(process.env.AILY_ONLINE_ACCEPTANCE, '1')
const repo = fileURLToPath(new URL('../../', import.meta.url))
const appDataSource = 'C:/Users/LENOVO/AppData/Local/aily-project'
const testRoot = path.join(appDataSource, 'dev-tests/abs-serial-analysis-20261028')
const suite = await fs.mkdtemp(path.join(testRoot, 'online-installed-'))
const outputRoot = process.env.AILY_ONLINE_OUTPUT_ROOT ?? path.join(repo, 'e2e/test-results/online-installed-20261101')
const outputRelative = path.relative(path.join(repo, 'e2e/test-results'), outputRoot)
assert.ok(path.isAbsolute(outputRoot) && outputRelative && !path.isAbsolute(outputRelative)
  && outputRelative !== '..' && !outputRelative.startsWith('..' + path.sep), 'Use an isolated E2E output directory')
const output = path.join(outputRoot, path.basename(suite))
const reuseProject = process.env.AILY_ONLINE_PROJECT
const project = path.resolve(reuseProject || path.join(suite, 'project')), appData = path.join(suite, 'appdata')
const scenario = process.env.AILY_ONLINE_SCENARIO ?? 'new-counter'
assert.ok(['new-counter', 'counter-boundary'].includes(scenario))
const home = path.join(suite, 'home'), agentProfile = path.join(suite, 'agent-profile')
const agentTemp = path.join(suite, 'agent-temp')
const seed = path.join(testRoot, 'archive-user-project/esp32-c3-HANTAI')
const hostBuild = process.env.AILY_ONLINE_HOST_BUILD ?? path.join(repo, 'tests/test-results/view-conflict-resolution-20261029/host-final/browser')
const daily = path.join(appDataSource, 'npm-global/app')
const activeFile = path.join(daily, 'store/subapp-aily-chat/active.json')
const dailyCatalogFile = path.join(daily, 'subapp-index.json')
const dailyConfigFile = path.join(appDataSource, 'config.json'), dailyAuthFile = path.join(appDataSource, '.aily')
const connectionFile = process.env.AILY_ONLINE_CONNECTION_PROFILE
assert.ok(connectionFile && path.isAbsolute(connectionFile), 'An explicit isolated API/token connection profile is required; never fall back to daily credentials')
const connection = JSON.parse(await fs.readFile(connectionFile, 'utf8'))
assert.ok(connection && typeof connection === 'object' && !Array.isArray(connection)
  && typeof connection.apiBase === 'string' && path.isAbsolute(connection.authFile ?? '')
  && path.isAbsolute(connection.configFile ?? ''), 'Explicit profile requires apiBase, authFile and configFile')
const configFile = connection.configFile, authFile = connection.authFile
assert.notEqual(path.resolve(authFile).toLowerCase(), path.resolve(dailyAuthFile).toLowerCase(), 'Never use the daily account credential file for isolated online acceptance')
const mode = process.env.AILY_ONLINE_FAULT_MODE ?? 'unclaimed-retry-ack'
assert.ok(['unclaimed-retry-ack', 'live-disconnect'].includes(mode))
const lexRoot = process.env.AILY_ONLINE_LEX_ROOT ?? path.resolve(repo, '../aily-lex-pro')
const sha = value => createHash('sha256').update(value).digest('hex')
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
const textOf = value => (value?.content ?? []).filter(item => item.type === 'text').map(item => item.text).join('\n')
const inside = (root, value) => { const relative = path.relative(root, value)
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep) }
const evidence = { ok: false, onlineLlm: false, localSyntheticModel: false, hardwareUsed: false,
  simulatorUsed: false, userProjectsModified: false, backendDeployed: false, mode, scenario, suite, project, tools: [] }
let app, renderer, proxy, page, loaded, hostPid, sessionId, baseline, baselineDocument, snapshot, installedRoot, installedEvidence, verifyPortableBuild
let sourceHash
const protectedFiles = new Map()
const phase = value => { evidence.phase = value; console.log(new Date().toISOString(), 'PHASE=' + value) }
async function treeHash(root) {
  const entries = []
  async function visit(directory) {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name), name = path.relative(root, file)
      assert.equal(entry.isSymbolicLink(), false, 'Never copy or follow a source project junction')
      if (entry.isDirectory()) await visit(file)
      else { assert.ok(entry.isFile()); entries.push([name, sha(await fs.readFile(file))]) }
    }
  }
  await visit(root)
  return { files: entries.length, sha256: sha(JSON.stringify(entries)) }
}
function blocks(state) {
  const result = new Map()
  const visit = value => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) return value.forEach(visit)
    if (typeof value.type === 'string' && typeof value.id === 'string') {
      const { inputs, next, x, y, ...rest } = value
      assert.ok(!result.has(value.id)); result.set(value.id, rest)
    }
    for (const [key, child] of Object.entries(value)) if (!['fields', 'extraState', 'variables'].includes(key)) visit(child)
  }
  visit(state); return result
}
try {
  await fs.mkdir(output, { recursive: true })
  if (reuseProject) {
    assert.ok(path.isAbsolute(reuseProject) && inside(testRoot, project)
      && /[\\/]online-installed-[^\\/]+[\\/]project$/.test(project), 'Only a previous owned online test project may be reused')
    assert.ok(same(project, await fs.realpath(project)), 'Never reuse a project junction')
    const previous = JSON.parse(await fs.readFile(path.join(outputRoot, path.basename(path.dirname(project)), 'result.json'), 'utf8'))
    assert.ok(same(previous.project, project) && previous.userProjectsModified === false)
  } else await fs.mkdir(project)
  for (const directory of [home, agentProfile, agentTemp]) await fs.mkdir(directory)
  for (const file of new Set([configFile, authFile, dailyConfigFile, dailyAuthFile, activeFile,
    dailyCatalogFile, ...(connectionFile ? [connectionFile] : [])])) {
    const original = await fs.readFile(file).catch(error => {
      // The user's daily login is unrelated to this test and may legitimately
      // be absent. Preserve that absence, never manufacture a credential file.
      if (file === dailyAuthFile && error.code === 'ENOENT') return null
      throw error
    })
    protectedFiles.set(file, original)
  }
  const config = JSON.parse(protectedFiles.get(configFile)), auth = JSON.parse(protectedFiles.get(authFile))
  const active = JSON.parse(protectedFiles.get(activeFile)), configuredApi = config.regions?.[config.region]?.api_server
  const apiBase = connection?.apiBase ?? configuredApi
  const apiUrl = new URL(apiBase)
  assert.ok(['http:', 'https:'].includes(apiUrl.protocol) && apiUrl.pathname === '/' && !apiUrl.search
    && !apiUrl.hash && !apiUrl.username && !apiUrl.password, 'API base must be a credential-free HTTP(S) origin')
  assert.equal(apiUrl.origin, new URL(configuredApi).origin,
    'Private credentials must use their explicitly selected config region, never silently reuse daily credentials on another server')
  assert.ok(typeof auth.access_token === 'string' && auth.access_token.length > 0)
  installedRoot = await fs.realpath(path.join(daily, 'store/subapp-aily-chat', active.selected.path))
  ;({ verifyPortableBuild } = await import(pathToFileURL(path.join(lexRoot, 'packages/aily-chat/server/portable-integrity.ts'))))
  installedEvidence = await verifyPortableBuild(installedRoot)
  const { captureBuildInputs } = await import(pathToFileURL(path.join(lexRoot, 'packages/aily-chat/scripts/portable-build-inputs.mjs')))
  assert.equal(installedEvidence.inputHash, sha(JSON.stringify(await captureBuildInputs(lexRoot))),
    'Installed Chat must contain the current recovery code before a paid online test')
  evidence.installed = { version: active.selected.version, inputHash: installedEvidence.inputHash, outputHash: installedEvidence.outputHash }
  evidence.upstream = { apiBase: apiUrl.origin, configuredRegion: config.region, explicitConnectionProfile: !!connection }
  phase('real-api-preflight')
  const check = await fetch(apiUrl.origin + '/api/v1/auth/me', { headers: { authorization: 'Bearer ' + auth.access_token }, signal: AbortSignal.timeout(15000) })
  evidence.authStatus = check.status; await check.body?.cancel()
  assert.equal(check.status, 200, 'Configured real API must authenticate; never switch credential regions')
  sourceHash = await treeHash(seed)
  if (!reuseProject) {
    for (const name of ['package.json', 'package-lock.json', 'project.abi', 'node_modules'])
      await fs.cp(path.join(seed, name), path.join(project, name), { recursive: true, force: false, errorOnExist: true })
    const manifest = JSON.parse(await fs.readFile(path.join(project, 'package.json'), 'utf8'))
    for (const spec of Object.values(manifest.dependencies ?? {})) if (typeof spec === 'string' && spec.startsWith('file:')) {
      const relative = spec.slice(5), source = path.resolve(seed, relative), destination = path.resolve(project, relative)
      assert.ok(inside(seed, source) && inside(project, destination))
      await fs.cp(source, destination, { recursive: true, force: false, errorOnExist: true })
    }
  }
  proxy = await createOnlineOperationFaultProxy({ upstreamOrigin: apiUrl.origin, mode,
    armNow: mode === 'live-disconnect', armAfterToolNames: ['edit', 'write'] })
  const profile = await prepareInstalledChatProfile({ appData, installedRoot, apiBase: proxy.origin,
    baseConfigPath: configFile, token: auth.access_token })
  // Keep sensitive credentials inaccessible to model-visible tools. Mutating
  // shell/device/other-project tools are denied before execution, not by a
  // post-hoc snapshot assertion. Only this fresh ABS file is writable.
  const permission = { '*': 'deny', tool_load: 'allow', tool_invoke: 'allow', skill: 'allow',
    read: 'allow', ls: 'allow', find: 'allow', grep: 'allow',
    write: { '*': 'deny', [path.join(project, 'project.abs')]: 'allow' },
    edit: { '*': 'deny', [path.join(project, 'project.abs')]: 'allow' },
    external_directory: { '*': 'deny', [suite + '/*']: 'allow', [project + '/*']: 'allow', [installedRoot + '/*']: 'allow' },
    path: { '*': 'allow', [path.join(appData, '.aily')]: 'deny', [authFile]: 'deny',
      [dailyAuthFile]: 'deny', ...(connectionFile ? { [connectionFile]: 'deny' } : {}) } }
  for (const name of ['abs_export', 'abs_validate', 'abs_apply', 'project_build', 'library_docs', 'block_info', 'block_list',
    'board_info', 'get_board_config', 'project_status', 'app_info', 'app_status', 'app_reload', 'todo']) permission[name] = 'allow'
  const policy = path.join(agentProfile, 'extensions/pi-permission-system/config.json')
  await fs.mkdir(path.dirname(policy), { recursive: true })
  await fs.writeFile(policy, JSON.stringify({ permission }), { flag: 'wx' })
  renderer = await serveRendererBuild(hostBuild)
  const { ELECTRON_RUN_AS_NODE, AILY_CHILD_PATH, NODE_PATH, AILY_PORTABLE_ROOT, ...parentEnv } = process.env
  phase('host-start')
  app = await _electron.launch({ args: ['.', '--serve', `--user-data-dir=${path.join(suite, 'electron-profile')}`], cwd: repo,
    timeout: 60000, env: { ...parentEnv, ...profile.env, AILY_E2E: '1', AILY_DEV_RENDERER_URL: renderer.origin,
      HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentProfile, TEMP: agentTemp, TMP: agentTemp,
      npm_config_offline: 'true', npm_config_audit: 'false' } })
  hostPid = await app.evaluate(() => process.pid); evidence.hostPid = hostPid
  // Scope renderer requests too. This never changes system networking or
  // another application's connections. Model operations run in the installed
  // Chat backend through its normal configured API origin.
  await app.context().route('**/*', async route => {
    const request = route.request(), url = new URL(request.url())
    if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !['http:', 'https:'].includes(url.protocol)) return route.continue()
    if (url.origin !== new URL(apiBase).origin || !url.pathname.startsWith('/api/')) return route.abort('blockedbyclient')
    const headers = { ...request.headers() }; delete headers.host; delete headers['content-length']; delete headers.connection
    try {
      const result = await fetch(proxy.origin + url.pathname + url.search, { method: request.method, headers,
        ...(['GET', 'HEAD'].includes(request.method()) ? {} : { body: request.postDataBuffer() }), signal: AbortSignal.timeout(15000) })
      await route.fulfill({ status: result.status, headers: Object.fromEntries(result.headers), body: Buffer.from(await result.arrayBuffer()) })
    } catch { await route.abort('connectionfailed') }
  })
  await app.firstWindow()
  const startDeadline = Date.now() + 60000
  while (!page && Date.now() < startDeadline) {
    page = app.windows().find(item => item.url().startsWith(renderer.origin))
    if (!page) await new Promise(resolve => setTimeout(resolve, 200))
  }
  assert.ok(page); page.on('dialog', dialog => dialog.dismiss())
  evidence.browserSockets = []
  page.on('websocket', socket => {
    const url = new URL(socket.url())
    const entry = { origin: url.origin, path: url.pathname, sent: 0, received: 0 }
    evidence.browserSockets.push(entry)
    socket.on('framesent', () => { entry.sent++ })
    socket.on('framereceived', () => { entry.received++ })
    socket.on('socketerror', error => { entry.error = String(error).replace(/\?[^\s]+/g, '?<redacted>') })
    socket.on('close', () => { entry.closed = true })
  })
  await page.goto(renderer.origin, { waitUntil: 'domcontentloaded' })
  await page.locator('app-main-window').waitFor({ timeout: 60000 })
  await page.evaluate(target => { location.hash = '#/main/blockly-editor?path=' + encodeURIComponent(target) }, project)
  await page.waitForFunction(target => {
    const element = document.querySelector('blockly-main'), service = element && window.ng?.getComponent(element)?.projectService
    return service?.currentProjectPath?.replaceAll('\\', '/') === target.replaceAll('\\', '/') && service.getBlocklyProjectLoadStatus(target)?.ready
  }, project, { timeout: 60000 })
  await page.waitForFunction(() => window.ng?.getComponent(document.querySelector('app-blockly-editor'))?._builderService?.isInstallInProgress() === false,
    undefined, { timeout: 60000 })
  baseline = await page.evaluate(() => JSON.parse(JSON.stringify(window.Blockly.serialization.workspaces.save(window.Blockly.getMainWorkspace()))))
  baselineDocument = JSON.parse(await fs.readFile(path.join(project, 'project.abi'), 'utf8'))
  phase('installed-chat-ui')
  loaded = await assertInstalledChatLoaded(page, { installedRoot, expectedApiBase: proxy.origin,
    expectedInputHash: installedEvidence.inputHash, expectedOutputHash: installedEvidence.outputHash })
  evidence.chat = { ...loaded.evidence, syntheticIdentity: false, realModelInvoked: false }
  delete evidence.chat.buildEvidence // Full sealed source lists are not a test report.
  await page.screenshot({ path: path.join(output, 'installed-chat.png'), fullPage: true })
  // Use the real composer's own existing transport and product-default model,
  // not a second control connection that can obscure the actual UI behavior.
  evidence.controlTransport = { protocol: 'embedded-composer' }
  phase('real-llm-prompt')
  const marker = 'ONLINE_RECOVERY_' + randomUUID().slice(0, 8)
  evidence.marker = marker; evidence.startedAt = Date.now()
  const requirement = scenario === 'counter-boundary'
    ? `当前隔离工程已存在counterMark和counterValue计数逻辑。只修正首次计时边界：在setup最后追加counterMark=millis()，保证setup完成后再满1000ms才首次输出0；不能仅依赖全局counterMark初值0。setup中同时追加一条新的串口打印，输出本轮标记 ${marker}；上一轮的标记字符串及原打印块都必须保持不动，不得替换。保留已有计数、风扇及串口代码，不新增重复计数逻辑、不重配串口。`
    : `用现有库增量增加：setup输出一次串口标记 ${marker}；再增加一个用millis差值而非delay的非阻塞1秒计数输出，计数0..9循环。必须在setup最后保存millis计时基准，保证setup完成后再满1000ms才首次输出0，不能只靠全局时间变量初值0。保持原有风扇/串口处理不变、不重配现有串口。`
  await loaded.frame.locator('.aily-chat-composer-input[role="textbox"]').fill(`这是已授权的隔离验收工程 ${project}，不是用户原工程。${requirement} 必须保留原有块ID、变量/对象模型与禁用/折叠/不可删除属性。专门验收文件编辑通道：先read磁盘 ${path.join(project, 'project.abs')} 及必要库文档，必须使用原生edit或write工具把修改实际写入该文件；然后abs_validate与abs_apply读取磁盘候选，不要给它们传inline abs字符串，不要用它们替代文件编辑。最后实际project_build编译并检查本次成功回执。分别说明代码/编译可证明与仍需硬件验证的边界。不要删除原块或重建工程，不创建或安装库，不用bash/powershell/脚本替代ABS编辑，不烧录、不操作串口或仿真、不访问其他工程。若服务短暂断线，沿用原会话状态和已完成工具回执，不重复写入或应用。`)
  await loaded.frame.locator('button.primary-action.send-action').click()
  const observed = new Set(), deadline = Date.now() + 12 * 60 * 1000
  while (Date.now() < deadline) {
    const dialogs = loaded.frame.locator('.pi-extension-dialog')
    for (const dialog of await dialogs.all()) if (await dialog.isVisible()) {
      const title = await dialog.getAttribute('aria-label'), lines = String(title).split(/\r?\n/)
      assert.equal(lines[0], 'Trust project folder?'); assert.ok(same(lines[1], project))
      await dialog.getByRole('button', { name: 'Trust (this session only)', exact: true }).click()
    }
    const sessions = await loaded.e2e('session.list')
    const candidates = sessions.sessions.filter(item => same(item.cwd, project))
    assert.ok(candidates.length <= 1)
    sessionId ??= candidates[0]?.sessionId
    if (sessionId) {
      snapshot = (await loaded.e2e('session.read', { sessionId })).session
      evidence.model ??= snapshot.model
      assert.equal(snapshot.permissionMode, 'default')
      const ids = new Set()
      for (const message of snapshot.messages.filter(item => item.role === 'toolResult')) {
        assert.ok(!ids.has(message.toolCallId), 'No duplicated committed tool results'); ids.add(message.toolCallId)
        if (!observed.has(message.toolCallId)) {
          observed.add(message.toolCallId)
          evidence.tools.push({ name: message.toolName, id: message.toolCallId, isError: message.isError === true, at: Date.now() })
          console.log(new Date().toISOString(), 'ONLINE_TOOL', message.toolName, message.isError === true ? 'ERROR' : 'OK')
          await fs.appendFile(path.join(output, 'tool-results.jsonl'), JSON.stringify(message) + '\n')
        }
      }
      const final = snapshot.messages.filter(item => item.role === 'assistant').at(-1)
      if (snapshot.isIdle && !snapshot.isStreaming && ['stop', 'error', 'aborted'].includes(final?.stopReason)) {
        evidence.final = { stopReason: final.stopReason, text: textOf(final), errorMessage: final.errorMessage }; break
      }
    }
    await new Promise(resolve => setTimeout(resolve, 750))
  }
  assert.equal(evidence.final?.stopReason, 'stop', 'Actual online turn must settle normally')
  assert.equal(snapshot.messages.filter(item => item.role === 'user').length, 1)
  for (const name of ['abs_validate', 'abs_apply', 'project_build']) assert.ok(evidence.tools.some(tool => tool.name === name && !tool.isError), name)
  evidence.fileEditObserved = evidence.tools.some(tool => ['edit', 'write'].includes(tool.name) && !tool.isError)
  const compile = JSON.parse(await fs.readFile(path.join(project, '.log/compile/latest-result.json'), 'utf8'))
  assert.equal(compile.success, true); assert.ok(compile.finishedAt >= evidence.startedAt)
  evidence.compiled = true; evidence.build = { requestId: compile.requestId, finishedAt: compile.finishedAt }
  const code = await fs.readFile(path.join(project, '.temp/sketch/sketch.ino'), 'utf8'); assert.ok(code.includes(marker))
  const after = await page.evaluate(() => JSON.parse(JSON.stringify(window.Blockly.serialization.workspaces.save(window.Blockly.getMainWorkspace()))))
  const beforeBlocks = blocks(baseline), afterBlocks = blocks(after)
  for (const [id, value] of beforeBlocks) assert.deepEqual(afterBlocks.get(id), value, 'Keep every original block attribute')
  for (const variable of baseline.variables ?? []) assert.deepEqual(after.variables.find(item => item.id === variable.id), variable)
  const afterDocument = JSON.parse(await fs.readFile(path.join(project, 'project.abi'), 'utf8'))
  assert.equal(afterDocument.activePageId, baselineDocument.activePageId)
  assert.deepEqual(afterDocument.openedPageIds, baselineDocument.openedPageIds)
  assert.deepEqual(afterDocument.pages.map(({ id, title }) => ({ id, title })), baselineDocument.pages.map(({ id, title }) => ({ id, title })))
  const documentBlocks = document => blocks([document.pages.map(item => item.content), document.sharedModel.procedureBlocks])
  const oldDocumentBlocks = documentBlocks(baselineDocument), newDocumentBlocks = documentBlocks(afterDocument)
  for (const [id, value] of oldDocumentBlocks) assert.deepEqual(newDocumentBlocks.get(id), value, 'Keep original blocks on every page and shared procedure')
  for (const variable of baselineDocument.sharedModel.variables)
    assert.deepEqual(afterDocument.sharedModel.variables.find(item => item.id === variable.id), variable)
  evidence.preserved = { originalBlocks: beforeBlocks.size, finalBlocks: afterBlocks.size,
    originalModels: baseline.variables?.length, allPageAndProcedureBlocks: oldDocumentBlocks.size,
    originalPages: baselineDocument.pages.length }
  evidence.transport = proxy.snapshot()
  assert.ok(evidence.fileEditObserved, 'The file-edit acceptance requires actual native edit/write, not inline ABS submission')
  assert.equal(evidence.transport.duplicatePosts, 0); assert.equal(evidence.transport.interruptCount, 0)
  assert.deepEqual(evidence.transport.failures, [])
  if (mode === 'unclaimed-retry-ack') {
    assert.equal(evidence.transport.unclaimedRecoveryCovered, true, 'Both original-unreceived and accepted-retry-ACK faults must actually occur')
    const operation = evidence.transport.operations.find(item => item.operationId === evidence.transport.selectedOperation)
    assert.equal(operation.posts, 2); assert.equal(operation.forwardedPosts, 1)
    assert.ok(operation.stateReads >= 2 && operation.eventReads >= 1, 'Actual service state and events must resume the same accepted operation')
    for (const idHash of evidence.transport.unclaimed.toolCallIdsSha256) {
      assert.equal(evidence.tools.filter(tool => sha(tool.id) === idHash).length, 1, 'Original completed tool results must not execute twice')
      const calls = snapshot.messages.filter(message => message.role === 'assistant')
        .flatMap(message => message.content ?? []).filter(item => item.type === 'toolCall' && sha(item.id) === idHash)
      assert.equal(calls.length, 1, 'Recovery must not replay the previous model step tool call')
    }
  } else {
    assert.equal(evidence.transport.secondDisconnectCovered, true,
      'Upstream did not produce enough real live progress for the requested 32-second second-disconnect coverage; do not report this as passed')
  }
  evidence.longThinkingAndSecondDisconnectCovered = evidence.transport.secondDisconnectCovered
  evidence.unclaimedRecoveryCovered = evidence.transport.unclaimedRecoveryCovered
  evidence.completedAt = Date.now(); evidence.ok = true
  phase('complete')
} catch (error) {
  evidence.failure = { name: error.name, message: error.message, causeCode: error.cause?.code,
    stack: String(error.stack).split('\n').slice(0, 6).join('\n') }
  console.error('ACCEPTANCE_FAILED', error.message); process.exitCode = 1
} finally {
  const finish = async (label, action) => {
    try { await action() } catch (error) {
      evidence.cleanupFailures ??= []
      evidence.cleanupFailures.push({ label, message: error.message })
      evidence.ok = false; process.exitCode = 1
    }
  }
  evidence.transport = proxy?.snapshot()
  evidence.onlineLlm = evidence.transport?.operations.some(operation => operation.semanticEvents > 0 || operation.toolCalls.length > 0) ?? false
  if (evidence.chat) evidence.chat.realModelInvoked = evidence.onlineLlm
  if (snapshot) await finish('session-evidence', () => fs.writeFile(path.join(output, 'online-session.json'), JSON.stringify(snapshot, null, 2)))
  if (page) await page.screenshot({ path: path.join(output, 'final.png'), fullPage: true }).catch(() => {})
  if (loaded && snapshot && !snapshot.isIdle) await finish('abort-owned-session', async () => {
    const stop = loaded.frame.locator('button.primary-action.stop-action')
    if (await stop.isVisible()) {
      await stop.click({ timeout: 3000 })
      evidence.cleanupAbortRequested = true
    }
  })
  if (app) await finish('close-owned-host', () => app.evaluate(({ app }, owned) => {
    if (process.pid !== owned.pid || process.env.AILY_APPDATA_PATH !== owned.appData) throw new Error('Refuse unrelated host shutdown')
    app.exit(0)
  }, { pid: hostPid, appData }))
  await finish('close-owned-renderer', () => renderer?.close())
  await finish('close-owned-proxy', () => proxy?.close())
  await finish('remove-private-access-token', () => fs.unlink(path.join(appData, '.aily')).catch(error => { if (error.code !== 'ENOENT') throw error }))
  await finish('preserve-source-and-config', async () => {
    if (sourceHash) assert.deepEqual(await treeHash(seed), sourceHash)
    for (const [file, original] of protectedFiles) {
      if (original === null) await assert.rejects(fs.readFile(file), { code: 'ENOENT' })
      else assert.equal(sha(await fs.readFile(file)), sha(original), 'Protected input changed: ' + path.basename(file))
    }
    if (installedEvidence) {
      const current = await verifyPortableBuild(installedRoot)
      assert.equal(current.inputHash, installedEvidence.inputHash); assert.equal(current.outputHash, installedEvidence.outputHash)
    }
    evidence.sourceAndDailyConfigurationUnchanged = true
  })
  await fs.mkdir(output, { recursive: true }); await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify({ ok: evidence.ok, phase: evidence.phase, failure: evidence.failure?.message, output, suite,
    compiled: evidence.compiled, longThinkingAndSecondDisconnectCovered: evidence.longThinkingAndSecondDisconnectCovered }))
}
