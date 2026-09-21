import { absJson, assertCurrentAbsProjection, hashAbsText, validateAbsProjection } from './abs-identity-map';
import { AbsIdentityMap, AbsProjection, AbsSyncError } from './abs-state';

/**
 * Project-scoped host capability. Keys are relative to its private sync directory,
 * except the three explicit project mirrors. The host owns path confinement,
 * single-file atomic writes and a lock shared with ALL product/Agent file writers.
 * CAS does not claim to lock arbitrary external processes: retain recovery copies.
 */
export interface AbsSyncStorageAccess {
  read(key: string): Promise<string | null>;
  replace(key: string, expectedByteHash: string | null, content: string | null): Promise<boolean>;
}
export interface AbsSyncStoragePort {
  read(key: string): Promise<string | null>;
  /** Write capability exists only inside this callback; never store a global active lock. */
  withLock<T>(operation: (storage: AbsSyncStorageAccess) => Promise<T>): Promise<T>;
}

export interface AbsDiskSnapshot { abi: string | null; abs: string | null; map: string | null }
export interface AbsGenerationInput {
  projection: AbsProjection;
  mode: 'import' | 'export';
  /** Exact caller input, not a re-rendered approximation; retained even on conflict. */
  inputAbs: string | null;
  /** Already prepared save shape. Export alone must not create/save project.abi. */
  abi: string | null;
  expected: AbsDiskSnapshot;
  /** Exact replaced map retained only for an explicit scope/map rebind. */
  inputMap?: string | null;
  /** Explicit draft refresh: inputAbs/inputMap are the durable original draft pair. */
  draftBaseGeneration?: string;
}
interface GenerationRecord extends Omit<AbsGenerationInput, 'expected'> {
  schemaVersion: 1;
  expected: AbsDiskSnapshot; // Byte hashes, unlike canonical ABI hashes in the map.
  previousCommitted: string | null;
}
interface GenerationPointer { schemaVersion: 1; generation: string; hash: string }
export interface AbsPublishResult {
  status: 'COMMITTED' | 'NOT_COMMITTED' | 'MIRROR_PENDING' | 'CONFLICT';
  generation: string;
  abiSaved: boolean;
  absMirrored: boolean;
  mapPublished: boolean;
  error?: string;
}
const ABI = 'project.abi';
const ABS = 'project.abs';
const MAP = 'project.abs.map.json';
const PREPARED = 'prepared.json';
const COMMITTED = 'committed.json';

export function absBaselineKey(generation: string): string {
  if (!/^[A-Za-z0-9_-]{1,96}$/.test(generation)) throw new AbsSyncError('ABS_GENERATION_INVALID', 'Invalid generation identifier.');
  return `baselines/${generation}.json`;
}
const hashNullable = (text: string | null) => text === null ? Promise.resolve(null) : hashAbsText(text);

/** Immutable baseline storage and recoverable mirror publication, independent of Blockly/Angular. */
export class AbsBaselineStore {
  private readonly scope: AbsIdentityMap['scope'];
  constructor(private readonly port: AbsSyncStoragePort, scope: AbsIdentityMap['scope']) { this.scope = { ...scope }; }

  async captureDisk(storage: Pick<AbsSyncStorageAccess, 'read'> = this.port): Promise<AbsDiskSnapshot> {
    const [abi, abs, map] = await Promise.all([storage.read(ABI), storage.read(ABS), storage.read(MAP)]);
    return { abi, abs, map };
  }

  /** Creates a generation only. Does not publish ABS, mark it ready, or save ABI. */
  async stage(input: AbsGenerationInput, expectedCommitted?: string | null): Promise<string> {
    input = JSON.parse(absJson(input));
    this.assertScope(input.projection);
    await validateAbsProjection(input.projection);
    const generation = input.projection.map.generation;
    const key = absBaselineKey(generation);
    if (input.projection.map.baselineRef !== key) throw new AbsSyncError('ABS_MAP_INVALID', 'Baseline reference must be derived by the host.');
    if ((input.mode === 'import' && (typeof input.abi !== 'string' || typeof input.inputAbs !== 'string'))
      || (input.mode === 'export' && input.abi !== null) || !['import', 'export'].includes(input.mode)) {
      throw new AbsSyncError('ABS_GENERATION_INVALID', 'Invalid save/export generation.');
    }
    const savedAbi = input.mode === 'import' ? input.abi : input.expected.abi;
    const savedHash = savedAbi === null ? null : await hashAbsText(absJson(JSON.parse(savedAbi)));
    if (input.projection.map.savedAbiHash !== savedHash) throw new AbsSyncError('ABS_MAP_INVALID', 'Saved ABI hash does not match the prepared save shape.');
    const expected = await this.hashDisk(input.expected);
    await this.assertDraftArchive({ ...input, expected });
    if (input.inputMap !== undefined && (typeof input.inputMap !== 'string' && input.inputMap !== null
      || await hashNullable(input.inputMap) !== expected.map)) throw new AbsSyncError('ABS_GENERATION_INVALID', 'Recovery map must retain the exact replaced bytes.');
    await this.port.withLock(async storage => {
      const previousCommitted = await hashNullable(await storage.read(COMMITTED));
      if (expectedCommitted !== undefined && expectedCommitted !== previousCommitted) {
        throw new AbsSyncError('ABS_BASELINE_STALE', 'Committed generation changed before staging.');
      }
      const record: GenerationRecord = { ...input, schemaVersion: 1, expected,
        previousCommitted };
      const content = absJson(record);
      const existing = await storage.read(key);
      if (existing === content) return;
      if (existing !== null || !await storage.replace(key, null, content)) {
        throw new AbsSyncError('ABS_GENERATION_EXISTS', 'An immutable generation cannot be overwritten.');
      }
    });
    return generation;
  }

  async load(generation: string): Promise<AbsProjection> {
    const projection = (await this.readGeneration(this.port, generation)).record.projection;
    assertCurrentAbsProjection(projection);
    return projection;
  }

  async readArchivedDraft(generation: string) {
    const { record } = await this.readGeneration(this.port, generation);
    if (!record.draftBaseGeneration) throw new AbsSyncError('ABS_DRAFT_ARCHIVE_MISSING', 'This generation is not an archived draft.');
    return { generation, baseGeneration: record.draftBaseGeneration, abs: record.inputAbs!,
      hash: record.expected.abs!, bytes: new TextEncoder().encode(record.inputAbs!).byteLength };
  }

  private async assertDraftArchive(record: Pick<AbsGenerationInput, 'mode' | 'inputAbs' | 'inputMap' | 'draftBaseGeneration' | 'expected'>) {
    if (record.draftBaseGeneration === undefined) return;
    absBaselineKey(record.draftBaseGeneration);
    if (record.mode !== 'export' || typeof record.inputAbs !== 'string' || typeof record.inputMap !== 'string'
      || await hashAbsText(record.inputAbs) !== record.expected.abs
      || JSON.parse(record.inputMap).generation !== record.draftBaseGeneration) {
      throw new AbsSyncError('ABS_GENERATION_INVALID', 'Draft archive must retain the exact source bytes and original generation map.');
    }
  }

  /** The host pointer, not an edited public map, selects the authoritative baseline. */
  async loadCommitted(): Promise<AbsProjection | null> {
    const committed = await this.inspectCommitted();
    if (committed) this.assertScope(committed.projection);
    if (committed) assertCurrentAbsProjection(committed.projection);
    return committed?.projection ?? null;
  }

  /** Cross-scope, checksum-verified diagnosis only. Does not authorize load/apply/recovery. */
  async inspectCommitted(): Promise<{ projection: AbsProjection; pointerHash: string } | null> {
    const text = await this.port.read(COMMITTED);
    if (text === null) return null;
    const pointer = this.parsePointer(text);
    const loaded = await this.readGeneration(this.port, pointer.generation, true);
    if (absJson(pointer) !== absJson(loaded.pointer)) throw new AbsSyncError('ABS_BASELINE_CORRUPT', 'Committed baseline checksum mismatch.');
    if (await this.port.read(COMMITTED) !== text) throw new AbsSyncError('ABS_BASELINE_STALE', 'Committed generation changed during capture.');
    return { projection: loaded.record.projection, pointerHash: await hashAbsText(text) };
  }

  /** Read-only diagnosis. A pending journal is never interpreted as permission to replay ABI. */
  async inspectPending(): Promise<(AbsPublishResult & { mode: 'import' | 'export' }) | null> {
    const text = await this.port.read(PREPARED);
    if (text === null) return null;
    const pointer = this.parsePointer(text);
    const { record, pointer: actual } = await this.readGeneration(this.port, pointer.generation);
    if (absJson(pointer) !== absJson(actual)) throw new AbsSyncError('ABS_BASELINE_CORRUPT', 'Prepared baseline checksum mismatch.');
    const result = await this.classifyFailure(this.port, record, 'Pending generation requires explicit recovery.');
    if (await this.port.read(PREPARED) !== text) throw new AbsSyncError('ABS_BASELINE_STALE', 'Pending generation changed during inspection.');
    return { ...result, mode: record.mode };
  }

  /**
   * Called only after resource validation and workspace readback. commitAbi must
   * save this exact text using the host's prepared-project save port, not recapture
   * the current workspace. It executes inside withLock and must not acquire it again.
   */
  async commit(
    generation: string, assertCurrent: () => void,
    commitAbi: (text: string, expectedByteHash: string | null, storage: AbsSyncStorageAccess) => Promise<void>,
  ): Promise<AbsPublishResult> {
    return this.port.withLock(async storage => {
      const { record, pointer } = await this.readGeneration(storage, generation);
      assertCurrentAbsProjection(record.projection);
      if (await storage.read(PREPARED) !== null) throw new AbsSyncError('ABS_TRANSACTION_PENDING', 'Recover or abandon the prepared transaction first.');
      if (absJson(await this.hashDisk(await this.captureDisk(storage))) !== absJson(record.expected)) {
        return this.result(storage, record, 'CONFLICT', 'Project files changed during preparation.');
      }
      assertCurrent();
      const pointerText = absJson(pointer);
      if (!await storage.replace(PREPARED, null, pointerText)) throw new AbsSyncError('ABS_TRANSACTION_PENDING', 'Another transaction was prepared.');
      try {
        // A host guard must run after every asynchronous boundary before mutation.
        assertCurrent();
        if (absJson(await this.hashDisk(await this.captureDisk(storage))) !== absJson(record.expected)) {
          return this.result(storage, record, 'CONFLICT', 'Project files changed before ABI commit.');
        }
        assertCurrent();
        if (record.mode === 'import') await commitAbi(record.abi!, record.expected.abi, storage);
        assertCurrent();
        return await this.publish(storage, record, pointerText, assertCurrent);
      } catch (error) {
        return this.classifyFailure(storage, record, error);
      }
    });
  }

  /** Restart recovery verifies actual bytes; it never re-applies or re-saves input ABS. */
  async recover(assertCurrent: () => void): Promise<AbsPublishResult | null> {
    return this.port.withLock(async storage => {
      const text = await storage.read(PREPARED);
      if (text === null) return null;
      const pointer = this.parsePointer(text);
      const { record, pointer: actual } = await this.readGeneration(storage, pointer.generation);
      if (absJson(pointer) !== absJson(actual)) throw new AbsSyncError('ABS_BASELINE_CORRUPT', 'Prepared baseline checksum mismatch.');
      try { return await this.publish(storage, record, text, assertCurrent); }
      catch (error) { return this.classifyFailure(storage, record, error); }
    });
  }

  /** Explicit cancellation only before ABI commit; immutable input/baseline stays available. */
  async abandon(generation: string): Promise<void> {
    await this.port.withLock(async storage => {
      const text = await storage.read(PREPARED);
      if (text === null) return;
      const pointer = this.parsePointer(text);
      const { record, pointer: actual } = await this.readGeneration(storage, generation);
      if (absJson(pointer) !== absJson(actual)) throw new AbsSyncError('ABS_BASELINE_CORRUPT', 'Cannot abandon a different or corrupt transaction.');
      if (absJson(await this.hashDisk(await this.captureDisk(storage))) !== absJson(record.expected)) {
        throw new AbsSyncError('ABS_TRANSACTION_CONFLICT', 'Files have changed; retain the recovery record.');
      }
      if (!await storage.replace(PREPARED, await hashAbsText(text), null)) throw new AbsSyncError('ABS_TRANSACTION_CONFLICT', 'Prepared record changed.');
    });
  }

  private async publish(storage: AbsSyncStorageAccess, record: GenerationRecord, pointerText: string, assertCurrent: () => void): Promise<AbsPublishResult> {
    const status = await this.result(storage, record, 'MIRROR_PENDING');
    const abiHash = await hashNullable(await storage.read(ABI));
    if (record.mode === 'import' && !status.abiSaved) {
      return { ...status, status: abiHash === record.expected.abi ? 'NOT_COMMITTED' : 'CONFLICT' };
    }
    if (record.mode === 'export' && abiHash !== record.expected.abi) return { ...status, status: 'CONFLICT' };
    const committed = await storage.read(COMMITTED);
    if (committed !== pointerText && await hashNullable(committed) !== record.previousCommitted) {
      return this.result(storage, record, 'CONFLICT', 'Committed generation changed.');
    }
    const outputMap = absJson(record.projection.map);
    // Precheck BOTH mirrors so an already conflicting map does not cause an ABS write.
    for (const [key, expected, output] of [[ABS, record.expected.abs, record.projection.abs], [MAP, record.expected.map, outputMap]]) {
      const current = await storage.read(key!);
      if (current !== output && await hashNullable(current) !== expected) return this.result(storage, record, 'CONFLICT', `${key} contains a newer edit.`);
    }
    for (const [key, output] of [[ABS, record.projection.abs], [MAP, outputMap]]) {
      const current = await storage.read(key);
      const expected = key === ABS ? record.expected.abs : record.expected.map;
      if (current === output) continue;
      if (await hashNullable(current) !== expected) return this.result(storage, record, 'CONFLICT', `${key} changed during publication.`);
      assertCurrent();
      if (!await storage.replace(key, expected, output)) return this.result(storage, record, 'CONFLICT', `${key} changed during publication.`);
    }
    const complete = await this.result(storage, record, 'COMMITTED');
    if (!complete.absMirrored || !complete.mapPublished || (record.mode === 'import' && !complete.abiSaved)) {
      return { ...complete, status: 'CONFLICT', error: 'Files changed after publication; recovery copies were retained.' };
    }
    const previous = await storage.read(COMMITTED);
    if (previous !== pointerText) {
      if (await hashNullable(previous) !== record.previousCommitted) return this.result(storage, record, 'CONFLICT', 'Committed generation changed.');
      assertCurrent();
      if (!await storage.replace(COMMITTED, record.previousCommitted, pointerText)) return this.result(storage, record, 'CONFLICT', 'Committed generation changed.');
    }
    const preparedHash = await hashAbsText(pointerText);
    assertCurrent();
    if (!await storage.replace(PREPARED, preparedHash, null)) return { ...complete, status: 'MIRROR_PENDING', error: 'Prepared journal cleanup is pending.' };
    return complete;
  }

  private async result(storage: Pick<AbsSyncStorageAccess, 'read'>, record: GenerationRecord, status: AbsPublishResult['status'], error?: string): Promise<AbsPublishResult> {
    const disk = await this.captureDisk(storage);
    return {
      status, generation: record.projection.map.generation,
      abiSaved: record.mode === 'import' && disk.abi === record.abi,
      absMirrored: disk.abs === record.projection.abs, mapPublished: disk.map === absJson(record.projection.map),
      ...(error ? { error } : {}),
    };
  }
  private async classifyFailure(storage: Pick<AbsSyncStorageAccess, 'read'>, record: GenerationRecord, error: unknown): Promise<AbsPublishResult> {
    try {
      const result = await this.result(storage, record, 'MIRROR_PENDING', String(error));
      if (record.mode === 'import' && !result.abiSaved) {
        result.status = await hashNullable(await storage.read(ABI)) === record.expected.abi ? 'NOT_COMMITTED' : 'CONFLICT';
      }
      return result;
    } catch (inspectionError) {
      throw new AbsSyncError('ABS_COMMIT_UNCERTAIN', `Cannot inspect the commit point; retain recovery state and do not roll back: ${String(inspectionError)}`);
    }
  }
  private async hashDisk(disk: AbsDiskSnapshot): Promise<AbsDiskSnapshot> {
    const [abi, abs, map] = await Promise.all([hashNullable(disk.abi), hashNullable(disk.abs), hashNullable(disk.map)]);
    return { abi, abs, map };
  }
  private async readGeneration(storage: Pick<AbsSyncStorageAccess, 'read'>, generation: string, inspection = false): Promise<{ record: GenerationRecord; pointer: GenerationPointer }> {
    const text = await storage.read(absBaselineKey(generation));
    if (text === null) throw new AbsSyncError('ABS_BASELINE_MISSING', 'Immutable ABS/ABI baseline is missing.');
    let record: GenerationRecord;
    try {
      record = JSON.parse(text);
      if (record.schemaVersion !== 1 || record.projection.map.generation !== generation
        || record.projection.map.baselineRef !== absBaselineKey(generation)) throw new Error('Invalid generation record.');
      // Previous snapshots may be inspected/recovered byte-for-byte, but load,
      // stage and new commit entrypoints cannot apply or republish them as new work.
      await validateAbsProjection(record.projection, true);
      if (!['import', 'export'].includes(record.mode)
        || (record.mode === 'import' && (typeof record.abi !== 'string' || typeof record.inputAbs !== 'string'))
        || (record.mode === 'export' && record.abi !== null)
        || !record.expected || Object.keys(record.expected).sort().join(',') !== 'abi,abs,map'
        || ![...Object.values(record.expected), record.previousCommitted].every(hash => hash === null || /^sha256:[a-f0-9]{64}$/.test(hash))) {
        throw new Error('Invalid commit record.');
      }
      if (record.mode === 'import' && await hashAbsText(absJson(JSON.parse(record.abi!))) !== record.projection.map.savedAbiHash) {
        throw new Error('Prepared save shape changed.');
      }
      if (record.inputMap !== undefined && (typeof record.inputMap !== 'string' && record.inputMap !== null
        || await hashNullable(record.inputMap) !== record.expected.map)) throw new Error('Recovery map bytes changed.');
      await this.assertDraftArchive(record);
    } catch (error) { throw new AbsSyncError('ABS_BASELINE_CORRUPT', String(error)); }
    if (!inspection) this.assertScope(record.projection);
    return { record, pointer: { schemaVersion: 1, generation, hash: await hashAbsText(text) } };
  }
  private parsePointer(text: string): GenerationPointer {
    try {
      const pointer = JSON.parse(text) as GenerationPointer;
      absBaselineKey(pointer.generation);
      if (pointer.schemaVersion !== 1 || !/^sha256:[a-f0-9]{64}$/.test(pointer.hash)) throw new Error('Invalid pointer.');
      return pointer;
    } catch (error) { throw new AbsSyncError('ABS_BASELINE_CORRUPT', String(error)); }
  }
  private assertScope(projection: AbsProjection): void {
    if (absJson(projection.map.scope) !== absJson(this.scope)) throw new AbsSyncError('ABS_SCOPE_INVALID', 'Baseline belongs to a different project or page.');
  }
}
