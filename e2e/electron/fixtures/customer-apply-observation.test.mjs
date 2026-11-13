import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import http from 'node:http'
import path from 'node:path'
import test from 'node:test'
import { createCustomerApplyObservationProxy } from './customer-apply-observation.mjs'

// Unit test of the fault injector only. The scripted endpoint is deliberately
// not called a native host; actual SDK/native receipts are verified by E2E.
test('the observation fault forwards exact bytes, drains its upstream and permits only the original observation after release', async () => {
  const project = path.resolve('owned-network-fixture'), requestId = randomUUID()
  const candidateHash = 'sha256:' + createHash('sha256').update('fixture candidate').digest('hex')
  const received = []
  const reply = JSON.stringify({ ok: true, publication: { status: 'COMMITTED' }, receipt: { requestId,
    candidate: { hash: candidateHash } } })
  const upstream = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk)
    received.push(Buffer.concat(chunks).toString())
    response.setHeader('content-type', 'application/json'); response.end(reply)
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const proxy = await createCustomerApplyObservationProxy({ port: upstream.address().port }, project, candidateHash)
  const call = input => fetch(`http://127.0.0.1:${proxy.port}/command`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: input })
  try {
    const apply = JSON.stringify({ token: 'unit-fixture-only', action: 'blockly-live-operation', path: project,
      operation: 'abs_apply', params: { requestId } })
    await assert.rejects(call(apply))
    assert.equal(received[0], apply)
    assert.equal(proxy.proof().realNativeCommitObserved, true)
    const observe = JSON.stringify({ token: 'unit-fixture-only', action: 'blockly-live-operation', path: project,
      operation: 'abs_recovery', params: { action: 'observe_apply', requestId } })
    await assert.rejects(call(observe))
    assert.equal(received[1], observe)
    proxy.releaseObservation()
    assert.equal(await (await call(observe)).text(), reply)
    assert.equal(received[2], observe)
    assert.deepEqual(proxy.proof().failures, [])
    assert.deepEqual(proxy.proof().commands.map(command => command.dropped), [true, true, false])
    assert.equal(proxy.proof().commands.filter(command => command.operation === 'abs_apply').length, 1)
  } finally {
    await proxy.close()
    const done = new Promise(resolve => upstream.close(resolve))
    upstream.closeAllConnections(); await done
  }
})
