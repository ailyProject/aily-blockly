import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'

/** A new board-template project and a tiny source fixture. No user project or
 * generated compiler output is copied, and the real generator/compiler owns
 * every diagnostic, build result and request log. */
export async function prepareBuildLogProject({ directory, boardsRoot, librariesRoot, scenario, marker, compileFieldValue = false }) {
  if (compileFieldValue) assert.equal(scenario, 'field-edit')
  const libraryName = '@aily-project/lib-e2e-build-log-' + scenario
  const blockType = 'e2e_build_log_probe_' + scenario.replaceAll('-', '_')
  const blockId = 'build_log_probe_' + (scenario === 'field-edit' ? 'value-edit' : scenario)
  const boardRoot = path.join(boardsRoot, 'arduino_uno')
  await fs.cp(path.join(boardRoot, 'template'), directory, { recursive: true, errorOnExist: true, force: false })
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'))
  manifest.name = `build-log-${scenario}`
  manifest.devmode = 'arduino'
  const pending = Object.keys(manifest.dependencies), copied = new Set()
  for (const name of pending) {
    if (copied.has(name)) continue
    copied.add(name)
    assert.match(name, /^@aily-project\/(board-|lib-)/)
    const source = name.startsWith('@aily-project/board-') ? boardRoot
      : path.join(librariesRoot, name.replace('@aily-project/lib-', ''))
    const destination = path.join(directory, 'node_modules', name)
    await fs.cp(source, destination, { recursive: true, dereference: true,
      filter: file => !path.relative(source, file).split(path.sep).includes('node_modules') })
    const metadata = JSON.parse(await fs.readFile(path.join(destination, 'package.json'), 'utf8'))
    pending.push(...Object.keys(metadata.dependencies ?? {}).filter(name => name.startsWith('@aily-project/lib-')))
  }
  const probe = path.join(directory, 'node_modules', libraryName)
  await fs.mkdir(probe, { recursive: true })
  const source = `#pragma message("${marker}")\n`
    + (scenario === 'failure' ? `#error ${marker}_intentional_failure\n` : '')
  const files = {
    'package.json': JSON.stringify({ name: libraryName, version: '1.0.0', nickname: 'Build log acceptance', main: 'index.js' }),
    'block.json': JSON.stringify([{ type: blockType,
      message0: scenario === 'field-edit' ? 'build log probe value %1' : 'build log probe',
      ...(scenario === 'field-edit' ? { args0: [{ type: 'field_number', name: 'VALUE', value: 100 }] } : {}), previousStatement: null,
      nextStatement: null, colour: 210 }]),
    'generator.js': `Arduino.forBlock[${JSON.stringify(blockType)}] = function (block, generator) { generator.addVariable(${JSON.stringify(blockType)}, ${JSON.stringify(source)}); ${compileFieldValue ? 'generator.addVariable("buildLogEditedValue", "int buildLogEditedValue = " + block.getFieldValue("VALUE") + ";\\n"); ' : ''}return ""; };\n`,
    'toolbox.json': JSON.stringify({ kind: 'category', name: 'Build log acceptance', contents: [{ kind: 'block', type: blockType }] }),
    'info.json': JSON.stringify({ name: libraryName.replace('@aily-project/', ''), displayName: 'Build log acceptance', category: 'utility' }),
    'readme_ai.md': 'A test-owned source probe. It intentionally emits a compiler pragma, and one case emits #error. Do not repair it.\n'
  }
  await Promise.all(Object.entries(files).map(([name, text]) => fs.writeFile(path.join(probe, name), text, { flag: 'wx' })))
  manifest.dependencies[libraryName] = '1.0.0'
  await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify(manifest, null, 2))
  const abiFile = path.join(directory, 'project.abi'), abi = JSON.parse(await fs.readFile(abiFile, 'utf8'))
  const global = abi.blocks.blocks.find(block => block.type === 'arduino_global')
  assert.ok(global)
  global.inputs = { ...global.inputs, ARDUINO_GLOBAL: { block: { type: blockType, id: blockId,
    ...(scenario === 'field-edit' ? { fields: { VALUE: 100 } } : {}) } } }
  await fs.writeFile(abiFile, JSON.stringify(abi, null, 2))
  return { project: directory, marker, boardPackage: '@aily-project/board-arduino_uno', sourceFixture: probe, blockType, blockId, libraryName }
}

export async function buildLogSourceHashes(project, sha) {
  return Object.fromEntries(await Promise.all(['package.json', 'project.abi', 'project.abs'].map(async file => {
    try { return [file, sha(await fs.readFile(path.join(project, file)))] }
    catch (error) { if (error.code === 'ENOENT') return [file, null]; throw error }
  })))
}
