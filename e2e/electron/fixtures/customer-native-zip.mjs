import assert from 'node:assert/strict'
import path from 'node:path'
import nativeFs from 'node:fs'
import fsPromises from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const require = createRequire(import.meta.url)
const yauzl = require('yauzl')
const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1
  return value >>> 0
})
const streamHash = async file => {
  const hash = createHash('sha256')
  for await (const chunk of nativeFs.createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

export async function extractNativeCustomerZip({ archive, prefix, project, output, expectedArchiveSha256, fs = fsPromises,
  sha = bytes => createHash('sha256').update(bytes).digest('hex') }) {
  assert.ok(path.isAbsolute(archive) && path.isAbsolute(project) && path.isAbsolute(output))
  assert.equal(await fs.lstat(project).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error }), false)
  assert.ok(typeof prefix === 'string' && prefix.endsWith('/') && !prefix.includes('..'))
  const archiveHash = await streamHash(archive), records = [], names = new Set()
  if (expectedArchiveSha256 !== undefined) assert.equal(archiveHash, expectedArchiveSha256, 'Original user ZIP identity changed')
  let uncompressedBytes = 0, extractedBytes = 0, skippedBytes = 0
  await fs.mkdir(project, { recursive: false })
  const zip = await new Promise((resolve, reject) => yauzl.open(archive, {
    lazyEntries: true, strictFileNames: true, validateEntrySizes: true
  }, (error, value) => error ? reject(error) : resolve(value)))
  await new Promise((resolve, reject) => {
    let failed = false
    const fail = error => { if (!failed) { failed = true; zip.close(); reject(error) } }
    zip.on('error', fail); zip.on('end', resolve)
    zip.on('entry', entry => {
      ;(async () => {
        const filename = entry.fileName
        assert.ok(!filename.includes('\\') && !filename.includes('\0') && !path.win32.isAbsolute(filename))
        assert.ok(filename.startsWith(prefix), 'Unexpected archive project root: ' + filename)
        const relative = filename.slice(prefix.length), directory = filename.endsWith('/')
        const parts = relative.replace(/\/$/, '').split('/').filter(Boolean)
        assert.ok(parts.every(part => part !== '.' && part !== '..' && !/[:\x00-\x1f]/.test(part)
          && !/[ .]$/.test(part) && !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part)), 'Unsafe Windows entry: ' + filename)
        const key = parts.join('/'), folded = key.toLowerCase()
        assert.ok(!names.has(folded), 'Duplicate or case-colliding entry: ' + filename); names.add(folded)
        const mode = entry.externalFileAttributes >>> 16 & 0xf000
        assert.ok(mode === 0 || mode === 0x8000 && !directory || mode === 0x4000 && directory, 'Links/special files are forbidden: ' + filename)
        assert.equal(entry.generalPurposeBitFlag & 1, 0, 'Encrypted ZIP entries are not allowed')
        uncompressedBytes += entry.uncompressedSize
        assert.ok(uncompressedBytes <= 256 * 1024 * 1024, 'Unexpected project ZIP expansion')
        const skipped = parts[0] === '.build'
        const receipt = { zipPath: filename, relative: key, directory, bytes: entry.uncompressedSize,
          compressedBytes: entry.compressedSize, crc32: entry.crc32 >>> 0, skipped,
          ...(skipped ? { reason: 'original root .build compiler output' } : {}) }
        records.push(receipt)
        if (skipped) { skippedBytes += entry.uncompressedSize; return }
        const destination = path.resolve(project, ...parts), fromRoot = path.relative(project, destination)
        assert.ok(destination === path.resolve(project) || fromRoot !== '..' && !fromRoot.startsWith('..' + path.sep) && !path.isAbsolute(fromRoot))
        if (directory) { await fs.mkdir(destination, { recursive: true }); return }
        assert.ok(key)
        await fs.mkdir(path.dirname(destination), { recursive: true })
        const input = await new Promise((resolveStream, rejectStream) => zip.openReadStream(entry, (error, stream) => error ? rejectStream(error) : resolveStream(stream)))
        const hash = createHash('sha256'); let count = 0, crc = 0xffffffff
        const checked = new Transform({ transform(chunk, encoding, callback) {
          count += chunk.length; hash.update(chunk)
          for (const byte of chunk) crc = crcTable[(crc ^ byte) & 255] ^ crc >>> 8
          callback(null, chunk)
        } })
        await pipeline(input, checked, nativeFs.createWriteStream(destination, { flags: 'wx' }))
        assert.equal(count, entry.uncompressedSize, 'ZIP size mismatch: ' + filename)
        assert.equal((crc ^ 0xffffffff) >>> 0, entry.crc32 >>> 0, 'ZIP CRC mismatch: ' + filename)
        receipt.zipContentSha256 = hash.digest('hex')
        receipt.extractedSha256 = await streamHash(destination)
        assert.equal(receipt.extractedSha256, receipt.zipContentSha256, 'Extracted content mismatch: ' + filename)
        extractedBytes += count
      })().then(() => { if (!failed) zip.readEntry() }).catch(error => fail(new Error('User ZIP entry ' + entry.fileName + ': ' + error.message, { cause: error })))
    })
    zip.readEntry()
  })
  assert.equal(await streamHash(archive), archiveHash, 'The original archive must remain unchanged')
  const receipt = { version: 1, archive, archiveSha256: archiveHash, prefix, project,
    originalArchiveReadOnly: true, unchangedOriginalScopeMetadata: true, pathsValidatedNoLinks: true,
    exclusionRule: 'Only original root .build/; all .log/.aily/.temp/.workspace-history/assets/node_modules/source retained.',
    uncompressedBytes, extractedBytes, skippedBytes, entryCount: records.length,
    indexSha256: sha(JSON.stringify(records)), records }
  const manifestFile = path.join(output, 'original-user-zip-extraction.json')
  await fs.writeFile(manifestFile, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' })
  return { ...receipt, manifestFile }
}
