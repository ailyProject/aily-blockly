import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { _electron } from '@playwright/test'
import { serveRendererBuild } from '../fixtures/build-renderer-server.mjs'
import { prepareInstalledChatProfile, assertInstalledChatLoaded } from '../fixtures/installed-chat-ui.mjs'
import { createOnlineOperationFaultProxy } from '../fixtures/online-operation-fault-proxy.mjs'
import { createReadLineCoverage, grepCoversSourceLines } from '../fixtures/read-line-coverage.mjs'
import { onlineSaveServiceToolEvidence, prepareOnlineProjectSaveReceipt } from '../fixtures/online-project-save-receipt.mjs'
import { prepareExternalLinkedLibrary, prepareLinkedDependencyConflict, verifyExternalLinkedLibrary } from '../fixtures/external-linked-library.mjs'
import { assertCumulativeGeneratedBehavior } from '../fixtures/abs-cumulative-behavior.mjs'
import { assertCumulativeNativeEditChain } from '../fixtures/abs-cumulative-edit-chain.mjs'
import repairEnvironment from '../../electron/project-repair-environment.js'
import { assertSelectedOnlineModel, explicitOnlineModelId, observeOnlineModelCatalog, resolveOnlineModelPreset, selectOnlineModelFromUi } from '../fixtures/online-model-selection.mjs'

// Explicit paid acceptance only. Real installed UI/provider, real upstream
// model, native tools and compiler; the proxy never manufactures model output.
// AILY_ONLINE_CONNECTION_PROFILE is an operator-owned JSON file containing
// {apiBase, authFile, configFile, model?, thinkingLevel?}. authFile contains only
// the test account's access_token; configFile selects that same API region.
// AILY_ONLINE_FAULT_MODE independently selects unclaimed-retry-ack (default)
// or live-disconnect (two real breaks with >32s of fresh resumed thinking).
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
assert.ok(['new-counter', 'counter-boundary', 'review-only', 'save-receipt', 'linked-library', 'dependency-conflict', 'cumulative-edits'].includes(scenario))
const readOnly = scenario === 'review-only'
const saveReceipt = scenario === 'save-receipt'
const cumulativeEdits = scenario === 'cumulative-edits'
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
const mode = process.env.AILY_ONLINE_FAULT_MODE ?? (saveReceipt ? 'live-disconnect' : 'unclaimed-retry-ack')
assert.ok(['unclaimed-retry-ack', 'live-disconnect'].includes(mode))
assert.ok(!saveReceipt || mode === 'live-disconnect', 'Save receipt acceptance observes a passive proxy, not SSE retry faults')
const lexRoot = process.env.AILY_ONLINE_LEX_ROOT ?? path.resolve(repo, '../aily-lex-pro')
const sha = value => createHash('sha256').update(value).digest('hex')
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
const textOf = value => (value?.content ?? []).filter(item => item.type === 'text').map(item => item.text).join('\n')
const inside = (root, value) => { const relative = path.relative(root, value)
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep) }
const evidence = { ok: false, onlineLlm: false, localSyntheticModel: false, hardwareUsed: false,
  simulatorUsed: false, userProjectsModified: false, backendDeployed: false, mode, scenario, suite, project, tools: [] }
let app, renderer, proxy, page, loaded, hostPid, sessionId, baseline, baselineDocument, snapshot, installedRoot, installedEvidence, verifyPortableBuild
let sourceHash, baselineAbiBytes, baselineSketchBytes, baselineAbsProgram, absCoverage
let saveReceiptCase, ownedHostClosed = false
let selectedModelPreset
let modelCatalogObserver
let linkedLibrary
const programOf = value => String(value).split('\n# @project-state:')[0]
const requiredReads = new Set(readOnly ? ['project.abs', 'abs-syntax.md', 'sketch.ino'] : ['abs-syntax.md'])
const completedReads = new Set()
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
  if (['linked-library', 'dependency-conflict'].includes(scenario)) {
    linkedLibrary = await prepareExternalLinkedLibrary(suite, project)
    evidence.linkedLibrary = linkedLibrary
  }
  proxy = await createOnlineOperationFaultProxy({ upstreamOrigin: apiUrl.origin, mode,
    armNow: false, armAfterToolNames: saveReceipt ? ['__save_receipt_has_no_sse_fault__'] : ['edit', 'write'],
    requireResumedThinkingSpan: !saveReceipt && mode === 'live-disconnect',
    firstDisconnectAfterThinkingMs: !saveReceipt && mode === 'live-disconnect' ? 5000 : 0 })
  const profile = await prepareInstalledChatProfile({ appData, installedRoot, apiBase: proxy.origin,
    baseConfigPath: configFile, token: auth.access_token })
  evidence.platformManifests = repairEnvironment.seedPlatformManifests(appData, project, appDataSource)
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
  if (scenario === 'dependency-conflict') for (const name of ['project_save', 'project_recover']) permission[name] = 'allow'
  if (readOnly) for (const name of ['write', 'edit', 'abs_export', 'abs_validate', 'abs_apply', 'project_build', 'app_reload'])
    permission[name] = 'deny'
  if (saveReceipt) {
    for (const name of ['write', 'edit', 'abs_export', 'abs_validate', 'abs_apply', 'project_build', 'blocks_tidy', 'project_upload', 'app_reload'])
      permission[name] = 'deny'
    permission.project_save = 'allow'
  }
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
  if (explicitOnlineModelId(connection.model)) modelCatalogObserver = observeOnlineModelCatalog(page, project)
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
  if (cumulativeEdits) {
    evidence.cumulativeBaseline = assertCumulativeGeneratedBehavior(
      await fs.readFile(path.join(project, '.temp/sketch/sketch.ino'), 'utf8'), {
        absent: [{ id: 'first-increment', pin: '12', value: 'HIGH' }, { id: 'second-increment', pin: '13', value: 'LOW' }]
      })
  }
  if (scenario === 'dependency-conflict') {
    phase('prepare-real-dependency-conflict')
    evidence.dependencyConflict = await prepareLinkedDependencyConflict(page, suite, project, linkedLibrary)
  }
  await page.screenshot({ path: path.join(output, 'installed-chat.png'), fullPage: true })
  if (readOnly) {
    baselineAbiBytes = await fs.readFile(path.join(project, 'project.abi'))
    baselineSketchBytes = await fs.readFile(path.join(project, '.temp/sketch/sketch.ino'))
    baselineAbsProgram = programOf(await fs.readFile(path.join(project, 'project.abs'), 'utf8'))
    absCoverage = createReadLineCoverage(baselineAbsProgram.split('\n').length)
  }
  if (saveReceipt) {
    phase('manual-save-receipt')
    saveReceiptCase = await prepareOnlineProjectSaveReceipt({ page, app, project })
    evidence.saveReceipts = { manual: saveReceiptCase.manual }
    baseline = await page.evaluate(() => JSON.parse(JSON.stringify(window.Blockly.serialization.workspaces.save(window.Blockly.getMainWorkspace()))))
    baselineDocument = saveReceiptCase.baselineDocument
    baselineAbiBytes = await fs.readFile(path.join(project, 'project.abi'))
    baselineSketchBytes = await fs.readFile(path.join(project, '.temp/sketch/sketch.ino'))
    baselineAbsProgram = programOf(await fs.readFile(path.join(project, 'project.abs'), 'utf8'))
    evidence.scope = { manualSave: true, agentSave: true, normalExitSave: true, sseDisconnect: false,
      longThinkingAndSecondDisconnect: false, compilation: false, fileEdit: false }
  }
  // Use the real composer's own transport and default model unless an explicit
  // catalog preset is selected through its normal UI; never a second control.
  evidence.controlTransport = { protocol: 'embedded-composer' }
  if (explicitOnlineModelId(connection.model)) {
    phase('select-explicit-online-model')
    const response = await fetch(proxy.origin + '/api/v2/model_catalog', {
      headers: { authorization: 'Bearer ' + auth.access_token }, signal: AbortSignal.timeout(15000) })
    assert.equal(response.status, 200, 'Explicit model selection requires the real authenticated model catalog')
    selectedModelPreset = resolveOnlineModelPreset(await response.json(), connection.model)
    phase('wait-online-model-catalog')
    evidence.modelCatalogReadiness = await modelCatalogObserver.waitUntilReady(selectedModelPreset, { deadline: startDeadline })
    phase('select-explicit-online-model')
    evidence.selectedModel = await selectOnlineModelFromUi(loaded.frame, selectedModelPreset)
  }
  phase('real-llm-prompt')
  const marker = 'ONLINE_RECOVERY_' + randomUUID().slice(0, 8)
  if (!readOnly && !saveReceipt) evidence.marker = marker
  evidence.startedAt = Date.now()
  const requirement = saveReceipt
    ? `本轮只保存当前画布。请实际调用一次 project_save(project="${project}") 并根据该调用最终回执报告保存结果；不修改任何文件或图形块，不调用 abs_export/abs_validate/abs_apply、blocks_tidy、project_build、project_upload 或 app_reload，不编译、不烧录、不整理、不运行脚本。工作区代码已由本验收人工保存，无需再研究或重写程序；本轮仍需实际调用一次保存工具验证原请求回执。保存工具内部会自动观察原请求，慢保存或丢失回执时不要再次发出保存工具调用。`
    : readOnly
    ? `本轮只读审查，不改任何文件。请实际read当前project.abs的程序主体（不必读取很长的宿主元数据行）、ABS语法参考abs-syntax.md，以及本项目.temp/sketch/sketch.ino，三者读完后再作完整结论。依据真实代码而非仅复述注释，分析setup到loop的执行顺序、首次计数与32位millis回绕、长时间loop滞后时计数语义、原串口readStringUntil和delay对阻塞性的影响、禁用块是否进入生成代码、UART引脚的实际设置与注释差异。区分真实缺陷、保留旧逻辑的限制，以及静态代码和已有编译回执无法证明的硬件行为。给出有代码依据的评审结论，但不提出或执行本轮修补。必要时只读查询相关库文档，不创建文件、修改ABS或C++、编译、烧录、运行脚本或操作仿真/串口。`
    : scenario === 'dependency-conflict'
    ? `本工程已安装本地库 ${linkedLibrary.packageName}，但同一依赖有 GUI 待保存的 v0.0.2 和外部 npm 写入的 v0.0.3 冲突。本轮明确保留待保存的 v0.0.2 意图，保全双方原数据。请通过 project_recover 的依赖检查和受保护逐项选择工具自行解决，再通过正常 project_save 保存；不要直接改manifest/lock、丢弃变更或重新调用安装工具。完成后调用 project_status 核对，并用该库 linked_library_probe 块在 setup 最后输出 ${marker}，保留原逻辑。`
    : scenario === 'linked-library'
    ? `这个工程已通过手动 npm 安装外部本地库 ${linkedLibrary.packageName}。先实际调用一次 project_status 核对该库状态，再用该库的 linked_library_probe 块在 setup 最后输出一次 ${marker}。只增加这一条语句，保持原有逻辑不变。查询必要的该库文档；不要重新安装、迁移或改写外部库源码。`
    : cumulativeEdits
    ? `本轮验收连续增量修改，按顺序做三次独立原生edit（每次完成后再做下一次），不要用脚本或旧临时文件重建。第一步在setup末尾增加io_digitalwrite(math_number(12), io_state(HIGH))，为这一新块写ABS块注释 @comment:"${marker} phase-one"。第二步在其后再增加io_digitalwrite(math_number(13), io_state(LOW))，保留第一步新增块。第三步只将第一块的注释改成"${marker} comments-only"，不改变任何程序调用。保持原有所有逻辑。第三次edit后，用普通read读取该次回执的previousDraft只读引用，核对它保留第二步的两项新增行为；不要把旧副本回写。三次编辑都完成后只对最终完整候选做一次abs_validate、abs_apply与project_build；这是不烧录的源码累计行为验收，不是实际引脚功能测试。最终检查生成sketch中两条digitalWrite都仍存在。`
    : scenario === 'counter-boundary'
    ? `当前隔离工程已存在counterMark和counterValue计数逻辑。只修正首次计时边界：在setup最后追加counterMark=millis()，保证setup完成后再满1000ms才首次输出0；不能仅依赖全局counterMark初值0。setup中同时追加一条新的串口打印，输出本轮标记 ${marker}；上一轮的标记字符串及原打印块都必须保持不动，不得替换。保留已有计数、风扇及串口代码，不新增重复计数逻辑、不重配串口。`
    : `用现有库增量增加：setup输出一次串口标记 ${marker}；再增加一个用millis差值而非delay的非阻塞1秒计数输出，计数0..9循环。必须在setup最后保存millis计时基准，保证setup完成后再满1000ms才首次输出0，不能只靠全局时间变量初值0。保持原有风扇/串口处理不变、不重配现有串口。`
  const editProtocol = readOnly || saveReceipt ? '' : `必须保留原有块ID、变量/对象模型与禁用/折叠/不可删除属性。专门验收文件编辑通道：${scenario === 'dependency-conflict' ? '先完成上述依赖恢复和保存，再' : '先'}read磁盘 ${path.join(project, 'project.abs')} 及必要库文档，必须使用原生edit或write工具把修改实际写入该文件；然后abs_validate与abs_apply读取磁盘候选，不要给它们传inline abs字符串，不要用它们替代文件编辑。最后实际project_build编译并检查本次成功回执。`
  await loaded.frame.locator('.aily-chat-composer-input[role="textbox"]').fill(`这是已授权的隔离验收工程 ${project}，不是用户原工程。${requirement} ${editProtocol} 不访问其他工程或凭据。若服务短暂断线，沿用原会话状态和已完成工具回执，不重复任何已完成工具。`)
  await loaded.frame.locator('button.primary-action.send-action').click()
  const observed = new Set(), deadline = Date.now() + 12 * 60 * 1000
  let nextProgressAt = 0
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
          if (!saveReceipt && mode === 'live-disconnect' && ['read', 'grep'].includes(message.toolName) && message.isError !== true) {
            const call = snapshot.messages.filter(item => item.role === 'assistant').flatMap(item => item.content ?? [])
              .find(item => item.type === 'toolCall' && item.id === message.toolCallId)
            const name = typeof call?.arguments?.path === 'string' ? path.basename(call.arguments.path).toLowerCase() : ''
            if (readOnly && name === 'project.abs' && same(path.resolve(project, call.arguments.path), path.join(project, 'project.abs'))) {
              if (message.toolName === 'read') {
                absCoverage.observe(call.arguments, message.details?.truncation)
                if (absCoverage.complete) completedReads.add(name)
              } else if (grepCoversSourceLines(baselineAbsProgram, textOf(message))) completedReads.add(name)
            } else if (message.toolName === 'read' && requiredReads.has(name)) completedReads.add(name)
            if (!evidence.faultArm && [...requiredReads].every(value => completedReads.has(value))) {
              proxy.arm()
              evidence.faultArm = { afterSuccessfulReads: [...completedReads].sort(), at: Date.now() }
            }
          }
          console.log(new Date().toISOString(), 'ONLINE_TOOL', message.toolName, message.isError === true ? 'ERROR' : 'OK')
          await fs.appendFile(path.join(output, 'tool-results.jsonl'), JSON.stringify(message) + '\n')
        }
      }
      const final = snapshot.messages.filter(item => item.role === 'assistant').at(-1)
      if (snapshot.isIdle && !snapshot.isStreaming && ['stop', 'error', 'aborted'].includes(final?.stopReason)) {
        evidence.final = { stopReason: final.stopReason, text: textOf(final), errorMessage: final.errorMessage }; break
      }
    }
    if (Date.now() >= nextProgressAt) {
      nextProgressAt = Date.now() + 5000
      await fs.writeFile(path.join(output, 'progress.json'), JSON.stringify({ phase: evidence.phase, sessionId,
        tools: evidence.tools, faultArm: evidence.faultArm, transport: proxy.snapshot() }, null, 2))
    }
    await new Promise(resolve => setTimeout(resolve, 750))
  }
  assert.equal(evidence.final?.stopReason, 'stop', 'Actual online turn must settle normally')
  assertSelectedOnlineModel(snapshot, selectedModelPreset)
  assert.equal(snapshot.messages.filter(item => item.role === 'user').length, 1)
  evidence.fileEditObserved = evidence.tools.some(tool => ['edit', 'write'].includes(tool.name) && !tool.isError)
  if (saveReceipt) {
    evidence.saveReceipts.agent = await saveReceiptCase.verifyAgent(snapshot)
    assert.deepEqual(await fs.readFile(path.join(project, 'project.abi')), baselineAbiBytes)
    assert.deepEqual(await fs.readFile(path.join(project, '.temp/sketch/sketch.ino')), baselineSketchBytes)
    assert.equal(programOf(await fs.readFile(path.join(project, 'project.abs'), 'utf8')), baselineAbsProgram)
    evidence.programUnchangedDuringAgentSave = true
    evidence.compiled = false
  } else if (readOnly) {
    assert.equal(evidence.tools.some(tool => ['write', 'edit', 'abs_export', 'abs_apply', 'project_build', 'app_reload'].includes(tool.name) && !tool.isError), false)
    assert.deepEqual(await fs.readFile(path.join(project, 'project.abi')), baselineAbiBytes)
    assert.deepEqual(await fs.readFile(path.join(project, '.temp/sketch/sketch.ino')), baselineSketchBytes)
    assert.equal(programOf(await fs.readFile(path.join(project, 'project.abs'), 'utf8')), baselineAbsProgram)
    evidence.readOnlyProjectUnchanged = true
  } else {
    for (const name of ['abs_validate', 'abs_apply', 'project_build']) assert.ok(evidence.tools.some(tool => tool.name === name && !tool.isError), name)
    const compile = JSON.parse(await fs.readFile(path.join(project, '.log/compile/latest-result.json'), 'utf8'))
    assert.equal(compile.success, true); assert.ok(compile.finishedAt >= evidence.startedAt)
    evidence.compiled = true; evidence.build = { requestId: compile.requestId, finishedAt: compile.finishedAt }
    const code = await fs.readFile(path.join(project, '.temp/sketch/sketch.ino'), 'utf8')
    if (cumulativeEdits) {
      evidence.cumulativeBehavior = assertCumulativeGeneratedBehavior(code, {
        required: [{ id: 'first-increment', pin: '12', value: 'HIGH' }, { id: 'second-increment', pin: '13', value: 'LOW' }]
      })
      assert.equal(evidence.tools.filter(tool => tool.name === 'edit' && !tool.isError).length, 3,
        'Exercise two cumulative native edits followed by a comment-only edit')
      assert.equal(evidence.tools.some(tool => ['bash', 'powershell', 'write'].includes(tool.name)), false,
        'Do not replace this native incremental-edit acceptance with a script or full reconstruction')
      const candidate = await fs.readFile(path.join(project, 'project.abs'), 'utf8')
      evidence.cumulativeEditChain = await assertCumulativeNativeEditChain({ session: snapshot, agentProfile, marker, candidate })
    } else assert.ok(code.includes(marker))
    if (linkedLibrary) {
      assert.ok(String(await fs.readFile(path.join(project, 'project.abs'))).includes(linkedLibrary.blockType + '('),
        'Use the actual installed external block, not a replacement serial block')
      assert.equal(evidence.tools.some(tool => ['lib_add', 'lib_install_local', 'lib_remove', 'lib_reset'].includes(tool.name)), false)
      const statusMessage = snapshot.messages.find(message => message.role === 'toolResult' && message.toolName === 'project_status' && !message.isError)
      assert.ok(statusMessage, 'Exercise the actual installed status tool')
      const status = JSON.parse(textOf(statusMessage))
      assert.ok(status.libraries.visible.includes(linkedLibrary.packageName), 'The external local library must not be misdiagnosed as invisible')
      assert.equal(status.libraries.declaredButInvisible.some(item => item.packageName === linkedLibrary.packageName), false)
      if (scenario === 'dependency-conflict') {
        const calls = snapshot.messages.filter(message => message.role === 'assistant').flatMap(message => message.content ?? [])
          .filter(item => item.type === 'toolCall' && item.name === 'project_recover')
        const decisions = calls.filter(item => item.arguments?.action === 'resolve_dependencies')
        const decisionResults = decisions.map(call => {
          const message = snapshot.messages.find(item => item.role === 'toolResult' && item.toolCallId === call.id)
          assert.ok(message, 'Every decision call needs its own receipt')
          return { call, result: JSON.parse(textOf(message)) }
        })
        const executed = decisionResults.filter(item => item.result.commandDispatched !== false)
        assert.equal(executed.length, 1, 'Execute the actual decision once; a pre-dispatch parameter refusal is not a replay')
        assert.equal(executed[0].result.ok, true)
        const refused = decisionResults.filter(item => item.result.commandDispatched === false)
        assert.ok(refused.every(item => item.result.code === 'LIBRARY_DEPENDENCY_RECOVERY_INVALID'))
        assert.equal(new Set(decisions.map(item => JSON.stringify(item.arguments))).size, decisions.length,
          'Do not repeat unchanged invalid arguments')
        assert.equal(evidence.tools.filter(tool => tool.name === 'project_save').length, 1, 'Normal save must not be repeated')
        const archives = await fs.readdir(path.join(project, '.aily/dependency-recovery'))
        assert.equal(archives.filter(name => name.endsWith('.json')).length, 1, 'Repeated observations must not multiply backups')
        evidence.dependencyConflict.verified = true
        evidence.dependencyConflict.decisionExecutions = executed.length
        evidence.dependencyConflict.preDispatchRefusals = refused.length
      }
      await verifyExternalLinkedLibrary(linkedLibrary)
      evidence.linkedLibrary.verified = true
    }
  }
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
  if (!readOnly && !saveReceipt) assert.ok(evidence.fileEditObserved, 'The file-edit acceptance requires actual native edit/write, not inline ABS submission')
  assert.equal(evidence.transport.duplicatePosts, 0); assert.equal(evidence.transport.interruptCount, 0)
  assert.deepEqual(evidence.transport.failures, [])
  if (saveReceipt) {
    assert.equal(evidence.transport.armed, false)
    assert.deepEqual(evidence.transport.faults, [], 'This case drops a host save receipt, never a model SSE response')
    for (const operation of evidence.transport.operations) {
      assert.equal(operation.posts, 1); assert.equal(operation.forwardedPosts, 1)
    }
    evidence.saveReceipts.agent.serviceTool = onlineSaveServiceToolEvidence(evidence.transport, evidence.saveReceipts.agent)
  } else if (mode === 'unclaimed-retry-ack') {
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
    assert.equal(evidence.transport.requireResumedThinkingSpan, true)
    assert.equal(evidence.transport.strictThinkingCovered, true,
      'Real fresh thinking did not span more than 32 seconds after recovery; do not report this as passed')
    const second = evidence.transport.faults[1]
    assert.ok(second.resumedThinkingDurationMs > 32000 && second.resumedThinkingEvents >= 2)
    assert.ok(second.lastThinkingSequence > second.firstThinkingSequence && second.firstThinkingSequence > second.watermark)
    assert.equal(second.canonicalStatus, 'running'); assert.equal(second.canonicalStreamState, 'open')
    for (const operation of evidence.transport.operations) {
      assert.equal(operation.posts, 1); assert.equal(operation.forwardedPosts, 1)
    }
  }
  evidence.longThinkingAndSecondDisconnectCovered = evidence.transport.strictThinkingCovered === true
  const finalOperation = evidence.transport.operations.toSorted((a, b) => a.step - b.step).at(-1)
  assert.ok(finalOperation?.terminal && finalOperation.operationId.startsWith(evidence.transport.interactionId + ':'))
  const canonicalBase = `${proxy.origin}/api/v3/interactions/${evidence.transport.interactionId}/operations/${finalOperation.step}`
  const getCanonical = async suffix => {
    const response = await fetch(canonicalBase + suffix, { headers: { authorization: 'Bearer ' + auth.access_token }, signal: AbortSignal.timeout(15000) })
    assert.equal(response.status, 200, 'Canonical final output must be recoverable without a new execution')
    return response.json()
  }
  const result = await getCanonical('/result'), state = await getCanonical('/state')
  const finalText = snapshot.messages.filter(item => item.role === 'assistant').at(-1).content
    .filter(item => item.type === 'text').map(item => item.text).join('')
  assert.equal(result.operationId, finalOperation.operationId); assert.equal(result.status, 'completed')
  assert.equal(result.pendingKind, 'none'); assert.equal(result.format, 'wire_text_utf8_v1')
  assert.equal(result.text, finalText); assert.equal(result.hash, 'sha256:' + sha(finalText))
  assert.equal(result.bytes, Buffer.byteLength(finalText)); assert.equal(result.nextStepIndex, finalOperation.step + 1)
  assert.equal(state.operationId, result.operationId); assert.equal(state.executionTerminal?.outputState, 'available')
  assert.equal(state.executionTerminal.outputHash, result.hash); assert.equal(state.executionTerminal.outputBytes, result.bytes)
  assert.equal(state.executionTerminal.responseGeneration, result.responseGeneration)
  evidence.canonicalAnswer = { operationId: result.operationId, hash: result.hash, bytes: result.bytes,
    responseGeneration: result.responseGeneration, sdkMatchesOriginal: true }
  evidence.unclaimedRecoveryCovered = evidence.transport.unclaimedRecoveryCovered
  if (saveReceipt) {
    phase('normal-exit-save-receipt')
    evidence.saveReceipts.exit = await saveReceiptCase.finishExit()
    ownedHostClosed = true
    evidence.ownedHostClosed = true
    app = undefined
  }
  evidence.completedAt = Date.now(); evidence.ok = true
  phase('complete')
} catch (error) {
  if (error.catalogReadiness) evidence.modelCatalogReadiness = error.catalogReadiness
  evidence.failure = { name: error.name, message: error.message, causeCode: error.cause?.code,
    stack: String(error.stack).split('\n').slice(0, 6).join('\n') }
  console.error('ACCEPTANCE_FAILED', error.message); process.exitCode = 1
} finally {
  if (modelCatalogObserver) {
    evidence.modelCatalogReadiness ??= modelCatalogObserver.snapshot()
    modelCatalogObserver.close()
  }
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
  if (app && !ownedHostClosed) await finish('close-owned-host', () => app.evaluate(({ app }, owned) => {
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
