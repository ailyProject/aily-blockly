import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

const token = /^(?:[A-Za-z_]\w*|\d+)$/
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// This is lexical masking, not an ABS/C++ parser or an execution proof. In
// particular, a comment or string quoting an old digitalWrite is not evidence.
function codeOnly(source) {
  return source.replace(
    /(?:u8|u|U|L)?R"([^\s()\\]{0,16})\([\s\S]*?\)\1"|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g,
    value => value.replace(/[^\r\n]/g, ' ')
  )
}

/** Explicit, task-owned GPIO expectations for the actual generated sketch.
 * Callers choose the current contract: an intentional deletion/undo is valid
 * when its new required/absent set says so. This does not infer user intent,
 * enforce monotonically growing block counts, or certify hardware behavior. */
export function assertCumulativeGeneratedBehavior(sketch, { required = [], absent = [] } = {}) {
  assert.equal(typeof sketch, 'string', 'Inspect the real generated sketch, not ABS or a summary')
  assert.ok(sketch.length > 0, 'The generated sketch must not be empty')
  assert.ok(Array.isArray(required) && Array.isArray(absent) && required.length + absent.length > 0,
    'Provide explicit current behavior expectations')
  const source = codeOnly(sketch), ids = new Set(), observations = []
  for (const [expectation, entries] of [['required', required], ['absent', absent]]) for (const entry of entries) {
    assert.ok(entry && typeof entry.id === 'string' && entry.id.length > 0 && !ids.has(entry.id), 'Use unique behavior IDs')
    assert.ok(typeof entry.pin === 'string' && token.test(entry.pin), 'Use an exact generated pin token')
    assert.ok(typeof entry.value === 'string' && token.test(entry.value), 'Use an exact generated level token')
    ids.add(entry.id)
    const call = new RegExp(`\\bdigitalWrite\\s*\\(\\s*${escape(entry.pin)}\\s*,\\s*${escape(entry.value)}\\s*\\)\\s*;`, 'g')
    const count = [...source.matchAll(call)].length
    const ok = expectation === 'required' ? count > 0 : count === 0
    if (!ok) {
      const error = new Error(`${expectation === 'required' ? 'Missing' : 'Unexpected'} generated behavior: ${entry.id} (digitalWrite(${entry.pin}, ${entry.value}))`)
      error.code = expectation === 'required' ? 'CUMULATIVE_BEHAVIOR_MISSING' : 'CUMULATIVE_BEHAVIOR_UNEXPECTED'
      error.behaviorId = entry.id
      error.scope = 'artifact-contract'
      throw error
    }
    observations.push({ id: entry.id, pin: entry.pin, value: entry.value, expectation, count })
  }
  return { version: 1, scope: 'artifact-contract', ok: true,
    sketchSha256: createHash('sha256').update(sketch).digest('hex'), observations,
    limitations: ['Generated call presence/absence only; not control-flow, timing, electrical or hardware execution proof.'] }
}
