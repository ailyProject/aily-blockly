import { absMapJson } from './abs-map-json';
import { AbsBaselineStore, type AbsJournalRecovery, type AbsSyncStoragePort } from './abs-baseline-store';
import { AbsOperationJournal, type LocationOperation } from './abs-operation-journal';
import { AbsApplicationJournal } from './abs-application-journal';
import { inspectAbsBaselineRecovery, recoverAbsBaseline } from './abs-baseline-recovery';
import { absJson, hashAbsText } from './abs-identity-map';
import { AbsSyncError } from './abs-state';
import { nativeSaveCapability, readNativeSaveAtAttachment } from './abs-native-save-protocol';
import { NativeSavePublications, readNativeSaveStage } from './abs-native-save-publication';

const movedOperation = (retained: LocationOperation | null, port: AbsSyncStoragePort, project: string) => !!retained
  && (retained.operation.project !== project || !!(retained.operation.attachment && port.attachment
    && absJson(retained.operation.attachment) !== absJson(port.attachment)));
const unprovenCopy = () => new AbsSyncError('ABS_OPERATION_LOCATION_UNPROVEN',
  'The copied transaction and the saved source or original writer could not be verified. All versions were retained.');
const digest = (value: string | null) => value === null ? Promise.resolve(null) : hashAbsText(value);
const matchesLocationAuthor = async (current: NonNullable<Awaited<ReturnType<AbsBaselineStore['readCommittedSnapshot']>>>, abs: string | null) =>
  abs === current.projection.abs || abs !== null && current.workspaceMode === 'project-v1'
  && current.authorSource?.hash === await hashAbsText(abs);

async function originalNativePublication(port: AbsSyncStoragePort, operation: LocationOperation['operation']) {
  if (!operation.nativeSave) return null;
  const { attachment } = nativeSaveCapability(operation);
  const save = await readNativeSaveAtAttachment(port, operation.project, operation.nativeSave, attachment);
  return save?.ref.operationId === operation.id ? readNativeSaveStage(port, save) : null;
}

async function inspectCopiedTransaction(port: AbsSyncStoragePort, project: string) {
  const observed = new Map<string, string | null>();
  const read = async (key: string) => {
    const value = await port.read(key);
    const hash = await digest(value);
    if (observed.has(key) && observed.get(key) !== hash) throw unprovenCopy();
    observed.set(key, hash);
    return value;
  };
  const inspection = { ...port, read };
  const retained = await new AbsOperationJournal(inspection, project).inspectLocation(), source = retained?.operation;
  if (!retained || !source || !movedOperation(retained, port, project) || !port.attachment || !port.retireCopiedLock
    || !port.observeExecutor || !source.committed || (!source.application && !source.nativeSave)) throw unprovenCopy();
  const original = nativeSaveCapability(source);
  if (original.attachment.root !== source.project || (await port.observeExecutor(original.executor)).state !== 'exited')
    throw unprovenCopy();
  const pageId = (source.document as { activePageId?: unknown }).activePageId;
  if (typeof pageId !== 'string' || !pageId) throw unprovenCopy();
  const publication = await originalNativePublication(inspection, source);
  if (source.nativeSave ? !publication : !source.candidate) throw unprovenCopy();
  if (await inspection.read('prepared.json') === null) {
    if (!publication || !await new NativeSavePublications(inspection, source.project).verifyCommittedCopy(publication)) {
      throw unprovenCopy();
    }
    return { phase: 'committed' as const, original, expected: Object.fromEntries(observed) };
  }
  const native = publication?.record?.evidence;
  const scope = { projectKey: source.project, pageId };
  const recovery = await new AbsBaselineStore(inspection, scope).inspectBoundJournalRecovery({
    disk: source.disk, committed: source.committed, candidate: source.candidate?.source, native,
  });
  if (!recovery || source.application && !await new AbsOperationJournal(inspection, source.project)
      .matchesCopiedApplication(retained, recovery.generation, pageId)) throw unprovenCopy();
  return { phase: 'prepared' as const, original, expected: Object.fromEntries(observed), recovery };
}

type CopiedTransaction = Awaited<ReturnType<typeof inspectCopiedTransaction>>;

async function verifyCopiedTransaction(port: AbsSyncStoragePort, { expected }: CopiedTransaction) {
  for (const [key, hash] of Object.entries(expected)) if (await digest(await port.read(key)) !== hash) throw unprovenCopy();
}

async function settlePreparedJournal(port: AbsSyncStoragePort, recovery: AbsJournalRecovery, assertCurrent: () => void) {
  assertCurrent();
  const store = new AbsBaselineStore(port, recovery.scope);
  if (recovery.action === 'abandon') await store.abandon(recovery.generation, recovery.token);
  else {
    const result = await store.recover(assertCurrent, recovery);
    if (result?.status !== 'COMMITTED') throw new AbsSyncError('ABS_RESTORE_INCOMPLETE', result?.error ?? 'The saved document transaction has not converged.');
  }
  assertCurrent();
}

/** Finish only the transaction whose actual ABI was already committed. An
 * unstarted transaction is abandoned; candidate input is never replayed. */
export async function settleAbsProjectTransaction(port: AbsSyncStoragePort, project: string, assertCurrent: () => void) {
  let entered = false;
  const settleUnderLock = (copied?: CopiedTransaction) => port.withLock(async storage => {
    entered = true;
    assertCurrent();
    // An earlier writer or recovery may already have cleared this journal.
    if (await storage.read('prepared.json') === null) return;
    // Reuse the exact journal checks and CAS with the lock already held.
    const locked: AbsSyncStoragePort = { ...port, read: key => storage.read(key), withLock: action => action(storage) };
    const journal = new AbsOperationJournal(locked, project);
    const retained = await journal.inspectLocation();
    const operation = retained?.operation;
    const moved = movedOperation(retained, locked, project);
    if (copied) {
      // Another adopter may have cleared the foreign marker and admitted a local
      // save while this recovery was between locks. Its own admission, stage and
      // source must prove this new prepared generation under the current lock.
      if (!moved && operation?.nativeSave && operation.committed && locked.attachment
        && absJson(operation.attachment) === absJson(locked.attachment)) {
        const native = (await originalNativePublication(locked, operation))?.record?.evidence;
        const scope = native?.binding.scope;
        const local = scope?.projectKey === project && await new AbsBaselineStore(locked, scope).inspectBoundJournalRecovery({
          disk: operation.disk, committed: operation.committed, native,
        });
        if (local) return settlePreparedJournal(locked, local, assertCurrent);
      }
      await verifyCopiedTransaction(locked, copied);
      if (copied.phase !== 'prepared') throw unprovenCopy();
      return settlePreparedJournal(locked, copied.recovery, assertCurrent);
    }
    const recovery = await new AbsBaselineStore(locked, { projectKey: project, pageId: '' }).inspectJournalRecovery();
    // A second interruption may already have a new target-local metadata
    // generation. Recovery still uses its own scope; the old request stays historical.
    if (moved && (!recovery || recovery.scope.projectKey !== project || retained?.operation.project === project)) {
      const proof = await inspectCopiedTransaction(locked, project);
      await verifyCopiedTransaction(locked, proof);
      if (proof.phase !== 'prepared') throw unprovenCopy();
      return settlePreparedJournal(locked, proof.recovery, assertCurrent);
    }
    if (!moved && retained?.operation.nativeSave) {
      const ref = await journal.findDocumentSave(retained.operation.nativeSave, assertCurrent);
      if (!ref) throw new AbsSyncError('ABS_NATIVE_SAVE_OBSERVATION_INVALID', 'The interrupted native publication has no original admission.');
    }
    assertCurrent();
    if (!recovery) throw new AbsSyncError('ABS_TRANSACTION_CONFLICT', 'The interrupted save conflicts with current files. All versions were retained.');
    if (recovery.scope.projectKey !== project) throw new AbsSyncError('ABS_SCOPE_INVALID', 'An interrupted transaction belongs to another project; its identity was not rebound.');
    await settlePreparedJournal(locked, recovery, assertCurrent);
  });
  try { await settleUnderLock(); }
  catch (error) {
    if (entered || (error as { code?: string })?.code !== 'PROJECT_FILE_LOCK_CHANGED' || !port.retireCopiedLock) throw error;
    // A foreign marker must be proven before the normal target lock can be acquired.
    if (!movedOperation(await new AbsOperationJournal(port, project).inspectLocation(), port, project)) {
      return settleUnderLock();
    }
    const copied = await inspectCopiedTransaction(port, project);
    assertCurrent();
    try { await port.retireCopiedLock({ phase: copied.phase, original: copied.original, expected: copied.expected }); }
    catch (retirementError) {
      // A changed journal authorizes an ordinary lock admission only. The target
      // lock and an exact prepared proof still guard every attempted write.
      if ((retirementError as { code?: string })?.code !== 'ABS_TRANSACTION_CONFLICT') throw retirementError;
    }
    await settleUnderLock(copied);
  }
}

/** Cold-start recovery returns the complete *previous view*. It never applies
 * the retained candidate, nor calls the view saved merely because it loaded. */
export async function recoverAbsProjectOperation(port: AbsSyncStoragePort, project: string, assertCurrent: () => void) {
  await settleAbsProjectTransaction(port, project, assertCurrent);
  const journal = new AbsOperationJournal(port, project), retained = await journal.inspectLocation();
  let operation = retained?.operation ?? null;
  const moved = movedOperation(retained, port, project);
  if (operation?.nativeSave && !moved) {
    const original = await new AbsOperationJournal(port, operation.project).findDocumentSave(operation.nativeSave, assertCurrent);
    if (!original) throw new AbsSyncError('ABS_NATIVE_SAVE_OBSERVATION_INVALID', 'The retained native operation has no original admission.');
  }
  if (retained && moved) {
    const store = new AbsBaselineStore(port, { projectKey: project, pageId: '' });
    const current = await store.readCommittedSnapshot(), disk = await store.captureDisk();
    const committed = await port.read('committed.json'), original = operation!;
    const scope = current?.projection.map.scope;
    const page = (original.document as any)?.activePageId;
    let origin: Awaited<ReturnType<AbsBaselineStore['inspectCommittedAncestor']>> = null;
    if (original.committed) {
      let pointer: { generation: string };
      try { pointer = JSON.parse(original.committed); }
      catch { throw new AbsSyncError('ABS_OPERATION_LOCATION_UNPROVEN', 'The retained operation has no valid original committed pointer.'); }
      origin = await store.inspectCommittedAncestor(pointer.generation);
    }
    const unchangedPointer = committed === original.committed;
    const metadataContinuation = !unchangedPointer && original.committed !== null && original.disk.abi !== null
      && await store.isMetadataOnlyContinuation(original.committed, original.disk.abi);
    const savedAbi = current ? await store.readDerivedAbi(current.projection.map.generation) : null;
    const completeMirrors = !!current && disk.abi !== null && disk.abi === savedAbi
      && await matchesLocationAuthor(current, disk.abs) && disk.map === absMapJson(current.projection.map);
    // The same-root restart path retires an obsolete view once a later complete
    // save won. A location change must retain that newer source too; it is never
    // proof that the old unknown application/request succeeded.
    const retireView = !unchangedPointer && !metadataContinuation && completeMirrors;
    if (!current || !committed || !original.committed || original.disk.abi === null
      || !origin || origin.pointerHash !== await hashAbsText(original.committed)
      || origin.projection.map.scope.projectKey !== original.project || origin.projection.map.scope.pageId !== page
      || !scope || ![project, original.project].includes(scope.projectKey) || typeof page !== 'string'
      || !retireView && (disk.abi !== original.disk.abi || savedAbi !== original.disk.abi || page !== scope.pageId
        || unchangedPointer && absJson(disk) !== absJson(original.disk)
        || !unchangedPointer && (!metadataContinuation || !completeMirrors))) {
      throw new AbsSyncError('ABS_OPERATION_LOCATION_UNPROVEN', 'The old operation and current complete saved source do not prove a location-only change. All versions were retained.');
    }
    if (original.executor && (!port.observeExecutor || (await port.observeExecutor(original.executor)).state !== 'exited')) throw unprovenCopy();
    assertCurrent();
    await journal.archiveLocation(retained, disk, committed, assertCurrent);
    if (scope.projectKey !== project) await recoverAbsBaseline(port, project, assertCurrent);
    const after = await store.readCommittedSnapshot(), afterDisk = await store.captureDisk(), afterPointer = await port.read('committed.json');
    if (!after || !afterPointer || after.projection.map.scope.projectKey !== project || after.projection.map.scope.pageId !== scope.pageId
      || afterDisk.abi !== disk.abi || await store.readDerivedAbi(after.projection.map.generation) !== disk.abi
      || !await matchesLocationAuthor(after, afterDisk.abs) || afterDisk.map !== absMapJson(after.projection.map)
      || afterPointer !== committed && !await store.isMetadataOnlyContinuation(committed, disk.abi!)) {
      throw new AbsSyncError('ABS_OPERATION_LOCATION_UNPROVEN', 'Location recovery no longer matches its preserved complete source. No retained view was applied.');
    }
    if (retireView) { await journal.retireLocation(retained, afterDisk, afterPointer, assertCurrent); return null; }
    operation = await journal.relocate(retained, afterDisk, afterPointer, assertCurrent);
  }
  if (!operation) return null;
  // A damaged derived sidecar must not manufacture a metadata successor and
  // stale the original pending request. Preserve the same immutable source.
  if (operation.project === project) {
    try { await new AbsBaselineStore(port, { projectKey: project, pageId: '' }).restoreCommittedMap(assertCurrent); }
    catch (error) { if ((error as { code?: string })?.code !== 'ABS_MAP_REPAIR_UNPROVEN') throw error; }
  }
  if (await inspectAbsBaselineRecovery(port, project)) {
    const repaired = await recoverAbsBaseline(port, project, assertCurrent);
    if (repaired.changed) {
      if (await journal.reanchorSource(operation.id, assertCurrent)) operation.committed = (await journal.inspect())!.committed;
    }
  }
  if (operation.application) await new AbsApplicationJournal(port, project).seal(operation.id, assertCurrent);
  if (operation.nativeSave) {
    const ref = await journal.findDocumentSave(operation.nativeSave, assertCurrent);
    if (ref) await new AbsApplicationJournal(port, project).sealNativeSave(ref, assertCurrent);
  }
  const store = new AbsBaselineStore(port, { projectKey: project, pageId: '' });
  let disk = await store.captureDisk();
  let committed = await port.read('committed.json');
  assertCurrent();
  if (committed !== operation.committed && disk.abi !== null && disk.abi === operation.disk.abi
    && await store.isMetadataOnlyContinuation(operation.committed, disk.abi)) {
    // A previous host may have died after metadata publication and before its
    // post-commit re-anchor. The immutable transaction proves no user save took place.
    await journal.reanchorSource(operation.id, assertCurrent);
    operation.committed = (await journal.inspect())!.committed;
    committed = await port.read('committed.json');
  }
  if (committed !== operation.committed) {
    const current = await store.inspectCommitted();
    if (disk.abi === null || !current || current.projection.map.savedAbiHash !== await hashAbsText(absJson(JSON.parse(disk.abi)))) {
      throw new AbsSyncError('ABS_OPERATION_SOURCE_CHANGED', 'A newer document version must be inspected; the retained view cannot overwrite it.');
    }
    // A completed save/apply whose response or operation cleanup was lost.
    await journal.finish(operation.id, assertCurrent);
    return null;
  }
  if (disk.abi !== operation.disk.abi) {
    if (validDocument(disk.abi) || !validDocument(operation.disk.abi)
      || disk.abs !== operation.disk.abs || disk.map !== operation.disk.map) {
      throw new AbsSyncError('ABS_OPERATION_SOURCE_CHANGED', 'The authoritative document changed after the retained operation. Both versions were kept.');
    }
    // Restore a missing/truncated primary only from this verified operation's
    // exact source, retaining the damaged bytes before the guarded replacement.
    const damaged = disk;
    await port.withLock(async storage => {
      assertCurrent();
      if (absJson(await store.captureDisk(storage)) !== absJson(damaged)
        || await storage.read('committed.json') !== operation.committed) throw new AbsSyncError('ABS_DISK_CONFLICT', 'Project changed before primary recovery.');
      const key = `recoveries/damaged-${crypto.randomUUID()}.json`;
      if (!await storage.replace(key, null, absJson({ version: 1, operationId: operation.id, disk: damaged }))) throw new AbsSyncError('ABS_DISK_CONFLICT', 'Could not preserve the damaged primary.');
      assertCurrent();
      if (!await storage.replace('project.abi', disk.abi === null ? null : await hashAbsText(disk.abi), operation.disk.abi)) {
        throw new AbsSyncError('ABS_DISK_CONFLICT', 'Primary recovery conflicted with another writer.');
      }
    });
    disk = await store.captureDisk();
    if (disk.abi !== operation.disk.abi) throw new AbsSyncError('ABS_COMMIT_UNCERTAIN', 'Recovered primary readback did not match its retained source.');
  }
  assertCurrent();
  return { operationId: operation.id, document: operation.document, committed, candidateApplied: false as const };
}

function validDocument(text: string | null): boolean {
  try { const value = text === null ? null : JSON.parse(text); return !!value && typeof value === 'object' && !Array.isArray(value); }
  catch { return false; }
}
