import { captureCustomFunctionRegistration, clearCustomFunctionRegistration, registerCustomFunctionContract } from '../../../editors/blockly-editor/services/blockly-custom-function-contract';

describe('custom function runtime registration lifecycle', () => {
  const auditedHash = '4d3a8f44d8fbeffc76bdfe6648fa076e2474505ab359a81cd64bfa98aaef592b';
  // These unit tests isolate lifecycle checks. Real Electron tests use the actual
  // read-only generator source and real Web Crypto, not this digest substitute.
  const source = 'var functionParamsMutator = {}; function registerFunction() {}';
  const setup = () => {
    let active = true;
    const owner = {}, registry: any = { custom_function_call_advance: { init() {} }, custom_function_call_return_advance: { init() {} } };
    const realm: any = { functionParamsMutator: { loadExtraState() {} }, functionCallSyncMutator: { saveExtraState() {} }, registerFunction() {},
      _PARAM_TYPE_OPTIONS_FALLBACK: [['int', 'int'], ['separator', '---']],
      Blockly: { Extensions: { TEST_ONLY: { allExtensions: { function_params_mutator() {} } } } } };
    return { owner, registry, realm, current: () => active, deactivate: () => { active = false; },
      define: () => { registry.custom_function_def = { init() {} }; } };
  };
  const acceptDigest = () => spyOn(window.crypto.subtle, 'digest').and.resolveTo(Uint8Array.from(auditedHash.match(/../g)!, byte => parseInt(byte, 16)).buffer);
  it('rejects unknown source even when names and registration shapes match', async () => {
    const f = setup(); f.define();
    await registerCustomFunctionContract(source, f.realm, f.registry, f.owner, f.current);
    expect(captureCustomFunctionRegistration(f.registry)).toBeUndefined();
  });
  it('supports generator-before-block-json loading without treating missing JSON as permission', async () => {
    acceptDigest(); const f = setup();
    await registerCustomFunctionContract(source, f.realm, f.registry, f.owner, f.current);
    expect(captureCustomFunctionRegistration(f.registry)?.get('custom_function_def')).toBeUndefined();
    f.define(); const snapshot = captureCustomFunctionRegistration(f.registry)!;
    expect(snapshot.get('custom_function_def')).toEqual({ kind: 'definition', parameterTypes: ['int'] });
    f.registry.custom_function_def = { init() {} };
    expect(() => snapshot.assertCurrent()).toThrow();
  });
  it('invalidates captured permissions on script callbacks, extension, options or session changes', async () => {
    acceptDigest();
    for (const mutate of [f => { f.realm.functionCallSyncMutator.saveExtraState = () => {}; },
      f => { f.realm.registerFunction = () => {}; },
      f => { f.realm.Blockly.Extensions.TEST_ONLY.allExtensions.function_params_mutator = () => {}; },
      f => { f.realm._PARAM_TYPE_OPTIONS_FALLBACK.push(['float', 'float']); }, f => f.deactivate()]) {
      const f = setup(); f.define();
      await registerCustomFunctionContract(source, f.realm, f.registry, f.owner, f.current);
      const snapshot = captureCustomFunctionRegistration(f.registry)!;
      expect(snapshot.get('custom_function_call_advance')).toBeDefined(); mutate(f);
      expect(() => snapshot.assertCurrent()).toThrow();
    }
  });
  it('rejects registration that finishes after its runtime is replaced and honors cleanup ownership', async () => {
    acceptDigest(); const f = setup(); f.define();
    const pending = registerCustomFunctionContract(source, f.realm, f.registry, f.owner, f.current); f.deactivate(); await pending;
    expect(captureCustomFunctionRegistration(f.registry)).toBeUndefined();
    const fresh = setup(); fresh.define();
    await registerCustomFunctionContract(source, fresh.realm, fresh.registry, fresh.owner, fresh.current);
    clearCustomFunctionRegistration(fresh.registry, {});
    expect(captureCustomFunctionRegistration(fresh.registry)).toBeDefined();
    clearCustomFunctionRegistration(fresh.registry, fresh.owner);
    expect(captureCustomFunctionRegistration(fresh.registry)).toBeUndefined();
  });
  it('rebuilds only derived registry state and owns detached copies', async () => {
    acceptDigest(); const f = setup(); f.define();
    await registerCustomFunctionContract(source, f.realm, f.registry, f.owner, f.current);
    const instance: any = {}, params = [{ name: 'amount', type: 'int' }];
    const state = { blocks: { blocks: [{ id: 'def', type: 'custom_function_def', fields: { FUNC_NAME: 'work', RETURN_TYPE: 'int' },
      extraState: { params, funcVarId: 'func', paramVarIds: ['param'] } }] } };
    const snapshot = captureCustomFunctionRegistration(f.registry)!;
    snapshot.synchronize({ getBlockById: () => instance } as any, state);
    expect(instance._funcLastName).toBe('work'); expect(f.realm.customFunctionRegistry.work.variableId).toBe('func');
    params[0].name = 'changed'; expect(f.realm.customFunctionRegistry.work.params[0].name).toBe('amount');
    snapshot.synchronize({} as any, { blocks: { blocks: [] } });
    expect(f.realm.customFunctionRegistry).toEqual({});
  });
  it('restores a delayed-reset lookup before caller serialization without reading callers', async () => {
    acceptDigest(); const f = setup(); f.define();
    f.realm.functionParamsMutator.saveExtraState = function() { return this.extra; };
    await registerCustomFunctionContract(source, f.realm, f.registry, f.owner, f.current);
    const definition: any = { type: 'custom_function_def', id: 'def', getFieldValue: name => name === 'FUNC_NAME' ? 'work' : 'int',
      extra: { params: [{ name: 'amount', type: 'float' }], funcVarId: 'func', paramVarIds: ['param'] } };
    const caller = { type: 'custom_function_call_advance', saveExtraState() { throw new Error('Must not read a stale caller'); } };
    const workspace: any = { getAllBlocks: () => [caller, definition], getBlockById: () => definition };
    const snapshot = captureCustomFunctionRegistration(f.registry)!;
    snapshot.prepareSerialization(workspace); f.realm.customFunctionRegistry = {};
    snapshot.prepareSerialization(workspace);
    expect(f.realm.customFunctionRegistry.work.params).toEqual([{ name: 'amount', type: 'float' }]);
    expect(definition._funcLastName).toBe('work');
    definition.getFieldValue = name => name === 'FUNC_NAME' ? 'pending_edit' : 'int';
    snapshot.prepareSerialization(workspace);
    expect(definition._funcLastName).toBe('work'); expect(f.realm.customFunctionRegistry.pending_edit).toBeUndefined();
    snapshot.prepareSerialization(workspace, true);
    expect(definition._funcLastName).toBe('pending_edit');
  });
});
