import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import nativeFs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { parseArgs, promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { _electron } from '@playwright/test'
import { prepareInstalledChatProfile, assertInstalledChatLoaded } from '../fixtures/installed-chat-ui.mjs'
import { resolveOnlineModelPreset, selectOnlineModelFromUi, assertSelectedOnlineModel } from '../fixtures/online-model-selection.mjs'
import { createBuildLogNetwork } from './fixtures/build-log-network.mjs'
import { summarizeOnlineComparison, summarizeBuildInvocationAttempts } from './fixtures/online-comparison.mjs'
import { assertCapturedEnvironmentProcess, selectEnvironmentProcessTree,
  remainingEnvironmentProcesses, environmentProcessStopScript } from './fixtures/r2-environment-cleanup.mjs'
import { createLibDriverRegistry, libDriverNpmEnvironment } from './fixtures/lib-driver-registry.mjs'
import { libraryCodeProbe, prepareLibraryCodeProbePackage, prepareLibraryCodeProbeProject,
  installLibraryCodeProbe, inspectLibraryCodeProbe } from './fixtures/library-code-probe.mjs'
import { fingerprintLibDriverSdk } from './lib-driver-candidate.acceptance.mjs'
import { sha } from './fixtures/r1-customer-native.mjs'

// Root explicitly starts this one actual paid acceptance. Importing the helper
// module never launches a Host, compiler, registry or model.
assert.equal(process.env.AILY_LIBRARY_ROOT_HOST_WINDOW, '1')
assert.equal(process.env.AILY_ONLINE_ACCEPTANCE, '1')
const required = ['pair-file', 'connection-profile', 'output', 'test-root', 'resource-root', 'platform-resource-root', 'project-input']
const { values } = parseArgs({ options: Object.fromEntries([...required, 'agent-root'].map(name => [name, { type: 'string' }])) })
for (const name of required) assert.ok(path.isAbsolute(values[name] ?? ''), '--' + name + ' must be absolute')
const repo = fileURLToPath(new URL('../../', import.meta.url))
const agentRoot = values['agent-root'] ?? path.resolve(repo, '../aily-lex-pro/packages/aily-agent')
const lex = path.resolve(agentRoot, '../..')
const materialProject = values['project-input']
const inside = (root, file) => { const relative = path.relative(root, file)
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) }
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
assert.ok(inside(path.join(repo, 'e2e/test-results'), values.output))
assert.ok(inside(path.join(values['resource-root'], 'dev-tests'), values['test-root']))
assert.equal(inside(values['resource-root'], values['platform-resource-root']), false)
const pair = JSON.parse(await fs.readFile(values['pair-file']))
const host = JSON.parse(await fs.readFile(pair.hostReceipt)), chat = JSON.parse(await fs.readFile(pair.chatReceipt))
assert.equal(chat.ok, true); assert.equal(sha(await fs.readFile(host.asar)), host.asarHash)
for (const relative of ['sdk', 'tools', 'compiler', 'node_modules', 'npm-global/node_modules'])
  assert.ok(inside(values['platform-resource-root'], await fs.realpath(path.join(values['platform-resource-root'], relative))))
const connection = JSON.parse(await fs.readFile(values['connection-profile']))
assert.equal(new URL(connection.apiBase).origin, 'https://api-test.yiyu.pro', 'Only 129 test Services is authorized; 114 is production')
assert.equal(connection.model, 'auto-fast', 'This single comparison uses the real Flash catalog preset without fallback')
assert.ok(path.isAbsolute(connection.authFile) && path.isAbsolute(connection.configFile))
assert.equal(same(connection.authFile, path.join(values['resource-root'], '.aily')), false)
assert.ok(os.freemem() >= 1024 ** 3)
const exec = promisify(execFile)
const processes = async () => {
  const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine,@{Name='CreationDate';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress"],
  { windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 ** 2 })
  const result = JSON.parse(stdout); return Array.isArray(result) ? result : [result]
}
assert.deepEqual((await processes()).filter(item => item.ExecutablePath && same(item.ExecutablePath, host.executable)), [], 'No previous exact Host may remain')
await fs.mkdir(path.dirname(values.output), { recursive: true }); await fs.mkdir(values.output)
await fs.mkdir(values['test-root'], { recursive: true })
const suite = await fs.mkdtemp(path.join(values['test-root'], 'lib-code-installed-'))
const appData = path.join(suite, 'appdata'), home = path.join(suite, 'home'), temp = path.join(suite, 'temp')
const agentProfile = path.join(suite, 'agent-profile'), npmCache = path.join(suite, 'npm-cache'), userconfig = path.join(suite, 'library-test.npmrc')
for (const directory of [home, temp, agentProfile, npmCache]) await fs.mkdir(directory)
const evidence = { ok: false, suite, output: values.output, host: { executable: host.executable, hash: host.asarHash },
  chat: chat.artifact, naturalPrompt: libraryCodeProbe.prompt, naturalPromptSha256: sha(libraryCodeProbe.prompt),
  toolOrderInjected: false, skillReadGateAdded: false, syntheticProviderOutput: false,
  syntheticToolResults: false, originalUserProgramModified: false, originalConversationReplayed: false,
  fixture: 'independent test-owned registry C++ library', forcedOldBuildExecuted: false,
  compiler: { backend: 'local', upstreamServicesIsCompiler: false }, stages: [], cleanupFailures: [], protectedFiles: [] }
const persist = async () => {
  evidence.transport = proxy?.snapshot(); evidence.registry = registry?.snapshot()
  const file = path.join(values.output, 'result.json'), temporary = file + '.tmp'
  await fs.writeFile(temporary, JSON.stringify(evidence, null, 2)); await fs.rename(temporary, file)
}
const stage = async name => { evidence.stages.push({ name, at: Date.now() }); console.log('LIB_CODE_PHASE=' + name); await persist() }
let app, page, loaded, registry, proxy, artifact, verifyPortableBuild, mainIdentity, actorIdentity, fixture, packed, accessToken, selectedModel, expectedEffectiveModel
const protectedFiles = new Map(), previousEnvironment = new Map()
const assignActorEnvironment = environment => { for (const [key, value] of Object.entries(environment)) {
  previousEnvironment.set(key, process.env[key]); if (value === undefined) delete process.env[key]; else process.env[key] = value
} }
const safeError = error => ({ name: error.name, code: error.code, message: String(error.message)
  .replaceAll(accessToken ?? '\u0000', '[private credential]').replace(/([?&]token=|Bearer\s+)[^\s"'&]+/gi, '$1[private credential]') })
const cleanup = async (name, action) => { try { await action() } catch (error) {
  evidence.ok = false; evidence.cleanupFailures.push({ name, ...safeError(error) })
} }
const textOf = message => (message?.content ?? []).filter(item => item.type === 'text').map(item => item.text).join('\n')
const payloadOf = message => { if (message?.details?.result && typeof message.details.result === 'object') return message.details.result
  try { return JSON.parse(textOf(message)) } catch { return undefined } }
const callsOf = snapshot => (snapshot?.messages ?? []).filter(message => message.role === 'assistant').flatMap(message => message.content ?? [])
  .filter(item => item.type === 'toolCall').map(item => ({ ...item,
    actualName: item.name === 'tool_invoke' ? item.arguments?.name : item.name,
    actualArguments: item.name === 'tool_invoke' ? item.arguments?.arguments : item.arguments }))
const nativeDocument = async () => JSON.parse(await page.evaluate(() => window.ng.getComponent(
  document.querySelector('app-blockly-editor')).blocklyService.captureRecoverySnapshot().documentText))
async function ownedSnapshot() {
  for (const dialog of await loaded.frame.locator('.pi-extension-dialog').all()) if (await dialog.isVisible()) {
    const lines = String(await dialog.getAttribute('aria-label')).split(/\r?\n/)
    assert.equal(lines[0], 'Trust project folder?'); assert.ok(same(lines[1], fixture.project))
    await dialog.getByRole('button', { name: 'Trust (this session only)', exact: true }).click()
  }
  assert.equal(await loaded.frame.locator('.full-access-permission-dialog').isVisible(), false)
  const listed = await loaded.e2e('session.list'), matches = listed.sessions.filter(item => same(item.cwd, fixture.project))
  assert.ok(matches.length <= 1)
  if (!matches.length) return undefined
  const snapshot = (await loaded.e2e('session.read', { sessionId: matches[0].sessionId })).session
  assertSelectedOnlineModel(snapshot, selectedModel); assert.equal(snapshot.permissionMode, 'default')
  return snapshot
}

try {
  await stage('read-only-129-quota-and-model-preflight')
  for (const file of new Set([values['connection-profile'], connection.configFile, connection.authFile,
    path.join(values['resource-root'], 'config.json'), path.join(values['resource-root'], '.aily'),
    path.join(values['resource-root'], 'npm-global/app/store/subapp-aily-chat/active.json'), path.join(values['resource-root'], 'npm-global/app/subapp-index.json')]))
    protectedFiles.set(file, await fs.readFile(file).then(sha).catch(error => { if (error.code === 'ENOENT') return null; throw error }))
  const config = JSON.parse(await fs.readFile(connection.configFile)), auth = JSON.parse(await fs.readFile(connection.authFile))
  assert.equal(new URL(config.regions[config.region].api_server).origin, connection.apiBase)
  accessToken = auth.access_token; assert.ok(typeof accessToken === 'string' && accessToken)
  proxy = await createBuildLogNetwork({ upstreamOrigin: connection.apiBase, upstreamAddress: '129.204.34.159' })
  const headers = { authorization: 'Bearer ' + accessToken }
  const quotaResponse = await fetch(proxy.origin + '/api/v3/interaction_quotas/snapshot', { headers, signal: AbortSignal.timeout(15000) })
  assert.equal(quotaResponse.status, 200)
  const quota = await quotaResponse.json()
  evidence.quota = { monthlyRemaining: quota.quotaSnapshots?.chat_monthly?.remaining, dailyRemaining: quota.quotaSnapshots?.daily_interactions?.remaining, rateLimited: quota.rateLimited }
  assert.ok(evidence.quota.monthlyRemaining >= 0.5); assert.equal(evidence.quota.rateLimited, false)
  const catalogResponse = await fetch(proxy.origin + '/api/v2/model_catalog', { headers, signal: AbortSignal.timeout(15000) })
  assert.equal(catalogResponse.status, 200)
  const catalog = await catalogResponse.json(); selectedModel = resolveOnlineModelPreset(catalog, connection.model)
  const preset = { ...catalog.data?.model_presets?.[selectedModel.id], ...catalog.data?.user_visible_model_presets?.[selectedModel.id] }
  expectedEffectiveModel = preset.auto_select === false && typeof preset.model === 'string' ? preset.model : undefined
  assert.equal(expectedEffectiveModel, 'glm-5.3-flash', 'No preset mutation or fallback is allowed')
  evidence.selectedModel = { ...selectedModel, expectedEffectiveModel, catalogSha256: sha(JSON.stringify(catalog)) }
  await stage('prepare-genuine-private-probe-package-and-project')
  packed = await prepareLibraryCodeProbePackage({ directory: path.join(suite, 'probe-material'), npmCli: path.join(repo, 'child/node/node_modules/npm/bin/npm-cli.js') })
  evidence.package = { ...packed, sourceText: undefined, expectedText: undefined }
  registry = await createLibDriverRegistry({ tarball: packed.tarball, expectedTarget: { name: libraryCodeProbe.name,
    version: libraryCodeProbe.version, requiredFiles: ['block.json', 'generator.js', 'toolbox.json', libraryCodeProbe.cpp, libraryCodeProbe.header, 'LICENSE'] } })
  fixture = await prepareLibraryCodeProbeProject({ directory: path.join(suite, 'project'), materialProject })
  evidence.project = fixture.project; evidence.materials = fixture
  await fs.writeFile(userconfig, 'registry=' + registry.origin + '\n@aily-project:registry=' + registry.origin + '\nreplace-registry-host=always\nignore-scripts=true\naudit=false\nfund=false\n', { flag: 'wx' })
  const profile = await prepareInstalledChatProfile({ appData, installedRoot: chat.installedRoot, apiBase: proxy.origin,
    baseConfigPath: connection.configFile, resourceAppData: values['platform-resource-root'], token: accessToken })
  profile.config.compile = { ...profile.config.compile, backend: 'local' }
  for (const region of Object.values(profile.config.regions ?? {}))
    for (const key of ['npm_registry', 'npm_registry_linux', 'npm_registry_coder']) region[key] = registry.origin
  await fs.writeFile(path.join(appData, 'config.json'), JSON.stringify(profile.config, null, 2))
  const permission = { '*': 'deny', tool_load: 'allow', tool_invoke: 'allow', skill: 'allow', read: 'allow', edit: 'allow', write: 'allow',
    grep: 'allow', find: 'allow', ls: 'allow', code_run: 'allow', bash: 'allow', powershell: 'allow', todo: 'allow', project_build: 'allow', project_save: 'allow',
    project_status: 'allow', blocks_list: 'allow', block_info: 'allow', library_docs: 'allow', search_boards_libraries: 'allow',
    lib_validate_local: 'allow', lib_install_local: 'allow',
    abs_export: 'allow', abs_validate: 'allow', abs_apply: 'allow',
    external_directory: { '*': 'deny', [suite + '/*']: 'allow', [chat.installedRoot + '/*']: 'allow' },
    path: { '*': 'allow', [path.join(appData, '.aily')]: 'deny', [connection.authFile]: 'deny', [connection.configFile]: 'deny',
      [values['connection-profile']]: 'deny', [path.join(values['resource-root'], '.aily')]: 'deny' } }
  const policy = path.join(agentProfile, 'extensions/pi-permission-system/config.json')
  await fs.mkdir(path.dirname(policy), { recursive: true }); await fs.writeFile(policy, JSON.stringify({ permission }), { flag: 'wx' })
  evidence.toolPermissionPolicy = Object.fromEntries(Object.entries(permission).filter(([name]) => !['path', 'external_directory'].includes(name)))
  ;({ verifyPortableBuild } = await import(pathToFileURL(path.join(lex, 'packages/aily-chat/server/portable-integrity.ts'))))
  artifact = await verifyPortableBuild(chat.installedRoot)
  assert.equal(artifact.inputHash, chat.artifact.inputHash); assert.equal(artifact.outputHash, chat.artifact.outputHash)
  const { captureBuildInputs } = await import(pathToFileURL(path.join(lex, 'packages/aily-chat/scripts/portable-build-inputs.mjs')))
  assert.equal(artifact.inputHash, sha(JSON.stringify(await captureBuildInputs(lex))))
  const npmEnvironment = libDriverNpmEnvironment(registry.origin, { cache: npmCache, userconfig })
  const { ELECTRON_RUN_AS_NODE, AILY_CHILD_PATH, NODE_PATH, AILY_PORTABLE_ROOT, AILY_AUTH_FILE,
    HTTP_PROXY, HTTPS_PROXY, ALL_PROXY, http_proxy, https_proxy, all_proxy, ...environment } = process.env
  await stage('launch-one-owned-installed-host-and-chat')
  app = await _electron.launch({ executablePath: host.executable, cwd: repo, timeout: 60000,
    args: [`--user-data-dir=${path.join(suite, 'chromium-profile')}`], env: { ...environment, ...profile.env, ...npmEnvironment,
      AILY_E2E: '1', HOME: home, USERPROFILE: home, TEMP: temp, TMP: temp, PI_CODING_AGENT_DIR: agentProfile } })
  const hostPid = await app.evaluate(() => process.pid), all = await processes()
  mainIdentity = all.find(item => item.ProcessId === hostPid); actorIdentity = all.find(item => item.ProcessId === process.pid)
  assert.ok(mainIdentity && actorIdentity); assert.ok(same(mainIdentity.ExecutablePath, host.executable))
  assert.ok(mainIdentity.CommandLine.includes(path.join(suite, 'chromium-profile')))
  evidence.host.pid = hostPid; evidence.hostPid = hostPid; evidence.mainIdentity = mainIdentity; await persist()
  for (const stream of ['stdout', 'stderr']) app.process()[stream]?.pipe(nativeFs.createWriteStream(path.join(values.output, 'main-' + stream + '.log')))
  await app.context().route('**/*', async route => {
    const request = route.request(), url = new URL(request.url())
    if (!['http:', 'https:'].includes(url.protocol) || ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return route.continue()
    if (url.origin !== connection.apiBase || !url.pathname.startsWith('/api/')) return route.abort('blockedbyclient')
    const clean = { ...request.headers() }; delete clean.host; delete clean.connection; delete clean['content-length']
    try {
      const response = await fetch(proxy.origin + url.pathname + url.search, { method: request.method(), headers: clean,
        ...(['GET', 'HEAD'].includes(request.method()) ? {} : { body: request.postDataBuffer() }), signal: AbortSignal.timeout(15000) })
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) })
    } catch { await route.abort('connectionfailed') }
  })
  const windowDeadline = Date.now() + 60000
  while (!page && Date.now() < windowDeadline) {
    for (const candidate of app.windows()) if (await candidate.locator('app-main-window').count()) { page = candidate; break }
    if (!page) await wait(100)
  }
  assert.ok(page); page.on('dialog', dialog => dialog.dismiss())
  page.on('pageerror', error => { (evidence.pageErrors ??= []).push(safeError(error)) })
  await page.evaluate(() => { const dismiss = () => document.querySelector('app-onboarding .btn-skip')?.click()
    new MutationObserver(dismiss).observe(document.documentElement, { childList: true, subtree: true }); dismiss() })
  await page.waitForFunction(() => window.ng?.getComponent(document.querySelector('app-header'))?.projectService)
  assert.equal(await page.evaluate(async project => { const service = window.ng.getComponent(document.querySelector('app-header')).projectService
    await service.initializeProjectDataSchema(project); return service.projectOpen(project) }, fixture.project), true)
  await page.waitForFunction(project => { const editor = window.ng.getComponent(document.querySelector('app-blockly-editor'))
    return editor?.projectService.currentProjectPath === project && editor.projectService.getBlocklyProjectLoadStatus(project)?.ready
      && editor._builderService.isInstallInProgress() === false }, fixture.project, { timeout: 120000 })
  loaded = await assertInstalledChatLoaded(page, { installedRoot: chat.installedRoot, expectedApiBase: proxy.origin,
    expectedInputHash: chat.artifact.inputHash, expectedOutputHash: chat.artifact.outputHash })
  evidence.installedChat = loaded.evidence
  assert.equal(await app.evaluate(({ app }) => app.isPackaged), true)
  assignActorEnvironment({ AILY_LIBRARY_HOST_PID: String(hostPid), AILY_APPDATA_PATH: appData, AILY_NPM_PREFIX: path.join(appData, 'npm-global'),
    HOME: home, USERPROFILE: home, TEMP: temp, TMP: temp, PI_CODING_AGENT_DIR: agentProfile, PI_OFFLINE: '1', AILY_CHILD_PATH: undefined, AILY_PORTABLE_ROOT: undefined })
  evidence.sdkFingerprint = await fingerprintLibDriverSdk(agentRoot)
  await stage('actual-product-registry-install-and-fixture-native-save')
  evidence.setup = await installLibraryCodeProbe({ page, project: fixture.project, agentRoot, suite, registry,
    checkpoint: async value => { evidence.setup = value; await persist() } })
  evidence.nativeBefore = await nativeDocument()
  const manifestBefore = JSON.parse(await fs.readFile(path.join(fixture.project, 'package.json')))
  const unaffectedDependencies = manifest => Object.fromEntries(Object.entries(manifest.dependencies ?? {})
    .filter(([name]) => name !== libraryCodeProbe.name))
  evidence.unaffectedDependencies = unaffectedDependencies(manifestBefore)
  evidence.abiBeforeSha256 = sha(await fs.readFile(path.join(fixture.project, 'project.abi')))
  const generated = await page.evaluate(() => window.ng.getComponent(document.querySelector('app-blockly-editor')).blocklyService.getReusableGeneratedCode())
  assert.ok(generated.includes('#include <AilyLibraryCodeProbe.h>') && generated.includes('(void)ailyLibraryCodeProbe();'))
  evidence.generatedBeforeSha256 = sha(generated)
  await selectOnlineModelFromUi(loaded.frame, selectedModel, { catalogTimeoutMs: 60000 })
  assert.ok(os.freemem() >= 1024 ** 3, 'Do not submit the paid task without the fixed minimum resource profile')
  const beforeSession = await ownedSnapshot()
  evidence.expectedUserCount = (beforeSession?.messages.filter(item => item.role === 'user').length ?? 0) + 1
  await stage('single-natural-flash-library-edit-request')
  const input = loaded.frame.locator('.aily-chat-composer-input[role="textbox"]'), send = loaded.frame.locator('button.primary-action.send-action')
  const inputDeadline = Date.now() + 30000
  while (Date.now() < inputDeadline) { if (await input.innerText() !== libraryCodeProbe.prompt) await input.fill(libraryCodeProbe.prompt)
    await wait(150); if (await input.innerText() === libraryCodeProbe.prompt && await send.isEnabled()) break }
  assert.equal(await input.innerText(), libraryCodeProbe.prompt); assert.equal(await send.isEnabled(), true)
  evidence.submittedAt = Date.now(); evidence.transportStartRequestIndex = proxy.snapshot().requests.length; await persist()
  await send.click({ timeout: 5000 }); evidence.onlineLlm = true
  let snapshot, nextCheckpoint = 0
  const deadline = Date.now() + 12 * 60 * 1000
  while (Date.now() < deadline) {
    assert.equal(await page.evaluate(() => window.ng.getComponent(document.querySelector('app-blockly-editor')).projectService.currentProjectPath), fixture.project)
    snapshot = await ownedSnapshot()
    const final = snapshot?.messages.filter(item => item.role === 'assistant').at(-1)
    if (snapshot?.messages.filter(item => item.role === 'user').length === evidence.expectedUserCount && snapshot.isIdle
      && !snapshot.isStreaming && ['stop', 'error', 'aborted'].includes(final?.stopReason)) break
    if (Date.now() >= nextCheckpoint) { nextCheckpoint = Date.now() + 5000; evidence.lastObservedSessionId = snapshot?.sessionId; await persist() }
    await wait(350)
  }
  assert.ok(snapshot?.isIdle && !snapshot.isStreaming, 'The original natural task must actually settle')
  const final = snapshot.messages.filter(item => item.role === 'assistant').at(-1)
  assert.equal(snapshot.messages.filter(item => item.role === 'user').length, evidence.expectedUserCount)
  evidence.settledAt = Date.now(); evidence.final = { stopReason: final?.stopReason, text: textOf(final) }
  await fs.writeFile(path.join(values.output, 'natural-session.json'), JSON.stringify(snapshot, null, 2))
  evidence.comparison = summarizeOnlineComparison(snapshot, { startedAt: evidence.submittedAt, expectedModel: expectedEffectiveModel,
    expectedPreset: selectedModel.id, transport: proxy.snapshot(), businessActionNames: ['lib_install_local', 'edit', 'project_build'] })
  assert.equal(evidence.comparison.modelEvidenceValid, true)
  assert.ok(evidence.comparison.taskThinking.complete && evidence.comparison.thinkingLevels.length > 0
    && evidence.comparison.thinkingLevels.every(level => level === 'high'))
  assert.ok(evidence.comparison.providerTimings.length > 0 && evidence.comparison.providerTimings.every(item =>
    item.httpEvidence?.reasoningEffortComplete && item.httpEvidence.reasoningEfforts.every(level => level === 'high')))
  assert.equal(final?.stopReason, 'stop')
  const calls = callsOf(snapshot)
  for (const forbidden of ['project_fork', 'project_open', 'app_open', 'project_upload'])
    assert.equal(calls.some(item => item.actualName === forbidden), false, 'No project switch/fork/reopen may replace the requested library edit')
  const localizes = calls.filter(item => item.actualName === 'lib_install_local')
  assert.ok(localizes.some(call => snapshot.messages.some(message => message.role === 'toolResult' && message.toolCallId === call.id
    && message.isError !== true && payloadOf(message)?.ok === true)), 'Observe the real product localization, not an equivalent hand-written file link')
  const authored = registry.packages.find(item => item.manifest.name === libraryCodeProbe.name)
  evidence.libraryEdit = await inspectLibraryCodeProbe(fixture.project, packed.expectedText, authored)
  const manifestAfter = JSON.parse(await fs.readFile(path.join(fixture.project, 'package.json')))
  assert.deepEqual(unaffectedDependencies(manifestAfter), evidence.unaffectedDependencies,
    'A library source edit cannot repair the fixture by removing or upgrading unrelated dependencies')
  for (const field of ['name', 'board', 'devmode']) assert.deepEqual(manifestAfter[field], manifestBefore[field])
  assert.deepEqual(await nativeDocument(), evidence.nativeBefore, 'A library source fix must preserve the full native document')
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(fixture.project, 'project.abi'))), evidence.nativeBefore)
  const builds = calls.filter(item => item.actualName === 'project_build')
  evidence.buildInvocations = summarizeBuildInvocationAttempts(snapshot)
  const completed = snapshot.messages.filter(message => message.role === 'toolResult' && builds.some(call => call.id === message.toolCallId))
    .map(message => ({ message, value: payloadOf(message) })).filter(item => item.value?.buildReceipt?.state === 'completed')
  assert.ok(completed.length > 0)
  evidence.build = completed.at(-1).value
  const value = evidence.build, requestId = value.buildReceipt.requestId
  assert.equal(value.ok, true); assert.equal(value.verification?.status, 'passed'); assert.equal(value.targetPid, hostPid)
  assert.ok(same(value.buildReceipt.project, fixture.project))
  const execution = await page.evaluate(({ project, requestId }) => window.builder.inspectBuildExecution(project, requestId), { project: fixture.project, requestId })
  evidence.execution = execution
  assert.equal(execution.buildRequestId, requestId); assert.equal(execution.status, 'completed'); assert.equal(execution.current, true)
  assert.deepEqual(value.buildInput, execution.buildInput); assert.equal(value.buildInput.buildRequestId, requestId)
  assert.equal(value.buildInput.inputDigest, execution.inputDigest); assert.equal(value.buildInput.executionId, execution.executionId)
  const privateRoot = path.join(fixture.project, '.aily/build-executions', execution.executionId, 'project')
  const fixedAbi = await fs.readFile(path.join(privateRoot, 'project.abi'))
  assert.equal(value.buildInput.abiHash, 'sha256:' + sha(fixedAbi)); assert.deepEqual(JSON.parse(fixedAbi), evidence.nativeBefore)
  const sourceLog = path.join(fixture.project, '.log/compile/requests', sha(requestId) + '.log')
  assert.ok(inside(suite, value.resultFile))
  const source = await fs.readFile(sourceLog, 'utf8'), copy = await fs.readFile(value.resultFile, 'utf8')
  assert.equal(copy, source); assert.ok(source.startsWith('Build request: ' + requestId + '\n'))
  const lines = source.split('\n'), range = { offset: Math.max(1, lines.length - 79), limit: Math.min(80, lines.length) }
  assert.equal(value.logLineCount, lines.length); assert.deepEqual(value.readRange, range); assert.equal(value.logStatus, 'complete')
  const capturedCpp = path.join(privateRoot, 'node_modules', libraryCodeProbe.name, libraryCodeProbe.cpp)
  const stagedCpp = path.join(privateRoot, '.temp/libraries/lib-e2e-library-code-probe/AilyLibraryCodeProbe.cpp')
  assert.equal(sha(await fs.readFile(capturedCpp)), evidence.libraryEdit.cppSha256)
  assert.equal(sha(await fs.readFile(stagedCpp)), evidence.libraryEdit.cppSha256)
  const sketch = await fs.readFile(path.join(privateRoot, '.temp/sketch/sketch.ino'), 'utf8')
  assert.ok(sketch.includes('#include <AilyLibraryCodeProbe.h>') && sketch.includes('(void)ailyLibraryCodeProbe();'))
  const compileCommands = lines.map((line, index) => ({ line, index })).filter(item => /g\+\+(?:\.exe)?["'\s]/.test(item.line)
    && /(?:^|\s)["']?-c["']?(?:\s|$)/.test(item.line) && item.line.includes('AilyLibraryCodeProbe.cpp'))
  assert.ok(compileCommands.length > 0); assert.ok(source.includes('Compilation successful'))
  evidence.compilerProof = { requestId, privateRoot, abiSha256: sha(fixedAbi), inputDigest: execution.inputDigest,
    capturedCpp, stagedCpp, actualCppSha256: evidence.libraryEdit.cppSha256, sketchSha256: sha(sketch),
    compilerCommands: compileCommands.map(item => ({ line: item.index + 1, sha256: sha(item.line) })),
    sourceLog, resultFile: value.resultFile, logSha256: sha(source), readRange: range,
    independentObserverRead: true, modelLogReadRequired: false, actualCompilerConsumedChangedLibraryCpp: true }
  const state = await page.evaluate(() => { const editor = window.ng.getComponent(document.querySelector('app-blockly-editor'))
    const host = window.ng.getComponent(document.querySelector('app-child-tool-host'))
    return { project: editor.projectService.currentProjectPath, busy: editor.blocklyService.isWorkspaceEditInProgress(),
      blocked: editor.blocklyService.isWorkspaceEditBlocked(), recoveryRequired: editor.blocklyService.isWorkspaceRecoveryRequired(),
      hasRunning: host?.aiOperationProtocol?.hasRunning,
      aiNoticeCount: [...document.querySelectorAll('app-notification .notification-box')].filter(node => /AI正在操作|正在停止 AI|正在同步 AI 状态/.test(node.textContent)).length } })
  evidence.finalHost = state
  assert.equal(state.project, fixture.project); assert.equal(state.busy, false); assert.equal(state.blocked, false)
  assert.equal(state.recoveryRequired, false); assert.equal(state.hasRunning, false); assert.equal(state.aiNoticeCount, 0)
  const registryUnknown = registry.snapshot().unknownRequests
  // Preserve the actual 404s. Only these two already observed UI catalog
  // backgrounds are unrelated to npm dependency material; unknown packages,
  // versions, tarballs or any other endpoint still fail qualification.
  const backgroundRegistryRequests = registryUnknown.filter(item => item.method === 'GET'
    && ['/vc-package-versions.json', '/-/v1/search'].includes(item.path) && item.status === 404)
  const unknownDependencyRequests = registryUnknown.filter(item => !backgroundRegistryRequests.includes(item))
  evidence.registryQualification = { backgroundRegistryRequests, unknownDependencyRequests, rawRejectedRequestsPreserved: true }
  assert.deepEqual(unknownDependencyRequests, [])
  assert.deepEqual(await fingerprintLibDriverSdk(agentRoot), evidence.sdkFingerprint)
  evidence.fullNativeDocumentPreserved = true; evidence.originalProjectReopenRequired = false; evidence.ok = true
  await stage('real-library-edit-and-fixed-input-compiler-verified')
  await page.screenshot({ path: path.join(values.output, 'library-code-result.png'), fullPage: true })
} catch (error) {
  evidence.error = safeError(error)
  if (page) await page.screenshot({ path: path.join(values.output, 'failure.png'), fullPage: true }).catch(() => {})
} finally {
  await cleanup('capture-and-stop-only-exact-owned-processes', async () => {
    if (!mainIdentity) return
    const all = await processes(), main = all.find(item => item.ProcessId === mainIdentity.ProcessId)
    assertCapturedEnvironmentProcess(main, mainIdentity)
    assertCapturedEnvironmentProcess(all.find(item => item.ProcessId === actorIdentity.ProcessId), actorIdentity)
    const captured = [...new Map([...selectEnvironmentProcessTree(all, mainIdentity),
      ...selectEnvironmentProcessTree(all, actorIdentity).filter(item => item.ProcessId !== process.pid)].map(item => [item.ProcessId, item])).values()]
    evidence.cleanup = { main: mainIdentity, captured, mode: 'owned-forced-test-cleanup', gracefulCloseClaim: false }
    for (const item of captured.slice().reverse()) await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', environmentProcessStopScript(item)], { windowsHide: true, timeout: 20000 })
    const deadline = Date.now() + 30000
    let remaining
    do { remaining = remainingEnvironmentProcesses(captured, await processes()); if (!remaining.length) break; await wait(200) } while (Date.now() < deadline)
    evidence.cleanup.remaining = remaining; assert.equal(remaining.length, 0)
  })
  evidence.transport = proxy?.snapshot(); evidence.registry = registry?.snapshot()
  await cleanup('close-owned-registry', async () => registry?.close())
  await cleanup('close-owned-network-proxy', async () => proxy?.close())
  for (const [key, value] of previousEnvironment) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  for (const [file, before] of protectedFiles) await cleanup('protected-shared-file', async () => {
    const after = await fs.readFile(file).then(sha).catch(error => { if (error.code === 'ENOENT') return null; throw error })
    evidence.protectedFiles.push({ path: file, before, after }); assert.equal(after, before)
  })
  if (fixture) await cleanup('original-user-material-unchanged', async () => {
    assert.equal(sha(await fs.readFile(path.join(materialProject, 'package.json'))), fixture.originalMaterialManifestSha256)
    assert.equal(sha(await fs.readFile(path.join(materialProject, 'project.abi'))), fixture.originalMaterialAbiSha256)
  })
  if (artifact) await cleanup('installed-chat-unchanged', async () => assert.deepEqual(await verifyPortableBuild(chat.installedRoot), artifact))
  await cleanup('Host-artifact-unchanged', async () => assert.equal(sha(await fs.readFile(host.asar)), host.asarHash))
  evidence.finishedAt = new Date().toISOString(); if (evidence.cleanupFailures.length) evidence.ok = false
  await persist()
}
console.log(JSON.stringify({ ok: evidence.ok, output: values.output, model: evidence.selectedModel?.expectedEffectiveModel,
  compilerSucceeded: evidence.build?.ok === true, error: evidence.error?.message, cleanupFailures: evidence.cleanupFailures.length }))
process.exitCode = evidence.ok ? 0 : 1
