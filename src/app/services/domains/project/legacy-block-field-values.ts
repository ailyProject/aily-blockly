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
  field: 'TYPE' | 'RESOLUTION' | 'MODE' | 'SIZE' | 'FONT_TYPE';
  oldValue: string | undefined;
  newValue: string;
}

/** Migrate only verified old dropdown spellings with equivalent current values.
 *
 * Native Blockly field restoration remains strict for every other unknown
 * dropdown value. In particular, never replace an unsupported selection with
 * the current default: that would silently change the generated program.
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
    if (typeof blockType !== 'string' || !fields || typeof fields !== 'object' || Array.isArray(fields)) continue;
    const change = (field: LegacyBlockFieldValueChange['field'], newValue: string) => {
      const oldValue = fields[field] as string | undefined;
      fields[field] = newValue;
      changes.push({ jsonPointer: `${jsonPointer}/fields/${field}`,
        blockId: typeof state['id'] === 'string' ? state['id'] : undefined,
        blockType, field, oldValue, newValue });
    };
    // lib-core-variables changed the Arduino String option without a version bump.
    if (LEGACY_ARDUINO_STRING_DECLARATIONS.has(blockType) && fields['TYPE'] === 'string') {
      change('TYPE', 'String');
    }
    // lib-core-serial's old saved value omitted the call parentheses.
    if (blockType === 'serial_read' && fields['TYPE'] === 'read') {
      change('TYPE', 'read()');
    }
    // Older U8G2 stored the full-buffer suffix in the resolution. The current
    // generator derives that same suffix from MODE instead.
    if (blockType === 'u8g2_begin' && fields['TYPE'] === 'SSD1306'
      && fields['RESOLUTION'] === '128X64_NONAME_F'
      && (fields['MODE'] === undefined || fields['MODE'] === 'FULL_BUFFER')) {
      change('RESOLUTION', '128X64_NONAME');
      if (fields['MODE'] === undefined) change('MODE', 'FULL_BUFFER');
    }
    // The old font picker stored only the exact U8G2 symbol. Keep that symbol;
    // the newer picker needs its category fields to create FONT at load time.
    if (blockType === 'u8g2_set_font' && fields['FONT'] === 'u8g2_font_wqy13_t_chinese2'
      && fields['SIZE'] === undefined && fields['FONT_TYPE'] === undefined) {
      change('SIZE', '14');
      change('FONT_TYPE', 'CHINESE');
    }
  }

  return changes.length ? { document, changes } : { document: source, changes };
}
