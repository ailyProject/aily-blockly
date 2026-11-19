import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'

/** One immutable local build for both independently launched Electron hosts. */
export async function serveRendererBuild(buildRoot) {
  const root = await fs.realpath(buildRoot)
  const inside = file => {
    const child = path.relative(root, file)
    return child && child !== '..' && !child.startsWith('..' + path.sep) && !path.isAbsolute(child)
  }
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
    '.png': 'image/png', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.wasm': 'application/wasm' }
  const server = http.createServer(async (request, response) => {
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405).end(); return }
    try {
      let name = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname)
      if (name === '/' || !path.extname(name)) name = '/index.html'
      const file = await fs.realpath(path.resolve(root, '.' + name))
      if (!inside(file)) { response.writeHead(403).end(); return }
      const stat = await fs.stat(file)
      if (!stat.isFile()) { response.writeHead(404).end(); return }
      const body = await fs.readFile(file)
      response.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream',
        'Content-Length': body.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
      response.end(request.method === 'HEAD' ? undefined : body)
    } catch { response.writeHead(404).end() }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return { origin: `http://127.0.0.1:${address.port}`, root,
    async close() {
      const done = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      server.closeAllConnections()
      await done
    } }
}
