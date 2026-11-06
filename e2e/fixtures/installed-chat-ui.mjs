import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { createInstalledChatObserver } from './installed-chat-observer.mjs'

const PACKAGE = '@aily-project/subapp-aily-chat'
const INPUT = '9a9c0b2877e6bcffe53b36d909b644d3d312c6e533d797f87c577ee87802b230'
const OUTPUT = '4d72168a4d470cc4a07f7c3f79d7e068b1304f065625b1e5aa70c6a5d279c7e9'
const USER = Object.freeze({ id: 'isolated-installed-chat', nickname: 'Isolated ABS acceptance', groups: ['free'],
  entitlements: {}, subscription_plan: { name: 'test', service_tier: 'free', status: 'active' } })
const sha = value => createHash('sha256').update(value).digest('hex')
const localUrl = value => {
  const url = new URL(value)
  assert.equal(url.protocol, 'http:')
  assert.equal(url.hostname, '127.0.0.1')
  assert.ok(url.port && !url.username && !url.password && url.pathname === '/')
  return url
}

export function createIsolatedChatToken() {
  return [{ alg: 'HS256', typ: 'JWT' }, { sub: JSON.stringify({ id: USER.id, user_type: 'free' }),
    exp: Math.floor(Date.now() / 1000) + 86400, jti: 'isolated-installed-chat-only' }]
    .map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.') + '.test-signature'
}

async function catalogFor(installedRoot) {
  const pkg = JSON.parse(await fs.readFile(path.join(installedRoot, 'package.json'), 'utf8'))
  assert.equal(pkg.name, PACKAGE)
  assert.equal(pkg.ailyPortable?.format, 'js')
  return { dev: true, 'aily-chat': { id: 'aily-chat', titleKey: 'AILY_CHAT.TITLE', namespace: 'AILY_CHAT',
    package: PACKAGE, version: pkg.version, app: { ...pkg.ailySubapp?.app,
      name: 'AILY_CHAT.TITLE', description: 'AILY_CHAT.DESCRIPTION', enabled: true, autoInstall: false },
    i18n: { defaultLocale: 'en', locales: { en: { TITLE: 'Aily Chat', DESCRIPTION: 'Isolated Agent acceptance' },
      zh_cn: { TITLE: 'Aily Chat', DESCRIPTION: '隔离 Agent 验收' } } } } }
}

/** Only synthetic credentials and localhost metadata. The operation bridge still
 * owns SSE/fault injection; no response here executes a model or a tool. */
export async function createLocalChatApiRouter({ operationOrigin, installedRoot }) {
  const operationBase = operationOrigin ? localUrl(operationOrigin).origin : undefined
  const token = createIsolatedChatToken(), catalog = await catalogFor(installedRoot)
  const requests = [], denied = [], activeProxies = new Set()
  const credits = { available_micros: 100_000_000, reserved_micros: 0, included_granted_micros: 100_000_000,
    next_reset_at: null, subscription_plan: 'test' }
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    const origin = request.headers.origin
    if (origin) {
      try { const value = new URL(origin); assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(value.hostname)) }
      catch { response.writeHead(403); response.end(); return }
      response.setHeader('access-control-allow-origin', origin)
      response.setHeader('access-control-allow-credentials', 'true')
    }
    response.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
    response.setHeader('access-control-allow-headers', request.headers['access-control-request-headers'] || 'authorization,content-type')
    if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return }
    requests.push({ method: request.method, path: url.pathname })
    const json = (value, status = 200) => {
      request.resume()
      const body = JSON.stringify(value)
      response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store',
        'content-length': Buffer.byteLength(body) })
      response.end(body)
    }
    if (request.method === 'GET') {
      if (url.pathname === '/api/v1/auth/me') return json({ status: 200, data: USER })
      if (url.pathname === '/api/v1/credits/me') return json(credits)
      if (url.pathname === '/api/v1/auth/me/quota-info') return json({ status: 200, data: {} })
      if (url.pathname === '/api/v3/interaction_quotas/snapshot') return json({ status: 200,
        data: { quotaSnapshots: {}, chatQuotaExceeded: false } })
      if (url.pathname === '/api/v1/entitlements/me/benefits') return json({ status: 200, data: {} })
      if (url.pathname === '/api/v2/model_catalog') return json({ status: 200, data: { model_presets: {} } })
      if (url.pathname === '/subapp-index.json') return json(catalog)
    }
    if (request.method === 'POST' && url.pathname === '/api/v1/generate_title')
      return json({ status: 200, data: 'Isolated ABS acceptance' })
    if (operationBase && ['GET', 'POST'].includes(request.method)
      && /^\/api\/v3\/interactions(?:\/|$)/.test(url.pathname)) {
      const proxy = http.request(new URL(url.pathname + url.search, operationBase), {
        method: request.method, headers: { ...request.headers, host: new URL(operationBase).host }
      }, upstream => { response.writeHead(upstream.statusCode, upstream.headers); upstream.pipe(response) })
      activeProxies.add(proxy)
      proxy.once('close', () => activeProxies.delete(proxy))
      proxy.once('error', () => { if (response.headersSent) response.destroy(); else response.destroy() })
      request.once('aborted', () => proxy.destroy())
      response.once('close', () => { if (!response.writableFinished) proxy.destroy() })
      request.pipe(proxy)
      return
    }
    denied.push({ method: request.method, path: url.pathname })
    json({ error: 'isolated_endpoint_not_available' }, 404)
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return { origin: `http://127.0.0.1:${server.address().port}`, token,
    snapshot: () => ({ requests: structuredClone(requests), denied: structuredClone(denied), syntheticIdentity: true,
      externalRequests: 0, modelsExecuted: 0, toolsExecuted: 0 }),
    async close() {
      for (const proxy of activeProxies) proxy.destroy()
      const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      server.closeAllConnections()
      await closed
    } }
}

/** A fresh profile references the immutable installed artifact, never the mutable
 * workspace or the user's credential/config records. */
export async function prepareInstalledChatProfile({ appData, installedRoot, apiBase, baseConfigPath, resourceAppData, token = createIsolatedChatToken() }) {
  appData = path.resolve(appData)
  assert.ok(path.isAbsolute(baseConfigPath) && path.isAbsolute(installedRoot))
  assert.match(appData.replaceAll('\\', '/'), /\/aily-project\/dev-tests\/.+\/appdata$/i)
  localUrl(apiBase)
  const config = JSON.parse(await fs.readFile(baseConfigPath, 'utf8'))
  config.metricsEnabled = false
  config.recentlyProjects = []
  config.regions = Object.fromEntries(Object.entries(config.regions || {}).map(([key, value]) => [key, {
    ...value, api_server: apiBase, resource: apiBase, web: apiBase, tool_web: apiBase,
    ucenter_web: apiBase, updater: '', npm_registry: apiBase, npm_registry_linux: apiBase, npm_registry_coder: apiBase
  }]))
  // Official cn URLs are deliberately normalized by the real host. Use its
  // supported non-official region instead of fighting that production policy.
  config.region = 'isolated-acceptance'
  config.regions[config.region] = { ...config.regions.cn, name: 'Isolated acceptance', official: false, enabled: true,
    api_server: apiBase, resource: apiBase, web: apiBase, tool_web: apiBase, ucenter_web: apiBase,
    npm_registry: apiBase, npm_registry_linux: apiBase, npm_registry_coder: apiBase }
  config.resource_source = 'localhost'
  config.resource_sources = [{ key: 'localhost', url: apiBase, enabled: true }]
  const catalog = await catalogFor(installedRoot), installRoot = path.join(appData, 'npm-global/app')
  const link = path.join(installRoot, 'node_modules', ...PACKAGE.split('/'))
  await fs.mkdir(path.dirname(link), { recursive: true })
  await fs.symlink(await fs.realpath(installedRoot), link, process.platform === 'win32' ? 'junction' : 'dir')
  await fs.writeFile(path.join(appData, 'config.json'), JSON.stringify(config, null, 2), { flag: 'wx' })
  await fs.writeFile(path.join(appData, '.aily'), JSON.stringify({ access_token: token, token_type: 'bearer',
    updated_at: new Date().toISOString() }), { flag: 'wx', mode: 0o600 })
  await fs.writeFile(path.join(installRoot, 'package.json'), JSON.stringify({ name: 'isolated-installed-chat', private: true,
    dependencies: {} }), { flag: 'wx' })
  await fs.writeFile(path.join(installRoot, 'subapp-index.json'), JSON.stringify(catalog, null, 2), { flag: 'wx' })
  const sourceAppData = path.dirname(baseConfigPath)
  const installedAppData = path.resolve(installedRoot, '../../../../../..')
  if (resourceAppData) assert.ok(path.isAbsolute(resourceAppData))
  const resourceRoots = [...new Set([resourceAppData, sourceAppData,
    ...(path.basename(installedAppData).toLowerCase() === 'aily-project' ? [installedAppData] : [])].filter(Boolean))]
  const resources = []
  for (const relative of ['sdk', 'tools', 'npm-global/node_modules', ...(resourceAppData ? ['compiler', 'node_modules'] : [])]) {
    let source
    for (const base of resourceRoots) {
      const candidate = path.join(base, relative)
      try { if ((await fs.stat(candidate)).isDirectory()) { source = await fs.realpath(candidate); break } }
      catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    assert.ok(source, `Existing compilation resource is required: ${relative}`)
    const destination = path.join(appData, relative)
    await fs.mkdir(path.dirname(destination), { recursive: true })
    await fs.symlink(source, destination, process.platform === 'win32' ? 'junction' : 'dir')
    resources.push(relative)
  }
  const shimNames = /^(?:aily-builder|aily-linter|aily-connector)(?:\.cmd|\.ps1)?$/
  const shims = new Set()
  for (const base of resourceRoots) {
    const prefix = path.join(base, 'npm-global')
    let entries
    try { entries = await fs.readdir(prefix, { withFileTypes: true }) }
    catch (error) { if (error.code === 'ENOENT') continue; throw error }
    for (const item of entries) {
      if (!item.isFile() || !shimNames.test(item.name) || shims.has(item.name)) continue
      await fs.copyFile(path.join(prefix, item.name), path.join(appData, 'npm-global', item.name), fs.constants.COPYFILE_EXCL)
      shims.add(item.name)
    }
  }
  const metadata = []
  for (const name of ['boards.json', 'boards-linux.json', 'libraries.json', 'tags.json', '.npmrc']) {
    try {
      await fs.copyFile(path.join(sourceAppData, name), path.join(appData, name), fs.constants.COPYFILE_EXCL)
      metadata.push(name)
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  return { appData, installRoot, link, config, preparation: { syntheticIdentity: true, resources, shims: [...shims], metadata },
    env: { AILY_APPDATA_PATH: appData,
    AILY_NPM_PREFIX: path.join(appData, 'npm-global'), AILY_API_SERVER: apiBase,
    AILY_MAIN_APPDATA_PATH: appData, AILY_AUTH_FILE: path.join(appData, '.aily') } }
}

/** Verify the real embedded UI and backend. Returned token-bearing URL and e2e
 * closure stay in memory; only the token-free evidence may be persisted. */
export async function assertInstalledChatLoaded(page, { installedRoot, output, expectedApiBase, expectedInputHash = INPUT, expectedOutputHash = OUTPUT }) {
  const receipt = JSON.parse(await fs.readFile(path.join(installedRoot, 'runtime/build-evidence.json'), 'utf8'))
  assert.equal(receipt.inputHash, expectedInputHash)
  assert.equal(receipt.outputHash, expectedOutputHash)
  let authentication
  const deadline = Date.now() + 60000
  do {
    authentication = await page.evaluate(async () => {
      const result = await window.iWindow.send({ to: 'main', data: { action: 'get-auth-state' }, timeout: 2000 })
      return { authenticated: result.authenticated === true, initializationState: result.initializationState }
    })
    if (authentication.authenticated || authentication.initializationState === 'signed_out') break
    await new Promise(resolve => setTimeout(resolve, 100))
  } while (Date.now() < deadline)
  assert.equal(authentication.authenticated, true, 'The isolated dummy identity must initialize through the real Host bridge')
  const runtimeApiBase = await page.evaluate(() => window.env.get('AILY_API_SERVER'))
  localUrl(runtimeApiBase)
  if (expectedApiBase) assert.equal(runtimeApiBase, expectedApiBase)
  const iframe = page.locator('app-main-window nz-sider app-child-tool-host iframe')
  if (!await iframe.isVisible()) await page.locator('app-main-window app-header .toolbox .btn:has(i.fa-star-christmas)').click()
  await iframe.waitFor({ state: 'visible', timeout: 60000 })
  const frame = await (await iframe.elementHandle()).contentFrame()
  assert.ok(frame)
  await frame.locator('.aily-chat-composer-input[role="textbox"]').waitFor({ state: 'visible', timeout: 60000 })
  const url = new URL(frame.url())
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
  const healthResponse = await fetch(new URL('/health', url), { signal: AbortSignal.timeout(15000) })
  assert.equal(healthResponse.status, 200)
  const health = await healthResponse.json()
  assert.equal(health.buildEvidence?.inputHash, expectedInputHash)
  assert.equal(health.buildEvidence?.outputHash, expectedOutputHash)
  const e2e = createInstalledChatObserver(url)
  const sessions = await e2e('session.list')
  const html = await fs.readFile(path.join(installedRoot, 'ui/index.html'), 'utf8')
  const entry = /<script type="module"[^>]+src="\.\/([^"]+)"/.exec(html)?.[1]
  const buildTime = /name="aily-build-time" content="([^"]+)"/.exec(html)?.[1]
  assert.ok(entry && buildTime)
  const loaded = await frame.evaluate(async () => {
    const script = document.querySelector('script[type="module"][src]')
    const response = await fetch(script.src, { cache: 'no-store' })
    if (!response.ok) throw new Error('Installed UI script was not served')
    return { file: new URL(script.src).pathname, bytes: Array.from(new Uint8Array(await response.arrayBuffer())),
      buildTime: document.querySelector('meta[name="aily-build-time"]')?.content }
  })
  assert.ok(loaded.file.endsWith('/' + entry))
  assert.equal(loaded.buildTime, buildTime)
  const moduleHash = sha(Buffer.from(loaded.bytes))
  assert.equal(moduleHash, sha(await fs.readFile(path.join(installedRoot, 'ui', entry))))
  const evidence = { ok: true, embedded: true, installedRoot, authentication, endpointOrigin: url.origin,
    buildEvidence: health.buildEvidence, runtimeApiBase, loadedUi: { entry, buildTime, moduleHash }, sessionCount: sessions.sessions.length,
    realModelInvoked: false, syntheticIdentity: true }
  if (output) {
    await fs.mkdir(output, { recursive: true })
    await fs.writeFile(path.join(output, 'installed-chat-ui.json'), JSON.stringify(evidence, null, 2))
    await page.screenshot({ path: path.join(output, 'installed-chat-ui.png'), fullPage: true })
  }
  return { frame, url, evidence, e2e }
}
