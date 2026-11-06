import type { AbsSyncStoragePort } from './abs-baseline-store';
import { assertAbsSourceEdits, type AbsSourceEdits } from './abs-edit-provenance';
import { absJson, hashAbsText } from './abs-identity-map';
import { AbsSyncError } from './abs-state';

const MAX_CANDIDATE_BYTES = 64 * 1024 * 1024;
const MAX_RECORD_BYTES = 128 * 1024 * 1024;
const MAX_EDIT_PROOF_BYTES = 520 * 1024;
const hashPattern = /^sha256:[a-f0-9]{64}$/;
type DamagedPredecessor = { recordHash: string } & ({ hash: string }
  | { readFailure: 'ABS_STORAGE_ENCODING_INVALID' | 'PROJECT_FILE_TOO_LARGE' });
export interface AbsCandidateBackupInput {
  hash: string; bytes: number; intentGeneration?: string; sourceEdits?: AbsSourceEdits;
  /** Opaque SDK history data. Archival does not verify or grant its authority. */
  editProof?: unknown;
}
export interface AbsCandidateArchive {
  version: 1; project: string; recordHash: string; path: string; hash: string; bytes: number; candidateApplied: false;
}
/** Preserve the host's existing dependency diagnosis while carrying only the
 * trusted backup reference across its runtime-preparation error boundary. */
export class AbsCandidateRuntimePreparationFailure extends Error {
  constructor(readonly original: unknown, readonly candidateArchive: AbsCandidateArchive) {
    super('Runtime preparation failed after the candidate was backed up.');
  }
}

function assertInput(value: unknown): asserts value is AbsCandidateBackupInput {
  const input = value as AbsCandidateBackupInput;
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['hash', 'bytes', 'intentGeneration', 'sourceEdits', 'editProof'].includes(key))
    || !hashPattern.test(input.hash ?? '') || !Number.isSafeInteger(input.bytes) || input.bytes < 0 || input.bytes > MAX_CANDIDATE_BYTES
    || input.intentGeneration !== undefined && (typeof input.intentGeneration !== 'string' || !/^[A-Za-z0-9_-]{1,96}$/.test(input.intentGeneration)))
    throw new AbsSyncError('ABS_CANDIDATE_ARCHIVE_INVALID', 'A candidate backup requires its exact bounded source hash, byte length and original origin.');
  assertAbsSourceEdits(input.sourceEdits);
}

function boundedEditProof(value: unknown): unknown {
  try {
    const text = JSON.stringify(value);
    return typeof text === 'string' && new TextEncoder().encode(text).byteLength <= MAX_EDIT_PROOF_BYTES
      ? JSON.parse(text) : undefined;
  } catch { return undefined; } // Optional history cannot prevent full source preservation.
}

export function assertCandidateArchiveRequest(input: Record<string, any>) {
  const preserve = input['action'] === 'preserve_candidate';
  const allowed = preserve ? ['version', 'requestId', 'action', 'candidate', 'abs', 'absPath']
    : ['version', 'requestId', 'action', 'recordHash'];
  if ((!preserve && input['action'] !== 'read_candidate') || Object.keys(input).some(key => !allowed.includes(key)))
    throw new AbsSyncError('ABS_CANDIDATE_ARCHIVE_INVALID', 'Candidate backup accepts only its exact preserve or read fields.');
  if (preserve) {
    assertInput(input['candidate']);
    const text = typeof input['abs'] === 'string', file = typeof input['absPath'] === 'string';
    if (text === file || file && !input['absPath'].trim())
      throw new AbsSyncError('ABS_CANDIDATE_ARCHIVE_INVALID', 'Provide exactly one candidate source or transfer path.');
  } else if (!hashPattern.test(input['recordHash'] ?? ''))
    throw new AbsSyncError('ABS_CANDIDATE_ARCHIVE_INVALID', 'Candidate backup reads require the exact original record hash.');
}

/** Unapplied bytes and claimed origins are recovery data, never a new baseline,
 * an apply receipt, or authority to bind an unknown candidate to current state. */
export class AbsCandidateJournal {
  constructor(private readonly port: AbsSyncStoragePort, private readonly project: string,
    private readonly assertCurrent: () => void) {}

  private key(recordHash: string) {
    if (!hashPattern.test(recordHash)) throw new AbsSyncError('ABS_CANDIDATE_ARCHIVE_INVALID', 'Invalid candidate archive hash.');
    return `recoveries/candidate-${recordHash.slice(7)}.json`;
  }
  private reference(recordHash: string, candidate: AbsCandidateBackupInput): AbsCandidateArchive {
    return { version: 1, project: this.project, recordHash, path: `${this.project}/.aily/abs-sync/${this.key(recordHash)}`,
      hash: candidate.hash, bytes: candidate.bytes, candidateApplied: false };
  }
  private async verify(source: string, candidate: AbsCandidateBackupInput) {
    assertInput(candidate);
    if (typeof source !== 'string' || new TextEncoder().encode(source).byteLength !== candidate.bytes
      || await hashAbsText(source) !== candidate.hash)
      throw new AbsSyncError('ABS_CANDIDATE_ARCHIVE_INVALID', 'Candidate source does not match its original hash and byte length.');
    this.assertCurrent();
  }
  async preserve(source: string, input: AbsCandidateBackupInput): Promise<AbsCandidateArchive> {
    assertInput(input);
    const { editProof, ...metadata } = input, proof = boundedEditProof(editProof);
    const candidate = JSON.parse(absJson({ ...metadata, ...(proof !== undefined ? { editProof: proof } : {}) })) as AbsCandidateBackupInput;
    await this.verify(source, candidate);
    const record = { version: 1, kind: 'abs-candidate', project: this.project, candidate: { ...candidate, source } };
    return this.port.withLock(async storage => {
      let damagedPredecessor: DamagedPredecessor | undefined;
      const seen = new Set<string>();
      while (true) {
        const text = absJson({ ...record, ...(damagedPredecessor ? { damagedPredecessor } : {}) });
        if (new TextEncoder().encode(text).byteLength > MAX_RECORD_BYTES)
          throw new AbsSyncError('ABS_CANDIDATE_ARCHIVE_TOO_LARGE', 'Encoded candidate backup exceeds the project storage limit.');
        const recordHash = await hashAbsText(text), key = this.key(recordHash);
        if (seen.has(recordHash)) throw new AbsSyncError('ABS_CANDIDATE_ARCHIVE_CONFLICT', 'Cyclic damaged candidate backup history.');
        seen.add(recordHash); this.assertCurrent();
        let before: string | null;
        try { before = await storage.read(key); }
        catch (error) {
          const code = (error as any)?.code;
          if (code !== 'ABS_STORAGE_ENCODING_INVALID' && code !== 'PROJECT_FILE_TOO_LARGE') throw error;
          damagedPredecessor = { recordHash, readFailure: code };
          continue;
        }
        if (before !== null && before !== text) {
          // The verified complete candidate is still available. Retain the bad
          // original and append a new immutable record; the observed damaged
          // hash is history only and grants no generation or apply authority.
          damagedPredecessor = { recordHash, hash: await hashAbsText(before) };
          continue;
        }
        if (before === null && !await storage.replace(key, null, text))
          throw new AbsSyncError('ABS_CANDIDATE_ARCHIVE_CONFLICT', 'Candidate backup publication conflicted with another writer.');
        this.assertCurrent();
        if (await storage.read(key) !== text) throw new AbsSyncError('ABS_CANDIDATE_ARCHIVE_CONFLICT', 'Candidate backup readback did not match.');
        return this.reference(recordHash, candidate);
      }
    });
  }
  async read(recordHash: string) {
    const text = await this.port.read(this.key(recordHash));
    if (text === null || new TextEncoder().encode(text).byteLength > MAX_RECORD_BYTES || await hashAbsText(text) !== recordHash)
      throw new AbsSyncError('ABS_CANDIDATE_ARCHIVE_UNAVAILABLE', 'The original candidate backup is missing or changed.');
    let record: any;
    try { record = JSON.parse(text); } catch { throw new AbsSyncError('ABS_CANDIDATE_ARCHIVE_INVALID', 'The candidate backup record is invalid.'); }
    if (record?.version !== 1 || record.kind !== 'abs-candidate' || record.project !== this.project
      || Object.keys(record).some(key => !['version', 'kind', 'project', 'candidate', 'damagedPredecessor'].includes(key))
      || !record.candidate || typeof record.candidate.source !== 'string')
      throw new AbsSyncError('ABS_CANDIDATE_ARCHIVE_INVALID', 'The candidate backup does not identify this project and source.');
    if (record.damagedPredecessor !== undefined) {
      const previous = record.damagedPredecessor;
      const shape = previous && typeof previous === 'object' && !Array.isArray(previous)
        ? Object.keys(previous).sort().join(',') : '';
      if (!hashPattern.test(previous?.recordHash ?? '') || !(shape === 'hash,recordHash' && hashPattern.test(previous.hash ?? '')
        || shape === 'readFailure,recordHash' && ['ABS_STORAGE_ENCODING_INVALID', 'PROJECT_FILE_TOO_LARGE'].includes(previous.readFailure)))
        throw new AbsSyncError('ABS_CANDIDATE_ARCHIVE_INVALID', 'The damaged backup observation is invalid.');
    }
    const { source, ...candidate } = record.candidate;
    await this.verify(source, candidate);
    if (absJson(record) !== text) throw new AbsSyncError('ABS_CANDIDATE_ARCHIVE_INVALID', 'The candidate backup encoding changed.');
    const proof = boundedEditProof(candidate.editProof);
    return { candidateArchive: this.reference(recordHash, candidate),
      candidate: { source, ...(candidate.intentGeneration !== undefined ? { intentGeneration: candidate.intentGeneration } : {}),
        ...(candidate.sourceEdits !== undefined ? { sourceEdits: candidate.sourceEdits } : {}),
        ...(proof !== undefined ? { editProof: proof } : {}) } };
  }
}
