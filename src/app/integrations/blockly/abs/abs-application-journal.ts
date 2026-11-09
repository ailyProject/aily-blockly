import { AbsBaselineStore, type AbsSyncStoragePort } from './abs-baseline-store';
import { generationEvidence } from './abs-generation-protocol';
import { absJson, hashAbsText } from './abs-identity-map';
import { AbsSyncError, type AbsProjection } from './abs-state';
export type { NativeSaveResultFacts } from './abs-native-save-protocol';
import { NativeSavePublications } from './abs-native-save-publication';
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
    const snapshot = JSON.parse(snapshotText), stagedText = await this.port.read(stageKey(index.operationId));
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
