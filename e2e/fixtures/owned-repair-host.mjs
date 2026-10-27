import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/** Cleanup only the authenticated host created by this suite's exact fork. */
export async function closeOwnedRepairHost(agentRoot, environment) {
  const runtime = await import(pathToFileURL(path.join(agentRoot, 'dist/blockly/runtime-client.js')).href)
  const bridge = (await runtime.discoverBridges(environment.hostPid)).find(bridge => bridge.pid === environment.hostPid)
  if (!bridge) return
  const params = { project: environment.project, environmentId: environment.environmentId,
    requestId: environment.requestId, parentHostPid: environment.parentHostPid,
    ...(environment.version === 2 ? { version: 2, lineageId: environment.lineageId, epoch: environment.epoch } : {}) }
  const identity = await runtime.sendCommand(bridge, 'blockly-live-operation', { operation: 'project_repair_identity', params }, 5000)
  assert.equal(identity.body?.repairEnvironment?.environmentId, environment.environmentId)
  assert.equal(identity.body?.repairEnvironment?.hostCodeIdentity, environment.hostCodeIdentity)
  // Normal close refuses active writers and saves; no process-wide force kill.
  if (bridge.project) {
    assert.equal(path.resolve(bridge.project), path.resolve(environment.project))
    const closed = await runtime.sendCommand(bridge, 'close', { path: environment.project }, 30000)
    assert.equal(closed.body?.ok, true, JSON.stringify(closed.body))
  }
  const stopped = await runtime.sendCommand(bridge, 'blockly-live-operation', { operation: 'project_repair_shutdown', params }, 5000)
  assert.equal(stopped.body?.ok, true, JSON.stringify(stopped.body))
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    try { process.kill(environment.hostPid, 0) }
    catch (error) { if (error.code === 'ESRCH') return; throw error }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('The authenticated suite-owned repair host accepted shutdown but did not exit')
}
