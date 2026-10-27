import type * as Blockly from 'blockly';
import { ABS_MANUAL_DISABLED_REASON, type AbsBlockState, type AbsBlockStateInspectRequest,
  type AbsBlockStatePlan } from '../../../integrations/blockly/abs/abs-block-state';
import { AbsSyncError } from '../../../integrations/blockly/abs/abs-state';

type Workspace = Pick<Blockly.Workspace, 'getAllBlocks' | 'getBlockById'>;
const reasons = (block: Blockly.Block) => [...block.getDisabledReasons()];
const sameReasons = (left: string[], right: string[]) => JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
const state = (block: Blockly.Block): AbsBlockState => ({ blockId: block.id, type: block.type,
  disabled: !block.isEnabled(), manualDisabled: block.getDisabledReasons().has(ABS_MANUAL_DISABLED_REASON),
  disabledReasons: reasons(block), collapsed: block.isCollapsed(), editable: block.isEditable() });

/** Bounded ID discovery: no field getters, serializers, guesses, or workspace mutation. */
export function inspectLiveBlockStates(workspace: Workspace, request: AbsBlockStateInspectRequest) {
  const ids = request.blockIds && new Set(request.blockIds), types = request.blockTypes && new Set(request.blockTypes);
  const matched = workspace.getAllBlocks(false).filter(block => (!ids || ids.has(block.id)) && (!types || types.has(block.type)))
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const offset = request.offset ?? 0, limit = request.limit ?? 50;
  const instances = matched.slice(offset, offset + limit).map(state);
  return { instances, totalMatches: matched.length, offset, limit, truncated: offset + instances.length < matched.length };
}

/** Prepare once under the normal edit lease. Every target is checked before the first setter.
 * Restore owns only the manual reason and collapse flag; it cannot erase library reasons.
 * The coordinator must additionally verify the complete project and publication outcome. */
export function prepareLiveBlockStateOperation(workspace: Workspace, plan: AbsBlockStatePlan, assertCurrent: () => void) {
  const entries = plan.beforeStates.map((before, index) => ({ before, after: plan.states[index],
    block: workspace.getBlockById(before.blockId) }));
  const assertTargets = (initial: boolean) => {
    assertCurrent();
    for (const entry of entries) {
      const block = workspace.getBlockById(entry.before.blockId);
      if (!entry.block || block !== entry.block || block.type !== entry.before.type) {
        throw new AbsSyncError('ABS_BLOCK_STATE_UNAVAILABLE', 'The requested block is not a current live instance.', undefined, [entry.before.blockId]);
      }
      if (initial && !block.isEditable()) throw new AbsSyncError('ABS_STATE_EDIT_FORBIDDEN', 'The live block is not editable.', undefined, [block.id]);
      if (initial && (!sameReasons(reasons(block), entry.before.disabledReasons) || block.isCollapsed() !== entry.before.collapsed)) {
        throw new AbsSyncError('ABS_BLOCK_STATE_STALE', 'Block state changed after planning. Inspect again before updating.', undefined, [block.id]);
      }
    }
    assertCurrent();
  };
  assertTargets(true);
  const states = () => entries.map(entry => state(entry.block!));
  const touched = new Map<Blockly.Block, Set<'disabled' | 'collapsed'>>();
  const mark = (block: Blockly.Block, property: 'disabled' | 'collapsed') => {
    const properties = touched.get(block) ?? new Set<'disabled' | 'collapsed'>();
    properties.add(property); touched.set(block, properties);
  };
  return {
    states,
    apply() {
      assertTargets(true);
      for (const { block, before, after } of entries) {
        if (before.manualDisabled !== after.manualDisabled) {
          mark(block!, 'disabled'); block!.setDisabledReason(after.manualDisabled, ABS_MANUAL_DISABLED_REASON);
        }
        if (before.collapsed !== after.collapsed) { mark(block!, 'collapsed'); block!.setCollapsed(after.collapsed); }
      }
      assertTargets(false);
      const actual = states();
      if (actual.some((value, index) => !sameReasons(value.disabledReasons, plan.states[index].disabledReasons)
        || value.collapsed !== plan.states[index].collapsed)) {
        throw new AbsSyncError('ABS_BLOCK_STATE_READBACK_MISMATCH', 'Native callbacks did not retain the requested block state.');
      }
      return actual;
    },
    restore() {
      assertTargets(false);
      for (const { block, before } of entries) {
        if (touched.get(block!)?.has('disabled') && block!.getDisabledReasons().has(ABS_MANUAL_DISABLED_REASON) !== before.manualDisabled)
          block!.setDisabledReason(before.manualDisabled, ABS_MANUAL_DISABLED_REASON);
        if (touched.get(block!)?.has('collapsed') && block!.isCollapsed() !== before.collapsed) block!.setCollapsed(before.collapsed);
      }
      assertTargets(false);
      const restored = states();
      if (restored.some((value, index) => touched.get(entries[index].block!)?.has('disabled')
        && value.manualDisabled !== plan.beforeStates[index].manualDisabled
        || touched.get(entries[index].block!)?.has('collapsed') && value.collapsed !== plan.beforeStates[index].collapsed)) {
        throw new AbsSyncError('ABS_BLOCK_STATE_ROLLBACK_FAILED', 'Native callbacks prevented tracked block state restoration.');
      }
      touched.clear();
      return restored;
    },
  };
}
