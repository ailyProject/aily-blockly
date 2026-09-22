import { indexAbsAbi } from './abs-identity-map';
import { AbsAbiWorkspace, AbsSyncError } from './abs-state';
export { assertAbsReadback } from './abs-readback';

/** Blockly's deletable flag protects UI gestures, not serialization.load/clear. */
export function assertAbsProtectedBlocks(baseline: AbsAbiWorkspace, candidate: AbsAbiWorkspace): void {
  const before = indexAbsAbi(baseline);
  const after = indexAbsAbi(candidate);
  for (const block of before.values()) {
    if (block['deletable'] !== false) continue;
    const next = after.get(block.id);
    const fail = (reason: string) => {
      throw new AbsSyncError(`ABS_PROTECTED_BLOCK_${reason}`, `Protected block ${block.type} cannot be removed, replaced or unlocked.`, undefined, [block.id], {
        blockType: block.type, reason: `protected-block-${reason.toLowerCase()}`,
        hint: `Keep the protected ${block.type} call from project.abs with its arguments and parent, including empty roots in minimal diagnostics. Repair the candidate; do not reset the baseline, recover the project or create variable models for this error.`,
      });
    };
    if (!next) fail('MISSING');
    if (next.type !== block.type) fail('TYPE_CHANGED');
    if (next['deletable'] !== false) fail('UNLOCK');
  }
}
