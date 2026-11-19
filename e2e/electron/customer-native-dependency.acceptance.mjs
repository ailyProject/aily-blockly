import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: Object.fromEntries([
  'dependency-input', 'test-root', 'output', 'agent-root', 'executable-path', 'host-build', 'case'
].map(name => [name, { type: 'string' }])) })
for (const name of ['dependency-input', 'test-root', 'output', 'agent-root'])
  assert.ok(values[name] && path.isAbsolute(values[name]), `--${name} must be absolute`)
assert.match(values['test-root'].replaceAll('\\', '/'), /\/aily-project\/dev-tests\//i)
assert.ok(!!values['executable-path'] !== !!values['host-build'])
const mode = values.case ?? 'dependency'
assert.ok(['dependency', 'publication'].includes(mode), '--case must be dependency or publication')
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const seed = await fs.realpath(values['dependency-input'])
const seedManifestFile = path.join(seed, 'package.json')
const seedManifestBytes = await fs.readFile(seedManifestFile)
const seedManifest = JSON.parse(seedManifestBytes)
assert.ok(seedManifest.board && seedManifest.dependencies)
await fs.mkdir(values['test-root'], { recursive: true })
const input = await fs.mkdtemp(path.join(values['test-root'], 'native-required-input-'))
for (const name of ['node_modules', 'local-libraries']) {
  const source = path.join(seed, name)
  try { await fs.lstat(source) } catch (error) { if (error.code === 'ENOENT' && name === 'local-libraries') continue; throw error }
  await fs.cp(source, path.join(input, name), { recursive: true, force: false, errorOnExist: true,
    filter: async file => {
      const stat = await fs.lstat(file)
      assert.ok(!stat.isSymbolicLink() && (stat.isDirectory() || stat.isFile()),
        'Use only detached physical dependencies; never borrow mutable customer paths')
      return true
    } })
}
const manifest = { name: 'native-required-dependency-fixture', version: '0.0.1',
  description: 'Owned inert native dependency acceptance', board: seedManifest.board,
  dependencies: structuredClone(seedManifest.dependencies) }
await fs.writeFile(path.join(input, 'package.json'), JSON.stringify(manifest, null, 2))
try {
  const lock = JSON.parse(await fs.readFile(path.join(seed, 'package-lock.json'), 'utf8'))
  lock.name = manifest.name; lock.version = manifest.version
  if (lock.packages?.['']) {
    lock.packages[''].name = manifest.name; lock.packages[''].version = manifest.version
    lock.packages[''].dependencies = manifest.dependencies
    delete lock.packages[''].scripts
  }
  await fs.writeFile(path.join(input, 'package-lock.json'), JSON.stringify(lock, null, 2))
} catch (error) { if (error.code !== 'ENOENT') throw error }
const document = { $ailyProjectData: { schemaVersion: 1, mode: 'external-only' }, schemaVersion: 3,
  activePageId: 'page-1', openedPageIds: ['page-1'],
  pages: [{ id: 'page-1', title: 'Native dependency fixture', content: { blocks: { languageVersion: 0,
    blocks: [{ type: 'text', id: 'native-dependency-text', x: 10, y: 20, fields: { TEXT: 'native_dependency_original' } }] } },
    viewState: { scale: 1, scrollX: 0, scrollY: 0 } }], sharedModel: { procedureBlocks: [] } }
await fs.writeFile(path.join(input, 'project.abi'), JSON.stringify(document, null, 2))
await fs.writeFile(path.join(input, 'ordinary-history-probe.txt'), 'ordinary-before-abort\n')
const args = [fileURLToPath(new URL('./customer-project-baseline.acceptance.mjs', import.meta.url)),
  mode === 'dependency' ? '--native-dependency-only' : '--native-publication-only', '--project-input', input]
for (const name of ['test-root', 'output', 'agent-root', 'executable-path', 'host-build'])
  if (values[name]) args.push('--' + name, values[name])
const exitCode = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { stdio: 'inherit', env: process.env })
  child.once('error', reject)
  child.once('exit', (code, signal) => resolve(signal ? 1 : code ?? 1))
})
assert.equal(digest(await fs.readFile(seedManifestFile)), digest(seedManifestBytes), 'The donor dependency project is read-only')
await fs.writeFile(path.join(values.output, 'prepared-input.json'), JSON.stringify({
  input, case: mode, dependencySeed: seed, generatedInertDocument: true, originalProgramCopied: false,
  rootScriptsPresent: false, donorManifestUnchanged: true, dependencyCount: Object.keys(manifest.dependencies).length
}, null, 2))
process.exitCode = exitCode
