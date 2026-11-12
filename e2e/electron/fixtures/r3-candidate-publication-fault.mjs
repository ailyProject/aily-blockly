/** Executed inside the one owned packaged Main. Authentication, dispatch and
 * receipt bodies remain production code. Only verified terminal transport is
 * disconnected/held; this module cannot fabricate an application outcome. */
export function installR3CandidatePublicationFault(_electron, configuration) {
  if (typeof configuration === 'string') configuration = JSON.parse(configuration)
  const process = globalThis.process
  const http = process.getBuiltinModule('http'), fs = process.getBuiltinModule('fs'), path = process.getBuiltinModule('path')
  const crypto = process.getBuiltinModule('crypto'), { Buffer } = process.getBuiltinModule('buffer')
  const config = configuration, same = (a, b) => typeof a === 'string' && typeof b === 'string'
    && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
  if (process.pid !== config.pid || process.env.AILY_APPDATA_PATH !== config.appData
    || !path.isAbsolute(config.project) || !same(fs.realpathSync(config.project), config.project)
    || !/[/\\]aily-project[/\\]dev-tests[/\\]/i.test(config.project) || !Number.isSafeInteger(config.port))
    throw Error('Candidate fault requires the exact root-owned physical test Host')
  if (globalThis.__ailyR3CandidateFault) throw Error('A candidate fault is already installed')
  const servers = process._getActiveHandles().filter(value => value instanceof http.Server && value.address()?.port === config.port)
  if (servers.length !== 1) throw Error('The original owned CLI server is unavailable')
  const server = servers[0], originalEmit = server.emit, hash = bytes => 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex')
  const canonical = value => JSON.stringify((function sort(v) {
    return Array.isArray(v) ? v.map(sort) : v && typeof v === 'object'
      ? Object.fromEntries(Object.keys(v).sort().map(key => [key, sort(v[key])])) : v
  })(value))
  const state = { available: true, requestId: config.requestId ?? null, ref: config.ref ?? null,
    observationOnly: config.observationOnly === true, commands: [], terminals: [], failures: [], drops: 0, held: 0,
    authenticatedHandlerReplaced: false, receiptFabricated: false }
  let releaseHeld
  const verify = (body, command) => {
    if (body?.ok !== true || body.operation !== 'abs_apply' || body.publication?.status !== 'COMMITTED') return null
    const receipt = body.receipt, binding = receipt?.output?.binding
    if (receipt?.version !== 2 || receipt.requestId !== state.requestId || canonical(receipt.workingCandidate) !== canonical(state.ref)
      || receipt.validation?.ok !== true || receipt.validation.scope !== 'complete-generation' || !binding
      || !same(body.project, config.project) || !same(binding.scope?.projectKey, config.project)
      || body.requiresReload !== false || body.publication.generation !== binding.generation)
      throw Error('The real terminal does not identify the exact original candidate publication')
    if (command.operation === 'abs_recovery' && (body.applicationObservation?.version !== 1
      || body.applicationObservation.requestId !== state.requestId || body.applicationObservation.current !== true))
      throw Error('Cold observation does not prove the current original application')
    for (const [name, key] of [['project.abi', 'abiHash'], ['project.abs', 'absHash'], ['project.abs.map.json', 'mapHash']]) {
      const filename = path.join(config.project, name), stat = fs.lstatSync(filename)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || hash(fs.readFileSync(filename)) !== binding[key])
        throw Error('The original terminal does not bind its complete physical output: ' + name)
    }
    if (config.expectedDocument && canonical(JSON.parse(fs.readFileSync(path.join(config.project, 'project.abi'), 'utf8'))) !== canonical(config.expectedDocument))
      throw Error('The saved complete document differs from the expected original program')
    const committed = JSON.parse(fs.readFileSync(path.join(config.project, '.aily/abs-sync/committed.json'), 'utf8'))
    if (committed.generation !== binding.generation) throw Error('The real committed pointer differs from its terminal')
    return { requestId: state.requestId, ref: state.ref, generation: binding.generation, evidence: receipt.output,
      observation: body.applicationObservation ?? null, candidate: receipt.candidate }
  }
  const hook = function (event, ...args) {
    if (event !== 'request') return originalEmit.call(this, event, ...args)
    const [request, response] = args
    if (request.method !== 'POST' || request.url !== '/command') return originalEmit.call(this, event, ...args)
    let command, chunks = [], size = 0
    request.on('data', chunk => { size += chunk.length; if (size <= 8 * 1024 * 1024) chunks.push(chunk); else chunks = [] })
    request.once('end', () => {
      if (!chunks.length || size > 8 * 1024 * 1024) return
      let payload; try { payload = JSON.parse(Buffer.concat(chunks)) } catch { return }
      if (payload.action !== 'blockly-live-operation' || !same(payload.path, config.project)) return
      const params = payload.params ?? {}, apply = payload.operation === 'abs_apply', observe = payload.operation === 'abs_recovery' && params.action === 'observe_apply'
      if (!apply && !observe) return
      if (apply) {
        if (state.observationOnly) state.failures.push({ code: 'cold-replayed-apply', at: Date.now() })
        state.requestId ??= params.requestId; state.ref ??= params.validation?.workingCandidate
      }
      if (params.requestId !== state.requestId) return
      if (apply && canonical(params.validation?.workingCandidate) !== canonical(state.ref))
        state.failures.push({ code: 'original-ref-changed' })
      command = { operation: payload.operation, action: params.action, requestId: params.requestId, at: Date.now(), requestHash: hash(Buffer.concat(chunks)) }
      state.commands.push(command)
    })
    const originalEnd = response.end
    response.end = function (...endArgs) {
      if (!command) return originalEnd.apply(this, endArgs)
      let terminal
      try {
        const raw = endArgs[0]
        if (typeof raw === 'string' || Buffer.isBuffer(raw)) terminal = verify(JSON.parse(raw), command)
      } catch (error) { state.failures.push({ code: 'unverified-terminal', message: error.message }) }
      if (terminal) state.terminals.push({ ...terminal, at: Date.now(), responseHash: hash(endArgs[0]) })
      if (terminal && !state.observationOnly) {
        if (command.operation === 'abs_apply') { state.drops++; response.destroy(); return response }
        state.held++; releaseHeld = () => originalEnd.apply(response, endArgs); return response
      }
      return originalEnd.apply(this, endArgs)
    }
    return originalEmit.call(this, event, ...args)
  }
  server.emit = hook
  globalThis.__ailyR3CandidateFault = { snapshot: () => JSON.parse(JSON.stringify(state)),
    restore: () => { if (server.emit !== hook) throw Error('Candidate fault ownership changed'); server.emit = originalEmit; releaseHeld?.() } }
  return { available: true, observationOnly: state.observationOnly, port: config.port }
}
