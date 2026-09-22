import { indexAbsAbi } from './abs-abi-index';
import { AbsAbiWorkspace, AbsSyncError } from './abs-state';
import { readAbsStatePath } from './abs-state-path';

/** Host-declared serialization contract; paths are schema, never duplicated model state. */
export interface AbsProcedureStateContract {
  role: 'definition' | 'call';
  namePath: string;
  parametersPath: string;
  parameterNamePath: string;
  parameterVariableIdPath?: string;
  parameterVariableIdsPath?: string;
  parameterTypePath?: string;
  parameterModelType?: string;
  family?: string;
  nameIsVariableId?: boolean;
  modelIdPath?: string;
  modelType?: string;
  allowDiscardReturn?: boolean;
  returns: boolean;
}
export interface AbsProcedureReference { blockId: string; statePath: string; kind: 'variable' | 'procedure'; modelId: string }

/** Blockly legacy procedure namespace is case-insensitive. Validate before callbacks can auto-create/retarget definitions. */
export function getAbsProcedureReferences(
  workspace: AbsAbiWorkspace, contracts: Record<string, AbsProcedureStateContract> = {},
): AbsProcedureReference[] {
  const blocks = indexAbsAbi(workspace);
  const variables = new Map((Array.isArray(workspace['variables']) ? workspace['variables'] : []).map(model => [model.id, model]));
  const definitions = new Map<string, { id: string; params: string[]; returns: boolean; family?: string }>();
  const calls: Array<{ id: string; name: string; params: string[]; contract: AbsProcedureStateContract }> = [];
  const refs: AbsProcedureReference[] = [];
  const fail = (id: string, message: string): never => { throw new AbsSyncError('ABS_PROCEDURE_INVALID', message, undefined, [id]); };
  for (const [id, contract] of Object.entries(contracts)) {
    const block = blocks.get(id);
    if (!block) continue; // A removed definition is legal only when no remaining call refers to it.
    if (!['definition', 'call'].includes(contract.role) || typeof contract.returns !== 'boolean') fail(id, 'Invalid procedure contract.');
    const storedName = readAbsStatePath(block, contract.namePath);
    const name = contract.nameIsVariableId ? variables.get(storedName)?.name : storedName;
    if (contract.modelIdPath) {
      const model = variables.get(readAbsStatePath(block, contract.modelIdPath));
      if (!model || model.name !== name || model.type !== contract.modelType
        || contract.nameIsVariableId && model.id !== storedName) fail(id, 'Function model identity/name/type mismatch.');
      refs.push({ blockId: id, statePath: contract.modelIdPath, kind: 'variable', modelId: model.id });
    }
    const parameters = readAbsStatePath(block, contract.parametersPath) ?? [];
    if (typeof name !== 'string' || !name.trim() || !Array.isArray(parameters)) fail(id, 'Invalid serialized procedure signature.');
    const parameterNames: string[] = [];
    const params = (parameters as unknown[]).map((parameter, index) => {
      const name = readAbsStatePath(parameter, contract.parameterNamePath);
      if (typeof name !== 'string' || !name.trim()) fail(id, 'Invalid procedure parameter name.');
      parameterNames.push(name as string);
      if (contract.parameterVariableIdPath !== undefined || contract.parameterVariableIdsPath !== undefined) {
        const variableId = contract.parameterVariableIdsPath ? readAbsStatePath(block, contract.parameterVariableIdsPath)?.[index]
          : readAbsStatePath(parameter, contract.parameterVariableIdPath!);
        const variable = variables.get(variableId);
        if (!variable || variable.name !== name || contract.parameterModelType !== undefined && (variable.type ?? '') !== contract.parameterModelType) fail(id, 'Procedure parameter variable identity/name/type does not match its model.');
        refs.push({ blockId: id, statePath: contract.parameterVariableIdsPath ? `${contract.parameterVariableIdsPath}/${index}`
          : `${contract.parametersPath}/${index}${contract.parameterVariableIdPath}`, kind: 'variable', modelId: variable.id });
      }
      const type = contract.parameterTypePath ? readAbsStatePath(parameter, contract.parameterTypePath) : undefined;
      if (contract.parameterTypePath && (typeof type !== 'string' || !type)) fail(id, 'Invalid typed parameter.');
      return contract.parameterTypePath ? JSON.stringify([name, type]) : name as string;
    });
    if (new Set(parameterNames.map(name => name.toLowerCase())).size !== params.length) fail(id, 'Duplicate procedure parameter names.');
    const key = (name as string).toLowerCase();
    if (contract.role === 'definition') {
      if (definitions.has(key)) fail(id, 'Ambiguous procedure definitions with the same name.');
      definitions.set(key, { id, params, returns: contract.returns, family: contract.family });
    } else calls.push({ id, name: name as string, params, contract });
  }
  for (const call of calls) {
    const definition = definitions.get(call.name.toLowerCase());
    if (!definition || definition.family !== call.contract.family || definition.returns !== call.contract.returns && !(call.contract.allowDiscardReturn && !call.contract.returns)
      || definition.params.length !== call.params.length
      || definition.params.some((name, index) => name !== call.params[index])) fail(call.id, 'Procedure call has no matching definition/signature; use a host model operation.');
    refs.push({ blockId: call.id, statePath: call.contract.namePath, kind: 'procedure', modelId: definition.id });
  }
  return refs;
}
