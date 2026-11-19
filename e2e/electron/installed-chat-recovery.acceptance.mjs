import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { _electron } from '@playwright/test'
import { serveRendererBuild } from '../fixtures/build-renderer-server.mjs'
import { createAbsTerminalExpiryBridge } from '../fixtures/abs-terminal-expiry-bridge.mjs'
import { createAbsStepSubmissionBridge } from '../fixtures/abs-step-submission-bridge.mjs'
import { createInstalledChatAgent } from '../fixtures/installed-chat-agent.mjs'
import { createLocalChatApiRouter, prepareInstalledChatProfile, assertInstalledChatLoaded } from '../fixtures/installed-chat-ui.mjs'

const repo = fileURLToPath(new URL('../../', import.meta.url))
const root = 'C:/Users/LENOVO/AppData/Local/aily-project/dev-tests/abs-serial-analysis-20261028'
const daily = 'C:/Users/LENOVO/AppData/Local/aily-project/npm-global/app'
const project = path.resolve(process.env.AILY_INSTALLED_PROJECT ?? '')
const output = path.resolve(process.env.AILY_INSTALLED_OUTPUT ?? '')
const mode = process.env.AILY_INSTALLED_MODE ?? 'expired'
const embeddedPrompt = process.env.AILY_INSTALLED_UI_PROMPT === '1'
const build = path.resolve(process.env.AILY_INSTALLED_HOST_BUILD ?? path.join(repo, 'tests/test-results/view-conflict-resolution-20261029/host-final/browser'))
const inputHash = process.env.AILY_INSTALLED_INPUT_HASH ?? '9a9c0b2877e6bcffe53b36d909b644d3d312c6e533d797f87c577ee87802b230'
const outputHash = process.env.AILY_INSTALLED_OUTPUT_HASH ?? '4d72168a4d470cc4a07f7c3f79d7e068b1304f065625b1e5aa70c6a5d279c7e9'
assert.match(inputHash, /^[a-f0-9]{64}$/, 'Expected portable input SHA-256')
assert.match(outputHash, /^[a-f0-9]{64}$/, 'Expected portable output SHA-256')
const inside = (parent, file) => { const relative = path.relative(parent, file)
  return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) }
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
const sha = value => createHash('sha256').update(value).digest('hex')
const textOf = message => (message?.content ?? []).filter(item => item.type === 'text').map(item => item.text).join('\n')
const parsedResult = message => {
  if (message?.structuredContent) return message.structuredContent
  if (message?.details?.result) return message.details.result
  try { return JSON.parse(textOf(message)) } catch { return undefined }
}
const programOf = source => {
  const marker = '\n# @project-state:'
  assert.equal(source.split(marker).length, 2, 'Exactly one host-owned state footer')
  return source.slice(0, source.indexOf(marker))
}
assert.ok(['disconnect', 'expired', 'incomplete'].includes(mode))
assert.ok(inside(root, project) && /[\\/]serial-agent-identity-[^\\/]+[\\/]project$/.test(project))
assert.ok(inside(path.join(repo, 'e2e/test-results/installed-chat-recovery-20261030'), output))
assert.ok(same(project, await fs.realpath(project)))
await fs.mkdir(output, { recursive: true })
const require = createRequire(import.meta.url)
const manager = require(path.join(repo, 'electron/subapp-manager.js'))
const dailyCatalogPath = path.join(daily, 'subapp-index.json')
const dailyActivePath = path.join(daily, 'store/subapp-aily-chat/active.json')
const dailyCatalog = await fs.readFile(dailyCatalogPath), dailyActive = await fs.readFile(dailyActivePath)
const installed = manager.readInstalledState(daily, JSON.parse(dailyCatalog)['aily-chat'])
assert.equal(installed.installedVersion, '0.1.48-next')
assert.equal(installed.installed, true)
assert.equal(installed.localNext, true)
const installedRoot = await fs.realpath(installed.packagePath)
const { verifyPortableBuild } = await import(pathToFileURL('D:/codes/aily-lex-pro/packages/aily-chat/server/portable-integrity.ts'))
const installedEvidence = await verifyPortableBuild(installedRoot)
assert.equal(installedEvidence.inputHash, inputHash)
assert.equal(installedEvidence.outputHash, outputHash)
const suite = await fs.mkdtemp(path.join(root, 'installed-chat-'))
const appData = path.join(suite, 'appdata'), home = path.join(suite, 'home'), agentProfile = path.join(suite, 'agent-profile')
const agentTemp = path.join(suite, 'agent-temp')
await fs.mkdir(home)
await fs.mkdir(agentTemp)
const seed = path.join(root, 'archive-user-project/esp32-c3-HANTAI')
async function sourceHashes() {
  const values = {}
  const visit = async (directory, prefix = '') => {
    for (const item of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? `${prefix}/${item.name}` : item.name, file = path.join(directory, item.name)
      if (item.isSymbolicLink()) values[relative] = 'link:' + sha(await fs.readlink(file))
      else if (item.isDirectory()) await visit(file, relative)
      else if (item.isFile()) values[relative] = sha(await fs.readFile(file))
    }
  }
  await visit(seed)
  return values
}
const sourceBefore = await sourceHashes()
const sourceDocument = JSON.parse(await fs.readFile(path.join(seed, 'project.abi'), 'utf8'))
const blockIndex = state => {
  const result = new Map()
  const visit = node => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) return node.forEach(visit)
    if (typeof node.type === 'string' && typeof node.id === 'string') {
      assert.ok(!result.has(node.id))
      const { inputs, next, x, y, ...block } = node
      result.set(node.id, block)
    }
    for (const [key, value] of Object.entries(node)) if (!['fields', 'extraState', 'variables'].includes(key)) visit(value)
  }
  visit(state)
  return result
}
const documentBlocks = document => blockIndex([document.pages.map(page => page.content), document.sharedModel.procedureBlocks])
const evidence = { ok: false, mode, branch: 'i3w-subapp', installedRoot, installedEvidence, project, suite,
  realInstalledHarness: true, privateAgentDistImported: false, llmInvoked: false, localFaultInjection: true,
  agentTransport: embeddedPrompt ? 'embedded-composer' : 'installed-public-harness',
  sourceSeed: { files: Object.keys(sourceBefore).length, sha256: sha(JSON.stringify(sourceBefore)) }, tools: [] }
const phase = value => { console.log(`PHASE=${value}`); evidence.phase = value }
let app, page, renderer, bridge, faultProxy, router, agent, hostPid, baseline, baselineDocument, candidate, exportResult, beforeFault, latestBuild
const beforeMarker = 'installed_before_' + randomUUID().slice(0, 8), afterMarker = beforeMarker.replace('before', 'after')
const absPath = path.join(project, 'project.abs'), inputArtifact = path.join(output, 'candidate-after-agent-edit.abs')
const observeNativeCandidate = async receipt => {
  assert.equal(receipt.hash, 'sha256:' + sha(candidate))
  assert.equal(receipt.bytes, Buffer.byteLength(candidate))
  const filename = `abs-recovery-candidate-${receipt.hash.slice(7, 31)}.txt`, matches = []
  for (const entry of await fs.readdir(agentTemp, { withFileTypes: true })) {
    if (!/^aily-tool-output-[A-Za-z0-9_-]+$/.test(entry.name)) continue
    assert.ok(entry.isDirectory() && !entry.isSymbolicLink())
    const file = path.join(agentTemp, entry.name, filename)
    try {
      const stat = await fs.lstat(file)
      assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1)
      assert.equal(stat.size, receipt.bytes)
      const bytes = await fs.readFile(file)
      assert.equal('sha256:' + sha(bytes), receipt.hash)
      matches.push({ file, bytes })
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  assert.equal(matches.length, 1, 'One exact normal-registrar candidate artifact in this fresh Agent temp')
  await fs.writeFile(inputArtifact, matches[0].bytes, { flag: 'wx' })
  evidence.inputCandidate = { ...receipt, source: 'normal-abs-apply-preserved-artifact', artifact: matches[0].file }
}
const compileDeadline = Date.now() + 12 * 60 * 1000
const deferred = (id, name, args = {}) => agent.deferredCall(id, name, { project, ...args })
const plan = []
const canvas = () => page.evaluate(() => JSON.parse(JSON.stringify(window.Blockly.serialization.workspaces.save(window.Blockly.getMainWorkspace()))))
const assertPreserved = async extra => {
  const current = await canvas(), old = blockIndex(baseline), now = blockIndex(current)
  for (const [id, block] of old) assert.deepEqual(now.get(id), block, 'Retain every original native block attribute')
  assert.deepEqual(current.variables, baseline.variables)
  assert.equal(now.size, old.size + extra)
  const document = JSON.parse(await fs.readFile(path.join(project, 'project.abi'), 'utf8'))
  assert.deepEqual(document.sharedModel.variables, baselineDocument.sharedModel.variables)
  assert.equal(document.activePageId, baselineDocument.activePageId)
  assert.deepEqual(document.openedPageIds, baselineDocument.openedPageIds)
  assert.deepEqual(document.pages.map(({ id, title }) => ({ id, title })), baselineDocument.pages.map(({ id, title }) => ({ id, title })))
  const previous = documentBlocks(baselineDocument), next = documentBlocks(document)
  for (const [id, block] of previous) assert.deepEqual(next.get(id), block)
  assert.equal(next.size, previous.size + extra)
  return { blocks: next.size, models: document.sharedModel.variables.length }
}
const ready = () => page.waitForFunction(target => {
  const element = document.querySelector('blockly-main')
  const component = element && window.ng?.getComponent(element), service = component?.projectService
  return service?.currentProjectPath?.replaceAll('\\', '/') === target.replaceAll('\\', '/')
    && service.getBlocklyProjectLoadStatus(target)?.ready === true
}, project, { timeout: 60000 })
const installSettled = () => page.waitForFunction(() => {
  const element = document.querySelector('app-blockly-editor')
  return element && window.ng?.getComponent(element)?._builderService?.isInstallInProgress() === false
}, undefined, { timeout: 60000 })
try {
  const nextTool = async () => {
    await agent.flush()
    const next = plan.shift()
    if (next) return next()
    assert.equal(latestBuild?.ok, true)
    assert.equal(latestBuild.buildReceipt?.state, 'completed')
    assert.equal(beforeFault, undefined)
    beforeFault = { canvas: await canvas(), abi: await fs.readFile(path.join(project, 'project.abi')), abs: await fs.readFile(absPath) }
    evidence.beforeFault = { canvas: sha(JSON.stringify(beforeFault.canvas)), abi: sha(beforeFault.abi), abs: sha(beforeFault.abs) }
    phase('fault-and-recovery')
    return undefined
  }
  const interactionId = 'itx_installed_' + randomUUID().replaceAll('-', '')
  bridge = mode === 'disconnect'
    ? await createAbsStepSubmissionBridge({ interactionId, failAfterToolId: 'agent-edit-once', nextTool })
    : await createAbsTerminalExpiryBridge({ interactionId, mode: mode === 'incomplete' ? 'incomplete' : 'available', nextTool })
  if (embeddedPrompt) {
    assert.equal(mode, 'expired', 'The embedded case combines accepted-step disconnect and expired final output')
    const { createCombinedOperationFaultProxy } = await import('../fixtures/combined-operation-fault-proxy.mjs')
    faultProxy = await createCombinedOperationFaultProxy({ upstreamOrigin: bridge.origin, failAfterToolId: 'agent-edit-once' })
  }
  router = await createLocalChatApiRouter({ operationOrigin: faultProxy?.origin ?? bridge.origin, installedRoot })
  const profile = await prepareInstalledChatProfile({ appData, installedRoot, apiBase: router.origin,
    baseConfigPath: path.join(root, 'appdata/config.json'), token: router.token })
  renderer = await serveRendererBuild(build)
  const { ELECTRON_RUN_AS_NODE, AILY_CHILD_PATH, NODE_PATH, AILY_PORTABLE_ROOT, ...parentEnv } = process.env
  phase('host-start')
  app = await _electron.launch({ args: ['.', '--serve', `--user-data-dir=${path.join(suite, 'electron-profile')}`], cwd: repo, timeout: 60000,
    env: { ...parentEnv, ...profile.env, AILY_E2E: '1', AILY_DEV_RENDERER_URL: renderer.origin, HOME: home, USERPROFILE: home,
      TEMP: agentTemp, TMP: agentTemp,
      npm_config_offline: 'true', npm_config_audit: 'false' } })
  evidence.redirectedApiRequests = []
  await app.context().route('**/*', async route => {
    const request = route.request(), url = new URL(request.url())
    if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !['http:', 'https:'].includes(url.protocol)) return route.continue()
    if (!url.pathname.startsWith('/api/')) return route.abort('blockedbyclient')
    evidence.redirectedApiRequests.push({ method: request.method(), path: url.pathname })
    const headers = { ...request.headers() }
    delete headers.host; delete headers['content-length']; delete headers.connection
    const response = await fetch(router.origin + url.pathname + url.search, { method: request.method(), headers,
      ...(['GET', 'HEAD'].includes(request.method()) ? {} : { body: request.postDataBuffer() }), signal: AbortSignal.timeout(15000) })
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) })
  })
  hostPid = await app.evaluate(() => process.pid)
  evidence.hostPid = hostPid
  await app.firstWindow()
  const deadline = Date.now() + 60000
  while (!page && Date.now() < deadline) {
    page = app.windows().find(item => item.url().startsWith(renderer.origin))
    if (!page) await new Promise(resolve => setTimeout(resolve, 200))
  }
  assert.ok(page)
  page.on('dialog', dialog => dialog.dismiss())
  await page.goto(renderer.origin, { waitUntil: 'domcontentloaded' })
  await page.locator('app-main-window').waitFor({ timeout: 60000 })
  await page.evaluate(target => { location.hash = '#/main/blockly-editor?path=' + encodeURIComponent(target) }, project)
  await ready(); await installSettled()
  phase('installed-chat-ui')
  const loaded = await assertInstalledChatLoaded(page, { installedRoot, output, expectedApiBase: router.origin,
    expectedInputHash: inputHash, expectedOutputHash: outputHash })
  evidence.chat = loaded.evidence
  baseline = await canvas()
  baselineDocument = JSON.parse(await fs.readFile(path.join(project, 'project.abi'), 'utf8'))
  const original = documentBlocks(sourceDocument), initial = documentBlocks(baselineDocument)
  for (const [id, value] of original) assert.deepEqual(initial.get(id), value)
  assert.equal(initial.size, original.size)
  assert.deepEqual(baselineDocument.sharedModel.variables, sourceDocument.sharedModel.variables)
  evidence.baseline = { blocks: initial.size, models: baselineDocument.sharedModel.variables.length }
  Object.assign(process.env, { HOME: home, USERPROFILE: home, AILY_APPDATA_PATH: appData, AILY_AUTH_FILE: path.join(appData, '.aily'),
    PI_CODING_AGENT_DIR: agentProfile, AILY_API_SERVER: router.origin, AILY_LIBRARY_HOST_PID: String(hostPid),
    AILY_SUBAPP_INSTALL_ROOT: path.join(appData, 'npm-global/app'), TEMP: agentTemp, TMP: agentTemp,
    PI_OFFLINE: '1', npm_config_offline: 'true', npm_config_audit: 'false' })
  delete process.env.AILY_CHILD_TOOL
  delete process.env.AILY_PORTABLE_ROOT
  const createAgent = embeddedPrompt
    ? (await import('../fixtures/installed-chat-ui-agent.mjs')).createInstalledChatUiAgent
    : createInstalledChatAgent
  agent = await createAgent({ installedRoot, isolationRoot: root, project, profileRoot: agentProfile, loadedChat: loaded,
    authFile: path.join(appData, '.aily'), apiBase: router.origin, expectedInputHash: inputHash, expectedOutputHash: outputHash,
    onStage: phase, onToolResult: async event => {
      const result = parsedResult(event)
      evidence.tools.push({ id: event.toolCallId, name: event.toolName, isError: event.isError })
      await fs.appendFile(path.join(output, 'tool-results.jsonl'), JSON.stringify(event) + '\n')
      assert.equal(event.isError, false, `Actual installed tool ${event.toolName} must succeed`)
      phase('tool-' + event.toolName)
      if (event.toolCallId === 'recover-inspect' && result?.diagnostics?.repair) {
        const repair = result.diagnostics.repair
        assert.equal(repair.authority, 'workspace')
        plan.unshift(() => deferred('recover-preserve', 'project_recover', { action: 'repair', token: repair.token, authority: repair.authority }))
      }
      if (event.toolCallId === 'recover-preserve') {
        assert.equal(result.ok, true); assert.equal(result.repairVerification.candidateApplied, false)
        assert.deepEqual(await canvas(), baseline)
      }
      if (event.toolCallId === 'agent-export') {
        assert.equal(result?.ok, true)
        exportResult = result
        const anchor = result.abs.match(/^arduino_setup\(\).*$/m)?.[0]
        assert.ok(anchor)
        candidate = result.abs.replace(anchor, `${anchor}\n    serial_print(Serial, text("${beforeMarker}"))`).replace(beforeMarker, afterMarker)
        evidence.exportGeneration = result.generation
      }
      if (event.toolCallId === 'agent-edit-once') {
        assert.ok(event.details?.patch?.includes('-    serial_print(Serial, text("' + beforeMarker + '"))'))
        assert.ok(event.details?.patch?.includes('+    serial_print(Serial, text("' + afterMarker + '"))'))
        evidence.nativeEditPatchHash = sha(event.details.patch)
      }
      if (event.toolCallId === 'agent-read-edited') assert.match(textOf(event), new RegExp(afterMarker))
      if (event.toolName === 'abs_validate') {
        assert.equal(result?.ok, true)
        evidence.validateReceipt = result.receipt
        assert.equal(result.receipt.candidate.hash, 'sha256:' + sha(candidate))
        assert.equal(result.receipt.candidate.bytes, Buffer.byteLength(candidate))
      }
      if (event.toolName === 'abs_apply') {
        assert.equal(result?.ok, true); evidence.applyReceipt = result.receipt
        await observeNativeCandidate(result.receipt.candidate)
        evidence.applied = await assertPreserved(2)
      }
      if (event.toolName === 'app_reload') { assert.equal(result?.ok, true); await ready(); await installSettled(); evidence.reopened = await assertPreserved(2) }
      if (event.toolName === 'project_build') {
        latestBuild = result
        if (result?.buildOutcome === 'unknown' && result.pendingBuild?.resumable === true) {
          assert.ok(Date.now() < compileDeadline)
          const pending = result.pendingBuild
          assert.equal(pending.tool, 'project_build')
          assert.equal(pending.arguments.build_target_pid, hostPid)
          assert.ok(same(pending.arguments.project, project))
          plan.unshift(() => agent.deferredCall('observe-build-' + evidence.tools.length, pending.tool, pending.arguments))
        }
      }
    } })
  plan.push(
    () => agent.loadCall('load-scoped-tools', ['project_recover', 'abs_export', 'abs_validate', 'abs_apply', 'app_reload', 'project_build']),
    () => deferred('recover-inspect', 'project_recover', { action: 'inspect' }),
    () => deferred('agent-export', 'abs_export'),
    () => agent.nativeCall('agent-read-initial', 'read', { path: absPath, limit: 30 }),
    () => agent.nativeCall('agent-write-candidate', 'write', { path: absPath, content: candidate.replace(afterMarker, beforeMarker) }),
    () => agent.nativeCall('agent-edit-once', 'edit', { path: absPath, edits: [{ oldText: beforeMarker, newText: afterMarker }] }),
    () => agent.nativeCall('agent-read-edited', 'read', { path: absPath,
      offset: Math.max(1, candidate.slice(0, candidate.indexOf(afterMarker)).split('\n').length - 3), limit: 8 }),
    () => deferred('agent-validate', 'abs_validate', { generation: exportResult.generation, absPath }),
    () => deferred('agent-apply', 'abs_apply', { generation: exportResult.generation, absPath }),
    () => deferred('agent-reopen', 'app_reload'),
    () => deferred('agent-compile', 'project_build'))
  let promptError
  try { await agent.prompt('Preserve all existing blocks and models in this isolated project. Inspect and repair the copied scope without applying a candidate, export ABS, read it, add one serial print, edit its marker once, validate and apply, reopen and compile. Do not upload, install or access other projects.') }
  catch (error) { promptError = { name: error.name, message: error.message } }
  await agent.flush()
  const final = agent.messages().filter(message => message.role === 'assistant').at(-1)
  evidence.final = { stopReason: final?.stopReason, text: textOf(final), errorMessage: final?.errorMessage,
    responseReplayPolicy: final?.responseReplayPolicy, responseOperationTerminal: final?.responseOperationTerminal, promptError }
  if (mode === 'incomplete') {
    assert.equal(final.stopReason, 'error'); assert.match(final.errorMessage, /interaction_response_incomplete/)
    assert.ok(!textOf(final).includes('Final response recovered'))
  } else {
    assert.equal(promptError, undefined); assert.equal(final?.stopReason, 'stop')
    if (mode === 'expired') assert.equal(textOf(final), bridge.finalText)
  }
  assert.equal(final.responseReplayPolicy, 'never')
  assert.deepEqual(final.responseOperationTerminal, { status: 'completed' })
  evidence.compiled = latestBuild
  assert.equal(latestBuild?.ok, true); assert.equal(latestBuild.buildReceipt?.state, 'completed')
  const after = { canvas: await canvas(), abi: await fs.readFile(path.join(project, 'project.abi')), abs: await fs.readFile(absPath) }
  assert.deepEqual(after, beforeFault, 'Transport recovery cannot change workspace, ABI or ABS bytes')
  assert.equal(evidence.applyReceipt.candidate.hash, evidence.inputCandidate.hash)
  assert.equal(evidence.applyReceipt.candidate.bytes, evidence.inputCandidate.bytes)
  assert.equal(evidence.applyReceipt.output.binding.absHash, 'sha256:' + sha(after.abs))
  assert.equal(programOf(after.abs.toString('utf8')), programOf(candidate))
  assert.equal(sha(await fs.readFile(inputArtifact)), sha(candidate))
  assert.match(await fs.readFile(path.join(project, '.temp/sketch/sketch.ino'), 'utf8'), new RegExp(afterMarker))
  evidence.afterRecovery = await assertPreserved(2)
  evidence.transport = bridge.snapshot()
  assert.deepEqual(evidence.transport.failures, [])
  assert.equal(evidence.transport.createCount, 1)
  for (const operation of evidence.transport.operations) { assert.equal(operation.postCount, 1); assert.equal(operation.providerInvocations, 1) }
  const lost = evidence.transport.operations.find(operation => mode === 'disconnect' ? operation.headersLost : operation.turnEndLost)
  assert.ok(lost); assert.equal(lost.eventReads, 1); assert.equal(lost.stateReads, 1)
  if (mode !== 'disconnect') { assert.equal(lost.resultReads, mode === 'expired' ? 1 : 0); assert.equal(evidence.transport.interruptCount, 0) }
  if (faultProxy) {
    evidence.combinedDisconnection = faultProxy.snapshot()
    assert.deepEqual(evidence.combinedDisconnection.failures, [])
    assert.equal(evidence.combinedDisconnection.faultInjected, true)
    assert.equal(evidence.combinedDisconnection.droppedResponses, 1)
    assert.equal(evidence.combinedDisconnection.duplicatePosts, 0)
    assert.equal(evidence.combinedDisconnection.operation.stateReads, 1)
    assert.equal(evidence.combinedDisconnection.operation.eventReads, 1)
  }
  for (const name of ['write', 'edit', 'abs_validate', 'abs_apply', 'app_reload']) assert.equal(evidence.tools.filter(tool => tool.name === name).length, 1)
  assert.equal(new Set(evidence.tools.map(tool => tool.id)).size, evidence.tools.length)
  evidence.agentProof = agent.proof()
  assert.equal(evidence.agentProof.promptRuns, 1); assert.equal(evidence.agentProof.sessionUserMessages, 1)
  if (embeddedPrompt) assert.equal(evidence.agentProof.actualEmbeddedComposerPrompt, true)
  evidence.ok = true
  phase('complete')
} catch (error) {
  evidence.failure = { message: error.message, stack: error.stack }
  evidence.transport = bridge?.snapshot()
  evidence.agentProof = agent?.proof()
  evidence.metadataRouter = router?.snapshot()
  evidence.combinedDisconnection = faultProxy?.snapshot()
  process.exitCode = 1
} finally {
  await agent?.dispose().catch(error => { evidence.cleanupFailure = error.message; process.exitCode = 1 })
  if (app) await app.evaluate(({ app }, owned) => {
    if (process.pid !== owned.pid || process.env.AILY_APPDATA_PATH !== owned.appData) throw new Error('Refuse unrelated host shutdown')
    app.exit(0)
  }, { pid: hostPid, appData }).catch(error => { evidence.cleanupFailure = error.message; process.exitCode = 1 })
  await renderer?.close(); await router?.close(); await faultProxy?.close(); await bridge?.close()
  assert.deepEqual(await sourceHashes(), sourceBefore)
  assert.deepEqual(await fs.readFile(dailyCatalogPath), dailyCatalog)
  assert.deepEqual(await fs.readFile(dailyActivePath), dailyActive)
  assert.deepEqual(await verifyPortableBuild(installedRoot), installedEvidence)
  evidence.sourceSeedPreserved = true; evidence.dailySelectionAndInstalledPayloadUnchanged = true
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify({ ok: evidence.ok, mode, phase: evidence.phase, failure: evidence.failure?.message, output }))
}
