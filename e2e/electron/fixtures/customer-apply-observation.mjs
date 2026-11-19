import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { verifyCustomerApplyObservationTrace } from './customer-apply-observation-trace.mjs'

const hash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex')
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
const inside = (root, file) => { const relative = path.relative(root, file)
  return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) }
const mirrors = project => Promise.all(['project.abi', 'project.abs', 'project.abs.map.json']
  .map(name => fs.readFile(path.join(project, name))))

/** Transparent local transport fault. All request/authentication/result bytes
 * originate with the real SDK/host. Only downstream responses are dropped. */
export async function createCustomerApplyObservationProxy(descriptor, project, candidateHash) {
  const commands = [], failures = [], active = new Set()
  let faultEnabled = true, requestId, committed = false
  const server = http.createServer((request, response) => {
    void (async () => {
      const chunks = []; let size = 0
      for await (const chunk of request) { size += chunk.length; assert.ok(size <= 4 * 1024 * 1024); chunks.push(chunk) }
      const body = Buffer.concat(chunks), input = body.length ? JSON.parse(body.toString()) : undefined
      const operation = input?.operation, action = input?.params?.action
      const apply = input?.action === 'blockly-live-operation' && operation === 'abs_apply'
      const observe = input?.action === 'blockly-live-operation' && operation === 'abs_recovery' && action === 'observe_apply'
      const readCandidate = input?.action === 'blockly-live-operation' && operation === 'abs_recovery' && action === 'read_candidate'
      if (apply || observe || readCandidate) {
        assert.ok(same(input.path, project), 'The transport fault can address only the owned project')
        const id = input.params?.requestId ?? input.params?.validation?.requestId
        if (apply) { assert.equal(requestId, undefined, 'An uncertain apply must never be resent'); requestId = id }
        if (observe) assert.equal(id, requestId)
        commands.push({ operation, ...(action ? { action } : {}), ...(id ? { requestId: id } : {}),
          ...(readCandidate ? { recordHash: input.params.recordHash } : {}), dropped: false })
      }
      const drop = faultEnabled && (apply || observe)
      const trace = commands.at(-1)
      const upstream = http.request({ host: '127.0.0.1', port: descriptor.port, method: request.method,
        path: request.url, headers: { ...request.headers, host: `127.0.0.1:${descriptor.port}` } }, reply => {
        const captured = []; let replyBytes = 0
        if (!drop) response.writeHead(reply.statusCode, reply.headers)
        reply.on('data', chunk => {
          if (drop) { replyBytes += chunk.length; if (replyBytes <= 8 * 1024 * 1024) captured.push(chunk) }
          else if (!response.destroyed) response.write(chunk)
        })
        reply.once('end', () => {
          if (drop) {
            if (trace) trace.dropped = true
            if (apply) {
              try {
                const result = JSON.parse(Buffer.concat(captured).toString())
                assert.equal(result.publication?.status, 'COMMITTED')
                assert.equal(result.receipt?.requestId, requestId)
                assert.equal(result.receipt?.candidate?.hash, candidateHash)
                committed = true
              } catch (error) { failures.push({ phase: 'real-apply-reply', message: String(error.message).slice(0, 500) }) }
            }
            response.destroy()
          } else if (!response.destroyed) response.end()
        })
        reply.once('error', error => { failures.push({ phase: 'upstream-reply', code: error.code }); response.destroy() })
      })
      active.add(upstream); upstream.once('close', () => active.delete(upstream))
      upstream.once('error', error => { failures.push({ phase: 'upstream-request', code: error.code }); response.destroy() })
      // Disconnecting the SDK must not cancel the real native operation.
      upstream.end(body)
    })().catch(error => { failures.push({ phase: 'proxy', message: String(error.message).slice(0, 500) }); response.destroy() })
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return { port: server.address().port,
    releaseObservation() { assert.ok(committed, 'Only a genuine committed host reply can release this fault'); faultEnabled = false },
    proof: () => ({ requestId, realNativeCommitObserved: committed, commands: structuredClone(commands), failures: structuredClone(failures) }),
    async close() {
      const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      // Close only downstream connections. Never cancel an accepted upstream
      // native command; the outer suite owns its host process on failure.
      server.closeAllConnections(); await closed
    } }
}

/** Lose a real native apply reply, then recover its original outcome after
 * deleting only this SDK process's verified disposable candidate cache. */
export async function runCustomerApplyObservation({ project, suite, home, agentRoot, hostPid, harness, call, phase,
  generation, absPath, candidateHash, evidence }) {
  assert.ok(inside(suite, project) && inside(suite, home))
  const sourceDescriptor = path.join(home, '.aily-blockly/cli-bridge', hostPid + '.json')
  const descriptor = JSON.parse(await fs.readFile(sourceDescriptor, 'utf8'))
  assert.equal(descriptor.pid, hostPid)
  assert.ok(Number.isSafeInteger(descriptor.port) && descriptor.port > 0)
  const proxyHome = path.join(suite, 'apply-observation-home-' + randomUUID())
  const copiedDescriptor = path.join(proxyHome, '.aily-blockly/cli-bridge', hostPid + '.json')
  await fs.mkdir(path.dirname(copiedDescriptor), { recursive: true })
  const proxy = await createCustomerApplyObservationProxy(descriptor, project, candidateHash)
  await fs.writeFile(copiedDescriptor, JSON.stringify({ ...descriptor, port: proxy.port }), { flag: 'wx', mode: 0o600 })
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  try {
    Object.assign(process.env, { HOME: proxyHome, USERPROFILE: proxyHome })
    assert.ok(same(os.homedir(), proxyHome), 'SDK discovery must use only the copied private descriptor')
    await phase('lose-real-apply-reply-and-original-request-observations')
    const unknown = await call('abs_apply', { project, generation, absPath })
    assert.equal(unknown.structured?.ok, false, 'The transport fault must reach the real SDK uncertainty path')
    assert.equal(unknown.structured?.publication?.status, 'UNKNOWN')
    assert.equal(unknown.structured?.applicationObservation?.resultKnown, false)
    const pending = harness.guard.snapshot(project), proof = proxy.proof()
    assert.equal(pending?.applicationRequestId, proof.requestId)
    assert.equal(pending.retainedCandidate?.hash, candidateHash)
    assert.equal(pending.retainedCandidateBackup?.hash, candidateHash)
    assert.equal(proof.realNativeCommitObserved, true)
    assert.deepEqual(proof.failures, [])
    assert.equal(proof.commands.filter(command => command.operation === 'abs_apply').length, 1)
    assert.ok(proof.commands.some(command => command.action === 'observe_apply' && command.dropped))

    const { ensureToolOutputDirectory } = await import(pathToFileURL(path.join(agentRoot, 'dist/tools/tool-output-store.js')).href)
    const artifact = pending.retainedCandidate, directory = ensureToolOutputDirectory()
    assert.ok(same(path.dirname(artifact.path), directory), 'Delete only this actual SDK process output artifact')
    assert.match(path.basename(directory), /^aily-tool-output-[A-Za-z0-9_-]+$/)
    assert.equal(path.basename(artifact.path), `abs-recovery-candidate-${candidateHash.slice(7, 31)}.txt`)
    const parent = await fs.lstat(directory), stat = await fs.lstat(artifact.path)
    assert.ok(parent.isDirectory() && !parent.isSymbolicLink() && stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1)
    assert.equal(stat.size, artifact.bytes)
    assert.equal(hash(await fs.readFile(artifact.path)), candidateHash)
    const before = await mirrors(project)
    await fs.unlink(artifact.path)
    const cacheLossCommandIndex = proxy.proof().commands.length
    proxy.releaseObservation()
    await phase('observe-original-commit-after-exact-candidate-cache-loss')
    const observed = await call('project_recover', { project, action: 'observe_apply', requestId: proof.requestId })
    assert.equal(observed.isError, false, observed.text?.slice(0, 1800))
    assert.equal(observed.structured?.ok, true)
    assert.equal(observed.structured.applyVerification?.ok, true)
    assert.equal(observed.structured.receipt?.candidate?.hash, candidateHash)
    assert.equal(observed.structured.receipt?.requestId, proof.requestId)
    assert.equal(hash(await fs.readFile(artifact.path)), candidateHash, 'The exact source must be restored from its project backup')
    assert.deepEqual(await mirrors(project), before, 'Observation cannot reapply or alter the native publication')
    const final = proxy.proof()
    assert.deepEqual(final.failures, [])
    const ordering = verifyCustomerApplyObservationTrace(final.commands, { requestId: proof.requestId,
      backupRecordHash: pending.retainedCandidateBackup.recordHash })
    assert.ok(ordering.firstObservationAfterCacheLoss >= cacheLossCommandIndex)
    evidence.applyObservationFault = { actualSdkAndHost: true, fabricatedResults: false, originalRequestId: proof.requestId,
      realNativeCommitObserved: true, originalApplyDispatches: 1, exactOwnedCacheRemoved: true,
      candidateRestoredFromProjectBackup: true, mirrorsUnchangedDuringObservation: true,
      candidateHash, cacheLossCommandIndex, ordering, commands: final.commands, failures: final.failures }
    evidence.cases.push({ name: 'real-unknown-apply-cache-loss-original-observation-no-reapply', ok: true })
    return observed.structured
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    await proxy.close()
    await fs.unlink(copiedDescriptor)
    const current = JSON.parse(await fs.readFile(sourceDescriptor, 'utf8'))
    for (const key of ['pid', 'port', 'token']) assert.equal(current[key], descriptor[key], 'The real host discovery identity must remain unchanged')
  }
}
