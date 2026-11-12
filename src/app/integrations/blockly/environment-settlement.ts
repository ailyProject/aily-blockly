import { openAbsHostStorage } from './abs/abs-host-storage';
import { settleAbsProjectTransaction } from './abs/abs-project-restart';
import { observeRuntimePublication } from './abs/abs-runtime-publication-observation';
import { AbsBaselineStore, type AbsSyncStoragePort } from './abs/abs-baseline-store';
import { AbsOperationJournal } from './abs/abs-operation-journal';
import { absJson, hashAbsText } from './abs/abs-identity-map';
import type { NativeSaveOperationRef } from './abs/abs-native-save-protocol';

/** Only retires an older environment observation. It grants no completion or
 * candidate authority to that older native request. */
export async function inspectEnvironmentSuccessor(io: AbsSyncStoragePort, project: string, guard: () => void) {
  return io.withLock(async access => {
    const port = { ...io, read: (key: string) => access.read(key) }, root = io.attachment?.root ?? project;
    const journal = new AbsOperationJournal(port, root), store = new AbsBaselineStore(port, { projectKey: root, pageId: '' });
    guard();
    const pointer = await access.read('operation.json'), head = await access.read('committed.json'), disk = await store.captureDisk(access);
    if (pointer === null || await access.read('prepared.json') !== null) return undefined;
    const location = await journal.inspectLocation();
    let owner: { kind: string; ref?: unknown; snapshotHash?: string } | undefined;
    if (location?.operation.nativeSave && location.operation.project === root
      && absJson(location.operation.disk) === absJson(disk) && location.operation.committed === head) {
      const ref = await journal.findDocumentSave(location.operation.nativeSave, guard);
      if (ref && ref.operationId === location.operation.id && absJson(ref.attachment) === absJson(io.attachment)) {
        owner = { kind: 'native-admission', ref, snapshotHash: await hashAbsText(location.snapshot) };
      }
    }
    if (!owner) {
      const selected = await store.readCommittedSnapshot();
      if (!selected || selected.projection.map.scope.projectKey !== root || selected.abi !== disk.abi
        || selected.projection.abs !== disk.abs || absJson(selected.projection.map) !== disk.map) return undefined;
      owner = { kind: 'complete-published-successor' };
    }
    const hash = (text: string | null) => text === null ? Promise.resolve(null) : hashAbsText(text);
    const saved = { abiHash: await hash(disk.abi), absHash: await hash(disk.abs), mapHash: await hash(disk.map),
      committedHash: await hash(head), operationPointerHash: await hashAbsText(pointer) };
    guard();
    if (await access.read('operation.json') !== pointer || await access.read('committed.json') !== head
      || await access.read('prepared.json') !== null || absJson(await store.captureDisk(access)) !== absJson(disk)) return undefined;
    return { version: 1, attachment: io.attachment, ...owner, saved };
  });
}

/** Source observation and dependency restoration share a physical lock, so
 * these two existing owners are called sequentially, never inside each other. */
export async function settleLinkedProjectEnvironment(project: string, assertCurrent: () => void,
  completed?: NativeSaveOperationRef): Promise<void> {
  const host = window['libraryDependencies'];
  if (host?.environmentVersion !== 2 || typeof host.pendingEnvironment !== 'function') return;
  const originals: Array<{ requestId: string; programRef: NativeSaveOperationRef }> = await host.pendingEnvironment(project);
  assertCurrent();
  const pending = completed ? originals.filter(value => value.programRef.request.requestId === completed.request.requestId) : originals;
  if (!pending.length) return;
  if (completed && (pending.length !== 1 || absJson(pending[0].programRef) !== absJson(completed))) {
    throw new Error('The linked environment no longer identifies the completed source publication.');
  }
  const io = completed ? undefined : await openAbsHostStorage(project, assertCurrent);
  if (io) await settleAbsProjectTransaction(io, project, assertCurrent);
  assertCurrent();
  for (const original of pending) {
    const facts = await observeRuntimePublication(project, original.programRef, assertCurrent); assertCurrent();
    if (completed && (facts.observation.state !== 'completed' || facts.observation.result.publication.status !== 'COMMITTED')) {
      throw new Error('The original source commit is not verified for its linked environment.');
    }
    const successor = io && facts.observation.state === 'completed' && facts.observation.result.publication.status === 'NOT_COMMITTED'
      ? await inspectEnvironmentSuccessor(io, project, assertCurrent) : undefined;
    await host.settleLinkedEnvironment(project, { ...original, ...facts, ...(successor ? { successor } : {}) }); assertCurrent();
  }
}
