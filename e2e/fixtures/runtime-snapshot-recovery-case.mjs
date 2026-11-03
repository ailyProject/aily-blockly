import assert from 'node:assert/strict'

/** Own isolated renderer only. The real loader loads its first root and then
 * fails once; all recovery/ABS/file edits continue through actual SDK tools. */
export async function runRuntimeSnapshotRecoveryCase({ page, harness, project, generation, absPath,
  before, canonicalHash, candidateHash, readCandidateHash, nativeDocument, stage, captureUi, changeRuntimeInput }) {
  await stage('runtime-snapshot-partial-load-fault')
  const fault = await page.evaluate(async expected => {
    const component = window.ng.getComponent(document.querySelector('app-blockly-editor'))
    const editor = component.blocklyService, native = component._projectService
    if (native.currentProjectPath.replaceAll('\\', '/').toLowerCase() !== expected.replaceAll('\\', '/').toLowerCase())
      throw new Error('Refuse a partial-load fault outside this isolated project')
    const original = editor.loadWorkspaceJson
    if (typeof original !== 'function' || typeof native.rebuildLibraryRuntime !== 'function')
      throw new Error('Actual native loader/runtime rebuild is unavailable')
    const audit = { fired: 0, originalRootCount: 0, loadedRootCount: 0 }
    editor.loadWorkspaceJson = function (json, clone, owner) {
      this.loadWorkspaceJson = original
      const partial = structuredClone(json), roots = partial?.blocks?.blocks
      if (!Array.isArray(roots) || roots.length < 2) throw new Error('The fixture requires at least two native roots before partial loading')
      audit.originalRootCount = roots.length
      partial.blocks.blocks = roots.slice(0, 1)
      original.call(this, partial, true, owner)
      audit.loadedRootCount = this.workspace.getTopBlocks(false).length
      audit.fired++
      throw new Error('ISOLATED_NATIVE_PARTIAL_LOAD_ONCE')
    }
    let failure
    try {
      await native.rebuildLibraryRuntime({ projectPath: expected, packageJson: native.currentPackageData,
        libraryNames: [...editor.loadedLibraryInfos.values()].map(item => item.packageName) })
    } catch (error) { failure = { code: error.code, message: error.message } }
    finally { editor.loadWorkspaceJson = original }
    return { ...audit, failure, blocked: editor.isWorkspaceEditBlocked(), ready: editor.generatorRuntime.isReady() }
  }, project)
  assert.equal(fault.fired, 1, 'The real native loader must fail after loading only its first root')
  assert.equal(fault.loadedRootCount, 1)
  assert.ok(fault.originalRootCount > fault.loadedRootCount)
  assert.equal(fault.failure?.code, 'BLOCKLY_RUNTIME_RECOVERY_REQUIRED')
  assert.equal(fault.blocked, true)
  assert.equal(fault.ready, false)
  assert.notEqual(canonicalHash(await nativeDocument()), canonicalHash(before), 'The failed live canvas must actually be partial')
  assert.equal(await readCandidateHash(), candidateHash, 'Native loading must not overwrite the pending ABS candidate')

  await stage('manual-save-and-native-exit-retain-full-snapshot')
  const recoveryDialog = page.locator('.ant-modal').filter({ hasText: '完整画布已受保护' })
  await page.keyboard.press('Control+s')
  await recoveryDialog.waitFor({ state: 'visible', timeout: 15000 })
  assert.match(await recoveryDialog.innerText(), /保存完整恢复副本/)
  await captureUi?.('runtime-snapshot-manual-save')
  await recoveryDialog.getByRole('button', { name: /^(取消|Cancel)$/ }).click()
  await recoveryDialog.waitFor({ state: 'hidden' })
  await page.evaluate(() => window.iWindow.close())
  await recoveryDialog.waitFor({ state: 'visible', timeout: 15000 })
  assert.match(await recoveryDialog.innerText(), /保存完整副本并继续/)
  await recoveryDialog.getByRole('button', { name: /^(取消|Cancel)$/ }).click()
  await recoveryDialog.waitFor({ state: 'hidden' })
  assert.equal(await readCandidateHash(), candidateHash, 'Cancelling save and native exit must retain the candidate')

  await stage('actual-sdk-runtime-snapshot-inspection')
  const inspected = (await harness.call('project_recover', { project, action: 'inspect' })).structured
  assert.equal(inspected.ok, true, JSON.stringify(inspected))
  assert.equal(inspected.inspectionVerification?.scope, 'library-runtime-recovery')
  const offer = inspected.diagnostics?.runtimeRecovery
  assert.equal(offer?.status, 'available')
  assert.equal(offer.ready, false)
  assert.equal(offer.sourcePreserved, true)
  assert.equal(offer.candidateApplied, false)
  assert.match(offer.snapshotHash, /^sha256:[a-f0-9]{64}$/)
  assert.deepEqual(inspected.nextAction?.input, { project, action: 'recover_runtime', token: offer.token, requestId: offer.requestId })

  await stage('actual-sdk-original-runtime-snapshot-recovery')
  let recovered = (await harness.call('project_recover', inspected.nextAction.input, { allowError: true })).structured
  const deadline = Date.now() + 120000
  let observations = 0
  while (!recovered.ok && recovered.runtimeRecoveryObservation?.observationOnly === true) {
    assert.ok(Date.now() < deadline, 'Observe the original restoration only; do not replay after a slow result')
    const next = recovered.nextAction?.input
    assert.deepEqual(next, { project, action: 'observe_runtime', token: offer.token, requestId: offer.requestId })
    await new Promise(resolve => setTimeout(resolve, 100))
    recovered = (await harness.call('project_recover', next, { allowError: true })).structured
    observations++
  }
  assert.equal(recovered.ok, true, JSON.stringify(recovered))
  assert.equal(recovered.runtimeRecoveryVerification?.scope, 'complete-native-snapshot')
  assert.equal(recovered.runtimeRecoveryVerification.snapshotHash, offer.snapshotHash)
  assert.equal(recovered.candidateApplied, false)
  const observedCompletion = (await harness.call('project_recover', { project, action: 'observe_runtime',
    token: offer.token, requestId: offer.requestId })).structured
  assert.equal(observedCompletion.ok, true, JSON.stringify(observedCompletion))
  assert.equal(canonicalHash(await nativeDocument()), canonicalHash(before), 'The complete retained native document must replace the partial canvas')
  assert.equal(await readCandidateHash(), candidateHash, 'Recovery must not apply or replace ABS candidate bytes')

  if (changeRuntimeInput) {
    await stage('old-completion-cannot-certify-new-library-bytes')
    const restoreInput = await changeRuntimeInput()
    const fingerprint = () => page.evaluate(() => window.ng.getComponent(document.querySelector('blockly-main'))
      .projectService.getBlocklyLibraryRuntimeFingerprint())
    try {
      assert.equal(await fingerprint(), null)
      const oldReceipt = (await harness.call('project_recover', { project, action: 'observe_runtime',
        token: offer.token, requestId: offer.requestId })).structured
      assert.equal(oldReceipt.ok, true, 'Historical completion remains observable')
      assert.equal(await fingerprint(), null, 'Observing the old receipt must not certify changed library bytes')
    } finally { await restoreInput() }
  }

  const audit = await page.evaluate(() => ({ ...window.__nativeRecoveryAudit }))
  const starts = audit.requests.filter(item => item.operation === 'abs_recovery' && item.action === 'recover_runtime' && !item.observe)
  assert.equal(starts.length, 1, 'Only one original runtime restoration may be submitted')
  assert.equal(audit.rebuilds.length, 2, 'Exactly the original failed rebuild and its one protected restoration are allowed')
  assert.notEqual(audit.rebuilds[0].completed, true)
  assert.equal(audit.rebuilds[1].completed, true)
  assert.equal(canonicalHash(audit.rebuilds[0].before), canonicalHash(audit.rebuilds[1].after))
  await stage('actual-sdk-validate-restored-runtime')
  const validated = (await harness.call('abs_validate', { project, generation, absPath })).structured
  assert.equal(validated.ok, true, JSON.stringify(validated))
  assert.equal(validated.finalValidation?.scope, 'prepared-generation')
  assert.equal((await page.evaluate(() => window.__nativeRecoveryAudit.rebuilds.length)), 2,
    'A verified fresh runtime acknowledgement must not force another full reload during validation')
  return { validated, recovery: {
    scenario: 'runtime-snapshot', fault, originalFailedRebuilds: 1, protectedRuntimeRestorations: 1,
    completeCanvasPreserved: true, candidateBytesPreserved: true, candidateApplied: false,
    snapshotHash: offer.snapshotHash, observationCalls: observations + 1,
    nativeRuntimeRecoveryVerified: recovered.runtimeRecoveryVerification,
    manualSaveRecoveryChoiceVerified: true, nativeExitRecoveryChoiceVerified: true,
    oldCompletionCannotCertifyChangedInputs: !!changeRuntimeInput,
    validation: validated,
  } }
}
