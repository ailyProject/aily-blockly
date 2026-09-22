import { AbsAbiBlock, AbsAbiWorkspace, AbsProjectionContracts, AbsSyncError } from './abs-state';
import { absJson } from './abs-identity-map';
import type { AbsBlockShapeContract } from './abs-declarative-contracts';
import type { DeclarativeBlockSnapshot } from '../../../editors/blockly-editor/services/blockly-declarative-block-catalog';

/** Pure adapter for the host-bundled +/- definitions and native legacy callers.
 * Names are intent; variable IDs and parameter field IDs are resolved by the host.
 * No runtime blocks, callbacks, shared-page writes or variable auto-creation here.
 */
export function captureAbsBundledProcedures(snapshot: DeclarativeBlockSnapshot) {
  const fail = (message: string, id?: string): never => {
    throw new AbsSyncError('ABS_PROCEDURE_INVALID', message, undefined, id ? [id] : []);
  };
  const record = (value: any, keys: string[]) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => keys.includes(key));
  const name = (value: any) => typeof value === 'string' && value.length > 0 && value.length <= 256
    && value === value.replace(/[\s\xa0]+/g, ' ').trim() && !/[\u0000-\u001f\u007f]/.test(value);
  const get = (type: string, extraState?: any): AbsBlockShapeContract | undefined => {
    snapshot.assertCurrent();
    const protocol = snapshot.procedure?.(type);
    if (!protocol) return undefined;
    const definition = protocol.role === 'definition';
    const state = extraState ?? {};
    if (!record(state, definition ? ['params', 'hasStatements'] : ['name', 'params'])) fail('Unknown procedure serializer state.');
    const params = state.params ?? [];
    if (!Array.isArray(params) || params.length > 128) fail('Invalid procedure parameters.');
    const fields: AbsBlockShapeContract['fields'] = {}, defaults = {}, inputs: AbsBlockShapeContract['inputs'] = {};
    if (definition) {
      if (state.hasStatements !== undefined && state.hasStatements !== false) fail('Noncanonical procedure statements state.');
      if (!protocol.returns && state.hasStatements === false) fail('A no-return definition requires its statement input.');
      fields['NAME'] = { type: 'field_input' };
      if (state.hasStatements !== false) inputs['STACK'] = 'statement';
      if (protocol.returns) inputs['RETURN'] = 'value';
      const ids = new Set(['NAME', 'TOP', 'STACK', 'RETURN', 'PLUS', 'WITH']);
      for (const param of params) {
        if (!record(param, ['name', 'id', 'argId']) || !name(param.name)
          || typeof param.id !== 'string' || !param.id || typeof param.argId !== 'string' || !param.argId || ids.has(param.argId)) {
          fail('A prepared parameter requires distinct variable and UI field identities.');
        }
        ids.add(param.argId);
        Object.defineProperty(fields, param.argId, { value: { type: 'field_input' }, enumerable: true });
        Object.defineProperty(defaults, param.argId, { value: param.name, enumerable: true });
      }
    } else {
      if (!name(state.name) || params.some(param => !name(param))) fail('Invalid procedure call signature.');
      params.forEach((_, index) => { inputs[`ARG${index}`] = 'value'; });
    }
    const names = params.map(param => (definition ? param.name : param).toLowerCase());
    if (new Set(names).size !== names.length) fail('Duplicate procedure parameters.');
    return { fields, defaults, inputs, output: !definition && protocol.returns,
      previous: !definition && !protocol.returns, next: !definition && !protocol.returns,
      ...(extraState != null ? { extraState } : {}),
      procedure: { ...protocol, namePath: definition ? '/fields/NAME' : '/extraState/name',
        parametersPath: '/extraState/params', parameterNamePath: definition ? '/name' : '',
        ...(definition ? { parameterVariableIdPath: '/id' } : {}) } };
  };
  const prepare = (block: AbsAbiBlock, previous: AbsAbiBlock | undefined, workspace: AbsAbiWorkspace,
    contracts: AbsProjectionContracts) => {
    snapshot.assertCurrent();
    const protocol = snapshot.procedure?.(block.type);
    if (!protocol) return;
    const state: any = block.extraState ?? {};
    if (protocol.role === 'definition') {
      if (!name(block.fields?.['NAME'])) fail('Provide an explicit procedure name.', block.id);
      if (!record(state, ['params', 'hasStatements']) || !Array.isArray(state.params ?? []) || (state.params ?? []).length > 128
        || state.hasStatements !== undefined && state.hasStatements !== false) fail('Invalid procedure state.', block.id);
      const oldParams: any[] = (previous?.extraState as any)?.params ?? [];
      const variables: any[] = Array.isArray(workspace['variables']) ? workspace['variables'] : [];
      // argId identifies a field within this definition, not a global model.
      // Keep local IDs short and reserve removed IDs for the whole preparation.
      const usedArgIds = new Set(oldParams.map(param => param.argId));
      let nextArg = 0;
      const params = (state.params ?? []).map((param: any) => {
        if (!record(param, ['name', 'id', 'argId']) || !name(param.name)) fail('Invalid procedure parameter.', block.id);
        const matches = variables.filter(model => model.name === param.name && (model.type ?? '') === '');
        if (matches.length !== 1) fail(`Parameter ${param.name} requires one model owned by the function parameter declaration. Check the documented procedure signature and its supported parameter contract.`, block.id);
        const model = matches[0], old = oldParams.find(value => value.id === model.id && value.name === param.name);
        let argId = old?.argId;
        if (!argId) {
          do { argId = `abs_arg_${nextArg++}`; } while (usedArgIds.has(argId));
          usedArgIds.add(argId);
        }
        if (!old && (param.id !== undefined || param.argId !== undefined)
          || param.id !== undefined && param.id !== model.id || param.argId !== undefined && param.argId !== argId) {
          fail('Parameter identity cannot be supplied or retargeted by the candidate.', block.id);
        }
        return { name: param.name, id: model.id, argId };
      });
      block.fields ??= {};
      for (const param of oldParams) {
        if (Object.hasOwn(block.fields, param.argId)) {
          if (block.fields[param.argId] !== param.name) fail('Edit the parameter signature, not its derived UI field.', block.id);
          delete block.fields[param.argId];
        }
      }
      for (const param of params) {
        if (Object.hasOwn(block.fields, param.argId) && block.fields[param.argId] !== param.name) fail('Parameter field conflicts with its signature.', block.id);
        Object.defineProperty(block.fields, param.argId, { value: param.name, enumerable: true, configurable: true, writable: true });
      }
      if (params.length || state.hasStatements === false) block.extraState = {
        ...(params.length ? { params } : {}), ...(state.hasStatements === false ? { hasStatements: false } : {}),
      };
      else delete block.extraState;
    } else {
      // Native callers omit an empty parameter array.
      if (!record(state, ['name', 'params'])) fail('Unknown procedure call state.', block.id);
      if (!Array.isArray(state.params ?? [])) fail('Invalid call parameters.', block.id);
      block.extraState = { name: state.name, ...(state.params?.length ? { params: state.params } : {}) };
    }
    const shape = get(block.type, block.extraState)!;
    Object.defineProperty(contracts.fields, block.id, { value: JSON.parse(absJson(shape.fields)), enumerable: true, configurable: true, writable: true });
    contracts.procedures ??= {};
    Object.defineProperty(contracts.procedures, block.id, { value: shape.procedure, enumerable: true, configurable: true, writable: true });
  };
  return { get, prepare };
}
