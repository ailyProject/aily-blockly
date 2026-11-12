import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { createRecoveredAgentHarness } from '../../fixtures/abs-agent-tools.mjs'
import { hantaiControlSource } from './hantai-control-source.mjs'

const hash = value => 'sha256:' + createHash('sha256').update(value).digest('hex')
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
const inside = (root, file) => {
  const relative = path.relative(root, file)
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
}

// This module only acts when explicitly invoked by the Root-owned real Host
// runner. It never launches a Host, calls a model, edits private metadata, or
// injects transport results. All publication uses the current genuine SDK.
export async function runHantaiNativeControl({ page, app, project, suite, output,
  agentRoot, globalRoot, appData = globalRoot, profileRoot: requestedProfileRoot, mode = 'original' }) {
  for (const [name, value] of Object.entries({ project, suite, output, agentRoot, globalRoot, appData }))
    assert.ok(path.isAbsolute(value), name + ' must be explicit and absolute')
  assert.ok(inside(suite, project), 'Use only the fresh Root-owned user-project fixture')
  assert.ok(['minimal-field', 'original'].includes(mode))
  const destination = path.join(output, 'hantai-native-' + mode)
  await fs.mkdir(destination, { recursive: false })
  const profileRoot = requestedProfileRoot ?? path.join(suite, 'capacity-agent-' + randomUUID())
  assert.ok(inside(suite, profileRoot))
  await fs.mkdir(profileRoot, { recursive: true })
  const resultFile = path.join(destination, 'result.json')
  const result = { ok: false, mode, project, actualSdkTools: true, actualInstalledHost: true,
    llmInvoked: false, modelSteering: false, syntheticToolResults: false,
    metadataEditedByHarness: false, hardwareUsed: false, compileRequested: false,
    calls: [], runs: [], reproductionComplete: false, businessPassed: false,
    limitations: ['The supplied ZIP is already a historical keep_view recovery result. Moving its path exercises current copied-location handling, not the exact lost historical pre-recovery state.'],
    startedAt: new Date().toISOString() }
  const persist = () => fs.writeFile(resultFile, JSON.stringify(result, null, 2))
  const snapshot = async label => {
    const ui = await page.evaluate(() => {
      const editor = window.ng.getComponent(document.querySelector('app-blockly-editor'))
      const header = window.ng.getComponent(document.querySelector('app-header'))
      const capture = editor.blocklyService.captureRecoverySnapshot()
      return { project: header.projectService.currentProjectPath, documentText: capture.documentText,
        load: header.projectService.getBlocklyProjectLoadStatus(header.projectService.currentProjectPath),
        hasUnsavedProjectChanges: header.hasUnsavedProjectChanges,
        aiNoticeTexts: [...document.querySelectorAll('app-ai-notice')].map(node => node.textContent) }
    })
    assert.ok(same(ui.project, project), 'The real Host must remain in the original test project')
    const native = JSON.parse(ui.documentText)
    await fs.writeFile(path.join(destination, label + '-native.json'), JSON.stringify(native, null, 2))
    const files = {}
    for (const relative of ['project.abi', 'project.abs', 'project.abs.map.json', 'package.json', 'package-lock.json']) {
      const bytes = await fs.readFile(path.join(project, relative)).catch(error => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      files[relative] = bytes === null ? null : { hash: hash(bytes), bytes: bytes.length }
      if (relative === 'project.abi' && bytes) {
        files[relative].nativeMatchesDisk = isDeepStrictEqual(native, JSON.parse(bytes))
        await fs.writeFile(path.join(destination, label + '-saved-abi.json'), bytes)
      }
    }
    return { ui: { ...ui, documentText: undefined }, native, files, nativeHash: hash(JSON.stringify(native)) }
  }
  const envKeys = ['AILY_LIBRARY_HOST_PID', 'AILY_APPDATA_PATH', 'PI_CODING_AGENT_DIR', 'PI_OFFLINE', 'HOME', 'USERPROFILE']
  const previousEnv = Object.fromEntries(envKeys.map(name => [name, process.env[name]]))
  let harness
  try {
    result.beforeSdk = await snapshot('before-sdk')
    const originalBytes = await fs.readFile(path.join(project, 'project.abs'))
    const extraction = JSON.parse(await fs.readFile(path.join(output, 'original-user-zip-extraction.json')))
    const member = extraction.records.find(record => record.relative === 'project.abs' && !record.skipped)
    assert.ok(member, 'Require the verified original user ZIP extraction receipt')
    assert.equal(hash(originalBytes).slice(7), member.zipContentSha256, 'Submit the actual original ZIP ABS, not a re-export')
    const originalSource = originalBytes.toString('utf8')
    result.originalSource = { hash: hash(originalBytes), bytes: originalBytes.length, zipMemberVerified: true }
    const hostPid = await app.evaluate(() => process.pid)
    assert.ok(Number.isSafeInteger(hostPid) && hostPid > 0)
    result.hostPid = hostPid
    const hostHome = await app.evaluate(() => process.env.USERPROFILE)
    assert.ok(path.isAbsolute(hostHome) && inside(suite, hostHome))
    const descriptorFile = path.join(hostHome, '.aily-blockly/cli-bridge', hostPid + '.json')
    const descriptor = JSON.parse(await fs.readFile(descriptorFile))
    assert.equal(descriptor.pid, hostPid)
    result.discoveryIdentity = { hostHome, descriptorFile, exactPidVerified: true, credentialsPrinted: false }
    Object.assign(process.env, { AILY_LIBRARY_HOST_PID: String(hostPid), AILY_APPDATA_PATH: appData,
      PI_CODING_AGENT_DIR: profileRoot, PI_OFFLINE: '1', HOME: hostHome, USERPROFILE: hostHome })
    const absPath = path.join(project, 'project.abs')
    harness = await createRecoveredAgentHarness({ agentRoot, sourceProject: project, globalRoot, profileRoot,
      persistToolTranscript: true,
      onStage(name) { result.harnessStage = name },
      permissionApproval(request) {
        if (request.toolName === 'read') return same(request.input?.path ?? '', absPath)
        return ['project_recover', 'abs_export', 'abs_apply'].includes(request.toolName)
          && same(request.input?.project ?? '', project)
      } })
    const call = async (name, input) => {
      const startedAt = Date.now()
      const actual = await harness.call(name, input, { allowError: true })
      const value = actual.structured ?? { ok: false, unstructured: true, text: actual.text }
      const record = { name, input, startedAt, elapsedMs: Date.now() - startedAt,
        isError: actual.isError === true, result: value }
      result.calls.push(record)
      await fs.appendFile(path.join(destination, 'actual-tool-results.jsonl'), JSON.stringify(record) + '\n')
      await persist()
      return value
    }
    // Exercise the real before_agent_start automatic same-project capture and
    // migration. Do not reproduce the retired resolve/repair protocol manually.
    await harness.settle()
    result.turnStart = await harness.beginTurn('Inspect this original user project and verify one controlled ABS field edit without compilation or hardware upload.')
    result.inspection = await call('project_recover', { project, action: 'inspect' })
    const next = result.inspection.nextAction
    if (next?.tool === 'project_recover' && next.input?.action === 'recover_project') {
      assert.ok(same(next.input.project, project))
      result.automaticRecovery = await call('project_recover', { project, action: 'recover_project' })
      if (!result.automaticRecovery.ok) {
        result.outcome = 'same-project-recovery-blocked'
        result.reproductionComplete = true
        return result
      }
    }
    for (const runMode of [mode]) {
      const run = { mode: runMode }
      result.runs.push(run)
      const source = originalSource
      const control = hantaiControlSource(result.beforeSdk.native, source, runMode)
      const candidate = control.source
      run.controlledEdit = control.edit
      run.source = { bytes: Buffer.byteLength(source), hash: hash(source) }
      run.candidate = { bytes: Buffer.byteLength(candidate), hash: hash(candidate) }
      await fs.writeFile(path.join(destination, runMode + '-submitted-candidate.abs'), candidate)
      run.beforeApply = await snapshot(runMode + '-before-apply')
      run.apply = await call('abs_apply', { project, abs: candidate })
      run.afterApply = await snapshot(runMode + '-after-apply')
      run.nativeUnchanged = isDeepStrictEqual(run.beforeApply.native, run.afterApply.native)
      run.savedAbiUnchanged = isDeepStrictEqual(run.beforeApply.files['project.abi'], run.afterApply.files['project.abi'])
      run.protectedPackageFilesUnchanged = ['package.json', 'package-lock.json'].every(file =>
        isDeepStrictEqual(run.beforeApply.files[file], run.afterApply.files[file]))
      if (!run.apply.ok) {
        assert.equal(run.nativeUnchanged, true, 'A failed native preparation must preserve complete Native')
        assert.equal(run.savedAbiUnchanged, true, 'A failed native preparation must preserve saved ABI')
        run.outcome = run.apply.code === 'ABS_LIMIT' ? 'actual-host-capacity-failure-reproduced' : 'actual-host-other-failure'
      } else {
        assert.equal(run.afterApply.files['project.abi'].nativeMatchesDisk, true)
        assert.equal(run.apply.publication?.status, 'COMMITTED')
        assert.equal(run.apply.applyVerification?.ok, true)
        assert.equal(run.apply.requiresReload, false)
        assert.deepEqual(run.afterApply.native, control.expectedNative, 'The complete actual Native must equal the original or exact one-field change')
        run.outcome = 'actual-host-application-committed'
      }
      assert.equal(run.protectedPackageFilesUnchanged, true)
      await persist()
    }
    result.outcome = result.runs.every(run => run.apply?.ok) ? 'original-source-control-committed' : 'actual-current-host-failure-observed'
    result.reproductionComplete = true
    result.businessPassed = result.runs.every(run => run.apply?.ok === true)
    result.ok = result.businessPassed
    return result
  } catch (error) {
    result.error = { name: error.name, code: error.code, message: String(error.message) }
    throw error
  } finally {
    if (harness) {
      try { await harness.settle(); result.settled = true }
      catch (error) { result.settlementError = { name: error.name, code: error.code, message: String(error.message) } }
      result.sdkProof = harness.proof()
      try { await harness.dispose(); result.harnessDisposed = true }
      catch (error) { result.disposalError = { name: error.name, code: error.code, message: String(error.message) } }
    }
    for (const name of envKeys) {
      if (previousEnv[name] === undefined) delete process.env[name]
      else process.env[name] = previousEnv[name]
    }
    result.finishedAt = new Date().toISOString()
    await persist()
  }
}

export const runControl = runHantaiNativeControl
