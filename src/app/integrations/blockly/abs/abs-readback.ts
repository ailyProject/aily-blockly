import { AbsFieldDefinition, normalizeAbsSerializedField } from './abs-field-values';
import { absJson } from './abs-json';
import { indexAbsAbi } from './abs-abi-index';
import { AbsAbiBlock, AbsAbiWorkspace, AbsSyncError } from './abs-state';

export interface AbsReadbackOptions {
  fieldDefinition?: (type: string, field: string, id: string) => AbsFieldDefinition | undefined;
  mode?: 'complete' | 'requested';
}
const BLOCK_DEFAULTS = { deletable: true, movable: true, editable: true, collapsed: false, data: '' };

/** One policy for transitional requested values and complete baseline transactions. */
export function assertAbsReadback(expected: AbsAbiWorkspace, actual: AbsAbiWorkspace, options: AbsReadbackOptions = {}): void {
  const before = indexAbsAbi(expected);
  const after = indexAbsAbi(actual);
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
    const visit = (block: AbsAbiBlock, owner: unknown) => {
      result.set(block.id, owner);
      for (const [name, input] of Object.entries(block.inputs ?? {})) {
        if (input.block) visit(input.block, [block.id, name, 'block']);
        if (input.shadow) visit(input.shadow, [block.id, name, 'shadow']);
      }
      if (block.next?.block) visit(block.next.block, [block.id, 'next']);
    };
    workspace.blocks.blocks.forEach(block => visit(block, null));
    return result;
  };
  const expectedOwners = owners(expected);
  const actualOwners = owners(actual);
  if (complete) equal([...before.keys()].sort(), [...after.keys()].sort(), '/blockIds');
  equal(expected.blocks.blocks.map(block => block.id), actual.blocks.blocks.filter(block => before.has(block.id)).map(block => block.id), '/roots');
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
  const actualVariables = models(actual);
  if (complete) equal([...expectedVariables.keys()].sort(), [...actualVariables.keys()].sort(), '/variables');
  for (const [id, model] of expectedVariables) equal(model, actualVariables.get(id), '/variables', id);
  for (const block of before.values()) {
    const loaded = after.get(block.id);
    if (!loaded || loaded.type !== block.type) fail('/type', block.id);
    equal(expectedOwners.get(block.id), actualOwners.get(block.id), '/connection', block.id);
    const exact = complete;
    const root = expectedOwners.get(block.id) === null;
    const attributes = (value: AbsAbiBlock) => {
      const { fields, inputs, next, ...attributes } = value;
      if (!root) { delete attributes['x']; delete attributes['y']; }
      if (root) for (const key of ['x', 'y']) if (typeof attributes[key] === 'number') attributes[key] = Math.round(attributes[key] as number);
      if (exact || Object.hasOwn(block, 'extraState')) attributes['extraState'] = attributes['extraState'] ?? null;
      if (exact || Object.hasOwn(block, 'enabled') || Object.hasOwn(block, 'disabledReasons')) {
        const reasons = attributes['disabledReasons'];
        if (reasons !== undefined && (!Array.isArray(reasons) || reasons.some(reason => typeof reason !== 'string'))) fail('/disabledReasons', block.id);
        attributes['disabledReasons'] = [...new Set([...(reasons as string[] ?? []), ...(attributes['enabled'] === false ? ['MANUALLY_DISABLED'] : [])])].sort();
      }
      delete attributes['enabled'];
      return attributes;
    };
    const left = attributes(block);
    const right = attributes(loaded);
    for (const [key, value] of Object.entries(BLOCK_DEFAULTS)) {
      if (exact || Object.hasOwn(left, key)) {
        if (!Object.hasOwn(left, key)) left[key] = value;
        if (!Object.hasOwn(right, key)) right[key] = value;
      }
    }
    record(left, right, exact, '/attributes', block.id);
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
    record(fields(block), fields(loaded), exact, '/fields', block.id);
    const connections = (value: AbsAbiBlock) => Object.fromEntries([
      ...Object.entries(value.inputs ?? {}).map(([name, slot]) => [`input:${name}`, slot] as const),
      ...(value.next ? [['next', value.next] as const] : []),
    ].map(([name, slot]) => {
      const { block: child, shadow, ...state } = slot as { block?: AbsAbiBlock; shadow?: AbsAbiBlock; [key: string]: unknown };
      return [name, { ...state, ...(child ? { block: child.id } : {}), ...(shadow ? { shadow: shadow.id } : {}) }];
    }));
    const expectedConnections = connections(block);
    const actualConnections = connections(loaded);
    if (exact) record(expectedConnections, actualConnections, true, '/connections', block.id);
    else for (const [name, connection] of Object.entries(expectedConnections)) {
      if (!Object.hasOwn(actualConnections, name)) fail(`/connections/${name}`, block.id);
      record(connection, actualConnections[name], false, `/connections/${name}`, block.id);
    }
  }
  const serializers = (workspace: AbsAbiWorkspace) => {
    const { blocks, variables, $ailyProjectData, ...state } = workspace;
    return { ...state, blocks: { languageVersion: 0, ...blocks, blocks: [] } };
  };
  record(serializers(expected), serializers(actual), complete, '/workspace');
}
