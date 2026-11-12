import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { createChatStopGates } from './r3-chat-stop-gates.mjs'
import { readBoardSessionStartup } from './r2-board-session-startup.mjs'

test('Chat Stop waits for each exact externally verified result once in both modes', async () => {
  for (const mode of ['apply-chat', 'recovery-owner']) {
    const gates = createChatStopGates(mode)
    for (const plan of gates.snapshot()) {
      let released = false
      const pending = gates.wait({ ...plan, previousResult: { toolCallId: plan.id } }).then(() => { released = true })
      await Promise.resolve(); assert.equal(released, false)
      gates.release(plan.id); await pending; assert.equal(released, true)
      assert.throws(() => gates.release(plan.id))
      await assert.rejects(gates.wait({ ...plan, previousResult: { toolCallId: plan.id } }))
    }
  }
})

test('foreign results and failed external observation cannot release a Chat Stop tool', async () => {
  const gates = createChatStopGates('recovery-owner')
  await assert.rejects(gates.wait({ turn: 0, step: 2, previousResult: { toolCallId: 'foreign' } }))
  assert.throws(() => gates.release('foreign'))
  const error = Error('Actual native archive assertion failed')
  const pending = gates.wait({ turn: 0, step: 5, previousResult: { tool_call_id: 'validate-A-before-load-failure' } })
  gates.cancel(error); await assert.rejects(pending, value => value === error)
  assert.throws(() => gates.release('validate-A-before-load-failure'))
  assert.equal(gates.snapshot().some(value => value.released), false)
})

test('first Chat Stop registry read requires successful actual UI create plus subscribe ACKs', async () => {
  const project = path.resolve('owned-stop-project')
  const commands = [{ id: 'create', type: 'session.create', cwd: project, at: 1 },
    { id: 'subscribe', type: 'session.subscribe', sessionId: 'original', at: 3 }]
  const responses = [{ id: 'create', ok: true, sessionId: 'original', cwd: project, at: 2 },
    { id: 'subscribe', ok: true, subscribed: true, sessionId: 'original', at: 4 }]
  let reads = 0
  const input = { project, commands, responses, now: () => 5, readRegistry: async () => { reads++; return [{ sessionId: 'original', cwd: project }] } }
  for (const partial of [[], responses.slice(0, 1)]) {
    assert.equal(await readBoardSessionStartup({ ...input, responses: partial }), undefined)
    assert.equal(reads, 0)
  }
  await assert.rejects(readBoardSessionStartup({ ...input, responses: [responses[0], { ...responses[1], ok: false }] }))
  await assert.rejects(readBoardSessionStartup({ ...input, responses: [responses[0], { ...responses[1], sessionId: 'foreign' }] }))
  await assert.rejects(readBoardSessionStartup({ ...input, responses: [responses[0], { ...responses[1], at: 1 }] }))
  assert.equal(reads, 0)
  const startup = await readBoardSessionStartup(input)
  assert.equal(startup.ready.sessionId, 'original'); assert.equal(reads, 1)
  assert.equal(startup.readStartedAt >= startup.ready.subscriptionResponse.at, true)
})

test('Chat Stop provider has no registry/native observer I/O and cleanup persists actual captured trees', async () => {
  const source = await fs.readFile(new URL('../r3-chat-stop.acceptance.mjs', import.meta.url), 'utf8')
  const provider = source.slice(source.indexOf('nextTool: async'), source.indexOf('router = await createLocalChatApiRouter'))
  assert.match(provider, /await gates\.wait\(input\)/)
  assert.doesNotMatch(provider, /await observe\(|loaded\.e2e\(|page\.evaluate\(|await phase\(/)
  const observe = source.slice(source.indexOf('const observe = async'), source.indexOf('const settle = async'))
  assert.match(observe, /if \(!startup\) return/)
  assert.ok(observe.indexOf('readBoardSessionStartup({') < observe.indexOf("loaded.e2e('session.list')"))
  assert.match(observe, /sessionId = startup\.ready\.sessionId/)
  assert.match(observe, /gates\.release\(message\.toolCallId\)/)
  assert.match(source, /capturedTree: owned/)
  assert.match(source, /cleanup\.remaining = remaining/)
  assert.match(source, /cleanup\.finalCapturedPidRows = finalProcesses\.filter/)
  assert.match(source, /finalOwnedProcesses = current \? remaining\.length : null/)
  assert.match(source, /Date\.now\(\) \+ 120000/)
})
