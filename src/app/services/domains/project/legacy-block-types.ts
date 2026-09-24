import { cloneProjectDataJson, collectProjectBlocks } from './project-data/project-data-payloads';

export interface LegacyBlockTypeChange {
  jsonPointer: string;
  blockId?: string;
  oldType: 'fastled_refresh';
  newType: 'fastled_show';
}

/** The old no-argument FastLED refresh block is the current show block. */
export function migrateLegacyBlockTypes<T>(source: T): { document: T; changes: LegacyBlockTypeChange[] } {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return { document: source, changes: [] };
  const document = cloneProjectDataJson(source);
  const changes: LegacyBlockTypeChange[] = [];
  for (const { state, jsonPointer } of collectProjectBlocks(document)) {
    if (state['type'] !== 'fastled_refresh' || state['fields'] !== undefined
      || state['inputs'] !== undefined || state['extraState'] !== undefined) continue;
    state['type'] = 'fastled_show';
    changes.push({ jsonPointer: `${jsonPointer}/type`,
      blockId: typeof state['id'] === 'string' ? state['id'] : undefined,
      oldType: 'fastled_refresh', newType: 'fastled_show' });
  }
  return changes.length ? { document, changes } : { document: source, changes };
}
