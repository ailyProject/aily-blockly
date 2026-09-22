import { AbsFieldDefinition, AbsFieldToken } from './abs-field-values';
import { AbsAbiWorkspace, AbsProjectionContracts, AbsSymbolTable, AbsSyncError } from './abs-state';
import { readAbsStatePath as atPointer } from './abs-state-path';
import { absModelRecovery, availableAbsModelName } from './abs-model-guidance';

type SymbolContract = NonNullable<AbsFieldDefinition['symbol']>;
interface SymbolModel { kind: SymbolContract['kind']; id: string; name: string; type: string }
const VARIABLE_TABLE: AbsSymbolTable = {
  kind: 'variable', source: 'workspace', path: '/variables', idPath: '/id', namePath: '/name', typePath: '/type',
};

/** Pure model lookup. ABS edits references; they do not recreate or rename model tables. */
export class AbsSymbols {
  private readonly ids = new Map<string, SymbolModel>();
  private readonly names = new Map<string, SymbolModel[]>();

  constructor(workspace: AbsAbiWorkspace, document: unknown, contracts: AbsProjectionContracts) {
    const tables = [...(Array.isArray(workspace['variables']) ? [VARIABLE_TABLE] : []), ...(contracts.symbolTables ?? [])];
    for (const table of tables) {
      const records = atPointer(table.source === 'workspace' ? workspace : document, table.path);
      if (!Array.isArray(records)) throw new AbsSyncError('ABS_SYMBOL_INVALID', `Missing model table ${table.path}.`);
      for (const record of records) {
        const id = atPointer(record, table.idPath);
        const name = atPointer(record, table.namePath);
        const type = table.typePath ? atPointer(record, table.typePath) ?? '' : '';
        if (typeof id !== 'string' || !id || typeof name !== 'string' || typeof type !== 'string') {
          throw new AbsSyncError('ABS_SYMBOL_INVALID', `Invalid ${table.kind} model in ${table.path}.`);
        }
        const key = this.key(table.kind, id);
        if (this.ids.has(key)) throw new AbsSyncError('ABS_SYMBOL_INVALID', `Duplicate ${table.kind} model identity.`);
        const model: SymbolModel = { kind: table.kind, id, name, type };
        this.ids.set(key, model);
        const nameKey = this.key(table.kind, name);
        const group = this.names.get(nameKey);
        if (group) group.push(model); else this.names.set(nameKey, [model]);
      }
    }
  }

  project(value: unknown, contract: SymbolContract): { value: string; modelId: string; kind: SymbolContract['kind'] } {
    const model = this.modelForStored(value, contract);
    return { value: model.name, modelId: model.id, kind: model.kind };
  }

  resolve(token: AbsFieldToken, contract: SymbolContract, previous?: unknown): unknown {
    if (token.reference && contract.kind !== 'variable') throw new AbsSyncError('ABS_SYMBOL_INVALID', '$ references select variables, not procedures.');
    if (typeof token.value !== 'string') throw new AbsSyncError('ABS_SYMBOL_INVALID', 'A symbol reference requires a readable string name.');
    const old = previous === undefined ? undefined : this.modelForStored(previous, contract);
    // Equal display names may refer to distinct typed models. An unchanged reference
    // keeps its proven identity; a changed ambiguous name never picks the first model.
    if (old?.name === token.value) return previous;
    const model = this.uniqueName(token.value, contract);
    if (contract.storage === 'name') return model.name;
    if (contract.storage === 'id') return model.id;
    const state = previous && typeof previous === 'object' && !Array.isArray(previous) ? { ...previous } : {};
    const result: Record<string, unknown> = { ...state, id: model.id };
    // Blockly's native full variable-state serialization explicitly defines these members.
    if (Object.hasOwn(state, 'name')) result['name'] = model.name;
    if (Object.hasOwn(state, 'type')) result['type'] = model.type;
    return result;
  }

  private modelForStored(value: unknown, contract: SymbolContract): SymbolModel {
    if (contract.storage === 'name') {
      if (typeof value !== 'string') throw new AbsSyncError('ABS_SYMBOL_INVALID', 'Expected a serialized symbol name.');
      return this.uniqueName(value, contract);
    }
    const id = contract.storage === 'variable-state'
      ? value && typeof value === 'object' && !Array.isArray(value) ? value['id'] : undefined
      : value;
    const model = typeof id === 'string' ? this.ids.get(this.key(contract.kind, id)) : undefined;
    if (!model || !this.allowed(model, contract)) {
      throw new AbsSyncError('ABS_SYMBOL_MISSING', 'Serialized symbol identity is missing or has an incompatible type.', undefined, [], {
        ...(model ? { modelName: model.name, actualTypes: [model.type] } : { actualTypes: [] }), expectedTypes: contract.allowedTypes,
        reason: 'stored-model-invalid',
        hint: 'The saved reference has no compatible model. Check the library README initializer and workspace model integrity. Preserve saved identities; report a registration/serialization defect if initialization cannot repair it. Never fabricate models.',
      });
    }
    return model;
  }
  private uniqueName(name: string, contract: SymbolContract): SymbolModel {
    const named = this.names.get(this.key(contract.kind, name)) ?? [];
    const matches = named.filter(model => this.allowed(model, contract));
    if (matches.length !== 1) {
      const code = matches.length ? 'ABS_SYMBOL_AMBIGUOUS' : named.length ? 'ABS_SYMBOL_TYPE_MISMATCH' : 'ABS_SYMBOL_MISSING';
      const reason = matches.length ? 'ambiguous' : named.length ? 'type-conflict' : 'missing';
      throw new AbsSyncError(code,
        `Cannot uniquely resolve ${contract.kind} ${JSON.stringify(name)}; expected types: ${JSON.stringify(contract.allowedTypes ?? 'any')}; existing types: ${JSON.stringify(named.map(model => model.type))}.`,
        undefined, [], { modelName: name, expectedTypes: contract.allowedTypes, actualTypes: named.map(model => model.type),
          reason, hint: absModelRecovery(reason),
          ...(named.length ? { availableName: availableAbsModelName(name, [...this.ids.values()].map(model => model.name)) } : {}) });
    }
    return matches[0];
  }
  private allowed(model: SymbolModel, contract: SymbolContract): boolean {
    return !contract.allowedTypes || contract.allowedTypes.includes(model.type);
  }
  private key(kind: SymbolContract['kind'], value: string): string { return JSON.stringify([kind, value]); }
}
