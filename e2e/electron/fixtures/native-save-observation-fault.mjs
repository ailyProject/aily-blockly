/** Self-contained test-only transport fault, installed in the real owned
 * Electron main process. Authentication, commands, handler and receipt bytes
 * stay unchanged. Only verified terminal responses are disconnected. */
export function installNativeSaveObservationFault(_electron, config) {
  const process = globalThis.process
  if (typeof process?.getBuiltinModule !== 'function' || typeof process._getActiveHandles !== 'function')
    return { available: false, reason: 'native_http_server_observer_unavailable' }
  // Complete customer documents can exceed CDP's object nesting budget. Only
  // the carrier changes; the exact same config is parsed inside the owned main.
  if (typeof config === 'string') config = JSON.parse(config)
  const http = process.getBuiltinModule('http'), fs = process.getBuiltinModule('fs')
  const path = process.getBuiltinModule('path'), crypto = process.getBuiltinModule('crypto')
  const { Buffer } = process.getBuiltinModule('buffer')
  const same = (left, right) => typeof left === 'string' && typeof right === 'string'
    && path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
  if (process.pid !== config.pid || process.env.AILY_APPDATA_PATH !== config.appData
    || !path.isAbsolute(config.project) || !/[/\\]aily-project[/\\]dev-tests[/\\]/i.test(config.project)
    || !same(fs.realpathSync(config.project), config.project) || !Number.isSafeInteger(config.port)
    || config.operation !== 'blocks_tidy' || !config.previousGeneration || !Array.isArray(config.previousDocument?.pages))
    throw Error('Save transport fault requires the exact owned physical project, host and operation')
  if (globalThis.__ailyNativeSaveObservationFault) throw Error('Do not install another save transport fault')
  const protocolVersion = config.receiptVersion ?? 1
  if (![1, 2].includes(protocolVersion) || config.observationOnly && (protocolVersion !== 2 || typeof config.observedRequestId !== 'string'
    || !Number.isSafeInteger(config.originalTargetPid))) throw Error('Invalid original publication observation fixture')
  const matches = process._getActiveHandles().filter(value => value instanceof http.Server && value.address()?.port === config.port)
  if (matches.length !== 1) return { available: false, reason: 'exact_owned_cli_server_unavailable' }
  const server = matches[0], originalEmit = server.emit
  const hash = bytes => 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex')
  const roots = document => [...document.pages.flatMap(page => page.content?.blocks?.blocks ?? []), ...(document.sharedModel?.procedureBlocks ?? [])]
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
  const withoutLayout = document => { const copy = JSON.parse(JSON.stringify(document)); for (const root of roots(copy)) { delete root.x; delete root.y }; return canonical(copy) }
  const state = { available: true, armed: !config.observationOnly, requestId: config.observedRequestId ?? null, commands: [], terminals: [], drops: 0,
    delegatedResponses: 0, failures: [], unverifiedTerminalReplies: [], authenticatedHandlerReplaced: false, discoveryRewritten: false,
    observationPaused: false }
  let pauseObservation = config.observationOnly === true && config.pauseObservation === true, heldEnd
  let proofStat, proofHash
  const proofParent = config.proofFile ? path.dirname(config.proofFile) : null
  const parentStat = proofParent ? fs.lstatSync(proofParent) : null
  if (config.proofFile && (!path.isAbsolute(config.proofFile) || !same(proofParent, path.dirname(config.project))
    || !/^r1-native-fault-[0-9]+\.json$/.test(path.basename(config.proofFile)) || !parentStat.isDirectory()
    || parentStat.isSymbolicLink() || !same(fs.realpathSync(proofParent), proofParent) || fs.existsSync(config.proofFile)))
    throw Error('Fault proof must be a new file in the exact owned suite')
  const publishProof = () => {
    if (!config.proofFile) return
    const parent = fs.lstatSync(proofParent)
    if (parent.dev !== parentStat.dev || parent.ino !== parentStat.ino || parent.isSymbolicLink())
      throw Error('Fault proof parent changed')
    const current = fs.lstatSync(config.proofFile, { throwIfNoEntry: false })
    if (proofStat ? !current || !current.isFile() || current.isSymbolicLink() || current.nlink !== 1
      || current.dev !== proofStat.dev || current.ino !== proofStat.ino || hash(fs.readFileSync(config.proofFile)) !== proofHash : current)
      throw Error('Fault proof ownership changed')
    const bytes = JSON.stringify(state), temp = config.proofFile + '.' + crypto.randomUUID() + '.tmp'
    try { fs.writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 }); fs.renameSync(temp, config.proofFile) }
    finally { try { fs.unlinkSync(temp) } catch (error) { if (error.code !== 'ENOENT') throw error } }
    proofStat = fs.lstatSync(config.proofFile); proofHash = hash(bytes)
  }
  const verify = body => {
    const receipt = body?.saveReceipt, result = body?.result
    const output = result?.projectionReceipt ?? result?.receipt, binding = output?.output?.binding
    if (body?.ok !== true || receipt?.version !== protocolVersion || receipt.requestId !== state.requestId
      || receipt.operation !== config.operation || !same(receipt.project, config.project) || receipt.state !== 'completed'
      || result?.ok !== true || result.absPersistence?.verified !== true || result.finalValidation?.ok !== true
      || output?.persisted !== true || result.generation !== binding?.generation
      || !same(binding?.scope?.projectKey, config.project)) return null
    if (protocolVersion === 2) {
      const observed = body.publicationObservation, identity = observed?.attachment?.identity
      // Independent physical oracle: Electron path stat may report dev=0 on
      // Windows, while a directory handle and the SDK agree on the device.
      // Do not call the product attachment helper or accept zero as a wildcard.
      const before = fs.lstatSync(config.project, { bigint: true })
      if (!before.isDirectory() || before.isSymbolicLink() || !same(fs.realpathSync(config.project), config.project))
        throw Error('The native publication project is not the owned physical directory')
      const fd = fs.openSync(config.project, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0))
      let physical
      try {
        physical = fs.fstatSync(fd, { bigint: true })
        const after = fs.lstatSync(config.project, { bigint: true })
        if (!physical.isDirectory() || !after.isDirectory() || after.isSymbolicLink()
          || !same(fs.realpathSync(config.project), config.project)
          || before.ino !== physical.ino || before.birthtimeNs !== physical.birthtimeNs
          || after.ino !== physical.ino || after.birthtimeNs !== physical.birthtimeNs
          || before.dev !== 0n && before.dev !== physical.dev || after.dev !== 0n && after.dev !== physical.dev)
          throw Error('The native publication physical project changed during handle capture')
      } finally { fs.closeSync(fd) }
      if (observed?.version !== 1 || observed.durable !== true || observed.requestId !== state.requestId
        || observed.operation !== config.operation || observed.current !== true
        || observed.executor?.hostPid !== (config.originalTargetPid ?? config.pid) || observed.observer?.hostPid !== config.pid
        || !same(observed.attachment?.root, config.project) || identity?.dev !== String(physical.dev)
        || identity.ino !== String(physical.ino) || identity.birthtimeNs !== String(physical.birthtimeNs)
        || output.version !== 2 || output.requestId !== state.requestId || output.validation?.scope !== 'generation-projection') return null
    }
    if (binding.generation === config.previousGeneration) throw Error('The real tidy did not publish a new native generation')
    for (const [name, key] of [['project.abi', 'abiHash'], ['project.abs', 'absHash'], ['project.abs.map.json', 'mapHash']])
      if (hash(fs.readFileSync(path.join(config.project, name))) !== binding[key]) throw Error('The native save reply no longer matches its three physical mirrors')
    const map = JSON.parse(fs.readFileSync(path.join(config.project, 'project.abs.map.json'), 'utf8'))
    if (map.generation !== binding.generation || map.baseAbsHash !== binding.absHash) throw Error('The native save map is inconsistent')
    if (!/^[A-Za-z0-9_-]{1,96}$/.test(binding.generation)) throw Error('Invalid native generation identity')
    const pointer = JSON.parse(fs.readFileSync(path.join(config.project, '.aily/abs-sync/committed.json'), 'utf8'))
    if (pointer.schemaVersion !== 1 || pointer.generation !== binding.generation
      || pointer.hash !== hash(fs.readFileSync(path.join(config.project, '.aily/abs-sync/baselines', binding.generation + '.json'))))
      throw Error('The native save has no exact checksum-bound COMMITTED generation pointer')
    const currentDocument = JSON.parse(fs.readFileSync(path.join(config.project, 'project.abi'), 'utf8'))
    if (JSON.stringify(withoutLayout(currentDocument)) !== JSON.stringify(withoutLayout(config.previousDocument)))
      throw Error('The actual tidy changed persisted program data beyond root layout')
    const previousRoots = new Map(roots(config.previousDocument).map(root => [root.id, root]))
    const changedRoots = roots(currentDocument).filter(root => previousRoots.get(root.id)?.x !== root.x || previousRoots.get(root.id)?.y !== root.y).length
    if (!changedRoots) throw Error('The actual tidy did not change any persisted root coordinates')
    return { requestId: receipt.requestId, operation: receipt.operation, state: receipt.state,
      generation: binding.generation, binding, projectSaved: result.projectSaved ?? null,
      abiSaved: true, absMirrored: true, mapPublished: true, threePhysicalHashesVerified: true,
      committedPointerVerified: true, committedPointer: { generation: pointer.generation, hash: pointer.hash },
      layout: { changedRoots, allOtherPersistedDataExactlyPreserved: true } }
  }
  const hook = function (event, ...args) {
    if (event !== 'request') return originalEmit.call(this, event, ...args)
    const [request, response] = args
    if (request.method !== 'POST' || request.url !== '/command') return originalEmit.call(this, event, ...args)
    let command, size = 0, chunks = []
    request.on('data', chunk => { size += chunk.length; if (size <= 1024 * 1024) chunks.push(chunk); else chunks = [] })
    request.once('end', () => {
      if (!chunks.length || size > 1024 * 1024) return
      let body
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return }
      const save = body.params?.saveRequest, operation = body.operation
      if (body.action !== 'blockly-live-operation' || !same(body.path, config.project)
        || save?.version !== protocolVersion || save.operation !== config.operation
        || !['blocks_tidy', 'project_save_status', 'project_publication_status'].includes(operation)
        || typeof save.requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(save.requestId)) return
      if (operation === 'blocks_tidy') {
        if (config.observationOnly) state.failures.push({ code: 'cold-reader-started-another-save' })
        if (state.requestId && state.requestId !== save.requestId) state.failures.push({ code: 'save-started-with-another-identity' })
        state.requestId ??= save.requestId
      }
      if (save.requestId !== state.requestId) return
      command = { operation, requestId: save.requestId, at: Date.now(), requestBytes: size,
        requestHash: hash(Buffer.concat(chunks)), dropped: false, responseBytes: null }
      state.commands.push(command)
      chunks = []
    })
    const originalEnd = response.end
    response.end = function (...endArgs) {
      if (!command) return originalEnd.apply(this, endArgs)
      const raw = endArgs[0]
      command.responseBytes = typeof raw === 'string' ? Buffer.byteLength(raw) : Buffer.isBuffer(raw) ? raw.length : null
      let body, terminal
      try {
        if (command.responseBytes !== null && command.responseBytes <= 8 * 1024 * 1024)
          body = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : raw)
        terminal = verify(body)
      } catch (error) {
        state.failures.push({ code: 'native-save-reply-verification-failed', message: String(error.message).slice(0, 250) })
      }
      if (!terminal && body?.saveReceipt?.state === 'completed') state.unverifiedTerminalReplies.push({
        requestId: body.saveReceipt.requestId, operation: body.saveReceipt.operation, resultOk: body.result?.ok,
        resultKeys: body.result && typeof body.result === 'object' ? Object.keys(body.result) : [],
        hasProjectionReceipt: !!body.result?.projectionReceipt, hasReceipt: !!body.result?.receipt,
        absPersistenceVerified: body.result?.absPersistence?.verified ?? null, finalValidationOk: body.result?.finalValidation?.ok ?? null })
      if (terminal) state.terminals.push({ ...terminal, responseHash: hash(raw), at: Date.now() })
      if (pauseObservation && terminal && command.operation === 'project_publication_status') {
        if (heldEnd) throw Error('Only the single original readonly response may be paused')
        state.observationPaused = true
        heldEnd = () => { state.observationPaused = false; state.delegatedResponses++
          const result = originalEnd.apply(response, endArgs); publishProof(); return result }
        publishProof(); return response
      }
      if (state.armed && terminal) { command.dropped = true; state.drops++; response.destroy()
        command.responseDestroyed = response.destroyed === true; publishProof(); return response }
      state.delegatedResponses++
      const result = originalEnd.apply(this, endArgs); publishProof(); return result
    }
    return originalEmit.call(this, event, ...args)
  }
  server.emit = hook
  globalThis.__ailyNativeSaveObservationFault = {
    snapshot: () => JSON.parse(JSON.stringify(state)),
    release: () => { if (!state.drops || !state.terminals.length) throw Error('Release only after a real verified native save reply was lost'); state.armed = false },
    releaseObservation: () => { if (!heldEnd) throw Error('No verified original readonly response is paused')
      const release = heldEnd; heldEnd = undefined; pauseObservation = false; release(); return true },
    restore: () => { if (server.emit !== hook) throw Error('Save transport hook ownership changed')
      if (heldEnd) { const release = heldEnd; heldEnd = undefined; pauseObservation = false; release() }
      server.emit = originalEmit; return state.drops }
  }
  publishProof()
  return { available: true, port: config.port, operation: config.operation }
}

export function assertNoNativeSaveModelFailures(failures) {
  if (failures.length) throw Object.assign(new Error('Local deterministic provider setup failed: ' + failures[0].message), { code: 'TEST_PROVIDER_SETUP_FAILED' })
}

/** A provider retry/create is not a second user turn or a cold restart. */
export function assertNativeSaveContinuationPhase({ coldReopened, actualUserTurns, providerTurn }) {
  if (coldReopened !== true || actualUserTurns !== 2 || providerTurn !== 1)
    throw Object.assign(new Error('Continued B requires the actual cold reopened session and its second real UI user turn'), { code: 'TEST_CONTINUATION_PHASE_INVALID' })
}
