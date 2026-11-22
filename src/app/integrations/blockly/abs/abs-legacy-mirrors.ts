import { absMapJson } from './abs-map-json';
import { readSavedBlocklyAbi } from './abs-project-open';
import { absJson, hashAbsText } from './abs-identity-map';
import type { AbsDiskSnapshot } from './abs-baseline-store';
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
