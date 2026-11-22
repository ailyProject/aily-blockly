import { openAbsHostStorage } from './abs/abs-host-storage';
import { settleAbsProjectTransaction } from './abs/abs-project-restart';
import { observeRuntimePublication } from './abs/abs-runtime-publication-observation';
import { AbsBaselineStore, type AbsSyncStoragePort } from './abs/abs-baseline-store';
import { AbsOperationJournal } from './abs/abs-operation-journal';
import { absJson, hashAbsText } from './abs/abs-identity-map';
import { nativeSaveError, type NativeSaveIdentity, type NativeSaveOperationRef } from './abs/abs-native-save-protocol';
import { nativeSaveAdmissionIdentity, OriginalRequestAdmissions } from './abs/original-request-admission';

interface LinkedEnvironmentReference {
  requestId: string;
  programRef: NativeSaveOperationRef;
}
interface LinkedEnvironmentHost {
  pendingEnvironment(project: string): Promise<LinkedEnvironmentReference[]>;
  settleLinkedEnvironment(project: string, request: LinkedEnvironmentReference & Awaited<ReturnType<typeof observeRuntimePublication>>
    & { successor?: Awaited<ReturnType<typeof inspectEnvironmentSuccessor>> }): Promise<unknown>;
}

/** Only a read may outlive this wait. Native journal writes keep their own
 * transaction ownership until completion. */
export async function observeOpenEnvironment<T>(read: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return read();
  signal.throwIfAborted();
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([cancelled, read()]); }
  finally { signal.removeEventListener('abort', abort); }
}

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
    let acceptedDisk: Promise<boolean> | undefined;
    const verifyAcceptedDisk = () => acceptedDisk ??= store.readCommittedSnapshot().then(selected =>
      selected?.projection.map.scope.projectKey === root && store.matchesAcceptedDisk(selected, disk));
    let owner: { kind: string; ref?: NativeSaveOperationRef; snapshotHash?: string } | undefined;
    if (location?.operation.nativeSave && location.operation.project === root
      && location.operation.disk.abi === disk.abi && location.operation.disk.map === disk.map && location.operation.committed === head
      && (location.operation.disk.abs === disk.abs || await store.workspaceMode(access) === 'project-v1' && await verifyAcceptedDisk())) {
      const ref = await journal.findDocumentSave(location.operation.nativeSave, guard);
      if (ref && ref.operationId === location.operation.id && absJson(ref.attachment) === absJson(io.attachment)) {
        owner = { kind: 'native-admission', ref, snapshotHash: await hashAbsText(location.snapshot) };
      }
    }
    if (!owner) {
      if (!await verifyAcceptedDisk()) return undefined;
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
  completed?: NativeSaveOperationRef, startupSignal?: AbortSignal): Promise<void> {
  const host = window['libraryDependencies'];
  if (host?.environmentVersion !== 2 || typeof host.pendingEnvironment !== 'function') return;
  const originals: LinkedEnvironmentReference[] = await observeOpenEnvironment(() => host.pendingEnvironment(project), startupSignal);
  assertCurrent();
  const pending = completed ? originals.filter(value => value.programRef.request.requestId === completed.request.requestId) : originals;
  if (!pending.length) return;
  if (completed && (pending.length !== 1 || absJson(pending[0].programRef) !== absJson(completed))) {
    throw new Error('The linked environment no longer identifies the completed source publication.');
  }
  const io = completed ? undefined : await openAbsHostStorage(project, assertCurrent);
  if (io) await settleAbsProjectTransaction(io, project, assertCurrent);
  assertCurrent();
  for (const original of pending) await settleEnvironment(host, project, original, assertCurrent, io, !!completed);
}

/** Authenticated callers supply the original native identity only. All source
 * and dependency facts are read here from the attached project. */
export async function settleOriginalBoardEnvironment(io: AbsSyncStoragePort, project: string,
  original: { request: NativeSaveIdentity; hostPid: number }, host: LinkedEnvironmentHost,
  guard: () => void): Promise<'none' | 'pending' | 'settled'> {
  const root = io.attachment?.root ?? project;
  const source = await new AbsOperationJournal(io, root).findDocumentSave(original.request, guard);
  if (!source) {
    const admission = nativeSaveAdmissionIdentity(original.request);
    const rejected = admission && await new OriginalRequestAdmissions(io, root).observe(admission);
    guard();
    if (rejected && rejected.executor.hostPid !== original.hostPid)
      throw nativeSaveError('The original board executor differs.', 'PROJECT_SAVE_EXECUTOR_MISMATCH');
    return rejected ? 'none' : 'pending';
  }
  if (source.executor.hostPid !== original.hostPid)
    throw nativeSaveError('The original board executor differs.', 'PROJECT_SAVE_EXECUTOR_MISMATCH');
  const pending = (await host.pendingEnvironment(root)).filter(value => value.programRef.request.requestId === original.request.requestId);
  guard();
  if (!pending.length) return 'none';
  if (pending.length !== 1 || absJson(pending[0].programRef) !== absJson(source))
    throw nativeSaveError('The linked environment belongs to a different original publication.');
  await settleEnvironment(host, root, pending[0], guard, io);
  return 'settled';
}

async function settleEnvironment(host: LinkedEnvironmentHost, project: string, original: LinkedEnvironmentReference,
  guard: () => void, io?: AbsSyncStoragePort, requireCommit = false): Promise<void> {
  const facts = await observeRuntimePublication(project, original.programRef, guard, io);
  guard();
  if (requireCommit && (facts.observation.state !== 'completed' || facts.observation.result.publication.status !== 'COMMITTED'))
    throw new Error('The original source commit is not verified for its linked environment.');
  const successor = io && facts.observation.state === 'completed' && facts.observation.result.publication.status === 'NOT_COMMITTED'
    ? await inspectEnvironmentSuccessor(io, project, guard) : undefined;
  await host.settleLinkedEnvironment(project, { ...original, ...facts, ...(successor ? { successor } : {}) });
  guard();
}
