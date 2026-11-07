import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { summarizeOnlineComparison, singleFieldExpectedDocument, verifySealedComparisonBaseline } from './online-comparison.mjs'

test('comparison records actual model, sampled usage and first business action without double counting reasoning', () => {
  const snapshot = { messages: [{ role: 'user', content: [{ type: 'text', text: '编译' }] },
    { role: 'assistant', timestamp: 1100, content: [{ type: 'toolCall', name: 'read', arguments: { path: 'skills/verification.md' } }] },
    { role: 'assistant', timestamp: 1200, responseModel: 'glm-5.3-flash', responsePresetId: 'auto-fast',
      usage: { input: 10, output: 4, reasoning: 3, cacheRead: 20, totalTokens: 34 },
      content: [{ type: 'toolCall', name: 'tool_load' }] },
    { role: 'assistant', timestamp: 1300, responseModel: 'glm-5.3-flash', responsePresetId: 'auto-fast',
      usage: { input: 20, output: 5, reasoning: 4, cacheRead: 30, totalTokens: 55 },
      content: [{ type: 'toolCall', id: 'build-call', name: 'tool_invoke', arguments: { name: 'project_build' } }] }],
    entries: [{ type: 'custom', customType: 'aily.tool-timing', data: { toolCallId: 'build-call', startedAt: 1400 } }] }
  const result = summarizeOnlineComparison(snapshot, { startedAt: 1000, expectedModel: 'glm-5.3-flash', expectedPreset: 'auto-fast',
    businessActionNames: ['project_build'] })
  assert.equal(result.sampleCount, 2); assert.equal(result.usage.output, 9); assert.equal(result.usage.reasoning, 7)
  assert.equal(result.usage.totalTokens, 89); assert.equal(result.modelEvidenceValid, true)
  assert.deepEqual(result.firstBusinessAction, { id: 'build-call', requestPreparationAt: 1300, name: 'project_build', executionStartedAt: 1400 })
  assert.equal(result.firstBusinessActionAfterMs, 400); assert.equal(result.requestPreparationProxyAfterMs, 300)
  assert.equal(summarizeOnlineComparison({ messages: snapshot.messages }).firstBusinessActionAfterMs, null)
  snapshot.messages[3].responseModel = 'fallback-model'
  assert.equal(summarizeOnlineComparison(snapshot, { expectedModel: 'glm-5.3-flash' }).modelEvidenceValid, false)
  delete snapshot.messages[3].responseModel
  assert.equal(summarizeOnlineComparison(snapshot).modelEvidenceValid, false)
})

test('only the observed user stop with empty local abort is excluded; missing actual model still fails', () => {
  const local = { role: 'assistant', stopReason: 'error', errorMessage: 'This operation was aborted', content: [],
    usage: { input: 0, output: 0, totalTokens: 0 } }
  const real = { role: 'assistant', responseId: 'actual-response', responseModel: 'glm-5.3', responsePresetId: 'auto-max',
    usage: { input: 10, output: 1 }, content: [] }
  const snapshot = { messages: [real, local] }
  assert.equal(summarizeOnlineComparison(snapshot, { expectedModel: 'glm-5.3' }).modelEvidenceValid, false)
  const valid = summarizeOnlineComparison(snapshot, { expectedModel: 'glm-5.3', userStopObserved: true })
  assert.equal(valid.excludedProvenLocalAbortCount, 1); assert.equal(valid.sampleCount, 1); assert.equal(valid.modelEvidenceValid, true)
  delete real.responseModel
  assert.equal(summarizeOnlineComparison(snapshot, { userStopObserved: true }).modelEvidenceValid, false)
})

test('single-field expected document preserves full program and rejects ambiguous/missing target', () => {
  const original = { blocks: { blocks: [{ id: 'global', inputs: { A: { block: { id: 'probe', fields: { VALUE: 100 } } } } },
    { id: 'loop', extraState: { comments: 'retain' } }] } }
  const actual = singleFieldExpectedDocument(original, 'probe', 'VALUE', 100, 101)
  assert.equal(original.blocks.blocks[0].inputs.A.block.fields.VALUE, 100)
  assert.equal(actual.blocks.blocks[0].inputs.A.block.fields.VALUE, 101)
  assert.deepEqual(actual.blocks.blocks[1], original.blocks.blocks[1])
  assert.throws(() => singleFieldExpectedDocument(original, 'missing', 'VALUE', 100, 101))
  assert.throws(() => singleFieldExpectedDocument(original, 'probe', 'VALUE', 99, 101))
})

test('explicit sealed arm binds both manifests and rejects output tampering or a different host', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sealed-online-'))
  const chat = path.join(root, 'chat'), host = path.join(root, 'host'), receiptFile = path.join(root, 'receipt.json')
  const sha = value => createHash('sha256').update(value).digest('hex')
  try {
    await fs.mkdir(path.join(chat, 'runtime'), { recursive: true }); await fs.mkdir(path.join(host, 'resources'), { recursive: true })
    const build = { inputHash: 'old-input', outputHash: 'old-output' }, raw = JSON.stringify(build), asar = Buffer.from('sealed host')
    await fs.writeFile(path.join(chat, 'runtime/build-evidence.json'), raw)
    await fs.writeFile(path.join(host, 'resources/app.asar'), asar)
    await fs.writeFile(path.join(host, 'app.exe'), 'sealed exe')
    const chatInventory = { 'runtime/build-evidence.json': { bytes: Buffer.byteLength(raw), sha256: sha(raw) } }
    const hostInventory = { 'resources/app.asar': { bytes: asar.length, sha256: sha(asar) },
      'app.exe': { bytes: Buffer.byteLength('sealed exe'), sha256: sha('sealed exe') } }
    const receipt = { immutable: true, artifacts: [
      { kind: 'chat', target: chat, build, inventory: chatInventory, inventorySha256: sha(JSON.stringify(chatInventory)) },
      { kind: 'host', target: host, asarSha256: sha(asar), inventory: hostInventory, inventorySha256: sha(JSON.stringify(hostInventory)) }] }
    await fs.writeFile(receiptFile, JSON.stringify(receipt))
    const args = { receiptFile, installedRoot: chat, executablePath: path.join(host, 'app.exe'), artifact: build }
    assert.equal((await verifySealedComparisonBaseline(args)).sourceCurrent, false)
    await assert.rejects(verifySealedComparisonBaseline({ ...args, executablePath: path.join(root, 'other/app.exe') }))
    await assert.rejects(verifySealedComparisonBaseline({ ...args, executablePath: path.join(host, 'missing.exe') }))
    await fs.writeFile(path.join(host, 'extra.exe'), 'not sealed')
    await assert.rejects(verifySealedComparisonBaseline({ ...args, executablePath: path.join(host, 'extra.exe') }))
    await assert.rejects(verifySealedComparisonBaseline(args))
    await fs.unlink(path.join(host, 'extra.exe'))
    await fs.writeFile(path.join(chat, 'extra.txt'), 'not sealed')
    await assert.rejects(verifySealedComparisonBaseline(args))
    await fs.unlink(path.join(chat, 'extra.txt'))
    await fs.writeFile(path.join(host, 'resources/app.asar'), 'tampered')
    await assert.rejects(verifySealedComparisonBaseline(args))
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
