import type { AbsStorageExecutor, AbsSyncStorageAccess, AbsSyncStoragePort } from './abs-baseline-store';
import { absJson, hashAbsText } from './abs-identity-map';
import { nativeSaveCapability, nativeSaveIndexKey } from './abs-native-save-protocol';
import type { NativeSaveIdentity } from './abs-native-save-protocol';
import { AbsSyncError } from './abs-state';

type AdmissionOperation = 'abs_apply' | 'project_save' | 'blocks_tidy';

export interface OriginalRequestAdmissionIdentity {
  requestId: string;
  operation: AdmissionOperation;
  inputDigest?: string;
}

export const applicationRequestKey = async (requestId: string) =>
  `recoveries/request-${(await hashAbsText(requestId)).slice(7)}.json`;

export function nativeSaveAdmissionIdentity(request: NativeSaveIdentity): OriginalRequestAdmissionIdentity | undefined {
  if (request.operation === 'project_save' || request.operation === 'blocks_tidy') {
    return { requestId: request.requestId, operation: request.operation, inputDigest: request.inputDigest };
  }
}

function admissionFault(message: string) {
  return new AbsSyncError('PROJECT_ADMISSION_RECEIPT_INVALID', message);
}

async function receiptKey(request: OriginalRequestAdmissionIdentity): Promise<string> {
  const application = request.operation === 'abs_apply';
  if (typeof request.requestId !== 'string' || !/^[A-Za-z0-9-]{16,80}$/.test(request.requestId)
    || !['abs_apply', 'project_save', 'blocks_tidy'].includes(request.operation)
    || (application ? request.inputDigest !== undefined : !/^sha256:[a-f0-9]{64}$/.test(request.inputDigest ?? ''))) {
    throw admissionFault('Invalid original request admission identity.');
  }
  const namespace = application ? 'abs-apply' : 'native-save';
  return `recoveries/admission-${(await hashAbsText(namespace + '\0' + request.requestId)).slice(7)}.json`;
}

type AdmissionRecord = {
  version: 1; kind: 'not-started'; operationId: string; project: string;
  request: OriginalRequestAdmissionIdentity; code: string; message: string;
} & ReturnType<typeof nativeSaveCapability>;

/** A rejection and its original writer index are mutually exclusive under the
 * existing project storage lock. Absence provides no evidence of a rejection. */
export class OriginalRequestAdmissions {
  constructor(private readonly port: AbsSyncStoragePort, private readonly project: string) {}

  async observe(request: OriginalRequestAdmissionIdentity,
    reader: Pick<AbsSyncStorageAccess, 'read'> = this.port): Promise<AdmissionRecord | null> {
    const text = await reader.read(await receiptKey(request));
    if (text === null) return null;
    const record = JSON.parse(text) as AdmissionRecord;
    const observed = nativeSaveCapability(this.port);
    nativeSaveCapability(record);
    if (record.version !== 1 || record.kind !== 'not-started' || record.project !== this.project
      || absJson(record.request) !== absJson(request) || absJson(record.attachment) !== absJson(observed.attachment)
      || !/^[a-f0-9-]{36}$/.test(record.operationId) || typeof record.code !== 'string' || record.code.length === 0
      || typeof record.message !== 'string') throw admissionFault('The rejection belongs to a different original request or physical project.');
    const index = await this.writerIndex(request);
    if (await reader.read(index) !== null) throw admissionFault('The original request also has an execution record.');
    return record;
  }

  async reject(request: OriginalRequestAdmissionIdentity, failure: { code: string; message: string },
    guard: () => void): Promise<AdmissionRecord | null> {
    return this.port.withLock(async storage => {
      guard();
      const retained = await this.observe(request, storage);
      if (retained) return retained;
      if (await storage.read(await this.writerIndex(request)) !== null) return null;
      const record: AdmissionRecord = { version: 1, kind: 'not-started', operationId: crypto.randomUUID(),
        project: this.project, request, ...nativeSaveCapability(this.port), code: failure.code, message: failure.message };
      guard();
      if (!await storage.replace(await receiptKey(request), null, absJson(record))) {
        throw admissionFault('The original rejection changed during settlement.');
      }
      return record;
    });
  }

  private writerIndex(request: OriginalRequestAdmissionIdentity) {
    return request.operation === 'abs_apply' ? applicationRequestKey(request.requestId) : nativeSaveIndexKey(request.requestId);
  }
}

export function originalAdmissionOutcome(record: AdmissionRecord) {
  const { operation, requestId } = record.request;
  return { ok: false, project: record.project, operation, code: record.code,
    message: record.message, admission: { status: 'NOT_STARTED' as const, requestId },
    publication: { status: 'NOT_COMMITTED' as const }, requiresReload: false, candidateApplied: false,
    ...(operation === 'abs_apply' ? { application: { status: 'NOT_STARTED' as const, requestId } } : {}) };
}

export function originalAdmissionObservation(record: AdmissionRecord, observer?: AbsStorageExecutor) {
  return { version: 1 as const, durable: true, requestId: record.request.requestId, operation: record.request.operation,
    operationId: record.operationId, attachment: record.attachment, executor: record.executor,
    observer: { hostPid: observer?.hostPid ?? null }, current: false };
}

export function observedApplicationAdmission(record: AdmissionRecord, observer?: AbsStorageExecutor) {
  return { ...originalAdmissionOutcome(record), applicationObservation: {
    version: 1, requestId: record.request.requestId, observationOnly: true, resultKnown: true, current: false,
  }, ...(observer ? { publicationObservation: originalAdmissionObservation(record, observer) } : {}) };
}
