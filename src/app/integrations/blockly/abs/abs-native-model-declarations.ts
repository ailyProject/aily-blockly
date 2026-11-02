import { AbsAbiWorkspace, AbsSyncError } from './abs-state';
import { absJson } from './abs-json';
import { absModelRecovery, availableAbsModelName } from './abs-model-guidance';

/** Host-observed generator effect. start identifies the producer in the byte-bound ABS,
 * not a new ABS annotation and not permission supplied by a consumer field. */
export interface AbsNativeModelDeclaration {
  start: number;
  blockType: string;
  id: string;
  name: string;
  type: string;
  /** A core language construct owns a lexical counter, not a library helper. */
  kind?: 'loop';
}

// Whole-candidate evidence includes every initializer, not just explicit creation intents.
// Keep this protocol capacity aligned with aily-agent/services/abs/model-declarations.
export const ABS_NATIVE_MODEL_DECLARATION_LIMIT = 512;

/** Native types form distinct existing namespaces. Case-only renames are still
 * conflicts; this key is for duplicate evidence, never permission to create. */
export function absNativeModelKey(name: string, type: string): string {
  return JSON.stringify([name.toLowerCase(), type]);
}

export function assertAbsNativeModelDeclarations(value: unknown): asserts value is AbsNativeModelDeclaration[] | undefined {
  if (value === undefined) return;
  const actualType = (item: unknown) => item === null ? 'null' : Array.isArray(item) ? 'array' : typeof item;
  const safeText = (item: unknown): item is string => typeof item === 'string' && !!item && item.length <= 256
    && item === item.trim() && !/[\u0000-\u001f\u007f]/.test(item);
  const fail = (reason: string, field: string, item: unknown, index?: number, producer?: any,
    length?: { received: number; expected: number }): never => {
    const blockType = safeText(producer?.blockType) ? producer.blockType : undefined;
    const range = blockType && Number.isSafeInteger(producer?.start) && producer.start >= 0
      ? { start: producer.start, end: producer.start + blockType.length } : undefined;
    throw new AbsSyncError('ABS_MODEL_DECLARATION_INVALID',
      `Native model declarations require unique, bounded producer/name/type/identity evidence (${field}: ${reason}${length ? `; actual ${length.received}, maximum ${length.expected}` : ''}).`,
      range, [], { phase: 'model-declaration', reason, field, actualTypes: [actualType(item)],
        ...(reason === 'invalid-type' ? { received: actualType(item), expected: 'string' } : {}),
        ...(blockType ? { blockType } : {}), ...(index === undefined ? {} : { path: `/declarations/${index}/${field}` }), ...length });
  };
  if (!Array.isArray(value)) return fail('invalid-container', 'declarations', value);
  if (!value.length) fail('empty-declarations', 'declarations', value);
  if (value.length > ABS_NATIVE_MODEL_DECLARATION_LIMIT) {
    fail('declaration-limit', 'declarations', value, undefined, undefined,
      { received: value.length, expected: ABS_NATIVE_MODEL_DECLARATION_LIMIT });
  }
  const ids = new Set<string>(), models = new Set<string>();
  value.forEach((item: any, index: number) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail('invalid-declaration', 'declaration', item, index);
    if (Object.keys(item).some(key => !['start', 'blockType', 'id', 'name', 'type', 'kind'].includes(key))) {
      fail('unsupported-property', 'declaration', item, index, item);
    }
    if (!Number.isSafeInteger(item.start) || item.start < 0) fail('invalid-offset', 'start', item.start, index, item);
    for (const field of ['blockType', 'id', 'name', 'type'] as const) {
      const text = item[field];
      if (typeof text !== 'string') fail('invalid-type', field, text, index, item);
      if (!text && field !== 'type') fail('empty-text', field, text, index, item);
      if (text.length > 256) fail('text-limit', field, text, index, item, { received: text.length, expected: 256 });
      if (/[\u0000-\u001f\u007f]/.test(text)) fail('control-character', field, text, index, item);
      if (text !== text.trim()) fail('surrounding-whitespace', field, text, index, item);
    }
    if (item.kind !== undefined && item.kind !== 'loop') fail('invalid-kind', 'kind', item.kind, index, item);
    if (ids.has(item.id)) fail('duplicate-identity', 'id', item.id, index, item);
    const key = absNativeModelKey(item.name, item.type);
    if (models.has(key)) fail('duplicate-model', 'name', item.name, index, item);
    ids.add(item.id); models.add(key);
  });
}

/** Merge only declarations proven by the isolated native executor. Existing models
 * keep their identity; deleting a producer never implicitly deletes a shared model. */
export function adoptAbsNativeModels(workspace: AbsAbiWorkspace, declarations: AbsNativeModelDeclaration[] | undefined): void {
  assertAbsNativeModelDeclarations(declarations);
  if (!declarations) return;
  const models = (workspace['variables'] ?? []) as Array<{ id: string; name: string; type?: string }>;
  const next = [...models];
  for (const declaration of declarations) {
    const { id, name, type } = declaration;
    // Reuse is identity-bound. An unrelated same-name model must never shadow
    // the exact ID, and a new ID must never steal an existing typed namespace.
    const existing = next.find(model => model.id === id)
      ?? next.find(model => model.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      if (absJson({ id: existing.id, name: existing.name, type: existing.type ?? '' }) !== absJson({ id, name, type })) {
        const reason = (existing.type ?? '') !== type ? 'type-conflict' : 'identity-conflict';
        throw new AbsSyncError('ABS_MODEL_DECLARATION_CONFLICT', `Initializer ${JSON.stringify(name)} conflicts with an existing model; names, types and identities cannot be implicitly changed.`,
          undefined, [], { blockType: declaration.blockType, modelName: name, expectedTypes: [type], actualTypes: [existing.type ?? ''],
            reason, hint: absModelRecovery(reason), availableName: availableAbsModelName(name, next.map(model => model.name)) });
      }
    } else next.push({ id, name, type });
  }
  workspace['variables'] = next;
}
