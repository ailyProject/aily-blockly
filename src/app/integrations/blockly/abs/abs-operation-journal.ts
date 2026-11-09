import { AbsBaselineStore, type AbsDiskSnapshot, type AbsSyncStorageAccess, type AbsSyncStoragePort,
  type AbsProjectAttachment, type AbsStorageExecutor, type AbsStorageExecutorObservation } from './abs-baseline-store';
import { assertGenerationValidation } from './abs-generation-protocol';
import { absJson, hashAbsText } from './abs-identity-map';
import { AbsSyncError } from './abs-state';
import { assertNativeSaveIdentity, nativeSaveCapability, nativeSaveIndexKey, nativeSaveError, readNativeSaveRequest,
  type NativeSaveIdentity, type NativeSaveOperationRef } from './abs-native-save-protocol';
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
}
export interface AbsUnpublishedDocumentSave {
  version: 1; kind: 'source-not-published'; requestId: string; operationId: string;
  attachment: AbsProjectAttachment; originalExecutor: AbsStorageExecutor; observerExecutor: AbsStorageExecutor;
  oldWriter: AbsStorageExecutorObservation & { state: 'exited' };
  snapshotHash: string;
  saved: { abiHash: string | null; absHash: string | null; mapHash: string | null;
    committedHash: string | null; operationPointerHash: string };
}
interface LocationOperation {
  operation: AbsOperationSnapshot; pointer: string; snapshot: string;
}
const currentKey = 'operation.json';
const snapshotKey = (id: string) => `recoveries/operation-${id}.json`;
const conflict = () => new AbsSyncError('ABS_OPERATION_CONFLICT', 'A different document operation is retained; inspect it before replacing its recovery snapshot.');

/** Durable recovery facts, never a workspace lease or authority to replay a candidate. */
export class AbsOperationJournal {
  constructor(private readonly port: AbsSyncStoragePort, private readonly project: string) {}

  /** An environment may recover before GUI loading. This proves only that
   * its dead parent did not publish source, not that Working was restored. */
  async inspectUnpublishedDocumentSave(ref: NativeSaveOperationRef, guard: () => void): Promise<AbsUnpublishedDocumentSave | null> {
    if (!this.port.observeExecutor) return null;
    const context = nativeSaveCapability(this.port);
    return this.port.withLock(async storage => {
      guard();
      const original = await readNativeSaveRequest({ ...context, read: key => storage.read(key) }, this.project, ref.request);
      if (!original || absJson(original.ref) !== absJson(ref)) return null;
      const pointerText = await storage.read(currentKey);
      if (pointerText === null) return null;
      const pointer = this.pointer(pointerText);
      if (pointer.id !== ref.operationId || pointer.hash !== original.snapshotHash || pointer.state === 'completed') return null;
      const unchanged = async () => {
        guard();
        return await storage.read(currentKey) === pointerText
          && absJson(await this.disk(storage)) === absJson(original.snapshot.disk)
          && await storage.read('committed.json') === original.snapshot.committed
          && await storage.read('prepared.json') === null
          && await storage.read(`recoveries/application-commit-${ref.operationId}.json`) === null
          && await storage.read(`recoveries/application-result-${ref.operationId}.json`) === null;
      };
      if (!await unchanged()) return null;
      const oldWriter = await this.port.observeExecutor!(ref.executor);
      if (oldWriter.state !== 'exited' || !['system-restarted', 'process-exited', 'process-reused'].includes(oldWriter.reason)) return null;
      const hash = (value: string | null) => value === null ? Promise.resolve(null) : hashAbsText(value);
      const saved = { abiHash: await hash(original.snapshot.disk.abi), absHash: await hash(original.snapshot.disk.abs),
        mapHash: await hash(original.snapshot.disk.map), committedHash: await hash(original.snapshot.committed),
        operationPointerHash: await hashAbsText(pointerText) };
      if (!await unchanged() || absJson(await this.port.observeExecutor!(ref.executor)) !== absJson(oldWriter)) return null;
      guard();
      return { version: 1, kind: 'source-not-published', requestId: ref.request.requestId, operationId: ref.operationId,
        attachment: context.attachment, originalExecutor: ref.executor, observerExecutor: context.executor,
        oldWriter: oldWriter as AbsUnpublishedDocumentSave['oldWriter'], snapshotHash: original.snapshotHash, saved };
    });
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
      const found = await readNativeSaveRequest({ ...context, read: key => storage.read(key) }, this.project, input.request);
      if (found) return { created: false, ref: found.ref };
      const previous = await storage.read(currentKey);
      if (previous !== null && this.pointer(previous).state === 'pending') throw conflict();
      if (absJson(await this.disk(storage)) !== absJson(input.disk)) throw conflict();
      const id = crypto.randomUUID();
      const record: AbsOperationSnapshot = { version: 1, id, project: this.project, kind: 'document-save',
        document: input.document, disk: input.disk, committed: await storage.read('committed.json'),
        nativeSave: input.request, ...context };
      const text = absJson(record), hash = await hashAbsText(text);
      assertCurrent();
      if (!await storage.replace(snapshotKey(id), null, text)) throw conflict();
      const index = absJson({ version: 2, kind: 'native-save', project: this.project, operationId: id,
        snapshotHash: hash, request: input.request, ...context });
      if (!await storage.replace(await nativeSaveIndexKey(input.request.requestId), null, index))
        throw nativeSaveError('The exact native request was already consumed.', 'ABS_NATIVE_SAVE_REQUEST_CONFLICT');
      assertCurrent();
      if (!await storage.replace(currentKey, previous === null ? null : await hashAbsText(previous),
        absJson({ version: 1, id, hash, state: 'pending' }))) throw conflict();
      return { created: true, ref: { operationId: id, request: input.request, ...context } };
    });
  }

  async begin(input: Omit<AbsOperationSnapshot, 'version' | 'id' | 'project' | 'committed'>,
    assertCurrent: () => void): Promise<string> {
    const id = crypto.randomUUID();
    return this.port.withLock(async storage => {
      assertCurrent();
      const previous = await storage.read(currentKey);
      if (previous !== null && this.pointer(previous).state === 'pending') throw conflict();
      const disk = await this.disk(storage);
      if (absJson(disk) !== absJson(input.disk)) throw conflict();
      const record: AbsOperationSnapshot = { ...input, version: 1, id, project: this.project,
        committed: await storage.read('committed.json'),
        ...(input.kind === 'abs-apply' && (this.port.attachment || this.port.executor) ? nativeSaveCapability(this.port) : {}) };
      const text = absJson(record), hash = await hashAbsText(text);
      assertCurrent();
      if (!await storage.replace(snapshotKey(id), null, text)) throw conflict();
      if (record.application) {
        const key = `recoveries/request-${(await hashAbsText(record.application.requestId)).slice(7)}.json`;
        if (!await storage.replace(key, null, absJson({ version: 1, project: this.project, operationId: id, snapshotHash: hash,
          requestId: record.application.requestId }))) throw new AbsSyncError('ABS_APPLY_REQUEST_ALREADY_RECORDED',
            'This exact apply request is retained. Observe its result; it cannot apply the candidate twice.');
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
    readback: (document: unknown) => Promise<void>): Promise<AbsCurrentDocumentRecovery | null> {
    if (!this.port.attachment || !this.port.executor || !this.port.observeExecutor) return null;
    const observer = nativeSaveCapability(this.port);
    return this.port.withLock<AbsCurrentDocumentRecovery | null>(async storage => {
      assertCurrent();
      const indexKey = `recoveries/request-${(await hashAbsText(requestId)).slice(7)}.json`;
      const indexText = await storage.read(indexKey);
      if (indexText === null) return null;
      const index = JSON.parse(indexText);
      if (index.version !== 1 || index.project !== this.project || index.requestId !== requestId
        || !/^[a-f0-9-]{36}$/.test(index.operationId) || !/^sha256:[a-f0-9]{64}$/.test(index.snapshotHash)) throw conflict();
      const pointerText = await storage.read(currentKey);
      if (pointerText === null) return null;
      const pointer = this.pointer(pointerText);
      if (pointer.id !== index.operationId || pointer.hash !== index.snapshotHash || pointer.state !== 'restored') return null;
      const snapshotText = await storage.read(snapshotKey(pointer.id));
      if (snapshotText === null || await hashAbsText(snapshotText) !== index.snapshotHash) throw conflict();
      const record = JSON.parse(snapshotText) as AbsOperationSnapshot;
      if (record.kind !== 'abs-apply' || record.version !== 1 || record.project !== this.project || record.id !== pointer.id
        || record.application?.requestId !== requestId || !record.document || !record.candidate
        || !record.disk || Object.keys(record.disk).sort().join(',') !== 'abi,abs,map'
        || !Object.values(record.disk).every(value => value === null || typeof value === 'string')
        || record.committed !== null && typeof record.committed !== 'string') throw conflict();
      // Legacy records remain inspectable but cannot acquire new recovery authority.
      if (!record.attachment || !record.executor) return null;
      const original = nativeSaveCapability({ attachment: record.attachment, executor: record.executor });
      if (absJson(original.attachment) !== absJson(observer.attachment)) return null;
      const validation: any = record.application.validation;
      assertGenerationValidation(validation);
      if (validation.requestId !== requestId || validation.candidate.hash !== record.candidate.hash
        || validation.candidate.bytes !== new TextEncoder().encode(record.candidate.source).length
        || await hashAbsText(record.candidate.source) !== record.candidate.hash
        || validation.base.generation !== record.candidate.generation
        || validation.base.scope.projectKey !== this.project) throw conflict();
      const unchanged = async () => {
        assertCurrent();
        if (await storage.read(indexKey) !== indexText || await storage.read(currentKey) !== pointerText
          || await storage.read(snapshotKey(pointer.id)) !== snapshotText
          || absJson(await this.disk(storage)) !== absJson(record.disk)
          || await storage.read('committed.json') !== record.committed || await storage.read('prepared.json') !== null) return false;
        for (const key of [`recoveries/application-${pointer.id}.json`, `recoveries/application-commit-${pointer.id}.json`,
          `recoveries/application-result-${pointer.id}.json`]) if (await storage.read(key) !== null) return false;
        assertCurrent(); return true;
      };
      if (record.disk.abi === null || record.disk.abs === null || record.disk.map === null || record.committed === null || !await unchanged()) return null;
      const oldWriter = await this.port.observeExecutor!(original.executor);
      if (oldWriter?.version !== 1 || oldWriter.state !== 'exited'
        || !['system-restarted', 'process-exited', 'process-reused'].includes(oldWriter.reason)) return null;
      await readback(record.document);
      assertCurrent();
      if (!await unchanged()) return null;
      const finalWriter = await this.port.observeExecutor!(original.executor);
      if (absJson(finalWriter) !== absJson(oldWriter)) return null;
      assertCurrent();
      return { version: 1, scope: 'restored-working-document', state: 'restored', requestId, operationId: pointer.id,
        snapshotHash: index.snapshotHash, operationPointerHash: await hashAbsText(pointerText),
        documentHash: await hashAbsText(absJson(record.document)), attachment: observer.attachment,
        originalExecutor: original.executor, observerExecutor: observer.executor,
        saved: { abiHash: await hashAbsText(record.disk.abi), absHash: await hashAbsText(record.disk.abs),
          mapHash: await hashAbsText(record.disk.map), committedHash: await hashAbsText(record.committed) },
        candidate: { hash: record.candidate.hash, bytes: validation.candidate.bytes,
          intentGeneration: validation.intentGeneration ?? validation.base.generation },
        oldWriter: oldWriter as AbsCurrentDocumentRecovery['oldWriter'], candidateApplied: false, originalPublication: 'UNKNOWN' };
    });
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
    const { application, ...original } = input.operation;
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
      assertCurrent();
      if (!await storage.replace(currentKey, await hashAbsText(text), absJson({ ...pointer, state }))) throw conflict();
    });
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
