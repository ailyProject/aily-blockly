import { cloneProjectDataJson, collectProjectBlocks } from './project-data/project-data-payloads';

export interface LegacyBlockShapeChange {
  jsonPointer: string;
  blockId?: string;
  blockType: 'blinker_widget_print' | 'controls_ifelse';
  oldItemCount?: number;
  newExtraCount?: number;
  addedHasElse?: true;
}

/** Reconstruct only legacy mutator state corroborated by saved connections. */
export function migrateLegacyBlockShapeValues<T>(source: T): { document: T; changes: LegacyBlockShapeChange[] } {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return { document: source, changes: [] };
  const document = cloneProjectDataJson(source);
  const changes: LegacyBlockShapeChange[] = [];
  for (const { state, jsonPointer } of collectProjectBlocks(document)) {
    const extraState = state['extraState'], inputs = state['inputs'];
    const extra = extraState && typeof extraState === 'object' && !Array.isArray(extraState)
      ? extraState as Record<string, any> : undefined;
    if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) continue;
    const blockId = typeof state['id'] === 'string' ? state['id'] : undefined;
    if (state['type'] === 'blinker_widget_print') {
      if (extraState !== undefined && (!extra || Object.hasOwn(extra, 'extraCount'))) continue;
      if (extra && !Object.hasOwn(extra, 'itemCount')) continue;

      const names = Object.keys(inputs);
      const count = extra ? extra['itemCount'] : names.length;

      if (!Number.isSafeInteger(count) || count < 2 || count > 1025 || !names.length) continue;

      // Blockly omits unconnected input slots. INPUT0 belongs to the base block.
      const slots = names.map(name => Number(/^INPUT(0|[1-9]\d*)$/u.exec(name)?.[1]));

      if (slots.some(slot => !Number.isSafeInteger(slot) || slot >= count)) continue;

      const newExtraCount = Math.max(...slots);

      if (extra) delete extra['itemCount'];

      if (newExtraCount || (extra && Object.keys(extra).length)) {
        state['extraState'] = { ...extra, ...(newExtraCount ? { extraCount: newExtraCount } : {}) };
      } else {
        delete state['extraState'];
      }

      changes.push({ jsonPointer: `${jsonPointer}/extraState`, blockId,
        blockType: 'blinker_widget_print', oldItemCount: count, newExtraCount });
    } else if (state['type'] === 'controls_ifelse' && Object.hasOwn(inputs, 'ELSE')
      && (extraState === undefined || extra && !Object.hasOwn(extra, 'hasElse'))) {
      state['extraState'] = { ...extra, hasElse: true };
      changes.push({ jsonPointer: `${jsonPointer}/extraState`, blockId,
        blockType: 'controls_ifelse', addedHasElse: true });
    }
  }
  return changes.length ? { document, changes } : { document: source, changes };
}
