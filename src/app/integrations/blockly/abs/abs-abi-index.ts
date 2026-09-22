import { AbsAbiBlock, AbsAbiWorkspace, AbsSyncError } from './abs-state';

export function indexAbsAbi(workspace: AbsAbiWorkspace): Map<string, AbsAbiBlock> {
  if (!workspace || !Array.isArray(workspace.blocks?.blocks) || Object.hasOwn(workspace, 'pages')) {
    throw new AbsSyncError('ABS_SCOPE_INVALID', 'Expected one composed workspace, not a multi-page document.');
  }
  const blocks = new Map<string, AbsAbiBlock>();
  const seen = new Set<object>();
  const visit = (block: AbsAbiBlock, depth: number) => {
    if (!block || typeof block !== 'object' || typeof block.id !== 'string' || !block.id || !/^[A-Za-z_]\w*$/.test(block.type)) {
      throw new AbsSyncError('ABS_ABI_INVALID', 'Each serialized block requires a type and stable ID.');
    }
    if (depth > 128 || blocks.size >= 100000) throw new AbsSyncError('ABS_LIMIT', 'ABI exceeds structural limits.');
    if (seen.has(block) || blocks.has(block.id)) {
      throw new AbsSyncError('ABS_DUPLICATE_ID', 'Repeated identity, cycle or multiple parents.', undefined, [block.id]);
    }
    seen.add(block);
    blocks.set(block.id, block);
    for (const input of Object.values(block.inputs ?? {})) {
      if (!input || typeof input !== 'object') throw new AbsSyncError('ABS_ABI_INVALID', 'Invalid input.');
      if (input.block) visit(input.block, depth + 1);
      if (input.shadow) visit(input.shadow, depth + 1);
    }
    if (block.next?.block) visit(block.next.block, depth + 1);
  };
  workspace.blocks.blocks.forEach(block => visit(block, 0));
  return blocks;
}
