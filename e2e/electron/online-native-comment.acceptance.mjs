import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { _electron } from '@playwright/test'
import { serveRendererBuild } from '../fixtures/build-renderer-server.mjs'
import { prepareInstalledChatProfile, assertInstalledChatLoaded } from '../fixtures/installed-chat-ui.mjs'
import { createStartupFaultProxy } from '../fixtures/create-startup-fault-proxy.mjs'
import { observeOnlineModelCatalog, explicitOnlineModelId, resolveOnlineModelPreset,
  selectOnlineModelFromUi, assertSelectedOnlineModel } from '../fixtures/online-model-selection.mjs'
import { prepareOnlineNativeCommentCase, captureNativeCommentState, assertOnlineNativeReceipts,
  assertNativeCommentEditPreserved, nativeSessionTools } from '../fixtures/online-native-comment-case.mjs'

// Paid acceptance against the explicitly authorized test server only. The model
// chooses its real SDK tools; no tool executor, output or receipt is replaced.
assert.equal(process.env.AILY_ONLINE_ACCEPTANCE, '1')
const repo = fileURLToPath(new URL('../../', import.meta.url))
const names = ['host-build', 'portable-root', 'seed-project', 'resource-root', 'test-root', 'lex-root', 'connection-profile', 'output']
const { values } = parseArgs({ options: Object.fromEntries([...names, 'forward-evidence'].map(name => [name, { type: 'string' }])) })
for (const name of names) assert.ok(values[name] && path.isAbsolute(values[name]), `--${name} must be absolute`)
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
const inside = (root, file) => { const relative = path.relative(root, file)
  return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) }
const sha = value => createHash('sha256').update(value).digest('hex')
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const textOf = message => (message?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('')
assert.match(values['test-root'].replaceAll('\\', '/'), /\/aily-project\/dev-tests\//i)
assert.ok(inside(path.join(repo, 'e2e/test-results'), values.output))
const connection = JSON.parse(await fs.readFile(values['connection-profile'], 'utf8'))
assert.ok(path.isAbsolute(connection.authFile ?? '') && path.isAbsolute(connection.configFile ?? ''))
const api = new URL(connection.apiBase)
assert.ok(['http:', 'https:'].includes(api.protocol) && api.pathname === '/'
  && !api.username && !api.password && !api.search && !api.hash)
let forwardEvidence
if (api.hostname !== '129.204.34.159') {
  assert.ok(api.hostname === '127.0.0.1' && path.isAbsolute(values['forward-evidence'] ?? ''),
    'Loopback requires explicit evidence of the root-owned SSH forward to 129')
  const forwarded = JSON.parse(await fs.readFile(values['forward-evidence'], 'utf8'))
  assert.equal(forwarded.connected, true); assert.equal(forwarded.target, '129.204.34.159'); assert.equal(forwarded.remotePort, 8080)
  assert.equal(new URL(forwarded.apiBase).origin, api.origin)
  assert.ok(same(forwarded.connectionProfile, values['connection-profile']))
  assert.match(forwarded.serverHead, /^[a-f0-9]{40}$/)
  forwardEvidence = { target: forwarded.target, remotePort: forwarded.remotePort, serverHead: forwarded.serverHead }
}
assert.ok(!same(connection.authFile, path.join(values['resource-root'], '.aily')), 'Never use the daily account credential file')
const seedManifest = JSON.parse(await fs.readFile(path.join(values['seed-project'], 'package.json'), 'utf8'))
assert.equal(seedManifest.name, 'pinned-comment-runtime-rebuild-diagnostic', 'Use the self-created UNO diagnostic seed')
assert.match(values['seed-project'].replaceAll('\\', '/'), /\/aily-project\/dev-tests\//i)
await fs.mkdir(path.dirname(values.output), { recursive: true }); await fs.mkdir(values.output, { recursive: false })
await fs.mkdir(values['test-root'], { recursive: true })
const suite = await fs.mkdtemp(path.join(values['test-root'], 'online-native-'))
const project = path.join(suite, 'project'), appData = path.join(suite, 'appdata'), home = path.join(suite, 'home')
const agentProfile = path.join(suite, 'agent-profile'), temp = path.join(suite, 'temp'), output = values.output
const marker = 'ONLINE_NATIVE_' + randomUUID().slice(0, 8)
const evidence = { ok: false, suite, project, marker, realInstalledUi: true, onlineLlm: false,
  syntheticOutput: false, syntheticProof: false, userProjectUsed: false, userProjectsModified: false,
  hardwareUsed: false, simulatorUsed: false, productionSourceModified: false, ...(forwardEvidence ? { sshForward: forwardEvidence } : {}), tools: [] }
let app, page, renderer, proxy, loaded, hostPid, installedEvidence, verifyPortableBuild, nativeCase
let snapshot, sessionId, catalogObserver, selectedModel, accessToken, seedHash, submittedAt
const protectedFiles = new Map()
const phase = value => { evidence.phase = value; console.log(new Date().toISOString(), 'PHASE=' + value) }
const redact = value => accessToken ? String(value).replaceAll(accessToken, '<redacted>') : String(value)
const persist = () => fs.writeFile(path.join(output, 'result.json'), JSON.stringify(evidence, null, 2))
async function seedTreeHash() {
  const files = []
  async function visit(directory) {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name)
      assert.equal(entry.isSymbolicLink(), false, 'Do not follow seed project junctions')
      if (entry.isDirectory()) await visit(file)
      else { assert.ok(entry.isFile()); files.push([path.relative(values['seed-project'], file), sha(await fs.readFile(file))]) }
    }
  }
  await visit(values['seed-project']); return sha(JSON.stringify(files))
}
async function readSession() {
  const frame = loaded.frame
  assert.equal(await frame.locator('.full-access-permission-dialog').isVisible(), false)
  for (const dialog of await frame.locator('.pi-extension-dialog').all()) if (await dialog.isVisible()) {
    const lines = String(await dialog.getAttribute('aria-label')).split(/\r?\n/)
    assert.equal(lines[0], 'Trust project folder?'); assert.ok(same(lines[1], project))
    await dialog.getByRole('button', { name: 'Trust (this session only)', exact: true }).click()
    evidence.scopedTrustAccepted = true
  }
  if (!sessionId) {
    const listed = await loaded.e2e('session.list'), candidates = listed.sessions.filter(item => same(item.cwd, project))
    assert.ok(candidates.length <= 1); sessionId = candidates[0]?.sessionId
  }
  if (sessionId) {
    snapshot = (await loaded.e2e('session.read', { sessionId })).session
    assert.ok(same(snapshot.cwd, project)); assert.equal(snapshot.permissionMode, 'default')
    assertSelectedOnlineModel(snapshot, selectedModel)
    const ids = new Set()
    for (const message of snapshot.messages.filter(message => message.role === 'toolResult')) {
      assert.ok(!ids.has(message.toolCallId), 'No duplicated committed SDK results'); ids.add(message.toolCallId)
    }
    evidence.tools = nativeSessionTools(snapshot).map(tool => ({ name: tool.tool, idHash: sha(tool.id),
      resultPresent: !!tool.message, isError: tool.message?.isError === true, ok: tool.result?.ok,
      ...(tool.result?.code ? { code: tool.result.code } : {}) }))
  }
  return snapshot
}
try {
  phase('verify-installed-artifact-and-test-account')
  for (const file of [values['connection-profile'], connection.configFile, connection.authFile])
    protectedFiles.set(file, await fs.readFile(file))
  const config = JSON.parse(protectedFiles.get(connection.configFile)), auth = JSON.parse(protectedFiles.get(connection.authFile))
  assert.equal(new URL(config.regions?.[config.region]?.api_server).origin, api.origin)
  assert.ok(typeof auth.access_token === 'string' && auth.access_token); accessToken = auth.access_token
  ;({ verifyPortableBuild } = await import(pathToFileURL(path.join(values['lex-root'], 'packages/aily-chat/server/portable-integrity.ts'))))
  installedEvidence = await verifyPortableBuild(values['portable-root'])
  const { captureBuildInputs } = await import(pathToFileURL(path.join(values['lex-root'], 'packages/aily-chat/scripts/portable-build-inputs.mjs')))
  assert.equal(installedEvidence.inputHash, sha(JSON.stringify(await captureBuildInputs(values['lex-root']))))
  evidence.installed = { inputHash: installedEvidence.inputHash, outputHash: installedEvidence.outputHash,
    version: JSON.parse(await fs.readFile(path.join(values['portable-root'], 'package.json'), 'utf8')).version }
  evidence.apiOrigin = api.origin
  const me = await fetch(api.origin + '/api/v1/auth/me', { headers: { authorization: 'Bearer ' + accessToken }, signal: AbortSignal.timeout(15000) })
  evidence.authStatus = me.status; await me.body?.cancel(); assert.equal(me.status, 200)
  seedHash = await seedTreeHash()
  for (const directory of [project, home, agentProfile, temp]) await fs.mkdir(directory)
  for (const name of ['package.json', 'project.abi', 'node_modules'])
    await fs.cp(path.join(values['seed-project'], name), path.join(project, name), { recursive: true, force: false, errorOnExist: true })
  try { await fs.copyFile(path.join(values['seed-project'], 'package-lock.json'), path.join(project, 'package-lock.json')) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  proxy = await createStartupFaultProxy({ upstreamOrigin: api.origin, mode: 'passive' })
  const profile = await prepareInstalledChatProfile({ appData, installedRoot: values['portable-root'], apiBase: proxy.origin,
    baseConfigPath: connection.configFile, resourceAppData: values['resource-root'], token: accessToken })
  evidence.localCompilationResources = profile.preparation.resources
  const permission = { '*': 'deny', tool_load: 'allow', tool_invoke: 'allow', skill: 'allow', read: 'allow', ls: 'allow', find: 'allow', grep: 'allow',
    write: { '*': 'deny', [path.join(project, 'project.abs')]: 'allow' },
    edit: { '*': 'deny', [path.join(project, 'project.abs')]: 'allow' },
    external_directory: { '*': 'deny', [suite + '/*']: 'allow', [project + '/*']: 'allow', [values['portable-root'] + '/*']: 'allow' },
    path: { '*': 'allow', [path.join(appData, '.aily')]: 'deny', [connection.authFile]: 'deny',
      [values['connection-profile']]: 'deny', [path.join(values['resource-root'], '.aily')]: 'deny',
      [path.join(appData, '.npmrc')]: 'deny' } }
  for (const name of ['project_recover', 'abs_export', 'abs_validate', 'abs_apply', 'project_build', 'library_docs', 'block_info',
    'block_list', 'board_info', 'get_board_config', 'project_status', 'app_info', 'app_status', 'todo']) permission[name] = 'allow'
  const policy = path.join(agentProfile, 'extensions/pi-permission-system/config.json')
  await fs.mkdir(path.dirname(policy), { recursive: true }); await fs.writeFile(policy, JSON.stringify({ permission }), { flag: 'wx' })
  renderer = await serveRendererBuild(values['host-build'])
  const { ELECTRON_RUN_AS_NODE, AILY_CHILD_PATH, NODE_PATH, AILY_PORTABLE_ROOT, AILY_AUTH_FILE, ...env } = process.env
  phase('cold-installed-chat-host')
  app = await _electron.launch({ args: ['.', '--serve', `--user-data-dir=${path.join(suite, 'electron-profile')}`], cwd: repo,
    timeout: 60000, env: { ...env, ...profile.env, AILY_E2E: '1', AILY_DEV_RENDERER_URL: renderer.origin,
      HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentProfile, TEMP: temp, TMP: temp,
      npm_config_offline: 'true', npm_config_audit: 'false' } })
  const identity = await app.evaluate(() => ({ pid: process.pid, appData: process.env.AILY_APPDATA_PATH }))
  assert.ok(Number.isSafeInteger(identity.pid) && same(identity.appData, appData)); hostPid = identity.pid
  evidence.hostPid = hostPid
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
  const deadline = Date.now() + 60000
  while (!page && Date.now() < deadline) {
    page = app.windows().find(window => window.url().startsWith(renderer.origin)); if (!page) await wait(100)
  }
  assert.ok(page); page.on('dialog', dialog => dialog.dismiss())
  if (explicitOnlineModelId(connection.model)) catalogObserver = observeOnlineModelCatalog(page, project)
  await page.goto(renderer.origin, { waitUntil: 'domcontentloaded' }); await page.locator('app-main-window').waitFor({ timeout: 60000 })
  await page.evaluate(() => {
    const dismiss = () => document.querySelector('app-onboarding .btn-skip')?.click()
    new MutationObserver(dismiss).observe(document.documentElement, { childList: true, subtree: true }); dismiss()
  })
  await page.waitForFunction(() => window.ng?.getComponent(document.querySelector('app-header'))?.projectService)
  await page.evaluate(async target => {
    const service = window.ng.getComponent(document.querySelector('app-header')).projectService
    await service.initializeProjectDataSchema(target)
    if (!await service.projectOpen(target)) throw Error('The self-created UNO project did not open')
  }, project)
  await page.waitForFunction(target => {
    const c = window.ng.getComponent(document.querySelector('app-blockly-editor'))
    return c?.projectService.currentProjectPath === target && c.projectService.getBlocklyProjectLoadStatus(target)?.ready
      && c._builderService.isInstallInProgress() === false
  }, project, { timeout: 120000 })
  loaded = await assertInstalledChatLoaded(page, { installedRoot: values['portable-root'], expectedApiBase: proxy.origin,
    expectedInputHash: installedEvidence.inputHash, expectedOutputHash: installedEvidence.outputHash })
  evidence.chat = { installedVersion: evidence.installed.version, actualEmbeddedComposer: true, buildHashesMatched: true }
  if (catalogObserver) {
    const response = await fetch(proxy.origin + '/api/v2/model_catalog', { headers: { authorization: 'Bearer ' + accessToken }, signal: AbortSignal.timeout(15000) })
    assert.equal(response.status, 200); selectedModel = resolveOnlineModelPreset(await response.json(), connection.model)
    evidence.catalog = await catalogObserver.waitUntilReady(selectedModel, { deadline: Date.now() + 60000 })
    evidence.selectedModel = await selectOnlineModelFromUi(loaded.frame, selectedModel)
  }
  phase('prepare-native-comments-and-real-runtime-rebuild')
  nativeCase = await prepareOnlineNativeCommentCase({ page, project, isolationRoot: suite, marker })
  evidence.nativePreparation = nativeCase.evidence
  await fs.writeFile(path.join(output, 'native-before.json'), JSON.stringify(nativeCase.baseline, null, 2))
  phase('one-real-model-composer-turn')
  await loaded.frame.locator('.aily-chat-composer-input[role="textbox"]').fill(
    `这是已授权的隔离UNO验收工程 ${project}，不是用户原工程。宿主已实际保存并重建运行时，画布健康；setup有显式x/y的关闭注释，loop有pinned=true注释。` +
    `请自主通过真实SDK工具完成一次最小增量：只在setup末尾增加 serial_print(Serial, text("${marker}"))，不要增加其他行为。` +
    `先检查当前工程并通过abs_export取得最新候选，再read磁盘project.abs和必要语法/库说明，用原生edit或write实际修改该ABS文件；` +
    `随后abs_validate、abs_apply读取该文件，最后project_build实际编译并等待本次成功回执。不要给验证/应用传inline ABS。` +
    `所有原有ID、根坐标、注释文本/pinned/width/height/x/y、保护属性、页面/共享模型和状态元数据都必须原样保留。` +
    `不要通过删除注释或元数据、脚本重建、修改生成C++、安装、整理、烧录、仿真或要求用户重启来完成。` +
    `若真实检查提供受保护恢复offer，再按其原token/requestId恢复并继续；健康无offer时无需recover_runtime。` +
    `本轮只有这一个用户请求，沿用已完成工具回执，编译未确认时不能宣称完成。不读取其他工程或任何凭据。`)
  submittedAt = Date.now(); evidence.submittedAt = submittedAt
  await loaded.frame.locator('button.primary-action.send-action').click()
  const modelDeadline = Date.now() + 12 * 60 * 1000
  let nextProgress = 0
  while (Date.now() < modelDeadline) {
    await readSession()
    if (snapshot) {
      assert.ok(snapshot.messages.filter(message => message.role === 'user').length <= 1)
      const final = snapshot.messages.filter(message => message.role === 'assistant').at(-1)
      if (snapshot.isIdle && !snapshot.isStreaming && ['stop', 'error', 'aborted'].includes(final?.stopReason)) {
        evidence.final = { stopReason: final.stopReason, textHash: sha(textOf(final)), textBytes: Buffer.byteLength(textOf(final)),
          ...(final.errorMessage ? { errorMessage: redact(final.errorMessage) } : {}) }
        assert.equal(final.stopReason, 'stop'); break
      }
    }
    if (Date.now() >= nextProgress) { nextProgress = Date.now() + 5000; await persist() }
    await wait(300)
  }
  assert.ok(evidence.final, 'The original real-model session must settle')
  assert.equal(snapshot.messages.filter(message => message.role === 'user').length, 1)
  phase('verify-sdk-apply-and-compile-receipts')
  const receipts = assertOnlineNativeReceipts(snapshot, project)
  evidence.receipts = receipts.evidence
  await page.waitForFunction(() => {
    const c = window.ng.getComponent(document.querySelector('app-blockly-editor')), b = c.blocklyService
    return !b.aiWriting && !b.aiWaitWriting && !b.isWorkspaceEditBlocked() && !b.isWorkspaceEditInProgress()
      && !window.ng.getComponent(document.querySelector('app-child-tool-host')).aiOperationProtocol?.hasRunning
  }, undefined, { timeout: 15000 })
  const after = await captureNativeCommentState(page, project)
  evidence.nativePreservation = assertNativeCommentEditPreserved(nativeCase.baseline, after, marker)
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(project, 'project.abi'), 'utf8')), after.document,
    'The saved ABI must equal the complete final native document')
  const compile = JSON.parse(await fs.readFile(path.join(project, '.log/compile/latest-result.json'), 'utf8'))
  assert.equal(compile.success, true); assert.ok(compile.finishedAt >= submittedAt)
  const sketch = await fs.readFile(path.join(project, '.temp/sketch/sketch.ino'), 'utf8')
  assert.ok(sketch.includes(marker), 'The actual compiler input must contain the applied marker')
  evidence.compile = { success: true, finishedAt: compile.finishedAt, freshResult: true, sketchHash: sha(sketch) }
  await fs.writeFile(path.join(output, 'native-after.json'), JSON.stringify(after, null, 2))
  evidence.transport = proxy.snapshot(); assert.deepEqual(evidence.transport.failures, [])
  assert.equal(evidence.transport.createCount, 1); assert.equal(evidence.transport.interruptCount, 0)
  assert.ok(evidence.transport.operations.some(operation => operation.semanticEvents > 0 || operation.toolCalls.length > 0))
  const last = evidence.transport.operations.toSorted((a, b) => a.step - b.step).at(-1)
  assert.ok(last)
  const canonicalBase = `${proxy.origin}/api/v3/interactions/${evidence.transport.interactionId}/operations/${last.step}`
  const stateResponse = await fetch(canonicalBase + '/state', { headers: { authorization: 'Bearer ' + accessToken }, signal: AbortSignal.timeout(15000) })
  assert.equal(stateResponse.status, 200)
  const state = await stateResponse.json(); assert.equal(state.status, 'completed')
  evidence.canonical = { operationId: state.operationId, status: state.status, streamState: state.streamState }
  evidence.onlineLlm = true; evidence.ok = true; phase('complete')
} catch (error) {
  evidence.failure = { name: error.name, code: error.code, message: redact(error.message),
    stack: redact(String(error.stack).split('\n').slice(0, 7).join('\n')) }
  process.exitCode = 1; console.error('ACCEPTANCE_FAILED', evidence.failure.message)
} finally {
  catalogObserver?.close()
  const finish = async (label, action) => { try { await action() } catch (error) {
    evidence.cleanupFailures ??= []; evidence.cleanupFailures.push({ label, message: redact(error.message) })
    evidence.ok = false; process.exitCode = 1
  } }
  if (loaded && submittedAt && (!snapshot?.isIdle || snapshot?.isStreaming)) await finish('settle-owned-session', async () => {
    const stop = loaded.frame.locator('button.primary-action.stop-action')
    if (await stop.isVisible()) await stop.click({ timeout: 3000 })
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) { await readSession(); if (snapshot?.isIdle && !snapshot.isStreaming) return; await wait(200) }
    throw Error('The original owned session did not settle after cleanup Stop')
  })
  if (page) await page.screenshot({ path: path.join(output, 'final.png'), fullPage: true }).catch(() => {})
  if (proxy) { evidence.transport = proxy.snapshot(); evidence.onlineLlm ||= evidence.transport.operations.some(operation => operation.semanticEvents > 0 || operation.toolCalls.length > 0) }
  if (app) await finish('close-owned-host', () => app.evaluate(({ app }, owned) => {
    if (process.pid !== owned.pid || process.env.AILY_APPDATA_PATH !== owned.appData) throw Error('Refuse unrelated host exit')
    app.exit(0)
  }, { pid: hostPid, appData }))
  await finish('close-owned-renderer', () => renderer?.close()); await finish('close-owned-proxy', () => proxy?.close())
  await finish('remove-private-token', () => fs.unlink(path.join(appData, '.aily')).catch(error => { if (error.code !== 'ENOENT') throw error }))
  await finish('preserve-seed-credentials-and-install', async () => {
    if (seedHash) assert.equal(await seedTreeHash(), seedHash)
    for (const [file, bytes] of protectedFiles) assert.equal(sha(await fs.readFile(file)), sha(bytes))
    if (installedEvidence) assert.deepEqual(await verifyPortableBuild(values['portable-root']), installedEvidence)
    evidence.inputsPreserved = true
  })
  await persist(); console.log(JSON.stringify({ ok: evidence.ok, phase: evidence.phase, failure: evidence.failure?.message, output, suite }))
}
