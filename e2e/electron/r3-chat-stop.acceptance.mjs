import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { parseArgs, promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { _electron } from '@playwright/test'
import { createAbsStopModel } from '../fixtures/abs-stop-model.mjs'
import { createLocalChatApiRouter, prepareInstalledChatProfile, assertInstalledChatLoaded } from '../fixtures/installed-chat-ui.mjs'
import { prepareBuildLogProject } from './fixtures/build-log-project.mjs'
import { singleFieldExpectedDocument } from './fixtures/online-comparison.mjs'
import { readWorkingCandidateEvidence, selectedWorkingCandidateRef } from './fixtures/r3-candidate-evidence.mjs'
import { installCandidateColdAudit, readCandidateAcceptanceEvidence } from './fixtures/r3-candidate-cold.mjs'
import { indexCustomerProject } from './fixtures/customer-project-baseline-case.mjs'
import { assertCancelledApplicationTool, assertUserStoppedAssistant } from './fixtures/abs-stop-presentation.mjs'
import { assertR3StoppedUi, assertR3StopApplicationDispatches, readR3CandidatePublication } from './fixtures/r3-chat-stop-presentation.mjs'
import { readBoardSessionStartup } from './fixtures/r2-board-session-startup.mjs'
import { createChatStopGates } from './fixtures/r3-chat-stop-gates.mjs'
import { assertCapturedEnvironmentProcess, selectEnvironmentProcessTree, remainingEnvironmentProcesses,
  environmentProcessStopScript } from './fixtures/r2-environment-cleanup.mjs'

const repo = fileURLToPath(new URL('../../', import.meta.url))
const { values } = parseArgs({ options: { ...Object.fromEntries(['executable-path', 'installed-root', 'lex-root', 'resource-root',
  'test-root', 'output', 'expected-input-hash'].map(name => [name, { type: 'string' }])), cases: { type: 'string', default: 'apply-chat,recovery-owner' } } })
assert.equal(process.env.AILY_R3_STOP_HOST_WINDOW, '1', 'Use the root-coordinated frozen-artifact host window')
for (const name of ['executable-path', 'installed-root', 'lex-root', 'resource-root', 'test-root', 'output']) assert.ok(path.isAbsolute(values[name] ?? ''), `--${name} must be absolute`)
const inside = (root, file) => { const relative = path.relative(root, file); return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) }
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
assert.ok(inside(path.join(repo, 'e2e/test-results'), values.output)); assert.ok(inside(path.join(values['resource-root'], 'dev-tests'), values['test-root']))
assert.match(values['expected-input-hash'] ?? '', /^[a-f0-9]{64}$/)
const cases = values.cases.split(','); assert.ok(cases.length && new Set(cases).size === cases.length && cases.every(mode => ['apply-chat', 'recovery-owner'].includes(mode)))
const sha = value => createHash('sha256').update(value).digest('hex'), hash = value => 'sha256:' + sha(value)
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const textOf = message => (message?.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n')
const parsed = message => { if (message?.details?.result) return message.details.result; try { return JSON.parse(textOf(message)) } catch { return undefined } }
const callsOf = snapshot => (snapshot?.messages ?? []).filter(message => message.role === 'assistant').flatMap(message => message.content ?? [])
  .filter(part => part.type === 'toolCall').map(call => ({ ...call, actualName: call.name === 'tool_invoke' ? call.arguments.name : call.name }))
const { verifyPortableBuild } = await import(pathToFileURL(path.join(values['lex-root'], 'packages/aily-chat/server/portable-integrity.ts')))
const { captureBuildInputs } = await import(pathToFileURL(path.join(values['lex-root'], 'packages/aily-chat/scripts/portable-build-inputs.mjs')))
const artifact = await verifyPortableBuild(values['installed-root'])
assert.equal(artifact.inputHash, values['expected-input-hash']); assert.equal(artifact.inputHash, sha(JSON.stringify(await captureBuildInputs(values['lex-root']))))
const asar = path.join(path.dirname(values['executable-path']), 'resources/app.asar'), hostHash = sha(await fs.readFile(asar))
await fs.mkdir(values.output, { recursive: false }); await fs.mkdir(values['test-root'], { recursive: true })
const native = (id, name, args) => ({ id, name, arguments: args })
const deferred = (id, name, args) => native(id, 'tool_invoke', { name, arguments: args })
const results = []
const exec = promisify(execFile)
const appendStatement = (source, type) => {
  const original = `${type}(200)`, position = source.indexOf(original)
  assert.ok(position >= 0); assert.equal(source.lastIndexOf(original), position)
  const indentation = source.slice(source.lastIndexOf('\n', position) + 1, position)
  assert.match(indentation, /^ *$/)
  return { oldText: original, newText: `${original}\n${indentation}${type}(777)` }
}
const processes = async () => {
  const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine,@{Name='CreationDate';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress"],
    { windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024 })
  const all = JSON.parse(stdout); return Array.isArray(all) ? all : [all]
}

async function runCase(mode) {
  assert.ok(os.freemem() >= 1024 ** 3, 'One tiny functional host requires 1024 MiB; never kill unrelated apps')
  const suite = await fs.mkdtemp(path.join(values['test-root'], 'r3-chat-stop-' + mode + '-'))
  const project = path.join(suite, 'project'), appData = path.join(suite, 'appdata'), home = path.join(suite, 'home'), temp = path.join(suite, 'temp')
  const output = path.join(values.output, mode), absPath = path.join(project, 'project.abs')
  await fs.mkdir(output); await fs.mkdir(home); await fs.mkdir(temp)
  const fixture = await prepareBuildLogProject({ directory: project, boardsRoot: path.resolve(repo, '../aily-blockly-boards'),
    librariesRoot: path.resolve(repo, '../aily-blockly-libraries'), scenario: 'field-edit', marker: 'ABS_STOP_NO_COMPILE' })
  const seed = JSON.parse(await fs.readFile(path.join(project, 'project.abi'), 'utf8'))
  seed.blocks.blocks.find(block => block.type === 'arduino_global').inputs.ARDUINO_GLOBAL.block.next = {
    block: { type: fixture.blockType, id: 'stop_boundary_second', fields: { VALUE: 200 } } }
  await fs.writeFile(path.join(project, 'project.abi'), JSON.stringify(seed, null, 2))
  const evidence = { ok: false, mode, suite, project, artifact, hostHash, startedAt: new Date().toISOString(),
    realInstalledChat: true, realAsarHost: true, deterministicLocalModel: true, paidModelRequests: 0,
    replacementToolExecutor: false, replacementStopHandler: false, fabricatedHostReceipts: false,
    stages: [], tools: [], sessionCommands: [], sessionResponses: [], abortCommands: [], abortResponses: [], eventCounts: {},
    processCaptures: [], finalOwnedProcesses: null, resources: [{ phase: 'cold', freeMemory: os.freemem() }] }
  results.push(evidence)
  let app, page, loaded, router, model, hostPid, mainIdentity, sessionId, snapshot, baseline, generation, candidateA, backupA, recoveryRequest, firstAppliedExpected, addedBlockId, originalApplyRequestId, originalWasAcceptedAtStop, currentTurn = 0, startupReady = false
  const gates = createChatStopGates(mode)
  const withAddedBlock = (original, observed) => {
    const expected = structuredClone(original), parent = indexCustomerProject(expected).get('stop_boundary_second')
    assert.ok(parent); assert.equal(parent.next, undefined)
    const actual = observed ? indexCustomerProject(observed).get('stop_boundary_second')?.next?.block : undefined
    if (actual) {
      assert.equal(actual.type, fixture.blockType); assert.deepEqual(actual.fields, { VALUE: 777 })
      assert.ok(typeof actual.id === 'string' && actual.id)
      if (addedBlockId) assert.equal(actual.id, addedBlockId); else addedBlockId = actual.id
    }
    assert.ok(addedBlockId)
    parent.next = { block: { type: fixture.blockType, id: addedBlockId, fields: { VALUE: 777 } } }
    return expected
  }
  const observed = new Set(), commandIds = new Set()
  const persist = () => fs.writeFile(path.join(output, 'result.json'), JSON.stringify(evidence, null, 2))
  const phase = async name => { console.log('PHASE=' + mode + ':' + name); evidence.stages.push({ name, at: Date.now() }); await persist() }
  const mirrors = async () => Object.fromEntries(await Promise.all(['project.abi', 'project.abs', 'project.abs.map.json', '.aily/abs-sync/committed.json']
    .map(async name => { try { const bytes = await fs.readFile(path.join(project, name)); return [name, { hash: hash(bytes), bytes: bytes.length }] }
      catch (error) { if (error.code === 'ENOENT') return [name, null]; throw error } })))
  const document = () => page.evaluate(() => JSON.parse(window.ng.getComponent(window.document.querySelector('app-blockly-editor')).blocklyService.captureRecoverySnapshot().documentText))
  const state = () => page.evaluate(() => { const element = window.document.querySelector('app-blockly-editor')
    const component = element ? window.ng.getComponent(element) : undefined
    const hostElement = window.document.querySelector('app-child-tool-host'), headerElement = window.document.querySelector('app-header')
    const service = component?.blocklyService, host = hostElement ? window.ng.getComponent(hostElement) : undefined
    const domain = headerElement ? window.ng.getComponent(headerElement)?.projectService : undefined
    const noticeElement = window.document.querySelector('app-notification'), noticeComponent = noticeElement ? window.ng.getComponent(noticeElement) : undefined
    const noticeService = host?.noticeService ?? component?.noticeService
    return { project: domain?.currentProjectPath ?? null, loadStatus: domain?.getBlocklyProjectLoadStatus() ?? null, projectOpening: domain?.isProjectOpening ?? null,
      writing: service?.aiWriting ?? false, waiting: service?.aiWaitWriting ?? false, blocked: service?.isWorkspaceEditBlocked() ?? false,
      nativeBusy: service?.isWorkspaceEditInProgress() ?? false, recoveryRequired: service?.isWorkspaceRecoveryRequired() ?? false,
      hasRunning: host?.aiOperationProtocol?.hasRunning ?? false, owner: host?.aiOperationProtocol?.selected?.owner ?? null,
      reports: window.__absStopReports, stopRpc: window.__absStopRpc,
      notice: { componentPresent: !!noticeElement, componentTitle: noticeComponent?.data?.title ?? null,
        componentHasStop: typeof noticeComponent?.data?.stop === 'function', serviceTitle: noticeService?.data?.title ?? null,
        serviceHasStop: typeof noticeService?.data?.stop === 'function', owner: noticeService?.owner ?? null,
        visibleTitles: [...window.document.querySelectorAll('app-notification .notification-box .title')].map(node => node.textContent),
        stopButtonCount: window.document.querySelectorAll('app-notification .notification-box .btn.red').length },
      pause: window.__absStopPause ? { entered: window.__absStopPause.entered, enteredAt: window.__absStopPause.enteredAt,
        loadCalls: window.__absStopPause.loadCalls, injectedLoadFailures: window.__absStopPause.injectedLoadFailures,
        newWorkspace: window.__absStopPause.newWorkspace, originalLeaseCurrent: window.__absStopPause.originalLeaseCurrent,
        snapshot: window.__absStopPause.snapshot } : null } })
  const acknowledgeTrust = async () => { const dialogs = loaded.frame.locator('.pi-extension-dialog')
    assert.equal(await loaded.frame.locator('.full-access-permission-dialog').isVisible(), false)
    for (let index = 0; index < await dialogs.count(); index++) { const dialog = dialogs.nth(index); if (!await dialog.isVisible()) continue
      const lines = String(await dialog.getAttribute('aria-label')).split(/\r?\n/)
      assert.equal(lines[0], 'Trust project folder?'); assert.ok(same(lines[1], project))
      await dialog.getByRole('button', { name: 'Trust (this session only)', exact: true }).click() } }
  const observe = async () => {
    assert.deepEqual(model.snapshot().failures, [])
    await acknowledgeTrust()
    if (!startupReady) {
      const startup = await readBoardSessionStartup({ commands: evidence.sessionCommands, responses: evidence.sessionResponses, project,
        readRegistry: async () => (await loaded.e2e('session.list')).sessions.filter(value => same(value.cwd, project)) })
      if (!startup) return
      assert.ok(startup.registry.length <= 1 && startup.registry.some(value => value.sessionId === startup.ready.sessionId))
      sessionId = startup.ready.sessionId; startupReady = true; evidence.sessionStartup = startup
    }
    snapshot = (await loaded.e2e('session.read', { sessionId })).session
    assert.equal(snapshot.sessionId, sessionId); assert.ok(same(snapshot.cwd, project)); assert.equal(snapshot.permissionMode, 'default')
    const calls = callsOf(snapshot)
    for (const message of snapshot.messages.filter(message => message.role === 'toolResult')) {
      if (observed.has(message.toolCallId)) continue; observed.add(message.toolCallId)
      const result = parsed(message), name = calls.find(call => call.id === message.toolCallId)?.actualName ?? message.toolName
      evidence.tools.push({ name, id: message.toolCallId, isError: message.isError === true, result })
      if (gates.has(message.toolCallId) && message.toolCallId !== 'one-real-app-reload-fails')
        assert.notEqual(message.isError, true, JSON.stringify({ id: message.toolCallId, result }))
      if (name === 'abs_export' && result?.ok) { generation = result.generation; candidateA = result.abs.replace(`${fixture.blockType}(100)`, `${fixture.blockType}(101)`); assert.notEqual(candidateA, result.abs)
        if (mode === 'apply-chat') { const edit = appendStatement(candidateA, fixture.blockType); candidateA = candidateA.replace(edit.oldText, edit.newText) }
        baseline = await document(); evidence.baseline = { document: baseline, mirrors: await mirrors() } }
      if (message.toolCallId === 'validate-A-before-load-failure') {
        assert.equal(message.isError, false); assert.equal(result.ok, true)
        evidence.candidateA = await readWorkingCandidateEvidence({ project, snapshot, candidateHash: hash(candidateA) })
        backupA = evidence.candidateA.ref
        assert.equal(evidence.candidateA.record.derivation.kind, 'splices', 'Actual Core edits persist exact revision provenance')
        assert.deepEqual(result.receipt.workingCandidate, backupA)
      }
      if (mode === 'apply-chat' && message.toolCallId === 'edit-A')
        await page.evaluate(() => { window.__absStopPause.armed = true })
      if (mode === 'recovery-owner' && message.toolCallId === 'validate-A-before-load-failure') {
        assert.ok(backupA, 'Archive exact A before any failed activation')
        await page.evaluate(() => { window.__absStopPause.failNextLoad = true; window.__absStopPause.armed = true })
      }
      if (message.toolCallId === 'one-real-app-reload-fails') {
        assert.equal(message.isError, true, 'The injected native load error must travel through the real reload tool')
        evidence.failedLoad = await page.evaluate(() => { const domain = window.ng.getComponent(window.document.querySelector('app-header')).projectService
          return { loadStatus: domain.getBlocklyProjectLoadStatus(), injectedLoadFailures: window.__absStopPause.injectedLoadFailures } })
        assert.equal(evidence.failedLoad.injectedLoadFailures, 1); assert.equal(evidence.failedLoad.loadStatus.ready, false)
        await phase('real-project-open-failed-once-original-A-backed-up')
      }
      if (mode === 'apply-chat' && message.toolCallId === 'read-A-next-turn') {
        const audit = await app.evaluate(() => globalThis.__ailyR3CandidateColdAudit.snapshot())
        const original = audit.terminals.find(value => value.operation === 'abs_apply' && value.requestId === originalApplyRequestId
          && value.ok === true && value.publication?.status === 'COMMITTED')
        assert.ok(original?.receipt, 'Read the actual original native receipt; never infer completion from GUI text')
        const checkpoint = selectedWorkingCandidateRef(snapshot, project).checkpoint
        const accepted = await readCandidateAcceptanceEvidence({ project, checkpoint, snapshot, requestId: originalApplyRequestId,
          ref: backupA, expectedOutput: original.receipt.output })
        if (!originalWasAcceptedAtStop) {
          const observed = audit.terminals.find(value => value.operation === 'abs_recovery' && value.action === 'observe_apply'
            && value.requestId === originalApplyRequestId && value.ok === true && value.applicationObservation?.current === true)
          assert.ok(observed?.receipt, 'The next real Core read must independently observe its exact pending original ID')
          const captured = audit.commands.filter(value => value.operation === 'abs_recovery' && value.action === 'candidate_capture').at(-1)
          assert.ok(captured && observed.at <= captured.at, 'Do not capture a successor before original-ID acceptance')
          assert.deepEqual(observed.receipt.output, original.receipt.output)
        }
        await assertApplied(accepted.result)
        const successor = await readWorkingCandidateEvidence({ project, snapshot })
        assert.notEqual(successor.ref.id, backupA.id)
        assert.equal(successor.record.derivation.kind, 'capture')
        const object = successor.record.base.document
        assert.deepEqual(JSON.parse(await fs.readFile(path.join(project, '.workspace-history/objects', object.hash.slice(0, 2), object.hash + '.blob'), 'utf8')), firstAppliedExpected)
        assert.equal(successor.record.base.published?.generation, original.receipt.output.binding.generation)
        const retained = await readWorkingCandidateEvidence({ project, ref: backupA, candidateHash: hash(candidateA), expectedBase: evidence.candidateA.record.base })
        assert.deepEqual(await document(), firstAppliedExpected)
        evidence.originalAcceptance = accepted; evidence.successorAfterOriginalAcceptance = successor
        evidence.originalImmutableAfterAcceptance = retained; evidence.originalObservationAudit = audit
      }
      if (gates.has(message.toolCallId)) gates.release(message.toolCallId)
    }
  }
  const settle = async expectedUsers => {
    const deadline = Date.now() + 120000
    while (Date.now() < deadline) { await observe()
      if (snapshot?.isIdle && !snapshot.isStreaming && snapshot.messages.filter(message => message.role === 'user').length === expectedUsers) {
        await fs.writeFile(path.join(output, `session-${expectedUsers}.json`), JSON.stringify(snapshot, null, 2)); return snapshot }
      await wait(150) }
    throw Error('The actual installed Chat did not settle')
  }
  const submit = async prompt => {
    await acknowledgeTrust(); const composer = loaded.frame.locator('.aily-chat-composer-input[role="textbox"]'), send = loaded.frame.locator('button.primary-action.send-action')
    await composer.fill(prompt); await send.waitFor({ state: 'visible', timeout: 15000 }); await send.click()
    evidence.resources.push({ phase: 'submit-' + currentTurn, freeMemory: os.freemem() })
  }
  const assertApplied = async result => {
    assert.equal(result?.ok, true); assert.equal(result.publication?.status, 'COMMITTED'); assert.equal(result.applyVerification?.ok, true)
    assert.equal(result.requiresReload, false); assert.equal(result.absPersistence?.verified, true)
    for (const [file, key] of [['project.abi', 'abiHash'], ['project.abs', 'absHash'], ['project.abs.map.json', 'mapHash']])
      assert.equal(hash(await fs.readFile(path.join(project, file))), result.receipt.output.binding[key])
  }
  const clearUi = async () => {
    await page.waitForFunction(() => { const host = window.ng.getComponent(window.document.querySelector('app-child-tool-host'))
      const service = window.ng.getComponent(window.document.querySelector('app-blockly-editor'))?.blocklyService
      return !host.aiOperationProtocol?.hasRunning && !service?.aiWriting && !service?.isWorkspaceEditBlocked() }, null, { timeout: 30000 })
    await loaded.frame.locator('button.primary-action.stop-action').waitFor({ state: 'hidden', timeout: 15000 })
    assert.equal(await page.locator('app-notification .notification-box').filter({ hasText: /AI正在操作|正在停止 AI|正在同步 AI 状态/ }).count(), 0)
    assert.equal(await page.locator('.blockly-spin.show').count(), 0)
  }
  const stoppedPresentation = async () => {
    // Capture the actual visible first-turn result before another user turn
    // can push its failure card out of view. Never repair the transcript here.
    const raw = assertUserStoppedAssistant(snapshot)
    await loaded.frame.locator('.x-aily-interruption-divider[role="status"], .x-aily-interruption-text[role="status"]').first()
      .waitFor({ state: 'visible', timeout: 15000 })
    await page.screenshot({ path: path.join(output, 'first-turn-stopped.png'), fullPage: true })
    const closed = loaded.frame.locator('.cag > .cag-header[aria-expanded="false"]')
    for (let count = 0; await closed.count(); count++) {
      assert.ok(count < 20, 'Bound presentation-only activity expansion')
      await closed.first().click()
    }
    await loaded.frame.locator('.cag-item-tool-title-label').filter({ hasText: /^(Abs Apply|abs_apply)$/i }).waitFor({ state: 'visible', timeout: 15000 })
    const ui = await loaded.frame.evaluate(() => {
      const visible = node => !!(node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden')
      const terminal = '.chat-part[data-part-type="error"]'
      return {
        interruptions: [...document.querySelectorAll('.x-aily-interruption-divider[role="status"], .x-aily-interruption-text[role="status"]')]
          .map(node => ({ text: node.textContent ?? '', visible: visible(node) })),
        terminalErrorCards: [...document.querySelectorAll(terminal + ' .x-aily-error-viewer[data-sev="error"]')]
          .map(node => ({ title: node.querySelector('.x-aily-error-title')?.textContent, text: node.textContent })),
        abortErrorAlerts: [...document.querySelectorAll('[role="alert"]')]
          .filter(node => /This operation was aborted|Request aborted \(user|Request aborted \(user_stop/i.test(node.textContent ?? ''))
          .map(node => node.textContent),
        terminalRetryButtons: document.querySelectorAll(terminal + ' .x-aily-error-retry-button').length,
        toolCards: [...document.querySelectorAll('.cag-item-tool')].map(node => ({
          title: node.querySelector('.cag-item-tool-title-label')?.textContent ?? '',
          status: node.querySelector('.cag-item-pill')?.textContent ?? '', tone: node.querySelector('.cag-item-pill')?.getAttribute('data-tone') ?? '',
          visible: visible(node) })) }
    })
    evidence.firstTurnPresentation = { raw, ui }
    await fs.writeFile(path.join(output, 'first-turn-stopped-ui.json'), JSON.stringify(evidence.firstTurnPresentation, null, 2))
    evidence.firstTurnPresentation.qualification = assertR3StoppedUi(ui, mode,
      evidence.tools.find(value => value.id === 'apply-A-stopped'))
    await fs.writeFile(path.join(output, 'first-turn-stopped-ui.json'), JSON.stringify(evidence.firstTurnPresentation, null, 2))
    await page.screenshot({ path: path.join(output, 'first-turn-stopped-tools.png'), fullPage: true })
  }
  try {
    model = await createAbsStopModel({ nextTool: async input => {
      await gates.wait(input); const { turn, step } = input; currentTurn = turn
      if (turn === 0) {
        if (step === 0) return native('load-abs-tools', 'tool_load', { names: ['abs_export', 'abs_validate', 'abs_apply', 'project_recover', 'app_reload'] })
        if (step === 1) return deferred('export-baseline', 'abs_export', { project })
        if (step === 2) return native('read-before-A', 'read', { path: absPath })
        if (step === 3) return native('edit-A', 'edit', { path: absPath, edits: [
          { oldText: `${fixture.blockType}(100)`, newText: `${fixture.blockType}(101)` },
          ...(mode === 'apply-chat' ? [appendStatement(candidateA, fixture.blockType)] : []),
        ] })
        if (mode === 'apply-chat' && step === 4) return deferred('apply-A-stopped', 'abs_apply', { project, absPath })
        if (mode === 'recovery-owner' && step === 4) return deferred('validate-A-before-load-failure', 'abs_validate', { project, absPath })
        if (mode === 'recovery-owner' && step === 5) {
          assert.ok(backupA, 'Archive exact A before any failed activation')
          return deferred('one-real-app-reload-fails', 'app_reload', { project })
        }
        if (mode === 'recovery-owner' && step === 6) return deferred('apply-A-auto-recovers-stopped', 'abs_apply', { project, absPath })
        throw Error('A stopped first turn must not request a further model step')
      }
      assert.equal(turn, 1)
      if (step === 0) return native('read-A-next-turn', 'read', { path: absPath })
      if (step === 1) return native('edit-B-next-turn', 'edit', { path: absPath, edits: [
        ...(mode === 'apply-chat' ? [{ oldText: `${fixture.blockType}(101)`, newText: `${fixture.blockType}(100)` }] : []),
        { oldText: `${fixture.blockType}(200)`, newText: `${fixture.blockType}(201)` },
      ] })
      if (step === 2) return deferred('apply-A-B-next-turn', 'abs_apply', { project, absPath })
      assert.equal(step, 3); return undefined
    } })
    router = await createLocalChatApiRouter({ operationOrigin: model.origin, installedRoot: values['installed-root'] })
    const profile = await prepareInstalledChatProfile({ appData, installedRoot: values['installed-root'], apiBase: router.origin,
      baseConfigPath: path.join(repo, 'electron/config/config.json'), resourceAppData: values['resource-root'], token: router.token })
    const { ELECTRON_RUN_AS_NODE, AILY_CHILD_PATH, NODE_PATH, AILY_PORTABLE_ROOT, AILY_AUTH_FILE, ...env } = process.env
    evidence.launchAttempted = true
    app = await _electron.launch({ executablePath: values['executable-path'], cwd: repo, args: [`--user-data-dir=${path.join(suite, 'electron-profile')}`], timeout: 60000,
      env: { ...env, ...profile.env, AILY_E2E: '1', HOME: home, USERPROFILE: home, TEMP: temp, TMP: temp, npm_config_offline: 'true', npm_config_audit: 'false' } })
    hostPid = await app.evaluate(() => process.pid); evidence.hostPid = hostPid
    const acquiredProcesses = await processes()
    mainIdentity = acquiredProcesses.find(value => value.ProcessId === hostPid)
    assertCapturedEnvironmentProcess(mainIdentity, { ...mainIdentity, ExecutablePath: values['executable-path'] })
    assert.ok(mainIdentity.CommandLine.includes(path.join(suite, 'electron-profile')))
    evidence.mainIdentity = mainIdentity
    evidence.processCaptures.push({ phase: 'acquired', at: Date.now(), main: mainIdentity, tree: selectEnvironmentProcessTree(acquiredProcesses, mainIdentity) })
    await app.context().route('**/*', route => {
      const url = new URL(route.request().url())
      return !['http:', 'https:'].includes(url.protocol) || ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ? route.continue() : route.abort('blockedbyclient')
    })
    const deadline = Date.now() + 60000
    while (!page && Date.now() < deadline) { for (const candidate of app.windows()) if (await candidate.locator('app-main-window').count()) { page = candidate; break }; if (!page) await wait(100) }
    assert.ok(page)
    page.on('websocket', socket => { socket.on('framesent', ({ payload }) => { let value; try { value = JSON.parse(String(payload)) } catch { return }
      if (value.channel !== 'agent') return
      const command = value.command
      if (['session.create', 'session.subscribe', 'session.openSubscribe', 'session.open', 'prompt'].includes(command?.type))
        evidence.sessionCommands.push({ id: value.id, type: command.type, sessionId: command.sessionId ?? command.options?.sessionId, cwd: command.options?.cwd, at: Date.now() })
      if (command?.type !== 'abort') return
      commandIds.add(value.id); evidence.abortCommands.push({ id: value.id, sessionId: command.sessionId, source: command.source,
        reason: command.reason, waitForSettle: command.waitForSettle, at: Date.now() }) })
    socket.on('framereceived', ({ payload }) => { let value; try { value = JSON.parse(String(payload)) } catch { return }; if (value.channel !== 'agent') return
      if (value.type === 'response' && commandIds.has(value.id)) evidence.abortResponses.push({ id: value.id, ok: value.ok, accepted: value.result?.accepted, settled: value.result?.settled })
      if (value.type === 'response' && evidence.sessionCommands.some(command => command.id === value.id))
        evidence.sessionResponses.push({ id: value.id, ok: value.ok, subscribed: value.result?.subscribed, sessionId: value.result?.snapshot?.sessionId,
          cwd: value.result?.snapshot?.cwd, errorCode: value.error?.code, errorMessage: value.error?.message, at: Date.now() })
      if (value.type === 'event' && typeof value.event?.type === 'string') evidence.eventCounts[value.event.type] = (evidence.eventCounts[value.event.type] ?? 0) + 1 }) })
    page.on('dialog', dialog => dialog.dismiss())
    await page.evaluate(() => { const dismiss = () => { window.document.querySelector('app-onboarding .btn-skip')?.click(); window.document.querySelector('app-login .login-close')?.click() }
      new MutationObserver(dismiss).observe(window.document.documentElement, { childList: true, subtree: true }); dismiss() })
    await page.waitForFunction(() => window.ng?.getComponent(window.document.querySelector('app-header'))?.projectService)
    await page.evaluate(async project => { const domain = window.ng.getComponent(window.document.querySelector('app-header')).projectService
      await domain.initializeProjectDataSchema(project); if (!await domain.projectOpen(project)) throw Error('Owned project failed to open') }, project)
    await page.waitForFunction(project => window.ng.getComponent(window.document.querySelector('app-header')).projectService.getBlocklyProjectLoadStatus(project).ready, project, { timeout: 120000 })
    loaded = await assertInstalledChatLoaded(page, { installedRoot: values['installed-root'], output, expectedApiBase: router.origin,
      expectedInputHash: artifact.inputHash, expectedOutputHash: artifact.outputHash }); evidence.chat = loaded.evidence
    if (mode === 'apply-chat') {
      const descriptor = JSON.parse(await fs.readFile(path.join(home, '.aily-blockly/cli-bridge', hostPid + '.json'), 'utf8'))
      assert.equal(descriptor.pid, hostPid)
      evidence.nativeAuditInstalled = await app.evaluate(installCandidateColdAudit,
        JSON.stringify({ project, appData, pid: hostPid, port: descriptor.port }))
      assert.equal(evidence.nativeAuditInstalled.available, true)
    }
    baseline = await document(); evidence.baseline = { document: baseline, mirrors: await mirrors() }
    await page.evaluate(({ mode, project }) => {
      const host = window.ng.getComponent(window.document.querySelector('app-child-tool-host'))
      const editor = window.ng.getComponent(window.document.querySelector('app-blockly-editor')).blocklyService
      const originalReport = host.reportAiOperationState.bind(host), remote = host.remoteApi
      window.__absStopReports = []; window.__absStopRpc = []
      host.reportAiOperationState = (...args) => { const ack = originalReport(...args); window.__absStopReports.push({ request: args[0], ack }); return ack }
      // Observer delegates the exact original RPC and returns its real result.
      host.remoteApi = new Proxy(remote, { get(target, key) { if (key !== 'stopActiveTurn') return Reflect.get(target, key)
        return async (...args) => { const item = { input: args[0], at: Date.now() }; window.__absStopRpc.push(item)
          const result = await target.stopActiveTurn(...args); item.result = result; return result } } })
      const state = window.__absStopPause = { armed: false, entered: false, loadCalls: 0, injectedLoadFailures: 0, originalWorkspace: editor.workspace }
      const method = mode === 'apply-chat' ? 'prepareProjectCode' : 'loadProjectDocumentForOpen', original = editor[method]
      editor[method] = async function (...args) {
        if (mode === 'recovery-owner') { state.loadCalls++
          if (state.failNextLoad) { state.failNextLoad = false; state.injectedLoadFailures++; throw Error('TEST_ONCE_NATIVE_LOAD_FAILURE') } }
        if (state.armed && !state.entered) { state.entered = true; state.enteredAt = Date.now(); args[1].assertCurrent(); state.originalLeaseCurrent = true
          state.newWorkspace = this.workspace !== state.originalWorkspace
          if (mode === 'apply-chat') state.snapshot = JSON.stringify(this.captureProjectSnapshot(args[1]).document)
          await new Promise(resolve => { state.release = () => resolve() }) }
        return original.apply(this, args)
      }
      state.restore = () => { editor[method] = original; host.remoteApi = remote }
    }, { mode, project })
    await phase('real-installed-composer-first-turn')
    await submit(mode === 'apply-chat' ? 'Apply field A, then I will stop during native publication.' : 'Preserve field A while automatically restoring this same project; I will stop during reload.')
    const pauseDeadline = Date.now() + 120000
    while (Date.now() < pauseDeadline) { await observe(); const value = await state(); if (value.pause?.entered) { evidence.paused = value; break }; await wait(100) }
    assert.ok(evidence.paused, 'The intended real native operation must enter the pause')
    assert.equal(evidence.paused.pause.originalLeaseCurrent, true); assert.ok(same(evidence.paused.project, project))
    evidence.paused.mirrors = await mirrors(); assert.equal(evidence.paused.mirrors['project.abi'].hash, evidence.baseline.mirrors['project.abi'].hash)
    assert.ok(evidence.paused.owner && evidence.paused.owner.sessionId === sessionId)
    if (!evidence.candidateA) {
      evidence.candidateA = await readWorkingCandidateEvidence({ project, snapshot, candidateHash: hash(candidateA) })
      backupA = evidence.candidateA.ref
    }
    if (mode === 'apply-chat') { assert.equal(evidence.paused.nativeBusy, true)
      const observed = JSON.parse(evidence.paused.pause.snapshot)
      firstAppliedExpected = withAddedBlock(singleFieldExpectedDocument(baseline, fixture.blockId, 'VALUE', 100, 101), observed)
      assert.deepEqual(observed, firstAppliedExpected); evidence.addedBlockId = addedBlockId }
    else { assert.equal(evidence.paused.projectOpening, true); assert.equal(evidence.paused.loadStatus.ready, false)
      assert.equal(evidence.paused.pause.newWorkspace, true); assert.equal(evidence.paused.pause.injectedLoadFailures, 1)
      evidence.paused.candidateBackup = await readWorkingCandidateEvidence({ project, snapshot, ref: backupA, candidateHash: hash(candidateA), expectedBase: evidence.candidateA.record.base })
      const directory = path.join(project, '.aily/abs-sync/recoveries'), records = (await fs.readdir(directory)).filter(name => /^project-request-[a-f0-9]{64}\.json$/.test(name))
      assert.equal(records.length, 1, 'One original automatic same-project recovery must be in progress')
      const file = path.join(directory, records[0]), raw = await fs.readFile(file), record = JSON.parse(raw)
      assert.equal(record.version, 1); assert.ok(same(record.project, project)); assert.equal(records[0], `project-request-${sha(record.requestId)}.json`)
      const resultFile = path.join(directory, `project-result-${sha(record.requestId)}.json`)
      await assert.rejects(fs.readFile(resultFile), { code: 'ENOENT' }, 'A paused reload cannot have a completed result yet')
      recoveryRequest = { file, hash: hash(raw), record, resultFile }; evidence.paused.originalRecovery = recoveryRequest }
    await phase('click-real-' + (mode === 'apply-chat' ? 'chat-stop' : 'owner-notice-stop'))
    await page.screenshot({ path: path.join(output, 'paused-before-stop.png'), fullPage: true })
    if (mode === 'apply-chat') await loaded.frame.locator('button.primary-action.stop-action').click()
    else await page.locator('app-notification .notification-box').filter({ hasText: 'AI正在操作' }).locator('.btn.red').click()
    await wait(750); await observe(); evidence.stopping = { state: await state(), isIdle: snapshot.isIdle, mirrors: await mirrors() }
    assert.equal(snapshot.isIdle, false); assert.equal(evidence.stopping.state.hasRunning, true)
    assert.equal(evidence.abortCommands.length, 1); assert.equal(evidence.abortCommands[0].sessionId, sessionId)
    assert.ok(evidence.abortResponses.some(value => value.ok && value.accepted === true))
    if (mode === 'recovery-owner') { const rpc = evidence.stopping.state.stopRpc; assert.equal(rpc.length, 1)
      assert.equal(rpc[0].input.version, 2); assert.equal(rpc[0].input.turnId, evidence.paused.owner.turnId)
      assert.equal(rpc[0].input.bridgeInstanceId, evidence.paused.owner.bridgeInstanceId)
      assert.equal(rpc[0].result.requestAccepted, true); assert.equal(rpc[0].result.settled, false) }
    else assert.equal(evidence.stopping.state.stopRpc.length, 0, 'Composer stop uses the actual agent channel, not the host notice RPC')
    await page.evaluate(() => window.__absStopPause.release()); await settle(1); await clearUi()
    await stoppedPresentation()
    evidence.afterStop = { state: await state(), mirrors: await mirrors(), document: await document() }
    if (mode === 'apply-chat') {
      assert.deepEqual(evidence.afterStop.document, firstAppliedExpected)
      assert.deepEqual(JSON.parse(await fs.readFile(path.join(project, 'project.abi'), 'utf8')), firstAppliedExpected)
      const audit = await app.evaluate(() => globalThis.__ailyR3CandidateColdAudit.snapshot())
      const writes = audit.commands.filter(value => value.operation === 'abs_apply')
      assert.equal(writes.length, 1); originalApplyRequestId = writes[0].requestId
      assert.deepEqual(writes[0].ref, backupA)
      const pending = selectedWorkingCandidateRef(snapshot, project).checkpoint.candidatePublications?.[originalApplyRequestId]
      assert.equal(pending?.kind, 'abs_apply'); assert.deepEqual(pending.ref, backupA)
      const authoritative = await readR3CandidatePublication(project, originalApplyRequestId, backupA)
      originalWasAcceptedAtStop = authoritative.acceptance !== undefined
      evidence.afterStop.originalPublication = { requestId: originalApplyRequestId, pending, authoritative, accepted: originalWasAcceptedAtStop,
        raw: evidence.firstTurnPresentation.qualification.classification, audit }
      if (originalWasAcceptedAtStop) {
        const original = audit.terminals.find(value => value.operation === 'abs_apply' && value.requestId === originalApplyRequestId && value.ok === true)
        assert.ok(original?.receipt)
        evidence.afterStop.originalAcceptance = await readCandidateAcceptanceEvidence({ project,
          checkpoint: { candidatePublications: { [originalApplyRequestId]: authoritative } }, snapshot,
          requestId: originalApplyRequestId, ref: backupA, expectedOutput: original.receipt.output })
      }
      // UNKNOWN is an observer outcome. Only the real same-ID receipt and its
      // persisted acceptance after the next Core read can qualify delivery.
      if (evidence.firstTurnPresentation.qualification.classification.publication === 'COMMITTED')
        await assertApplied(evidence.tools.find(value => value.id === 'apply-A-stopped').result)
    }
    else { assert.deepEqual(evidence.afterStop.document, baseline)
      const stopped = evidence.tools.find(value => value.id === 'apply-A-auto-recovers-stopped')
      evidence.cancelledApplication = assertCancelledApplicationTool(stopped)
      assert.equal(evidence.tools.some(value => value.name === 'abs_apply' && value.result?.publication?.status === 'COMMITTED'), false)
      evidence.afterStop.candidateBackup = await readWorkingCandidateEvidence({ project, snapshot, ref: backupA, candidateHash: hash(candidateA), expectedBase: evidence.candidateA.record.base })
      assert.equal(hash(await fs.readFile(recoveryRequest.file)), recoveryRequest.hash, 'Stop must not replace the original recovery request')
      const completed = JSON.parse(await fs.readFile(recoveryRequest.resultFile, 'utf8'))
      assert.equal(completed.requestHash, recoveryRequest.hash); assert.equal(completed.requestId, recoveryRequest.record.requestId)
      assert.ok(same(completed.project, project)); assert.equal(completed.result.ok, true); assert.equal(completed.result.ready, true)
      assert.equal(completed.result.recoveryState, 'completed'); assert.equal(completed.result.candidateApplied, false)
      assert.equal(completed.result.receipt.requestId, recoveryRequest.record.requestId)
      evidence.afterStop.originalRecovery = completed
      assert.equal((snapshot.entries ?? []).some(entry => entry.type === 'custom' && entry.customType === 'aily.abs-workflow'
        && entry.data?.absHash === sha(candidateA)), false, 'A new fixed candidate must not write a second legacy proof/handoff') }
    await phase('next-real-composer-turn-read-edit-B-apply-A-B')
    currentTurn = 1; await submit(mode === 'apply-chat'
      ? 'Restore accepted field A to its original value 100, change field B to 201, and apply the complete program.'
      : 'Keep field A, change only field B, and apply the complete program.'); await settle(2); await clearUi()
    const applied = evidence.tools.find(value => value.id === 'apply-A-B-next-turn'); assert.equal(applied?.isError, false); await assertApplied(applied.result)
    const finalCandidate = await readWorkingCandidateEvidence({ project, snapshot,
      ...(mode === 'recovery-owner' ? { expectedBase: evidence.candidateA.record.base } : {}) })
    evidence.finalCandidate = finalCandidate
    if (mode === 'recovery-owner') { assert.equal(finalCandidate.ref.id, backupA.id); assert.notEqual(finalCandidate.ref.revisionHash, backupA.revisionHash) }
    else {
      assert.notEqual(finalCandidate.ref.id, backupA.id, 'An accepted application closes the old candidate; subsequent edits capture new actual Working')
      assert.equal(finalCandidate.ref.id, evidence.successorAfterOriginalAcceptance.ref.id)
      assert.deepEqual(finalCandidate.record.base, evidence.successorAfterOriginalAcceptance.record.base)
      await readWorkingCandidateEvidence({ project, ref: backupA, expectedBase: evidence.candidateA.record.base })
    }
    let expected = singleFieldExpectedDocument(mode === 'apply-chat' ? baseline
      : singleFieldExpectedDocument(baseline, fixture.blockId, 'VALUE', 100, 101), 'stop_boundary_second', 'VALUE', 200, 201)
    if (mode === 'apply-chat') expected = withAddedBlock(expected)
    assert.deepEqual(await document(), expected); assert.deepEqual(JSON.parse(await fs.readFile(path.join(project, 'project.abi'), 'utf8')), expected)
    const afterCalls = callsOf(snapshot); assert.equal(afterCalls.filter(call => call.actualName === 'abs_apply').length, 2)
    const firstRawCommitted = evidence.firstTurnPresentation.qualification?.classification?.publication === 'COMMITTED'
    assert.equal(evidence.tools.filter(value => value.name === 'abs_apply' && value.result?.publication?.status === 'COMMITTED').length,
      mode === 'apply-chat' && firstRawCommitted ? 2 : 1)
    if (mode === 'apply-chat') {
      evidence.finalNativeAudit = await app.evaluate(() => globalThis.__ailyR3CandidateColdAudit.snapshot())
      assertR3StopApplicationDispatches(evidence.finalNativeAudit, originalApplyRequestId, applied.result.receipt.requestId)
      assert.equal(evidence.finalNativeAudit.commands.filter(value => value.operation === 'abs_recovery' && value.action === 'candidate_capture').length, 2)
    }
    evidence.final = { state: await state(), document: expected, mirrors: await mirrors(), userMessages: snapshot.messages.filter(message => message.role === 'user').length }
    assert.ok(same(evidence.final.state.project, project)); assert.equal(evidence.final.state.recoveryRequired, false); assert.equal(evidence.eventCounts.agent_settled >= 2, true)
    if (mode === 'recovery-owner') {
      assert.equal(evidence.final.state.pause.loadCalls, 2, 'One failed native load plus one original recovery load; no stop-triggered reload replay')
      const records = (await fs.readdir(path.join(project, '.aily/abs-sync/recoveries'))).filter(name => /^project-request-[a-f0-9]{64}\.json$/.test(name))
      assert.equal(records.length, 1, 'The next turn must observe/converge the original recovery, not begin another one')
    }
    assert.deepEqual(model.snapshot().failures, []); assert.equal(model.snapshot().createCount, 2)
    await page.screenshot({ path: path.join(output, 'final.png'), fullPage: true }); evidence.ok = true
  } catch (error) { evidence.error = { message: error.message, stack: error.stack }
    if (page) {
      evidence.failureState = await state().catch(failure => ({ observationError: failure.message }))
      await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {})
    }
    if (loaded && sessionId) {
      const value = await loaded.e2e('session.read', { sessionId }).catch(() => undefined)
      if (value) await fs.writeFile(path.join(output, 'failure-session.json'), JSON.stringify(value.session, null, 2))
    }
    throw error }
  finally {
    gates.cancel(Error('Owned Chat Stop fixture is finishing'))
    if (app) {
      evidence.nativeAuditAtCleanup = await app.evaluate(() => globalThis.__ailyR3CandidateColdAudit?.snapshot()).catch(() => undefined)
      await app.evaluate(() => globalThis.__ailyR3CandidateColdAudit?.restore()).catch(() => {})
    }
    if (page) await page.evaluate(() => { window.__absStopPause?.release?.(); window.__absStopPause?.restore?.() }).catch(() => {})
    try { if (app && mainIdentity) {
      const all = await processes(), current = all.find(value => value.ProcessId === hostPid)
      const owned = current ? selectEnvironmentProcessTree(all, mainIdentity) : evidence.processCaptures[0].tree
      evidence.cleanup = { main: mainIdentity, capturedAt: Date.now(), mainPresent: !!current, capturedTree: owned,
        previouslyCapturedTree: evidence.processCaptures[0].tree, mode: 'owned-forced-test-cleanup', gracefulCloseTested: false }
      if (current) {
        assertCapturedEnvironmentProcess(current, mainIdentity)
        evidence.processCaptures.push({ phase: 'before-cleanup', at: Date.now(), main: current, tree: owned })
        await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', environmentProcessStopScript(mainIdentity)], { windowsHide: true, timeout: 20000 })
      }
      for (const child of remainingEnvironmentProcesses(owned, await processes()).filter(value => value.ProcessId !== hostPid))
          await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', environmentProcessStopScript(child)], { windowsHide: true, timeout: 20000 })
      const deadline = Date.now() + 30000
      let remaining, finalProcesses
      do { finalProcesses = await processes(); remaining = remainingEnvironmentProcesses(owned, finalProcesses); if (!remaining.length) break; await wait(150) } while (Date.now() < deadline)
      evidence.cleanup.remaining = remaining
      evidence.cleanup.finalCapturedPidRows = finalProcesses.filter(value => owned.some(old => old.ProcessId === value.ProcessId))
      evidence.cleanup.verifiedAt = Date.now()
      evidence.finalOwnedProcesses = current ? remaining.length : null
      assert.deepEqual(remaining, [])
      assert.ok(current, 'Do not claim complete tree cleanup when the Main disappeared before the final tree capture')
      evidence.cleanupMode = 'owned-forced-test-cleanup'; evidence.gracefulCloseTested = false; app = undefined
    } else if (evidence.launchAttempted) {
      throw Error('The Host launch was attempted without a captured Main identity; owned cleanup cannot be qualified')
    } else evidence.finalOwnedProcesses = 0
    } catch (error) { evidence.ok = false; evidence.cleanupError = { message: error.message, stack: error.stack } }
    evidence.transport = model?.snapshot(); evidence.api = router?.snapshot(); evidence.phaseGates = gates.snapshot()
    await router?.close(); await model?.close(); evidence.finishedAt = new Date().toISOString(); await persist()
    await fs.writeFile(path.join(values.output, 'summary.json'), JSON.stringify({ ok: results.every(value => value.ok), cases: results.map(value => ({ mode: value.mode, ok: value.ok, suite: value.suite })) }, null, 2))
  }
}
for (const mode of cases) await runCase(mode)
assert.deepEqual(await verifyPortableBuild(values['installed-root']), artifact)
assert.equal(artifact.inputHash, sha(JSON.stringify(await captureBuildInputs(values['lex-root']))))
assert.equal(sha(await fs.readFile(asar)), hostHash)
