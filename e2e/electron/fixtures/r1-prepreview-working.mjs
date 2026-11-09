import assert from 'node:assert/strict'

/** Installs only an owned-test observation/fault around the actual preload fs.
 * Production receives no replacement journal, receipt, document, or authority.
 * This function is serialized into the real preload isolated world. */
export function installPrepreviewOperationFault(config) {
  const runtime = globalThis.process
  if (typeof runtime?.getBuiltinModule !== 'function') return { available: false }
  const fs = runtime.getBuiltinModule('fs'), path = runtime.getBuiltinModule('path'), crypto = runtime.getBuiltinModule('crypto')
  if (!fs?.renameSync || !path?.resolve || !crypto?.createHash) return { available: false }
  const same = (a, b) => typeof a === 'string' && typeof b === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
  const hash = bytes => 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex')
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
  const fail = message => { throw new Error('Prepreview checkpoint qualification: ' + message) }
  if (!path.isAbsolute(config.project) || !/[/\\]aily-project[/\\]dev-tests[/\\]/i.test(config.project)
    || !same(fs.realpathSync(config.project), config.project)) fail('exact owned physical project required')
  if (!path.isAbsolute(config.evidencePath) || !/[/\\]e2e[/\\]test-results[/\\]/i.test(config.evidencePath)
    || fs.existsSync(config.evidencePath)) fail('fresh owned evidence path required')
  if (!Number.isInteger(config.hostPid) || config.hostPid <= 0 || config.hostPid === runtime.pid
    || String(config.hostPid) !== runtime.env.AILY_LIBRARY_HOST_PID) fail('exact inherited main PID required')
  if (!['kill-after-pointer', 'eio-before-pointer'].includes(config.mode)
    || !/^sha256:[a-f0-9]{64}$/.test(config.candidateHash) || !config.generation
    || !config.document || !config.mirrors) fail('explicit boundary identity required')
  if (globalThis.__ailyPrepreviewFault) fail('a fault is already installed')
  const directory = path.join(config.project, '.aily', 'abs-sync'), pointerPath = path.join(directory, 'operation.json')
  const original = fs.renameSync
  const state = { available: true, mode: config.mode, renameCalls: 0, delegatedCalls: 0, operationRenames: 0,
    injected: 0, qualifications: [], refusals: [] }
  const delegate = args => { state.delegatedCalls++; return original.apply(fs, args) }
  const readOptional = file => { try { return fs.readFileSync(file) } catch (error) { if (error.code === 'ENOENT') return null; throw error } }
  const qualify = pointerBytes => {
    const pointer = JSON.parse(pointerBytes.toString('utf8'))
    if (pointer.version !== 1 || pointer.state !== 'pending' || !/^[a-f0-9-]+$/.test(pointer.id)
      || !/^sha256:[a-f0-9]{64}$/.test(pointer.hash)) fail('invalid actual pending pointer')
    const snapshotPath = path.join(directory, 'recoveries', 'operation-' + pointer.id + '.json')
    const snapshotBytes = fs.readFileSync(snapshotPath), record = JSON.parse(snapshotBytes.toString('utf8'))
    if (hash(snapshotBytes) !== pointer.hash) fail('immutable operation checksum mismatch')
    // Other native setup operations cannot become the requested apply boundary.
    if (record.kind !== 'abs-apply') return null
    if (record.version !== 1 || record.id !== pointer.id || !same(record.project, config.project)) fail('wrong operation identity')
    if (JSON.stringify(canonical(record.document)) !== JSON.stringify(canonical(config.document))) fail('snapshot is not the complete dirty S1')
    if (hash(JSON.stringify(canonical(record.document))) !== config.documentHash) fail('dirty S1 digest mismatch')
    const candidate = record.candidate, application = record.application
    if (candidate?.hash !== config.candidateHash || hash(candidate.source) !== config.candidateHash
      || candidate.generation !== config.generation) fail('original candidate A or G0 was rebound')
    if (typeof application?.requestId !== 'string' || !application.requestId
      || application.validation?.requestId !== application.requestId
      || application.validation.candidate?.hash !== config.candidateHash
      || (application.validation.intentGeneration ?? application.validation.base?.generation) !== config.generation
      || !same(application.validation.base?.scope?.projectKey, config.project)) fail('original application request missing or rebound')
    for (const [name, key] of [['project.abi', 'abi'], ['project.abs', 'abs'], ['project.abs.map.json', 'map']]) {
      const expected = config.mirrors[name], actual = readOptional(path.join(config.project, name)), retained = record.disk?.[key]
      if (!expected || actual === null || typeof retained !== 'string'
        || hash(actual) !== expected.hash || actual.length !== expected.bytes || hash(retained) !== expected.hash) fail('S0 mirror changed: ' + name)
    }
    const committed = readOptional(path.join(directory, 'committed.json')), expected = config.mirrors['.aily/abs-sync/committed.json']
    if (!expected || committed === null || hash(committed) !== expected.hash || committed.length !== expected.bytes
      || hash(record.committed) !== expected.hash) fail('S0 committed pointer changed')
    const witness = JSON.parse(globalThis.document.documentElement.dataset.ailyPrepreviewWitness ?? 'null')
    if (!witness || witness.loadCalls !== 0 || witness.clearCalls !== 0 || witness.documentHash !== config.documentHash) fail('GUI preview was already loaded or witness missing')
    return { pointer, snapshotPath, snapshotHash: hash(snapshotBytes), documentHash: hash(JSON.stringify(canonical(record.document))),
      candidateHash: candidate.hash, generation: candidate.generation, requestId: application.requestId,
      mirrors: config.mirrors, witness, hostPid: config.hostPid, preloadPid: runtime.pid, mode: config.mode,
      durablePointer: config.mode === 'kill-after-pointer', at: Date.now() }
  }
  const saveEvidence = value => {
    const fd = fs.openSync(config.evidencePath, 'wx', 0o600)
    try { fs.writeFileSync(fd, JSON.stringify(value, null, 2)); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  }
  const hook = function (...args) {
    state.renameCalls++
    const [from, target] = args
    if (state.injected || typeof from !== 'string' || typeof target !== 'string'
      || !same(target, pointerPath) || !same(path.dirname(from), directory)
      || !/^\.abs-sync-[a-f0-9-]+\.tmp$/.test(path.basename(from))) return delegate(args)
    state.operationRenames++
    if (config.mode === 'kill-after-pointer') delegate(args)
    let qualified
    try { qualified = qualify(fs.readFileSync(config.mode === 'kill-after-pointer' ? target : from)) }
    catch (error) { state.refusals.push({ message: error.message, at: Date.now() }); throw error }
    if (!qualified) return config.mode === 'kill-after-pointer' ? undefined : delegate(args)
    state.injected++; state.qualifications.push(qualified); saveEvidence(qualified)
    if (config.mode === 'eio-before-pointer') throw Object.assign(new Error('TEST_PREPREVIEW_OPERATION_POINTER_EIO'), { code: 'EIO' })
    // Neither return to storage nor allow a surviving renderer to load S1/A.
    runtime.kill(config.hostPid, 'SIGKILL')
    runtime.kill(runtime.pid, 'SIGKILL')
    throw new Error('Owned preload unexpectedly survived its SIGKILL')
  }
  fs.renameSync = hook
  globalThis.__ailyPrepreviewFault = { snapshot: () => JSON.parse(JSON.stringify(state)), restore: () => {
    if (fs.renameSync !== hook) fail('fault ownership changed')
    fs.renameSync = original; return state.injected
  } }
  return { available: true, mode: config.mode, hostPid: config.hostPid, preloadPid: runtime.pid }
}

/** Main-world read-only counters: no loader callback or status is replaced. */
export function installPrepreviewGuiWitness({ documentHash }) {
  if (globalThis.__ailyPrepreviewGui) throw Error('Preview witness already installed')
  const runtime = window.Blockly, workspace = runtime?.getMainWorkspace(), loader = runtime?.serialization?.workspaces
  if (!workspace || typeof workspace.clear !== 'function' || typeof loader?.load !== 'function') throw Error('Real Blockly loader unavailable')
  const state = { loadCalls: 0, clearCalls: 0, documentHash }, originalLoad = loader.load, originalClear = workspace.clear
  const publish = () => { document.documentElement.dataset.ailyPrepreviewWitness = JSON.stringify(state) }
  const load = function (...args) { if (args[1] === workspace) { state.loadCalls++; publish() } return originalLoad.apply(this, args) }
  const clear = function (...args) { state.clearCalls++; publish(); return originalClear.apply(this, args) }
  loader.load = load; workspace.clear = clear; publish()
  globalThis.__ailyPrepreviewGui = { snapshot: () => ({ ...state }), restore: () => {
    if (loader.load !== load || workspace.clear !== clear) throw Error('Preview witness ownership changed')
    loader.load = originalLoad; workspace.clear = originalClear; return { ...state }
  } }
  return { ...state }
}

/** Actual-main HTTP witness. Default is passive. The explicitly armed separate
 * committed-reply mode can destroy one proven original response and kill only
 * its own main. Authentication, commands and native result facts stay intact. */
export function installPrepreviewApplicationAudit(_electron, config) {
  const runtime = globalThis.process, fs = runtime.getBuiltinModule('fs'), path = runtime.getBuiltinModule('path')
  const http = runtime.getBuiltinModule('http'), crypto = runtime.getBuiltinModule('crypto'), { Buffer } = runtime.getBuiltinModule('buffer')
  const same = (a, b) => typeof a === 'string' && typeof b === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
  if (runtime.pid !== config.pid || runtime.env.AILY_APPDATA_PATH !== config.appData || !path.isAbsolute(config.project)
    || !/[/\\]aily-project[/\\]dev-tests[/\\]/i.test(config.project) || !same(fs.realpathSync(config.project), config.project)
    || !Number.isSafeInteger(config.port) || !path.isAbsolute(config.evidencePath)
    || !/[/\\]e2e[/\\]test-results[/\\]/i.test(config.evidencePath) || fs.existsSync(config.evidencePath)) throw Error('Require exact owned fresh passive audit')
  if (globalThis.__ailyPrepreviewApplicationAudit) throw Error('Only one passive application audit per owned main')
  const matches = runtime._getActiveHandles().filter(value => value instanceof http.Server && value.address()?.port === config.port)
  if (matches.length !== 1) return { available: false }
  const server = matches[0], originalEmit = server.emit, hash = bytes => 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex')
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
  const state = { version: 1, available: true, pid: runtime.pid, commands: [], responses: [], failures: [],
    commandsSentByObserver: 0, responsesModified: 0, authenticatedHandlerReplaced: false }
  let committedKill, candidateRead, heldCandidateEnd
  const persist = () => {
    const temp = config.evidencePath + '.' + crypto.randomUUID() + '.tmp'
    const fd = fs.openSync(temp, 'wx', 0o600)
    try { fs.writeFileSync(fd, JSON.stringify(state)); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    fs.renameSync(temp, config.evidencePath)
  }
  const qualifyCommitted = (body, command, response, beforeBytes) => {
    const receipt = body.receipt, output = receipt?.output, binding = output?.binding, publication = body.publication
    if (body.ok !== true || publication?.status !== 'COMMITTED' || body.requiresReload !== false
      || !['abiSaved', 'absMirrored', 'mapPublished'].every(key => publication[key] === true)
      || receipt?.version !== 2 || receipt.requestId !== command.requestId || receipt.validation?.ok !== true
      || receipt.validation.scope !== 'complete-generation' || receipt.candidate?.hash !== committedKill.candidateHash
      || (receipt.intentGeneration ?? receipt.base?.generation) !== committedKill.generation
      || publication.generation !== binding?.generation || !same(binding?.scope?.projectKey, config.project))
      throw Error('A complete original native COMMITTED receipt is required before reply-loss kill')
    if (response.writableEnded || response.writableFinished || !response.socket || !Number.isSafeInteger(beforeBytes)
      || response.socket.bytesWritten !== beforeBytes) throw Error('The original response may already have sent bytes')
    if (state.responses.some(value => value.commandIndex !== command.index && value.requestId === command.requestId
      && value.publication?.status === 'COMMITTED')) throw Error('The original commit was already observable before this fault')
    const mirrors = {}
    for (const [name, key] of [['project.abi', 'abiHash'], ['project.abs', 'absHash'], ['project.abs.map.json', 'mapHash']]) {
      const bytes = fs.readFileSync(path.join(config.project, name))
      if (hash(bytes) !== binding[key]) throw Error('Committed reply differs from its original physical mirror: ' + name)
      mirrors[name] = { hash: hash(bytes), bytes: bytes.length }
    }
    if (mirrors['project.abs'].bytes !== output.absBytes) throw Error('Committed ABS byte count differs')
    const document = JSON.parse(fs.readFileSync(path.join(config.project, 'project.abi'), 'utf8'))
    if (JSON.stringify(canonical(document)) !== JSON.stringify(canonical(committedKill.document))) throw Error('Native commit did not preserve complete A+C')
    const map = JSON.parse(fs.readFileSync(path.join(config.project, 'project.abs.map.json'), 'utf8'))
    if (map.generation !== binding.generation || map.baseAbsHash !== binding.absHash
      || JSON.stringify(canonical(map.scope)) !== JSON.stringify(canonical(binding.scope))) throw Error('Committed map binding differs')
    const directory = path.join(config.project, '.aily/abs-sync'), committedBytes = fs.readFileSync(path.join(directory, 'committed.json'))
    const committed = JSON.parse(committedBytes.toString('utf8'))
    if (!/^[A-Za-z0-9_-]{1,96}$/.test(binding.generation) || committed.schemaVersion !== 1 || committed.generation !== binding.generation
      || committed.hash !== hash(fs.readFileSync(path.join(directory, 'baselines', binding.generation + '.json')))) throw Error('No exact committed baseline pointer')
    mirrors['.aily/abs-sync/committed.json'] = { hash: hash(committedBytes), bytes: committedBytes.length }
    const indexPath = path.join(directory, 'recoveries/request-' + hash(command.requestId).slice(7) + '.json')
    const indexBytes = fs.readFileSync(indexPath), index = JSON.parse(indexBytes.toString('utf8'))
    if (index.requestId !== command.requestId || index.project !== config.project || !/^[a-f0-9-]{36}$/.test(index.operationId)) throw Error('Original immutable request index differs')
    const names = ['request-' + hash(command.requestId).slice(7) + '.json', 'operation-' + index.operationId + '.json',
      'application-' + index.operationId + '.json', 'application-commit-' + index.operationId + '.json', 'application-result-' + index.operationId + '.json']
    const immutable = names.map(name => { const file = path.join(directory, 'recoveries', name), bytes = fs.readFileSync(file)
      return { path: file, hash: hash(bytes), bytes: bytes.length } })
    const record = JSON.parse(fs.readFileSync(immutable[1].path, 'utf8')), stage = JSON.parse(fs.readFileSync(immutable[2].path, 'utf8'))
    const proof = JSON.parse(fs.readFileSync(immutable[3].path, 'utf8')), final = JSON.parse(fs.readFileSync(immutable[4].path, 'utf8'))
    if (immutable[1].hash !== index.snapshotHash || record.id !== index.operationId || record.project !== config.project
      || record.application?.requestId !== command.requestId || record.application.validation?.requestId !== command.requestId
      || record.candidate?.hash !== committedKill.candidateHash || hash(record.candidate.source) !== committedKill.candidateHash
      || JSON.stringify(canonical(record.document)) !== JSON.stringify(canonical(committedKill.beforeDocument))
      || ![stage, proof, final].every(value => value.version === 1 && value.project === config.project && value.operationId === index.operationId)
      || stage.validation?.requestId !== command.requestId || stage.validation.candidate?.hash !== receipt.candidate.hash
      || stage.validation.base?.generation !== receipt.base?.generation
      || proof.stageHash !== immutable[2].hash || final.stageHash !== immutable[2].hash || proof.committedHash !== hash(committedBytes)
      || final.outcome?.publication?.status !== 'COMMITTED' || final.outcome.requiresReload !== false
      || JSON.stringify(canonical(final.outcome.evidence)) !== JSON.stringify(canonical(output))
      || JSON.stringify(canonical(stage.outcome?.evidence)) !== JSON.stringify(canonical(output))) throw Error('Original staged/sealed/completed apply facts differ')
    const pointer = JSON.parse(fs.readFileSync(path.join(directory, 'operation.json'), 'utf8'))
    if (pointer.id !== index.operationId || pointer.hash !== index.snapshotHash || pointer.state !== 'completed') throw Error('Original committed operation was not completed')
    return { mode: 'kill-committed-apply-before-observe', pointer, snapshotPath: immutable[1].path, snapshotHash: immutable[1].hash,
      candidateHash: committedKill.candidateHash, generation: committedKill.generation, requestId: command.requestId,
      hostPid: runtime.pid, preloadPid: record.executor?.storagePid ?? null, durablePointer: true, binding, mirrors, immutable,
      documentHash: hash(JSON.stringify(canonical(document))), candidateApplied: true, at: Date.now(),
      response: { originalEndDelegated: false, socketBytesBefore: beforeBytes, socketBytesAtEnd: response.socket.bytesWritten } }
  }
  const qualifyCandidateRead = (body, command, response, beforeBytes) => {
    const reference = body.candidateArchive, candidate = body.candidate
    if (body.ok !== true || body.operation !== 'abs_recovery' || !same(body.project, config.project)
      || body.receipt?.version !== 2 || body.receipt.requestId !== command.requestId
      || body.receipt.action !== 'read_candidate' || reference?.recordHash !== candidateRead.recordHash
      || reference.hash !== candidateRead.candidateHash || reference.candidateApplied !== false || !same(reference.project, config.project)
      || candidate?.intentGeneration !== candidateRead.generation || hash(candidate.source) !== candidateRead.candidateHash)
      throw Error('A real successful exact candidate read is required')
    const prior = state.responses.find(value => value.operation === 'abs_recovery' && value.action === 'observe_apply'
      && value.requestId === candidateRead.applicationRequestId && value.publication?.status === 'UNKNOWN'
      && value.currentDocumentRecovery?.scope === 'restored-working-document')
    if (!prior) throw Error('The exact original application must have a valid restored-document observation first')
    const file = path.join(config.project, '.aily/abs-sync/recoveries', 'candidate-' + candidateRead.recordHash.slice(7) + '.json')
    if (!same(file, reference.path) || !same(fs.realpathSync(file), file)) throw Error('Candidate reference is outside its exact project archive')
    const stat = fs.lstatSync(file), bytes = fs.readFileSync(file), record = JSON.parse(bytes.toString('utf8'))
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || hash(bytes) !== candidateRead.recordHash
      || record.version !== 1 || record.kind !== 'abs-candidate' || !same(record.project, config.project) || record.candidate?.hash !== candidateRead.candidateHash
      || record.candidate.source !== candidate.source || Buffer.byteLength(candidate.source) !== reference.bytes
      || JSON.stringify(canonical(candidate.editProof)) !== JSON.stringify(canonical(record.candidate.editProof))
      || JSON.stringify(canonical(candidate.sourceEdits)) !== JSON.stringify(canonical(record.candidate.sourceEdits))) throw Error('Returned candidate differs from its complete immutable archive')
    const proof = candidate.editProof, origin = proof?.origin
    const physical = prior.currentDocumentRecovery.attachment?.identity, mapHash = prior.currentDocumentRecovery.saved?.mapHash?.slice(7)
    if (proof?.version !== 2 || proof.hash !== candidateRead.candidateHash || typeof proof.identity !== 'string' || !proof.identity
      || typeof proof.key !== 'string' || !path.isAbsolute(proof.key) || path.basename(proof.key) !== 'project.abs'
      || !(proof.mapHash === null || /^[a-f0-9]{64}$/.test(proof.mapHash ?? ''))
      || origin?.version !== 1 || origin.generation !== candidateRead.generation
      || origin.baseAbsHash !== hash(candidateRead.baseSource) || !same(origin.sourceKey, path.join(config.project, 'project.abs'))
      || !physical || origin.rootIdentity !== `${physical.dev}:${physical.ino}`
      || !mapHash || ![origin.mapHash, origin.acceptedMapHash].includes(mapHash)
      || !Array.isArray(proof.steps) || !proof.steps.length) throw Error('The exact original full edit proof is unavailable')
    let source = candidateRead.baseSource
    for (const step of proof.steps) {
      if (step.before !== hash(source) || !Array.isArray(step.edits) || !step.edits.length) throw Error('Edit-proof chain does not start at the original intent')
      let previous = source.length + 1
      for (const edit of [...step.edits].sort((a, b) => b.start - a.start)) {
        if (!Number.isSafeInteger(edit.start) || !Number.isSafeInteger(edit.end) || edit.start < 0 || edit.end < edit.start
          || edit.end > source.length || edit.end > previous || typeof edit.text !== 'string') throw Error('Invalid genuine edit-proof step')
        previous = edit.start; source = source.slice(0, edit.start) + edit.text + source.slice(edit.end)
      }
      if (hash(source) !== step.after) throw Error('Edit-proof replay hash differs')
    }
    if (source !== candidate.source || response.writableEnded || response.writableFinished || !response.socket
      || !Number.isSafeInteger(beforeBytes) || response.socket.bytesWritten !== beforeBytes) throw Error('Candidate body is invalid or may already have been sent')
    return { recordHash: reference.recordHash, candidateHash: reference.hash, generation: candidate.intentGeneration,
      readRequestId: command.requestId, applicationRequestId: candidateRead.applicationRequestId, proofHash: hash(JSON.stringify(canonical(proof))),
      held: true, socketCancelled: false, originalEndDelegated: false, responseBytesBefore: beforeBytes, at: Date.now() }
  }
  const hook = function (event, ...args) {
    if (event !== 'request') return originalEmit.call(this, event, ...args)
    const [request, response] = args
    if (request.method !== 'POST' || request.url !== '/command') return originalEmit.call(this, event, ...args)
    let command, bytes = 0, chunks = []
    const socketBytesBefore = response.socket?.bytesWritten
    request.on('data', chunk => { bytes += chunk.length; if (bytes <= 1024 * 1024) chunks.push(chunk); else chunks = [] })
    request.once('end', () => {
      if (!chunks.length || bytes > 1024 * 1024) return
      let body
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return }
      chunks = []
      if (body.action !== 'blockly-live-operation' || !same(body.path, config.project)
        || !['abs_apply', 'abs_recovery', 'abs_projection'].includes(body.operation)
        || body.operation === 'abs_recovery' && !['observe_apply', 'inspect', 'read_candidate'].includes(body.params?.action)) return
      const requestId = body.params?.requestId
      if (typeof requestId !== 'string' || !/^[A-Za-z0-9-]{16,80}$/.test(requestId)) return
      command = { index: state.commands.length, operation: body.operation, action: body.params?.action ?? null,
        requestId, candidateHash: body.params?.validation?.candidate?.hash ?? null, at: Date.now(), requestBytes: bytes,
        ...(body.params?.action === 'read_candidate' ? { recordHash: body.params.recordHash } : {}),
        ...(body.operation === 'abs_projection' ? {
          flags: Object.fromEntries(['reuseCurrent', 'synchronize', 'publish', 'save'].map(key => [key,
            typeof body.params?.[key] === 'boolean' ? body.params[key] : null])),
          invalidBooleanFlags: ['reuseCurrent', 'synchronize', 'publish', 'save'].filter(key =>
            body.params?.[key] !== undefined && typeof body.params[key] !== 'boolean') } : {}) }
      state.commands.push(command); persist()
    })
    const originalEnd = response.end
    response.end = function (...endArgs) {
      let committedBoundary, candidateBoundary
      if (command) {
        const raw = endArgs[0], size = typeof raw === 'string' ? Buffer.byteLength(raw) : Buffer.isBuffer(raw) ? raw.length : 0
        try {
          if (!size || size > 8 * 1024 * 1024) throw Error('Actual application response is unavailable or oversized')
          const body = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : raw)
          state.responses.push({ commandIndex: command.index, operation: command.operation, action: command.action, requestId: command.requestId,
            at: Date.now(), responseBytes: size, responseHash: hash(raw), httpStatus: response.statusCode,
            ok: body.ok, code: body.code ?? null, publication: body.publication ?? null,
            applicationObservation: body.applicationObservation ?? null,
            currentDocumentRecovery: body.currentDocumentRecovery ?? null,
            outputBinding: body.receipt?.output?.binding ?? null,
            ...(command.operation === 'abs_recovery' && command.action === 'inspect'
              ? { baselineBinding: body.diagnostics?.baseline?.binding ?? null } : {}),
            receipt: body.receipt ? { version: body.receipt.version, requestId: body.receipt.requestId,
              validation: body.receipt.validation, outputBinding: body.receipt.output?.binding } : null })
          if (committedKill && command.operation === 'abs_apply') {
            if (command.candidateHash !== committedKill.candidateHash) throw Error('Wrong candidate reached committed-reply fault')
            committedBoundary = qualifyCommitted(body, command, this, socketBytesBefore)
          }
          if (candidateRead && !state.candidateRead && command.operation === 'abs_recovery' && command.action === 'read_candidate'
            && command.recordHash === candidateRead.recordHash) candidateBoundary = qualifyCandidateRead(body, command, this, socketBytesBefore)
        } catch (error) { state.failures.push({ commandIndex: command.index, message: error.message }) }
        persist()
      }
      if (candidateBoundary) {
        state.candidateRead = candidateBoundary
        this.once('close', () => { state.candidateRead.socketCancelled = true; state.candidateRead.closedAt = Date.now(); persist() })
        heldCandidateEnd = () => {
          state.candidateRead.held = false; state.candidateRead.originalEndDelegated = true; state.candidateRead.releasedAt = Date.now()
          let result
          try { result = originalEnd.apply(response, endArgs) }
          catch (error) { state.candidateRead.lateEndCode = error.code ?? null }
          persist(); return result
        }
        persist(); return this
      }
      if (committedBoundary) {
        this.destroy()
        if (this.destroyed !== true) throw Error('The original response socket did not close')
        committedBoundary.response.destroyed = true
        state.responsesModified++; state.committedKill = committedBoundary; persist()
        const fd = fs.openSync(committedKill.evidencePath, 'wx', 0o600)
        try { fs.writeFileSync(fd, JSON.stringify(committedBoundary)); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
        runtime.kill(runtime.pid, 'SIGKILL')
        throw Error('Owned main survived its committed-reply SIGKILL')
      }
      return originalEnd.apply(this, endArgs)
    }
    return originalEmit.call(this, event, ...args)
  }
  server.emit = hook
  globalThis.__ailyPrepreviewApplicationAudit = { snapshot: () => JSON.parse(JSON.stringify(state)), armCandidateRead: value => {
    if (config.stopCandidateRead !== true || candidateRead || !/^sha256:[a-f0-9]{64}$/.test(value?.recordHash ?? '')
      || !/^sha256:[a-f0-9]{64}$/.test(value?.candidateHash ?? '') || typeof value.generation !== 'string'
      || typeof value.baseSource !== 'string' || !/^[A-Za-z0-9-]{16,80}$/.test(value.applicationRequestId)) throw Error('Require one exact real pending candidate read')
    candidateRead = JSON.parse(JSON.stringify(value)); return { armed: true }
  }, releaseCandidateRead: () => {
    if (!heldCandidateEnd || !state.candidateRead?.socketCancelled) throw Error('Release the delayed candidate only after actual socket cancellation')
    const release = heldCandidateEnd; heldCandidateEnd = undefined; release(); return true
  }, armCommittedKill: value => {
    if (config.killCommitted !== true || committedKill || !value?.document || !value.beforeDocument
      || !/^sha256:[a-f0-9]{64}$/.test(value.candidateHash) || typeof value.generation !== 'string'
      || !same(path.dirname(value.evidencePath), path.dirname(config.evidencePath)) || fs.existsSync(value.evidencePath)) throw Error('Invalid fresh committed-reply fault identity')
    committedKill = JSON.parse(JSON.stringify(value)); return { armed: true }
  }, restore: () => {
    if (server.emit !== hook) throw Error('Passive audit ownership changed')
    if (heldCandidateEnd) throw Error('A paused candidate response must first be cancelled and released')
    server.emit = originalEmit; return state.commands.length
  } }
  persist(); return { available: true, pid: runtime.pid, port: config.port }
}

export function assertNoProtectedProjectionPublication(commands, through) {
  assert.ok(Number.isFinite(through) && through > 0)
  const projections = commands.filter(value => value.operation === 'abs_projection' && value.at <= through)
  for (const projection of projections) {
    assert.deepEqual(projection.invalidBooleanFlags, [], 'Projection option types must be observable')
    assert.equal(projection.flags?.publish, false, 'Protected recovery cannot run a publishing projection')
    assert.notEqual(projection.flags?.synchronize, true, 'Protected recovery cannot synchronize/save the dirty GUI')
    assert.notEqual(projection.flags?.save, true, 'Protected recovery cannot save before original observation')
  }
  return projections
}

/** Inspect may precede observe. The ordering fence concerns publications, not
 * unrelated readonly RPCs or message/provider timestamps. */
export function assertProtectedApplicationPreparation(audit, { requestId, firstProviderAt, publication, observationNotBefore }) {
  assert.ok(Number.isFinite(firstProviderAt) && firstProviderAt > 0, 'Use the actual first local provider HTTP arrival')
  const observed = audit.responses.find(value => value.operation === 'abs_recovery' && value.action === 'observe_apply'
    && value.requestId === requestId && value.publication?.status === publication
    && (observationNotBefore === undefined || value.at >= observationNotBefore)
    && (publication === 'COMMITTED' ? value.applicationObservation?.current === true
      : value.currentDocumentRecovery?.scope === 'restored-working-document'))
  assert.ok(observed, 'The system must observe the exact original application before exposing the cold turn to its provider')
  assert.ok(Number.isFinite(observed.at) && observed.at <= firstProviderAt, 'Original readonly observation must complete before the first provider call')
  assert.equal(audit.commands.filter(value => value.operation === 'abs_apply' && value.at <= firstProviderAt).length, 0,
    'Cold preparation cannot resubmit or replace the original application')
  const projections = assertNoProtectedProjectionPublication(audit.commands, publication === 'COMMITTED' ? observed.at : firstProviderAt)
  return { firstProviderAt, observed, projections, readonlyInspectionCount: audit.commands.filter(value =>
    value.operation === 'abs_recovery' && value.action === 'inspect' && value.at <= firstProviderAt).length }
}
