import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRecoveredAgentHarness } from '../../fixtures/abs-agent-tools.mjs'
import { prepareCustomerLocalLibrary, installCustomerLocalLibrary } from './customer-local-library.mjs'

const hash = value => 'sha256:' + createHash('sha256').update(value).digest('hex')
const same = (a, b) => typeof a === 'string' && typeof b === 'string'
  && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
const mirrors = ['project.abi', 'project.abs', 'project.abs.map.json']
const locks = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'node_modules/.package-lock.json']
const originalText = 'native_dependency_original', appliedText = 'native_dependency_applied'
const ordinaryBefore = 'ordinary-before-abort\n', ordinaryAfter = 'ordinary-after-abort\n'

async function nativeDocument(page, project) {
  const handle = await page.waitForFunction(project => {
    const editor = window.ng?.getComponent(document.querySelector('app-blockly-editor'))
    if (editor?.projectService.currentProjectPath !== project
      || editor.projectService.getBlocklyProjectLoadStatus(project)?.ready !== true) return false
    try { return editor.blocklyService.captureRecoverySnapshot().documentText }
    catch (error) {
      if (error?.code === 'BLOCKLY_EDIT_BUSY' || error?.code === 'BLOCKLY_EDIT_STALE') return false
      throw error
    }
  }, project, { timeout: 120000 })
  try { return JSON.parse(await handle.jsonValue()) } finally { await handle.dispose() }
}

async function captureFiles(project, names) {
  const result = {}
  for (const name of names) {
    try { result[name] = await fs.readFile(path.join(project, name)) }
    catch (error) { if (error.code !== 'ENOENT') throw error; result[name] = null }
  }
  return result
}

/** Add a root without changing the original program or its complete footer. */
export function appendCustomerDependencyProbe(source, blockType) {
  assert.match(blockType, /^customer_baseline_probe_[a-f0-9]{10}$/)
  const marker = '\n# @project-state:', position = source.indexOf(marker)
  assert.ok(position > 0 && source.indexOf(marker, position + marker.length) === -1,
    'Keep the one complete actual exported project-state footer')
  assert.equal(source.includes(blockType + '('), false, 'The new dependency must not already occur in the program')
  const inserted = '\n\n' + blockType + '()'
  return { oldText: marker, newText: inserted + marker,
    candidate: source.slice(0, position) + inserted + source.slice(position) }
}

/** The only accepted new native data are one host-issued ID and its root
 * coordinates. All original document data are independently reconstructed. */
export function expectedCustomerDependencyDocument(original, actual, blockType) {
  assert.equal(original.pages.length, 1, 'This independent acceptance uses a one-page owned input')
  const previousRoots = original.pages[0].content.blocks.blocks
  assert.equal(previousRoots.length, 1)
  const text = previousRoots[0]
  assert.equal(text.type, 'text')
  assert.equal(text.fields.TEXT, originalText)
  const expected = structuredClone(original)
  expected.pages[0].content.blocks.blocks[0].fields.TEXT = appliedText
  const roots = actual.pages?.[0]?.content?.blocks?.blocks
  assert.ok(Array.isArray(roots))
  const newRoots = roots.filter(block => block.id !== text.id)
  assert.equal(newRoots.length, 1, 'The host must create exactly one new root')
  const added = newRoots[0]
  assert.equal(added.type, blockType)
  assert.equal(typeof added.id, 'string')
  assert.ok(added.id.length > 0 && added.id !== text.id)
  for (const key of Object.keys(added)) assert.ok(['type', 'id', 'x', 'y'].includes(key),
    'The inert probe has no inputs, fields, next block, model or hidden state: ' + key)
  for (const key of ['x', 'y']) if (Object.hasOwn(added, key)) assert.ok(Number.isFinite(added[key]))
  expected.pages[0].content.blocks.blocks.push(structuredClone(added))
  assert.deepEqual(actual, expected, 'Only the requested string field and one actual dependency root may change')
  return { expectedDocument: expected, blockId: added.id }
}

export async function verifyCustomerNativeDependencyRuntime({ page, project, probe, readNativeDocument }) {
  const document = await (readNativeDocument ? readNativeDocument() : nativeDocument(page, project))
  const native = await page.evaluate(({ project, probe }) => {
    const editor = window.ng.getComponent(document.querySelector('app-blockly-editor'))
    if (editor.projectService.currentProjectPath !== project) throw Error('The dependency probe left its owned project')
    return { registered: typeof window.Blockly.Blocks[probe.blockType]?.init === 'function',
      runtime: editor.blocklyService.getLibraryRuntimeSnapshot() }
  }, { project, probe })
  assert.equal(native.registered, true)
  assert.equal(native.runtime.active, true)
  assert.ok(native.runtime.loadedLibraries.includes(probe.packageName))
  assert.ok(native.runtime.toolboxLibraries.includes(probe.packageName))
  assert.equal(document.pages.flatMap(page => page.content.blocks?.blocks ?? [])
    .filter(block => block.type === probe.blockType && (!probe.blockId || block.id === probe.blockId)).length, 1)
  return { nativeBlockRegistered: true, nativeProgramReferencesProbe: true, runtimeReady: true,
    runtime: native.runtime, document }
}

/** Independent real-host case: an installed library is consumed by a verified
 * native commit before ordinary SDK file work is cancelled in the same turn. */
export async function runCustomerNativeDependencyCase({ project, suite, home, appData, agentRoot, hostPid, page,
  phase, evidence, originalDocument, readNativeDocument, ordinaryFileName = 'ordinary-history-probe.txt' }) {
  assert.equal(path.basename(ordinaryFileName), ordinaryFileName)
  const ordinaryPath = path.join(project, ordinaryFileName), absPath = path.join(project, 'project.abs')
  assert.equal(await fs.readFile(ordinaryPath, 'utf8'), ordinaryBefore, 'Use only the controlled ordinary-file fixture')
  const readNative = () => readNativeDocument ? readNativeDocument() : nativeDocument(page, project)
  assert.deepEqual(await readNative(), originalDocument)
  const fixture = await prepareCustomerLocalLibrary({ suite, project })
  const profileRoot = path.join(suite, 'agent-profile')
  Object.assign(process.env, { AILY_LIBRARY_HOST_PID: String(hostPid), AILY_APPDATA_PATH: appData,
    PI_CODING_AGENT_DIR: profileRoot, HOME: home, USERPROFILE: home, PI_OFFLINE: '1' })
  const harness = await createRecoveredAgentHarness({ agentRoot, sourceProject: project, globalRoot: suite, profileRoot,
    persistToolTranscript: true,
    async configureRegistry(context) {
      const module = await import(pathToFileURL(path.join(agentRoot, 'dist/blockly/tools/registrars/library/lib-install-local.js')).href)
      module.registerLibInstallLocal(context)
    },
    permissionApproval(request) {
      assert.equal(request.permissionMode, 'default')
      if (['read', 'edit'].includes(request.toolName))
        return same(request.input?.path, absPath) || same(request.input?.path, ordinaryPath)
      if (!same(request.input?.project, project)) return false
      if (request.toolName === 'lib_install_local') return same(request.input?.source, fixture.source)
        && request.input?.force !== true && request.input?.registry === 'http://127.0.0.1:9'
      return ['abs_export', 'abs_validate', 'abs_apply'].includes(request.toolName)
    } })
  const tools = evidence.tools = []
  const call = async (name, input) => {
    await phase('native-dependency-' + name)
    const started = Date.now(), response = await harness.call(name, input, { allowError: true })
    const result = response.structured
    tools.push({ tool: name, elapsedMs: Date.now() - started, isError: response.isError,
      ...(response.isError ? { failureText: response.text.slice(0, 2500) } : {}),
      result: { ok: result?.ok, code: result?.code, generation: result?.generation,
        publication: result?.publication, candidateHash: result?.receipt?.candidate?.hash,
        applyVerification: result?.applyVerification,
        error: typeof result?.error === 'string' ? result.error.slice(0, 1500) : undefined } })
    return response
  }
  const successful = (response, operation, structured = true) => {
    assert.equal(response.isError, false, operation + ': ' + response.text.slice(0, 1800))
    if (structured) assert.equal(response.structured?.ok, true, operation + ' did not verify success')
    return response.structured
  }
  const readView = () => fs.readFile(harness.history.mapWorkspaceReadPath(absPath), 'utf8')
  let primaryFailure
  try {
    const exported = successful(await call('abs_export', { project }), 'Actual initial native export')
    assert.equal(typeof exported.generation, 'string')
    successful(await call('read', { path: absPath, offset: 1, limit: 100 }), 'Read actual initial ABS', false)
    const source = await readView(), oldText = 'text(' + JSON.stringify(originalText) + ')'
    const newText = 'text(' + JSON.stringify(appliedText) + ')'
    assert.equal(source.split(oldText).length, 2)
    successful(await call('edit', { path: absPath, edits: [{ oldText, newText }] }), 'Track the requested string edit', false)
    const initialCandidate = source.replace(oldText, newText), initialCandidateHash = hash(initialCandidate)
    assert.equal(hash(await readView()), initialCandidateHash)
    evidence.nativeDependency = { independentOwnedInput: true, llmInvoked: false,
      installation: await installCustomerLocalLibrary({ fixture, call, page,
        readCandidate: readView, getGuardSnapshot: () => harness.guard.snapshot(project),
        candidateHash: initialCandidateHash, intentGeneration: exported.generation }) }

    successful(await call('read', { path: absPath, offset: 1, limit: 100 }), 'Read retained editable ABS after installation', false)
    const retained = await readView()
    assert.equal(hash(retained), initialCandidateHash, 'The actual editable SDK view must retain the first edit')
    const addition = appendCustomerDependencyProbe(retained, fixture.blockType)
    successful(await call('edit', { path: absPath, edits: [{ oldText: addition.oldText, newText: addition.newText }] }),
      'Reference the installed dependency through an actual SDK edit', false)
    const candidateHash = hash(addition.candidate)
    assert.equal(hash(await readView()), candidateHash)
    const validated = successful(await call('abs_validate', { project, generation: exported.generation, absPath }),
      'Validate the complete dependency-consuming candidate')
    assert.equal((validated.receipt?.validation ?? validated.validation)?.ok, true)
    assert.equal(validated.receipt?.candidate?.hash, candidateHash)
    const applied = successful(await call('abs_apply', { project, generation: exported.generation, absPath }),
      'Apply the dependency-consuming candidate through the actual host')
    assert.equal(applied.publication?.status, 'COMMITTED')
    assert.equal(applied.applyVerification?.ok, true)
    assert.equal(applied.receipt?.candidate?.hash, candidateHash)
    assert.equal(harness.guard.snapshot(project)?.status, 'verified')
    const committed = await readNative()
    const { expectedDocument, blockId } = expectedCustomerDependencyDocument(originalDocument, committed, fixture.blockType)
    const probe = { packageName: fixture.packageName, blockType: fixture.blockType, blockId }
    const beforeAbort = await captureFiles(project, [...mirrors, 'package.json', ...locks,
      ...fixture.sourceFiles.map(name => path.join('local-libraries', ...fixture.packageName.split('/'), name))])
    for (const name of [...mirrors, 'package.json', 'package-lock.json']) assert.ok(beforeAbort[name])
    const manifest = JSON.parse(beforeAbort['package.json'].toString('utf8'))
    assert.match(manifest.dependencies?.[fixture.packageName] ?? '', /^file:(?:\.\/)?local-libraries\//)
    assert.equal((await fs.lstat(fixture.installed)).isSymbolicLink(), true)
    const installedTarget = await fs.realpath(fixture.installed)
    assert.ok(same(installedTarget, await fs.realpath(fixture.canonical)))

    assert.equal(harness.history.hasActiveTurn, true, 'Keep installation, native commit and ordinary edit in the same real turn')
    assert.equal(harness.history.isActiveTurnPreserved, false, 'Ordinary abort must run, not preserve the whole turn')
    successful(await call('read', { path: ordinaryPath, offset: 1, limit: 5 }), 'Read the ordinary file', false)
    successful(await call('edit', { path: ordinaryPath, edits: [{ oldText: ordinaryBefore, newText: ordinaryAfter }] }),
      'Edit unrelated ordinary file B through the actual SDK', false)
    const ordinaryView = harness.history.mapWorkspaceReadPath(ordinaryPath)
    assert.ok(!same(ordinaryView, ordinaryPath), 'The real SDK edit must exist in its active history overlay')
    assert.equal(await fs.readFile(ordinaryView, 'utf8'), ordinaryAfter)
    assert.equal(await fs.readFile(ordinaryPath, 'utf8'), ordinaryBefore, 'Ordinary B must still be unpublished')
    await phase('native-dependency-abort-actual-history-turn')
    await harness.history.abort()
    assert.equal(harness.history.hasActiveTurn, false)
    await assert.rejects(fs.lstat(ordinaryView), error => error.code === 'ENOENT',
      'Ordinary cancellation must remove the changed SDK overlay instead of preserving the whole turn')
    assert.equal(await fs.readFile(harness.history.mapWorkspaceReadPath(ordinaryPath), 'utf8'), ordinaryBefore)
    assert.equal(await fs.readFile(ordinaryPath, 'utf8'), ordinaryBefore)
    assert.equal(harness.guard.snapshot(project)?.status, 'verified')
    assert.deepEqual(await readNative(), expectedDocument)
    const afterAbort = await captureFiles(project, Object.keys(beforeAbort))
    for (const [name, bytes] of Object.entries(beforeAbort)) {
      assert.equal(afterAbort[name] === null, bytes === null, 'Abort changed required file presence: ' + name)
      if (bytes) assert.ok(bytes.equals(afterAbort[name]), 'Abort changed exact committed native, manifest, lock or canonical library bytes: ' + name)
    }
    assert.equal((await fs.lstat(fixture.installed)).isSymbolicLink(), true)
    assert.ok(same(await fs.realpath(fixture.installed), installedTarget), 'The consumed dependency link must retain its canonical target')
    const runtime = await verifyCustomerNativeDependencyRuntime({ page, project, probe, readNativeDocument: readNative })
    assert.deepEqual(runtime.document, expectedDocument)
    evidence.nativeDependency = { ...evidence.nativeDependency, originalGeneration: exported.generation,
      publishedGeneration: applied.publication.generation, candidateHash, probe,
      nativeProgramConsumesInstalledDependency: true, verifiedNativeCommit: true, actualHistoryAbort: true,
      sameActualHistoryTurn: true, entireTurnPreserved: false,
      ordinaryB: { file: ordinaryFileName, overlayChangedBeforeAbort: true, unpublished: true, revertedByAbort: true,
        changedOverlayRemoved: true,
        beforeHash: hash(ordinaryBefore), discardedHash: hash(ordinaryAfter), afterHash: hash(await fs.readFile(ordinaryPath)) },
      mirrorsAndDependencyBytesPreserved: Object.entries(beforeAbort).map(([name, bytes]) => ({ name, hash: bytes && hash(bytes) })),
      manifest: { allFieldsAndBytesPreserved: true },
      symbolicLinkAndTargetPreserved: true, runtimeReady: runtime.runtimeReady, nativeBlockRegistered: true }
    evidence.cases.push({ name: 'native-commit-consumes-installed-dependency-ordinary-edit-abort-retains-exact-native-and-library-state',
      ok: true, actualNpmExecuted: true, customerLifecycleScriptsExecuted: false })
    return { expectedDocument, probe, ordinaryFileName }
  } catch (error) {
    primaryFailure = error
    evidence.nativeDependencyFailure = { name: error.name, code: error.code,
      message: String(error.message).slice(0, 1800), ...(error.details ? { details: error.details } : {}),
      guard: harness.guard.snapshot(project) }
    throw error
  } finally {
    evidence.sdkProof = harness.proof()
    try { await harness.dispose() }
    catch (error) {
      evidence.nativeDependencyCleanupFailure = { name: error.name, code: error.code,
        message: String(error.message).slice(0, 1200) }
      if (!primaryFailure) throw error
    }
  }
}
