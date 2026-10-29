import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { createRecoveredAgentHarness } from '../fixtures/abs-agent-tools.mjs'
import { createAbsProviderSession } from '../fixtures/abs-provider-session.mjs'
import { createAbsStepSubmissionBridge } from '../fixtures/abs-step-submission-bridge.mjs'

test('real SDK/Aily provider retains one actual core edit after accepted POST loses its headers', { timeout: 60000 }, async () => {
  const agentRoot = process.env.AILY_ABS_AGENT_ROOT, output = process.env.AILY_ABS_STREAM_TEST_ROOT
  assert.ok(agentRoot && path.isAbsolute(agentRoot), 'Use the current private built Agent, not daily Chat')
  const allowed = path.resolve('e2e/test-results'), relative = path.relative(allowed, path.resolve(output ?? ''))
  assert.ok(output && relative && !relative.startsWith('..') && !path.isAbsolute(relative))
  await fs.mkdir(output, { recursive: true })
  const root = await fs.mkdtemp(path.join(output, 'sdk-')), project = path.join(root, 'project'), profile = path.join(root, 'profile')
  await fs.mkdir(project)
  const home = path.join(root, 'home')
  await fs.mkdir(home)
  // Only bootstrap a throwaway non-program fixture. The exercised mutation is
  // exclusively the SDK's actual core edit; no script restores its result.
  await fs.writeFile(path.join(project, 'package.json'), JSON.stringify({ name: 'isolated-step-fixture', type: 'arduino' }))
  const file = path.join(project, 'note.txt')
  await fs.writeFile(file, 'fixture-before\n')
  Object.assign(process.env, { PI_CODING_AGENT_DIR: profile, PI_OFFLINE: '1', HOME: home, USERPROFILE: home,
    AILY_APPDATA_PATH: path.join(root, 'appdata') })
  const results = [], plan = [
    { id: 'read-initial', name: 'read', arguments: { path: file } },
    { id: 'edit-exactly-once', name: 'edit', arguments: { path: file, edits: [{ oldText: 'fixture-before', newText: 'fixture-after' }] } },
    { id: 'read-recovered', name: 'read', arguments: { path: file } }
  ]
  const bridge = await createAbsStepSubmissionBridge({ interactionId: 'itx-isolated-sdk-step',
    failAfterToolId: 'edit-exactly-once', nextTool: async ({ step }) => plan[step] })
  let harness
  try {
    harness = await createRecoveredAgentHarness({ agentRoot, sourceProject: project, globalRoot: root, profileRoot: profile,
      createStreaming: context => createAbsProviderSession(context, { apiBase: bridge.origin,
        onToolResult: event => { assert.equal(event.isError, false); results.push(event) } }),
      permissionApproval: request => ['read', 'edit'].includes(request.toolName) && request.input?.path === file })
    await harness.prompt('Read note.txt, change fixture-before to fixture-after exactly once, then read it back. Do not perform any other action.')
    assert.equal(harness.messages().filter(message => message.role === 'assistant').at(-1).stopReason, 'stop')
    assert.deepEqual(results.map(event => event.toolName), ['read', 'edit', 'read'])
    assert.match(results[2].content[0].text, /fixture-after/)
    assert.equal(await fs.readFile(file, 'utf8'), 'fixture-after\n')
    const transport = bridge.snapshot(), lost = transport.operations.find(value => value.headersLost)
    assert.deepEqual(transport.failures, [])
    assert.equal(transport.createCount, 1)
    assert.equal(lost.step, 2)
    assert.equal(lost.postCount, 1)
    assert.equal(lost.providerInvocations, 1)
    assert.equal(lost.stateReads, 1)
    assert.equal(lost.eventReads, 1)
    assert.equal(results.filter(event => event.toolName === 'edit').length, 1)
    assert.equal(harness.proof().sessionUserMessages, 1)
    await fs.writeFile(path.join(root, 'result.json'), JSON.stringify({ ok: true, transport, proof: harness.proof() }, null, 2))
  } finally { await harness?.dispose(); await bridge.close() }
})
