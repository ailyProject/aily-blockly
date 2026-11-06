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
  const journal = new AbsOperationJournal(port, project), operation = await journal.inspect();
  if (!operation) return null;
  if (await inspectAbsBaselineRecovery(port, project)) {
    const repaired = await recoverAbsBaseline(port, project, assertCurrent);
    if (repaired.changed) {
      if (await journal.reanchorSource(operation.id, assertCurrent)) operation.committed = (await journal.inspect())!.committed;
    }
  }
  if (operation.application) await new AbsApplicationJournal(port, project).seal(operation.id, assertCurrent);
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
