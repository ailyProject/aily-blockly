import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** Structural reproducer, never a reconstruction of the customer's program. */
export async function prepareIssue787Project({ project, boardsRoot, librariesRoot }) {
  const boardRoot = path.join(boardsRoot, 'stm32f103c8')
  const manifest = JSON.parse(await fs.readFile(path.join(boardRoot, 'template/package.json'), 'utf8'))
  manifest.name = 'issue787-private-reproducer'
  const pending = Object.keys(manifest.dependencies), copied = new Set()
  for (const name of pending) {
    if (copied.has(name)) continue
    copied.add(name)
    assert.match(name, /^@aily-project\/(board-|lib-)/)
    const source = name.startsWith('@aily-project/board-') ? boardRoot : path.join(librariesRoot, name.replace('@aily-project/lib-', ''))
    const target = path.join(project, 'node_modules', name)
    await fs.cp(source, target, { recursive: true, dereference: true, force: false, errorOnExist: true,
      filter: file => !path.relative(source, file).split(path.sep).includes('node_modules') })
    const info = JSON.parse(await fs.readFile(path.join(target, 'package.json'), 'utf8'))
    pending.push(...Object.keys(info.dependencies ?? {}).filter(name => name.startsWith('@aily-project/lib-')))
  }
  const abi = JSON.parse(await fs.readFile(path.join(boardRoot, 'template/project.abi'), 'utf8'))
  const variables = Array.from({ length: 109 }, (_, i) => ({ id: `issue787-var-${i}`, name: `value_${i}`, type: 'int' }))
  const roots = Array.from({ length: 2450 }, (_, i) => ({ type: 'math_number', id: `issue787-number-${i}`,
    fields: { NUM: i }, x: 400 + i % 35 * 100, y: 50 + Math.floor(i / 35) * 80,
    ...(i === 2449 ? { icons: { comment: { text: 'Last block must survive save and restart', pinned: true, height: 80, width: 200, x: 3600, y: 5650 } } } : {}) }))
  const document = { schemaVersion: 3, activePageId: 'main', openedPageIds: ['main', 'secondary'],
    pages: [
      { id: 'main', title: 'Main', content: { blocks: { ...abi.blocks, blocks: [...abi.blocks.blocks, ...roots] } } },
      { id: 'secondary', title: 'Inactive page', content: { blocks: { languageVersion: 0,
        blocks: [{ type: 'math_number', id: 'issue787-inactive', fields: { NUM: 787 }, x: 50, y: 50 }] } } }
    ], sharedModel: { procedureBlocks: [], variables } }
  await fs.writeFile(path.join(project, 'package.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' })
  await fs.writeFile(path.join(project, 'project.abi'), JSON.stringify(document), { flag: 'wx' })
  return { board: '@aily-project/board-stm32f103c8', boardVersion: '3.0.0', activeBlocks: 2453,
    totalBlocks: 2454, variableCount: variables.length, syntheticStructure: true, customerProgram: false }
}

export function indexIssue787Document(document) {
  const blocks = new Map()
  const visit = node => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) return node.forEach(visit)
    if (typeof node.id === 'string' && typeof node.type === 'string' && ('fields' in node || /^arduino_/.test(node.type))) {
      assert.ok(!blocks.has(node.id), 'Duplicate block identity: ' + node.id)
      blocks.set(node.id, node)
    }
    for (const [key, value] of Object.entries(node)) if (!['fields', 'icons', 'variables'].includes(key)) visit(value)
  }
  visit(document)
  return blocks
}

export async function seedIssue787ExitedBuildOwner(project) {
  assert.match(project.replaceAll('\\', '/'), /\/aily-project\/dev-tests\/issue787[^/]*\/issue787-save-[^/]+\/project$/i)
  const module = fileURLToPath(new URL('../../../child/scripts/build-workspace-lease.js', import.meta.url))
  const result = spawnSync(process.execPath, ['-e',
    "require(process.argv[1]).acquireBuildWorkspace(process.argv[2], 'compile').childEnvironment();process.exit(0)", module, project],
  { windowsHide: true, encoding: 'utf8', timeout: 15000 })
  assert.equal(result.status, 0, result.stderr || result.error?.message)
  const directory = path.join(project, '.build')
  const bytes = new Map(await Promise.all((await fs.readdir(directory)).map(async name => [name, await fs.readFile(path.join(directory, name))])))
  assert.ok(bytes.size > 0)
  return { markers: bytes.size, async assertPreserved() {
    assert.deepEqual((await fs.readdir(directory)).sort(), [...bytes.keys()].sort())
    for (const [name, expected] of bytes) assert.deepEqual(await fs.readFile(path.join(directory, name)), expected,
      'An uncertain legacy build owner must stay protected: ' + name)
  } }
}
