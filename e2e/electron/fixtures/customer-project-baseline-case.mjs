import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { createRecoveredAgentHarness } from '../../fixtures/abs-agent-tools.mjs'
import { prepareCustomerLocalLibrary, installCustomerLocalLibrary } from './customer-local-library.mjs'
import { readCustomerNativeDocument, runCustomerStateLayoutOperations } from './customer-state-layout.mjs'

export function indexCustomerProject(document) {
  const blocks = new Map()
  const visit = block => {
    if (!block || typeof block.type !== 'string') return
    assert.equal(typeof block.id, 'string')
    assert.equal(blocks.has(block.id), false, 'Duplicate persisted block identity')
    blocks.set(block.id, block)
    for (const input of Object.values(block.inputs ?? {})) { visit(input.block); visit(input.shadow) }
    visit(block.next?.block)
  }
  for (const page of document.pages) for (const block of page.content.blocks?.blocks ?? []) visit(block)
  for (const block of document.sharedModel?.procedureBlocks ?? []) visit(block)
  return blocks
}

export function customerProjectSummary(document) {
  const blocks = [...indexCustomerProject(document).values()]
  return { blocks: blocks.length, pages: document.pages.length,
    variables: document.sharedModel?.variables?.length ?? 0,
    commentBlocks: blocks.filter(block => block.type === 'cpp_comment').length,
    commentIcons: blocks.filter(block => block.icons?.comment).length }
}

/** Observe genuine native Realm progress; no callbacks or results are replaced. */
export async function observeCustomerNativeProgress(page) {
  await page.evaluate(() => {
    const original = window.MessageChannel
    const editor = window.ng.getComponent(document.querySelector('app-blockly-editor')).blocklyService
    const originals = {}
    const stats = window.__customerBaselineNative = { observations: [], snapshotCalls: 0, workspaceJsonCalls: 0, realms: 0 }
    for (const [method, counter] of [['captureProjectSnapshot', 'snapshotCalls'], ['getWorkspaceJson', 'workspaceJsonCalls']]) {
      originals[method] = editor[method]
      editor[method] = function (...args) { stats[counter]++; return originals[method].apply(this, args) }
    }
    function ObservedChannel(...args) {
      const channel = new original(...args)
      channel.port1.addEventListener('message', event => {
        const value = event.data
        if (!value?.ui) return
        const ui = Object.fromEntries(Object.entries(value.ui).filter(([, n]) => typeof n === 'number' && Number.isFinite(n)))
        stats.observations.push({ ...(typeof value.phase === 'string' ? { phase: value.phase } : {}), ui })
      })
      stats.realms++
      return channel
    }
    ObservedChannel.prototype = original.prototype
    Object.setPrototypeOf(ObservedChannel, original)
    window.MessageChannel = ObservedChannel
    window.__customerBaselineRestoreObservation = () => {
      window.MessageChannel = original
      for (const [method, implementation] of Object.entries(originals)) editor[method] = implementation
    }
  })
}

/** Read-only component diagnosis, deliberately independent of ABS authorization.
 * This exercises the same disposable evaluator as workspace refresh; it does
 * not issue a generation, edit a candidate, apply, save or repair the baseline.
 */
export async function runCustomerNativeComponentCase({ page, project, modules, phase, evidence }) {
  evidence.componentOnly = { absValidateCalled: false, candidateApplied: false, baselineAuthorizationProduced: false, modules,
    ownReplayInputs: true, timeoutMs: 30000, runs: [] }
  for (const run of ['cold', 'warm']) {
    await phase('readonly-native-component-' + run)
    const before = await page.evaluate(() => structuredClone(window.__customerBaselineNative))
    const response = await page.evaluate(async ({ project, modules }) => {
      const imported = {}
      for (const [name, entry] of Object.entries(modules)) {
        const url = new URL(entry.file, document.baseURI)
        const source = await (await fetch(url, { cache: 'no-store' })).arrayBuffer()
        const actual = [...new Uint8Array(await crypto.subtle.digest('SHA-256', source))]
          .map(value => value.toString(16).padStart(2, '0')).join('')
        if (actual !== entry.sha256) throw Error('Native diagnostic module does not match the paired renderer build')
        imported[name] = (await import(url.href))[name]
        if (typeof imported[name] !== 'function') throw Error('Native diagnostic export is unavailable')
      }
      const component = window.ng.getComponent(document.querySelector('app-blockly-editor'))
      if (component.projectService.currentProjectPath !== project) throw Error('Unexpected project during native observation')
      const editor = component.blocklyService
      const replay = editor.captureNativeReplay(), state = editor.getWorkspaceJson()
      const before = editor.captureProjectSnapshot(), started = performance.now()
      try {
        const verified = await imported.evaluateNativeCandidate({ steps: replay.steps, graphics: replay.graphics,
          blocks: [], verify: { state, contracts: { fields: {} } } },
        { assertCurrent: replay.assertCurrent, timeoutMs: 30000 })
        replay.assertCurrent()
        if (editor.captureProjectSnapshot().revision !== before.revision) throw Error('The real source changed during component observation')
        // The evaluator's transfer decoder already returns JSON data and this
        // nonempty real program has its blocks container. No state is patched.
        imported.assertAbsReadback(state, verified.state)
        return { ok: true, elapsedMs: performance.now() - started, sourceText: JSON.stringify(state),
          resultText: JSON.stringify(verified.state), structures: verified.structures.length }
      } catch (error) {
        return { ok: false, elapsedMs: performance.now() - started, code: error.code,
          diagnostic: error.diagnostic && { phase: error.diagnostic.phase, reason: error.diagnostic.reason,
            nativeTiming: error.diagnostic.nativeTiming }, message: String(error.message).slice(0, 1500) }
      }
    }, { project, modules })
    const after = await page.evaluate(() => structuredClone(window.__customerBaselineNative))
    const observations = after.observations.slice(before.observations.length)
    const { sourceText, resultText, ...summary } = response
    const hash = text => import('node:crypto').then(({ createHash }) => createHash('sha256').update(text).digest('hex'))
    const outcome = { run, ...summary, realms: after.realms - before.realms,
      snapshotCalls: after.snapshotCalls - before.snapshotCalls,
      maximumUiSnapshots: observations.length ? Math.max(...observations.map(value => value.ui.snapshots ?? 0)) : null,
      maximumUiCallbacks: observations.length ? Math.max(...observations.map(value => value.ui.callbacks ?? 0)) : null,
      observations }
    if (response.ok) {
      outcome.sourceSha256 = await hash(sourceText); outcome.readbackSha256 = await hash(resultText)
      outcome.exactSerializedReadback = sourceText === resultText
      const source = JSON.parse(sourceText), actual = JSON.parse(resultText)
      const wrap = state => ({ pages: [{ content: state }], sharedModel: { procedureBlocks: [] } })
      const sourceIds = [...indexCustomerProject(wrap(source)).keys()].sort()
      const actualIds = [...indexCustomerProject(wrap(actual)).keys()].sort()
      assert.deepEqual(actualIds, sourceIds)
      outcome.blocks = actualIds.length; outcome.variables = actual.variables?.length ?? 0
      outcome.fullRequestedReadbackVerified = true
    }
    evidence.componentOnly.runs.push(outcome)
    await phase('readonly-native-component-' + run + '-settled')
    assert.equal(response.ok, true, 'Read-only component failed; it did not authorize or apply any ABS')
  }
}

const safeResult = result => ({ ok: result?.ok, code: result?.code, generation: result?.generation,
  error: typeof result?.error === 'string' ? result.error.slice(0, 1000) : undefined,
  publication: result?.publication && { status: result.publication.status, generation: result.publication.generation },
  candidateHash: result?.receipt?.candidate?.hash,
  runtimeSync: result?.runtimeSync && { ok: result.runtimeSync.ok, ready: result.runtimeSync.ready,
    requiresReload: result.runtimeSync.requiresReload },
  stateVerification: result?.stateVerification,
  validation: result?.receipt?.validation ?? result?.validation,
  applyVerification: result?.applyVerification && { ok: result.applyVerification.ok },
  diagnostic: result?.diagnostic && { phase: result.diagnostic.phase, reason: result.diagnostic.reason,
    nativeTiming: result.diagnostic.nativeTiming },
  inspection: result?.diagnostics && { status: result.diagnostics.status, issues: result.diagnostics.issues,
    generation: result.diagnostics.generation, rebindOffered: !!result.diagnostics.rebind,
    inPlaceRecovery: result.diagnostics.inPlaceRecovery, loadRecovery: result.diagnostics.loadRecovery,
    runtimeRecovery: result.diagnostics.runtimeRecovery },
  nextAction: result?.nextAction && { tool: result.nextAction.tool, action: result.nextAction.input?.action } })

export async function runCustomerBaselineCase({ project, suite, home, appData, agentRoot, hostPid, page, phase, evidence, originalDocument,
  exerciseSelfOperations = false, exerciseDependencyOperations = false }) {
  const profileRoot = path.join(suite, 'agent-profile'), absPath = path.join(project, 'project.abs')
  const localLibrary = exerciseDependencyOperations ? await prepareCustomerLocalLibrary({ suite, project }) : undefined
  const observedMenuIds = new Set()
  Object.assign(process.env, { AILY_LIBRARY_HOST_PID: String(hostPid), AILY_APPDATA_PATH: appData,
    PI_CODING_AGENT_DIR: profileRoot, HOME: home, USERPROFILE: home, PI_OFFLINE: '1' })
  const same = (a, b) => typeof a === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
  const harness = await createRecoveredAgentHarness({ agentRoot, sourceProject: project, globalRoot: suite, profileRoot,
    async configureRegistry(context) {
      if (!exerciseDependencyOperations) return
      for (const [relative, name] of [
        ['library/lib-install-local', 'registerLibInstallLocal'], ['project/blocks-tidy', 'registerBlocksTidy'],
        ['app-window/app-menu-list', 'registerAppMenuList'], ['app-window/app-menu-execute', 'registerAppMenuExecute']
      ]) {
        const module = await import(pathToFileURL(path.join(agentRoot, 'dist/blockly/tools/registrars', relative + '.js')).href)
        module[name](context)
      }
    },
    permissionApproval(request) {
      if (request.toolName === 'app_menu_list') return exerciseDependencyOperations
      if (request.toolName === 'app_menu_execute') return observedMenuIds.has(request.input?.itemId)
      if (['read', 'edit'].includes(request.toolName)) return same(request.input?.path, absPath)
      if (request.toolName === 'lib_install_local') return !!localLibrary
        && same(request.input?.project, project) && same(request.input?.source, localLibrary.source)
      return same(request.input?.project, project)
        && ['project_recover', 'project_save', 'abs_export', 'abs_validate', 'abs_apply',
          ...(exerciseDependencyOperations ? ['blocks_tidy', 'blocks_set_state'] : [])].includes(request.toolName)
    } })
  const calls = evidence.tools = []
  const call = async (name, input) => {
    const before = await page.evaluate(() => structuredClone(window.__customerBaselineNative))
    const started = Date.now(), response = await harness.call(name, input, { allowError: true })
    const after = await page.evaluate(() => structuredClone(window.__customerBaselineNative))
    const observations = after.observations.slice(before.observations.length)
    const entry = { tool: name, action: input.action, elapsedMs: Date.now() - started, isError: response.isError,
      ...(response.isError ? { failureText: response.text.slice(0, 2500) } : {}),
      result: safeResult(response.structured), native: {
        realms: after.realms - before.realms, snapshots: after.snapshotCalls - before.snapshotCalls,
        workspaceJsonCalls: after.workspaceJsonCalls - before.workspaceJsonCalls,
        maximumUiSnapshots: observations.length ? Math.max(...observations.map(v => v.ui.snapshots ?? 0)) : null,
        maximumUiCallbacks: observations.length ? Math.max(...observations.map(v => v.ui.callbacks ?? 0)) : null,
        observations } }
    calls.push(entry)
    await phase('tool-settled-' + name)
    return response
  }
  const requireSuccess = (response, operation, structured = true) => {
    assert.equal(response.isError, false, `${operation} blocked; see structured diagnostic in result.json`)
    if (structured) assert.equal(response.structured?.ok, true, `${operation} did not confirm success`)
    return response.structured
  }
  try {
    await phase('automatically-bind-copied-scope')
    const exported = requireSuccess(await call('abs_export', { project }), 'Automatic copied-scope export')
    assert.ok(exported?.generation, 'Export must supply the actual current generation')
    const noOp = requireSuccess(await call('abs_validate', { project, generation: exported.generation, absPath }), 'Whole exported candidate validation')
    assert.equal((noOp.receipt?.validation ?? noOp.validation)?.ok, true)
    const source = await fs.readFile(absPath, 'utf8')
    const lines = source.split(/\r?\n/)
    const candidate = lines.map((line, index) => ({ line, index,
      match: line.trim().startsWith('#') ? null : /\b(cpp_comment|text)\(("(?:\\.|[^"\\])*")/.exec(line) }))
      .find(item => item.match && lines.filter(line => line === item.line).length === 1
        && [...indexCustomerProject(originalDocument).values()].flatMap(block => Object.values(block.fields ?? {}))
          .filter(value => value === JSON.parse(item.match[2])).length === 1)
    assert.ok(candidate, 'A unique actual string field is required for a legitimate minimal derived edit')
    await call('read', { path: absPath, offset: candidate.index + 1, limit: 1 })
    const oldValue = JSON.parse(candidate.match[2]), newValue = oldValue + ' [customer-baseline-roundtrip]'
    const newLine = candidate.line.replace(candidate.match[0], candidate.match[1] + '(' + JSON.stringify(newValue))
    const intendedCandidateHash = 'sha256:' + createHash('sha256').update(source.replace(candidate.line, newLine)).digest('hex')
    requireSuccess(await call('edit', { path: absPath, edits: [{ oldText: candidate.line, newText: newLine }] }), 'Actual provenanced field edit', false)
    let expectedDocument
    if (exerciseDependencyOperations) {
      evidence.dependencyOperations = { actualSdkToolChain: true, fabricatedToolResults: false,
        originalGeneration: exported.generation, originalCandidateHash: intendedCandidateHash,
        actualNpmExecuted: false, customerLifecycleScriptsExecuted: false }
      const beforeInstall = await readCustomerNativeDocument(page, project)
      await phase('install-local-library-through-real-sdk-tool')
      evidence.dependencyOperations.library = await installCustomerLocalLibrary({ fixture: localLibrary,
        call, page, readCandidate: () => fs.readFile(harness.history.mapWorkspaceReadPath(absPath)),
        getGuardSnapshot: () => harness.guard.snapshot(project),
        candidateHash: intendedCandidateHash, intentGeneration: exported.generation })
      evidence.dependencyOperations.actualNpmExecuted = true
      evidence.dependencyOperations.candidateBackup = evidence.dependencyOperations.library.candidateBackup
      assert.deepEqual(await readCustomerNativeDocument(page, project), beforeInstall,
        'Installing an unused fixture library must preserve the complete native document')
      await phase('validate-original-candidate-after-local-library-runtime-ready')
      const continued = requireSuccess(await call('abs_validate', { project, generation: exported.generation, absPath }),
        'Original candidate after actual dependency/runtime synchronization')
      assert.equal(continued.receipt?.candidate?.hash, intendedCandidateHash,
        'Runtime synchronization must not substitute the exported saved canvas for the original candidate')
      evidence.dependencyOperations.originalCandidateValidatedAcrossRuntimeChange = true
      expectedDocument = await runCustomerStateLayoutOperations({ page, project, call, phase, evidence })
    }
    if (exerciseSelfOperations || exerciseDependencyOperations) {
      await phase('save-current-canvas-with-unapplied-draft')
      const saved = requireSuccess(await call('project_save', { project }), 'Canvas save while original candidate is pending')
      assert.equal(saved.workflowVerification?.candidateApplied, false, 'Saving the current canvas cannot claim the draft applied')
      await phase('read-current-projection-without-discarding-draft')
      requireSuccess(await call('abs_export', { project }), 'Projection read with retained original candidate')
      evidence.cases.push({ name: 'edit-save-export-continue-original-candidate', ok: true, automatic: true })
    }
    const validated = requireSuccess(await call('abs_validate', { project, generation: exported.generation, absPath }), 'Whole derived candidate validation')
    assert.equal((validated.receipt?.validation ?? validated.validation)?.ok, true)
    assert.equal(validated.receipt?.candidate?.hash, intendedCandidateHash, 'Validation must use the retained edited candidate, not the saved canonical view')
    const applied = requireSuccess(await call('abs_apply', { project, generation: exported.generation, absPath }), 'Whole derived candidate application')
    assert.equal(applied.publication?.status, 'COMMITTED')
    assert.equal(applied.applyVerification?.ok, true)
    assert.equal(applied.receipt?.candidate?.hash, intendedCandidateHash,
      'Application must use the same original candidate through every system-owned change')
    if (exerciseDependencyOperations) {
      evidence.dependencyOperations.originalCandidateApplied = true
      evidence.cases.push({ name: 'edit-install-runtime-tidy-state-save-export-continue-original-candidate', ok: true,
        actualNpmExecuted: true, customerLifecycleScriptsExecuted: false })
    }
    requireSuccess(await call('project_save', { project }), 'Project save')
    if (exerciseDependencyOperations) {
      const menu = requireSuccess(await call('app_menu_list', {}), 'Actual host menu inspection')
      const flatten = items => items.flatMap(item => [item, ...flatten(item.children ?? [])])
      for (const action of ['project-save', 'project-save-as']) {
        const item = flatten(menu.items).find(item => item.action === action)
        assert.ok(item && item.automationBlocked, 'The actual menu must advertise its candidate-aware automation boundary')
        observedMenuIds.add(item.id)
        const rejected = await call('app_menu_execute', { itemId: item.id, confirm: true })
        assert.equal(rejected.structured?.commandDispatched, false)
        assert.equal(rejected.structured?.requiresUserAction, false)
        assert.equal(rejected.structured?.code, action === 'project-save-as'
          ? 'PROJECT_RECOVERY_IN_PLACE_REQUIRED' : 'PROJECT_SAVE_REQUIRES_TOOL')
      }
      evidence.cases.push({ name: 'menu-cannot-bypass-candidate-save-or-create-recovery-project', ok: true })
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const rejected = await call('project_recover', { project, action: 'fork', requestId: randomUUID() })
      assert.equal(rejected.structured?.code, 'PROJECT_RECOVERY_IN_PLACE_REQUIRED')
      assert.equal(rejected.structured?.commandDispatched, false)
    }
    const projects = []
    for (const entry of await fs.readdir(suite, { withFileTypes: true })) if (entry.isDirectory()) {
      try { if ((await fs.stat(path.join(suite, entry.name, 'project.abi'))).isFile()) projects.push(entry.name) }
      catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    assert.deepEqual(projects, ['project'], 'Automatic tool/recovery operations must not create another user project')
    evidence.cases.push({ name: 'repeated-legacy-fork-rejected-with-no-new-projects', ok: true })
    await harness.settle()
    evidence.sdk = { actualSdkSession: true, fabricatedToolResults: false, llmInvoked: false,
      originalGeneration: exported.generation, publishedGeneration: applied.publication.generation,
      derivedEdit: { kind: 'single-string-field', blockType: candidate.match[1], originalLine: candidate.index + 1 },
      helperScriptsExecuted: false }
    return { oldValue, newValue, ...(expectedDocument ? { expectedDocument } : {}) }
  } finally { evidence.sdkProof = harness.proof(); await harness.dispose() }
}
