import { inspectAbsSourceEdits, type AbsSourceEdits } from './abs-edit-provenance';
import type { AbsProjection } from './abs-state';
import { AbsSyncError } from './abs-state';

/** Apply only to externally bound candidates. Missing visible program calls are
 * deletions, never an implicit append/patch. Native defaults are not user calls. */
export function assertAbsDeletionIntent(baseline: AbsProjection, candidate: string,
  removed: readonly string[], sourceEdits?: AbsSourceEdits): void {
  const visible = new Set(baseline.map.nodes.map(node => node.blockId));
  const omitted = removed.filter(id => visible.has(id));
  if (!omitted.length) return;
  if (sourceEdits !== undefined) {
    // Exact replay is required; the presence of an edits array is no authority.
    // Matching has already checked identities. Empty AST lists avoid repeating
    // identity analysis while reusing the same complete text replay verifier.
    inspectAbsSourceEdits(baseline.abs, candidate, [], [], sourceEdits);
    return;
  }
  throw new AbsSyncError('ABS_DELETION_INTENT_REQUIRED',
    'The candidate omits existing program calls without a verified source edit. The current program was retained.',
    undefined, omitted.slice(0, 16), { reason: 'unproven-program-omission', received: omitted.length,
      ...(omitted.length > 16 ? { truncated: true } : {}),
      hint: 'Preserve the complete candidate and continue by editing the original tracked project.abs. Unmentioned program sections are not an append or an authorized deletion. Normal tracked deletions are accepted after exact replay. Do not reload, fork, change generation or ask the user to switch projects to resolve this candidate error.' });
}
