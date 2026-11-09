import { AbsBaselineStore, type AbsSyncStoragePort } from './abs-baseline-store';
import { openAbsHostStorage } from './abs-host-storage';
import { absJson } from './abs-identity-map';
import { AbsSyncError } from './abs-state';

export interface SavedProjectProgram {
  version: 1;
  source: 'committed' | 'legacy';
  generation: string | null;
  pointerHash: string | null;
  packageText: string;
  files: { 'project.abi': string | null; 'project.abs': string | null; 'project.abs.map.json': string | null };
}

/** Export/backup consumers read saved source and its environment metadata at
 * one boundary. Working and private drafts continue to use their own owners. */
export async function readSavedProjectProgram(project: string, assertCurrent: () => void,
  supplied?: AbsSyncStoragePort): Promise<SavedProjectProgram> {
  const port = supplied ?? await openAbsHostStorage(project, assertCurrent);
  return port.withLock(async access => {
    assertCurrent();
    const readOnly: AbsSyncStoragePort = { read: key => access.read(key),
      withLock: () => { throw new AbsSyncError('ABS_STORAGE_OPERATION_INVALID', 'A saved-source reader cannot publish or acquire a nested lock.'); } };
    const store = new AbsBaselineStore(readOnly, { projectKey: project, pageId: '' });
    const selected = await store.readCommittedSnapshot();
    const packageText = await access.read('package.json');
    if (packageText === null) throw new AbsSyncError('PROJECT_MANIFEST_MISSING', 'The saved project manifest is unavailable.');
    assertCurrent();
    if (selected) return { version: 1, source: 'committed', generation: selected.projection.map.generation,
      pointerHash: selected.pointerHash, packageText,
      files: { 'project.abi': selected.abi, 'project.abs': selected.projection.abs,
        'project.abs.map.json': absJson(selected.projection.map) } };
    if (await access.read('prepared.json') !== null) throw new AbsSyncError('ABS_TRANSACTION_PENDING',
      'The original first publication must settle before an export can select saved source.');
    const disk = await store.captureDisk(access);
    assertCurrent();
    return { version: 1, source: 'legacy', generation: null, pointerHash: null, packageText,
      files: { 'project.abi': disk.abi, 'project.abs': disk.abs, 'project.abs.map.json': disk.map } };
  });
}
