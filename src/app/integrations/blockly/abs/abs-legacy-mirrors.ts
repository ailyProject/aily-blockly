import { absMapJson } from './abs-map-json';
import { readSavedBlocklyAbi } from './abs-project-open';
import { absJson, hashAbsText } from './abs-identity-map';
import { AbsBaselineStore, type AbsDiskSnapshot, type AbsSyncStoragePort } from './abs-baseline-store';
import { AbsOperationJournal } from './abs-operation-journal';
import { AbsSyncError } from './abs-state';
import type { AbsIdentityMap, AbsProjection } from './abs-state';

/** These projections predate complete ABS. An old map can identify the
 * displaced public bytes for archival, but cannot grant an apply capability. */
export function isLegacyAbsProjection(version: unknown): boolean {
  return ['abs-v2.preview.3', 'abs-v2.preview.4', 'abs-v2.preview.5', 'abs-v2.preview.6'].includes(version as string);
}

export async function inspectLegacyAbsMirrors(disk: AbsDiskSnapshot, baseline?: AbsProjection) {
  if (baseline ? !isLegacyAbsProjection(baseline.map.projectionVersion) : disk.abs === null && disk.map === null) return undefined;
  const abi = readSavedBlocklyAbi(disk.abi);
  if (!abi) return undefined;
  let map: AbsIdentityMap | undefined;
  try {
    const old = disk.map === null ? undefined : JSON.parse(disk.map);
    if (old?.schemaVersion === 1 && old.absSchemaVersion === 2 && isLegacyAbsProjection(old.projectionVersion)
      && typeof old.generation === 'string' && /^[A-Za-z0-9_-]{1,96}$/.test(old.generation)
      && old.baselineRef === `baselines/${old.generation}.json`
      && typeof old.scope?.projectKey === 'string' && typeof old.scope?.pageId === 'string'
      && /^sha256:[a-f0-9]{64}$/.test(old.baseAbsHash)
      && Array.isArray(old.nodes) && Array.isArray(old.symbols)) map = old;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  const publicCacheMatches = !!map && map.savedAbiHash === await hashAbsText(absJson(abi));
  const absClean = disk.abs === null || (baseline
    ? disk.abs === baseline.abs
    : publicCacheMatches && await hashAbsText(disk.abs) === map!.baseAbsHash);
  const mapClean = disk.map === null || (baseline ? disk.map === absMapJson(baseline.map) : publicCacheMatches);
  return {
    retainMap: !absClean || !mapClean,
    retainDraft: disk.abs !== null && (!absClean || !mapClean),
  };
}

/** Retire only undecodable public mirrors. Their bytes never become a text
 * draft, accepted source, or an input to the normal publisher. */
export async function refreshInvalidAbsMirrors(port: AbsSyncStoragePort, project: string,
  checkSavedCanvas: (abi: string) => Promise<void>, assertCurrent: () => void) {
  const settings = ['project.abs', 'project.abs.map.json'] as const;
  const invalid = Symbol('invalid mirror');
  return port.withLock(async storage => {
    const scope = { ...port, read: key => storage.read(key) };
    const lookup = new AbsBaselineStore(scope, { projectKey: project, pageId: '' });
    const observed = await Promise.all(settings.map(async key => {
      try { return await storage.read(key); }
      catch (error) { if ((error as { code?: string })?.code !== 'ABS_STORAGE_ENCODING_INVALID') throw error; return invalid; }
    }));
    if (!observed.includes(invalid)) return;
    if (!storage.retireInvalidAbsMirror)
      throw new AbsSyncError('ABS_STORAGE_HOST_UNAVAILABLE', 'Legacy byte preservation requires the matching host.');
    const [abi, committed, operation] = await Promise.all(['project.abi', 'committed.json', 'operation.json'].map(key => storage.read(key)));
    if (abi === null || !readSavedBlocklyAbi(abi))
      throw new AbsSyncError('ABS_STORAGE_ENCODING_INVALID', 'Invalid mirror bytes require an independently saved ABI.');
    if (await storage.read('prepared.json') !== null || await new AbsOperationJournal(scope, project).inspect())
      throw new AbsSyncError('ABS_TRANSACTION_PENDING', 'The original transaction still owns the program.');
    await checkSavedCanvas(abi); assertCurrent();
    const accepted = await lookup.readCommittedSnapshot(), mode = await lookup.workspaceMode(storage);
    const canonical = accepted && (mode === 'project-v1' || !isLegacyAbsProjection(accepted.projection.map.projectionVersion)) ? accepted : null;
    if ((canonical && canonical.abi !== abi) || (!canonical && mode === 'project-v1'))
      throw new AbsSyncError('ABS_DUAL_EDIT_CONFLICT', 'The original accepted program cannot verify mirror recovery.');
    const replacements = canonical ? [canonical.projection.abs, absMapJson(canonical.projection.map)] : [null, null];
    const digest = (value: string | null) => value === null ? null : hashAbsText(value);
    const abiHash = await hashAbsText(abi), committedHash = await digest(committed), operationHash = await digest(operation);
    // The map describes the accepted ABI. A distinct author stays untouched
    // and its exact bytes are a CAS preimage, even when they do not parse.
    const author = observed[0] === invalid ? replacements[0] : observed[0];
    const absHash = await digest(author ?? (mode === 'overlay-v1' ? canonical?.projection.abs ?? null : null));
    for (const [index, key] of settings.entries()) {
      if (observed[index] !== invalid) continue;
      assertCurrent();
      if (!await storage.retireInvalidAbsMirror({ key, abiHash, committedHash, operationHash,
        ...(key === 'project.abs.map.json' && absHash ? { absHash } : {}), replacement: replacements[index] }))
        throw new AbsSyncError('ABS_DISK_CONFLICT', 'The original invalid mirror changed before recovery.');
    }
    assertCurrent();
  });
}
