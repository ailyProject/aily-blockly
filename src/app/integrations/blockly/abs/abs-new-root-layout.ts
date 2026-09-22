import type * as Blockly from 'blockly';
import { AbsAbiWorkspace, AbsSyncError } from './abs-state';

/** Layout only new roots, using measured stacks after the one authorized load.
 * Existing coordinates are never tidied. Seal the resulting coordinates into
 * the expected candidate before complete readback and the persistence revision.
 */
export function layoutAbsNewRoots(
  expected: AbsAbiWorkspace, added: readonly string[], workspace: Blockly.WorkspaceSvg, assertCurrent: () => void,
): void {
  const ids = new Set(added), roots = expected.blocks.blocks.filter(block => ids.has(block.id));
  if (!roots.length || typeof workspace.render !== 'function') return; // Headless workspaces have no UI layout.
  assertCurrent();
  const runtime = window['Blockly'] as typeof Blockly;
  const measure = (block: Blockly.BlockSvg) => {
    const rect = block.getBoundingRectangle();
    if (![rect.top, rect.bottom, rect.left, rect.right].every(Number.isFinite) || rect.bottom < rect.top) {
      throw new AbsSyncError('ABS_LAYOUT_UNAVAILABLE', 'New block layout has invalid runtime bounds.', undefined, [block.id]);
    }
    return rect;
  };
  let y = 30;
  for (const block of workspace.getTopBlocks(false)) if (!ids.has(block.id)) y = Math.max(y, measure(block).bottom + 48);
  runtime.Events.disable();
  try {
    for (const state of roots) {
      assertCurrent();
      const block = workspace.getBlockById(state.id);
      if (!block || block.getParent()) throw new AbsSyncError('ABS_LAYOUT_UNAVAILABLE', 'A prepared new root was not loaded as a root.');
      const rect = measure(block), position = block.getRelativeToSurfaceXY();
      if (![position.x, position.y].every(Number.isFinite)) throw new AbsSyncError('ABS_LAYOUT_UNAVAILABLE', 'New root has invalid coordinates.');
      block.moveBy((workspace.RTL ? -30 : 30) - position.x, y - rect.top);
      const placed = block.getRelativeToSurfaceXY();
      if (![placed.x, placed.y].every(Number.isFinite)) throw new AbsSyncError('ABS_LAYOUT_UNAVAILABLE', 'New root layout returned invalid coordinates.');
      state['x'] = placed.x; state['y'] = placed.y;
      y += rect.bottom - rect.top + 48;
    }
  } finally { runtime.Events.enable(); }
  assertCurrent();
}
