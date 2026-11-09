import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import vm from 'node:vm'
import { EventEmitter } from 'node:events'
import { installPrepreviewOperationFault, installPrepreviewGuiWitness, installPrepreviewApplicationAudit,
  assertProtectedApplicationPreparation } from './r1-prepreview-working.mjs'

const hash = bytes => 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex')
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
function fixture(mode = 'kill-after-pointer', mutate = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r1-prepreview-'))
  const project = path.join(root, 'aily-project/dev-tests/project'), directory = path.join(project, '.aily/abs-sync')
  const output = path.join(root, 'e2e/test-results/output')
  fs.mkdirSync(path.join(directory, 'recoveries'), { recursive: true }); fs.mkdirSync(output, { recursive: true })
  const document = { pages: [{ id: 'main', content: { untouched: true, number: 201 } }] }, candidate = 'block(101)\nblock(200)'
  const disk = { abi: '{"number":200}', abs: 'block(100)\nblock(200)', map: '{"generation":"g0"}' }, committed = '{"generation":"g0"}'
  const mirrors = {}
  for (const [name, source] of [['project.abi', disk.abi], ['project.abs', disk.abs], ['project.abs.map.json', disk.map], ['.aily/abs-sync/committed.json', committed]]) {
    fs.writeFileSync(path.join(project, name), source); mirrors[name] = { hash: hash(source), bytes: Buffer.byteLength(source) }
  }
  const config = { project, evidencePath: path.join(output, 'checkpoint.json'), mode, hostPid: 404,
    generation: 'g0', candidateHash: hash(candidate), document, documentHash: hash(JSON.stringify(canonical(document))), mirrors }
  const record = { version: 1, id: 'a123-456', project, kind: 'abs-apply', document: structuredClone(document), disk, committed,
    candidate: { source: candidate, hash: hash(candidate), generation: 'g0' }, application: { requestId: 'original-id', validation: { requestId: 'original-id',
      candidate: { hash: hash(candidate) }, base: { generation: 'g0', scope: { projectKey: project } } } } }
  const witness = { loadCalls: 0, clearCalls: 0, documentHash: config.documentHash }
  mutate({ record, config, witness, project, directory })
  const snapshotBytes = JSON.stringify(record)
  fs.writeFileSync(path.join(directory, 'recoveries/operation-' + record.id + '.json'), snapshotBytes)
  const pointer = { version: 1, id: record.id, hash: hash(snapshotBytes), state: 'pending' }
  const from = path.join(directory, '.abs-sync-a123-456.tmp'), target = path.join(directory, 'operation.json')
  fs.writeFileSync(from, JSON.stringify(pointer))
  const kills = [], calls = []
  const files = { ...fs, renameSync: (...args) => { calls.push(args); return fs.renameSync(...args) } }
  const context = vm.createContext({ process: { pid: 505, env: { AILY_LIBRARY_HOST_PID: '404' },
    getBuiltinModule: name => ({ fs: files, path, crypto })[name], kill: (pid, signal) => { kills.push({ pid, signal }); if (pid === 505) throw Error('TEST_ACTUAL_KILL_REPLACED_IN_PURE_SPEC') } },
    document: { documentElement: { dataset: { ailyPrepreviewWitness: JSON.stringify(witness) } } } })
  const installed = vm.runInContext(`(${installPrepreviewOperationFault.toString()})(${JSON.stringify(config)})`, context)
  return { installed, from, target, config, files, context, calls, kills,
    run: () => files.renameSync(from, target), read: () => JSON.parse(fs.readFileSync(config.evidencePath, 'utf8')),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

test('kills only the actual main and preload after exact S1 pointer is durable, before GUI load', () => {
  const f = fixture(); try {
    assert.equal(f.installed.available, true)
    assert.throws(f.run, /PURE_SPEC/)
    const saved = f.read()
    assert.equal(saved.durablePointer, true); assert.equal(saved.requestId, 'original-id'); assert.equal(saved.witness.loadCalls, 0)
    assert.equal(saved.candidateHash, f.config.candidateHash)
    assert.equal(f.calls.length, 1); assert.equal(fs.existsSync(f.target), true)
    assert.deepEqual(f.kills, [{ pid: 404, signal: 'SIGKILL' }, { pid: 505, signal: 'SIGKILL' }])
  } finally { f.cleanup() }
})

test('EIO before the operation pointer is a live-only boundary and cannot claim durable cold recovery', () => {
  const f = fixture('eio-before-pointer'); try {
    assert.throws(f.run, { code: 'EIO' })
    assert.equal(f.read().durablePointer, false); assert.equal(f.calls.length, 0); assert.deepEqual(f.kills, [])
    assert.equal(fs.existsSync(f.target), false); assert.equal(fs.existsSync(f.from), true)
  } finally { f.cleanup() }
})

test('refuses old S0, altered candidate/intent, prior preview, missing request and changed mirrors', () => {
  for (const mutate of [
    ({ record }) => { record.document.pages[0].content.number = 200 },
    ({ record }) => { record.candidate.source = 'different(999)' },
    ({ record }) => { record.candidate.generation = 'new-g1' },
    ({ witness }) => { witness.loadCalls = 1 },
    ({ witness }) => { witness.clearCalls = 1 },
    ({ record }) => { delete record.application },
    ({ record }) => { record.application.validation.candidate.hash = hash('substituted') },
    ({ record }) => { record.application.validation.base.generation = 'other-g' },
    ({ config }) => { config.mirrors['project.abi'].hash = hash('changed') },
    ({ record }) => { record.committed = '{"generation":"other"}' }
  ]) {
    const f = fixture('kill-after-pointer', mutate); try {
      assert.throws(f.run, /qualification/); assert.deepEqual(f.kills, []); assert.equal(fs.existsSync(f.config.evidencePath), false)
    } finally { f.cleanup() }
  }
})

test('delegates non-apply operation pointers without manufacturing a kill boundary', () => {
  const f = fixture('kill-after-pointer', ({ record }) => { record.kind = 'document-save' }); try {
    f.run(); assert.equal(f.calls.length, 1); assert.deepEqual(f.kills, []); assert.equal(fs.existsSync(f.config.evidencePath), false)
  } finally { f.cleanup() }
})

test('immutable snapshot checksum must match the actual pointer and exact main is required', () => {
  const f = fixture(); try {
    const pointer = JSON.parse(fs.readFileSync(f.from, 'utf8')); pointer.hash = hash('tamper')
    fs.writeFileSync(f.from, JSON.stringify(pointer)); assert.throws(f.run, /checksum/); assert.deepEqual(f.kills, [])
    assert.throws(() => vm.runInContext(`(${installPrepreviewOperationFault.toString()})(${JSON.stringify({ ...f.config, hostPid: 303 })})`, f.context), /main PID/)
  } finally { f.cleanup() }
})

test('EIO preserves an existing pointer exactly and still cannot grant cold restore', () => {
  const f = fixture('eio-before-pointer'); try {
    const previous = '{"version":1,"id":"previous","state":"completed"}'
    fs.writeFileSync(f.target, previous)
    assert.throws(f.run, { code: 'EIO' }); assert.equal(fs.readFileSync(f.target, 'utf8'), previous)
    assert.equal(f.read().durablePointer, false); assert.deepEqual(f.kills, [])
  } finally { f.cleanup() }
})

test('GUI witness counts only the active workspace and delegates loader/clear unchanged', () => {
  const calls = [], workspace = { clear: (...args) => { calls.push(['clear', ...args]); return 'clear-result' } }
  const loader = { load: (...args) => { calls.push(['load', ...args]); return 'load-result' } }
  const originalLoad = loader.load, originalClear = workspace.clear
  const context = vm.createContext({ window: { Blockly: { getMainWorkspace: () => workspace, serialization: { workspaces: loader } } },
    document: { documentElement: { dataset: {} } } })
  vm.runInContext(`(${installPrepreviewGuiWitness.toString()})({documentHash:'exact-S1'})`, context)
  assert.equal(loader.load('detached', {}), 'load-result')
  assert.equal(loader.load('real', workspace), 'load-result'); assert.equal(workspace.clear('arg'), 'clear-result')
  const state = vm.runInContext('globalThis.__ailyPrepreviewGui.snapshot()', context)
  assert.equal(state.loadCalls, 1); assert.equal(state.clearCalls, 1); assert.equal(state.documentHash, 'exact-S1')
  vm.runInContext('globalThis.__ailyPrepreviewGui.restore()', context)
  assert.equal(loader.load, originalLoad); assert.equal(workspace.clear, originalClear); assert.equal(calls.length, 3)
})

test('passive actual-server witness preserves auth/body and UNKNOWN response bytes, with no new commands', () => {
  const f = fixture()
  try {
    class Server extends EventEmitter { address() { return { port: 12345 } } }
    const server = new Server(), originals = [], received = []
    const result = { ok: false, publication: { status: 'UNKNOWN' }, applicationObservation: { requestId: 'original-request-1234', current: false },
      currentDocumentRecovery: { version: 1, scope: 'restored-working-document', candidateApplied: false } }
    server.on('request', (req, res) => {
      const chunks = []; req.on('data', value => chunks.push(value))
      req.on('end', () => { received.push(Buffer.concat(chunks).toString()); res.end(JSON.stringify(result)) })
    })
    const auditPath = f.config.evidencePath + '.audit.json'
    const context = vm.createContext({ process: { pid: 404, env: { AILY_APPDATA_PATH: 'owned-appdata' },
      getBuiltinModule: name => ({ fs, path, crypto, http: { Server }, buffer: { Buffer } })[name], _getActiveHandles: () => [server] } })
    vm.runInContext(`(${installPrepreviewApplicationAudit.toString()})(null,${JSON.stringify({ pid: 404, appData: 'owned-appdata', project: f.config.project, port: 12345, evidencePath: auditPath })})`, context)
    const request = new EventEmitter(); request.method = 'POST'; request.url = '/command'
    const response = { statusCode: 400, end: value => { originals.push(value); return response } }
    const body = JSON.stringify({ action: 'blockly-live-operation', path: f.config.project, token: 'NEVER_PERSIST_THIS_TOKEN',
      operation: 'abs_recovery', params: { action: 'observe_apply', requestId: 'original-request-1234' } })
    server.emit('request', request, response); request.emit('data', Buffer.from(body)); request.emit('end')
    assert.deepEqual(received, [body]); assert.deepEqual(originals, [JSON.stringify(result)])
    const raw = fs.readFileSync(auditPath, 'utf8'), audit = JSON.parse(raw)
    assert.equal(raw.includes('NEVER_PERSIST_THIS_TOKEN'), false)
    assert.equal(audit.commands.length, 1); assert.equal(audit.commands[0].requestId, 'original-request-1234')
    assert.equal(audit.responses[0].publication.status, 'UNKNOWN'); assert.equal(audit.responses[0].applicationObservation.current, false)
    assert.equal(audit.responses[0].currentDocumentRecovery.scope, 'restored-working-document')
    assert.equal(audit.commandsSentByObserver, 0); assert.equal(audit.responsesModified, 0)
    assert.deepEqual(audit.failures, [])
    const apply = new EventEmitter(); apply.method = 'POST'; apply.url = '/command'
    const applyResponse = { statusCode: 400, end: value => value }
    const applyBody = JSON.stringify({ action: 'blockly-live-operation', path: f.config.project,
      operation: 'abs_apply', params: { requestId: 'new-application-1234', validation: { candidate: { hash: hash('new-B') } } } })
    server.emit('request', apply, applyResponse); apply.emit('data', Buffer.from(applyBody)); apply.emit('end')
    const next = JSON.parse(fs.readFileSync(auditPath, 'utf8'))
    assert.equal(next.commands.length, 2); assert.equal(next.commands[1].requestId, 'new-application-1234')
    assert.equal(next.commands[1].candidateHash, hash('new-B'))
    vm.runInContext('globalThis.__ailyPrepreviewApplicationAudit.restore()', context)
  } finally { f.cleanup() }
})

function committedReplyFixture(mutate = () => {}) {
  const f = fixture(), project = f.config.project, directory = path.join(project, '.aily/abs-sync')
  const operationId = '11111111-2222-4333-8444-555555555555', requestId = 'original-request-1234'
  const before = f.config.document, applied = { ...structuredClone(before), applied: 'A+C' }, abs = 'block(101)\nblock(201)'
  const scope = { projectKey: project, pageId: 'main' }, map = { generation: 'g1', baseAbsHash: hash(abs), scope: { pageId: 'main', projectKey: project } }
  const abi = JSON.stringify(applied), mapText = JSON.stringify(map), binding = { generation: 'g1', scope,
    abiHash: hash(abi), absHash: hash(abs), mapHash: hash(mapText) }, output = { binding, absBytes: Buffer.byteLength(abs) }
  fs.writeFileSync(path.join(project, 'project.abi'), abi); fs.writeFileSync(path.join(project, 'project.abs'), abs)
  fs.writeFileSync(path.join(project, 'project.abs.map.json'), mapText); fs.mkdirSync(path.join(directory, 'baselines'))
  const baseline = '{"fixture":"opaque real baseline bytes are hash-bound here"}'; fs.writeFileSync(path.join(directory, 'baselines/g1.json'), baseline)
  const committed = JSON.stringify({ schemaVersion: 1, generation: 'g1', hash: hash(baseline) })
  fs.writeFileSync(path.join(directory, 'committed.json'), committed)
  const publication = { status: 'COMMITTED', generation: 'g1', abiSaved: true, absMirrored: true, mapPublished: true }
  const validation = { requestId, candidate: { hash: f.config.candidateHash }, base: { generation: 'g0' } }
  const record = JSON.parse(fs.readFileSync(path.join(directory, 'recoveries/operation-a123-456.json'), 'utf8'))
  record.id = operationId; record.application = { requestId, validation }; record.executor = { storagePid: 505 }
  const snapshot = JSON.stringify(record), snapshotPath = path.join(directory, 'recoveries/operation-' + operationId + '.json')
  fs.writeFileSync(snapshotPath, snapshot)
  fs.writeFileSync(path.join(directory, 'recoveries/request-' + hash(requestId).slice(7) + '.json'),
    JSON.stringify({ version: 1, project, requestId, operationId, snapshotHash: hash(snapshot) }))
  const stage = JSON.stringify({ version: 1, project, operationId, validation, outcome: { evidence: output } })
  fs.writeFileSync(path.join(directory, 'recoveries/application-' + operationId + '.json'), stage)
  fs.writeFileSync(path.join(directory, 'recoveries/application-commit-' + operationId + '.json'),
    JSON.stringify({ version: 1, project, operationId, stageHash: hash(stage), committedHash: hash(committed) }))
  fs.writeFileSync(path.join(directory, 'recoveries/application-result-' + operationId + '.json'),
    JSON.stringify({ version: 1, project, operationId, stageHash: hash(stage), outcome: { publication, requiresReload: false, evidence: output } }))
  fs.writeFileSync(path.join(directory, 'operation.json'), JSON.stringify({ version: 1, id: operationId, hash: hash(snapshot), state: 'completed' }))
  const body = { ok: true, publication, requiresReload: false,
    receipt: { ...validation, version: 2, output, validation: { ok: true, scope: 'complete-generation' } } }
  class Server extends EventEmitter { address() { return { port: 23456 } } }
  const server = new Server(), request = new EventEmitter(), kills = [], delegated = []
  request.method = 'POST'; request.url = '/command'
  const response = { statusCode: 200, socket: { bytesWritten: 700 }, writableEnded: false, writableFinished: false,
    destroy() { this.destroyed = true }, end(value) { delegated.push(value); this.writableEnded = true; return this } }
  server.on('request', (req, res) => { req.on('end', () => res.end(JSON.stringify(body))) })
  const auditPath = f.config.evidencePath + '.committed-audit.json', boundaryPath = f.config.evidencePath + '.committed-boundary.json'
  const context = vm.createContext({ process: { pid: 404, env: { AILY_APPDATA_PATH: 'owned-appdata' },
    getBuiltinModule: name => ({ fs, path, crypto, http: { Server }, buffer: { Buffer } })[name], _getActiveHandles: () => [server],
    kill: (pid, signal) => { kills.push({ pid, signal }); throw Error('TEST_MAIN_SIGKILL') } } })
  vm.runInContext(`(${installPrepreviewApplicationAudit.toString()})(null,${JSON.stringify({ pid: 404, appData: 'owned-appdata', project,
    port: 23456, evidencePath: auditPath, killCommitted: true })})`, context)
  vm.runInContext(`globalThis.__ailyPrepreviewApplicationAudit.armCommittedKill(${JSON.stringify({ document: applied, beforeDocument: before,
    candidateHash: f.config.candidateHash, generation: 'g0', evidencePath: boundaryPath })})`, context)
  mutate({ body, response, directory, operationId, project, applied })
  return { ...f, kills, delegated, auditPath, boundaryPath, response, run: () => {
    server.emit('request', request, response)
    request.emit('data', Buffer.from(JSON.stringify({ action: 'blockly-live-operation', path: project, operation: 'abs_apply',
      params: { requestId, validation } })))
    // Simulate prior actual response bytes only after the request witness took its baseline.
    if (response.alreadySent) response.socket.bytesWritten++
    request.emit('end')
  } }
}

test('separate committed-reply mode kills only after physical commit proof and before original end can send bytes', () => {
  const f = committedReplyFixture(); try {
    assert.throws(f.run, /TEST_MAIN_SIGKILL/); assert.deepEqual(f.delegated, [])
    assert.deepEqual(f.kills, [{ pid: 404, signal: 'SIGKILL' }]); assert.equal(f.response.destroyed, true)
    const proof = JSON.parse(fs.readFileSync(f.boundaryPath, 'utf8'))
    assert.equal(proof.mode, 'kill-committed-apply-before-observe'); assert.equal(proof.candidateApplied, true)
    assert.equal(proof.response.originalEndDelegated, false); assert.equal(proof.response.socketBytesBefore, proof.response.socketBytesAtEnd)
    assert.equal(proof.immutable.length, 5)
    const audit = JSON.parse(fs.readFileSync(f.auditPath, 'utf8')); assert.equal(audit.responsesModified, 1); assert.deepEqual(audit.failures, [])
  } finally { f.cleanup() }
})

test('reply already sent, wrong ID/candidate, partial commit or damaged physical proof cannot qualify commit-before-observe kill', () => {
  for (const mutate of [
    ({ response }) => { response.alreadySent = true },
    ({ body }) => { body.receipt.requestId = 'wrong-original-request' },
    ({ body }) => { body.receipt.candidate.hash = hash('different candidate') },
    ({ body }) => { body.publication.absMirrored = false },
    ({ body }) => { body.publication.status = 'UNKNOWN' },
    ({ directory, operationId }) => { fs.writeFileSync(path.join(directory, 'recoveries/application-commit-' + operationId + '.json'), '{}') },
    ({ project }) => { fs.writeFileSync(path.join(project, 'project.abi'), '{}') },
  ]) {
    const f = committedReplyFixture(mutate); try {
      f.run(); assert.deepEqual(f.kills, []); assert.equal(f.delegated.length, 1)
      assert.equal(fs.existsSync(f.boundaryPath), false); assert.equal(f.response.destroyed, undefined)
      assert.ok(JSON.parse(fs.readFileSync(f.auditPath, 'utf8')).failures.length > 0)
    } finally { f.cleanup() }
  }
})

test('projection/inspection audit records only scalar options and bindings, allowing readonly inspect before exact old observation', () => {
  const f = fixture()
  try {
    class Server extends EventEmitter { address() { return { port: 34567 } } }
    const server = new Server(), delegated = []; let reply
    server.on('request', (req, res) => req.once('end', () => res.end(JSON.stringify(reply))))
    const auditPath = f.config.evidencePath + '.projection-audit.json'
    const context = vm.createContext({ process: { pid: 404, env: { AILY_APPDATA_PATH: 'owned-appdata' },
      getBuiltinModule: name => ({ fs, path, crypto, http: { Server }, buffer: { Buffer } })[name], _getActiveHandles: () => [server] } })
    vm.runInContext(`(${installPrepreviewApplicationAudit.toString()})(null,${JSON.stringify({ pid: 404, appData: 'owned-appdata', project: f.config.project,
      port: 34567, evidencePath: auditPath })})`, context)
    const send = (operation, params, response) => {
      reply = response
      const request = new EventEmitter(); request.method = 'POST'; request.url = '/command'
      const raw = JSON.stringify({ action: 'blockly-live-operation', path: f.config.project, token: 'NEVER_LOG_TOKEN', operation,
        params: { ...params, abs: 'NEVER_LOG_BODY' } })
      server.emit('request', request, { statusCode: 200, end: value => { delegated.push(value) } })
      request.emit('data', Buffer.from(raw)); request.emit('end')
    }
    const binding = { generation: 'g0', scope: { projectKey: f.config.project, pageId: 'main' } }
    send('abs_projection', { requestId: 'readonly-projection-1234', reuseCurrent: true, synchronize: false, publish: false },
      { ok: true, publication: { status: 'NOT_COMMITTED' }, receipt: { output: { binding } } })
    send('abs_recovery', { requestId: 'readonly-inspection-1234', action: 'inspect' }, { ok: true, diagnostics: { baseline: { binding } } })
    send('abs_recovery', { requestId: 'original-request-1234', action: 'observe_apply' }, { ok: false, code: 'ABS_APPLY_OBSERVATION_UNKNOWN',
      publication: { status: 'UNKNOWN' }, applicationObservation: { current: false }, currentDocumentRecovery: { scope: 'restored-working-document' } })
    const raw = fs.readFileSync(auditPath, 'utf8'), audit = JSON.parse(raw), firstProviderAt = Date.now() + 5
    assert.equal(raw.includes('NEVER_LOG_TOKEN'), false); assert.equal(raw.includes('NEVER_LOG_BODY'), false)
    assert.deepEqual(audit.commands[0].flags, { reuseCurrent: true, synchronize: false, publish: false, save: null })
    assert.deepEqual(audit.responses[0].outputBinding, binding); assert.deepEqual(audit.responses[1].baselineBinding, binding)
    const preparation = assertProtectedApplicationPreparation(audit, { requestId: 'original-request-1234', firstProviderAt, publication: 'UNKNOWN' })
    assert.equal(preparation.readonlyInspectionCount, 1); assert.equal(delegated.length, 3)
    for (const mutate of [value => { value.commands[0].flags.publish = null }, value => { value.commands[0].flags.synchronize = true },
      value => { value.commands[0].flags.save = true }, value => { value.commands[0].invalidBooleanFlags = ['publish'] },
      value => { value.responses[2].at = firstProviderAt + 1 }, value => { value.responses[2].requestId = 'different-request-1234' }]) {
      const changed = structuredClone(audit); mutate(changed)
      assert.throws(() => assertProtectedApplicationPreparation(changed, { requestId: 'original-request-1234', firstProviderAt, publication: 'UNKNOWN' }))
    }
    vm.runInContext('globalThis.__ailyPrepreviewApplicationAudit.restore()', context)
  } finally { f.cleanup() }
})

function pausedCandidateFixture(mutate = () => {}) {
  const f = fixture(), project = f.config.project, baseSource = 'block(100)\nblock(200)', source = 'block(101)\nblock(200)'
  const physical = fs.lstatSync(project, { bigint: true }), mapHash = f.config.mirrors['project.abs.map.json'].hash.slice(7)
  const edits = [{ start: 8, end: 9, text: '1' }], proof = { version: 2, hash: hash(source), key: path.join(project, 'project.abs'),
    identity: 'owned-inode-fence', mapHash, origin: { version: 1, generation: 'g0', baseAbsHash: hash(baseSource), sourceKey: path.join(project, 'project.abs'),
      rootIdentity: `${physical.dev}:${physical.ino}`, mapHash }, steps: [{ before: hash(baseSource), after: hash(source), edits }] }
  const record = { version: 1, kind: 'abs-candidate', project, candidate: { source, hash: hash(source), bytes: Buffer.byteLength(source),
    intentGeneration: 'g0', sourceEdits: [edits], editProof: proof } }
  const bytes = JSON.stringify(canonical(record)), recordHash = hash(bytes), file = path.join(project, '.aily/abs-sync/recoveries', 'candidate-' + recordHash.slice(7) + '.json')
  fs.writeFileSync(file, bytes)
  const reference = { version: 1, project, path: file, recordHash, hash: hash(source), bytes: Buffer.byteLength(source), candidateApplied: false }
  const prior = { ok: false, publication: { status: 'UNKNOWN' }, applicationObservation: { current: false },
    currentDocumentRecovery: { scope: 'restored-working-document', requestId: 'original-request-1234',
      attachment: { identity: { dev: String(physical.dev), ino: String(physical.ino) } }, saved: { mapHash: 'sha256:' + mapHash } } }
  const body = { ok: true, operation: 'abs_recovery', project, receipt: { version: 2, requestId: 'read-candidate-1234', action: 'read_candidate' },
    candidateArchive: reference, candidate: { source, intentGeneration: 'g0', sourceEdits: [edits], editProof: proof } }
  mutate({ body, prior })
  class Server extends EventEmitter { address() { return { port: 45678 } } }
  const server = new Server(), delegated = []; let reply
  server.on('request', (req, res) => req.once('end', () => res.end(JSON.stringify(reply))))
  const auditPath = f.config.evidencePath + '.candidate-read-audit.json'
  const context = vm.createContext({ process: { pid: 404, env: { AILY_APPDATA_PATH: 'owned-appdata' },
    getBuiltinModule: name => ({ fs, path, crypto, http: { Server }, buffer: { Buffer } })[name], _getActiveHandles: () => [server] } })
  vm.runInContext(`(${installPrepreviewApplicationAudit.toString()})(null,${JSON.stringify({ pid: 404, appData: 'owned-appdata', project,
    port: 45678, evidencePath: auditPath, stopCandidateRead: true })})`, context)
  vm.runInContext(`globalThis.__ailyPrepreviewApplicationAudit.armCandidateRead(${JSON.stringify({ recordHash, candidateHash: hash(source),
    generation: 'g0', applicationRequestId: 'original-request-1234', baseSource })})`, context)
  const send = (requestId, action, result) => {
    reply = result
    const req = new EventEmitter(); req.method = 'POST'; req.url = '/command'
    const res = new EventEmitter(); Object.assign(res, { statusCode: 200, socket: { bytesWritten: 200 }, writableEnded: false, writableFinished: false,
      end(value) { delegated.push(value); this.writableEnded = true; return this } })
    server.emit('request', req, res)
    req.emit('data', Buffer.from(JSON.stringify({ action: 'blockly-live-operation', path: project, operation: 'abs_recovery',
      params: { requestId, action, ...(action === 'read_candidate' ? { recordHash } : {}) } })))
    req.emit('end'); return res
  }
  send('original-request-1234', 'observe_apply', prior)
  return { ...f, context, delegated, auditPath, body, send: () => send('read-candidate-1234', 'read_candidate', body),
    audit: () => JSON.parse(fs.readFileSync(auditPath, 'utf8')) }
}

test('candidate-read Stop seam holds only genuine full-proof bytes after original observation, then releases only after socket cancellation', () => {
  const f = pausedCandidateFixture(); try {
    const response = f.send(); assert.equal(f.delegated.length, 1)
    assert.equal(f.audit().candidateRead.held, true); assert.equal(f.audit().candidateRead.originalEndDelegated, false)
    assert.throws(() => vm.runInContext('globalThis.__ailyPrepreviewApplicationAudit.releaseCandidateRead()', f.context), /socket cancellation/)
    response.emit('close')
    assert.equal(f.audit().candidateRead.socketCancelled, true)
    assert.equal(vm.runInContext('globalThis.__ailyPrepreviewApplicationAudit.releaseCandidateRead()', f.context), true)
    assert.equal(f.delegated.length, 2); assert.equal(f.delegated[1], JSON.stringify(f.body))
    assert.equal(f.audit().candidateRead.held, false); assert.deepEqual(f.audit().failures, [])
    vm.runInContext('globalThis.__ailyPrepreviewApplicationAudit.restore()', f.context)
  } finally { f.cleanup() }
})

test('missing recovery fact, wrong record/intent or missing full proof cannot become a paused candidate success', () => {
  for (const mutate of [({ prior }) => { prior.currentDocumentRecovery = null },
    ({ body }) => { body.candidate.intentGeneration = 'new-g2' },
    ({ body }) => { body.candidateArchive.recordHash = hash('wrong archive') },
    ({ body }) => { delete body.candidate.editProof },
    ({ body }) => { body.candidate.source = 'different source' }]) {
    const f = pausedCandidateFixture(mutate); try {
      f.send(); assert.equal(f.delegated.length, 2)
      assert.equal(f.audit().candidateRead, undefined); assert.ok(f.audit().failures.length > 0)
      vm.runInContext('globalThis.__ailyPrepreviewApplicationAudit.restore()', f.context)
    } finally { f.cleanup() }
  }
})
