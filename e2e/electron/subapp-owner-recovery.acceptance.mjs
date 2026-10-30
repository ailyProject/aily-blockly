import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from '@playwright/test'
import { serveRendererBuild } from '../fixtures/build-renderer-server.mjs'
import { installOwnerEchoFixture, verifyOwnerRecoveryWithAgent } from '../fixtures/subapp-owner-recovery-agent.mjs'

// Explicit private input/output roots only. This suite does not open a user
// project, use a model, discover hardware or replace the daily installed Chat.
const repo = fileURLToPath(new URL('../../', import.meta.url))
const required = name => {
  const value = process.env['AILY_OWNER_' + name]
  assert.ok(value && path.isAbsolute(value), `AILY_OWNER_${name} must be an explicit absolute path`)
  return path.resolve(value)
}
const root = await fs.realpath(required('TEST_ROOT'))
const build = required('HOST_BUILD'), agentRoot = required('AGENT_ROOT'), output = required('OUTPUT')
const inside = (parent, child) => { const value = path.relative(parent, child); return value &&
  value !== '..' && !value.startsWith('..' + path.sep) && !path.isAbsolute(value) }
assert.match(root.replaceAll('\\', '/'), /\/aily-project\/dev-tests\//i)
assert.ok(inside(path.join(repo, 'e2e/test-results'), output))
await fs.mkdir(output, { recursive: true })
const suite = await fs.mkdtemp(path.join(root, 'owner-recovery-'))
const home = path.join(suite, 'home'), appData = path.join(suite, 'appdata')
const project = path.join(suite, 'project'), profileRoot = path.join(suite, 'agent-profile')
await Promise.all([home, appData, project].map(directory => fs.mkdir(directory)))
await fs.writeFile(path.join(project, 'package.json'), JSON.stringify({ name: 'isolated-owner-acceptance', type: 'arduino' }))
const fixture = await installOwnerEchoFixture({ testRoot: root, appData, hostRoot: repo })
let app, renderer, catalog
const report = { ok: false, suite, hardwareUsed: false, simulatorUsed: false, llmInvoked: false,
  userProjectsModified: false, dailyInstallReplaced: false }
try {
  catalog = http.createServer((request, response) => {
    response.setHeader('content-type', 'application/json')
    response.setHeader('access-control-allow-origin', '*')
    response.setHeader('access-control-allow-headers', '*')
    response.end(JSON.stringify(request.url === '/subapp-index.json' ? fixture.index : { status: 200, data: {} }))
  })
  await new Promise(resolve => catalog.listen(0, '127.0.0.1', resolve))
  renderer = await serveRendererBuild(build)
  const { ELECTRON_RUN_AS_NODE, AILY_CHILD_PATH, NODE_PATH, ...env } = process.env
  app = await _electron.launch({ args: ['.', '--serve', `--user-data-dir=${path.join(suite, 'electron-profile')}`],
    cwd: repo, timeout: 60000, env: { ...env, AILY_E2E: '1', AILY_APPDATA_PATH: appData, HOME: home, USERPROFILE: home,
      PI_CODING_AGENT_DIR: profileRoot, AILY_DEV_RENDERER_URL: renderer.origin, AILY_BUILD_PRODUCT: 'blockly',
      AILY_SUBAPP_INDEX_URL: `http://127.0.0.1:${catalog.address().port}/subapp-index.json`,
      npm_config_offline: 'true', npm_config_audit: 'false' } })
  const hostPid = await app.evaluate(() => process.pid)
  report.hostPid = hostPid
  await app.firstWindow()
  let page
  const deadline = Date.now() + 60000
  while (!page && Date.now() < deadline) {
    page = app.windows().find(candidate => candidate.url().startsWith(renderer.origin))
    if (!page) await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(page, 'Only this suite-owned Host renderer may be used')
  page.on('dialog', dialog => dialog.dismiss())
  await page.goto(renderer.origin, { waitUntil: 'domcontentloaded' })
  await page.locator('app-main-window').waitFor({ timeout: 60000 })
  Object.assign(process.env, { AILY_LIBRARY_HOST_PID: String(hostPid), AILY_APPDATA_PATH: appData,
    PI_CODING_AGENT_DIR: profileRoot, HOME: home, USERPROFILE: home, PI_OFFLINE: '1',
    AILY_SUBAPP_INSTALL_ROOT: path.join(appData, 'npm-global/app') })
  const { pathToFileURL } = await import('node:url')
  const { appCommand } = await import(pathToFileURL(path.join(agentRoot, 'dist/blockly/services/app/command.js')).href)
  let ready = false
  for (let attempt = 0; attempt < 100 && !ready; attempt++) {
    const listed = await appCommand('blockly-live-operation', undefined,
      { operation: 'child_app_list', params: {} }, { targetPid: hostPid, timeoutMs: 5000 })
    ready = listed.ok && JSON.stringify(listed).includes(fixture.toolId)
    if (!ready) await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.equal(ready, true, 'Private installed echo manifest must be visible in the actual Host')
  Object.assign(report, await verifyOwnerRecoveryWithAgent({ agentRoot, sourceProject: project,
    globalRoot: root, profileRoot, fixture, hostPid }))
} catch (error) { report.error = String(error?.stack || error); throw error }
finally {
  if (app) {
    const child = app.process()
    await app.close().catch(() => undefined)
    report.hostExited = child.exitCode !== null
  }
  await renderer?.close()
  await new Promise(resolve => catalog ? catalog.close(resolve) : resolve())
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2))
}
