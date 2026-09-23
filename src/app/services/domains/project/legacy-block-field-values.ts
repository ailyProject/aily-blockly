import { cloneProjectDataJson, collectProjectBlocks } from './project-data/project-data-payloads';

const LEGACY_ARDUINO_STRING_DECLARATIONS = new Set([
  'variable_define',
  'variable_define_scoped',
  'variable_define_advanced',
  'variable_define_advanced_scoped',
]);

export interface LegacyBlockFieldValueChange {
  jsonPointer: string;
  blockId?: string;
  blockType: string;
  field: 'TYPE';
  oldValue: 'string';
  newValue: 'String';
}

/** Migrate only the verified pre-1.0.1 Arduino String spelling.
 *
 * The core variables package changed the serialized dropdown value from
 * `string` to `String` without changing its package version. Native Blockly
 * field restoration must remain strict for every other unknown dropdown value.
 */
export function migrateLegacyBlockFieldValues<T>(source: T): {
  document: T;
  changes: LegacyBlockFieldValueChange[];
} {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return { document: source, changes: [] };
  }

  const document = cloneProjectDataJson(source);
  const changes: LegacyBlockFieldValueChange[] = [];
  for (const { state, jsonPointer } of collectProjectBlocks(document)) {
    const blockType = state['type'];
    const fields = state['fields'];
    if (typeof blockType !== 'string' || !LEGACY_ARDUINO_STRING_DECLARATIONS.has(blockType)
      || !fields || typeof fields !== 'object' || Array.isArray(fields)
      || fields['TYPE'] !== 'string') continue;

    fields['TYPE'] = 'String';
    changes.push({
      jsonPointer: `${jsonPointer}/fields/TYPE`,
      blockId: typeof state['id'] === 'string' ? state['id'] : undefined,
      blockType,
      field: 'TYPE',
      oldValue: 'string',
      newValue: 'String',
    });
  }

  return changes.length ? { document, changes } : { document: source, changes };
}
