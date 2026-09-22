import { AbsIdentityMap, AbsProjection, AbsSyncError } from './abs-state';
import { absJson, hashAbsText } from './abs-identity-map';
import { AbsPreparedVariable, AbsVariableCreation, assertAbsVariableCreations, planAbsVariableCreations } from './abs-variable-intents';
import { assertAbsSourceEdits, type AbsSourceEdits } from './abs-edit-provenance';
import { assertAbsNativeModelDeclarations, type AbsNativeModelDeclaration } from './abs-native-model-declarations';

/** A byte-bound wire view, not an authority to modify the immutable baseline. */
export interface AbsGenerationBinding {
  generation: string;
  scope: AbsIdentityMap['scope'];
  abiHash: string | null;
  absHash: string;
  mapHash: string;
}
export interface AbsGenerationEvidence { binding: AbsGenerationBinding; absBytes: number }
export interface AbsGenerationRequest { version: 2; requestId: string }
export interface AbsGenerationCandidateRequest extends AbsGenerationRequest {
  base: AbsGenerationBinding;
  candidate: { hash: string; bytes: number };
  createVariables?: AbsVariableCreation[];
  sourceEdits?: AbsSourceEdits;
}
export interface AbsGenerationValidation extends AbsGenerationCandidateRequest {
  workspaceRevision: number;
  preparedVariables?: AbsPreparedVariable[];
  preparedModels?: AbsNativeModelDeclaration[];
  /** Exact baseline IDs retired by host policy before preparing new models. */
  retiredModels?: string[];
}

const hash = (value: unknown) => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
export function assertGenerationRequest(value: any): asserts value is AbsGenerationRequest & Record<string, any> {
  if (value?.version !== 2) {
    throw new AbsSyncError('ABS_PROTOCOL_REQUIRED', 'ABS tools require generation protocol version 2. Update the host and Agent together.');
  }
  if (typeof value.requestId !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(value.requestId)) {
    throw new AbsSyncError('ABS_REQUEST_INVALID', 'A valid generation requestId is required.', undefined, [], { reason: 'invalid-request-id' });
  }
}
export function assertGenerationProjectionRequest(value: any): void {
  assertGenerationRequest(value);
  if (!hash(value['expectedAbiHash'])
    || ['initialize', 'publish', 'reuseCurrent', 'synchronize'].some(key => value[key] !== undefined && typeof value[key] !== 'boolean')
    || value['rebind'] !== undefined && !hash(value['rebind'])) {
    throw new AbsSyncError('ABS_REQUEST_INVALID', 'Invalid generation export options.');
  }
}
export function assertGenerationCandidate(value: any): asserts value is AbsGenerationCandidateRequest & Record<string, any> {
  assertGenerationRequest(value);
  assertAbsVariableCreations(value['createVariables']);
  assertAbsSourceEdits(value['sourceEdits']);
  const { base, candidate } = value as any;
  if (!base || typeof base.generation !== 'string' || !/^[A-Za-z0-9_-]{1,96}$/.test(base.generation)
    || typeof base.scope?.projectKey !== 'string' || !base.scope.projectKey || typeof base.scope?.pageId !== 'string' || !base.scope.pageId
    || !hash(base.abiHash) || !hash(base.absHash) || !hash(base.mapHash)
    || !hash(candidate?.hash) || !Number.isSafeInteger(candidate?.bytes) || candidate.bytes < 1) {
    throw new AbsSyncError('ABS_REQUEST_INVALID', 'A saved ABI, generation binding and exact candidate bytes are required. Export the project first.');
  }
}
export function assertGenerationValidation(value: any): asserts value is AbsGenerationValidation & Record<string, any> {
  assertGenerationCandidate(value);
  assertAbsNativeModelDeclarations(value['preparedModels']);
  const retired = value['retiredModels'];
  if (retired !== undefined && (!Array.isArray(retired) || !retired.length
    || retired.some(id => typeof id !== 'string' || !id.length) || new Set(retired).size !== retired.length)) {
    throw new AbsSyncError('ABS_REQUEST_INVALID', 'Invalid retired model evidence.');
  }
  if (!Number.isSafeInteger((value as any).workspaceRevision) || (value as any).workspaceRevision < 0) {
    throw new AbsSyncError('ABS_REQUEST_INVALID', 'The prepared workspace revision is missing.');
  }
  if (value.createVariables ? absJson(value['preparedVariables'] ?? null) !== absJson(planAbsVariableCreations({ requestId: value.requestId, variables: value.createVariables }))
    : value['preparedVariables'] !== undefined) throw new AbsSyncError('ABS_REQUEST_INVALID', 'Prepared variable evidence does not match the creation intent.');
}
/** Shared wire checks. The live bridge additionally binds its library runtime fingerprint. */
export function readGenerationApplyValidation(input: any): AbsGenerationValidation & Record<string, any> {
  assertGenerationRequest(input);
  const validation = input['validation'];
  try {
    assertGenerationValidation(validation);
    if (validation.requestId !== input.requestId || validation['validation']?.scope !== 'prepared-generation'
      || validation['validation']?.ok !== true || input['chunk'] !== undefined && typeof input['chunk'] !== 'boolean') {
      throw new Error('The preparation receipt must match this request and scope.');
    }
  } catch (error) {
    throw new AbsSyncError('ABS_REQUEST_INVALID', `Invalid preparation receipt: ${(error as Error).message}`, undefined, [], {
      reason: validation == null ? 'missing-validation-receipt' : 'invalid-validation-receipt',
      hint: 'Use the current Agent ABS apply tool to prepare this candidate. Do not construct receipts or edit generation/map data manually.',
    });
  }
  return validation;
}
export async function generationEvidence(projection: AbsProjection, abi: string | null): Promise<AbsGenerationEvidence> {
  return { binding: { generation: projection.map.generation, scope: { ...projection.map.scope },
    abiHash: abi === null ? null : await hashAbsText(abi), absHash: projection.map.baseAbsHash,
    mapHash: await hashAbsText(absJson(projection.map)) }, absBytes: new TextEncoder().encode(projection.abs).byteLength };
}
