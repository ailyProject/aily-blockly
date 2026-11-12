import { AbsBaselineStore, type AbsSyncStoragePort } from './abs-baseline-store';
import { AbsOperationJournal } from './abs-operation-journal';
import { AbsApplicationJournal } from './abs-application-journal';
import { inspectAbsBaselineRecovery, recoverAbsBaseline } from './abs-baseline-recovery';
import { absJson, hashAbsText } from './abs-identity-map';
import { AbsSyncError } from './abs-state';

/** Finish only the transaction whose actual ABI was already committed. An
 * unstarted transaction is abandoned; candidate input is never replayed. */
export async function settleAbsProjectTransaction(port: AbsSyncStoragePort, project: string, assertCurrent: () => void) {
  if (await port.read('prepared.json') === null) return;
  const retained = await new AbsOperationJournal(port, project).inspectLocation();
  if (retained?.operation.nativeSave) {
    const original = retained.operation;
    const ref = await new AbsOperationJournal(port, original.project).findDocumentSave(original.nativeSave!, assertCurrent);
    if (!ref) throw new AbsSyncError('ABS_NATIVE_SAVE_OBSERVATION_INVALID', 'The interrupted native publication has no original admission.');
  }
  const recovery = await new AbsBaselineStore(port, { projectKey: project, pageId: '' }).inspectJournalRecovery();
  assertCurrent();
  if (!recovery) throw new AbsSyncError('ABS_TRANSACTION_CONFLICT', 'The interrupted save conflicts with current files. All versions were retained.');
  if (recovery.scope.projectKey !== project) throw new AbsSyncError('ABS_SCOPE_INVALID', 'An interrupted transaction belongs to another project; its identity was not rebound.');
  const store = new AbsBaselineStore(port, recovery.scope);
  if (recovery.action === 'abandon') await store.abandon(recovery.generation, recovery.token);
  else {
    const result = await store.recover(assertCurrent, recovery);
    if (result?.status !== 'COMMITTED') throw new AbsSyncError('ABS_RESTORE_INCOMPLETE', result?.error ?? 'The saved document transaction has not converged.');
  }
  assertCurrent();
}

/** Cold-start recovery returns the complete *previous view*. It never applies
 * the retained candidate, nor calls the view saved merely because it loaded. */
export async function recoverAbsProjectOperation(port: AbsSyncStoragePort, project: string, assertCurrent: () => void) {
  await settleAbsProjectTransaction(port, project, assertCurrent);
  const journal = new AbsOperationJournal(port, project), retained = await journal.inspectLocation();
  let operation = retained?.operation ?? null;
  if (operation?.nativeSave) {
    const original = await new AbsOperationJournal(port, operation.project).findDocumentSave(operation.nativeSave, assertCurrent);
    if (!original) throw new AbsSyncError('ABS_NATIVE_SAVE_OBSERVATION_INVALID', 'The retained native operation has no original admission.');
  }
  if (retained && operation!.project !== project) {
    const store = new AbsBaselineStore(port, { projectKey: project, pageId: '' });
    const current = await store.inspectCommitted(), disk = await store.captureDisk();
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
      && disk.abs === current.projection.abs && disk.map === absJson(current.projection.map);
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
    assertCurrent();
    await journal.archiveLocation(retained, disk, committed, assertCurrent);
    if (scope.projectKey !== project) await recoverAbsBaseline(port, project, assertCurrent);
    const after = await store.inspectCommitted(), afterDisk = await store.captureDisk(), afterPointer = await port.read('committed.json');
    if (!after || !afterPointer || after.projection.map.scope.projectKey !== project || after.projection.map.scope.pageId !== scope.pageId
      || afterDisk.abi !== disk.abi || await store.readDerivedAbi(after.projection.map.generation) !== disk.abi
      || afterDisk.abs !== after.projection.abs || afterDisk.map !== absJson(after.projection.map)
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
