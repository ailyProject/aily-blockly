import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { resolveBootstrapResources } from './bootstrap-resources.mjs'

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aily-bootstrap-resources-'))
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()))
    assert.ok(path.basename(root).startsWith('aily-bootstrap-resources-'))
    assert.equal(await fs.realpath(root), root)
    await fs.rm(root, { recursive: true, force: true })
  })
  const daily = path.join(root, 'daily'), isolated = path.join(root, 'isolated'), cache = path.join(root, 'cache')
  for (const base of [daily, isolated]) for (const relative of ['sdk', 'tools', 'compiler', 'node_modules', 'npm-global/node_modules']) {
    await fs.mkdir(path.join(base, relative), { recursive: true })
  }
  await fs.mkdir(cache)
  return { root, daily, isolated, cache }
}

test('explicit sharing records the exact Daily real paths and existing cache without copies', async t => {
  const f = await fixture(t)
  const result = await resolveBootstrapResources({ resourceRoot: f.daily, platformRoot: f.daily,
    sharedPlatformResources: true, npmCacheRoot: f.cache })
  assert.equal(result.mode, 'shared-daily')
  assert.equal(result.platformPhysical, await fs.realpath(f.daily))
  assert.equal(result.resources.length, 5)
  assert.ok(result.resources.every(item => item.realPath.startsWith(f.daily + path.sep)))
  assert.equal(result.npmCache.realPath, await fs.realpath(f.cache))
  assert.deepEqual(await fs.readdir(f.cache), [])
})
test('explicit sharing refuses a different resource root', async t => {
  const f = await fixture(t)
  await assert.rejects(resolveBootstrapResources({ resourceRoot: f.daily, platformRoot: f.isolated,
    sharedPlatformResources: true }), /explicitly selected Daily/)
})
test('default configuration retains a distinct isolated platform and refuses implicit sharing', async t => {
  const f = await fixture(t)
  assert.equal((await resolveBootstrapResources({ resourceRoot: f.daily, platformRoot: f.isolated })).mode, 'isolated-platform')
  await assert.rejects(resolveBootstrapResources({ resourceRoot: f.daily, platformRoot: f.daily }), /explicit option/)
})
test('shared resource subdirectories cannot silently point outside Daily', async t => {
  const f = await fixture(t), target = path.join(f.daily, 'tools')
  await fs.rmdir(target)
  await fs.symlink(path.join(f.isolated, 'tools'), target, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(resolveBootstrapResources({ resourceRoot: f.daily, platformRoot: f.daily,
    sharedPlatformResources: true }), /unselected root/)
})
test('an optional cache must be an existing absolute directory', async t => {
  const f = await fixture(t)
  await assert.rejects(resolveBootstrapResources({ resourceRoot: f.daily, platformRoot: f.isolated, npmCacheRoot: 'relative' }), /absolute/)
  await assert.rejects(resolveBootstrapResources({ resourceRoot: f.daily, platformRoot: f.isolated, npmCacheRoot: path.join(f.root, 'missing') }), { code: 'ENOENT' })
})
