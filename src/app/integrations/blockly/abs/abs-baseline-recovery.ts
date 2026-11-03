import type { AbsBaselineStore } from './abs-baseline-store';
import { inspectAbsGeneration } from './abs-generation-inspection';
import { AbsSyncError, type AbsIdentityMap } from './abs-state';

const recoverable = new Set(['ABS_BASELINE_CORRUPT', 'ABS_BASELINE_MISSING']);
export const ABS_BASELINE_RECOVERY_HINT = 'Preserve source, candidate, staging and private records. Call project_recover(action="fork"); host verifies complete source/ownership. Do not delete locks/baselines, overwrite ABI/map or clear the source guard. Reapply on the verified copy.';

/** Read-only recovery diagnosis must not depend on repairing its own journal.
 * Only errors from this private-store inspection get this recovery fact. The
 * normal fork rechecks loading/source completeness and active ownership. */
export async function inspectAbsGenerationForRecovery(store: AbsBaselineStore, scope: AbsIdentityMap['scope']) {
  try { return await inspectAbsGeneration(store, scope); }
  catch (error) {
    if (!(error instanceof AbsSyncError) || !recoverable.has(error.code)) throw error;
    throw new AbsSyncError(error.code, error.message, error.range, error.blockIds,
      { reason: 'baseline-unavailable', hint: ABS_BASELINE_RECOVERY_HINT });
  }
}
