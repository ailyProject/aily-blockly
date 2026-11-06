import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createRecoveredAgentHarness } from '../../fixtures/abs-agent-tools.mjs'

/** Drop the actual IPC reply after a real application; never fabricate an outcome. */
export async function runIssue787ApplyReconnect({ app, project, suite, appData, home, hostPid, agentRoot, phase }) {
  const absPath = path.join(project, 'project.abs'), profileRoot = path.join(suite, 'agent-profile')
  Object.assign(process.env, { AILY_LIBRARY_HOST_PID: String(hostPid), AILY_APPDATA_PATH: appData,
    PI_CODING_AGENT_DIR: profileRoot, HOME: home, USERPROFILE: home, PI_OFFLINE: '1' })
  const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
  const harness = await createRecoveredAgentHarness({ agentRoot, sourceProject: project, globalRoot: suite, profileRoot,
    persistToolTranscript: true,
    permissionApproval(request) {
      if (['read', 'write', 'edit'].includes(request.toolName)) return typeof request.input?.path === 'string' && same(request.input.path, absPath)
      return same(request.input?.project ?? '', project)
        && ['project_recover', 'project_save', 'abs_export', 'abs_validate', 'abs_apply'].includes(request.toolName)
    } })
  try {
    await phase('actual-sdk-export-edit-and-lost-apply-reply')
    const exported = (await harness.call('abs_export', { project })).structured
    assert.equal(exported.ok, true, JSON.stringify(exported))
    const source = await fs.readFile(absPath, 'utf8')
    const lines = source.split(/\r?\n/).filter(line => !line.trim().startsWith('#') && /\b2787\b/.test(line))
    assert.equal(lines.length, 1, 'A unique, visible saved value identifies the intended candidate edit')
    await harness.call('edit', { path: absPath, oldText: lines[0], newText: lines[0].replace(/\b2787\b/, '3787') })
    await app.evaluate(({ ipcMain, BrowserWindow }) => {
      const state = global.__issue787ApplyFault = { starts: [], observations: [], dropped: 0 }
      for (const win of BrowserWindow.getAllWindows()) {
        const send = win.webContents.send.bind(win.webContents)
        win.webContents.send = (channel, payload, ...rest) => {
          if (channel === 'cli-bridge:blockly-live-operation') {
            if (payload.operation === 'abs_apply') {
              state.starts.push({ requestId: payload.params?.requestId })
              state.dropTransportId ??= payload.requestId
            }
            if (payload.operation === 'abs_recovery' && payload.params?.action === 'observe_apply')
              state.observations.push({ requestId: payload.params.requestId })
          }
          return send(channel, payload, ...rest)
        }
      }
      const emit = ipcMain.emit
      ipcMain.emit = function (channel, ...args) {
        if (channel === 'cli-bridge:blockly-live-operation:response'
          && args[1]?.requestId === state.dropTransportId && state.dropped === 0) {
          state.dropped++; return true
        }
        return emit.call(this, channel, ...args)
      }
    })
    const applied = (await harness.call('abs_apply', { project, generation: exported.generation, absPath })).structured
    assert.equal(applied.ok, true, JSON.stringify(applied))
    assert.equal(applied.publication?.status, 'COMMITTED')
    assert.equal(applied.applyVerification?.ok, true)
    const audit = await app.evaluate(() => global.__issue787ApplyFault)
    assert.equal(audit.dropped, 1)
    assert.equal(audit.starts.length, 1, 'A lost reply cannot replay the application')
    assert.ok(audit.observations.length >= 1, 'The actual SDK must query the original durable request')
    const requestId = audit.starts[0].requestId
    assert.ok(audit.observations.every(item => item.requestId === requestId))
    const observed = (await harness.call('project_recover', { project, action: 'observe_apply', requestId })).structured
    assert.equal(observed.ok, true, JSON.stringify(observed))
    assert.equal(observed.receipt.requestId, requestId)
    assert.equal(observed.publication.generation, applied.publication.generation)
    assert.equal((await app.evaluate(() => global.__issue787ApplyFault)).starts.length, 1)
    await harness.settle()
    return { ok: true, requestId, generation: applied.publication.generation, applicationStarts: 1,
      droppedReplies: 1, originalRequestObserved: true, observations: audit.observations.length,
      actualSdkTools: true, fabricatedToolResults: false, llmInvoked: false }
  } finally { await harness.dispose() }
}
