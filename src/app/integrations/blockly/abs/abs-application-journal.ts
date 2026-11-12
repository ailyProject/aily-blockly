import { AbsBaselineStore, type AbsSyncStoragePort } from './abs-baseline-store';
import { assertGenerationValidation, generationEvidence } from './abs-generation-protocol';
import { absJson, hashAbsText } from './abs-identity-map';
import { AbsSyncError, type AbsProjection } from './abs-state';
export type { NativeSaveResultFacts } from './abs-native-save-protocol';
import { NativeSavePublications } from './abs-native-save-publication';
import { nativeSaveCapability } from './abs-native-save-protocol';
import type { NativeSaveIdentity, NativeSaveOperationRef, NativeSaveStageInput, NativeSaveResultFacts } from './abs-native-save-protocol';
import type { AbsSyncStorageAccess } from './abs-baseline-store';
import type { AbsOperationSnapshot } from './abs-operation-journal';

const stageKey = (id: string) => `recoveries/application-${id}.json`;
const proofKey = (id: string) => `recoveries/application-commit-${id}.json`;
const resultKey = (id: string) => `recoveries/application-result-${id}.json`;
const fail = (message: string) => new AbsSyncError('ABS_APPLY_OBSERVATION_INVALID', message);

/** The application section of the existing operation journal. Staging is not
 * success: only an exact committed-pointer + complete-file readback seals it. */
export class AbsApplicationJournal {
  constructor(private readonly port: AbsSyncStoragePort, private readonly project: string) {}
  private native() { return new NativeSavePublications(this.port, this.project); }
  stageNativeSave(input: NativeSaveStageInput, guard: () => void) { return this.native().stageNativeSave(input, guard); }
  sealNativeSave(ref: NativeSaveOperationRef, guard: () => void) { return this.native().sealNativeSave(ref, guard); }
  sealNativeUnchangedLocked(ref: NativeSaveOperationRef, access: AbsSyncStorageAccess, original: AbsOperationSnapshot,
    committedPointer: string | null, guard: () => void) {
    return this.native().sealNativeUnchangedLocked(ref, access, original, committedPointer, guard);
  }
  completeNativeSave(ref: NativeSaveOperationRef, facts: NativeSaveResultFacts, guard: () => void) { return this.native().completeNativeSave(ref, facts, guard); }
  observeNativeSave(request: NativeSaveIdentity, guard: () => void) { return this.native().observeNativeSave(request, guard); }

  async stage(operationId: string, validation: any, outcome: any, assertCurrent: () => void) {
    const record = absJson({ version: 1, project: this.project, operationId, validation, outcome });
    await this.port.withLock(async storage => {
      assertCurrent();
      if (!await storage.replace(stageKey(operationId), null, record)) throw fail('The staged application result already exists.');
    });
  }

  async complete(operationId: string, outcome: any, assertCurrent: () => void) {
    const stagedText = await this.port.read(stageKey(operationId));
    if (stagedText === null) throw fail('The original staged application is missing.');
    const staged = JSON.parse(stagedText);
    if (absJson(outcome.evidence) !== absJson(staged.outcome.evidence) || outcome.publication?.status !== 'COMMITTED'
      || outcome.requiresReload !== false || absJson(outcome.historyBase ?? null) !== absJson(staged.outcome.historyBase ?? null)) throw fail('The completed result differs from its committed application.');
    const text = absJson({ version: 1, project: this.project, operationId, stageHash: await hashAbsText(stagedText), outcome });
    await this.port.withLock(async storage => {
      assertCurrent();
      if (!await storage.replace(resultKey(operationId), null, text)) throw fail('The original application result already exists.');
    });
  }

  /** Seal only this live original writer's fully read-back rollback. A legacy
   * restored pointer alone is deliberately not a known application outcome. */
  async completeRolledBack(operationId: string, failure: { code?: string; message?: string; diagnostic?: unknown },
    assertCurrent: () => void, readback: (document: unknown) => Promise<void>): Promise<void> {
    const context = nativeSaveCapability(this.port);
    await this.port.withLock(async storage => {
      assertCurrent();
      const pointerText = await storage.read('operation.json');
      const pointer = pointerText === null ? null : JSON.parse(pointerText);
      const snapshotText = await storage.read(`recoveries/operation-${operationId}.json`);
      if (pointer?.version !== 1 || pointer.id !== operationId || pointer.state !== 'restored' || snapshotText === null
        || await hashAbsText(snapshotText) !== pointer.hash) throw fail('The original rollback is not completely restored.');
      const snapshot = JSON.parse(snapshotText) as AbsOperationSnapshot;
      this.assertRollbackSnapshot(snapshot, operationId);
      const validation = snapshot.application!.validation as any;
      if (await hashAbsText(snapshot.candidate!.source) !== validation.candidate.hash
        || new TextEncoder().encode(snapshot.candidate!.source).byteLength !== validation.candidate.bytes) throw fail('The original rollback source changed.');
      if (absJson(snapshot.attachment) !== absJson(context.attachment) || absJson(snapshot.executor) !== absJson(context.executor)) {
        throw fail('Only the original physical application writer can seal its rollback.');
      }
      const requestId = snapshot.application!.requestId;
      const indexText = await storage.read(`recoveries/request-${(await hashAbsText(requestId)).slice(7)}.json`);
      const index = indexText === null ? null : JSON.parse(indexText);
      if (index?.version !== 1 || index.project !== this.project || index.operationId !== operationId
        || index.requestId !== requestId || index.snapshotHash !== pointer.hash) throw fail('The original application request changed.');
      const unchanged = async () => await storage.read('operation.json') === pointerText
        && await storage.read(`recoveries/operation-${operationId}.json`) === snapshotText
        && await storage.read('committed.json') === snapshot.committed
        && await storage.read('prepared.json') === null
        && await storage.read(stageKey(operationId)) === null
        && await storage.read(proofKey(operationId)) === null
        && absJson(await this.disk(storage)) === absJson(snapshot.disk);
      if (!await unchanged()) throw fail('The application published or changed before rollback verification.');
      await readback(JSON.parse(absJson(snapshot.document)));
      assertCurrent();
      if (!await unchanged()) throw fail('The original rollback changed during complete Native readback.');
      const digest = (value: string | null) => value === null ? Promise.resolve(null) : hashAbsText(value);
      const outcome = { ok: false, operation: 'abs_apply', project: this.project,
        code: failure.code || 'ABS_APPLICATION_FAILED', message: failure.message || 'The original application was rolled back.',
        ...(failure.diagnostic === undefined ? {} : { diagnostic: JSON.parse(absJson(failure.diagnostic)) }),
        publication: { status: 'NOT_COMMITTED' }, application: { status: 'ROLLED_BACK', requestId },
        requiresReload: false, candidateApplied: false };
      const record = absJson({ version: 1, kind: 'rolled-back', project: this.project, operationId,
        snapshotHash: pointer.hash, operationPointer: pointerText, documentHash: await hashAbsText(absJson(snapshot.document)),
        saved: { abiHash: await digest(snapshot.disk.abi), absHash: await digest(snapshot.disk.abs),
          mapHash: await digest(snapshot.disk.map), committedHash: await digest(snapshot.committed) }, outcome });
      assertCurrent();
      const previous = await storage.read(resultKey(operationId));
      if (previous === record) return;
      if (previous !== null || !await storage.replace(resultKey(operationId), null, record)) throw fail('The original application already has another terminal result.');
    });
  }

  private assertRollbackSnapshot(snapshot: AbsOperationSnapshot, operationId: string): void {
    if (snapshot.version !== 1 || snapshot.kind !== 'abs-apply' || snapshot.id !== operationId || snapshot.project !== this.project
      || !snapshot.application || !snapshot.candidate || !snapshot.document || typeof snapshot.document !== 'object') {
      throw fail('The rollback does not identify an original complete application.');
    }
    assertGenerationValidation(snapshot.application.validation);
    const validation = snapshot.application.validation as any;
    if (validation.requestId !== snapshot.application.requestId || !validation.workingCandidate
      || validation.candidate.hash !== snapshot.candidate.hash || validation.base.generation !== snapshot.candidate.generation) {
      throw fail('The rollback candidate or original validation changed.');
    }
    nativeSaveCapability({ attachment: snapshot.attachment, executor: snapshot.executor });
  }

  private async disk(storage: Pick<AbsSyncStorageAccess, 'read'>) {
    const [abi, abs, map] = await Promise.all(['project.abi', 'project.abs', 'project.abs.map.json'].map(key => storage.read(key)));
    return { abi, abs, map };
  }

  /** Also used on restart in the commit->reply gap. This never writes ABI,
   * applies a candidate, or infers history from an unrelated current project. */
  async seal(operationId: string, assertCurrent: () => void): Promise<boolean> {
    if (await this.port.read(proofKey(operationId)) !== null) return true;
    const staged = await this.port.read(stageKey(operationId));
    if (staged === null) return false;
    const record = JSON.parse(staged), binding = record.outcome?.evidence?.binding;
    if (record.version !== 1 || record.project !== this.project || record.operationId !== operationId || !binding
      || binding.scope.projectKey !== this.project) throw fail('The staged application scope is invalid.');
    const store = new AbsBaselineStore(this.port, binding.scope), committed = await this.ancestor(store, binding.generation);
    if (!committed) return false;
    const currentPointer = await this.port.read('committed.json');
    const disk = await store.captureDisk();
    const abi = await store.readDerivedAbi(binding.generation);
    if (absJson(await generationEvidence(committed.projection, abi)) !== absJson(record.outcome.evidence)) return false;
    if (currentPointer !== null && await hashAbsText(currentPointer) === committed.pointerHash
      && (disk.abi !== abi || disk.abs !== committed.projection.abs || disk.map !== absJson(committed.projection.map))) return false;
    await this.port.withLock(async storage => {
      assertCurrent();
      if (absJson(await store.captureDisk(storage)) !== absJson(disk)
        || await storage.read('committed.json') !== currentPointer) throw fail('The application commit changed during observation.');
      const proof = absJson({ version: 1, project: this.project, operationId, stageHash: await hashAbsText(staged), committedHash: committed.pointerHash });
      const previous = await storage.read(proofKey(operationId));
      if (previous !== proof && (previous !== null || !await storage.replace(proofKey(operationId), null, proof))) throw fail('Conflicting application commit proof.');
    });
    return true;
  }

  async observe(requestId: string, assertCurrent: () => void): Promise<{ projection?: AbsProjection; result: any }> {
    const indexText = await this.port.read(`recoveries/request-${(await hashAbsText(requestId)).slice(7)}.json`);
    const unknown = (code: string) => ({ result: { ok: false, operation: 'abs_apply', project: this.project, code,
      publication: { status: 'UNKNOWN' }, applicationObservation: { version: 1, requestId, current: false } } });
    if (indexText === null) return unknown('ABS_APPLY_OBSERVATION_UNKNOWN');
    const index = JSON.parse(indexText);
    if (index.version !== 1 || index.project !== this.project || index.requestId !== requestId || !/^[a-f0-9-]{36}$/.test(index.operationId)) throw fail('Invalid original application request index.');
    const snapshotText = await this.port.read(`recoveries/operation-${index.operationId}.json`);
    if (snapshotText === null || await hashAbsText(snapshotText) !== index.snapshotHash) throw fail('Original operation snapshot changed.');
    const snapshot = JSON.parse(snapshotText), recordedFinalText = await this.port.read(resultKey(index.operationId));
    if (recordedFinalText !== null && JSON.parse(recordedFinalText).kind === 'rolled-back') {
      this.assertRollbackSnapshot(snapshot, index.operationId);
      const context = nativeSaveCapability(this.port), final = JSON.parse(recordedFinalText), pointer = JSON.parse(final.operationPointer);
      const digest = (value: string | null) => value === null ? Promise.resolve(null) : hashAbsText(value);
      const saved = { abiHash: await digest(snapshot.disk.abi), absHash: await digest(snapshot.disk.abs),
        mapHash: await digest(snapshot.disk.map), committedHash: await digest(snapshot.committed) };
      if (snapshot.application.requestId !== requestId || absJson(snapshot.attachment) !== absJson(context.attachment)
        || await hashAbsText(snapshot.candidate.source) !== snapshot.application.validation.candidate.hash
        || new TextEncoder().encode(snapshot.candidate.source).byteLength !== snapshot.application.validation.candidate.bytes
        || final.version !== 1 || final.project !== this.project || final.operationId !== index.operationId
        || final.snapshotHash !== index.snapshotHash || pointer.version !== 1 || pointer.id !== index.operationId
        || pointer.hash !== index.snapshotHash || pointer.state !== 'restored'
        || final.documentHash !== await hashAbsText(absJson(snapshot.document)) || absJson(final.saved) !== absJson(saved)
        || final.outcome?.ok !== false || final.outcome?.operation !== 'abs_apply' || final.outcome?.project !== this.project
        || final.outcome?.publication?.status !== 'NOT_COMMITTED' || final.outcome?.application?.status !== 'ROLLED_BACK'
        || final.outcome?.application?.requestId !== requestId || final.outcome?.requiresReload !== false
        || final.outcome?.candidateApplied !== false || typeof final.outcome?.code !== 'string') throw fail('The original rollback terminal result changed.');
      assertCurrent();
      return { result: { ...final.outcome, receipt: { ...snapshot.application.validation, rollback: { version: 1,
        operationId: index.operationId, snapshotHash: index.snapshotHash, recordHash: await hashAbsText(recordedFinalText),
        documentHash: final.documentHash, operationPointerHash: await hashAbsText(final.operationPointer), saved,
        attachment: snapshot.attachment, executor: snapshot.executor } },
        applicationObservation: { version: 1, requestId, observationOnly: true, resultKnown: true, current: false } } };
    }
    const stagedText = await this.port.read(stageKey(index.operationId));
    if (stagedText === null) return unknown('ABS_APPLY_OBSERVATION_UNKNOWN');
    const staged = JSON.parse(stagedText), validation = staged.validation, binding = staged.outcome?.evidence?.binding;
    if (snapshot.application?.requestId !== requestId || absJson(snapshot.application.validation) !== absJson(validation)
      || validation.requestId !== requestId || validation.candidate.hash !== snapshot.candidate?.hash
      || await hashAbsText(snapshot.candidate.source) !== validation.candidate.hash || validation.base.generation !== snapshot.candidate.generation
      || !binding || staged.project !== this.project || staged.operationId !== index.operationId) throw fail('Original candidate or intent binding differs from the staged result.');
    const proofText = await this.port.read(proofKey(index.operationId));
    let proof: any;
    if (proofText !== null) proof = JSON.parse(proofText);
    else {
      // Read-only observation in the acknowledgement gap. Restart recovery
      // seals this evidence durably before admitting another document writer.
      const currentStore = new AbsBaselineStore(this.port, binding.scope), committed = await this.ancestor(currentStore, binding.generation);
      if (!committed) return unknown('ABS_APPLY_OBSERVATION_PENDING');
      const committedPointer = await this.port.read('committed.json');
      const currentDisk = await currentStore.captureDisk();
      const historicalAbi = await currentStore.readDerivedAbi(binding.generation);
      if (absJson(await generationEvidence(committed.projection, historicalAbi)) !== absJson(staged.outcome.evidence)
        || await this.port.read('committed.json') !== committedPointer) return unknown('ABS_APPLY_OBSERVATION_PENDING');
      if (committedPointer !== null && await hashAbsText(committedPointer) === committed.pointerHash
        && (currentDisk.abi !== historicalAbi || currentDisk.abs !== committed.projection.abs || currentDisk.map !== absJson(committed.projection.map))) return unknown('ABS_APPLY_OBSERVATION_PENDING');
      proof = { project: this.project, operationId: index.operationId, stageHash: await hashAbsText(stagedText), committedHash: committed.pointerHash };
    }
    if (proof.stageHash !== await hashAbsText(stagedText) || proof.project !== this.project || proof.operationId !== index.operationId) throw fail('Original committed result proof changed.');
    const store = new AbsBaselineStore(this.port, binding.scope), projection = await store.load(binding.generation);
    const abi = await store.readDerivedAbi(binding.generation);
    if (absJson(await generationEvidence(projection, abi)) !== absJson(staged.outcome.evidence)) throw fail('Original saved document readback differs from its result.');
    const disk = await store.captureDisk(), pointer = await this.port.read('committed.json');
    const current = pointer !== null && await hashAbsText(pointer) === proof.committedHash && disk.abi === abi
      && disk.abs === projection.abs && disk.map === absJson(projection.map) && await this.port.read('prepared.json') === null;
    assertCurrent();
    let outcome = staged.outcome;
    const finalText = await this.port.read(resultKey(index.operationId));
    if (finalText !== null) {
      const final = JSON.parse(finalText);
      if (final.version !== 1 || final.project !== this.project || final.operationId !== index.operationId
        || final.stageHash !== proof.stageHash || absJson(final.outcome?.evidence) !== absJson(outcome.evidence)
        || final.outcome?.publication?.status !== 'COMMITTED' || final.outcome?.requiresReload !== false
        || absJson(final.outcome?.historyBase ?? null) !== absJson(outcome.historyBase ?? null)) throw fail('The original final result differs from the committed source.');
      outcome = final.outcome;
    }
    return { projection, result: { ...outcome, ok: true, operation: 'abs_apply', project: this.project,
      receipt: { ...validation, output: outcome.evidence, appliedRevision: outcome.appliedRevision,
        ...(outcome.historyBase ? { historyBase: { hash: outcome.historyBase.hash, inputAbsHash: outcome.historyBase.inputAbsHash } } : {}),
        validation: { ok: true, scope: 'complete-generation' } },
      applicationObservation: { version: 1, requestId, current } } };
  }

  private async ancestor(store: AbsBaselineStore, generation: string) {
    try { return await store.inspectCommittedAncestor(generation); }
    catch (error) {
      if (['ABS_BASELINE_MISSING', 'ABS_BASELINE_CORRUPT'].includes((error as any)?.code)) return null;
      throw error;
    }
  }
}
