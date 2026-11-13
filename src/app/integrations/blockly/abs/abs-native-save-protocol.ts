import type { AbsDiskSnapshot, AbsProjectAttachment, AbsStorageExecutor, AbsSyncStoragePort } from './abs-baseline-store';
import type { AbsGenerationEvidence } from './abs-generation-protocol';
import type { ProjectPublicationOperation } from '@domain/project/public-api';
import type { AbsBlockState, AbsBlockStateUpdateRequest } from './abs-block-state';
import { absJson, hashAbsText } from './abs-identity-map';
import { AbsSyncError } from './abs-state';

export interface NativeSaveIdentity {
  version: 2; requestId: string; operation: ProjectPublicationOperation; inputDigest: string;
}
export interface NativeSaveOperationRef {
  operationId: string; request: NativeSaveIdentity; attachment: AbsProjectAttachment; executor: AbsStorageExecutor;
}
export interface NativeSaveStageInput {
  ref: NativeSaveOperationRef; evidence: AbsGenerationEvidence; inputAbiHash: string | null; appliedRevision?: number;
  blockState?: NativeSaveBlockStateReceipt;
}
export interface NativeSaveBlockStateReceipt {
  version: 2; requestId: string; action: 'update'; expectedGeneration?: string; expectedCanvas?: string;
  changes: AbsBlockStateUpdateRequest['changes']; inputAbiHash: string | null;
  beforeStates: AbsBlockState[]; states: AbsBlockState[]; output: AbsGenerationEvidence;
}
export interface NativeSaveCommittedFacts {
  projectSaved: boolean; generatedCodePublished: boolean; partial: boolean;
  publication: { status: 'COMMITTED'; generation: string; abiSaved: boolean; absMirrored: boolean; mapPublished: boolean; error?: string };
  evidence: AbsGenerationEvidence; requiresReload: boolean; warnings?: readonly string[];
  derivedOutputs?: Record<string, unknown>; dependencyState?: Record<string, unknown>; code?: string; error?: string;
  blockState?: NativeSaveBlockStateReceipt;
}
export interface NativeSaveFailureFacts {
  projectSaved: false; generatedCodePublished: false; partial: false;
  publication: { status: 'NOT_COMMITTED'; generation?: string };
  requiresReload: false; code: string; error?: string; cancelled?: boolean; warnings?: readonly string[];
  evidence?: never;
  blockState?: never;
}
export type NativeSaveResultFacts = NativeSaveCommittedFacts | NativeSaveFailureFacts;
export type NativeSaveObservation = { state: 'not-found'; request: NativeSaveIdentity }
  | { state: 'pending' | 'unknown'; ref?: NativeSaveOperationRef; code: string; publication: { status: 'UNKNOWN' } }
  | { state: 'completed'; ref: NativeSaveOperationRef; result: NativeSaveResultFacts; current: boolean };
export interface NativeSaveSnapshot {
  version: 1; id: string; project: string; kind: 'document-save'; document: unknown;
  disk: AbsDiskSnapshot; committed: string | null; nativeSave: NativeSaveIdentity;
  attachment: AbsProjectAttachment; executor: AbsStorageExecutor;
}
const hash = (value: unknown) => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
export async function blockStatePublicationIdentity(project: string, request: AbsBlockStateUpdateRequest): Promise<NativeSaveIdentity> {
  const normalized = project.replace(/\\/g, '/').replace(/\/+$/, '');
  const projectKey = /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//') ? normalized.toLowerCase() : normalized;
  return { version: 2, requestId: `pub2-${request.requestId}`, operation: 'blocks_set_state',
    inputDigest: await hashAbsText(absJson({ version: 2, project: projectKey, operation: 'blocks_set_state', request })) };
}
export const nativeSaveError = (message: string, code = 'ABS_NATIVE_SAVE_OBSERVATION_INVALID') => new AbsSyncError(code, message);
export function assertNativeSaveIdentity(value: NativeSaveIdentity): void {
  if (value?.version !== 2 || typeof value.requestId !== 'string' || !/^pub2-[A-Za-z0-9][A-Za-z0-9._:-]{0,121}$/.test(value.requestId)
    || !['project_save', 'blocks_tidy', 'blocks_set_state', 'history_restore'].includes(value.operation) || !hash(value.inputDigest)) {
    throw nativeSaveError('Native durable saves require version 2, a reserved pub2 request ID and the original input digest.', 'ABS_NATIVE_SAVE_REQUEST_INVALID');
  }
}
export function nativeSaveCapability(port: Pick<AbsSyncStoragePort, 'attachment' | 'executor'>) {
  const attachment = port.attachment, executor = port.executor;
  if (attachment?.version !== 1 || typeof attachment.root !== 'string' || !attachment.root
    || !['dev', 'ino', 'birthtimeNs'].every(key => typeof attachment.identity?.[key] === 'string' && /^\d+$/.test(attachment.identity[key]))
    || executor?.version !== 1 || !Number.isSafeInteger(executor.hostPid) || executor.hostPid! < 1
    || !Number.isSafeInteger(executor.storagePid) || executor.storagePid < 1 || typeof executor.instanceId !== 'string' || !executor.instanceId
    || ![executor.processIdentity, executor.bootId].every(value => value === null || typeof value === 'string')) {
    throw nativeSaveError('Native save storage has no verified physical attachment/executor capability.', 'ABS_NATIVE_SAVE_CAPABILITY_REQUIRED');
  }
  return JSON.parse(absJson({ attachment, executor })) as { attachment: AbsProjectAttachment; executor: AbsStorageExecutor };
}
export async function nativeSaveIndexKey(requestId: string): Promise<string> {
  return `recoveries/request-${(await hashAbsText('native-save-v2\0' + requestId)).slice(7)}.json`;
}

/** Shared lookup: an immutable index consumes the request even if the later
 * operation pointer was never written. A copied root cannot adopt its result. */
export async function readNativeSaveRequest(port: Pick<AbsSyncStoragePort, 'read' | 'attachment' | 'executor'>,
  project: string, request: NativeSaveIdentity) {
  assertNativeSaveIdentity(request);
  const context = nativeSaveCapability(port), indexText = await port.read(await nativeSaveIndexKey(request.requestId));
  if (indexText === null) return null;
  let index: any, snapshot: NativeSaveSnapshot;
  try {
    index = JSON.parse(indexText);
    if (index.version !== 2 || index.kind !== 'native-save' || index.project !== project
      || !/^[a-f0-9-]{36}$/.test(index.operationId) || !hash(index.snapshotHash)) throw new Error('Invalid native request index.');
    const text = await port.read(`recoveries/operation-${index.operationId}.json`);
    if (text === null || await hashAbsText(text) !== index.snapshotHash) throw new Error('Original native snapshot checksum differs.');
    snapshot = JSON.parse(text);
    if (snapshot.version !== 1 || snapshot.kind !== 'document-save' || snapshot.id !== index.operationId
      || snapshot.project !== project || !snapshot.document || typeof snapshot.document !== 'object'
      || !snapshot.disk || Object.keys(snapshot.disk).sort().join(',') !== 'abi,abs,map'
      || !Object.values(snapshot.disk).every(value => value === null || typeof value === 'string')
      || snapshot.committed !== null && typeof snapshot.committed !== 'string') throw new Error('Invalid original native snapshot.');
    if (absJson(index.request) !== absJson(snapshot.nativeSave) || absJson(index.attachment) !== absJson(snapshot.attachment)
      || absJson(index.executor) !== absJson(snapshot.executor)) throw new Error('Native request bindings differ from the snapshot.');
    assertNativeSaveIdentity(snapshot.nativeSave);
    nativeSaveCapability({ attachment: snapshot.attachment, executor: snapshot.executor });
  } catch (error) { throw nativeSaveError((error as Error).message); }
  if (absJson(snapshot.nativeSave) !== absJson(request)) throw nativeSaveError('This original ID belongs to a different native input.', 'ABS_NATIVE_SAVE_REQUEST_CONFLICT');
  if (absJson(snapshot.attachment) !== absJson(context.attachment))
    throw nativeSaveError('The original native request belongs to a different physical project attachment.', 'ABS_NATIVE_SAVE_ATTACHMENT_CHANGED');
  return { snapshot, snapshotHash: index.snapshotHash as string, ref: {
    operationId: snapshot.id, request: snapshot.nativeSave, attachment: snapshot.attachment, executor: snapshot.executor,
  } as NativeSaveOperationRef };
}

export function assertNativeSaveRef(actual: NativeSaveOperationRef, expected: NativeSaveOperationRef): void {
  if (absJson(actual) !== absJson(expected)) throw nativeSaveError('The exact original native operation reference differs.');
}
