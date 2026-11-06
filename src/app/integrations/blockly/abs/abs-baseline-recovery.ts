import { createProjectDataMarker } from '@domain/project/public-api';
import { AbsBaselineStore, absBaselineKey, type AbsSyncStoragePort } from './abs-baseline-store';
import { decodeAbsState } from './abs-full-state';
import { absJson, createAbsProjection, hashAbsText } from './abs-identity-map';
import { sameAbsProgram } from './abs-program-state';
import { AbsSyncError, type AbsIdentityMap } from './abs-state';
import { inspectAbsGeneration } from './abs-generation-inspection';

const recoverable = new Set(['ABS_BASELINE_CORRUPT', 'ABS_BASELINE_MISSING']);
export const ABS_BASELINE_RECOVERY_HINT = 'Preserve source, candidate, staging and private records. Inspect project recovery and execute only the offered same-project preserving recovery. Do not delete locks/baselines, overwrite ABI/map, create another project or ask the user to open a copy. A request generation mismatch is not baseline corruption.';

/** Preserve the existing typed inspection boundary; diagnosis never repairs
 * its own journal or grants authority to consume a competing source. */
export async function inspectAbsGenerationForRecovery(store: AbsBaselineStore, scope: AbsIdentityMap['scope']) {
  try { return await inspectAbsGeneration(store, scope); }
  catch (error) {
    if (!(error instanceof AbsSyncError) || !recoverable.has(error.code)) throw error;
    throw new AbsSyncError(error.code, error.message, error.range, error.blockIds,
      { reason: 'baseline-unavailable', hint: ABS_BASELINE_RECOVERY_HINT });
  }
}

/** A public full-state ABS plus its matching saved ABI can repair private
 * baseline metadata. An unapplied draft or competing ABI never authorizes it. */
async function source(port: AbsSyncStoragePort, project: string) {
  if (await port.read('prepared.json') !== null) throw new AbsSyncError('ABS_TRANSACTION_PENDING', 'Converge the original transaction before baseline repair.');
  const store = new AbsBaselineStore(port, { projectKey: project, pageId: '' }), disk = await store.captureDisk();
  if (disk.abi === null || disk.abs === null) return null;
  const decoded = await decodeAbsState(disk.abs), document: any = decoded.document;
  if (!document || typeof document.activePageId !== 'string' || !Array.isArray(document.pages)) return null;
  const saved = JSON.parse(disk.abi), marked = { ...document, $ailyProjectData: createProjectDataMarker() };
  if (!sameAbsProgram(saved, document) && !sameAbsProgram(saved, marked)) return null;
  const generation = crypto.randomUUID(), scope = { projectKey: project, pageId: document.activePageId };
  const projection = await createAbsProjection(decoded.workspace, { document, contracts: decoded.contracts, scope, generation,
    baselineRef: absBaselineKey(generation), savedAbiHash: await hashAbsText(absJson(saved)) });
  // Decoding retained state alone is not proof the public body was committed.
  if (projection.abs !== disk.abs) return null;
  return { store: new AbsBaselineStore(port, scope), disk, projection, committed: await port.read('committed.json') };
}

export async function inspectAbsBaselineRecovery(port: AbsSyncStoragePort, project: string) {
  try {
    const store = new AbsBaselineStore(port, { projectKey: project, pageId: '' });
    try {
      const committed = await store.inspectCommitted(), disk = await store.captureDisk();
      if (committed?.projection.map.scope.projectKey === project) {
        const abi = await store.readDerivedAbi(committed.projection.map.generation);
        let competing = false;
        try { competing = disk.abi !== null && !sameAbsProgram(JSON.parse(disk.abi), JSON.parse(abi!)); } catch { /* Damaged primary may use the verified committed source. */ }
        if (abi !== null && !competing) return { version: 1, action: 'recover_project', sameProject: true, candidateApplied: false, source: 'saved-document',
          input: { abiHash: disk.abi === null ? null : await hashAbsText(disk.abi), absHash: disk.abs === null ? null : await hashAbsText(disk.abs),
            mapHash: disk.map === null ? null : await hashAbsText(disk.map) } };
      }
    } catch { /* A missing private generation may still have a complete matching public source. */ }
    const input = await source(port, project);
    if (!input) return null;
    return { version: 1, action: 'recover_project', sameProject: true, candidateApplied: false, source: 'public-generation',
      input: { abiHash: await hashAbsText(input.disk.abi!), absHash: await hashAbsText(input.disk.abs!),
        mapHash: input.disk.map === null ? null : await hashAbsText(input.disk.map) } };
  } catch { return null; }
}

export async function recoverAbsBaseline(port: AbsSyncStoragePort, project: string, assertCurrent: () => void) {
  const lookup = new AbsBaselineStore(port, { projectKey: project, pageId: '' });
  try {
    const healthy = await lookup.inspectCommitted();
    if (healthy) {
      if (healthy.projection.map.scope.projectKey !== project) throw new AbsSyncError('ABS_SCOPE_INVALID', 'The committed source belongs to another project.');
      const disk = await lookup.captureDisk();
      let damaged = disk.abi === null;
      if (disk.abi !== null) { try { JSON.parse(disk.abi); } catch { damaged = true; } }
      if (damaged) {
        const abi = await lookup.readDerivedAbi(healthy.projection.map.generation);
        if (abi === null) throw new AbsSyncError('ABS_RECOVERY_SOURCE_UNAVAILABLE', 'The verified generation has no saved primary recipe.');
        await port.withLock(async storage => {
          assertCurrent();
          if (absJson(await lookup.captureDisk(storage)) !== absJson(disk)
            || await hashAbsText((await storage.read('committed.json'))!) !== healthy.pointerHash) throw new AbsSyncError('ABS_DISK_CONFLICT', 'Primary recovery inputs changed.');
          if (!await storage.replace(`recoveries/primary-${crypto.randomUUID()}.json`, null, absJson({ version: 1, project,
            sourceGeneration: healthy.projection.map.generation, disk }))) throw new AbsSyncError('ABS_RECOVERY_ARCHIVE_CONFLICT', 'Could not preserve damaged primary bytes.');
          assertCurrent();
          if (!await storage.replace('project.abi', disk.abi === null ? null : await hashAbsText(disk.abi), abi)) throw new AbsSyncError('ABS_DISK_CONFLICT', 'Primary recovery conflicted with another writer.');
        });
        if (await port.read('project.abi') !== abi) throw new AbsSyncError('ABS_COMMIT_UNCERTAIN', 'Recovered primary readback did not match its verified generation.');
      }
      return { changed: false, generation: healthy.projection.map.generation };
    }
  } catch (error) {
    if (!['ABS_BASELINE_CORRUPT', 'ABS_BASELINE_MISSING'].includes((error as any)?.code)) throw error;
  }
  const input = await source(port, project);
  if (!input) throw new AbsSyncError('ABS_RECOVERY_SOURCE_UNAVAILABLE', 'No matching complete saved ABI/ABS source exists; all content and candidates were retained.');
  const archive = `recoveries/baseline-${crypto.randomUUID()}.json`;
  await port.withLock(async storage => {
    assertCurrent();
    if (absJson(await input.store.captureDisk(storage)) !== absJson(input.disk) || await storage.read('committed.json') !== input.committed) {
      throw new AbsSyncError('ABS_DISK_CONFLICT', 'Baseline recovery inputs changed.');
    }
    if (!await storage.replace(archive, null, absJson({ version: 1, kind: 'baseline-repair', project,
      disk: input.disk, committed: input.committed }))) throw new AbsSyncError('ABS_RECOVERY_ARCHIVE_CONFLICT', 'Could not preserve baseline recovery inputs.');
  });
  await input.store.stage({ projection: input.projection, mode: 'import', inputAbs: input.disk.abs, abi: input.disk.abi,
    expected: input.disk, metadataOnly: true }, input.committed === null ? null : await hashAbsText(input.committed));
  assertCurrent();
  const result = await input.store.commit(input.projection.map.generation, assertCurrent, async (text, hash, storage) => {
    assertCurrent();
    if (text !== input.disk.abi || !await storage.replace('project.abi', hash, text)) throw new AbsSyncError('ABS_ABI_COMMIT_CONFLICT', 'The saved primary changed; recovery did not replace it.');
  });
  if (result.status !== 'COMMITTED') throw new AbsSyncError('ABS_RESTORE_INCOMPLETE', result.error ?? 'Baseline metadata recovery is pending.');
  return { changed: true, generation: result.generation, recoveryArchive: archive };
}
