import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { _electron } from '@playwright/test'
import { serveRendererBuild } from '../fixtures/build-renderer-server.mjs'
import { prepareInstalledChatProfile, assertInstalledChatLoaded } from '../fixtures/installed-chat-ui.mjs'
import { explicitOnlineModelId, resolveOnlineModelPreset,
  selectOnlineModelFromUi, assertSelectedOnlineModel } from '../fixtures/online-model-selection.mjs'
import { prepareBuildLogProject, buildLogSourceHashes } from './fixtures/build-log-project.mjs'
import { createBuildLogNetwork } from './fixtures/build-log-network.mjs'
import { verifySealedComparisonBaseline, summarizeOnlineComparison, summarizeCaseTransport, singleFieldExpectedDocument } from './fixtures/online-comparison.mjs'

// Real, explicitly enabled paid acceptance. Every model call is submitted by
// the installed iframe composer. Services is the model upstream; the local
// production Blockly/Arduino compiler produces the actual request logs.
assert.equal(process.env.AILY_ONLINE_ACCEPTANCE, '1', 'Explicitly enable the real online acceptance')
const repo = fileURLToPath(new URL('../../', import.meta.url))
const required = ['connection-profile', 'installed-root', 'test-root', 'resource-root', 'lex-root', 'output']
const optional = ['executable-path', 'host-build', 'boards-root', 'libraries-root', 'sealed-baseline-receipt']
const { values } = parseArgs({ options: { ...Object.fromEntries([...required, ...optional, 'upstream-address'].map(name => [name, { type: 'string' }])),
  'expected-thinking-level': { type: 'string' },
  'expected-effective-model': { type: 'string' },
  'minimum-free-memory-mib': { type: 'string' },
  'fixture-preflight-only': { type: 'boolean' },
  'comparison-tools': { type: 'boolean' },
  cases: { type: 'string', default: 'success,failure,cancel,chat-stop,reconnect,observation' } } })
for (const name of required) assert.ok(values[name] && path.isAbsolute(values[name]), `--${name} must be absolute`)
for (const name of optional) if (values[name]) assert.ok(path.isAbsolute(values[name]), `--${name} must be absolute`)
assert.ok(values['executable-path'] || values['host-build'], 'Provide the actual installed executable or a renderer build')
const cases = values.cases.split(',')
const minimumFreeMemoryMiB = values['minimum-free-memory-mib'] === undefined ? 0 : Number(values['minimum-free-memory-mib'])
if (values['expected-thinking-level']) assert.match(values['expected-thinking-level'], /^[a-z]{2,16}$/)
assert.ok(Number.isSafeInteger(minimumFreeMemoryMiB) && minimumFreeMemoryMiB >= 0)
assert.ok(cases.length && new Set(cases).size === cases.length && cases.every(name => ['success', 'failure', 'cancel', 'chat-stop', 'reconnect', 'observation', 'field-edit'].includes(name)))
const same = (left, right) => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
const inside = (parent, file) => { const relative = path.relative(parent, file)
  return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) }
assert.ok(inside(path.join(values['resource-root'], 'dev-tests'), values['test-root']))
assert.ok(inside(path.join(repo, 'e2e/test-results'), values.output))
const sha = value => createHash('sha256').update(value).digest('hex')
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
const textOf = message => (message?.content ?? []).filter(item => item.type === 'text').map(item => item.text).join('\n')
const payloadOf = message => {
  if (message?.details?.result && typeof message.details.result === 'object') return message.details.result
  try { return JSON.parse(textOf(message)) } catch { return undefined }
}
const callsOf = snapshot => (snapshot?.messages ?? []).filter(message => message.role === 'assistant').flatMap(message => message.content ?? [])
  .filter(item => item.type === 'toolCall').map(item => ({ ...item,
    actualName: item.name === 'tool_invoke' ? item.arguments?.name : item.name,
    actualArguments: item.name === 'tool_invoke' ? item.arguments?.arguments : item.arguments }))
const connection = JSON.parse(await fs.readFile(values['connection-profile'], 'utf8'))
assert.ok(typeof connection.apiBase === 'string' && path.isAbsolute(connection.configFile ?? '') && path.isAbsolute(connection.authFile ?? ''))
const api = new URL(connection.apiBase)
assert.ok(['http:', 'https:'].includes(api.protocol) && api.pathname === '/' && !api.username && !api.password && !api.search && !api.hash)
assert.ok(!same(connection.authFile, path.join(values['resource-root'], '.aily')), 'Use the explicit test account profile')
await fs.mkdir(values.output, { recursive: false })
const suite = await fs.mkdtemp(path.join(values['test-root'], 'build-log-installed-'))
const appData = path.join(suite, 'appdata'), home = path.join(suite, 'home')
const agentProfile = path.join(suite, 'agent-profile'), agentTemp = path.join(suite, 'agent-temp')
const boardsRoot = values['boards-root'] ?? path.resolve(repo, '../aily-blockly-boards')
const librariesRoot = values['libraries-root'] ?? path.resolve(repo, '../aily-blockly-libraries')
const evidence = { ok: false, suite, output: values.output, cases: [], actualIframeComposer: true, realInstalledUi: true,
  onlineLlm: false, syntheticOutput: false, fabricatedToolResults: false, hardwareUsed: false,
  compiler: { backend: 'local', upstreamServicesIsCompiler: false }, userProjectsModified: false, cleanupFailures: [] }
let app, page, loaded, renderer, proxy, hostPid, artifact, verifyPortableBuild, accessToken, selectedModel, expectedEffectiveModel, activeCase
const protectedFiles = new Map(), projects = new Map()
const safeError = error => {
  let message = String(error?.message ?? error)
  if (accessToken) message = message.replaceAll(accessToken, '[private credential]')
  return { name: error?.name, code: error?.code,
    message: message.replace(/([?&]token=|Bearer\s+)[^\s"'&]+/gi, '$1[private credential]') }
}
const checkpoint = async () => {
  evidence.transport = proxy?.snapshot()
  for (const record of evidence.cases) {
    if (!record.transportWindow) continue
    Object.assign(record, summarizeCaseTransport(evidence.transport, record.transportWindow, {
      functionalPassed: record.functionalPassed === true,
      expectedFaultKind: record.scenario === 'reconnect' ? 'accepted-build-result-sse-disconnect' : null }))
    if (record.transportWindow.endedAt !== undefined)
      await fs.writeFile(path.join(values.output, record.scenario + '.json'), JSON.stringify(record, null, 2))
  }
  await fs.writeFile(path.join(values.output, 'progress.json'), JSON.stringify(evidence, null, 2))
}
const finishCase = async (record, functionalPassed = true) => {
  record.functionalPassed = functionalPassed
  record.transportWindow.endRequestIndex = proxy.snapshot().requests.length
  record.transportWindow.endedAt = Date.now()
  await checkpoint()
}
const phase = async name => { evidence.phase = name; console.log(new Date().toISOString(), 'PHASE=' + name); await checkpoint() }
async function trustOnly(project) {
  for (const dialog of await loaded.frame.locator('.pi-extension-dialog').all()) if (await dialog.isVisible()) {
    const lines = String(await dialog.getAttribute('aria-label')).split(/\r?\n/)
    assert.equal(lines[0], 'Trust project folder?'); assert.ok(same(lines[1], project))
    await dialog.getByRole('button', { name: 'Trust (this session only)', exact: true }).click()
  }
  assert.equal(await loaded.frame.locator('.full-access-permission-dialog').isVisible(), false)
}
async function ownedSnapshot(project) {
  await trustOnly(project)
  const listed = await loaded.e2e('session.list'), matches = listed.sessions.filter(item => same(item.cwd, project))
  assert.ok(matches.length <= 1, 'An isolated project has only its real iframe session')
  if (!matches.length) return undefined
  const snapshot = (await loaded.e2e('session.read', { sessionId: matches[0].sessionId })).session
  assertSelectedOnlineModel(snapshot, selectedModel)
  assert.equal(snapshot.permissionMode, 'default')
  return snapshot
}
const hostState = () => page.evaluate(() => {
  const editor = window.ng.getComponent(document.querySelector('app-blockly-editor'))
  const builder = editor?._builderService, service = editor?.blocklyService
  const host = window.ng.getComponent(document.querySelector('app-child-tool-host'))
  const notices = [...document.querySelectorAll('app-notification .notification-box')]
  return { project: editor?.projectService.currentProjectPath, activeBuildRequestId: builder?.activeBuildRequestId,
    streamId: builder?.streamId, buildCompleted: builder?.buildCompleted, cancelled: builder?.cancelled,
    aiNoticeCount: notices.filter(node => /AI正在操作|正在停止 AI|正在同步 AI 状态/.test(node.textContent)).length,
    hasRunning: host?.aiOperationProtocol?.hasRunning, writing: service?.aiWriting, waitWriting: service?.aiWaitWriting,
    busy: service?.isWorkspaceEditInProgress(), blocked: service?.isWorkspaceEditBlocked(),
    recoveryRequired: service?.isWorkspaceRecoveryRequired() }
})
async function openProject(project, scenario) {
  await phase('open-' + scenario)
  await page.evaluate(async target => {
    const service = window.ng.getComponent(document.querySelector('app-header')).projectService
    if (service.currentProjectPath && !await service.close()) throw Error('Owned previous project did not close')
    await service.initializeProjectDataSchema(target)
    if (!await service.projectOpen(target)) throw Error('Owned template project did not open')
  }, project)
  await page.waitForFunction(target => {
    const editor = window.ng.getComponent(document.querySelector('app-blockly-editor'))
    return editor?.projectService.currentProjectPath === target && editor.projectService.getBlocklyProjectLoadStatus(target)?.ready
      && editor?._builderService?.isInstallInProgress() === false
  }, project, { timeout: 120000 })
  loaded = await assertInstalledChatLoaded(page, { installedRoot: values['installed-root'], expectedApiBase: proxy.origin,
    expectedInputHash: artifact.inputHash, expectedOutputHash: artifact.outputHash })
  evidence.chat ??= { ...loaded.evidence, syntheticIdentity: false }
  evidence.renderer ??= { origin: new URL(page.url()).origin,
    loadedFromAsar: !renderer && evidence.host?.packaged === true && /app\.asar$/i.test(evidence.host.appPath),
    developmentRendererOverride: Boolean(renderer) }
  // A cold installed catalog loads after the visible composer. Wait for its
  // exact selectable preset within the normal startup budget; never substitute
  // another model or send a request while the catalog is still empty.
  if (selectedModel) await selectOnlineModelFromUi(loaded.frame, selectedModel, { catalogTimeoutMs: 60000 })
  await page.evaluate(async target => {
    const service = window.ng.getComponent(document.querySelector('app-header')).projectService
    const result = await service.save(target)
    if (!result?.success) throw Error('Initial source save failed')
  }, project)
  const fixture = projects.get(scenario)
  const sourceDeadline = Date.now() + 15000
  let generated = ''
  do {
    generated = await page.evaluate(() => window.ng.getComponent(document.querySelector('app-blockly-editor'))
      .blocklyService.getReusableGeneratedCode() ?? '')
    if (generated.includes(fixture.marker)) break
    await wait(100)
  } while (Date.now() < sourceDeadline)
  assert.ok(generated.includes(fixture.marker), 'Validate this actual generated source fixture before any model call')
  assert.equal(generated.includes('#error'), scenario === 'failure')
  evidence.sourceFixtures ??= {}
  evidence.sourceFixtures[scenario] = { source: 'actual-current-native-generator-preview', sha256: sha(generated), bytes: Buffer.byteLength(generated),
    expectedMarkerEmitted: true, intentionalError: scenario === 'failure', library: fixture.libraryName, blockType: fixture.blockType }
  return page.evaluate(() => JSON.stringify(window.Blockly.serialization.workspaces.save(window.Blockly.getMainWorkspace())))
}
async function submit(prompt) {
  const startedAt = Date.now(), minimumBytes = minimumFreeMemoryMiB * 1024 * 1024
  let freeMemoryBytes = os.freemem(), lowestFreeMemoryBytes = freeMemoryBytes, sampleCount = 1
  while (freeMemoryBytes < minimumBytes && Date.now() - startedAt < 60000) {
    assert.equal(page.isClosed(), false, 'The owned app closed while waiting for resources')
    await wait(1000); freeMemoryBytes = os.freemem(); sampleCount++
    lowestFreeMemoryBytes = Math.min(lowestFreeMemoryBytes, freeMemoryBytes)
  }
  const resource = { at: Date.now(), startedAt, waitMs: Date.now() - startedAt, sampleCount, lowestFreeMemoryBytes,
    freeMemoryBytes, totalMemoryBytes: os.totalmem(), cpus: os.cpus().length,
    ...(process.platform === 'win32' ? { loadAverageSupported: false } : { loadAverage: os.loadavg() }), minimumFreeMemoryMiB }
  evidence.resources ??= []; evidence.resources.push(resource)
  assert.ok(resource.freeMemoryBytes >= minimumFreeMemoryMiB * 1024 * 1024, 'Insufficient free physical memory for the explicitly bounded paid sample')
  const input = loaded.frame.locator('.aily-chat-composer-input[role="textbox"]')
  const send = loaded.frame.locator('button.primary-action.send-action')
  const deadline = Date.now() + 30000
  // A real workspace switch may finish after its textarea becomes visible and
  // reset an unsent draft. Stabilize that unsent text before the single click;
  // never retry a click or an already submitted original interaction.
  while (Date.now() < deadline) {
    if (await input.innerText() !== prompt) await input.fill(prompt)
    await wait(150)
    if (await input.innerText() === prompt && await send.isEnabled()) break
  }
  assert.equal(await input.innerText(), prompt, 'The new workspace must retain its unsent input')
  assert.equal(await send.isEnabled(), true, 'The normal composer must acknowledge the unsent input')
  await send.click({ timeout: 5000 })
  evidence.onlineLlm = true
}
function watchUserBuildStop(project, record, surface) {
  assert.ok(['chat', 'compile-notice'].includes(surface))
  let finished = false
  const deadline = Date.now() + 12 * 60 * 1000
  const promise = (async () => {
    while (!finished && Date.now() < deadline) {
      const state = await hostState()
      assert.ok(same(state.project, project))
      if (state.activeBuildRequestId && state.streamId && !state.buildCompleted && !state.cancelled && state.hasRunning) {
        const stop = surface === 'chat' ? loaded.frame.locator('button.primary-action.stop-action')
          : page.locator('app-notification .notification-box').filter({ hasText: /编译|Compil/i }).locator('.btn.red')
        if (await stop.count() === 1 && await stop.isVisible() && await stop.isEnabled()) {
          record.runningBuild = { requestId: state.activeBuildRequestId, hostPid, streamId: state.streamId,
            actualHostAgentRunning: state.hasRunning, at: Date.now() }
          await stop.click({ timeout: 5000 })
          record.stop = { surface: 'actual-' + surface + '-stop-button', at: Date.now() }
          await phase(surface + '-user-stop-clicked')
          return
        }
      }
      await wait(40)
    }
    if (!finished) throw Object.assign(new Error('No actual running compiler was available to stop'), { code: 'SCENARIO_NOT_COVERED' })
  })()
  // The caller awaits this exact promise on exit. An early rejection must not
  // become unhandled while the independent session observer is still pending.
  promise.catch(() => {})
  return { async finish() { finished = true; await promise } }
}
async function settle({ project, record, expectedUserMessages }) {
  const deadline = Date.now() + 12 * 60 * 1000
  let snapshot, nextCheckpoint = 0
  const observed = new Set(record.toolResultIds ?? [])
  while (Date.now() < deadline) {
    snapshot = await ownedSnapshot(project)
    const state = await hostState()
    assert.ok(same(state.project, project))
    if (snapshot) {
      record.sessionId = snapshot.sessionId
      for (const message of snapshot.messages.filter(item => item.role === 'toolResult')) {
        if (observed.has(message.toolCallId)) continue
        observed.add(message.toolCallId)
        const call = callsOf(snapshot).find(call => call.id === message.toolCallId)
        const result = payloadOf(message)
        const tool = { name: call?.actualName ?? message.toolName, id: message.toolCallId, isError: message.isError === true,
          ...(result?.buildReceipt ? { buildReceipt: result.buildReceipt, logStatus: result.logStatus } : {}) }
        record.tools.push(tool)
        console.log(new Date().toISOString(), 'TOOL', tool.name, tool.isError ? 'ERROR' : 'OK')
      }
      const final = snapshot.messages.filter(message => message.role === 'assistant').at(-1)
      const users = snapshot.messages.filter(message => message.role === 'user').length
      if (users === expectedUserMessages && snapshot.isIdle && !snapshot.isStreaming && ['stop', 'error', 'aborted'].includes(final?.stopReason)) {
        record.final = { stopReason: final.stopReason, assistantTextSha256: sha(textOf(final)), errorMessage: final.errorMessage }
        record.comparison = summarizeOnlineComparison(snapshot, { startedAt: record.submittedAt,
          expectedModel: expectedEffectiveModel, expectedPreset: selectedModel?.id,
          transport: proxy.snapshot(),
          userStopObserved: record.stop?.surface === 'actual-chat-stop-button',
          businessActionNames: record.scenario === 'field-edit' ? ['edit', 'abs_apply'] : ['project_build'] })
        if (values['expected-thinking-level']) {
          record.comparison.expectedThinkingLevel = values['expected-thinking-level']
          record.comparison.thinkingEvidenceValid = record.comparison.thinkingLevels.length > 0
            && record.comparison.thinkingLevels.every(level => level === values['expected-thinking-level'])
          assert.equal(record.comparison.thinkingEvidenceValid, true, 'Observe the requested thinking setting; never silently lower it')
          record.comparison.httpReasoningEvidenceValid = record.comparison.providerTimings.length > 0
            && record.comparison.providerTimings.every(item => item.httpEvidence?.reasoningEffortComplete
              && item.httpEvidence.reasoningEfforts.every(level => level === values['expected-thinking-level']))
          assert.equal(record.comparison.httpReasoningEvidenceValid, true, 'Observe the actual unchanged HTTP request reasoning_effort separately from session selection')
        }
        record.settledAt = Date.now()
        record.finalHost = state; record.toolResultIds = [...observed]
        await checkpoint()
        return snapshot
      }
    }
    if (Date.now() >= nextCheckpoint) { nextCheckpoint = Date.now() + 5000; record.lastHost = state; await checkpoint() }
    await wait(350)
  }
  throw Object.assign(new Error('Original online turn did not settle inside its bounded deadline'), { code: 'SCENARIO_NOT_COVERED' })
}
async function assertLogRead(snapshot, record, fixture) {
  const calls = callsOf(snapshot), builds = calls.filter(call => call.actualName === 'project_build')
  const starts = builds.filter(call => !call.actualArguments?.build_request_id)
  assert.equal(starts.length, 1, 'One original build start; failure/recovery/cancellation cannot restart it')
  assert.ok(builds.every(call => same(call.actualArguments?.project ?? '', fixture.project)))
  for (const forbidden of ['write', 'edit', 'abs_apply', 'abs_validate', 'project_upload', 'blocks_tidy', 'app_reload', 'bash', 'powershell', 'code_run'])
    assert.equal(calls.some(call => call.actualName === forbidden), false, `No repair or unrelated action: ${forbidden}`)
  const resultMessages = snapshot.messages.filter(message => message.role === 'toolResult' && builds.some(call => call.id === message.toolCallId))
  const completed = resultMessages.map(message => ({ message, value: payloadOf(message) })).filter(item => item.value?.buildReceipt?.state === 'completed')
  assert.ok(completed.length >= 1, 'The real host must confirm the terminal request')
  const { value } = completed.at(-1), requestId = value.buildReceipt.requestId
  record.build = value
  assert.equal(value.buildReceipt.version, 1); assert.ok(same(value.buildReceipt.project, fixture.project))
  assert.equal(value.targetPid, hostPid)
  const cancelled = value.buildOutcome === 'cancelled'
  const execution = await page.evaluate(({ project, requestId }) => window.builder.inspectBuildExecution(project, requestId),
    { project: fixture.project, requestId })
  assert.ok(execution, 'The exact request must retain its private execution record')
  assert.equal(execution.buildRequestId, requestId)
  assert.equal(execution.status, cancelled ? 'cancelled' : value.ok ? 'completed' : 'failed')
  assert.equal(execution.current, true)
  record.execution = execution
  if (record.scenario === 'chat-stop') {
    assert.ok(value.ok === true || cancelled, 'Stopping observation must not fabricate a compiler failure')
    assert.equal(record.stop?.surface, 'actual-chat-stop-button')
    assert.equal(value.verification?.status, cancelled ? 'cancelled' : 'passed')
    record.chatStopCompilationOutcome = cancelled ? 'host-confirmed-cancelled' : 'host-confirmed-success'
  } else {
    assert.equal(value.ok, record.scenario !== 'failure' && record.scenario !== 'cancel')
    assert.equal(value.verification?.status, record.scenario === 'cancel' ? 'cancelled' : record.scenario === 'failure' ? 'failed' : 'passed')
  }
  assert.equal(value.logStatus, cancelled ? 'partial' : 'complete')
  if (record.scenario === 'cancel' || record.scenario === 'chat-stop') {
    assert.ok(record.stop, 'The actual user stop control must have been clicked')
    if (record.scenario === 'cancel') {
      assert.equal(record.stop.surface, 'actual-compile-notice-stop-button')
      assert.equal(value.buildOutcome, 'cancelled')
    }
    assert.equal(requestId, record.runningBuild.requestId)
    assert.ok(builds.slice(1).every(call => call.actualArguments.build_request_id === requestId && call.actualArguments.build_target_pid === hostPid))
  }
  assert.ok(same(value.sourceLogFile, path.join(fixture.project, '.log/compile/requests', sha(requestId) + '.log')))
  assert.ok(path.isAbsolute(value.resultFile))
  const [source, copy] = await Promise.all([fs.readFile(value.sourceLogFile, 'utf8'), fs.readFile(value.resultFile, 'utf8')])
  assert.equal(copy, source); assert.ok(source.startsWith(`Build request: ${requestId}\n`))
  const loggedProject = /^Project: (.+)$/m.exec(source)?.[1]
  assert.ok(loggedProject && same(loggedProject, fixture.project), 'The actual log header must name its bound project')
  if (record.scenario === 'failure') {
    assert.ok(source.includes(fixture.marker), 'The actual failed C++ diagnostic must identify this intentional source error')
  } else if (!cancelled) {
    // The installed AVR recipe uses -w, so a successful #pragma message need
    // not be emitted. Attest the actual generated source and compiler command
    // instead of requiring a warning that this real toolchain suppresses.
    assert.equal(execution.result?.buildRequestId, requestId, 'Only the exact successful request can supply compiler input')
    assert.ok(inside(path.join(fixture.project, '.aily/build-executions'), execution.result.currentProjectPath))
    const sketch = await fs.readFile(path.join(execution.result.currentProjectPath, '.temp/sketch/sketch.ino'), 'utf8')
    assert.ok(sketch.includes(fixture.marker), 'The real source generator must have emitted this source fixture')
    assert.ok(source.includes('avr-g++') && source.includes('Compilation successful'), 'The request log must contain the real successful compiler invocation')
  }
  const lines = source.split('\n'), range = { offset: Math.max(1, lines.length - 79), limit: Math.min(80, lines.length) }
  assert.equal(value.logLineCount, lines.length); assert.deepEqual(value.readRange, range)
  assert.equal(value.stderr, undefined); assert.equal(value.compileDiagnostics, undefined)
  const reads = calls.filter(call => call.actualName === 'read' && same(call.actualArguments?.path ?? '', value.resultFile))
  assert.ok(reads.some(call => call.actualArguments.offset === range.offset && call.actualArguments.limit === range.limit),
    'The real model must use the returned path and exact suggested read range')
  const read = reads.find(call => call.actualArguments.offset === range.offset && call.actualArguments.limit === range.limit)
  const readMessages = snapshot.messages.filter(message => message.role === 'toolResult' && message.toolCallId === read.id)
  assert.equal(readMessages.length, 1); assert.notEqual(readMessages[0].isError, true)
  const expectedTail = lines.slice(range.offset - 1, range.offset - 1 + range.limit).filter(line => line.trim())
  const readText = textOf(readMessages[0])
  for (const line of expectedTail.slice(-3)) assert.ok(readText.includes(line), 'Actual native read must contain the requested compiler log tail')
  const requestFiles = await fs.readdir(path.dirname(value.sourceLogFile))
  assert.deepEqual(requestFiles, [sha(requestId) + '.log'], 'A failure/reconnect/cancel must not silently compile a second request')
  const before = await fs.stat(value.resultFile), originalHash = sha(copy)
  await wait(100)
  assert.equal(sha(await fs.readFile(value.resultFile)), originalHash); assert.equal((await fs.stat(value.resultFile)).mtimeMs, before.mtimeMs)
  record.build = value; record.logProof = { requestId, logSha256: originalHash, bytes: Buffer.byteLength(source), lineCount: lines.length,
    readRange: range, actualNativeRead: true, readToolCallIdSha256: sha(read.id), requestFiles: requestFiles.length, immutableCopy: true }
  return requestId
}

try {
  await phase('prepare-isolated-board-template-projects')
  for (const directory of [appData, home, agentProfile, agentTemp]) await fs.mkdir(directory)
  for (const scenario of cases) {
    const marker = 'BUILD_LOG_' + scenario.toUpperCase() + '_' + randomUUID().replaceAll('-', '')
    const fixture = await prepareBuildLogProject({ directory: path.join(suite, scenario), boardsRoot, librariesRoot, scenario, marker })
    projects.set(scenario, fixture)
  }
  for (const file of new Set([values['connection-profile'], connection.configFile, connection.authFile,
    path.join(values['resource-root'], 'config.json'), path.join(values['resource-root'], '.aily'),
    path.join(values['resource-root'], 'npm-global/app/store/subapp-aily-chat/active.json'),
    path.join(values['resource-root'], 'npm-global/app/subapp-index.json')])) {
    protectedFiles.set(file, await fs.readFile(file).then(sha).catch(error => { if (error.code === 'ENOENT') return null; throw error }))
  }
  const config = JSON.parse(await fs.readFile(connection.configFile, 'utf8'))
  assert.equal(new URL(config.regions?.[config.region]?.api_server).origin, api.origin)
  const auth = JSON.parse(await fs.readFile(connection.authFile, 'utf8'))
  assert.ok(typeof auth.access_token === 'string' && auth.access_token); accessToken = auth.access_token
  ;({ verifyPortableBuild } = await import(pathToFileURL(path.join(values['lex-root'], 'packages/aily-chat/server/portable-integrity.ts'))))
  artifact = await verifyPortableBuild(values['installed-root'])
  const { captureBuildInputs } = await import(pathToFileURL(path.join(values['lex-root'], 'packages/aily-chat/scripts/portable-build-inputs.mjs')))
  if (values['sealed-baseline-receipt']) {
    assert.ok(values['executable-path'] && !values['host-build'], 'A sealed before arm must use its sealed real host')
    evidence.inputVerification = await verifySealedComparisonBaseline({ receiptFile: values['sealed-baseline-receipt'],
      installedRoot: values['installed-root'], executablePath: values['executable-path'], artifact })
  } else {
    assert.equal(artifact.inputHash, sha(JSON.stringify(await captureBuildInputs(values['lex-root']))))
    evidence.inputVerification = { mode: 'current-source', sourceCurrent: true, inputHash: artifact.inputHash }
  }
  evidence.installed = artifact; evidence.upstream = { apiBase: api.origin, explicitConnectionProfile: true }
  proxy = await createBuildLogNetwork({ upstreamOrigin: api.origin, upstreamAddress: values['upstream-address'] })
  await phase('129-real-auth-and-model-preflight')
  const headers = { authorization: 'Bearer ' + accessToken }
  const me = await fetch(proxy.origin + '/api/v1/auth/me', { headers, signal: AbortSignal.timeout(15000) })
  evidence.authStatus = me.status; await me.body?.cancel(); assert.equal(me.status, 200)
  if (explicitOnlineModelId(connection.model)) {
    const response = await fetch(proxy.origin + '/api/v2/model_catalog', { headers, signal: AbortSignal.timeout(15000) })
    assert.equal(response.status, 200)
    const catalog = await response.json()
    selectedModel = resolveOnlineModelPreset(catalog, connection.model)
    const preset = { ...catalog.data?.model_presets?.[selectedModel.id], ...catalog.data?.user_visible_model_presets?.[selectedModel.id] }
    expectedEffectiveModel = preset.auto_select === false && typeof preset.model === 'string' ? preset.model : undefined
    if (values['expected-effective-model'])
      assert.equal(expectedEffectiveModel, values['expected-effective-model'], 'The comparison catalog must pin the explicitly expected effective model')
    evidence.selectedModel = { ...selectedModel, expectedEffectiveModel, catalogSha256: sha(JSON.stringify(catalog)) }
  }
  if (values['expected-effective-model']) assert.equal(expectedEffectiveModel, values['expected-effective-model'])
  const profile = await prepareInstalledChatProfile({ appData, installedRoot: values['installed-root'], apiBase: proxy.origin,
    baseConfigPath: connection.configFile, resourceAppData: values['resource-root'], token: accessToken })
  profile.config.compile = { ...profile.config.compile, backend: 'local' }
  await fs.writeFile(path.join(appData, 'config.json'), JSON.stringify(profile.config, null, 2))
  // resourceAppData gives this profile read-through access to the installed
  // platform metadata and SDK/compiler bodies. Do not seed private metadata
  // through those junctions or write anything into the daily resource trees.
  const permission = { '*': 'deny', tool_load: 'allow', tool_invoke: 'allow', skill: 'allow', read: 'allow', project_build: 'allow',
    todo: 'allow', ...(values['comparison-tools'] || cases.includes('field-edit') ? { edit: 'allow', abs_apply: 'allow', abs_validate: 'allow' } : {}),
    external_directory: { '*': 'deny', [suite + '/*']: 'allow', [values['installed-root'] + '/*']: 'allow' },
    path: { '*': 'allow', [path.join(appData, '.aily')]: 'deny', [connection.authFile]: 'deny', [connection.configFile]: 'deny',
      [values['connection-profile']]: 'deny', [path.join(values['resource-root'], '.aily')]: 'deny' } }
  evidence.toolPermissionPolicy = Object.fromEntries(Object.entries(permission).filter(([key]) => !['path', 'external_directory'].includes(key)))
  const policy = path.join(agentProfile, 'extensions/pi-permission-system/config.json')
  await fs.mkdir(path.dirname(policy), { recursive: true }); await fs.writeFile(policy, JSON.stringify({ permission }), { flag: 'wx' })
  if (values['host-build']) renderer = await serveRendererBuild(values['host-build'])
  const { ELECTRON_RUN_AS_NODE, AILY_CHILD_PATH, NODE_PATH, AILY_PORTABLE_ROOT, AILY_AUTH_FILE, ...env } = process.env
  await phase('cold-current-blockly-and-installed-chat')
  app = await _electron.launch({ ...(values['executable-path'] ? { executablePath: values['executable-path'] } : {}),
    args: [...(values['executable-path'] ? [] : ['.']), ...(renderer ? ['--serve'] : []), `--user-data-dir=${path.join(suite, 'electron-profile')}`],
    cwd: repo, timeout: 60000, env: { ...env, ...profile.env, AILY_E2E: '1',
      ...(renderer ? { AILY_DEV_RENDERER_URL: renderer.origin } : {}), HOME: home, USERPROFILE: home,
      PI_CODING_AGENT_DIR: agentProfile, TEMP: agentTemp, TMP: agentTemp, npm_config_offline: 'true', npm_config_audit: 'false' } })
  hostPid = await app.evaluate(() => process.pid); evidence.hostPid = hostPid
  evidence.host = await app.evaluate(({ app }) => ({ version: app.getVersion(), appPath: app.getAppPath(), packaged: app.isPackaged }))
  if (values['executable-path']) { assert.equal(evidence.host.packaged, true); assert.match(evidence.host.appPath, /app\.asar$/i) }
  await checkpoint()
  await app.context().route('**/*', async route => {
    const request = route.request(), url = new URL(request.url())
    if (!['http:', 'https:'].includes(url.protocol) || ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return route.continue()
    if (url.origin !== api.origin || !url.pathname.startsWith('/api/')) return route.abort('blockedbyclient')
    const clean = { ...request.headers() }; delete clean.host; delete clean.connection; delete clean['content-length']
    try {
      const response = await fetch(proxy.origin + url.pathname + url.search, { method: request.method(), headers: clean,
        ...(['GET', 'HEAD'].includes(request.method()) ? {} : { body: request.postDataBuffer() }), signal: AbortSignal.timeout(15000) })
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) })
    } catch { await route.abort('connectionfailed') }
  })
  const deadline = Date.now() + 60000
  while (!page && Date.now() < deadline) {
    for (const candidate of app.windows()) {
      if (renderer ? candidate.url().startsWith(renderer.origin) : await candidate.locator('app-main-window').count() > 0) {
        page = candidate; break
      }
    }
    if (!page) await wait(100)
  }
  evidence.host.windowUrls = app.windows().map(candidate => {
    try { const url = new URL(candidate.url()); return url.origin + url.pathname + url.hash.split('?')[0] }
    catch { return 'unavailable' }
  })
  await checkpoint()
  assert.ok(page)
  page.on('dialog', dialog => dialog.dismiss())
  if (renderer) await page.goto(renderer.origin, { waitUntil: 'domcontentloaded' })
  await page.locator('app-main-window').waitFor({ timeout: 60000 })
  await page.evaluate(() => {
    const dismiss = () => document.querySelector('app-onboarding .btn-skip')?.click()
    new MutationObserver(dismiss).observe(document.documentElement, { childList: true, subtree: true }); dismiss()
  })
  await page.waitForFunction(() => window.ng?.getComponent(document.querySelector('app-header'))?.projectService)
  const allRequestIds = new Set()
  for (const scenario of cases) {
    const fixture = projects.get(scenario), record = { scenario, project: fixture.project, tools: [],
      functionalPassed: false, performanceEligible: false, expectedInjectedFault: null, unexpectedTransportFailures: [],
      transportWindow: { startRequestIndex: proxy.snapshot().requests.length, startedAt: Date.now() } }
    activeCase = record
    evidence.cases.push(record)
    const baseline = await openProject(fixture.project, scenario)
    record.sourceBefore = await buildLogSourceHashes(fixture.project, sha)
    if (values['fixture-preflight-only']) {
      assert.equal(scenario, 'field-edit')
      singleFieldExpectedDocument(JSON.parse(baseline), fixture.blockId, 'VALUE', 100, 101)
      record.ok = true; record.fixturePreflightOnly = true
      await finishCase(record, false)
      await phase('verified-unpaid-field-fixture')
      continue
    }
    if (scenario === 'field-edit') {
      const expected = singleFieldExpectedDocument(JSON.parse(baseline), fixture.blockId, 'VALUE', 100, 101)
      const nativeBefore = JSON.parse(await page.evaluate(() => window.ng.getComponent(document.querySelector('app-blockly-editor'))
        .blocklyService.captureRecoverySnapshot().documentText))
      const expectedCompleteDocument = singleFieldExpectedDocument(nativeBefore, fixture.blockId, 'VALUE', 100, 101)
      record.expectedCompleteDocument = expectedCompleteDocument
      await phase('129-composer-' + scenario)
      record.submittedAt = Date.now()
      await submit(`请直接修改当前项目 ${fixture.project}：把唯一 build log probe 积木的 VALUE 数值从100改为101，并应用到当前工作区。只改这一个字段，完整保留所有其他程序、块ID、连接、注释和坐标。读取当前ABS，使用正常edit修改后调用abs_apply即可；不编译、不整理、不新建或打开工程、不调用shell、不要求用户操作。完成后简短报告。`)
      const snapshot = await settle({ project: fixture.project, record, expectedUserMessages: 1 })
      assert.equal(record.final.stopReason, 'stop')
      const calls = callsOf(snapshot)
      assert.ok(calls.some(call => call.actualName === 'abs_apply'), 'The real model must publish its edit')
      for (const name of ['project_build', 'project_fork', 'project_recover', 'project_recovery', 'project_open', 'app_open', 'app_reload', 'bash', 'powershell', 'code_run'])
        assert.equal(calls.some(call => call.actualName === name), false, `No unrelated action: ${name}`)
      const actual = await page.evaluate(() => window.Blockly.serialization.workspaces.save(window.Blockly.getMainWorkspace()))
      assert.deepEqual(actual, expected, 'Only the requested existing field may change; the complete program must survive')
      const nativeAfter = JSON.parse(await page.evaluate(() => window.ng.getComponent(document.querySelector('app-blockly-editor'))
        .blocklyService.captureRecoverySnapshot().documentText))
      assert.deepEqual(nativeAfter, expectedCompleteDocument, 'The entire native document must retain every unedited page and shared model')
      const persisted = await Promise.all(['project.abi', 'project.abs', 'project.abs.map.json'].map(file => fs.readFile(path.join(fixture.project, file))))
      assert.deepEqual(JSON.parse(persisted[0].toString()), expectedCompleteDocument, 'The full requested document must actually be saved')
      const applyCall = calls.filter(call => call.actualName === 'abs_apply').at(-1)
      const applyMessage = snapshot.messages.find(message => message.role === 'toolResult' && message.toolCallId === applyCall.id)
      const applied = payloadOf(applyMessage), binding = applied?.receipt?.output?.binding
      assert.notEqual(applyMessage?.isError, true)
      assert.equal(applied?.publication?.status, 'COMMITTED')
      assert.equal(applied.requiresReload, false)
      for (const key of ['abiSaved', 'absMirrored', 'mapPublished']) assert.equal(applied.publication[key], true)
      assert.equal(applied.receipt?.version, 2); assert.equal(applied.receipt.validation?.ok, true)
      assert.equal(applied.receipt.validation?.scope, 'complete-generation')
      assert.equal(applied.applyVerification?.ok, true); assert.equal(applied.absPersistence?.verified, true)
      assert.equal(applied.publication.generation, binding?.generation)
      assert.ok(same(binding?.scope?.projectKey ?? '', fixture.project))
      assert.deepEqual(persisted.map(bytes => 'sha256:' + sha(bytes)), [binding.abiHash, binding.absHash, binding.mapHash])
      assert.equal(persisted[1].length, applied.receipt.output.absBytes)
      const publicMap = JSON.parse(persisted[2].toString())
      assert.equal(publicMap.generation, binding.generation); assert.deepEqual(publicMap.scope, binding.scope)
      assert.equal(publicMap.baseAbsHash, binding.absHash)
      record.absApplication = { toolCallId: applyCall.id, result: applied,
        persisted: { abiHash: binding.abiHash, absHash: binding.absHash, mapHash: binding.mapHash, absBytes: persisted[1].length } }
      assert.equal(record.comparison.modelEvidenceValid, true, 'Actual routed model must match the fixed catalog preset')
      record.programIntegrity = { completeExpectedDocument: true, beforeSha256: sha(baseline),
        expectedSha256: sha(JSON.stringify(expected)), actualSha256: sha(JSON.stringify(actual)), changedField: 'VALUE', before: 100, after: 101 }
      record.ok = true
      await finishCase(record)
      await page.screenshot({ path: path.join(values.output, scenario + '.png'), fullPage: true })
      await fs.writeFile(path.join(values.output, scenario + '.json'), JSON.stringify(record, null, 2))
      await phase('verified-' + scenario)
      continue
    }
    if (scenario === 'observation') {
      await phase('real-host-build-observation-disconnect')
      const { runBuildLogObservation } = await import('./fixtures/build-log-observation.mjs')
      record.observation = await runBuildLogObservation({ app, page, loaded, project: fixture.project, suite, home, appData,
        installedRoot: values['installed-root'], output: values.output, hostPid })
      record.ok = true
      await finishCase(record)
      await fs.writeFile(path.join(values.output, scenario + '.json'), JSON.stringify(record, null, 2))
      await phase('verified-' + scenario)
      continue
    }
    if (scenario === 'reconnect') proxy.armAfterBuildResult()
    await phase('129-composer-' + scenario)
    const prompt = `这是隔离工程的编译日志验收，源码和依赖已准备并保存，路径 ${fixture.project}。只执行以下动作：必要时tool_load加载project_build，然后实际调用一次project_build(project="${fixture.project}")。编译后必须使用普通read，path严格取该返回的resultFile，offset和limit严格取其readRange。读取完成简短报告buildReceipt.requestId、编译状态、logStatus及读取到的日志尾部。${scenario === 'failure' ? '工程故意含#error，编译失败正是预期，读取其失败日志即可。' : ''}${scenario === 'cancel' ? '我将在编译通知里点击停止来取消真实编译。收到取消回执后仍实际read其日志；绝不重新编译。' : ''}${scenario === 'chat-stop' ? '我会在编译过程中点击Chat停止，停止的是AI观察，不要擅自恢复观察或重启编译。' : ''}绝对不要修改任何文件/积木、修复故意错误、扫描项目、重复新建编译、清缓存、烧录或调用shell。遇到断线继续同一原操作；若返回pendingBuild，仅按其精确arguments观察原请求，不要新开编译。请直接执行，不询问。`
    const stopWatcher = ['cancel', 'chat-stop'].includes(scenario)
      ? watchUserBuildStop(fixture.project, record, scenario === 'cancel' ? 'compile-notice' : 'chat') : undefined
    let snapshot
    try {
      record.submittedAt = Date.now()
      await submit(prompt)
      snapshot = await settle({ project: fixture.project, record, expectedUserMessages: 1 })
    } finally { await stopWatcher?.finish() }
    if (scenario === 'chat-stop') {
      assert.ok(record.stop, 'The real compiler must still run when Chat Stop is clicked')
      const originalBuild = callsOf(snapshot).find(call => call.actualName === 'project_build' && !call.actualArguments?.build_request_id)
      assert.ok(originalBuild)
      const originalResult = snapshot.messages.find(message => message.role === 'toolResult' && message.toolCallId === originalBuild.id)
      const stoppedObservation = payloadOf(originalResult)
      assert.equal(stoppedObservation?.code, 'BUILD_OBSERVATION_CANCELLED')
      assert.equal(stoppedObservation.buildOutcome, 'unknown')
      assert.equal(stoppedObservation.observation?.compilationCancelled, false)
      assert.equal(stoppedObservation.buildReceipt?.requestId, record.runningBuild.requestId)
      assert.equal(stoppedObservation.targetPid, hostPid)
      const resume = stoppedObservation.pendingBuild?.arguments
      assert.equal(resume?.build_request_id, record.runningBuild.requestId)
      assert.equal(resume.build_target_pid, hostPid); assert.ok(same(resume.project, fixture.project))
      assert.deepEqual(Object.keys(resume).sort(), ['build_request_id', 'build_target_pid', 'project'])
      // Pi may serialize this cooperative AbortError as error rather than
      // aborted. Accept only this exact producer form together with the real
      // user stop and request-bound cancelled-observation result above.
      assert.ok(record.final.stopReason === 'aborted'
        || record.final.stopReason === 'error' && record.final.errorMessage === 'This operation was aborted')
      record.stoppedAssistant = { ...record.final }
      record.stoppedObservation = stoppedObservation
      const idleDeadline = Date.now() + 30000
      let state
      do { state = await hostState(); if (!state.hasRunning && !state.aiNoticeCount && !state.writing && !state.waitWriting && !state.busy) break; await wait(100) } while (Date.now() < idleDeadline)
      assert.equal(state.aiNoticeCount, 0, 'AI正在操作 must disappear after the real Chat stop')
      assert.equal(state.hasRunning, false); assert.equal(state.writing, false); assert.equal(state.waitWriting, false); assert.equal(state.busy, false)
      assert.equal(state.blocked, false); assert.equal(state.recoveryRequired, false)
      record.afterChatStop = state
      await phase('129-observe-original-request-after-chat-stop')
      await submit(`上一轮用户停止了AI观察。本轮只观察那次原请求：project_build(project="${fixture.project}",build_request_id="${record.runningBuild.requestId}",build_target_pid=${hostPid})，必要时先加载该工具。停止观察不代表编译已取消，必须按真实宿主终态报告。绝不启动新编译，不传clear_cache或preprocess_only。收到终态后实际普通read其resultFile，并严格使用返回readRange的offset和limit，简短报告requestId、真实编译状态及logStatus。不要修复、修改文件、重启编译、询问或执行其他操作。`)
      snapshot = await settle({ project: fixture.project, record, expectedUserMessages: 2 })
    }
    assert.equal(record.final.stopReason, 'stop', 'The actual original or read-only observation turn must settle normally')
    const requestId = await assertLogRead(snapshot, record, fixture)
    const noticeDeadline = Date.now() + 15000
    let settledHost
    do {
      settledHost = await hostState()
      if (!settledHost.hasRunning && !settledHost.aiNoticeCount && !settledHost.writing && !settledHost.waitWriting && !settledHost.busy) break
      await wait(100)
    } while (Date.now() < noticeDeadline)
    assert.equal(settledHost.aiNoticeCount, 0, 'Settled build and read must release the AI正在操作 notice')
    assert.equal(settledHost.hasRunning, false)
    record.settledHost = settledHost
    assert.equal(allRequestIds.has(requestId), false, 'Independent compilations cannot share a request ID'); allRequestIds.add(requestId)
    assert.equal(await page.evaluate(() => JSON.stringify(window.Blockly.serialization.workspaces.save(window.Blockly.getMainWorkspace()))), baseline,
      'The model must leave the source canvas unchanged')
    if (scenario === 'reconnect') {
      const network = proxy.snapshot()
      assert.equal(network.faults.length, 1); assert.equal(network.capturedBuildRequestId, requestId)
      const fault = network.faults[0], interaction = fault.path.match(/\/interactions\/([^/]+)\/steps$/)[1]
      const observations = network.requests.filter(item => item.at >= fault.at && item.method === 'GET'
        && item.path.startsWith(`/api/v3/interactions/${interaction}/operations/${fault.step}/`))
      assert.ok(observations.some(item => item.path.endsWith('/state')), 'Reconnect must observe the original real129 operation state')
      assert.ok(observations.some(item => item.path.endsWith('/events')), 'Reconnect must resume the original real129 operation stream')
      record.reconnect = { fault, sameRequestId: requestId, canonicalStateObserved: true, originalOperationEventsResumed: true,
        buildStarts: 1, compilerTransportFaultInjected: false }
    }
    if (expectedEffectiveModel) assert.equal(record.comparison.modelEvidenceValid, true, 'Actual routed model must match the fixed catalog preset')
    record.ok = true
    await finishCase(record)
    await page.screenshot({ path: path.join(values.output, scenario + '.png'), fullPage: true })
    await fs.writeFile(path.join(values.output, scenario + '.json'), JSON.stringify(record, null, 2))
    await phase('verified-' + scenario)
  }
  assert.deepEqual(proxy.snapshot().failures, [])
  evidence.ok = true
  await phase('complete')
} catch (error) {
  evidence.error = safeError(error)
  if (activeCase && !activeCase.functionalPassed) {
    activeCase.error = safeError(error)
    await finishCase(activeCase, false)
  }
  console.error(JSON.stringify(evidence.error))
  if (page) await page.screenshot({ path: path.join(values.output, 'failure.png'), fullPage: true }).catch(() => {})
  process.exitCode = 1
} finally {
  const finish = async (name, work) => { try { await work() } catch (error) { evidence.cleanupFailures.push({ name, ...safeError(error) }); process.exitCode = 1 } }
  // Only this script's isolated process can be closed. Never stop the daily app.
  if (app) await finish('close-owned-isolated-host', () => app.evaluate(({ app }, owner) => {
    if (process.pid !== owner.hostPid || process.env.AILY_APPDATA_PATH !== owner.appData) throw Error('Refuse unrelated host shutdown')
    app.exit(0)
  }, { hostPid, appData }))
  await finish('close-owned-renderer', async () => renderer?.close())
  await finish('close-owned-network-proxy', async () => proxy?.close())
  for (const [file, before] of protectedFiles) await finish('protected-profile-unchanged', async () => {
    const after = await fs.readFile(file).then(sha).catch(error => { if (error.code === 'ENOENT') return null; throw error })
    assert.equal(after, before, 'The explicit and daily profiles/catalogs must remain unchanged')
  })
  if (artifact) await finish('immutable-installed-chat', async () => assert.deepEqual(await verifyPortableBuild(values['installed-root']), artifact))
  if (evidence.cleanupFailures.length) evidence.ok = false
  await checkpoint()
  await fs.writeFile(path.join(values.output, 'result.json'), JSON.stringify(evidence, null, 2))
  console.log('RESULT=' + path.join(values.output, 'result.json'))
}
