import type * as Blockly from 'blockly';
import { AbsSyncError, type AbsSyntaxNode } from '../../../integrations/blockly/abs/abs-state';
import { absJson } from '../../../integrations/blockly/abs/abs-json';
import { captureAbsFieldContract } from '../../../integrations/blockly/abs/abs-runtime-field-contract';
import { isPlainProjectJsonObject } from '@domain/project/project-document/public-api';
import type { NativeCandidateWorkspace } from './blockly-native-candidate-workspace';

type Register = (block: Blockly.Block, name: string, type: string) => void;
type ModelField = { name: string; type: string; shared: boolean };
const text = (value: unknown, empty = false): value is string => typeof value === 'string' && (empty || !!value)
  && value.length <= 256 && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);

/** Only small data records, never accessors, arbitrary prototypes or toJSON hooks.
 * Inspect only block types in this candidate, not an entire library registry. */
export function captureNativeInitializerContracts(generator: Blockly.Generator, types: Iterable<string>) {
  const invalid = (reason: string): never => { throw new AbsSyncError('ABS_MODEL_INITIALIZER_INVALID',
    'Invalid installed workspace model initializer contract: ' + reason + '.', undefined, [],
    { phase: 'model-declaration', reason }); };
  const data = (object: object, key: string) => {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor) return undefined;
    if (!('value' in descriptor) || !descriptor.enumerable) return invalid('data-properties-required');
    return descriptor.value;
  };
  const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object'
    && !Array.isArray(value) && isPlainProjectJsonObject(value);
  const registry = data(generator, 'modelDeclarations');
  if (registry !== undefined && !record(registry)) invalid('keyed-registry-required');
  const read = (contract: unknown) => {
    if (!record(contract) || ![3, 4].includes(Reflect.ownKeys(contract).length)
      || Reflect.ownKeys(contract).some(key => typeof key !== 'string' || !['version', 'scope', 'fields', 'shared'].includes(key))) {
      return invalid('unsupported-version-or-scope');
    }
    if (data(contract, 'version') !== 1 || data(contract, 'scope') !== 'workspace') return invalid('unsupported-version-or-scope');
    const fields = data(contract, 'fields');
    if (!record(fields) || !Reflect.ownKeys(fields).length || Reflect.ownKeys(fields).length > 32) return invalid('invalid-fields');
    const shared = new Set<string>();
    if (Object.hasOwn(contract, 'shared')) {
      const values = data(contract, 'shared');
      if (!Array.isArray(values)) return invalid('invalid-shared-fields');
      const length = Object.getOwnPropertyDescriptor(values, 'length')?.value;
      if (!Number.isSafeInteger(length) || length < 0 || length > 32
        || Reflect.ownKeys(values).length !== length + 1) return invalid('invalid-shared-fields');
      for (let index = 0; index < length; index++) {
        const name = data(values, String(index));
        if (!text(name) || !Object.hasOwn(fields, name) || shared.has(name)) return invalid('invalid-shared-fields');
        shared.add(name);
      }
    }
    const result: ModelField[] = [];
    for (const name of Reflect.ownKeys(fields)) {
      if (!text(name)) return invalid('invalid-field-or-type');
      const type = data(fields, name);
      if (!text(type, true)) return invalid('invalid-field-or-type');
      result.push({ name, type, shared: shared.has(name) });
    }
    return result;
  };
  const contracts = new Map<string, { contract: unknown; fields: ModelField[]; snapshot: string }>();
  for (const type of new Set(types)) {
    if (!registry || !Object.hasOwn(registry, type)) continue;
    const contract = data(registry, type), fields = read(contract);
    contracts.set(type, { contract, fields, snapshot: absJson(fields) });
  }
  return {
    get: (type: string) => contracts.get(type)?.fields,
    shares(block: Blockly.Block, name: string, type: string, id: string) {
      const fields = contracts.get(block.type)?.fields.filter(field => {
        const model = (block.getField(field.name) as Blockly.FieldVariable | null)?.getVariable?.();
        return model?.getName() === name && model.getType() === type && model.getId() === id;
      });
      return !!fields?.length && fields.every(field => field.shared);
    },
    assertCurrent() {
      try {
        if (contracts.size && data(generator, 'modelDeclarations') !== registry) throw new Error();
        for (const [type, expected] of contracts) {
          if (data(registry, type) !== expected.contract || absJson(read(expected.contract)) !== expected.snapshot) throw new Error();
        }
      } catch {
        throw new AbsSyncError('ABS_MODEL_INITIALIZER_CHANGED', 'Installed model initializer contracts changed during generation or preparation.');
      }
    },
  };
}

/** An installed generator may explicitly own fixed-type workspace models selected
 * by its own fields. Consumer variableTypes/defaultType alone are never authority.
 * Complete generation must still reproduce the normal registration helper calls. */
export function captureNativeModelInitializers(execution: NativeCandidateWorkspace, generator: Blockly.Generator,
  blocks: ReadonlyMap<AbsSyntaxNode, Blockly.Block>, inactive: (block: Blockly.Block) => boolean,
  retainedIds: ReadonlySet<string>) {
  const contracts = captureNativeInitializerContracts(generator, [...blocks.values()].filter(block => !inactive(block)).map(block => block.type));
  const bootstrap = execution.workspace.getVariableMap().getAllVariables().filter(model => retainedIds.has(model.getId())).map(model => ({
    id: model.getId(), name: model.getName(), type: model.getType(),
  }));
  const reused = new Map<Blockly.Block, Array<{ id: string; name: string; type: string }>>();
  const entries: Array<{ block: Blockly.Block; node: AbsSyntaxNode;
    fields: ModelField[] }> = [];
  const fail = (block: Blockly.Block, node: AbsSyntaxNode, reason: string, field?: string): never => {
    throw new AbsSyncError('ABS_MODEL_INITIALIZER_INVALID', 'Invalid installed workspace model initializer contract: ' + reason + '.',
      field ? node.fieldRanges[field] ?? node : node, [],
      { phase: 'model-declaration', blockType: block.type, reason, ...(field ? { field } : {}) });
  };
  for (const [node, block] of blocks) {
    const fields = contracts.get(block.type);
    if (inactive(block) || !fields) continue;
    const planned: ModelField[] = [];
    for (const { name, type, shared } of fields) {
      const field = block.getField(name), token = node.fields[name];
      if (!(field instanceof execution.native.FieldVariable) || field.SERIALIZABLE === false) return fail(block, node, 'not-a-variable-field', name);
      const allowed = captureAbsFieldContract(field).symbol?.allowedTypes;
      if (allowed && !allowed.includes(type)) fail(block, node, 'field-type-conflict', name);
      if (!token?.reference || !text(token.value)) fail(block, node, 'explicit-variable-reference-required', name);
      planned.push({ name, type, shared });
    }
    entries.push({ block, node, fields: planned });
    reused.set(block, planned.flatMap(field => bootstrap.filter(model => model.name === node.fields[field.name].value && model.type === field.type)));
  }
  return {
    get size() { return entries.length; },
    shares(block: Blockly.Block, name: string, type: string) {
      const entry = entries.find(entry => entry.block === block);
      const fields = entry?.fields.filter(field => field.type === type && entry.node.fields[field.name].value === name);
      return !!fields?.length && fields.every(field => field.shared);
    },
    reuses(block: Blockly.Block, name: string, type: string) {
      return reused.get(block)?.some(saved => {
        const current = execution.workspace.getVariableMap().getVariableById(saved.id);
        return saved.name === name && saved.type === type && current?.getName() === name && current?.getType() === type;
      }) === true;
    },
    apply(register: Register) {
      for (const { block, node, fields } of entries) for (const { name, type } of fields) {
        register(block, node.fields[name].value as string, type);
      }
    },
    assertCurrent: contracts.assertCurrent,
  };
}
