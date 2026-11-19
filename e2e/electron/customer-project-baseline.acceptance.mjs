import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { _electron } from '@playwright/test'
import { serveRendererBuild } from '../fixtures/build-renderer-server.mjs'
import { indexCustomerProject, customerProjectSummary, observeCustomerNativeProgress, runCustomerBaselineCase, runCustomerNativeComponentCase } from './fixtures/customer-project-baseline-case.mjs'
import { verifyCustomerCandidateRecord } from './fixtures/customer-local-library.mjs'

const repo = fileURLToPath(new URL('../../', import.meta.url))
const { values } = parseArgs({ options: { ...Object.fromEntries(
  ['project-input', 'test-root', 'output', 'executable-path', 'host-build', 'agent-root'].map(name => [name, { type: 'string' }])),
  'component-only': { type: 'boolean' }, 'exercise-self-operations': { type: 'boolean' },
  'exercise-dependency-operations': { type: 'boolean' }, 'exercise-post-save-edit': { type: 'boolean' },
  'exercise-post-commit-abort': { type: 'boolean' }, 'exercise-apply-observation-fault': { type: 'boolean' },
  'origin-preflight-only': { type: 'boolean' }, 'native-dependency-only': { type: 'boolean' },
  'native-publication-only': { type: 'boolean' } } })
assert.ok(!values['exercise-post-save-edit'] || values['exercise-self-operations'] || values['exercise-dependency-operations'],
  '--exercise-post-save-edit requires --exercise-self-operations or --exercise-dependency-operations')
assert.ok(!(values['native-dependency-only'] && values['native-publication-only']))
assert.ok(!(values['native-dependency-only'] || values['native-publication-only']) || !['component-only', 'origin-preflight-only', 'exercise-self-operations',
  'exercise-dependency-operations', 'exercise-post-save-edit', 'exercise-post-commit-abort', 'exercise-apply-observation-fault']
  .some(name => values[name]), 'The minimal required-dependency case is independent of customer replay modes')
for (const name of ['project-input', 'test-root', 'output', 'agent-root']) assert.ok(values[name] && path.isAbsolute(values[name]), `--${name} must be absolute`)
assert.ok(values['host-build'] || values['executable-path'])
assert.ok(!(values['host-build'] && values['executable-path']),
  'Use a source main with --host-build, or a complete package with --executable-path; mixed main/renderer layouts are not an installation acceptance')
const inside = (parent, child) => { const relative = path.relative(parent, child)
  return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) }
assert.match(values['test-root'].replaceAll('\\', '/'), /\/aily-project\/dev-tests\//i)
assert.ok(inside(path.join(repo, 'e2e/test-results'), values.output))
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
async function nativeDiagnosticModules() {
  const directory = values['host-build'] ?? path.join(repo, 'dist/aily-blockly/browser')
  const wanted = ['evaluateNativeCandidate', 'assertAbsReadback'], modules = {}
  for (const file of (await fs.readdir(directory)).filter(name => /^chunk-[\w-]+\.js$/.test(name))) {
    const source = await fs.readFile(path.join(directory, file), 'utf8')
    for (const name of wanted) if (source.includes('function ' + name + '(')) {
      assert.equal(modules[name], undefined, 'Ambiguous native diagnostic module')
      modules[name] = { file, sha256: digest(source) }
    }
  }
  assert.deepEqual(Object.keys(modules).sort(), wanted.sort(), 'Use the paired development renderer with its actual exported native evaluator')
  return modules
}
async function inventory(root) {
  const files = []
  const visit = async directory => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      assert.equal(entry.isSymbolicLink(), false, 'Replay input must be a physical detached project')
      if (entry.isDirectory()) await visit(file)
      else { assert.equal(entry.isFile(), true); files.push({ path: path.relative(root, file), sha256: digest(await fs.readFile(file)) }) }
    }
  }
  await visit(root)
  return files.sort((a, b) => a.path.localeCompare(b.path))
}
await fs.mkdir(values['test-root'], { recursive: true })
await fs.mkdir(values.output, { recursive: false })
const suite = await fs.mkdtemp(path.join(values['test-root'], 'customer787-'))
const project = path.join(suite, 'project'), appData = path.join(suite, 'appdata'), home = path.join(suite, 'home')
assert.ok(!inside(values['project-input'], suite) && !inside(suite, values['project-input']))
for (const directory of [appData, home]) await fs.mkdir(directory)
const originalFiles = await inventory(values['project-input'])
await fs.cp(values['project-input'], project, { recursive: true, dereference: false, force: false, errorOnExist: true })
assert.deepEqual(await inventory(project), originalFiles)
const inputDocument = JSON.parse(await fs.readFile(path.join(project, 'project.abi'), 'utf8'))
const evidence = { ok: false, suite, project, cases: [], realElectron: true,
  realCustomerSource: values['native-dependency-only'] !== true && values['native-publication-only'] !== true,
  generatedNativeDependencyFixture: values['native-dependency-only'] === true,
  generatedNativePublicationFixture: values['native-publication-only'] === true,
  originalInputModified: false, derivedCandidate: true, exactLateCandidateReplayed: false,
  helperScriptsExecuted: false, npmScriptsExecuted: false, compilerInvoked: false, llmInvoked: false,
  source: { summary: customerProjectSummary(inputDocument), abiSha256: digest(await fs.readFile(path.join(project, 'project.abi'))),
    fileCount: originalFiles.length }, cleanupFailures: [] }
const persist = () => fs.writeFile(path.join(values.output, 'result.json'), JSON.stringify(evidence, null, 2))
const phase = async name => { evidence.phase = name; await persist(); console.log('CUSTOMER_BASELINE_PHASE=' + name) }
let app, page, renderer, hostPid
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
const hashDocument = value => digest(JSON.stringify(canonical(value)))
// Deep real programs can exceed CDP object-by-value nesting. Transfer the
// complete native serialization as text, then parse it on the Node side.
const nativeDocument = async () => {
  const started = Date.now()
  let snapshot
  try {
    snapshot = await page.waitForFunction(target => {
      const editor = window.ng?.getComponent(document.querySelector('app-blockly-editor'))
      if (editor?.projectService.currentProjectPath !== target
        || editor.projectService.getBlocklyProjectLoadStatus(target)?.ready !== true) return false
      try { return editor.blocklyService.captureRecoverySnapshot().documentText }
      catch (error) {
        if (error?.code === 'BLOCKLY_EDIT_BUSY' || error?.code === 'BLOCKLY_EDIT_STALE') return false
        throw error
      }
    }, project, { timeout: 120000 })
  } catch (error) {
    evidence.nativeSnapshotFailure = { phase: evidence.phase, elapsedMs: Date.now() - started,
      observation: await page.evaluate(target => {
        const editor = window.ng?.getComponent(document.querySelector('app-blockly-editor'))
        return { project: editor?.projectService.currentProjectPath,
          load: editor?.projectService.getBlocklyProjectLoadStatus(target),
          busy: editor?.blocklyService.workspaceEditGate?.busy,
          blocked: editor?.blocklyService.workspaceEditGate?.blocked,
          recoveryRequired: editor?.blocklyService.workspaceEditGate?.recoveryRequired }
      }, project).catch(reason => ({ unavailable: String(reason.message).slice(0, 400) })) }
    throw error
  }
  try {
    const text = await snapshot.jsonValue()
    ;(evidence.nativeSnapshotReads ??= []).push({ phase: evidence.phase, elapsedMs: Date.now() - started })
    return JSON.parse(text)
  } finally { await snapshot.dispose() }
}
async function launch() {
  const { ELECTRON_RUN_AS_NODE, AILY_CHILD_PATH, NODE_PATH, AILY_AUTH_FILE, AILY_LIBRARY_HOST_PID, PI_CODING_AGENT_DIR, ...env } = process.env
  app = await _electron.launch({ ...(values['executable-path'] ? { executablePath: values['executable-path'] } : {}), cwd: repo,
    args: [...(values['executable-path'] ? [] : ['.']), ...(renderer ? ['--serve'] : []), `--user-data-dir=${path.join(suite, 'profile')}`],
    timeout: 60000, env: { ...env, AILY_E2E: '1', AILY_APPDATA_PATH: appData, AILY_NPM_PREFIX: path.join(appData, 'npm-global'),
      ...(renderer ? { AILY_DEV_RENDERER_URL: renderer.origin } : {}), HOME: home, USERPROFILE: home,
      npm_config_offline: 'true', npm_config_audit: 'false' } })
  hostPid = await app.evaluate(() => process.pid)
  await app.firstWindow()
  evidence.discovery = await app.evaluate(async () => {
    const os = process.getBuiltinModule('os'), fs = process.getBuiltinModule('fs'), path = process.getBuiltinModule('path')
    const home = os.homedir(), file = path.join(home, '.aily-blockly', 'cli-bridge', process.pid + '.json')
    const deadline = Date.now() + 5000
    while (!fs.existsSync(file) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100))
    return { hostPid: process.pid, home, expectedHome: process.env.USERPROFILE,
      homeVariable: process.env.HOME, descriptorExists: fs.existsSync(file) }
  })
  await persist()
  assert.equal(path.resolve(evidence.discovery.home).toLowerCase(), path.resolve(home).toLowerCase(), 'The host must use this isolated home')
  assert.equal(evidence.discovery.descriptorExists, true, 'The actual owned host bridge must start before SDK business operations')
  evidence.rendererMode = renderer ? 'source-main-with-local-build' : 'packaged-main-and-renderer'
  page = undefined
  const deadline = Date.now() + 60000
  while (!page && Date.now() < deadline) {
    for (const candidate of app.windows()) if (await candidate.locator('app-main-window').count() > 0) { page = candidate; break }
    if (!page) await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(page, 'The actual main-window component must exist')
  page.on('dialog', dialog => dialog.dismiss())
  page.on('pageerror', error => { (evidence.pageErrorHashes ??= []).push(digest(error.message)) })
  await page.evaluate(() => {
    const dismiss = () => { document.querySelector('app-onboarding .btn-skip')?.click(); document.querySelector('app-login .login-close')?.click() }
    new MutationObserver(dismiss).observe(document.documentElement, { childList: true, subtree: true }); dismiss()
  })
  await page.waitForFunction(() => window.ng?.getComponent(document.querySelector('app-header'))?.projectService)
  const opened = await page.evaluate(async target => {
    const domain = window.ng.getComponent(document.querySelector('app-header')).projectService
    if (domain.currentProjectPath && domain.currentProjectPath !== target) throw Error('Unexpected unrelated project')
    await domain.initializeProjectDataSchema(target)
    const result = await domain.projectOpen(target)
    return { opened: result === true, status: domain.getBlocklyProjectLoadStatus(target) }
  }, project)
  evidence.open = opened
  await persist()
  assert.equal(opened.opened, true, 'The copied customer project must open through the real domain coordinator')
  await page.waitForFunction(target => {
    const editor = window.ng.getComponent(document.querySelector('app-blockly-editor'))
    return editor?.projectService.currentProjectPath === target
      && editor.projectService.getBlocklyProjectLoadStatus(target)?.ready === true
  }, project, { timeout: 120000 })
  evidence.host = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, path: app.getAppPath(), version: app.getVersion() }))
  if (values['executable-path']) assert.match(evidence.host.path, /app\.asar$/i)
}
async function forceKillOwned() {
  assert.equal(await app.evaluate(() => process.pid), hostPid)
  const closed = app.waitForEvent('close', { timeout: 15000 })
  await app.evaluate((_, expected) => {
    if (process.pid !== expected.pid || process.env.AILY_APPDATA_PATH !== expected.appData) throw Error('Refuse unrelated host termination')
    process.kill(process.pid, 'SIGKILL')
  }, { pid: hostPid, appData }).catch(error => { if (!/closed|destroyed|terminated|Target/i.test(error.message)) throw error })
  await closed
  app = undefined
}
try {
  await phase('prepare-isolated-original-project')
  const config = JSON.parse(await fs.readFile(path.join(repo, 'electron/config/config.json'), 'utf8'))
  Object.assign(config, { metricsEnabled: false, project_path: suite, recentlyProjects: [], onboardingCompleted: true,
    blocklyOnboardingCompleted: true, region: 'offline-customer787' })
  config.appdata_path[process.platform] = appData
  config.regions = { 'offline-customer787': { official: false, enabled: true, name: 'Customer baseline acceptance',
    api_server: 'http://127.0.0.1:9', resource: 'http://127.0.0.1:9', web: 'http://127.0.0.1:9',
    tool_web: 'http://127.0.0.1:9', ucenter_web: 'http://127.0.0.1:9', npm_registry: 'http://127.0.0.1:9', npm_registry_linux: 'http://127.0.0.1:9' } }
  await fs.writeFile(path.join(appData, 'config.json'), JSON.stringify(config), { flag: 'wx' })
  await fs.mkdir(path.join(appData, 'npm-global/app'), { recursive: true })
  await fs.writeFile(path.join(appData, 'npm-global/app/subapp-index.json'), JSON.stringify({ dev: true }), { flag: 'wx' })
  if (values['host-build']) renderer = await serveRendererBuild(values['host-build'])
  await phase('open-complete-customer-document')
  await launch()
  const initial = await nativeDocument()
  assert.deepEqual(customerProjectSummary(initial), evidence.source.summary)
  assert.deepEqual([...indexCustomerProject(initial).keys()].sort(), [...indexCustomerProject(inputDocument).keys()].sort())
  if (hashDocument(initial) !== hashDocument(inputDocument)) {
    evidence.initialNativeMismatch = path.join(values.output, 'initial-native-mismatch.json')
    await fs.writeFile(evidence.initialNativeMismatch, JSON.stringify(initial, null, 2))
  }
  assert.equal(hashDocument(initial), hashDocument(inputDocument),
    'Opening the actual source must preserve its entire persisted document, including function and variable identity')
  evidence.loaded = { summary: customerProjectSummary(initial), hash: hashDocument(initial) }
  evidence.cases.push({ name: 'original-complete-native-load', ok: true })
  await observeCustomerNativeProgress(page)
  if (values['component-only']) {
    const names = ['project.abi', 'project.abs', 'project.abs.map.json']
    const primary = await Promise.all(names.map(async name => ({ name, sha256: digest(await fs.readFile(path.join(project, name))) })))
    const baselines = await inventory(path.join(project, '.aily/abs-sync'))
    await runCustomerNativeComponentCase({ page, project, modules: await nativeDiagnosticModules(), phase, evidence })
    assert.equal(hashDocument(await nativeDocument()), hashDocument(initial), 'Read-only observation cannot change the real source canvas')
    assert.deepEqual(await inventory(path.join(project, '.aily/abs-sync')), baselines)
    assert.deepEqual(await Promise.all(names.map(async name => ({ name, sha256: digest(await fs.readFile(path.join(project, name))) }))), primary)
    evidence.cases.push({ name: 'readonly-native-component-cold-warm', ok: true, sourceAndBaselineBytesUnchanged: true,
      sdkBaselineAuthorizationTested: false })
  } else if (values['native-publication-only']) {
    const { runCustomerNativePublicationCase } = await import('./fixtures/customer-native-publication-case.mjs')
    const result = await runCustomerNativePublicationCase({ project, suite, home, appData,
      agentRoot: values['agent-root'], hostPid, page, phase, evidence, originalDocument: initial,
      readNativeDocument: nativeDocument })
    const expectedHash = hashDocument(result.expectedDocument)
    assert.equal(hashDocument(await nativeDocument()), expectedHash)
    const saved = await fs.readFile(path.join(project, 'project.abi'), 'utf8')
    assert.equal(hashDocument(JSON.parse(saved)), expectedHash)
    const publishedMirrors = await Promise.all(['project.abi', 'project.abs', 'project.abs.map.json']
      .map(name => fs.readFile(path.join(project, name))))
    for (let attempt = 1; attempt <= 2; attempt++) {
      await phase('force-kill-and-cold-reopen-native-without-applying-draft-' + attempt)
      await forceKillOwned()
      assert.equal(await fs.readFile(path.join(project, 'project.abi'), 'utf8'), saved)
      await launch()
      assert.equal(hashDocument(await nativeDocument()), expectedHash,
        'Cold open must retain the exact native publication without applying the archived draft')
      const coldMirrors = await Promise.all(['project.abi', 'project.abs', 'project.abs.map.json']
        .map(name => fs.readFile(path.join(project, name))))
      for (let index = 0; index < publishedMirrors.length; index++)
        assert.ok(coldMirrors[index].equals(publishedMirrors[index]), 'Cold open changed a healthy native mirror without applying the draft')
      for (const backup of result.candidateBackups) await verifyCustomerCandidateRecord({ project, backup,
        candidateHash: backup.candidateHash, intentGeneration: backup.intentGeneration })
      evidence.cases.push({ name: 'non-apply-native-publication-and-pending-draft-backup-survive-cold-open',
        attempt, ok: true, candidateApplied: false })
    }
  } else if (values['native-dependency-only']) {
    const { runCustomerNativeDependencyCase } = await import('./fixtures/customer-native-dependency-case.mjs')
    const result = await runCustomerNativeDependencyCase({ project, suite, home, appData,
      agentRoot: values['agent-root'], hostPid, page, phase, evidence, originalDocument: initial,
      readNativeDocument: nativeDocument })
    const expectedHash = hashDocument(result.expectedDocument)
    const assertColdDependency = async () => {
      assert.equal(hashDocument(await nativeDocument()), expectedHash,
        'The entire native program must retain the new dependency block and all pre-existing content')
      const pkg = JSON.parse(await fs.readFile(path.join(project, 'package.json'), 'utf8'))
      assert.match(pkg.dependencies?.[result.probe.packageName] ?? '', /^file:(?:\.\/)?local-libraries\//)
      const runtime = await page.evaluate(({ packageName, blockType }) => {
        const editor = window.ng.getComponent(document.querySelector('app-blockly-editor'))
        return { registered: typeof window.Blockly.Blocks[blockType]?.init === 'function',
          used: editor.blocklyService.workspace.getAllBlocks(false).filter(block => block.type === blockType).length,
          snapshot: editor.blocklyService.getLibraryRuntimeSnapshot() }
      }, result.probe)
      assert.equal(runtime.registered, true)
      assert.equal(runtime.used, 1, 'The loaded native program must actually use this dependency')
      assert.equal(runtime.snapshot.active, true)
      assert.ok(runtime.snapshot.loadedLibraries.includes(result.probe.packageName))
      assert.ok(runtime.snapshot.toolboxLibraries.includes(result.probe.packageName))
      return runtime
    }
    await phase('verify-entire-program-and-required-library-after-abort')
    await assertColdDependency()
    const saved = await fs.readFile(path.join(project, 'project.abi'), 'utf8')
    assert.equal(hashDocument(JSON.parse(saved)), expectedHash)
    for (let attempt = 1; attempt <= 2; attempt++) {
      await phase('force-kill-and-cold-reopen-required-native-dependency-' + attempt)
      await forceKillOwned()
      assert.equal(await fs.readFile(path.join(project, 'project.abi'), 'utf8'), saved)
      await launch()
      const runtime = await assertColdDependency()
      evidence.cases.push({ name: 'committed-used-library-and-entire-program-survive-abort-and-cold-open',
        attempt, ok: true, packageName: result.probe.packageName, blockType: result.probe.blockType, runtime })
    }
  } else {
  const edit = await runCustomerBaselineCase({ project, suite, home, appData, agentRoot: values['agent-root'], hostPid, page, phase, evidence,
    originalDocument: initial, exerciseSelfOperations: values['exercise-self-operations'] === true,
    exerciseDependencyOperations: values['exercise-dependency-operations'] === true,
    exercisePostSaveEdit: values['exercise-post-save-edit'] === true,
    exercisePostCommitAbort: values['exercise-post-commit-abort'] === true,
    exerciseApplyObservationFault: values['exercise-apply-observation-fault'] === true,
    originPreflightOnly: values['origin-preflight-only'] === true })
  if (edit.originPreflightOnly) {
    assert.equal(hashDocument(await nativeDocument()), hashDocument(initial), 'An SDK file draft cannot change the native canvas')
    evidence.cases.push({ name: 'origin-preflight-retains-native-canvas', ok: true })
  } else {
  await phase('verify-entire-program-after-derived-apply')
  const after = await nativeDocument(), expected = structuredClone(edit.expectedDocument ?? initial)
  for (const change of edit.edits ?? [edit]) {
    const matches = [...indexCustomerProject(expected).values()].flatMap(block => Object.entries(block.fields ?? {})
      .filter(([, value]) => value === change.oldValue).map(([field]) => ({ block, field })))
    assert.equal(matches.length, 1, 'Each derived change must affect exactly one distinct original string field')
    matches[0].block.fields[matches[0].field] = change.newValue
  }
  assert.equal(hashDocument(after), hashDocument(expected), 'Every unedited field, identity, page, variable and comment must be preserved')
  assert.deepEqual(customerProjectSummary(after), evidence.source.summary)
  const saved = await fs.readFile(path.join(project, 'project.abi'), 'utf8')
  assert.equal(hashDocument(JSON.parse(saved)), hashDocument(after))
  evidence.cases.push({ name: 'complete-derived-candidate-validate-apply-save', ok: true, hash: hashDocument(after), summary: customerProjectSummary(after) })
  for (let attempt = 1; attempt <= 2; attempt++) {
    await phase('force-kill-and-cold-reopen-original-project-' + attempt)
    await forceKillOwned()
    assert.equal(await fs.readFile(path.join(project, 'project.abi'), 'utf8'), saved)
    await launch()
    assert.equal(hashDocument(await nativeDocument()), hashDocument(after))
    if (evidence.finalCandidateBackup) await verifyCustomerCandidateRecord({ project, backup: evidence.finalCandidateBackup,
      candidateHash: evidence.sdk.finalCandidateHash, intentGeneration: evidence.sdk.originalGeneration })
    evidence.cases.push({ name: 'saved-complete-program-survives-force-kill-and-cold-open', attempt, ok: true })
  }
  }
  }
  assert.deepEqual(await inventory(values['project-input']), originalFiles)
  evidence.originalInputUnchanged = true
  evidence.ok = true
  await phase('passed')
} catch (error) {
  evidence.error = { name: error.name, code: error.code, message: String(error.message).slice(0, 1500) }
  await persist()
  throw error
} finally {
  if (app) {
    if (evidence.ok) await app.close().catch(error => evidence.cleanupFailures.push(error.message))
    else await forceKillOwned().catch(error => evidence.cleanupFailures.push(error.message))
  }
  if (renderer) await renderer.close()
  evidence.originalInputUnchanged = JSON.stringify(await inventory(values['project-input'])) === JSON.stringify(originalFiles)
  if (!evidence.originalInputUnchanged) {
    evidence.originalInputModified = true; evidence.ok = false
  }
  await persist()
}
