import { absJson, hashAbsText } from './abs-identity-map';
import { AbsSyncError } from './abs-state';
import { assertWorkingCandidateRef, type WorkingCandidateRef } from './abs-working-candidate';
import type { AbsProjectAttachment, AbsSyncStoragePort } from './abs-baseline-store';

export interface AbsProgramDriftObservation {
  version: 1;
  attachment: AbsProjectAttachment;
  workingRevision: number;
  expected: Record<'abiHash' | 'absHash' | 'mapHash' | 'committedHash' | 'preparedHash', string | null>;
  sourceRef?: WorkingCandidateRef;
  originalRequestId?: string;
}

export function assertProgramDriftShape(input: unknown): asserts input is AbsProgramDriftObservation {
  const value = input as AbsProgramDriftObservation;
  const names = ['abiHash', 'absHash', 'mapHash', 'committedHash', 'preparedHash'] as const;
  if (value?.version !== 1 || !value.attachment || value.attachment.version !== 1
    || typeof value.attachment.root !== 'string' || !value.attachment.identity
    || !['dev', 'ino', 'birthtimeNs'].every(key => /^-?\d+$/.test((value.attachment.identity as any)[key]))
    || Object.keys(value).some(key => !['version', 'attachment', 'workingRevision', 'expected', 'sourceRef', 'originalRequestId'].includes(key))
    || !Number.isSafeInteger(value.workingRevision) || value.workingRevision < 0
    || !value.expected || Object.keys(value.expected).length !== names.length
    || !names.every(key => value.expected[key] === null || typeof value.expected[key] === 'string' && /^sha256:[a-f0-9]{64}$/.test(value.expected[key]!))
    || value.expected.preparedHash !== null || value.originalRequestId !== undefined &&
      (typeof value.originalRequestId !== 'string' || !/^[A-Za-z0-9-]{16,80}$/.test(value.originalRequestId) || !value.sourceRef)) {
    throw new AbsSyncError('ABS_PROGRAM_DRIFT_STALE', 'An exact physical Working and program-file observation is required.');
  }
  if (value.sourceRef) assertWorkingCandidateRef(value.sourceRef);
}

/** A deny-only witness. Only a new capture of the actual Working document can
 * choose repair output; caller text, old receipts and hashes never supply it. */
export async function assertProgramDriftObservation(port: AbsSyncStoragePort, revision: number,
  input: unknown, assertCurrent: () => void): Promise<AbsProgramDriftObservation> {
  assertProgramDriftShape(input);
  const value = input;
  const fail = () => new AbsSyncError('ABS_PROGRAM_DRIFT_STALE', 'The observed program files, physical project or Working revision changed.');
  const names = ['abiHash', 'absHash', 'mapHash', 'committedHash', 'preparedHash'] as const;
  if (value?.version !== 1 || !port.attachment || absJson(value.attachment) !== absJson(port.attachment)
    || !Number.isSafeInteger(value.workingRevision) || value.workingRevision !== revision
    ) throw fail();
  const texts = await Promise.all(['project.abi', 'project.abs', 'project.abs.map.json', 'committed.json', 'prepared.json'].map(key => port.read(key)));
  const hashes = await Promise.all(texts.map(text => text === null ? null : hashAbsText(text)));
  assertCurrent();
  if (names.some((name, index) => value.expected[name] !== hashes[index])) throw fail();
  return JSON.parse(absJson(value));
}
