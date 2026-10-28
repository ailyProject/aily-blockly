import { indexAbsAbi } from './abs-abi-index';
import { isAbsBlockDisabled, type AbsAbiBlock, type AbsAbiWorkspace } from './abs-state';

/** Executable activity in serialized Blockly topology. Inputs belong to their
 * owner; next statements share its outer scope. A covered shadow is persisted
 * fallback data, never an executable definition or call. Structural/identity
 * admission still covers every inactive block and dormant shadow. */
export function indexAbsBlockActivity(workspace: AbsAbiWorkspace): ReadonlyMap<string, boolean> {
  indexAbsAbi(workspace);
  const active = new Map<string, boolean>();
  const pending: Array<{ block: AbsAbiBlock; outerActive: boolean }> = workspace.blocks.blocks
    .map(block => ({ block, outerActive: true })).reverse();
  while (pending.length) {
    const { block, outerActive } = pending.pop()!;
    const enabled = outerActive && !isAbsBlockDisabled(block);
    active.set(block.id, enabled);
    if (block.next?.block) pending.push({ block: block.next.block, outerActive });
    const inputs = Object.values(block.inputs ?? {});
    for (let index = inputs.length - 1; index >= 0; index--) {
      const input = inputs[index];
      if (input.shadow) pending.push({ block: input.shadow, outerActive: enabled && !input.block });
      if (input.block) pending.push({ block: input.block, outerActive: enabled });
    }
  }
  return active;
}
