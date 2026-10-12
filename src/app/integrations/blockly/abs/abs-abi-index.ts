import { AbsAbiBlock, AbsAbiWorkspace, AbsSyncError } from './abs-state';

export function indexAbsAbi(workspace: AbsAbiWorkspace): Map<string, AbsAbiBlock> {
  if (!workspace || !Array.isArray(workspace.blocks?.blocks) || Object.hasOwn(workspace, 'pages')) {
    throw new AbsSyncError('ABS_SCOPE_INVALID', 'Expected one composed workspace, not a multi-page document.');
  }
  const blocks = new Map<string, AbsAbiBlock>();
  const seen = new Set<object>();
  // Sequential statements are siblings, even though Blockly stores next links
  // as nested JSON. Bound input nesting separately from the complete graph.
  const pending = workspace.blocks.blocks.map(block => ({ block, depth: 0 })).reverse();
  while (pending.length) {
    const { block, depth } = pending.pop()!;
    if (!block || typeof block !== 'object' || typeof block.id !== 'string' || !block.id || !/^[A-Za-z_]\w*$/.test(block.type)) {
      throw new AbsSyncError('ABS_ABI_INVALID', 'Each serialized block requires a type and stable ID.');
    }
    if (depth > 128 || blocks.size >= 100000) {
      const resource = depth > 128 ? 'inputDepth' : 'blocks';
      throw new AbsSyncError('ABS_LIMIT', 'ABI exceeds structural limits.', undefined, [block.id], {
        reason: 'abi-capacity', capacity: { phase: 'index', resource, actual: depth > 128 ? depth : blocks.size + 1, limit: depth > 128 ? 128 : 100000 },
        hint: 'Retain the complete ABS and project. Report this capacity diagnostic; do not retry unchanged requests or recount the workspace with shell scripts.',
      });
    }
    if (seen.has(block) || blocks.has(block.id)) {
      throw new AbsSyncError('ABS_DUPLICATE_ID', 'Repeated identity, cycle or multiple parents.', undefined, [block.id]);
    }
    seen.add(block);
    blocks.set(block.id, block);
    const children: Array<{ block: AbsAbiBlock; depth: number }> = [];
    for (const input of Object.values(block.inputs ?? {})) {
      if (!input || typeof input !== 'object') throw new AbsSyncError('ABS_ABI_INVALID', 'Invalid input.');
      if (input.block) children.push({ block: input.block, depth: depth + 1 });
      if (input.shadow) children.push({ block: input.shadow, depth: depth + 1 });
    }
    if (block.next?.block) children.push({ block: block.next.block, depth });
    pending.push(...children.reverse());
  }
  return blocks;
}
