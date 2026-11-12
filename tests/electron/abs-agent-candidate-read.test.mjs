import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { createRecoveredAgentHarness } from '../../e2e/fixtures/abs-agent-tools.mjs'

test('owned SDK ABS reads stay read-only without a Host and never grant private History access', async () => {
  const agentRoot = process.env.AILY_ABS_AGENT_ROOT, outputRoot = process.env.AILY_ABS_AGENT_TEST_ROOT
  assert.ok(agentRoot && path.isAbsolute(agentRoot))
  assert.ok(outputRoot && path.isAbsolute(outputRoot))
  const relative = path.relative(path.resolve('tests/test-results'), path.resolve(outputRoot))
  assert.ok(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))
  const root = path.join(outputRoot, 'candidate-read-' + Date.now()), source = path.join(root, 'source')
  const profile = path.join(root, 'profile'), home = path.join(root, 'home')
  const abs = path.join(source, 'project.abs'), privateFile = path.join(source, '.workspace-history/private.abs')
  await mkdir(path.dirname(privateFile), { recursive: true }); await mkdir(profile); await mkdir(home)
  const original = '# ABS Schema: 2\nnode(1)\n'
  await writeFile(path.join(source, 'package.json'), '{"name":"candidate-read-fixture","type":"arduino"}')
  await writeFile(abs, original); await writeFile(privateFile, 'private candidate sentinel\n')
  const names = ['PI_CODING_AGENT_DIR', 'PI_OFFLINE', 'HOME', 'USERPROFILE', 'AILY_LIBRARY_HOST_PID', 'AILY_APPDATA_PATH']
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]))
  Object.assign(process.env, { PI_CODING_AGENT_DIR: profile, PI_OFFLINE: '1', HOME: home, USERPROFILE: home,
    AILY_LIBRARY_HOST_PID: '99999999', AILY_APPDATA_PATH: root })
  const originalFetch = globalThis.fetch
  let externalFetches = 0, harness
  globalThis.fetch = async () => { externalFetches++; throw new Error('No Host or provider exists in this offline SDK test') }
  try {
    harness = await createRecoveredAgentHarness({ agentRoot, sourceProject: source, globalRoot: root, profileRoot: profile,
      permissionApproval(request) {
        return ['read', 'edit'].includes(request.toolName) && [abs, privateFile].includes(request.input.path)
      } })
    await harness.settle()
    await harness.beginTurn('Inspect the existing program without granting unavailable Host or private History authority.')
    assert.equal(harness.history.hasCandidateOwner, true, 'Ownership comes from the real persistent SDK user branch')
    assert.equal((await harness.readText(abs)), original)
    assert.equal(harness.history.candidateRef('project.abs'), undefined, 'No physical Working capture was returned by a Host')
    // Before the composition fix this ordinary Core edit succeeded in the
    // private view. The real candidate capability keeps compatibility reads
    // read-only rather than creating a second writable program identity.
    const edit = await harness.call('edit', { path: abs, edits: [{ oldText: 'node(1)', newText: 'node(2)' }] }, { expectError: true })
    assert.match(edit.text, /exact retained candidate source is read-only/i)
    assert.equal(await readFile(abs, 'utf8'), original)
    assert.equal((await harness.readText(abs)), original)
    await harness.call('read', { path: privateFile }, { expectError: true })
    assert.equal(await readFile(privateFile, 'utf8'), 'private candidate sentinel\n')
    assert.equal(harness.history.candidateRef('.workspace-history/private.abs'), undefined)
    assert.equal(harness.history.candidateRef('project.abs'), undefined)
    assert.equal(harness.proof().sessionUserMessages, 1)
    assert.equal(harness.proof().permissionMode, 'default')
    assert.equal(harness.proof().llmInvoked, false)
    assert.equal(externalFetches, 0)
  } finally {
    await harness?.dispose()
    globalThis.fetch = originalFetch
    for (const name of names) if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]
  }
})
