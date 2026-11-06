import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { _electron } from '@playwright/test'
import { serveRendererBuild } from '../fixtures/build-renderer-server.mjs'
import { createAbsTerminalExpiryBridge } from '../fixtures/abs-terminal-expiry-bridge.mjs'
import { createCombinedOperationFaultProxy } from '../fixtures/combined-operation-fault-proxy.mjs'
import { createLocalChatApiRouter, prepareInstalledChatProfile, assertInstalledChatLoaded } from '../fixtures/installed-chat-ui.mjs'
import { createInstalledChatUiAgent } from '../fixtures/installed-chat-ui-agent.mjs'

// A real portable Chat + host workflow driven by deterministic localhost model
// output. Every edit, native preparation, apply, recovery and compile runs in
// the product; no credentials, online model or user project are involved.
const repo = fileURLToPath(new URL('../../', import.meta.url))
const { values } = parseArgs({ options: Object.fromEntries(
  ['host-build', 'portable-root', 'seed-project', 'resource-root', 'test-root', 'lex-root', 'output']
    .map(name => [name, { type: 'string' }])) })
for (const name of ['host-build', 'portable-root', 'seed-project', 'resource-root', 'test-root', 'lex-root', 'output'])
  assert.ok(values[name] && path.isAbsolute(values[name]), `--${name} must be absolute`)
const inside = (root, value) => { const relative = path.relative(root, value)
  return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) }
assert.match(values['test-root'].replaceAll('\\', '/'), /\/aily-project\/dev-tests\//i)
assert.ok(inside(values['test-root'], values['seed-project']))
assert.ok(inside(path.join(repo, 'e2e/test-results'), values.output))
const seedManifest = JSON.parse(await fs.readFile(path.join(values['seed-project'], 'package.json'), 'utf8'))
assert.equal(seedManifest.name, 'pinned-comment-runtime-rebuild-diagnostic')
await fs.mkdir(values.output, { recursive: false })
const suite = await fs.mkdtemp(path.join(values['test-root'], 'native-chat-'))
const project = path.join(suite, 'project'), appData = path.join(suite, 'appdata'), home = path.join(suite, 'home')
const agentTemp = path.join(suite, 'agent-temp'), output = values.output, installedRoot = values['portable-root']
await fs.cp(values['seed-project'], project, { recursive: true, dereference: true, errorOnExist: true })
for (const directory of [appData, home, agentTemp]) await fs.mkdir(directory)
const sha = data => createHash('sha256').update(data).digest('hex')
const textOf = message => (message?.content ?? []).filter(item => item.type === 'text').map(item => item.text).join('\n')
const parsed = message => { if (message?.details?.result) return message.details.result
  try { return JSON.parse(textOf(message)) } catch { return undefined } }
const { verifyPortableBuild } = await import(pathToFileURL(path.join(values['lex-root'], 'packages/aily-chat/server/portable-integrity.ts')))
const artifact = await verifyPortableBuild(installedRoot)
const evidence = { ok: false, suite, project, realElectron: true, realPortableChat: true,
  llmInvoked: false, deterministicLocalModel: true, userProjectUsed: false, artifact, tools: [], reports: [] }
const persist = () => fs.writeFile(path.join(values.output, 'result.json'), JSON.stringify(evidence, null, 2))
const phase = value => { evidence.phase = value; console.log('PHASE=' + value) }
const marker = 'native_recovery_' + randomUUID().slice(0, 8)
const absPath = path.join(project, 'project.abs'), plan = []
let app, page, renderer, router, bridge, fault, agent, hostPid, candidate, generation, build
const beforeSeed = sha(await fs.readFile(path.join(values['seed-project'], 'project.abi')))
try {
  const nextTool = async () => {
    await agent.flush()
    const next = plan.shift()
    if (next) return next()
    assert.equal(build?.ok, true, 'Only a completed real compile can authorize the final response')
    assert.equal(build.buildReceipt?.state, 'completed')
  }
  bridge = await createAbsTerminalExpiryBridge({ interactionId: 'itx_native_' + randomUUID().replaceAll('-', ''), nextTool,
    allowEarlyStateProbe: true,
    finalText: 'The copied UNO project was edited, validated, applied and compiled through the real tools. Native comments were preserved. Final response recovered without replay.' })
  fault = await createCombinedOperationFaultProxy({ upstreamOrigin: bridge.origin, failAfterToolId: 'native-write' })
  router = await createLocalChatApiRouter({ operationOrigin: fault.origin, installedRoot })
  const profile = await prepareInstalledChatProfile({ appData, installedRoot, apiBase: router.origin,
    baseConfigPath: path.join(repo, 'electron/config/config.json'), resourceAppData: values['resource-root'], token: router.token })
  renderer = await serveRendererBuild(values['host-build'])
  const { ELECTRON_RUN_AS_NODE, AILY_CHILD_PATH, NODE_PATH, AILY_PORTABLE_ROOT, AILY_AUTH_FILE, ...env } = process.env
  phase('cold-portable-chat-host')
  app = await _electron.launch({ args: ['.', '--serve', `--user-data-dir=${path.join(suite, 'electron-profile')}`],
    cwd: repo, timeout: 60000, env: { ...env, ...profile.env, AILY_E2E: '1', AILY_DEV_RENDERER_URL: renderer.origin,
      HOME: home, USERPROFILE: home, TEMP: agentTemp, TMP: agentTemp,
      npm_config_offline: 'true', npm_config_audit: 'false' } })
  hostPid = await app.evaluate(() => process.pid)
  evidence.hostPid = hostPid
  await app.context().route('**/*', async route => {
    const request = route.request(), url = new URL(request.url())
    if (!['http:', 'https:'].includes(url.protocol) || ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return route.continue()
    if (!url.pathname.startsWith('/api/')) return route.abort('blockedbyclient')
    const headers = { ...request.headers() }; delete headers.host; delete headers['content-length']; delete headers.connection
    const response = await fetch(router.origin + url.pathname + url.search, { method: request.method(), headers,
      ...(['GET', 'HEAD'].includes(request.method()) ? {} : { body: request.postDataBuffer() }), signal: AbortSignal.timeout(15000) })
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) })
  })
  const deadline = Date.now() + 60000
  while (!page && Date.now() < deadline) {
    page = app.windows().find(window => window.url().startsWith(renderer.origin))
    if (!page) await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(page)
  page.on('dialog', dialog => dialog.dismiss())
  await page.goto(renderer.origin, { waitUntil: 'domcontentloaded' })
  await page.locator('app-main-window').waitFor({ timeout: 60000 })
  await page.evaluate(() => {
    const dismiss = () => document.querySelector('app-onboarding .btn-skip')?.click()
    new MutationObserver(dismiss).observe(document.documentElement, { childList: true, subtree: true }); dismiss()
  })
  await page.waitForFunction(() => window.ng?.getComponent(document.querySelector('app-header'))?.projectService)
  await page.evaluate(async target => {
    const service = window.ng.getComponent(document.querySelector('app-header')).projectService
    await service.initializeProjectDataSchema(target)
    if (!await service.projectOpen(target)) throw Error('The copied test project did not open')
  }, project)
  await page.waitForFunction(target => {
    const c = window.ng.getComponent(document.querySelector('app-blockly-editor'))
    return c?.projectService.currentProjectPath === target && c.projectService.getBlocklyProjectLoadStatus(target)?.ready
  }, project, { timeout: 120000 })
  phase('verify-portable-iframe')
  const loaded = await assertInstalledChatLoaded(page, { installedRoot, output, expectedApiBase: router.origin,
    expectedInputHash: artifact.inputHash, expectedOutputHash: artifact.outputHash })
  evidence.chat = loaded.evidence
  await page.evaluate(() => {
    const host = window.ng.getComponent(document.querySelector('app-child-tool-host')), original = host.reportAiOperationState.bind(host)
    window.__nativeChatReports = []
    host.reportAiOperationState = (...args) => {
      const ack = original(...args)
      window.__nativeChatReports.push({ request: args[0], ack })
      return ack
    }
  })
  const baseline = await page.evaluate(() => window.Blockly.serialization.workspaces.save(window.Blockly.getMainWorkspace()))
  agent = await createInstalledChatUiAgent({ installedRoot, isolationRoot: suite, project, loadedChat: loaded,
    expectedInputHash: artifact.inputHash, expectedOutputHash: artifact.outputHash,
    onStage: phase, onToolResult: async event => {
      const result = parsed(event)
      evidence.tools.push({ name: event.toolName, id: event.toolCallId, isError: event.isError, result,
        ...(event.isError ? { errorText: textOf(event) } : {}) })
      assert.equal(event.isError, false, `${event.toolName}: ${textOf(event)}`)
      phase('tool-' + event.toolName)
      if (event.toolCallId === 'native-inspect' && result?.diagnostics?.repair) {
        const repair = result.diagnostics.repair
        assert.equal(repair.authority, 'workspace')
        plan.unshift(() => agent.deferredCall('native-preserve', 'project_recover', {
          project, action: 'repair', token: repair.token, authority: repair.authority }))
      }
      if (event.toolName === 'abs_export') {
        assert.equal(result.ok, true); generation = result.generation
        const anchor = result.abs.match(/^arduino_setup\(\).*$/m)?.[0]
        assert.ok(anchor)
        candidate = result.abs.replace(anchor, `${anchor}\n    serial_print(Serial, text("${marker}"))`)
      }
      if (event.toolName === 'abs_apply') {
        assert.equal(result.ok, true); assert.equal(result.applyVerification?.ok, true)
        evidence.applyReceipt = result.receipt
      }
      if (event.toolName === 'project_build') {
        build = result
        if (result?.buildOutcome === 'unknown' && result.pendingBuild?.resumable === true)
          plan.unshift(() => agent.deferredCall('compile-observe-' + evidence.tools.length, 'project_build', result.pendingBuild.arguments))
      }
    } })
  const tool = (id, name, args = {}) => agent.deferredCall(id, name, { project, ...args })
  plan.push(
    () => agent.loadCall('load-native-tools', ['project_recover', 'abs_export', 'abs_validate', 'abs_apply', 'project_build']),
    () => tool('native-inspect', 'project_recover', { action: 'inspect' }),
    () => tool('native-export', 'abs_export'),
    () => agent.nativeCall('native-read', 'read', { path: absPath, limit: 50 }),
    () => agent.nativeCall('native-write', 'write', { path: absPath, content: candidate }),
    () => tool('native-validate', 'abs_validate', { generation, absPath }),
    () => tool('native-apply', 'abs_apply', { generation, absPath }),
    () => tool('native-compile', 'project_build'))
  phase('one-real-composer-turn')
  await agent.prompt('Preserve every block and comment in this isolated copied UNO project. Export ABS, add one Serial print, validate, apply and compile. Do not upload or install packages. Complete the edit through the tools.')
  await agent.flush()
  const final = agent.messages().filter(message => message.role === 'assistant').at(-1)
  assert.equal(final.stopReason, 'stop'); assert.equal(textOf(final), bridge.finalText)
  assert.equal(build.ok, true); assert.equal(build.buildReceipt.state, 'completed')
  const after = await page.evaluate(() => ({ state: window.Blockly.serialization.workspaces.save(window.Blockly.getMainWorkspace()),
    activity: (() => { const editor = window.ng.getComponent(document.querySelector('app-blockly-editor')).blocklyService
      return { writing: editor.aiWriting, waiting: editor.aiWaitWriting, blocked: editor.isWorkspaceEditBlocked() } })() }))
  const blockIndex = state => { const result = new Map(); const walk = node => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) return node.forEach(walk)
    if (node.type && node.id) { const { inputs, next, x, y, ...attributes } = node; result.set(node.id, attributes) }
    for (const [key, child] of Object.entries(node)) if (!['fields', 'extraState'].includes(key)) walk(child)
  }; walk(state); return result }
  const oldBlocks = blockIndex(baseline), newBlocks = blockIndex(after.state)
  for (const [id, attributes] of oldBlocks) assert.deepEqual(newBlocks.get(id), attributes)
  assert.equal(newBlocks.size, oldBlocks.size + 2)
  assert.deepEqual(after.activity, { writing: false, waiting: false, blocked: false })
  assert.match(await fs.readFile(path.join(project, '.temp/sketch/sketch.ino'), 'utf8'), new RegExp(marker))
  await page.waitForFunction(() => {
    const reports = window.__nativeChatReports || []
    return reports.some(item => item.request.version === 2 && item.request.runs.length === 0 && item.ack.applied)
      && !window.ng.getComponent(document.querySelector('app-child-tool-host')).aiOperationProtocol?.hasRunning
  }, undefined, { timeout: 15000 })
  evidence.reports = await page.evaluate(() => window.__nativeChatReports)
  assert.ok(evidence.reports.some(item => item.request.version === 2 && item.request.runs.length > 0 && item.ack.applied))
  evidence.transport = bridge.snapshot(); evidence.disconnect = fault.snapshot(); evidence.agent = agent.proof()
  assert.deepEqual(evidence.transport.failures, []); assert.deepEqual(evidence.disconnect.failures, [])
  assert.equal(evidence.disconnect.faultInjected, true); assert.equal(evidence.transport.createCount, 1)
  assert.equal(evidence.agent.actualEmbeddedComposerPrompt, true)
  evidence.compiled = build; evidence.preservedOriginalBlocks = oldBlocks.size; evidence.ok = true
  await page.screenshot({ path: path.join(output, 'complete.png'), fullPage: true })
  phase('complete')
} catch (error) {
  evidence.error = error.stack ?? String(error); process.exitCode = 1
  evidence.transport = bridge?.snapshot(); evidence.agent = agent?.proof()
  await persist()
  console.error(error.message)
  await page?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {})
} finally {
  await agent?.dispose()
  if (app) await app.evaluate(({ app }, owned) => {
    if (process.pid !== owned.pid || process.env.AILY_APPDATA_PATH !== owned.appData) throw Error('Refuse unrelated host exit')
    app.exit(0)
  }, { pid: hostPid, appData }).catch(error => { evidence.cleanupError = error.message; process.exitCode = 1 })
  await renderer?.close(); await router?.close(); await fault?.close(); await bridge?.close()
  assert.equal(sha(await fs.readFile(path.join(values['seed-project'], 'project.abi'))), beforeSeed)
  assert.deepEqual(await verifyPortableBuild(installedRoot), artifact)
  await persist()
  console.log(JSON.stringify({ ok: evidence.ok, phase: evidence.phase, output }))
}
