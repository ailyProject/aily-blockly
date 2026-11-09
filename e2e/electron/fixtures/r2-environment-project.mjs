import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { prepareBuildLogProject } from './build-log-project.mjs'

/** Definitions and local package sources only. Runtime/receipts/npm operations
 * are never replaced by this fixture. Every package input is offline-owned. */
export async function prepareR2EnvironmentProject({ directory, suite, boardsRoot, librariesRoot }) {
  const fixture = await prepareBuildLogProject({ directory, boardsRoot, librariesRoot, scenario: 'field-edit', marker: 'R2_ENV_NO_COMPILE' })
  const abiPath = path.join(directory, 'project.abi'), abi = JSON.parse(await fs.readFile(abiPath, 'utf8'))
  const first = abi.blocks.blocks.find(block => block.type === 'arduino_global').inputs.ARDUINO_GLOBAL.block
  first.next = { block: { type: fixture.blockType, id: 'r2_environment_C', fields: { VALUE: 200 }, next: {
    block: { type: fixture.blockType, id: 'r2_environment_B', fields: { VALUE: 300 } } } } }
  await fs.writeFile(abiPath, JSON.stringify(abi, null, 2))
  const sourceRoot = path.join(suite, 'offline-packages'), scope = '@aily-project'
  await fs.mkdir(path.join(sourceRoot, scope), { recursive: true })
  const names = (await fs.readdir(path.join(directory, 'node_modules', scope))).map(name => `${scope}/${name}`)
  const locations = new Map(names.map(name => [name, path.join(sourceRoot, name)]))
  for (const name of names) await fs.cp(path.join(directory, 'node_modules', name), locations.get(name), {
    recursive: true, dereference: true, errorOnExist: true, force: false,
    filter: file => !path.relative(path.join(directory, 'node_modules', name), file).split(path.sep).includes('node_modules') })
  const convert = manifest => {
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) for (const name of Object.keys(manifest[field] ?? {})) {
      assert.ok(locations.has(name), `Offline closure is missing ${name}`)
      manifest[field][name] = `file:${locations.get(name).replaceAll('\\', '/')}`
    }
    return manifest
  }
  const menu = [{ name: 'R2 acceptance mode', key: 'R2Mode', children: [
    { name: 'R2 initial mode', data: 'one' }, { name: 'R2 changed mode', data: 'two' } ] }]
  for (const name of names) for (const root of [locations.get(name), path.join(directory, 'node_modules', name)]) {
    const file = path.join(root, 'package.json'), metadata = convert(JSON.parse(await fs.readFile(file, 'utf8')))
    if (name === fixture.boardPackage) {
      metadata.boardDependencies = {} // A fixture board menu needs no global SDK or hardware.
      await fs.writeFile(path.join(root, 'menu.json'), JSON.stringify(menu, null, 2))
    }
    await fs.writeFile(file, JSON.stringify(metadata, null, 2))
  }
  const manifestFile = path.join(directory, 'package.json'), manifest = convert(JSON.parse(await fs.readFile(manifestFile, 'utf8')))
  manifest.projectConfig = { ...manifest.projectConfig, R2Mode: 'one' }
  await fs.writeFile(manifestFile, JSON.stringify(manifest, null, 2))
  const libraryName = '@aily-project/lib-r2-environment-extra', blockType = 'r2_environment_added_block'
  const localLibrary = path.join(sourceRoot, libraryName); await fs.mkdir(path.join(localLibrary, 'src'), { recursive: true })
  const files = {
    'package.json': JSON.stringify({ name: libraryName, version: '1.0.0', nickname: 'Offline R2 environment library', main: 'index.js' }),
    'block.json': JSON.stringify([{ type: blockType, message0: 'R2 environment added block', previousStatement: null, nextStatement: null, colour: 180 }]),
    'generator.js': `Arduino.forBlock[${JSON.stringify(blockType)}] = function () { return ""; };\n`,
    'toolbox.json': JSON.stringify({ kind: 'category', name: 'R2 environment', contents: [{ kind: 'block', type: blockType }] }),
    'info.json': JSON.stringify({ name: 'lib-r2-environment-extra', displayName: 'R2 environment', category: 'utility' }),
    'src/Original.h': '#pragma once\n// Original offline environment source.\n',
    'README.md': 'Owned offline acceptance library. No hardware or dependency scripts.\n',
    'README_AI.md': 'Owned offline acceptance fixture. No build or hardware operation is required.\n',
  }
  for (const [name, text] of Object.entries(files)) await fs.writeFile(path.join(localLibrary, name), text, { flag: 'wx' })
  return { ...fixture, localLibrary, addedLibraryName: libraryName, addedBlockType: blockType,
    installSpec: `${libraryName}@file:${localLibrary.replaceAll('\\', '/')}`, cId: 'r2_environment_C', bId: 'r2_environment_B' }
}
