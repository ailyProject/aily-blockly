import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { _electron } from '@playwright/test'
import { serveRendererBuild } from '../fixtures/build-renderer-server.mjs'
import { createRecoveredAgentHarness } from '../fixtures/abs-agent-tools.mjs'
import { createAbsProviderSession } from '../fixtures/abs-provider-session.mjs'
import { createAbsStepSubmissionBridge } from '../fixtures/abs-step-submission-bridge.mjs'

const repo = fileURLToPath(new URL('../../', import.meta.url))
const root = path.resolve(process.env.AILY_STEP_ROOT ?? '')
const project = path.resolve(process.env.AILY_STEP_PROJECT ?? '')
const agentRoot = path.resolve(process.env.AILY_STEP_AGENT ?? '')
const build = path.resolve(process.env.AILY_STEP_HOST_BUILD ?? '')
const output = path.resolve(process.env.AILY_STEP_OUTPUT ?? '')
const duplicateOwners = process.env.AILY_STEP_DUPLICATE_OWNERS === '1'
const liveRecovery = process.env.AILY_STEP_LIVE_RECOVERY === '1'
assert.ok(!liveRecovery || !duplicateOwners, 'Keep distinct fault fixtures independently attributable')
const inside = (parent, file) => { const r = path.relative(parent, file); return r && r !== '..'
  && !r.startsWith('..' + path.sep) && !path.isAbsolute(r) }
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
const sha = value => createHash('sha256').update(value).digest('hex')
const textOf = event => (event.content ?? []).filter(item => item.type === 'text').map(item => item.text).join('\n')
const resultOf = event => {
  if (event.details?.result && typeof event.details.result === 'object') return event.details.result
  try { return JSON.parse(textOf(event)) } catch { return undefined }
}
assert.match(root.replaceAll('\\', '/'), /^C:\/.*\/aily-project\/dev-tests\/abs-serial-analysis-20261028$/i)
assert.ok(inside(root, project) && /[\\/]serial-agent-[^\\/]+[\\/]project$/.test(project))
assert.ok(inside(path.join(repo, 'e2e/test-results'), output))
assert.ok(same(root, await fs.realpath(root)) && same(project, await fs.realpath(project)))
await fs.mkdir(output, { recursive: true })
const suite = await fs.mkdtemp(path.join(root, 'step-submission-'))
const home = path.join(suite, 'home'), profileRoot = path.join(suite, 'agent-profile'), appData = path.join(root, 'appdata')
await fs.mkdir(home)
const seed = path.join(root, 'archive-user-project/esp32-c3-HANTAI')
const seedHashes = async () => {
  const hashes = {}
  const visit = async (directory, relative = '') => {
    for (const item of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = relative ? `${relative}/${item.name}` : item.name, full = path.join(directory, item.name)
      if (item.isSymbolicLink()) hashes[name] = 'link:' + sha(await fs.readlink(full))
      else if (item.isDirectory()) await visit(full, name)
      else if (item.isFile()) hashes[name] = sha(await fs.readFile(full))
    }
  }
  await visit(seed)
  return hashes
}
const sourceBefore = await seedHashes()
const sourceDocument = duplicateOwners ? JSON.parse(await fs.readFile(path.join(seed, 'project.abi'), 'utf8')) : undefined
const index = state => {
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
const evidence = { ok: false, llmInvoked: false, realAilyProvider: true, actualSdkLoop: true, localHttpSse: true,
  realServiceCasOrBilling: false, realSdkCoreReadWriteEdit: true, project,
  hardwareUsed: false, simulatorUsed: false, userProjectsModified: false, dailyInstallReplaced: false,
  ...(duplicateOwners ? { duplicateOwners: true, insertionLineEnding: 'lone-CR', expectedSavedLineEnding: 'LF' } : {}),
  ...(liveRecovery ? { liveRecovery: true, productionRecoveryBudgetMs: 30_000, requiredHealthyStreamMs: 32_000 } : {}), tools: [] }
evidence.sourceSeed = { files: Object.keys(sourceBefore).length, sha256: sha(JSON.stringify(sourceBefore)) }
let app, renderer, page, harness, bridge, hostPid, baseline, baselineBlocks, baselineDocument, exported, latestBuild, editResultSha256, observeProvenance
const documentBlocks = document => index([document.pages.map(page => page.content), document.sharedModel.procedureBlocks])
const call = async (name, input) => {
  const result = await harness.call(name, input)
  return result.structured ?? result
}
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
  const preserved = state => {
    const current = index(state)
    for (const [id, block] of baselineBlocks) assert.deepEqual(current.get(id), block,
      'Retain all original fields/extraState/disabled/collapsed/nondeletable blocks')
    assert.deepEqual(state.variables, baseline.variables, 'A print-only edit must preserve every original variable model')
    assert.equal(current.size, baselineBlocks.size + 2)
    return { blocks: current.size, models: state.variables.length }
  }
  const preservedDocument = async () => {
    const current = JSON.parse(await fs.readFile(path.join(project, 'project.abi'), 'utf8'))
    assert.equal(current.activePageId, baselineDocument.activePageId)
    assert.deepEqual(current.openedPageIds, baselineDocument.openedPageIds)
    assert.deepEqual(current.pages.map(({ id, title }) => ({ id, title })), baselineDocument.pages.map(({ id, title }) => ({ id, title })))
    assert.deepEqual(current.sharedModel.variables, baselineDocument.sharedModel.variables)
    const blocks = documentBlocks(current), before = documentBlocks(baselineDocument)
    for (const [id, value] of before) assert.deepEqual(blocks.get(id), value,
      'Preserve every page and shared procedure block, not only the visible canvas')
    assert.equal(blocks.size, before.size + 2)
    return { pages: current.pages.length, allPageAndSharedProcedureBlocks: blocks.size, sharedVariables: current.sharedModel.variables.length }
  }
  await page.evaluate(target => { location.hash = '#/main/blockly-editor?path=' + encodeURIComponent(target) }, project)
  await ready()
  await installSettled()
  Object.assign(process.env, { AILY_LIBRARY_HOST_PID: String(hostPid), AILY_APPDATA_PATH: appData,
    PI_CODING_AGENT_DIR: profileRoot, HOME: home, USERPROFILE: home, PI_OFFLINE: '1', npm_config_offline: 'true', npm_config_audit: 'false' })
  const absPath = path.join(project, 'project.abs'), before = `step_before_${randomUUID().slice(0, 8)}`
  const after = before.replace('before', 'after'), plan = []
  bridge = await createAbsStepSubmissionBridge({ interactionId: 'itx_abs_steps_' + randomUUID().replaceAll('-', ''),
    failAfterToolId: 'abs-edit-once', ...(liveRecovery ? { liveRecovery: { durationMs: 32_000 } } : {}), nextTool: async ({ step }) => {
      if (step < plan.length) {
        if (duplicateOwners && plan[step].name === 'abs_validate') await observeProvenance('before-validate')
        return plan[step]
      }
      assert.ok(latestBuild, 'The SDK must execute the real build before completion')
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
      return undefined
    } })
  const compileDeadline = Date.now() + 12 * 60 * 1000
  harness = await createRecoveredAgentHarness({ agentRoot, sourceProject: project, globalRoot: root, profileRoot,
    createStreaming: async context => {
      if (duplicateOwners) {
        const store = await context.mod('operations/abs-edit-provenance-store')
        const provenance = await context.mod('operations/abs-edit-provenance')
        observeProvenance = async phase => {
          const physicalRoot = harness.history.executionRoot, file = path.join(physicalRoot, 'project.abs')
          assert.ok(same(physicalRoot, project) || inside(project, physicalRoot))
          const currentHash = 'sha256:' + sha(await fs.readFile(file))
          const record = store.readAbsEditRecord(file)
          const origin = store.readAbsEditOrigin(file)
          const implicit = provenance.absEditProvenance(physicalRoot, undefined, currentHash)
          const explicit = provenance.absEditProvenance(physicalRoot, 'sha256:' + sha(exported.abs), currentHash)
          const observation = { phase, physicalRoot, currentHash, mapHash: store.captureAbsEditGeneration(file),
            baselineHash: store.captureAbsEditBaseline(file) ?? null,
            origin: origin ? { version: origin.version, generation: origin.generation,
              baseAbsHash: origin.baseAbsHash, mapHash: origin.mapHash, sourceKeySha256: sha(origin.sourceKey) } : null,
            durable: Array.isArray(record) ? record.map(value => ({ before: value.before, after: value.after,
              edits: value.edits.map(edit => ({ start: edit.start, end: edit.end, characters: edit.text.length })) })) : [],
            implicitBatches: implicit?.length ?? 0, explicitBatches: explicit?.length ?? 0 }
          ;(evidence.provenance ??= []).push(observation)
          await fs.appendFile(path.join(output, 'provenance-observations.jsonl'), JSON.stringify(observation) + '\n')
        }
      }
      return createAbsProviderSession(context, { apiBase: bridge.origin,
      onToolResult: async event => {
        const result = resultOf(event)
        evidence.tools.push({ name: event.toolName, id: event.toolCallId, isError: event.isError === true })
        await fs.appendFile(path.join(output, 'tool-results.jsonl'), JSON.stringify({ name: event.toolName, ...event }) + '\n')
        assert.notEqual(event.isError, true, `Actual Agent tool ${event.toolName} must succeed`)
        if (event.toolCallId === 'abs-edit-once') editResultSha256 = sha(JSON.stringify({
          toolCallId: event.toolCallId, toolName: event.toolName, isError: false,
          result: { content: [{ type: 'text', text: textOf(event) }] } }))
        if (duplicateOwners && ['abs-edit-insert', 'abs-edit-once'].includes(event.toolCallId)) {
          await observeProvenance(event.toolCallId === 'abs-edit-insert' ? 'after-insert' : 'after-marker')
        }
        if (event.toolName === 'abs_validate') {
          assert.equal(result?.ok, true); evidence.validated = true
          if (duplicateOwners) {
            assert.ok(result.editTracking?.batches > 0, 'Actual SDK edits must reach host identity matching as tracked batches')
            assert.ok(result.editTracking.edits >= 2)
            evidence.validationTracking = { ...result.editTracking, candidate: result.receipt.candidate }
          }
        }
        if (event.toolName === 'abs_apply') {
          assert.equal(result?.ok, true)
          evidence.applied = preserved(await canvas())
          evidence.applyReceipt = result.receipt
          if (duplicateOwners) {
            evidence.appliedDocument = await preservedDocument()
            assert.deepEqual(result.editTracking, { batches: evidence.validationTracking.batches, edits: evidence.validationTracking.edits })
            assert.deepEqual(result.receipt.candidate, evidence.validationTracking.candidate,
              'Application must bind the same candidate proven by the tracked validation')
            evidence.applicationTracking = result.editTracking
          }
        }
        if (event.toolName === 'app_reload') {
          assert.equal(result?.ok, true)
          await ready()
          await installSettled()
          evidence.reopened = preserved(await canvas())
          if (duplicateOwners) evidence.reopenedDocument = await preservedDocument()
        }
        if (event.toolName === 'project_build') latestBuild = result
        if (event.toolCallId === 'abs-read-recovered') assert.match(textOf(event), new RegExp(after))
      } })
    },
    permissionApproval(request) {
      assert.equal(request.permissionMode, 'default')
      if (['read', 'write', 'edit'].includes(request.toolName)) return same(request.input?.path ?? '', absPath)
      return ['abs_export', 'abs_validate', 'abs_apply', 'app_reload', 'project_build', 'app_close',
        ...(duplicateOwners || liveRecovery ? ['project_recover'] : [])].includes(request.toolName)
        && same(request.input?.project ?? '', project)
    } })
  if (liveRecovery) {
    const originalCanvas = await canvas()
    const inspected = await call('project_recover', { project, action: 'inspect' })
    assert.equal(inspected.ok, true)
    if (inspected.diagnostics?.repair) {
      const { token, authority } = inspected.diagnostics.repair
      const repaired = await call('project_recover', { project, action: 'repair', token, authority })
      assert.equal(repaired.ok, true)
      assert.equal(repaired.publication.status, 'COMMITTED')
      assert.equal(repaired.repairVerification.candidateApplied, false)
      assert.deepEqual(await canvas(), originalCanvas, 'Preparation preserves the native project; it does not apply an ABS candidate')
      evidence.preparationRecovery = { inspected: true, repaired: true, candidateApplied: false }
    }
  }
  if (duplicateOwners) {
    const loadedCanvas = await canvas()
    const inspected = await call('project_recover', { project, action: 'inspect' })
    assert.equal(inspected.ok, true)
    const repair = inspected.diagnostics?.repair
    evidence.preparationRecovery = { inspected: true, status: inspected.diagnostics?.status, repairOffered: !!repair }
    if (repair) {
      assert.equal(repair.authority, 'workspace')
      assert.match(repair.token, /^sha256:[a-f0-9]{64}$/)
      const repaired = await call('project_recover', { project, action: 'repair', token: repair.token, authority: repair.authority })
      assert.equal(repaired.ok, true)
      assert.equal(repaired.repairVerification?.ok, true)
      assert.equal(repaired.repairVerification.candidateApplied, false)
      assert.equal(repaired.publication.status, 'COMMITTED')
      assert.deepEqual(await canvas(), loadedCanvas, 'A copied-scope repair must not change the loaded canvas')
      evidence.preparationRecovery.repaired = true
      evidence.preparationRecovery.candidateApplied = false
    }
    const ownerSuffix = randomUUID().slice(0, 8)
    evidence.ownerSetup = await page.evaluate(suffix => {
      const workspace = window.Blockly.getMainWorkspace()
      const original = workspace.getAllBlocks(false).filter(block => block.type === 'custom_function_def')
      if (original.length !== 1) throw new Error('The read-only archive must initially have exactly one function owner')
      original[0].data = JSON.stringify({ acceptance: 'opaque-original-owner', nonce: suffix })
      const created = workspace.newBlock('custom_function_def', `acceptance-owner-${suffix}`)
      created.setFieldValue(`acceptanceOwner_${suffix}`, 'FUNC_NAME')
      created.setFieldValue('void', 'RETURN_TYPE')
      created.data = JSON.stringify({ acceptance: 'opaque-second-owner', nonce: suffix })
      created.initSvg(); created.render(); created.moveBy(1650, 450)
      created.setCollapsed(true); created.setDeletable(false)
      return { original: original[0].id, created: created.id, actualNativeBlockCreation: true }
    }, ownerSuffix)
  } else {
    baseline = await canvas()
    baselineBlocks = index(baseline)
  }
  exported = await call('abs_export', { project })
  assert.equal(exported.ok, true)
  if (duplicateOwners) {
    // The actual canonical export/save path registers the native library model
    // and publishes the current canvas. No script rewrites ABI, map or ABS.
    baseline = await canvas()
    baselineBlocks = index(baseline)
    const owners = [...baselineBlocks.values()].filter(block => block.type === 'custom_function_def')
    assert.equal(owners.length, 2)
    assert.ok(owners.every(owner => owner.data && owner.extraState?.funcVarId))
    const created = baselineBlocks.get(evidence.ownerSetup.created)
    assert.equal(created.collapsed, true); assert.equal(created.deletable, false)
    assert.equal(created.fields.RETURN_TYPE, 'void')
    evidence.owners = owners.map(owner => ({ id: owner.id, dataSha256: sha(owner.data), extraState: owner.extraState }))
    assert.equal(exported.abs.includes('\r'), false, 'Lone-CR newText is exercised against the actual LF canonical baseline')
    baselineDocument = JSON.parse(await fs.readFile(path.join(project, 'project.abi'), 'utf8'))
    const originalBlocks = documentBlocks(sourceDocument), allBaselineBlocks = documentBlocks(baselineDocument)
    for (const [id, original] of originalBlocks) {
      const actual = allBaselineBlocks.get(id)
      if (id === evidence.ownerSetup.original) {
        const { data: _oldData, ...before } = original, { data: _newData, ...after } = actual
        assert.deepEqual(after, before, 'Only fixture opaque data is added to the original owner before baseline')
      } else assert.deepEqual(actual, original, 'All archived page/shared-procedure blocks survive the native baseline publication')
    }
    assert.equal(allBaselineBlocks.size, originalBlocks.size + 1)
    for (const variable of sourceDocument.sharedModel.variables) {
      assert.deepEqual(baselineDocument.sharedModel.variables.find(value => value.id === variable.id), variable)
    }
    assert.equal(baselineDocument.sharedModel.variables.length, sourceDocument.sharedModel.variables.length + 1)
    evidence.sourceDocument = { pages: sourceDocument.pages.length, allPageAndSharedProcedureBlocks: originalBlocks.size,
      sharedVariables: sourceDocument.sharedModel.variables.length, preservedIntoBaseline: true }
    evidence.baselineDocument = { pages: baselineDocument.pages.length, allPageAndSharedProcedureBlocks: allBaselineBlocks.size,
      sharedVariables: baselineDocument.sharedModel.variables.length }
  }
  evidence.baseline = { blocks: baselineBlocks.size, models: baseline.variables.length }
  const anchor = exported.abs.match(duplicateOwners ? /^custom_function_def\(.*$/m : /^arduino_setup\(\).*$/m)?.[0]
  assert.ok(anchor)
  const candidate = exported.abs.replace(anchor, `${anchor}\n    serial_print(Serial, text("${before}"))`)
  const final = candidate.replace(before, after)
  const markerLine = candidate.slice(0, candidate.indexOf(before)).split('\n').length
  plan.push(
    { id: 'abs-read-initial', name: 'read', arguments: { path: absPath, limit: 30 } },
    { id: 'abs-write-candidate', name: 'write', arguments: { path: absPath, content: duplicateOwners ? exported.abs : candidate } },
    ...(duplicateOwners ? [{ id: 'abs-edit-insert', name: 'edit', arguments: { path: absPath,
      edits: [{ oldText: anchor, newText: `${anchor}\r    serial_print(Serial, text("${before}"))` }] } }] : []),
    { id: 'abs-edit-once', name: 'edit', arguments: { path: absPath, edits: [{ oldText: before, newText: after }] } },
    { id: 'abs-read-recovered', name: 'read', arguments: { path: absPath, offset: Math.max(1, markerLine - 3), limit: 8 } },
    { id: 'abs-validate', name: 'abs_validate', arguments: { project, generation: exported.generation, absPath } },
    { id: 'abs-apply', name: 'abs_apply', arguments: { project, generation: exported.generation, absPath } },
    { id: 'abs-reopen', name: 'app_reload', arguments: { project } },
    { id: 'abs-compile', name: 'project_build', arguments: { project } })
  evidence.candidateSha256 = sha(final)
  await harness.prompt('In this isolated project, preserve every existing block and model. Read project.abs, add the single serial print, edit its unique marker once, validate and apply ABS, reopen, then compile. Never upload or touch other projects.')
  assert.equal(harness.messages().filter(message => message.role === 'assistant').at(-1).stopReason, 'stop')
  assert.equal(evidence.tools.filter(tool => tool.name === 'edit').length, duplicateOwners ? 2 : 1)
  assert.equal(evidence.tools.filter(tool => tool.name === 'write').length, 1)
  assert.ok(evidence.validated && evidence.applied && evidence.reopened)
  assert.equal(evidence.applyReceipt.candidate.hash, 'sha256:' + evidence.candidateSha256)
  if (duplicateOwners) {
    const committed = await fs.readFile(absPath, 'utf8')
    assert.equal(committed.includes('\r'), false)
    assert.equal(committed.includes(after), true)
    assert.equal(committed.includes(before), false)
    evidence.savedLineEnding = 'LF'
  }
  evidence.transport = bridge.snapshot()
  assert.deepEqual(evidence.transport.failures, [])
  assert.equal(evidence.transport.createCount, 1)
  const lost = evidence.transport.operations.find(value => value.headersLost)
  assert.equal(lost.acceptedToolCallId, 'abs-edit-once')
  assert.equal(lost.acceptedToolResultSha256, editResultSha256, 'The accepted POST must carry the actual SDK edit result unchanged')
  assert.equal(lost.postCount, 1)
  assert.equal(lost.providerInvocations, 1)
  if (liveRecovery) {
    assert.equal(lost.stateReads, 2, 'Reuse submission-state proof, then freeze the watermark again after the second disconnect')
    assert.equal(lost.eventReads, 2)
    assert.equal(lost.earlyClientDisconnect, undefined, 'A healthy thinking stream must not be cancelled by a recovery timer')
    assert.ok(lost.liveDurationMs >= evidence.requiredHealthyStreamMs)
    assert.ok(lost.liveThinkingEvents > 250)
    assert.equal(lost.livePhase, 'completed')
    assert.ok(lost.secondResumeAfter > 1 && lost.secondResumeAfter <= lost.secondDisconnectSequence)
    assert.equal(evidence.transport.interruptCount, 0, 'Connection recovery is not cancellation of the original operation')
    for (const tool of plan) assert.equal(evidence.tools.filter(actual => actual.id === tool.id).length, 1,
      'The real SDK must never execute an already completed tool twice')
  } else {
    assert.equal(lost.stateReads, 1)
    assert.equal(lost.eventReads, 1)
  }
  evidence.compiled = latestBuild
  const sketch = await fs.readFile(path.join(project, '.temp/sketch/sketch.ino'), 'utf8')
  assert.ok(sketch.includes(after))
  assert.equal(sketch.includes(before), false)
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
  assert.deepEqual(await seedHashes(), sourceBefore)
  evidence.sourceSeedPreserved = true
  evidence.ok &&= process.exitCode !== 1
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(evidence, null, 2))
  console.log(evidence.ok ? 'PASS' : 'FAIL', path.join(output, 'result.json'))
}
