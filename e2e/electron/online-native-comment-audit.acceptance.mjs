import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { _electron } from '@playwright/test'
import { serveRendererBuild } from '../fixtures/build-renderer-server.mjs'
import { assertOnlineNativeReceipts, assertNativeCommentEditPreserved, captureNativeCommentState } from '../fixtures/online-native-comment-case.mjs'

// Audit the SAME persisted online turn after a fixture parser rejection. This
// opens its owned project for native readback only: no model, tool invocation,
// save, apply, runtime rebuild, compile, login or connection profile is used.
const repo = fileURLToPath(new URL('../../', import.meta.url))
const { values } = parseArgs({ options: Object.fromEntries(['run-output', 'host-build', 'output'].map(name => [name, { type: 'string' }])) })
for (const name of ['run-output', 'host-build', 'output']) assert.ok(path.isAbsolute(values[name] ?? ''))
const inside = (root, file) => { const relative = path.relative(root, file)
  return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) }
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
const sha = value => createHash('sha256').update(value).digest('hex')
assert.ok(inside(path.join(repo, 'e2e/test-results'), values['run-output']) && inside(path.join(repo, 'e2e/test-results'), values.output))
assert.ok(!same(values['run-output'], values.output))
const originalPath = path.join(values['run-output'], 'result.json'), originalBytes = await fs.readFile(originalPath)
const original = JSON.parse(originalBytes), project = original.project
assert.ok(inside(original.suite, project) && same(await fs.realpath(project), project))
assert.match(original.suite.replaceAll('\\', '/'), /\/aily-project\/dev-tests\/.+\/online-native-[^/]+$/i)
assert.equal(original.final?.stopReason, 'stop'); assert.equal(original.inputsPreserved, true)
assert.equal(original.onlineLlm, true); assert.equal(original.transport?.createCount, 1)
const baseline = JSON.parse(await fs.readFile(path.join(values['run-output'], 'native-before.json'), 'utf8'))
const sessions = []
async function findSessions(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    assert.equal(entry.isSymbolicLink(), false)
    if (entry.isDirectory()) await findSessions(file)
    else if (entry.isFile() && file.endsWith('.jsonl')) sessions.push(file)
  }
}
await findSessions(path.join(original.suite, 'agent-profile/sessions')); assert.equal(sessions.length, 1)
const sessionBytes = await fs.readFile(sessions[0]), rows = sessionBytes.toString('utf8').trim().split(/\r?\n/).map(line => JSON.parse(line))
const session = { messages: rows.map(row => row.message).filter(Boolean) }
assert.equal(session.messages.filter(message => message.role === 'user').length, 1)
const final = session.messages.filter(message => message.role === 'assistant').at(-1)
assert.equal(final.stopReason, 'stop')
assert.equal(sha(final.content.filter(block => block.type === 'text').map(block => block.text).join('')), original.final.textHash)
const receipts = assertOnlineNativeReceipts(session, project)
await fs.mkdir(values.output, { recursive: false })
const auditSuite = await fs.mkdtemp(path.join(original.suite, 'native-audit-'))
const appData = path.join(auditSuite, 'appdata'), home = path.join(auditSuite, 'home'), temp = path.join(auditSuite, 'temp')
for (const directory of [appData, home, temp]) await fs.mkdir(directory)
const report = { ok: false, sameRunAudit: true, originalReportedOk: original.ok, originalFailure: original.failure?.message,
  originalReportSha256: sha(originalBytes), originalSessionSha256: sha(sessionBytes),
  project, originalUserPrompts: 1, newModelCalls: 0, newToolInvocations: 0, newCompileCalls: 0,
  originalOnlineTurnVerified: true, receipts: receipts.evidence, stages: [] }
const persist = () => fs.writeFile(path.join(values.output, 'result.json'), JSON.stringify(report, null, 2))
const phase = value => { report.stages.push(value); console.log('PHASE=' + value) }
const protectedNames = ['project.abi', 'project.abs', 'project.abs.map.json', 'package.json',
  '.temp/sketch/sketch.ino', '.log/compile/latest-result.json']
const hashes = async () => Object.fromEntries(await Promise.all(protectedNames.map(async name => [name, sha(await fs.readFile(path.join(project, name)))])))
const beforeHashes = await hashes()
const compile = JSON.parse(await fs.readFile(path.join(project, '.log/compile/latest-result.json'), 'utf8'))
assert.equal(compile.success, true); assert.ok(compile.finishedAt >= original.submittedAt)
const sketch = await fs.readFile(path.join(project, '.temp/sketch/sketch.ino'), 'utf8'); assert.ok(sketch.includes(original.marker))
report.originalCompilation = { success: true, finishedAt: compile.finishedAt, requestId: receipts.evidence.build.requestId,
  compilationScope: receipts.evidence.compilationScope, sketchSha256: sha(sketch) }
let app, renderer, page, hostPid
try {
  const config = JSON.parse(await fs.readFile(path.join(repo, 'electron/config/config.json'), 'utf8'))
  config.metricsEnabled = false; config.recentlyProjects = []; config.project_path = auditSuite; config.appdata_path[process.platform] = appData
  config.region = 'native-audit-offline'; config.regions = { [config.region]: { official: false, enabled: true,
    name: 'Native same-run audit', api_server: 'http://127.0.0.1:9', resource: 'http://127.0.0.1:9', web: 'http://127.0.0.1:9',
    tool_web: 'http://127.0.0.1:9', ucenter_web: 'http://127.0.0.1:9', npm_registry: 'http://127.0.0.1:9' } }
  await fs.writeFile(path.join(appData, 'config.json'), JSON.stringify(config), { flag: 'wx' })
  renderer = await serveRendererBuild(values['host-build'])
  const { ELECTRON_RUN_AS_NODE, AILY_CHILD_PATH, NODE_PATH, AILY_PORTABLE_ROOT, AILY_AUTH_FILE, ...env } = process.env
  phase('cold-owned-native-readback-only')
  app = await _electron.launch({ args: ['.', '--serve', `--user-data-dir=${path.join(auditSuite, 'electron-profile')}`], cwd: repo,
    timeout: 60000, env: { ...env, AILY_E2E: '1', AILY_APPDATA_PATH: appData, AILY_MAIN_APPDATA_PATH: appData,
      AILY_NPM_PREFIX: path.join(appData, 'npm-global'), AILY_DEV_RENDERER_URL: renderer.origin,
      HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: path.join(auditSuite, 'agent-profile'), TEMP: temp, TMP: temp,
      npm_config_offline: 'true', npm_config_audit: 'false' } })
  const identity = await app.evaluate(() => ({ pid: process.pid, appData: process.env.AILY_APPDATA_PATH }))
  assert.ok(same(identity.appData, appData)); hostPid = identity.pid; report.hostPid = hostPid
  await app.context().route('**/*', route => {
    const url = new URL(route.request().url())
    if (!['http:', 'https:'].includes(url.protocol) || url.origin === renderer.origin) return route.continue()
    return route.abort('blockedbyclient')
  })
  const deadline = Date.now() + 60000
  while (!page && Date.now() < deadline) { page = app.windows().find(window => window.url().startsWith(renderer.origin)); if (!page) await new Promise(resolve => setTimeout(resolve, 100)) }
  assert.ok(page); page.on('dialog', dialog => dialog.dismiss())
  await page.goto(renderer.origin, { waitUntil: 'domcontentloaded' }); await page.locator('app-main-window').waitFor({ timeout: 60000 })
  await page.evaluate(() => {
    const dismiss = () => { document.querySelector('app-onboarding .btn-skip')?.click(); document.querySelector('app-login .login-close')?.click() }
    new MutationObserver(dismiss).observe(document.documentElement, { childList: true, subtree: true }); dismiss()
  })
  await page.waitForFunction(() => window.ng?.getComponent(document.querySelector('app-header'))?.projectService)
  await page.evaluate(async target => {
    if (!await window.ng.getComponent(document.querySelector('app-header')).projectService.projectOpen(target)) throw Error('The same owned project did not open')
  }, project)
  await page.waitForFunction(target => {
    const c = window.ng.getComponent(document.querySelector('app-blockly-editor'))
    return c?.projectService.currentProjectPath === target && c.projectService.getBlocklyProjectLoadStatus(target)?.ready
  }, project, { timeout: 120000 })
  phase('verify-complete-native-and-durable-source')
  const after = await captureNativeCommentState(page, project)
  report.nativePreservation = assertNativeCommentEditPreserved(baseline, after, original.marker)
  assert.deepEqual(after.document, JSON.parse(await fs.readFile(path.join(project, 'project.abi'), 'utf8')))
  assert.deepEqual(after.activity, { writing: false, waitHint: false, busy: false, blocked: false, recoveryRequired: false, ready: true })
  report.sourceHashes = await hashes(); assert.deepEqual(report.sourceHashes, beforeHashes)
  await fs.writeFile(path.join(values.output, 'native-after.json'), JSON.stringify(after, null, 2))
  await page.screenshot({ path: path.join(values.output, 'final.png'), fullPage: true })
  report.ok = true; phase('same-original-turn-audit-complete')
} catch (error) { report.failure = { name: error.name, message: error.message, stack: String(error.stack).split('\n').slice(0, 7).join('\n') }; process.exitCode = 1; console.error(error.message) }
finally {
  if (app) await app.evaluate(({ app }, owned) => {
    if (process.pid !== owned.pid || process.env.AILY_APPDATA_PATH !== owned.appData) throw Error('Refuse unrelated host exit')
    app.exit(0)
  }, { pid: hostPid, appData }).catch(error => { report.cleanupError = error.message; report.ok = false; process.exitCode = 1 })
  await renderer?.close()
  try {
    assert.equal(sha(await fs.readFile(originalPath)), sha(originalBytes)); assert.equal(sha(await fs.readFile(sessions[0])), sha(sessionBytes))
    assert.deepEqual(await hashes(), beforeHashes); report.originalEvidenceAndSourceUnchanged = true
  } catch (error) { report.integrityFailure = error.message; report.ok = false; process.exitCode = 1 }
  await persist(); console.log(JSON.stringify({ ok: report.ok, sameRunAudit: true, output: values.output, failure: report.failure?.message }))
}
