import { AbsSyncError } from '../../../integrations/blockly/abs/abs-state';

/** Bounded execution stages, never library source, field values or filesystem paths. */
export const NATIVE_CANDIDATE_PHASES = ['asset', 'realm', 'replay', 'binding', 'views', 'ui', 'load', 'resources', 'generate', 'readback', 'cleanup'] as const;
export type NativeCandidatePhase = typeof NATIVE_CANDIDATE_PHASES[number];
export type NativeCandidateProgress = (phase: NativeCandidatePhase) => void;

/** One bounded execution per fresh realm. A caller-supplied deadline still
 * bounds the complete evaluation; it is never multiplied by the pass count. */
export function nativeCandidateBudget(timeoutMs: number | undefined, passes: 1 | 2) {
  const perPassMs = timeoutMs ?? 10000;
  if (!Number.isFinite(perPassMs) || perPassMs <= 0 || perPassMs > 60000) throw new Error('Invalid native candidate timeout.');
  return { perPassMs, totalMs: timeoutMs ?? perPassMs * passes };
}

export function nativeCandidateTimeout(phase: NativeCandidatePhase, timeoutMs: number): AbsSyncError {
  return new AbsSyncError('ABS_NATIVE_TIMEOUT', `Native candidate timed out during ${phase} (${Math.round(timeoutMs)}ms budget).`, undefined, [], {
    reason: `native-timeout-${phase}`,
    hint: 'Preparation timed out before apply; do not repeat unchanged requests. Retain ABS; report draft path/phase/incomplete status. Ask the user to retry after reducing load or restarting the updated host. If publication is UNKNOWN, inspect project_recover.',
  });
}
