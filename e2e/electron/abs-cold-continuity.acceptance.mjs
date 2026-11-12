import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { parseArgs } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { _electron } from '@playwright/test'
import { createAbsStopModel } from '../fixtures/abs-stop-model.mjs'
import { createLocalChatApiRouter, prepareInstalledChatProfile, assertInstalledChatLoaded } from '../fixtures/installed-chat-ui.mjs'
import { prepareBuildLogProject } from './fixtures/build-log-project.mjs'
import { singleFieldExpectedDocument } from './fixtures/online-comparison.mjs'
import { verifyCustomerCandidateRecord } from './fixtures/customer-local-library.mjs'
import { assertColdCandidateProof, assertColdPendingIntent, assertPostAdoptionArchiveFailure, installColdCandidateArchiveRenameFault, sourceHash, waitForColdSessionOpen } from './fixtures/abs-cold-continuity.mjs'
import { assertUserStoppedAssistant, assertUserStopTerminalUi, readUserStopTerminalUi } from './fixtures/abs-stop-presentation.mjs'

// Novel boundary: a native metadata publication while A is pending, followed by
// a real host crash and original Chat-session continuation. No model service,
// manual history restore, proof binding, fabricated host receipt or UI Stop.
const repo = fileURLToPath(new URL('../../', import.meta.url))
const names = ['executable-path', 'installed-root', 'lex-root', 'resource-root', 'test-root', 'output', 'expected-input-hash']
const { values } = parseArgs({ options: { ...Object.fromEntries(names.map(name => [name, { type: 'string' }])), 'archive-eio': { type: 'boolean', default: false } } })
const archiveEio = values['archive-eio']
assert.equal(process.env.AILY_ABS_COLD_HOST_WINDOW, '1', 'Only use the root-coordinated frozen-artifact host window')
for (const name of names.filter(name => name !== 'expected-input-hash')) assert.ok(path.isAbsolute(values[name] ?? ''), `--${name} must be absolute`)
const inside = (root, target) => { const relative = path.relative(root, target); return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) }
const same = (left, right) => typeof left === 'string' && typeof right === 'string' && path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
assert.ok(inside(path.join(repo, 'e2e/test-results'), values.output))
assert.ok(inside(path.join(values['resource-root'], 'dev-tests'), values['test-root']))
assert.match(values['expected-input-hash'] ?? '', /^[a-f0-9]{64}$/)
assert.ok(os.freemem() >= 1024 ** 3, 'Use one tiny functional host only; do not terminate unrelated applications')
const sha = value => createHash('sha256').update(value).digest('hex'), wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const exec = promisify(execFile)
const processes = async () => {
  assert.equal(process.platform, 'win32', 'The owned crash/relaunch observer currently targets the Windows packaged host')
  const result = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate | ConvertTo-Json -Compress'], { windowsHide: true, timeout: 15000 })
  const value = JSON.parse(result.stdout); return Array.isArray(value) ? value : [value]
}
const ownedTree = async pid => {
  const all = await processes(), owned = new Set([pid]); let added
  do { added = false; for (const item of all) if (owned.has(item.ParentProcessId) && !owned.has(item.ProcessId)) { owned.add(item.ProcessId); added = true } } while (added)
  return all.filter(item => owned.has(item.ProcessId))
}
const waitOwnedExit = async tree => {
  const deadline = Date.now() + 30000; let remaining
  do { const current = await processes(); remaining = tree.filter(item => current.some(value => value.ProcessId === item.ProcessId && value.CreationDate === item.CreationDate))
    if (!remaining.length) return { exitedNaturally: true, remaining: [] }; await wait(500)
  } while (Date.now() < deadline)
  throw Object.assign(new Error('Owned host descendants did not exit; do not overlap another host or terminate unrelated applications'), { remaining })
}
const native = (id, name, args) => ({ id, name, arguments: args })
const deferred = (id, name, args) => native(id, 'tool_invoke', { name, arguments: args })
const textOf = message => (message?.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n')
const payloadOf = message => { if (message?.details?.result) return message.details.result; try { return JSON.parse(textOf(message)) } catch { return undefined } }
const callsOf = snapshot => (snapshot?.messages ?? []).filter(message => message.role === 'assistant').flatMap(message => message.content ?? [])
  .filter(part => part.type === 'toolCall').map(call => ({ ...call, actualName: call.name === 'tool_invoke' ? call.arguments.name : call.name }))
const { verifyPortableBuild } = await import(pathToFileURL(path.join(values['lex-root'], 'packages/aily-chat/server/portable-integrity.ts')))
const { captureBuildInputs } = await import(pathToFileURL(path.join(values['lex-root'], 'packages/aily-chat/scripts/portable-build-inputs.mjs')))
const artifact = await verifyPortableBuild(values['installed-root'])
assert.equal(artifact.inputHash, values['expected-input-hash'])
assert.equal(artifact.inputHash, sha(JSON.stringify(await captureBuildInputs(values['lex-root']))))
const asar = path.join(path.dirname(values['executable-path']), 'resources/app.asar'), hostHash = sha(await fs.readFile(asar))
await fs.mkdir(values.output, { recursive: false }); await fs.mkdir(values['test-root'], { recursive: true })
const suite = await fs.mkdtemp(path.join(values['test-root'], 'abs-cold-'))
const project = path.join(suite, 'project'), appData = path.join(suite, 'appdata'), home = path.join(suite, 'home'), temp = path.join(suite, 'temp')
const absPath = path.join(project, 'project.abs')
await fs.mkdir(home); await fs.mkdir(temp)
const fixture = await prepareBuildLogProject({ directory: project, boardsRoot: path.resolve(repo, '../aily-blockly-boards'),
  librariesRoot: path.resolve(repo, '../aily-blockly-libraries'), scenario: 'field-edit', marker: 'ABS_COLD_NO_COMPILE' })
const seed = JSON.parse(await fs.readFile(path.join(project, 'project.abi'), 'utf8'))
seed.blocks.blocks.find(block => block.type === 'arduino_global').inputs.ARDUINO_GLOBAL.block.next = {
  block: { type: fixture.blockType, id: 'cold_continuity_second', fields: { VALUE: 200 } } }
await fs.writeFile(path.join(project, 'project.abi'), JSON.stringify(seed, null, 2))
const evidence = { ok: false, suite, project, artifact, hostHash, startedAt: new Date().toISOString(),
  mode: archiveEio ? 'post-adoption-archive-eio-chat-stop-cold' : 'normal-save-cold',
  realInstalledChat: true, realAsarHost: true, deterministicLocalModel: true, paidModelRequests: 0,
  replacementToolExecutor: false, manualSessionRestore: false, manualProofBinding: false,
  stages: [], tools: [], sessionCommands: [], sessionOpenResponses: [], abortCommands: [], abortResponses: [], launches: [], resources: [] }
const persist = () => fs.writeFile(path.join(values.output, 'result.json'), JSON.stringify(evidence, null, 2))
const phase = async name => { console.log('PHASE=' + name); evidence.stages.push({ name, at: Date.now() }); await persist() }
const mirrors = async () => Object.fromEntries(await Promise.all(['project.abi', 'project.abs', 'project.abs.map.json', '.aily/abs-sync/committed.json']
  .map(async name => { try { const bytes = await fs.readFile(path.join(project, name)); return [name, { hash: sourceHash(bytes), bytes: bytes.length }] }
    catch (error) { if (error.code === 'ENOENT') return [name, null]; throw error } })))
let app, page, loaded, model, router, profile, hostPid, sessionId, snapshot, baseline, baseSource, sourceA, originalGeneration, rootBlock, inspected
let faultWindow, faultRelease, providerHeldAfterFault = false, faultInstalled = false
const observed = new Set(), abortIds = new Set()
const preload = async code => {
  faultWindow ??= await app.browserWindow(page)
  return faultWindow.evaluate((window, code) => window.webContents.executeJavaScriptInIsolatedWorld(999, [{ code }]), code)
}
const faultState = () => preload('globalThis.__ailyColdArchiveFault?.snapshot() ?? { available: false }')
const nativeDocument = () => page.evaluate(() => JSON.parse(window.ng.getComponent(document.querySelector('app-blockly-editor')).blocklyService.captureRecoverySnapshot().documentText))
const state = () => page.evaluate(() => {
  const component = name => { const element = document.querySelector(name); return element ? window.ng?.getComponent(element) : undefined }
  const editor = component('app-blockly-editor'), host = component('app-child-tool-host'), domain = component('app-header')?.projectService
  const service = editor?.blocklyService, notice = host?.noticeService ?? editor?.noticeService
  return { project: domain?.currentProjectPath ?? null, loadStatus: domain?.getBlocklyProjectLoadStatus() ?? null,
    writing: service?.aiWriting ?? false, waiting: service?.aiWaitWriting ?? false,
    blocked: service?.isWorkspaceEditBlocked() ?? false, nativeBusy: service?.isWorkspaceEditInProgress() ?? false,
    recoveryRequired: service?.isWorkspaceRecoveryRequired() ?? false, hasRunning: host?.aiOperationProtocol?.hasRunning ?? false,
    noticeTitle: notice?.data?.title ?? null, noticeHasStop: typeof notice?.data?.stop === 'function',
    noticeButtons: document.querySelectorAll('app-notification .notification-box .btn.red').length,
    recentProjects: (domain?.recentlyProjects ?? []).map(value => ({ path: value.path, name: value.name })) }
})
const trust = async () => {
  assert.equal(await loaded.frame.locator('.full-access-permission-dialog').isVisible(), false)
  const dialogs = loaded.frame.locator('.pi-extension-dialog')
  for (let index = 0; index < await dialogs.count(); index++) { const dialog = dialogs.nth(index); if (!await dialog.isVisible()) continue
    const lines = String(await dialog.getAttribute('aria-label')).split(/\r?\n/)
    assert.equal(lines[0], 'Trust project folder?'); assert.ok(same(lines[1], project))
    await dialog.getByRole('button', { name: 'Trust (this session only)', exact: true }).click() }
}
const observe = async () => {
  await trust()
  const listed = await loaded.e2e('session.list'), sessions = listed.sessions.filter(value => same(value.cwd, project))
  assert.ok(sessions.length <= 1, 'No replacement Chat session may silently stand in for the old session')
  if (!sessionId) sessionId = sessions[0]?.sessionId
  if (!sessionId) return
  snapshot = (await loaded.e2e('session.read', { sessionId })).session
  assert.equal(snapshot.sessionId, sessionId); assert.ok(same(snapshot.cwd, project)); assert.equal(snapshot.permissionMode, 'default')
  const calls = callsOf(snapshot)
  for (const message of snapshot.messages.filter(message => message.role === 'toolResult')) {
    if (observed.has(message.toolCallId)) continue; observed.add(message.toolCallId)
    const result = payloadOf(message), name = calls.find(call => call.id === message.toolCallId)?.actualName ?? message.toolName
    evidence.tools.push({ name, id: message.toolCallId, isError: message.isError === true, result, text: name === 'read' ? textOf(message) : undefined })
    if (archiveEio && message.toolCallId === 'cold-publish-state') assertPostAdoptionArchiveFailure(evidence.tools.at(-1))
    else assert.equal(message.isError === true, false, name + ': ' + textOf(message).slice(0, 1400))
    if (message.toolCallId === 'cold-export-original') {
      originalGeneration = result.generation; baseSource = result.abs; sourceA = baseSource.replace(`${fixture.blockType}(100)`, `${fixture.blockType}(101)`)
      assert.notEqual(sourceA, baseSource); assert.equal(result.publication?.status, 'COMMITTED')
      baseline = await nativeDocument(); rootBlock = baseline.pages[0].content.blocks.blocks.find(block => block.type === 'arduino_global')
      assert.ok(rootBlock?.id); evidence.baseline = { document: baseline, mirrors: await mirrors(), generation: originalGeneration }
    }
    if (message.toolCallId === 'cold-inspect-state') { inspected = result; assert.equal(result.instances.length, 1); assert.equal(result.instances[0].blockId, rootBlock.id) }
  }
}
const settle = async (users, filename) => {
  const deadline = Date.now() + 120000
  while (Date.now() < deadline) { await observe()
    if (snapshot?.isIdle && !snapshot.isStreaming && snapshot.messages.filter(message => message.role === 'user').length === users) {
      await fs.writeFile(path.join(values.output, filename), JSON.stringify(snapshot, null, 2)); return snapshot }
    await wait(150) }
  throw Error('The actual installed Chat did not settle')
}
const submit = async prompt => {
  await trust(); await loaded.frame.locator('.aily-chat-composer-input[role="textbox"]').fill(prompt)
  const send = loaded.frame.locator('button.primary-action.send-action'); await send.waitFor({ state: 'visible', timeout: 15000 }); await send.click()
  evidence.resources.push({ phase: 'submit', freeMemory: os.freemem(), at: Date.now() })
}
const idleUi = async () => {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) { const current = await state()
    if (!current.hasRunning && !current.writing && !current.waiting && !current.nativeBusy && !current.blocked && !current.recoveryRequired) {
      assert.equal(current.noticeHasStop, false); assert.equal(current.noticeButtons, 0); return current }
    await wait(100) }
  throw Error('The original project retained a running/recovery UI gate')
}
async function launch(attempt) {
  evidence.resources.push({ phase: 'cold-launch-' + attempt, freeMemory: os.freemem(), at: Date.now() })
  assert.ok(os.freemem() >= 1024 ** 3)
  const { ELECTRON_RUN_AS_NODE, AILY_CHILD_PATH, NODE_PATH, AILY_PORTABLE_ROOT, AILY_AUTH_FILE, ...env } = process.env
  app = await _electron.launch({ executablePath: values['executable-path'], cwd: repo,
    args: [`--user-data-dir=${path.join(suite, 'electron-profile')}`], timeout: 60000,
    env: { ...env, ...profile.env, AILY_E2E: '1', HOME: home, USERPROFILE: home, TEMP: temp, TMP: temp,
      npm_config_offline: 'true', npm_config_audit: 'false' } })
  hostPid = await app.evaluate(() => process.pid); evidence.launches.push({ attempt, hostPid, at: Date.now() }); await persist()
  await app.context().route('**/*', route => { const url = new URL(route.request().url())
    return !['http:', 'https:'].includes(url.protocol) || ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ? route.continue() : route.abort('blockedbyclient') })
  page = undefined
  const deadline = Date.now() + 60000
  while (!page && Date.now() < deadline) { for (const candidate of app.windows()) if (await candidate.locator('app-main-window').count()) { page = candidate; break }; if (!page) await wait(100) }
  assert.ok(page); page.on('dialog', dialog => dialog.dismiss())
  page.on('websocket', socket => socket.on('framesent', ({ payload }) => {
    let value; try { value = JSON.parse(String(payload)) } catch { return }
    if (value.channel === 'agent' && value.command?.type === 'abort') {
      abortIds.add(value.id); evidence.abortCommands.push({ attempt, id: value.id, sessionId: value.command.sessionId,
        source: value.command.source, reason: value.command.reason, at: Date.now() }); return
    }
    if (value.channel !== 'agent' || !['session.open', 'session.openSubscribe', 'session.create', 'prompt'].includes(value.command?.type)) return
    evidence.sessionCommands.push({ attempt, id: value.id, type: value.command.type, sessionId: value.command.sessionId ?? value.command.options?.sessionId,
      cwd: value.command.options?.cwd, at: Date.now() })
  }).on('framereceived', ({ payload }) => {
    let value; try { value = JSON.parse(String(payload)) } catch { return }
    if (value.channel === 'agent' && value.type === 'response' && abortIds.has(value.id))
      evidence.abortResponses.push({ id: value.id, ok: value.ok, accepted: value.result?.accepted, settled: value.result?.settled })
    if (value.channel === 'agent' && value.type === 'response' && evidence.sessionCommands.some(command => command.id === value.id
      && ['session.open', 'session.openSubscribe'].includes(command.type)))
      evidence.sessionOpenResponses.push({ id: value.id, ok: value.ok, subscribed: value.result?.subscribed,
        sessionId: value.result?.snapshot?.sessionId, errorCode: value.error?.code, errorMessage: value.error?.message, at: Date.now() })
  }))
  await page.evaluate(() => { const dismiss = () => { document.querySelector('app-onboarding .btn-skip')?.click(); document.querySelector('app-login .login-close')?.click() }
    new MutationObserver(dismiss).observe(document.documentElement, { childList: true, subtree: true }); dismiss() })
  await page.waitForFunction(() => { const element = document.querySelector('app-header'); return element && window.ng?.getComponent(element)?.projectService })
  if (!attempt) {
    await page.evaluate(async project => { const domain = window.ng.getComponent(document.querySelector('app-header')).projectService
      await domain.initializeProjectDataSchema(project); if (!await domain.projectOpen(project)) throw Error('Owned fixture failed to open') }, project)
    evidence.launches.at(-1).projectEntry = 'first-run-fixture-domain-open'
  } else evidence.launches.at(-1).projectEntry = 'product-automatic-original-root'
  await page.waitForFunction(project => { const element = document.querySelector('app-header'); const domain = element && window.ng?.getComponent(element)?.projectService
    return domain?.currentProjectPath === project && domain?.getBlocklyProjectLoadStatus(project)?.ready }, project, { timeout: 120000 })
  const uiOutput = path.join(values.output, 'launch-' + attempt); await fs.mkdir(uiOutput)
  loaded = await assertInstalledChatLoaded(page, { installedRoot: values['installed-root'], output: uiOutput, expectedApiBase: router.origin,
    expectedInputHash: artifact.inputHash, expectedOutputHash: artifact.outputHash })
  evidence.launches.at(-1).chat = loaded.evidence
  if (attempt) {
    // Do not call the read-only session observer until the product itself has
    // selected/opened the original session through its real UI channel.
    evidence.launches.at(-1).originalSessionOpen = await waitForColdSessionOpen({ project, sessionId, attempt,
      commands: () => evidence.sessionCommands, responses: () => evidence.sessionOpenResponses,
      readRegistry: async () => (await loaded.e2e('session.list')).sessions.filter(value => same(value.cwd, project)) })
  }
}
try {
  model = await createAbsStopModel({ nextTool: async ({ turn, step }) => {
    await observe()
    if (!turn) {
      if (step === 0) return native('cold-load-tools', 'tool_load', { names: ['abs_export', 'abs_apply', 'project_save', 'blocks_set_state'] })
      if (step === 1) return deferred('cold-export-original', 'abs_export', { project })
      if (step === 2) return native('cold-read-before-A', 'read', { path: absPath })
      if (step === 3) return native('cold-edit-A', 'edit', { path: absPath, edits: [{ oldText: `${fixture.blockType}(100)`, newText: `${fixture.blockType}(101)` }] })
      if (step === 4) {
        if (archiveEio) {
          const config = { project, candidateHash: sourceHash(sourceA), generation: originalGeneration,
            initialMapHash: evidence.baseline.mirrors['project.abs.map.json'].hash.slice(7) }
          evidence.archiveFaultInstall = await preload(`(${installColdCandidateArchiveRenameFault.toString()})(${JSON.stringify(config)})`)
          assert.equal(evidence.archiveFaultInstall.available, true, 'Preload fs fault capability is required; do not replace it with a fabricated controller error')
          faultInstalled = true
        }
        return deferred('cold-inspect-state', 'blocks_set_state', { project, action: 'inspect', blockIds: [rootBlock.id], limit: 1 })
      }
      if (step === 5) return deferred('cold-publish-state', 'blocks_set_state', { project, action: 'update', expectedGeneration: inspected.expectedGeneration,
        changes: [{ blockId: rootBlock.id, collapsed: !inspected.instances[0].collapsed }] })
      if (step === 6) {
        if (archiveEio) { providerHeldAfterFault = true; await new Promise(resolve => { faultRelease = resolve }); return undefined }
        return deferred('cold-save-before-crash', 'project_save', { project })
      }
      assert.equal(step, 7); return undefined
    }
    assert.equal(turn, 1)
    if (step === 0) return native('cold-read-restored-A', 'read', { path: absPath })
    if (step === 1) return native('cold-edit-B', 'edit', { path: absPath, edits: [{ oldText: `${fixture.blockType}(200)`, newText: `${fixture.blockType}(201)` }] })
    if (step === 2) return deferred('cold-apply-A-B', 'abs_apply', { project, absPath })
    assert.equal(step, 3); return undefined
  } })
  router = await createLocalChatApiRouter({ operationOrigin: model.origin, installedRoot: values['installed-root'] })
  profile = await prepareInstalledChatProfile({ appData, installedRoot: values['installed-root'], apiBase: router.origin,
    baseConfigPath: path.join(repo, 'electron/config/config.json'), resourceAppData: values['resource-root'], token: router.token })
  await phase('first-real-installed-chat-session'); await launch(0)
  if (archiveEio) {
    evidence.archiveFaultCapabilities = await preload(`({ available: typeof globalThis.process?.getBuiltinModule === 'function'
      && typeof globalThis.process.getBuiltinModule('fs')?.renameSync === 'function' })`)
    if (!evidence.archiveFaultCapabilities.available) {
      evidence.covered = false
      throw Object.assign(new Error('Preload isolated-world Node fs is unavailable; archive EIO boundary is uncovered, no fallback fault is permitted'), { code: 'ABS_CANDIDATE_EIO_INJECTION_UNAVAILABLE' })
    }
  }
  await submit(archiveEio
    ? 'Edit field A to 101, collapse the global block, and retain A unapplied for later continuation. I will stop after the native state change.'
    : 'Edit field A to 101, collapse the global block, and save the current canvas while keeping A unapplied for later continuation.')
  if (archiveEio) {
    const deadline = Date.now() + 120000
    while (!providerHeldAfterFault && Date.now() < deadline) { await observe(); await wait(100) }
    assert.equal(providerHeldAfterFault, true, 'Pause the actual provider request only after the native archive failure tool result')
    const failedTool = evidence.tools.find(value => value.id === 'cold-publish-state'), binding = assertPostAdoptionArchiveFailure(failedTool)
    evidence.archiveFault = await faultState(); assert.equal(evidence.archiveFault.injected, 1)
    const match = evidence.archiveFault.matches[0]
    for (const [file, key] of [['project.abi', 'abiHash'], ['project.abs', 'absHash'], ['project.abs.map.json', 'mapHash']]) {
      assert.equal(sourceHash(await fs.readFile(path.join(project, file))), binding[key]); assert.equal(match[key], binding[key])
    }
    assert.equal(match.currentGeneration, binding.generation); assert.equal(match.intentGeneration, originalGeneration)
    await assert.rejects(fs.readFile(match.target), { code: 'ENOENT' }, 'The failed candidate append must not exist')
    evidence.beforeStop = { state: await state(), mirrors: await mirrors(), binding, originalError: failedTool }
    assert.equal(snapshot.isIdle, false)
    await page.screenshot({ path: path.join(values.output, 'archive-failed-before-chat-stop.png'), fullPage: true })
    await phase('real-chat-stop-after-committed-native-save-and-archive-eio')
    await loaded.frame.locator('button.primary-action.stop-action').click()
    const interruptDeadline = Date.now() + 15000
    while (!model.snapshot().interactions.find(value => value.turn === 0)?.interrupted && Date.now() < interruptDeadline) await wait(100)
    assert.equal(model.snapshot().interactions.find(value => value.turn === 0)?.interrupted, true)
    faultRelease(); faultRelease = undefined
  }
  await settle(1, 'session-before-crash.json')
  const save = evidence.tools.find(value => value.id === 'cold-save-before-crash')?.result
  const publication = evidence.tools.find(value => value.id === 'cold-publish-state')?.result
  if (!archiveEio) {
    assert.equal(save?.ok, true); assert.equal(save.workspaceSaveVerification?.ok, true)
    assert.equal(save.workflowVerification?.candidateApplied, false)
  } else {
    evidence.firstTurnStop = assertUserStoppedAssistant(snapshot)
    await loaded.frame.locator('.x-aily-interruption-divider[role="status"], .x-aily-interruption-text[role="status"]')
      .first().waitFor({ state: 'visible', timeout: 15000 })
    evidence.firstTurnStopUi = await loaded.frame.evaluate(readUserStopTerminalUi)
    assertUserStopTerminalUi(evidence.firstTurnStopUi)
    assert.equal(evidence.abortCommands.length, 1); assert.equal(evidence.abortCommands[0].sessionId, sessionId)
    assert.equal(evidence.abortCommands[0].source, 'user'); assert.equal(evidence.abortCommands[0].reason, 'user_stop')
    assert.ok(evidence.abortResponses.some(value => value.ok && value.accepted === true))
    await loaded.frame.locator('.x-aily-interruption-divider[role="status"], .x-aily-interruption-text[role="status"]').first().waitFor({ state: 'visible', timeout: 15000 })
    assert.equal(await loaded.frame.locator('.chat-part[data-part-type="error"] .x-aily-error-viewer[data-sev="error"]').count(), 0)
    assert.equal(evidence.tools.filter(value => value.name === 'project_save').length, 0, 'Do not heal the failed proof with an extra save')
    await assert.rejects(fs.readFile(evidence.archiveFault.matches[0].target), { code: 'ENOENT' }, 'No implicit healthy archive retry may hide this handoff boundary')
    await page.screenshot({ path: path.join(values.output, 'archive-failed-after-chat-stop.png'), fullPage: true })
  }
  assert.equal(publication?.publication?.status, 'COMMITTED'); assert.equal(publication.stateVerification?.candidateApplied, false)
  assert.notEqual(publication.publication.generation, originalGeneration, 'The real changed collapsed metadata must produce an observable native successor')
  const beforePending = assertColdPendingIntent(snapshot, { project, sessionId, generation: originalGeneration, source: sourceA })
  if (archiveEio) {
    assert.equal(beforePending.retainedCandidateHandoff?.version, 1)
    assert.match(beforePending.retainedCandidateHandoff?.recordHash ?? '', /^sha256:[a-f0-9]{64}$/,
      'The system must persist its own verified post-adoption handoff; the harness cannot bind a proof')
  }
  const backup = beforePending.retainedCandidateBackup
  evidence.candidateA = await verifyCustomerCandidateRecord({ project, backup, candidateHash: sourceHash(sourceA), intentGeneration: originalGeneration })
  const recordBytes = await fs.readFile(backup.path), record = JSON.parse(recordBytes)
  evidence.candidateProof = assertColdCandidateProof(record, { project, source: sourceA, baseSource, generation: originalGeneration })
  const expectedSaved = structuredClone(baseline), expectedRoot = expectedSaved.pages[0].content.blocks.blocks.find(block => block.id === rootBlock.id)
  if (!inspected.instances[0].collapsed) expectedRoot.collapsed = true
  else delete expectedRoot.collapsed
  assert.deepEqual(await nativeDocument(), expectedSaved)
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(project, 'project.abi'), 'utf8')), expectedSaved)
  assert.ok((await fs.readFile(absPath, 'utf8')).includes(`${fixture.blockType}(100)`), 'A must remain unapplied in canonical before the crash')
  evidence.beforeCrash = { sessionId, pending: beforePending, mirrors: await mirrors(), state: await idleUi(),
    originalGeneration, stateGeneration: publication.publication.generation, saveBinding: save?.workspaceSaveVerification.binding ?? publication.receipt.output.binding }
  assert.equal(callsOf(snapshot).filter(value => value.actualName === 'abs_apply').length, 0)
  await page.screenshot({ path: path.join(values.output, 'pending-A-before-crash.png'), fullPage: true })
  await phase('force-kill-exact-owned-host-with-A-still-unapplied')
  if (faultInstalled) { evidence.archiveFaultFinal = await faultState(); assert.equal(evidence.archiveFaultFinal.injected, 1)
    assert.equal(await preload('globalThis.__ailyColdArchiveFault.restore()'), 1); faultInstalled = false }
  evidence.processTreeBeforeCrash = await ownedTree(hostPid)
  assert.equal(await app.evaluate(() => process.pid), hostPid)
  const closed = app.waitForEvent('close', { timeout: 15000 })
  await app.evaluate((_, expected) => {
    if (process.pid !== expected.pid || process.env.AILY_APPDATA_PATH !== expected.appData) throw Error('Refuse unrelated host termination')
    process.kill(process.pid, 'SIGKILL')
  }, { pid: hostPid, appData }).catch(error => { if (!/closed|destroyed|terminated|Target/i.test(error.message)) throw error })
  await closed; app = undefined; page = undefined; loaded = undefined; faultWindow = undefined
  evidence.crashCleanup = await waitOwnedExit(evidence.processTreeBeforeCrash)
  assert.deepEqual(await mirrors(), evidence.beforeCrash.mirrors)
  await phase('cold-original-profile-project-and-chat-session'); await launch(1)
  await observe(); assertColdPendingIntent(snapshot, { project, sessionId, generation: originalGeneration, source: sourceA })
  assert.deepEqual(await nativeDocument(), expectedSaved, 'Cold open must not silently apply A')
  assert.deepEqual(await mirrors(), evidence.beforeCrash.mirrors)
  assert.ok((await fs.readFile(backup.path)).equals(recordBytes), 'Cold open cannot replace the original immutable archive')
  await page.screenshot({ path: path.join(values.output, 'cold-original-session-before-B.png'), fullPage: true })
  await phase('real-next-turn-restores-A-edits-B-and-applies-complete-program')
  await submit('Continue the saved unapplied edit A, change the second field to 201, and apply the complete A+B program in this same project.')
  await settle(2, 'session-after-cold-B.json')
  const readA = evidence.tools.find(value => value.id === 'cold-read-restored-A')
  assert.ok(readA?.text.includes(`${fixture.blockType}(101)`), 'The actual core read must recover A into the editable view before B')
  const applied = evidence.tools.find(value => value.id === 'cold-apply-A-B')?.result
  assert.equal(applied?.ok, true); assert.equal(applied.publication?.status, 'COMMITTED')
  assert.equal(applied.applyVerification?.ok, true); assert.equal(applied.requiresReload, false); assert.equal(applied.absPersistence?.verified, true)
  const expected = singleFieldExpectedDocument(singleFieldExpectedDocument(expectedSaved, fixture.blockId, 'VALUE', 100, 101), 'cold_continuity_second', 'VALUE', 200, 201)
  assert.deepEqual(await nativeDocument(), expected)
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(project, 'project.abi'), 'utf8')), expected)
  for (const [file, key] of [['project.abi', 'abiHash'], ['project.abs', 'absHash'], ['project.abs.map.json', 'mapHash']])
    assert.equal(sourceHash(await fs.readFile(path.join(project, file))), applied.receipt.output.binding[key])
  assert.equal(applied.receipt.validation?.scope, 'complete-generation'); assert.equal(applied.receipt.validation?.ok, true)
  assert.equal(callsOf(snapshot).filter(value => value.actualName === 'abs_apply').length, 1)
  assert.equal(snapshot.messages.filter(message => message.role === 'user').length, 2)
  assert.equal(evidence.sessionCommands.filter(value => value.attempt === 1 && value.type === 'session.create').length, 0)
  const forbidden = ['project_create', 'project_open', 'project_recover', 'project_fork', 'app_open', 'app_reload']
  assert.ok(!callsOf(snapshot).some(value => forbidden.includes(value.actualName)), 'The Agent may not replace, reopen or fork the project to continue A+B')
  evidence.final = { state: await idleUi(), mirrors: await mirrors(), document: expected, sessionId: snapshot.sessionId,
    nativeCommittedApplications: evidence.tools.filter(value => value.name === 'abs_apply' && value.result?.publication?.status === 'COMMITTED').length }
  assert.ok(same(evidence.final.state.project, project)); assert.ok(evidence.final.state.recentProjects.every(value => same(value.path, project)))
  assert.ok((await fs.readFile(backup.path)).equals(recordBytes))
  assert.equal(model.snapshot().createCount, 2); assert.deepEqual(model.snapshot().failures, [])
  await page.screenshot({ path: path.join(values.output, 'final-A-B-after-cold-continuation.png'), fullPage: true })
  evidence.ok = true
} catch (error) {
  evidence.error = { name: error.name, message: error.message, stack: error.stack }
  if (page) { evidence.failureState = await state().catch(error => ({ observationError: error.message })); await page.screenshot({ path: path.join(values.output, 'failure.png'), fullPage: true }).catch(() => {}) }
  if (loaded && sessionId) { const value = await loaded.e2e('session.read', { sessionId }).catch(() => undefined)
    if (value) await fs.writeFile(path.join(values.output, 'failure-session.json'), JSON.stringify(value.session, null, 2)) }
  throw error
} finally {
  faultRelease?.()
  if (faultInstalled && app) await preload('globalThis.__ailyColdArchiveFault?.restore()').catch(error => { evidence.faultRestoreError = error.message })
  if (app) {
    const tree = await ownedTree(hostPid).catch(error => { evidence.cleanupObservationError = error.message; return [] })
    await app.close().catch(error => { evidence.cleanupError = error.message })
    if (tree.length) evidence.finalCleanup = await waitOwnedExit(tree).catch(error => {
      evidence.cleanupError = error.message; return { exitedNaturally: false, remaining: error.remaining } })
  }
  evidence.transport = model?.snapshot(); evidence.api = router?.snapshot()
  await router?.close(); await model?.close()
  evidence.finishedAt = new Date().toISOString(); await persist()
}
assert.deepEqual(await verifyPortableBuild(values['installed-root']), artifact)
assert.equal(artifact.inputHash, sha(JSON.stringify(await captureBuildInputs(values['lex-root']))))
assert.equal(sha(await fs.readFile(asar)), hostHash)
assert.equal(evidence.finalCleanup?.exitedNaturally, true, 'A passing run must leave no owned host descendant alive')
