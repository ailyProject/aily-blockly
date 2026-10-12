import { AbsSyncError } from '../../../integrations/blockly/abs/abs-state';

/** Operational bounds, shared by the host and the disposable native runtime.
 * Increasing a budget requires real full-pipeline measurements, not only a parser test. */
export const NATIVE_CANDIDATE_LIMITS = Object.freeze({
  blocks: 16384, identities: 16384, createdBlocks: 32768, defaultCreations: 16384,
  variables: 2000, hostCalls: 2000, arguments: 2000, resources: 2000,
  declarations: 2000, requestCharacters: 16 * 1024 * 1024,
});

export function assertNativeBudget(resource: keyof typeof NATIVE_CANDIDATE_LIMITS, actual: number,
  phase: 'request' | 'creation' | 'model-preparation'): void {
  const limit = NATIVE_CANDIDATE_LIMITS[resource];
  if (actual <= limit) return;
  const hint = 'Keep the original project. Extract repeated/cohesive logic into a local Blockly library, replace it with fewer high-level blocks, then validate and build. Preserve behavior; do not delete functionality or retry the same oversized ABS.';
  throw new AbsSyncError('ABS_LIMIT', `Native candidate ${resource} count ${actual} exceeds limit ${limit} (${phase}).`,
    undefined, [], { reason: 'native-capacity', capacity: { phase, resource, actual, limit }, hint });
}
