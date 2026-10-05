import type { BlocklyProjectDocument } from '../../../editors/blockly-editor/services/blockly-project-model';
import { absJson } from './abs-json';
import { absProgramDocument } from './abs-program-state';
import { AbsSyncError } from './abs-state';

interface ProjectSnapshot { revision: number; document: BlocklyProjectDocument }

/** The revision must come from a fresh full-content observation, not Blockly events.
 * Cache only the pure program comparison. Every call still captures live state,
 * including serializer side effects and changes made without an editor event.
 * Ownership is one preparation phase; no TTL or cross-operation state. */
export function createAbsProjectSnapshotGuard<T extends ProjectSnapshot>(
  baseline: T, capture: () => T, assertContext: () => void,
): () => T {
  const program = absJson(absProgramDocument(baseline.document));
  let acceptedRevision = baseline.revision;
  return () => {
    assertContext();
    const current = capture();
    assertContext(); // A serializer must not silently switch project/runtime.
    if (current.revision !== acceptedRevision) {
      if (absJson(absProgramDocument(current.document)) !== program) {
        throw new AbsSyncError('ABS_REVISION_STALE', 'Workspace changed during generation preparation.');
      }
      // Viewport/layout may settle once and then remain stable for many checks.
      // Its revision proves the same content on the next freshly captured state.
      acceptedRevision = current.revision;
    }
    return current;
  };
}
