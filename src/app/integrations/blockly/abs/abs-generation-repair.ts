import { absJson, hashAbsText } from './abs-identity-map';
import { absProgramDocument } from './abs-program-state';
import type { inspectAbsGeneration } from './abs-generation-inspection';
import type { AbsProjectionContracts } from './abs-state';

export interface AbsRecoveryArchive {
  generation: string;
  key: string;
  hash: string;
  files: Record<'abi' | 'abs' | 'map' | 'committed' | 'baseline', { hash: string | null; bytes: number }>;
  draft: { hash: string | null; bytes: number };
}

/** A repair grants authority to rebuild derivatives, never to accept an old AI candidate. */
export async function describeAbsRepair(
  inspection: Awaited<ReturnType<typeof inspectAbsGeneration>>, document: unknown, contracts: AbsProjectionContracts,
) {
  if (!inspection.committed || inspection.pending || inspection.disk.abi === null || !inspection.diagnostics.issues.length
    || inspection.diagnostics.issues.some(issue => !['ABS_SCOPE_INVALID', 'ABS_MAP_INVALID', 'ABS_SOURCE_CONFLICT',
      'ABS_PROJECTION_UPGRADE_REQUIRED', 'ABS_BASELINE_STALE', 'ABS_DUAL_EDIT_CONFLICT', 'ABS_RUNTIME_CONTRACT_STALE'].includes(issue))) return undefined;
  const token = await hashAbsText(absJson({ version: 1, authority: 'workspace', scope: inspection.diagnostics.scope,
    hashes: inspection.diagnostics.hashes, committed: inspection.committed.pointerHash,
    document: absProgramDocument(document), contracts }));
  return { token, authority: 'workspace' as const, action: 'repair' as const,
    preserves: ['project.abs', 'project.abs.map.json', 'project.abi', 'committed-pointer', 'workspace'] };
}
