import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { _electron } from '@playwright/test'
import { serveRendererBuild } from '../fixtures/build-renderer-server.mjs'
import { createRecoveredAgentHarness } from '../fixtures/abs-agent-tools.mjs'
import { createAbsProviderSession } from '../fixtures/abs-provider-session.mjs'
import { createAbsTerminalExpiryBridge } from '../fixtures/abs-terminal-expiry-bridge.mjs'

const repo = fileURLToPath(new URL('../../', import.meta.url))
const root = path.resolve(process.env.AILY_TERMINAL_ROOT ?? '')
const project = path.resolve(process.env.AILY_TERMINAL_PROJECT ?? '')
const agentRoot = path.resolve(process.env.AILY_TERMINAL_AGENT ?? '')
const build = path.resolve(process.env.AILY_TERMINAL_HOST_BUILD ?? '')
const output = path.resolve(process.env.AILY_TERMINAL_OUTPUT ?? '')
const mode = process.env.AILY_TERMINAL_MODE ?? 'available'
const inside = (parent, file) => { const relative = path.relative(parent, file)
  return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) }
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
const sha = value => createHash('sha256').update(value).digest('hex')
const textOf = event => (event.content ?? []).filter(item => item.type === 'text').map(item => item.text).join('\n')
const resultOf = event => {
  if (event.details?.result && typeof event.details.result === 'object') return event.details.result
  try { return JSON.parse(textOf(event)) } catch { return undefined }
}
const programOf = source => {
  const marker = '\n# @project-state:', at = source.indexOf(marker)
  if (at < 0) return source
  assert.equal(source.indexOf(marker, at + marker.length), -1, 'The host-owned state section must be unique')
  const end = source.indexOf('\n', at + marker.length)
  return source.slice(0, at) + (end < 0 ? '' : source.slice(end))
}
assert.ok(['available', 'missing', 'incomplete'].includes(mode))
assert.match(root.replaceAll('\\', '/'), /^C:\/.*\/aily-project\/dev-tests\/abs-serial-analysis-20261028$/i)
assert.ok(inside(root, project) && /[\\/]serial-agent-[^\\/]+[\\/]project$/.test(project))
assert.ok(inside(path.join(repo, 'e2e/test-results'), output))
assert.ok(same(root, await fs.realpath(root)) && same(project, await fs.realpath(project)))
await fs.mkdir(output, { recursive: true })
const suite = await fs.mkdtemp(path.join(root, 'terminal-expiry-'))
const home = path.join(suite, 'home'), profileRoot = path.join(suite, 'agent-profile'), appData = path.join(root, 'appdata')
await fs.mkdir(home)
const seed = path.join(root, 'archive-user-project/esp32-c3-HANTAI')
const sourceHashes = async () => {
  const hashes = {}
  const visit = async (directory, prefix = '') => {
    for (const item of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? `${prefix}/${item.name}` : item.name, file = path.join(directory, item.name)
      if (item.isSymbolicLink()) hashes[relative] = 'link:' + sha(await fs.readlink(file))
      else if (item.isDirectory()) await visit(file, relative)
      else if (item.isFile()) hashes[relative] = sha(await fs.readFile(file))
    }
  }
  await visit(seed)
  return hashes
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
const evidence = { ok: false, mode, project, llmInvoked: false, syntheticUsage: true,
  realAilyProvider: true, actualSdkLoop: true, realSdkCoreReadWriteEdit: true,
  realServiceCasOrBilling: false, hardwareUsed: false, simulatorUsed: false,
  userProjectsModified: false, dailyInstallReplaced: false, tools: [],
  sourceSeed: { files: Object.keys(sourceBefore).length, sha256: sha(JSON.stringify(sourceBefore)) } }
let app, renderer, page, harness, bridge, hostPid, baseline, baselineDocument, latestBuild, finalHash, inputCandidate, beforeExpiry
const call = async (name, input) => { const result = await harness.call(name, input); return result.structured ?? result }
try {
  renderer = await serveRendererBuild(build)
  const { ELECTRON_RUN_AS_NODE, AILY_CHILD_PATH, NODE_PATH, ...env } = process.env
  app = await _electron.launch({ args: ['.', '--serve', `--user-data-dir=${path.join(suite, 'electron-profile')}`], cwd: repo,
    timeout: 60000, env: { ...env, AILY_E2E: '1', AILY_APPDATA_PATH: appData, HOME: home, USERPROFILE: home,
      AILY_DEV_RENDERER_URL: renderer.origin, npm_config_offline: 'true', npm_config_audit: 'false' } })
  hostPid = await app.evaluate(() => process.pid)
  evidence.hostPid = hostPid
  await app.firstWindow()
  const deadline = Date.now() + 60000
  while (!page && Date.now() < deadline) {
    page = app.windows().find(candidate => candidate.url().startsWith(renderer.origin))
    if (!page) await new Promise(resolve => setTimeout(resolve, 200))
  }
  assert.ok(page)
  page.on('dialog', dialog => dialog.dismiss())
  await page.goto(renderer.origin, { waitUntil: 'domcontentloaded' })
  await page.locator('app-main-window').waitFor({ timeout: 60000 })
  const ready = () => page.waitForFunction(target => {
    const element = document.querySelector('blockly-main'), service = element && window.ng?.getComponent(element)?.projectService
    return service?.currentProjectPath?.replaceAll('\\', '/') === target.replaceAll('\\', '/')
      && service.getBlocklyProjectLoadStatus(target)?.ready === true
  }, project, { timeout: 60000 })
  const installSettled = () => page.waitForFunction(() => {
    const component = window.ng?.getComponent(document.querySelector('app-blockly-editor'))
    return component?._builderService?.isInstallInProgress() === false
  }, undefined, { timeout: 60000 })
  const canvas = () => page.evaluate(() => JSON.parse(JSON.stringify(window.Blockly.serialization.workspaces.save(window.Blockly.getMainWorkspace()))))
  const preservedCanvas = state => {
    const oldBlocks = blockIndex(baseline), current = blockIndex(state)
    for (const [id, value] of oldBlocks) assert.deepEqual(current.get(id), value, 'Every original hidden/opaque/native block state survives')
    assert.deepEqual(state.variables, baseline.variables)
    assert.equal(current.size, oldBlocks.size + 2)
    return { blocks: current.size, models: state.variables.length }
  }
  const preservedDocument = async () => {
    const current = JSON.parse(await fs.readFile(path.join(project, 'project.abi'), 'utf8'))
    assert.equal(current.activePageId, baselineDocument.activePageId)
    assert.deepEqual(current.openedPageIds, baselineDocument.openedPageIds)
    assert.deepEqual(current.pages.map(({ id, title }) => ({ id, title })), baselineDocument.pages.map(({ id, title }) => ({ id, title })))
    assert.deepEqual(current.sharedModel.variables, baselineDocument.sharedModel.variables)
    const before = documentBlocks(baselineDocument), after = documentBlocks(current)
    for (const [id, value] of before) assert.deepEqual(after.get(id), value, 'Preserve every page and shared procedure, not just the active canvas')
    assert.equal(after.size, before.size + 2)
    return { pages: current.pages.length, blocks: after.size, models: current.sharedModel.variables.length }
  }
  await page.evaluate(target => { location.hash = '#/main/blockly-editor?path=' + encodeURIComponent(target) }, project)
  await ready(); await installSettled()
  Object.assign(process.env, { AILY_LIBRARY_HOST_PID: String(hostPid), AILY_APPDATA_PATH: appData,
    PI_CODING_AGENT_DIR: profileRoot, HOME: home, USERPROFILE: home, PI_OFFLINE: '1', npm_config_offline: 'true', npm_config_audit: 'false' })
  const absPath = path.join(project, 'project.abs'), before = `terminal_before_${randomUUID().slice(0, 8)}`
  const after = before.replace('before', 'after'), plan = []
  const compileDeadline = Date.now() + 12 * 60 * 1000
  bridge = await createAbsTerminalExpiryBridge({ interactionId: 'itx_abs_terminal_' + randomUUID().replaceAll('-', ''), mode,
    nextTool: async ({ step }) => {
      if (step < plan.length) return plan[step]
      assert.ok(latestBuild, 'The actual SDK must compile the applied candidate before final text')
      if (latestBuild.buildOutcome === 'unknown' && latestBuild.pendingBuild?.resumable === true) {
        const pending = latestBuild.pendingBuild
        assert.ok(Date.now() < compileDeadline)
        assert.equal(pending.tool, 'project_build')
        assert.equal(pending.arguments.build_target_pid, hostPid)
        assert.ok(same(pending.arguments.project, project))
        return { id: `observe-build-${step}`, name: pending.tool, arguments: pending.arguments }
      }
      assert.equal(latestBuild.ok, true)
      assert.equal(latestBuild.buildReceipt?.state, 'completed')
      evidence.compiled = latestBuild
      // The canonical export legitimately refreshes the host-owned state
      // footer. Freeze the actual output only after reopen/compile, immediately
      // before transport failure, rather than confusing it with input bytes.
      assert.equal(beforeExpiry, undefined)
      beforeExpiry = { canvas: await canvas(), abi: await fs.readFile(path.join(project, 'project.abi')),
        abs: await fs.readFile(path.join(project, 'project.abs')) }
      evidence.beforeRecovery = { canvasSha256: sha(JSON.stringify(beforeExpiry.canvas)),
        abiSha256: sha(beforeExpiry.abi), absSha256: sha(beforeExpiry.abs) }
      return undefined
    } })
  harness = await createRecoveredAgentHarness({ agentRoot, sourceProject: project, globalRoot: root, profileRoot,
    createStreaming: context => createAbsProviderSession(context, { apiBase: bridge.origin, onToolResult: async event => {
      const result = resultOf(event)
      evidence.tools.push({ name: event.toolName, id: event.toolCallId, isError: event.isError === true })
      await fs.appendFile(path.join(output, 'tool-results.jsonl'), JSON.stringify({ name: event.toolName, ...event }) + '\n')
      assert.notEqual(event.isError, true, `Actual Agent tool ${event.toolName} must succeed`)
      if (event.toolCallId === 'abs-edit-once') {
        const physical = path.join(harness.history.executionRoot, 'project.abs')
        assert.ok(same(physical, absPath) || inside(project, physical))
        inputCandidate = await fs.readFile(physical)
        assert.equal(sha(inputCandidate), finalHash, 'Observe the real SDK edit result before any canonical publication')
        evidence.inputCandidate = { hash: 'sha256:' + sha(inputCandidate), bytes: inputCandidate.byteLength,
          artifact: 'candidate-after-sdk-edit.abs', checkpoint: harness.history.currentCheckpoint ?? null }
        // This is an evidence copy of an already executed SDK edit, never a
        // write to project/overlay or a substitute for the actual Agent tool.
        await fs.writeFile(path.join(output, 'candidate-after-sdk-edit.abs'), inputCandidate)
      }
      if (event.toolName === 'abs_validate') { assert.equal(result?.ok, true); evidence.validated = true }
      if (event.toolName === 'abs_apply') {
        assert.equal(result?.ok, true)
        evidence.applied = preservedCanvas(await canvas())
        evidence.appliedDocument = await preservedDocument()
        evidence.applyReceipt = result.receipt
      }
      if (event.toolName === 'app_reload') {
        assert.equal(result?.ok, true)
        await ready(); await installSettled()
        evidence.reopened = preservedCanvas(await canvas())
        evidence.reopenedDocument = await preservedDocument()
      }
      if (event.toolName === 'project_build') latestBuild = result
      if (event.toolCallId === 'abs-read-edited') assert.match(textOf(event), new RegExp(after))
    } }),
    permissionApproval(request) {
      if (['read', 'write', 'edit'].includes(request.toolName)) return same(request.input?.path ?? '', absPath)
      return ['abs_export', 'abs_validate', 'abs_apply', 'app_reload', 'project_build', 'app_close', 'project_recover'].includes(request.toolName)
        && same(request.input?.project ?? '', project)
    } })
  // A fresh physical copy can contain an old source scope. Only the existing
  // actual Agent preserving-repair workflow may reconcile it; no script writes
  // a map, pointer, generation or candidate to bypass that protection.
  const loaded = await canvas(), inspected = await call('project_recover', { project, action: 'inspect' })
  assert.equal(inspected.ok, true)
  const repair = inspected.diagnostics?.repair
  evidence.preparationRecovery = { status: inspected.diagnostics?.status, repairOffered: !!repair }
  if (repair) {
    assert.equal(repair.authority, 'workspace')
    const repaired = await call('project_recover', { project, action: 'repair', token: repair.token, authority: repair.authority })
    assert.equal(repaired.ok, true)
    assert.equal(repaired.repairVerification?.candidateApplied, false)
    assert.equal(repaired.publication.status, 'COMMITTED')
    assert.deepEqual(await canvas(), loaded)
    evidence.preparationRecovery.candidateApplied = false
  }
  const exported = await call('abs_export', { project })
  assert.equal(exported.ok, true)
  baseline = await canvas()
  baselineDocument = JSON.parse(await fs.readFile(path.join(project, 'project.abi'), 'utf8'))
  const originalBlocks = documentBlocks(sourceDocument), loadedBlocks = documentBlocks(baselineDocument)
  for (const [id, value] of originalBlocks) assert.deepEqual(loadedBlocks.get(id), value, 'The initial native load/export must retain every archived page/shared-procedure block')
  assert.equal(loadedBlocks.size, originalBlocks.size)
  assert.deepEqual(baselineDocument.sharedModel.variables, sourceDocument.sharedModel.variables)
  evidence.sourceDocument = { pages: sourceDocument.pages.length, blocks: originalBlocks.size,
    models: sourceDocument.sharedModel.variables.length, preservedIntoBaseline: true }
  evidence.baseline = { canvasBlocks: blockIndex(baseline).size, blocks: documentBlocks(baselineDocument).size,
    models: baselineDocument.sharedModel.variables.length }
  const anchor = exported.abs.match(/^arduino_setup\(\).*$/m)?.[0]
  assert.ok(anchor)
  const candidate = exported.abs.replace(anchor, `${anchor}\n    serial_print(Serial, text("${before}"))`)
  finalHash = sha(candidate.replace(before, after))
  const line = candidate.slice(0, candidate.indexOf(before)).split('\n').length
  plan.push(
    { id: 'abs-read-initial', name: 'read', arguments: { path: absPath, limit: 30 } },
    { id: 'abs-write-candidate', name: 'write', arguments: { path: absPath, content: candidate } },
    { id: 'abs-edit-once', name: 'edit', arguments: { path: absPath, edits: [{ oldText: before, newText: after }] } },
    { id: 'abs-read-edited', name: 'read', arguments: { path: absPath, offset: Math.max(1, line - 3), limit: 8 } },
    { id: 'abs-validate', name: 'abs_validate', arguments: { project, generation: exported.generation, absPath } },
    { id: 'abs-apply', name: 'abs_apply', arguments: { project, generation: exported.generation, absPath } },
    { id: 'abs-reopen', name: 'app_reload', arguments: { project } },
    { id: 'abs-compile', name: 'project_build', arguments: { project } })
  let promptError
  try { await harness.prompt('In this isolated project, preserve every original block and model. Read project.abs, add a single serial print, edit its unique marker once, validate and apply, reopen and compile. Do not upload or touch any other project.') }
  catch (error) { promptError = { name: error.name, message: error.message, code: error.code } }
  const assistant = harness.messages().filter(message => message.role === 'assistant').at(-1)
  evidence.finalResponse = { stopReason: assistant?.stopReason, text: textOf(assistant ?? {}), errorMessage: assistant?.errorMessage,
    responseReplayPolicy: assistant?.responseReplayPolicy, responseOperationTerminal: assistant?.responseOperationTerminal,
    usage: assistant?.usage,
    ...(promptError ? { promptError } : {}) }
  if (mode === 'available') {
    assert.equal(promptError, undefined)
    assert.equal(assistant?.stopReason, 'stop')
    assert.equal(textOf(assistant), bridge.finalText, 'Recover only the exact raw suffix, without prefix duplication')
    assert.equal(assistant.responseReplayPolicy, 'never')
    assert.deepEqual(assistant.responseOperationTerminal, { status: 'completed' })
  } else {
    assert.ok(promptError || assistant?.stopReason === 'error', 'Missing/incomplete output cannot be declared a full successful response')
    assert.notEqual(assistant?.stopReason, 'stop')
    assert.ok(!textOf(assistant ?? {}).includes('Final response recovered'), 'Never fabricate the unobserved final suffix')
    assert.equal(assistant?.responseReplayPolicy, 'never')
    if (mode === 'incomplete') assert.deepEqual(assistant?.responseOperationTerminal, { status: 'completed' },
      'Proven remote completion is distinct from incomplete response delivery')
    else assert.equal(assistant?.responseOperationTerminal, undefined, 'Legacy state alone cannot mint a new execution-terminal proof')
    if (mode === 'incomplete') assert.match(assistant.errorMessage, /interaction_response_incomplete/)
  }
  assert.equal(assistant?.usage?.input, 1, 'A terminal receipt cannot replay the already observed usage frame')
  assert.equal(assistant?.usage?.output, 1)
  assert.equal(evidence.tools.filter(tool => tool.name === 'write').length, 1)
  assert.equal(evidence.tools.filter(tool => tool.name === 'edit').length, 1)
  for (const name of ['abs_validate', 'abs_apply', 'app_reload']) assert.equal(evidence.tools.filter(tool => tool.name === name).length, 1)
  assert.ok(evidence.validated && evidence.applied && evidence.reopened)
  assert.equal(evidence.applyReceipt.candidate.hash, 'sha256:' + finalHash)
  assert.equal(evidence.applyReceipt.candidate.bytes, inputCandidate.byteLength)
  const recoveredAbs = await fs.readFile(absPath), recoveredAbi = await fs.readFile(path.join(project, 'project.abi'))
  const recoveredCanvas = await canvas()
  assert.ok(beforeExpiry)
  assert.deepEqual(recoveredCanvas, beforeExpiry.canvas, 'Terminal recovery cannot mutate the native workspace')
  assert.deepEqual(recoveredAbi, beforeExpiry.abi, 'Terminal recovery cannot mutate the saved ABI')
  assert.deepEqual(recoveredAbs, beforeExpiry.abs, 'Terminal recovery cannot mutate the canonical ABS')
  assert.equal(evidence.applyReceipt.output.binding.absHash, 'sha256:' + sha(recoveredAbs), 'Canonical output binds its own host-refreshed state footer')
  assert.equal(programOf(recoveredAbs.toString('utf8')), programOf(inputCandidate.toString('utf8')),
    'Canonicalization may update hidden-state identities, never the edited readable program')
  assert.equal(sha(await fs.readFile(path.join(output, evidence.inputCandidate.artifact))), finalHash,
    'Keep the exact real SDK input candidate independently of canonical output')
  evidence.afterRecoveryHashes = { canvasSha256: sha(JSON.stringify(recoveredCanvas)), abiSha256: sha(recoveredAbi), absSha256: sha(recoveredAbs) }
  assert.deepEqual(evidence.afterRecoveryHashes, evidence.beforeRecovery)
  assert.match(await fs.readFile(path.join(project, '.temp/sketch/sketch.ino'), 'utf8'), new RegExp(after))
  evidence.compiled = latestBuild
  assert.equal(latestBuild?.ok, true)
  assert.equal(latestBuild?.buildReceipt?.state, 'completed')
  evidence.afterRecovery = preservedCanvas(await canvas())
  evidence.afterRecoveryDocument = await preservedDocument()
  evidence.transport = bridge.snapshot()
  assert.deepEqual(evidence.transport.failures, [])
  assert.equal(evidence.transport.createCount, 1)
  assert.equal(evidence.transport.interruptCount, mode === 'missing' ? 1 : 0)
  const expired = evidence.transport.operations.find(value => value.turnEndLost)
  assert.equal(expired.toolCallId, undefined, 'The expired final operation has no latent executable tool')
  assert.ok(expired.eventReads >= 1 && expired.stateReads >= 1)
  assert.equal(expired.resultReads, mode === 'available' ? 1 : 0)
  for (const operation of evidence.transport.operations) {
    assert.equal(operation.providerInvocations, 1)
    assert.equal(operation.postCount, 1, 'Neither event expiry nor incomplete receipts may replay accepted steps')
  }
  assert.equal(evidence.transport.requests.some(request => /resume|restart/.test(request.path)), false)
  evidence.proof = harness.proof()
  assert.equal(evidence.proof.actualProviderSession, true)
  assert.equal(evidence.proof.promptRuns, 1)
  assert.equal(evidence.proof.sessionUserMessages, 1)
  await call('app_close', { project })
  evidence.ok = true
} catch (error) {
  evidence.failure = { message: error.message, stack: error.stack }
  evidence.transport = bridge?.snapshot()
  process.exitCode = 1
} finally {
  await harness?.dispose().catch(error => { evidence.cleanupFailure = error.message; process.exitCode = 1 })
  if (app) await app.evaluate(({ app }, expected) => {
    if (process.pid !== expected.pid || process.env.AILY_APPDATA_PATH !== expected.appData) throw new Error('Refuse unrelated host shutdown')
    app.exit(0)
  }, { pid: hostPid, appData }).catch(error => { evidence.cleanupFailure = error.message; process.exitCode = 1 })
  await renderer?.close()
  await bridge?.close()
  assert.deepEqual(await sourceHashes(), sourceBefore)
  evidence.sourceSeedPreserved = true
  evidence.ok &&= process.exitCode !== 1
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(evidence, null, 2))
  console.log(evidence.ok ? 'PASS' : 'FAIL', path.join(output, 'result.json'))
}
