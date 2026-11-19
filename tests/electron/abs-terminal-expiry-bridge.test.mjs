import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createAbsTerminalExpiryBridge } from '../../e2e/fixtures/abs-terminal-expiry-bridge.mjs'
import { createRecoveredAgentHarness } from '../../e2e/fixtures/abs-agent-tools.mjs'
import { createAbsProviderSession } from '../../e2e/fixtures/abs-provider-session.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
const repo = fileURLToPath(new URL('../../', import.meta.url))
const textOf = message => (message?.content ?? []).filter(item => item.type === 'text').map(item => item.text).join('\n')
const parseFrames = text => text.split('\n\n').filter(Boolean).map(line => JSON.parse(line.slice('data: '.length)))

for (const mode of ['available', 'missing', 'incomplete']) {
  test(`terminal-expiry bridge ${mode}: completed operation loses only turn_end, first event reconnect is expired`, async () => {
    const interactionId = 'itx_protocol_' + randomUUID().replaceAll('-', '')
    const bridge = await createAbsTerminalExpiryBridge({ interactionId, mode, nextTool: async ({ step }) => step === 0
      ? { id: 'real-tool-result-placeholder', name: 'read', arguments: { path: 'fixture.txt' } } : undefined })
    const base = `${bridge.origin}/api/v3/interactions/${interactionId}`
    try {
      const created = await fetch(`${bridge.origin}/api/v3/interactions`, { method: 'POST',
        body: JSON.stringify({ request: { request_context: { interaction_recovery: 'operation_stream_v1' } } }) })
      assert.equal(created.headers.get('x-aily-operation-id'), `${interactionId}:0`)
      assert.equal(parseFrames(await created.text()).at(-1).type, 'turn_end')
      const raw = JSON.stringify({ stepIndex: 1, lease: 'isolated-terminal-lease-1', action: { kind: 'tool_results',
        payload: { results: [{ toolCallId: 'real-tool-result-placeholder', isError: false, result: { content: [] } }] } } })
      const response = await fetch(`${base}/steps`, { method: 'POST', headers: {
        'X-Aily-Step-Submission-Id': randomUUID(), 'X-Aily-Step-Submission-Version': '1', 'X-Aily-Step-Request-Sha256': sha(raw)
      }, body: raw })
      assert.equal(response.headers.get('x-aily-operation-id'), `${interactionId}:1`)
      const partial = parseFrames(await response.text())
      assert.deepEqual(partial.map(frame => frame.type), ['turn_begin', 'markdown_delta', 'usage'])
      assert.equal(partial[1].text, bridge.prefix)
      const events = await fetch(`${base}/operations/1/events?after=3`)
      assert.equal(events.status, 410)
      assert.deepEqual(await events.json(), { error: 'interaction_operation_expired' })
      const state = await (await fetch(`${base}/operations/1/state`)).json()
      assert.equal(state.status, 'completed')
      assert.equal(state.lastSequence, null)
      assert.equal(state.streamState, 'expired')
      assert.equal(state.recovery.responseComplete, false)
      if (mode === 'missing') assert.equal(Object.hasOwn(state, 'executionTerminal'), false)
      else {
        const terminal = state.executionTerminal
        assert.equal(terminal.operationId, `${interactionId}:1`)
        assert.equal(terminal.operationStepIndex, 1)
        assert.equal(terminal.nextStepIndex, 2)
        assert.equal(terminal.outputState, mode === 'available' ? 'available' : 'incomplete')
        if (mode === 'available') {
          const result = await (await fetch(`${base}/operations/1/result`)).json()
          assert.equal(result.text, bridge.finalText)
          assert.equal(result.hash, 'sha256:' + sha(result.text))
          assert.equal(result.bytes, Buffer.byteLength(result.text))
          assert.equal(result.hash, terminal.outputHash)
          assert.equal(result.responseGeneration, terminal.responseGeneration)
        } else assert.equal(terminal.responseGeneration, null)
      }
      const snapshot = bridge.snapshot()
      assert.deepEqual(snapshot.failures, [])
      assert.equal(snapshot.createCount, 1)
      assert.equal(snapshot.interruptCount, 0)
      assert.equal(snapshot.operations[1].providerInvocations, 1)
      assert.equal(snapshot.operations[1].postCount, 1)
      assert.equal(snapshot.operations[1].resultReads, mode === 'available' ? 1 : 0)
    } finally { await bridge.close() }
  })
}

// These cases use the actual built Agent/RetrySession, not a hand-written
// parser or direct tool-call script. They are intentionally opt-in until root
// has produced and verified the new private Agent (never use daily Chat).
const agentRoot = process.env.AILY_TERMINAL_AGENT
const sdkOutput = process.env.AILY_TERMINAL_SDK_OUTPUT
const scenarios = [
  { name: 'available', mode: 'available', succeeds: true },
  { name: 'missing', mode: 'missing' },
  { name: 'incomplete', mode: 'incomplete' },
  { name: 'wrong-operation', mode: 'available', resultFault: 'operation' },
  { name: 'wrong-hash', mode: 'available', resultFault: 'hash' },
  { name: 'wrong-generation', mode: 'available', resultFault: 'generation' },
  { name: 'pending-tool', mode: 'available', unacknowledgedTool: true }
]
for (const scenario of scenarios) {
  test(`real SDK terminal-expiry ${scenario.name}: actual edit is never replayed`, {
    skip: !agentRoot || !sdkOutput, timeout: 60000
  }, async () => {
    assert.ok(path.isAbsolute(agentRoot), 'Use an explicit root-verified private built Agent')
    const output = path.resolve(sdkOutput), relative = path.relative(path.join(repo, 'tests/test-results'), output)
    assert.ok(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))
    await fs.mkdir(output, { recursive: true })
    const root = await fs.mkdtemp(path.join(output, scenario.name + '-')), project = path.join(root, 'project')
    const profileRoot = path.join(root, 'profile'), home = path.join(root, 'home')
    await fs.mkdir(project); await fs.mkdir(home)
    // Bootstrap only a throwaway non-program file. Candidate writes and edits
    // below are exclusively the real SDK tools and their permission/history hooks.
    await fs.writeFile(path.join(project, 'package.json'), JSON.stringify({ name: 'isolated-terminal-fixture', type: 'arduino' }))
    const file = path.join(project, 'note.txt')
    await fs.writeFile(file, 'bootstrap\n')
    Object.assign(process.env, { PI_CODING_AGENT_DIR: profileRoot, PI_OFFLINE: '1', HOME: home, USERPROFILE: home,
      AILY_APPDATA_PATH: path.join(root, 'appdata') })
    const tools = [], plan = [
      { id: 'read-initial', name: 'read', arguments: { path: file } },
      { id: 'write-once', name: 'write', arguments: { path: file, content: 'terminal-before\n' } },
      { id: 'edit-once', name: 'edit', arguments: { path: file, edits: [{ oldText: 'terminal-before', newText: 'terminal-after' }] } },
      { id: 'read-edited', name: 'read', arguments: { path: file } }
    ]
    const bridge = await createAbsTerminalExpiryBridge({ interactionId: 'itx_sdk_terminal_' + randomUUID().replaceAll('-', ''),
      mode: scenario.mode, resultFault: scenario.resultFault, ...(scenario.unacknowledgedTool ? {
        unsettledTool: { id: 'must-never-execute', name: 'edit', arguments: { path: file,
          edits: [{ oldText: 'terminal-after', newText: 'forbidden-replay' }] } }
      } : {}), nextTool: async ({ step }) => plan[step] })
    const evidence = { ok: false, scenario: scenario.name, llmInvoked: false, realSdkLoop: true }
    let harness
    try {
      harness = await createRecoveredAgentHarness({ agentRoot, sourceProject: project, globalRoot: root, profileRoot,
        createStreaming: context => createAbsProviderSession(context, { apiBase: bridge.origin,
          onToolResult: event => { assert.equal(event.isError, false); tools.push({ name: event.toolName, id: event.toolCallId }) } }),
        permissionApproval: request => ['read', 'write', 'edit'].includes(request.toolName) && request.input?.path === file })
      let promptError
      try { await harness.prompt('Read note.txt, write terminal-before, edit it to terminal-after exactly once, read it back, then finish. Do not access other paths.') }
      catch (error) { promptError = { name: error.name, message: error.message, code: error.code } }
      const assistant = harness.messages().filter(message => message.role === 'assistant').at(-1)
      evidence.final = { stopReason: assistant?.stopReason, text: textOf(assistant), errorMessage: assistant?.errorMessage,
        responseReplayPolicy: assistant?.responseReplayPolicy, responseOperationTerminal: assistant?.responseOperationTerminal,
        usage: assistant?.usage, promptError }
      assert.deepEqual(tools.map(tool => tool.name), ['read', 'write', 'edit', 'read'])
      assert.equal(await fs.readFile(file, 'utf8'), 'terminal-after\n')
      if (scenario.succeeds) {
        assert.equal(promptError, undefined)
        assert.equal(assistant?.stopReason, 'stop')
        assert.equal(textOf(assistant), bridge.finalText)
        assert.equal(assistant.responseReplayPolicy, 'never')
        assert.deepEqual(assistant.responseOperationTerminal, { status: 'completed' })
      } else {
        assert.ok(promptError || assistant?.stopReason === 'error')
        assert.notEqual(assistant?.stopReason, 'stop')
        assert.ok(!textOf(assistant).includes('Final response recovered'))
        assert.equal(assistant?.responseReplayPolicy, 'never')
        if (scenario.mode === 'missing') assert.equal(assistant?.responseOperationTerminal, undefined)
        else assert.deepEqual(assistant?.responseOperationTerminal, { status: 'completed' })
        if (scenario.mode === 'incomplete') assert.match(assistant.errorMessage, /interaction_response_incomplete/)
      }
      assert.equal(assistant?.usage?.input, 1)
      assert.equal(assistant?.usage?.output, 1)
      const snapshot = bridge.snapshot(), expired = snapshot.operations.find(operation => operation.turnEndLost)
      assert.deepEqual(snapshot.failures, [])
      assert.equal(snapshot.createCount, 1)
      assert.equal(snapshot.interruptCount, scenario.mode === 'missing' ? 1 : 0)
      assert.equal(expired.toolCallId, undefined)
      assert.ok(expired.stateReads >= 1 && expired.eventReads >= 1)
      assert.equal(expired.resultReads, scenario.mode === 'available' && !scenario.unacknowledgedTool ? 1 : 0)
      for (const operation of snapshot.operations) {
        assert.equal(operation.providerInvocations, 1)
        assert.equal(operation.postCount, 1)
      }
      assert.equal(snapshot.requests.some(request => /resume|restart/.test(request.path)), false)
      evidence.transport = snapshot
      evidence.proof = harness.proof()
      assert.equal(evidence.proof.sessionUserMessages, 1)
      assert.equal(evidence.proof.promptRuns, 1)
      evidence.ok = true
    } catch (error) {
      evidence.failure = { message: error.message, stack: error.stack }
      evidence.transport = bridge.snapshot()
      throw error
    } finally {
      await harness?.dispose()
      await bridge.close()
      await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(evidence, null, 2))
    }
  })
}
