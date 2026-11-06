import { AbsBaselineStore, type AbsDiskSnapshot, type AbsSyncStorageAccess, type AbsSyncStoragePort } from './abs-baseline-store';
import { absJson, hashAbsText } from './abs-identity-map';
import { AbsSyncError } from './abs-state';

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
}
interface OperationPointer { version: 1; id: string; hash: string; state: 'pending' | 'restored' | 'completed'; sourceCommitted?: string; sourceAbiHash?: string }
interface LocationOperation {
  operation: AbsOperationSnapshot; pointer: string; snapshot: string;
}
const currentKey = 'operation.json';
const snapshotKey = (id: string) => `recoveries/operation-${id}.json`;
const conflict = () => new AbsSyncError('ABS_OPERATION_CONFLICT', 'A different document operation is retained; inspect it before replacing its recovery snapshot.');

/** Durable recovery facts, never a workspace lease or authority to replay a candidate. */
export class AbsOperationJournal {
  constructor(private readonly port: AbsSyncStoragePort, private readonly project: string) {}

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
        committed: await storage.read('committed.json') };
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
    return retained?.operation ?? null;
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
  async finishUnchangedSave(id: string, expected: AbsDiskSnapshot, assertCurrent: () => void): Promise<void> {
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
