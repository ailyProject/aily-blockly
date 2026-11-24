import { inspectAbsSourceEdits, type AbsSourceEditOrigin, type AbsSourceEdits } from './abs-edit-provenance';
import type { AbsProjection } from './abs-state';
import { AbsSyncError } from './abs-state';

/** Apply only to externally bound candidates. Missing visible program calls are
 * deletions, never an implicit append/patch. Native defaults are not user calls. */
export function assertAbsDeletionIntent(baseline: AbsProjection, candidate: string,
  removed: readonly string[], sourceEdits?: AbsSourceEdits, sourceEditOrigin?: AbsSourceEditOrigin): void {
  const visible = new Set(baseline.map.nodes.map(node => node.blockId));
  const omitted = removed.filter(id => visible.has(id));
  if (!omitted.length) return;
  if (sourceEdits !== undefined) {
    // Exact replay is required; the presence of an edits array is no authority.
    // Matching has already checked identities. Empty AST lists avoid repeating
    // identity analysis while reusing the same complete text replay verifier.
    inspectAbsSourceEdits(baseline.abs, candidate, [], [], sourceEdits, sourceEditOrigin);
    return;
  }
  throw new AbsSyncError('ABS_DELETION_INTENT_REQUIRED',
    'The candidate omits existing program calls without a verified source edit. The current program was retained.',
    undefined, omitted.slice(0, 16), { reason: 'unproven-program-omission', received: omitted.length,
      ...(omitted.length > 16 ? { truncated: true } : {}),
      hint: 'Reapplying this candidate cannot recover deletion proof. Use edit on the exact tracked pre-edit project.abs and preserve other draft changes and host state. If that source is unavailable, keep the draft and report the blocker.' });
}
