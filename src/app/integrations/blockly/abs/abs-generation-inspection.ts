import { AbsBaselineStore, AbsDiskSnapshot } from './abs-baseline-store';
import { absJson, hashAbsText } from './abs-identity-map';
import { ABS_PROJECTION_VERSION, AbsIdentityMap, AbsSyncError } from './abs-state';

/** Disk diagnosis is separate from workspace preparation and never grants apply authority. */
export async function inspectAbsGeneration(store: AbsBaselineStore, scope: AbsIdentityMap['scope']) {
  const disk = await store.captureDisk();
  const pending = await store.inspectPending();
  const committed = await store.inspectCommitted();
  const baseline = committed?.projection;
  const issues: string[] = [];
  if (pending) issues.push('ABS_TRANSACTION_PENDING');
  if (!baseline) issues.push(disk.map === null ? 'ABS_INITIALIZATION_REQUIRED' : 'ABS_BASELINE_MISSING');
  else {
    if (baseline.map.projectionVersion !== ABS_PROJECTION_VERSION) issues.push('ABS_PROJECTION_UPGRADE_REQUIRED');
    if (absJson(baseline.map.scope) !== absJson(scope)) issues.push('ABS_SCOPE_INVALID');
    if (disk.map !== absJson(baseline.map)) issues.push('ABS_MAP_INVALID');
    if (disk.abs !== baseline.abs) issues.push('ABS_SOURCE_CONFLICT');
  }
  if (disk.abi === null) issues.push('ABS_SAVED_ABI_REQUIRED');
  const canRebind = !!baseline && issues.length > 0
    && issues.every(issue => ['ABS_SCOPE_INVALID', 'ABS_MAP_INVALID', 'ABS_PROJECTION_UPGRADE_REQUIRED'].includes(issue));
  const hashes = await hashAbsDisk(disk);
  const rebind = canRebind ? { token: await hashAbsText(absJson({ scope, hashes, committed: committed!.pointerHash })),
    from: baseline!.map.scope, to: scope } : undefined;
  // Detect an external writer during the asynchronous inspection as well as at commit.
  const current = await store.captureDisk();
  const latest = await store.inspectCommitted();
  if (absJson(current) !== absJson(disk) || latest?.pointerHash !== committed?.pointerHash
    || absJson(await store.inspectPending()) !== absJson(pending)) {
    throw new AbsSyncError('ABS_BASELINE_STALE', 'Generation changed during inspection; inspect again before acting.');
  }
  return { disk, committed, pending, diagnostics: { scope, generation: baseline?.map.generation,
    baselineScope: baseline?.map.scope, issues, hashes,
    status: rebind ? 'rebind-required' : issues.length ? 'blocked' : 'ready', ...(rebind ? { rebind } : {}) } };
}

async function hashAbsDisk(disk: AbsDiskSnapshot) {
  const hash = (value: string | null) => value === null ? null : hashAbsText(value);
  return { abi: await hash(disk.abi), abs: await hash(disk.abs), map: await hash(disk.map) };
}
