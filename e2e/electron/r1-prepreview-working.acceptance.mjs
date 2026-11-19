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
import { sourceHash, waitForColdSessionOpen } from './fixtures/abs-cold-continuity.mjs'
import { assertUserStoppedAssistant, assertUserStopTerminalUi, readUserStopTerminalUi } from './fixtures/abs-stop-presentation.mjs'
import { installPrepreviewOperationFault, installPrepreviewGuiWitness, installPrepreviewApplicationAudit,
  assertProtectedApplicationPreparation, assertNoProtectedProjectionPublication } from './fixtures/r1-prepreview-working.mjs'

// Novel boundary: actual GUI-dirty S1 is journaled before loading candidate A
// based on S0. Crash exactly there; product navigation/recovery must restore S1.
const repo = fileURLToPath(new URL('../../', import.meta.url))
const names = ['executable-path', 'installed-root', 'lex-root', 'resource-root', 'test-root', 'output', 'expected-input-hash', 'expected-host-hash']
const { values } = parseArgs({ options: { ...Object.fromEntries(names.map(name => [name, { type: 'string' }])),
  'eio-before-pointer': { type: 'boolean', default: false }, 'kill-committed-apply-before-observe': { type: 'boolean', default: false },
  'stop-during-candidate-read': { type: 'boolean', default: false } } })
const eio = values['eio-before-pointer']
const committedKill = values['kill-committed-apply-before-observe']
const stopCandidateRead = values['stop-during-candidate-read']
assert.ok(!(eio && committedKill), 'Pre-pointer EIO and post-commit reply loss are independent boundaries')
assert.ok(!stopCandidateRead || !eio && !committedKill, 'Candidate-read Stop belongs only to the original UNKNOWN prepreview recovery')
assert.equal(process.env.AILY_R1_PREPREVIEW_HOST_WINDOW, '1', 'Only use the root-coordinated frozen-artifact host window')
for (const name of names.filter(name => !name.startsWith('expected-'))) assert.ok(path.isAbsolute(values[name] ?? ''), `--${name} must be absolute`)
const inside = (root, target) => { const relative = path.relative(root, target); return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) }
const same = (left, right) => typeof left === 'string' && typeof right === 'string' && path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
assert.ok(inside(path.join(repo, 'e2e/test-results'), values.output))
assert.ok(inside(path.join(values['resource-root'], 'dev-tests'), values['test-root']))
assert.match(values['expected-input-hash'] ?? '', /^[a-f0-9]{64}$/)
assert.match(values['expected-host-hash'] ?? '', /^[a-f0-9]{64}$/)
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
assert.equal(hostHash, values['expected-host-hash'])
await fs.mkdir(values.output, { recursive: false }); await fs.mkdir(values['test-root'], { recursive: true })
const suite = await fs.mkdtemp(path.join(values['test-root'], 'r1-prepreview-'))
const project = path.join(suite, 'project'), appData = path.join(suite, 'appdata'), home = path.join(suite, 'home'), temp = path.join(suite, 'temp')
const absPath = path.join(project, 'project.abs')
await fs.mkdir(home); await fs.mkdir(temp)
const fixture = await prepareBuildLogProject({ directory: project, boardsRoot: path.resolve(repo, '../aily-blockly-boards'),
  librariesRoot: path.resolve(repo, '../aily-blockly-libraries'), scenario: 'field-edit', marker: 'R1_PREPREVIEW_NO_COMPILE' })
const seed = JSON.parse(await fs.readFile(path.join(project, 'project.abi'), 'utf8'))
seed.blocks.blocks.find(block => block.type === 'arduino_global').inputs.ARDUINO_GLOBAL.block.next = {
  block: { type: fixture.blockType, id: 'prepreview_gui_second', fields: { VALUE: 200 } } }
await fs.writeFile(path.join(project, 'project.abi'), JSON.stringify(seed, null, 2))
const evidence = { ok: false, suite, project, artifact, hostHash, startedAt: new Date().toISOString(),
  mode: eio ? 'eio-before-operation-pointer-live-only' : committedKill ? 'kill-committed-apply-before-observe'
    : stopCandidateRead ? 'kill-before-preview-cold-stop-candidate-read' : 'kill-after-operation-pointer-before-preview',
  realInstalledChat: true, realAsarHost: true, deterministicLocalModel: true, paidModelRequests: 0,
  replacementToolExecutor: false, manualSessionRestore: false, manualProofBinding: false,
  stages: [], tools: [], sessionCommands: [], sessionOpenResponses: [], abortCommands: [], abortResponses: [], launches: [], resources: [] }
const persist = () => fs.writeFile(path.join(values.output, 'result.json'), JSON.stringify(evidence, null, 2))
const phase = async name => { console.log('PHASE=' + name); evidence.stages.push({ name, at: Date.now() }); await persist() }
const mirrors = async () => Object.fromEntries(await Promise.all(['project.abi', 'project.abs', 'project.abs.map.json', '.aily/abs-sync/committed.json']
  .map(async name => { try { const bytes = await fs.readFile(path.join(project, name)); return [name, { hash: sourceHash(bytes), bytes: bytes.length }] }
    catch (error) { if (error.code === 'ENOENT') return [name, null]; throw error } })))
let app, page, loaded, model, router, profile, hostPid, sessionId, snapshot, baseline, baseSource, sourceA, originalGeneration
let faultWindow, faultInstalled = false, auditInstalled = false, expectedS1, backup, archiveBytes, providerRelease, providerHeld = false
let originalIndexPath, originalIndexBytes, originalSnapshotBytes, restoredOperationPointerBytes
const originalCommittedFiles = new Map()
const observed = new Set(), abortIds = new Set()
const preload = async code => {
  faultWindow ??= await app.browserWindow(page)
  return faultWindow.evaluate((window, code) => window.webContents.executeJavaScriptInIsolatedWorld(999, [{ code }]), code)
}
const faultState = () => preload('globalThis.__ailyPrepreviewFault?.snapshot() ?? { available: false }')
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
    if (message.toolCallId === 'prepreview-original-apply') {
      if (eio) assert.equal(message.isError, true, 'The real operation pointer EIO must remain a failed application')
      // A dead host can return an honest unknown result. It is retained as-is;
      // only actual automatic recovery and the final oracle can pass this case.
      assert.notEqual(result?.publication?.status, 'COMMITTED', 'The pre-preview interrupted request cannot claim a publication')
    } else assert.equal(message.isError === true, false, name + ': ' + textOf(message).slice(0, 1400))
    if (message.toolCallId === 'cold-export-original') {
      originalGeneration = result.generation; baseSource = result.abs; sourceA = baseSource.replace(`${fixture.blockType}(100)`, `${fixture.blockType}(101)`)
      assert.notEqual(sourceA, baseSource); assert.equal(result.publication?.status, 'COMMITTED')
      baseline = await nativeDocument(); evidence.baseline = { document: baseline, mirrors: await mirrors(), generation: originalGeneration }
    }
  }
}
const settle = async (users, filename, accepts = () => true, timeoutMs = 120000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) { assert.deepEqual(model.snapshot().failures, [], 'Fail immediately on deterministic provider setup errors'); await observe()
    if (snapshot?.isIdle && !snapshot.isStreaming && snapshot.messages.filter(message => message.role === 'user').length === users && accepts(snapshot)) {
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
  const { ELECTRON_RUN_AS_NODE, AILY_CHILD_PATH, NODE_PATH, AILY_PORTABLE_ROOT, AILY_AUTH_FILE, AILY_LIBRARY_HOST_PID, ...env } = process.env
  app = await _electron.launch({ executablePath: values['executable-path'], cwd: repo,
    args: [`--user-data-dir=${path.join(suite, 'electron-profile')}`], timeout: 60000,
    env: { ...env, ...profile.env, AILY_E2E: '1', HOME: home, USERPROFILE: home, TEMP: temp, TMP: temp,
      npm_config_offline: 'true', npm_config_audit: 'false' } })
  hostPid = await app.evaluate(() => process.pid); evidence.launches.push({ attempt, hostPid, at: Date.now() }); await persist()
  // Capture the product's actual preflight readonly observation, which is not a
  // model tool result. The witness never emits commands or changes responses.
  const descriptorPath = path.join(home, '.aily-blockly/cli-bridge', hostPid + '.json')
  let descriptor
  const descriptorDeadline = Date.now() + 15000
  while (!descriptor && Date.now() < descriptorDeadline) {
    try { descriptor = JSON.parse(await fs.readFile(descriptorPath, 'utf8')) }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; await wait(100) }
  }
  assert.equal(descriptor?.pid, hostPid)
  evidence.launches.at(-1).passiveAudit = await app.evaluate(installPrepreviewApplicationAudit, {
    pid: hostPid, appData, project, port: descriptor.port, killCommitted: committedKill && !attempt,
    stopCandidateRead: stopCandidateRead && attempt === 1,
    evidencePath: path.join(values.output, 'host-application-audit-' + attempt + '.json') })
  assert.equal(evidence.launches.at(-1).passiveAudit.available, true); auditInstalled = true
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
    assert.deepEqual(model.snapshot().failures, [])
    await observe()
    if (!turn) {
      if (step === 0) return native('cold-load-tools', 'tool_load', { names: ['abs_export', 'abs_validate', 'abs_apply'] })
      if (step === 1) return deferred('cold-export-original', 'abs_export', { project })
      if (step === 2) return native('prepreview-read-S0', 'read', { path: absPath })
      if (step === 3) return native('prepreview-edit-A', 'edit', { path: absPath,
        edits: [{ oldText: `${fixture.blockType}(100)`, newText: `${fixture.blockType}(101)` }] })
      if (step === 4) return deferred('prepreview-validate-A', 'abs_validate', { project, absPath })
      if (step === 5) {
        const validated = evidence.tools.find(value => value.id === 'prepreview-validate-A')?.result
        assert.equal(validated?.ok, true); assert.equal(validated.receipt?.validation?.ok, true)
        backup = validated.candidateArchive
        evidence.candidateA = await verifyCustomerCandidateRecord({ project, backup,
          candidateHash: sourceHash(sourceA), intentGeneration: originalGeneration })
        archiveBytes = await fs.readFile(backup.path)
        const record = JSON.parse(archiveBytes)
        assert.equal(record.candidate.source, sourceA)
        assert.ok(record.candidate.sourceEdits?.length > 0, 'A must be a genuine tracked edit, not fabricated replacement text')
        // The independent actual GUI edit is deliberately newer than candidate A.
        const dirty = await page.evaluate(({ project, blockId }) => {
          const editor = window.ng.getComponent(document.querySelector('app-blockly-editor'))
          if (editor.projectService.currentProjectPath !== project) throw Error('Wrong actual editor project')
          const service = editor.blocklyService, before = service.captureProjectSnapshot()
          const block = window.Blockly.getMainWorkspace().getBlockById(blockId)
          if (!block?.getField('VALUE')) throw Error('Owned GUI field unavailable')
          block.setFieldValue(201, 'VALUE')
          const after = service.captureProjectSnapshot()
          return { beforeRevision: before.revision, afterRevision: after.revision, documentText: after.documentText }
        }, { project, blockId: 'prepreview_gui_second' })
        expectedS1 = singleFieldExpectedDocument(baseline, 'prepreview_gui_second', 'VALUE', 200, 201)
        assert.deepEqual(JSON.parse(dirty.documentText), expectedS1)
        assert.notEqual(dirty.beforeRevision, dirty.afterRevision)
        assert.deepEqual(await mirrors(), evidence.baseline.mirrors, 'A genuine unsaved GUI change cannot have changed S0 mirrors')
        const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
          ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
        const documentHash = sourceHash(JSON.stringify(canonical(expectedS1)))
        evidence.guiS1 = { ...dirty, document: expectedS1, documentHash }
        evidence.previewWitness = await page.evaluate(installPrepreviewGuiWitness, { documentHash })
        evidence.processTreeBeforeCrash = await ownedTree(hostPid)
        await fs.writeFile(path.join(values.output, 'session-before-dispatch.json'), JSON.stringify(snapshot, null, 2))
        await page.screenshot({ path: path.join(values.output, 'dirty-S1-before-preview.png'), fullPage: true })
        await persist()
        const config = { project, hostPid, document: expectedS1, documentHash,
          candidateHash: sourceHash(sourceA), generation: originalGeneration, mirrors: evidence.baseline.mirrors,
          mode: eio ? 'eio-before-pointer' : 'kill-after-pointer', evidencePath: path.join(values.output, 'actual-operation-boundary.json') }
        if (committedKill) {
          const expectedApplied = singleFieldExpectedDocument(expectedS1, fixture.blockId, 'VALUE', 100, 101)
          evidence.committedFaultArmed = await app.evaluate((_, value) => globalThis.__ailyPrepreviewApplicationAudit.armCommittedKill(value), {
            candidateHash: sourceHash(sourceA), generation: originalGeneration, beforeDocument: expectedS1, document: expectedApplied,
            evidencePath: config.evidencePath })
          assert.equal(evidence.committedFaultArmed.armed, true)
        } else {
          evidence.faultInstall = await preload(`(${installPrepreviewOperationFault.toString()})(${JSON.stringify(config)})`)
          assert.equal(evidence.faultInstall.available, true, 'Real isolated-world Node fs must be available; no fake recovery is permitted')
          faultInstalled = true
        }
        await persist()
        return deferred('prepreview-original-apply', 'abs_apply', { project, absPath })
      }
      // Never turn a setup failure, lost reply or first create retry into B.
      assert.equal(step, 6)
      providerHeld = true
      await new Promise(resolve => { providerRelease = resolve })
      return undefined
    }
    assert.equal(turn, 1, 'Continuation is one actual second user turn in the original session')
    assert.equal(snapshot.messages.filter(value => value.role === 'user').length, stopCandidateRead ? 3 : 2,
      'Cancelled preflight must not become a synthetic provider turn or replace the original session')
    if (step === 0) {
      const provider = model.snapshot().requests.find(value => value.turn === 1 && value.step === 0 && value.path === '/api/v3/interactions')
      assert.ok(provider, 'The real cold provider create request must already exist')
      const audit = await app.evaluate(() => globalThis.__ailyPrepreviewApplicationAudit.snapshot())
      const currentPrompt = evidence.sessionCommands.filter(value => value.attempt === 1 && value.type === 'prompt').at(-1)
      if (stopCandidateRead) assert.ok(currentPrompt && currentPrompt.at >= evidence.lateCandidateBody.releasedAt)
      evidence.protectedPreparation = assertProtectedApplicationPreparation(audit, {
        requestId: evidence.actualBoundary.requestId, firstProviderAt: provider.at, publication: committedKill ? 'COMMITTED' : 'UNKNOWN',
        ...(stopCandidateRead ? { observationNotBefore: currentPrompt.at } : {}) })
      if (stopCandidateRead) assert.ok(audit.responses.filter(value => value.action === 'observe_apply'
        && value.requestId === evidence.actualBoundary.requestId).length >= 2, 'The resumed owner must independently observe the old request again')
      if (!committedKill) assert.deepEqual(await mirrors(), evidence.baseline.mirrors,
        'Protected preparation cannot publish dirty S1 before restoring the original pending A')
      await persist()
      return native('prepreview-read-restored-A', 'read', { path: absPath })
    }
    if (step === 1) return native('prepreview-edit-B', 'edit', { path: absPath,
      edits: [{ oldText: `${fixture.blockType}(101)`, newText: `${fixture.blockType}(102)` }] })
    if (step === 2) {
      if (!committedKill) {
        const audit = await app.evaluate(() => globalThis.__ailyPrepreviewApplicationAudit.snapshot())
        assertNoProtectedProjectionPublication(audit.commands, Date.now())
        const disk = await mirrors(); assert.deepEqual(disk, evidence.baseline.mirrors,
          'All four S0 mirrors must stay exact until the new B application is requested')
        evidence.beforeBApply = { at: Date.now(), mirrors: disk, protectedCommands: audit.commands }; await persist()
      }
      return deferred('prepreview-apply-A-B-C', 'abs_apply', { project, absPath })
    }
    assert.equal(step, 3); return undefined
  } })
  router = await createLocalChatApiRouter({ operationOrigin: model.origin, installedRoot: values['installed-root'] })
  profile = await prepareInstalledChatProfile({ appData, installedRoot: values['installed-root'], apiBase: router.origin,
    baseConfigPath: path.join(repo, 'electron/config/config.json'), resourceAppData: values['resource-root'], token: router.token })
  await phase('actual-installed-chat-creates-A-and-gui-creates-dirty-S1'); await launch(0)
  // Register before dispatch; handle the timeout immediately so a failed setup
  // cannot produce a detached unhandled rejection while preserving diagnostics.
  const closed = app.waitForEvent('close', { timeout: 150000 }).then(() => ({ closed: true }), error => ({ closed: false, message: error.message }))
  await submit('Change the first field to 101, validate it and apply the complete program while retaining other current edits.')
  let actualBoundary
  const deadline = Date.now() + 120000
  while (Date.now() < deadline) {
    assert.deepEqual(model.snapshot().failures, [], 'A setup error cannot masquerade as a successful crash boundary')
    try { actualBoundary = JSON.parse(await fs.readFile(path.join(values.output, 'actual-operation-boundary.json'), 'utf8')); break }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    await wait(100)
  }
  assert.ok(actualBoundary, 'The actual native apply must reach the qualified operation pointer boundary')
  evidence.actualBoundary = actualBoundary
  assert.equal(actualBoundary.candidateHash, sourceHash(sourceA)); assert.equal(actualBoundary.generation, originalGeneration)
  assert.equal(actualBoundary.hostPid, hostPid)
  if (!committedKill) { assert.equal(actualBoundary.witness.loadCalls, 0); assert.equal(actualBoundary.witness.clearCalls, 0) }
  else {
    assert.equal(actualBoundary.mode, 'kill-committed-apply-before-observe'); assert.equal(actualBoundary.candidateApplied, true)
    assert.equal(actualBoundary.response.originalEndDelegated, false); assert.equal(actualBoundary.response.destroyed, true)
    assert.equal(actualBoundary.response.socketBytesBefore, actualBoundary.response.socketBytesAtEnd)
  }
  if (eio) {
    assert.equal(actualBoundary.durablePointer, false, 'A pre-pointer EIO is explicitly not a durable cold recovery proof')
    const heldDeadline = Date.now() + 30000
    while (!providerHeld && Date.now() < heldDeadline) { assert.deepEqual(model.snapshot().failures, []); await observe(); await wait(100) }
    assert.equal(providerHeld, true)
    evidence.fault = await faultState(); assert.equal(evidence.fault.injected, 1)
    evidence.afterEio = { state: await state(), mirrors: await mirrors(), document: await nativeDocument(),
      witness: await page.evaluate(() => globalThis.__ailyPrepreviewGui.snapshot()),
      failedTool: evidence.tools.find(value => value.id === 'prepreview-original-apply') }
    assert.equal(evidence.afterEio.failedTool?.isError, true)
    assert.equal(evidence.afterEio.witness.loadCalls, 0); assert.equal(evidence.afterEio.witness.clearCalls, 0)
    assert.deepEqual(evidence.afterEio.document, expectedS1)
    assert.deepEqual(evidence.afterEio.mirrors, evidence.baseline.mirrors)
    const pointer = await fs.readFile(path.join(project, '.aily/abs-sync/operation.json'), 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error })
    assert.notEqual(pointer && JSON.parse(pointer).id, actualBoundary.pointer.id)
    evidence.afterEio.pointer = pointer
    evidence.coverage = { liveDirtyS1Preserved: true, noPreview: true, originalMirrorsPreserved: true, coldRecoveryTested: false }
    await page.screenshot({ path: path.join(values.output, 'operation-pointer-eio-live-S1.png'), fullPage: true })
    // End this test-owned pending provider via the real Chat Stop. This cleanup
    // is not classified as the pre-preview durability qualification.
    await loaded.frame.locator('button.primary-action.stop-action').click()
    providerRelease(); providerRelease = undefined
    await settle(1, 'session-after-live-eio.json')
    assert.equal(await preload('globalThis.__ailyPrepreviewFault.restore()'), 1); faultInstalled = false
    await page.evaluate(() => globalThis.__ailyPrepreviewGui.restore())
    evidence.final = { state: await idleUi(), mirrors: await mirrors() }
    evidence.ok = true
  } else {
    assert.equal(actualBoundary.durablePointer, true)
    const closeResult = await closed; assert.equal(closeResult.closed, true, closeResult.message)
    app = undefined; page = undefined; loaded = undefined; faultWindow = undefined; faultInstalled = false; auditInstalled = false
    evidence.crashCleanup = await waitOwnedExit(evidence.processTreeBeforeCrash)
    const expectedBeforeCold = committedKill ? actualBoundary.mirrors : evidence.baseline.mirrors
    assert.deepEqual(await mirrors(), expectedBeforeCold)
    const pointer = JSON.parse(await fs.readFile(path.join(project, '.aily/abs-sync/operation.json'), 'utf8'))
    assert.deepEqual(pointer, actualBoundary.pointer)
    const snapshotBytes = await fs.readFile(actualBoundary.snapshotPath), checkpoint = JSON.parse(snapshotBytes)
    assert.equal(sourceHash(snapshotBytes), pointer.hash); assert.deepEqual(checkpoint.document, expectedS1)
    assert.equal(checkpoint.candidate.source, sourceA); assert.equal(checkpoint.candidate.generation, originalGeneration)
    if (committedKill) for (const reference of actualBoundary.immutable) {
      const bytes = await fs.readFile(reference.path)
      assert.equal(sourceHash(bytes), reference.hash); assert.equal(bytes.length, reference.bytes)
      originalCommittedFiles.set(reference.path, bytes)
    }
    evidence.originalApplication = checkpoint.application
    originalSnapshotBytes = snapshotBytes
    originalIndexPath = path.join(project, '.aily/abs-sync/recoveries', 'request-' + sha(checkpoint.application.requestId) + '.json')
    originalIndexBytes = await fs.readFile(originalIndexPath)
    const originalIndex = JSON.parse(originalIndexBytes)
    assert.equal(originalIndex.requestId, checkpoint.application.requestId)
    assert.equal(originalIndex.operationId, pointer.id); assert.equal(originalIndex.snapshotHash, sourceHash(snapshotBytes))
    evidence.originalImmutableRequest = { path: originalIndexPath, hash: sourceHash(originalIndexBytes), snapshotPath: actualBoundary.snapshotPath,
      snapshotHash: sourceHash(snapshotBytes), requestId: checkpoint.application.requestId, operationId: pointer.id }
    evidence.beforeCold = { sessionId, mirrors: await mirrors(), pointer, candidateArchive: evidence.candidateA }
    await phase(committedKill ? 'cold-automatic-original-project-session-keeps-committed-A-C' : 'cold-automatic-original-project-and-session-restores-dirty-S1'); await launch(1)
    await observe()
    const expectedColdDocument = committedKill ? singleFieldExpectedDocument(expectedS1, fixture.blockId, 'VALUE', 100, 101) : expectedS1
    assert.deepEqual(await nativeDocument(), expectedColdDocument, committedKill
      ? 'The exact original committed A+C must stay visible; do not roll it back to dirty S1' : 'The recovered GUI must contain dirty S1, not old saved S0 or candidate A')
    assert.deepEqual(await mirrors(), expectedBeforeCold, 'Cold recovery cannot rewrite the qualified original publication')
    restoredOperationPointerBytes = await fs.readFile(path.join(project, '.aily/abs-sync/operation.json'))
    const restoredPointer = JSON.parse(restoredOperationPointerBytes)
    assert.equal(restoredPointer.id, pointer.id); assert.equal(restoredPointer.hash, pointer.hash); assert.equal(restoredPointer.state, committedKill ? 'completed' : 'restored')
    assert.ok((await fs.readFile(backup.path)).equals(archiveBytes))
    evidence.afterCold = { state: await state(), mirrors: await mirrors(), document: await nativeDocument(), sessionId: snapshot.sessionId }
    await fs.writeFile(path.join(values.output, 'session-after-automatic-cold.json'), JSON.stringify(snapshot, null, 2))
    await page.screenshot({ path: path.join(values.output, committedKill ? 'cold-auto-original-committed-A-C.png' : 'cold-auto-restored-dirty-S1.png'), fullPage: true })
    if (stopCandidateRead) {
      await phase('pause-real-full-proof-candidate-read-after-valid-original-observation')
      const pending = snapshot.entries.filter(value => value.type === 'custom' && value.customType === 'aily.abs-workflow'
        && same(value.data?.project, project)).at(-1)?.data
      assert.equal(pending?.applicationRequestId, checkpoint.application.requestId)
      assert.equal(pending.intentGeneration, originalGeneration); assert.equal(pending.retainedCandidate.hash, sourceHash(sourceA))
      const reference = pending.retainedCandidateBackup
      await verifyCustomerCandidateRecord({ project, backup: reference, candidateHash: sourceHash(sourceA), intentGeneration: originalGeneration })
      const proofBytes = await fs.readFile(reference.path), proofRecord = JSON.parse(proofBytes)
      assert.ok(proofRecord.candidate.editProof, 'The real dispatch backup must retain its complete original proof')
      evidence.candidateReadFaultArmed = await app.evaluate((_, config) => globalThis.__ailyPrepreviewApplicationAudit.armCandidateRead(config), {
        recordHash: reference.recordHash, candidateHash: sourceHash(sourceA), generation: originalGeneration,
        applicationRequestId: checkpoint.application.requestId, baseSource })
      assert.equal(evidence.candidateReadFaultArmed.armed, true)
      const oldMarkers = await loaded.frame.locator('.x-aily-interruption-divider[role="status"], .x-aily-interruption-text[role="status"]').count()
      await submit('Continue the retained edit in this same project.')
      let paused; const heldDeadline = Date.now() + 30000
      while (Date.now() < heldDeadline) {
        assert.deepEqual(model.snapshot().failures, [])
        const audit = await app.evaluate(() => globalThis.__ailyPrepreviewApplicationAudit.snapshot())
        assert.deepEqual(audit.failures, []); paused = audit.candidateRead
        if (paused?.held) break
        await wait(50)
      }
      assert.equal(paused?.held, true, 'The actual successful full-proof read response must be paused before SDK adoption')
      assert.equal(paused.recordHash, reference.recordHash); assert.equal(paused.applicationRequestId, checkpoint.application.requestId)
      assert.equal(paused.originalEndDelegated, false); assert.equal(model.snapshot().createCount, 1)
      await page.screenshot({ path: path.join(values.output, 'candidate-read-held-before-chat-stop.png'), fullPage: true })
      await loaded.frame.locator('button.primary-action.stop-action').waitFor({ state: 'visible', timeout: 5000 })
      evidence.candidateStopClickedAt = Date.now(); await loaded.frame.locator('button.primary-action.stop-action').click()
      await settle(2, 'session-stopped-during-candidate-read.json', value => {
        const request = value.entries.findLast(entry => entry.customType === 'aily.abort-request')
        const assistant = value.entries.findLast(entry => entry.type === 'message' && entry.message.role === 'assistant')
        const trace = value.entries.findLast(entry => entry.customType === 'aily.trace' && entry.data?.phase === 'run_settled')
        return request && assistant && value.entries.indexOf(request) < value.entries.indexOf(assistant)
          && assistant.message.stopReason === 'aborted'
          && trace?.data?.status === 'aborted' && trace.data.completedAt >= Date.parse(assistant.timestamp)
      }, 15000)
      evidence.candidateReadStop = assertUserStoppedAssistant(snapshot)
      await loaded.frame.waitForFunction(previous => document.querySelectorAll('.x-aily-interruption-divider[role="status"], .x-aily-interruption-text[role="status"]').length > previous, oldMarkers)
      evidence.candidateReadStopUi = await loaded.frame.evaluate(readUserStopTerminalUi); assertUserStopTerminalUi(evidence.candidateReadStopUi)
      let cancelled; const cancelDeadline = Date.now() + 5000
      do { cancelled = await app.evaluate(() => globalThis.__ailyPrepreviewApplicationAudit.snapshot()); if (cancelled.candidateRead.socketCancelled) break; await wait(50) } while (Date.now() < cancelDeadline)
      assert.equal(cancelled.candidateRead.socketCancelled, true)
      assert.ok(cancelled.candidateRead.closedAt >= evidence.candidateReadStop.rawAbortRequestEntry.data.requestedAt)
      assert.equal(model.snapshot().createCount, 1, 'A candidate-read Stop cannot start any new provider request')
      assert.deepEqual(await mirrors(), evidence.baseline.mirrors); assert.deepEqual(await nativeDocument(), expectedS1)
      const latestPending = snapshot.entries.filter(value => value.customType === 'aily.abs-workflow' && same(value.data?.project, project)).at(-1)?.data
      assert.deepEqual(latestPending, pending, 'Stop must retain the original application, intent and exact full-proof reference')
      assert.ok((await fs.readFile(reference.path)).equals(proofBytes))
      const overlays = await fs.readdir(path.join(project, '.workspace-history/overlays')).catch(error => { if (error.code === 'ENOENT') return []; throw error })
      assert.deepEqual(overlays, [], 'The stopped preflight must leave no active or orphan working overlay')
      evidence.candidateReadStopped = { audit: cancelled.candidateRead, pending: latestPending, overlays, state: await idleUi(), mirrors: await mirrors() }
      assert.equal(await app.evaluate(() => globalThis.__ailyPrepreviewApplicationAudit.releaseCandidateRead()), true)
      await wait(250); await observe()
      assert.equal(model.snapshot().createCount, 1); assert.deepEqual(await mirrors(), evidence.baseline.mirrors)
      assert.deepEqual(await nativeDocument(), expectedS1)
      const afterLate = snapshot.entries.filter(value => value.customType === 'aily.abs-workflow' && same(value.data?.project, project)).at(-1)?.data
      assert.deepEqual(afterLate, pending, 'A late cancelled body must not retire or adopt the old request')
      assert.ok((await fs.readFile(reference.path)).equals(proofBytes))
      evidence.lateCandidateBody = await app.evaluate(() => globalThis.__ailyPrepreviewApplicationAudit.snapshot().candidateRead)
      assert.equal(evidence.lateCandidateBody.held, false); assert.equal(evidence.lateCandidateBody.originalEndDelegated, true)
      await page.screenshot({ path: path.join(values.output, 'candidate-read-stopped-and-late-body-released.png'), fullPage: true })
    }
    await phase('same-session-next-user-turn-continues-A-B-with-gui-C')
    await submit('Continue the retained edit, change its first field from 101 to 102, and apply the whole program while keeping the other current GUI edit.')
    await settle(stopCandidateRead ? 3 : 2, 'session-after-A-B-C.json')
    const readA = evidence.tools.find(value => value.id === 'prepreview-read-restored-A')
    assert.ok(readA?.text.includes(`${fixture.blockType}(101)`), 'Actual core read must restore original A before tracked edit B')
    if (committedKill) assert.ok(readA.text.includes(`${fixture.blockType}(201)`), 'After observing COMMITTED, core read must include canonical A+C')
    const applied = evidence.tools.find(value => value.id === 'prepreview-apply-A-B-C')?.result
    assert.equal(applied?.ok, true); assert.equal(applied.publication?.status, 'COMMITTED')
    assert.equal(applied.publication.abiSaved, true); assert.equal(applied.publication.absMirrored, true); assert.equal(applied.publication.mapPublished, true)
    assert.equal(applied.applyVerification?.ok, true); assert.equal(applied.requiresReload, false); assert.equal(applied.absPersistence?.verified, true)
    const expected = singleFieldExpectedDocument(expectedS1, fixture.blockId, 'VALUE', 100, 102)
    assert.deepEqual(await nativeDocument(), expected)
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(project, 'project.abi'), 'utf8')), expected)
    for (const [file, key] of [['project.abi', 'abiHash'], ['project.abs', 'absHash'], ['project.abs.map.json', 'mapHash']])
      assert.equal(sourceHash(await fs.readFile(path.join(project, file))), applied.receipt.output.binding[key])
    const finalMap = JSON.parse(await fs.readFile(path.join(project, 'project.abs.map.json'), 'utf8'))
    assert.equal(finalMap.generation, applied.receipt.output.binding.generation)
    assert.deepEqual(finalMap.scope, applied.receipt.output.binding.scope)
    assert.equal(finalMap.baseAbsHash, applied.receipt.output.binding.absHash)
    assert.equal(applied.receipt.validation?.scope, 'complete-generation'); assert.equal(applied.receipt.validation?.ok, true)
    if (committedKill) assert.equal(applied.receipt.intentGeneration ?? applied.receipt.base.generation, actualBoundary.binding.generation,
      'New B begins from the verified committed A+C, not the retired unknown intent')
    assert.notEqual(applied.receipt.requestId, checkpoint.application.requestId, 'B must use a fresh application identity')
    assert.ok((await fs.readFile(originalIndexPath)).equals(originalIndexBytes), 'The original UNKNOWN request index stays immutable')
    assert.ok((await fs.readFile(actualBoundary.snapshotPath)).equals(originalSnapshotBytes), 'Recovery cannot rewrite original S1/candidate/request facts')
    evidence.finalApplicationAudit = await app.evaluate(() => globalThis.__ailyPrepreviewApplicationAudit.snapshot())
    const originalAudit = JSON.parse(await fs.readFile(path.join(values.output, 'host-application-audit-0.json'), 'utf8'))
    const audits = [originalAudit, evidence.finalApplicationAudit]
    for (const [index, audit] of audits.entries()) {
      assert.deepEqual(audit.failures, []); assert.equal(audit.commandsSentByObserver, 0)
      assert.equal(audit.responsesModified, committedKill && index === 0 ? 1 : 0)
    }
    const commands = audits.flatMap(audit => audit.commands), responses = audits.flatMap(audit => audit.responses)
    assert.equal(commands.filter(command => command.operation === 'abs_apply' && command.requestId === checkpoint.application.requestId).length, 1,
      'The original interrupted request must never be submitted again')
    const newApplies = commands.filter(command => command.operation === 'abs_apply' && command.requestId !== checkpoint.application.requestId)
    assert.equal(newApplies.length, 1); assert.equal(newApplies[0].requestId, applied.receipt.requestId)
    if (!committedKill) assertNoProtectedProjectionPublication(evidence.finalApplicationAudit.commands, newApplies[0].at)
    const recoveredObservation = responses.find(response => response.operation === 'abs_recovery'
      && response.requestId === checkpoint.application.requestId && (committedKill
        ? response.publication?.status === 'COMMITTED' && response.applicationObservation?.current === true : response.currentDocumentRecovery))
    assert.ok(recoveredObservation, 'The system must actually observe the original request and independent current-document recovery')
    assert.equal(recoveredObservation.publication?.status, committedKill ? 'COMMITTED' : 'UNKNOWN')
    assert.equal(recoveredObservation.applicationObservation?.requestId, checkpoint.application.requestId)
    assert.equal(recoveredObservation.applicationObservation?.current, committedKill)
    if (committedKill) {
      assert.equal(recoveredObservation.receipt?.requestId, checkpoint.application.requestId)
      assert.deepEqual(recoveredObservation.receipt.outputBinding, actualBoundary.binding)
      for (const [file, bytes] of originalCommittedFiles) assert.ok((await fs.readFile(file)).equals(bytes), 'Original commit result stays immutable: ' + file)
      evidence.originalCommittedRecoveryAudit = recoveredObservation
    } else {
      const recovery = recoveredObservation.currentDocumentRecovery
    assert.equal(recovery.scope, 'restored-working-document'); assert.equal(recovery.state, 'restored')
    assert.equal(recovery.requestId, checkpoint.application.requestId); assert.equal(recovery.operationId, pointer.id)
    assert.equal(recovery.snapshotHash, sourceHash(originalSnapshotBytes)); assert.equal(recovery.operationPointerHash, sourceHash(restoredOperationPointerBytes))
    assert.equal(recovery.documentHash, evidence.guiS1.documentHash); assert.equal(recovery.originalPublication, 'UNKNOWN')
    assert.equal(recovery.candidateApplied, false); assert.equal(recovery.oldWriter?.state, 'exited')
    assert.equal(recovery.originalExecutor?.hostPid, evidence.launches[0].hostPid)
    assert.equal(recovery.originalExecutor?.storagePid, actualBoundary.preloadPid)
    assert.equal(recovery.observerExecutor?.hostPid, hostPid)
    assert.equal(recovery.candidate.hash, sourceHash(sourceA)); assert.equal(recovery.candidate.intentGeneration, originalGeneration)
      evidence.originalUnknownRecoveryAudit = recoveredObservation
    }
    const finalWorkflow = snapshot.entries.filter(value => value.type === 'custom' && value.customType === 'aily.abs-workflow'
      && same(value.data?.project, project)).at(-1)?.data
    assert.ok(finalWorkflow); assert.notEqual(finalWorkflow.status, 'blocked'); assert.equal(finalWorkflow.applicationRequestId, undefined)
    assert.equal(snapshot.messages.filter(message => message.role === 'user').length, stopCandidateRead ? 3 : 2)
    assert.equal(evidence.sessionCommands.filter(value => value.attempt === 1 && value.type === 'session.create').length, 0)
    const forbidden = ['project_create', 'project_open', 'project_recover', 'project_fork', 'app_open', 'app_reload']
    assert.ok(!callsOf(snapshot).some(value => forbidden.includes(value.actualName)), 'Do not reopen/copy or manually resolve the original application')
    evidence.final = { state: await idleUi(), mirrors: await mirrors(), document: expected, sessionId: snapshot.sessionId }
    assert.ok(same(evidence.final.state.project, project)); assert.ok(evidence.final.state.recentProjects.every(value => same(value.path, project)))
    assert.ok((await fs.readFile(backup.path)).equals(archiveBytes))
    assert.equal(model.snapshot().createCount, 2); assert.deepEqual(model.snapshot().failures, [])
    await page.screenshot({ path: path.join(values.output, 'final-A-B-C-same-root.png'), fullPage: true })
    evidence.ok = true
  }
} catch (error) {
  evidence.error = { name: error.name, message: error.message, stack: error.stack }
  if (page) { evidence.failureState = await state().catch(error => ({ observationError: error.message })); await page.screenshot({ path: path.join(values.output, 'failure.png'), fullPage: true }).catch(() => {}) }
  if (loaded && sessionId) { const value = await loaded.e2e('session.read', { sessionId }).catch(() => undefined)
    if (value) await fs.writeFile(path.join(values.output, 'failure-session.json'), JSON.stringify(value.session, null, 2)) }
  await persist()
  throw error
} finally {
  providerRelease?.()
  if (faultInstalled && app) await preload('globalThis.__ailyPrepreviewFault?.restore()').catch(error => { evidence.faultRestoreError = error.message })
  if (auditInstalled && app) await app.evaluate(() => globalThis.__ailyPrepreviewApplicationAudit.restore()).catch(error => { evidence.auditRestoreError = error.message })
  if (app) {
    const tree = await ownedTree(hostPid).catch(error => { evidence.cleanupObservationError = error.message; return [] })
    if (stopCandidateRead || eio) {
      let closeTimer
      const closing = app.close().then(() => true, error => { evidence.cleanupError = error.message; return false })
      // The EIO oracle deliberately leaves GUI-dirty S1. Closing it requires the
      // existing unsaved-changes choice, after all business assertions and Stop.
      // This is test cleanup, never an automatic-recovery qualification.
      if (eio && evidence.ok) {
        try {
          const dialog = page.locator('app-unsave-dialog')
          await dialog.waitFor({ state: 'visible', timeout: 10000 })
          assert.deepEqual(await mirrors(), evidence.baseline.mirrors)
          const text = await dialog.innerText()
          assert.ok(text.includes('未保存的更改') && text.includes('是否在关闭前保存更改?'))
          const skip = dialog.getByRole('button', { name: '跳过保存', exact: true })
          assert.equal(await skip.count(), 1)
          evidence.explicitEioCleanup = { at: Date.now(), choice: '跳过保存', dialogText: text,
            afterBusinessAssertions: true, recoveryQualification: false }
          await skip.click()
          assert.deepEqual(await mirrors(), evidence.baseline.mirrors)
        } catch (error) {
          evidence.eioCleanupError = error.message; evidence.ok = false
        }
      }
      const closed = await Promise.race([closing,
        new Promise(resolve => { closeTimer = setTimeout(() => resolve(false), 20000) })]).finally(() => clearTimeout(closeTimer))
      if (!closed) {
        evidence.forcedFailureCleanup = true; evidence.ok = false
        await app.evaluate((_, owned) => {
          if (process.pid !== owned.pid || process.env.AILY_APPDATA_PATH !== owned.appData) throw Error('Refuse unrelated cleanup termination')
          process.kill(process.pid, 'SIGKILL')
        }, { pid: hostPid, appData }).catch(error => { evidence.cleanupTermination = error.message })
      }
    } else await app.close().catch(error => { evidence.cleanupError = error.message })
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
assert.equal(evidence.forcedFailureCleanup, undefined, 'Forced cleanup cannot turn a failed cancellation into a pass')
assert.equal(evidence.ok, true, 'Business verification and any explicit test cleanup must both complete')
