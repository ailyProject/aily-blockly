import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import crypto from 'node:crypto'
import vm from 'node:vm'
import * as nativeFs from 'node:fs'
import { Buffer } from 'node:buffer'
import { assertNativeSaveContinuationPhase, assertNoNativeSaveModelFailures, installNativeSaveObservationFault } from './native-save-observation-fault.mjs'

const hash = value => 'sha256:' + crypto.createHash('sha256').update(value).digest('hex')
async function runFixture(run, unchanged = false, options = {}) {
  const version = options.version ?? 1
  const suite = await fs.mkdtemp(path.join(os.tmpdir(), 'native-save-fault-'))
  const project = path.join(suite, 'aily-project/dev-tests/owned/project'), appData = path.join(suite, 'appdata')
  await fs.mkdir(project, { recursive: true })
  const document = { pages: [{ content: { blocks: { blocks: [{ id: 'original-root', type: 'text', x: 120, y: 300, fields: { TEXT: 'original' } }] } } }], sharedModel: { procedureBlocks: [] } }
  if (options.deepMetadata) {
    let entry = document.sharedModel
    for (let i = 0; i < 140; i++) { entry.extra = { retained: i }; entry = entry.extra }
  }
  const previousDocument = structuredClone(document); previousDocument.pages[0].content.blocks.blocks[0].x = 240
  const abi = Buffer.from(JSON.stringify(document)), abs = Buffer.from('text("original")\n')
  const generation = unchanged ? 'g1' : 'actual-g2'
  const map = Buffer.from(JSON.stringify({ generation, baseAbsHash: hash(abs) }))
  for (const [name, data] of [['project.abi', abi], ['project.abs', abs], ['project.abs.map.json', map]]) await fs.writeFile(path.join(project, name), data)
  const nativeBaseline = Buffer.from(JSON.stringify({ unitNativeGeneration: generation }))
  await fs.mkdir(path.join(project, '.aily/abs-sync/baselines'), { recursive: true })
  await fs.writeFile(path.join(project, '.aily/abs-sync/baselines', generation + '.json'), nativeBaseline)
  await fs.writeFile(path.join(project, '.aily/abs-sync/committed.json'), JSON.stringify({ schemaVersion: 1, generation, hash: hash(nativeBaseline) }))
  const binding = { generation, scope: { projectKey: project, pageId: 'page-1' }, abiHash: hash(abi), absHash: hash(abs), mapHash: hash(map) }
  const token = 'unit-auth-must-never-enter-the-proof', handled = []
  const server = http.createServer(async (request, response) => {
    const chunks = []; for await (const part of request) chunks.push(part)
    const raw = Buffer.concat(chunks), value = JSON.parse(raw.toString())
    assert.equal(value.token, token, 'The real existing handler still receives its original auth/body')
    handled.push({ raw: raw.toString(), value })
    const body = { ok: true, saveReceipt: { version, requestId: value.params.saveRequest.requestId,
      project, operation: 'blocks_tidy', state: 'completed' }, result: { ok: true, generation,
      absPersistence: { verified: true }, finalValidation: { ok: true }, projectSaved: true,
      projectionReceipt: { persisted: true, output: { binding },
        ...(version === 2 ? { version: 2, requestId: value.params.saveRequest.requestId, validation: { scope: 'generation-projection' } } : {}) } } }
    if (version === 2) {
      const directory = await fs.open(project, nativeFs.constants.O_RDONLY | (nativeFs.constants.O_DIRECTORY ?? 0))
      let physical
      try { physical = await directory.stat({ bigint: true }) } finally { await directory.close() }
      body.publicationObservation = { version: 1, durable: true, current: true,
        requestId: value.params.saveRequest.requestId, operation: 'blocks_tidy', attachment: { root: project,
          identity: Object.fromEntries(['dev', 'ino', 'birthtimeNs'].map(key => [key, String(physical[key])])) },
        executor: { hostPid: options.wrongExecutor ? 9999 : options.observationOnly ? 4567 : 1234 }, observer: { hostPid: 1234 } }
    }
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(body))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const handles = { opened: 0, closed: 0, active: new Set() }
  let afterFstat = false
  const observedFs = { ...nativeFs,
    openSync: (...args) => { const fd = nativeFs.openSync(...args); handles.opened++; handles.active.add(fd); return fd },
    closeSync: fd => { try { return nativeFs.closeSync(fd) } finally { handles.closed++; handles.active.delete(fd) } },
    fstatSync: (...args) => { const stat = nativeFs.fstatSync(...args); afterFstat = true; return stat },
    lstatSync: (...args) => {
      const stat = nativeFs.lstatSync(...args)
      if (args[0] !== project || !args[1]?.bigint) return stat
      if (options.failAfterFstat && afterFstat) throw Object.assign(new Error('Exact post-fstat path check failed'), { code: 'EIO' })
      return options.pathDevZero ? Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { dev: 0n }) : stat
    } }
  const context = vm.createContext({ process: { pid: 1234, env: { AILY_APPDATA_PATH: appData },
    _getActiveHandles: () => [server], getBuiltinModule: name => ({ http, fs: observedFs, path, crypto, buffer: { Buffer } })[name] } })
  const config = { pid: 1234, project, appData, port: server.address().port, operation: 'blocks_tidy', previousGeneration: 'g1', previousDocument,
    receiptVersion: version, ...(options.observationOnly ? { observationOnly: true, observedRequestId: 'original-save', originalTargetPid: 4567,
      pauseObservation: options.pauseObservation } : {}) }
  if (options.proofFile) config.proofFile = path.join(path.dirname(project), 'r1-native-fault-0.json')
  // ElectronApplication.evaluate supplies Electron API first, user argument second.
  const carrier = options.configAsText ? JSON.stringify(JSON.stringify(config)) : JSON.stringify(config)
  const installed = vm.runInContext(`(${installNativeSaveObservationFault.toString()})({ electronApi: true }, ${carrier})`, context)
  const send = (operation, requestId = 'original-save', signal = AbortSignal.timeout(3000)) => fetch(`http://127.0.0.1:${server.address().port}/command`, {
    method: 'POST', body: JSON.stringify({ token, action: 'blockly-live-operation', operation, path: project,
      params: { saveRequest: { version, requestId, operation: 'blocks_tidy', waitMs: 1000 } } }), signal })
  try { await run({ context, installed, send, handled, token, handles, proofFile: config.proofFile }) }
  finally {
    context.__ailyNativeSaveObservationFault?.restore()
    const closed = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await closed
    await fs.rm(suite, { recursive: true, force: true })
  }
}

test('actual HTTP loses verified save replies, then exposes only the original observation without changing auth/body', async () => {
  await runFixture(async ({ context, installed, send, handled, token }) => {
    assert.equal(installed.available, true)
    await assert.rejects(send('blocks_tidy')); await assert.rejects(send('project_save_status'))
    const before = context.__ailyNativeSaveObservationFault.snapshot()
    assert.equal(before.drops, 2); assert.equal(before.commands.filter(value => value.operation === 'blocks_tidy').length, 1)
    assert.equal(before.terminals[0].generation, 'actual-g2')
    assert.equal(before.terminals[0].threePhysicalHashesVerified, true)
    assert.equal(before.terminals[0].committedPointerVerified, true)
    assert.equal(before.terminals[0].layout.changedRoots, 1)
    context.__ailyNativeSaveObservationFault.release()
    const response = await send('project_save_status'); assert.equal(response.status, 200)
    const result = await response.json(); assert.equal(result.saveReceipt.requestId, 'original-save')
    const proof = context.__ailyNativeSaveObservationFault.snapshot()
    assert.equal(proof.drops, 2); assert.equal(proof.delegatedResponses, 1); assert.equal(handled.length, 3)
    assert.equal(JSON.stringify(proof).includes(token), false); assert.equal(JSON.stringify(proof).includes('"body"'), false)
  })
})

test('an unchanged generation is delegated and reported, never pretended to be the intended G2 fault', async () => {
  await runFixture(async ({ context, send }) => {
    const response = await send('blocks_tidy'); assert.equal(response.status, 200)
    const proof = context.__ailyNativeSaveObservationFault.snapshot()
    assert.equal(proof.drops, 0); assert.equal(proof.failures[0].code, 'native-save-reply-verification-failed')
    assert.throws(() => context.__ailyNativeSaveObservationFault.release())
  }, true)
})

test('without an exact existing native server this test seam remains unavailable', () => {
  assert.equal(vm.runInNewContext(`(${installNativeSaveObservationFault.toString()})({})`).available, false)
})

test('v2 drops only a physically verified native publication with the original executor', async () => {
  await runFixture(async ({ context, send }) => {
    await assert.rejects(send('blocks_tidy'))
    assert.equal(context.__ailyNativeSaveObservationFault.snapshot().drops, 1)
  }, false, { version: 2 })
  await runFixture(async ({ context, send }) => {
    assert.equal((await send('blocks_tidy')).status, 200)
    const proof = context.__ailyNativeSaveObservationFault.snapshot()
    assert.equal(proof.drops, 0); assert.equal(proof.unverifiedTerminalReplies.length, 1)
  }, false, { version: 2, wrongExecutor: true })
})

test('cold v2 spy delegates an original-executor readonly observation and rejects another save', async () => {
  await runFixture(async ({ context, send }) => {
    assert.equal((await send('project_publication_status')).status, 200)
    let proof = context.__ailyNativeSaveObservationFault.snapshot()
    assert.equal(proof.terminals.length, 1); assert.equal(proof.drops, 0); assert.equal(proof.failures.length, 0)
    await send('blocks_tidy'); proof = context.__ailyNativeSaveObservationFault.snapshot()
    assert.equal(proof.failures[0].code, 'cold-reader-started-another-save')
  }, false, { version: 2, observationOnly: true })
})

test('a paused cold observation delegates the exact verified real response only when released', async () => {
  await runFixture(async ({ context, send, handled }) => {
    let settled = false
    const response = send('project_publication_status').then(value => { settled = true; return value })
    const until = Date.now() + 1500
    while (!context.__ailyNativeSaveObservationFault.snapshot().observationPaused && Date.now() < until)
      await new Promise(resolve => setTimeout(resolve, 1))
    const proof = context.__ailyNativeSaveObservationFault.snapshot()
    assert.equal(proof.observationPaused, true); assert.equal(proof.terminals.length, 1)
    assert.equal(handled.length, 1); assert.equal(settled, false)
    assert.equal(context.__ailyNativeSaveObservationFault.releaseObservation(), true)
    const body = await (await response).json()
    assert.equal(body.saveReceipt.requestId, 'original-save'); assert.equal(body.publicationObservation.executor.hostPid, 4567)
    assert.equal(context.__ailyNativeSaveObservationFault.snapshot().observationPaused, false)
  }, false, { version: 2, observationOnly: true, pauseObservation: true })
})

test('cancelling a paused readonly HTTP request does not turn its late response into another save', async () => {
  await runFixture(async ({ context, send, handled }) => {
    const controller = new AbortController()
    const response = send('project_publication_status', 'original-save', controller.signal)
    const rejected = assert.rejects(response)
    const until = Date.now() + 1500
    while (!context.__ailyNativeSaveObservationFault.snapshot().observationPaused && Date.now() < until)
      await new Promise(resolve => setTimeout(resolve, 1))
    assert.equal(context.__ailyNativeSaveObservationFault.snapshot().observationPaused, true)
    controller.abort(); await rejected
    assert.equal(context.__ailyNativeSaveObservationFault.releaseObservation(), true)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(handled.length, 1)
    assert.deepEqual([...context.__ailyNativeSaveObservationFault.snapshot().failures], [])
  }, false, { version: 2, observationOnly: true, pauseObservation: true })
})

test('v2 independently verifies directory-handle identity when path stat reports device zero', async () => {
  await runFixture(async ({ context, send, handles }) => {
    await assert.rejects(send('blocks_tidy'))
    const state = context.__ailyNativeSaveObservationFault.snapshot()
    assert.equal(state.drops, 1); assert.equal(state.failures.length, 0)
    assert.equal(handles.opened, 1); assert.equal(handles.closed, 1); assert.equal(handles.active.size, 0)
  }, false, { version: 2, pathDevZero: true })
})

test('v2 closes its directory handle and does not drop a reply after a post-fstat path-check failure', async () => {
  await runFixture(async ({ context, send, handles }) => {
    assert.equal((await send('blocks_tidy')).status, 200)
    const state = context.__ailyNativeSaveObservationFault.snapshot()
    assert.equal(state.drops, 0); assert.equal(state.failures[0].code, 'native-save-reply-verification-failed')
    assert.match(state.failures[0].message, /post-fstat path check/)
    assert.equal(handles.opened, 1); assert.equal(handles.closed, 1); assert.equal(handles.active.size, 0)
  }, false, { version: 2, pathDevZero: true, failAfterFstat: true })
})

test('a JSON-text carrier preserves the full deep customer document and the same v2 HTTP fault checks', async () => {
  await runFixture(async ({ context, installed, send }) => {
    assert.equal(installed.available, true)
    await assert.rejects(send('blocks_tidy'))
    const state = context.__ailyNativeSaveObservationFault.snapshot()
    assert.equal(state.drops, 1); assert.equal(state.failures.length, 0)
    assert.equal(state.terminals[0].layout.allOtherPersistedDataExactlyPreserved, true)
  }, false, { version: 2, configAsText: true, deepMetadata: true })
})

test('the owned physical proof records a genuinely destroyed terminal response without using the inspector snapshot', async () => {
  await runFixture(async ({ send, proofFile }) => {
    await assert.rejects(send('blocks_tidy'))
    const state = JSON.parse(await fs.readFile(proofFile, 'utf8'))
    assert.equal(state.drops, 1); assert.equal(state.commands[0].responseDestroyed, true)
    assert.equal(state.terminals[0].threePhysicalHashesVerified, true)
    assert.equal(state.terminals[0].layout.allOtherPersistedDataExactlyPreserved, true)
  }, false, { version: 2, configAsText: true, proofFile: true })
})

test('a retry/create cannot become continued B, and the first fixture failure stops the scenario', () => {
  assert.doesNotThrow(() => assertNativeSaveContinuationPhase({ coldReopened: true, actualUserTurns: 2, providerTurn: 1 }))
  for (const state of [{ coldReopened: false, actualUserTurns: 1, providerTurn: 1 },
    { coldReopened: true, actualUserTurns: 1, providerTurn: 1 }, { coldReopened: true, actualUserTurns: 2, providerTurn: 2 }])
    assert.throws(() => assertNativeSaveContinuationPhase(state), error => error.code === 'TEST_CONTINUATION_PHASE_INVALID')
  assert.doesNotThrow(() => assertNoNativeSaveModelFailures([]))
  assert.throws(() => assertNoNativeSaveModelFailures([{ message: 'original fault setup error' }]),
    error => error.code === 'TEST_PROVIDER_SETUP_FAILED' && error.message.includes('original fault setup error'))
})
