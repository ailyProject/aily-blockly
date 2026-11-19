import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { environmentCreationKey, assertCapturedEnvironmentProcess } from './r2-environment-cleanup.mjs'

export function missingLibraryProjectionRequest(expectedAbiHash, requestId) {
  assert.match(expectedAbiHash, /^sha256:[a-f0-9]{64}$/)
  assert.match(requestId, /^[a-zA-Z0-9-]{16,80}$/)
  return { version: 2, requestId, expectedAbiHash, initialize: true, publish: true }
}

export function sanitizeMissingLibraryReply(value, secrets = []) {
  return JSON.parse(JSON.stringify(value, (key, item) => {
    if (/token|authorization|password|secret|credential/i.test(key)) return '[redacted]'
    if (typeof item === 'string') for (const secret of secrets.filter(Boolean)) item = item.replaceAll(secret, '[redacted]')
    return item
  }))
}

/** Same original-ID observation policy as recoverProjectInPlace: one start,
 * then only readonly observations after uncertain transport/native replies. */
export async function observeMissingLibraryRecovery({ requestId, send, deadline, now = Date.now,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const uncertain = value => !value || value.transportError === true || [
    'PROJECT_RECOVERY_PENDING', 'PROJECT_RECOVERY_UNKNOWN', 'PROJECT_RECOVERY_REQUEST_UNKNOWN',
    'PROJECT_RECOVERY_RECEIPT_UNCERTAIN', 'RENDERER_RESPONSE_TIMEOUT', 'RENDERER_REQUEST_CANCELLED',
  ].includes(String(value.code ?? value.errorCode))
  const responses = []
  const request = async observe => {
    const remaining = deadline - now()
    if (remaining <= 0) return { ok: false, code: 'PROJECT_RECOVERY_UNKNOWN' }
    let result
    try { result = await send({ version: 2, action: 'recover_project', requestId, ...(observe ? { observe: true } : {}) }, remaining) }
    catch (error) { result = { ok: false, transportError: true, error: error.message } }
    responses.push({ observe, result })
    return result
  }
  let result = await request(false)
  if (uncertain(result)) result = await request(true)
  for (let attempt = 1; uncertain(result) && attempt < 30 && now() < deadline; attempt++) {
    await wait(Math.min(1000, Math.max(0, deadline - now())))
    if (now() >= deadline) break
    result = await request(true)
  }
  return { result, responses, exhausted: uncertain(result) }
}

export function captureMissingLibraryProcessTree(all, originalMain) {
  const current = all.find(value => value.ProcessId === originalMain.ProcessId)
  assertCapturedEnvironmentProcess(current, originalMain)
  const captured = new Map([[current.ProcessId, current]])
  let changed
  do {
    changed = false
    for (const child of all) {
      const parent = captured.get(child.ParentProcessId)
      if (!parent || captured.has(child.ProcessId)) continue
      // A stale PPID is not ancestry after PID reuse. Compare both ends in the
      // same CIM snapshot before including a process in owned cleanup.
      if (environmentCreationKey(child.CreationDate) < environmentCreationKey(parent.CreationDate)) continue
      captured.set(child.ProcessId, child); changed = true
    }
  } while (changed)
  return [...captured.values()]
}

/** Test fixture preparation only, while the healthy project is closed. A used
 * but undeclared library reaches the actual missing-used-library dialog; a
 * missing declared dependency would be repaired earlier by startup reconcile. */
export async function prepareMissingLibraryLoadInput({ project, source, libraryName, blockType }) {
  assert.ok(path.isAbsolute(project) && path.isAbsolute(source))
  assert.match(libraryName, /^@aily-project\/lib-[\w.-]+$/)
  assert.equal((await fs.lstat(project)).isSymbolicLink(), false)
  assert.equal((await fs.realpath(project)).toLowerCase(), path.resolve(project).toLowerCase())
  assert.equal(JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8')).name, libraryName)
  const manifestFile = path.join(project, 'package.json'), manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'))
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) delete manifest[field]?.[libraryName]
  manifest.ailyBlocklyUsedLibraries = { ...manifest.ailyBlocklyUsedLibraries,
    [libraryName]: { version: `file:${source}`, localPath: source, blockTypes: [blockType], updatedAt: Date.now() } }
  await fs.writeFile(manifestFile, JSON.stringify(manifest, null, 2))
  for (const file of ['package-lock.json', 'npm-shrinkwrap.json']) {
    let lock
    try { lock = JSON.parse(await fs.readFile(path.join(project, file), 'utf8')) }
    catch (error) { if (error.code === 'ENOENT') continue; throw error }
    delete lock.dependencies?.[libraryName]
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) delete lock.packages?.['']?.[field]?.[libraryName]
    if (lock.packages) delete lock.packages[`node_modules/${libraryName}`]
    await fs.writeFile(path.join(project, file), JSON.stringify(lock, null, 2))
  }
  const installed = path.join(project, 'node_modules', libraryName)
  assert.equal((await fs.realpath(path.dirname(installed))).toLowerCase(), path.dirname(installed).toLowerCase())
  const leaf = await fs.lstat(installed)
  if (leaf.isSymbolicLink()) await fs.unlink(installed)
  else { assert.equal(leaf.isDirectory(), true); await fs.rm(installed, { recursive: true }) }
  return { libraryName, source, blockType, installed,
    usedLibraryRetained: true, dependencyDeclarationRemoved: true, onlyOwnedFixturePrepared: true }
}

/** Passive actual Main witness. The original methods execute unchanged. */
export function installMissingLibraryLoadWitness({ app }, config) {
  const node = process.getBuiltinModule, fs = node('fs'), path = node('path'), crypto = node('crypto')
  const hash = value => 'sha256:' + crypto.createHash('sha256').update(value).digest('hex')
  if (process.pid !== config.pid || process.env.AILY_APPDATA_PATH !== config.appData
    || !path.isAbsolute(config.project) || !/[/\\]aily-project[/\\]dev-tests[/\\]/i.test(config.project)
    || fs.realpathSync(config.project).toLowerCase() !== path.resolve(config.project).toLowerCase())
    throw Error('Missing-library witness requires the exact owned physical Main project')
  const require = node('module').createRequire(path.join(app.getAppPath(), 'package.json'))
  const { LibraryDependencies } = require('./electron/library-dependencies.js')
  const prototype = LibraryDependencies.prototype, prepare = prototype.prepareLocalSource, save = prototype.save
  const state = { sourcePreparations: [], completions: [], workerExecutions: [], failures: [], originalMethodsDelegated: true }
  const workers = new Map()
  const mirrors = () => Object.fromEntries(['project.abi', 'project.abs', 'project.abs.map.json', '.aily/abs-sync/committed.json'].map(file => {
    try { return [file, hash(fs.readFileSync(path.join(config.project, file)))] }
    catch (error) { if (error.code === 'ENOENT') return [file, null]; throw error }
  }))
  const same = root => path.resolve(root).toLowerCase() === path.resolve(config.project).toLowerCase()
  const prepareWrapper = function (root, request, assertCurrent) {
    if (!same(root) || request.localSource?.packageName !== config.libraryName) return prepare.apply(this, arguments)
    const owned = this.environment.owned.get(root)
    if (!owned || owned.record.requestId !== request.requestId) throw Error('No exact original environment owner before local source mutation')
    const checkpointFile = path.join(owned.folder, 'checkpoint.json'), bytes = fs.readFileSync(checkpointFile), envelope = JSON.parse(bytes)
    if (envelope.hash !== hash(JSON.stringify(envelope.payload)) || envelope.payload.requestId !== request.requestId)
      throw Error('The actual pre-mutation checkpoint is not durable and exact')
    if (!workers.has(this)) {
      const original = this.run, wrapped = function (project, request) {
        if (same(project)) state.workerExecutions.push({ requestId: this.environment.owned.get(project)?.record.requestId,
          kind: request.materializeSources ? 'materialize-sources' : request.save === true ? 'npm-save' : 'npm-reify', at: Date.now() })
        return original.apply(this, arguments)
      }
      workers.set(this, { original, wrapped }); this.run = wrapped
    }
    const before = mirrors(), result = prepare.apply(this, arguments), after = mirrors()
    if (JSON.stringify(before) !== JSON.stringify(after)) throw Error('Local source import changed Program mirrors')
    state.sourcePreparations.push({ requestId: request.requestId, checkpointFile, checkpointHash: hash(bytes),
      checkpointBeforeSideEffects: true, before, after, attachment: envelope.payload.attachment, executor: envelope.payload.executor })
    return result
  }
  const saveWrapper = async function (root) {
    const result = await save.apply(this, arguments)
    if (same(root)) for (const prepared of state.sourcePreparations) {
      const environment = this.environment.observe(root, prepared.requestId)
      if (environment.status === 'completed' && !state.completions.some(value => value.requestId === prepared.requestId)) {
        const after = mirrors()
        if (JSON.stringify(prepared.before) !== JSON.stringify(after)) throw Error('Environment completion changed Program mirrors')
        state.completions.push({ requestId: prepared.requestId, environment, after })
      }
    }
    return result
  }
  prototype.prepareLocalSource = prepareWrapper; prototype.save = saveWrapper
  globalThis.__r2MissingLibraryLoadWitness = {
    snapshot: () => JSON.parse(JSON.stringify(state)),
    restore() {
      if (prototype.prepareLocalSource !== prepareWrapper || prototype.save !== saveWrapper) throw Error('Missing-library witness ownership changed')
      for (const [owner, entry] of workers) { if (owner.run !== entry.wrapped) throw Error('Missing-library worker witness ownership changed'); owner.run = entry.original }
      prototype.prepareLocalSource = prepare; prototype.save = save
    },
  }
  return { available: true, pid: process.pid }
}

export function assertMissingLibraryLoadWitness(witness) {
  assert.deepEqual(witness.failures, [])
  assert.equal(witness.originalMethodsDelegated, true)
  assert.equal(witness.sourcePreparations.length, 1, 'The known local source is installed once')
  assert.equal(witness.completions.length, 1)
  const before = witness.sourcePreparations[0], completed = witness.completions[0]
  assert.match(before.requestId, /^env1-[a-f0-9-]{36}$/i)
  assert.equal(before.checkpointBeforeSideEffects, true)
  assert.equal(completed.requestId, before.requestId)
  assert.equal(completed.environment.requestId, before.requestId)
  assert.equal(completed.environment.status, 'completed')
  assert.equal(completed.environment.current, true)
  assert.equal(completed.environment.candidateApplied, false)
  assert.deepEqual(witness.workerExecutions.map(value => value.kind), ['npm-reify', 'materialize-sources', 'npm-save'],
    'One original Main installation includes its existing materialization and save phases, not a second mutate')
  assert.ok(witness.workerExecutions.every(value => value.requestId === before.requestId))
  assert.deepEqual(before.before, before.after)
  assert.deepEqual(before.before, completed.after)
  for (const hash of Object.values(before.before)) assert.match(hash, /^sha256:[a-f0-9]{64}$/)
  return before.requestId
}
