import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createRecoveredAgentHarness } from '../../fixtures/abs-agent-tools.mjs'

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
  validation: result?.receipt?.validation ?? result?.validation,
  applyVerification: result?.applyVerification && { ok: result.applyVerification.ok },
  diagnostic: result?.diagnostic && { phase: result.diagnostic.phase, reason: result.diagnostic.reason,
    nativeTiming: result.diagnostic.nativeTiming },
  inspection: result?.diagnostics && { status: result.diagnostics.status, issues: result.diagnostics.issues,
    generation: result.diagnostics.generation, rebindOffered: !!result.diagnostics.rebind,
    inPlaceRecovery: result.diagnostics.inPlaceRecovery, loadRecovery: result.diagnostics.loadRecovery,
    runtimeRecovery: result.diagnostics.runtimeRecovery },
  nextAction: result?.nextAction && { tool: result.nextAction.tool, action: result.nextAction.input?.action } })

export async function runCustomerBaselineCase({ project, suite, home, appData, agentRoot, hostPid, page, phase, evidence, originalDocument }) {
  const profileRoot = path.join(suite, 'agent-profile'), absPath = path.join(project, 'project.abs')
  Object.assign(process.env, { AILY_LIBRARY_HOST_PID: String(hostPid), AILY_APPDATA_PATH: appData,
    PI_CODING_AGENT_DIR: profileRoot, HOME: home, USERPROFILE: home, PI_OFFLINE: '1' })
  const same = (a, b) => typeof a === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
  const harness = await createRecoveredAgentHarness({ agentRoot, sourceProject: project, globalRoot: suite, profileRoot,
    permissionApproval(request) {
      if (['read', 'edit'].includes(request.toolName)) return same(request.input?.path, absPath)
      return same(request.input?.project, project)
        && ['project_recover', 'project_save', 'abs_export', 'abs_validate', 'abs_apply'].includes(request.toolName)
    } })
  const calls = evidence.tools = []
  const call = async (name, input) => {
    const before = await page.evaluate(() => structuredClone(window.__customerBaselineNative))
    const started = Date.now(), response = await harness.call(name, input, { allowError: true })
    const after = await page.evaluate(() => structuredClone(window.__customerBaselineNative))
    const observations = after.observations.slice(before.observations.length)
    const entry = { tool: name, action: input.action, elapsedMs: Date.now() - started, isError: response.isError,
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
    await phase('inspect-copied-scope')
    let inspection = (await call('project_recover', { project, action: 'inspect' })).structured
    let exported
    for (let attempt = 0; attempt < 3; attempt++) {
      const rebind = inspection?.diagnostics?.rebind?.token
      const response = await call('abs_export', { project, ...(rebind ? { rebind } : {}) })
      if (!response.isError && response.structured?.ok === true) { exported = response.structured; break }
      inspection = (await call('project_recover', { project, action: 'inspect' })).structured
      const next = inspection?.nextAction
      assert.ok(next?.tool === 'project_recover' && same(next.input?.project, project)
        && ['recover_project', 'recover_runtime', 'observe_project', 'observe_runtime', 'refresh', 'repair'].includes(next.input?.action),
      'Blocked export offered no verified same-project continuation; no guard was bypassed')
      requireSuccess(await call(next.tool, next.input), 'Offered recovery')
    }
    assert.ok(exported?.generation, 'Export must supply the actual current generation')
    const noOp = requireSuccess(await call('abs_validate', { project, generation: exported.generation, absPath }), 'Whole exported candidate validation')
    assert.equal((noOp.receipt?.validation ?? noOp.validation)?.ok, true)
    const source = await fs.readFile(absPath, 'utf8')
    const lines = source.split(/\r?\n/)
    const candidate = lines.map((line, index) => ({ line, index,
      match: line.trim().startsWith('#') ? null : /\bcpp_comment\(("(?:\\.|[^"\\])*")/.exec(line) }))
      .find(item => item.match && lines.filter(line => line === item.line).length === 1
        && [...indexCustomerProject(originalDocument).values()].flatMap(block => Object.values(block.fields ?? {}))
          .filter(value => value === JSON.parse(item.match[1])).length === 1)
    assert.ok(candidate, 'A unique actual comment is required for a legitimate minimal derived edit')
    await call('read', { path: absPath, offset: candidate.index + 1, limit: 1 })
    const oldValue = JSON.parse(candidate.match[1]), newValue = oldValue + ' [customer787-baseline-roundtrip]'
    const newLine = candidate.line.replace(candidate.match[0], 'cpp_comment(' + JSON.stringify(newValue))
    requireSuccess(await call('edit', { path: absPath, edits: [{ oldText: candidate.line, newText: newLine }] }), 'Actual provenanced comment edit', false)
    const validated = requireSuccess(await call('abs_validate', { project, generation: exported.generation, absPath }), 'Whole derived candidate validation')
    assert.equal((validated.receipt?.validation ?? validated.validation)?.ok, true)
    const applied = requireSuccess(await call('abs_apply', { project, generation: exported.generation, absPath }), 'Whole derived candidate application')
    assert.equal(applied.publication?.status, 'COMMITTED')
    assert.equal(applied.applyVerification?.ok, true)
    requireSuccess(await call('project_save', { project }), 'Project save')
    await harness.settle()
    evidence.sdk = { actualSdkSession: true, fabricatedToolResults: false, llmInvoked: false,
      originalGeneration: exported.generation, publishedGeneration: applied.publication.generation,
      derivedEdit: { kind: 'single-cpp-comment-field', originalLine: candidate.index + 1 },
      helperScriptsExecuted: false }
    return { oldValue, newValue }
  } finally { await harness.dispose() }
}
