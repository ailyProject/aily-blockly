import { tftMediaSize, u8g2BitmapSize } from '@domain/project/project-data/public-api';
import type { DeclarativeBlockSnapshot } from '../../editors/blockly-editor/services/blockly-declarative-block-catalog';
import { parseBlockDefinition } from './abs/block-definition.model';

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
  singleFieldOutput?: true;
  assertCurrent(): void;
}

function mediaKind(field: Record<string, any>): MediaKind | undefined {
  if (field['type'] === 'field_bitmap_u8g2') return 'u8g2_bitmap';
  if (field['type'] === 'field_tftespi_image') return 'tft_image';
  if (field['type'] === 'field_tftespi_animation') return field['imageMode'] === true ? 'tft_image' : 'tft_animation';
}

function mediaBlockArguments(definition: Record<string, any>) {
  const argumentLists = Object.keys(definition).filter(key => /^args\d+$/.test(key)).map(key => definition[key]);
  const args: Array<Record<string, any>> = argumentLists.filter(Array.isArray).flat();
  const fields = args.filter(field => field && typeof field['name'] === 'string' && mediaKind(field));
  return { argumentLists, args, fields };
}

/** A recovery can target only a unique field supported by the media importer. */
export function declaredMediaImportFieldType(definition: Record<string, any> | undefined, fieldName: string): string | undefined {
  if (!definition) return;
  const matches = mediaBlockArguments(definition).fields.filter(field => field['name'] === fieldName);
  return matches.length === 1 ? matches[0]['type'] : undefined;
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
  const { argumentLists, args, fields } = mediaBlockArguments(definition);
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
  // This proves the call syntax. Media fields still require native validation when applied.
  const meta = args.length === 1 && argumentLists.every(Array.isArray) &&
    !Object.hasOwn(definition, 'mutator') && !Object.hasOwn(definition, 'extraState') &&
    !Object.hasOwn(definition, 'extensions') && !/[^A-Za-z0-9_]/.test(target.blockType) &&
    definitions.registered(target.blockType) ? parseBlockDefinition(definition, '') : undefined;
  const argument = meta?.argsOrder[0];
  const singleFieldOutput = meta?.type === target.blockType && meta.hasOutput && !meta.hasPrevious && !meta.hasNext &&
    meta.argsOrder.length === 1 && argument?.kind === 'field' && argument.name === field['name'];
  assertCurrent();
  return { kind, blockType: target.blockType, fieldName: field['name'], fieldType: field['type'], ...size,
    ...(singleFieldOutput ? { singleFieldOutput: true } : {}), assertCurrent };
}
