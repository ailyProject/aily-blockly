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

export function assertAbsNativeModelDeclarations(value: unknown): asserts value is AbsNativeModelDeclaration[] | undefined {
  if (value === undefined) return;
  const text = (item: unknown, empty = false) => typeof item === 'string' && (empty || !!item)
    && item.length <= 256 && item === item.trim() && !/[\u0000-\u001f\u007f]/.test(item);
  if (!Array.isArray(value) || !value.length || value.length > 128 || value.some(item => !item
    || Object.keys(item).some(key => !['start', 'blockType', 'id', 'name', 'type', 'kind'].includes(key))
    || item.kind !== undefined && item.kind !== 'loop'
    || !Number.isSafeInteger(item.start) || item.start < 0 || !text(item.blockType)
    || !text(item.id) || !text(item.name) || !text(item.type, true))
    || new Set(value.map(item => item.id)).size !== value.length
    || new Set(value.map(item => item.name.toLowerCase())).size !== value.length) {
    throw new AbsSyncError('ABS_MODEL_DECLARATION_INVALID', 'Native model declarations require unique, bounded producer/name/type/identity evidence.');
  }
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
    const existing = next.find(model => model.id === id || model.name.toLowerCase() === name.toLowerCase());
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
