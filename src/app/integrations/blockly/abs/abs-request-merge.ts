import type { AbsAbiWorkspace } from './abs-state';
import { mergeAbsStrictDocument } from './abs-strict-document-merge';

/** Apply the candidate's proven delta by stable identity. A real overlap is
 * retained as a conflict; a deleted user path is never implicitly restored. */
export function mergeAbsRequestWorkspace(
  base: AbsAbiWorkspace,
  current: AbsAbiWorkspace,
  target: AbsAbiWorkspace,
): AbsAbiWorkspace {
  return mergeAbsStrictDocument(base, current, target);
}
