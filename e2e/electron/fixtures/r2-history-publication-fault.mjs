/** Transparent response-only fault for the exact owned CLI server. No handler,
 * auth, descriptor, native result, publication bytes or request is replaced. */
export function installHistoryPublicationFault(_electron, config) {
  if (typeof config === 'string') config = JSON.parse(config)
  const process = globalThis.process, fs = process.getBuiltinModule('fs'), http = process.getBuiltinModule('http'),
    path = process.getBuiltinModule('path'), crypto = process.getBuiltinModule('crypto'), { Buffer } = process.getBuiltinModule('buffer')
  const same = (a, b) => typeof a === 'string' && typeof b === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
  if (process.pid !== config.pid || process.env.AILY_APPDATA_PATH !== config.appData || !same(fs.realpathSync(config.project), config.project) ||
    !/[/\\]aily-project[/\\]dev-tests[/\\]/i.test(config.project) || !Array.isArray(config.expectedDocument?.pages))
    throw Error('History fault requires the exact owned project, process and expected full document')
  if (globalThis.__ailyR2HistoryFault) throw Error('History transport observer already installed')
  const servers = process._getActiveHandles().filter(value => value instanceof http.Server && value.address()?.port === config.port)
  if (servers.length !== 1) return { available: false, reason: 'exact-owned-cli-server-not-found' }
  const server = servers[0], originalEmit = server.emit, sha = bytes => 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex')
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
  const state = { available: true, armed: config.dropTerminal === true, requestId: config.requestId ?? null, commands: [],
    drops: 0, failures: [], terminals: [], handlerReplaced: false, descriptorRewritten: false }
  const write = () => {
    if (!config.proofFile) return
    if (!same(path.dirname(config.proofFile), path.dirname(config.project)) || !/^r2-history-fault-[01]\.json$/.test(path.basename(config.proofFile)))
      throw Error('Fault proof must remain in its exact owned suite')
    const temporary = config.proofFile + '.' + crypto.randomUUID() + '.tmp'
    try { fs.writeFileSync(temporary, JSON.stringify(state), { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, config.proofFile) }
    finally { try { fs.unlinkSync(temporary) } catch (error) { if (error.code !== 'ENOENT') throw error } }
  }
  function terminal(body, command) {
    const save = body?.saveReceipt, result = body?.result, reference = body?.historyPublication, observed = body?.publicationObservation,
      projection = result?.projectionReceipt, binding = projection?.output?.binding
    if (body?.ok !== true || save?.version !== 2 || save.operation !== 'history_restore' || save.state !== 'completed' ||
      save.requestId !== command.requestId || !same(save.project, config.project) || reference?.version !== 1 ||
      reference.requestId !== command.requestId || reference.id !== command.historyId ||
      JSON.stringify(canonical(reference.candidate)) !== JSON.stringify(canonical(command.candidate)) ||
      result?.publication?.status !== 'COMMITTED' || result?.absPersistence?.verified !== true || result?.finalValidation?.ok !== true ||
      projection?.version !== 2 || projection.requestId !== command.requestId || projection.persisted !== true ||
      projection.validation?.scope !== 'generation-projection' || !same(binding?.scope?.projectKey, config.project) ||
      observed?.version !== 1 || observed.durable !== true || observed.current !== true || observed.operation !== 'history_restore' ||
      observed.requestId !== command.requestId || observed.executor?.hostPid !== (config.originalTargetPid ?? config.pid) ||
      observed.observer?.hostPid !== config.pid) return null
    const before = fs.lstatSync(config.project, { bigint: true }), fd = fs.openSync(config.project, fs.constants.O_RDONLY)
    let physical
    try {
      physical = fs.fstatSync(fd, { bigint: true }); const after = fs.lstatSync(config.project, { bigint: true })
      if (!before.isDirectory() || before.isSymbolicLink() || !after.isDirectory() || after.isSymbolicLink() ||
        before.ino !== physical.ino || after.ino !== physical.ino || before.birthtimeNs !== physical.birthtimeNs || after.birthtimeNs !== physical.birthtimeNs ||
        before.dev !== 0n && before.dev !== physical.dev || after.dev !== 0n && after.dev !== physical.dev) throw Error('Physical root changed')
    } finally { fs.closeSync(fd) }
    const identity = observed.attachment?.identity
    if (!same(observed.attachment?.root, config.project) || identity?.dev !== String(physical.dev) || identity.ino !== String(physical.ino) || identity.birthtimeNs !== String(physical.birthtimeNs))
      throw Error('Original publication attachment is not this physical root')
    for (const [name, key] of [['project.abi','abiHash'], ['project.abs','absHash'], ['project.abs.map.json','mapHash']])
      if (sha(fs.readFileSync(path.join(config.project, name))) !== binding[key]) throw Error('Original receipt differs from a physical mirror')
    const pointer = JSON.parse(fs.readFileSync(path.join(config.project, '.aily/abs-sync/committed.json'), 'utf8')),
      baseline = fs.readFileSync(path.join(config.project, '.aily/abs-sync/baselines', pointer.generation + '.json'))
    if (pointer.generation !== binding.generation || pointer.hash !== sha(baseline)) throw Error('COMMITTED pointer differs from original receipt')
    const document = JSON.parse(fs.readFileSync(path.join(config.project, 'project.abi'), 'utf8'))
    if (JSON.stringify(canonical(document)) !== JSON.stringify(canonical(config.expectedDocument))) throw Error('History publication did not preserve the complete expected document')
    return { requestId: command.requestId, executorPid: observed.executor.hostPid, observerPid: observed.observer.hostPid,
      generation: binding.generation, binding, completeDocumentVerified: true, physicalMirrorsVerified: true, inputDigest: reference.inputDigest }
  }
  function hook(event, ...args) {
    if (event !== 'request') return originalEmit.call(this, event, ...args)
    const [request, response] = args
    if (request.method !== 'POST' || request.url !== '/command') return originalEmit.call(this, event, ...args)
    let command, size = 0, chunks = []
    request.on('data', chunk => { size += chunk.length; if (size <= 128 * 1024 * 1024) chunks.push(chunk); else chunks = [] })
    request.once('end', () => {
      let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return }
      const params = body.params
      if (body.action !== 'blockly-live-operation' || body.operation !== 'abs_recovery' || !same(body.path, config.project) ||
        !['history_publish','history_observe'].includes(params?.action) || !/^pub2-[0-9a-f-]{36}$/i.test(params.requestId ?? '')) return
      if (params.action === 'history_publish') {
        if (config.readOnly) state.failures.push('Cold reader started a new native history publication')
        if (state.requestId && state.requestId !== params.requestId) state.failures.push('History publication changed its original request ID')
        state.requestId ??= params.requestId
      }
      if (params.requestId !== state.requestId) return
      command = { action: params.action, requestId: params.requestId, historyId: params.history?.id, candidate: params.history?.candidate,
        originalTargetPid: params.originalTargetPid ?? null, at: Date.now(), dropped: false }
      state.commands.push(command); chunks = []
    })
    const end = response.end
    response.end = function (...args) {
      if (!command) return end.apply(this, args)
      let proof
      try { proof = terminal(JSON.parse(Buffer.isBuffer(args[0]) ? args[0].toString('utf8') : args[0]), command) }
      catch (error) { state.failures.push(String(error.message)); write() }
      if (proof) state.terminals.push({ ...proof, at: Date.now() })
      if (proof && state.armed) { command.dropped = true; state.drops++; response.destroy(); command.responseDestroyed = response.destroyed; write(); return response }
      const value = end.apply(this, args); write(); return value
    }
    return originalEmit.call(this, event, ...args)
  }
  server.emit = hook
  globalThis.__ailyR2HistoryFault = { snapshot: () => structuredClone(state), restore() { if (server.emit !== hook) throw Error('History observer ownership changed'); server.emit = originalEmit; return structuredClone(state) } }
  write()
  return { available: true }
}
