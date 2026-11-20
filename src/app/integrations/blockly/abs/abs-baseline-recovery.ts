import { absMapJson } from './abs-map-json';
import { createProjectDataMarker } from '@domain/project/project-data/project-data.types';
import { composeBlocklyPage } from '../../../editors/blockly-editor/services/blockly-project-model';
import { AbsBaselineStore, absBaselineKey, type AbsGenerationInput, type AbsSyncStoragePort } from './abs-baseline-store';
import { decodeAbsState, splitAbsState } from './abs-full-state';
import { absJson, reconstructAbsProjection, hashAbsText } from './abs-identity-map';
import { sameAbsProgram } from './abs-program-state';
import { AbsSyncError, type AbsIdentityMap } from './abs-state';
import { inspectAbsGeneration } from './abs-generation-inspection';

const recoverable = new Set(['ABS_BASELINE_CORRUPT', 'ABS_BASELINE_MISSING']);
export const ABS_BASELINE_RECOVERY_HINT = 'Preserve source, candidate, staging and private records. Inspect project recovery and execute only the offered same-project preserving recovery. Do not delete locks/baselines, overwrite ABI/map, create another project or ask the user to open a copy. A request generation mismatch is not baseline corruption.';

interface BaselineRecoverySource extends Pick<AbsGenerationInput, 'projection' | 'draftBaseGeneration' | 'authorIntent'> {
  store: AbsBaselineStore;
  disk: AbsGenerationInput['expected'];
  committed: string | null;
}

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
async function source(port: AbsSyncStoragePort, project: string): Promise<BaselineRecoverySource | null> {
  if (await port.read('prepared.json') !== null) throw new AbsSyncError('ABS_TRANSACTION_PENDING', 'Converge the original transaction before baseline repair.');
  const store = new AbsBaselineStore(port, { projectKey: project, pageId: '' }), disk = await store.captureDisk();
  if (disk.abi === null || disk.abs === null) return null;
  const committed = await port.read('committed.json');
  try {
    const decoded = await decodeAbsState(disk.abs), document: any = decoded.document;
    if (!document || typeof document.activePageId !== 'string' || !Array.isArray(document.pages)) return null;
    const saved = JSON.parse(disk.abi), marked = { ...document, $ailyProjectData: createProjectDataMarker() };
    if (!sameAbsProgram(saved, document) && !sameAbsProgram(saved, marked)) return null;
    const generation = crypto.randomUUID(), scope = { projectKey: project, pageId: document.activePageId };
    const projection = await reconstructAbsProjection(decoded.workspace, { document, contracts: decoded.contracts, scope, generation,
      baselineRef: absBaselineKey(generation), savedAbiHash: await hashAbsText(absJson(saved)) }, disk.abs);
    // Decoding retained state alone is not proof the public body was committed.
    if (projection.abs !== disk.abs) return null;
    return { store: new AbsBaselineStore(port, scope), disk, projection, committed };
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    if (committed === null && disk.map !== null && error instanceof AbsSyncError && error.code === 'ABS_STATE_INVALID') {
      const recovered = await reconstructDraftBase(port, project, { abi: disk.abi, abs: disk.abs, map: disk.map });
      if (recovered) return recovered;
    }
    throw error;
  }
}

/** A copied project may only carry the public files. Recreate the saved state
 * from ABI and verify the entire original index before archiving the draft. */
async function reconstructDraftBase(port: AbsSyncStoragePort, project: string,
  disk: { abi: string; abs: string; map: string }): Promise<BaselineRecoverySource | null> {
  let verified: Awaited<ReturnType<typeof reconstructAbsProjection>>;
  try {
    const map = JSON.parse(disk.map);
    const document = JSON.parse(disk.abi);
    const state = JSON.parse(splitAbsState(disk.abs).state ?? 'null');
    const savedAbiHash = await hashAbsText(absJson(document));
    if (document.schemaVersion !== 3 || !state?.contracts?.fields || savedAbiHash !== map?.savedAbiHash
      || typeof map.scope?.projectKey !== 'string' || map.scope.pageId !== document.activePageId
      || map.baselineRef !== absBaselineKey(map.generation)) return null;
    const workspace = composeBlocklyPage(document, map.scope.pageId);
    verified = await reconstructAbsProjection(workspace, { document, contracts: state.contracts, scope: map.scope,
      generation: map.generation, baselineRef: map.baselineRef, savedAbiHash }, disk.abs);
    if (absMapJson(verified.map) !== disk.map || verified.abs === disk.abs) return null;
  } catch {
    // An invalid public file cannot prove a missing private generation.
    return null;
  }
  const generation = crypto.randomUUID(), scope = { projectKey: project, pageId: verified.map.scope.pageId };
  const store = new AbsBaselineStore(port, scope);
  const projection = { ...verified, map: { ...verified.map, scope, generation, baselineRef: absBaselineKey(generation) } };
  const authorIntent = await store.workspaceMode() === 'project-v1' ? 'preserve' : undefined;
  return { store, disk, projection, committed: null, draftBaseGeneration: verified.map.generation, authorIntent };
}

/** A pending ABS is a draft, not a second saved document. A verified saved
 * recipe and its exact public map identify its origin without parsing or
 * trusting that draft. Archive it using the existing draft journal. */
async function committedSource(port: AbsSyncStoragePort, project: string, lookup: AbsBaselineStore,
  healthy: NonNullable<Awaited<ReturnType<AbsBaselineStore['readCommittedSnapshot']>>>): Promise<BaselineRecoverySource | null> {
  const disk = await lookup.captureDisk();
  if (disk.abi === null || disk.abs === null || disk.map !== absMapJson(healthy.projection.map)) return null;
  const abi = await lookup.readDerivedAbi(healthy.projection.map.generation);
  if (abi === null) return null;
  try { if (!sameAbsProgram(JSON.parse(disk.abi), JSON.parse(abi))) return null; }
  catch (error) { if (error instanceof SyntaxError) return null; throw error; }
  const generation = crypto.randomUUID(), previous = healthy.projection;
  const scope = { projectKey: project, pageId: previous.map.scope.pageId };
  const projection = await reconstructAbsProjection(previous.workspace, { document: previous.document, contracts: previous.contracts,
    generation, baselineRef: absBaselineKey(generation), scope, savedAbiHash: await hashAbsText(absJson(JSON.parse(disk.abi))) }, previous.abs);
  if (projection.abs !== previous.abs) return null;
  const authorIntent = healthy.workspaceMode === 'project-v1' && disk.abs !== previous.abs
    ? (healthy.authorSource?.disposition === 'accepted' && healthy.authorSource.hash === await hashAbsText(disk.abs)
      ? 'candidate' : 'preserve') : undefined;
  return { store: new AbsBaselineStore(port, scope), disk, projection, committed: await port.read('committed.json'),
    ...(authorIntent ? { authorIntent } : {}),
    ...(disk.abs !== previous.abs ? { draftBaseGeneration: previous.map.generation } : {}) };
}

/** Inspection and execution use identical source admission. A physical move is
 * metadata repair only when the complete public source still equals the exact
 * checksum-verified commit. Neither a draft nor a newer primary grants it. */
async function classifyRecovery(port: AbsSyncStoragePort, project: string) {
  if (await port.read('prepared.json') !== null) throw new AbsSyncError('ABS_TRANSACTION_PENDING', 'Converge the original transaction before baseline repair.');
  const lookup = new AbsBaselineStore(port, { projectKey: project, pageId: '' });
  let healthy: Awaited<ReturnType<AbsBaselineStore['readCommittedSnapshot']>> = null;
  try {
    healthy = await lookup.readCommittedSnapshot();
  } catch (error) {
    if (!(error instanceof AbsSyncError) || !recoverable.has(error.code)) throw error;
  }
  if (healthy?.projection.map.scope.projectKey === project) {
    const disk = await lookup.captureDisk(), abi = await lookup.readDerivedAbi(healthy.projection.map.generation);
    let damaged = disk.abi === null, competing = false;
    if (disk.abi !== null) {
      try { competing = abi !== null && !sameAbsProgram(JSON.parse(disk.abi), JSON.parse(abi)); }
      catch { damaged = true; }
    }
    if (damaged && abi !== null) return { kind: 'primary' as const, lookup, healthy, disk, abi };
    if (!damaged && !competing && disk.map === absMapJson(healthy.projection.map)) {
      return { kind: 'current' as const, lookup, healthy, disk };
    }
  }
  const input = healthy?.projection.map.scope.projectKey !== project && healthy
    ? await committedSource(port, project, lookup, healthy) ?? await source(port, project)
    : await source(port, project);
  if (!input) throw new AbsSyncError('ABS_RECOVERY_SOURCE_UNAVAILABLE', 'No matching complete saved ABI/ABS source exists; all content and candidates were retained.');
  if (healthy && (input.projection.abs !== healthy.projection.abs
    || input.projection.map.scope.pageId !== healthy.projection.map.scope.pageId)) {
    throw new AbsSyncError('ABS_SOURCE_CONFLICT', 'The complete public source differs from the verified commit; retain both versions.');
  }
  return { kind: 'metadata' as const, input };
}

export async function inspectAbsBaselineRecovery(port: AbsSyncStoragePort, project: string) {
  try {
    const classified = await classifyRecovery(port, project);
    const disk = classified.kind === 'metadata' ? classified.input.disk : classified.disk;
    return { version: 1, action: 'recover_project', sameProject: true, candidateApplied: false,
      source: classified.kind === 'metadata' ? 'public-generation' : 'saved-document',
      input: { abiHash: disk.abi === null ? null : await hashAbsText(disk.abi),
        absHash: disk.abs === null ? null : await hashAbsText(disk.abs),
        mapHash: disk.map === null ? null : await hashAbsText(disk.map) } };
  } catch { return null; }
}

export async function recoverAbsBaseline(port: AbsSyncStoragePort, project: string, assertCurrent: () => void) {
  const classified = await classifyRecovery(port, project);
  if (classified.kind !== 'metadata') {
    const { lookup, healthy, disk } = classified;
    if (classified.kind === 'primary') {
      const { abi } = classified;
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
  const { input } = classified;
  const archive = `recoveries/baseline-${crypto.randomUUID()}.json`;
  await port.withLock(async storage => {
    assertCurrent();
    if (absJson(await input.store.captureDisk(storage)) !== absJson(input.disk) || await storage.read('committed.json') !== input.committed) {
      throw new AbsSyncError('ABS_DISK_CONFLICT', 'Baseline recovery inputs changed.');
    }
    if (!await storage.replace(archive, null, absJson({ version: 1, kind: 'baseline-repair', project,
      disk: input.disk, committed: input.committed }))) throw new AbsSyncError('ABS_RECOVERY_ARCHIVE_CONFLICT', 'Could not preserve baseline recovery inputs.');
  });
  const { draftBaseGeneration, authorIntent } = input;
  await input.store.stage({ projection: input.projection, mode: 'import', inputAbs: input.disk.abs, inputMap: input.disk.map, abi: input.disk.abi,
    expected: input.disk, ...(draftBaseGeneration ? { draftBaseGeneration } : {}),
    ...(authorIntent === 'candidate' || authorIntent === 'preserve' ? { authorIntent, metadataOnly: true } : {}),
    ...(!draftBaseGeneration ? { metadataOnly: true } : {}) },
    input.committed === null ? null : await hashAbsText(input.committed));
  assertCurrent();
  const result = await input.store.commit(input.projection.map.generation, assertCurrent, async (text, hash, storage) => {
    assertCurrent();
    if (text !== input.disk.abi || !await storage.replace('project.abi', hash, text)) throw new AbsSyncError('ABS_ABI_COMMIT_CONFLICT', 'The saved primary changed; recovery did not replace it.');
  });
  if (result.status !== 'COMMITTED') throw new AbsSyncError('ABS_RESTORE_INCOMPLETE', result.error ?? 'Baseline metadata recovery is pending.');
  return { changed: true, generation: result.generation, recoveryArchive: archive };
}

/** Fast path for every live entrypoint, including inspect. Ordinary valid maps
 * require no additional baseline decoding. Recovery still verifies complete
 * source and the exact committed chain before replacing only metadata. */
export async function recoverAbsLocationMetadata(port: AbsSyncStoragePort, scope: AbsIdentityMap['scope'], assertCurrent: () => void) {
  const map = await port.read('project.abs.map.json');
  let foreign = false, invalid = map === null, changed = false;
  if (map !== null) {
    try {
      const value = JSON.parse(map);
      invalid = typeof value?.scope?.projectKey !== 'string' || typeof value?.scope?.pageId !== 'string';
      foreign = !invalid && value.scope.projectKey !== scope.projectKey && value.scope.pageId === scope.pageId;
      changed = !foreign && (map !== absJson(value)
        || JSON.parse((await port.read('committed.json')) ?? 'null')?.generation !== value.generation);
    } catch { invalid = true; }
  }
  if (!foreign && !invalid && !changed || await port.read('committed.json') === null) return;
  if (await port.read('prepared.json') !== null) return;
  if (!foreign) {
    try { await new AbsBaselineStore(port, scope).restoreCommittedMap(assertCurrent); return; }
    catch (error) { if ((error as { code?: string })?.code !== 'ABS_MAP_REPAIR_UNPROVEN') throw error; }
    if (!invalid) return;
  }
  if (invalid) {
    try {
      const committed = await new AbsBaselineStore(port, scope).inspectCommitted();
      if (committed?.projection.map.scope.pageId !== scope.pageId) return;
      // An untrusted draft is not input to automatic source decoding/rebind.
      // Leave its exact bytes and bad sidecar to the existing preserving
      // diagnostic path rather than introducing a new read/edit gate.
      if (committed.projection.map.scope.projectKey === scope.projectKey
        && await port.read('project.abs') !== committed.projection.abs) return;
    } catch (error) {
      if (error instanceof AbsSyncError && recoverable.has(error.code)) return;
      throw error;
    }
  }
  assertCurrent();
  try { await recoverAbsBaseline(port, scope.projectKey, assertCurrent); }
  catch (error) {
    // An unadmitted source remains available to the existing read-only conflict
    // inspection. Do not turn automatic metadata repair into a new global gate.
    if (!(error instanceof AbsSyncError)
      || !['ABS_RECOVERY_SOURCE_UNAVAILABLE', 'ABS_SOURCE_CONFLICT', 'ABS_STATE_INVALID'].includes(error.code)) throw error;
  }
  assertCurrent();
}
