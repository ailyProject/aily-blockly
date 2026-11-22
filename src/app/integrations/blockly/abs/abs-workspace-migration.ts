import { AbsBaselineStore, type AbsSyncStoragePort } from './abs-baseline-store';
import { generationEvidence } from './abs-generation-protocol';
import { absJson, hashAbsText } from './abs-identity-map';
import { absMapJson } from './abs-map-json';
import { AbsSyncError } from './abs-state';
import { AbsOperationJournal } from './abs-operation-journal';
import { recoverAbsLocationMetadata } from './abs-baseline-recovery';
import { sameAbsProjectDirectory } from './abs-project-path';
import type { AbsWorkspaceMode } from './abs-workspace-mode';

const nullableHash = (text: string | null) => text === null ? Promise.resolve(null) : hashAbsText(text);

export async function assertWorkspaceMigrationWritable(port: Pick<AbsSyncStoragePort, 'read'>) {
  const text = await port.read('history-workspace.json');
  if (text === null) return;
  let record: any;
  try { record = JSON.parse(text); } catch { throw new AbsSyncError('ABS_WORKSPACE_MIGRATION_CONFLICT', 'The original History metadata is invalid.'); }
  if (record.executionMigration?.phase === 'prepared') throw new AbsSyncError('ABS_WORKSPACE_MIGRATION_PENDING',
    'The original workspace migration must settle before another program writer.');
}

export async function captureWorkspaceMigrationProof(port: AbsSyncStoragePort,
  working: { revision: number; document: unknown }, assertCurrent: () => void, mode: AbsWorkspaceMode = 'overlay-v1', repairMap = false) {
  return port.withLock(async storage => {
    assertCurrent();
    if (!port.attachment) throw new AbsSyncError('ABS_WORKSPACE_MIGRATION_CONFLICT', 'Migration requires the original physical project attachment.');
    const scoped: AbsSyncStoragePort = { ...port, read: key => storage.read(key), withLock: operation => operation(storage) };
    const store = new AbsBaselineStore(scoped, { projectKey: port.attachment.root, pageId: '' });
    if (await store.workspaceMode(storage) !== mode)
      throw new AbsSyncError('ABS_WORKSPACE_MIGRATION_CONFLICT', 'The engine changed before workspace readiness could be verified.');
    const snapshot = await store.readCommittedSnapshot(), disk = await store.captureDisk(storage);
    const committed = await storage.read('committed.json'), prepared = await storage.read('prepared.json');
    const modeMarker = await storage.read('workspace-mode.json');
    if (!snapshot || snapshot.abi === null || disk.abi !== snapshot.abi || committed === null || prepared !== null
      || await new AbsOperationJournal(scoped, port.attachment.root).inspect())
      throw new AbsSyncError('ABS_WORKSPACE_MIGRATION_CONFLICT', 'Migration requires the verified accepted ABI/map and no prepared generation.');
    const map = absMapJson(snapshot.projection.map);
    if (disk.map !== map) {
      if (!repairMap || (mode === 'overlay-v1' && disk.abs !== snapshot.projection.abs)) {
        throw new AbsSyncError('ABS_WORKSPACE_MIGRATION_CONFLICT', 'Migration requires the verified accepted ABI/map and no prepared generation.');
      }
      await assertWorkspaceMigrationWritable(scoped);
      // Repair the old generation's cache, then let the location rebind below
      // prove and publish the new scope. The storage still belongs to this copy.
      const original = new AbsBaselineStore(scoped, snapshot.projection.map.scope);
      await original.restoreCommittedMap(assertCurrent, { disk, pointerHash: snapshot.pointerHash });
      disk.map = map;
    }
    const accepted = (await generationEvidence(snapshot.projection, snapshot.abi)).binding;
    const expected = { abiHash: await nullableHash(disk.abi), absHash: await nullableHash(disk.abs), mapHash: await nullableHash(disk.map),
      committedHash: await hashAbsText(committed), preparedHash: null };
    if (snapshot.pointerHash !== expected.committedHash) throw new AbsSyncError('ABS_BASELINE_STALE', 'The accepted head changed during migration preparation.');
    assertCurrent();
    return { version: 1 as const, attachment: port.attachment,
      modeBefore: { text: modeMarker, hash: await nullableHash(modeMarker) },
      accepted: { version: 1 as const, attachment: port.attachment, accepted, committedHash: expected.committedHash },
      host: { expected, workingRevision: working.revision, workingDocumentHash: await hashAbsText(absJson(working.document)),
        author: { hash: expected.absHash, bytes: disk.abs === null ? null : new TextEncoder().encode(disk.abs).byteLength } } };
  });
}

/** Rebind only an otherwise verified saved generation before issuing its proof.
 * Fence every recovery write against the observed original inputs. */
export async function prepareWorkspaceMigrationProof(port: AbsSyncStoragePort,
  working: { revision: number; document: unknown }, assertCurrent: () => void, mode: AbsWorkspaceMode = 'overlay-v1') {
  const original = await captureWorkspaceMigrationProof(port, working, assertCurrent, mode, true);
  const { root } = original.attachment, binding = original.accepted.accepted;
  const windows = /^[A-Za-z]:[/\\]|^\\\\/.test(root);
  if (await sameAbsProjectDirectory(binding.scope.projectKey, root, undefined, windows)) return original;

  const scope = { projectKey: root, pageId: binding.scope.pageId };
  const expected = original.host.expected;
  const recoveryPort: AbsSyncStoragePort = { ...port, withLock: operation => port.withLock(async storage => {
    const scoped = { ...port, read: key => storage.read(key) };
    await assertWorkspaceMigrationWritable(scoped);
    if (await storage.read('workspace-mode.json') !== original.modeBefore.text || await storage.read('prepared.json') !== null
      || await nullableHash(await storage.read('committed.json')) !== expected.committedHash
      || await nullableHash(await storage.read('project.abi')) !== expected.abiHash
      || await nullableHash(await storage.read('project.abs')) !== expected.absHash
      || await nullableHash(await storage.read('project.abs.map.json')) !== expected.mapHash
      || await new AbsOperationJournal(scoped, root).inspect()) {
      throw new AbsSyncError('ABS_WORKSPACE_MIGRATION_OBSERVATION_STALE', 'Migration location repair no longer matches the observed project.');
    }
    assertCurrent();
    return operation(storage);
  }) };
  await recoverAbsLocationMetadata(recoveryPort, scope, assertCurrent);
  const repaired = await captureWorkspaceMigrationProof(port, working, assertCurrent, mode);
  const rebound = repaired.accepted.accepted;
  if (!await sameAbsProjectDirectory(rebound.scope.projectKey, root, undefined, windows)
    || absJson(repaired.attachment) !== absJson(original.attachment) || repaired.modeBefore.hash !== original.modeBefore.hash
    || rebound.scope.pageId !== binding.scope.pageId || rebound.abiHash !== binding.abiHash || rebound.absHash !== binding.absHash) {
    throw new AbsSyncError('ABS_WORKSPACE_MIGRATION_CONFLICT', 'Migration could not verify the accepted program at its current project location.');
  }
  if (absJson(repaired.host.author) !== absJson(original.host.author)) {
    const draft = await new AbsBaselineStore(port, scope).readArchivedDraft(rebound.generation);
    if (draft.baseGeneration !== binding.generation || draft.hash !== original.host.author.hash || draft.bytes !== original.host.author.bytes) {
      throw new AbsSyncError('ABS_WORKSPACE_MIGRATION_CONFLICT', 'Migration could not verify the original author draft was retained.');
    }
  }
  assertCurrent();
  return repaired;
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
