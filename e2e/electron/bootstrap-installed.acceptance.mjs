import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import nativeFs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { parseArgs, promisify, isDeepStrictEqual } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { _electron } from '@playwright/test'
import { prepareInstalledChatProfile, assertInstalledChatLoaded } from '../fixtures/installed-chat-ui.mjs'
import { selectOnlineModelFromUi, assertSelectedOnlineModel } from '../fixtures/online-model-selection.mjs'
import { createBuildLogNetwork } from './fixtures/build-log-network.mjs'
import { summarizeOnlineComparison, summarizeBuildInvocationAttempts } from './fixtures/online-comparison.mjs'
import { assertCapturedEnvironmentProcess, selectEnvironmentProcessTree,
  remainingEnvironmentProcesses, environmentProcessStopScript } from './fixtures/r2-environment-cleanup.mjs'
import { bootstrapPrompt, bootstrapPromptSha256, answerBootstrapQuestionnaire, bootstrapText,
  inspectBootstrapSession, inspectWeatherGeneratedSource, qualifyBootstrapWeatherGoal,
  bootstrapOriginalAutoSelection, bootstrapResourceAssessment, readBootstrapTerminalUi,
  readBootstrapTerminalGeneratedSource } from './fixtures/bootstrap-natural.mjs'
import { bootstrapCleanupDecision } from './fixtures/bootstrap-cleanup.mjs'
import { readBootstrapObservation, createBootstrapReadOnlyObserver } from './fixtures/bootstrap-observation.mjs'
import { resolveBootstrapResources, sharedBootstrapProtectedFiles } from './fixtures/bootstrap-resources.mjs'

// Explicit Root-owned real paid acceptance. No project is prepared or opened
// before the original user prompt. Importing the pure fixture launches nothing.
assert.equal(process.env.AILY_BOOTSTRAP_ROOT_HOST_WINDOW, '1')
assert.equal(process.env.AILY_ONLINE_ACCEPTANCE, '1')
const required = ['pair-file', 'connection-profile', 'answers-file', 'output', 'test-root', 'resource-root',
  'platform-resource-root', 'registry-origin', 'resource-origin', 'permission-mode']
const { values } = parseArgs({ options: { ...Object.fromEntries([...required, 'agent-root', 'original-session', 'npm-cache-root']
  .map(name => [name, { type: 'string' }])), 'task-timeout-ms': { type: 'string', default: '1800000' },
  'shared-platform-resources': { type: 'boolean', default: false },
  'resource-profile': { type: 'string', default: 'physical-1gib' } } })
for (const name of required.filter(name => !['registry-origin', 'resource-origin', 'permission-mode'].includes(name)))
  assert.ok(path.isAbsolute(values[name] ?? ''), '--' + name + ' must be absolute')
assert.equal(values['permission-mode'], 'full', 'This comparison preserves the original explicitly authorized full permission mode')
const timeout = Number(values['task-timeout-ms'])
assert.ok(Number.isSafeInteger(timeout) && timeout >= 60000 && timeout <= 3600000)
const resourceProfile = values['resource-profile']
assert.ok(['physical-1gib', 'windows-functional'].includes(resourceProfile))
if (resourceProfile === 'windows-functional') assert.equal(process.platform, 'win32')
const repo = fileURLToPath(new URL('../../', import.meta.url))
const agentRoot = values['agent-root'] ?? path.resolve(repo, '../aily-lex-pro/packages/aily-agent')
const lex = path.resolve(agentRoot, '../..')
const composerSerializerFile = path.join(lex, 'packages/aily-chat/ui/src/services/composer/composer-document.ts')
const { serializeComposerDocument } = await import(pathToFileURL(composerSerializerFile))
const sha = value => createHash('sha256').update(value).digest('hex')
async function fileSha(file) {
  const digest = createHash('sha256')
  for await (const chunk of nativeFs.createReadStream(file)) digest.update(chunk)
  return digest.digest('hex')
}
const memorySnapshot = () => ({ at: Date.now(), freeBytes: os.freemem(), rssBytes: process.memoryUsage().rss,
  externalBytes: process.memoryUsage().external, arrayBuffersBytes: process.memoryUsage().arrayBuffers })
const exec = promisify(execFile), wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function resourceSnapshot() {
  if (resourceProfile !== 'windows-functional') return memorySnapshot()
  const sampleStartedAt = Date.now()
  try {
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory -ErrorAction Stop | Select-Object AvailableBytes,CommitLimit,CommittedBytes | ConvertTo-Json -Compress'],
    { windowsHide: true, timeout: 15000, maxBuffer: 65536 })
    const sampled = JSON.parse(stdout)
    return { ...memorySnapshot(), platform: process.platform, windowsMemory: { sampleStartedAt, sampleCompletedAt: Date.now(),
      availablePhysicalBytes: sampled.AvailableBytes, commitLimitBytes: sampled.CommitLimit, committedBytes: sampled.CommittedBytes } }
  } catch (error) {
    return { ...memorySnapshot(), platform: process.platform, windowsMemoryError: { sampleStartedAt,
      sampleCompletedAt: Date.now(), name: error.name, code: error.code ?? null, message: String(error.message) } }
  }
}
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
const inside = (root, file) => { const relative = path.relative(root, file)
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) }
const origin = value => { const url = new URL(value)
  assert.ok(['https:', 'http:'].includes(url.protocol) && url.pathname === '/' && !url.username && !url.password && !url.search && !url.hash)
  return url.origin }
const registryOrigin = origin(values['registry-origin']), resourceOrigin = origin(values['resource-origin'])
assert.equal(registryOrigin, 'https://registry.yiyu.pro', 'Use the explicitly approved genuine package registry')
assert.equal(resourceOrigin, 'https://blockly.yiyu.pro', 'Use the explicitly approved genuine resource service')
assert.ok(inside(path.join(repo, 'e2e/test-results'), values.output))
assert.ok(inside(path.join(values['resource-root'], 'dev-tests'), values['test-root']))
const resourceTopology = await resolveBootstrapResources({ resourceRoot: values['resource-root'],
  platformRoot: values['platform-resource-root'], sharedPlatformResources: values['shared-platform-resources'],
  npmCacheRoot: values['npm-cache-root'] })
const pair = JSON.parse(await fs.readFile(values['pair-file']))
const host = JSON.parse(await fs.readFile(pair.hostReceipt)), chat = JSON.parse(await fs.readFile(pair.chatReceipt))
assert.equal(chat.ok, true)
const resourcePreflight = { profile: resourceProfile, minimumFreeBytes: resourceProfile === 'windows-functional' ? 256 * 1024 ** 2 : 1024 ** 3,
  beforeAsarHash: memorySnapshot(), asarBytes: (await fs.stat(host.asar)).size,
  hashMethod: 'streaming-sha256' }
assert.equal(await fileSha(host.asar), host.asarHash)
resourcePreflight.afterAsarHash = memorySnapshot()
const connection = JSON.parse(await fs.readFile(values['connection-profile']))
assert.equal(new URL(connection.apiBase).origin, 'https://api-test.yiyu.pro', '129 is test; 114 production is forbidden')
assert.equal(connection.model, 'auto', 'Preserve the original UI selection; the actual response route is checked separately')
assert.ok(path.isAbsolute(connection.authFile) && path.isAbsolute(connection.configFile))
assert.equal(same(connection.authFile, path.join(values['resource-root'], '.aily')), false)
const originalAnswers = JSON.parse(await fs.readFile(values['answers-file']))
assert.ok(Array.isArray(originalAnswers) && originalAnswers.length === 3)
assert.ok(originalAnswers.every(item => typeof item.question === 'string' && typeof item.answer === 'string'))
resourcePreflight.beforeLaunch = await resourceSnapshot()
resourcePreflight.launchAssessment = bootstrapResourceAssessment(resourceProfile, resourcePreflight.beforeLaunch)
assert.equal(resourcePreflight.launchAssessment.passed, true,
  'Do not launch under an already resource-starved profile: ' + JSON.stringify(resourcePreflight))
const processes = async () => {
  const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine,@{Name='CreationDate';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress"],
  { windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 ** 2 })
  const result = JSON.parse(stdout); return Array.isArray(result) ? result : [result]
}
assert.deepEqual((await processes()).filter(item => item.ExecutablePath && same(item.ExecutablePath, host.executable)), [],
  'No previous exact Host may remain')
await fs.mkdir(path.dirname(values.output), { recursive: true }); await fs.mkdir(values.output)
await fs.mkdir(values['test-root'], { recursive: true })
const suite = await fs.mkdtemp(path.join(values['test-root'], 'bootstrap-installed-'))
const appData = path.join(suite, 'appdata'), home = path.join(suite, 'home'), temp = path.join(suite, 'temp')
const agentProfile = path.join(suite, 'agent-profile'), npmCache = resourceTopology.npmCache?.realPath ?? path.join(suite, 'npm-cache')
const projectFolder = path.join(suite, 'projects'), userconfig = path.join(suite, 'bootstrap.npmrc')
for (const directory of [home, temp, agentProfile, ...(!resourceTopology.npmCache ? [npmCache] : []), projectFolder]) await fs.mkdir(directory)
let app, page, loaded, proxy, accessToken, artifact, verifyPortableBuild, mainIdentity, actorIdentity, selectedModel, snapshot, sessionId
let preserveActive = false, terminalGeneratedSource
let observationDeadline
const evidence = { ok: false, suite, host: { executable: host.executable, hash: host.asarHash }, chat: chat.artifact,
  resourcePreflight, resourceTopology,
  ...(resourceProfile === 'windows-functional' ? { performanceComparisonEligible: false,
    performanceExclusionReason: 'Explicit Windows functional capacity profile; no performance comparison is claimed' } : {}),
  originalPrompt: bootstrapPrompt, originalPromptSha256: bootstrapPromptSha256, originalAnswersSha256: sha(JSON.stringify(originalAnswers)),
  realInstalledHost: true, onlineLlm: false, syntheticProviderOutput: false, syntheticToolResults: false,
  preOpenedProject: false, seededProject: false, originalConversationReplayed: false, toolOrderInjected: false,
  skillReadGateAdded: false, permissionMode: values['permission-mode'], expectedThinkingLevel: 'off',
  expectedResponseRoute: { model: 'glm-5.3', preset: 'auto-max' },
  compiler: { backend: 'local', upstreamServicesIsCompiler: false }, runtimeHardwareNetworkingTested: false,
  resourceOrigins: { registry: registryOrigin, resource: resourceOrigin }, stages: [], answers: [], cleanupFailures: [], protectedFiles: [] }
const protectedFiles = new Map()
const safeError = error => ({ name: error.name, code: error.code, message: String(error.message)
  .replaceAll(accessToken ?? '\u0000', '[private credential]').replace(/([?&]token=|Bearer\s+)[^\s"'&]+/gi, '$1[private credential]') })
const persist = async () => { evidence.transport = proxy?.snapshot()
  const file = path.join(values.output, 'result.json'), temporary = file + '.tmp'
  await fs.writeFile(temporary, JSON.stringify(evidence, null, 2)); await fs.rename(temporary, file) }
const stage = async name => { evidence.stages.push({ name, at: Date.now() }); console.log('BOOTSTRAP_PHASE=' + name); await persist() }
const cleanup = async (name, action) => { try { await action() } catch (error) {
  evidence.ok = false; evidence.cleanupFailures.push({ name, ...safeError(error) }) } }
const uiProject = () => page.evaluate(() => {
  const element = document.querySelector('app-header')
  const service = element ? window.ng?.getComponent(element)?.projectService : undefined
  return { currentProject: service?.currentProjectPath ?? null,
    coderProjects: Array.isArray(service?.coderProjects) ? service.coderProjects.map(item => item.path) : [] }
})
const activeWork = () => page.evaluate(() => {
  const component = selector => { const element = document.querySelector(selector)
    return element ? window.ng?.getComponent(element) : undefined }
  const editor = component('app-blockly-editor'), builder = editor?._builderService
  const projectService = component('app-header')?.projectService
  const host = component('app-child-tool-host')
  return { project: editor?.projectService.currentProjectPath ?? null, buildRequestId: builder?.activeBuildRequestId ?? null,
    lifecycleOwners: projectService?.projectLifecycle?.owners?.size ?? null, hasRunning: host?.aiOperationProtocol?.hasRunning ?? false,
    streamId: builder?.streamId ?? null, buildCompleted: builder?.buildCompleted ?? null, cancelled: builder?.cancelled ?? null }
})
const observeRead = (method, fields = {}, deadline = observationDeadline) => readBootstrapObservation(
  () => loaded.e2e(method, fields), { deadline, onTimeout: async item => {
    (evidence.observationFailures ??= []).push({ ...item, method, ...(fields.sessionId ? { sessionId: fields.sessionId } : {}) })
    await persist()
  } })
async function observeSession() {
  for (const dialog of await loaded.frame.locator('.pi-extension-dialog').all()) if (await dialog.isVisible()) {
    const lines = String(await dialog.getAttribute('aria-label')).split(/\r?\n/)
    assert.equal(lines[0], 'Trust project folder?')
    assert.ok(inside(suite, lines[1]), 'Only this isolated suite can be trusted automatically')
    await dialog.getByRole('button', { name: 'Trust (this session only)', exact: true }).click()
  }
  const answered = await answerBootstrapQuestionnaire(loaded.frame, originalAnswers)
  if (answered) { evidence.answers.push(answered); await persist() }
  if (!sessionId) {
    const listed = await observeRead('session.list')
    const candidates = []
    for (const item of listed.sessions) {
      const candidate = (await observeRead('session.read', { sessionId: item.sessionId })).session
      if (candidate.messages.some(message => message.role === 'user' && bootstrapText(message) === bootstrapPrompt)) candidates.push(candidate)
    }
    assert.ok(candidates.length <= 1, 'Do not select another session or duplicate prompt')
    if (!candidates.length) return undefined
    sessionId = candidates[0].sessionId; evidence.sessionId = sessionId
  }
  // Creating the project changes cwd. The original session identity is the
  // authority for this observation; never replace it with a new empty session.
  const result = (await observeRead('session.read', { sessionId })).session
  assert.equal(result.sessionId, sessionId); assertSelectedOnlineModel(result, selectedModel)
  assert.equal(result.thinkingLevel, 'off')
  assert.equal(result.permissionMode, 'full')
  return result
}
async function selectOriginalSettings() {
  const frame = loaded.frame
  // The real Auto action selects thinking=off. Max's reasoning submenu does
  // not offer Off and is not the original user's selection.
  const modelSelection = await selectOnlineModelFromUi(frame, selectedModel, { catalogTimeoutMs: 60000 })
  await frame.locator('.permission-mode-indicator').click()
  const full = frame.locator('.popup-menu-permission button').filter({ has: frame.locator('i.fa-triangle-exclamation') })
  assert.equal(await full.count(), 1); await full.click()
  const confirmation = frame.locator('.full-access-permission-dialog')
  await confirmation.waitFor({ state: 'visible', timeout: 5000 })
  await confirmation.locator('input[type="checkbox"]').uncheck()
  await confirmation.locator('.confirm-btn').click()
  await confirmation.waitFor({ state: 'hidden', timeout: 5000 })
  // Confirmation closes before settings.update finishes. The normal indicator
  // changes after permission.default.set settles; sending earlier can capture
  // the previous permissionMode when the first session is created.
  await frame.locator('.permission-mode-indicator i.fa-triangle-exclamation').waitFor({ state: 'visible', timeout: 5000 })
  evidence.settingsSelectedViaVisibleUi = { ...modelSelection, modelPreset: selectedModel.id,
    thinkingLevel: 'off', thinkingVerifiedBy: 'actual-session-snapshot-and-task-thinking',
    permissionMode: 'full', rememberedPermission: false,
    permissionVerifiedBy: 'rendered-full-indicator-after-settings-update',
    permissionIndicatorText: await frame.locator('.permission-mode-indicator').innerText(), permissionAppliedAt: Date.now() }
}

try {
  await stage('read-only-129-preflight-and-private-profile')
  const sharedFiles = resourceTopology.mode === 'shared-daily' ? await sharedBootstrapProtectedFiles(values['resource-root']) : []
  for (const file of new Set([values['connection-profile'], connection.configFile, connection.authFile,
    path.join(values['resource-root'], 'config.json'), path.join(values['resource-root'], '.aily'),
    path.join(values['resource-root'], 'npm-global/app/store/subapp-aily-chat/active.json'),
    path.join(values['resource-root'], 'npm-global/app/subapp-index.json'), values['answers-file'], values['original-session'], ...sharedFiles].filter(Boolean)))
    protectedFiles.set(file, await fs.readFile(file).then(sha).catch(error => { if (error.code === 'ENOENT') return null; throw error }))
  if (values['original-session']) evidence.originalFailurePreserved = { sha256: protectedFiles.get(values['original-session']), readonlyInput: true }
  const config = JSON.parse(await fs.readFile(connection.configFile)), auth = JSON.parse(await fs.readFile(connection.authFile))
  assert.equal(new URL(config.regions[config.region].api_server).origin, connection.apiBase)
  accessToken = auth.access_token; assert.ok(typeof accessToken === 'string' && accessToken)
  proxy = await createBuildLogNetwork({ upstreamOrigin: connection.apiBase, upstreamAddress: '129.204.34.159' })
  const headers = { authorization: 'Bearer ' + accessToken }
  const quotaResponse = await fetch(proxy.origin + '/api/v3/interaction_quotas/snapshot', { headers, signal: AbortSignal.timeout(15000) })
  assert.equal(quotaResponse.status, 200)
  const quota = await quotaResponse.json()
  evidence.quota = { monthlyRemaining: quota.quotaSnapshots?.chat_monthly?.remaining,
    dailyRemaining: quota.quotaSnapshots?.daily_interactions?.remaining, rateLimited: quota.rateLimited }
  assert.ok(evidence.quota.monthlyRemaining >= 0.5); assert.equal(evidence.quota.rateLimited, false)
  const catalogResponse = await fetch(proxy.origin + '/api/v2/model_catalog', { headers, signal: AbortSignal.timeout(15000) })
  assert.equal(catalogResponse.status, 200)
  const catalog = await catalogResponse.json(); selectedModel = bootstrapOriginalAutoSelection(catalog)
  evidence.selectedModel = { ...selectedModel, expectedEffectiveModel: 'glm-5.3', catalogSha256: sha(JSON.stringify(catalog)) }
  const profile = await prepareInstalledChatProfile({ appData, installedRoot: chat.installedRoot, apiBase: proxy.origin,
    baseConfigPath: connection.configFile, resourceAppData: values['platform-resource-root'], token: accessToken })
  profile.config.compile = { ...profile.config.compile, backend: 'local' }
  profile.config.project_path = projectFolder; profile.config.recentlyProjects = []
  for (const region of Object.values(profile.config.regions ?? {})) {
    for (const key of ['npm_registry', 'npm_registry_linux', 'npm_registry_coder']) region[key] = registryOrigin
    region.resource = resourceOrigin
  }
  profile.config.resource_sources = [{ key: 'localhost', url: resourceOrigin, enabled: true }]
  await fs.writeFile(path.join(appData, 'config.json'), JSON.stringify(profile.config, null, 2))
  const npmrc = 'registry=' + registryOrigin + '\n@aily-project:registry=' + registryOrigin
    + '\nreplace-registry-host=always\nignore-scripts=true\naudit=false\nfund=false\n'
  await fs.writeFile(userconfig, npmrc, { flag: 'wx' }); await fs.writeFile(path.join(appData, '.npmrc'), npmrc)
  const permission = { '*': 'allow', project_upload: 'deny', project_fork: 'deny',
    external_directory: { '*': 'deny', [suite + '/*']: 'allow', [chat.installedRoot + '/*']: 'allow' },
    path: { '*': 'allow', [path.join(appData, '.aily')]: 'deny', [connection.authFile]: 'deny', [connection.configFile]: 'deny',
      [values['connection-profile']]: 'deny', [values['answers-file']]: 'deny', [path.join(values['resource-root'], '.aily')]: 'deny' } }
  const policy = path.join(agentProfile, 'extensions/pi-permission-system/config.json')
  await fs.mkdir(path.dirname(policy), { recursive: true }); await fs.writeFile(policy, JSON.stringify({ permission }), { flag: 'wx' })
  evidence.permissionPolicy = { normalLocalToolsAllowed: true, originalFullModeSelectedViaUi: true,
    credentialPathsConfiguredDeny: true, fullModeMayOverrideApprovalPolicy: true, actualWorkspaceOwnershipProtectionRemains: true }
  ;({ verifyPortableBuild } = await import(pathToFileURL(path.join(lex, 'packages/aily-chat/server/portable-integrity.ts'))))
  artifact = await verifyPortableBuild(chat.installedRoot)
  assert.equal(artifact.inputHash, chat.artifact.inputHash); assert.equal(artifact.outputHash, chat.artifact.outputHash)
  const { captureBuildInputs } = await import(pathToFileURL(path.join(lex, 'packages/aily-chat/scripts/portable-build-inputs.mjs')))
  assert.equal(artifact.inputHash, sha(JSON.stringify(await captureBuildInputs(lex))))
  const { ELECTRON_RUN_AS_NODE, AILY_CHILD_PATH, NODE_PATH, AILY_PORTABLE_ROOT, AILY_AUTH_FILE,
    HTTP_PROXY, HTTPS_PROXY, ALL_PROXY, http_proxy, https_proxy, all_proxy, ...environment } = process.env
  await stage('cold-empty-desktop-and-installed-chat')
  app = await _electron.launch({ executablePath: host.executable, cwd: repo, timeout: 60000,
    args: [`--user-data-dir=${path.join(suite, 'chromium-profile')}`], env: { ...environment, ...profile.env,
      AILY_E2E: '1', HOME: home, USERPROFILE: home, TEMP: temp, TMP: temp, PI_CODING_AGENT_DIR: agentProfile,
      NPM_CONFIG_CACHE: npmCache, npm_config_cache: npmCache, NPM_CONFIG_USERCONFIG: userconfig, npm_config_userconfig: userconfig,
      NPM_CONFIG_REGISTRY: registryOrigin, npm_config_registry: registryOrigin, NPM_CONFIG_OFFLINE: 'false', npm_config_offline: 'false',
      NPM_CONFIG_IGNORE_SCRIPTS: 'true', npm_config_ignore_scripts: 'true', NPM_CONFIG_AUDIT: 'false', NPM_CONFIG_FUND: 'false' } })
  const hostPid = await app.evaluate(() => process.pid), all = await processes()
  mainIdentity = all.find(item => item.ProcessId === hostPid); actorIdentity = all.find(item => item.ProcessId === process.pid)
  assert.ok(mainIdentity && actorIdentity); assert.ok(same(mainIdentity.ExecutablePath, host.executable))
  assert.ok(mainIdentity.CommandLine.includes(path.join(suite, 'chromium-profile')))
  evidence.host.pid = hostPid; evidence.mainIdentity = mainIdentity; await persist()
  for (const stream of ['stdout', 'stderr']) app.process()[stream]?.pipe(nativeFs.createWriteStream(path.join(values.output, 'main-' + stream + '.log')))
  await app.context().route('**/*', async route => {
    const request = route.request(), url = new URL(request.url())
    if (!['http:', 'https:'].includes(url.protocol) || ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return route.continue()
    if ([registryOrigin, resourceOrigin].includes(url.origin) && ['GET', 'HEAD'].includes(request.method())) return route.continue()
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
  await page.waitForFunction(() => { const element = document.querySelector('app-header')
    return element && window.ng?.getComponent(element)?.projectService })
  evidence.emptyDesktopBeforeChat = await uiProject()
  assert.ok(!evidence.emptyDesktopBeforeChat.currentProject); assert.deepEqual(evidence.emptyDesktopBeforeChat.coderProjects, [])
  assert.deepEqual(await fs.readdir(projectFolder), [])
  loaded = await assertInstalledChatLoaded(page, { installedRoot: chat.installedRoot, expectedApiBase: proxy.origin,
    expectedInputHash: chat.artifact.inputHash, expectedOutputHash: chat.artifact.outputHash })
  loaded.e2e = createBootstrapReadOnlyObserver(loaded.frame.url(), { onFailure: async reply => {
    (evidence.observationReplies ??= []).push(reply); await persist()
  } })
  evidence.installedChat = loaded.evidence; assert.equal(await app.evaluate(({ app }) => app.isPackaged), true)
  const initialSessions = (await loaded.e2e('session.list')).sessions
  for (const item of initialSessions) {
    const state = (await loaded.e2e('session.read', { sessionId: item.sessionId })).session
    assert.equal(state.messages.filter(message => message.role === 'user').length, 0, 'Do not reuse an existing user conversation')
  }
  await selectOriginalSettings()
  evidence.emptyDesktopBeforePrompt = await uiProject(); assert.ok(!evidence.emptyDesktopBeforePrompt.currentProject)
  assert.deepEqual(await fs.readdir(projectFolder), [])
  const input = loaded.frame.locator('.aily-chat-composer-input[role="textbox"]'), send = loaded.frame.locator('button.primary-action.send-action')
  await input.fill(bootstrapPrompt); await send.waitFor({ state: 'visible' }); assert.equal(await send.isEnabled(), true)
  // Tiptap paragraphs have layout-dependent innerText separators. Read the
  // actual editor document without mutating it and use the product's onUpdate /
  // Enter serializer, which is the source of the send button's draft.
  const composer = await input.evaluate(element => ({ document: element.editor?.getJSON() ?? null,
    layoutText: element.innerText }))
  assert.ok(composer.document, 'Read the actual Tiptap document; never substitute DOM layout text')
  const serializedPrompt = serializeComposerDocument(composer.document)
  evidence.composerInput = { method: 'normal-contenteditable-fill', actualTiptapDocumentRead: true,
    serializer: 'serializeComposerDocument', serializerSourceSha256: sha(await fs.readFile(composerSerializerFile)),
    documentSha256: sha(JSON.stringify(composer.document)), serializedPromptSha256: sha(serializedPrompt),
    originalPromptSha256: bootstrapPromptSha256, serializedUtf8Bytes: Buffer.byteLength(serializedPrompt),
    serializedNewlineCount: serializedPrompt.match(/\n/g)?.length ?? 0,
    layoutTextSha256: sha(composer.layoutText), layoutNewlineCount: composer.layoutText.match(/\n/g)?.length ?? 0 }
  await persist()
  assert.equal(serializedPrompt, bootstrapPrompt, 'The product serializer must preserve the original user request byte for byte')
  resourcePreflight.beforePaidSubmission = await resourceSnapshot()
  resourcePreflight.paidSubmissionAssessment = bootstrapResourceAssessment(resourceProfile, resourcePreflight.beforePaidSubmission)
  await persist()
  assert.equal(resourcePreflight.paidSubmissionAssessment.passed, true,
    'Minimum resource profile is unavailable before the paid submission: ' + JSON.stringify(resourcePreflight))
  await stage('original-natural-request-from-empty-desktop')
  evidence.submittedAt = Date.now(); evidence.transportStartRequestIndex = proxy.snapshot().requests.length; await persist()
  evidence.submissionAttemptedAt = Date.now(); observationDeadline = evidence.submissionAttemptedAt + timeout; await persist()
  await send.click({ timeout: 5000 }); evidence.onlineLlm = true
  const deadline = observationDeadline; let checkpointAt = 0
  while (Date.now() < deadline) {
    snapshot = await observeSession()
    const final = snapshot?.messages.filter(message => message.role === 'assistant').at(-1)
    if (snapshot?.isIdle && !snapshot.isStreaming && ['stop', 'error', 'aborted'].includes(final?.stopReason)) break
    if (Date.now() >= checkpointAt) { checkpointAt = Date.now() + 5000; evidence.lastObservedSessionId = snapshot?.sessionId
      evidence.currentUiProject = await uiProject(); await persist() }
    await wait(350)
  }
  evidence.settledAt = Date.now()
  if (snapshot) await fs.writeFile(path.join(values.output, 'natural-session.json'), JSON.stringify(snapshot, null, 2))
  const terminal = snapshot?.messages.filter(message => message.role === 'assistant').at(-1)
  if (snapshot?.isIdle && !snapshot.isStreaming && ['stop', 'error', 'aborted'].includes(terminal?.stopReason)) {
    try {
      const observed = await page.evaluate(readBootstrapTerminalUi)
      evidence.preAssertionFinalHost = { observedAt: Date.now(), ...observed.finalHost }
      evidence.finalHost = observed.finalHost
      evidence.preAssertionNative = { captureError: observed.captureError, project: observed.finalHost.project }
      if (observed.documentText && observed.finalHost.project && inside(suite, observed.finalHost.project)) {
        const native = JSON.parse(observed.documentText), file = path.join(values.output, 'pre-assert-native-document.json')
        const documentBytes = JSON.stringify(native, null, 2)
        await fs.writeFile(file, documentBytes)
        await fs.writeFile(path.join(values.output, 'final-native-document.json'), documentBytes)
        Object.assign(evidence.preAssertionNative, { file, fileSha256: sha(documentBytes), documentSha256: sha(JSON.stringify(native)) })
        const diskFile = path.join(observed.finalHost.project, 'project.abi'), disk = await fs.readFile(diskFile)
        Object.assign(evidence.preAssertionNative, { diskFile, diskSha256: sha(disk),
          completeDocumentMatchesDisk: isDeepStrictEqual(native, JSON.parse(disk)) })
        terminalGeneratedSource = await page.evaluate(readBootstrapTerminalGeneratedSource)
        evidence.generatedSourceFile = path.join(values.output, 'final-generated-source.cpp')
        await fs.writeFile(evidence.generatedSourceFile, terminalGeneratedSource)
        evidence.generatedSourceSha256 = sha(terminalGeneratedSource)
        evidence.generatedGoal = inspectWeatherGeneratedSource(terminalGeneratedSource)
      }
    } catch (error) { evidence.preAssertionObservationError = safeError(error) }
    await persist()
  }
  assert.ok(snapshot?.isIdle && !snapshot.isStreaming, 'The original task exceeded the observer deadline; do not call it a product timeout or successful compile')
  const facts = inspectBootstrapSession(snapshot)
  evidence.actualSubmittedPromptSha256 = facts.userPrompts.map(prompt => sha(prompt))
  evidence.completedBuildResults = facts.completedBuilds.map(item => item.result)
  evidence.build = facts.completedBuilds.at(-1)?.result
  evidence.final = { stopReason: facts.final?.stopReason, text: facts.finalText }
  evidence.lifecycle = { creates: facts.creates, successfulCreates: facts.successfulCreates.length,
    manualLifecycleHandoff: facts.manualLifecycleHandoff, switchCalls: facts.projectSwitchCalls.map(item => ({ name: item.actualName, args: item.actualArguments })) }
  evidence.buildInvocations = summarizeBuildInvocationAttempts(snapshot)
  evidence.comparison = summarizeOnlineComparison(snapshot, { startedAt: evidence.submittedAt, expectedModel: 'glm-5.3',
    expectedPreset: 'auto-max', transport: proxy.snapshot(), businessActionNames: ['project_create', 'lib_add', 'abs_apply', 'project_build'] })
  evidence.modelQualification = { status: evidence.comparison.modelEvidenceValid ? 'matched' : 'ineligible',
    selectedUiModel: selectedModel.id, expectedResponseRoute: evidence.expectedResponseRoute,
    actualResponseModels: evidence.comparison.effectiveModels,
    actualResponsePresets: [...new Set(evidence.comparison.samples.map(item => item.preset ?? null))],
    fallbackAttempted: false }
  assert.ok(evidence.comparison.taskThinking.complete && evidence.comparison.thinkingLevels.length > 0
    && evidence.comparison.thinkingLevels.every(level => level === 'off'))
  assert.deepEqual(facts.userPrompts, [bootstrapPrompt]); assert.equal(facts.final?.stopReason, 'stop')
  assert.equal(facts.successfulCreates.length, 1); assert.equal(facts.manualLifecycleHandoff, false)
  assert.equal(facts.calls.some(call => ['project_fork', 'project_upload'].includes(call.actualName)), false)
  const finalUi = await uiProject(), project = finalUi.currentProject
  assert.ok(project && inside(projectFolder, project)); evidence.project = project
  const projectDirectories = await fs.readdir(projectFolder, { withFileTypes: true })
  assert.deepEqual(projectDirectories.filter(item => item.isDirectory()).map(item => item.name), [path.basename(project)])
  const manifest = JSON.parse(await fs.readFile(path.join(project, 'package.json')))
  assert.equal(manifest.dependencies?.['@aily-project/board-arduino_uno_r4_wifi'], '1.5.3')
  evidence.projectManifest = manifest
  const native = JSON.parse(await page.evaluate(() => window.ng.getComponent(document.querySelector('app-blockly-editor'))
    .blocklyService.captureRecoverySnapshot().documentText))
  const abi = await fs.readFile(path.join(project, 'project.abi'))
  assert.deepEqual(JSON.parse(abi), native); evidence.nativeDocumentSha256 = sha(JSON.stringify(native)); evidence.abiSha256 = sha(abi)
  await fs.writeFile(path.join(values.output, 'final-native-document.json'), JSON.stringify(native, null, 2))
  const generated = terminalGeneratedSource
  assert.equal(typeof generated, 'string', 'The actual terminal source must be captured before acceptance assertions')
  evidence.generatedSourceSha256 = sha(generated); evidence.generatedGoal = inspectWeatherGeneratedSource(generated)
  assert.ok(facts.completedBuilds.length > 0, 'No successful compiler work can be inferred from a loaded tool or prose')
  const completed = facts.completedBuilds.at(-1).result; evidence.build = completed
  assert.equal(completed.ok, true); assert.equal(completed.verification?.status, 'passed')
  const requestId = completed.buildReceipt.requestId
  assert.ok(same(completed.buildReceipt.project, project)); assert.equal(completed.targetPid, hostPid)
  const execution = await page.evaluate(({ project, requestId }) => window.builder.inspectBuildExecution(project, requestId), { project, requestId })
  evidence.execution = execution; assert.equal(execution.buildRequestId, requestId); assert.equal(execution.status, 'completed')
  assert.deepEqual(completed.buildInput, execution.buildInput); assert.equal(completed.buildInput.buildRequestId, requestId)
  assert.equal(completed.buildInput.inputDigest, execution.inputDigest); assert.equal(completed.buildInput.executionId, execution.executionId)
  const privateRoot = path.join(project, '.aily/build-executions', execution.executionId, 'project')
  const privateAbi = await fs.readFile(path.join(privateRoot, 'project.abi'))
  assert.equal(completed.buildInput.abiHash, 'sha256:' + sha(privateAbi)); assert.deepEqual(JSON.parse(privateAbi), native)
  const sketch = await fs.readFile(path.join(privateRoot, '.temp/sketch/sketch.ino'), 'utf8')
  evidence.compilerInputGoal = inspectWeatherGeneratedSource(sketch)
  const canonical = path.join(project, '.log/compile/requests', sha(requestId) + '.log')
  assert.ok(path.isAbsolute(completed.resultFile) && inside(suite, completed.resultFile))
  const source = await fs.readFile(canonical, 'utf8'), copy = await fs.readFile(completed.resultFile, 'utf8')
  assert.equal(source, copy); assert.ok(source.startsWith('Build request: ' + requestId + '\n'))
  assert.ok(source.includes('Compilation successful')); assert.match(source, /arm-none-eabi-g\+\+/)
  const lines = copy.split('\n'), range = completed.readRange
  assert.ok(Number.isSafeInteger(range?.offset) && range.offset >= 1 && Number.isSafeInteger(range.limit) && range.limit > 0)
  assert.equal(completed.logLineCount, lines.length); assert.equal(completed.logStatus, 'complete')
  const selectedLines = lines.slice(range.offset - 1, range.offset - 1 + range.limit)
  for (const terminal of lines.filter(line => line.trim()).slice(-3)) assert.ok(selectedLines.includes(terminal))
  evidence.compilerProof = { requestId, privateRoot, inputDigest: execution.inputDigest, abiSha256: sha(privateAbi),
    sketchSha256: sha(sketch), canonical, resultFile: completed.resultFile, logSha256: sha(copy),
    readRange: range, selectedUtf8Bytes: Buffer.byteLength(selectedLines.join('\n')), terminalLinesPresent: true,
    independentObserverRead: true, actualCoreReadClaim: false, modelLogReadRequired: false, generatedProgramConsumedByCompiler: true }
  evidence.finalHost = await page.evaluate(() => { const editor = window.ng.getComponent(document.querySelector('app-blockly-editor'))
    const host = window.ng.getComponent(document.querySelector('app-child-tool-host'))
    return { project: editor.projectService.currentProjectPath, busy: editor.blocklyService.isWorkspaceEditInProgress(),
      blocked: editor.blocklyService.isWorkspaceEditBlocked(), recoveryRequired: editor.blocklyService.isWorkspaceRecoveryRequired(),
      hasRunning: host?.aiOperationProtocol?.hasRunning,
      aiNoticeCount: [...document.querySelectorAll('app-notification .notification-box')].filter(node => /AI正在操作|正在停止 AI|正在同步 AI 状态/.test(node.textContent)).length } })
  assert.equal(evidence.finalHost.busy, false); assert.equal(evidence.finalHost.blocked, false)
  assert.equal(evidence.finalHost.recoveryRequired, false); assert.equal(evidence.finalHost.hasRunning, false); assert.equal(evidence.finalHost.aiNoticeCount, 0)
  evidence.sameOriginalSession = snapshot.sessionId === sessionId
  evidence.fullNativeDocumentAndCompilerInputVerified = true; evidence.userManualLifecycleRequired = false
  evidence.technicalPipelinePassed = true
  evidence.goalQualification = qualifyBootstrapWeatherGoal(evidence.generatedGoal, evidence.compilerInputGoal)
  evidence.qualificationIncomplete = evidence.goalQualification.status !== 'verified' || evidence.modelQualification.status !== 'matched'
  evidence.ok = !evidence.qualificationIncomplete
  await stage(evidence.ok ? 'original-new-project-weather-task-verified' : 'compiler-pipeline-verified-comparison-qualification-incomplete')
  await page.screenshot({ path: path.join(values.output, 'result.png'), fullPage: true })
} catch (error) {
  evidence.error = safeError(error)
  if (snapshot) await fs.writeFile(path.join(values.output, 'natural-session.json'), JSON.stringify(snapshot, null, 2)).catch(() => {})
  if (page) await page.screenshot({ path: path.join(values.output, 'failure.png'), fullPage: true }).catch(() => {})
} finally {
  // A test observer deadline is not a cancellation request. Keep the accepted
  // model/Host/compiler and transparent proxy alive for Root to observe the same
  // operation. The bounded lease expires by closing only this proxy; it never
  // kills or cancels active product work and never marks the raw case passed.
  if (mainIdentity) {
    const state = page ? await activeWork().catch(() => null) : null
    let latest, sessionObserved = false
    if (loaded && sessionId) try { latest = (await observeRead('session.read', { sessionId })).session; sessionObserved = true } catch { /* Unknown is preserved. */ }
    evidence.cleanupDecision = bootstrapCleanupDecision({ hostStarted: true, submissionAttempted: Boolean(evidence.submissionAttemptedAt),
      hostState: state, session: latest, sessionObserved })
    preserveActive = !evidence.cleanupDecision.allowed
    if (preserveActive) {
      evidence.ok = false; evidence.cleanupDeferred = { reason: 'original-accepted-work-still-active',
        noStopOrKillSent: true, originalSessionId: sessionId ?? null, state, proxyOrigin: proxy?.origin,
        actorPid: process.pid, boundedProxyLeaseMs: 20 * 60 * 1000 }
      await persist()
      setTimeout(() => { void (async () => {
        evidence.cleanupDeferred.proxyLeaseExpiredAt = Date.now()
        await proxy?.close(); await persist()
      })().catch(error => console.error('BOOTSTRAP_PROXY_LEASE_ERROR=' + safeError(error).message)) }, 20 * 60 * 1000)
      console.log('BOOTSTRAP_ACTIVE_WORK_PRESERVED=' + path.join(values.output, 'result.json'))
    }
  }
  if (!preserveActive) {
  await cleanup('capture-and-stop-only-exact-owned-processes', async () => {
    if (!mainIdentity) return
    const all = await processes(), currentMain = all.find(item => item.ProcessId === mainIdentity.ProcessId)
    if (currentMain) assertCapturedEnvironmentProcess(currentMain, mainIdentity)
    assertCapturedEnvironmentProcess(all.find(item => item.ProcessId === actorIdentity.ProcessId), actorIdentity)
    const captured = [...new Map([...(currentMain ? selectEnvironmentProcessTree(all, mainIdentity) : []),
      ...selectEnvironmentProcessTree(all, actorIdentity).filter(item => item.ProcessId !== process.pid)]
      .map(item => [item.ProcessId, item])).values()]
    evidence.cleanup = { main: mainIdentity, captured, mode: 'owned-forced-test-cleanup', gracefulCloseClaim: false, errors: [] }
    await persist()
    // Stop the validated Main first so it cannot respawn descendants. A gone
    // transient identity cannot prevent cleanup of other strongly owned nodes.
    const ordered = [...captured.filter(item => item.ProcessId === mainIdentity.ProcessId),
      ...captured.filter(item => item.ProcessId !== mainIdentity.ProcessId).reverse()]
    for (const item of ordered) try {
      await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', environmentProcessStopScript(item)], { windowsHide: true, timeout: 20000 })
    } catch (error) { evidence.cleanup.errors.push({ pid: item.ProcessId, ...safeError(error) }) }
    const deadline = Date.now() + 30000; let remaining
    do { remaining = remainingEnvironmentProcesses(captured, await processes()); if (!remaining.length) break; await wait(200) } while (Date.now() < deadline)
    evidence.cleanup.remaining = remaining; assert.equal(remaining.length, 0); assert.deepEqual(evidence.cleanup.errors, [])
  })
  evidence.transport = proxy?.snapshot(); await cleanup('close-owned-network-proxy', async () => proxy?.close())
  }
  for (const [file, before] of protectedFiles) await cleanup('protected-original-or-shared-file', async () => {
    const after = await fs.readFile(file).then(sha).catch(error => { if (error.code === 'ENOENT') return null; throw error })
    evidence.protectedFiles.push({ path: file, before, after }); assert.equal(after, before)
  })
  if (artifact) await cleanup('installed-chat-unchanged', async () => assert.deepEqual(await verifyPortableBuild(chat.installedRoot), artifact))
  await cleanup('Host-artifact-unchanged', async () => assert.equal(await fileSha(host.asar), host.asarHash))
  evidence.finishedAt = new Date().toISOString(); if (evidence.cleanupFailures.length) evidence.ok = false
  await persist()
}
console.log(JSON.stringify({ ok: evidence.ok, output: values.output, selectedUiModel: evidence.selectedModel?.id,
  actualResponseModels: evidence.comparison?.effectiveModels, modelQualification: evidence.modelQualification?.status,
  compilerSucceeded: evidence.build?.ok === true, error: evidence.error?.message, cleanupFailures: evidence.cleanupFailures.length }))
process.exitCode = evidence.ok ? 0 : 1
