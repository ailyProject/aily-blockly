import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

export const EXTERNAL_LIBRARY_PACKAGE = '@aily-project/lib-linked-probe'
export const EXTERNAL_LIBRARY_BLOCK = 'linked_library_probe'

/** A real manual npm install into an owned fixture, never a user project.
 * The external source stays outside the project and is not rewritten by tools. */
export async function prepareExternalLinkedLibrary(suite, project) {
  assert.equal(path.dirname(project), suite)
  const source = path.join(suite, '外部库 source')
  await fs.mkdir(source)
  const files = {
    'package.json': JSON.stringify({ name: EXTERNAL_LIBRARY_PACKAGE, version: '0.0.1', private: true }),
    'block.json': JSON.stringify([{ type: EXTERNAL_LIBRARY_BLOCK, message0: 'linked probe %1',
      args0: [{ type: 'field_input', name: 'TEXT', text: 'probe' }],
      previousStatement: null, nextStatement: null, colour: 160 }]),
    'generator.js': `Arduino.forBlock['${EXTERNAL_LIBRARY_BLOCK}'] = function(block) {
  return 'Serial.println(' + JSON.stringify(block.getFieldValue('TEXT')) + ');\\n';
};\n`,
    'toolbox.json': JSON.stringify({ kind: 'category', name: 'Linked probe',
      contents: [{ kind: 'block', type: EXTERNAL_LIBRARY_BLOCK }] }),
    'README_AI.md': '# Linked probe\n\n' +
      '`linked_library_probe("message")` is a statement that prints its TEXT field once on the existing Serial port.\n' +
      'The field is a direct string argument, not an input_value block. No initializer, variable model or C++ header is required.\n'
  }
  for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(source, name), content, { flag: 'wx' })
  await install(suite, project, source)
  const installed = path.join(project, 'node_modules', ...EXTERNAL_LIBRARY_PACKAGE.split('/'))
  assert.equal((await fs.lstat(installed)).isSymbolicLink(), true)
  assert.equal(await fs.realpath(installed), await fs.realpath(source))
  const sourceHash = await hashLibrary(source)
  return { packageName: EXTERNAL_LIBRARY_PACKAGE, blockType: EXTERNAL_LIBRARY_BLOCK,
    source, sourceHash, installed, manualNpm: true, npmExitCode: 0 }
}

async function install(suite, project, source) {
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
  await fs.access(npmCli)
  const result = spawnSync(process.execPath, [npmCli, 'install', `file:${source.replaceAll('\\', '/')}`,
    '--install-links=false', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: project, encoding: 'utf8', timeout: 60000, windowsHide: true,
    env: { ...process.env, NPM_CONFIG_USERCONFIG: path.join(suite, 'fixture.npmrc'),
      npm_config_userconfig: path.join(suite, 'fixture.npmrc'), npm_config_cache: path.join(suite, 'npm-cache') }
  })
  assert.equal(result.error, undefined, result.error?.message)
  assert.equal(result.status, 0, result.stderr || result.stdout)
}

/** Simulate a GUI-staged local update plus a manual npm update of the same
 * entry. All three libraries and the target belong to this isolated suite. */
export async function prepareLinkedDependencyConflict(page, suite, project, fixture) {
  const sources = []
  for (const version of ['0.0.2', '0.0.3']) {
    const source = fixture.source + '-v' + version
    await fs.cp(fixture.source, source, { recursive: true, errorOnExist: true, force: false })
    await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({ name: fixture.packageName, version, private: true }))
    sources.push({ source, hash: await hashLibrary(source) })
  }
  const rootBytes = await fs.readFile(path.join(project, 'package.json'))
  const staged = await page.evaluate(async ({ project, source, name }) => {
    const component = window.ng.getComponent(document.querySelector('app-blockly-editor'))
    const current = component._projectService.currentProjectPath.replaceAll('\\', '/').toLowerCase()
    if (current !== project.replaceAll('\\', '/').toLowerCase()) throw new Error('Refuse a dependency fixture in another project')
    return window.libraryDependencies.mutate(project, { action: 'install', packages: [`${name}@file:${source.replaceAll('\\', '/')}`] })
  }, { project, source: sources[0].source, name: fixture.packageName })
  assert.equal(staged.dirty, true)
  assert.deepEqual(await fs.readFile(path.join(project, 'package.json')), rootBytes, 'GUI staging must not save the root manifest')
  await install(suite, project, sources[1].source)
  const status = await page.evaluate(project => window.libraryDependencies.status(project), project)
  assert.equal(status.dependencyConflict?.status, 'available')
  assert.ok(status.dependencyConflict.entries.some(item => item.name === fixture.packageName))
  fixture.expectedTarget = sources[0].source
  fixture.additionalSources = sources
  return { conflictCreated: true, stagedChoice: 'staged', externalSource: sources[1].source, recoveryActionsRequired: true }
}

export async function verifyExternalLinkedLibrary(fixture) {
  assert.equal(await hashLibrary(fixture.source), fixture.sourceHash, 'External source must remain byte-for-byte unchanged')
  for (const source of fixture.additionalSources ?? []) assert.equal(await hashLibrary(source.source), source.hash)
  assert.equal((await fs.lstat(fixture.installed)).isSymbolicLink(), true)
  assert.equal(await fs.realpath(fixture.installed), await fs.realpath(fixture.expectedTarget ?? fixture.source), 'Only a deliberately selected dependency can change the link')
}

async function hashLibrary(root) {
  const files = (await fs.readdir(root)).sort(), values = []
  for (const name of files) values.push([name, createHash('sha256').update(await fs.readFile(path.join(root, name))).digest('hex')])
  return createHash('sha256').update(JSON.stringify(values)).digest('hex')
}
