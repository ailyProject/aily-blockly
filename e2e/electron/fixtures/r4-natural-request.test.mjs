import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { loadNaturalRequests, naturalRequest } from '../../fixtures/r4-natural-request.mjs'

test('natural requests preserve literal user text, fixed fixture marker, and template identity across roots', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'r4-natural-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'requests.json'), value = { version: 1, cases: { success: { prompt: '请编译当前项目，告诉我结果。', marker: 'R4_COMPILE' } } }
  await fs.writeFile(file, JSON.stringify(value))
  const loaded = await loadNaturalRequests(file, ['success'])
  const one = naturalRequest(loaded, 'success', path.join(dir, 'one')), two = naturalRequest(loaded, 'success', path.join(dir, 'two'))
  assert.equal(one.prompt, value.cases.success.prompt)
  assert.equal(one.templateSha256, two.templateSha256); assert.equal(one.renderedSha256, two.renderedSha256)
  assert.equal(one.marker, two.marker); assert.equal(one.toolSequenceInjected, false); assert.equal(one.modelLogReadRequired, false)
  assert.equal(await loadNaturalRequests(undefined, ['failure']), undefined)
})

test('the optional natural comparison rejects unsupported goals, unknown expansion, and random markers before any paid request', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'r4-natural-invalid-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'requests.json')
  for (const [name, prompt, marker] of [['failure', '编译 {{project}}', 'R4_COMPILE'], ['success', '编译 {{project}} {{other}}', 'R4_COMPILE'], ['success', '编译 {{project}}', 'random-marker']]) {
    await fs.writeFile(file, JSON.stringify({ version: 1, cases: { [name]: { prompt, marker } } }))
    await assert.rejects(loadNaturalRequests(file, [name]))
  }
})
