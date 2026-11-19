import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import nativeFs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { parseArgs, promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { _electron } from '@playwright/test'
import { prepareR2EnvironmentProject } from './fixtures/r2-environment-project.mjs'
import { createLocalChatApiRouter, prepareInstalledChatProfile } from '../fixtures/installed-chat-ui.mjs'
import { nativeDocument, inventory } from './fixtures/r1-customer-native.mjs'
import { installMissingLibraryLoadWitness, assertMissingLibraryLoadWitness, captureMissingLibraryProcessTree, prepareMissingLibraryLoadInput, observeMissingLibraryRecovery, missingLibraryProjectionRequest, sanitizeMissingLibraryReply } from './fixtures/r2-missing-library-load.mjs'
import { assertCapturedEnvironmentProcess, remainingEnvironmentProcesses, environmentProcessStopScript } from './fixtures/r2-environment-cleanup.mjs'

// New native load/recovery branch only. No model, Agent tool replay, hand-made
// recovery capability or replacement publisher participates in this scenario.
const repo = fileURLToPath(new URL('../../', import.meta.url))
const fields = ['executable-path', 'installed-root', 'lex-root', 'resource-root', 'test-root', 'output', 'expected-input-hash', 'expected-asar-hash']
const { values } = parseArgs({ options: Object.fromEntries(fields.map(key => [key, { type: 'string' }])) })
assert.equal(process.env.AILY_R2_MISSING_LIBRARY_HOST_WINDOW, '1')
for (const field of fields.filter(key => !key.startsWith('expected-'))) assert.ok(path.isAbsolute(values[field] ?? ''), field)
for (const field of fields.filter(key => key.startsWith('expected-'))) assert.match(values[field] ?? '', /^[a-f0-9]{64}$/)
const inside = (root, file) => { const relative = path.relative(root, file); return !!relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) }
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
assert.ok(inside(path.join(repo, 'e2e/test-results'), values.output))
assert.ok(inside(path.join(values['resource-root'], 'dev-tests'), values['test-root']))
assert.ok(os.freemem() >= 1024 ** 3)
const hash = value => createHash('sha256').update(value).digest('hex')
const wait = ms => new Promise(resolve => setTimeout(resolve, ms)), exec = promisify(execFile)
async function fileHash(file) { const digest = createHash('sha256'); for await (const bytes of nativeFs.createReadStream(file)) digest.update(bytes); return digest.digest('hex') }
const { verifyPortableBuild } = await import(pathToFileURL(path.join(values['lex-root'], 'packages/aily-chat/server/portable-integrity.ts')))
const artifact = await verifyPortableBuild(values['installed-root'])
assert.equal(artifact.inputHash, values['expected-input-hash'])
const asar = path.join(path.dirname(values['executable-path']), 'resources/app.asar'), hostHash = await fileHash(asar)
assert.equal(hostHash, values['expected-asar-hash'])
await fs.mkdir(values.output)
await fs.mkdir(values['test-root'], { recursive: true })
const suite = await fs.mkdtemp(path.join(values['test-root'], 'r2-missing-library-'))
const project = path.join(suite, 'project'), appData = path.join(suite, 'appdata'), home = path.join(suite, 'home'), temp = path.join(suite, 'temp')
await fs.mkdir(home); await fs.mkdir(temp)
const fixture = await prepareR2EnvironmentProject({ directory: project, suite,
  boardsRoot: path.resolve(repo, '../aily-blockly-boards'), librariesRoot: path.resolve(repo, '../aily-blockly-libraries') })
const libraryName = '@aily-project/lib-e2e-build-log-field-edit'
const manifest = JSON.parse(await fs.readFile(path.join(project, 'package.json'), 'utf8'))
const source = manifest.dependencies[libraryName].slice(5)
assert.ok(path.isAbsolute(source)); const externalBefore = await inventory(source)
const rootHandle = nativeFs.openSync(project, 'r')
let projectAttachment
try { const physical = nativeFs.fstatSync(rootHandle, { bigint: true }); assert.equal(physical.isDirectory(), true)
  projectAttachment = { version: 1, root: project, identity: { dev: String(physical.dev), ino: String(physical.ino), birthtimeNs: String(physical.birthtimeNs) } }
} finally { nativeFs.closeSync(rootHandle) }
const evidence = { ok: false, suite, project, artifact, hostHash, paidModelRequests: 0, modelUsed: false, sdkUsed: false,
  projectAttachment, manualRecoveryCapability: false, manualProjectFork: false, phases: [], commands: [], failedReplies: [], coverage: 'new missing-library load and same-root automatic recovery' }
const persist = () => fs.writeFile(path.join(values.output, 'result.json'), JSON.stringify(evidence, null, 2))
const phase = async name => { evidence.phases.push({ name, at: Date.now() }); console.log('PHASE=' + name); await persist() }
const processes = async () => {
  const result = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,@{Name='CreationDate';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress"], { windowsHide: true, timeout: 15000 })
  const list = JSON.parse(result.stdout); return Array.isArray(list) ? list : [list]
}
const tree = async () => captureMissingLibraryProcessTree(await processes(), originalMain)
const mirrors = async () => Object.fromEntries(await Promise.all(['project.abi', 'project.abs', 'project.abs.map.json', '.aily/abs-sync/committed.json'].map(async file => [file, 'sha256:' + await fileHash(path.join(project, file))])))
let app, page, router, originalMain, descriptor, witness = false
const command = async (operation, params = {}, remainingMs = 130000) => {
  const at = Date.now()
  // Real CLI body authentication and actual Main/renderer dispatch. Tokens
  // stay in memory; no synthetic receipt or change to native timeouts exists.
  const reply = await fetch(`http://127.0.0.1:${descriptor.port}/command`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(Math.min(130000, Math.max(1, remainingMs))),
    body: JSON.stringify({ token: descriptor.token, action: 'blockly-live-operation', path: project, operation, params }) })
  const body = await reply.json()
  if (body.ok !== true || reply.status >= 400) evidence.failedReplies.push({ operation, at, status: reply.status,
    body: sanitizeMissingLibraryReply(body, [descriptor.token, router?.token]) })
  evidence.commands.push({ operation, at, completedAt: Date.now(), status: reply.status, ok: body.ok, code: body.code ?? body.errorCode ?? null,
    requestId: params.requestId ?? null, observe: params.observe === true })
  return body
}
const state = () => page.evaluate(project => {
  const domain = window.ng.getComponent(document.querySelector('app-header')).projectService
  const editorElement = document.querySelector('app-blockly-editor'), editor = editorElement && window.ng.getComponent(editorElement)
  const noticeElement = document.querySelector('app-notification'), notice = noticeElement && window.ng.getComponent(noticeElement)
  return { project: domain.currentProjectPath, opening: domain.isProjectOpening, transitioning: domain.isProjectTransitionInProgress(project),
    loadStatus: domain.getBlocklyProjectLoadStatus(project),
    savedRecoveryTarget: domain.hasSavedRecoveryTarget(project), writing: !!editor?.blocklyService.aiWriting,
    nativeBusy: !!editor?.blocklyService.isWorkspaceEditInProgress(), recoveryRequired: !!editor?.blocklyService.isWorkspaceRecoveryRequired(),
    recentProjects: (domain.recentlyProjects ?? []).map(value => value.path),
    blocked: !!editor?.blocklyService.isWorkspaceEditBlocked(), noticeDoing: notice?.data?.state === 'doing' }
}, project)
async function restoreMissingLibraryWitness() {
  if (witness && app) { evidence.installWitness = await app.evaluate(() => globalThis.__r2MissingLibraryLoadWitness.snapshot())
    await app.evaluate(() => globalThis.__r2MissingLibraryLoadWitness.restore()); witness = false }
}
try {
  router = await createLocalChatApiRouter({ installedRoot: values['installed-root'] })
  const profile = await prepareInstalledChatProfile({ appData, installedRoot: values['installed-root'], apiBase: router.origin,
    baseConfigPath: path.join(repo, 'electron/config/config.json'), resourceAppData: values['resource-root'], token: router.token })
  const { ELECTRON_RUN_AS_NODE, AILY_CHILD_PATH, NODE_PATH, AILY_PORTABLE_ROOT, AILY_AUTH_FILE, ...launchEnvironment } = process.env
  await phase('healthy-native-open-and-real-G0-export')
  app = await _electron.launch({ executablePath: values['executable-path'], cwd: repo, args: [`--user-data-dir=${path.join(suite, 'electron-profile')}`], timeout: 60000,
    env: { ...launchEnvironment, ...profile.env, AILY_E2E: '1', HOME: home, USERPROFILE: home, TEMP: temp, TMP: temp,
      npm_config_offline: 'true', npm_config_audit: 'false' } })
  const pid = await app.evaluate(() => process.pid)
  assert.equal(await app.evaluate(({ app }) => app.isPackaged), true)
  evidence.realAsarHost = true
  originalMain = (await processes()).find(value => value.ProcessId === pid)
  assertCapturedEnvironmentProcess(originalMain, { ...originalMain, ExecutablePath: values['executable-path'] })
  evidence.hostPid = pid
  const until = Date.now() + 60000
  while (!page && Date.now() < until) { page = app.windows().find(value => value.url().includes('localhost'))
    if (page && !await page.locator('app-main-window').count()) page = undefined
    if (!page) for (const candidate of app.windows()) if (await candidate.locator('app-main-window').count()) { page = candidate; break }
    if (!page) await wait(100) }
  assert.ok(page)
  await app.context().route('**/*', route => { const url = new URL(route.request().url()); return !['http:', 'https:'].includes(url.protocol)
    || ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ? route.continue() : route.abort('blockedbyclient') })
  await page.evaluate(() => { const dismiss = () => { document.querySelector('app-onboarding .btn-skip')?.click(); document.querySelector('app-login .login-close')?.click() }
    new MutationObserver(dismiss).observe(document.documentElement, { childList: true, subtree: true }); dismiss() })
  await page.waitForFunction(() => { const element = document.querySelector('app-header'); return element && window.ng?.getComponent(element)?.projectService })
  await page.evaluate(async project => { const domain = window.ng.getComponent(document.querySelector('app-header')).projectService
    await domain.initializeProjectDataSchema(project); if (!await domain.projectOpen(project)) throw Error('Healthy owned project failed to open') }, project)
  const healthyDocument = await nativeDocument(page, project)
  evidence.mainCapability = await page.evaluate(() => window.libraryDependencies.capabilities())
  assert.equal(evidence.mainCapability.dependencyEnvironmentVersion, 2)
  descriptor = JSON.parse(await fs.readFile(path.join(home, '.aily-blockly/cli-bridge', pid + '.json'), 'utf8'))
  assert.equal(descriptor.pid, pid)
  const projectionRequest = missingLibraryProjectionRequest('sha256:' + await fileHash(path.join(project, 'project.abi')), randomUUID())
  const exported = await command('abs_projection', projectionRequest)
  assert.equal(exported.ok, true); assert.equal(exported.publication.status, 'COMMITTED')
  evidence.healthy = { document: healthyDocument, projection: exported.receipt, mirrors: await mirrors() }
  const closed = await command('project_close'); assert.equal(closed.ok, true)
  await page.waitForFunction(() => !window.ng.getComponent(document.querySelector('app-header')).projectService.currentProjectPath)
  evidence.closedMirrors = await mirrors()
  await phase('owned-installed-leaf-missing-first-open-dialog-cancel')
  evidence.missingInput = await prepareMissingLibraryLoadInput({ project, source, libraryName, blockType: fixture.blockType })
  const installed = evidence.missingInput.installed
  assert.deepEqual(await inventory(source), externalBefore); assert.deepEqual(await mirrors(), evidence.closedMirrors)
  const opening = page.evaluate(project => window.ng.getComponent(document.querySelector('app-header')).projectService.projectOpen(project), project)
  void opening.catch(() => {})
  const dialog = page.locator('app-paste-install-dialog')
  await dialog.waitFor({ state: 'visible', timeout: 120000 })
  await page.screenshot({ path: path.join(values.output, 'missing-library-first-dialog.png'), fullPage: true })
  await dialog.getByRole('button', { name: /^(?:取消|Cancel)$/ }).click()
  const opened = await opening.catch(() => false)
  assert.notEqual(opened, true)
  await page.waitForFunction(project => {
    const domain = window.ng.getComponent(document.querySelector('app-header')).projectService
    return domain.currentProjectPath === project && !domain.isProjectOpening && !domain.isProjectTransitionInProgress(project)
      && !domain.getBlocklyProjectLoadStatus(project).ready
  }, project, { timeout: 30000 })
  evidence.failedOpen = { dialogCancelled: true, state: await state(), mirrors: await mirrors() }
  assert.ok(same(evidence.failedOpen.state.project, project)); assert.equal(evidence.failedOpen.state.loadStatus.ready, false)
  assert.deepEqual(evidence.failedOpen.mirrors, evidence.closedMirrors)
  evidence.witnessInstallation = await app.evaluate(installMissingLibraryLoadWitness, { project, libraryName, appData, pid })
  witness = true; assert.equal(evidence.witnessInstallation.available, true)
  await phase('real-CLI-recover-project-automatic-same-root-managed-library-load')
  const recoveryId = 'missinglibs-' + randomUUID()
  const recovery = await observeMissingLibraryRecovery({ requestId: recoveryId, deadline: Date.now() + 150000,
    send: (params, remaining) => command('abs_recovery', params, remaining) })
  const recovered = recovery.result
  evidence.recovery = { originalRequestId: recoveryId, ...recovery }
  assert.equal(recovered.ok, true, JSON.stringify({ code: recovered.code, error: recovered.message }))
  assert.equal(recovered.receipt?.requestId, recoveryId); assert.equal(recovered.candidateApplied, false)
  assert.equal(recovered.receipt?.version, 2); assert.equal(recovered.receipt?.action, 'recover_project')
  assert.equal(recovered.receipt?.candidateApplied, false); assert.ok(same(recovered.project, project)); assert.equal(recovered.loadStatus?.ready, true)
  assert.equal(evidence.commands.filter(value => value.operation === 'abs_recovery' && !value.observe).length, 1)
  assert.equal(recovered.recoveryState, 'completed'); assert.equal(recovered.ready, true)
  assert.equal(await dialog.count(), 0, 'Known-source same-root recovery cannot require a second human dialog')
  const finalDocument = await nativeDocument(page, project)
  assert.deepEqual(finalDocument, healthyDocument)
  evidence.installWitness = await app.evaluate(() => globalThis.__r2MissingLibraryLoadWitness.snapshot())
  const environmentId = assertMissingLibraryLoadWitness(evidence.installWitness)
  evidence.environment = await page.evaluate(async ({ project, environmentId }) => {
    const current = () => { if (window.ng.getComponent(document.querySelector('app-header')).projectService.currentProjectPath !== project) throw Error('Project changed') }
    const storage = await window.fs.openProjectSyncStorage(project, current)
    return { result: await window.libraryDependencies.observeEnvironment(project, { requestId: environmentId }), attachment: storage.attachment }
  }, { project, environmentId })
  const environment = evidence.environment.result.environment
  assert.equal(environment.requestId, environmentId); assert.equal(environment.status, 'completed'); assert.equal(environment.current, true)
  assert.equal(environment.candidateApplied, false); assert.deepEqual(environment.attachment, evidence.environment.attachment)
  assert.deepEqual(environment.attachment, projectAttachment)
  const canonical = path.join(project, 'local-libraries', libraryName)
  assert.equal((await fs.lstat(installed)).isSymbolicLink(), true)
  assert.ok(same(await fs.realpath(installed), await fs.realpath(canonical)))
  assert.deepEqual(await inventory(source), externalBefore)
  const idleUntil = Date.now() + 30000
  let finalState
  do { finalState = await state(); if (!finalState.noticeDoing && !finalState.writing && !finalState.blocked) break; await wait(100) } while (Date.now() < idleUntil)
  assert.ok(same(finalState.project, project)); assert.equal(finalState.loadStatus.ready, true)
  assert.equal(finalState.savedRecoveryTarget, true); assert.equal(finalState.writing, false); assert.equal(finalState.blocked, false)
  assert.equal(finalState.nativeBusy, false); assert.equal(finalState.recoveryRequired, false)
  assert.ok(finalState.recentProjects.every(value => same(value, project)))
  assert.equal(finalState.noticeDoing, false)
  evidence.final = { document: finalDocument, state: finalState, mirrors: await mirrors(), installedCanonicalJunction: true,
    automaticSameRootRecovery: true, noSecondDialog: true, environmentOnlyMirrorsPreserved: true,
    publicationAcrossRecoveryMayChange: true }
  await page.screenshot({ path: path.join(values.output, 'automatic-missing-library-ready.png'), fullPage: true })
  assert.equal((router.snapshot().requests ?? []).some(value => value.path.includes('/interactions')), false)
  assert.equal(await fileHash(asar), hostHash)
  assert.deepEqual(await verifyPortableBuild(values['installed-root']), artifact)
  evidence.ok = true
} catch (error) {
  evidence.error = { name: error.name, message: error.message, stack: error.stack }
  if (page) { evidence.failureState = await state().catch(error => ({ observationError: error.message }))
    await page.screenshot({ path: path.join(values.output, 'failure.png'), fullPage: true }).catch(() => {}) }
  throw error
} finally {
  await persist()
  await restoreMissingLibraryWitness().catch(error => { evidence.witnessRestoreError = error.message; evidence.ok = false })
  if (app && originalMain) {
    const captured = await tree(), current = captured.find(value => value.ProcessId === originalMain.ProcessId)
    if (current) { assertCapturedEnvironmentProcess(current, originalMain)
      await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', environmentProcessStopScript(originalMain)], { windowsHide: true, timeout: 20000 }) }
    let remaining, until = Date.now() + 30000
    do { remaining = remainingEnvironmentProcesses(captured, await processes()); if (!remaining.length) break; await wait(250) } while (Date.now() < until)
    evidence.cleanup = { kind: 'forced-test-cleanup', normalCloseCovered: false, remaining, ownedProcessesExited: !remaining.length }
    assert.deepEqual(remaining, [])
  }
  evidence.api = router?.snapshot(); await router?.close(); evidence.completedAt = new Date().toISOString(); await persist()
}
