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
      const count = extra?.['itemCount'] ?? Object.keys(inputs).length;
      if (!Number.isSafeInteger(count) || count < 2 || Object.keys(inputs).length !== count
        || Array.from({ length: count }, (_, i) => `INPUT${i}`).some(name => !Object.hasOwn(inputs, name))) continue;
      if (extra && !Object.hasOwn(extra, 'itemCount')) continue;
      if (extra) delete extra['itemCount'];
      state['extraState'] = { ...extra, extraCount: count - 1 };
      changes.push({ jsonPointer: `${jsonPointer}/extraState`, blockId,
        blockType: 'blinker_widget_print', oldItemCount: count, newExtraCount: count - 1 });
    } else if (state['type'] === 'controls_ifelse' && Object.hasOwn(inputs, 'ELSE')
      && (extraState === undefined || extra && !Object.hasOwn(extra, 'hasElse'))) {
      state['extraState'] = { ...extra, hasElse: true };
      changes.push({ jsonPointer: `${jsonPointer}/extraState`, blockId,
        blockType: 'controls_ifelse', addedHasElse: true });
    }
  }
  return changes.length ? { document, changes } : { document: source, changes };
}
