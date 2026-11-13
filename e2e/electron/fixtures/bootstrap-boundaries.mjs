import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID, createHash } from 'node:crypto'
import http from 'node:http'
import { createAbsStepSubmissionBridge } from '../../fixtures/abs-step-submission-bridge.mjs'
import { loadCandidateSdk, candidateSession, appendCandidateUser } from './r3-customer-candidate.mjs'
import { bootstrapCalls, bootstrapPayload, bootstrapText, bootstrapSessionProjectBinding, bootstrapUserStopOutcome,
  bootstrapDeferredCall } from './bootstrap-natural.mjs'
import { readBootstrapObservation } from './bootstrap-observation.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
const inside = (root, file) => { const rel = path.relative(root, file)
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel) }
const nativeDocument = page => page.evaluate(() => JSON.parse(window.ng.getComponent(
  document.querySelector('app-blockly-editor')).blocklyService.captureRecoverySnapshot().documentText))

/** Observe an exact persisted candidate without acquiring a Pi mutation owner. */
export async function readBootstrapImmutableCandidate(agentRoot, project, ref) {
  const [{ HistoryCandidateStore }, { WorkspaceHistoryStore, canonicalWorkspaceRoot, sha256 }] = await Promise.all([
    import(pathToFileURL(path.join(agentRoot, 'dist/extensions/pi-workspace-history/candidate-store.js'))),
    import(pathToFileURL(path.join(agentRoot, 'dist/extensions/pi-workspace-history/store.js'))),
  ])
  const workspaceRoot = canonicalWorkspaceRoot(project)
  const managed = path.join(workspaceRoot, '.workspace-history'), stat = await fs.lstat(managed)
  assert.equal(stat.isSymbolicLink(), false); assert.equal(stat.isDirectory(), true)
  // Store construction can initialize metadata. Supply only the immutable
  // reader's storage layout so this independent observer cannot create it.
  // Match the actual Store constructor's identity and reuse its object-path
  // implementation without constructing a metadata-initializing Store.
  const store = { workspaceRoot, workspaceId: sha256(workspaceRoot), workspaceDir: await fs.realpath(managed) }
  store.objectPath = WorkspaceHistoryStore.prototype.objectPath.bind(store)
  Object.freeze(store)
  const result = new HistoryCandidateStore(store).read(ref)
  assert.deepEqual(result.ref, ref)
  assert.equal(sha(result.source), result.record.source.hash)
  assert.equal(Buffer.byteLength(result.source), result.record.source.bytes)
  return result
}

export const boundaryHostState = page => page.evaluate(() => {
  const component = selector => { const element = document.querySelector(selector)
    return element ? window.ng?.getComponent(element) : undefined }
  const project = component('app-header')?.projectService
  const editor = component('app-blockly-editor'), service = editor?.blocklyService
  const host = component('app-child-tool-host')
  return { project: project?.currentProjectPath ?? null, busy: service?.isWorkspaceEditInProgress() ?? false,
    lifecycleOwners: project?.projectLifecycle?.owners?.size ?? null,
    blocked: service?.isWorkspaceEditBlocked() ?? false, recoveryRequired: service?.isWorkspaceRecoveryRequired() ?? false,
    hasRunning: host?.aiOperationProtocol?.hasRunning ?? false,
    aiNoticeCount: [...document.querySelectorAll('app-notification .notification-box')].filter(node =>
      /AI正在操作|正在停止 AI|正在同步 AI 状态/.test(node.textContent)).length,
    pausedInHost: window.__bootstrapLifecyclePause?.entered === true,
    pauseReleased: window.__bootstrapLifecyclePause?.released === true,
    pauseAdmissionCount: window.__bootstrapLifecyclePause?.admissions ?? null }
})

export function assertBootstrapReadbackAbiScope(status, candidateStop = false) {
  if (candidateStop) {
    assert.equal(status.abiFile?.summaryScope, 'execution-view', 'Candidate-stop status must identify its execution-view ABI scope')
    assert.equal(status.disk?.abiFile?.summaryScope, 'persisted-project', 'Candidate-stop requires an explicit persisted-project ABI observation')
    assert.equal(status.disk.abiFile.exists, true, 'Candidate-stop persisted ABI must still exist; an absent execution-view ABI does not erase Native data')
  } else assert.equal(status.abiFile?.exists, true, 'New-project readback requires its actual inspected ABI')
  return { executionView: status.abiFile, persistedProject: status.disk?.abiFile ?? null }
}

/** A test-owned valid local library and a genuine UNO template. These fixture
 * bytes are prepared only when Root executes the acceptance; no user project,
 * counterfeit registry version or generated compiler output is copied. */
export async function prepareBootstrapBoundaryProject({ project, platformRoot }) {
  const board = path.join(platformRoot, 'node_modules/@aily-project/board-arduino_uno_r4_wifi')
  await fs.cp(path.join(board, 'template'), project, { recursive: true, errorOnExist: true, force: false })
  const manifest = JSON.parse(await fs.readFile(path.join(project, 'package.json')))
  const queue = Object.keys(manifest.dependencies), visited = new Set()
  for (const name of queue) {
    if (visited.has(name)) continue
    visited.add(name); assert.match(name, /^@aily-project\/(?:lib|board)-/)
    const source = path.join(platformRoot, 'node_modules', name), destination = path.join(project, 'node_modules', name)
    const pkg = JSON.parse(await fs.readFile(path.join(source, 'package.json')))
    assert.equal(pkg.version, manifest.dependencies[name], 'Use the exact actual template package version')
    await fs.cp(source, destination, { recursive: true, dereference: true,
      filter: file => !path.relative(source, file).split(path.sep).includes('node_modules') })
    for (const [dependency, version] of Object.entries(pkg.dependencies ?? {})) {
      if (!dependency.startsWith('@aily-project/lib-')) continue
      manifest.dependencies[dependency] ??= version; queue.push(dependency)
    }
  }
  const name = '@aily-project/lib-e2e-bootstrap-boundary', local = path.join(project, 'local-libraries', name)
  const contents = {
    'package.json': JSON.stringify({ name, version: '0.0.1', nickname: 'Bootstrap boundary fixture', dependencies: {} }),
    'block.json': JSON.stringify([{ type: 'e2e_bootstrap_value', message0: 'bootstrap value %1',
      args0: [{ type: 'field_number', name: 'VALUE', value: 100 }], previousStatement: null, nextStatement: null, colour: 210 }]),
    'generator.js': 'Arduino.forBlock.e2e_bootstrap_value = function(block) { return "// bootstrap value " + block.getFieldValue("VALUE") + "\\n"; };\n',
    'toolbox.json': JSON.stringify({ kind: 'category', name: 'Bootstrap fixture', contents: [{ kind: 'block', type: 'e2e_bootstrap_value' }] }),
    'readme_ai.md': 'Test-owned local fixture; its numeric field is used to verify retained candidate edits.\n'
  }
  await fs.mkdir(local, { recursive: true })
  for (const [file, text] of Object.entries(contents)) await fs.writeFile(path.join(local, file), text, { flag: 'wx' })
  await fs.cp(local, path.join(project, 'node_modules', name), { recursive: true, errorOnExist: true, force: false })
  manifest.dependencies[name] = 'file:local-libraries/' + name; manifest.name = 'bootstrap-boundary-project'; manifest.devmode = 'arduino'
  await fs.writeFile(path.join(project, 'package.json'), JSON.stringify(manifest, null, 2))
  const file = path.join(project, 'project.abi'), abi = JSON.parse(await fs.readFile(file))
  const global = abi.blocks.blocks.find(item => item.type === 'arduino_global'); assert.ok(global)
  global.inputs = { ...global.inputs, ARDUINO_GLOBAL: { block: { type: 'e2e_bootstrap_value', id: 'bootstrap_value', fields: { VALUE: 100 } } } }
  await fs.writeFile(file, JSON.stringify(abi, null, 2))
  return { project, name, blockId: 'bootstrap_value', abiSha256: sha(await fs.readFile(file)), genuineTemplate: true, syntheticLocalProbe: true }
}

async function lifecycleRuntime({ agentRoot, workspace, suite, audit, globalSession = false }) {
  const sdk = await loadCandidateSdk(agentRoot, audit), signal = new AbortController().signal
  const manager = sdk.SessionManager.create(workspace, path.join(suite, 'boundary-sdk-sessions-' + randomUUID()))
  appendCandidateUser(manager, 'Controlled lifecycle boundary; no provider or compiler is used by this actor.')
  const run = candidateSession(sdk, workspace, manager, signal); await run.begin()
  let workspaceRoot = workspace
  if (globalSession) {
    const { WorkspaceBinding } = await import(pathToFileURL(path.join(agentRoot, 'dist/workspace-binding.js')))
    const permissions = new sdk.permission.PermissionModeRuntime({ permissionMode: () => 'default' })
    permissions.restore(run.context)
    workspaceRoot = new WorkspaceBinding(workspace, workspace, run.history, permissions, workspace)
    assert.equal(workspaceRoot.lifecycleSourceProject, null, 'Use real global-session metadata; an empty execution directory is not a Native project')
  }
  const registry = sdk.registry.createBlocklyToolRegistry(workspaceRoot, run.history, 'blockly')
  const context = sdk.registrars.createRegistrarContext(registry, workspaceRoot, run.history, new sdk.workflow.AbsWorkflowGuard(), 'blockly')
  for (const [name, method] of [['project-open', 'registerProjectOpen'], ['project-create', 'registerProjectCreate']]) {
    const module = await import(pathToFileURL(path.join(agentRoot, 'dist/blockly/tools/registrars/project', name + '.js')))
    module[method](context)
  }
  return { sdk, run, signal, async call(name, args) {
    const tool = registry.definitions().find(item => item.name === name); assert.ok(tool)
    const raw = await tool.execute(args, signal, { toolCallId: randomUUID(), sessionId: manager.getSessionId() })
    const value = raw.structuredContent ?? bootstrapPayload(raw)
    audit.push({ source: 'real-sdk-registrar', name, args, isError: raw.isError === true, result: value })
    assert.notEqual(raw.isError, true, JSON.stringify(value)); assert.equal(value?.ok, true, JSON.stringify(value))
    return value
  } }
}

export async function runBootstrapDirectBoundary({ scenario, page, agentRoot, suite, project, projectParent, checkpoint }) {
  assert.equal(scenario, 'first-open')
  const before = await boundaryHostState(page); assert.ok(!before.project)
  const audit = [], workspace = path.join(suite, 'empty-sdk-workspace'); await fs.mkdir(workspace)
  const runtime = await lifecycleRuntime({ agentRoot, workspace, suite, audit, globalSession: true })
  const evidence = { scenario, actualHost: true, actualSdkRegistrars: true, providerInvoked: false, compilerInvoked: false,
    preOpenedProject: false, before, audit, userSwitchOrReopenRequired: false }
  try {
    evidence.open = await runtime.call('project_open', { project })
    await page.waitForFunction(target => { const service = window.ng.getComponent(document.querySelector('app-header')).projectService
      return service.currentProjectPath === target && service.getBlocklyProjectLoadStatus(target)?.ready }, project, { timeout: 120000 })
    const native = await nativeDocument(page)
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(project, 'project.abi'))), native)
    evidence.nativeDocumentSha256 = sha(JSON.stringify(native)); await checkpoint(evidence)
    evidence.after = await boundaryHostState(page)
    assert.equal(evidence.after.project, project); assert.equal(evidence.after.lifecycleOwners, 0)
    evidence.ok = true; await checkpoint(evidence)
    return evidence
  } finally { await runtime.run.settle(); await runtime.run.history.dispose() }
}

export async function createBootstrapBoundaryProvider({ scenario, project, projectParent }) {
  assert.ok(['stop-before', 'stop-host', 'reconnect', 'candidate-switch', 'candidate-stop'].includes(scenario))
  const candidateScenario = scenario === 'candidate-switch' || scenario === 'candidate-stop'
  let release, waitingBeforeDispatch = false
  let candidateGate, releaseCandidateGate, candidateGatesReleased = false
  const gate = async phase => {
    candidateGate = { phase, pending: !candidateGatesReleased }
    if (candidateGatesReleased) return
    await new Promise(resolve => { releaseCandidateGate = resolve })
  }
  const barrier = new Promise(resolve => { release = resolve })
  const bridge = await createAbsStepSubmissionBridge({ interactionId: 'bootstrap_' + randomUUID().replaceAll('-', ''),
    failAfterToolId: scenario === 'reconnect' ? 'bootstrap-open-once' : undefined,
    allowInterrupt: scenario.startsWith('stop-') || scenario === 'candidate-stop', finalText: 'Controlled lifecycle boundary completed.',
    async nextTool({ step, previousResult }) {
      if (candidateScenario) {
        if (scenario === 'candidate-stop' && step >= 6) return null
        if (step === 0) return { id: 'bootstrap-candidate-load', name: 'tool_load', arguments: { names: ['project_open', 'project_create', 'abs_apply'] } }
        if (step === 1) return bootstrapDeferredCall('bootstrap-candidate-open-A', 'project_open', { project })
        if (step === 2 || step === 6) {
          if (step === 6) await gate('returned-A')
          return { id: 'bootstrap-candidate-read-' + step, name: 'read', arguments: { path: path.join(project, 'project.abs') } }
        }
        if (step === 3) {
          const text = bootstrapText(previousResult?.result ?? previousResult)
          const oldText = text.match(/\be2e_bootstrap_value\([^()\n]*\b100\b[^()\n]*\)/)?.[0]
          assert.ok(oldText, 'Use only the actual Core read projection to plan the controlled edit')
          return { id: 'bootstrap-candidate-edit-A', name: 'edit', arguments: { path: path.join(project, 'project.abs'),
            edits: [{ oldText, newText: oldText.replace(/\b100\b/, '101') }] } }
        }
        if (step === 4) { await gate('draft-ready')
          return bootstrapDeferredCall('bootstrap-candidate-create-B', 'project_create', { name: 'bootstrap-switch-target', path: projectParent,
            boardName: '@aily-project/board-arduino_uno_r4_wifi', boardVersion: '1.5.3', developmentMode: 'blockly' }) }
        if (step === 5) { await gate('created-B')
          return bootstrapDeferredCall('bootstrap-candidate-return-A', 'project_open', { project }) }
        if (step === 7) {
          assert.match(bootstrapText(previousResult?.result ?? previousResult), /e2e_bootstrap_value\([^\n]*101/)
          return bootstrapDeferredCall('bootstrap-candidate-apply-A', 'abs_apply', { project, absPath: 'project.abs' })
        }
        return null
      }
      if (scenario === 'stop-before') { waitingBeforeDispatch = true; await barrier; return null }
      if (step === 0) return { id: 'bootstrap-load', name: 'tool_load', arguments: { names: [scenario === 'reconnect' ? 'project_open' : 'project_create'] } }
      if (step === 1) return scenario === 'reconnect'
        ? bootstrapDeferredCall('bootstrap-open-once', 'project_open', { project })
        : bootstrapDeferredCall('bootstrap-create-once', 'project_create', { name: 'bootstrap-stop-target', path: projectParent,
          boardName: '@aily-project/board-arduino_uno_r4_wifi', boardVersion: '1.5.3', developmentMode: 'blockly' })
      return null
    } })
  if (!['stop-host', 'candidate-stop'].includes(scenario)) return { ...bridge, release,
    releaseCandidateGate({ permanent = false } = {}) {
      if (permanent) candidateGatesReleased = true
      if (candidateGate?.pending) { candidateGate.pending = false; releaseCandidateGate() }
    },
    snapshot: () => ({ ...bridge.snapshot(), waitingBeforeDispatch, candidateGate,
    controlledProviderNotOnlineModel: true, sourceOfToolResults: 'actual-installed-SDK-and-Host' }) }
  // A second, separately identified interaction is enabled only after the
  // original stopped session has already proved its automatic binding. The
  // visible composer submits a read-only followup; it cannot create/open roots.
  let readback, readbackInteractionId, readbackArmed = false
  const server = http.createServer((request, response) => { void (async () => {
    const chunks = []; let size = 0
    for await (const chunk of request) { size += chunk.length; assert.ok(size <= 8 * 1024 ** 2); chunks.push(chunk) }
    const raw = Buffer.concat(chunks), url = new URL(request.url, 'http://127.0.0.1')
    const useReadback = readback && (url.pathname.includes('/' + readbackInteractionId + '/')
      || request.method === 'POST' && url.pathname === '/api/v3/interactions' && readbackArmed)
    const target = new URL(request.url, useReadback ? readback.origin : bridge.origin)
    const upstream = http.request(target, { method: request.method, headers: { ...request.headers, host: target.host } }, reply => {
      response.writeHead(reply.statusCode, reply.headers); reply.pipe(response) })
    upstream.once('error', () => response.destroy()); upstream.end(raw)
  })().catch(() => response.destroy()) })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return { origin: 'http://127.0.0.1:' + server.address().port, release,
    releaseCandidateGate({ permanent = false } = {}) {
      if (permanent) candidateGatesReleased = true
      if (candidateGate?.pending) { candidateGate.pending = false; releaseCandidateGate() }
    },
    async armReadback(targetProject) {
      assert.equal(readbackArmed, false); assert.ok(targetProject && inside(projectParent, targetProject))
      readbackInteractionId = 'bootstrap_readback_' + randomUUID().replaceAll('-', '')
      readback = await createAbsStepSubmissionBridge({ interactionId: readbackInteractionId,
        finalText: 'Read-only operation in the automatically bound original session completed.', async nextTool({ step }) {
          if (step === 0) return { id: 'bootstrap-readback-load', name: 'tool_load', arguments: { names: ['project_status'] } }
          if (step === 1) return bootstrapDeferredCall('bootstrap-readback-status', 'project_status', { project: targetProject })
          if (step === 2) return { id: scenario === 'candidate-stop' ? 'bootstrap-readback-candidate' : 'bootstrap-readback-package',
            name: 'read', arguments: { path: path.join(targetProject, scenario === 'candidate-stop' ? 'project.abs' : 'package.json') } }
          return null
        } })
      readbackArmed = true
    },
    snapshot: () => ({ ...bridge.snapshot(), waitingBeforeDispatch, candidateGate, readback: readback?.snapshot() ?? null,
      controlledProviderNotOnlineModel: true, sourceOfToolResults: 'actual-installed-SDK-and-Host' }),
    async close() { const closed = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await closed
      await readback?.close(); await bridge.close() } }
}

export async function runBootstrapUiBoundary({ scenario, page, loaded, provider, project, suite, agentRoot, checkpoint }) {
  const candidateStop = scenario === 'candidate-stop', hostStop = scenario === 'stop-host' || candidateStop
  const before = await boundaryHostState(page); assert.ok(!before.project)
  const evidence = { scenario, actualInstalledComposer: true, controlledProviderNotOnlineModel: true,
    actualCompilerInvoked: false, fabricatedToolResults: false, before, snapshots: [] }
  if (hostStop) await page.evaluate(holdAt => {
    const service = window.ng.getComponent(document.querySelector('app-header')).projectService
    const original = service.withProjectLifecycleAdmission; if (typeof original !== 'function') throw Error('Packaged Host lacks lifecycle admission')
    window.__bootstrapLifecyclePause = { entered: false, released: false, admissions: 0 }
    service.withProjectLifecycleAdmission = function (assertCurrent, operation) {
      return original.call(this, assertCurrent, async owner => {
        const state = window.__bootstrapLifecyclePause
        if (++state.admissions !== holdAt) return operation(owner)
        state.entered = true
        await new Promise(resolve => { state.release = resolve }); return operation(owner)
      })
    }
  }, candidateStop ? 3 : 1)
  const prompt = 'Controlled lifecycle boundary ' + scenario + '; this is a synthetic test-provider case, not the user weather task.'
  await loaded.frame.locator('.aily-chat-composer-input[role="textbox"]').fill(prompt)
  evidence.submissionAttemptedAt = Date.now(); await checkpoint(evidence)
  await loaded.frame.locator('button.primary-action.send-action').click()
  let sessionId, snapshot, stopped = false, nextCheckpoint = 0
  let candidateNative, candidateRef, candidateHash
  const readImmutableA = ref => readBootstrapImmutableCandidate(agentRoot, project, ref)
  const savedARef = () => snapshot.entries.filter(entry => entry.type === 'custom' && entry.customType === 'aily.workspace-history'
    && entry.data?.workspaceRoot && same(entry.data.workspaceRoot, project) && entry.data.candidateRefs?.['project.abs']).at(-1)?.data.candidateRefs['project.abs']
  const deadline = Date.now() + 5 * 60 * 1000
  evidence.observationDeadline = deadline
  const observeRead = (method, fields = {}, readDeadline = deadline) => readBootstrapObservation(
    () => loaded.e2e(method, fields), { deadline: readDeadline, onTimeout: async item => {
      (evidence.observationFailures ??= []).push({ ...item, method, ...(fields.sessionId ? { sessionId: fields.sessionId } : {}) })
      await checkpoint(evidence)
    } })
  try {
    while (Date.now() < deadline) {
      for (const dialog of await loaded.frame.locator('.pi-extension-dialog').all()) if (await dialog.isVisible()) {
        const parts = String(await dialog.getAttribute('aria-label')).split(/\r?\n/)
        assert.equal(parts[0], 'Trust project folder?'); assert.ok(inside(suite, parts[1]))
        await dialog.getByRole('button', { name: 'Trust (this session only)', exact: true }).click()
      }
      if (!sessionId) {
        const sessions = (await observeRead('session.list')).sessions
        for (const item of sessions) { const candidate = (await observeRead('session.read', { sessionId: item.sessionId })).session
          if (candidate.messages.some(message => message.role === 'user' && bootstrapText(message) === prompt)) { assert.ok(!sessionId); sessionId = candidate.sessionId } }
      }
      if (sessionId) { snapshot = (await observeRead('session.read', { sessionId })).session; evidence.sessionId = sessionId }
      const state = await boundaryHostState(page), transport = provider.snapshot()
      if ((scenario === 'candidate-switch' || candidateStop) && transport.candidateGate?.pending) {
        const phase = transport.candidateGate.phase
        if (phase === 'draft-ready') {
          assert.ok(same(state.project, project)); candidateNative = await nativeDocument(page)
          assert.ok(JSON.stringify(candidateNative).includes('bootstrap_value'))
          if (candidateStop) {
            const values = []
            const visit = value => { if (!value || typeof value !== 'object') return
              if (value.id === 'bootstrap_value') values.push(value.fields?.VALUE)
              for (const child of Object.values(value)) if (child && typeof child === 'object') visit(child) }
            visit(candidateNative)
            assert.deepEqual(values, [100], 'The candidate-stop Native baseline must still contain exactly the original unapplied value 100')
          }
          evidence.candidateBeforeCreate = { nativeDocument: candidateNative, binding: bootstrapSessionProjectBinding(snapshot, project) }
          assert.equal(evidence.candidateBeforeCreate.binding.bound, true)
        } else if (phase === 'created-B') {
          assert.ok(state.project && !same(state.project, project))
          evidence.bindingAtB = bootstrapSessionProjectBinding(snapshot, state.project); assert.equal(evidence.bindingAtB.bound, true)
          candidateRef = savedARef(); assert.ok(candidateRef, 'The actual navigation hook must checkpoint A before rebinding to B')
          const retained = await readImmutableA(candidateRef); candidateHash = sha(retained.source)
          assert.match(retained.source, /e2e_bootstrap_value\([^\n]*101/)
          evidence.retainedCandidate = { ref: candidateRef, sourceSha256: candidateHash, actualImmutableARead: true }
        } else {
          assert.equal(phase, 'returned-A'); assert.ok(same(state.project, project))
          assert.equal(bootstrapSessionProjectBinding(snapshot, project).bound, true)
          assert.deepEqual(await nativeDocument(page), candidateNative, 'Returning to A must preserve its full unapplied native document')
          assert.deepEqual(savedARef(), candidateRef)
          assert.equal(sha((await readImmutableA(candidateRef)).source), candidateHash)
          evidence.retainedCandidate.restoredByActualRuntime = true
        }
        await checkpoint(evidence); provider.releaseCandidateGate()
      }
      if (!stopped && (scenario === 'stop-before' && transport.waitingBeforeDispatch || hostStop && state.pausedInHost)) {
        if (candidateStop) {
          assert.equal(state.pauseAdmissionCount, 3); assert.ok(candidateRef && candidateHash)
          assert.ok(state.project && !same(state.project, project), 'Stop must hold the admitted B-to-A operation before Native opens A')
          const pending = bootstrapCalls(snapshot).at(-1)
          assert.equal(pending.actualName, 'project_open'); assert.ok(same(pending.actualArguments.project, project))
        }
        const stop = loaded.frame.locator('button.primary-action.stop-action'); assert.equal(await stop.isVisible(), true)
        const requestedAt = Date.now()
        await stop.click(); stopped = true; evidence.stop = { at: requestedAt, clickedAt: Date.now(), state, preDispatch: scenario === 'stop-before',
          hostCancellationClaim: false, actualVisibleChatStop: true }; await checkpoint(evidence)
        if (hostStop) {
          assert.ok(sessionId)
          let abortEntry; const abortDeadline = Date.now() + 10000
          do {
            const current = (await observeRead('session.read', { sessionId }, Math.min(deadline, abortDeadline))).session
            assert.equal(current.sessionId, sessionId)
            abortEntry = current.entries.find(entry => entry.type === 'custom' && entry.customType === 'aily.abort-request'
              && entry.data?.sessionId === sessionId && entry.data.source === 'user' && entry.data.requestedAt >= requestedAt)
            if (abortEntry) break
            await wait(100)
          } while (Date.now() < abortDeadline)
          assert.ok(abortEntry, 'Observe the backend original-session Stop before releasing the already admitted Host operation')
          evidence.stop.backendAbortObservedAt = Date.now(); evidence.stop.backendRequestedAt = abortEntry.data.requestedAt
          evidence.stop.interruptCountBeforeHostRelease = provider.snapshot().interruptCount
          evidence.stop.releaseHostAt = Date.now(); await checkpoint(evidence)
          await page.evaluate(() => { const state = window.__bootstrapLifecyclePause
            state.released = true; state.release() })
        }
        provider.release()
      }
      const final = snapshot?.messages.filter(message => message.role === 'assistant').at(-1)
      if (snapshot?.isIdle && !snapshot.isStreaming && ['stop', 'aborted', 'error'].includes(final?.stopReason)
        && !state.busy && !state.hasRunning && state.aiNoticeCount === 0 && state.lifecycleOwners === 0) break
      if (Date.now() >= nextCheckpoint) { nextCheckpoint = Date.now() + 1000
        evidence.snapshots.push({ at: Date.now(), sessionId, idle: snapshot?.isIdle, streaming: snapshot?.isStreaming, state }); await checkpoint(evidence) }
      await wait(100)
    }
    assert.ok(snapshot?.isIdle && !snapshot.isStreaming); evidence.sessionId = sessionId
    evidence.session = snapshot; evidence.transport = provider.snapshot(); evidence.after = await boundaryHostState(page)
    assert.deepEqual(snapshot.messages.filter(message => message.role === 'user').map(bootstrapText), [prompt])
    const calls = bootstrapCalls(snapshot), final = snapshot.messages.filter(message => message.role === 'assistant').at(-1)
    evidence.final = { stopReason: final?.stopReason, text: bootstrapText(final), errorMessage: final?.errorMessage ?? null }
    if (scenario.startsWith('stop-') || candidateStop) {
      evidence.userStopOutcome = bootstrapUserStopOutcome(snapshot, evidence.stop?.at)
      assert.equal(evidence.userStopOutcome.normalUserStop, true,
        'Only the exact durable original-session user Stop can qualify an aborted outcome')
    } else { assert.equal(final?.stopReason, 'stop'); assert.ok(!final?.errorMessage) }
    evidence.visibleErrorBubbles = await loaded.frame.locator('.pi-message-error:visible').allTextContents()
    assert.deepEqual(evidence.visibleErrorBubbles, [])
    assert.equal(evidence.after.busy, false); assert.equal(evidence.after.blocked, false)
    assert.equal(evidence.after.recoveryRequired, false); assert.equal(evidence.after.hasRunning, false); assert.equal(evidence.after.aiNoticeCount, 0)
    assert.equal(evidence.after.lifecycleOwners, 0)
    assert.deepEqual(evidence.transport.failures, [])
    if (scenario === 'candidate-switch') {
      assert.ok(candidateNative && candidateRef && candidateHash)
      const expected = structuredClone(candidateNative)
      const visit = value => { if (!value || typeof value !== 'object') return
        if (value.id === 'bootstrap_value') value.fields.VALUE = 101
        for (const child of Object.values(value)) if (child && typeof child === 'object') visit(child) }
      visit(expected)
      assert.deepEqual(await nativeDocument(page), expected)
      assert.deepEqual(JSON.parse(await fs.readFile(path.join(project, 'project.abi'))), expected)
      assert.ok(same(evidence.after.project, project)); assert.equal(bootstrapSessionProjectBinding(snapshot, project).bound, true)
      for (const [name, count] of [['project_create', 1], ['project_open', 2], ['read', 2], ['edit', 1], ['abs_apply', 1]])
        assert.equal(calls.filter(call => call.actualName === name).length, count)
      for (const id of ['bootstrap-candidate-create-B', 'bootstrap-candidate-return-A', 'bootstrap-candidate-apply-A']) {
        const result = snapshot.messages.find(message => message.role === 'toolResult' && message.toolCallId === id)
        assert.ok(result && result.isError !== true); assert.equal(bootstrapPayload(result)?.ok, true)
      }
      assert.equal(evidence.transport.createCount, 1); assert.equal(evidence.transport.interruptCount, 0)
      assert.ok(evidence.transport.operations.every(item => item.providerInvocations === 1 && item.postCount === 1))
      evidence.actualRuntimeHandledEveryRebind = true; evidence.fullOriginalNativeDocumentPreservedExceptCandidateField = true
    } else if (scenario === 'reconnect') {
      const opens = calls.filter(call => call.actualName === 'project_open'); assert.equal(opens.length, 1)
      const result = snapshot.messages.find(message => message.role === 'toolResult' && message.toolCallId === opens[0].id)
      assert.equal(bootstrapPayload(result)?.ok, true); assert.ok(same(evidence.after.project, project))
      assert.equal(evidence.transport.createCount, 1)
      const recovered = evidence.transport.operations.find(item => item.headersLost)
      assert.ok(recovered && recovered.stateReads > 0 && recovered.eventReads > 0)
      assert.ok(evidence.transport.operations.every(item => item.providerInvocations === 1 && item.postCount === 1))
      evidence.sameOriginalOperationReadOnlyRecovery = true
    } else {
      assert.equal(stopped, true)
      if (scenario === 'stop-before') {
        assert.equal(evidence.transport.interruptCount, 1)
        assert.equal(calls.filter(call => call.actualName === 'project_create').length, 0); assert.ok(!evidence.after.project)
      } else {
        assert.ok([0, 1].includes(evidence.transport.interruptCount), 'An already finished provider tool-call stream need not receive an HTTP interruption')
        assert.ok(evidence.stop.backendAbortObservedAt <= evidence.stop.releaseHostAt)
        assert.equal(calls.filter(call => call.actualName === 'project_create').length, 1)
        assert.ok(evidence.after.project); evidence.originalHostLateCompletionObserved = true
        const targetProject = evidence.after.project
        if (candidateStop) {
          assert.ok(same(targetProject, project)); assert.equal(calls.filter(call => call.actualName === 'project_open').length, 2)
          assert.equal(calls.filter(call => call.actualName === 'abs_apply').length, 0)
          assert.deepEqual(await nativeDocument(page), candidateNative)
          assert.deepEqual(JSON.parse(await fs.readFile(path.join(project, 'project.abi'))), candidateNative)
          assert.deepEqual(savedARef(), candidateRef)
          const retained = await readImmutableA(candidateRef); assert.equal(sha(retained.source), candidateHash)
          evidence.candidateAfterStop = { ref: candidateRef, sourceSha256: candidateHash,
            nativeOriginal100Preserved: true, originalCandidate101Preserved: true }
        }
        evidence.bindingBeforeFollowup = bootstrapSessionProjectBinding(snapshot, targetProject)
        await checkpoint(evidence)
        assert.equal(evidence.bindingBeforeFollowup.bound, true,
          'Late Native success must already be bound to the original session before another prompt or tool can run')
        const dirsBefore = (await fs.readdir(path.dirname(targetProject))).sort()
        const abiBefore = sha(await fs.readFile(path.join(targetProject, 'project.abi')))
        const nativeBefore = sha(JSON.stringify(await nativeDocument(page)))
        evidence.sessionBeforeReadback = snapshot
        await provider.armReadback(targetProject)
        const followup = candidateStop ? '只读检查当前项目状态和工作草稿，不新建、打开、切换或应用项目。'
          : '只读检查当前项目状态和项目清单，不新建、打开或切换项目。'
        const composer = loaded.frame.locator('.aily-chat-composer-input[role="textbox"]')
        await composer.fill(followup); await loaded.frame.locator('button.primary-action.send-action').click()
        const readbackDeadline = Math.min(Date.now() + 120000, deadline)
        do {
          snapshot = (await observeRead('session.read', { sessionId }, readbackDeadline)).session
          assert.equal(snapshot.sessionId, sessionId)
          const last = snapshot.messages.filter(message => message.role === 'assistant').at(-1)
          if (snapshot.isIdle && !snapshot.isStreaming && snapshot.messages.filter(message => message.role === 'user').length === 2
            && ['stop', 'aborted', 'error'].includes(last?.stopReason)) break
          await wait(100)
        } while (Date.now() < readbackDeadline)
        assert.ok(snapshot.isIdle && !snapshot.isStreaming)
        // Persist the actually completed second turn before any business
        // assertion can fail. Never leave only the older stopped snapshot.
        evidence.session = snapshot
        evidence.readbackCheckpoint = { phase: 'original-session-readonly-turn-settled', at: Date.now(),
          sessionId: snapshot.sessionId, cwd: snapshot.cwd, userMessages: snapshot.messages.filter(message => message.role === 'user').length }
        await checkpoint(evidence)
        assert.deepEqual(snapshot.messages.filter(message => message.role === 'user').map(bootstrapText), [prompt, followup])
        evidence.bindingAfterFollowup = bootstrapSessionProjectBinding(snapshot, targetProject)
        assert.equal(evidence.bindingAfterFollowup.bound, true)
        const afterCalls = bootstrapCalls(snapshot)
        assert.equal(afterCalls.filter(call => call.actualName === 'project_create').length, 1)
        if (candidateStop) {
          assert.equal(afterCalls.filter(call => call.actualName === 'project_open').length, 2)
          assert.equal(afterCalls.filter(call => ['project_fork', 'app_open', 'abs_apply'].includes(call.actualName)).length, 0)
        } else assert.equal(afterCalls.filter(call => ['project_fork', 'project_open', 'app_open'].includes(call.actualName)).length, 0)
        const statusCall = afterCalls.find(call => call.id === 'bootstrap-readback-status')
        assert.ok(statusCall && same(statusCall.actualArguments.project, targetProject))
        const statusMessage = snapshot.messages.find(message => message.role === 'toolResult' && message.toolCallId === statusCall.id)
        const statusValue = bootstrapPayload(statusMessage)
        evidence.readbackStatus = statusValue
        evidence.readbackCheckpoint.phase = 'verify-status-scope-and-original-root'; await checkpoint(evidence)
        assert.notEqual(statusMessage?.isError, true); assert.equal(statusValue?.ok, true)
        assert.ok(same(statusValue.project, targetProject), 'Readonly status must address the automatically bound original project')
        evidence.readbackAbiScope = assertBootstrapReadbackAbiScope(statusValue, candidateStop)
        const readMessage = snapshot.messages.find(message => message.role === 'toolResult'
          && message.toolCallId === (candidateStop ? 'bootstrap-readback-candidate' : 'bootstrap-readback-package'))
        assert.ok(readMessage && readMessage.isError !== true)
        if (candidateStop) {
          const retained = await readImmutableA(candidateRef)
          assert.equal(sha(retained.source), candidateHash); assert.notEqual(readMessage.details?.truncation?.truncated, true)
          assert.equal(bootstrapText(readMessage).trimEnd(), retained.source.trimEnd())
          assert.match(bootstrapText(readMessage), /e2e_bootstrap_value\([^\n]*101/)
        } else {
          const manifest = JSON.parse(await fs.readFile(path.join(targetProject, 'package.json')))
          assert.ok(bootstrapText(readMessage).includes(manifest.name))
          assert.ok(bootstrapText(readMessage).includes('@aily-project/board-arduino_uno_r4_wifi'))
        }
        assert.deepEqual((await fs.readdir(path.dirname(targetProject))).sort(), dirsBefore)
        evidence.readbackCheckpoint.phase = 'verify-native-after-readonly-turn'; await checkpoint(evidence)
        assert.equal(sha(await fs.readFile(path.join(targetProject, 'project.abi'))), abiBefore)
        assert.equal(sha(JSON.stringify(await nativeDocument(page))), nativeBefore)
        evidence.afterReadback = await boundaryHostState(page)
        assert.equal(evidence.afterReadback.lifecycleOwners, 0); assert.equal(evidence.afterReadback.aiNoticeCount, 0)
        assert.equal(evidence.afterReadback.hasRunning, false); assert.equal(evidence.afterReadback.busy, false)
        const readbackTransport = provider.snapshot().readback
        assert.equal(readbackTransport.createCount, 1); assert.deepEqual(readbackTransport.failures, [])
        assert.ok(readbackTransport.operations.every(item => item.providerInvocations === 1 && item.postCount === 1))
        const readbackFinal = snapshot.messages.filter(message => message.role === 'assistant').at(-1)
        assert.equal(readbackFinal?.stopReason, 'stop'); assert.ok(!readbackFinal.errorMessage)
        evidence.readOnlyFollowup = { sameSessionId: sessionId, source: 'visible-composer-second-controlled-interaction',
          bindingVerifiedBeforePrompt: true, project: targetProject, status: statusValue,
          actualCorePackageRead: !candidateStop, actualCoreCandidateRead: candidateStop,
          additionalCreateOrOpen: false, additionalApply: false, duplicateDirectoryCreated: false, userManualActivation: false }
        evidence.session = snapshot; evidence.transport = provider.snapshot()
        evidence.readbackCheckpoint.phase = 'all-readonly-followup-oracles-verified'
      }
    }
    evidence.ok = true; await checkpoint(evidence); return evidence
  } finally {
    provider.release()
    provider.releaseCandidateGate?.({ permanent: true })
    if (hostStop) await page.evaluate(() => { const state = window.__bootstrapLifecyclePause
      if (state?.release && !state.released) { state.released = true; state.release() } }).catch(() => {})
  }
}
