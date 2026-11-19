import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { parseArgs, promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { _electron } from '@playwright/test'
import { prepareBuildLogProject } from './fixtures/build-log-project.mjs'

// R0 only: actual packaged native realm + actual dirty Working capture. No
// application receipt, Chat Stop, durable recovery or new production owner is
// fabricated by this probe. Those must pass the subsequent R1 product chain.
const repo = fileURLToPath(new URL('../../', import.meta.url))
const { values } = parseArgs({ options: Object.fromEntries(['executable-path', 'renderer-root', 'test-root', 'output', 'expected-host-hash']
  .map(name => [name, { type: 'string' }])) })
for (const name of ['executable-path', 'renderer-root', 'test-root', 'output']) assert.ok(path.isAbsolute(values[name] ?? ''))
const inside = (root, child) => { const relative = path.relative(root, child); return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) }
assert.ok(inside(path.join(repo, 'e2e/test-results'), values.output))
assert.match(values['test-root'].replaceAll('\\', '/'), /\/aily-project\/dev-tests\//i)
assert.match(values['expected-host-hash'] ?? '', /^[a-f0-9]{64}$/)
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const hostHash = sha(await fs.readFile(path.join(path.dirname(values['executable-path']), 'resources/app.asar')))
assert.equal(hostHash, values['expected-host-hash'])
const files = await fs.readdir(values['renderer-root'])
const modules = {}
for (const file of files.filter(name => /^chunk-[\w-]+\.js$/.test(name))) {
  const source = await fs.readFile(path.join(values['renderer-root'], file), 'utf8')
  for (const name of ['evaluateNativeCandidate', 'assertAbsReadback']) if (source.includes('function ' + name + '(')) {
    assert.equal(modules[name], undefined)
    modules[name] = { file, sha256: sha(source) }
  }
}
assert.ok(modules.evaluateNativeCandidate && modules.assertAbsReadback)
await fs.mkdir(path.dirname(values.output), { recursive: true })
await fs.mkdir(values.output, { recursive: false })
await fs.mkdir(values['test-root'], { recursive: true })
const suite = await fs.mkdtemp(path.join(values['test-root'], 'r0-runtime-'))
const project = path.join(suite, 'project'), appData = path.join(suite, 'appdata'), home = path.join(suite, 'home'), temp = path.join(suite, 'temp')
for (const directory of [appData, home, temp]) await fs.mkdir(directory)
const fixture = await prepareBuildLogProject({ directory: project, boardsRoot: path.resolve(repo, '../aily-blockly-boards'),
  librariesRoot: path.resolve(repo, '../aily-blockly-libraries'), scenario: 'field-edit', marker: 'R0_RUNTIME_NO_COMPILER' })
const config = JSON.parse(await fs.readFile(path.join(repo, 'electron/config/config.json'), 'utf8'))
Object.assign(config, { metricsEnabled: false, project_path: suite, recentlyProjects: [], onboardingCompleted: true,
  blocklyOnboardingCompleted: true, region: 'r0-local' })
config.appdata_path[process.platform] = appData
config.regions = { 'r0-local': Object.fromEntries(['api_server', 'resource', 'web', 'tool_web', 'ucenter_web', 'npm_registry', 'npm_registry_linux']
  .map(key => [key, 'http://127.0.0.1:9'])) }
Object.assign(config.regions['r0-local'], { official: false, enabled: true, name: 'R0 isolated native probe' })
await fs.writeFile(path.join(appData, 'config.json'), JSON.stringify(config), { flag: 'wx' })
await fs.mkdir(path.join(appData, 'npm-global/app'), { recursive: true })
await fs.writeFile(path.join(appData, 'npm-global/app/subapp-index.json'), '{"dev":true}', { flag: 'wx' })
const evidence = { ok: false, startedAt: new Date().toISOString(), suite, project, hostHash, modules,
  realPackagedHost: true, paidModelRequests: 0, compilerInvoked: false, newerSourceVerified: false,
  durableRecoveryTested: false, chatStopTested: false, runs: [] }
const persist = () => fs.writeFile(path.join(values.output, 'result.json'), JSON.stringify(evidence, null, 2))
const exec = promisify(execFile)
const processes = async () => {
  const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate | ConvertTo-Json -Compress'], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
  const list = JSON.parse(stdout); return Array.isArray(list) ? list : [list]
}
let app, page, hostPid, owned = []
try {
  await persist()
  const { ELECTRON_RUN_AS_NODE, NODE_PATH, AILY_CHILD_PATH, AILY_AUTH_FILE, AILY_PORTABLE_ROOT, ...env } = process.env
  app = await _electron.launch({ executablePath: values['executable-path'], cwd: repo, args: [`--user-data-dir=${path.join(suite, 'profile')}`],
    timeout: 60000, env: { ...env, AILY_E2E: '1', AILY_APPDATA_PATH: appData, AILY_NPM_PREFIX: path.join(appData, 'npm-global'),
      HOME: home, USERPROFILE: home, TEMP: temp, TMP: temp, npm_config_offline: 'true', npm_config_audit: 'false' } })
  hostPid = await app.evaluate(() => process.pid); evidence.hostPid = hostPid
  await app.context().route('**/*', route => {
    const url = new URL(route.request().url())
    return !['http:', 'https:'].includes(url.protocol) || ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      ? route.continue() : route.abort('blockedbyclient')
  })
  const deadline = Date.now() + 60000
  while (!page && Date.now() < deadline) {
    for (const candidate of app.windows()) if (await candidate.locator('app-main-window').count()) { page = candidate; break }
    if (!page) await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(page)
  page.on('dialog', dialog => dialog.dismiss())
  await page.evaluate(() => {
    const dismiss = () => { document.querySelector('app-onboarding .btn-skip')?.click(); document.querySelector('app-login .login-close')?.click() }
    new MutationObserver(dismiss).observe(document.documentElement, { childList: true, subtree: true }); dismiss()
  })
  await page.waitForFunction(() => window.ng?.getComponent(document.querySelector('app-header'))?.projectService)
  assert.equal(await page.evaluate(async target => {
    const domain = window.ng.getComponent(document.querySelector('app-header')).projectService
    if (domain.currentProjectPath && domain.currentProjectPath !== target) throw Error('Unexpected unrelated project')
    await domain.initializeProjectDataSchema(target)
    return await domain.projectOpen(target)
  }, project), true)
  await page.waitForFunction(target => {
    const editor = window.ng?.getComponent(document.querySelector('app-blockly-editor'))
    return editor?.projectService.currentProjectPath === target && editor.projectService.getBlocklyProjectLoadStatus(target)?.ready
  }, project, { timeout: 120000 })
  const all = await processes(), pids = new Set([hostPid])
  let changed
  do { changed = false; for (const item of all) if (pids.has(item.ParentProcessId) && !pids.has(item.ProcessId)) { pids.add(item.ProcessId); changed = true } } while (changed)
  owned = all.filter(item => pids.has(item.ProcessId)); evidence.owned = owned
  const abiBefore = sha(await fs.readFile(path.join(project, 'project.abi')))
  const working = await page.evaluate(({ blockId }) => {
    const editor = window.ng.getComponent(document.querySelector('app-blockly-editor')).blocklyService
    const before = editor.captureProjectSnapshot()
    const block = window.Blockly.getMainWorkspace().getBlockById(blockId)
    if (!block || block.getFieldValue('VALUE') !== 100) throw Error('Missing real GUI fixture')
    block.setFieldValue(102, 'VALUE')
    const after = editor.captureProjectSnapshot()
    const lease = editor.acquireWorkspaceEditLease()
    const denied = []
    try {
      for (const method of ['getProjectDocument', 'captureProjectSnapshot', 'captureRecoverySnapshot']) {
        try { editor[method](); throw Error(method + ' exposed a writer view') }
        catch (error) { if (error.code !== 'BLOCKLY_EDIT_BUSY') throw error; denied.push(method) }
      }
      if (editor.captureProjectSnapshot(lease).documentText !== after.documentText) throw Error('Owner cannot capture exact Working')
    } finally { lease.release() }
    return { beforeText: before.documentText, afterText: after.documentText, beforeVersion: before.revision, afterVersion: after.revision,
      ordinaryReadsDenied: denied, busyAfterRelease: editor.isWorkspaceEditInProgress() }
  }, fixture)
  assert.ok(working.afterVersion > working.beforeVersion)
  const expected = JSON.parse(working.beforeText)
  let found = 0
  const visit = value => { if (!value || typeof value !== 'object') return
    if (value.id === fixture.blockId) { value.fields.VALUE = 102; found++ }
    for (const child of Object.values(value)) if (child && typeof child === 'object') visit(child)
  }
  visit(expected); assert.equal(found, 1); assert.deepEqual(JSON.parse(working.afterText), expected)
  assert.equal(working.busyAfterRelease, false)
  assert.equal(sha(await fs.readFile(path.join(project, 'project.abi'))), abiBefore)
  evidence.working = { ...working, genuineDirtyDocumentPreserved: true, diskUnchanged: true }; await persist()
  for (const kind of ['realm-isolation', 'abort-in-realm', 'bounded-sync-cpu']) {
    console.log('R0_RUNTIME_PHASE=' + kind)
    const result = await page.evaluate(async ({ modules, kind }) => {
      const imported = {}
      for (const [name, entry] of Object.entries(modules)) {
        const url = new URL(entry.file, document.baseURI)
        const bytes = await (await fetch(url, { cache: 'no-store' })).arrayBuffer()
        const actual = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('')
        if (actual !== entry.sha256) throw Error('Paired native diagnostic module mismatch')
        imported[name] = (await import(url.href))[name]
        if (typeof imported[name] !== 'function') throw Error('Missing actual native export')
      }
      const editor = window.ng.getComponent(document.querySelector('app-blockly-editor')).blocklyService
      const replay = editor.captureNativeReplay(), state = editor.getWorkspaceJson(), working = editor.captureProjectSnapshot().documentText
      const request = { steps: [...replay.steps], graphics: replay.graphics, blocks: [], verify: { state, contracts: { fields: {} } } }
      const marker = '__R0_ISOLATED_LIBRARY__', hostMarker = window.Blockly.Msg[marker]
      if (kind === 'realm-isolation') request.steps.push({ kind: 'script', label: 'r0-actual-realm-isolation', source: 'Blockly.Msg.__R0_ISOLATED_LIBRARY__ = "realm-only";' })
      if (kind === 'abort-in-realm') request.steps.push({ kind: 'script', label: 'r0-await-registration', source: 'setTimeout(function () { Blockly.Msg.__R0_ISOLATED_LIBRARY__ = "deferred"; }, 1500);' })
      if (kind === 'bounded-sync-cpu') request.steps.push({ kind: 'script', label: 'r0-bounded-cpu-no-hard-isolation',
        source: '(function () { var until = Date.now() + 400; while (Date.now() < until) {} })();' })
      const controller = new AbortController(), start = performance.now()
      let frameSeen = false, timer, abortAt
      const targetReplay = {}
      const NativeChannel = window.MessageChannel
      function ObservedChannel(...args) {
        const channel = new NativeChannel(...args)
        channel.port1.addEventListener('message', event => {
          const reply = event.data, replay = reply?.replay
          if (replay?.step !== request.steps.length - 1) return
          if (replay.event === 'step-start') {
            targetReplay.startRealmMs = reply.elapsedMs
            targetReplay.receivedStartMs = performance.now() - start
            if (kind !== 'realm-isolation' && timer === undefined) timer = setTimeout(() => {
              abortAt = performance.now() - start; controller.abort(new DOMException('R0 cancellation', 'AbortError'))
            }, 60)
          }
          if (replay.event === 'step-end') { targetReplay.endRealmMs = reply.elapsedMs; targetReplay.receivedEndMs = performance.now() - start }
        })
        return channel
      }
      ObservedChannel.prototype = NativeChannel.prototype
      Object.setPrototypeOf(ObservedChannel, NativeChannel)
      window.MessageChannel = ObservedChannel
      const observer = new MutationObserver(() => {
        if (kind === 'realm-isolation' || frameSeen || !document.querySelector('iframe[data-blockly-native-candidate]')) return
        frameSeen = true
      })
      observer.observe(document.body, { childList: true })
      let outcome, code, readbackEqual = false
      try {
        const actual = await imported.evaluateNativeCandidate(request, { assertCurrent: replay.assertCurrent, timeoutMs: 10000, signal: controller.signal })
        imported.assertAbsReadback(state, actual.state); readbackEqual = true; outcome = 'completed'
      } catch (error) { code = error.code ?? error.name; outcome = controller.signal.aborted ? 'cancelled' : 'failed'; if (outcome === 'failed') throw error }
      finally { observer.disconnect(); clearTimeout(timer); window.MessageChannel = NativeChannel }
      if (window.Blockly.Msg[marker] !== hostMarker) throw Error('Realm wrote the host registry')
      if (editor.captureProjectSnapshot().documentText !== working) throw Error('Read-only candidate changed the full GUI document')
      return { kind, outcome, code, elapsedMs: performance.now() - start, abortAtMs: abortAt ?? null, frameSeen, targetReplay, readbackEqual,
        hostRegistryUnchanged: true, fullWorkingUnchanged: true, remainingNativeFrames: document.querySelectorAll('iframe[data-blockly-native-candidate]').length,
        cpuHardIsolationProven: false }
    }, { modules, kind })
    assert.equal(result.remainingNativeFrames, 0)
    if (kind === 'realm-isolation') { assert.equal(result.outcome, 'completed'); assert.equal(result.readbackEqual, true) }
    else {
      assert.equal(result.frameSeen, true); assert.equal(typeof result.targetReplay.receivedStartMs, 'number', 'Cancellation must reach the actual probe replay step')
      if (kind === 'abort-in-realm') assert.equal(result.outcome, 'cancelled')
      else assert.ok(['cancelled', 'completed'].includes(result.outcome), 'A bounded synchronous script is not promised preemptible')
    }
    evidence.runs.push(result); await persist()
  }
  assert.equal(sha(await fs.readFile(path.join(project, 'project.abi'))), abiBefore)
  evidence.ok = true
} catch (error) {
  evidence.failure = { message: error.message, stack: error.stack }; throw error
} finally {
  if (app) await app.evaluate(({ app }, expected) => {
    if (process.pid !== expected.pid || process.env.AILY_APPDATA_PATH !== expected.appData) throw Error('Refuse unrelated host cleanup')
    app.exit(0)
  }, { pid: hostPid, appData }).catch(error => { if (!/closed|destroyed|terminated|Target/i.test(error.message)) throw error })
  const deadline = Date.now() + 30000
  let remaining = []
  do { const all = await processes(); remaining = owned.filter(item => all.some(p => p.ProcessId === item.ProcessId && p.CreationDate === item.CreationDate))
    if (!remaining.length) break; await new Promise(resolve => setTimeout(resolve, 250)) } while (Date.now() < deadline)
  evidence.remainingOwned = remaining; evidence.finishedAt = new Date().toISOString(); await persist()
  assert.equal(remaining.length, 0, 'No R0-owned process may outlive its probe')
}
console.log(JSON.stringify({ ok: evidence.ok, output: values.output, nativeCases: evidence.runs.length, paidModelRequests: 0, remainingOwned: 0 }))
