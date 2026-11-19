import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { extractNativeCustomerZip } from './customer-native-zip.mjs'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const crc32 = bytes => {
  let crc = 0xffffffff
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ crc >>> 1 : crc >>> 1 }
  return (crc ^ 0xffffffff) >>> 0
}
// Tiny uncompressed ZIPs are test data, not replacement SDK/library packages.
function zip(entries) {
  const local = [], central = []; let offset = 0
  for (const [filename, text] of entries) {
    const name = Buffer.from(filename), body = Buffer.from(text), crc = crc32(body)
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4)
    header.writeUInt16LE(0x800, 6); header.writeUInt32LE(crc, 14); header.writeUInt32LE(body.length, 18)
    header.writeUInt32LE(body.length, 22); header.writeUInt16LE(name.length, 26)
    local.push(header, name, body)
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4)
    directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x800, 8); directory.writeUInt32LE(crc, 16)
    directory.writeUInt32LE(body.length, 20); directory.writeUInt32LE(body.length, 24)
    directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(offset, 42)
    central.push(directory, name); offset += header.length + name.length + body.length
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50)
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, directory, end])
}
async function fixture(entries) {
  const outputRoot = path.resolve(import.meta.dirname, '../../test-results')
  await fs.mkdir(outputRoot, { recursive: true })
  const root = await fs.mkdtemp(path.join(outputRoot, 'customer-native-zip-'))
  const archive = path.join(root, 'input.zip'), output = path.join(root, 'result')
  await fs.writeFile(archive, zip(entries)); await fs.mkdir(output)
  return { archive, output, project: path.join(root, 'project'), prefix: 'original/' }
}
test('keeps exact source, installed libraries, recovery/history/assets/logs and excludes only root compiler outputs', async () => {
  const files = { 'package.json': '{"name":"original"}', 'project.abi': '{"schemaVersion":3}',
    'project.abs': '# original complete source\r\n', '.aily/abs-sync/committed.json': '{"original":true}',
    '.workspace-history/workspace.json': '{"retained":true}', 'node_modules/released/source.js': 'original package bytes',
    '.assets/中文.txt': '原文件\r\n', '.log/original.log': 'original diagnostic', '.build/generated.o': 'disposable compiler object' }
  const input = await fixture(Object.entries(files).map(([name, text]) => ['original/' + name, text]))
  const originalHash = sha(await fs.readFile(input.archive))
  const receipt = await extractNativeCustomerZip({ ...input, expectedArchiveSha256: originalHash })
  for (const [name, text] of Object.entries(files)) {
    if (name.startsWith('.build/')) await assert.rejects(fs.readFile(path.join(input.project, name)), { code: 'ENOENT' })
    else assert.deepEqual(await fs.readFile(path.join(input.project, name)), Buffer.from(text))
  }
  assert.equal(sha(await fs.readFile(input.archive)), originalHash)
  assert.equal(receipt.originalArchiveReadOnly, true)
  assert.equal(receipt.records.filter(record => record.skipped).length, 1)
})
test('rejects traversal, name collisions and changed archive identity without writing outside its project', async () => {
  for (const names of [['original/../escaped.txt'], ['original/Case.txt', 'original/case.txt']]) {
    const input = await fixture(names.map(name => [name, 'must stay contained']))
    await assert.rejects(extractNativeCustomerZip(input))
    await assert.rejects(fs.readFile(path.join(path.dirname(input.project), 'escaped.txt')), { code: 'ENOENT' })
  }
  const input = await fixture([['original/project.abi', '{}']])
  await assert.rejects(extractNativeCustomerZip({ ...input, expectedArchiveSha256: '0'.repeat(64) }), /identity changed/)
  await assert.rejects(fs.stat(input.project), { code: 'ENOENT' })
})
