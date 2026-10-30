import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { build as bundle } from 'esbuild'
import { _electron } from '@playwright/test'
import { serveRendererBuild } from '../fixtures/build-renderer-server.mjs'
import { createRecoveredAgentHarness } from '../fixtures/abs-agent-tools.mjs'
import { createAbsProviderSession } from '../fixtures/abs-provider-session.mjs'
import { createAbsStepSubmissionBridge } from '../fixtures/abs-step-submission-bridge.mjs'

const repo = fileURLToPath(new URL('../../', import.meta.url))
const root = path.resolve(process.env.AILY_SAVE_TEST_ROOT ?? '')
const project = path.resolve(process.env.AILY_SAVE_PROJECT ?? '')
const hostBuild = path.resolve(process.env.AILY_SAVE_HOST_BUILD ?? '')
const agentRoot = path.resolve(process.env.AILY_SAVE_AGENT_ROOT ?? '')
const output = path.resolve(process.env.AILY_SAVE_OUTPUT ?? '')
const inside = (parent, value) => { const r = path.relative(parent, value); return r && !r.startsWith('..') && !path.isAbsolute(r) }
assert.match(root.replaceAll('\\', '/'), /\/aily-project\/dev-tests\/[^/]+$/i)
assert.ok(inside(root, project) && /[\\/]serial-agent-[^\\/]+[\\/]project$/.test(project))
assert.ok(inside(path.join(repo, 'e2e/test-results'), output))
assert.ok(process.env.AILY_SAVE_HOST_BUILD && process.env.AILY_SAVE_AGENT_ROOT)
assert.equal((await fs.realpath(project)).toLowerCase(), project.toLowerCase())
await fs.mkdir(output, { recursive: true })
const suite = await fs.mkdtemp(path.join(root, 'save-consistency-'))
const home = path.join(suite, 'home'), profileRoot = path.join(suite, 'agent-profile'), appData = path.join(root, 'appdata')
await fs.mkdir(home)
const sha = value => createHash('sha256').update(value).digest('hex')
const samePath = (left, right) => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
const findBlock = (value, id) => value && typeof value === 'object'
  ? value.id === id && typeof value.type === 'string' ? value : Object.values(value).map(child => findBlock(child, id)).find(Boolean) : undefined
const abiPath = path.join(project, 'project.abi'), absPath = path.join(project, 'project.abs'), mapPath = path.join(project, 'project.abs.map.json')
const evidence = { ok: false, project, suite, hardwareUsed: false, simulatorUsed: false,
  userProjectsModified: false, dailyInstallReplaced: false, actualSdkTools: true, llmInvoked: false, saves: [] }
let renderer, app, page, hostPid, harness
const snapshot = async () => page.evaluate(() => {
  const main = window.ng.getComponent(document.querySelector('blockly-main'))
  const header = window.ng.getComponent(document.querySelector('app-header'))
  return { star: header.hasUnsavedProjectChanges, state: main.projectService.stateSubject.value,
    blocks: window.Blockly.getMainWorkspace().getAllBlocks(false).length }
})
async function launch() {
  const { ELECTRON_RUN_AS_NODE, AILY_CHILD_PATH, NODE_PATH, ...env } = process.env
  app = await _electron.launch({ cwd: repo, args: ['.', '--serve', `--user-data-dir=${path.join(suite, 'electron-profile')}`],
    timeout: 60000, env: { ...env, AILY_E2E: '1', AILY_APPDATA_PATH: appData, HOME: home, USERPROFILE: home,
      AILY_DEV_RENDERER_URL: renderer.origin, npm_config_offline: 'true', npm_config_audit: 'false' } })
  hostPid = await app.evaluate(() => process.pid)
  await app.firstWindow()
  const deadline = Date.now() + 60000
  page = undefined
  while (!page && Date.now() < deadline) {
    page = app.windows().find(value => value.url().startsWith(renderer.origin))
    if (!page) await new Promise(resolve => setTimeout(resolve, 200))
  }
  assert.ok(page)
  page.on('dialog', dialog => dialog.dismiss())
  page.on('console', message => {
    if (/Normalization|项目保存失败|Saved ABI and workspace diverged/.test(message.text())) {
      ;(evidence.console ??= []).push({ type: message.type(), text: message.text().slice(0, 1000) })
    }
  })
  await page.goto(renderer.origin, { waitUntil: 'domcontentloaded' })
  await page.locator('app-main-window').waitFor({ timeout: 60000 })
  await page.evaluate(target => { location.hash = '#/main/blockly-editor?path=' + encodeURIComponent(target) }, project)
  await page.waitForFunction(target => {
    const mainElement = document.querySelector('blockly-main'), editorElement = document.querySelector('app-blockly-editor')
    const main = mainElement && window.ng?.getComponent(mainElement)
    const editor = editorElement && window.ng?.getComponent(editorElement)
    return main?.projectService?.currentProjectPath?.replaceAll('\\', '/') === target.replaceAll('\\', '/')
      && main.projectService.getBlocklyProjectLoadStatus(target)?.ready === true
      && editor?._builderService?.isInstallInProgress() === false
  }, project, { timeout: 60000 })
  await page.evaluate(() => {
    const service = window.ng.getComponent(document.querySelector('blockly-main')).projectService
    const save = service.save.bind(service)
    const resolveConflict = service.resolveSaveConflict.bind(service)
    window.__acceptanceSaves = []
    window.__acceptanceResolutions = []
    // Observe the actual UI-triggered operation without changing its arguments,
    // receipt, rejection or timing. Never substitute a scripted file write.
    service.save = (...args) => {
      const observed = { started: Date.now() }
      window.__acceptanceSaves.push(observed)
      return save(...args).then(value => {
        Object.assign(observed, { settled: Date.now(), success: value?.success === true })
        return value
      }, error => {
        Object.assign(observed, { settled: Date.now(), success: false, error: String(error) })
        throw error
      })
    }
    service.resolveSaveConflict = (...args) => {
      const observed = { started: Date.now(), choice: args[1] }
      window.__acceptanceResolutions.push(observed)
      return resolveConflict(...args).then(value => {
        Object.assign(observed, { settled: Date.now(), projectSaved: value?.projectSaved === true,
          partial: value?.partial, generation: value?.generation, refreshed: value?.refreshed })
        return value
      }, error => {
        Object.assign(observed, { settled: Date.now(), projectSaved: false, code: error?.code, error: String(error) })
        throw error
      })
    }
  })
}
async function stopOwned() {
  if (!app) return
  const closed = app.waitForEvent('close', { timeout: 15000 })
  await app.evaluate(({ app }, expected) => {
    if (process.pid !== expected.pid || process.env.AILY_APPDATA_PATH !== expected.appData) throw new Error('Refuse unrelated host shutdown')
    app.exit(0)
  }, { pid: hostPid, appData })
  await closed
  app = undefined
}
async function diskDrift(kind) {
  const value = JSON.parse(await fs.readFile(abiPath, 'utf8'))
  if (kind === 'root-layout') {
    const root = value.pages.flatMap(page => page.content?.blocks?.blocks ?? [])[0]
    assert.ok(root); root.x = (root.x ?? 0) + 23
  } else {
    value.pages[0].viewState = { ...value.pages[0].viewState, scale: 0.92, scrollX: 13, scrollY: 21 }
  }
  await fs.writeFile(abiPath, JSON.stringify(value)) // Explicit external-writer fault in this owned fixture only.
}
async function editNumber(value) {
  const edited = await page.evaluate(value => {
    const main = window.ng.getComponent(document.querySelector('blockly-main'))
    const block = window.Blockly.getMainWorkspace().getAllBlocks(false).find(block => block.type === 'math_number' && !block.isShadow())
    if (!block) throw new Error('The C3 acceptance seed requires an ordinary number block')
    const changed = Number(block.getFieldValue('NUM')) !== value
    const previewToken = main.generatedArtifactRetryToken
    block.setFieldValue(String(value), 'NUM')
    return { id: block.id, changed, previewToken }
  }, value)
  if (edited.changed) {
    // Observe the real debounced native publication, rather than planting an
    // obsolete managed-name header while an unrelated preview is still due.
    await page.waitForFunction(previous => {
      const main = window.ng.getComponent(document.querySelector('blockly-main'))
      return main.generatedArtifactRetryToken > previous && !main.backgroundCodeGenerationInProgress && !main.generatedArtifactRetryTimer
    }, edited.previewToken, { timeout: 15000 })
  }
  return edited.id
}
async function nativeDocument() {
  return page.evaluate(() => {
    const editor = window.ng.getComponent(document.querySelector('app-blockly-editor'))
    return JSON.parse(editor.blocklyService.captureRecoverySnapshot().documentText)
  })
}
async function mirrors() {
  const names = ['project.abi', 'project.abs', 'project.abs.map.json', '.aily/abs-sync/committed.json']
  return Object.fromEntries(await Promise.all(names.map(async name => [name, await fs.readFile(path.join(project, name), 'utf8')])))
}
async function assertSaved(id, value) {
  const abi = JSON.parse(await fs.readFile(abiPath, 'utf8')), map = JSON.parse(await fs.readFile(mapPath, 'utf8'))
  assert.equal(Number(findBlock(abi, id)?.fields?.NUM), value)
  assert.equal(Number(findBlock(await nativeDocument(), id)?.fields?.NUM), value)
  assert.equal(map.savedAbiHash, 'sha256:' + sha(JSON.stringify(canonical(abi))))
  return { abi, map }
}
async function chooseDialog(action, expectedActions, { closing = false } = {}) {
  const modal = page.locator('app-unsave-dialog:visible')
  await modal.waitFor({ state: 'visible', timeout: 5000 })
  const actions = await modal.evaluate(element => window.ng.getComponent(element).buttons.map(button => button.action))
  if (expectedActions) assert.deepEqual(actions, expectedActions)
  if (actions.includes('keep_view') && actions.includes('replace_view') && !evidence.conflictDialogScreenshot) {
    // Crop to the generic decision dialog; never capture the user's code canvas.
    const file = path.join(output, 'conflict-choices.png')
    await modal.screenshot({ path: file })
    evidence.conflictDialogScreenshot = file
  }
  const index = actions.indexOf(action)
  assert.notEqual(index, -1, `The real modal did not offer ${action}: ${actions.join(', ')}`)
  // Map the semantic action to its rendered footer button, never assume first/last.
  await modal.locator('.footer button').nth(index).click()
  if (!closing) await modal.waitFor({ state: 'hidden', timeout: 5000 })
  return actions
}
async function awaitUiIdle(star) {
  await page.waitForFunction(star => {
    const header = window.ng.getComponent(document.querySelector('app-header'))
    const main = window.ng.getComponent(document.querySelector('blockly-main'))
    return header.hasUnsavedProjectChanges === star && !header.projectConflictResolving && !header.projectSavingFromUi
      && main.projectService.stateSubject.value !== 'saving'
  }, star, { timeout: 15000 })
}
async function openConflict() {
  const since = Date.now()
  await page.keyboard.press('Control+s')
  await page.waitForFunction(since => window.__acceptanceSaves.some(save => save.started >= since && save.settled && !save.success), since,
    { timeout: 15000 })
  await page.locator('app-unsave-dialog:visible').waitFor({ timeout: 5000 })
  return since
}
async function awaitResolved(since, choice) {
  await page.waitForFunction(({ since, choice }) => window.__acceptanceResolutions.some(result => result.started >= since
    && result.choice === choice && result.settled), { since, choice }, { timeout: 15000 })
  const observation = await page.evaluate(({ since, choice }) => window.__acceptanceResolutions
    .filter(result => result.started >= since && result.choice === choice && result.settled).at(-1), { since, choice })
  assert.equal(observation.projectSaved, true, `${choice} was not confirmed: ${observation.code ?? ''} ${observation.error ?? ''}`)
  assert.equal(observation.partial, false, `${choice} returned partial persistence`)
  await awaitUiIdle(false)
}
async function directories(directory) {
  try { return (await fs.readdir(directory, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name) }
  catch (error) { if (error.code === 'ENOENT') return []; throw error }
}
async function generatedSourceFault(label) {
  const header = `src/objects_acceptance-${label}-12345678.h`, sketch = '.temp/sketch/sketch.ino'
  const originals = new Map([[header, Buffer.from(`// preserved ${label} header\r\nconst int external_original = 7;\r\n`)],
    [sketch, Buffer.from(`// preserved ${label} generated sketch\r\nvoid setup() {}\r\nvoid loop() {}\r\n`)]])
  const archiveRoot = path.join(project, '.aily/generated-source-archives')
  const before = new Set(await directories(archiveRoot))
  for (const [relative, bytes] of originals) {
    await fs.mkdir(path.dirname(path.join(project, relative)), { recursive: true })
    await fs.writeFile(path.join(project, relative), bytes) // Owned external-source conflict fault, not an Agent edit.
  }
  return { originals, archiveRoot, before }
}
async function assertGeneratedSourcesArchived(fault) {
  const manifests = []
  const found = new Set()
  for (const directory of (await directories(fault.archiveRoot)).filter(name => !fault.before.has(name))) {
    const root = path.join(fault.archiveRoot, directory), file = path.join(root, 'manifest.json')
    const manifest = JSON.parse(await fs.readFile(file, 'utf8'))
    assert.equal(manifest.version, 1); assert.equal(manifest.kind, 'superseded-generated-source')
    for (const entry of manifest.files) {
      if (!fault.originals.has(entry.path)) continue
      assert.ok(inside(root, path.resolve(root, entry.archivedPath)))
      const archived = await fs.readFile(path.join(root, entry.archivedPath)), expected = fault.originals.get(entry.path)
      assert.deepEqual(archived, expected); assert.equal(entry.bytes, expected.length)
      assert.equal(entry.hash, 'sha256:' + sha(expected)); found.add(entry.path)
    }
    manifests.push(path.relative(project, file))
  }
  assert.deepEqual([...found].sort(), [...fault.originals.keys()].sort(), 'Every superseded generated source must be durably retained')
  return { manifests, exactOriginalBytesVerified: true, paths: [...found] }
}
async function startHarness({ createStreaming } = {}) {
  Object.assign(process.env, { AILY_LIBRARY_HOST_PID: String(hostPid), AILY_APPDATA_PATH: appData,
    PI_CODING_AGENT_DIR: profileRoot, HOME: home, USERPROFILE: home, PI_OFFLINE: '1', npm_config_offline: 'true', npm_config_audit: 'false' })
  return createRecoveredAgentHarness({ agentRoot, sourceProject: project, globalRoot: root, profileRoot, persistToolTranscript: true,
    ...(createStreaming ? { createStreaming } : {}),
    permissionApproval(request) {
      if (['read', 'write', 'edit'].includes(request.toolName)) return typeof request.input?.path === 'string'
        && samePath(request.input.path, absPath)
      return samePath(request.input?.project ?? '', project)
        && ['project_recover', 'project_save', 'abs_export', 'abs_validate', 'abs_apply'].includes(request.toolName)
    } })
}
async function actualSdkSaveOnlyCycle() {
  const results = []
  const structured = event => event.details?.result ?? JSON.parse(event.content.filter(value => value.type === 'text').map(value => value.text).join('\n'))
  let beforeSave
  const bridge = await createAbsStepSubmissionBridge({ interactionId: 'itx-isolated-save-only',
    finalText: 'The current canvas is saved. No AI candidate was applied and no compilation was requested.',
    nextTool: async ({ step }) => {
      if (step === 0) return { id: 'inspect-save-conflict', name: 'project_recover', arguments: { project, action: 'inspect' } }
      if (step === 1) return { id: 'resolve-save-conflict', name: 'project_recover', arguments: { project, action: 'resolve',
        token: structured(results[0]).conflictResolution.token, choice: 'keep_view' } }
      if (step === 2) return { id: 'save-current-canvas', name: 'project_save', arguments: { project } }
      assert.equal(step, 3, 'Only inspect, explicit source choice and save are needed')
    } })
  try {
    harness = await startHarness({ createStreaming: context => createAbsProviderSession(context, { apiBase: bridge.origin,
      onToolResult: async event => {
        assert.notEqual(event.isError, true)
        results.push(event)
        if (event.toolName === 'project_recover' && results.length === 2) beforeSave = await mirrors()
      } }) })
    const id = await editNumber(44)
    await awaitUiIdle(true)
    const external = JSON.parse(await fs.readFile(abiPath, 'utf8'))
    findBlock(external, id).fields.NUM = 4401
    const externalText = JSON.stringify(external)
    await fs.writeFile(abiPath, externalText) // Explicit suite-owned external writer, never an Agent edit.
    await harness.prompt('Save the current canvas without changing or applying any program. Preserve conflicting originals if source resolution is necessary.')
    assert.deepEqual(results.map(event => event.toolName), ['project_recover', 'project_recover', 'project_save'])
    const inspected = structured(results[0]), resolved = structured(results[1]), saved = structured(results[2])
    assert.equal(inspected.conflictResolution?.inputAbiHash, 'sha256:' + sha(externalText))
    assert.equal(resolved.ok, true)
    assert.equal(resolved.publication?.status, 'COMMITTED')
    assert.equal(resolved.resolutionVerification?.candidateApplied, false)
    assert.equal(resolved.workspaceSaveVerification?.scope, 'current-canvas-save')
    assert.equal(resolved.workspaceSaveVerification?.ok, true)
    assert.equal(resolved.recoveryArchive?.files?.abi?.hash, 'sha256:' + sha(externalText))
    assert.equal(saved.ok, true, 'An already committed current canvas must not require a no-op abs_apply')
    assert.equal(saved.workspaceSaveVerification?.version, 1)
    assert.equal(saved.workspaceSaveVerification?.scope, 'current-canvas-save')
    assert.equal(saved.workspaceSaveVerification?.ok, true)
    assert.equal(saved.workspaceSaveVerification?.candidateApplied, false)
    await awaitUiIdle(false)
    await assertSaved(id, 44)
    assert.equal(await fs.readFile(abiPath, 'utf8'), beforeSave['project.abi'], 'Save-only must not alter program bytes')
    const proof = harness.proof(), transport = bridge.snapshot()
    assert.equal(proof.actualSdkSession, true)
    assert.equal(proof.actualProviderSession, true)
    assert.equal(proof.promptRuns, 1)
    assert.equal(proof.sessionUserMessages, 1)
    assert.equal(proof.calls.some(call => ['write', 'edit', 'abs_validate', 'abs_apply'].includes(call.name)), false)
    assert.equal(harness.messages().filter(message => message.role === 'assistant').at(-1)?.stopReason, 'stop')
    assert.equal(transport.createCount, 1)
    assert.deepEqual(transport.failures, [])
    assert.ok(transport.operations.every(value => value.postCount === 1))
    await harness.dispose(); harness = undefined
    return { actualSdkProof: proof, actualProviderPrompt: true, transport, saved, manualNumberPreserved: 44,
      diskConflictOriginalArchived: 4401, noApplyOrProgramEdit: true, star: false }
  } finally { await bridge.close() }
}
async function actualSdkManualCycle() {
  harness = await startHarness()
  const exported = (await harness.call('abs_export', { project })).structured
  assert.equal(exported.ok, true)
  await harness.call('read', { path: absPath, limit: 12 })
  // All source edits go through real registered SDK tools and their permission/history hooks.
  await harness.write(absPath, exported.abs)
  const anchor = exported.abs.match(/^arduino_loop\(\).*$/m)?.[0]
  assert.ok(anchor, 'C3 acceptance seed requires arduino_loop')
  const markerBefore = `acceptance-first-${path.basename(suite)}`, markerAfter = `${markerBefore}-second`
  await harness.edit(absPath, anchor, `${anchor}\n    serial_print(Serial, text("${markerBefore}"))`)
  const firstValidation = (await harness.call('abs_validate', { project, generation: exported.generation, absPath })).structured
  assert.equal(firstValidation.ok, true)
  const first = (await harness.call('abs_apply', { project, generation: exported.generation, absPath })).structured
  assert.equal(first.applyVerification?.ok, true)
  await harness.settle()
  const numberId = await editNumber(46)
  await page.waitForFunction(() => window.ng.getComponent(document.querySelector('app-header')).hasUnsavedProjectChanges)
  const secondTurn = await harness.beginTurn('Preserve the manual number edit and change only the acceptance serial-print marker.')
  const rule = secondTurn.projectControl?.payload?.rule
  assert.equal(typeof rule, 'string', 'The actual turn-start hook must provide its host-prepared ABS metadata')
  const normalizedRule = rule.replaceAll('\r\n', '\n').trimEnd()
  const snapshotStart = normalizedRule.lastIndexOf('\n\n')
  assert.ok(snapshotStart >= 0)
  const turnSnapshot = JSON.parse(normalizedRule.slice(snapshotStart + 2))
  assert.ok(samePath(turnSnapshot.project, project)); assert.equal(turnSnapshot.absSync.ok, true)
  assert.equal(turnSnapshot.absSync.state, 'ready'); assert.equal(turnSnapshot.absSync.canvasSaved, true)
  const generation = turnSnapshot.absSync.generation
  assert.match(generation, /^[A-Za-z0-9_-]{1,96}$/)
  // A new user turn legitimately synchronizes the hand edit. Use the actual
  // host-prepared generation, not the preceding turn's now-stale generation.
  await harness.call('read', { path: absPath, limit: 12 })
  await harness.edit(absPath, markerBefore, markerAfter)
  const secondValidation = (await harness.call('abs_validate', { project, generation, absPath })).structured
  assert.equal(secondValidation.ok, true)
  const second = (await harness.call('abs_apply', { project, generation, absPath })).structured
  assert.equal(second.applyVerification?.ok, true)
  await assertSaved(numberId, 46)
  await harness.settle()
  await assertSaved(numberId, 46)
  const persisted = await fs.readFile(absPath, 'utf8')
  assert.ok(persisted.includes(markerAfter)); assert.ok(!persisted.includes(`text("${markerBefore}")`))
  const proof = harness.proof()
  assert.deepEqual(proof.calls.filter(call => ['read', 'write', 'edit', 'abs_validate', 'abs_apply'].includes(call.name)).map(call => call.name),
    ['read', 'write', 'edit', 'abs_validate', 'abs_apply', 'read', 'edit', 'abs_validate', 'abs_apply'])
  await harness.dispose(); harness = undefined
  const since = Date.now()
  await page.keyboard.press('Control+s')
  await page.waitForFunction(since => window.__acceptanceSaves.some(save => save.started >= since && save.settled && save.success), since, { timeout: 15000 })
  await awaitUiIdle(false); await assertSaved(numberId, 46)
  return { firstGeneration: first.generation ?? first.publication.generation, secondGeneration: second.generation ?? second.publication.generation,
    manualNumberId: numberId, manualNumberPreserved: 46, marker: markerAfter, actualSdkProof: proof, manualCtrlSSuccess: true,
    secondTurn: { actualSdkBeforeAgentStart: secondTurn.actualSdkBeforeAgentStart, actualProviderPrompt: false,
      hostPreparedGeneration: generation, manualCanvasSynchronizedByTurnStart: true } }
}
async function awaitSave(action, id, value) {
  const before = JSON.parse(await fs.readFile(mapPath, 'utf8')), since = Date.now()
  await action()
  await page.waitForFunction(since => window.__acceptanceSaves.some(save => save.started >= since && save.settled && save.success), since,
    { timeout: 15000 })
  await page.waitForFunction(() => {
    const header = window.ng.getComponent(document.querySelector('app-header'))
    const main = window.ng.getComponent(document.querySelector('blockly-main'))
    return !header.hasUnsavedProjectChanges && main.projectService.stateSubject.value !== 'saving'
  }, undefined, { timeout: 15000 })
  const receiptMs = Date.now() - since
  const abi = JSON.parse(await fs.readFile(abiPath, 'utf8')), map = JSON.parse(await fs.readFile(mapPath, 'utf8'))
  assert.equal(Number(findBlock(abi, id)?.fields?.NUM), value)
  assert.notEqual(map.generation, before.generation)
  const samples = []
  for (const delay of [0, 1000, 2000, 2000]) { if (delay) await page.waitForTimeout(delay); samples.push(await snapshot()) }
  assert.ok(samples.every(value => !value.star && value.state !== 'saving'))
  return { receiptMs, verificationMs: Date.now() - since, generation: map.generation, samples }
}
try {
  renderer = await serveRendererBuild(hostBuild)
  await launch()
  harness = await startHarness()
  const inspected = (await harness.call('project_recover', { project, action: 'inspect' })).structured
  const repair = inspected?.diagnostics?.repair
  if (repair) assert.equal((await harness.call('project_recover', { project, action: 'repair', token: repair.token, authority: repair.authority })).structured?.ok, true)
  const exported = (await harness.call('abs_export', { project })).structured
  assert.equal(exported.ok, true)
  await harness.settle(); await harness.dispose(); harness = undefined
  for (const [index, kind] of ['root-layout', 'viewport'].entries()) {
    await diskDrift(kind)
    const value = 37 + index, id = await editNumber(value)
    await page.waitForFunction(() => window.ng.getComponent(document.querySelector('app-header')).hasUnsavedProjectChanges)
    const action = index === 0 ? () => page.keyboard.press('Control+s') : async () => {
      await page.locator('app-header .header-box > .menu').click()
      await page.locator('.menu-item').filter({ has: page.locator('.text', { hasText: /^Ctrl\s*\+\s*S$/i }) }).click()
    }
    evidence.saves.push({ kind, trigger: index === 0 ? 'Ctrl+S' : 'menu', ...(await awaitSave(action, id, value)) })
  }
  // Publish a legal historical unmarked generation; do not counterfeit a new hash in an old baseline.
  const seeded = await bundle({ entryPoints: [path.join(repo, 'e2e/fixtures/abs-save-load-fixture.ts')],
    bundle: true, write: false, format: 'iife', globalName: '__absSaveFixture', platform: 'browser',
    target: 'es2022', tsconfig: path.join(repo, 'tsconfig.json'), logLevel: 'silent',
    alias: { '@domain/project/public-api': path.join(repo, 'e2e/fixtures/abs-save-project-data.ts') } })
  await page.addScriptTag({ content: seeded.outputFiles[0].text })
  const legacy = await page.evaluate(project => window.__absSaveFixture.seedUnmarkedGeneration(project), project)
  evidence.loadMigration = { seededGeneration: legacy.generation, legitimateJournal: true }
  await stopOwned()
  await launch()
  const migrated = JSON.parse(await fs.readFile(abiPath, 'utf8')), map = JSON.parse(await fs.readFile(mapPath, 'utf8'))
  assert.ok(migrated.$ailyProjectData)
  assert.notEqual(map.generation, legacy.generation)
  assert.equal(map.savedAbiHash, 'sha256:' + sha(JSON.stringify(canonical(migrated))))
  const archive = JSON.parse(await fs.readFile(path.join(project, '.aily/abs-sync/recoveries', `${map.generation}.json`), 'utf8'))
  assert.equal(archive.disk.abi, legacy.abiText)
  assert.equal(archive.disk.map, legacy.mapText)
  assert.equal(archive.committed.pointer, legacy.pointerText)
  await page.waitForTimeout(1200)
  assert.equal((await snapshot()).star, false)
  Object.assign(evidence.loadMigration, { committedGeneration: map.generation, oldAbiAndMapAndPointerArchived: true,
    savedAbiHashVerified: true, star: false })
  evidence.sdkSaveOnlyCycle = await actualSdkSaveOnlyCycle()
  evidence.sdkManualCycle = await actualSdkManualCycle()

  // A real external program conflict must present the two explicit strategies.
  // Cancel first: neither disk, native canvas, pointer nor source originals may change.
  const keepId = await editNumber(39)
  const external = JSON.parse(await fs.readFile(abiPath, 'utf8'))
  findBlock(external, keepId).fields.NUM = 4001
  const conflictText = JSON.stringify(external)
  await fs.writeFile(abiPath, conflictText) // Explicit semantic external-writer fault only.
  await page.waitForFunction(() => window.ng.getComponent(document.querySelector('app-header')).hasUnsavedProjectChanges)
  const cancelledMirrors = await mirrors(), cancelledView = await nativeDocument()
  await openConflict()
  // Inject after the failed ordinary save has finished preparing its code. This
  // fault tests resolution publication, not an unrelated preview debounce.
  const keepSourceFault = await generatedSourceFault('keep')
  const actions = await chooseDialog('cancel', ['cancel', 'keep_view', 'replace_view'])
  await awaitUiIdle(true)
  assert.deepEqual(await mirrors(), cancelledMirrors); assert.deepEqual(await nativeDocument(), cancelledView)
  for (const [relative, bytes] of keepSourceFault.originals) assert.deepEqual(await fs.readFile(path.join(project, relative)), bytes)
  const keepSince = await openConflict()
  await chooseDialog('keep_view', actions)
  await awaitResolved(keepSince, 'keep_view')
  const kept = await assertSaved(keepId, 39)
  const keepArchive = JSON.parse(await fs.readFile(path.join(project, '.aily/abs-sync/recoveries', `${kept.map.generation}.json`), 'utf8'))
  assert.equal(keepArchive.disk.abi, conflictText)
  assert.deepEqual(keepArchive.disk, { abi: cancelledMirrors['project.abi'], abs: cancelledMirrors['project.abs'], map: cancelledMirrors['project.abs.map.json'] })
  assert.equal(keepArchive.committed.pointer, cancelledMirrors['.aily/abs-sync/committed.json'])
  assert.equal(Number(findBlock(JSON.parse(keepArchive.workspace), keepId)?.fields?.NUM), 39)
  evidence.conflict = { actions, cancelled: { diskAndPointerUnchanged: true, canvasUnchanged: true, sourceBytesUnchanged: true, star: true },
    keep_view: { generation: kept.map.generation, nativeAndAbiValue: 39, originalDiskValueArchived: 4001, star: false,
      generatedSources: await assertGeneratedSourcesArchived(keepSourceFault) } }

  // Replace means a genuine native refresh from the exact validated saved ABI,
  // not repainting the old view or treating an arbitrary draft's mtime as authority.
  const replaceId = await editNumber(40)
  const latest = JSON.parse(await fs.readFile(abiPath, 'utf8'))
  findBlock(latest, replaceId).fields.NUM = 41
  const latestText = JSON.stringify(latest)
  await fs.writeFile(abiPath, latestText) // Owned external fault: disk41 versus native40.
  await page.waitForFunction(() => window.ng.getComponent(document.querySelector('app-header')).hasUnsavedProjectChanges)
  const replaceView = await nativeDocument(), replaceMirrors = await mirrors()
  const replaceSince = await openConflict()
  const replaceSourceFault = await generatedSourceFault('replace')
  await chooseDialog('replace_view', actions)
  await awaitResolved(replaceSince, 'replace_view')
  const refreshed = await assertSaved(replaceId, 41)
  const replaceArchive = JSON.parse(await fs.readFile(path.join(project, '.aily/abs-sync/recoveries', `${refreshed.map.generation}.json`), 'utf8'))
  assert.deepEqual(JSON.parse(replaceArchive.workspace), replaceView)
  assert.equal(Number(findBlock(JSON.parse(replaceArchive.workspace), replaceId)?.fields?.NUM), 40)
  assert.equal(replaceArchive.disk.abi, latestText)
  assert.equal(replaceArchive.committed.pointer, replaceMirrors['.aily/abs-sync/committed.json'])
  evidence.conflict.replace_view = { generation: refreshed.map.generation, nativeAndAbiValue: 41,
    previousViewValueArchived: 40, star: false, generatedSources: await assertGeneratedSourcesArchived(replaceSourceFault) }

  // Retain the ordinary native quit/save case after both explicit resolutions.
  const finalId = await editNumber(42)
  await diskDrift('root-layout')
  const exited = app.waitForEvent('close', { timeout: 20000 })
  await page.evaluate(() => window.ng.getComponent(document.querySelector('app-header')).close())
  await chooseDialog('save', ['cancel', 'continue', 'save'], { closing: true })
  await exited
  app = undefined
  const finalAbi = JSON.parse(await fs.readFile(abiPath, 'utf8')), finalMap = JSON.parse(await fs.readFile(mapPath, 'utf8'))
  assert.equal(Number(findBlock(finalAbi, finalId)?.fields?.NUM), 42)
  assert.equal(finalMap.savedAbiHash, 'sha256:' + sha(JSON.stringify(canonical(finalAbi))))
  assert.ok((await fs.readFile(absPath, 'utf8')).includes(evidence.sdkManualCycle.marker))
  evidence.nativeQuit = { saveAndContinueClosedOwnedHost: true, codeSaved: true }

  // A quit with a genuine disk/canvas conflict must also remain recoverable,
  // rather than leaving the user trapped behind a stale save failure.
  await launch()
  const quitId = await editNumber(43)
  const quitExternal = JSON.parse(await fs.readFile(abiPath, 'utf8'))
  findBlock(quitExternal, quitId).fields.NUM = 4301
  const quitExternalText = JSON.stringify(quitExternal)
  await fs.writeFile(abiPath, quitExternalText) // Owned semantic conflict; never mutate the source seed.
  const conflictExited = app.waitForEvent('close', { timeout: 20000 })
  await page.evaluate(() => window.ng.getComponent(document.querySelector('app-header')).close())
  await chooseDialog('keep_view', ['cancel', 'keep_view', 'replace_view'], { closing: true })
  await conflictExited
  app = undefined
  const quitAbi = JSON.parse(await fs.readFile(abiPath, 'utf8')), quitMap = JSON.parse(await fs.readFile(mapPath, 'utf8'))
  const quitArchive = JSON.parse(await fs.readFile(path.join(project, '.aily/abs-sync/recoveries', `${quitMap.generation}.json`), 'utf8'))
  assert.equal(Number(findBlock(quitAbi, quitId)?.fields?.NUM), 43)
  assert.equal(quitArchive.disk.abi, quitExternalText)
  assert.equal(quitMap.savedAbiHash, 'sha256:' + sha(JSON.stringify(canonical(quitAbi))))
  evidence.nativeConflictQuit = { keepViewSavedAndClosedOwnedHost: true, nativeValueSaved: 43,
    originalDiskValueArchived: 4301, archiveVerified: true }
  evidence.ok = true
} catch (error) {
  evidence.failure = { message: error.message, stack: error.stack }; process.exitCode = 1
  if (page && !page.isClosed()) {
    evidence.uiFailureObservation = await page.evaluate(() => {
      const header = window.ng?.getComponent(document.querySelector('app-header'))
      const main = window.ng?.getComponent(document.querySelector('blockly-main'))
      const modal = document.querySelector('app-unsave-dialog')
      return { saves: window.__acceptanceSaves, resolutions: window.__acceptanceResolutions,
        star: header?.hasUnsavedProjectChanges, state: main?.projectService.stateSubject.value,
        notices: [...document.querySelectorAll('.ant-message-notice-content')].map(node => node.textContent?.slice(0, 1600)),
        modalActions: modal ? window.ng.getComponent(modal).buttons.map(button => button.action) : [],
        ordinaryNumbers: window.Blockly?.getMainWorkspace()?.getAllBlocks(false)
          .filter(block => block.type === 'math_number' && !block.isShadow()).map(block => ({ id: block.id, value: block.getFieldValue('NUM') })) }
    }).catch(error => ({ observationError: String(error) }))
  }
} finally {
  await harness?.dispose().catch(error => { evidence.cleanupFailure = error.message; process.exitCode = 1 })
  await stopOwned().catch(error => { evidence.cleanupFailure = error.message; process.exitCode = 1 })
  await renderer?.close()
  evidence.ok &&= process.exitCode !== 1
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify({ ok: evidence.ok, output, failure: evidence.failure?.message }))
}
