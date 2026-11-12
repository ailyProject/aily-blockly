import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { inspectDriverTarball } from './lib-driver-registry.mjs'
import { loadCandidateSdk, appendCandidateUser, candidateSession } from './r3-customer-candidate.mjs'
import { sha } from './r1-customer-native.mjs'

export const libraryCodeProbe = Object.freeze({ name: '@aily-project/lib-e2e-library-code-probe', version: '1.0.0',
  blockType: 'e2e_library_code_probe', blockId: 'e2e_library_code_probe_statement',
  cpp: 'src/AilyLibraryCodeProbe.cpp', header: 'src/AilyLibraryCodeProbe.h',
  before: 'constexpr int kProbeValue = 1;', after: 'constexpr int kProbeValue = 2;',
  prompt: '当前项目的 @aily-project/lib-e2e-library-code-probe 库中，src/AilyLibraryCodeProbe.cpp 的 kProbeValue 应当是 2，但现在写成了 1。请修复这个库代码，保留 static_assert 检查、函数接口和当前积木程序的其他内容，编译验证后简短告诉我结果。' })
const gate = () => assert.equal(process.env.AILY_LIBRARY_ROOT_HOST_WINDOW, '1')
const inside = (root, file) => { const relative = path.relative(root, file)
  return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) }

/** Genuine authored test package; npm-pack is offline and lifecycle-free. It is
 * never published and cannot replace a user's or an upstream package identity. */
export async function prepareLibraryCodeProbePackage({ directory, npmCli }) {
  gate()
  const source = path.join(directory, 'source'), destination = path.join(directory, 'packages')
  await fs.mkdir(path.join(source, 'src'), { recursive: true }); await fs.mkdir(destination)
  const manifest = { name: libraryCodeProbe.name, version: libraryCodeProbe.version,
    nickname: 'Library C++ edit probe', description: 'Private acceptance-only C++ library edit probe.',
    main: 'generator.js', license: 'MIT', files: ['block.json', 'generator.js', 'toolbox.json', 'info.json', 'README.md', 'README_AI.md', 'src/', 'LICENSE'],
    compatibility: { core: ['esp32:esp32', 'arduino:avr'] } }
  const files = {
    'package.json': JSON.stringify(manifest, null, 2) + '\n',
    'block.json': JSON.stringify([{ type: libraryCodeProbe.blockType, message0: 'Library C++ probe',
      previousStatement: null, nextStatement: null, colour: 210,
      tooltip: 'Calls ailyLibraryCodeProbe(); its driver is required to return 2.' }], null, 2) + '\n',
    'generator.js': `Arduino.forBlock['${libraryCodeProbe.blockType}'] = function(block, generator) {\n  generator.addLibrary('AilyLibraryCodeProbe', '#include <AilyLibraryCodeProbe.h>');\n  return '(void)ailyLibraryCodeProbe();\\n';\n};\n`,
    'toolbox.json': JSON.stringify({ kind: 'category', name: 'Library C++ probe', colour: '#2376a8',
      contents: [{ kind: 'block', type: libraryCodeProbe.blockType }] }, null, 2) + '\n',
    'info.json': JSON.stringify({ name: 'lib-e2e-library-code-probe', displayName: 'Library C++ probe', category: 'utility' }, null, 2) + '\n',
    'README.md': '# Library C++ edit probe\n\nPrivate acceptance fixture. The Blockly statement calls ailyLibraryCodeProbe(), whose required return value is 2. No hardware is used.\n',
    'README_AI.md': '# Private library code probe\n\nThe public function ailyLibraryCodeProbe() must return 2. Its C++ source keeps a static_assert on the required value. The Blockly generator calls this function; the sketch must keep that call. This package is an isolated acceptance fixture.\n',
    [libraryCodeProbe.header]: '#pragma once\nint ailyLibraryCodeProbe();\n',
    [libraryCodeProbe.cpp]: '#include "AilyLibraryCodeProbe.h"\n\nnamespace {\nconstexpr int kProbeValue = 1;\nstatic_assert(kProbeValue == 2, "AILY_LIBRARY_EDIT_PROBE_EXPECTS_2");\n}\n\nint ailyLibraryCodeProbe() { return kProbeValue; }\n',
    'LICENSE': 'MIT License\n\nCopyright (c) 2026 Aily acceptance fixture authors\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files, to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, subject to including this copyright and permission notice.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY ARISING FROM THE SOFTWARE OR THE USE OF THE SOFTWARE.\n'
  }
  for (const [file, contents] of Object.entries(files)) await fs.writeFile(path.join(source, file), contents, { flag: 'wx' })
  const userconfig = path.join(directory, 'pack.npmrc'), cache = path.join(directory, 'pack-cache')
  await fs.writeFile(userconfig, 'offline=true\nignore-scripts=true\naudit=false\nfund=false\n', { flag: 'wx' })
  const { stdout } = await promisify(execFile)(process.execPath, [npmCli, 'pack', '--json', '--offline', '--ignore-scripts',
    '--audit=false', '--fund=false', '--cache', cache, '--userconfig', userconfig, '--pack-destination', destination],
  { cwd: source, windowsHide: true, timeout: 60000, maxBuffer: 1024 ** 2 })
  const produced = JSON.parse(stdout)
  assert.equal(produced.length, 1)
  const tarball = path.join(destination, produced[0].filename), packed = await inspectDriverTarball(tarball)
  assert.equal(packed.manifest.name, libraryCodeProbe.name); assert.equal(packed.manifest.version, libraryCodeProbe.version)
  assert.equal(packed.integrity, produced[0].integrity)
  for (const file of packed.files) assert.equal(file.sha256, sha(await fs.readFile(path.join(source, file.path))))
  for (const required of ['package.json', 'generator.js', 'block.json', 'toolbox.json', libraryCodeProbe.header, libraryCodeProbe.cpp])
    assert.ok(packed.files.some(file => file.path === required))
  return { tarball, source, packed: { ...packed, bytes: undefined }, sourceText: files[libraryCodeProbe.cpp],
    expectedText: files[libraryCodeProbe.cpp].replace(libraryCodeProbe.before, libraryCodeProbe.after),
    originalCppFailsStaticAssertion: true, oldBuildExecuted: false, npmInstallExecuted: false, npmLifecycleScriptsExecuted: false }
}

/** Only exact board/core packages are detached from the already qualified
 * original material. The original user's program is not used or edited. */
export async function prepareLibraryCodeProbeProject({ directory, materialProject }) {
  gate()
  const original = JSON.parse(await fs.readFile(path.join(materialProject, 'package.json')))
  const names = Object.keys(original.dependencies).filter(name => name === '@aily-project/board-esp32' || name.startsWith('@aily-project/lib-core-'))
  assert.ok(names.includes('@aily-project/board-esp32'))
  const board = path.join(materialProject, 'node_modules/@aily-project/board-esp32')
  await fs.cp(path.join(board, 'template'), directory, { recursive: true, errorOnExist: true, force: false })
  const dependencies = {}, materials = []
  for (const name of names) {
    const source = path.join(materialProject, 'node_modules', name)
    assert.equal((await fs.lstat(source)).isSymbolicLink(), false)
    const pkg = JSON.parse(await fs.readFile(path.join(source, 'package.json')))
    assert.equal(pkg.name, name)
    assert.ok(pkg.version)
    dependencies[name] = pkg.version
    await fs.cp(source, path.join(directory, 'node_modules', name), { recursive: true, dereference: false,
      filter: async file => {
        if (path.relative(source, file).split(path.sep).some(part => ['node_modules', '.git'].includes(part))) return false
        assert.equal((await fs.lstat(file)).isSymbolicLink(), false)
        return true
      } })
    materials.push({ name, version: pkg.version, source, manifestSha256: sha(await fs.readFile(path.join(source, 'package.json'))) })
  }
  const manifest = { name: 'library-code-probe', version: '1.0.0', board: original.board, devmode: 'arduino', dependencies }
  await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify(manifest, null, 2))
  // Keep the genuine lock material. Product lib_add/npm reify must reconcile it
  // with the new minimal fixture manifest and create the actual probe entry.
  await fs.copyFile(path.join(materialProject, 'package-lock.json'), path.join(directory, 'package-lock.json'))
  return { project: directory, materials, originalMaterialManifestSha256: sha(await fs.readFile(path.join(materialProject, 'package.json'))),
    originalMaterialAbiSha256: sha(await fs.readFile(path.join(materialProject, 'project.abi'))), originalUserProgramCopied: false }
}

/** Actual product registrar+transport, not a fabricated npm install or result. */
export async function installLibraryCodeProbe({ page, project, agentRoot, suite, registry, checkpoint = async () => {} }) {
  gate()
  const audit = [], sdk = await loadCandidateSdk(agentRoot, audit)
  const manager = sdk.SessionManager.create(project, path.join(suite, 'setup-sdk-sessions'))
  appendCandidateUser(manager, 'Prepare the isolated library code fixture dependency.')
  const signal = new AbortController().signal, session = candidateSession(sdk, project, manager, signal)
  try {
    await session.begin()
    const tools = sdk.registry.createBlocklyToolRegistry(project, session.history, 'blockly')
    const context = sdk.registrars.createRegistrarContext(tools, project, session.history, new sdk.workflow.AbsWorkflowGuard(), 'blockly')
    context.candidateBackupTransport = sdk.transport
    const { registerLibAdd } = await import(pathToFileURL(path.join(agentRoot, 'dist/blockly/tools/registrars/library/lib-add.js')).href)
    registerLibAdd(context)
    const result = await tools.definitions().find(tool => tool.name === 'lib_add').execute({ project,
      packages: [libraryCodeProbe.name + '@' + libraryCodeProbe.version], registry: registry.origin }, signal,
    { toolCallId: randomUUID(), sessionId: manager.getSessionId() })
    const evidence = { actualProductLibAdd: true, result: result.structuredContent, isError: result.isError === true, audit }
    await checkpoint(evidence)
    assert.notEqual(result.isError, true); assert.equal(result.structuredContent?.ok, true)
    assert.equal(result.structuredContent.filesInstalled, true); assert.equal(result.structuredContent.runtimeSync?.ready, true)
    const target = path.join(project, 'node_modules', libraryCodeProbe.name)
    assert.equal((await fs.lstat(target)).isSymbolicLink(), false)
    const authored = registry.packages.find(item => item.manifest.name === libraryCodeProbe.name)
    for (const file of authored.files) assert.equal(sha(await fs.readFile(path.join(target, file.path))), file.sha256)
    const lock = JSON.parse(await fs.readFile(path.join(project, 'package-lock.json')))
    assert.equal(lock.packages['node_modules/' + libraryCodeProbe.name].version, libraryCodeProbe.version)
    assert.equal(lock.packages['node_modules/' + libraryCodeProbe.name].integrity, authored.integrity)
    evidence.packageLockSha256 = sha(await fs.readFile(path.join(project, 'package-lock.json')))
    evidence.tarballActuallyRequested = registry.snapshot().requests.some(item => item.tarball && item.package === libraryCodeProbe.name && item.status === 200)
    assert.equal(evidence.tarballActuallyRequested, true)
    await session.settle()
    await page.evaluate(async ({ project, type, id }) => {
      const editor = window.ng.getComponent(document.querySelector('app-blockly-editor'))
      if (editor.projectService.currentProjectPath !== project) throw Error('Fixture setup must stay in its one project')
      const workspace = window.Blockly.getMainWorkspace()
      const setup = workspace.getAllBlocks(false).find(block => block.type === 'arduino_setup')
      if (!setup || setup.getInput('ARDUINO_SETUP').connection.targetBlock()) throw Error('Expected an empty fixture setup')
      const probe = workspace.newBlock(type, id); probe.initSvg(); probe.render()
      setup.getInput('ARDUINO_SETUP').connection.connect(probe.previousConnection)
      const saved = await editor.projectService.save(project)
      if (!saved?.success) throw Error('The real fixture native save failed')
    }, { project, type: libraryCodeProbe.blockType, id: libraryCodeProbe.blockId })
    return evidence
  } finally { await session.history.dispose() }
}

export async function inspectLibraryCodeProbe(project, expectedText, authored) {
  const manifest = JSON.parse(await fs.readFile(path.join(project, 'package.json'))), declared = manifest.dependencies[libraryCodeProbe.name]
  assert.ok(declared?.startsWith('file:'), 'The real Agent must localize the registry package through the product')
  const canonical = path.join(project, 'local-libraries', libraryCodeProbe.name)
  const root = await fs.realpath(path.join(project, 'node_modules', libraryCodeProbe.name))
  assert.ok(inside(project, root)); assert.equal(path.resolve(root).toLowerCase(), path.resolve(canonical).toLowerCase())
  assert.equal((await fs.realpath(path.resolve(project, declared.slice(5)))).toLowerCase(), root.toLowerCase())
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json')))
  assert.equal(pkg.name, libraryCodeProbe.name); assert.equal(pkg.version, libraryCodeProbe.version)
  const cpp = path.join(root, libraryCodeProbe.cpp)
  assert.equal(await fs.readFile(cpp, 'utf8'), expectedText, 'Only the requested C++ constant may change; the assertion must stay')
  for (const file of authored.files.filter(file => file.path !== libraryCodeProbe.cpp))
    assert.equal(sha(await fs.readFile(path.join(root, file.path))), file.sha256, 'Preserve every other actual packed library file')
  return { name: pkg.name, version: pkg.version, declaredDependency: declared, canonical, installedSourceRoot: root,
    cpp, cppSha256: sha(expectedText), realLocalLibrary: true, otherPackedFilesPreserved: true }
}
