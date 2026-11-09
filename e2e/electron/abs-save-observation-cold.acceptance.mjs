import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { parseArgs, promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { _electron } from '@playwright/test'
import { createAbsStopModel } from '../fixtures/abs-stop-model.mjs'
import { createLocalChatApiRouter, prepareInstalledChatProfile, assertInstalledChatLoaded } from '../fixtures/installed-chat-ui.mjs'
import { prepareBuildLogProject } from './fixtures/build-log-project.mjs'
import { singleFieldExpectedDocument } from './fixtures/online-comparison.mjs'
import { verifyCustomerCandidateRecord } from './fixtures/customer-local-library.mjs'
import { assertCustomerRootLayoutOnly } from './fixtures/customer-state-layout.mjs'
import { assertColdCandidateProof, assertColdPendingIntent, sourceHash, waitForColdSessionOpen } from './fixtures/abs-cold-continuity.mjs'
import { assertUserStoppedAssistant, assertUserStopTerminalUi, readUserStopTerminalUi } from './fixtures/abs-stop-presentation.mjs'
import { assertNativeSaveContinuationPhase, assertNoNativeSaveModelFailures, installNativeSaveObservationFault } from './fixtures/native-save-observation-fault.mjs'

// A novel native boundary: real G1 state save -> real tidy G2, lost terminal
// replies -> SDK pendingSave -> original-ID observation -> Stop and cold B.
// Neither a model service nor a replacement receipt/proof executor is used.
const repo = fileURLToPath(new URL('../../', import.meta.url))
const names = ['executable-path', 'installed-root', 'lex-root', 'resource-root', 'test-root', 'output', 'expected-input-hash']
const { values } = parseArgs({ options: { ...Object.fromEntries(names.map(name => [name, { type: 'string' }])),
  'kill-before-observe': { type: 'boolean', default: false }, 'stop-during-cold-observation': { type: 'boolean', default: false } } })
const killBeforeObserve = values['kill-before-observe']
const stopDuringCold = values['stop-during-cold-observation']
assert.ok(!stopDuringCold || killBeforeObserve)
assert.equal(process.env.AILY_ABS_SAVE_OBSERVATION_HOST_WINDOW, '1', 'Use the root-coordinated frozen-artifact host window')
for (const name of names.filter(name => name !== 'expected-input-hash')) assert.ok(path.isAbsolute(values[name] ?? ''))
const inside = (root, file) => { const relative = path.relative(root, file); return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) }
const same = (left, right) => typeof left === 'string' && typeof right === 'string' && path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
assert.ok(inside(path.join(repo, 'e2e/test-results'), values.output)); assert.ok(inside(path.join(values['resource-root'], 'dev-tests'), values['test-root']))
assert.match(values['expected-input-hash'] ?? '', /^[a-f0-9]{64}$/)
const sha = bytes => createHash('sha256').update(bytes).digest('hex'), wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const exec = promisify(execFile)
const processes = async () => { const result = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate | ConvertTo-Json -Compress'], { windowsHide: true, timeout: 15000 })
  const list = JSON.parse(result.stdout); return Array.isArray(list) ? list : [list] }
const ownedTree = async pid => { const all = await processes(), ids = new Set([pid]); let changed
  do { changed = false; for (const item of all) if (ids.has(item.ParentProcessId) && !ids.has(item.ProcessId)) { ids.add(item.ProcessId); changed = true } } while (changed)
  return all.filter(item => ids.has(item.ProcessId)) }
const exited = async tree => { const deadline = Date.now() + 30000; let remaining
  do { const current = await processes(); remaining = tree.filter(item => current.some(value => value.ProcessId === item.ProcessId && value.CreationDate === item.CreationDate))
    if (!remaining.length) return { exitedNaturally: true, remaining: [] }; await wait(500) } while (Date.now() < deadline)
  throw Object.assign(Error('Owned host descendants remain; never terminate unrelated applications'), { remaining }) }
const textOf = message => (message?.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n')
const payloadOf = message => { if (message?.details?.result) return message.details.result; try { return JSON.parse(textOf(message)) } catch { return undefined } }
const callsOf = snapshot => (snapshot?.messages ?? []).filter(message => message.role === 'assistant').flatMap(message => message.content ?? [])
  .filter(part => part.type === 'toolCall').map(call => ({ ...call, actualName: call.name === 'tool_invoke' ? call.arguments.name : call.name }))
const native = (id, name, args) => ({ id, name, arguments: args }), deferred = (id, name, args) => native(id, 'tool_invoke', { name, arguments: args })
const { verifyPortableBuild } = await import(pathToFileURL(path.join(values['lex-root'], 'packages/aily-chat/server/portable-integrity.ts')))
const { captureBuildInputs } = await import(pathToFileURL(path.join(values['lex-root'], 'packages/aily-chat/scripts/portable-build-inputs.mjs')))
const artifact = await verifyPortableBuild(values['installed-root'])
assert.equal(artifact.inputHash, values['expected-input-hash']); assert.equal(artifact.inputHash, sha(JSON.stringify(await captureBuildInputs(values['lex-root']))))
const asar = path.join(path.dirname(values['executable-path']), 'resources/app.asar'), hostHash = sha(await fs.readFile(asar))
await fs.mkdir(values.output, { recursive: false }); await fs.mkdir(values['test-root'], { recursive: true })
const suite = await fs.mkdtemp(path.join(values['test-root'], 'abs-save-observe-')), project = path.join(suite, 'project')
const appData = path.join(suite, 'appdata'), home = path.join(suite, 'home'), temp = path.join(suite, 'temp'), absPath = path.join(project, 'project.abs')
for (const directory of [home, temp]) await fs.mkdir(directory)
const fixture = await prepareBuildLogProject({ directory: project, boardsRoot: path.resolve(repo, '../aily-blockly-boards'),
  librariesRoot: path.resolve(repo, '../aily-blockly-libraries'), scenario: 'field-edit', marker: 'ABS_SAVE_OBSERVE_NO_COMPILE' })
const seed = JSON.parse(await fs.readFile(path.join(project, 'project.abi'), 'utf8'))
seed.blocks.blocks.find(block => block.type === 'arduino_global').inputs.ARDUINO_GLOBAL.block.next = {
  block: { type: fixture.blockType, id: 'save_observation_second', fields: { VALUE: 200 } } }
// Owned fixture data, before any host opens it. A later real tidy must perform
// visible root-coordinate work, rather than inventing a generation for a no-op.
seed.blocks.blocks.forEach((block, index) => { block.x = 240 + index * 230; block.y = 300 + index * 270 })
await fs.writeFile(path.join(project, 'project.abi'), JSON.stringify(seed, null, 2))
const evidence = { ok: false, suite, project, artifact, hostHash, startedAt: new Date().toISOString(),
  realInstalledChat: true, realAsarHost: true, paidModelRequests: 0, deterministicLocalModel: true,
  fabricatedHostReceipts: false, manualProofBinding: false, manualSessionRestore: false, killBeforeObserve, stopDuringCold,
  stages: [], tools: [], launches: [], sessionCommands: [], sessionResponses: [], abortCommands: [], abortResponses: [], resources: [] }
const persist = () => fs.writeFile(path.join(values.output, 'result.json'), JSON.stringify(evidence, null, 2))
const phase = async name => { console.log('PHASE=' + name); evidence.stages.push({ name, at: Date.now() }); await persist() }
let app, page, loaded, model, router, profile, hostPid, sessionId, snapshot, baseline, baseSource, sourceA, generation, inspected, rootId
let g1Document, g1, expectedSaved, pendingArgs, held = false, release, faultInstalled = false, coldReopened = false, originalHostPid
const seen = new Set(), abortIds = new Set()
const document = () => page.evaluate(() => JSON.parse(window.ng.getComponent(window.document.querySelector('app-blockly-editor')).blocklyService.captureRecoverySnapshot().documentText))
const mirrors = async () => Object.fromEntries(await Promise.all(['project.abi', 'project.abs', 'project.abs.map.json'].map(async name => [name, sourceHash(await fs.readFile(path.join(project, name)))])))
const faultState = () => app.evaluate(() => globalThis.__ailyNativeSaveObservationFault?.snapshot() ?? { available: false })
const state = () => page.evaluate(() => {
  const component = name => { const element = window.document.querySelector(name); return element ? window.ng?.getComponent(element) : undefined }
  const editor = component('app-blockly-editor'), host = component('app-child-tool-host'), domain = component('app-header')?.projectService
  const blockly = editor?.blocklyService, notice = host?.noticeService ?? editor?.noticeService
  return { project: domain?.currentProjectPath ?? null, ready: domain?.getBlocklyProjectLoadStatus()?.ready ?? false,
    writing: blockly?.aiWriting ?? false, blocked: blockly?.isWorkspaceEditBlocked() ?? false, nativeBusy: blockly?.isWorkspaceEditInProgress() ?? false,
    recoveryRequired: blockly?.isWorkspaceRecoveryRequired() ?? false, hasRunning: host?.aiOperationProtocol?.hasRunning ?? false,
    noticeTitle: notice?.data?.title ?? null, noticeHasStop: typeof notice?.data?.stop === 'function',
    noticeButtons: window.document.querySelectorAll('app-notification .notification-box .btn.red').length,
    recentProjects: (domain?.recentlyProjects ?? []).map(value => value.path) }
})
const trust = async () => {
  assert.equal(await loaded.frame.locator('.full-access-permission-dialog').isVisible(), false)
  for (const dialog of await loaded.frame.locator('.pi-extension-dialog').all()) if (await dialog.isVisible()) {
    const lines = String(await dialog.getAttribute('aria-label')).split(/\r?\n/); assert.equal(lines[0], 'Trust project folder?'); assert.ok(same(lines[1], project))
    await dialog.getByRole('button', { name: 'Trust (this session only)', exact: true }).click() }
}
const observe = async () => {
  await trust()
  const sessions = (await loaded.e2e('session.list')).sessions.filter(value => same(value.cwd, project)); assert.ok(sessions.length <= 1)
  sessionId ??= sessions[0]?.sessionId; if (!sessionId) return
  snapshot = (await loaded.e2e('session.read', { sessionId })).session; assert.equal(snapshot.sessionId, sessionId); assert.ok(same(snapshot.cwd, project))
  assert.equal(snapshot.permissionMode, 'default')
  const calls = callsOf(snapshot)
  for (const message of snapshot.messages.filter(value => value.role === 'toolResult')) {
    if (seen.has(message.toolCallId)) continue; seen.add(message.toolCallId)
    const result = payloadOf(message), name = calls.find(call => call.id === message.toolCallId)?.actualName ?? message.toolName
    evidence.tools.push({ id: message.toolCallId, name, isError: message.isError === true, result, text: name === 'read' ? textOf(message) : undefined })
    if (message.toolCallId === 'uncertain-original-tidy') {
      assert.equal(message.isError, true); assert.equal(result.saveOutcome, 'unknown'); assert.equal(result.observation?.resultKnown, false)
      assert.equal(result.observation?.reason, 'transport', 'A protocol rejection is not a successful transport-loss scenario')
      assert.equal(result.pendingSave?.tool, 'blocks_tidy'); pendingArgs = structuredClone(result.pendingSave.arguments)
      assert.ok(same(pendingArgs.project, project)); assert.equal(pendingArgs.save_target_pid, hostPid)
      evidence.pendingSave = result.pendingSave
    } else assert.equal(message.isError === true, false, name + ': ' + textOf(message).slice(0, 1000))
    if (message.toolCallId === 'export-g0') {
      generation = result.generation; baseSource = result.abs; sourceA = baseSource.replace(`${fixture.blockType}(100)`, `${fixture.blockType}(101)`)
      assert.notEqual(sourceA, baseSource); baseline = await document(); rootId = baseline.pages[0].content.blocks.blocks.find(block => block.type === 'arduino_global').id
    }
    if (message.toolCallId === 'inspect-g0') { inspected = result; assert.equal(result.instances.length, 1); assert.equal(result.instances[0].blockId, rootId) }
    if (message.toolCallId === 'state-save-g1') {
      assert.equal(result.publication?.status, 'COMMITTED'); assert.equal(result.stateVerification?.candidateApplied, false)
      g1 = result.publication.generation; assert.notEqual(g1, generation)
      g1Document = await document(); const expected = structuredClone(baseline), target = expected.pages[0].content.blocks.blocks.find(block => block.id === rootId)
      if (!inspected.instances[0].collapsed) target.collapsed = true; else delete target.collapsed
      assert.deepEqual(g1Document, expected); evidence.g1 = { generation: g1, document: g1Document, mirrors: await mirrors() }
    }
    if (message.toolCallId === 'observe-exact-original-tidy') {
      assert.equal(result.ok, true); assert.equal(result.saveOutcome, 'completed'); assert.equal(result.observation?.originalRequest, true)
      assert.equal(result.saveReceipt?.requestId, pendingArgs.save_request_id); assert.equal(result.saveReceipt.operation, 'blocks_tidy')
      assert.equal(result.workspaceSaveVerification?.ok, true); assert.equal(result.workspaceSaveVerification.candidateApplied, false)
      assert.notEqual(result.workspaceSaveVerification.generation, g1)
      expectedSaved = await document(); evidence.layout = assertCustomerRootLayoutOnly(g1Document, expectedSaved)
      assert.ok(evidence.layout.changedRoots > 0, 'The actual tidy must visibly change native root coordinates')
      evidence.observedSave = result
    }
  }
}
const settle = async (users, ready = () => true) => { const deadline = Date.now() + 120000
  while (Date.now() < deadline) { assertNoNativeSaveModelFailures(model.snapshot().failures); await observe()
    if (snapshot?.isIdle && !snapshot.isStreaming && snapshot.messages.filter(value => value.role === 'user').length === users && ready(snapshot)) {
      await fs.writeFile(path.join(values.output, 'session-' + users + '.json'), JSON.stringify(snapshot, null, 2)); return }
    await wait(150) }
  throw Error('Installed Chat failed to settle this exact original save scenario') }
const submit = async prompt => { await trust(); await loaded.frame.locator('.aily-chat-composer-input[role="textbox"]').fill(prompt)
  const send = loaded.frame.locator('button.primary-action.send-action'); await send.waitFor({ state: 'visible', timeout: 15000 }); await send.click() }
const idle = async () => { const deadline = Date.now() + 30000
  while (Date.now() < deadline) { const current = await state()
    if (current.ready && !current.hasRunning && !current.writing && !current.blocked && !current.nativeBusy && !current.recoveryRequired) {
      assert.equal(current.noticeHasStop, false); assert.equal(current.noticeButtons, 0); return current }
    await wait(100) }
  throw Error('Original save observation left a runtime/notice/recovery gate') }
async function launch(attempt) {
  assert.ok(os.freemem() >= 1024 ** 3); evidence.resources.push({ attempt, freeMemory: os.freemem(), at: Date.now() })
  const { ELECTRON_RUN_AS_NODE, AILY_CHILD_PATH, NODE_PATH, AILY_PORTABLE_ROOT, AILY_AUTH_FILE, ...env } = process.env
  app = await _electron.launch({ executablePath: values['executable-path'], cwd: repo, args: [`--user-data-dir=${path.join(suite, 'electron-profile')}`], timeout: 60000,
    env: { ...env, ...profile.env, AILY_E2E: '1', HOME: home, USERPROFILE: home, TEMP: temp, TMP: temp, npm_config_offline: 'true', npm_config_audit: 'false' } })
  hostPid = await app.evaluate(() => process.pid); evidence.launches.push({ attempt, hostPid, at: Date.now() }); await persist()
  if (attempt && killBeforeObserve) {
    // Install before Chat/session startup; session restoration may observe the
    // pending publication before the next user turn reaches the composer.
    const descriptorPath = path.join(home, '.aily-blockly/cli-bridge', hostPid + '.json')
    let descriptor; const until = Date.now() + 30000
    while (!descriptor && Date.now() < until) {
      try { descriptor = JSON.parse(await fs.readFile(descriptorPath, 'utf8')) }
      catch (error) { if (error.code !== 'ENOENT') throw error; await wait(50) }
    }
    assert.equal(descriptor?.pid, hostPid)
    evidence.coldObserver = await app.evaluate(installNativeSaveObservationFault,
      { project, appData, pid: hostPid, port: descriptor.port, operation: 'blocks_tidy', previousGeneration: g1,
        previousDocument: g1Document, receiptVersion: 2, observationOnly: true,
        observedRequestId: pendingArgs.save_request_id, originalTargetPid: originalHostPid, pauseObservation: stopDuringCold })
    assert.equal(evidence.coldObserver.available, true); faultInstalled = true
    evidence.coldObserverInstalledAt = Date.now()
  }
  await app.context().route('**/*', route => { const url = new URL(route.request().url())
    return !['http:', 'https:'].includes(url.protocol) || ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ? route.continue() : route.abort('blockedbyclient') })
  page = undefined; const deadline = Date.now() + 60000
  while (!page && Date.now() < deadline) { for (const candidate of app.windows()) if (await candidate.locator('app-main-window').count()) { page = candidate; break }; if (!page) await wait(100) }
  assert.ok(page); page.on('dialog', dialog => dialog.dismiss())
  page.on('websocket', socket => socket.on('framesent', ({ payload }) => {
    let value; try { value = JSON.parse(String(payload)) } catch { return }; if (value.channel !== 'agent') return
    const command = value.command
    if (command?.type === 'abort') { abortIds.add(value.id); evidence.abortCommands.push({ id: value.id, sessionId: command.sessionId, source: command.source, reason: command.reason }) }
    if (['session.open', 'session.openSubscribe', 'session.create'].includes(command?.type)) evidence.sessionCommands.push({ attempt, id: value.id, type: command.type,
      sessionId: command.sessionId ?? command.options?.sessionId, cwd: command.options?.cwd })
  }).on('framereceived', ({ payload }) => {
    let value; try { value = JSON.parse(String(payload)) } catch { return }; if (value.channel !== 'agent' || value.type !== 'response') return
    if (abortIds.has(value.id)) evidence.abortResponses.push({ id: value.id, ok: value.ok, accepted: value.result?.accepted })
    if (evidence.sessionCommands.some(command => command.id === value.id && ['session.open', 'session.openSubscribe'].includes(command.type)))
      evidence.sessionResponses.push({ id: value.id, ok: value.ok, subscribed: value.result?.subscribed, sessionId: value.result?.snapshot?.sessionId,
        errorCode: value.error?.code, errorMessage: value.error?.message })
  }))
  await page.evaluate(() => { const dismiss = () => { window.document.querySelector('app-onboarding .btn-skip')?.click(); window.document.querySelector('app-login .login-close')?.click() }
    new MutationObserver(dismiss).observe(window.document.documentElement, { childList: true, subtree: true }); dismiss() })
  await page.waitForFunction(() => { const element = window.document.querySelector('app-header'); return element && window.ng?.getComponent(element)?.projectService })
  if (!attempt) await page.evaluate(async project => { const domain = window.ng.getComponent(window.document.querySelector('app-header')).projectService
    await domain.initializeProjectDataSchema(project); if (!await domain.projectOpen(project)) throw Error('Owned fixture failed to open') }, project)
  // Cold recovery belongs to the product. Never click a recent item, issue an
  // open RPC or replace the original session to make this assertion pass.
  await page.waitForFunction(project => { const domain = window.ng.getComponent(window.document.querySelector('app-header')).projectService
    return domain.currentProjectPath === project && domain.getBlocklyProjectLoadStatus(project)?.ready }, project, { timeout: 120000 })
  const uiOutput = path.join(values.output, 'launch-' + attempt); await fs.mkdir(uiOutput)
  loaded = await assertInstalledChatLoaded(page, { installedRoot: values['installed-root'], output: uiOutput, expectedApiBase: router.origin,
    expectedInputHash: artifact.inputHash, expectedOutputHash: artifact.outputHash }); evidence.launches.at(-1).chat = loaded.evidence
  if (attempt) evidence.launches.at(-1).originalSessionOpen = await waitForColdSessionOpen({ project, sessionId, attempt,
    commands: () => evidence.sessionCommands, responses: () => evidence.sessionResponses,
    readRegistry: async () => (await loaded.e2e('session.list')).sessions.filter(value => same(value.cwd, project)) })
}
try {
  model = await createAbsStopModel({ nextTool: async ({ turn, step }) => {
    assertNoNativeSaveModelFailures(model.snapshot().failures)
    if (turn !== 0) assert.equal(coldReopened, true, 'A provider retry cannot enter B before the actual cold restart')
    await observe()
    if (!turn) {
      if (step === 0) return native('load-save-tools', 'tool_load', { names: ['abs_export', 'abs_apply', 'blocks_set_state', 'blocks_tidy'] })
      if (step === 1) return deferred('export-g0', 'abs_export', { project })
      if (step === 2) return native('read-before-A', 'read', { path: absPath })
      if (step === 3) return native('edit-A', 'edit', { path: absPath, edits: [{ oldText: `${fixture.blockType}(100)`, newText: `${fixture.blockType}(101)` }] })
      if (step === 4) return deferred('inspect-g0', 'blocks_set_state', { project, action: 'inspect', blockIds: [rootId], limit: 1 })
      if (step === 5) return deferred('state-save-g1', 'blocks_set_state', { project, action: 'update', expectedGeneration: inspected.expectedGeneration,
        changes: [{ blockId: rootId, collapsed: !inspected.instances[0].collapsed }] })
      if (step === 6) {
        const descriptor = JSON.parse(await fs.readFile(path.join(home, '.aily-blockly/cli-bridge', hostPid + '.json'), 'utf8'))
        assert.equal(descriptor.pid, hostPid)
        evidence.faultInstall = await app.evaluate(installNativeSaveObservationFault,
          { project, appData, pid: hostPid, port: descriptor.port, operation: 'blocks_tidy', previousGeneration: g1,
            previousDocument: g1Document, receiptVersion: 2 })
        assert.equal(evidence.faultInstall.available, true, 'A missing real transport seam is uncovered, not an injected success'); faultInstalled = true
        return deferred('uncertain-original-tidy', 'blocks_tidy', { project })
      }
      if (step === 7) {
        const proof = await faultState(); evidence.originalSaveFault = proof
        assert.ok(proof.drops >= 1 && proof.drops <= 2); assert.deepEqual(proof.failures, [])
        assert.deepEqual(proof.unverifiedTerminalReplies, [])
        assert.equal(pendingArgs.save_request_id, proof.requestId); assert.equal(proof.commands.filter(value => value.operation === 'blocks_tidy').length, 1)
        evidence.originalSaveFault = proof
        if (!killBeforeObserve) {
          await app.evaluate(() => globalThis.__ailyNativeSaveObservationFault.release())
          return deferred('observe-exact-original-tidy', 'blocks_tidy', pendingArgs)
        }
        // The oracle may inspect disk; the SDK must still retain its original
        // unknown request and has not received this native terminal result.
        expectedSaved = JSON.parse(await fs.readFile(path.join(project, 'project.abi'), 'utf8'))
        evidence.layout = assertCustomerRootLayoutOnly(g1Document, expectedSaved)
        assert.ok(evidence.layout.changedRoots > 0)
        held = true; await new Promise(resolve => { release = resolve }); return undefined
      }
      assert.equal(step, 8); held = true; await new Promise(resolve => { release = resolve }); return undefined
    }
    if (stopDuringCold) {
      assert.equal(coldReopened, true); assert.equal(turn, 1)
      assert.equal(snapshot.messages.filter(value => value.role === 'user').length, 3,
        'The cancelled preflight must never become a provider interaction or continued B')
    } else assertNativeSaveContinuationPhase({ coldReopened, actualUserTurns: snapshot.messages.filter(value => value.role === 'user').length, providerTurn: turn })
    if (step === 0) return native('read-A-after-cold', 'read', { path: absPath })
    if (step === 1) return native('edit-B-after-cold', 'edit', { path: absPath, edits: [{ oldText: `${fixture.blockType}(200)`, newText: `${fixture.blockType}(201)` }] })
    if (step === 2) return deferred('apply-A-B-after-cold', 'abs_apply', { project, absPath })
    assert.equal(step, 3); return undefined
  } })
  router = await createLocalChatApiRouter({ operationOrigin: model.origin, installedRoot: values['installed-root'] })
  profile = await prepareInstalledChatProfile({ appData, installedRoot: values['installed-root'], apiBase: router.origin, baseConfigPath: path.join(repo, 'electron/config/config.json'), resourceAppData: values['resource-root'], token: router.token })
  await phase('real-g1-state-save-then-uncertain-original-tidy-g2'); await launch(0)
  await submit('Keep edit A unapplied, collapse the global block, then tidy and save the current canvas. Recover an uncertain save only by observing its original request. I will stop before continuing.')
  const deadline = Date.now() + 120000
  while (!held && Date.now() < deadline) { assertNoNativeSaveModelFailures(model.snapshot().failures); await observe(); assertNoNativeSaveModelFailures(model.snapshot().failures); await wait(100) }
  assert.equal(held, true, 'The actual native G2 save must complete before user Stop')
  assert.ok(expectedSaved); assert.deepEqual(JSON.parse(await fs.readFile(path.join(project, 'project.abi'), 'utf8')), expectedSaved)
  const pending = assertColdPendingIntent(snapshot, { project, sessionId, generation, source: sourceA })
  const backup = pending.retainedCandidateBackup
  evidence.candidateA = await verifyCustomerCandidateRecord({ project, backup, candidateHash: sourceHash(sourceA), intentGeneration: generation })
  const archiveBytes = await fs.readFile(backup.path), archive = JSON.parse(archiveBytes)
  evidence.candidateProof = assertColdCandidateProof(archive, { project, source: sourceA, baseSource, generation })
  assert.equal(pending.retainedCandidateHandoff?.version, 1)
  const handoffPath = path.join(project, '.workspace-history/abs-candidate-handoffs', pending.retainedCandidateHandoff.recordHash.slice(7) + '.json')
  const handoffBytes = await fs.readFile(handoffPath), handoff = JSON.parse(handoffBytes)
  assert.equal(sourceHash(handoffBytes), pending.retainedCandidateHandoff.recordHash)
  const binding = (killBeforeObserve ? evidence.originalSaveFault.terminals.at(-1) : evidence.observedSave.workspaceSaveVerification).binding
  for (const [file, key, handoffKey] of [['project.abi', 'abiHash', 'abi'], ['project.abs', 'absHash', 'abs'], ['project.abs.map.json', 'mapHash', 'map']]) {
    assert.equal(sourceHash(await fs.readFile(path.join(project, file))), binding[key])
    assert.equal(handoff.hashes[handoffKey], killBeforeObserve ? evidence.g1.mirrors[file] : binding[key])
  }
  assert.equal(handoff.intentGeneration, generation)
  assert.equal(handoff.editProof.origin.acceptedMapHash, (killBeforeObserve ? evidence.g1.mirrors['project.abs.map.json'] : binding.mapHash).slice(7))
  evidence.beforeStop = { pending, handoffPath, handoffHash: sourceHash(handoffBytes), handoffOwner: handoff.owner, mirrors: await mirrors(), binding }
  await page.screenshot({ path: path.join(values.output, 'observed-g2-before-stop.png'), fullPage: true })
  await phase(killBeforeObserve ? 'real-chat-stop-before-original-save-observation' : 'real-chat-stop-after-original-save-observation')
  await loaded.frame.locator('button.primary-action.stop-action').click()
  const interruptDeadline = Date.now() + 15000
  while (!model.snapshot().interactions.find(value => value.turn === 0)?.interrupted && Date.now() < interruptDeadline) await wait(100)
  assert.equal(model.snapshot().interactions.find(value => value.turn === 0)?.interrupted, true); release(); release = undefined
  await settle(1); evidence.firstTurnStop = assertUserStoppedAssistant(snapshot)
  await loaded.frame.locator('.x-aily-interruption-divider[role="status"], .x-aily-interruption-text[role="status"]')
    .first().waitFor({ state: 'visible', timeout: 15000 })
  evidence.firstTurnStopUi = await loaded.frame.evaluate(readUserStopTerminalUi)
  assertUserStopTerminalUi(evidence.firstTurnStopUi)
  assert.equal(evidence.abortCommands.length, 1); assert.equal(evidence.abortCommands[0].sessionId, sessionId)
  assert.ok(evidence.abortResponses.some(value => value.ok && value.accepted === true))
  await idle(); assert.deepEqual(await mirrors(), evidence.beforeStop.mirrors)
  assertColdPendingIntent(snapshot, { project, sessionId, generation, source: sourceA })
  await page.screenshot({ path: path.join(values.output, 'stopped-unapplied-A-after-observation.png'), fullPage: true })
  evidence.finalSaveFault = await faultState(); assert.deepEqual(evidence.finalSaveFault.failures, [])
  assert.equal(evidence.finalSaveFault.commands.filter(value => value.operation === 'blocks_tidy').length, 1)
  assert.ok(evidence.finalSaveFault.commands.every(value => value.requestId === pendingArgs.save_request_id))
  assert.equal(await app.evaluate(() => globalThis.__ailyNativeSaveObservationFault.restore()), evidence.finalSaveFault.drops); faultInstalled = false
  await phase('force-kill-owned-host-and-cold-original-session')
  originalHostPid = hostPid
  const tree = await ownedTree(hostPid), closed = app.waitForEvent('close', { timeout: 15000 })
  await app.evaluate((_, expected) => { if (process.pid !== expected.pid || process.env.AILY_APPDATA_PATH !== expected.appData) throw Error('Refuse unrelated host termination'); process.kill(process.pid, 'SIGKILL') }, { pid: hostPid, appData })
    .catch(error => { if (!/closed|destroyed|terminated|Target/i.test(error.message)) throw error })
  await closed; app = undefined; page = undefined; loaded = undefined; evidence.crashCleanup = await exited(tree)
  await launch(1); await observe(); assertColdPendingIntent(snapshot, { project, sessionId, generation, source: sourceA })
  assert.deepEqual(await document(), expectedSaved); assert.deepEqual(await mirrors(), evidence.beforeStop.mirrors)
  coldReopened = true
  await page.screenshot({ path: path.join(values.output, 'cold-original-session-before-B.png'), fullPage: true })
  if (stopDuringCold) {
    await phase('real-chat-stop-during-cold-original-publication-observation-before-model')
    const previousStopMarkers = await loaded.frame.locator('.x-aily-interruption-divider[role="status"], .x-aily-interruption-text[role="status"]').count()
    await submit('Continue the retained edit in this same original project.')
    const pausedDeadline = Date.now() + 30000
    let paused
    while (Date.now() < pausedDeadline) {
      assertNoNativeSaveModelFailures(model.snapshot().failures)
      paused = await faultState()
      if (paused.observationPaused) break
      await wait(50)
    }
    assert.equal(paused?.observationPaused, true, 'Pause only the real verified original publication response')
    assert.equal(model.snapshot().createCount, 1, 'No new provider call may precede cold candidate restoration')
    await loaded.frame.locator('button.primary-action.stop-action').waitFor({ state: 'visible', timeout: 5000 })
    await loaded.frame.locator('button.primary-action.stop-action').click()
    await settle(2, value => {
      const stop = value.entries?.findLast(entry => entry.type === 'custom' && entry.customType === 'aily.abort-request')
      const assistant = value.entries?.findLast(entry => entry.type === 'message' && entry.message.role === 'assistant')
      const trace = value.entries?.findLast(entry => entry.type === 'custom' && entry.customType === 'aily.trace' && entry.data?.phase === 'run_settled')
      if (!stop || stop.id === evidence.firstTurnStop.abortRequestEntryId || !assistant
        || Date.parse(assistant.timestamp) < Date.parse(stop.timestamp)) return false
      assert.equal(assistant.message.stopReason, 'aborted', 'Preflight Stop must not persist a failed assistant')
      return trace?.data?.completedAt >= Date.parse(assistant.timestamp)
    })
    evidence.preflightStop = assertUserStoppedAssistant(snapshot)
    await loaded.frame.waitForFunction(previous => document.querySelectorAll(
      '.x-aily-interruption-divider[role="status"], .x-aily-interruption-text[role="status"]').length > previous, previousStopMarkers)
    evidence.preflightStopUi = await loaded.frame.evaluate(readUserStopTerminalUi)
    assertUserStopTerminalUi(evidence.preflightStopUi)
    assert.equal(model.snapshot().createCount, 1)
    assertColdPendingIntent(snapshot, { project, sessionId, generation, source: sourceA })
    assert.deepEqual(await mirrors(), evidence.beforeStop.mirrors)
    await idle()
    assert.equal(await app.evaluate(() => globalThis.__ailyNativeSaveObservationFault.releaseObservation()), true)
    await page.screenshot({ path: path.join(values.output, 'stopped-during-cold-read-before-provider.png'), fullPage: true })
  }
  await phase('actual-cold-read-A-edit-B-and-full-application')
  await submit('Continue the retained edit A, change the second field from 200 to 201, and apply complete A+B in this same project, preserving the saved layout.')
  await settle(stopDuringCold ? 3 : 2)
  if (killBeforeObserve) {
    evidence.coldObservation = await faultState()
    assert.deepEqual(evidence.coldObservation.failures, [])
    assert.ok(evidence.coldObservation.commands.some(value => value.operation === 'project_publication_status'))
    assert.equal(evidence.coldObservation.commands.filter(value => value.operation === 'blocks_tidy').length, 0)
    assert.ok(evidence.coldObservation.terminals.some(value => value.requestId === pendingArgs.save_request_id))
    assert.equal(await app.evaluate(() => globalThis.__ailyNativeSaveObservationFault.restore()), 0); faultInstalled = false
  }
  assert.ok(evidence.tools.find(value => value.id === 'read-A-after-cold')?.text.includes(`${fixture.blockType}(101)`))
  const applied = evidence.tools.find(value => value.id === 'apply-A-B-after-cold')?.result
  assert.equal(applied?.ok, true); assert.equal(applied.publication?.status, 'COMMITTED'); assert.equal(applied.applyVerification?.ok, true)
  assert.equal(applied.absPersistence?.verified, true); assert.equal(applied.requiresReload, false)
  const expected = singleFieldExpectedDocument(singleFieldExpectedDocument(expectedSaved, fixture.blockId, 'VALUE', 100, 101), 'save_observation_second', 'VALUE', 200, 201)
  assert.deepEqual(await document(), expected); assert.deepEqual(JSON.parse(await fs.readFile(path.join(project, 'project.abi'), 'utf8')), expected)
  for (const [file, key] of [['project.abi', 'abiHash'], ['project.abs', 'absHash'], ['project.abs.map.json', 'mapHash']]) assert.equal(sourceHash(await fs.readFile(path.join(project, file))), applied.receipt.output.binding[key])
  assert.equal(applied.receipt.validation?.ok, true); assert.equal(applied.receipt.validation?.scope, 'complete-generation')
  assert.equal(callsOf(snapshot).filter(value => value.actualName === 'abs_apply').length, 1)
  assert.ok(!callsOf(snapshot).some(value => ['project_create', 'project_fork', 'project_recover', 'project_open', 'app_open', 'app_reload', 'project_save'].includes(value.actualName)))
  evidence.final = { state: await idle(), mirrors: await mirrors(), sessionId: snapshot.sessionId, document: expected }
  assert.ok(same(evidence.final.state.project, project)); assert.ok(evidence.final.state.recentProjects.every(value => same(value, project)))
  assert.ok((await fs.readFile(backup.path)).equals(archiveBytes)); assert.equal(model.snapshot().createCount, 2); assert.deepEqual(model.snapshot().failures, [])
  await page.screenshot({ path: path.join(values.output, 'final-A-B-after-original-save-observation.png'), fullPage: true }); evidence.ok = true
} catch (error) {
  evidence.error = { name: error.name, message: error.message, stack: error.stack }
  if (faultInstalled && app) evidence.finalSaveFault = await faultState().catch(error => ({ observationError: error.message }))
  if (page) { evidence.failureState = await state().catch(error => ({ observationError: error.message })); await page.screenshot({ path: path.join(values.output, 'failure.png'), fullPage: true }).catch(() => {}) }
  if (loaded && sessionId) { const value = await loaded.e2e('session.read', { sessionId }).catch(() => undefined)
    if (value) await fs.writeFile(path.join(values.output, 'failure-session.json'), JSON.stringify(value.session, null, 2)) }
  throw error
} finally {
  release?.()
  if (faultInstalled && app) {
    evidence.finalSaveFault ??= await faultState().catch(error => ({ observationError: error.message }))
    await app.evaluate(() => globalThis.__ailyNativeSaveObservationFault?.restore()).catch(error => { evidence.faultRestoreError = error.message })
  }
  if (app) { const tree = await ownedTree(hostPid).catch(() => []); await app.close().catch(error => { evidence.cleanupError = error.message })
    if (tree.length) evidence.finalCleanup = await exited(tree).catch(error => ({ exitedNaturally: false, remaining: error.remaining })) }
  evidence.model = model?.snapshot(); evidence.api = router?.snapshot(); await router?.close(); await model?.close()
  evidence.finishedAt = new Date().toISOString(); await persist()
}
assert.deepEqual(await verifyPortableBuild(values['installed-root']), artifact)
assert.equal(artifact.inputHash, sha(JSON.stringify(await captureBuildInputs(values['lex-root'])))); assert.equal(sha(await fs.readFile(asar)), hostHash)
assert.equal(evidence.finalCleanup?.exitedNaturally, true)
