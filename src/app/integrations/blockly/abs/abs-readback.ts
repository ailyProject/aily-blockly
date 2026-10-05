import { AbsFieldDefinition, normalizeAbsSerializedField } from './abs-field-values';
import { absJson } from './abs-json';
import { indexAbsAbi } from './abs-abi-index';
import { AbsAbiBlock, AbsAbiWorkspace, AbsSyncError } from './abs-state';

export interface AbsReadbackOptions {
  fieldDefinition?: (type: string, field: string, id: string) => AbsFieldDefinition | undefined;
  mode?: 'complete' | 'requested';
  /** Ordinary project loading has its own structural admission, not ABS syntax depth budgets. */
  index?: (workspace: AbsAbiWorkspace) => Map<string, AbsAbiBlock>;
}
const BLOCK_DEFAULTS = { deletable: true, movable: true, editable: true, collapsed: false, data: '' };

/** One policy for transitional requested values and complete baseline transactions. */
export function assertAbsReadback(expected: AbsAbiWorkspace, actual: AbsAbiWorkspace, options: AbsReadbackOptions = {}): void {
  prepareReadback(expected, options)(actual);
}

/** Own one immutable expected state; each invocation still indexes and checks the
 * complete fresh readback. No revision shortcut or caller-owned cached proof.
 * Field contracts are read each time, not assumed to be callback-free constants. */
export function createAbsReadbackVerifier(expected: AbsAbiWorkspace, options: Omit<AbsReadbackOptions, 'index'> = {}) {
  return prepareReadback(structuredClone(expected), { fieldDefinition: options.fieldDefinition, mode: options.mode });
}

function prepareReadback(expected: AbsAbiWorkspace, options: AbsReadbackOptions) {
  const index = options.index ?? indexAbsAbi;
  const before = index(expected);
  const complete = options.mode !== 'requested';
  const fail = (path: string, id?: string): never => {
    throw new AbsSyncError('ABS_READBACK_MISMATCH', `Blockly changed or discarded persisted state at ${path}.`, undefined, id ? [id] : []);
  };
  const equal = (left: unknown, right: unknown, path: string, id?: string) => {
    if (left === undefined || right === undefined ? left !== right : absJson(left) !== absJson(right)) fail(path, id);
  };
  const record = (left: Record<string, unknown>, right: Record<string, unknown>, exact: boolean, path: string, id?: string) => {
    for (const key of exact ? new Set([...Object.keys(left), ...Object.keys(right)]) : Object.keys(left)) {
      equal(Object.hasOwn(left, key) ? left[key] : undefined, Object.hasOwn(right, key) ? right[key] : undefined, `${path}/${key}`, id);
    }
  };
  const owners = (workspace: AbsAbiWorkspace) => {
    const result = new Map<string, unknown>();
    const pending: Array<{ block: AbsAbiBlock; owner: unknown }> = workspace.blocks.blocks.map(block => ({ block, owner: null }));
    while (pending.length) {
      const { block, owner } = pending.pop()!;
      result.set(block.id, owner);
      for (const [name, input] of Object.entries(block.inputs ?? {})) {
        if (input.block) pending.push({ block: input.block, owner: [block.id, name, 'block'] });
        if (input.shadow) pending.push({ block: input.shadow, owner: [block.id, name, 'shadow'] });
      }
      if (block.next?.block) pending.push({ block: block.next.block, owner: [block.id, 'next'] });
    }
    return result;
  };
  const expectedOwners = owners(expected);
  const expectedIds = [...before.keys()].sort();
  const expectedRoots = expected.blocks.blocks.map(block => block.id);
  const models = (workspace: AbsAbiWorkspace) => {
    const value = workspace['variables'];
    if (value !== undefined && !Array.isArray(value)) fail('/variables');
    const result = new Map<string, Record<string, unknown>>();
    for (const model of value as any[] ?? []) {
      if (!model || typeof model.id !== 'string' || !model.id || result.has(model.id)) fail('/variables');
      result.set(model.id, { ...model, type: model.type ?? '' });
    }
    return result;
  };
  const expectedVariables = models(expected);
  const expectedVariableIds = [...expectedVariables.keys()].sort();
  const attributes = (value: AbsAbiBlock, original: AbsAbiBlock) => {
    const { fields, inputs, next, ...attributes } = value;
    const root = expectedOwners.get(original.id) === null;
    if (!root) { delete attributes['x']; delete attributes['y']; }
    if (root) for (const key of ['x', 'y']) if (typeof attributes[key] === 'number') attributes[key] = Math.round(attributes[key] as number);
    if (complete || Object.hasOwn(original, 'extraState')) attributes['extraState'] = attributes['extraState'] ?? null;
    if (complete || Object.hasOwn(original, 'enabled') || Object.hasOwn(original, 'disabledReasons')) {
      const reasons = attributes['disabledReasons'];
      if (reasons !== undefined && (!Array.isArray(reasons) || reasons.some(reason => typeof reason !== 'string'))) fail('/disabledReasons', original.id);
      attributes['disabledReasons'] = [...new Set([...(reasons as string[] ?? []), ...(attributes['enabled'] === false ? ['MANUALLY_DISABLED'] : [])])].sort();
    }
    delete attributes['enabled'];
    for (const [key, value] of Object.entries(BLOCK_DEFAULTS)) {
      if ((complete || Object.hasOwn(original, key)) && !Object.hasOwn(attributes, key)) attributes[key] = value;
    }
    return attributes;
  };
  const connections = (value: AbsAbiBlock) => Object.fromEntries([
    ...Object.entries(value.inputs ?? {}).map(([name, slot]) => [`input:${name}`, slot] as const),
    ...(value.next ? [['next', value.next] as const] : []),
  ].map(([name, slot]) => {
    const { block: child, shadow, ...state } = slot as { block?: AbsAbiBlock; shadow?: AbsAbiBlock; [key: string]: unknown };
    return [name, { ...state, ...(child ? { block: child.id } : {}), ...(shadow ? { shadow: shadow.id } : {}) }];
  }));
  const serializers = (workspace: AbsAbiWorkspace) => {
    const { blocks, variables, $ailyProjectData, ...state } = workspace;
    return { ...state, blocks: { languageVersion: 0, ...blocks, blocks: [] } };
  };
  const expectedState = serializers(expected);
  const entries = [...before.values()].map(block => ({ block, attributes: attributes(block, block), connections: connections(block) }));

  return (actual: AbsAbiWorkspace): void => {
    const after = index(actual);
    const actualOwners = owners(actual);
    if (complete) equal(expectedIds, [...after.keys()].sort(), '/blockIds');
    equal(expectedRoots, actual.blocks.blocks.filter(block => before.has(block.id)).map(block => block.id), '/roots');
    const actualVariables = models(actual);
    if (complete) equal(expectedVariableIds, [...actualVariables.keys()].sort(), '/variables');
    for (const [id, model] of expectedVariables) equal(model, actualVariables.get(id), '/variables', id);
    for (const entry of entries) {
      const { block } = entry;
      const loaded = after.get(block.id);
      if (!loaded || loaded.type !== block.type) fail('/type', block.id);
      equal(expectedOwners.get(block.id), actualOwners.get(block.id), '/connection', block.id);
      record(entry.attributes, attributes(loaded, block), complete, '/attributes', block.id);
      const fields = (value: AbsAbiBlock) => Object.fromEntries(Object.entries(value.fields ?? {}).map(([name, stored]) => {
        const definition = options.fieldDefinition?.(block.type, name, block.id);
        if (definition?.symbol?.kind === 'variable' && definition.symbol.storage === 'variable-state') {
          const state = stored as Record<string, unknown>;
          const model = state && typeof state === 'object' ? actualVariables.get(state['id'] as string) : undefined;
          if (!model || (Object.hasOwn(state, 'name') && model['name'] !== state['name'])
            || (Object.hasOwn(state, 'type') && model['type'] !== state['type'])) fail(`/fields/${name}`, block.id);
        }
        return [name, normalizeAbsSerializedField(stored, definition)];
      }));
      record(fields(block), fields(loaded), complete, '/fields', block.id);
      const expectedConnections = entry.connections;
      const actualConnections = connections(loaded);
      if (complete) record(expectedConnections, actualConnections, true, '/connections', block.id);
      else for (const [name, connection] of Object.entries(expectedConnections)) {
        if (!Object.hasOwn(actualConnections, name)) fail(`/connections/${name}`, block.id);
        record(connection, actualConnections[name], false, `/connections/${name}`, block.id);
      }
    }
    record(expectedState, serializers(actual), complete, '/workspace');
  };
}
