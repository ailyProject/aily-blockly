import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { _electron } from '@playwright/test'
import { serveRendererBuild } from '../fixtures/build-renderer-server.mjs'
import { createRecoveredAgentHarness } from '../fixtures/abs-agent-tools.mjs'

const repo = fileURLToPath(new URL('../../', import.meta.url))
const required = name => {
  const value = process.env['AILY_RESOLVE_' + name]
  assert.ok(value && path.isAbsolute(value), `AILY_RESOLVE_${name} must be an explicit absolute path`)
  return path.resolve(value)
}
const root = required('ROOT'), project = required('PROJECT'), agentRoot = required('AGENT')
const build = required('HOST_BUILD'), output = required('OUTPUT')
const choice = process.env.AILY_RESOLVE_CHOICE, loseAck = process.env.AILY_RESOLVE_UNKNOWN_ACK === '1'
const inspectProbe = process.env.AILY_RESOLVE_INSPECT_PROBE === '1'
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
const inside = (a, b) => { const relative = path.relative(a, b); return relative && relative !== '..' &&
  !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) }
assert.match(root.replaceAll('\\', '/'), /^C:\/.*\/aily-project\/dev-tests\/abs-serial-analysis-20261028$/i)
assert.ok(inside(root, project) && /[\\/]serial-agent-identity-[^\\/]+[\\/]project$/.test(project))
assert.ok(same(project, await fs.realpath(project)))
assert.ok(inside(path.join(repo, 'e2e/test-results'), output))
assert.ok(['keep_view', 'replace_view'].includes(choice))
await fs.mkdir(output, { recursive: true })
const suite = await fs.mkdtemp(path.join(root, 'conflict-agent-'))
const home = path.join(suite, 'home'), profileRoot = path.join(suite, 'agent-profile'), appData = path.join(root, 'appdata')
await fs.mkdir(home)
const abiPath = path.join(project, 'project.abi'), absPath = path.join(project, 'project.abs')
const hash = value => 'sha256:' + createHash('sha256').update(value).digest('hex')
const find = (value, id) => value && typeof value === 'object'
  ? value.id === id && typeof value.type === 'string' ? value : Object.values(value).map(child => find(child, id)).find(Boolean) : undefined
const source = path.join(root, 'archive-user-project/esp32-c3-HANTAI')
const sourceHashes = () => Promise.all(['project.abi', 'project.abs', 'project.abs.map.json', 'package.json'].map(async file => hash(await fs.readFile(path.join(source, file)))))
const sourceBefore = await sourceHashes()
const evidence = { ok: false, project, choice, loseAck, actualSdkTools: true, llmInvoked: false,
  hardwareUsed: false, simulatorUsed: false, dailyInstallReplaced: false, userProjectsModified: false, tools: [] }
let app, renderer, page, harness, hostPid, ackLost = false, probeInjected = false
const resolveCalls = [], allowedReads = new Set([absPath, abiPath])
const call = async (name, input, options) => {
  const value = await harness.call(name, input, options), result = value.structured ?? value
  evidence.tools.push({ name, isError: value.isError === true })
  await fs.appendFile(path.join(output, 'tool-results.jsonl'), JSON.stringify({ name, input, isError: value.isError, result }) + '\n')
  return result
}
try {
  renderer = await serveRendererBuild(build)
  const { ELECTRON_RUN_AS_NODE, AILY_CHILD_PATH, NODE_PATH, ...env } = process.env
  app = await _electron.launch({ cwd: repo, args: ['.', '--serve', `--user-data-dir=${path.join(suite, 'electron-profile')}`],
    timeout: 60000, env: { ...env, AILY_E2E: '1', AILY_APPDATA_PATH: appData, HOME: home, USERPROFILE: home,
      AILY_DEV_RENDERER_URL: renderer.origin, npm_config_offline: 'true', npm_config_audit: 'false' } })
  hostPid = await app.evaluate(() => process.pid)
  evidence.hostPid = hostPid
  await app.firstWindow()
  const deadline = Date.now() + 60000
  while (!page && Date.now() < deadline) {
    page = app.windows().find(value => value.url().startsWith(renderer.origin))
    if (!page) await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(page)
  page.on('dialog', dialog => dialog.dismiss())
  await page.goto(renderer.origin, { waitUntil: 'domcontentloaded' })
  await page.locator('app-main-window').waitFor({ timeout: 60000 })
  await page.evaluate(target => { location.hash = '#/main/blockly-editor?path=' + encodeURIComponent(target) }, project)
  await page.waitForFunction(target => {
    const mainElement = document.querySelector('blockly-main'), editorElement = document.querySelector('app-blockly-editor')
    if (!window.ng || !mainElement || !editorElement) return false
    const main = window.ng.getComponent(mainElement)
    const editor = window.ng.getComponent(editorElement)
    return main?.projectService?.currentProjectPath?.replaceAll('\\', '/') === target.replaceAll('\\', '/') &&
      main.projectService.getBlocklyProjectLoadStatus(target)?.ready === true && editor?._builderService?.isInstallInProgress() === false
  }, project, { timeout: 60000 })
  Object.assign(process.env, { AILY_LIBRARY_HOST_PID: String(hostPid), AILY_APPDATA_PATH: appData,
    PI_CODING_AGENT_DIR: profileRoot, HOME: home, USERPROFILE: home, PI_OFFLINE: '1', npm_config_offline: 'true', npm_config_audit: 'false' })
  const mod = relative => import(pathToFileURL(path.join(agentRoot, 'dist', relative + '.js')).href)
  const { registerProjectRecover } = await mod('blockly/tools/registrars/project/project-recover')
  const { createBlocklyToolRegistry } = await mod('blockly/tools/registry')
  const { resolveAbsConflict } = await mod('blockly/services/abs/generation-resolution')
  const { tryLiveBlocklyOperation } = await mod('blockly/services/app/live-operation')
  const { registerAbsApply } = await mod('blockly/tools/registrars/abs/abs-apply')
  const { absApplyLiveFirst } = await mod('blockly/services/abs/live')
  harness = await createRecoveredAgentHarness({ agentRoot, sourceProject: project, globalRoot: root, profileRoot,
    persistToolTranscript: true,
    configureRegistry(context) {
      const registry = createBlocklyToolRegistry(context.workspace, context.workspaceHistory, 'blockly')
      registerProjectRecover({ ...context, registry }, { resolve: (project, token, choice, _transport, observation) =>
        resolveAbsConflict(project, token, choice, async (target, operation, input) => {
          resolveCalls.push({ observe: input.observe === true, tokenHash: hash(input.token), choice: input.choice })
          const result = await tryLiveBlocklyOperation(target, operation, input)
          if (loseAck && !ackLost && !input.observe && result?.ok === true) {
            ackLost = true
            return { ok: false, transportError: true } // Only lose the actual committed acknowledgement.
          }
          return result
        }, observation) })
      context.registry.replaceOwned(['project_recover'], registry.definitions())
      if (inspectProbe) {
        const applyRegistry = createBlocklyToolRegistry(context.workspace, context.workspaceHistory, 'blockly')
        registerAbsApply({ ...context, registry: applyRegistry }, 'abs_apply', async (...args) => {
          if (!probeInjected) {
            probeInjected = true
            throw Error('Suite-owned unknown apply failure before any host operation')
          }
          return absApplyLiveFirst(...args)
        })
        context.registry.replaceOwned(['abs_apply'], applyRegistry.definitions())
      }
    },
    permissionApproval(request) {
      if (['read', 'write', 'edit'].includes(request.toolName)) return request.toolName === 'read'
        ? allowedReads.has(request.input?.path) : same(request.input?.path ?? '', absPath)
      return ['project_recover', 'abs_export', 'abs_validate', 'abs_apply', 'project_build', 'app_close'].includes(request.toolName)
        && same(request.input?.project ?? '', project)
    } })
  const initial = await call('project_recover', { project, action: 'inspect' }), repair = initial.diagnostics?.repair
  if (repair) assert.equal((await call('project_recover', { project, action: 'repair', token: repair.token, authority: repair.authority })).repairVerification?.ok, true)
  assert.equal((await call('abs_export', { project })).ok, true)
  await harness.settle()
  evidence.turnStart = await harness.beginTurn('Resolve the explicit saved-ABI/canvas source conflict, preserve the pending print, then deliberately rebuild it on the fresh baseline, apply and compile. Never upload.')
  assert.equal(evidence.turnStart.actualSdkBeforeAgentStart, true)
  let exported = await call('abs_export', { project })
  assert.equal(exported.ok, true)
  await call('read', { path: absPath, limit: 30 })
  await call('write', { path: absPath, content: exported.abs })
  const marker = 'source_resolution_' + randomUUID().slice(0, 8), anchor = exported.abs.match(/^arduino_setup\(\)[^\r\n]*$/m)?.[0]
  assert.ok(anchor)
  assert.equal(exported.abs.split(anchor).length, 2)
  await call('edit', { path: absPath, edits: [{ oldText: anchor, newText: `${anchor}\n    serial_print(Serial, text("${marker}"))` }] })
  if (inspectProbe) {
    const unknown = await call('abs_apply', { project, generation: exported.generation, absPath }, { expectError: true })
    assert.equal(probeInjected, true)
    assert.equal(unknown.ok, false)
    assert.equal(unknown.publication, undefined, 'An injected unknown exception is not a definite rollback receipt')
    assert.equal(harness.guard.snapshot(project).status, 'blocked')
    assert.equal(harness.guard.snapshot(project).concurrentEdit, undefined)
    const healthy = await call('project_recover', { project, action: 'inspect' })
    assert.equal(healthy.ok, true)
    assert.equal(healthy.diagnostics?.repair, undefined, 'The host must remain healthy; this is no mutation/recovery offer')
    assert.equal(healthy.conflictResolution, undefined)
    assert.equal(healthy.candidateArtifact.hash, unknown.candidateArtifact.hash)
    allowedReads.add(healthy.candidateFile)
    assert.ok(JSON.stringify(await call('read', { path: healthy.candidateFile, limit: 40 })).includes(marker))
    assert.equal(harness.guard.snapshot(project).status, 'blocked', 'Inspection must not release the unapplied intent')
    evidence.healthyInspectCandidateRead = { ok: true, hostOperationDispatched: false, hash: healthy.candidateArtifact.hash,
      candidateApplied: false, readThroughActualAgent: true, noRecoveryOffer: true }
    exported = await call('abs_export', { project })
    assert.equal(exported.ok, true)
    await call('read', { path: absPath, limit: 30 })
    await call('write', { path: absPath, content: exported.abs })
    const restoredAnchor = exported.abs.match(/^arduino_setup\(\)[^\r\n]*$/m)?.[0]
    assert.ok(restoredAnchor)
    await call('edit', { path: absPath, edits: [{ oldText: restoredAnchor,
      newText: `${restoredAnchor}\n    serial_print(Serial, text("${marker}"))` }] })
  }
  const edited = await page.evaluate(() => {
    const main = window.ng.getComponent(document.querySelector('blockly-main'))
    const block = window.Blockly.getMainWorkspace().getAllBlocks(false).find(value => value.type === 'math_number' && !value.isShadow())
    if (!block) throw Error('Need an ordinary number block in the private C3 fixture')
    const previewToken = main.generatedArtifactRetryToken
    block.setFieldValue('71', 'NUM')
    return { id: block.id, previewToken }
  })
  const numberId = edited.id
  await page.waitForFunction(previous => {
    const main = window.ng.getComponent(document.querySelector('blockly-main'))
    return main.generatedArtifactRetryToken > previous && !main.backgroundCodeGenerationInProgress && !main.generatedArtifactRetryTimer
  }, edited.previewToken, { timeout: 15000 })
  await page.waitForFunction(() => window.ng.getComponent(document.querySelector('app-header')).hasUnsavedProjectChanges)
  const external = JSON.parse(await fs.readFile(abiPath, 'utf8')), externalNumber = find(external, numberId)
  assert.ok(externalNumber)
  externalNumber.fields.NUM = typeof externalNumber.fields.NUM === 'string' ? '70' : 70
  const externalText = JSON.stringify(external)
  await fs.writeFile(abiPath, externalText) // Owned external-writer fault only; Agent program edits use real SDK tools above/below.
  const failed = await call('abs_apply', { project, generation: exported.generation, absPath }, { expectError: true })
  assert.equal(failed.ok, false)
  assert.ok(failed.candidateFile, 'A refused apply must retain its exact original submitted candidate')
  allowedReads.add(failed.candidateFile)
  assert.ok(JSON.stringify(await call('read', { path: failed.candidateFile, limit: 40 })).includes(marker))
  assert.equal(harness.guard.snapshot(project)?.concurrentEdit, true)
  const inspected = await call('project_recover', { project, action: 'inspect' })
  assert.equal(inspected.conflictResolution?.inputAbiHash, hash(externalText))
  const input = { project, action: 'resolve', token: inspected.conflictResolution.token, choice }
  let resolved = await call('project_recover', input, loseAck ? { expectError: true } : undefined)
  if (loseAck) {
    assert.equal(resolved.publication.status, 'UNKNOWN')
    assert.equal(harness.guard.snapshot(project).resolutionPending.token, input.token)
    const observed = await call('project_recover', { project, action: 'inspect' })
    assert.equal(observed.completedResolution?.token, input.token)
    resolved = await call('project_recover', input)
    assert.equal(resolved.receipt.observe, true)
  }
  assert.equal(resolved.ok, true)
  assert.equal(resolved.resolutionVerification.candidateApplied, false)
  assert.equal(resolved.receipt.source.kind, choice === 'keep_view' ? 'workspace' : 'saved-abi')
  assert.equal(resolved.recoveryArchive.files.abi.hash, hash(externalText))
  assert.equal(resolved.abs.includes(marker), false, 'Source resolution must not smuggle in the unapplied candidate')
  assert.equal(harness.guard.snapshot(project).concurrentEdit, undefined)
  assert.equal(harness.guard.snapshot(project).status, 'blocked', 'The requested print still requires tracked application')
  const selected = JSON.parse(await fs.readFile(abiPath, 'utf8'))
  assert.equal(Number(find(selected, numberId)?.fields?.NUM), choice === 'keep_view' ? 71 : 70)
  allowedReads.add(resolved.candidateFile)
  const retained = await call('read', { path: resolved.candidateFile })
  assert.ok(JSON.stringify(retained).includes(marker))
  assert.equal(resolved.candidateArtifact.hash, failed.candidateArtifact.hash)
  await call('read', { path: absPath, limit: 30 })
  await call('write', { path: absPath, content: resolved.abs })
  const freshAnchor = resolved.abs.match(/^arduino_setup\(\)[^\r\n]*$/m)?.[0]
  assert.ok(freshAnchor)
  await call('edit', { path: absPath, edits: [{ oldText: freshAnchor, newText: `${freshAnchor}\n    serial_print(Serial, text("${marker}"))` }] })
  assert.equal((await call('abs_validate', { project, generation: resolved.generation, absPath })).ok, true)
  assert.equal((await call('abs_apply', { project, generation: resolved.generation, absPath })).ok, true)
  let compiled = await call('project_build', { project }), attempts = 0
  while (compiled.buildOutcome === 'unknown' && compiled.pendingBuild?.resumable === true && attempts++ < 10) {
    const pending = compiled.pendingBuild
    assert.equal(pending.tool, 'project_build')
    assert.equal(pending.arguments.build_target_pid, hostPid)
    assert.ok(same(pending.arguments.project, project))
    compiled = await call(pending.tool, pending.arguments)
  }
  assert.equal(compiled.ok, true)
  assert.equal(compiled.buildReceipt?.state, 'completed')
  assert.deepEqual(resolveCalls.map(value => value.observe), loseAck ? [false, true] : [false])
  const proof = harness.proof()
  assert.equal(proof.actualSdkSession, true)
  assert.equal(proof.actualPiToolCallHooks, true)
  assert.equal(proof.actualPermissionSystem, true)
  await harness.settle()
  evidence.actualSdkSuccessfulTurnSettled = true
  Object.assign(evidence, { ok: true, oldCandidateNotAppliedByResolution: true, selectedNumber: choice === 'keep_view' ? 71 : 70,
    resolutionVerification: resolved.resolutionVerification, buildReceipt: compiled.buildReceipt, resolveCalls, proof })
  await call('app_close', { project })
} catch (error) { evidence.failure = { message: error.message, stack: error.stack }; process.exitCode = 1 }
finally {
  await harness?.dispose().catch(error => { evidence.cleanupFailure = error.message; process.exitCode = 1 })
  if (app) {
    const child = app.process()
    const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Owned Host did not exit after test shutdown')), 10000)
      child.once('exit', () => { clearTimeout(timer); resolve() })
    })
    await app.evaluate(({ app }, expected) => {
      if (process.pid !== expected.pid || process.env.AILY_APPDATA_PATH !== expected.appData) throw Error('Refuse unrelated Host shutdown')
      app.exit(0)
    }, { pid: hostPid, appData }).catch(error => { evidence.shutdownObservation = error.message })
    await exited.catch(error => { evidence.cleanupFailure = error.message; process.exitCode = 1 })
    evidence.hostExited = child.exitCode !== null || child.signalCode !== null
  }
  await renderer?.close()
  assert.deepEqual(await sourceHashes(), sourceBefore)
  evidence.sourceSeedPreserved = true
  evidence.ok &&= process.exitCode !== 1
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(evidence, null, 2))
  console.log(evidence.ok ? 'PASS' : 'FAIL', path.join(output, 'result.json'))
}
