import type { AbsStorageExecutor, AbsSyncStorageAccess, AbsSyncStoragePort } from './abs-baseline-store';
import { absJson, hashAbsText } from './abs-identity-map';
import { assertNativeSaveIdentity, nativeSaveCapability, nativeSaveIndexKey } from './abs-native-save-protocol';
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
const applicationWriterKey = async (requestId: string) =>
  `recoveries/application-writer-${(await hashAbsText(requestId)).slice(7)}.json`;
const nativeSaveWriterKey = async (requestId: string) =>
  `recoveries/save-writer-${(await hashAbsText(requestId)).slice(7)}.json`;

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

type ApplicationWriter = { version: 1; kind: 'validated-writer'; project: string; requestId: string;
  candidateHash: string } & ReturnType<typeof nativeSaveCapability>;
type SaveWriter = { version: 1; kind: 'admitted-save'; project: string; request: NativeSaveIdentity;
  viewRevision: number } & ReturnType<typeof nativeSaveCapability>;

const exited = (observation: Awaited<ReturnType<NonNullable<AbsSyncStoragePort['observeExecutor']>>>) =>
  observation.state === 'exited' && ['system-restarted', 'process-exited', 'process-reused'].includes(observation.reason);

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
      if (request.operation === 'abs_apply') await this.assertApplicationWriter(request.requestId, undefined, storage);
      else await this.assertSaveWriter({ version: 2, requestId: request.requestId, operation: request.operation,
        inputDigest: request.inputDigest! }, storage);
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

  async reserveApplication(requestId: string, candidateHash: string, guard: () => void) {
    const request = { operation: 'abs_apply' as const, requestId };
    const key = await applicationWriterKey(requestId);
    const context = nativeSaveCapability(this.port);
    return this.port.withLock(async storage => {
      guard();
      if (!/^sha256:[a-f0-9]{64}$/.test(candidateHash) || await this.observe(request, storage)
        || await storage.read(await applicationRequestKey(requestId)) !== null)
        throw admissionFault('The original application has already been settled or admitted.');
      const retained = await this.applicationWriter(requestId, storage);
      const writer: ApplicationWriter = { version: 1, kind: 'validated-writer', project: context.attachment.root, requestId,
        candidateHash, ...context };
      if (retained ? absJson(retained.writer) !== absJson(writer) : !await storage.replace(key, null, absJson(writer)))
        throw admissionFault('The original application has a different validated writer.');
      guard();
    });
  }

  /** A newer renderer cannot acquire an old prepared request even if the
   * original transport returns late. Called under the first writer's lock. */
  async assertApplicationWriter(requestId: string, candidateHash: string | undefined, storage: Pick<AbsSyncStorageAccess, 'read'>) {
    const retained = await this.applicationWriter(requestId, storage);
    if (retained && (candidateHash !== undefined && retained.writer.candidateHash !== candidateHash
      || absJson(retained.writer.executor) !== absJson(nativeSaveCapability(this.port).executor)))
      throw admissionFault('The original application belongs to a different validated writer or candidate.');
  }

  async observeExitedApplicationWriter(requestId: string, originalTargetPid: number) {
    if (!this.port.observeExecutor) return null;
    const request = { operation: 'abs_apply' as const, requestId };
    const writerIndex = await applicationRequestKey(requestId);
    return this.port.withLock(async storage => {
      const retained = await this.applicationWriter(requestId, storage);
      if (!retained || retained.writer.executor.hostPid !== originalTargetPid
        || await this.observe(request, storage) || await storage.read(writerIndex) !== null) return null;
      const oldWriter = await this.port.observeExecutor!(retained.writer.executor);
      if (!exited(oldWriter)) return null;
      return { oldWriter, intentHash: await hashAbsText(retained.text), attachment: retained.writer.attachment,
        executor: retained.writer.executor };
    });
  }

  async reserveSave(request: NativeSaveIdentity, viewRevision: number, guard: () => void) {
    assertNativeSaveIdentity(request);
    const identity = nativeSaveAdmissionIdentity(request), key = await nativeSaveWriterKey(request.requestId);
    if (!identity || !Number.isSafeInteger(viewRevision) || viewRevision < 0) throw admissionFault('Invalid original save writer.');
    return this.port.withLock(async storage => {
      guard();
      if (await this.observe(identity, storage) || await storage.read(await this.writerIndex(identity)) !== null) return null;
      const old = await this.saveWriter(request, storage);
      const record: SaveWriter = { version: 1, kind: 'admitted-save', project: this.project, request, viewRevision,
        ...nativeSaveCapability(this.port) };
      const text = absJson(record);
      if (old ? old.text !== text : !await storage.replace(key, null, text))
        throw admissionFault('The original save belongs to a different admitted writer.');
      guard();
      return { version: record.version, kind: record.kind, request, viewRevision, attachment: record.attachment,
        executor: record.executor, intentHash: await hashAbsText(text) };
    });
  }

  /** The optional acknowledgement belongs only to the active canvas that prepared it. */
  async assertSaveWriter(request: NativeSaveIdentity, storage: Pick<AbsSyncStorageAccess, 'read'>,
    expected?: { viewRevision: number; intentHash: string }) {
    if (!nativeSaveAdmissionIdentity(request)) return;
    const retained = await this.saveWriter(request, storage);
    if (expected && (!retained || retained.record.viewRevision !== expected.viewRevision
      || await hashAbsText(retained.text) !== expected.intentHash)
      || retained && absJson(retained.record.executor) !== absJson(nativeSaveCapability(this.port).executor))
      throw admissionFault('The original save belongs to a different admitted writer.');
  }

  async observeExitedSaveWriter(request: NativeSaveIdentity, originalTargetPid: number) {
    const identity = nativeSaveAdmissionIdentity(request);
    if (!this.port.observeExecutor || !identity) return null;
    return this.port.withLock(async storage => {
      const retained = await this.saveWriter(request, storage);
      if (!retained || retained.record.executor.hostPid !== originalTargetPid || await this.observe(identity, storage)
        || await storage.read(await this.writerIndex(identity)) !== null) return null;
      const oldWriter = await this.port.observeExecutor!(retained.record.executor);
      if (!exited(oldWriter)) return null;
      const { version, kind, attachment, executor, viewRevision } = retained.record;
      return { version, kind, request, attachment, executor, viewRevision, oldWriter, intentHash: await hashAbsText(retained.text) };
    });
  }

  private async saveWriter(request: NativeSaveIdentity, storage: Pick<AbsSyncStorageAccess, 'read'>) {
    const text = await storage.read(await nativeSaveWriterKey(request.requestId));
    if (text === null) return null;
    const record = JSON.parse(text) as SaveWriter;
    nativeSaveCapability(record);
    if (record.version !== 1 || record.kind !== 'admitted-save' || record.project !== this.project
      || absJson(record.request) !== absJson(request) || !Number.isSafeInteger(record.viewRevision) || record.viewRevision < 0
      || absJson(record.attachment) !== absJson(nativeSaveCapability(this.port).attachment))
      throw admissionFault('The save writer belongs to a different original request or physical project.');
    return { text, record };
  }

  private async applicationWriter(requestId: string, storage: Pick<AbsSyncStorageAccess, 'read'>) {
    if (!/^[A-Za-z0-9-]{16,80}$/.test(requestId)) throw admissionFault('The original application identity is invalid.');
    const text = await storage.read(await applicationWriterKey(requestId));
    if (text === null) return null;
    const writer = JSON.parse(text) as ApplicationWriter;
    const attachment = nativeSaveCapability(this.port).attachment;
    nativeSaveCapability(writer);
    if (writer.version !== 1 || writer.kind !== 'validated-writer' || writer.project !== attachment.root
      || writer.requestId !== requestId || !/^sha256:[a-f0-9]{64}$/.test(writer.candidateHash)
      || absJson(writer.attachment) !== absJson(attachment))
      throw admissionFault('The validated writer does not belong to the original request or project.');
    return { text, writer };
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
