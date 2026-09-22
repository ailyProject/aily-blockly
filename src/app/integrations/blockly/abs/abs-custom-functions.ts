import type { DeclarativeBlockSnapshot } from '../../../editors/blockly-editor/services/blockly-declarative-block-catalog';
import { AbsAbiBlock, AbsAbiWorkspace, AbsProjectionContracts, AbsSyncError } from './abs-state';
import { AbsBlockShapeContract, compileAbsDeclarativeContract, assertAbsDeclaredBlockShape } from './abs-declarative-contracts';
import { absJson } from './abs-identity-map';
import { customFunctionSyntax } from './abs-custom-function-syntax';

/** Audited custom-function serializer adapter. Models are explicit intents; no live Blockly or library callbacks. */
export function captureAbsCustomFunctions(snapshot: DeclarativeBlockSnapshot) {
  const fail = (message: string): never => { throw new AbsSyncError('ABS_CUSTOM_FUNCTION_INVALID', message); };
  const record = (value: any, keys: string[]) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => keys.includes(key));
  const name = (value: any) => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
  const describe = (type: string) => {
    snapshot.assertCurrent();
    const protocol = snapshot.customFunctions?.get(type), json = protocol && snapshot.get('custom_function_def');
    if (!protocol || !json || json['mutator'] !== 'function_params_mutator') return undefined;
    const { mutator, ...staticJson } = json;
    const base = compileAbsDeclarativeContract(staticJson, snapshot.supportsUiExtension);
    if (!base || absJson(Object.keys(base.fields).sort()) !== absJson(['FUNC_NAME', 'RETURN_TYPE'])
      || base.fields['FUNC_NAME'].type !== 'field_input' || base.fields['RETURN_TYPE'].type !== 'field_dropdown'
      || absJson(base.inputs) !== absJson({ STACK: 'statement' }) || base.output || base.previous || base.next) return undefined;
    return { protocol, base };
  };
  const field = (type: string, key: string) => {
    const descriptor = describe(type);
    if (descriptor?.protocol.kind === 'definition') {
      if (descriptor.base.fields[key]) return descriptor.base.fields[key];
      if (/^PARAM_NAME\d+$/.test(key)) return { type: 'field_input' };
      if (/^PARAM_TYPE\d+$/.test(key)) return { type: 'field_dropdown', options: descriptor.protocol.parameterTypes.map(value => [null, value] as const) };
    }
    return descriptor && descriptor.protocol.kind !== 'definition' && key === 'FUNC_NAME'
      ? { type: 'field_variable', symbol: { kind: 'variable' as const, storage: 'variable-state' as const, allowedTypes: ['FUNC'] } } : undefined;
  };
  const get = (type: string, extra?: any): AbsBlockShapeContract | undefined => {
    const descriptor = describe(type); if (!descriptor) return undefined;
    const { protocol, base } = descriptor, definition = protocol.kind === 'definition';
    if (!record(extra, definition ? ['paramCount', 'returnType', 'params', 'funcVarId', 'paramVarIds', 'nextParamVarSeq'] : ['extraCount', 'funcVarId', 'params'])
      || typeof extra.funcVarId !== 'string' || !extra.funcVarId) fail('Missing prepared function model identity.');
    const params = extra.params ?? [];
    if (!Array.isArray(params) || params.length > 128 || params.some(param => !record(param, ['name', 'type'])
      || !name(param.name) || !protocol.parameterTypes.includes(param.type))
      || new Set(params.map(param => param.name.toLowerCase())).size !== params.length) fail('Invalid typed parameter signature.');
    const fields = definition ? { ...base.fields } : { FUNC_NAME: field(type, 'FUNC_NAME')! };
    const inputs = definition ? { ...base.inputs } : {};
    if (definition) {
      if (!Array.isArray(extra.params) || extra.paramCount !== params.length || !Array.isArray(extra.paramVarIds)
        || extra.paramVarIds.length !== params.length || extra.paramVarIds.some(id => typeof id !== 'string' || !id)
        || new Set(extra.paramVarIds).size !== params.length || !Number.isSafeInteger(extra.nextParamVarSeq) || extra.nextParamVarSeq < 0
        || extra.returnType === '---' || !base.fields['RETURN_TYPE'].options?.some(option => option[1] === extra.returnType)) fail('Invalid prepared definition state.');
      if (extra.returnType !== 'void') inputs['RETURN'] = 'value';
      params.forEach((_, index) => {
        fields[`PARAM_NAME${index}`] = { type: 'field_input' };
        fields[`PARAM_TYPE${index}`] = { type: 'field_dropdown', options: protocol.parameterTypes.map(value => [null, value]) };
      });
    } else {
      if (extra.extraCount !== params.length || params.length === 0 && Object.hasOwn(extra, 'params')) fail('Noncanonical call parameter state.');
      params.forEach((_, index) => { inputs[`INPUT${index}`] = 'value'; });
    }
    return { fields, defaults: {}, inputs, output: protocol.kind === 'value-call', previous: protocol.kind === 'statement-call',
      next: protocol.kind === 'statement-call', extraState: extra,
      procedure: { family: 'custom-functions-v1', role: definition ? 'definition' : 'call', namePath: definition ? '/fields/FUNC_NAME' : '/fields/FUNC_NAME/id',
        ...(definition ? {} : { nameIsVariableId: true }), modelIdPath: '/extraState/funcVarId', modelType: 'FUNC',
        parametersPath: '/extraState/params', parameterNamePath: '/name', parameterTypePath: '/type',
        ...(definition ? { parameterVariableIdsPath: '/extraState/paramVarIds', parameterModelType: '' } : {}),
        returns: definition ? extra.returnType !== 'void' : protocol.kind === 'value-call', allowDiscardReturn: !definition && protocol.kind === 'statement-call' } };
  };
  const prepare = (block: AbsAbiBlock, previous: AbsAbiBlock | undefined, workspace: AbsAbiWorkspace, contracts: AbsProjectionContracts) => {
    const descriptor = describe(block.type); if (!descriptor) return;
    const definition = descriptor.protocol.kind === 'definition', state: any = block.extraState ?? {};
    if (!record(state, definition ? ['paramCount', 'returnType', 'params', 'funcVarId', 'paramVarIds', 'nextParamVarSeq'] : ['extraCount', 'funcVarId', 'params'])) fail('Unknown serializer members.');
    const params = state.params ?? [], old: any = previous?.extraState;
    if (!Array.isArray(params) || params.length > 128) fail('Invalid parameters.');
    const variables: any[] = Array.isArray(workspace['variables']) ? workspace['variables'] : [];
    const models = variables.filter(model => model.type === 'FUNC' && (definition ? model.name === block.fields?.['FUNC_NAME']
      : model.id === (block.fields?.['FUNC_NAME'] as any)?.id));
    if (models.length !== 1 || !name(models[0].name)) fail('Function requires a model owned by its definition. Check the documented function definition and signature.');
    const model = models[0];
    if (!previous && state.funcVarId !== undefined || state.funcVarId !== undefined && state.funcVarId !== model.id
      || old?.funcVarId && old.funcVarId !== model.id) fail('Function model identity cannot be supplied or retargeted.');
    if (definition) {
      const returnType = block.fields?.['RETURN_TYPE'];
      if (state.returnType !== undefined && state.returnType !== returnType && state.returnType !== old?.returnType) fail('Return type fields conflict.');
      const ids = params.map((param: any) => {
        if (!record(param, ['name', 'type'])) fail('Parameter accepts name/type only.');
        const matches = variables.filter(model => model.name === param.name && (model.type ?? '') === '');
        if (matches.length !== 1) fail('Each parameter requires a model owned by the function parameter declaration. Check the documented function signature.');
        return matches[0].id;
      });
      if (!previous && (state.paramVarIds !== undefined || state.nextParamVarSeq !== undefined)
        || state.paramVarIds !== undefined && absJson(state.paramVarIds) !== absJson(old?.paramVarIds)
        || state.nextParamVarSeq !== undefined && state.nextParamVarSeq !== old?.nextParamVarSeq) fail('Parameter model identities are host-owned.');
      if (state.paramCount !== undefined && state.paramCount !== params.length && state.paramCount !== old?.paramCount) fail('Parameter count conflicts with signature.');
      block.fields ??= {};
      (old?.params ?? []).forEach((param, index) => {
        for (const [prefix, value] of [['PARAM_NAME', param.name], ['PARAM_TYPE', param.type]]) {
          const key = prefix + index;
          const requested = prefix === 'PARAM_NAME' ? params[index]?.name : params[index]?.type;
          if (Object.hasOwn(block.fields!, key) && block.fields![key] !== value && block.fields![key] !== requested) fail('Parameter field conflicts with signature.');
          delete block.fields![key];
        }
      });
      params.forEach((param: any, index: number) => {
        for (const [prefix, value] of [['PARAM_NAME', param.name], ['PARAM_TYPE', param.type]]) {
          if (Object.hasOwn(block.fields!, prefix + index) && block.fields![prefix + index] !== value) fail('Parameter field conflicts with signature.');
        }
        block.fields![`PARAM_NAME${index}`] = param.name; block.fields![`PARAM_TYPE${index}`] = param.type;
      });
      block.extraState = { paramCount: params.length, returnType, params, funcVarId: model.id, paramVarIds: ids, nextParamVarSeq: old?.nextParamVarSeq ?? 0 };
    } else {
      if (state.extraCount !== undefined && state.extraCount !== params.length && state.extraCount !== old?.extraCount) fail('Call count conflicts with signature.');
      block.extraState = { extraCount: params.length, funcVarId: model.id, ...(params.length ? { params } : {}) };
    }
    const shape = get(block.type, block.extraState)!;
    contracts.fields[block.id] = JSON.parse(absJson(shape.fields));
    contracts.procedures ??= {}; contracts.procedures[block.id] = shape.procedure!;
  };
  const existing = (block: AbsAbiBlock) => {
    const shape = get(block.type, block.extraState);
    if (shape) {
      assertAbsDeclaredBlockShape(block, shape);
      const state: any = block.extraState;
      if (shape.procedure?.role === 'definition' && (block.fields?.['RETURN_TYPE'] !== state.returnType
        || state.params.some((param, index) => block.fields?.[`PARAM_NAME${index}`] !== param.name || block.fields?.[`PARAM_TYPE${index}`] !== param.type))) fail('Definition fields differ from its signature.');
    }
    return shape;
  };
  return { describe, field, get, prepare, existing, syntax: (source: string, workspace: AbsAbiWorkspace) => customFunctionSyntax(source, workspace, describe) };
}
