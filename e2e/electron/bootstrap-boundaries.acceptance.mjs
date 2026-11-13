import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import nativeFs from 'node:fs'
import path from 'node:path'
import { parseArgs, promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { _electron } from '@playwright/test'
import { prepareInstalledChatProfile, assertInstalledChatLoaded, createLocalChatApiRouter } from '../fixtures/installed-chat-ui.mjs'
import { assertCapturedEnvironmentProcess, selectEnvironmentProcessTree, remainingEnvironmentProcesses,
  environmentProcessStopScript } from './fixtures/r2-environment-cleanup.mjs'
import { prepareBootstrapBoundaryProject, runBootstrapDirectBoundary, createBootstrapBoundaryProvider,
  runBootstrapUiBoundary, boundaryHostState } from './fixtures/bootstrap-boundaries.mjs'
import { bootstrapCleanupDecision } from './fixtures/bootstrap-cleanup.mjs'
import { readBootstrapObservation, createBootstrapReadOnlyObserver } from './fixtures/bootstrap-observation.mjs'

assert.equal(process.env.AILY_BOOTSTRAP_ROOT_HOST_WINDOW, '1', 'Root owns the actual Host window')
const required = ['pair-file', 'connection-profile', 'output', 'test-root', 'resource-root', 'platform-resource-root', 'scenario']
const { values } = parseArgs({ options: Object.fromEntries([...required, 'agent-root'].map(name => [name, { type: 'string' }])) })
for (const name of required.filter(name => name !== 'scenario')) assert.ok(path.isAbsolute(values[name] ?? ''), '--' + name + ' must be absolute')
const scenario = values.scenario; assert.ok(['first-open', 'candidate-switch', 'candidate-stop', 'stop-before', 'stop-host', 'reconnect'].includes(scenario))
const repo = fileURLToPath(new URL('../../', import.meta.url)), agentRoot = values['agent-root'] ?? path.resolve(repo, '../aily-lex-pro/packages/aily-agent')
const sha = value => createHash('sha256').update(value).digest('hex')
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
const inside = (root, file) => { const rel = path.relative(root, file)
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel) }
assert.ok(inside(path.join(repo, 'e2e/test-results'), values.output))
assert.ok(inside(path.join(values['resource-root'], 'dev-tests'), values['test-root']))
assert.equal(inside(values['resource-root'], values['platform-resource-root']), false)
for (const relative of ['sdk', 'tools', 'compiler', 'node_modules', 'npm-global/node_modules'])
  assert.ok(inside(values['platform-resource-root'], await fs.realpath(path.join(values['platform-resource-root'], relative))))
const pair = JSON.parse(await fs.readFile(values['pair-file']))
const host = JSON.parse(await fs.readFile(pair.hostReceipt)), chat = JSON.parse(await fs.readFile(pair.chatReceipt))
assert.equal(chat.ok, true); assert.equal(sha(await fs.readFile(host.asar)), host.asarHash)
const connection = JSON.parse(await fs.readFile(values['connection-profile']))
assert.ok(path.isAbsolute(connection.configFile) && path.isAbsolute(connection.authFile))
const exec = promisify(execFile), wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const processes = async () => { const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine,@{Name='CreationDate';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress"],
{ windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 ** 2 }); const result = JSON.parse(stdout); return Array.isArray(result) ? result : [result] }
assert.deepEqual((await processes()).filter(item => item.ExecutablePath && same(item.ExecutablePath, host.executable)), [], 'Do not overlap another exact Host')
await fs.mkdir(path.dirname(values.output), { recursive: true }); await fs.mkdir(values.output)
await fs.mkdir(values['test-root'], { recursive: true })
const suite = await fs.mkdtemp(path.join(values['test-root'], 'bootstrap-' + scenario + '-'))
const appData = path.join(suite, 'appdata'), home = path.join(suite, 'home'), temp = path.join(suite, 'temp')
const profileRoot = path.join(suite, 'agent-profile'), projectParent = path.join(suite, 'projects'), project = path.join(projectParent, 'original')
const npmCache = path.join(suite, 'npm-cache'), userconfig = path.join(suite, 'bootstrap.npmrc')
for (const directory of [home, temp, profileRoot, projectParent, npmCache]) await fs.mkdir(directory)
const evidence = { ok: false, scenario, suite, host: { executable: host.executable, hash: host.asarHash }, chat: chat.artifact,
  actualInstalledHost: true, actualInstalledChat: true, realOnlineModelInvoked: false, real129ProviderInvoked: false,
  deterministicProviderForUiBoundary: scenario !== 'first-open', actualCompilerInvoked: false,
  fabricatedToolResults: false, preOpenedProject: false, stages: [], cleanupFailures: [], protectedFiles: [] }
let app, page, loaded, provider, router, artifact, verifyPortableBuild, mainIdentity, actorIdentity, preserveActive = false
const protectedFiles = new Map(), oldEnvironment = new Map()
const safeError = error => ({ name: error.name, code: error.code,
  message: String(error.message).replace(/([?&]token=|Bearer\s+)[^\s"'&]+/gi, '$1[private credential]') })
const persist = async () => { evidence.transport = provider?.snapshot(); evidence.router = router?.snapshot()
  const file = path.join(values.output, 'result.json'), temporary = file + '.tmp'
  await fs.writeFile(temporary, JSON.stringify(evidence, null, 2)); await fs.rename(temporary, file) }
const stage = async name => { evidence.stages.push({ name, at: Date.now() }); console.log('BOOTSTRAP_BOUNDARY_PHASE=' + name); await persist() }
const cleanup = async (name, action) => { try { await action() } catch (error) {
  evidence.ok = false; evidence.cleanupFailures.push({ name, ...safeError(error) }) } }
const assignEnvironment = environment => { for (const [key, value] of Object.entries(environment)) {
  oldEnvironment.set(key, process.env[key]); if (value === undefined) delete process.env[key]; else process.env[key] = value } }
try {
  for (const file of new Set([values['connection-profile'], connection.authFile, connection.configFile,
    path.join(values['resource-root'], 'config.json'), path.join(values['resource-root'], '.aily'),
    path.join(values['resource-root'], 'npm-global/app/store/subapp-aily-chat/active.json'), path.join(values['resource-root'], 'npm-global/app/subapp-index.json')]))
    protectedFiles.set(file, await fs.readFile(file).then(sha).catch(error => { if (error.code === 'ENOENT') return null; throw error }))
  await stage('prepare-owned-unopened-target-and-local-provider')
  evidence.fixture = await prepareBootstrapBoundaryProject({ project, platformRoot: values['platform-resource-root'] })
  if (scenario !== 'first-open') provider = await createBootstrapBoundaryProvider({ scenario, project, projectParent })
  router = await createLocalChatApiRouter({ operationOrigin: provider?.origin, installedRoot: chat.installedRoot })
  const profile = await prepareInstalledChatProfile({ appData, installedRoot: chat.installedRoot, apiBase: router.origin,
    baseConfigPath: connection.configFile, resourceAppData: values['platform-resource-root'] })
  profile.config.project_path = projectParent; profile.config.recentlyProjects = []; profile.config.compile = { ...profile.config.compile, backend: 'local' }
  for (const region of Object.values(profile.config.regions)) {
    for (const key of ['npm_registry', 'npm_registry_linux', 'npm_registry_coder']) region[key] = 'https://registry.yiyu.pro'
    region.resource = 'https://blockly.yiyu.pro'
  }
  profile.config.resource_sources = [{ key: 'localhost', url: 'https://blockly.yiyu.pro', enabled: true }]
  await fs.writeFile(path.join(appData, 'config.json'), JSON.stringify(profile.config, null, 2))
  const npmrc = 'registry=https://registry.yiyu.pro\n@aily-project:registry=https://registry.yiyu.pro\nignore-scripts=true\naudit=false\nfund=false\n'
  await fs.writeFile(userconfig, npmrc, { flag: 'wx' }); await fs.writeFile(path.join(appData, '.npmrc'), npmrc)
  const policy = path.join(profileRoot, 'extensions/pi-permission-system/config.json')
  await fs.mkdir(path.dirname(policy), { recursive: true }); await fs.writeFile(policy, JSON.stringify({ permission: { '*': 'allow',
    external_directory: { '*': 'deny', [suite + '/*']: 'allow', [chat.installedRoot + '/*']: 'allow' },
    path: { '*': 'allow', [path.join(appData, '.aily')]: 'deny', [connection.authFile]: 'deny', [connection.configFile]: 'deny' } } }))
  ;({ verifyPortableBuild } = await import(pathToFileURL(path.join(agentRoot, '../../packages/aily-chat/server/portable-integrity.ts'))))
  artifact = await verifyPortableBuild(chat.installedRoot)
  assert.equal(artifact.inputHash, chat.artifact.inputHash); assert.equal(artifact.outputHash, chat.artifact.outputHash)
  const { captureBuildInputs } = await import(pathToFileURL(path.join(agentRoot, '../../packages/aily-chat/scripts/portable-build-inputs.mjs')))
  assert.equal(artifact.inputHash, sha(JSON.stringify(await captureBuildInputs(path.resolve(agentRoot, '../..')))))
  const { ELECTRON_RUN_AS_NODE, AILY_CHILD_PATH, NODE_PATH, AILY_PORTABLE_ROOT, AILY_AUTH_FILE,
    HTTP_PROXY, HTTPS_PROXY, ALL_PROXY, http_proxy, https_proxy, all_proxy, ...environment } = process.env
  const ownedEnvironment = { ...profile.env, AILY_E2E: '1', HOME: home, USERPROFILE: home, TEMP: temp, TMP: temp,
    PI_CODING_AGENT_DIR: profileRoot, NPM_CONFIG_CACHE: npmCache, npm_config_cache: npmCache,
    NPM_CONFIG_USERCONFIG: userconfig, npm_config_userconfig: userconfig, NPM_CONFIG_OFFLINE: 'false', npm_config_offline: 'false',
    NPM_CONFIG_IGNORE_SCRIPTS: 'true', npm_config_ignore_scripts: 'true', NPM_CONFIG_AUDIT: 'false', NPM_CONFIG_FUND: 'false' }
  await stage('launch-empty-packaged-host-and-installed-chat')
  app = await _electron.launch({ executablePath: host.executable, cwd: repo, timeout: 60000,
    args: [`--user-data-dir=${path.join(suite, 'chromium-profile')}`], env: { ...environment, ...ownedEnvironment } })
  const hostPid = await app.evaluate(() => process.pid), all = await processes()
  mainIdentity = all.find(item => item.ProcessId === hostPid); actorIdentity = all.find(item => item.ProcessId === process.pid)
  assertCapturedEnvironmentProcess(mainIdentity, { ...mainIdentity, ExecutablePath: host.executable })
  assert.ok(mainIdentity.CommandLine.includes(path.join(suite, 'chromium-profile')))
  evidence.host.pid = hostPid; evidence.mainIdentity = mainIdentity; await persist()
  for (const stream of ['stdout', 'stderr']) app.process()[stream]?.pipe(nativeFs.createWriteStream(path.join(values.output, 'main-' + stream + '.log')))
  await app.context().route('**/*', async route => {
    const request = route.request(), url = new URL(request.url())
    if (!['http:', 'https:'].includes(url.protocol) || ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return route.continue()
    if (['https://registry.yiyu.pro', 'https://blockly.yiyu.pro'].includes(url.origin) && ['GET', 'HEAD'].includes(request.method())) return route.continue()
    if (!url.pathname.startsWith('/api/')) return route.abort('blockedbyclient')
    const headers = { ...request.headers() }; delete headers.host; delete headers.connection; delete headers['content-length']
    const reply = await fetch(router.origin + url.pathname + url.search, { method: request.method(), headers,
      ...(['GET', 'HEAD'].includes(request.method()) ? {} : { body: request.postDataBuffer() }), signal: AbortSignal.timeout(15000) })
    await route.fulfill({ status: reply.status, headers: Object.fromEntries(reply.headers), body: Buffer.from(await reply.arrayBuffer()) })
  })
  const deadline = Date.now() + 60000
  while (!page && Date.now() < deadline) { for (const candidate of app.windows()) if (await candidate.locator('app-main-window').count()) { page = candidate; break }
    if (!page) await wait(100) }
  assert.ok(page); page.on('dialog', dialog => dialog.dismiss())
  await page.evaluate(() => { const dismiss = () => document.querySelector('app-onboarding .btn-skip')?.click()
    new MutationObserver(dismiss).observe(document.documentElement, { childList: true, subtree: true }); dismiss() })
  await page.waitForFunction(() => { const element = document.querySelector('app-header')
    return element && window.ng?.getComponent(element)?.projectService })
  evidence.emptyDesktop = await boundaryHostState(page); assert.ok(!evidence.emptyDesktop.project)
  loaded = await assertInstalledChatLoaded(page, { installedRoot: chat.installedRoot, expectedApiBase: router.origin,
    expectedInputHash: chat.artifact.inputHash, expectedOutputHash: chat.artifact.outputHash })
  loaded.e2e = createBootstrapReadOnlyObserver(loaded.frame.url(), { onFailure: async reply => {
    (evidence.observationReplies ??= []).push(reply); await persist()
  } })
  evidence.installedChat = loaded.evidence; assert.equal(await app.evaluate(({ app }) => app.isPackaged), true)
  assignEnvironment({ ...ownedEnvironment, AILY_LIBRARY_HOST_PID: String(hostPid), AILY_CHILD_PATH: undefined,
    AILY_PORTABLE_ROOT: undefined, NODE_PATH: undefined, PI_OFFLINE: '1' })
  await stage('actual-' + scenario)
  evidence.businessAttemptedAt = Date.now()
  const checkpoint = async result => { evidence.boundary = result; await persist() }
  evidence.boundary = scenario === 'first-open'
    ? await runBootstrapDirectBoundary({ scenario, page, agentRoot, suite, project, projectParent, checkpoint })
    : await runBootstrapUiBoundary({ scenario, page, loaded, provider, project, suite, agentRoot, checkpoint })
  assert.equal(evidence.boundary.ok, true); evidence.ok = true
  await page.screenshot({ path: path.join(values.output, 'result.png'), fullPage: true }); await stage('boundary-verified')
} catch (error) {
  evidence.error = safeError(error)
  if (page) await page.screenshot({ path: path.join(values.output, 'failure.png'), fullPage: true }).catch(() => {})
} finally {
  const finalState = page ? await boundaryHostState(page).catch(() => null) : null
  let finalSession, sessionObserved = false
  if (loaded && evidence.boundary?.sessionId) try {
    finalSession = (await readBootstrapObservation(() => loaded.e2e('session.read', { sessionId: evidence.boundary.sessionId }), {
      deadline: evidence.boundary.observationDeadline, onTimeout: async item => {
        (evidence.observationFailures ??= []).push({ ...item, method: 'session.read', sessionId: evidence.boundary.sessionId }); await persist()
      } })).session; sessionObserved = true
  } catch { /* Unknown is preserved, never considered idle. */ }
  evidence.cleanupDecision = bootstrapCleanupDecision({ hostStarted: Boolean(mainIdentity),
    submissionAttempted: Boolean(evidence.businessAttemptedAt), hostState: finalState,
    session: finalSession, sessionObserved, requiresSession: scenario !== 'first-open' })
  preserveActive = !evidence.cleanupDecision.allowed
  if (preserveActive) { evidence.ok = false; evidence.cleanupDeferred = { reason: 'actual-Host-lifecycle-still-running', state: finalState,
    noStopOrKillSent: true, main: mainIdentity, actor: actorIdentity, routerOrigin: router?.origin, providerOrigin: provider?.origin }; await persist() }
  else {
    await cleanup('exact-owned-process-cleanup', async () => {
      if (!mainIdentity) return
      const all = await processes(), main = all.find(item => item.ProcessId === mainIdentity.ProcessId)
      if (main) assertCapturedEnvironmentProcess(main, mainIdentity)
      assertCapturedEnvironmentProcess(all.find(item => item.ProcessId === actorIdentity.ProcessId), actorIdentity)
      const captured = [...new Map([...(main ? selectEnvironmentProcessTree(all, mainIdentity) : []),
        ...selectEnvironmentProcessTree(all, actorIdentity).filter(item => item.ProcessId !== process.pid)].map(item => [item.ProcessId, item])).values()]
      evidence.cleanup = { main: mainIdentity, captured, remaining: null, errors: [] }; await persist()
      for (const item of [...captured.filter(item => item.ProcessId === mainIdentity.ProcessId), ...captured.filter(item => item.ProcessId !== mainIdentity.ProcessId).reverse()])
        try { await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', environmentProcessStopScript(item)], { windowsHide: true, timeout: 20000 }) }
        catch (error) { evidence.cleanup.errors.push({ pid: item.ProcessId, ...safeError(error) }) }
      const deadline = Date.now() + 30000; let remaining
      do { remaining = remainingEnvironmentProcesses(captured, await processes()); if (!remaining.length) break; await wait(200) } while (Date.now() < deadline)
      evidence.cleanup.remaining = remaining; assert.deepEqual(remaining, []); assert.deepEqual(evidence.cleanup.errors, [])
    })
    await cleanup('close-local-router', async () => router?.close()); await cleanup('close-controlled-provider', async () => provider?.close())
  }
  for (const [key, value] of oldEnvironment) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  for (const [file, before] of protectedFiles) await cleanup('protected-shared-input', async () => {
    const after = await fs.readFile(file).then(sha).catch(error => { if (error.code === 'ENOENT') return null; throw error })
    evidence.protectedFiles.push({ path: file, before, after }); assert.equal(after, before)
  })
  if (artifact) await cleanup('installed-chat-unchanged', async () => assert.deepEqual(await verifyPortableBuild(chat.installedRoot), artifact))
  await cleanup('Host-artifact-unchanged', async () => assert.equal(sha(await fs.readFile(host.asar)), host.asarHash))
  evidence.finishedAt = new Date().toISOString(); await persist()
}
console.log(JSON.stringify({ ok: evidence.ok, scenario, output: values.output, error: evidence.error?.message, cleanupDeferred: preserveActive }))
process.exitCode = evidence.ok ? 0 : 1
