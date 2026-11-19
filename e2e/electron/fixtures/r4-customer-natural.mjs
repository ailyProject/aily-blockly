import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import semver from 'semver'
import { documentHash, sha } from './r1-customer-native.mjs'
import { singleFieldExpectedDocument } from './online-comparison.mjs'

// These are incremental natural tasks on the complete original documents.
// They do not replay the historical 60/9-turn conversations.
export const customerNaturalCases = Object.freeze({
  '787': Object.freeze({ inputAbiSha256: '1f162f73713562b4b82b81e916d1f61abda9c2eccd4d0dea82084cc50a50d24f',
    blockId: '5e6e8f32-cd08-439e-905b-80f7c861ac04', field: 'NUM', before: 720, after: 721, variable: 'posPerLiter',
    prompt: '请把当前项目里 posPerLiter 的初始值从 720 改为 721，其他功能与内容保留。应用修改后编译验证，简短告诉我结果。' }),
  chiyao: Object.freeze({ inputAbiSha256: '911cb578e55c445131c6cc57acbafbba92018fe8468b94eaa56d1f07d1580271',
    blockId: '6eef5cc8-b5d6-42a5-b65c-9ad35296ee62', field: 'NUM', before: 22, after: 23, variable: 'pin_buzzer',
    expectedCompileFailure: Object.freeze({ header: 'DS1302.h', package: '@aily-project/lib-ds1302', version: '1.0.0',
      diagnostic: 'fatal error: DS1302.h: No such file or directory',
      reason: 'The original locked published dependency contains no driver source; independently reproduced before any model turn.' }),
    prompt: '请把当前项目里 pin_buzzer 的初始值从 22 改为 23，其他功能与内容保留。应用修改后编译验证，简短告诉我结果。' })
})

const inside = (parent, child) => {
  const relative = path.relative(parent, child)
  return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
}
const pathKey = value => process.platform === 'win32' ? value.toLowerCase() : value

async function bodyInventory(root) {
  const result = []
  const visit = async directory => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      if (entry.name === 'node_modules') continue
      assert.equal(entry.isSymbolicLink(), false, 'The original project body cannot redirect through a link')
      if (entry.isDirectory()) await visit(file)
      else { assert.equal(entry.isFile(), true); result.push({ path: path.relative(root, file), sha256: sha(await fs.readFile(file)) }) }
    }
  }
  await visit(root)
  return result.sort((a, b) => a.path.localeCompare(b.path))
}

export function customerDependencyVersionMatches(installed, declared) {
  const version = String(installed ?? '').trim(), requested = String(declared ?? '').trim()
  if (!version || !requested) return false
  if (version === requested) return true
  if (!semver.valid(version)) return false
  try { return semver.satisfies(version, requested, { includePrerelease: true }) }
  catch { return false }
}

async function prepareDependencies({ input, directory, resourceRoot, boardsRoot, librariesRoot }) {
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'))
  const pending = Object.entries(manifest.dependencies ?? {}), copied = new Map(), evidence = []
  for (const [name, requestedVersion] of pending) {
    if (copied.has(name)) {
      assert.ok(String(requestedVersion).startsWith('file:') || customerDependencyVersionMatches(copied.get(name), requestedVersion),
        'Every transitive declaration must be satisfied by the one installed dependency: ' + name)
      continue
    }
    assert.match(name, /^@aily-project\/(?:board|lib)-[a-zA-Z0-9_-]+$/)
    const destination = path.join(directory, 'node_modules', name)
    const local = String(requestedVersion).startsWith('file:') ? path.resolve(directory, requestedVersion.slice(5)) : undefined
    if (local) assert.ok(inside(directory, local), 'A local library must be preserved inside this project')
    const libraryDirectory = name.slice('@aily-project/lib-'.length)
    // Read only this declared, physically detached package from the original;
    // never copy/traverse the user's complete node_modules tree or its links.
    const sources = local ? [local] : [path.join(input, 'node_modules', name), path.join(resourceRoot, 'node_modules', name),
      ...(name.startsWith('@aily-project/board-') ? [path.join(boardsRoot, name.slice('@aily-project/board-'.length))]
        : [path.join(librariesRoot, libraryDirectory), path.join(librariesRoot, libraryDirectory.replaceAll('-', '_'))])]
    let source, selected
    for (const candidate of sources) {
      const metadata = await fs.lstat(candidate).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
      if (!metadata?.isDirectory() || metadata.isSymbolicLink()) continue
      if (pathKey(await fs.realpath(candidate)) !== pathKey(path.resolve(candidate))) continue
      const pkg = JSON.parse(await fs.readFile(path.join(candidate, 'package.json'), 'utf8'))
      if (pkg.name !== name || !local && !customerDependencyVersionMatches(pkg.version, requestedVersion)) continue
      source = candidate; selected = pkg; break
    }
    assert.ok(source, 'No explicit physical package satisfies the real declaration: ' + name + '@' + requestedVersion)
    await fs.cp(source, destination, { recursive: true, dereference: false, errorOnExist: true, force: false,
      filter: async file => {
        if (path.relative(source, file).split(path.sep).some(part => ['node_modules', '.git'].includes(part))) return false
        assert.equal((await fs.lstat(file)).isSymbolicLink(), false, 'A dependency cannot follow an extra linked source')
        return true
      } })
    const bytes = await fs.readFile(path.join(destination, 'package.json')), installed = JSON.parse(bytes)
    assert.equal(installed.name, name)
    assert.equal(installed.version, selected.version)
    assert.ok(local || customerDependencyVersionMatches(installed.version, requestedVersion))
    copied.set(name, installed.version)
    evidence.push({ name, requestedVersion, version: installed.version, declarationSatisfied: true,
      localProjectSource: Boolean(local), manifestSha256: sha(bytes), source })
    pending.push(...Object.entries(installed.dependencies ?? {}).filter(([dependency]) => dependency.startsWith('@aily-project/')))
  }
  return evidence
}

export async function prepareCustomerNaturalProject({ input, directory, kind, resourceRoot, boardsRoot, librariesRoot }) {
  const goal = customerNaturalCases[kind]
  assert.ok(goal, 'Use one of the two qualified original projects')
  assert.ok(path.isAbsolute(input) && path.isAbsolute(directory))
  assert.ok(!inside(input, directory) && !inside(directory, input), 'An isolated copy cannot overlap the original input')
  const bytes = await fs.readFile(path.join(input, 'project.abi'))
  assert.equal(sha(bytes), goal.inputAbiSha256, 'The natural goal belongs to these exact original ABI bytes')
  const originalInventory = await bodyInventory(input)
  await fs.cp(input, directory, { recursive: true, dereference: false, errorOnExist: true, force: false,
    filter: file => !path.relative(input, file).split(path.sep).includes('node_modules') })
  assert.deepEqual(await bodyInventory(directory), originalInventory, 'Preserve the entire project body/resources without copying user node_modules')
  const dependencies = await prepareDependencies({ input, directory, resourceRoot, boardsRoot, librariesRoot })
  const originalDocument = JSON.parse(bytes)
  const expectedDocument = singleFieldExpectedDocument(originalDocument, goal.blockId, goal.field, goal.before, goal.after)
  let initialRequestLogFiles
  try { initialRequestLogFiles = await fs.readdir(path.join(directory, '.log/compile/requests')) }
  catch (error) { if (error.code !== 'ENOENT') throw error; initialRequestLogFiles = [] }
  return { project: directory, blockId: goal.blockId, marker: goal.variable,
    customer: { kind, ...goal, input, originalInventory, originalDocument, expectedDocument, initialRequestLogFiles, dependencies },
    sourceFixture: 'complete-original-customer-project', libraryName: null, blockType: 'math_number' }
}

export function expectedCustomerNaturalDocument(document, fixture) {
  const goal = fixture.customer
  assert.equal(documentHash(document), documentHash(goal.originalDocument), 'Opening the project must preserve every original native field before the paid task')
  return singleFieldExpectedDocument(document, goal.blockId, goal.field, goal.before, goal.after)
}

export function verifyCustomerGeneratedSource(fixture, source, edited = false) {
  const goal = fixture.customer, value = edited ? goal.after : goal.before
  assert.equal(typeof source, 'string')
  assert.ok(source.length > 0)
  const assignment = new RegExp('\\b' + goal.variable + '\\s*=\\s*\\(?\\s*' + value + '(?:\\.0+)?\\s*\\)?\\s*;')
  assert.match(source, assignment, 'The actual generated C++ must contain the requested original variable assignment')
  return { sha256: sha(source), bytes: Buffer.byteLength(source), variable: goal.variable, value }
}

export async function verifyCustomerCompilerInput(fixture, executionRoot, expectedDocument) {
  const abi = await fs.readFile(path.join(executionRoot, 'project.abi'))
  assert.deepEqual(JSON.parse(abi), expectedDocument, 'The actual request-specific compiler input must contain the full applied document')
  const sketch = await fs.readFile(path.join(executionRoot, '.temp/sketch/sketch.ino'), 'utf8')
  const source = verifyCustomerGeneratedSource(fixture, sketch, true)
  return { completeDocumentMatched: true, abiSha256: sha(abi), ...source }
}

/** Verify the existing failure only for this exact original fixture. A missing
 * toolchain, a different error, or a claimed success cannot satisfy it. */
export function verifyCustomerKnownCompileFailure(fixture, result, log, assistantText) {
  const goal = fixture.customer
  assert.equal(goal?.kind, 'chiyao')
  assert.equal(goal.inputAbiSha256, customerNaturalCases.chiyao.inputAbiSha256)
  const expected = customerNaturalCases.chiyao.expectedCompileFailure
  assert.equal(result.ok, false)
  assert.equal(result.code, 'BUILD_FAILED')
  assert.equal(result.verification?.status, 'failed')
  assert.ok(log.includes(expected.diagnostic), 'The real compiler must reproduce the independently diagnosed original failure')
  assert.match(assistantText, /失败|未通过|缺少|缺失|missing|not found|failed/i)
  return { expected: 'original-dependency-failure', actual: 'failed', header: expected.header,
    originalDependency: expected.package, originalVersion: expected.version,
    originalDriverFailureStillPresent: true, compilationFailureReported: true,
    missingHeaderMentioned: assistantText.includes(expected.header) }
}

export async function verifyCustomerOriginalUnchanged(fixture) {
  assert.deepEqual(await bodyInventory(fixture.customer.input), fixture.customer.originalInventory,
    'The complete detached original project body/resources and historical metadata must remain unchanged')
}
