import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import nativeFs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import test from 'node:test'
import { installMissingLibraryLoadWitness, assertMissingLibraryLoadWitness, captureMissingLibraryProcessTree, prepareMissingLibraryLoadInput, observeMissingLibraryRecovery, missingLibraryProjectionRequest, sanitizeMissingLibraryReply } from './r2-missing-library-load.mjs'
import { prepareR2EnvironmentProject } from './r2-environment-project.mjs'

const requestId = 'env1-00000000-0000-4000-8000-000000000001'
const mirrors = Object.fromEntries(['project.abi', 'project.abs', 'project.abs.map.json', '.aily/abs-sync/committed.json']
  .map((file, i) => [file, 'sha256:' + String(i).repeat(64)]))
const fixture = () => ({ failures: [], originalMethodsDelegated: true,
  workerExecutions: [{ requestId, kind: 'npm-reify' }, { requestId, kind: 'materialize-sources' }, { requestId, kind: 'npm-save' }],
  sourcePreparations: [{ requestId, checkpointBeforeSideEffects: true, before: mirrors, after: mirrors }],
  completions: [{ requestId, after: mirrors, environment: { requestId, status: 'completed', current: true, candidateApplied: false } }] })
test('actual-load oracle accepts one exact pre-mutation checkpoint and environment-only completion', () => {
  assert.equal(assertMissingLibraryLoadWitness(fixture()), requestId)
})

test('native failure diagnostics retain the real message and fields while credentials never enter the report', () => {
  const sanitized = sanitizeMissingLibraryReply({ ok: false, code: 'ABS_REQUEST_INVALID', message: 'Original rejection uses sensitive-123',
    diagnostics: { reason: 'initialize-and-synchronize' }, token: 'sensitive-123', nested: { authorization: 'Bearer secret' } }, ['sensitive-123'])
  assert.equal(sanitized.message, 'Original rejection uses [redacted]')
  assert.deepEqual(sanitized.diagnostics, { reason: 'initialize-and-synchronize' })
  assert.equal(sanitized.token, '[redacted]'); assert.equal(sanitized.nested.authorization, '[redacted]')
})

test('healthy projection request satisfies the actual native generation protocol and missing required fields do not', async () => {
  const repo = path.resolve(import.meta.dirname, '../../..'), require = createRequire(path.join(repo, 'package.json'))
  const { transformSync } = require('esbuild'), ts = require('typescript'), module = { exports: {} }
  const protocol = await fs.readFile(path.join(repo, 'src/app/integrations/blockly/abs/abs-generation-protocol.ts'), 'utf8')
  const state = await fs.readFile(path.join(repo, 'src/app/integrations/blockly/abs/abs-state.ts'), 'utf8')
  const parsed = ts.createSourceFile('protocol.ts', protocol, ts.ScriptTarget.Latest, true)
  const errorSource = ts.createSourceFile('state.ts', state, ts.ScriptTarget.Latest, true)
  const error = errorSource.statements.find(value => ts.isClassDeclaration(value) && value.name?.text === 'AbsSyncError')
  const validation = parsed.statements.filter(value => ts.isFunctionDeclaration(value)
    && ['assertGenerationRequest', 'assertGenerationProjectionRequest'].includes(value.name?.text)
    || ts.isVariableStatement(value) && value.declarationList.declarations.some(item => item.name.getText(parsed) === 'hash'))
  assert.equal(validation.length, 3)
  vm.runInNewContext(transformSync([error.getText(errorSource), ...validation.map(value => value.getText(parsed))].join('\n'),
    { loader: 'ts', format: 'cjs', target: 'es2022' }).code, { module })
  const request = missingLibraryProjectionRequest('sha256:' + 'a'.repeat(64), '00000000-0000-4000-8000-000000000001')
  module.exports.assertGenerationProjectionRequest(request)
  for (const field of ['version', 'requestId', 'expectedAbiHash']) {
    const missing = { ...request }; delete missing[field]
    assert.throws(() => module.exports.assertGenerationProjectionRequest(missing))
  }
})

test('actual exportGeneration admits the healthy initial-export options before native execution and rejects conflicting synchronization options', async () => {
  const repo = path.resolve(import.meta.dirname, '../../..'), require = createRequire(path.join(repo, 'package.json'))
  const { transformSync } = require('esbuild'), ts = require('typescript'), module = { exports: {} }
  const sync = await fs.readFile(path.join(repo, 'src/app/integrations/blockly/abs/abs-workspace-sync.service.ts'), 'utf8')
  const state = await fs.readFile(path.join(repo, 'src/app/integrations/blockly/abs/abs-state.ts'), 'utf8')
  const parsed = ts.createSourceFile('sync.ts', sync, ts.ScriptTarget.Latest, true)
  const errorSource = ts.createSourceFile('state.ts', state, ts.ScriptTarget.Latest, true)
  const declaration = parsed.statements.find(value => ts.isClassDeclaration(value) && value.name?.text === 'AbsWorkspaceSyncService')
  const method = declaration.members.find(value => value.name?.getText(parsed) === 'exportGeneration')
  const error = errorSource.statements.find(value => ts.isClassDeclaration(value) && value.name?.text === 'AbsSyncError')
  vm.runInNewContext(transformSync(error.getText(errorSource) + '\nclass Gate { ' + method.getText(parsed) + '\n}; module.exports=Gate;',
    { loader: 'ts', format: 'cjs', target: 'es2022' }).code, { module })
  let admitted = 0
  const probe = Object.assign(new module.exports(), { run: async callback => { assert.equal(typeof callback, 'function'); admitted++; return 'admitted-without-native-execution' } })
  assert.equal(await probe.exportGeneration(missingLibraryProjectionRequest('sha256:' + 'a'.repeat(64), '00000000-0000-4000-8000-000000000001')), 'admitted-without-native-execution')
  assert.equal(admitted, 1)
  for (const incompatible of [{ synchronize: true, initialize: true }, { synchronize: true, publish: false },
    { synchronize: true, rebind: 'sha256:' + 'a'.repeat(64) }, { synchronize: true, preserveDraft: 'private' }])
    await assert.rejects(probe.exportGeneration(incompatible), { code: 'ABS_REQUEST_INVALID' })
  assert.equal(admitted, 1, 'Conflicting native options must be refused before any lease/GUI/native work')
})
test('missing checkpoint, wrong original result, duplicate install or any program mutation cannot qualify', () => {
  for (const mutate of [value => value.sourcePreparations[0].checkpointBeforeSideEffects = false,
    value => value.completions[0].requestId = 'foreign', value => value.completions[0].environment.current = false,
    value => value.sourcePreparations.push(structuredClone(value.sourcePreparations[0])),
    value => value.workerExecutions.push({ requestId, kind: 'npm-reify' }),
    value => value.completions[0].after = { ...mirrors, 'project.abs': 'sha256:' + 'f'.repeat(64) }]) {
    const value = fixture(); mutate(value); assert.throws(() => assertMissingLibraryLoadWitness(value))
  }
})
test('actual load driver uses supported authenticated CLI recovery and never creates a saved-target capability in the observer', async () => {
  const source = await fs.readFile(new URL('../r2-missing-library-load.acceptance.mjs', import.meta.url), 'utf8')
  assert.match(source, /command\('abs_recovery', params, remaining\)/)
  assert.match(source, /observeMissingLibraryRecovery\(\{ requestId: recoveryId/)
  assert.doesNotMatch(source, /savedRecoveryTargets|\.remember\(|rememberNativePrimary|session\.filePath|session\.open/)
  assert.match(source, /restoreMissingLibraryWitness/)
  assert.match(source, /forced-test-cleanup/)
  assert.match(source, /prepareMissingLibraryLoadInput\(/)
  assert.match(source, /captureMissingLibraryProcessTree\(/)
  assert.doesNotMatch(source, /isWorkspaceWriting\(/)
})

test('uncertain native recovery is started once then only exact-ID readonly queries consume the same deadline', async () => {
  const calls = [], replies = [{ ok: false, errorCode: 'RENDERER_RESPONSE_TIMEOUT' }, { ok: false, code: 'PROJECT_RECOVERY_REQUEST_UNKNOWN' }, { ok: true }]
  let clock = 10
  const result = await observeMissingLibraryRecovery({ requestId: 'original', deadline: 10000, now: () => clock,
    wait: async ms => { clock += ms }, send: async (params, budget) => { calls.push({ params, budget }); clock += 10; return replies.shift() } })
  assert.equal(result.result.ok, true); assert.equal(result.exhausted, false)
  assert.equal(calls.filter(value => !value.params.observe).length, 1)
  assert.ok(calls.every(value => value.params.requestId === 'original' && value.params.version === 2))
  assert.ok(calls.slice(1).every(value => value.params.observe === true))
  assert.ok(calls[0].budget > calls.at(-1).budget)
})

test('business rejection and exhausted native recovery never restart the mutation or invent completion', async () => {
  let calls = 0
  const failed = await observeMissingLibraryRecovery({ requestId: 'original', deadline: 1000, now: () => 0,
    send: async () => { calls++; return { ok: false, code: 'REAL_NATIVE_FAILURE' } } })
  assert.equal(failed.result.code, 'REAL_NATIVE_FAILURE'); assert.equal(calls, 1)
  let clock = 0
  const unknown = await observeMissingLibraryRecovery({ requestId: 'original', deadline: 100, now: () => clock,
    wait: async ms => { clock += ms }, send: async () => { clock += 60; return { ok: false, code: 'PROJECT_RECOVERY_REQUEST_UNKNOWN' } } })
  assert.equal(unknown.exhausted, true); assert.equal(unknown.result.ok, false)
  assert.equal(unknown.responses.filter(value => !value.observe).length, 1)
})

test('owned process ancestry excludes stale PPIDs from either reused Main or intermediate process IDs', () => {
  const process = (ProcessId, ParentProcessId, CreationDate) => ({ ProcessId, ParentProcessId, CreationDate, ExecutablePath: path.resolve('aily.exe') })
  const root = process(10, 1, '2026-11-08T10:00:00Z'), child = process(20, 10, '2026-11-08T10:01:00Z')
  const old = process(30, 10, '2026-11-05T10:00:00Z'), reusedParentChild = process(40, 20, '2026-11-08T10:00:30Z')
  const valid = process(50, 20, '2026-11-08T10:02:00Z')
  assert.deepEqual(captureMissingLibraryProcessTree([root, child, old, reusedParentChild, valid], root).map(value => value.ProcessId), [10, 20, 50])
  assert.throws(() => captureMissingLibraryProcessTree([{ ...root, CreationDate: '2026-11-08T10:00:01Z' }], root))
})

test('real environment fixture reaches missing-used-library selection while actual installedOk remains true before any reconcile', async t => {
  const repo = path.resolve(import.meta.dirname, '../../..'), require = createRequire(path.join(repo, 'package.json'))
  const ts = require('typescript'), { transformSync } = require('esbuild')
  const suite = await fs.mkdtemp(path.join(os.tmpdir(), 'r2-missing-load-input-')), project = path.join(suite, 'project')
  t.after(() => fs.rm(suite, { recursive: true, force: true }))
  const fixture = await prepareR2EnvironmentProject({ directory: project, suite,
    boardsRoot: path.resolve(repo, '../aily-blockly-boards'), librariesRoot: path.resolve(repo, '../aily-blockly-libraries') })
  const libraryName = '@aily-project/lib-e2e-build-log-field-edit'
  const manifest = JSON.parse(await fs.readFile(path.join(project, 'package.json'), 'utf8'))
  const source = manifest.dependencies[libraryName].slice(5), program = await fs.readFile(path.join(project, 'project.abi'))
  await prepareMissingLibraryLoadInput({ project, source, libraryName, blockType: fixture.blockType })
  assert.ok((await fs.readFile(path.join(project, 'project.abi'))).equals(program))
  const methods = async (file, className, names) => {
    const text = await fs.readFile(path.join(repo, file), 'utf8'), parsed = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
    const type = parsed.statements.find(value => ts.isClassDeclaration(value) && value.name?.text === className)
    return names.map(name => { const node = type.members.find(value => value.name?.getText(parsed) === name); assert.ok(node, name); return node.getText(parsed) }).join('\n')
  }
  const componentMethods = await methods('src/app/editors/blockly-editor/blockly-editor.component.ts', 'BlocklyEditorComponent', [
    'getMissingProjectLibraries', 'getDeclaredBlocklyLibraryDependencies', 'normalizeUsedLibraryManifest', 'resolveProjectLocalLibraryPath', 'resolveManifestLocalPath',
  ])
  const npmMethod = await methods('src/app/services/domains/dependencies/npm.service.ts', 'NpmService', ['installedOk'])
  const context = vm.createContext({ module: { exports: {} }, performance, console: { log() {} },
    window: { fs: nativeFs, path: { ...path, isExists: nativeFs.existsSync } },
    isAilyLibraryPackageName: value => /^@aily-project(?:-linux)?\/lib-/.test(value),
    AILY_BLOCKLY_USED_LIBRARIES_FIELD: 'ailyBlocklyUsedLibraries' })
  vm.runInContext(transformSync(`class Component { ${componentMethods} }; class Npm { ${npmMethod} }; module.exports={Component,Npm}`, { loader: 'ts', format: 'cjs', target: 'es2022' }).code, context)
  const npm = Object.assign(new context.module.exports.Npm(), { isCloudBuild: () => false })
  assert.equal(await npm.installedOk(project), true, 'Startup dependency reconciliation is not needed for this prepared missing-usage scenario')
  const current = JSON.parse(await fs.readFile(path.join(project, 'package.json'), 'utf8'))
  const component = Object.assign(new context.module.exports.Component(), {
    isBlocklyLibraryPackageName: value => /^@aily-project(?:-linux)?\/lib-/.test(value),
    isBlocklyLibraryPackageReady: (root, name) => ['package.json', 'block.json', 'generator.js', 'toolbox.json'].every(file => nativeFs.existsSync(path.join(root, 'node_modules', name, file))),
    compareBlocklyLibraryNames: (a, b) => a.localeCompare(b), electronService: { pathJoin: path.join },
    blocklyService: { collectBlockTypesFromProjectDocument: () => [fixture.blockType] },
  })
  const missing = component.getMissingProjectLibraries(project, current, JSON.parse(program))
  assert.equal(missing.length, 1); assert.equal(missing[0].name, libraryName)
  assert.equal(missing[0].localPath, source); assert.equal(missing[0].version, 'file:' + source)
  assert.equal(component.getDeclaredBlocklyLibraryDependencies(current).has(libraryName), false)
})

test('the serialized witness delegates actual Main source preparation only after its real durable checkpoint and never fabricates a terminal', async t => {
  const repo = path.resolve(import.meta.dirname, '../../..'), require = createRequire(path.join(repo, 'package.json'))
  const { LibraryDependencies } = require('./electron/library-dependencies.js')
  const suite = await fs.mkdtemp(path.join(os.tmpdir(), 'r2-missing-witness-'))
  const project = path.join(suite, 'aily-project/dev-tests/owned/project'), source = path.join(suite, 'source'), appData = path.join(suite, 'appdata')
  await fs.mkdir(path.join(project, '.aily/abs-sync'), { recursive: true }); await fs.mkdir(source); await fs.mkdir(appData)
  const name = '@aily-project/lib-witness', requestId = 'env1-00000000-0000-4000-8000-000000000001'
  await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({ name, version: '1.0.0' }))
  await fs.writeFile(path.join(source, 'original.txt'), 'Actual original source bytes')
  await fs.writeFile(path.join(project, 'package.json'), '{"name":"witness-owner","dependencies":{}}')
  for (const file of Object.keys(mirrors)) await fs.writeFile(path.join(project, file), 'Opaque immutable program ' + file)
  const context = vm.createContext({ process: { pid: process.pid, env: { AILY_APPDATA_PATH: appData }, getBuiltinModule: process.getBuiltinModule } })
  vm.runInContext('(' + installMissingLibraryLoadWitness.toString() + ')', context)({ app: { getAppPath: () => repo } },
    { pid: process.pid, appData, project, libraryName: name })
  t.after(async () => { context.__r2MissingLibraryLoadWitness.restore(); await fs.rm(suite, { recursive: true, force: true }) })
  const manager = new LibraryDependencies({ run: () => { throw Error('A passive checkpoint/source witness test must not fake npm success') } })
  await manager.locked(project, guard => {
    const request = { requestId, action: 'install', packages: [`${name}@file:./local-libraries/${name}`],
      localSource: { packageName: name, source, force: false } }
    const operation = manager.environment.begin(project, { ...request, operation: 'library-change' }, null, guard)
    manager.prepareLocalSource(project, request, guard)
    const state = context.__r2MissingLibraryLoadWitness.snapshot()
    assert.equal(state.sourcePreparations.length, 1); assert.equal(state.sourcePreparations[0].requestId, requestId)
    assert.deepEqual(state.sourcePreparations[0].before, state.sourcePreparations[0].after)
    assert.equal(state.sourcePreparations[0].checkpointBeforeSideEffects, true)
    assert.equal(state.completions.length, 0); assert.equal(state.workerExecutions.length, 0)
    assert.equal(nativeFs.readFileSync(path.join(project, 'local-libraries', name, 'original.txt'), 'utf8'), 'Actual original source bytes')
    manager.environment.restore(project, operation, guard)
  })
})
