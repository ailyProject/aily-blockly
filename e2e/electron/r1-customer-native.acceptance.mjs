import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import nativeFs from 'node:fs'
import path from 'node:path'
import { parseArgs, promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { _electron } from '@playwright/test'
import { installNativeSaveObservationFault } from './fixtures/native-save-observation-fault.mjs'
import { assertCustomerRootLayoutOnly } from './fixtures/customer-state-layout.mjs'
import { sha, documentHash, inventory, fieldPlan, expectedEdit, nativeDocument, editWorking, delay } from './fixtures/r1-customer-native.mjs'

// R1 original programs: genuine dirty Working S1, real native tidy, lost terminal
// transport, an observer-abort attempt, whole-host death before client observation,
// product-owned project navigation, then readonly original-ID recovery and edit B.
// Chat Stop/session restoration is a separate root-owned installed-Chat case.
const repo = fileURLToPath(new URL('../../', import.meta.url))
const names = ['project-input', 'test-root', 'output', 'executable-path', 'expected-host-hash', 'agent-root', 'case']
const { values } = parseArgs({ options: Object.fromEntries(names.map(name => [name, { type: 'string' }])) })
assert.equal(process.env.AILY_R1_CUSTOMER_HOST_WINDOW, '1', 'Use the root-coordinated final R1 host window')
for (const name of names.filter(name => !['case', 'expected-host-hash'].includes(name))) assert.ok(path.isAbsolute(values[name] ?? ''), name)
assert.ok(['787', 'chiyao'].includes(values.case)); assert.match(values['expected-host-hash'] ?? '', /^[a-f0-9]{64}$/)
const inside = (parent, child) => { const r = path.relative(parent, child); return r && r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r) }
assert.ok(inside(path.join(repo, 'e2e/test-results'), values.output))
assert.match(values['test-root'].replaceAll('\\', '/'), /\/aily-project\/dev-tests\//i)
const originalHash = values.case === '787' ? '1f162f73713562b4b82b81e916d1f61abda9c2eccd4d0dea82084cc50a50d24f'
  : '911cb578e55c445131c6cc57acbafbba92018fe8468b94eaa56d1f07d1580271'
assert.equal(sha(await fs.readFile(path.join(values['project-input'], 'project.abi'))), originalHash)
const asar = path.join(path.dirname(values['executable-path']), 'resources/app.asar')
assert.equal(sha(await fs.readFile(asar)), values['expected-host-hash'])
await fs.mkdir(path.dirname(values.output), { recursive: true }); await fs.mkdir(values.output, { recursive: false })
await fs.mkdir(values['test-root'], { recursive: true })
const suite = await fs.mkdtemp(path.join(values['test-root'], `r1-customer-${values.case}-`))
const project = path.join(suite, 'project'), appData = path.join(suite, 'appdata'), home = path.join(suite, 'home'), temp = path.join(suite, 'temp')
for (const directory of [appData, home, temp]) await fs.mkdir(directory)
const originalFiles = await inventory(values['project-input'])
await fs.cp(values['project-input'], project, { recursive: true, dereference: false, errorOnExist: true, force: false })
assert.deepEqual(await inventory(project), originalFiles)
const original = JSON.parse(await fs.readFile(path.join(project, 'project.abi'), 'utf8')), plan = fieldPlan(original)
const evidence = { ok: false, case: values.case, suite, project, hostHash: values['expected-host-hash'], originalHash,
  realOriginalProject: true, derivedFieldEdit: true, exactLateCandidateReplayed: false,
  realPackagedHost: true, realSdkServices: true, paidModelRequests: 0, explicitCompileRequested: false, compilerCoverage: 'not-tested',
  chatStopTested: false, observationAbortRequested: false, observationCancellationConfirmed: false,
  manualColdOpen: false, clickedRecent: false,
  fabricatedHostReceipts: false, launches: [], phases: [], cleanupFailures: [] }
const persist = () => fs.writeFile(path.join(values.output, 'result.json'), JSON.stringify(evidence, null, 2))
const phase = async name => { evidence.phases.push({ name, at: Date.now() }); console.log('R1_CUSTOMER_PHASE=' + name); await persist() }
const exec = promisify(execFile)
const processes = async () => { const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate | ConvertTo-Json -Compress'],
{ windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024 }); const list = JSON.parse(stdout); return Array.isArray(list) ? list : [list] }
const tree = async pid => { const all = await processes(), ids = new Set([pid]); let changed
  do { changed = false; for (const item of all) if (ids.has(item.ParentProcessId) && !ids.has(item.ProcessId)) { ids.add(item.ProcessId); changed = true } } while (changed)
  return all.filter(item => ids.has(item.ProcessId)) }
const waitExited = async owned => { const until = Date.now() + 30000
  do { const active = await processes(), remaining = owned.filter(old => active.some(now => now.ProcessId === old.ProcessId && now.CreationDate === old.CreationDate))
    if (!remaining.length) return { ownedRemaining: 0 }; await delay(300) } while (Date.now() < until)
  throw Error('Owned host descendants remain after termination') }
const configuration = JSON.parse(await fs.readFile(path.join(repo, 'electron/config/config.json'), 'utf8'))
Object.assign(configuration, { metricsEnabled: false, project_path: suite, recentlyProjects: [], onboardingCompleted: true,
  blocklyOnboardingCompleted: true, region: 'r1-offline' })
configuration.appdata_path[process.platform] = appData
configuration.regions = { 'r1-offline': { official: false, enabled: true, name: 'R1 customer native', ...Object.fromEntries(
  ['api_server', 'resource', 'web', 'tool_web', 'ucenter_web', 'npm_registry', 'npm_registry_linux'].map(name => [name, 'http://127.0.0.1:9'])) } }
await fs.writeFile(path.join(appData, 'config.json'), JSON.stringify(configuration), { flag: 'wx' })
await fs.mkdir(path.join(appData, 'npm-global/app'), { recursive: true })
await fs.writeFile(path.join(appData, 'npm-global/app/subapp-index.json'), '{"dev":true}', { flag: 'wx' })
let app, page, hostPid, descriptor, sdk, sourceSaved, originalRequest, fault, pending
const mirrors = () => Promise.all(['project.abi', 'project.abs', 'project.abs.map.json'].map(name => fs.readFile(path.join(project, name), 'utf8')))
async function launch(attempt) {
  const { ELECTRON_RUN_AS_NODE, AILY_CHILD_PATH, NODE_PATH, AILY_AUTH_FILE, AILY_LIBRARY_HOST_PID, PI_CODING_AGENT_DIR, AILY_PORTABLE_ROOT, ...env } = process.env
  app = await _electron.launch({ executablePath: values['executable-path'], cwd: repo,
    args: [`--user-data-dir=${path.join(suite, 'chromium-profile')}`], timeout: 60000,
    env: { ...env, AILY_E2E: '1', AILY_APPDATA_PATH: appData, AILY_NPM_PREFIX: path.join(appData, 'npm-global'),
      HOME: home, USERPROFILE: home, TEMP: temp, TMP: temp, npm_config_offline: 'true', npm_config_ignore_scripts: 'true',
      npm_config_audit: 'false', npm_config_registry: 'http://127.0.0.1:9', npm_config_cache: path.join(suite, 'npm-cache') } })
  hostPid = await app.evaluate(() => process.pid)
  const launch = { attempt, hostPid, explicitProjectArg: false, observerOpenIssued: false, at: Date.now() }; evidence.launches.push(launch)
  const created = (await processes()).find(entry => entry.ProcessId === hostPid)
  assert.ok(created); launch.creationDate = created.CreationDate
  for (const stream of ['stdout', 'stderr']) app.process()[stream]?.pipe(nativeFs.createWriteStream(path.join(values.output, `main-${attempt}-${stream}.log`)))
  app.process().on('exit', (code, signal) => { (evidence.processExits ??= []).push({ attempt, hostPid: launch.hostPid, code, signal, at: Date.now() }) })
  await app.context().route('**/*', route => { const u = new URL(route.request().url()); return !['http:', 'https:'].includes(u.protocol)
    || ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) ? route.continue() : route.abort('blockedbyclient') })
  page = undefined; const until = Date.now() + 60000
  while (!page && Date.now() < until) { for (const candidate of app.windows()) if (await candidate.locator('app-main-window').count()) { page = candidate; break }; if (!page) await delay(100) }
  assert.ok(page); page.on('dialog', dialog => dialog.dismiss())
  page.on('pageerror', error => { (evidence.pageErrors ??= []).push({ phase: evidence.phases.at(-1)?.name, message: String(error.message).slice(0, 600) }) })
  await page.evaluate(() => { const dismiss = () => { document.querySelector('app-onboarding .btn-skip')?.click(); document.querySelector('app-login .login-close')?.click() }
    new MutationObserver(dismiss).observe(document.documentElement, { childList: true, subtree: true }); dismiss() })
  await page.waitForFunction(() => window.ng?.getComponent(document.querySelector('app-header'))?.projectService)
  if (attempt === 0) {
    launch.initialSetupOpenIssued = true
    assert.equal(await page.evaluate(async target => { const domain = window.ng.getComponent(document.querySelector('app-header')).projectService
      await domain.initializeProjectDataSchema(target); return await domain.projectOpen(target) }, project), true)
  }
  // No click, open RPC, schema initialization or projectOpen on cold startup.
  await page.waitForFunction(target => { const domain = window.ng?.getComponent(document.querySelector('app-header'))?.projectService
    return domain?.currentProjectPath === target && domain.getBlocklyProjectLoadStatus(target)?.ready === true }, project, { timeout: 120000 })
  launch.projectRestoredByProduct = attempt > 0
  const info = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, appPath: app.getAppPath(),
    node: process.version, electron: process.versions.electron }))
  assert.equal(info.packaged, true); assert.match(info.appPath, /app\.asar$/i); launch.host = info
  assert.equal(sha(await fs.readFile(asar)), values['expected-host-hash'])
  const discoveryFile = path.join(home, '.aily-blockly/cli-bridge', hostPid + '.json')
  for (let i = 0; i < 50; i++) { try { descriptor = JSON.parse(await fs.readFile(discoveryFile, 'utf8')); break } catch { await delay(100) } }
  assert.equal(descriptor?.pid, hostPid); assert.equal(descriptor.nativeSaveReceiptVersion, 2)
  Object.assign(process.env, { AILY_LIBRARY_HOST_PID: String(hostPid), AILY_APPDATA_PATH: appData, HOME: home, USERPROFILE: home, PI_OFFLINE: '1' })
  await persist()
}
async function killOwned() {
  const actual = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `Get-CimInstance Win32_Process -Filter 'ProcessId = ${hostPid}' | Select-Object ProcessId,CreationDate,ExecutablePath,CommandLine | ConvertTo-Json -Compress`],
  { windowsHide: true, timeout: 15000 })
  const identity = JSON.parse(actual.stdout)
  assert.equal(identity.ProcessId, hostPid)
  assert.equal(identity.CreationDate, evidence.launches.at(-1).creationDate, 'Never kill a reused PID')
  assert.equal(path.resolve(identity.ExecutablePath).toLowerCase(), path.resolve(values['executable-path']).toLowerCase())
  assert.ok(identity.CommandLine.includes(path.join(suite, 'chromium-profile')), 'Refuse an unrelated profile')
  const owned = await tree(hostPid), main = owned.find(entry => entry.ProcessId === hostPid)
  assert.equal(main.CreationDate, identity.CreationDate)
  const closed = app.waitForEvent('close', { timeout: 15000 })
  process.kill(hostPid, 'SIGKILL')
  await closed; app = undefined; evidence.lastKill = { executorPid: hostPid, ...await waitExited(owned) }; await persist()
}
try {
  await phase('initial-exact-original-load'); await launch(0)
  assert.equal(documentHash(await nativeDocument(page, project)), documentHash(original))
  const load = relative => import(pathToFileURL(path.join(values['agent-root'], 'dist', relative + '.js')).href)
  const [{ observeProjectSave }, { appCommand }, { requestHostAbsProjection }] = await Promise.all([
    load('blockly/services/project/save-observation'), load('blockly/services/app/command'), load('blockly/services/abs/host-projection')])
  sdk = { observeProjectSave, appCommand, requestHostAbsProjection }
  evidence.agentModules = await Promise.all(['blockly/services/project/save-observation', 'blockly/services/project/publication-observation',
    'blockly/services/app/command', 'blockly/runtime-client', 'blockly/services/abs/host-projection'].map(async name => ({ name,
    sha256: sha(await fs.readFile(path.join(values['agent-root'], 'dist', name + '.js'))) })))
  const exported = await sdk.requestHostAbsProjection(project, { reuseCurrent: true })
  assert.equal(exported?.ok, true, JSON.stringify({ code: exported?.code, error: exported?.error }))
  const s0 = await mirrors(), previousGeneration = JSON.parse(s0[2]).generation
  assert.equal(documentHash(JSON.parse(s0[0])), documentHash(original))
  await phase('real-gui-dirty-working-S1-before-native-tidy')
  const changed = await editWorking(page, project, plan, plan.valueA, true), s1 = expectedEdit(original, plan, plan.valueA, true)
  assert.ok(changed.afterRevision > changed.beforeRevision)
  assert.equal(documentHash(JSON.parse(changed.documentText)), documentHash(s1))
  assert.deepEqual(await mirrors(), s0, 'Dirty Working must not silently publish itself')
  evidence.working = { blockId: plan.blockId, originalValue: plan.oldValue, valueA: plan.valueA,
    beforeRevision: changed.beforeRevision, afterRevision: changed.afterRevision, fullS1Hash: documentHash(s1), diskStillS0: true }
  await persist()
  const proofFile = path.join(suite, 'r1-native-fault-0.json')
  const installed = await app.evaluate(installNativeSaveObservationFault, JSON.stringify({ pid: hostPid, project, appData, port: descriptor.port, proofFile,
    operation: 'blocks_tidy', receiptVersion: 2, previousGeneration, previousDocument: s1 }))
  assert.equal(installed.available, true)
  await phase('real-native-v2-tidy-disconnect-terminal-before-client-observation')
  const controller = new AbortController()
  const saving = sdk.observeProjectSave(sdk.appCommand, project, 'blocks_tidy', { signal: controller.signal,
    onTarget: (target, submission) => { assert.equal(target.pid, hostPid); originalRequest = submission } })
  const until = Date.now() + 180000
  do { fault = JSON.parse(await fs.readFile(proofFile, 'utf8'))
    if (fault.failures.length) throw Error(JSON.stringify(fault.failures))
    if (fault.drops) break; await delay(100) } while (Date.now() < until)
  assert.ok(fault.drops > 0, 'Must disconnect a genuine verified terminal save response')
  assert.ok(fault.commands.some(command => command.dropped && command.responseDestroyed === true))
  const ping = await (await fetch(`http://127.0.0.1:${descriptor.port}/ping`, { signal: AbortSignal.timeout(3000) })).json()
  assert.equal(ping.pid, hostPid); assert.equal(ping.nativeSaveReceiptVersion, 2)
  evidence.mainAfterDisconnect = { pid: ping.pid, nativeSaveReceiptVersion: ping.nativeSaveReceiptVersion,
    creationDate: evidence.launches.at(-1).creationDate, actualResponseDestroyed: true }
  controller.abort(new DOMException('R1 stop observing the already committed original save', 'AbortError'))
  evidence.observationAbortRequested = true
  pending = await saving
  await fs.writeFile(path.join(values.output, 'unobserved-save-result.json'), JSON.stringify(pending, null, 2))
  assert.equal(pending.saveOutcome, 'unknown')
  assert.equal(pending.observation.resultKnown, false)
  assert.equal(pending.observation.operationCancelled, false)
  evidence.observationCancellationConfirmed = pending.cancelled === true
  assert.equal(originalRequest.version, 2); assert.equal(fault.requestId, originalRequest.requestId)
  assert.equal(fault.commands.filter(item => item.operation === 'blocks_tidy').length, 1)
  const index = JSON.parse(await fs.readFile(path.join(project, '.aily/abs-sync/recoveries',
    'request-' + sha('native-save-v2\0' + originalRequest.requestId) + '.json'), 'utf8'))
  const snapshotBytes = await fs.readFile(path.join(project, '.aily/abs-sync/recoveries', `operation-${index.operationId}.json`))
  assert.equal('sha256:' + sha(snapshotBytes), index.snapshotHash)
  const journal = JSON.parse(snapshotBytes)
  assert.equal(documentHash(journal.document), documentHash(s1), 'Original durable snapshot must be latest dirty Working before tidy')
  assert.equal(journal.executor.hostPid, hostPid)
  assert.deepEqual([journal.disk.abi, journal.disk.abs, journal.disk.map], s0)
  sourceSaved = await mirrors(); const persisted = JSON.parse(sourceSaved[0])
  const layout = assertCustomerRootLayoutOnly(s1, persisted); assert.ok(layout.changedRoots > 0)
  assert.equal(documentHash(await nativeDocument(page, project)), documentHash(persisted))
  evidence.originalSave = { requestId: originalRequest.requestId, operationId: index.operationId, executorPid: hostPid,
    sourceSaved: true, observedByClient: false, snapshotS1Exact: true, layout,
    pending: { code: pending.code, saveOutcome: pending.saveOutcome, cancelled: pending.cancelled,
      observation: pending.observation, publication: pending.publication },
    terminalFault: fault }
  await page.screenshot({ path: path.join(values.output, 'source-saved-client-stopped-before-kill.png'), fullPage: true })
  await phase('whole-host-kill-before-original-request-observation'); const executorPid = hostPid; await killOwned()
  await phase('cold-product-auto-navigates-exact-original-project'); await launch(1)
  assert.notEqual(hostPid, executorPid)
  assert.equal(documentHash(await nativeDocument(page, project)), documentHash(persisted))
  assert.deepEqual(await mirrors(), sourceSaved)
  await app.evaluate(installNativeSaveObservationFault, JSON.stringify({ pid: hostPid, originalTargetPid: executorPid,
    observedRequestId: originalRequest.requestId, observationOnly: true, project, appData, port: descriptor.port,
    proofFile: path.join(suite, 'r1-native-fault-1.json'), operation: 'blocks_tidy', receiptVersion: 2, previousGeneration, previousDocument: s1 }))
  const observationStarted = Date.now()
  const wireObservations = []
  const recordedCommand = async (...args) => {
    const started = Date.now(), record = { action: args[0], project: args[1], operation: args[2]?.operation,
      saveRequest: args[2]?.params?.saveRequest, originalTargetPid: args[2]?.params?.originalTargetPid,
      startedAt: started, state: 'started' }
    wireObservations.push(record)
    const saveWire = () => fs.writeFile(path.join(values.output, 'cold-wire-responses.json'), JSON.stringify(wireObservations, null, 2))
    await saveWire()
    try {
      const response = await sdk.appCommand(...args)
      Object.assign(record, { state: 'returned', elapsedMs: Date.now() - started, response })
      await saveWire()
      return response
    } catch (error) {
      Object.assign(record, { state: 'threw', elapsedMs: Date.now() - started,
        error: { name: error.name, code: error.code, message: error.message } })
      await saveWire()
      throw error
    }
  }
  const observed = await sdk.observeProjectSave(recordedCommand, project, 'blocks_tidy', {
    requestId: originalRequest.requestId, targetPid: executorPid, resume: true, observationBudgetMs: 30000 })
  const observationElapsedMs = Date.now() - observationStarted
  await fs.writeFile(path.join(values.output, 'cold-observed-result.json'), JSON.stringify({ elapsedMs: observationElapsedMs, observed }, null, 2))
  evidence.coldObservationAttempt = { elapsedMs: observationElapsedMs, observationBudgetMs: 30000,
    workingViewComparisonBudgetMs: 2000, underWorkingViewBudget2s: observationElapsedMs < 2000,
    saveOutcome: observed.saveOutcome, code: observed.code, observation: observed.observation }
  await persist()
  assert.equal(observed.saveOutcome, 'completed'); assert.equal(observed.publication.status, 'COMMITTED')
  assert.equal(observed.projectSaved, true); assert.equal(observed.targetPid, executorPid)
  assert.equal(observed.publicationObservation.executor.hostPid, executorPid)
  assert.equal(observed.publicationObservation.observer.hostPid, hostPid)
  assert.equal(observed.publicationObservation.current, true)
  assert.equal(observed.saveReceipt.requestId, originalRequest.requestId)
  const readonly = JSON.parse(await fs.readFile(path.join(suite, 'r1-native-fault-1.json'), 'utf8'))
  assert.ok(readonly.commands.length > 0); assert.ok(readonly.commands.every(command => command.operation === 'project_publication_status'))
  assert.equal(readonly.failures.length, 0); assert.deepEqual(await mirrors(), sourceSaved)
  evidence.coldObservation = { resultKnown: true, originalExecutorPid: executorPid, observerPid: hostPid,
    requestId: observed.saveReceipt.requestId, current: observed.publicationObservation.current, sourceHashesUnchanged: true,
    elapsedMs: observationElapsedMs, underWorkingViewBudget2s: observationElapsedMs < 2000,
    hostProcessingMs: readonly.terminals.map(terminal => terminal.at - readonly.commands.find(command => command.requestId === terminal.requestId)?.at), readonly }
  await phase('continue-real-gui-field-B-and-ui-v2-save')
  const continued = await editWorking(page, project, plan, plan.valueB), expectedB = expectedEdit(persisted, plan, plan.valueB)
  assert.equal(documentHash(JSON.parse(continued.documentText)), documentHash(expectedB))
  const saved = await page.evaluate(async project => {
    const result = await window.ng.getComponent(document.querySelector('app-header')).projectService.save(project)
    return { success: result.success, projectSaved: result.projectSaved, partial: result.partial, code: result.code,
      error: result.error, saveReceipt: result.saveReceipt, publication: result.publication, generation: result.generation }
  }, project)
  assert.equal(saved.success, true, JSON.stringify(saved)); assert.equal(saved.saveReceipt.version, 2)
  assert.notEqual(saved.saveReceipt.requestId, originalRequest.requestId)
  assert.equal(documentHash(await nativeDocument(page, project)), documentHash(expectedB))
  assert.equal(documentHash(JSON.parse((await mirrors())[0])), documentHash(expectedB))
  evidence.continuation = { valueB: plan.valueB, completeDocumentHash: documentHash(expectedB), save: saved }
  await page.screenshot({ path: path.join(values.output, 'cold-auto-restored-and-continued.png'), fullPage: true })
  assert.deepEqual(await inventory(values['project-input']), originalFiles)
  for (const group of ['node_modules', 'local-libraries', '.assets']) {
    const sourcePrefix = group + path.sep, wanted = originalFiles.filter(entry => entry.path.startsWith(sourcePrefix))
    for (const entry of wanted) assert.equal(sha(await fs.readFile(path.join(project, entry.path))), entry.sha256,
      'Fixed definition/resource source changed: ' + entry.path)
  }
  evidence.originalInputUnchanged = true; evidence.fixedOriginalDefinitionFilesUnchanged = true; evidence.ok = true
  await phase('passed')
} catch (error) {
  evidence.error = { name: error.name, code: error.code, message: String(error.message).slice(0, 1800) }
  if (page) { await page.screenshot({ path: path.join(values.output, 'failure.png'), fullPage: true }).catch(() => {})
    evidence.failureState = await page.evaluate(() => { const domain = window.ng?.getComponent(document.querySelector('app-header'))?.projectService
      return { currentProject: domain?.currentProjectPath, load: domain?.getBlocklyProjectLoadStatus(),
        mainRoute: location.hash.split('?')[0], guideVisible: !!document.querySelector('app-guide') } }).catch(() => null) }
  await persist(); throw error
} finally {
  if (app) {
    try { const owned = await tree(hostPid); if (evidence.ok) { await app.close(); app = undefined; await waitExited(owned) } else await killOwned()
      evidence.finalOwnedProcesses = 0 }
    catch (error) { evidence.cleanupFailures.push(String(error.message)); evidence.ok = false }
  }
  evidence.originalInputUnchanged = JSON.stringify(await inventory(values['project-input'])) === JSON.stringify(originalFiles)
  if (!evidence.originalInputUnchanged) evidence.ok = false
  await persist()
}
