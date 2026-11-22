import { AbsBaselineStore, type AbsDiskSnapshot, type AbsSyncStorageAccess, type AbsSyncStoragePort,
  type AbsProjectAttachment, type AbsStorageExecutor, type AbsStorageExecutorObservation } from './abs-baseline-store';
import { assertGenerationValidation } from './abs-generation-protocol';
import { absJson, hashAbsText } from './abs-identity-map';
import { absMapJson } from './abs-map-json';
import { AbsSyncError } from './abs-state';
import { assertNativeSaveIdentity, nativeSaveCapability, nativeSaveIndexKey, nativeSaveError, nativeSaveSettlementKey, readNativeSaveRequest,
  type NativeSaveIdentity, type NativeSaveOperationRef } from './abs-native-save-protocol';
import { applicationRequestKey, nativeSaveAdmissionIdentity, OriginalRequestAdmissions } from './original-request-admission';
export type { NativeSaveIdentity, NativeSaveOperationRef } from './abs-native-save-protocol';

export interface AbsOperationSnapshot {
  version: 1;
  id: string;
  project: string;
  kind: 'abs-apply' | 'runtime-rebuild' | 'document-save';
  /** Fully materialized, including inactive pages. This is never an apply receipt. */
  document: unknown;
  disk: AbsDiskSnapshot;
  committed: string | null;
  candidate?: { source: string; generation: string; hash: string };
  application?: { requestId: string; validation: unknown };
  nativeSave?: NativeSaveIdentity;
  sourceStageVersion?: 1;
  attachment?: import('./abs-baseline-store').AbsProjectAttachment;
  executor?: import('./abs-baseline-store').AbsStorageExecutor;
}
interface OperationPointer { version: 1; id: string; hash: string; state: 'pending' | 'restored' | 'completed'; sourceCommitted?: string; sourceAbiHash?: string }
export interface AbsCurrentDocumentRecovery {
  version: 1; scope: 'restored-working-document'; state: 'restored';
  requestId: string; operationId: string; snapshotHash: string; operationPointerHash: string; documentHash: string;
  attachment: AbsProjectAttachment; originalExecutor: AbsStorageExecutor; observerExecutor: AbsStorageExecutor;
  saved: { abiHash: string; absHash: string; mapHash: string; committedHash: string };
  candidate: { hash: string; bytes: number; intentGeneration: string };
  oldWriter: AbsStorageExecutorObservation & { state: 'exited' };
  candidateApplied: false; originalPublication: 'UNKNOWN';
  settlement?: { version: 1; recordHash: string };
}
type RestoredApplicationRecord = { version: 1; kind: 'restored-working-document'; project: string; operationPointer: string;
  stagedHash: string | null; recovery: Omit<AbsCurrentDocumentRecovery, 'settlement'> };
export interface AbsUnpublishedDocumentSave {
  version: 1; kind: 'source-not-published'; requestId: string; operationId: string;
  attachment: AbsProjectAttachment; originalExecutor: AbsStorageExecutor; observerExecutor: AbsStorageExecutor;
  oldWriter: AbsStorageExecutorObservation & { state: 'exited' };
  snapshotHash: string;
  saved: { abiHash: string | null; absHash: string | null; mapHash: string | null;
    committedHash: string | null; operationPointerHash: string };
}
type SaveSettlementKind = 'source-not-published' | 'before-source-stage';
interface SaveSettlementRecord {
  version: 1; kind: 'save-writer-settlement'; project: string; ref: NativeSaveOperationRef;
  snapshotHash: string; reason: SaveSettlementKind; oldWriter: AbsUnpublishedDocumentSave['oldWriter'];
  unpublished?: { pointer: string; saved: AbsUnpublishedDocumentSave['saved'] };
}
interface RestoredOperationHandoff {
  version: 1; kind: 'restored-operation-handoff'; project: string; operationPointer: string;
  stagedHash: string | null; saved: AbsUnpublishedDocumentSave['saved'];
  metadataAnchor?: { committedHash: string; mapHash: string };
}
type ApplicationWriterSettlement = {
  version: 1; kind: 'application-writer-settlement'; project: string; requestId: string; operationId: string;
  snapshotHash: string; attachment: AbsProjectAttachment; executor: AbsStorageExecutor;
  oldWriter: AbsUnpublishedDocumentSave['oldWriter'];
} & ({ handoffHash: string; reason?: never }
  | { reason: 'before-source-stage'; handoffHash?: never }
  | LegacyWriterBasis);
type LegacyWriterBasis = { reason: 'legacy-validated-writer'; legacyWriterHash: string; handoffHash?: never }
  | { reason: 'legacy-index-exited-writer'; legacyWriterHash?: never; handoffHash?: never };
export interface LocationOperation {
  operation: AbsOperationSnapshot; pointer: string; snapshot: string;
}
const currentKey = 'operation.json';
const snapshotKey = (id: string) => `recoveries/operation-${id}.json`;
export const restoredApplicationKey = (id: string) => `recoveries/application-restored-${id}.json`;
const handoffKey = (id: string) => `recoveries/operation-handoff-${id}.json`;
const retiredApplicationKey = (id: string) => `recoveries/application-retired-${id}.json`;
const stageKey = (id: string) => `recoveries/application-${id}.json`;
const hashNullable = (value: string | null) => value === null ? Promise.resolve(null) : hashAbsText(value);
const conflict = () => new AbsSyncError('ABS_OPERATION_CONFLICT', 'A different document operation is retained; inspect it before replacing its recovery snapshot.');
const applicationAlreadyIndexed = () => new AbsSyncError('ABS_APPLY_REQUEST_ALREADY_RECORDED',
  'This exact apply request is retained. Observe its result; it cannot apply the candidate twice.');
const exitedApplicationWriter = (value?: AbsStorageExecutorObservation): value is AbsCurrentDocumentRecovery['oldWriter'] =>
  value?.version === 1 && value.state === 'exited' && ['system-restarted', 'process-exited', 'process-reused'].includes(value.reason);

/** Durable recovery facts, never a workspace lease or authority to replay a candidate. */
export class AbsOperationJournal {
  constructor(private readonly port: AbsSyncStoragePort, private readonly project: string) {}

  /** An environment may recover before GUI loading. This proves only that
   * its dead parent did not publish source, not that Working was restored. */
  async inspectUnpublishedDocumentSave(ref: NativeSaveOperationRef, guard: () => void): Promise<AbsUnpublishedDocumentSave | null> {
    if (!this.port.observeExecutor) return null;
    return this.port.withLock(storage => this.inspectUnpublishedSaveLocked(ref, guard, storage));
  }

  private async inspectUnpublishedSaveLocked(ref: NativeSaveOperationRef, guard: () => void, storage: AbsSyncStorageAccess): Promise<AbsUnpublishedDocumentSave | null> {
    const context = nativeSaveCapability(this.port);
    guard();
    const original = await readNativeSaveRequest({ ...context, read: key => storage.read(key) }, this.project, ref.request);
    if (!original || absJson(original.ref) !== absJson(ref)) return null;
    const pointerText = await storage.read(currentKey);
    if (pointerText === null) return null;
    const pointer = this.pointer(pointerText);
    if (pointer.id !== ref.operationId || pointer.hash !== original.snapshotHash || pointer.state === 'completed') return null;
    const source = await this.unpublishedSource(storage, pointerText, original.snapshot, guard);
    if (!source) return null;
    const oldWriter = await this.port.observeExecutor!(ref.executor);
    if (!exitedApplicationWriter(oldWriter) || !await source.unchanged()
      || absJson(await this.port.observeExecutor!(ref.executor)) !== absJson(oldWriter)) return null;
    guard();
    return { version: 1, kind: 'source-not-published', requestId: ref.request.requestId, operationId: ref.operationId,
      attachment: context.attachment, originalExecutor: ref.executor, observerExecutor: context.executor,
      oldWriter, snapshotHash: original.snapshotHash, saved: source.saved };
  }

  /** Release only the old writer. An immutable record outlives the current
   * operation pointer, but cannot supply a save outcome or canvas proof. */
  async observeSaveWriterSettlement(ref: NativeSaveOperationRef, guard: () => void) {
    if (!this.port.observeExecutor) return null;
    return this.port.withLock(storage => this.settleSaveWriter(ref, guard, storage));
  }

  private async settleSaveWriter(ref: NativeSaveOperationRef, guard: () => void, storage: AbsSyncStorageAccess) {
    if (!this.port.observeExecutor || !nativeSaveAdmissionIdentity(ref.request)) return null;
    guard();
    const context = nativeSaveCapability(this.port);
    const original = await readNativeSaveRequest({ ...context, read: key => storage.read(key) }, this.project, ref.request);
    if (!original || absJson(original.ref) !== absJson(ref)) return null;
    const id = ref.operationId, key = nativeSaveSettlementKey(id);
    if (!await this.hasNoResult(storage, id)) return null;
    const retained = await storage.read(key);
    let text = retained;
    let record: SaveSettlementRecord;
    if (retained !== null) {
      record = JSON.parse(retained);
      if (record.version !== 1 || record.kind !== 'save-writer-settlement' || record.project !== this.project
        || absJson(record.ref) !== absJson(ref) || record.snapshotHash !== original.snapshotHash
        || !exitedApplicationWriter(record.oldWriter)
        || (record.reason !== 'source-not-published' && record.reason !== 'before-source-stage')) throw conflict();
      if (record.reason === 'before-source-stage' && await storage.read(stageKey(id)) !== null) return null;
    } else {
      const oldWriter = await this.port.observeExecutor(ref.executor);
      if (!exitedApplicationWriter(oldWriter)) return null;
      const handoff = await this.readHandoff(original.snapshot, original.snapshotHash, storage);
      const pointer = await storage.read(currentKey);
      const live = !handoff && pointer !== null ? await this.inspectUnpublishedSaveLocked(ref, guard, storage) : null;
      const unpublished = handoff ? { pointer: handoff.record.operationPointer, saved: handoff.record.saved }
        : live ? { pointer: pointer!, saved: live.saved } : undefined;
      // The original stage is written once, before any source publish. On
      // older records without that declared protocol also require the exact
      // original file preimage; a missing current pointer alone proves nothing.
      if (!unpublished && (await storage.read(stageKey(id)) !== null
        || original.sourceStageVersion !== 1 && (absJson(await this.disk(storage)) !== absJson(original.snapshot.disk)
          || await storage.read('committed.json') !== original.snapshot.committed || await storage.read('prepared.json') !== null))) return null;
      record = { version: 1, kind: 'save-writer-settlement', project: this.project, ref, snapshotHash: original.snapshotHash,
        reason: unpublished ? 'source-not-published' : 'before-source-stage', oldWriter,
        ...(unpublished ? { unpublished } : {}) };
      text = absJson(record);
      guard();
      if (!await storage.replace(key, null, text)) throw conflict();
    }
    return { version: 1 as const, kind: 'indexed-save-retired' as const, request: ref.request, operationId: id,
      snapshotHash: original.snapshotHash, attachment: ref.attachment, executor: ref.executor,
      observer: { hostPid: context.executor.hostPid }, oldWriter: record.oldWriter,
      settlement: { kind: record.reason, recordHash: await hashAbsText(text!) } };
  }

  /** Preserve the current fast path for a native writer already confirmed exited. */
  private async retainSaveBeforeAdvancing(pointer: OperationPointer, guard: () => void, storage: AbsSyncStorageAccess) {
    if (!this.port.observeExecutor) return;
    const text = await storage.read(snapshotKey(pointer.id));
    if (text === null || await hashAbsText(text) !== pointer.hash) throw conflict();
    const snapshot = JSON.parse(text) as AbsOperationSnapshot;
    if (snapshot.kind !== 'document-save' || !snapshot.nativeSave || !snapshot.attachment || !snapshot.executor) return;
    await this.settleSaveWriter({ operationId: pointer.id, request: snapshot.nativeSave,
      attachment: snapshot.attachment, executor: snapshot.executor }, guard, storage);
  }

  // Snapshot the original source boundary under the publication lock. ABS may
  // contain a separate author's draft, which stays untouched in project-v1.
  private async unpublishedSource(storage: AbsSyncStorageAccess, pointer: string,
    snapshot: AbsOperationSnapshot, guard: () => void) {
    const disk = await this.disk(storage), staged = await storage.read(stageKey(snapshot.id));
    const original = this.pointer(pointer);
    const reanchored = snapshot.kind === 'abs-apply' && original.sourceCommitted !== undefined;
    const metadata = reanchored ? await this.metadataHandoffAnchor(storage, snapshot, original) : null;
    if (reanchored && !metadata) return null;
    const committedPointer = metadata ? original.sourceCommitted! : snapshot.committed;
    const expectedMap = metadata ? absMapJson(metadata.committed.projection.map) : snapshot.disk.map;
    if (disk.abi !== snapshot.disk.abi || disk.map !== expectedMap) return null;
    const draftChanged = disk.abs !== snapshot.disk.abs;
    const accepted = new AbsBaselineStore({ ...this.port, read: key => storage.read(key) }, { projectKey: this.project, pageId: '' });
    const unchanged = async () => {
      guard();
      return await storage.read(currentKey) === pointer
        && absJson(await this.disk(storage)) === absJson(disk)
        && await storage.read('committed.json') === committedPointer
        && await storage.read(stageKey(snapshot.id)) === staged
        && (!draftChanged || await accepted.workspaceMode(storage) === 'project-v1')
        && await storage.read('prepared.json') === null && await this.hasNoResult(storage, snapshot.id);
    };
    if (!await unchanged()) return null;
    if (draftChanged || metadata) {
      const committed = metadata?.committed ?? await accepted.readCommittedSnapshot();
      if (!committed || committed.projection.map.scope.projectKey !== this.project
        || !await accepted.matchesAcceptedDisk(committed, disk)) return null;
    }
    const saved = { abiHash: await hashNullable(disk.abi), absHash: await hashNullable(disk.abs),
      mapHash: await hashNullable(snapshot.disk.map), committedHash: await hashNullable(snapshot.committed),
      operationPointerHash: await hashAbsText(pointer) };
    return { saved, staged, unchanged, metadataAnchor: metadata?.proof };
  }

  /** Verify the same immutable metadata-only chain retained by restart. Pin
   * its head so a later source publication cannot change this original proof. */
  private async metadataHandoffAnchor(storage: Pick<AbsSyncStorageAccess, 'read'>,
    snapshot: AbsOperationSnapshot, pointer: OperationPointer) {
    const head = pointer.sourceCommitted, abi = snapshot.disk.abi;
    if (snapshot.kind !== 'abs-apply' || !snapshot.committed || abi === null || typeof head !== 'string'
      || pointer.sourceAbiHash !== await hashAbsText(abi)) return null;
    const anchor = new AbsBaselineStore({ ...this.port, read: key => key === 'committed.json' ? Promise.resolve(head) : storage.read(key) },
      { projectKey: this.project, pageId: '' });
    if (!await anchor.isMetadataOnlyContinuation(snapshot.committed, abi)) return null;
    const committed = await anchor.readCommittedSnapshot();
    if (!committed || committed.abi !== abi || committed.projection.map.scope.projectKey !== this.project) return null;
    return { committed, proof: { committedHash: committed.pointerHash, mapHash: await hashAbsText(absMapJson(committed.projection.map)) } };
  }

  private async hasNoResult(storage: Pick<AbsSyncStorageAccess, 'read'>, id: string) {
    return await storage.read(`recoveries/application-commit-${id}.json`) === null
      && await storage.read(`recoveries/application-result-${id}.json`) === null;
  }

  private async indexedApplication(requestId: string, storage: Pick<AbsSyncStorageAccess, 'read'>) {
    const indexKey = await applicationRequestKey(requestId), indexText = await storage.read(indexKey);
    if (indexText === null) return null;
    const index = JSON.parse(indexText);
    if (index.version !== 1 || index.project !== this.project || index.requestId !== requestId
      || !/^[a-f0-9-]{36}$/.test(index.operationId) || !/^sha256:[a-f0-9]{64}$/.test(index.snapshotHash)) throw conflict();
    const snapshotText = await storage.read(snapshotKey(index.operationId));
    if (snapshotText === null || await hashAbsText(snapshotText) !== index.snapshotHash) throw conflict();
    const snapshot = JSON.parse(snapshotText) as AbsOperationSnapshot;
    if (snapshot.kind !== 'abs-apply' || snapshot.version !== 1 || snapshot.project !== this.project
      || snapshot.id !== index.operationId || snapshot.application?.requestId !== requestId || !snapshot.candidate || !snapshot.document
      || !snapshot.disk || Object.keys(snapshot.disk).sort().join(',') !== 'abi,abs,map'
      || !Object.values(snapshot.disk).every(value => value === null || typeof value === 'string')
      || snapshot.committed !== null && typeof snapshot.committed !== 'string'
      || index.sourceStageVersion !== snapshot.sourceStageVersion
      || snapshot.sourceStageVersion !== undefined && snapshot.sourceStageVersion !== 1) throw conflict();
    if (!snapshot.attachment || !snapshot.executor) return null;
    const original = nativeSaveCapability(snapshot), observer = nativeSaveCapability(this.port);
    if (absJson(original.attachment) !== absJson(observer.attachment)) return null;
    const validation: any = snapshot.application.validation;
    assertGenerationValidation(validation);
    if (validation.requestId !== requestId || validation.candidate.hash !== snapshot.candidate.hash
      || validation.candidate.bytes !== new TextEncoder().encode(snapshot.candidate.source).byteLength
      || await hashAbsText(snapshot.candidate.source) !== snapshot.candidate.hash
      || validation.base.generation !== snapshot.candidate.generation || validation.base.scope.projectKey !== this.project) throw conflict();
    return { indexKey, indexText, snapshotText, snapshot, snapshotHash: index.snapshotHash as string, original, validation };
  }

  /** Retain evidence before advancing a restored pointer, independently of
   * GUI readback and whether the original process can be observed yet. */
  private async retainHandoff(pointerText: string, guard: () => void, storage: AbsSyncStorageAccess) {
    const pointer = this.pointer(pointerText);
    if (pointer.state !== 'restored' || !this.port.attachment || !this.port.executor || !this.port.observeExecutor
      || !await this.hasNoResult(storage, pointer.id)) return;
    const text = await storage.read(snapshotKey(pointer.id));
    if (text === null || await hashAbsText(text) !== pointer.hash) throw conflict();
    const snapshot = JSON.parse(text) as AbsOperationSnapshot;
    if (snapshot.kind === 'document-save' && snapshot.nativeSave && nativeSaveAdmissionIdentity(snapshot.nativeSave)) {
      const original = await readNativeSaveRequest({ ...nativeSaveCapability(this.port), read: key => storage.read(key) },
        this.project, snapshot.nativeSave);
      if (!original || original.ref.operationId !== pointer.id || original.snapshotHash !== pointer.hash) return;
    } else if (snapshot.kind === 'abs-apply' && snapshot.application) {
      const original = await this.indexedApplication(snapshot.application.requestId, storage);
      if (!original || original.snapshot.id !== pointer.id || original.snapshotHash !== pointer.hash) return;
    } else return;
    if (await this.readHandoff(snapshot, pointer.hash, storage)) return;
    const source = await this.unpublishedSource(storage, pointerText, snapshot, guard);
    if (!source || snapshot.kind === 'abs-apply' && source.staged !== null
      && !await this.matchesRestoredStage(storage, snapshot, source.staged)) return;
    const record: RestoredOperationHandoff = { version: 1, kind: 'restored-operation-handoff', project: this.project,
      operationPointer: pointerText, stagedHash: await hashNullable(source.staged), saved: source.saved,
      ...(source.metadataAnchor ? { metadataAnchor: source.metadataAnchor } : {}) };
    const serialized = absJson(record), key = handoffKey(pointer.id), existing = await storage.read(key);
    if (!await source.unchanged()) return;
    if (existing !== serialized && (existing !== null || !await storage.replace(key, null, serialized))) throw conflict();
  }

  private async readHandoff(snapshot: AbsOperationSnapshot, snapshotHash: string, storage: Pick<AbsSyncStorageAccess, 'read'>) {
    const text = await storage.read(handoffKey(snapshot.id));
    if (text === null || !await this.hasNoResult(storage, snapshot.id)) return null;
    const record = JSON.parse(text) as RestoredOperationHandoff, pointer = this.pointer(record.operationPointer);
    if (record.version !== 1 || record.kind !== 'restored-operation-handoff' || record.project !== this.project
      || pointer.state !== 'restored' || pointer.id !== snapshot.id || pointer.hash !== snapshotHash
      || record.stagedHash !== await hashNullable(await storage.read(stageKey(snapshot.id)))
      || record.saved.operationPointerHash !== await hashAbsText(record.operationPointer)
      || record.saved.abiHash !== await hashNullable(snapshot.disk.abi)
      || record.saved.mapHash !== await hashNullable(snapshot.disk.map)
      || record.saved.committedHash !== await hashNullable(snapshot.committed)
      || record.saved.absHash !== null && !/^sha256:[a-f0-9]{64}$/.test(record.saved.absHash)) throw conflict();
    if (snapshot.kind === 'abs-apply' && pointer.sourceCommitted !== undefined || record.metadataAnchor !== undefined) {
      const metadata = await this.metadataHandoffAnchor(storage, snapshot, pointer);
      if (!metadata || absJson(metadata.proof) !== absJson(record.metadataAnchor ?? null)) throw conflict();
    }
    return { record, hash: await hashAbsText(text) };
  }

  /** Exact original writer retirement, with no current canvas or apply result. */
  async observeApplicationWriterSettlement(requestId: string, guard: () => void, originalTargetPid?: number) {
    if (!this.port.attachment || !this.port.executor || !this.port.observeExecutor) return null;
    const observer = nativeSaveCapability(this.port);
    const needsWrite = 'needs-write' as const;
    const inspect = async (storage: Pick<AbsSyncStorageAccess, 'read'>, writable?: AbsSyncStorageAccess) => {
      guard();
      const indexed = await this.indexedApplication(requestId, storage);
      if (!indexed || originalTargetPid !== undefined && indexed.original.executor.hostPid !== originalTargetPid) return null;
      const { indexKey, indexText, snapshot, snapshotHash, original: { attachment, executor } } = indexed;
      const operationId = snapshot.id, key = retiredApplicationKey(operationId);
      const text = await storage.read(key), retained = text === null ? null : JSON.parse(text) as ApplicationWriterSettlement;
      const oldWriter = retained ? retained.oldWriter : await this.port.observeExecutor!(executor);
      if (!exitedApplicationWriter(oldWriter)) return null;
      let handoff = await this.readHandoff(snapshot, snapshotHash, storage);
      if (!handoff) {
        const pointerText = await storage.read(currentKey);
        const pointer = pointerText === null ? null : this.pointer(pointerText);
        if (pointer?.id === operationId && pointer.state === 'restored' && pointerText !== null) {
          if (!await this.hasNoResult(storage, operationId)) return null;
          if (!writable) return needsWrite;
          await this.retainHandoff(pointerText, guard, writable);
          handoff = await this.readHandoff(snapshot, snapshotHash, storage);
        }
      }
      const pointer = handoff ? null : await storage.read(currentKey);
      let basis: { handoffHash: string } | { reason: 'before-source-stage' } | LegacyWriterBasis;
      if (handoff) basis = { handoffHash: handoff.hash };
      else {
        if (await storage.read(stageKey(operationId)) !== null) return null;
        if (pointer !== null && this.pointer(pointer).id === operationId) return null;
        // The index can survive a failed pointer CAS. A marked writer cannot
        // write source before its immutable stage, irrespective of the new head.
        if (snapshot.sourceStageVersion === 1) basis = { reason: 'before-source-stage' };
        else {
          const legacy = await this.legacyWriterBasis(requestId, indexed, oldWriter, retained !== null, storage);
          if (!legacy) return null;
          basis = legacy;
        }
      }
      guard();
      if (await storage.read(indexKey) !== indexText || !await this.hasNoResult(storage, operationId)
        || (handoff ? (await this.readHandoff(snapshot, snapshotHash, storage))?.hash !== handoff.hash
          : await storage.read(currentKey) !== pointer || await storage.read(stageKey(operationId)) !== null)) return null;
      const record: ApplicationWriterSettlement = { version: 1, kind: 'application-writer-settlement', project: this.project,
        requestId, operationId, snapshotHash, attachment, executor, oldWriter, ...basis };
      const bytes = absJson(record);
      if (text !== bytes) {
        if (text !== null) throw conflict();
        if (!writable) return needsWrite;
        guard();
        if (!await writable.replace(key, null, bytes)) throw conflict();
      } else if (!writable && await storage.read(key) !== bytes) {
        return null;
      }
      const recordHash = await hashAbsText(bytes);
      guard();
      return { version: 1 as const, kind: 'indexed-application-retired' as const, requestId, operationId,
        snapshotHash, attachment, executor, observer: { hostPid: observer.executor.hostPid },
        oldWriter, settlement: { recordHash } };
    };
    const observed = await inspect(this.port);
    if (observed !== needsWrite) return observed;
    let entered = false;
    try {
      const settled = await this.port.withLock(storage => { entered = true; return inspect(storage, storage); });
      return settled === needsWrite ? null : settled;
    } catch (error) {
      if (!entered && (error as { code?: string })?.code === 'PROJECT_FILE_BUSY') { guard(); return null; }
      throw error;
    }
  }

  private async legacyWriterBasis(requestId: string, indexed: NonNullable<Awaited<ReturnType<AbsOperationJournal['indexedApplication']>>>,
    oldWriter: AbsCurrentDocumentRecovery['oldWriter'], retained: boolean, storage: Pick<AbsSyncStorageAccess, 'read'>): Promise<LegacyWriterBasis | null> {
    const { snapshot, validation, original: { executor } } = indexed;
    const admissions = new OriginalRequestAdmissions(this.port, this.project);
    const readWriter = () => admissions.inspectIndexedApplicationWriter(requestId, validation.candidate.hash, executor, storage);
    const writer = await readWriter();
    const noRestoredProof = async () => await storage.read(restoredApplicationKey(snapshot.id)) === null;
    if (!writer || !await noRestoredProof()) return null;
    // A recorded proof survives later saves. Mint one only against the exact
    // source preimage or its verified committed successor, under this lock.
    if (!retained) {
      const store = new AbsBaselineStore({ ...this.port, read: key => storage.read(key) }, validation.base.scope);
      if (await storage.read('prepared.json') !== null || !await store.hasCommittedPreimage(snapshot)
        || absJson(await this.port.observeExecutor!(executor)) !== absJson(oldWriter)
        || await storage.read('prepared.json') !== null) return null;
    }
    if (!await noRestoredProof() || writer.validatedWriterHash !== (await readWriter())?.validatedWriterHash) return null;
    // The immutable original index consumes this request before any writer can
    // move the operation pointer. Without a reservation, the exact exited writer
    // and verified preimage authorize revocation only, leaving the result unknown.
    return writer.validatedWriterHash === null ? { reason: 'legacy-index-exited-writer' }
      : { reason: 'legacy-validated-writer', legacyWriterHash: writer.validatedWriterHash };
  }

  async findDocumentSave(request: NativeSaveIdentity, assertCurrent: () => void): Promise<NativeSaveOperationRef | null> {
    assertCurrent();
    const found = await readNativeSaveRequest(this.port, this.project, request);
    assertCurrent(); return found?.ref ?? null;
  }

  async beginDocumentSave(input: { request: NativeSaveIdentity; document: unknown; disk: AbsDiskSnapshot },
    assertCurrent: () => void): Promise<{ created: boolean; ref: NativeSaveOperationRef }> {
    assertNativeSaveIdentity(input.request);
    input = JSON.parse(absJson(input));
    const context = nativeSaveCapability(this.port);
    return this.port.withLock(async storage => {
      assertCurrent();
      const admission = nativeSaveAdmissionIdentity(input.request);
      if (admission) {
        const admissions = new OriginalRequestAdmissions(this.port, this.project);
        if (await admissions.observe(admission, storage))
          throw nativeSaveError('The original native request was rejected before starting.', 'ABS_NATIVE_SAVE_REQUEST_ALREADY_RECORDED');
        await admissions.assertSaveWriter(input.request, storage);
      }
      const found = await readNativeSaveRequest({ ...context, read: key => storage.read(key) }, this.project, input.request);
      if (found) return { created: false, ref: found.ref };
      const previous = await this.previousOperation(storage, assertCurrent);
      if (absJson(await this.disk(storage)) !== absJson(input.disk)) throw conflict();
      const id = crypto.randomUUID();
      const record: AbsOperationSnapshot = { version: 1, id, project: this.project, kind: 'document-save',
        document: input.document, disk: input.disk, committed: await storage.read('committed.json'),
        nativeSave: input.request, ...(admission ? { sourceStageVersion: 1 as const } : {}), ...context };
      const text = absJson(record), hash = await hashAbsText(text);
      assertCurrent();
      if (!await storage.replace(snapshotKey(id), null, text)) throw conflict();
      const index = absJson({ version: 2, kind: 'native-save', project: this.project, operationId: id,
        ...(record.sourceStageVersion ? { sourceStageVersion: record.sourceStageVersion } : {}),
        snapshotHash: hash, request: input.request, ...context });
      if (!await storage.replace(await nativeSaveIndexKey(input.request.requestId), null, index))
        throw nativeSaveError('The exact native request was already consumed.', 'ABS_NATIVE_SAVE_REQUEST_CONFLICT');
      assertCurrent();
      if (!await storage.replace(currentKey, previous === null ? null : await hashAbsText(previous),
        absJson({ version: 1, id, hash, state: 'pending' }))) throw conflict();
      return { created: true, ref: { operationId: id, request: input.request, ...context } };
    });
  }

  async begin(input: Omit<AbsOperationSnapshot, 'version' | 'id' | 'project' | 'committed' | 'sourceStageVersion'>,
    assertCurrent: () => void, markWriteAttempt?: () => void): Promise<string> {
    const id = crypto.randomUUID();
    return this.port.withLock(async storage => {
      assertCurrent();
      const admissions = input.application ? new OriginalRequestAdmissions(this.port, this.project) : undefined;
      let requestKey: string | undefined;
      if (input.application && admissions) {
        const { requestId } = input.application;
        if (await admissions.observe({ operation: 'abs_apply', requestId }, storage))
          throw new AbsSyncError('ABS_APPLY_REQUEST_ALREADY_RECORDED', 'The original apply request was rejected before starting.');
        requestKey = await applicationRequestKey(requestId);
        if (await storage.read(requestKey) !== null) throw applicationAlreadyIndexed();
        await admissions.assertApplicationWriter(requestId, input.candidate?.hash, storage);
      }
      const previous = await this.previousOperation(storage, assertCurrent);
      const disk = await this.disk(storage);
      if (absJson(disk) !== absJson(input.disk)) throw conflict();
      const record: AbsOperationSnapshot = { ...input, version: 1, id, project: this.project,
        committed: await storage.read('committed.json'),
        ...(input.kind === 'abs-apply' && (this.port.attachment || this.port.executor) ? nativeSaveCapability(this.port) : {}),
        // A validated apply's immutable application stage always precedes commit.
        ...(input.kind === 'abs-apply' && input.application ? { sourceStageVersion: 1 as const } : {}) };
      const text = absJson(record), hash = await hashAbsText(text);
      const indexText = requestKey !== undefined && record.application
        ? absJson({ version: 1, project: this.project, operationId: id, snapshotHash: hash,
          requestId: record.application.requestId,
          ...(record.sourceStageVersion ? { sourceStageVersion: record.sourceStageVersion } : {}) })
        : undefined;
      assertCurrent();
      markWriteAttempt?.();
      try {
        if (!await storage.replace(snapshotKey(id), null, text)) throw conflict();
        if (requestKey !== undefined && indexText !== undefined && !await storage.replace(requestKey, null, indexText))
          throw applicationAlreadyIndexed();
      } catch (error) {
        // begin() has not handed the operation to the program writer. The
        // live original executor can settle before leaving this project lock.
        if ((error as { code?: string })?.code === 'ABS_COMMIT_UNCERTAIN' && admissions && record.application
          && record.candidate && record.attachment && record.executor && requestKey && indexText) {
          try {
            assertCurrent();
            const snapshot = await storage.read(snapshotKey(id)), index = await storage.read(requestKey);
            if ((snapshot === null || snapshot === text)
              && (index === null || index === indexText && snapshot === text)
              && await storage.read(currentKey) === previous) {
              await admissions.recordUnstartedApplication({ requestId: record.application.requestId, operationId: id,
                candidateHash: record.candidate.hash, index }, assertCurrent, storage);
            }
          } catch { /* Keep the original error if the writer cannot prove settlement. */ }
        }
        throw error;
      }
      assertCurrent();
      if (!await storage.replace(currentKey, previous === null ? null : await hashAbsText(previous),
        absJson({ version: 1, id, hash, state: 'pending' }))) throw conflict();
      return id;
    });
  }

  async inspect(): Promise<AbsOperationSnapshot | null> {
    const retained = await this.inspectLocation();
    if (retained && retained.operation.project !== this.project)
      throw new AbsSyncError('ABS_OPERATION_CORRUPT', 'The retained operation belongs to another project location.');
    if (retained?.operation.nativeSave) {
      const native = await readNativeSaveRequest(this.port, this.project, retained.operation.nativeSave);
      if (!native || native.ref.operationId !== retained.operation.id) throw conflict();
    }
    return retained?.operation ?? null;
  }

  /** Independent current-Working readback, never a terminal result for the old
   * application. Only a new attachment-bound operation with an exited storage
   * executor qualifies. The caller verifies complete live S1 under this one
   * existing file lock; it must not flush or acquire a nested storage lock. */
  async inspectRestoredApplication(requestId: string, assertCurrent: () => void,
    readback?: (document: unknown) => Promise<void>): Promise<AbsCurrentDocumentRecovery | null> {
    return this.readRestoredApplication(requestId, assertCurrent, readback);
  }

  /** Retain the observed writer fence with its original request before another
   * document operation replaces the current pointer. The original apply stays UNKNOWN. */
  async recordRestoredApplication(id: string, assertCurrent: () => void, readback: (document: unknown) => Promise<void>) {
    const operation = await this.inspect();
    if (operation?.id === id && operation.kind === 'abs-apply' && operation.application) {
      await this.readRestoredApplication(operation.application.requestId, assertCurrent, readback, true);
    }
  }

  private async readRestoredApplication(requestId: string, assertCurrent: () => void,
    readback?: (document: unknown) => Promise<void>, retain = false): Promise<AbsCurrentDocumentRecovery | null> {
    if (!this.port.attachment || !this.port.executor || !this.port.observeExecutor) return null;
    const observer = nativeSaveCapability(this.port);
    return this.port.withLock<AbsCurrentDocumentRecovery | null>(async storage => {
      assertCurrent();
      const indexed = await this.indexedApplication(requestId, storage);
      if (!indexed) return null;
      const { indexKey, indexText, snapshotText, snapshot: record, snapshotHash, original, validation } = indexed;
      const recoveryKey = restoredApplicationKey(record.id);
      const recoveryText = await storage.read(recoveryKey);
      const retained = recoveryText === null ? null : JSON.parse(recoveryText) as RestoredApplicationRecord;
      if (!retained && !readback) return null;
      const pointerText = retained ? retained.operationPointer : await storage.read(currentKey);
      if (pointerText === null) return null;
      const pointer = this.pointer(pointerText);
      if (pointer.id !== record.id || pointer.hash !== snapshotHash || pointer.state !== 'restored') return null;
      if (record.disk.abi === null || record.disk.abs === null || record.disk.map === null || record.committed === null) return null;
      const applicationStage = stageKey(pointer.id), staged = await storage.read(applicationStage);
      // Keep the original proof bound to its snapshot. Verify and preserve a
      // separate author draft only when sealing the durable project-v1 record.
      const readbackDisk = retained ? record.disk : await this.disk(storage);
      if (readbackDisk.abi !== record.disk.abi || readbackDisk.map !== record.disk.map) return null;
      const draftChanged = readbackDisk.abs !== record.disk.abs;
      if (draftChanged && !retain) return null;
      const accepted = draftChanged
        ? new AbsBaselineStore({ ...this.port, read: key => storage.read(key) }, { projectKey: this.project, pageId: '' })
        : undefined;
      const draftIsIndependent = async () => {
        if (!accepted) return true;
        if (await accepted.workspaceMode(storage) !== 'project-v1') return false;
        const committed = await accepted.readCommittedSnapshot();
        return committed?.projection.map.scope.projectKey === this.project && await accepted.matchesAcceptedDisk(committed, readbackDisk);
      };
      const unchanged = async (historical: boolean) => {
        assertCurrent();
        if (await storage.read(indexKey) !== indexText || await storage.read(recoveryKey) !== recoveryText
          || await storage.read(snapshotKey(pointer.id)) !== snapshotText
          || await storage.read(applicationStage) !== staged
          || (!historical && (await storage.read(currentKey) !== pointerText || !await draftIsIndependent()
            || absJson(await this.disk(storage)) !== absJson(readbackDisk)
            || await storage.read('committed.json') !== record.committed || await storage.read('prepared.json') !== null))) return false;
        assertCurrent();
        return this.hasNoResult(storage, pointer.id);
      };
      if (!await unchanged(!!retained)) return null;
      const oldWriter = retained ? retained.recovery?.oldWriter : await this.port.observeExecutor!(original.executor);
      if (!exitedApplicationWriter(oldWriter)) return null;
      if (staged !== null && !await this.matchesRestoredStage(storage, record, staged)) return null;
      const recoveryObserver = retained ? nativeSaveCapability({ attachment: observer.attachment, executor: retained.recovery.observerExecutor }).executor
        : observer.executor;
      if (!retained) await readback!(record.document);
      assertCurrent();
      if (!await unchanged(!!retained)) return null;
      const finalWriter = await this.port.observeExecutor!(original.executor);
      if (retained) {
        // A transient probe failure cannot undo a sealed exit and Working readback.
        const unavailable = finalWriter?.version === 1 && finalWriter.state === 'unknown'
          && (finalWriter.reason === 'identity-unavailable' || finalWriter.reason === 'process-unavailable');
        if (!exitedApplicationWriter(finalWriter) && !unavailable) return null;
      } else if (absJson(finalWriter) !== absJson(oldWriter)) return null;
      const recovery: RestoredApplicationRecord['recovery'] = { version: 1, scope: 'restored-working-document', state: 'restored', requestId, operationId: pointer.id,
        snapshotHash, operationPointerHash: await hashAbsText(pointerText),
        documentHash: await hashAbsText(absJson(record.document)), attachment: observer.attachment,
        originalExecutor: original.executor, observerExecutor: recoveryObserver,
        saved: { abiHash: await hashAbsText(record.disk.abi), absHash: await hashAbsText(record.disk.abs),
          mapHash: await hashAbsText(record.disk.map), committedHash: await hashAbsText(record.committed) },
        candidate: { hash: validation.candidate.hash, bytes: validation.candidate.bytes,
          intentGeneration: validation.intentGeneration ?? validation.base.generation },
        oldWriter, candidateApplied: false, originalPublication: 'UNKNOWN' };
      const marker: RestoredApplicationRecord = { version: 1, kind: 'restored-working-document', project: this.project,
        operationPointer: pointerText, stagedHash: staged === null ? null : await hashAbsText(staged), recovery };
      assertCurrent();
      if (retained) {
        if (absJson(marker) !== absJson(retained)) throw conflict();
        return { ...recovery, settlement: { version: 1, recordHash: await hashAbsText(recoveryText!) } };
      }
      if (!retain) return recovery;
      const text = absJson(marker);
      if (!await storage.replace(recoveryKey, null, text)) throw conflict();
      return { ...recovery, settlement: { version: 1, recordHash: await hashAbsText(text) } };
    });
  }

  async matchesCopiedApplication(retained: LocationOperation, generation: string, pageId: string): Promise<boolean> {
    const source = retained.operation, application = source.application, candidate = source.candidate;
    if (source.kind !== 'abs-apply' || source.project !== this.project || !source.committed || !application || !candidate) return false;
    const validation = application.validation as any;
    assertGenerationValidation(validation);
    const indexText = await this.port.read(await applicationRequestKey(application.requestId));
    const index = indexText === null ? null : JSON.parse(indexText);
    const staged = await this.port.read(`recoveries/application-${source.id}.json`);
    if (index?.version !== 1 || index.project !== this.project || index.requestId !== application.requestId
      || index.operationId !== source.id || index.snapshotHash !== await hashAbsText(retained.snapshot)
      || validation.requestId !== application.requestId || validation.candidate.hash !== candidate.hash
      || validation.candidate.bytes !== new TextEncoder().encode(candidate.source).length
      || validation.base.generation !== candidate.generation || validation.base.scope.projectKey !== this.project
      || validation.base.scope.pageId !== pageId || staged === null) return false;
    return this.matchesRestoredStage(this.port, source, staged, generation);
  }

  private async matchesRestoredStage(storage: Pick<AbsSyncStorageAccess, 'read'>, operation: AbsOperationSnapshot, staged: string,
    generation?: string): Promise<boolean> {
    const record = JSON.parse(staged), evidence = record.outcome?.evidence;
    const binding = evidence?.binding;
    if (record.version !== 1 || record.project !== this.project || record.operationId !== operation.id
      || absJson(record.validation) !== absJson(operation.application!.validation) || binding?.scope?.projectKey !== this.project
      || typeof binding.scope.pageId !== 'string' || typeof binding.generation !== 'string' || binding.generation === operation.candidate!.generation
      || generation !== undefined && binding.generation !== generation
      || record.outcome?.publication?.status !== 'COMMITTED' || record.outcome.publication.generation !== binding.generation) return false;
    return new AbsBaselineStore(this.port, binding.scope).matchesRestoredApplicationStage(storage, evidence,
      operation.candidate!.source, operation.disk, operation.committed!);
  }

  async hasUnsettledOperation(): Promise<boolean> {
    const text = await this.port.read(currentKey);
    return text !== null && this.pointer(text).state !== 'completed';
  }

  /** Discovery only. A different path cannot authorize restoring this view;
   * the caller must prove its exact complete saved source before migration. */
  async inspectLocation(): Promise<LocationOperation | null> {
    const text = await this.port.read(currentKey);
    if (text === null) return null;
    const pointer = this.pointer(text);
    if (pointer.state === 'completed') return null;
    const snapshot = await this.port.read(snapshotKey(pointer.id));
    if (snapshot === null || await hashAbsText(snapshot) !== pointer.hash) {
      throw new AbsSyncError('ABS_OPERATION_CORRUPT', 'The retained complete operation snapshot is missing or changed.');
    }
    let record: AbsOperationSnapshot;
    try { record = JSON.parse(snapshot); }
    catch { throw new AbsSyncError('ABS_OPERATION_CORRUPT', 'Invalid retained operation encoding.'); }
    if (record.version !== 1 || record.id !== pointer.id || typeof record.project !== 'string' || !record.project
      || !['abs-apply', 'runtime-rebuild', 'document-save'].includes(record.kind) || !record.document || typeof record.document !== 'object'
      || !record.disk || Object.keys(record.disk).sort().join(',') !== 'abi,abs,map'
      || !Object.values(record.disk).every(value => value === null || typeof value === 'string')
      || record.committed !== null && typeof record.committed !== 'string'
      || record.candidate && (typeof record.candidate.source !== 'string' || typeof record.candidate.generation !== 'string'
        || await hashAbsText(record.candidate.source) !== record.candidate.hash)) {
      throw new AbsSyncError('ABS_OPERATION_CORRUPT', 'Invalid complete operation snapshot.');
    }
    if (await this.port.read(currentKey) !== text) throw conflict();
    if (pointer.sourceCommitted !== undefined) {
      if (record.disk.abi === null || pointer.sourceAbiHash !== await hashAbsText(record.disk.abi)) throw conflict();
      record.committed = pointer.sourceCommitted;
    }
    return { operation: record, pointer: text, snapshot };
  }

  async archiveLocation(input: LocationOperation, disk: AbsDiskSnapshot, committed: string,
    assertCurrent: () => void): Promise<void> {
    const text = absJson({ version: 1, kind: 'operation-location', project: this.project,
      sourceProject: input.operation.project, pointer: input.pointer, snapshot: input.snapshot });
    const key = `recoveries/location-${(await hashAbsText(text)).slice(7)}.json`;
    await this.port.withLock(async storage => {
      assertCurrent();
      if (await storage.read(currentKey) !== input.pointer || await storage.read(snapshotKey(input.operation.id)) !== input.snapshot
        || absJson(await this.disk(storage)) !== absJson(disk) || await storage.read('committed.json') !== committed
        || await storage.read('prepared.json') !== null) throw conflict();
      const before = await storage.read(key);
      if (before !== text && (before !== null || !await storage.replace(key, null, text))) throw conflict();
    });
  }

  /** Atomic pointer handoff after byte-preserving location metadata recovery.
   * The old operation/request is historical; this restores its view only. */
  async relocate(input: LocationOperation, disk: AbsDiskSnapshot, committed: string,
    assertCurrent: () => void): Promise<AbsOperationSnapshot> {
    const id = crypto.randomUUID();
    const { application, nativeSave, attachment, executor, ...original } = input.operation;
    const record: AbsOperationSnapshot = { ...original, id, project: this.project, disk, committed };
    const text = absJson(record), hash = await hashAbsText(text), previous = this.pointer(input.pointer);
    await this.port.withLock(async storage => {
      assertCurrent();
      if (await storage.read(currentKey) !== input.pointer || await storage.read(snapshotKey(input.operation.id)) !== input.snapshot
        || absJson(await this.disk(storage)) !== absJson(disk) || await storage.read('committed.json') !== committed
        || await storage.read('prepared.json') !== null) throw conflict();
      if (!await storage.replace(snapshotKey(id), null, text)) throw conflict();
      assertCurrent();
      if (!await storage.replace(currentKey, await hashAbsText(input.pointer),
        absJson({ version: 1, id, hash, state: previous.state }))) throw conflict();
    });
    return record;
  }

  async retireLocation(input: LocationOperation, disk: AbsDiskSnapshot, committed: string,
    assertCurrent: () => void): Promise<void> {
    await this.port.withLock(async storage => {
      assertCurrent();
      if (await storage.read(currentKey) !== input.pointer || await storage.read(snapshotKey(input.operation.id)) !== input.snapshot
        || absJson(await this.disk(storage)) !== absJson(disk) || await storage.read('committed.json') !== committed
        || await storage.read('prepared.json') !== null) throw conflict();
      const pointer = this.pointer(input.pointer);
      if (!await storage.replace(currentKey, await hashAbsText(input.pointer), absJson({ ...pointer, state: 'completed',
        recovery: { version: 1, project: this.project, viewRetired: true, candidateApplied: false,
          originalApplicationResult: 'unknown' } }))) throw conflict();
    });
  }

  /** A metadata-only repair may advance the saved-source pointer while leaving
   * this unsaved view intact. Re-anchor only after complete saved ABI readback;
   * this never acknowledges or applies the retained view/candidate. */
  async reanchorSource(id: string, assertCurrent: () => void): Promise<boolean> {
    const operation = await this.inspect();
    if (!operation || operation.id !== id || operation.disk.abi === null) throw conflict();
    const store = new AbsBaselineStore(this.port, { projectKey: this.project, pageId: '' });
    const committed = await store.inspectCommitted();
    if (!committed || committed.projection.map.scope.projectKey !== this.project) throw conflict();
    if (await store.readDerivedAbi(committed.projection.map.generation) !== operation.disk.abi) return false;
    if (await this.port.read('committed.json') === operation.committed) { assertCurrent(); return true; }
    if (!await store.isMetadataOnlyContinuation(operation.committed, operation.disk.abi)) return false;
    await this.port.withLock(async storage => {
      const pointerText = await storage.read(currentKey), committedText = await storage.read('committed.json');
      if (pointerText === null || committedText === null || await hashAbsText(committedText) !== committed.pointerHash
        || await storage.read('project.abi') !== operation.disk.abi) throw conflict();
      const pointer = this.pointer(pointerText);
      if (pointer.id !== id) throw conflict();
      assertCurrent();
      if (!await storage.replace(currentKey, await hashAbsText(pointerText), absJson({ ...pointer,
        sourceCommitted: committedText, sourceAbiHash: await hashAbsText(operation.disk.abi) }))) throw conflict();
    });
    return true;
  }

  /** Acknowledges only this exact operation after readback/rollback, never its candidate. */
  async finish(id: string, assertCurrent: () => void): Promise<void> {
    return this.advance(id, 'completed', assertCurrent);
  }

  /** The sole commit point for a byte-identical save. Recheck all source bytes
   * and the original committed pointer under the same lock as retirement. */
  async finishUnchangedSave(id: string, expected: AbsDiskSnapshot, assertCurrent: () => void,
    seal?: (storage: AbsSyncStorageAccess, original: AbsOperationSnapshot, committedPointer: string | null) => Promise<void>): Promise<void> {
    await this.port.withLock(async storage => {
      const pointerText = await storage.read(currentKey);
      if (pointerText === null) throw conflict();
      const pointer = this.pointer(pointerText);
      if (pointer.id !== id) throw conflict();
      if (pointer.state === 'completed') return;
      const snapshot = await storage.read(snapshotKey(id));
      if (snapshot === null || await hashAbsText(snapshot) !== pointer.hash) throw conflict();
      const record = JSON.parse(snapshot) as AbsOperationSnapshot;
      if (record.kind !== 'document-save' || absJson(record.disk) !== absJson(expected)
        || absJson(await this.disk(storage)) !== absJson(expected) || await storage.read('committed.json') !== record.committed) {
        throw new AbsSyncError('ABS_DISK_CONFLICT', 'The saved source changed before the unchanged-save acknowledgement. Its complete view was retained.');
      }
      assertCurrent();
      if (seal) { await seal(storage, record, record.committed); assertCurrent(); }
      if (!await storage.replace(currentKey, await hashAbsText(pointerText), absJson({ ...pointer, state: 'completed' }))) throw conflict();
    });
  }

  /** Native readback recovered the view, but unsaved content stays durable
   * through another crash until a normal save advances the committed source. */
  async restored(id: string, assertCurrent: () => void): Promise<void> {
    return this.advance(id, 'restored', assertCurrent);
  }

  private async advance(id: string, state: 'restored' | 'completed', assertCurrent: () => void): Promise<void> {
    await this.port.withLock(async storage => {
      const text = await storage.read(currentKey);
      if (text === null) throw conflict();
      const pointer = this.pointer(text);
      if (pointer.id !== id) throw conflict();
      if (pointer.state === 'completed' || pointer.state === state) return;
      if (state === 'restored') await this.retainSaveBeforeAdvancing(pointer, assertCurrent, storage);
      assertCurrent();
      if (!await storage.replace(currentKey, await hashAbsText(text), absJson({ ...pointer, state }))) throw conflict();
    });
  }

  private async previousOperation(storage: AbsSyncStorageAccess, assertCurrent: () => void) {
    const previous = await storage.read(currentKey);
    if (previous === null) return null;
    const pointer = this.pointer(previous);
    if (pointer.state === 'pending') throw conflict();
    if (pointer.state === 'restored') {
      await this.retainHandoff(previous, assertCurrent, storage);
      await this.retainSaveBeforeAdvancing(pointer, assertCurrent, storage);
    }
    return previous;
  }

  private pointer(text: string): OperationPointer {
    let pointer: OperationPointer;
    try { pointer = JSON.parse(text); } catch { throw new AbsSyncError('ABS_OPERATION_CORRUPT', 'Invalid retained operation pointer.'); }
    if (pointer?.version !== 1 || !/^[a-f0-9-]{36}$/.test(pointer.id) || !/^sha256:[a-f0-9]{64}$/.test(pointer.hash)
      || !['pending', 'restored', 'completed'].includes(pointer.state)) throw new AbsSyncError('ABS_OPERATION_CORRUPT', 'Invalid retained operation pointer.');
    return pointer;
  }
  private async disk(storage: Pick<AbsSyncStorageAccess, 'read'>): Promise<AbsDiskSnapshot> {
    const [abi, abs, map] = await Promise.all(['project.abi', 'project.abs', 'project.abs.map.json'].map(key => storage.read(key)));
    return { abi, abs, map };
  }
}
