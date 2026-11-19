import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { _electron } from '@playwright/test'

import { createRecoveredAgentHarness } from '../fixtures/abs-agent-tools.mjs'
import { dropOneHostResponse } from '../fixtures/host-response-fault.mjs'
import { serveRendererBuild } from '../fixtures/build-renderer-server.mjs'
import { closeOwnedRepairHost } from '../fixtures/owned-repair-host.mjs'
import { interruptRepairCommit } from '../fixtures/repair-commit-fault.mjs'
import { withoutRepairRoute, withoutPreservationEntry, withLegacyPreservationOnly, repairContinuationAction, resumeRepairTarget } from '../fixtures/repair-environment-acceptance.mjs'

const absolute = name => {
  const value = process.env[name]
  assert.ok(value && path.isAbsolute(value), `${name} must identify an explicit private test path`)
  return path.resolve(value)
}
const root = absolute('AILY_ABS_RECOVERY_TEST_ROOT')
const seed = absolute('AILY_ABS_RECOVERY_SEED')
const agentRoot = absolute('AILY_ABS_AGENT_ROOT')
const hostBuild = absolute('AILY_ABS_RECOVERY_HOST_BUILD')
const output = absolute('AILY_ABS_RECOVERY_OUTPUT')
const inside = (parent, child) => {
  const relative = path.relative(parent, child)
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
}
assert.ok(inside(root, seed), 'Never select a user project as the seed')
assert.ok(inside(path.resolve('e2e/test-results'), output), 'Keep evidence in ignored E2E outputs')
const suite = path.join(root, `agent-recovery-${Date.now()}`)
const source = path.join(suite, 'source-native')
const failedSource = path.join(suite, 'source-load-failed')
const closedSource = path.join(suite, 'source-closed-legacy')
const opaqueSource = path.join(suite, 'source-opaque-canvas')
const unknownViewSource = path.join(suite, 'source-unknown-view')
const library = path.join(suite, 'fixture-library')
const home = path.join(root, 'isolated-home')
const ids = ['recovery-enabled', 'recovery-disabled']
const extra = { version: 3, params: [{ name: 'value', type: 'int', values: [0, 91, null] }],
  dictionary: { note: '界😀', preserved: true } }
const evidence = { isolation: { userProjectsModified: false, simulatorInvoked: false, uploaded: false,
  dailyInstallReplaced: false }, scenarios: [] }
const protectedSnapshots = new Map()
const protectedOwnerRecords = new Map()
let app, page, harness, renderer, repairChild, nestedRepairChild
const log = (...args) => console.log(new Date().toISOString(), ...args)
const files = ['package.json', 'project.abi', 'project.abs', 'project.abs.map.json',
  'pending-recovery-note.txt', '.aily/abs-sync/committed.json']
const snapshot = async project => Object.fromEntries(await Promise.all(files.map(async file => {
  try { return [file, await fs.readFile(path.join(project, file))] }
  catch (error) { if (error.code === 'ENOENT') return [file, null]; throw error }
})))
const preserved = async (project, before) => assert.deepEqual(await snapshot(project), before, 'Source bytes must remain exact')
async function prepare(project, missingLibrary) {
  await fs.mkdir(project, { recursive: true })
  for (const file of ['package.json', 'package-lock.json', 'project.abi', 'node_modules'])
    await fs.cp(path.join(seed, file), path.join(project, file), { recursive: true })
  if (!missingLibrary) await fs.cp(library, path.join(project, 'node_modules/@aily-project/lib-realm-fixture'), { recursive: true })
  const manifest = JSON.parse(await fs.readFile(path.join(project, 'package.json'), 'utf8'))
  manifest.name = path.basename(project)
  manifest.nickname = 'Isolated Agent recovery acceptance'
  // The failed fixture models an unknown block from a missing library, not an
  // npm download failure. Never make this deterministic test contact a registry.
  if (!missingLibrary) manifest.dependencies['@aily-project/lib-realm-fixture'] = '1.0.0'
  delete manifest.buildInfo
  delete manifest.codeHash
  await fs.writeFile(path.join(project, 'package.json'), JSON.stringify(manifest, null, 2))
  const document = JSON.parse(await fs.readFile(path.join(project, 'project.abi'), 'utf8'))
  const blocks = document.pages[0].content.blocks.blocks
  ids.forEach((id, i) => blocks.push({ type: 'realm_state_fixture', id, x: 650, y: 80 + i * 150,
    deletable: false, collapsed: true, ...(i ? { disabledReasons: ['MANUALLY_DISABLED'] } : {}),
    fields: { PICK: 'B' }, extraState: extra }))
  await fs.writeFile(path.join(project, 'project.abi'), JSON.stringify(document))
}
async function open(project, ready) {
  log('OPEN', project, ready)
  await page.evaluate(target => { location.hash = '#/main/blockly-editor?path=' + encodeURIComponent(target) }, project)
  await page.waitForFunction(({ project, ready }) => {
    const element = document.querySelector('blockly-main')
    if (!element) return false
    const component = window.ng?.getComponent(element)
    const service = component?.projectService
    if (!service || service.currentProjectPath?.replaceAll('\\', '/') !== project.replaceAll('\\', '/')) return false
    const status = service.getBlocklyProjectLoadStatus(project)
    return ready ? status?.ready === true : status?.ready === false && status.state === 'error'
  }, { project, ready }, { timeout: 60000 })
}
async function canvas() {
  return page.evaluate(ids => ids.map(id => {
    const block = window.Blockly.getMainWorkspace().getBlockById(id)
    return { id, exists: !!block, extra: block?.saveExtraState(), dropdown: block?.getFieldValue('PICK'),
      disabled: block ? !block.isEnabled() : undefined, collapsed: block?.isCollapsed(), deletable: block?.isDeletable() }
  }), ids)
}
async function checkCanvas() {
  const values = await canvas()
  for (const value of values) {
    assert.equal(value.exists, true)
    assert.deepEqual(value.extra, extra)
    assert.equal(value.dropdown, 'B')
    assert.equal(value.disabled, value.id === ids[1])
    assert.equal(value.collapsed, true)
    assert.equal(value.deletable, false)
  }
}
async function launchParent(profileName) {
  const { ELECTRON_RUN_AS_NODE, ...env } = process.env
  app = await _electron.launch({ args: ['.', '--serve', `--user-data-dir=${path.join(suite, profileName)}`],
    cwd: process.cwd(), timeout: 60000, env: { ...env, AILY_E2E: '1',
      AILY_APPDATA_PATH: path.join(root, 'appdata'), HOME: home, USERPROFILE: home,
      AILY_DEV_RENDERER_URL: renderer.origin } })
  await app.firstWindow()
  const deadline = Date.now() + 60000
  page = undefined
  while (!page && Date.now() < deadline) {
    page = app.windows().find(candidate => candidate.url().startsWith(renderer.origin) || /^chrome-error:/.test(candidate.url()))
    if (!page) await new Promise(resolve => setTimeout(resolve, 200))
  }
  assert.ok(page)
  page.on('dialog', dialog => dialog.dismiss())
  page.on('console', event => { if (event.type() === 'error') log('RENDERER_ERROR', event.text().slice(0, 1500)) })
  await page.goto(renderer.origin)
  await page.locator('app-main-window').waitFor({ timeout: 60000 })
  const pid = await app.evaluate(() => process.pid)
  Object.assign(process.env, { AILY_LIBRARY_HOST_PID: String(pid), AILY_APPDATA_PATH: path.join(root, 'appdata'),
    HOME: home, USERPROFILE: home, PI_OFFLINE: '1' })
  return pid
}
async function createHarness(project, options = {}) {
  const profileRoot = path.join(suite, 'agent-profile-' + path.basename(project))
  process.env.PI_CODING_AGENT_DIR = profileRoot
  return createRecoveredAgentHarness({ agentRoot, sourceProject: project, globalRoot: suite, profileRoot,
    ...options, onStage: stage => log('AGENT', stage),
    async configureRegistry(context) {
      const module = await import(pathToFileURL(path.join(agentRoot,
        'dist/blockly/tools/registrars/library/lib-install-local.js')).href)
      module.registerLibInstallLocal(context)
    },
    permissionApproval(request) {
      assert.equal(request.permissionMode, 'default')
      const input = request.input ?? {}
      if (['read', 'write', 'edit'].includes(request.toolName)) {
        if (typeof input.path !== 'string' || !path.isAbsolute(input.path)) return false
        if (request.toolName === 'read' && harness?.history.retainedReadRoots?.some(view => inside(view, input.path)))
          return inside(suite, input.path)
        const owner = [project, ...request.associatedProjects].find(root => inside(root, input.path))
        if (!owner || !inside(suite, owner)) return false
        if (request.toolName === 'read') return true
        return owner !== project ? input.path === path.join(owner, 'project.abs')
          : !harness?.guard.snapshot(project)?.concurrentEdit
            && ['project.abs', 'pending-recovery-note.txt'].some(name => input.path === path.join(project, name))
      }
      return typeof input.project === 'string' && inside(suite, input.project)
        && (request.toolName !== 'lib_install_local' || input.source === library)
    }
  })
}
async function call(name, input, expectError = false, allowError = false) {
  log('TOOL', name, input.action ?? '', input.project ?? input.path ?? '')
  const result = await harness.call(name, input, { expectError, allowError })
  const structured = result.structured
  await fs.appendFile(path.join(output, 'tool-results.jsonl'), JSON.stringify({ name, input,
    isError: result.isError, structured, ...(!structured ? { text: result.text } : {}) }) + '\n')
  return structured ?? result
}
async function editApplyBuild(target, generation, { separateHost = false, finalValue = 42 } = {}) {
  const file = path.join(target, 'project.abs')
  const text = await harness.readText(file)
  const pattern = /variable_define\("chain_counter", int, math_number\(\d+\)\)/
  assert.match(text, pattern, 'The real read must contain the fixture variable definition')
  // All candidate IO below uses actual registered Agent core tools, never fs.
  await harness.write(file, text.replace(pattern, 'variable_define("chain_counter", int, math_number(41))'))
  await harness.edit(file, 'math_number(41)', `math_number(${finalValue})`)
  const written = await harness.readText(file)
  assert.match(written, new RegExp(`variable_define\\("chain_counter", int, math_number\\(${finalValue}\\)\\)`))
  const applied = await call('abs_apply', { project: target, generation, absPath: file })
  assert.equal(applied.ok, true)
  if (!separateHost) await checkCanvas()
  else {
    // Receipt readback proves the live target. This additional disk assertion
    // must not ask the deliberately broken original serializer for a snapshot.
    const document = JSON.parse(await fs.readFile(path.join(target, 'project.abi'), 'utf8'))
    const blocks = document.pages.flatMap(page => page.content.blocks.blocks)
    for (const id of ids) {
      const block = blocks.find(block => block.id === id)
      assert.ok(block)
      assert.deepEqual(block.extraState, extra)
      assert.equal(block.collapsed, true)
      assert.equal(block.deletable, false)
      assert.equal(block.disabledReasons?.includes('MANUALLY_DISABLED') ?? false, id === ids[1])
    }
  }
  const built = await call('project_build', { project: target })
  assert.equal(built.ok, true)
  assert.equal(built.buildExecutionKind, 'compilation')
  assert.equal(built.buildReceipt?.state, 'completed')
  assert.equal(path.resolve(built.buildReceipt.project), path.resolve(target))
  assert.equal(built.verification?.scope, 'project-compilation')
  assert.equal(built.verification.status, 'passed')
  return { actualCoreReadWriteEdit: true, apply: applied.ok, compile: built.ok,
    buildReceipt: built.buildReceipt, compileVerification: built.verification, proof: harness.proof() }
}
async function main() {
  await fs.mkdir(output, { recursive: true })
  await fs.mkdir(suite, { recursive: true })
  await fs.cp(path.resolve('tests/electron/fixtures/realm-library'), library, { recursive: true })
  await prepare(source, false)
  await prepare(failedSource, true)
  await prepare(closedSource, false)
  await prepare(opaqueSource, true)
  await prepare(unknownViewSource, false)
  // A never-opened legacy source must not be migrated just to recover it.
  const closedDocument = JSON.parse(await fs.readFile(path.join(closedSource, 'project.abi'), 'utf8'))
  const legacy = { ...closedDocument.pages[0].content, variables: closedDocument.sharedModel.variables ?? [] }
  await fs.writeFile(path.join(closedSource, 'project.abi'), JSON.stringify(legacy))
  await fs.writeFile(path.join(closedSource, 'project.abs'), Buffer.from([0xff, 0xfe, 0x41]))
  const opaqueDocument = JSON.parse(await fs.readFile(path.join(opaqueSource, 'project.abi'), 'utf8'))
  await fs.writeFile(path.join(opaqueSource, 'project.abi'), JSON.stringify({ ...opaqueDocument.pages[0].content,
    variables: opaqueDocument.sharedModel.variables ?? [] }))
  log('BOOTSTRAP', suite)
  renderer = await serveRendererBuild(hostBuild)
  const hostPid = await launchParent('electron-profile')
  evidence.hostPid = hostPid
  await open(source, true)
  await checkCanvas()
  harness = await createHarness(source, { persistToolTranscript: true })
  const initial = await call('abs_export', { project: source, initialize: true })
  assert.equal(initial.ok, true)
  const originalDraft = await harness.readText(path.join(source, 'project.abs'))
  const definition = originalDraft.match(/variable_define\("chain_counter", int, math_number\(\d+\)\)/)?.[0]
  assert.ok(definition)
  await harness.edit(path.join(source, 'project.abs'), definition,
    definition.replace(/math_number\(\d+\)/, 'math_number(19)'))
  await harness.write(path.join(source, 'pending-recovery-note.txt'), 'Retain this unpublished source file.\n')
  const sourceDraftView = harness.history.executionRoot
  // Deliberate fixture fault, not an Agent edit or recovery implementation:
  // retain the corrupt bytes and prove recovery never rewrites/deletes them.
  const pointer = path.join(source, '.aily/abs-sync/committed.json')
  await fs.writeFile(pointer, '{deliberate-isolated-corruption')
  const before = await snapshot(source)
  protectedSnapshots.set(source, before)
  const inspected = await call('project_recover', { project: source, action: 'inspect' }, true)
  assert.equal(inspected.code, 'ABS_BASELINE_CORRUPT')
  assert.deepEqual(inspected.nextAction, { tool: 'project_recover', input: { project: source, action: 'fork' } })
  harness.guard.recordConflict(source, { ok: false, code: 'ABS_SOURCE_CONFLICT', error: 'Isolated source intent must survive recovery' })
  await page.evaluate(() => {
    const editor = window.ng.getComponent(document.querySelector('blockly-main')).blocklyService
    const lease = editor.acquireWorkspaceEditLease()
    lease.quarantine('Isolated source quarantine')
    lease.release()
    if (!editor.isWorkspaceEditBlocked() || editor.isWorkspaceEditInProgress())
      throw new Error('The isolated source must be quarantined without an active writer')
  })
  const quarantined = await call('project_recover', { project: source, action: 'inspect' }, true)
  // Read-only inspection may encounter the corrupt pointer first; neither
  // error changes the independent native quarantine or permits source writes.
  assert.ok(['ABS_BASELINE_CORRUPT', 'ABS_WORKSPACE_QUARANTINED'].includes(quarantined.code))
  assert.deepEqual(quarantined.nextAction, { tool: 'project_recover', input: { project: source, action: 'fork' } })
  const responseFault = dropOneHostResponse(payload => payload.operation === 'project_fork'
    && payload.path === source && payload.params?.targetPath === path.join(suite, 'target-native'))
  let lost
  try {
    lost = await call('project_recover', { project: source, action: 'fork', targetPath: path.join(suite, 'target-native') }, true)
    assert.equal(responseFault.dropped?.result?.projectSaved, true, 'The real host saved before its acknowledgement was lost')
    assert.equal(lost.code, 'PROJECT_FORK_OUTCOME_UNKNOWN')
    assert.equal(lost.nextAction?.input?.action, 'observe_fork')
  } finally { responseFault.restore() }
  const targetsBeforeObservation = await fs.readdir(suite)
  const fork = await call(lost.nextAction.tool, lost.nextAction.input)
  assert.equal(fork.forkVerification.sourceComplete, true)
  assert.equal(fork.workspaceAssociation.ok, true)
  assert.deepEqual(await fs.readdir(suite), targetsBeforeObservation, 'Observing a fork must not create a second project')
  const fresh = fork.projectionReady ? fork : await call(fork.nextAction.tool, fork.nextAction.input)
  assert.ok(fresh.generation)
  assert.equal(harness.binding.root, source)
  assert.ok(harness.guard.snapshot(source).concurrentEdit)
  await call('write', { path: path.join(source, 'project.abs'), content: 'must not execute' }, true)
  const native = await editApplyBuild(fork.project, fresh.generation)
  await harness.settle()
  await preserved(source, before)
  assert.equal(await harness.readText(path.join(sourceDraftView, 'pending-recovery-note.txt')),
    'Retain this unpublished source file.\n')
  assert.match(await harness.readText(path.join(sourceDraftView, 'project.abs')), /math_number\(19\)/)
  await assert.rejects(fs.stat(path.join(source, 'pending-recovery-note.txt')), { code: 'ENOENT' })
  assert.equal(await fs.readFile(pointer, 'utf8'), '{deliberate-isolated-corruption')
  assert.ok(harness.guard.snapshot(source).concurrentEdit)
  const sessionSnapshot = harness.sessionSnapshot(), association = [...harness.binding.associatedProjectRoots]
  await fs.writeFile(path.join(output, 'source-session.json'), JSON.stringify(sessionSnapshot, null, 2))
  const heldGuard = harness.guard.snapshot(source)
  await harness.dispose(); harness = undefined
  harness = await createHarness(source, { sessionSnapshot, restoreHistory: true, expectedAssociation: association })
  assert.deepEqual(harness.guard.snapshot(source), heldGuard)
  const index = JSON.parse(await harness.readText(path.join(source, '.workspace-history/preserved-index.json')))
  assert.equal(index.readOnly, true)
  const manifest = JSON.parse(await harness.readText(index.views[0].manifestPath))
  assert.equal(manifest.canonicalWritten, false)
  const pending = manifest.unpublishedFiles.find(file => file.relativePath === 'pending-recovery-note.txt')
  assert.ok(pending)
  assert.equal(await harness.readText(pending.path), 'Retain this unpublished source file.\n')
  await call('write', { path: pending.path, content: 'must remain immutable after restart' }, true)
  await harness.settle()
  await preserved(source, before)
  evidence.scenarios.push({ kind: 'corrupt-baseline-plus-quarantine', source, target: fork.project,
    sourceBytesPreserved: true, sourceGuardPreserved: true, lostAcknowledgementObserved: true,
    duplicateCopyAvoided: true, sourceSettlementDidNotPublish: true, allUnpublishedSourceFilesRetained: true,
    sdkRestartRetainedReadOnly: true, restartedProof: harness.proof(), ...native })
  const toolProofOnly = withoutPreservationEntry(harness.sessionSnapshot())
  await harness.dispose(); harness = undefined
  harness = await createHarness(source, { sessionSnapshot: toolProofOnly, restoreHistory: true, expectedAssociation: association })
  const proofIndex = JSON.parse(await harness.readText(path.join(source, '.workspace-history/preserved-index.json')))
  assert.ok(proofIndex.views.length > 0, 'The actual paired recovery result must restore its complete strong reference')
  const proofManifest = JSON.parse(await harness.readText(proofIndex.views[0].manifestPath))
  const proofNote = proofManifest.unpublishedFiles.find(file => file.relativePath === 'pending-recovery-note.txt')
  assert.equal(await harness.readText(proofNote.path), 'Retain this unpublished source file.\n')
  await call('write', { path: proofNote.path, content: 'must not publish the source' }, true)
  await harness.settle(); await preserved(source, before)
  assert.deepEqual(harness.guard.snapshot(source), heldGuard)
  evidence.scenarios.push({ kind: 'paired-strong-reference-without-custom-entry', source,
    actualToolResultProof: true, sourceGuardPreserved: true, unpublishedOtherFileReadOnly: true, proof: harness.proof() })
  const legacySnapshot = withLegacyPreservationOnly(harness.sessionSnapshot())
  await fs.writeFile(path.join(output, 'legacy-session.json'), JSON.stringify(legacySnapshot, null, 2))
  await harness.dispose(); harness = undefined
  harness = await createHarness(source, { sessionSnapshot: legacySnapshot, restoreHistory: true,
    expectedAssociation: association })
  const legacyIndex = JSON.parse(await harness.readText(path.join(source, '.workspace-history/preserved-index.json')))
  assert.equal(legacyIndex.views.length, 0, 'An old ABS hash does not prove the entire overlay')
  assert.equal(legacyIndex.legacyAbsCandidates.length, 1)
  const legacyCandidate = legacyIndex.legacyAbsCandidates[0]
  assert.equal(legacyCandidate.scope, 'project.abs-only')
  assert.equal(legacyCandidate.otherFilesVerified, false)
  assert.match(await harness.readText(legacyCandidate.path), /math_number\(19\)/)
  await call('write', { path: legacyCandidate.path, content: 'must remain read-only' }, true)
  await call('read', { path: path.join(sourceDraftView, 'pending-recovery-note.txt') }, true)
  await harness.settle()
  await preserved(source, before)
  assert.deepEqual(harness.guard.snapshot(source), heldGuard)
  evidence.scenarios.push({ kind: 'legacy-sealed-abs-with-exact-historical-hash', source,
    exactAbsRestoredThroughCoreRead: true, otherOldViewFilesNotAuthorized: true,
    sourceDiskAndGuardPreserved: true, proof: harness.proof() })
  await harness.dispose(); harness = undefined
  await open(failedSource, false)
  const failedBefore = await snapshot(failedSource)
  protectedSnapshots.set(failedSource, failedBefore)
  harness = await createHarness(failedSource)
  harness.guard.recordConflict(failedSource, { ok: false, code: 'ABS_SOURCE_CONFLICT', error: 'Keep failed source intent' })
  const loadInspection = await call('project_recover', { project: failedSource, action: 'inspect' })
  assert.equal(loadInspection.inspectionVerification.scope, 'load-recovery-inspection')
  const savedFork = await call('project_recover', { project: failedSource, action: 'fork', targetPath: path.join(suite, 'target-load-failed') })
  assert.equal(savedFork.recoverySource.kind, 'saved-document')
  assert.equal(savedFork.recoverySource.partialCanvas, 'archived')
  assert.equal(savedFork.forkVerification.sourceComplete, true)
  assert.equal(savedFork.workspaceAssociation.ok, true)
  assert.deepEqual(await fs.readFile(path.join(savedFork.project, 'project.abi')), failedBefore['project.abi'])
  assert.ok(savedFork.recoveryArchive)
  const savedInspection = await call('project_recover', { project: savedFork.project, action: 'inspect' })
  assert.deepEqual(savedInspection.nextAction, { tool: 'project_status', input: { project: savedFork.project } })
  await call(savedInspection.nextAction.tool, savedInspection.nextAction.input)
  const installed = await call('lib_install_local', { project: savedFork.project, source: library })
  assert.equal(installed.filesInstalled, true)
  assert.equal(installed.runtimeSync.recoveryReload.ready, true)
  assert.ok(installed.generation)
  const recovered = await editApplyBuild(savedFork.project, installed.generation)
  await harness.settle()
  await preserved(failedSource, failedBefore)
  assert.ok(harness.guard.snapshot(failedSource).concurrentEdit)
  assert.equal(harness.binding.root, failedSource)
  evidence.scenarios.push({ kind: 'initial-load-failure-missing-library', source: failedSource, target: savedFork.project,
    completeDiskPrimary: true, partialCanvasSeparatelyArchived: true, managedLibraryRepair: true,
    normalReload: true, sourceBytesPreserved: true, sourceGuardPreserved: true, ...recovered })
  await harness.dispose(); harness = undefined
  // Simulate a user closing the preceding private project, never the source to
  // recover. All recovery/navigation afterwards uses actual Agent tools.
  await page.evaluate(async () => {
    const service = window.ng.getComponent(document.querySelector('blockly-main')).projectService
    await service.close()
    if (service.currentProjectPath) throw new Error('Private project did not close')
  })
  const closedBefore = await snapshot(closedSource)
  protectedSnapshots.set(closedSource, closedBefore)
  harness = await createHarness(closedSource)
  harness.guard.recordConflict(closedSource, { ok: false, code: 'ABS_SOURCE_CONFLICT', error: 'Preserve closed source intent' })
  const closedGuard = harness.guard.snapshot(closedSource)
  await call('app_open', { project: closedSource }, true)
  const noHost = await call('project_recover', { project: closedSource, action: 'inspect' }, true)
  assert.equal(noHost.code, 'ABS_HOST_REQUIRED')
  assert.equal(noHost.nextAction?.input?.action, 'open')
  const opened = await call(noHost.nextAction.tool, noHost.nextAction.input)
  assert.equal(opened.recoveryOpenVerification?.independentCopy, true)
  assert.equal(opened.workspaceAssociation.ok, true)
  assert.equal(opened.recoverySource.loadFailed, false)
  assert.notEqual(opened.project, closedSource)
  assert.deepEqual(harness.guard.snapshot(closedSource), closedGuard)
  assert.equal(opened.candidateArtifact.encoding, 'binary')
  assert.deepEqual(await fs.readFile(opened.candidateArtifact.path), closedBefore['project.abs'])
  const closedResult = await editApplyBuild(opened.project, opened.generation)
  await harness.settle()
  await preserved(closedSource, closedBefore)
  assert.deepEqual(harness.guard.snapshot(closedSource), closedGuard)
  assert.equal(harness.binding.root, closedSource)
  evidence.scenarios.push({ kind: 'closed-legacy-source-with-invalid-draft', source: closedSource, target: opened.project,
    sourceBytesPreserved: true, sourceGuardPreserved: true, rawDraftArchivedExactly: true,
    sourceNotMigrated: true, ...closedResult })
  await call('app_close', { project: opened.project })
  await harness.dispose(); harness = undefined

  // An unknown view is retained, not called stale. A conclusively exited file
  // writer also stays on disk; the Agent follows the tool's preserving route.
  harness = await createHarness(unknownViewSource)
  const coordination = path.join(unknownViewSource, '.aily')
  await fs.mkdir(coordination, { recursive: true })
  const viewRecord = path.join(coordination, 'project-open.lock')
  const fileRecord = path.join(coordination, 'project-files.write.lock')
  const retired = spawnSync(process.execPath, ['-e', ''], { windowsHide: true })
  assert.equal(retired.status, 0)
  assert.throws(() => process.kill(retired.pid, 0), { code: 'ESRCH' })
  await fs.writeFile(viewRecord, '{"pid":"retained-unconfirmed-view"}')
  await fs.writeFile(fileRecord, JSON.stringify({ pid: retired.pid, token: randomUUID() }))
  for (const file of [viewRecord, fileRecord]) protectedOwnerRecords.set(file, await fs.readFile(file))
  const unknownBefore = await snapshot(unknownViewSource)
  protectedSnapshots.set(unknownViewSource, unknownBefore)
  const rejectedView = await call('app_open', { project: unknownViewSource }, true)
  assert.equal(rejectedView.code, 'PROJECT_VIEW_OWNER_UNKNOWN')
  assert.deepEqual(rejectedView.nextAction, { tool: 'project_recover', input: { project: unknownViewSource, action: 'open' } })
  const copiedView = await call(rejectedView.nextAction.tool, rejectedView.nextAction.input)
  assert.equal(copiedView.recoveryOpenVerification?.independentCopy, true)
  assert.notEqual(copiedView.project, unknownViewSource)
  const copiedResult = await editApplyBuild(copiedView.project, copiedView.generation)
  await harness.settle()
  await preserved(unknownViewSource, unknownBefore)
  for (const [file, bytes] of protectedOwnerRecords) assert.deepEqual(await fs.readFile(file), bytes)
  evidence.scenarios.push({ kind: 'unknown-view-and-exited-file-owner-preserving-copy', source: unknownViewSource,
    target: copiedView.project, unknownViewNotReplaced: true, exitedFileMarkerRetained: true,
    actualAgentFollowedOfferedTool: true, sourceBytesPreserved: true, ...copiedResult })
  await harness.dispose(); harness = undefined
  await open(opaqueSource, false)
  const opaqueBefore = await snapshot(opaqueSource)
  protectedSnapshots.set(opaqueSource, opaqueBefore)
  const originalBlock = await page.evaluate(() => {
    const workspace = window.Blockly.getMainWorkspace()
    // Strict initial-load validation can leave an empty partial canvas. Model
    // a real unsaved native edit without firing autosave into a failed project.
    window.Blockly.Events.disable()
    let block
    try {
      block = workspace.getAllBlocks(false).find(block => block.type === 'serial_println')
        ?? workspace.newBlock('math_number')
      block.setCollapsed(true)
      block.setDeletable(false)
      block.setDisabledReason(true, 'MANUALLY_DISABLED')
      block.initSvg?.(); block.render?.()
    } finally { window.Blockly.Events.enable() }
    window.__opaqueRecoveryBlock = block
    block.saveExtraState = () => { throw new Error('Deliberate isolated native serializer failure') }
    return { id: block.id, type: block.type, disabled: !block.isEnabled(), collapsed: block.isCollapsed(), deletable: block.isDeletable() }
  })
  harness = await createHarness(opaqueSource)
  harness.guard.recordConflict(opaqueSource, { ok: false, code: 'ABS_SOURCE_CONFLICT', error: 'Opaque native source must remain in its renderer' })
  let separate = await call('project_recover', { project: opaqueSource, action: 'fork', targetPath: path.join(suite, 'target-opaque') })
  const originalSeparateFork = separate
  assert.equal(separate.repairEnvironment.hostPid, undefined,
    'A prepared fork must not start a mutating child before target association')
  // Legacy-load fixture fault only, after the real fork was proved/associated:
  // remove its schema marker, never edit an Agent candidate or source file.
  const beforeNormalization = JSON.parse(await fs.readFile(path.join(separate.project, 'project.abi'), 'utf8'))
  delete beforeNormalization.$ailyProjectData
  const normalizationInput = Buffer.from(JSON.stringify(beforeNormalization))
  await fs.writeFile(path.join(separate.project, 'project.abi'), normalizationInput)
  const interruptedAck = await interruptRepairCommit(app, { pid: hostPid, appData: path.join(root, 'appdata'),
    kind: 'final-ack', requestId: separate.forkReceipt.requestId })
  const waitingUntil = Date.now() + 90000
  let ackInterruption
  while (!separate.runtimeAssociation?.ok || !['ready', 'load-failed'].includes(separate.repairEnvironment?.state)) {
    if (separate.repairEnvironment?.hostPid) repairChild = separate.repairEnvironment
    if (separate.code === 'PROJECT_REPAIR_COMMIT_UNCONFIRMED') {
      ackInterruption = separate
      assert.equal(separate.details?.phase, 'final-ack')
      assert.equal(separate.recoverability?.state, 'metadata-commit-unconfirmed')
      assert.equal(separate.nextAction?.input?.action, 'inspect_environment')
    }
    assert.ok(Date.now() < waitingUntil, 'The owned independent host must become observable within the test deadline')
    const action = repairContinuationAction(separate, separate.project)
    await new Promise(resolve => setTimeout(resolve, 500))
    separate = await call(action.tool, action.input, false, true)
  }
  repairChild = separate.repairEnvironment
  assert.ok(ackInterruption, 'The Agent must receive the actionable commit-interruption diagnostic')
  const ackFault = await interruptedAck.restore()
  const settledAck = JSON.parse(await fs.readFile(ackFault.filename, 'utf8'))
  assert.equal(settledAck.state, 'completed')
  assert.equal(settledAck.epoch, repairChild.epoch, 'ACK reconciliation must retain the exact launched epoch')
  evidence.scenarios.push({ kind: 'launched-child-final-ack-interruption', target: separate.project,
    sameAttemptSettled: true, authenticatedEpoch: repairChild.epoch, sourceGuardPreserved: true,
    actionableCommitDiagnostic: true })
  const normalization = separate.recoveryContinuation?.initialNormalization
  assert.equal(normalization?.kind, 'project-data-normalization')
  assert.equal(normalization.beforeAbiHash, 'sha256:' + createHash('sha256').update(normalizationInput).digest('hex'))
  assert.ok(normalization.transitions.length > 0)
  assert.notEqual(repairChild.hostPid, hostPid)
  assert.equal(repairChild.parentHostPid, hostPid)
  assert.equal(repairChild.state, 'load-failed', 'The independent child must first reproduce the real missing-library failure')
  assert.equal(originalSeparateFork.activated, false, 'The parent must not claim source navigation')
  assert.equal(originalSeparateFork.activationBlocked.reason, 'partial-canvas-unavailable')
  assert.equal(originalSeparateFork.recoverySource.partialCanvas, 'unavailable')
  assert.equal(originalSeparateFork.forkVerification.sourceComplete, true)
  const childInspection = await call(separate.nextAction.tool, separate.nextAction.input)
  assert.equal(childInspection.inspectionVerification.scope, 'saved-recovery-load-inspection')
  assert.deepEqual(childInspection.nextAction, { tool: 'project_status', input: { project: separate.project } })
  await call(childInspection.nextAction.tool, childInspection.nextAction.input)
  const childInstalled = await call('lib_install_local', { project: separate.project, source: library })
  assert.equal(childInstalled.runtimeSync.recoveryReload.ready, true)
  assert.ok(childInstalled.generation)
  const childResult = await editApplyBuild(separate.project, childInstalled.generation, { separateHost: true })
  await harness.settle()
  await preserved(opaqueSource, opaqueBefore)
  const childSnapshot = harness.sessionSnapshot(), childAssociation = [...harness.binding.associatedProjectRoots]
  const childGuard = harness.guard.snapshot(opaqueSource)
  await harness.dispose(); harness = undefined
  harness = await createHarness(opaqueSource, { sessionSnapshot: childSnapshot, restoreHistory: true,
    expectedAssociation: childAssociation })
  assert.deepEqual(harness.guard.snapshot(opaqueSource), childGuard)
  const restartedProjection = await call('abs_export', { project: separate.project })
  const restartedChild = await editApplyBuild(separate.project, restartedProjection.generation,
    { separateHost: true, finalValue: 43 })
  await harness.settle()
  await preserved(opaqueSource, opaqueBefore)
  const retainedBlock = await page.evaluate(id => {
    const component = window.ng.getComponent(document.querySelector('blockly-main'))
    const block = window.Blockly.getMainWorkspace().getBlockById(id)
    let failed = false
    try { block.saveExtraState() } catch { failed = true }
    return { sameObject: block === window.__opaqueRecoveryBlock, serializerStillFails: failed,
      project: component.projectService.currentProjectPath, id: block.id, type: block.type,
      disabled: !block.isEnabled(), collapsed: block.isCollapsed(), deletable: block.isDeletable() }
  }, originalBlock.id)
  assert.equal(path.resolve(retainedBlock.project), opaqueSource)
  assert.equal(retainedBlock.sameObject, true)
  assert.equal(retainedBlock.serializerStillFails, true)
  for (const key of Object.keys(originalBlock)) assert.deepEqual(retainedBlock[key], originalBlock[key])
  assert.ok(harness.guard.snapshot(opaqueSource).concurrentEdit)
  evidence.scenarios.push({ kind: 'unserializable-native-source-with-independent-repair-host', source: opaqueSource,
    target: separate.project, repairEnvironment: repairChild, sourceBytesPreserved: true, sourceGuardPreserved: true,
    originalRendererAndBlockIdentityPreserved: true, originalSerializerStillUnavailable: true,
    childInitiallyLoadFailed: true, childManagedLibraryRepair: true, typedInitialNormalization: normalization,
    sdkRestartAfterTargetMutation: true, restartedChild, ...childResult })

  // A missing route hint must not force reuse of the initial fork's ABI hash.
  const routeLessSnapshot = withoutRepairRoute(harness.sessionSnapshot())
  const connectedEnvironment = repairChild
  await harness.dispose(); harness = undefined
  harness = await createHarness(opaqueSource, { sessionSnapshot: routeLessSnapshot, restoreHistory: true,
    expectedAssociation: childAssociation })
  assert.deepEqual(harness.guard.snapshot(opaqueSource), childGuard)
  const continued = await resumeRepairTarget(call, separate.project, environment => { repairChild = environment })
  assert.equal(continued.repairEnvironment.hostPid, connectedEnvironment.hostPid)
  assert.equal(continued.repairEnvironment.epoch, connectedEnvironment.epoch)
  const continuedProjection = await call('abs_export', { project: separate.project })
  const continuedResult = await editApplyBuild(separate.project, continuedProjection.generation,
    { separateHost: true, finalValue: 44 })
  await harness.settle()
  await preserved(opaqueSource, opaqueBefore)
  assert.deepEqual(harness.guard.snapshot(opaqueSource), childGuard)
  evidence.scenarios.push({ kind: 'modified-target-without-route-reference', target: separate.project,
    continuation: continued.recoveryContinuation, sourceGuardPreserved: true, ...continuedResult })

  // Shut down only the authenticated idle child; the native controller must
  // prove exit before creating a new epoch, keeping all earlier receipts.
  const previousEnvironment = repairChild
  await call('app_close', { project: separate.project })
  await closeOwnedRepairHost(agentRoot, previousEnvironment)
  const replacement = await resumeRepairTarget(call, separate.project, environment => { repairChild = environment })
  assert.ok(replacement.repairEnvironment.epoch > previousEnvironment.epoch)
  assert.equal(replacement.repairEnvironment.lineageId, previousEnvironment.lineageId)
  assert.notEqual(replacement.repairEnvironment.environmentId, previousEnvironment.environmentId)
  assert.notEqual(replacement.repairEnvironment.hostPid, previousEnvironment.hostPid)
  const replacementProjection = await call('abs_export', { project: separate.project })
  const replacementResult = await editApplyBuild(separate.project, replacementProjection.generation,
    { separateHost: true, finalValue: 45 })
  await harness.settle()
  await preserved(opaqueSource, opaqueBefore)
  evidence.scenarios.push({ kind: 'confirmed-child-exit-new-epoch', target: separate.project,
    previousEnvironment, repairEnvironment: repairChild, ...replacementResult })

  const parentSnapshot = harness.sessionSnapshot()
  const previousOwner = JSON.parse(await fs.readFile(path.join(root, 'appdata', 'agent-repair-environments',
    'lineages', repairChild.lineageId, 'current.json'), 'utf8'))
  assert.equal(previousOwner.hostPid, repairChild.hostPid)
  assert.equal(previousOwner.environmentId, repairChild.environmentId)
  await harness.dispose(); harness = undefined
  // This is a fault in the suite's owned parent, not a user/simulator process.
  // The unrepresentable original canvas cannot survive this exit; the protocol
  // must explicitly report that fact, while keeping disk and sealed CAS data.
  const previousParent = app
  let parentExitTimer
  const parentExit = new Promise((resolve, reject) => {
    parentExitTimer = setTimeout(() => reject(new Error('The suite-owned parent did not exit')), 15000)
    previousParent.process().once('exit', resolve)
  })
  try {
    await Promise.all([parentExit, previousParent.evaluate(({ app }) => app.exit(0)).catch(() => {})])
  } finally { clearTimeout(parentExitTimer) }
  app = undefined; page = undefined
  const newParentPid = await launchParent('electron-profile-restarted')
  assert.notEqual(newParentPid, hostPid)
  harness = await createHarness(opaqueSource, { sessionSnapshot: parentSnapshot, restoreHistory: true,
    expectedAssociation: childAssociation })
  const interruptedAdoption = await interruptRepairCommit(app, { pid: newParentPid, appData: path.join(root, 'appdata'),
    kind: 'adoption-current', lineageId: repairChild.lineageId, previousOwner })
  let adoptionInterruption, firstChildState
  const adopted = await resumeRepairTarget(async (...args) => {
    const result = await call(...args)
    firstChildState ??= result.childState
    if (result.code === 'PROJECT_REPAIR_COMMIT_UNCONFIRMED') {
      adoptionInterruption = result
      assert.equal(result.details?.phase, 'adoption-current')
      assert.equal(result.recoverability?.state, 'metadata-commit-unconfirmed')
      assert.equal(result.nextAction?.input?.action, 'inspect_environment')
    }
    return result
  }, separate.project, environment => { repairChild = environment })
  const adoptionFault = await interruptedAdoption.restore({ required: false })
  if (adoptionFault) {
    assert.ok(adoptionInterruption, 'Adoption interruption must offer exact-target observation, not an unrelated owner wait')
    const reservedOwner = path.join(path.dirname(adoptionFault.filename), 'owners', `${adoptionFault.value.epoch}.json`)
    const retainedOwner = JSON.parse(await fs.readFile(reservedOwner, 'utf8'))
    assert.equal(retainedOwner.ownerHostPid, newParentPid)
    assert.equal(adopted.repairEnvironment.hostPid, previousOwner.hostPid)
    assert.ok(adopted.repairEnvironment.epoch > retainedOwner.epoch, 'Retry must not overwrite the uncommitted owner declaration')
    evidence.scenarios.push({ kind: 'owner-declaration-current-commit-interruption', target: separate.project,
      retainedEpoch: retainedOwner.epoch, committedEpoch: adopted.repairEnvironment.epoch, sameChild: true,
      sourceGuardPreserved: true, actionableCommitDiagnostic: true })
  } else {
    assert.equal(adoptionInterruption, undefined)
    assert.equal(firstChildState, 'exited', 'Do not silently skip a live or unknown-child adoption fault')
    assert.notEqual(adopted.repairEnvironment.hostPid, previousOwner.hostPid)
    evidence.unexercised ??= []
    evidence.unexercised.push({ kind: 'owner-declaration-current-commit-interruption',
      reason: 'The original child was confirmed exited after parent shutdown; the real replacement route was exercised instead.' })
  }
  assert.equal(adopted.repairEnvironment.parentHostPid, newParentPid)
  assert.equal(adopted.repairEnvironment.sourceView, 'unavailable')
  assert.notEqual(adopted.repairEnvironment.originalViewPreserved, true)
  const adoptedProjection = await call('abs_export', { project: separate.project })
  const adoptedResult = await editApplyBuild(separate.project, adoptedProjection.generation,
    { separateHost: true, finalValue: 46 })
  await harness.settle()
  await preserved(opaqueSource, opaqueBefore)
  assert.deepEqual(harness.guard.snapshot(opaqueSource), childGuard)
  evidence.scenarios.push({ kind: 'same-code-parent-restart', target: separate.project,
    oldParentPid: hostPid, newParentPid, repairEnvironment: repairChild,
    originalMemoryUnavailable: true, sourceDiskAndGuardPreserved: true, ...adoptedResult })

  // The exact-target repair child must save C without navigating away from B.
  // C gets a fresh child under the same native parent, not a global PID bypass.
  const secondSourceBefore = await snapshot(separate.project)
  const nested = await call('project_recover', { project: separate.project, action: 'fork', targetPath: path.join(suite, 'target-nested') })
  assert.equal(nested.forkVerification.sourceComplete, true)
  assert.equal(nested.recoverySource.kind, 'workspace')
  assert.equal(nested.activated, false)
  assert.equal(nested.workspaceAssociation.ok, true)
  assert.equal(nested.runtimeHandoff.ok, true, JSON.stringify(nested))
  assert.equal(nested.runtimeHandoff.repairEnvironment.parentHostPid, newParentPid)
  assert.deepEqual(nested.nextAction, { tool: 'project_recover', input: { project: nested.project, action: 'inspect_environment' } })
  await preserved(separate.project, secondSourceBefore)
  const preparedSnapshot = harness.sessionSnapshot(), preparedAssociation = [...harness.binding.associatedProjectRoots]
  await harness.dispose(); harness = undefined
  harness = await createHarness(opaqueSource, { sessionSnapshot: preparedSnapshot, restoreHistory: true,
    expectedAssociation: preparedAssociation })
  const preparedOpen = await call('app_open', { project: nested.project }, true)
  assert.equal(preparedOpen.code, 'PROJECT_REPAIR_ENVIRONMENT_UNAVAILABLE',
    'A prepared target must retain deny-only affinity across an actual SDK restart')
  assert.deepEqual(harness.guard.snapshot(opaqueSource), childGuard)
  // Isolated dependency fault only; no candidate or user file is edited here.
  const nestedLibrary = path.join(nested.project, 'node_modules/@aily-project/lib-realm-fixture')
  assert.ok(inside(suite, nestedLibrary))
  const actualNestedLibrary = await fs.realpath(nestedLibrary)
  assert.ok(inside(nested.project, actualNestedLibrary), 'Only the new copy may own this fault-injected library')
  const missingLibrary = path.join(nested.project, '.aily/e2e-missing-library')
  await fs.mkdir(missingLibrary, { recursive: true })
  // Keep its real installed package.json: otherwise project opening invokes
  // npm and this would test installation/network behavior instead of loading.
  await fs.rename(path.join(actualNestedLibrary, 'generator.js'), path.join(missingLibrary, 'generator.js'))
  const nestedReady = await resumeRepairTarget(call, nested.project, environment => { nestedRepairChild = environment })
  assert.equal(nestedReady.repairEnvironment.state, 'load-failed')
  assert.notEqual(nestedRepairChild.hostPid, repairChild.hostPid)
  assert.equal(nestedRepairChild.parentHostPid, newParentPid)
  const nestedInspection = await call(nestedReady.nextAction.tool, nestedReady.nextAction.input)
  assert.deepEqual(nestedInspection.nextAction, { tool: 'project_status', input: { project: nested.project } })
  await call(nestedInspection.nextAction.tool, nestedInspection.nextAction.input)
  const existingLibrary = await call('lib_install_local', { project: nested.project, source: library }, true)
  assert.match(existingLibrary.error, /local-library copy already exists.*force=true/)
  await preserved(separate.project, secondSourceBefore)
  // The incomplete library belongs physically to C (asserted before fault
  // injection), not B. Exercise the managed explicit overwrite contract only
  // for that disposable copy; never remove its source library via scripts.
  const nestedInstalled = await call('lib_install_local', { project: nested.project, source: library, force: true })
  assert.equal(nestedInstalled.runtimeSync.recoveryReload.ready, true)
  const nestedResult = await editApplyBuild(nested.project, nestedInstalled.generation, { separateHost: true, finalValue: 47 })
  await harness.settle(); await preserved(opaqueSource, opaqueBefore)
  await preserved(separate.project, secondSourceBefore)
  assert.deepEqual(harness.guard.snapshot(opaqueSource), childGuard)
  await call('app_close', { project: nested.project })
  await closeOwnedRepairHost(agentRoot, nestedRepairChild); nestedRepairChild = undefined
  await preserved(separate.project, secondSourceBefore)
  evidence.scenarios.push({ kind: 'nested-workspace-fork-independent-host-and-library-repair', source: separate.project,
    target: nested.project, originalSourceAndGuardPreserved: true, immediateSourceBytesPreserved: true,
    originKindPreserved: 'workspace', preparedSdkRestartDeniedParentFallback: true,
    managedLibraryRepair: true, distinctChildSameParent: true, ...nestedResult })

  // Historical A can move without invalidating the already independent B.
  // A fresh target-root session has no file permission for either A path.
  await harness.dispose(); harness = undefined
  const movedSource = opaqueSource + '-moved'
  assert.ok(inside(suite, movedSource)); assert.ok(inside(suite, opaqueSource))
  await fs.rename(opaqueSource, movedSource)
  protectedSnapshots.delete(opaqueSource); protectedSnapshots.set(movedSource, opaqueBefore)
  harness = await createHarness(separate.project)
  const movedContinuation = await resumeRepairTarget(call, separate.project, environment => { repairChild = environment })
  assert.equal(movedContinuation.repairEnvironment.parentHostPid, newParentPid)
  const movedProjection = await call('abs_export', { project: separate.project })
  const movedResult = await editApplyBuild(separate.project, movedProjection.generation, { separateHost: true, finalValue: 48 })
  await harness.settle(); await preserved(movedSource, opaqueBefore)
  await assert.rejects(fs.stat(opaqueSource), { code: 'ENOENT' })
  assert.equal(harness.binding.associatedProjectRoots.includes(opaqueSource), false)
  assert.equal(harness.binding.associatedProjectRoots.includes(movedSource), false)
  evidence.scenarios.push({ kind: 'historical-source-moved-target-root-session', target: separate.project,
    sourceBytesPreservedAtMovedPath: true, noHistoricalSourceFileScopeGranted: true, ...movedResult })
  await call('app_close', { project: separate.project })
  evidence.ok = true
}
main().catch(async error => {
  log('FAIL', error.stack ?? String(error))
  // Capture the owning host before normal cleanup, so transport rejection is
  // distinguishable from a dead process without retrying any mutation.
  const hostObservation = {};
  try {
    hostObservation.main = await app?.evaluate(() => ({ pid: process.pid }));
    hostObservation.renderer = await page?.evaluate(() => {
      const component = window.ng?.getComponent(document.querySelector('blockly-main'));
      const project = component?.projectService?.currentProjectPath;
      return { path: location.hash, project, status: project ? component.projectService.getBlocklyProjectLoadStatus(project) : null };
    });
    const runtime = await import(pathToFileURL(path.join(agentRoot, 'dist/blockly/runtime-client.js')).href);
    hostObservation.bridges = (await runtime.discoverBridges(hostObservation.main?.pid ?? evidence.hostPid))
      .map(({ pid, project, developmentMode }) => ({ pid, project, developmentMode }));
  } catch (observationError) { hostObservation.error = observationError.message; }
  await fs.writeFile(path.join(output, 'failure.json'), JSON.stringify({ message: error.message,
    outcome: error.outcome, evidence, hostObservation, agentProof: harness?.proof() }, null, 2)).catch(() => {})
  await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {})
  process.exitCode = 1
}).finally(async () => {
  const cleanupFailure = error => {
    log('OWNED_CLEANUP_FAILED', error.message)
    evidence.cleanupErrors ??= []
    evidence.cleanupErrors.push(error.message)
    process.exitCode = 1
  }
  if (nestedRepairChild) await closeOwnedRepairHost(agentRoot, nestedRepairChild).catch(cleanupFailure)
  if (repairChild) await closeOwnedRepairHost(agentRoot, repairChild).catch(error => {
    cleanupFailure(error)
  })
  await harness?.dispose().catch(cleanupFailure)
  if (app) {
    await app.evaluate(({ app }) => app.quit()).catch(() => {})
    await new Promise(resolve => setTimeout(resolve, 1000))
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {})
  }
  await renderer?.close().catch(cleanupFailure)
  // Read-only postconditions cover actual SDK shutdown and native disposal,
  // not just the point immediately after the last successful recovery tool.
  for (const [project, before] of protectedSnapshots) await preserved(project, before).catch(cleanupFailure)
  for (const [file, bytes] of protectedOwnerRecords)
    await fs.readFile(file).then(actual => assert.deepEqual(actual, bytes)).catch(cleanupFailure)
  if (evidence.ok && process.exitCode !== 1) {
    evidence.cleanupVerified = true
    evidence.sourceBytesPreservedAfterDisposal = true
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(evidence, null, 2))
    log('PASS', JSON.stringify(evidence))
  }
})
