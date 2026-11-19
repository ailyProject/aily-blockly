import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'

const sha = value => createHash('sha256').update(value).digest('hex')
const supported = new Set(['success', 'edit-build'])

/** Test-owned user text only. No system, tool, permission or product prompt is altered. */
export async function loadNaturalRequests(file, cases) {
  if (!file) return undefined
  assert.ok(path.isAbsolute(file))
  const bytes = await fs.readFile(file), value = JSON.parse(bytes)
  assert.equal(value.version, 1)
  assert.ok(value.cases && !Array.isArray(value.cases) && typeof value.cases === 'object')
  assert.ok(cases.length && cases.every(name => supported.has(name)))
  for (const name of cases) {
    const request = value.cases[name]
    assert.ok(request && typeof request.prompt === 'string' && request.prompt.trim() === request.prompt && request.prompt)
    assert.ok(Buffer.byteLength(request.prompt) <= 8192)
    assert.equal(request.prompt.includes('{{'), false, 'Natural comparison text is literal; current cwd supplies the project')
    assert.match(request.marker, /^R4_[A-Z0-9_]{1,80}$/)
  }
  return { file, hash: sha(bytes), cases: value.cases }
}

export function naturalRequest(config, scenario) {
  if (!config) return undefined
  const request = config.cases[scenario]
  assert.ok(request)
  const prompt = request.prompt
  return { prompt, marker: request.marker, templateSha256: sha(request.prompt), renderedSha256: sha(prompt),
    sourceFileSha256: config.hash, contract: 'natural-user-task', modelLogReadRequired: false,
    toolSequenceInjected: false, markerFixedAcrossArms: true }
}
