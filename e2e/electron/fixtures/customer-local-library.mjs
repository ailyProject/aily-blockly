import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import vm from 'node:vm'

const hash = value => 'sha256:' + createHash('sha256').update(value).digest('hex')
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
const inside = (root, target) => {
  const relative = path.relative(root, target)
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
}
const json = value => JSON.stringify(value, null, 2) + '\n'

async function ownedProject(suite, project) {
  assert.ok(path.isAbsolute(suite) && path.isAbsolute(project), 'Use explicit owned test paths')
  const physicalSuite = await fs.realpath(suite), physicalProject = await fs.realpath(project)
  assert.match(physicalSuite.replaceAll('\\', '/'), /\/aily-project\/dev-tests\//i)
  assert.ok(same(suite, physicalSuite) && same(project, physicalProject), 'Fixture paths cannot redirect through links')
  assert.ok(inside(physicalSuite, physicalProject), 'The project must belong to this private suite')
  return { suite: physicalSuite, project: physicalProject }
}

async function libraryHash(source) {
  const values = []
  for (const name of (await fs.readdir(source)).sort()) {
    const file = path.join(source, name), stat = await fs.lstat(file)
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'Only the known ordinary fixture files may be imported')
    values.push([name, hash(await fs.readFile(file))])
  }
  return hash(JSON.stringify(values))
}

/** Prepare a new inert package outside the owned project. No install is run. */
export async function prepareCustomerLocalLibrary({ suite, project }) {
  const owned = await ownedProject(suite, project)
  const suffix = hash(owned.suite).slice(-10)
  const packageName = '@aily-project/lib-customer-baseline-probe-' + suffix
  const blockType = 'customer_baseline_probe_' + suffix
  const source = path.join(owned.suite, 'dependency-library-source')
  const canonical = path.join(owned.project, 'local-libraries', ...packageName.split('/'))
  const installed = path.join(owned.project, 'node_modules', ...packageName.split('/'))
  const manifest = JSON.parse(await fs.readFile(path.join(owned.project, 'package.json'), 'utf8'))
  assert.equal(manifest.dependencies?.[packageName], undefined, 'Never replace an existing project dependency')
  const files = {
    'package.json': json({ name: packageName, version: '0.0.1', private: true,
      description: 'Inert owned dependency for customer baseline acceptance' }),
    'block.json': json([{ type: blockType, message0: 'Customer baseline dependency probe',
      previousStatement: null, nextStatement: null, colour: 160,
      tooltip: 'An unused test statement that emits only a C++ comment.' }]),
    'generator.js': `Arduino.forBlock[${JSON.stringify(blockType)}] = function () {\n  return '// customer baseline dependency probe\\n';\n};\n`,
    'toolbox.json': json({ kind: 'category', name: 'Customer baseline probe', colour: 160,
      contents: [{ kind: 'block', type: blockType }] }),
    'README.md': '# Customer baseline dependency probe\n\nOwned E2E fixture. No dependencies, npm scripts, C++ headers, models or hardware effects.\n',
    'README_AI.md': '# Customer baseline dependency probe\n\n' +
      '`' + blockType + '()` is a statement with no arguments. Its generator emits only a C++ comment.\n' +
      'This library is installed to change the real host runtime while preserving an existing ABS candidate; do not add its block to the customer program.\n'
  }
  await fs.mkdir(source)
  for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(source, name), content, { flag: 'wx' })
  const pkg = JSON.parse(files['package.json'])
  for (const key of ['scripts', 'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'workspaces'])
    assert.equal(pkg[key], undefined)
  const Arduino = { forBlock: {} }
  new vm.Script(files['generator.js']).runInNewContext({ Arduino }, { timeout: 1000 })
  assert.equal(Arduino.forBlock[blockType](), '// customer baseline dependency probe\n')
  return { ...owned, source, canonical, installed, packageName, blockType,
    sourceHash: await libraryHash(source), sourceFiles: Object.keys(files).sort() }
}

async function projectSnapshot(project) {
  return {
    absHash: hash(await fs.readFile(path.join(project, 'project.abs'))),
    abi: JSON.parse(await fs.readFile(path.join(project, 'project.abi'), 'utf8')),
    abiHash: hash(await fs.readFile(path.join(project, 'project.abi'))),
    mapHash: hash(await fs.readFile(path.join(project, 'project.abs.map.json')))
  }
}

/** The product tool really invokes npm. Its inherited environment disables
 * lifecycle scripts and network access, including scripts in the customer root.
 * Calls in this harness must remain sequential while these process flags apply. */
async function withOfflineNpm(suite, action) {
  const cache = path.join(suite, 'dependency-npm-cache'), globalConfig = path.join(suite, 'dependency-global.npmrc')
  await fs.mkdir(cache)
  await fs.writeFile(globalConfig, '', { flag: 'wx' })
  const settings = { ignore_scripts: 'true', offline: 'true', audit: 'false', fund: 'false',
    update_notifier: 'false', package_lock_only: 'false', dry_run: 'false', global: 'false',
    cache, globalconfig: globalConfig }
  const overrides = Object.fromEntries(Object.entries(settings).flatMap(([key, value]) =>
    [['npm_config_' + key, value], ['NPM_CONFIG_' + key.toUpperCase(), value]]))
  const keys = new Set(Object.keys(overrides).map(key => key.toLowerCase()))
  const previous = Object.entries(process.env).filter(([key]) => keys.has(key.toLowerCase()))
  const clear = () => { for (const key of Object.keys(process.env)) if (keys.has(key.toLowerCase())) delete process.env[key] }
  clear()
  Object.assign(process.env, overrides)
  try { return await action() } finally { clear(); Object.assign(process.env, Object.fromEntries(previous)) }
}

/** Call the real SDK tool, then verify its native runtime acknowledgement and
 * the actual filesystem. `call` returns the unchanged Agent harness envelope. */
export async function installCustomerLocalLibrary({ fixture, call, page,
  readCandidate, getGuardSnapshot, candidateHash, intentGeneration }) {
  const { suite, project } = await ownedProject(fixture.suite, fixture.project)
  assert.equal(typeof readCandidate, 'function', 'Read the candidate through the actual SDK history view')
  assert.equal(typeof getGuardSnapshot, 'function', 'Observe the tool-created retained candidate through the actual SDK guard')
  assert.equal(await libraryHash(fixture.source), fixture.sourceHash, 'The known inert package must be unchanged')
  // An SDK edit lives in its active history view. The live ABS remains the
  // published canvas; reading it as the draft would either misdiagnose success
  // or tempt the test to materialize a candidate and hide an admission bug.
  const originalCandidateHash = hash(await readCandidate())
  assert.equal(originalCandidateHash, candidateHash, 'Install must start with the original edited SDK candidate')
  const before = await projectSnapshot(project)
  const response = await withOfflineNpm(suite, () => call('lib_install_local', {
    project, source: fixture.source, registry: 'http://127.0.0.1:9'
  }))
  assert.equal(response.isError, false, response.text?.slice(0, 2000))
  const result = response.structured
  assert.equal(result?.ok, true, JSON.stringify(result))
  assert.equal(result.filesInstalled, true)
  assert.equal(result.exitCode, 0)
  assert.equal(result.packageName, fixture.packageName)
  assert.equal(result.installMode, 'symbolic-link')
  assert.equal(result.linkVerification?.ok, true)
  assert.equal(result.materializationVerification?.ok, true)
  assert.equal(result.vfsVisible, true)
  assert.equal(result.persistence, 'dependencies-only')
  assert.equal(result.runtimeSync?.ok, true)
  assert.equal(result.runtimeSync?.ready, true)
  assert.ok(result.runtimeSync.runtime?.loadedLibraries.includes(fixture.packageName))
  assert.ok(result.runtimeSync.runtime?.toolboxLibraries.includes(fixture.packageName))
  assert.deepEqual(result.runtimeSync.missingLibraries, [])
  assert.deepEqual(result.runtimeSync.missingToolboxLibraries, [])
  assert.deepEqual(result.runtimeSync.failedLibraries, [])
  assert.equal((await fs.lstat(fixture.installed)).isSymbolicLink(), true)
  const canonical = await fs.realpath(fixture.canonical), installedTarget = await fs.realpath(fixture.installed)
  assert.ok(inside(project, canonical), 'Installed source must stay in this project')
  assert.ok(same(canonical, installedTarget), 'npm must link the canonical project copy')
  assert.equal(await libraryHash(fixture.source), fixture.sourceHash, 'Import must not rewrite the external fixture')
  assert.equal(await libraryHash(fixture.canonical), fixture.sourceHash, 'Canonical copy must match the known fixture')
  const manifest = JSON.parse(await fs.readFile(path.join(project, 'package.json'), 'utf8'))
  assert.match(manifest.dependencies?.[fixture.packageName] ?? '', /^file:(?:\.\/)?local-libraries\//)
  const native = await page.evaluate(({ project, packageName, blockType }) => {
    const component = window.ng.getComponent(document.querySelector('app-blockly-editor'))
    if (component.projectService.currentProjectPath.replaceAll('\\', '/').toLowerCase() !== project.replaceAll('\\', '/').toLowerCase())
      throw new Error('The library tool changed the active project')
    return { blockRegistered: typeof window.Blockly.Blocks[blockType]?.init === 'function',
      runtime: component.blocklyService.getLibraryRuntimeSnapshot(), packageName }
  }, { project, packageName: fixture.packageName, blockType: fixture.blockType })
  assert.equal(native.blockRegistered, true, 'The new real block definition must be loaded')
  assert.equal(native.runtime.active, true)
  assert.ok(native.runtime.loadedLibraries.includes(fixture.packageName))
  assert.ok(native.runtime.toolboxLibraries.includes(fixture.packageName))
  const after = await projectSnapshot(project)
  assert.equal(after.absHash, before.absHash, 'Dependency-only installation cannot publish over the live ABS')
  assert.equal(after.abiHash, before.abiHash, 'Dependency-only installation cannot save or rewrite the live ABI')
  assert.equal(after.mapHash, before.mapHash, 'Dependency-only installation cannot republish the live baseline map')
  assert.deepEqual(after.abi, before.abi, 'Dependency-only installation cannot edit or save the customer program')
  const candidateBackup = await verifyCustomerCandidateBackup({ project,
    guardSnapshot: getGuardSnapshot(), candidateHash, intentGeneration })
  return { ok: true, packageName: fixture.packageName, blockType: fixture.blockType,
    actualNpmExecuted: true, customerLifecycleScriptsExecuted: false, npmLifecycleScriptsDisabled: true, npmOffline: true,
    filesInstalled: result.filesInstalled, exitCode: result.exitCode, runtimeReady: result.runtimeSync.ready,
    installMode: result.installMode, canonicalSourceVerified: true, nativeBlockRegistered: native.blockRegistered,
    runtime: native.runtime, persistence: result.persistence,
    candidate: { source: 'sdk-active-history-view', beforeHash: originalCandidateHash,
      afterHash: candidateBackup.candidateHash, unchanged: true, preservedByDependencyTool: true },
    candidateBackup,
    liveAbs: { beforeHash: before.absHash, afterHash: after.absHash, unchanged: true },
    abi: { beforeHash: before.abiHash, afterHash: after.abiHash, allFieldsPreserved: true },
    map: { beforeHash: before.mapHash, afterHash: after.mapHash, unchanged: true } }
}

/** Observe the product-created immutable record, without creating a backup or
 * calling validation first. A dependency tool must preserve its own input. */
export async function verifyCustomerCandidateBackup({ project, guardSnapshot, candidateHash, intentGeneration }) {
  const backup = guardSnapshot?.retainedCandidateBackup
  assert.ok(backup, 'The dependency tool itself must publish a durable original-candidate backup reference')
  assert.equal(backup.version, 1)
  assert.ok(same(backup.project, project))
  assert.match(backup.recordHash, /^sha256:[a-f0-9]{64}$/)
  assert.equal(backup.hash, candidateHash)
  assert.equal(backup.candidateApplied, false)
  const expectedPath = path.join(project, '.aily', 'abs-sync', 'recoveries', `candidate-${backup.recordHash.slice(7)}.json`)
  assert.ok(same(backup.path, expectedPath), 'Backups belong inside this same project recovery store')
  assert.ok(same(await fs.realpath(expectedPath), expectedPath), 'The backup cannot redirect outside the owned project')
  assert.equal((await fs.lstat(expectedPath)).isFile(), true)
  const bytes = await fs.readFile(expectedPath), record = JSON.parse(bytes.toString('utf8'))
  assert.equal(hash(bytes), backup.recordHash)
  assert.equal(record.version, 1)
  assert.equal(record.kind, 'abs-candidate')
  assert.ok(same(record.project, project))
  assert.equal(record.candidate.hash, candidateHash)
  assert.equal(hash(record.candidate.source), candidateHash)
  assert.equal(Buffer.byteLength(record.candidate.source), backup.bytes)
  assert.equal(record.candidate.bytes, backup.bytes)
  assert.equal(record.candidate.intentGeneration, intentGeneration)
  assert.equal(guardSnapshot.retainedCandidate?.hash, candidateHash)
  assert.equal(guardSnapshot.intentGeneration, intentGeneration)
  return { path: expectedPath, recordHash: backup.recordHash, candidateHash, bytes: backup.bytes,
    intentGeneration, physicalRecordVerified: true, originalSourceAndIntentVerified: true, candidateApplied: false }
}
