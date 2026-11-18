import { AbsBaselineStore, type AbsSyncStoragePort } from './abs-baseline-store';
import { generationEvidence } from './abs-generation-protocol';
import { absJson, hashAbsText } from './abs-identity-map';
import { AbsSyncError } from './abs-state';
import { AbsOperationJournal } from './abs-operation-journal';

export async function assertWorkspaceMigrationWritable(port: Pick<AbsSyncStoragePort, 'read'>) {
  const text = await port.read('history-workspace.json');
  if (text === null) return;
  let record: any;
  try { record = JSON.parse(text); } catch { throw new AbsSyncError('ABS_WORKSPACE_MIGRATION_CONFLICT', 'The original History metadata is invalid.'); }
  if (record.executionMigration?.phase === 'prepared') throw new AbsSyncError('ABS_WORKSPACE_MIGRATION_PENDING',
    'The original workspace migration must settle before another program writer.');
}

export async function captureWorkspaceMigrationProof(port: AbsSyncStoragePort,
  working: { revision: number; document: unknown }, assertCurrent: () => void) {
  return port.withLock(async storage => {
    assertCurrent();
    if (!port.attachment) throw new AbsSyncError('ABS_WORKSPACE_MIGRATION_CONFLICT', 'Migration requires the original physical project attachment.');
    const scoped = { ...port, read: key => storage.read(key) };
    const store = new AbsBaselineStore(scoped, { projectKey: port.attachment.root, pageId: '' });
    if (await store.workspaceMode(storage) !== 'overlay-v1')
      throw new AbsSyncError('ABS_WORKSPACE_MIGRATION_CONFLICT', 'Only the original overlay engine can prepare a mode migration.');
    const snapshot = await store.readCommittedSnapshot(), disk = await store.captureDisk(storage);
    const committed = await storage.read('committed.json'), prepared = await storage.read('prepared.json');
    const mode = await storage.read('workspace-mode.json');
    if (!snapshot || snapshot.abi === null || !await store.matchesAcceptedDisk(snapshot, { ...disk, abs: snapshot.projection.abs })
      || committed === null || prepared !== null || await new AbsOperationJournal(scoped, port.attachment.root).inspect())
      throw new AbsSyncError('ABS_WORKSPACE_MIGRATION_CONFLICT', 'Migration requires the verified accepted ABI/map and no prepared generation.');
    const nullable = (text: string | null) => text === null ? Promise.resolve(null) : hashAbsText(text);
    const accepted = (await generationEvidence(snapshot.projection, snapshot.abi)).binding;
    const expected = { abiHash: await nullable(disk.abi), absHash: await nullable(disk.abs), mapHash: await nullable(disk.map),
      committedHash: await hashAbsText(committed), preparedHash: null };
    if (snapshot.pointerHash !== expected.committedHash) throw new AbsSyncError('ABS_BASELINE_STALE', 'The accepted head changed during migration preparation.');
    assertCurrent();
    return { version: 1 as const, attachment: port.attachment,
      modeBefore: { text: mode, hash: await nullable(mode) },
      accepted: { version: 1 as const, attachment: port.attachment, accepted, committedHash: expected.committedHash },
      host: { expected, workingRevision: working.revision, workingDocumentHash: await hashAbsText(absJson(working.document)),
        author: { hash: expected.absHash, bytes: disk.abs === null ? null : new TextEncoder().encode(disk.abs).byteLength } } };
  });
}

/** The renderer verifies semantic accepted bytes; native selection separately
 * verifies the prepared History record, physical files and atomic mode CAS. */
export async function verifyWorkspaceMigrationRecord(port: AbsSyncStoragePort, recordHash: string,
  working: { revision: number; document: unknown }, assertCurrent: () => void) {
  const text = await port.read(`history-objects/${recordHash}`); assertCurrent();
  if (text === null || await hashAbsText(text) !== `sha256:${recordHash}`)
    throw new AbsSyncError('ABS_WORKSPACE_MIGRATION_CONFLICT', 'The prepared migration record checksum differs.');
  let record: any;
  try { record = JSON.parse(text); } catch { throw new AbsSyncError('ABS_WORKSPACE_MIGRATION_CONFLICT', 'The prepared migration record is invalid.'); }
  if (!port.attachment) throw new AbsSyncError('ABS_WORKSPACE_MIGRATION_CONFLICT', 'Migration requires the original physical project attachment.');
  const store = new AbsBaselineStore(port, { projectKey: port.attachment.root, pageId: '' });
  const snapshot = await store.readCommittedSnapshot(); assertCurrent();
  const mode = await store.workspaceMode();
  const documentHash = await hashAbsText(absJson(working.document));
  if (record?.version !== 1 || record.from !== 'overlay-v1' || record.to !== 'project-v1'
    || !port.attachment || absJson(record.attachment) !== absJson(port.attachment)
    || record.accepted?.version !== 1 || absJson(record.accepted.attachment) !== absJson(port.attachment)
    || !snapshot || snapshot.abi === null || record.accepted.committedHash !== snapshot.pointerHash
    || absJson(record.accepted.accepted) !== absJson((await generationEvidence(snapshot.projection, snapshot.abi)).binding))
    throw new AbsSyncError('ABS_WORKSPACE_MIGRATION_CONFLICT', 'The prepared migration is not this current accepted program and Working view.');
  if (mode === 'overlay-v1' && (record.host?.workingDocumentHash !== undefined
    ? record.host.workingDocumentHash !== documentHash : record.host?.workingRevision !== working.revision))
    throw new AbsSyncError('ABS_WORKSPACE_MIGRATION_OBSERVATION_STALE', 'The Working document changed after migration preparation.');
  assertCurrent();
  return { version: 1 as const, recordHash, workingRevision: working.revision, workingDocumentHash: documentHash };
}
