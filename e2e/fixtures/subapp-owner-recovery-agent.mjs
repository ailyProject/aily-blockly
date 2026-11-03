import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRecoveredAgentHarness } from './abs-agent-tools.mjs'

const toolId = 'owner-echo-fixture', packageName = '@aily-project/subapp-owner-echo-fixture'
const inside = (root, child) => { const value = path.relative(root, child); return value &&
  value !== '..' && !value.startsWith('..' + path.sep) && !path.isAbsolute(value) }
const writeJson = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2))
const readJson = file => fs.readFile(file, 'utf8').then(JSON.parse)

/** Install only into an explicitly private acceptance appdata before launching
 * its own Host. The caller owns that Host/catalog, never daily installation. */
export async function installOwnerEchoFixture({ testRoot, appData, hostRoot }) {
  testRoot = await fs.realpath(testRoot)
  assert.match(testRoot.replaceAll('\\', '/'), /\/aily-project\/dev-tests\//i)
  assert.ok(inside(testRoot, appData), 'The catalog must belong to this private test root')
  const appRoot = path.join(appData, 'npm-global/app')
  const packageRoot = path.join(appRoot, 'node_modules', ...packageName.split('/'))
  const indexFile = path.join(appRoot, 'subapp-index.json')
  const index = await readJson(indexFile).catch(error => { if (error.code === 'ENOENT') return { dev: true }; throw error })
  assert.equal(index[toolId], undefined, 'Use a fresh fixture installation, never overwrite an existing package')
  await fs.mkdir(path.dirname(packageRoot), { recursive: true })
  await fs.mkdir(packageRoot)
  await fs.mkdir(path.join(packageRoot, 'agent'))
  assert.ok(inside(testRoot, await fs.realpath(packageRoot)), 'Never follow a package link into a daily install')
  const manifest = { name: packageName, version: '0.0.0', main: 'index.cjs', aily: { uiIndex: 'ui/index.html' }, ailySubapp: {
    app: { extension: true, autoInstall: false }, agent: { tools: { manifest: 'agent/tools.json' } } } }
  const tools = { protocolVersion: 1, transport: 'aily-child-rpc', lifecycle: {
    ownerRelease: { method: 'fixture.ownerRelease', timeoutMs: 5000 }
  }, tools: [{ name: 'owner_fixture_echo', description: 'Private stateless owner acceptance echo; no devices.',
    permission: 'read', requiresSession: true, rpc: { method: 'fixture.echo' },
    inputSchema: { type: 'object', properties: { text: { type: 'string', maxLength: 100 } },
      required: ['text'], additionalProperties: false } }] }
  await writeJson(path.join(packageRoot, 'package.json'), manifest)
  await writeJson(path.join(packageRoot, 'agent/tools.json'), tools)
  // Non-native WS packages must have a package-root UI entry even when this
  // extension never presents one. Do not mark it native/headless to bypass the
  // real Host adapter whitelist, or weaken installed-package discovery.
  await fs.mkdir(path.join(packageRoot, 'ui'))
  await fs.writeFile(path.join(packageRoot, 'ui/index.html'), '<!doctype html><title>Private owner echo fixture</title>')
  await fs.copyFile(new URL('./subapp-owner-echo.cjs', import.meta.url), path.join(packageRoot, 'index.cjs'))
  await fs.mkdir(path.join(packageRoot, 'node_modules'))
  await fs.symlink(await fs.realpath(path.join(hostRoot, 'node_modules/ws')),
    path.join(packageRoot, 'node_modules/ws'), process.platform === 'win32' ? 'junction' : 'dir')
  index[toolId] = { id: toolId, namespace: 'OWNER_ECHO_FIXTURE', titleKey: toolId,
    package: packageName, version: manifest.version, app: manifest.ailySubapp.app }
  await writeJson(indexFile, index)
  const rootFile = path.join(appRoot, 'package.json')
  const rootPackage = await readJson(rootFile).catch(error => { if (error.code === 'ENOENT') return { private: true }; throw error })
  rootPackage.dependencies = { ...rootPackage.dependencies, [packageName]: manifest.version }
  await writeJson(rootFile, rootPackage)
  return { toolId, packageName, packageRoot, index, traceFile: path.join(packageRoot, 'calls.jsonl') }
}

/** Actual SDK permission/hooks and production tools against the caller's
 * isolated real Host. Only the fault injection is an exact old lease release.
 * No business call is replayed; no project-file writes are performed here. */
export async function verifyOwnerRecoveryWithAgent({ agentRoot, sourceProject, globalRoot, profileRoot, fixture, hostPid }) {
  const mod = relative => import(pathToFileURL(path.join(agentRoot, 'dist', relative + '.js')).href)
  const { SubappAgentSession } = await mod('blockly/subapp-agent-session')
  const { appCommand } = await mod('blockly/services/app/command')
  const { registerInstalledSubappAgentTools } = await mod('blockly/tools/registrars/subapp-agent/index')
  const { discoverInstalledSubappAgentCatalog } = await mod('blockly/subapp-agent-manifest')
  const appRoot = path.resolve(fixture.packageRoot, '../../..'), calls = []
  const scope = new SubappAgentSession(async (operation, params, options) => {
    const result = await appCommand('blockly-live-operation', undefined, { operation, params },
      { ...options, targetPid: hostPid })
    calls.push({ operation, params, result })
    return result
  })
  const catalog = discoverInstalledSubappAgentCatalog({ installRoot: appRoot, developmentMode: 'blockly' })
  assert.ok(catalog.tools.some(tool => tool.name === 'owner_fixture_echo'), 'The real package manifest must be discoverable')
  let harness
  try {
    harness = await createRecoveredAgentHarness({ agentRoot, sourceProject, globalRoot, profileRoot,
      persistToolTranscript: true,
      configureRegistry(context) { registerInstalledSubappAgentTools({ ...context, subappSession: scope }, 'blockly', catalog) },
      permissionApproval: request => ['owner_fixture_echo', 'child_app_recover'].includes(request.toolName) })
    const first = await harness.call('owner_fixture_echo', { text: 'first' })
    assert.equal(first.structured.result.text, 'first')
    const acquired = calls.find(call => call.params.action === 'acquire')
    assert.ok(acquired?.result.ok)
    const old = { sessionId: acquired.params.sessionId, ownerLeaseId: acquired.result.ownerLeaseId }
    const released = await appCommand('blockly-live-operation', undefined,
      { operation: 'subapp_agent_owner', params: { action: 'release', ...old } },
      { targetPid: hostPid, timeoutMs: 65000 })
    assert.equal(released.ok, true, 'The exact fixture owner must finish cleanup before recovery')
    const fenced = await harness.call('owner_fixture_echo', { text: 'must-not-replay' }, { expectError: true })
    assert.equal(fenced.structured.errorCode, 'SUBAPP_OWNER_EXPIRED')
    const observed = await harness.call('child_app_recover', { action: 'owner_inspect' })
    assert.equal(observed.structured.state, 'retired')
    assert.equal(observed.structured.cleanup, 'confirmed')
    assert.equal(observed.structured.pendingRequests, 0)
    const recovered = await harness.call('child_app_recover', { action: 'owner_recover' })
    assert.equal(recovered.structured.ok, true)
    assert.equal(recovered.structured.notResumed, true)
    assert.equal(recovered.structured.deviceResourcesRestored, false)
    const next = await harness.call('owner_fixture_echo', { text: 'fresh' })
    assert.equal(next.structured.result.text, 'fresh')
    const recoveredControl = calls.find(call => call.params.action === 'recover')
    assert.notEqual(recoveredControl.result.ownerLeaseId, old.ownerLeaseId)
    const events = (await fs.readFile(fixture.traceFile, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.equal(events.filter(event => event.method === 'fixture.echo').length, 2, 'Only first and future fresh echoes reach Runtime')
    assert.equal(events.filter(event => event.method === 'fixture.ownerRelease').length, 1)
    assert.equal(calls.filter(call => call.params.action === 'acquire').length, 1)
    assert.equal(calls.filter(call => call.params.action === 'recover').length, 1)
    const proof = harness.proof()
    assert.equal(proof.actualSdkSession, true)
    assert.equal(proof.actualPiToolCallHooks, true)
    assert.equal(proof.actualPermissionSystem, true)
    assert.equal(proof.permissionMode, 'default')
    return { ok: true, actualHost: true, actualSdkTools: true, domainEchoCount: 2, failedDomainNotReplayed: true,
      explicitRecoveryCount: 1, originalAcquireCount: 1, oldCleanupConfirmed: true,
      userProjectsModified: false, hardwareUsed: false, simulatorUsed: false, proof }
  } finally { try { await scope.close() } finally { await harness?.dispose() } }
}
