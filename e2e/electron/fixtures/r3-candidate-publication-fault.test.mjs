import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { createHash } from 'node:crypto'
import { installR3CandidatePublicationFault } from './r3-candidate-publication-fault.mjs'

test('transport preflight drops one exact real handler response, holds its readonly status, then delegates cold status unchanged', async () => {
  assert.equal(process.platform, 'win32')
  const testRoot = path.join(os.homedir(), 'AppData/Local/aily-project/dev-tests/baseline-r3-20261108')
  await fs.mkdir(testRoot, { recursive: true })
  const suite = await fs.mkdtemp(path.join(testRoot, 'fault-preflight-')), project = path.join(suite, 'project')
  await fs.mkdir(path.join(project, '.aily/abs-sync'), { recursive: true })
  const sha = value => 'sha256:' + createHash('sha256').update(value).digest('hex')
  const document = { schemaVersion: 3, activePageId: 'main', pages: [], sharedModel: { procedureBlocks: [] } }
  const inputs = { 'project.abi': JSON.stringify(document), 'project.abs': 'exact controlled fixture source',
    'project.abs.map.json': JSON.stringify({ generation: 'g1' }) }
  for (const [file, body] of Object.entries(inputs)) await fs.writeFile(path.join(project, file), body)
  await fs.writeFile(path.join(project, '.aily/abs-sync/committed.json'), JSON.stringify({ generation: 'g1' }))
  const requestId = 'r3-original-application-12345678', ref = { version: 1, id: '11111111-1111-4111-8111-111111111111', revisionHash: 'a'.repeat(64) }
  const binding = { generation: 'g1', scope: { projectKey: project, pageId: 'main' }, abiHash: sha(inputs['project.abi']),
    absHash: sha(inputs['project.abs']), mapHash: sha(inputs['project.abs.map.json']) }
  const terminal = { ok: true, operation: 'abs_apply', project, requiresReload: false,
    publication: { status: 'COMMITTED', generation: 'g1' }, receipt: { version: 2, requestId, workingCandidate: ref,
      output: { binding }, candidate: { hash: sha('A'), bytes: 1 }, validation: { ok: true, scope: 'complete-generation' } } }
  let handlers = 0
  const server = http.createServer(async (request, response) => {
    assert.equal(request.headers['x-fixture-auth'], 'owned-auth')
    const chunks = []; for await (const part of request) chunks.push(part)
    const payload = JSON.parse(Buffer.concat(chunks)), observe = payload.operation === 'abs_recovery'
    handlers++; const value = { ...terminal, ...(observe ? { applicationObservation: { version: 1, requestId, current: true } } : {}) }
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(value))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const previous = process.env.AILY_APPDATA_PATH; process.env.AILY_APPDATA_PATH = suite
  const config = { pid: process.pid, project, appData: suite, port: server.address().port, expectedDocument: document }
  const command = (operation, params, signal) => fetch(`http://127.0.0.1:${config.port}/command`, { method: 'POST', signal,
    headers: { 'content-type': 'application/json', 'x-fixture-auth': 'owned-auth' },
    body: JSON.stringify({ action: 'blockly-live-operation', path: project, operation, params }) })
  try {
    installR3CandidatePublicationFault(null, config)
    await assert.rejects(command('abs_apply', { version: 2, requestId, validation: { workingCandidate: ref } }))
    assert.equal(globalThis.__ailyR3CandidateFault.snapshot().drops, 1)
    const owner = new AbortController(), observing = command('abs_recovery', { version: 2, requestId, action: 'observe_apply' }, owner.signal)
    const deadline = Date.now() + 5000
    while (!globalThis.__ailyR3CandidateFault.snapshot().held && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(globalThis.__ailyR3CandidateFault.snapshot().held, 1)
    owner.abort(); await assert.rejects(observing)
    const first = globalThis.__ailyR3CandidateFault.snapshot(); assert.equal(first.commands.length, 2); assert.deepEqual(first.failures, [])
    globalThis.__ailyR3CandidateFault.restore(); delete globalThis.__ailyR3CandidateFault
    installR3CandidatePublicationFault(null, { ...config, observationOnly: true, requestId, ref })
    const cold = await (await command('abs_recovery', { version: 2, requestId, action: 'observe_apply' })).json()
    assert.deepEqual(cold, { ...terminal, applicationObservation: { version: 1, requestId, current: true } })
    const observed = globalThis.__ailyR3CandidateFault.snapshot(); assert.equal(observed.drops, 0); assert.equal(observed.held, 0)
    assert.equal(observed.terminals.length, 1); assert.deepEqual(observed.failures, []); assert.equal(handlers, 3)
    console.log('CONTROLLED_HTTP_PREFLIGHT ' + suite + '; not a packaged Host receipt oracle')
  } finally {
    globalThis.__ailyR3CandidateFault?.restore(); delete globalThis.__ailyR3CandidateFault
    if (previous === undefined) delete process.env.AILY_APPDATA_PATH; else process.env.AILY_APPDATA_PATH = previous
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
  }
})
