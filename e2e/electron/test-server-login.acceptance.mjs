import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { _electron } from '@playwright/test'
import { serveRendererBuild } from '../fixtures/build-renderer-server.mjs'
import { prepareInstalledChatProfile } from '../fixtures/installed-chat-ui.mjs'

// Interactive login to an explicitly selected test origin. Never copy a daily
// credential, weaken authentication or contact a production API. A successful
// login is retained in the private profile, then only this test window closes.
// Use email login: system OAuth protocol callbacks do not inherit this profile.
assert.equal(process.env.AILY_TEST_LOGIN, '1')
const apiBase = process.env.AILY_TEST_API
assert.equal(apiBase, 'http://127.0.0.1:18159')
assert.equal((await fetch(apiBase + '/health')).status, 200)
const repo = fileURLToPath(new URL('../../', import.meta.url))
const source = 'C:/Users/LENOVO/AppData/Local/aily-project'
const root = path.join(source, 'dev-tests/abs-serial-analysis-20261028')
const suite = await fs.mkdtemp(path.join(root, 'test129-login-'))
const appData = path.join(suite, 'appdata')
const output = path.join(repo, 'e2e/test-results/unclaimed-step-20261101', path.basename(suite))
await fs.mkdir(output, { recursive: true })
const active = JSON.parse(await fs.readFile(path.join(source, 'npm-global/app/store/subapp-aily-chat/active.json'), 'utf8'))
const installedRoot = await fs.realpath(path.join(source, 'npm-global/app/store/subapp-aily-chat', active.selected.path))
const { verifyPortableBuild } = await import(pathToFileURL('D:/codes/aily-lex-pro/packages/aily-chat/server/portable-integrity.ts'))
const installed = await verifyPortableBuild(installedRoot)
const profile = await prepareInstalledChatProfile({ appData, installedRoot, apiBase,
  baseConfigPath: path.join(source, 'config.json'), token: '' })
// This is the fresh, test-owned placeholder, not the user's daily auth file.
await fs.unlink(path.join(appData, '.aily'))
const home = path.join(suite, 'home'), agentProfile = path.join(suite, 'agent-profile'), temp = path.join(suite, 'temp')
for (const directory of [home, agentProfile, temp]) await fs.mkdir(directory)
const connectionFile = path.join(suite, 'connection-profile.json')
await fs.writeFile(connectionFile, JSON.stringify({ apiBase, authFile: path.join(appData, '.aily'),
  configFile: path.join(appData, 'config.json'), model: 'auto', thinkingLevel: 'high' }, null, 2), { flag: 'wx' })
const renderer = await serveRendererBuild(path.join(repo, 'tests/test-results/view-conflict-resolution-20261029/host-final/browser'))
const { ELECTRON_RUN_AS_NODE, AILY_CHILD_PATH, NODE_PATH, AILY_PORTABLE_ROOT, ...env } = process.env
let app, pid
const report = { suite, appData, connectionFile, installed, productionAccess: false, signedIn: false }
try {
  app = await _electron.launch({ args: ['.', '--serve', `--user-data-dir=${path.join(suite, 'electron-profile')}`],
    cwd: repo, timeout: 60000, env: { ...env, ...profile.env, AILY_E2E: '1',
      AILY_DEV_RENDERER_URL: renderer.origin, HOME: home, USERPROFILE: home,
      PI_CODING_AGENT_DIR: agentProfile, TEMP: temp, TMP: temp, npm_config_offline: 'true' } })
  pid = await app.evaluate(() => process.pid)
  await app.context().route('**/*', route => {
    const url = new URL(route.request().url())
    return !['http:', 'https:'].includes(url.protocol) || ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      ? route.continue() : route.abort('blockedbyclient')
  })
  let page
  const startup = Date.now() + 60000
  while (!page && Date.now() < startup) {
    page = app.windows().find(value => value.url().startsWith(renderer.origin))
    if (!page) await new Promise(resolve => setTimeout(resolve, 200))
  }
  assert.ok(page)
  await page.goto(renderer.origin, { waitUntil: 'domcontentloaded' })
  await page.locator('app-main-window').waitFor({ timeout: 60000 })
  await page.evaluate(() => { document.title = 'Blockly · 129 测试服务器手动登录（隔离）' })
  await page.bringToFront()
  console.log('TEST_LOGIN_READY', JSON.stringify({ suite, connectionFile, apiBase, pid }))
  console.log('This isolated window closes automatically after verified login; the private account file is retained.')
  await fs.writeFile(path.join(output, 'ready.json'), JSON.stringify({ ...report, pid }, null, 2))
  // User supplies credentials only in the actual host login UI.
  const deadline = Date.now() + 20 * 60 * 1000
  while (Date.now() < deadline) {
    let token
    try { token = JSON.parse(await fs.readFile(path.join(appData, '.aily'), 'utf8')).access_token }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error }
    if (typeof token === 'string' && token.length > 0) {
      const response = await fetch(apiBase + '/api/v1/auth/me', { headers: { authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(10000) })
      const body = await response.json()
      if (response.status === 200 && body?.status === 200) {
        report.signedIn = true
        console.log('TEST_LOGIN_AUTHENTICATED', JSON.stringify({ connectionFile, apiBase }))
        break
      }
    }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  assert.ok(report.signedIn, 'Test login is still required; no model request was sent')
} catch (error) {
  report.failure = { name: error.name, message: error.message }
  console.error('TEST_LOGIN_FAILED', error.message)
  process.exitCode = 1
} finally {
  if (app) await app.evaluate(({ app }, expected) => {
    if (process.pid !== expected.pid || process.env.AILY_APPDATA_PATH !== expected.appData) throw new Error('Refuse unrelated shutdown')
    app.exit(0)
  }, { pid, appData }).catch(() => {})
  await renderer.close()
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2))
}
