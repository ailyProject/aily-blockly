import type { AbsSyncStoragePort } from './abs-baseline-store';
import { absJson } from './abs-identity-map';
import { AbsSyncError } from './abs-state';

export interface AbsRecoveryLineage { version: 1; project: string; sourceProject: string; operationId: string }

/** Discovery facts survive edits/restarts. No hashes or workspace grants are
 * refreshed from this relationship; every mutation needs its own admission. */
export async function readAbsRecoveryLineage(port: AbsSyncStoragePort, project: string): Promise<AbsRecoveryLineage | null> {
  const text = await port.read('lineage.json');
  if (text === null) return null;
  let value: AbsRecoveryLineage;
  try { value = JSON.parse(text); } catch { throw new AbsSyncError('ABS_LINEAGE_INVALID', 'Recovery relationship metadata is invalid.'); }
  if (value?.version !== 1 || value.project !== project || typeof value.sourceProject !== 'string' || !value.sourceProject
    || !/^[A-Za-z0-9_-]{8,96}$/.test(value.operationId)) throw new AbsSyncError('ABS_LINEAGE_INVALID', 'Recovery relationship does not identify this project.');
  return value;
}

export async function rememberAbsRecoveryLineage(port: AbsSyncStoragePort, lineage: AbsRecoveryLineage, assertCurrent: () => void) {
  await port.withLock(async storage => {
    const before = await storage.read('lineage.json');
    if (before !== null) {
      const previous = await readAbsRecoveryLineage({ read: storage.read, withLock: port.withLock }, lineage.project);
      if (previous?.sourceProject === lineage.sourceProject) return;
      throw new AbsSyncError('ABS_LINEAGE_CONFLICT', 'The existing recovery relationship was retained; a new operation cannot replace it.');
    }
    assertCurrent();
    if (!await storage.replace('lineage.json', null, absJson(lineage))) throw new AbsSyncError('ABS_LINEAGE_CONFLICT', 'Recovery relationship changed.');
  });
}
