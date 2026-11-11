import { tftMediaSize, u8g2BitmapSize } from '@domain/project/project-data/public-api';
import type { DeclarativeBlockSnapshot } from '../../editors/blockly-editor/services/blockly-declarative-block-catalog';

export type MediaKind = 'tft_image' | 'tft_animation' | 'u8g2_bitmap';

export interface MediaImportTarget {
  blockType: string;
  fieldName?: string;
}

export interface BoundMediaImportTarget {
  kind: MediaKind;
  blockType: string;
  fieldName: string;
  fieldType: string;
  width: number;
  height: number;
  assertCurrent(): void;
}

function mediaKind(field: Record<string, any>): MediaKind | undefined {
  if (field['type'] === 'field_bitmap_u8g2') return 'u8g2_bitmap';
  if (field['type'] === 'field_tftespi_image') return 'tft_image';
  if (field['type'] === 'field_tftespi_animation') return field['imageMode'] === true ? 'tft_image' : 'tft_animation';
}

/** Bind to registered field declarations without creating a probe block. */
export function bindMediaImportTarget(target: MediaImportTarget, definitions: DeclarativeBlockSnapshot,
  assertCurrent: () => void): BoundMediaImportTarget {
  if (!target || typeof target.blockType !== 'string' || !target.blockType || target.blockType.length > 256
    || target.fieldName !== undefined && (typeof target.fieldName !== 'string' || !target.fieldName || target.fieldName.length > 256)) {
    throw new Error('A target Blockly block type and optional field name are required.');
  }
  const definition = definitions.get(target.blockType);
  if (!definition) throw new Error(`No registered field declaration is available for ${target.blockType}.`);
  const fields = Object.keys(definition).filter(key => /^args\d+$/.test(key) && Array.isArray(definition[key]))
    .flatMap(key => definition[key] as Array<Record<string, any>>)
    .filter(field => field && typeof field['name'] === 'string' && mediaKind(field));
  const matches = target.fieldName === undefined ? fields : fields.filter(field => field['name'] === target.fieldName);
  if (matches.length !== 1) {
    const names = fields.map(field => field['name']).join(', ');
    throw new Error(names ? `Select a media field from ${target.blockType}: ${names}.` : `${target.blockType} has no declared media field.`);
  }
  const field = matches[0], kind = mediaKind(field)!;
  const value = field['value'];
  const tftValue = value?.schemaVersion === 1 && (value.format === 'rgb565' && value.encoding === 'rgb565-be'
    || value.format === 'rgb332' && value.encoding === 'rgb332') ? value : undefined;
  const size = kind === 'u8g2_bitmap' ? u8g2BitmapSize(value, field) : tftMediaSize(tftValue, tftMediaSize(field));
  assertCurrent();
  return { kind, blockType: target.blockType, fieldName: field['name'], fieldType: field['type'], ...size, assertCurrent };
}
