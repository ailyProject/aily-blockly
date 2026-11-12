import { AbsBaselineStore, absBaselineKey, type AbsSyncStorageAccess, type AbsSyncStoragePort } from './abs-baseline-store';
import { generationEvidence } from './abs-generation-protocol';
import { absJson, hashAbsText } from './abs-identity-map';
import type { AbsOperationSnapshot } from './abs-operation-journal';
import { assertNativeSaveRef, nativeSaveCapability, nativeSaveError, readNativeSaveRequest, blockStatePublicationIdentity,
  type NativeSaveIdentity, type NativeSaveOperationRef, type NativeSaveStageInput,
  type NativeSaveResultFacts, type NativeSaveObservation } from './abs-native-save-protocol';

const stageKey = (id: string) => `recoveries/application-${id}.json`;
const proofKey = (id: string) => `recoveries/application-commit-${id}.json`;
const resultKey = (id: string) => `recoveries/application-result-${id}.json`;
const hash = (text: string | null) => text === null ? Promise.resolve(null) : hashAbsText(text);
const json = (text: string) => { try { return JSON.parse(text); } catch { throw nativeSaveError('Invalid native save record encoding.'); } };
const same = (a: unknown, b: unknown) => absJson(a) === absJson(b);
const projectKey = (value: string) => {
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//') ? normalized.toLowerCase() : normalized;
};

/** Native-save section of the existing operation/application journal. There is
 * no second store, mutable current-result pointer, or projection on observation. */
export class NativeSavePublications {
  constructor(private readonly port: AbsSyncStoragePort, private readonly project: string) {}
  private reader(access: Pick<AbsSyncStorageAccess, 'read'> = this.port) {
    return { ...nativeSaveCapability(this.port), read: (key: string) => access.read(key) };
  }
  private async original(ref: NativeSaveOperationRef, access: Pick<AbsSyncStorageAccess, 'read'> = this.port) {
    const found = await readNativeSaveRequest(this.reader(access), this.project, ref.request);
    if (!found) throw nativeSaveError('Original native admission is missing.');
    assertNativeSaveRef(found.ref, ref); return found;
  }
  private async stage(ref: NativeSaveOperationRef, access: Pick<AbsSyncStorageAccess, 'read'> = this.port) {
    const original = await this.original(ref, access), text = await access.read(stageKey(ref.operationId));
    if (text === null) return { original, text, record: null };
    const record = json(text);
    await this.validateStage(record, original, ref);
    return { original, text, record };
  }
  private async validateStage(record: any, original: any, ref: NativeSaveOperationRef) {
    const binding = record.evidence?.binding;
    if (record.version !== 2 || record.kind !== 'native-save' || record.project !== this.project
      || record.snapshotHash !== original.snapshotHash || !same(record.ref, ref) || !binding
      || typeof binding.scope?.projectKey !== 'string' || projectKey(binding.scope.projectKey) !== projectKey(this.project) || typeof binding.scope.pageId !== 'string'
      || typeof binding.generation !== 'string' || !/^[A-Za-z0-9_-]{1,96}$/.test(binding.generation)
      || ![binding.abiHash, binding.absHash, binding.mapHash].every(value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value))
      || !Number.isSafeInteger(record.evidence.absBytes) || record.evidence.absBytes < 0
      || record.inputAbiHash !== await hash(original.snapshot.disk.abi)) throw nativeSaveError('Native stage does not bind its exact original input/output.');
    if (ref.request.operation !== 'history_restore' && typeof (original.snapshot.document as any)?.activePageId === 'string'
      && (original.snapshot.document as any).activePageId !== binding.scope.pageId) throw nativeSaveError('Native save changed the original target page.');
    if (ref.request.operation === 'blocks_set_state') {
      const state = record.blockState;
      if (state?.version !== 2 || state.action !== 'update' || !Array.isArray(state.changes)
        || !Array.isArray(state.beforeStates) || !Array.isArray(state.states)
        || state.beforeStates.length !== state.changes.length || state.states.length !== state.changes.length
        || state.inputAbiHash !== record.inputAbiHash || !same(state.output, record.evidence)) {
        throw nativeSaveError('The state publication lacks its original native readback.');
      }
      const identity = await blockStatePublicationIdentity(this.project, { version: 2, requestId: state.requestId, action: 'update',
        ...(state.expectedCanvas ? { expectedCanvas: state.expectedCanvas } : { expectedGeneration: state.expectedGeneration }), changes: state.changes });
      if (!same(identity, ref.request) || state.changes.some((change, index) => change.blockId !== state.beforeStates[index]?.blockId
        || change.blockId !== state.states[index]?.blockId)) throw nativeSaveError('The original state request differs from its native stage.');
    } else if (record.blockState !== undefined) throw nativeSaveError('A different native operation cannot claim state-update readback.');
  }
  private async immutable(access: AbsSyncStorageAccess, key: string, text: string) {
    const previous = await access.read(key);
    if (previous !== text && (previous !== null || !await access.replace(key, null, text)))
      throw nativeSaveError('The exact immutable native publication record already differs.');
  }
  async stageNativeSave(input: NativeSaveStageInput, guard: () => void): Promise<void> {
    input = JSON.parse(absJson(input));
    await this.port.withLock(async access => {
      const original = await this.original(input.ref, access);
      if (await access.read(resultKey(input.ref.operationId)) !== null) throw nativeSaveError('This native request already has a terminal result.');
      const record = { version: 2, kind: 'native-save', project: this.project, snapshotHash: original.snapshotHash, ...input };
      await this.validateStage(record, original, input.ref);
      guard();
      await this.immutable(access, stageKey(input.ref.operationId), absJson(record));
      // Reuse the same strict reader used by every subsequent seal/observation.
      await this.stage(input.ref, access); guard();
    });
  }
  private proof(ref: NativeSaveOperationRef, staged: any, committedHash: string, mode: 'changed' | 'unchanged') {
    return { version: 2, kind: 'native-save-source', project: this.project, ref,
      snapshotHash: staged.original.snapshotHash, stageHash: '', committedHash, mode };
  }
  private validateProof(proof: any, ref: NativeSaveOperationRef, staged: any, stageHash: string) {
    if (proof.version !== 2 || proof.kind !== 'native-save-source' || proof.project !== this.project
      || !same(proof.ref, ref) || proof.snapshotHash !== staged.original.snapshotHash || proof.stageHash !== stageHash
      || !['changed', 'unchanged'].includes(proof.mode) || !/^sha256:[a-f0-9]{64}$/.test(proof.committedHash))
      throw nativeSaveError('The original native source proof differs from its request/attachment/stage.');
  }
  private async output(staged: any, access: Pick<AbsSyncStorageAccess, 'read'> = this.port) {
    const binding = staged.record.evidence.binding;
    const store = new AbsBaselineStore({ read: key => access.read(key), withLock: () => { throw nativeSaveError('Nested publication lock is not permitted.'); } }, binding.scope);
    const ancestor = await store.inspectCommittedAncestor(binding.generation);
    if (!ancestor) return null;
    const abi = ancestor.abi;
    if (abi === null || !same(await generationEvidence(ancestor.projection, abi), staged.record.evidence))
      throw nativeSaveError('The exact native output generation/evidence differs.');
    return { store, ancestor, abi };
  }
  private async changedProof(staged: any, access: Pick<AbsSyncStorageAccess, 'read'> = this.port) {
    const output = await this.output(staged, access);
    if (!output) return null;
    // A pre-existing generation cannot prove that this request ran. The newly
    // committed record must have been prepared against this original head/files.
    const generation = staged.record.evidence.binding.generation;
    const text = await access.read(absBaselineKey(generation));
    if (text === null) return null;
    const record = json(text), expected = Object.fromEntries(await Promise.all(Object.entries(staged.original.snapshot.disk)
      .map(async ([key, value]) => [key, await hash(value as string | null)])));
    const pointer = absJson({ schemaVersion: 1, generation, hash: await hashAbsText(text) });
    if (await hashAbsText(pointer) !== output.ancestor.pointerHash
      || record.previousCommitted !== await hash(staged.original.snapshot.committed) || !same(record.expected, expected)) return null;
    return { ...output, value: { ...this.proof(staged.original.ref, staged, output.ancestor.pointerHash, 'changed'),
      stageHash: await hashAbsText(staged.text) } };
  }
  async sealNativeSave(ref: NativeSaveOperationRef, guard: () => void): Promise<boolean> {
    const staged = await this.stage(ref);
    if (!staged.record) return false;
    const resolved = await this.changedProof(staged);
    if (!resolved) return false;
    const pointer = await this.port.read('committed.json'), disk = await resolved.store.captureDisk();
    if (await hash(pointer) === resolved.ancestor.pointerHash && (disk.abi !== resolved.abi
      || disk.abs !== resolved.ancestor.projection.abs || disk.map !== absJson(resolved.ancestor.projection.map))) return false;
    await this.port.withLock(async access => {
      await this.original(ref, access);
      if (await access.read(stageKey(ref.operationId)) !== staged.text || await access.read('committed.json') !== pointer
        || !same(await resolved.store.captureDisk(access), disk)) throw nativeSaveError('Native commit changed during sealing.');
      const finalText = await access.read(resultKey(ref.operationId));
      if (finalText && json(finalText).terminal === 'not-committed') throw nativeSaveError('A failed native request cannot later publish.');
      guard(); await this.immutable(access, proofKey(ref.operationId), absJson(resolved.value)); guard();
    });
    return true;
  }
  async sealNativeUnchangedLocked(ref: NativeSaveOperationRef, access: AbsSyncStorageAccess,
    original: AbsOperationSnapshot, committedPointer: string | null, guard: () => void): Promise<void> {
    const staged = await this.stage(ref, access);
    if (!staged.record || !same(staged.original.snapshot, original) || original.committed !== committedPointer
      || await access.read('committed.json') !== committedPointer || await access.read('prepared.json') !== null)
      throw nativeSaveError('Unchanged save does not own its original exact source.');
    const output = await this.output(staged, access);
    if (!output || await hash(committedPointer) !== output.ancestor.pointerHash
      || !same(await output.store.captureDisk(access), original.disk) || output.abi !== original.disk.abi
      || output.ancestor.projection.abs !== original.disk.abs || absJson(output.ancestor.projection.map) !== original.disk.map)
      throw nativeSaveError('Unchanged save output differs from the retained original source.');
    guard(); await this.immutable(access, proofKey(ref.operationId), absJson({
      ...this.proof(ref, staged, output.ancestor.pointerHash, 'unchanged'), stageHash: await hashAbsText(staged.text),
    })); guard();
  }
  private validateFacts(facts: NativeSaveResultFacts) {
    if (facts.publication?.status === 'NOT_COMMITTED') {
      if (facts.projectSaved !== false || facts.generatedCodePublished !== false || facts.partial !== false
        || facts.requiresReload !== false || typeof facts.code !== 'string' || !facts.code || facts.evidence !== undefined)
        throw nativeSaveError('Invalid native NOT_COMMITTED terminal facts.');
    } else if (facts.publication?.status !== 'COMMITTED' || facts.projectSaved !== true || facts.requiresReload !== false
      || typeof facts.generatedCodePublished !== 'boolean' || typeof facts.partial !== 'boolean'
      || typeof facts.publication.abiSaved !== 'boolean' || !facts.publication.absMirrored || !facts.publication.mapPublished || !facts.evidence
      || facts.publication.generation !== facts.evidence.binding.generation) throw nativeSaveError('Invalid native committed terminal facts.');
  }
  async completeNativeSave(ref: NativeSaveOperationRef, facts: NativeSaveResultFacts, guard: () => void): Promise<void> {
    facts = JSON.parse(absJson(facts)); this.validateFacts(facts);
    await this.port.withLock(async access => {
      const original = await this.original(ref, access);
      const committed = facts.publication.status === 'COMMITTED';
      const staged = await this.stage(ref, access);
      if (facts.publication.status === 'COMMITTED') {
        const proofText = await access.read(proofKey(ref.operationId));
        if (!staged.record || proofText === null || !same(staged.record.evidence, facts.evidence)) throw nativeSaveError('Native completion has no original source proof.');
        const proof = json(proofText);
        this.validateProof(proof, ref, staged, await hashAbsText(staged.text!));
        if (proof.mode === 'changed' && !facts.publication.abiSaved) throw nativeSaveError('A changed save lacks its ABI commit fact.');
        if (!same(facts.blockState ?? null, staged.record.blockState ?? null)) throw nativeSaveError('Final state readback differs from the sealed native stage.');
      } else {
        const disk = { abi: await access.read('project.abi'), abs: await access.read('project.abs'), map: await access.read('project.abs.map.json') };
        if (await access.read('prepared.json') !== null || !same(disk, original.snapshot.disk)
          || await access.read('committed.json') !== original.snapshot.committed || await access.read(proofKey(ref.operationId)) !== null)
          throw nativeSaveError('An uncertain or saved native operation cannot be labelled NOT_COMMITTED.');
      }
      const text = absJson({ version: 2, kind: 'native-save-result', project: this.project, ref,
        snapshotHash: original.snapshotHash, stageHash: staged.text === null ? null : await hashAbsText(staged.text),
        terminal: committed ? 'committed' : 'not-committed', result: facts });
      guard(); await this.immutable(access, resultKey(ref.operationId), text); guard();
    });
  }
  async observeNativeSave(request: NativeSaveIdentity, guard: () => void): Promise<NativeSaveObservation> {
    guard(); const original = await readNativeSaveRequest(this.reader(), this.project, request);
    if (!original) return { state: 'not-found', request };
    const ref = original.ref, staged = await this.stage(ref), finalText = await this.port.read(resultKey(ref.operationId));
    let final: any;
    if (finalText !== null) {
      final = json(finalText);
      if (final.version !== 2 || final.kind !== 'native-save-result' || final.project !== this.project || !same(final.ref, ref)
        || final.snapshotHash !== original.snapshotHash || final.stageHash !== (staged.text === null ? null : await hashAbsText(staged.text)))
        throw nativeSaveError('The original native final result changed.');
      this.validateFacts(final.result);
      if (final.terminal === 'not-committed' && final.result.publication.status === 'NOT_COMMITTED') {
        guard(); return { state: 'completed', ref, result: final.result, current: false };
      }
      if (final.terminal !== 'committed' || final.result.publication.status !== 'COMMITTED') throw nativeSaveError('Native terminal discriminant differs.');
    }
    const pending = (): NativeSaveObservation => ({ state: staged.record ? 'unknown' : 'pending', ref,
      code: 'ABS_NATIVE_SAVE_OBSERVATION_PENDING', publication: { status: 'UNKNOWN' } });
    if (!staged.record) return pending();
    const proofText = await this.port.read(proofKey(ref.operationId));
    const output = await this.output(staged);
    if (!output) return pending();
    let proof: any;
    if (proofText !== null) {
      proof = json(proofText); this.validateProof(proof, ref, staged, await hashAbsText(staged.text));
      if (proof.committedHash !== output.ancestor.pointerHash) throw nativeSaveError('Native proof points at a different saved output.');
    } else {
      proof = (await this.changedProof(staged))?.value;
      if (!proof) return pending(); // Unchanged saves need their original under-lock seal.
    }
    const pointer = await this.port.read('committed.json'), disk = await output.store.captureDisk();
    if (await hash(pointer) === proof.committedHash && (disk.abi !== output.abi || disk.abs !== output.ancestor.projection.abs
      || disk.map !== absJson(output.ancestor.projection.map))) return pending();
    if (await this.port.read('committed.json') !== pointer) return pending();
    const current = await hash(pointer) === proof.committedHash && await this.port.read('prepared.json') === null;
    const result: NativeSaveResultFacts = final?.result ?? { projectSaved: true, generatedCodePublished: false, partial: true,
      publication: { status: 'COMMITTED', generation: staged.record.evidence.binding.generation, abiSaved: proof.mode === 'changed', absMirrored: true, mapPublished: true },
      requiresReload: false, evidence: staged.record.evidence,
      warnings: ['The original source commit is verified; its post-save outputs were not observed.'],
      derivedOutputs: { published: false, code: 'PROJECT_DERIVED_OUTPUT_PENDING' } };
    if (staged.record.blockState) {
      if (final && !same(result.blockState, staged.record.blockState)) throw nativeSaveError('Observed state readback differs from its original native stage.');
      if (!final) result.blockState = staged.record.blockState;
    }
    if (final && !same(result.evidence, staged.record.evidence)) throw nativeSaveError('Final native evidence differs from its original stage.');
    guard(); return { state: 'completed', ref, result, current };
  }
}
