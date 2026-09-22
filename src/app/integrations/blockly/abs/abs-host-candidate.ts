import { AbsHostProjectionRequest, AbsHostProjectionReceipt, assertAbsHostProjectionRequest } from './abs-host-projection';

export interface AbsHostCandidateRequest extends Pick<AbsHostProjectionRequest, 'version' | 'requestId' | 'expectedAbiHash'> {
  candidateHash: string;
}
export interface AbsHostCandidateReceipt {
  version: 1;
  requestId: string;
  project: string;
  scope: AbsHostProjectionReceipt['scope'];
  source: { abiHash: string };
  candidate: { hash: string; bytes: number };
  validation: { ok: true; scope: 'legacy-syntax-and-project-data' };
}
export interface AbsHostApplicationReceipt extends Omit<AbsHostCandidateReceipt, 'validation'> {
  applied: { scope: AbsHostProjectionReceipt['scope']; abiHash: string; absHash: string; absBytes: number };
  validation: { ok: true; scope: 'legacy-requested-state-and-project-data' };
}
export function assertAbsHostCandidateRequest(value: unknown): asserts value is AbsHostCandidateRequest {
  assertAbsHostProjectionRequest(value);
  if (typeof (value as AbsHostCandidateRequest).candidateHash !== 'string'
    || !/^sha256:[a-f0-9]{64}$/.test((value as AbsHostCandidateRequest).candidateHash)) {
    throw new Error('Invalid ABS candidate hash.');
  }
}
export function assertAbsHostCandidateReceipt(value: unknown): asserts value is AbsHostCandidateReceipt {
  const receipt = value as AbsHostCandidateReceipt;
  assertAbsHostCandidateRequest({ ...receipt, expectedAbiHash: receipt?.source?.abiHash, candidateHash: receipt?.candidate?.hash });
  if (typeof receipt.project !== 'string' || !receipt.project || typeof receipt.scope?.pageId !== 'string' || !receipt.scope.pageId
    || !Number.isSafeInteger(receipt.scope.contextEpoch) || receipt.scope.contextEpoch < 0
    || !Number.isSafeInteger(receipt.scope.workspaceRevision) || receipt.scope.workspaceRevision < 0
    || !Number.isSafeInteger(receipt.candidate.bytes) || receipt.candidate.bytes < 1
    || receipt.validation?.ok !== true || receipt.validation.scope !== 'legacy-syntax-and-project-data') {
    throw new Error('Invalid ABS candidate validation receipt.');
  }
}
