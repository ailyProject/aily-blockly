import { assertGenerationCandidate, type AbsGenerationBinding } from './abs-generation-protocol';
import { absJson, hashAbsText } from './abs-identity-map';
import { AbsSyncError } from './abs-state';
import type { NativeSaveIdentity } from './abs-native-save-protocol';
import { readHistoryEnvironmentInput, hydrateHistoryEnvironment, historyEnvironmentIdentity,
  type HistoryEnvironmentPlan, type HistoryEnvironmentInput } from '../history-environment';
import type { ProjectSaveReceiptResponse } from '@domain/project/public-api';

export interface AbsObservedProgramPublication extends Omit<ProjectSaveReceiptResponse, 'operation'> {
  operation: 'abs_recovery'; project: string;
  historyPublication?: ReturnType<typeof historyPublicationReference>;
  statePublication?: { version: number; requestId: string; nativeRequestId: string; inputDigest: string };
}

export interface AbsHistoryPublicationRequest<Environment = HistoryEnvironmentInput> {
  version: 2;
  requestId: string;
  history: {
    id: string;
    expected: AbsGenerationBinding;
    base: { hash: string; bytes: number; source?: string; format?: 'abs' | 'abi' };
    candidate: { hash: string; bytes: number; format?: 'abs' | 'abi' };
    source?: string;
    environment?: Environment;
  };
}

export function readAbsHistoryPublication(input: any, requireSource: true,
  readObject?: (hash: string) => Promise<string | null>): Promise<AbsHistoryPublicationRequest<HistoryEnvironmentPlan>>;
export function readAbsHistoryPublication(input: any, requireSource: false,
  readObject?: (hash: string) => Promise<string | null>): Promise<AbsHistoryPublicationRequest>;
export async function readAbsHistoryPublication(input: any, requireSource: boolean,
  readObject?: (hash: string) => Promise<string | null>): Promise<AbsHistoryPublicationRequest> {
  let history = input?.history;
  if (!/^pub2-[a-f0-9-]{36}$/.test(input?.requestId ?? '') || !history
    || typeof history.id !== 'string' || !history.id || history.id.length > 256 || history.id.includes('\0')
    || Object.keys(history).some(key => !['id', 'expected', 'base', 'candidate', 'source', 'environment'].includes(key))) {
    throw new AbsSyncError('ABS_HISTORY_PUBLICATION_INVALID', 'History publication requires its original request and immutable target.');
  }
  assertGenerationCandidate({ version: input.version, requestId: input.requestId,
    base: history.expected, candidate: history.candidate });
  if (!/^sha256:[a-f0-9]{64}$/.test(history.base?.hash ?? '') || !Number.isSafeInteger(history.base?.bytes)
    || history.base.bytes < 1 || Object.keys(history.base).some(key => !['hash', 'bytes', 'source', 'format'].includes(key))
    || [history.base.format, history.candidate.format].some(format => format !== undefined && !['abi', 'abs'].includes(format))
    || Object.keys(history.candidate).some(key => !['hash', 'bytes', 'format'].includes(key))) {
    throw new AbsSyncError('ABS_HISTORY_PUBLICATION_INVALID', 'History must retain the original transition base separately from the current saved head.');
  }
  const environmentInput = readHistoryEnvironmentInput(history.environment);
  if (requireSource && readObject) {
    // Hashes already name immutable objects in this project's existing History
    // store. The transport carries neither large source bodies nor file paths.
    history = { ...history, base: { ...history.base } };
    if (history.base.source === undefined) history.base.source = await readObject(history.base.hash);
    if (history.source === undefined) history.source = await readObject(history.candidate.hash);
  }
  if (requireSource && typeof history.base.source !== 'string' || history.base.source !== undefined
    && (typeof history.base.source !== 'string' || new TextEncoder().encode(history.base.source).byteLength !== history.base.bytes
      || await hashAbsText(history.base.source) !== history.base.hash)) {
    throw new AbsSyncError('ABS_HISTORY_PUBLICATION_INVALID', 'The retained history base differs from its original bytes.');
  }
  if (requireSource && typeof history.source !== 'string' || history.source !== undefined
    && (typeof history.source !== 'string' || new TextEncoder().encode(history.source).byteLength !== history.candidate.bytes
      || await hashAbsText(history.source) !== history.candidate.hash)) {
    throw new AbsSyncError('ABS_HISTORY_PUBLICATION_INVALID', 'The retained history target differs from its original bytes.');
  }
  const environment = requireSource ? await hydrateHistoryEnvironment(environmentInput, readObject ?? (async () => null)) : environmentInput;
  return JSON.parse(absJson({ version: 2, requestId: input.requestId,
    history: { ...history, ...(environment ? { environment } : {}) } }));
}

/** Publishing and observation identify the same command; an action or later GUI
 * capture never changes its digest. The ordinary save request API is separate. */
export async function historyPublicationIdentity(project: string, request: AbsHistoryPublicationRequest): Promise<NativeSaveIdentity> {
  const normalized = project.replace(/\\/g, '/').replace(/\/+$/, '');
  const projectKey = /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//') ? normalized.toLowerCase() : normalized;
  const { id, expected, base, candidate, environment } = request.history;
  const environmentIdentity = await historyEnvironmentIdentity(environment);
  return { version: 2, requestId: request.requestId, operation: 'history_restore',
    inputDigest: await hashAbsText(absJson({ version: 1, project: projectKey,
      operation: 'history_restore', history: { id, expected, base: { hash: base.hash, bytes: base.bytes,
        ...(base.format ? { format: base.format } : {}) }, candidate,
        ...(environmentIdentity ? { environment: environmentIdentity } : {}) } })) };
}

export function historyPublicationReference(request: AbsHistoryPublicationRequest, identity: NativeSaveIdentity) {
  return { version: 1, id: request.history.id, requestId: request.requestId,
    inputDigest: identity.inputDigest, candidate: request.history.candidate };
}
