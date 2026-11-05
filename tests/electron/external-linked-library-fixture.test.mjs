import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { prepareExternalLinkedLibrary, verifyExternalLinkedLibrary, EXTERNAL_LIBRARY_PACKAGE } from '../../e2e/fixtures/external-linked-library.mjs'

test('manual npm fixture uses a real external file link and never changes its source', async t => {
  const suite = await fs.mkdtemp(path.join(os.tmpdir(), 'aily-linked-npm-'))
  t.after(async () => {
    assert.equal(path.dirname(suite), path.resolve(os.tmpdir()))
    assert.match(path.basename(suite), /^aily-linked-npm-/)
    await fs.rm(suite, { recursive: true, force: true })
  })
  const project = path.join(suite, 'project')
  await fs.mkdir(project)
  await fs.writeFile(path.join(project, 'package.json'), JSON.stringify({ name: 'isolated-linked-test', private: true }))
  const fixture = await prepareExternalLinkedLibrary(suite, project)
  const manifest = JSON.parse(await fs.readFile(path.join(project, 'package.json'), 'utf8'))
  assert.match(manifest.dependencies[EXTERNAL_LIBRARY_PACKAGE], /^file:/)
  assert.equal(fixture.manualNpm, true)
  const calls = [], Arduino = { forBlock: {} }
  Function('Arduino', await fs.readFile(path.join(fixture.source, 'generator.js'), 'utf8'))(Arduino)
  assert.equal(Arduino.forBlock.linked_library_probe({ getFieldValue() { calls.push('field'); return 'test "quote"' } }),
    'Serial.println("test \\"quote\\"");\n')
  assert.deepEqual(calls, ['field'])
  await verifyExternalLinkedLibrary(fixture)
})
