import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

// A read-only source archive and a fresh suite-owned target. Never follow a
// junction, reuse an old workspace or rewrite a copied ABS/map credential.
const root = path.resolve(process.env.AILY_STEP_ROOT ?? '')
const output = path.resolve(process.env.AILY_STEP_OUTPUT ?? '')
assert.match(root.replaceAll('\\', '/'), /^C:\/.*\/aily-project\/dev-tests\/abs-serial-analysis-20261028$/i)
assert.match(output.replaceAll('\\', '/'), /\/aily-blockly\/e2e\/test-results\/abs-semantic-identity-20261029(?:\/|$)/i)
assert.equal((await fs.realpath(root)).toLowerCase(), root.toLowerCase())
const seed = path.join(root, 'archive-user-project/esp32-c3-HANTAI')
const target = path.join(root, `serial-agent-identity-${randomUUID()}`, 'project')
assert.ok(path.relative(root, target).startsWith('serial-agent-identity-'))
await assert.rejects(fs.lstat(target), { code: 'ENOENT' })
const digest = value => createHash('sha256').update(value).digest('hex')
const hashes = async () => {
  const result = {}
  async function visit(dir, prefix = '') {
    for (const item of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? `${prefix}/${item.name}` : item.name, file = path.join(dir, item.name)
      const stat = await fs.lstat(file)
      if (stat.isSymbolicLink()) result[relative] = 'link:' + digest(await fs.readlink(file))
      else if (stat.isDirectory()) await visit(file, relative)
      else if (stat.isFile()) result[relative] = digest(await fs.readFile(file))
    }
  }
  await visit(seed)
  return result
}
const sourceBefore = await hashes(), skipped = [], copied = []
const excluded = new Set(['.git', '.temp', '.build', '.log', '.workspace-history', 'test-results', 'playwright-report'])
async function copy(dir, destination, prefix = '') {
  await fs.mkdir(destination, { recursive: true })
  for (const item of await fs.readdir(dir, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${item.name}` : item.name, file = path.join(dir, item.name)
    const stat = await fs.lstat(file)
    if (excluded.has(item.name) || stat.isSymbolicLink()) { skipped.push(relative); continue }
    if (stat.isDirectory()) await copy(file, path.join(destination, item.name), relative)
    else if (stat.isFile()) { await fs.copyFile(file, path.join(destination, item.name), fs.constants.COPYFILE_EXCL); copied.push(relative) }
  }
}
await copy(seed, target)
assert.deepEqual(await hashes(), sourceBefore, 'The original source archive must be unchanged')
await fs.mkdir(output, { recursive: true })
const evidence = { project: target, source: seed, sourceFiles: Object.keys(sourceBefore).length,
  sourceSha256: digest(JSON.stringify(sourceBefore)), sourcePreserved: true, copiedFiles: copied.length, skipped,
  copiedCredentialsUntouched: true, recoveryRequiredThroughAgentOnly: true }
await fs.writeFile(path.join(output, 'preparation.json'), JSON.stringify(evidence, null, 2))
console.log(JSON.stringify(evidence))
