import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { prepareCustomerNaturalProject, expectedCustomerNaturalDocument,
  verifyCustomerOriginalUnchanged, verifyCustomerCompilerInput } from './fixtures/r4-customer-natural.mjs'
import { loadCandidateSdk, fingerprintCandidateSdk, appendCandidateUser,
  candidateSession, exactCandidateFieldEdit } from './fixtures/r3-customer-candidate.mjs'
import { sha } from './fixtures/r1-customer-native.mjs'

// This small driver composes the existing real SDK/Core/History/Host actor.
// Root supplies its already-owned packaged Host/page/profile. No fake transport,
// model executor, automatic Host launch or fixture driver-source injection exists.
const gate = () => assert.equal(process.env.AILY_LIBRARY_ROOT_HOST_WINDOW, '1', 'Only Root starts the actual library acceptance')
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
const inside = (root, file) => { const relative = path.relative(root, file)
  return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) }
const nativeDocument = async page => JSON.parse(await page.evaluate(() => window.ng.getComponent(
  document.querySelector('app-blockly-editor')).blocklyService.captureRecoverySnapshot().documentText))
const extraModules = ['blockly/tools/registrars/library/lib-add',
  'blockly/tools/registrars/library/library-transaction', 'blockly/tools/registrars/library/complete-installation',
  'blockly/tools/registrars/project/project-build', 'blockly/services/library/mutation-admission',
  'blockly/services/library/runtime-sync', 'blockly/services/project/build-log-reference']

export async function fingerprintLibDriverSdk(agentRoot) {
  return [...await fingerprintCandidateSdk(agentRoot), ...await Promise.all(extraModules.map(async name => ({
    name, sha256: sha(await fs.readFile(path.join(agentRoot, 'dist', name + '.js'))) })))]
}

async function directoryInventory(root) {
  const files = []
  const visit = async directory => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      assert.equal(entry.isSymbolicLink(), false)
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(file)
      else { assert.ok(entry.isFile()); files.push({ path: path.relative(root, file), sha256: sha(await fs.readFile(file)) }) }
    }
  }
  await visit(root)
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

export async function prepareLibDriverProject(options) {
  gate()
  const fixture = await prepareCustomerNaturalProject({ ...options, kind: 'chiyao' })
  const installed = path.join(fixture.project, 'node_modules/@aily-project/lib-ds1302')
  const pkg = JSON.parse(await fs.readFile(path.join(installed, 'package.json')))
  assert.equal(pkg.version, '1.0.0')
  assert.equal(await fs.lstat(path.join(installed, 'src')).catch(error => {
    if (error.code === 'ENOENT') return null; throw error }), null)
  const oldLocal = path.join(fixture.project, 'local-libraries/@aily-project/lib-ds1302')
  fixture.driverUpgrade = { oldInstalledVersion: pkg.version, oldLocal,
    oldLocalInventory: await directoryInventory(oldLocal), originalLockSha256: sha(await fs.readFile(path.join(fixture.project, 'package-lock.json'))) }
  return fixture
}

/** Execute only the real lib_add transaction and native application. Compilation
 * is a separate explicit stage so Root can retain a newly exposed C++ failure. */
export async function runLibDriverCandidateCase({ page, fixture, agentRoot, expectedSdkHash, registry,
  suite, upgradePubsubclient = false, signal = new AbortController().signal, checkpoint = async () => {}, onRuntime = () => {} }) {
  gate()
  const project = fixture.project, evidence = { ok: false, providerRequests: 0, modelExecuted: false,
    replacementToolExecutor: false, fabricatedNativeReceipts: false, fixtureCopiedDriverIntoProject: false,
    project, rpc: [], stages: [], compilerRunInThisStage: false,
    scope: 'Actual DS1302 registry upgrade, preserved candidate and native apply; compilation is a separate explicit stage.' }
  const stage = async name => { evidence.stages.push({ name, at: Date.now() }); await checkpoint(evidence) }
  const beforeFingerprint = await fingerprintLibDriverSdk(agentRoot)
  assert.match(expectedSdkHash, /^[a-f0-9]{64}$/)
  assert.equal(sha(JSON.stringify(beforeFingerprint)), expectedSdkHash)
  evidence.sdk = { fingerprint: beforeFingerprint, sha256: expectedSdkHash }
  const beforeNative = await nativeDocument(page)
  const expected = expectedCustomerNaturalDocument(beforeNative, fixture)
  const beforeAbi = await fs.readFile(path.join(project, 'project.abi'))
  const beforeManifest = JSON.parse(await fs.readFile(path.join(project, 'package.json')))
  const sdk = await loadCandidateSdk(agentRoot, evidence.rpc)
  const manager = sdk.SessionManager.create(project, path.join(suite, 'library-sdk-sessions'))
  appendCandidateUser(manager, 'Keep the original project, change pin_buzzer from 22 to 23, and repair its DS1302 package.')
  const session = candidateSession(sdk, project, manager, signal)
  onRuntime({ session, sdk, evidence })
  await session.begin()
  await stage('actual-Core-read-edit-candidate-A')
  const initial = await session.read()
  const plan = { blockId: fixture.customer.blockId, field: 'NUM', oldValue: 22, value: 23 }
  const edit = await exactCandidateFieldEdit(session.history, initial.candidate, plan, signal)
  const edited = (await session.edit(edit.oldText, edit.newText)).candidate
  evidence.candidateA = { ref: edited.ref, sourceSha256: sha(edited.source), base: edited.record.base }
  assert.deepEqual(await nativeDocument(page), beforeNative, 'Core edit must remain a candidate until real apply')
  const load = name => import(pathToFileURL(path.join(agentRoot, 'dist', name + '.js')).href)
  const { registerLibAdd } = await load('blockly/tools/registrars/library/lib-add')
  const tools = sdk.registry.createBlocklyToolRegistry(project, session.history, 'blockly')
  const context = sdk.registrars.createRegistrarContext(tools, project, session.history,
    new sdk.workflow.AbsWorkflowGuard(), 'blockly')
  context.candidateBackupTransport = sdk.transport
  registerLibAdd(context)
  const libAdd = tools.definitions().find(tool => tool.name === 'lib_add')
  assert.ok(libAdd)
  const upgradedNames = ['@aily-project/lib-ds1302', ...(upgradePubsubclient ? ['@aily-project/lib-pubsubclient'] : [])]
  evidence.requestedLibraryPackages = upgradedNames.map(name => name + '@1.0.1')
  await stage(upgradePubsubclient ? 'real-product-lib-add-ds1302-and-pubsubclient-1.0.1' : 'real-product-lib-add-1.0.1-from-closed-registry')
  const upgraded = await libAdd.execute({ project, packages: evidence.requestedLibraryPackages,
    registry: registry.origin }, signal, { toolCallId: randomUUID(), sessionId: manager.getSessionId() })
  evidence.library = upgraded.structuredContent
  evidence.registry = registry.snapshot()
  await checkpoint(evidence)
  assert.notEqual(upgraded.isError, true, JSON.stringify(evidence.library))
  assert.equal(evidence.library?.ok, true, JSON.stringify(evidence.library))
  assert.equal(evidence.library.filesInstalled, true)
  assert.equal(evidence.library.runtimeSync?.ok, true)
  assert.equal(evidence.library.runtimeSync?.ready, true)
  evidence.installedPackages = []
  const installedLock = JSON.parse(await fs.readFile(path.join(project, 'package-lock.json')))
  for (const name of upgradedNames) {
    const targetPackage = path.join(project, 'node_modules', name)
    assert.equal((await fs.lstat(targetPackage)).isSymbolicLink(), false)
    assert.ok(inside(project, await fs.realpath(targetPackage)))
    const installed = JSON.parse(await fs.readFile(path.join(targetPackage, 'package.json')))
    assert.equal(installed.name, name)
    assert.equal(installed.version, '1.0.1', 'A real upgrade cannot masquerade as 1.0.0')
    const authored = registry.packages.find(item => item.manifest.name === name && item.manifest.version === installed.version)
    assert.ok(authored)
    for (const file of authored.files) assert.equal(sha(await fs.readFile(path.join(targetPackage, file.path))), file.sha256)
    assert.ok(evidence.registry.requests.some(item => item.tarball && item.package === name && item.status === 200),
      'The real npm operation must consume each exact served tarball')
    assert.equal(installedLock.packages?.['node_modules/' + name]?.version, '1.0.1')
    assert.equal(installedLock.packages['node_modules/' + name].integrity, authored.integrity)
    evidence.installedPackages.push({ name, version: installed.version, integrity: authored.integrity,
      tarballSha256: authored.sha256, filesVerifiedAgainstActualNpmPack: authored.files.length,
      manifestAndLockPersistedByProduct: true, lockSha256: sha(await fs.readFile(path.join(project, 'package-lock.json'))) })
  }
  // The installed Host also queries these optional catalog/search endpoints
  // before any tool runs. Keep their real 404s, separately from npm package
  // metadata/tarball traffic; no replacement dependency is served for them.
  const backgroundPaths = new Set(['/vc-package-versions.json', '/-/v1/search'])
  evidence.registry.deniedBackgroundCatalog = evidence.registry.unknownRequests.filter(item =>
    item.method === 'GET' && backgroundPaths.has(item.path))
  assert.deepEqual(evidence.registry.unknownRequests.filter(item =>
    item.method !== 'GET' || !backgroundPaths.has(item.path)), [],
  'An unprepared registry dependency must be diagnosed as fixture material, never fetched blindly')
  assert.deepEqual(await directoryInventory(fixture.driverUpgrade.oldLocal), fixture.driverUpgrade.oldLocalInventory,
    'The old unregistered local 0.0.1 repair cannot be overwritten by this upgrade')
  const afterManifest = JSON.parse(await fs.readFile(path.join(project, 'package.json')))
  const otherDependencies = value => Object.fromEntries(Object.entries(value.dependencies).filter(([name]) => !upgradedNames.includes(name)))
  assert.deepEqual(otherDependencies(afterManifest), otherDependencies(beforeManifest))
  assert.deepEqual(await nativeDocument(page), beforeNative, 'A dependency transaction cannot apply the pending program')
  assert.ok((await fs.readFile(path.join(project, 'project.abi'))).equals(beforeAbi), 'Library autosave may persist dependencies, not replace the unapplied document')
  const retained = (await session.read()).candidate
  assert.equal(retained.ref.id, edited.ref.id)
  assert.equal(retained.source, edited.source)
  assert.equal((await session.history.readCandidate(edited.ref, { signal })).source, edited.source)
  evidence.candidateAfterLibrary = { ref: retained.ref, sourceSha256: sha(retained.source), originalAStillReadable: true }
  evidence.installedPackage = { ...evidence.installedPackages[0], oldLocalUnchanged: true }
  evidence.targetLibrary = await currentDriverSource(project)
  await stage('real-original-candidate-apply-after-library-upgrade')
  const applied = await session.apply()
  evidence.application = applied
  assert.equal(applied.publication?.status, 'COMMITTED')
  assert.equal(applied.applyVerification?.ok, true)
  assert.equal(applied.requiresReload, false)
  assert.deepEqual(await nativeDocument(page), expected)
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(project, 'project.abi'), 'utf8')), expected)
  assert.deepEqual(await fingerprintLibDriverSdk(agentRoot), beforeFingerprint)
  await verifyCustomerOriginalUnchanged(fixture)
  evidence.ok = true
  evidence.fullDocumentMatched = true
  evidence.sameProject = true
  await stage('upgrade-and-apply-verified-compile-is-separate')
  return { evidence, fixture, session, sdk, context, tools, expectedDocument: expected, registry, suite, signal, agentRoot }
}

/** Resolve the real installed source, including a later product-created file:
 * author path. A registry node_modules path is not advertised as writable. */
export async function currentDriverSource(project) {
  const name = '@aily-project/lib-ds1302'
  const manifest = JSON.parse(await fs.readFile(path.join(project, 'package.json')))
  const installed = path.join(project, 'node_modules', name)
  const sourceRoot = await fs.realpath(installed)
  assert.ok(inside(project, sourceRoot))
  const pkg = JSON.parse(await fs.readFile(path.join(sourceRoot, 'package.json')))
  assert.equal(pkg.name, name); assert.equal(pkg.version, '1.0.1')
  const file = relative => path.join(sourceRoot, relative)
  const cpp = file('src/DS1302.cpp'), header = file('src/DS1302.h')
  const dependency = manifest.dependencies[name]
  const editable = typeof dependency === 'string' && dependency.startsWith('file:')
    && same(await fs.realpath(path.resolve(project, dependency.slice(5))), sourceRoot)
  return { packageName: name, version: pkg.version, declaredDependency: dependency, installedPath: installed,
    sourceRoot, editableProjectLibrary: editable, installedRegistryFilesReadOnly: !editable,
    cpp: { path: cpp, relative: 'src/DS1302.cpp', sha256: sha(await fs.readFile(cpp)) },
    header: { path: header, relative: 'src/DS1302.h', sha256: sha(await fs.readFile(header)) },
    compilerSnapshotRelativeCpp: 'node_modules/' + name + '/src/DS1302.cpp',
    compilerStagedRelativeCpp: '.temp/libraries/lib-ds1302/DS1302.cpp' }
}

/** Verify modified bytes at the authored path, fixed request package snapshot,
 * and staged C++ source; only a matching real compile command proves execution. */
export async function verifyDriverCompilerSource({ project, privateRoot, expectedCppSha256, log,
  requireCompilerCommand = false }) {
  const selected = await currentDriverSource(project)
  assert.equal(selected.cpp.sha256, expectedCppSha256)
  const captured = path.join(privateRoot, selected.compilerSnapshotRelativeCpp)
  const staged = path.join(privateRoot, selected.compilerStagedRelativeCpp)
  assert.equal(sha(await fs.readFile(captured)), expectedCppSha256)
  assert.equal(sha(await fs.readFile(staged)), expectedCppSha256)
  const lines = log.split('\n'), commands = []
  for (const [index, line] of lines.entries()) {
    if (/g\+\+(?:\.exe)?["'\s]/.test(line) && /(?:^|\s)-c(?:\s|$)/.test(line) && line.includes('DS1302.cpp'))
      commands.push({ line: index + 1, commandSha256: sha(line) })
  }
  if (requireCompilerCommand) assert.ok(commands.length > 0, 'The real verbose compiler must consume the modified driver C++')
  return { selectedSource: selected, actualPrivatePackageCpp: captured, actualStagedCompilerCpp: staged,
    authoredAndCapturedAndStagedSha256: expectedCppSha256, compilerCommands: commands,
    driverCompileCommandObserved: commands.length > 0, logSha256: sha(log) }
}

/** Explicit real compiler stage; never claims that a failed C++ build passed. */
export async function compileLibDriverCandidate(run, { page, checkpoint = async () => {},
  expectedCppSha256 = run.evidence.targetLibrary.cpp.sha256, requireSuccess = false }) {
  gate()
  const { registerProjectBuild } = await import(pathToFileURL(path.join(run.agentRoot,
    'dist/blockly/tools/registrars/project/project-build.js')).href)
  registerProjectBuild(run.context)
  const build = run.tools.definitions().find(tool => tool.name === 'project_build')
  assert.ok(build)
  let response = await build.execute({ project: run.fixture.project }, run.signal,
    { toolCallId: randomUUID(), sessionId: run.session.manager.getSessionId() })
  let value = response.structuredContent
  const originalRequestId = value?.buildReceipt?.requestId
  const observations = [], observationDeadline = Date.now() + 30 * 60 * 1000
  // A long cold compile may exhaust one observation window. Follow only the
  // product's original read-only status arguments; never submit another build.
  while (value?.buildReceipt?.state !== 'completed' && value?.pendingBuild) {
    observations.push({ result: value, isError: response.isError === true })
    run.evidence.compile = { result: value, compilerSucceeded: false, observations }
    await checkpoint(run.evidence)
    assert.ok(Date.now() < observationDeadline, 'The original compile did not reach a terminal state within the owned observation budget')
    const pending = value.pendingBuild
    assert.equal(pending.tool, 'project_build')
    assert.ok(same(pending.arguments.project, run.fixture.project))
    assert.equal(pending.arguments.build_request_id, originalRequestId)
    assert.equal(pending.arguments.build_target_pid, run.evidence.library.targetPid)
    response = await build.execute(pending.arguments, run.signal,
      { toolCallId: randomUUID(), sessionId: run.session.manager.getSessionId() })
    value = response.structuredContent
    assert.equal(value?.buildReceipt?.requestId, originalRequestId)
  }
  run.evidence.compile = { result: value, compilerSucceeded: value?.ok === true, rawIsError: response.isError === true }
  run.evidence.compile.observations = observations
  await checkpoint(run.evidence)
  assert.equal(value?.buildReceipt?.state, 'completed')
  const requestId = value.buildReceipt.requestId
  const execution = await page.evaluate(({ project, requestId }) => window.builder.inspectBuildExecution(project, requestId),
    { project: run.fixture.project, requestId })
  assert.equal(execution?.buildRequestId, requestId)
  assert.deepEqual(value.buildInput, execution.buildInput)
  assert.equal(value.buildInput.buildRequestId, requestId)
  const privateRoot = path.join(run.fixture.project, '.aily/build-executions', execution.executionId, 'project')
  assert.equal('sha256:' + sha(await fs.readFile(path.join(privateRoot, 'project.abi'))), value.buildInput.abiHash)
  run.evidence.compile.input = await verifyCustomerCompilerInput(run.fixture, privateRoot, run.expectedDocument)
  if (run.evidence.requestedLibraryPackages.includes('@aily-project/lib-pubsubclient@1.0.1')) {
    const authored = run.registry.packages.find(item => item.manifest.name === '@aily-project/lib-pubsubclient')
    const generatorFile = authored.files.find(file => file.path === 'generator.js')
    const fixedGenerator = path.join(privateRoot, 'node_modules/@aily-project/lib-pubsubclient/generator.js')
    assert.equal(sha(await fs.readFile(fixedGenerator)), generatorFile.sha256)
    const sketch = await fs.readFile(path.join(privateRoot, '.temp/sketch/sketch.ino'), 'utf8')
    assert.ok(sketch.includes('aily_mqtt_cstr(const String& value)'))
    assert.ok(sketch.includes('aily_mqtt_cstr(mqtt_out)'))
    run.evidence.compile.mqttCompatibility = { version: '1.0.1', actualPrivateGenerator: fixedGenerator,
      generatorSha256: generatorFile.sha256, actualStringPayloadAdaptedInCompilerSketch: true }
  }
  assert.ok(path.isAbsolute(value.resultFile) && inside(run.suite, value.resultFile))
  assert.ok(inside(run.suite, os.tmpdir()), 'Root must give the real SDK an owned TEMP/TMP before importing it')
  const permission = new run.sdk.permission.PermissionModeRuntime({ permissionMode: () => 'default' })
  permission.restore(run.session.context)
  const files = run.sdk.operations.createWorkspaceFileOperations(run.fixture.project, run.session.history, permission,
    [path.dirname(value.resultFile)])
  const read = run.sdk.pi.createReadToolDefinition(run.fixture.project, { operations: files.read })
  const readback = await read.execute(randomUUID(), { path: value.resultFile, ...value.readRange }, run.signal, undefined, run.session.context)
  assert.notEqual(readback.isError, true)
  const canonical = path.join(run.fixture.project, '.log/compile/requests', sha(requestId) + '.log')
  const source = await fs.readFile(canonical, 'utf8'), copy = await fs.readFile(value.resultFile, 'utf8')
  assert.equal(copy, source)
  assert.ok(source.startsWith('Build request: ' + requestId + '\n'))
  const lines = source.split('\n')
  assert.deepEqual(value.readRange, { offset: Math.max(1, lines.length - 79), limit: Math.min(80, lines.length) })
  const text = readback.content.filter(item => item.type === 'text').map(item => item.text).join('\n')
  for (const line of lines.slice(value.readRange.offset - 1).filter(line => line.trim()).slice(-3)) assert.ok(text.includes(line))
  run.evidence.compile.log = { requestId, canonical, resultFile: value.resultFile,
    sha256: sha(copy), readRange: value.readRange, actualCoreRead: true }
  run.evidence.compile.driverCpp = await verifyDriverCompilerSource({ project: run.fixture.project,
    privateRoot, expectedCppSha256, log: source, requireCompilerCommand: value.ok === true })
  run.evidence.compile.verified = true
  run.evidence.compile.compilerSucceeded = value.ok === true
  run.evidence.fullScenarioPassed = value.ok === true
  await checkpoint(run.evidence)
  if (requireSuccess) assert.equal(value.ok, true, 'The unchanged whole project must actually compile; retain any newly exposed C++ error')
  return run.evidence.compile
}
