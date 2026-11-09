import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import semver from 'semver'

const hash = (bytes, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding)

/** Inspect real npm-pack bytes; never invent a manifest, version or driver. */
export async function inspectDriverTarball(file) {
  assert.ok(path.isAbsolute(file))
  assert.equal((await fs.lstat(file)).isSymbolicLink(), false)
  const bytes = await fs.readFile(file)
  assert.ok(bytes.length <= 32 * 1024 ** 2)
  const archive = gunzipSync(bytes, { maxOutputLength: 128 * 1024 ** 2 }), files = []
  let manifest
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break
    const name = header.subarray(0, 100).toString().split('\0')[0]
    const prefix = header.subarray(345, 500).toString().split('\0')[0]
    const entry = prefix ? prefix + '/' + name : name
    const size = Number.parseInt(header.subarray(124, 136).toString().replaceAll('\0', '').trim() || '0', 8)
    assert.ok(Number.isSafeInteger(size) && size >= 0 && offset + 512 + size <= archive.length)
    assert.ok(entry.startsWith('package/') && !entry.split('/').includes('..'))
    assert.ok([0, 48, 53].includes(header[156]), 'Only physical regular files/directories are permitted')
    const contents = archive.subarray(offset + 512, offset + 512 + size)
    if (header[156] !== 53) {
      files.push({ path: entry.slice(8), bytes: size, sha256: hash(contents) })
      if (entry === 'package/package.json') manifest = JSON.parse(contents.toString('utf8'))
    }
    offset += 512 + Math.ceil(size / 512) * 512
  }
  assert.match(manifest?.name ?? '', /^@aily-project\/(?:lib|board)-[\w.-]+$/)
  assert.ok(semver.valid(manifest.version))
  return { file, manifest, files, bytes, sha256: hash(bytes), shasum: hash(bytes, 'sha1'),
    integrity: 'sha512-' + hash(bytes, 'sha512', 'base64') }
}

/** A closed local registry. Extra material must be supplied as another genuine
 * tarball explicitly; an unknown package/version is recorded and rejected. */
export async function createLibDriverRegistry({ tarball, additionalTarballs = [], expectedTarget = {
  name: '@aily-project/lib-ds1302', version: '1.0.1', requiredFiles: ['src/DS1302.h', 'src/DS1302.cpp', 'LICENSE']
} }) {
  assert.equal(process.env.AILY_LIBRARY_ROOT_HOST_WINDOW, '1', 'Root exclusively owns the actual acceptance window')
  const target = await inspectDriverTarball(tarball)
  assert.equal(target.manifest.name, expectedTarget.name)
  assert.equal(target.manifest.version, expectedTarget.version)
  for (const required of expectedTarget.requiredFiles)
    assert.ok(target.files.some(file => file.path === required))
  const packages = [target, ...await Promise.all(additionalTarballs.map(inspectDriverTarball))]
  const identities = new Set()
  for (const item of packages) {
    assert.ok(!identities.has(item.manifest.name + '@' + item.manifest.version))
    identities.add(item.manifest.name + '@' + item.manifest.version)
    if (item !== target) assert.notEqual(item.manifest.name, target.manifest.name,
      'A fixture target has exactly its actual packed version, never a counterfeit replacement')
  }
  let origin
  const requests = [], unknownRequests = []
  const server = http.createServer((request, response) => {
    let pathname
    try { pathname = decodeURIComponent(new URL(request.url, origin).pathname).replace(/\/$/, '') }
    catch { pathname = '/invalid-url' }
    const event = { at: Date.now(), method: request.method, path: pathname }
    requests.push(event)
    request.resume()
    const send = (status, body, type = 'application/json') => {
      const content = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))
      event.status = status; event.bodyBytes = request.method === 'HEAD' ? 0 : content.length
      response.writeHead(status, { 'content-type': type, 'content-length': content.length,
        'cache-control': 'no-store', 'access-control-allow-origin': '*' })
      response.end(request.method === 'HEAD' ? undefined : content)
    }
    const reject = (status, reason) => {
      event.rejection = reason; unknownRequests.push(event)
      send(status, { error: 'closed_fixture_registry', reason })
    }
    if (!['GET', 'HEAD'].includes(request.method)) return reject(405, 'unsupported-method')
    const tar = packages.find(item => pathname === '/tarballs/' + item.sha256 + '.tgz')
    if (tar) {
      event.package = tar.manifest.name; event.version = tar.manifest.version; event.tarball = true
      return send(200, tar.bytes, 'application/octet-stream')
    }
    const match = /^\/(\@[^/]+\/[^/]+)(?:\/([^/]+))?$/.exec(pathname)
    if (!match) return reject(404, 'unprepared-path')
    const selected = packages.filter(item => item.manifest.name === match[1])
    if (!selected.length) return reject(404, 'unprepared-package')
    const project = item => ({ ...item.manifest, dist: { shasum: item.shasum, integrity: item.integrity,
      tarball: origin + '/tarballs/' + item.sha256 + '.tgz' } })
    event.package = match[1]
    if (match[2]) {
      const exact = selected.find(item => item.manifest.version === match[2])
      if (!exact) return reject(404, 'unprepared-version')
      event.version = match[2]
      return send(200, project(exact))
    }
    const versions = Object.fromEntries(selected.map(item => [item.manifest.version, project(item)]))
    send(200, { _id: match[1], name: match[1], 'dist-tags': { latest: semver.rsort(Object.keys(versions))[0] }, versions })
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  origin = 'http://127.0.0.1:' + server.address().port
  return { origin, packages: packages.map(({ bytes, ...item }) => item),
    snapshot: () => ({ requests: structuredClone(requests), unknownRequests: structuredClone(unknownRequests),
      outboundRequestsFromRegistry: 0, modelsExecuted: 0, toolsExecuted: 0 }),
    async close() { const closed = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await closed } }
}

/** Apply to the owned Host and its npm children before launch. All scoped
 * tarball URLs are emitted by the closed registry; existing lock registry hosts
 * are replaced through npm's supported setting rather than edited by a fixture. */
export function libDriverNpmEnvironment(origin, { cache, userconfig }) {
  const url = new URL(origin)
  assert.equal(url.protocol, 'http:'); assert.equal(url.hostname, '127.0.0.1')
  assert.ok(url.port && !url.username && !url.password)
  assert.ok(path.isAbsolute(cache) && path.isAbsolute(userconfig))
  return { npm_config_offline: 'false', npm_config_registry: origin,
    npm_config_replace_registry_host: 'always', npm_config_cache: cache, npm_config_userconfig: userconfig,
    npm_config_ignore_scripts: 'true', npm_config_audit: 'false', npm_config_fund: 'false',
    npm_config_update_notifier: 'false', NO_PROXY: '127.0.0.1,localhost,::1' }
}
