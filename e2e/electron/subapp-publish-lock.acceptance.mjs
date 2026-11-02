// Real Windows file-lock acceptance for subapp publication.
// The rename error is raised by the operating system: a read handle is held on the
// extracted package, then the production rename runs unchanged. Nothing here fabricates EPERM.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const hostRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const require = createRequire(import.meta.url)
const {
  createSubappManager,
  readInstalledState,
} = require(path.join(hostRoot, 'electron/subapp-manager.js'))
const versions = require(path.join(hostRoot, 'electron/subapp-version-store.js'))
const { portableSubappTarball } = require(path.join(hostRoot, 'tests/electron/fixtures/npm-tarball-fixture.js'))

const ID = 'aily-chat'
const PACKAGE = '@aily-project/subapp-aily-chat'
const PREVIOUS = '0.1.32'
const LATEST = '0.1.33'
const windowsOnly = process.platform === 'win32'
  ? false
  : 'A held file denies directory rename only on Windows'

function integrity(buffer) {
  return `sha512-${createHash('sha512').update(buffer).digest('base64')}`
}

function archiveFor(version) {
  return portableSubappTarball({ packageName: PACKAGE, version, id: ID })
}

function catalogEntry(version, archive) {
  return {
    id: ID,
    package: PACKAGE,
    version,
    namespace: 'AILY_CHAT',
    titleKey: 'AILY_CHAT.NAME',
    app: { name: 'Aily Chat', enabled: true },
    update: { download: 'background', install: 'next-launch' },
    dist: {
      tarball: `https://packages.example.test/${version}.tgz`,
      integrity: integrity(archive),
    },
  }
}

function stateEntry(version) {
  return {
    id: ID,
    package: PACKAGE,
    version,
    namespace: 'AILY_CHAT',
    titleKey: 'AILY_CHAT.NAME',
    app: { name: 'Aily Chat', enabled: true },
  }
}

function createManager(rootDir, version, archive) {
  const entry = catalogEntry(version, archive)
  return createSubappManager({
    rootDir,
    updateRootDir: path.join(rootDir, 'updates'),
    env: {},
    // cache-first must not reuse the previously installed catalog.
    indexUrl: `https://packages.example.test/subapp-index-${version}.json`,
    fetchImpl: async () => ({ ok: true, text: async () => JSON.stringify({ [ID]: entry }) }),
    downloadFile: async (_url, destination, onProgress) => {
      fs.writeFileSync(destination, archive)
      onProgress?.(100)
    },
    runNpm: async () => { throw new Error('portable publication must not run npm') },
    hasProcessesUsingPath: async () => false,
    forceStopChildToolByCatalogId: async () => ({ success: true }),
  })
}

function versionFile(rootDir, version) {
  return path.join(rootDir, 'store', 'subapp-aily-chat', version, 'source', 'server', 'index.js')
}

// Open the extracted file immediately before the real staging-directory rename.
// Later retries call the same fs.renameSync; only the first attempt is locked
// when mode is "transient".
function lockRealStagingRename(mode) {
  const rename = fs.renameSync
  const observed = []
  let handle = null
  let arm = true
  fs.renameSync = (source, destination, ...args) => {
    const publishing = path.basename(String(source)).startsWith('.staging-')
    if (publishing && arm) {
      arm = false
      handle = fs.openSync(path.join(source, 'source', 'package.json'), 'r')
    }
    try {
      return rename.call(fs, source, destination, ...args)
    } catch (error) {
      if (publishing) observed.push({ code: error.code, errno: error.errno, message: error.message })
      if (mode === 'transient' && publishing && handle !== null && error.code === 'EPERM') {
        fs.closeSync(handle)
        handle = null
      }
      throw error
    }
  }
  return {
    observed,
    stop() {
      fs.renameSync = rename
      if (handle !== null) {
        fs.closeSync(handle)
        handle = null
      }
    },
  }
}

function assertRealRenameDenial(observed) {
  assert.ok(observed.length >= 1, 'production rename did not hit a real lock')
  for (const error of observed) {
    assert.equal(error.code, 'EPERM')
    assert.equal(error.errno, -4048)
    assert.match(error.message, /operation not permitted, rename/)
    assert.match(error.message, /\.staging-/)
  }
}

async function installPrevious(t) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-publish-lock-'))
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }))
  const archive = archiveFor(PREVIOUS)
  const manager = createManager(rootDir, PREVIOUS, archive)
  await manager.install({ id: ID })
  const installed = readInstalledState(rootDir, stateEntry(PREVIOUS))
  assert.equal(installed.installed, true)
  assert.equal(installed.installedVersion, PREVIOUS)
  const bytes = fs.readFileSync(versionFile(rootDir, PREVIOUS))
  return { rootDir, bytes }
}

describe('Windows publish lock', { concurrency: false, skip: windowsOnly }, () => {
test('a real Windows file lock is retried and only then enables the latest version', async (t) => {
  const { rootDir, bytes } = await installPrevious(t)
  const latest = archiveFor(LATEST)
  const manager = createManager(rootDir, LATEST, latest)
  const lock = lockRealStagingRename('transient')
  t.after(() => lock.stop())
  try {
    await manager.update({ id: ID })
  } finally {
    lock.stop()
  }
  assertRealRenameDenial(lock.observed)
  const installed = readInstalledState(rootDir, stateEntry(LATEST))
  assert.equal(installed.installed, true)
  assert.equal(installed.installedVersion, LATEST)
  assert.equal(installed.packagePath, path.join(rootDir, 'store', 'subapp-aily-chat', LATEST, 'source'))
  assert.match(fs.readFileSync(versionFile(rootDir, LATEST), 'utf8'), new RegExp(LATEST))
  assert.deepEqual(fs.readFileSync(versionFile(rootDir, PREVIOUS)), bytes)
  const launch = await manager.prepareLaunch({ id: ID })
  try {
    assert.equal(launch.config.version, LATEST)
  } finally {
    launch.release()
  }
  assert.equal(versions.readActiveManifest(rootDir, { id: ID, package: PACKAGE }).selected.version, LATEST)
})

test('a real Windows file lock that never clears keeps the previous version launchable', async (t) => {
  const { rootDir, bytes } = await installPrevious(t)
  const latest = archiveFor(LATEST)
  const manager = createManager(rootDir, LATEST, latest)
  const lock = lockRealStagingRename('persistent')
  t.after(() => lock.stop())
  try {
    await assert.rejects(manager.update({ id: ID }), (error) => {
      assert.equal(error.code, 'SUBAPP_VERSION_PUBLISH_BUSY')
      assert.match(error.message, /更新失败/)
      assert.match(error.message, new RegExp(PREVIOUS))
      assert.match(error.message, /仍可继续使用/)
      return true
    })
  } finally {
    lock.stop()
  }
  assert.ok(lock.observed.length >= 2, 'a held lock must survive more than one production rename attempt')
  assertRealRenameDenial(lock.observed)
  const installed = readInstalledState(rootDir, stateEntry(PREVIOUS))
  assert.equal(installed.installed, true)
  assert.equal(installed.installedVersion, PREVIOUS)
  assert.equal(installed.packagePath, path.join(rootDir, 'store', 'subapp-aily-chat', PREVIOUS, 'source'))
  assert.deepEqual(fs.readFileSync(versionFile(rootDir, PREVIOUS)), bytes)
  assert.equal(fs.existsSync(path.join(rootDir, 'store', 'subapp-aily-chat', LATEST)), false)
  assert.equal(versions.readActiveManifest(rootDir, { id: ID, package: PACKAGE }).selected.version, PREVIOUS)
  const launch = await manager.prepareLaunch({ id: ID })
  try {
    assert.equal(launch.config.version, PREVIOUS)
    assert.equal(launch.config.packagePath, installed.packagePath)
  } finally {
    launch.release()
  }
})
})
