import type * as Blockly from 'blockly';

/** Own enabled state plus enclosing inputs, not earlier statements in a next
 * chain. Own this lookup for one synchronous snapshot/capture only: cached
 * topology and disabled state are not valid across edits or native callbacks. */
export function createBlocklyBlockActivity(): (block: Blockly.Block) => boolean {
  const enabled = new Map<Blockly.Block, boolean>();
  const surrounding = new Map<Blockly.Block, Blockly.Block | null>();
  const surround = (block: Blockly.Block): Blockly.Block | null => {
    if (surrounding.has(block)) return surrounding.get(block)!;
    const chain: Blockly.Block[] = [], seen = new Set<Blockly.Block>();
    let current = block, parent: Blockly.Block | null;
    while (true) {
      if (surrounding.has(current)) { parent = surrounding.get(current)!; break; }
      if (seen.has(current)) throw new Error('Blockly activity requires acyclic block connections.');
      seen.add(current); chain.push(current);
      parent = current.getParent?.() ?? null;
      // This is bundled Blockly.getSurroundParent's rule. Cache the skipped
      // next edges too, so querying every owner in a long stack stays linear.
      if (!parent || parent.getNextBlock?.() !== current) break;
      current = parent;
    }
    for (const entry of chain) surrounding.set(entry, parent);
    return parent;
  };
  return block => {
    const chain: Blockly.Block[] = [], seen = new Set<Blockly.Block>();
    let current: Blockly.Block | null = block, active = true;
    while (current && !enabled.has(current)) {
      if (seen.has(current)) throw new Error('Blockly activity requires acyclic block connections.');
      seen.add(current); chain.push(current);
      if (!current.isEnabled()) { active = false; break; }
      current = surround(current);
    }
    if (current && enabled.has(current)) active = enabled.get(current)!;
    for (const entry of chain) enabled.set(entry, active);
    return active;
  };
}

/** Convenience for a single observation. Bulk readers should share a fresh
 * createBlocklyBlockActivity lookup within their synchronous read boundary. */
export function isBlocklyBlockActive(block: Blockly.Block): boolean {
  return createBlocklyBlockActivity()(block);
}
