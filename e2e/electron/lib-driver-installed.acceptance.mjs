import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import nativeFs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { parseArgs, promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { _electron } from '@playwright/test'
import { prepareInstalledChatProfile, createLocalChatApiRouter, assertInstalledChatLoaded } from '../fixtures/installed-chat-ui.mjs'
import { assertCapturedEnvironmentProcess, selectEnvironmentProcessTree,
  remainingEnvironmentProcesses, environmentProcessStopScript } from './fixtures/r2-environment-cleanup.mjs'
import { createLibDriverRegistry, libDriverNpmEnvironment } from './fixtures/lib-driver-registry.mjs'
import { prepareLibDriverProject, fingerprintLibDriverSdk,
  runLibDriverCandidateCase, compileLibDriverCandidate } from './lib-driver-candidate.acceptance.mjs'
import { verifyCustomerOriginalUnchanged } from './fixtures/r4-customer-natural.mjs'
import { sha } from './fixtures/r1-customer-native.mjs'

// Authoring/importing a fixture never starts this driver. Root explicitly owns
// this executable entry and its single real Host; no provider is called.
assert.equal(process.env.AILY_LIBRARY_ROOT_HOST_WINDOW, '1', 'Only Root launches the actual library acceptance')
const required = ['pair-file', 'output', 'test-root', 'resource-root', 'platform-resource-root', 'project-input', 'tarball', 'agent-root']
const { values } = parseArgs({ options: { ...Object.fromEntries(required.map(name => [name, { type: 'string' }])),
  'additional-tarball': { type: 'string' }, 'upgrade-pubsubclient': { type: 'boolean', default: false },
  'upgrade-only': { type: 'boolean', default: false } } })
for (const name of required) assert.ok(path.isAbsolute(values[name] ?? ''), '--' + name + ' must be absolute')
if (values['additional-tarball']) assert.ok(path.isAbsolute(values['additional-tarball']))
assert.equal(Boolean(values['additional-tarball']), values['upgrade-pubsubclient'],
  'The PubSubClient upgrade requires the explicit real matching extra tarball and the explicit upgrade flag together')
const repo = fileURLToPath(new URL('../../', import.meta.url))
const lex = path.resolve(values['agent-root'], '../..')
const inside = (root, file) => { const relative = path.relative(root, file)
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) }
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
assert.ok(inside(path.join(repo, 'e2e/test-results'), values.output))
assert.ok(inside(path.join(values['resource-root'], 'dev-tests'), values['test-root']))
assert.equal(inside(values['resource-root'], values['platform-resource-root']), false,
  'Use the detached private platform material, not Daily resources')
const pair = JSON.parse(await fs.readFile(values['pair-file']))
assert.ok(path.isAbsolute(pair.hostReceipt) && path.isAbsolute(pair.chatReceipt))
const host = JSON.parse(await fs.readFile(pair.hostReceipt)), chat = JSON.parse(await fs.readFile(pair.chatReceipt))
assert.equal(chat.ok, true)
assert.equal(sha(await fs.readFile(host.asar)), host.asarHash)
for (const relative of ['sdk', 'tools', 'compiler', 'node_modules', 'npm-global/node_modules']) {
  const actual = await fs.realpath(path.join(values['platform-resource-root'], relative))
  assert.ok(inside(values['platform-resource-root'], actual), 'Every resource root must stay inside private platform material')
}
assert.ok(os.freemem() >= 1024 ** 3, 'The actual Host window requires the fixed minimum free-memory budget')
const exec = promisify(execFile)
const processes = async () => {
  const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine,@{Name='CreationDate';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress"],
  { windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 ** 2 })
  const result = JSON.parse(stdout)
  return Array.isArray(result) ? result : [result]
}
assert.deepEqual((await processes()).filter(item => item.ExecutablePath && same(item.ExecutablePath, host.executable)), [],
  'Finish and independently audit the previous exact Host window before this run')
await fs.mkdir(path.dirname(values.output), { recursive: true })
await fs.mkdir(values.output)
await fs.mkdir(values['test-root'], { recursive: true })
const suite = await fs.mkdtemp(path.join(values['test-root'], 'lib-driver-installed-'))
const appData = path.join(suite, 'appdata'), home = path.join(suite, 'home')
const temp = path.join(suite, 'temp'), agentProfile = path.join(suite, 'agent-profile')
const npmCache = path.join(suite, 'npm-cache'), userconfig = path.join(suite, 'library-test.npmrc')
for (const directory of [home, temp, agentProfile, npmCache]) await fs.mkdir(directory)
const evidence = { ok: false, suite, output: values.output, pairFile: values['pair-file'],
  actualHost: { executable: host.executable, asarHash: host.asarHash },
  actualChat: chat.artifact, actor: 'Real SDK/Core/History registrars against the real installed Host',
  modelExecuted: false, providerRequests: 0, originalConversationReplayed: false,
  originalUserProjectModified: false, compilationRequested: !values['upgrade-only'],
  cleanupFailures: [], stages: [], protectedFiles: [] }
const persist = () => fs.writeFile(path.join(values.output, 'result.json'), JSON.stringify(evidence, null, 2))
const stage = async name => { evidence.stages.push({ name, at: Date.now() }); console.log('LIB_DRIVER_PHASE=' + name); await persist() }
const protectedFiles = new Map()
for (const file of [path.join(values['resource-root'], 'config.json'), path.join(values['resource-root'], '.aily'),
  path.join(values['resource-root'], 'npm-global/app/store/subapp-aily-chat/active.json'),
  path.join(values['resource-root'], 'npm-global/app/subapp-index.json')])
  protectedFiles.set(file, await fs.readFile(file).then(sha).catch(error => { if (error.code === 'ENOENT') return null; throw error }))
let app, page, loaded, mainIdentity, actorIdentity, registry, api, artifact, verifyPortableBuild, fixture, runtime, run
const previousEnvironment = new Map()
const assignActorEnvironment = environment => {
  for (const [key, value] of Object.entries(environment)) {
    previousEnvironment.set(key, process.env[key])
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}
const cleanup = async (name, action) => {
  try { await action() }
  catch (error) { evidence.ok = false; evidence.cleanupFailures.push({ name, message: error.message }) }
}

try {
  await stage('prepare-real-tarball-registry-and-original-project')
  registry = await createLibDriverRegistry({ tarball: values.tarball,
    additionalTarballs: values['additional-tarball'] ? [values['additional-tarball']] : [] })
  if (values['upgrade-pubsubclient']) {
    const additional = registry.packages.filter(item => item.manifest.name !== '@aily-project/lib-ds1302')
    assert.equal(additional.length, 1)
    assert.equal(additional[0].manifest.name, '@aily-project/lib-pubsubclient')
    assert.equal(additional[0].manifest.version, '1.0.1')
    for (const required of ['generator.js', 'block.json', 'toolbox.json', 'src.7z'])
      assert.ok(additional[0].files.some(file => file.path === required))
  }
  api = await createLocalChatApiRouter({ installedRoot: chat.installedRoot })
  await fs.writeFile(userconfig, 'registry=' + registry.origin + '\n@aily-project:registry=' + registry.origin +
    '\nreplace-registry-host=always\nignore-scripts=true\naudit=false\nfund=false\n', { flag: 'wx' })
  fixture = await prepareLibDriverProject({ input: values['project-input'], directory: path.join(suite, 'project'),
    resourceRoot: values['resource-root'], boardsRoot: path.resolve(repo, '../aily-blockly-boards'),
    librariesRoot: path.resolve(repo, '../aily-blockly-libraries') })
  evidence.project = fixture.project
  evidence.originalInputAbiHash = fixture.customer.inputAbiSha256
  evidence.dependencyMaterialization = fixture.customer.dependencies
  evidence.originalLockSha256 = fixture.driverUpgrade.originalLockSha256
  const profile = await prepareInstalledChatProfile({ appData, installedRoot: chat.installedRoot, apiBase: api.origin,
    baseConfigPath: path.join(values['resource-root'], 'config.json'), resourceAppData: values['platform-resource-root'] })
  profile.config.compile = { ...profile.config.compile, backend: 'local' }
  for (const region of Object.values(profile.config.regions ?? {}))
    for (const key of ['npm_registry', 'npm_registry_linux', 'npm_registry_coder']) region[key] = registry.origin
  await fs.writeFile(path.join(appData, 'config.json'), JSON.stringify(profile.config, null, 2))
  const integrityModule = await import(pathToFileURL(path.join(lex, 'packages/aily-chat/server/portable-integrity.ts')))
  verifyPortableBuild = integrityModule.verifyPortableBuild
  artifact = await verifyPortableBuild(chat.installedRoot)
  assert.equal(artifact.inputHash, chat.artifact.inputHash); assert.equal(artifact.outputHash, chat.artifact.outputHash)
  const npmEnvironment = libDriverNpmEnvironment(registry.origin, { cache: npmCache, userconfig })
  const { ELECTRON_RUN_AS_NODE, AILY_CHILD_PATH, NODE_PATH, AILY_PORTABLE_ROOT, AILY_AUTH_FILE,
    HTTP_PROXY, HTTPS_PROXY, ALL_PROXY, http_proxy, https_proxy, all_proxy, ...environment } = process.env
  await stage('launch-owned-real-host-and-installed-chat')
  app = await _electron.launch({ executablePath: host.executable, cwd: repo, timeout: 60000,
    args: [`--user-data-dir=${path.join(suite, 'chromium-profile')}`],
    env: { ...environment, ...profile.env, ...npmEnvironment, AILY_E2E: '1',
      HOME: home, USERPROFILE: home, TEMP: temp, TMP: temp, PI_CODING_AGENT_DIR: agentProfile } })
  const hostPid = await app.evaluate(() => process.pid)
  const all = await processes()
  mainIdentity = all.find(item => item.ProcessId === hostPid)
  actorIdentity = all.find(item => item.ProcessId === process.pid)
  assert.ok(mainIdentity && actorIdentity)
  assert.ok(same(mainIdentity.ExecutablePath, host.executable))
  assert.ok(mainIdentity.CommandLine.includes(path.join(suite, 'chromium-profile')))
  evidence.hostPid = hostPid; evidence.mainIdentity = mainIdentity
  for (const stream of ['stdout', 'stderr']) app.process()[stream]?.pipe(nativeFs.createWriteStream(path.join(values.output, 'main-' + stream + '.log')))
  await app.context().route('**/*', route => { const url = new URL(route.request().url())
    return !['http:', 'https:'].includes(url.protocol) || ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      ? route.continue() : route.abort('blockedbyclient') })
  const deadline = Date.now() + 60000
  while (!page && Date.now() < deadline) {
    for (const candidate of app.windows()) if (await candidate.locator('app-main-window').count()) { page = candidate; break }
    if (!page) await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(page)
  page.on('pageerror', error => { (evidence.pageErrors ??= []).push({ stage: evidence.stages.at(-1)?.name, message: error.message }) })
  await page.evaluate(() => { const dismiss = () => { document.querySelector('app-onboarding .btn-skip')?.click(); document.querySelector('app-login .login-close')?.click() }
    new MutationObserver(dismiss).observe(document.documentElement, { childList: true, subtree: true }); dismiss() })
  await page.waitForFunction(() => window.ng?.getComponent(document.querySelector('app-header'))?.projectService)
  assert.equal(await page.evaluate(async project => {
    const service = window.ng.getComponent(document.querySelector('app-header')).projectService
    await service.initializeProjectDataSchema(project)
    return service.projectOpen(project)
  }, fixture.project), true)
  await page.waitForFunction(project => {
    const editor = window.ng.getComponent(document.querySelector('app-blockly-editor'))
    return editor?.projectService.currentProjectPath === project
      && editor.projectService.getBlocklyProjectLoadStatus(project)?.ready
      && editor._builderService.isInstallInProgress() === false
  }, fixture.project, { timeout: 120000 })
  loaded = await assertInstalledChatLoaded(page, { installedRoot: chat.installedRoot, expectedApiBase: api.origin,
    expectedInputHash: chat.artifact.inputHash, expectedOutputHash: chat.artifact.outputHash })
  evidence.installedChat = loaded.evidence
  assert.equal((await app.evaluate(({ app }) => app.isPackaged)), true)
  assignActorEnvironment({ AILY_LIBRARY_HOST_PID: String(hostPid), AILY_APPDATA_PATH: appData,
    AILY_NPM_PREFIX: path.join(appData, 'npm-global'), HOME: home, USERPROFILE: home, TEMP: temp, TMP: temp,
    PI_CODING_AGENT_DIR: agentProfile, PI_OFFLINE: '1', AILY_CHILD_PATH: undefined, AILY_PORTABLE_ROOT: undefined })
  const expectedSdkHash = sha(JSON.stringify(await fingerprintLibDriverSdk(values['agent-root'])))
  await stage('actual-sdk-candidate-library-upgrade-and-apply')
  run = await runLibDriverCandidateCase({ page, fixture, agentRoot: values['agent-root'], expectedSdkHash,
    registry, suite, upgradePubsubclient: values['upgrade-pubsubclient'], onRuntime: value => { runtime = value },
    checkpoint: async value => { evidence.actual = value; await persist() } })
  if (!values['upgrade-only']) {
    await stage('actual-fixed-input-compiler-and-returned-log-read')
    const compiled = await compileLibDriverCandidate(run, { page,
      checkpoint: async value => { evidence.actual = value; await persist() } })
    evidence.compilerSucceeded = compiled.compilerSucceeded
    assert.equal(compiled.compilerSucceeded, true, 'Retain the actual newly exposed compiler failure; do not call the complete scenario successful')
  }
  const apiDenied = api.snapshot().denied
  const optionalMetadataPaths = new Set(['/boards.json', '/boards-linux.json', '/libraries.json', '/tags.json'])
  evidence.deniedOptionalUiMetadata = apiDenied.filter(item => item.method === 'GET' && optionalMetadataPaths.has(item.path))
  evidence.unexpectedApiDenied = apiDenied.filter(item => item.method !== 'GET' || !optionalMetadataPaths.has(item.path))
  assert.deepEqual(evidence.unexpectedApiDenied, [], 'Keep optional metadata 404s separately; interaction/model and all other denied requests still fail')
  evidence.ok = true
  await page.screenshot({ path: path.join(values.output, 'library-upgrade-result.png'), fullPage: true })
} catch (error) {
  evidence.error = { name: error.name, code: error.code, message: error.message, stack: error.stack }
  if (page) await page.screenshot({ path: path.join(values.output, 'failure.png'), fullPage: true }).catch(() => {})
} finally {
  if (run?.evidence.ok) await cleanup('settle-real-sdk-history', () => run.session.settle())
  await cleanup('dispose-real-sdk-history', async () => runtime?.session.history.dispose())
  await cleanup('capture-and-stop-only-exact-owned-processes', async () => {
    if (!mainIdentity) return
    const all = await processes(), main = all.find(item => item.ProcessId === mainIdentity.ProcessId)
    assertCapturedEnvironmentProcess(main, mainIdentity)
    const actor = all.find(item => item.ProcessId === actorIdentity.ProcessId)
    assertCapturedEnvironmentProcess(actor, actorIdentity)
    const captured = [...new Map([...selectEnvironmentProcessTree(all, mainIdentity),
      ...selectEnvironmentProcessTree(all, actorIdentity).filter(item => item.ProcessId !== process.pid)]
      .map(item => [item.ProcessId, item])).values()]
    evidence.cleanup = { main: mainIdentity, captured, mode: 'owned-forced-test-cleanup', gracefulCloseClaim: false }
    for (const item of captured.slice().reverse())
      await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', environmentProcessStopScript(item)],
        { windowsHide: true, timeout: 20000 })
    const deadline = Date.now() + 30000
    let remaining
    do {
      remaining = remainingEnvironmentProcesses(captured, await processes())
      if (!remaining.length) break
      await new Promise(resolve => setTimeout(resolve, 200))
    } while (Date.now() < deadline)
    evidence.cleanup.remaining = remaining
    assert.equal(remaining.length, 0)
  })
  evidence.registry = registry?.snapshot(); evidence.api = api?.snapshot()
  await cleanup('close-owned-registry', async () => registry?.close())
  await cleanup('close-owned-chat-api', async () => api?.close())
  for (const [key, value] of previousEnvironment) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  for (const [file, before] of protectedFiles) await cleanup('protected-Daily-file', async () => {
    const after = await fs.readFile(file).then(sha).catch(error => { if (error.code === 'ENOENT') return null; throw error })
    evidence.protectedFiles.push({ path: file, before, after })
    assert.equal(after, before)
  })
  if (fixture) await cleanup('original-input-unchanged', () => verifyCustomerOriginalUnchanged(fixture))
  if (artifact) await cleanup('installed-chat-unchanged', async () => assert.deepEqual(await verifyPortableBuild(chat.installedRoot), artifact))
  await cleanup('Host-artifact-unchanged', async () => assert.equal(sha(await fs.readFile(host.asar)), host.asarHash))
  evidence.finishedAt = new Date().toISOString()
  if (evidence.cleanupFailures.length) evidence.ok = false
  await persist()
}
console.log(JSON.stringify({ ok: evidence.ok, output: values.output, compilerSucceeded: evidence.compilerSucceeded,
  error: evidence.error?.message, cleanupFailures: evidence.cleanupFailures.length }))
process.exitCode = evidence.ok ? 0 : 1
