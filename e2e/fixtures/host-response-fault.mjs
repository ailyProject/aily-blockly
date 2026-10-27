import assert from 'node:assert/strict'
import http from 'node:http'
import { syncBuiltinESMExports } from 'node:module'

/** Lose one real loopback response only after the actual host completed it.
 * No tool, receipt, project-file operation or host handler is stubbed. */
export function dropOneHostResponse(match) {
  const original = http.request
  let dropped
  http.request = function (options, callback) {
    if (!options || typeof options !== 'object' || options.host !== '127.0.0.1'
      || options.path !== '/command' || typeof callback !== 'function')
      return original.apply(this, arguments)
    const written = []
    let request
    request = original.call(this, options, response => {
      let payload
      try { payload = JSON.parse(Buffer.concat(written).toString('utf8')) } catch { /* Ordinary request. */ }
      if (dropped || !payload || !match(payload)) return callback(response)
      const received = []
      response.on('data', chunk => received.push(Buffer.from(chunk)))
      response.on('end', () => {
        let result
        try { result = JSON.parse(Buffer.concat(received).toString('utf8')) } catch { result = undefined }
        dropped = { operation: payload.operation, result }
        request.emit('error', new Error('Isolated lost acknowledgement after actual Host completion'))
      })
      response.on('error', error => request.emit('error', error))
    })
    const write = request.write
    request.write = function (chunk, ...args) {
      written.push(Buffer.from(chunk))
      return write.call(this, chunk, ...args)
    }
    return request
  }
  syncBuiltinESMExports()
  return {
    get dropped() { return dropped },
    restore() {
      assert.notEqual(http.request, original, 'Fault must be restored exactly once')
      http.request = original
      syncBuiltinESMExports()
    }
  }
}
