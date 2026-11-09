import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
export function selectedWorkingCandidateRef(snapshot, project, file = 'project.abs') {
  const entries = snapshot.entries ?? []
  const checkpoint = entries.findLast(entry => entry.type === 'custom' && entry.customType === 'aily.workspace-history'
    && entry.data?.candidateRefs?.[file] && (!entry.data.workspaceRoot || same(entry.data.workspaceRoot, project)))
  assert.ok(checkpoint, 'The actual linear test branch must persist its selected candidate reference')
  return { ref: checkpoint.data.candidateRefs[file], checkpointEntryId: checkpoint.id, checkpoint: checkpoint.data }
}

/** Read immutable objects selected by the real Pi checkpoint. The current head
 * and matching source bytes are assertions only, never a reference selector. */
export async function readWorkingCandidateEvidence({ project, snapshot, ref, candidateHash, expectedBase, file = 'project.abs' }) {
  const selected = snapshot ? selectedWorkingCandidateRef(snapshot, project, file) : undefined
  ref ??= selected?.ref
  assert.equal(ref?.version, 1); assert.match(ref.id, /^[a-f0-9-]{36}$/); assert.match(ref.revisionHash, /^[a-f0-9]{64}$/)
  if (selected) assert.deepEqual(ref, selected.ref)
  const object = async (hash, bytes) => {
    assert.match(hash, /^[a-f0-9]{64}$/)
    const filename = path.join(project, '.workspace-history', 'objects', hash.slice(0, 2), hash + '.blob')
    const stat = await fs.lstat(filename); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1)
    const contents = await fs.readFile(filename); assert.equal(sha(contents), hash)
    if (bytes !== undefined) assert.equal(contents.length, bytes)
    const text = contents.toString('utf8'); assert.deepEqual(Buffer.from(text), contents)
    return { filename, text }
  }
  const manifest = await object(ref.revisionHash), record = JSON.parse(manifest.text)
  assert.equal(record.id, ref.id); assert.equal(record.version, 1); assert.equal(record.kind, 'agent')
  assert.ok(same(record.project.attachment.root, await fs.realpath(project)))
  assert.equal(record.project.logicalId, sha(record.project.attachment.root))
  assert.equal(record.intent.anchorId, record.owner.intentAnchorId)
  if (snapshot) {
    assert.equal(record.owner.sessionId, snapshot.sessionId)
    assert.ok(snapshot.entries.some(entry => entry.id === record.owner.intentAnchorId && entry.type === 'message' && entry.message.role === 'user'))
  }
  const source = await object(record.source.hash, record.source.bytes)
  if (candidateHash) assert.equal('sha256:' + record.source.hash, candidateHash)
  for (const key of ['document', 'abs', 'map', 'contracts']) await object(record.base[key].hash, record.base[key].bytes)
  if (expectedBase) assert.deepEqual(record.base, expectedBase)
  return { ref, record, sourcePath: source.filename, source: source.text, manifestPath: manifest.filename,
    checkpointEntryId: selected?.checkpointEntryId, sourceHash: 'sha256:' + record.source.hash }
}
