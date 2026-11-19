import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'

const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
const inside = (root, file) => {
  const relative = path.relative(root, file)
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
}

/** Sharing resources never shares the test's project, account or session state. */
export async function resolveBootstrapResources({ resourceRoot, platformRoot, sharedPlatformResources = false, npmCacheRoot }) {
  assert.ok(path.isAbsolute(resourceRoot) && path.isAbsolute(platformRoot))
  assert.equal(typeof sharedPlatformResources, 'boolean')
  const dailyPhysical = await fs.realpath(resourceRoot), platformPhysical = await fs.realpath(platformRoot)
  if (sharedPlatformResources) assert.ok(same(dailyPhysical, platformPhysical), 'Shared resources must be the explicitly selected Daily resource root')
  else {
    assert.equal(same(dailyPhysical, platformPhysical), false, 'Sharing Daily resources requires the explicit option')
    assert.equal(inside(resourceRoot, platformRoot), false, 'Default platform resources remain isolated from Daily')
  }
  const allowed = sharedPlatformResources ? dailyPhysical : platformRoot
  const resources = []
  for (const relative of ['sdk', 'tools', 'compiler', 'node_modules', 'npm-global/node_modules']) {
    const requested = path.join(platformRoot, relative), realPath = await fs.realpath(requested)
    assert.ok((await fs.stat(requested)).isDirectory())
    assert.ok(inside(allowed, realPath), 'Compilation resources must not resolve to an unselected root: ' + relative)
    resources.push({ relative, requested, realPath })
  }
  let npmCache = null
  if (npmCacheRoot !== undefined) {
    assert.ok(path.isAbsolute(npmCacheRoot), 'An existing npm cache must be absolute')
    assert.ok((await fs.stat(npmCacheRoot)).isDirectory(), 'The selected npm cache must already exist')
    npmCache = { mode: 'shared-existing', requested: npmCacheRoot, realPath: await fs.realpath(npmCacheRoot) }
  }
  return { mode: sharedPlatformResources ? 'shared-daily' : 'isolated-platform', dailyPhysical, platformPhysical, resources, npmCache }
}

export async function sharedBootstrapProtectedFiles(root) {
  const files = [
    'compiler/arm-none-eabi-gcc@7.2.1/bin/arm-none-eabi-g++.exe',
    'tools/arm-none-eabi-gcc@7.2.1/bin/arm-none-eabi-g++.exe',
    'compiler/arm-none-eabi-gcc@7.2.1/arm-none-eabi/include/c++/7.2.1/arm-none-eabi/thumb/v7e-m/fpv4-sp/hard/bits/c++config.h',
    'tools/arm-none-eabi-gcc@7.2.1/arm-none-eabi/include/c++/7.2.1/arm-none-eabi/thumb/v7e-m/fpv4-sp/hard/bits/c++config.h',
    'sdk/renesas_uno_1.5.3/cores/arduino/Arduino.h',
    'node_modules/@aily-project/board-arduino_uno_r4_wifi/package.json',
    'npm-global/node_modules/@aily-project/aily-builder/package.json',
    'npm-global/aily-builder', 'npm-global/aily-builder.cmd', 'npm-global/aily-builder.ps1',
  ].map(relative => path.join(root, relative))
  const packageRoot = path.join(root, 'npm-global/node_modules/@aily-project/aily-builder')
  const manifest = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'))
  const entry = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.['aily-builder']
  assert.ok(typeof entry === 'string' && inside(packageRoot, path.resolve(packageRoot, entry)))
  files.push(path.resolve(packageRoot, entry))
  for (const file of files) assert.ok((await fs.stat(file)).isFile(), 'Shared resource file is required: ' + file)
  return files
}
