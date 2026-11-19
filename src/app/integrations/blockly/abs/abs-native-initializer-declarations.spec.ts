import { evaluateNativeCandidate } from '../../../editors/blockly-editor/services/blockly-native-candidate';
import type { NativeCandidateRequest, NativeReplayStep } from '../../../editors/blockly-editor/services/blockly-native-candidate-protocol';
import { normalizeAbsSerializedWorkspace } from './abs-serialized-workspace';
import { pidModelFixture } from './abs-native-pid-model.fixture';
import { BlocklyGeneratorRuntimeService } from '../../../editors/blockly-editor/services/blockly-generator-runtime.service';

describe('explicit native multi-model initializers', () => {
  const helper: NativeReplayStep = { kind: 'script', label: 'core-registration-protocol', source: `
    function registerVariableToBlockly(name, type) {
      const workspace = Blockly.getMainWorkspace();
      if (!workspace.getVariable(name, type)) workspace.createVariable(name, type);
    }
  ` };
  const pid = 'pid_init($myPID, $input, $output, $setpoint, custom, 2, 5, 1, DIRECT)';
  const request = (abs: string): NativeCandidateRequest => ({ blocks: [], abs: '# ABS Schema: 2\n' + abs,
    modelRequestId: 'explicit-native-initializer-test', steps: [
      { kind: 'context', mode: 'arduino' }, helper,
      { kind: 'definitions', definitions: structuredClone(pidModelFixture.blocks) },
      { kind: 'script', label: 'installed-pid-generator', source: pidModelFixture.source },
    ] });
  const run = (value: NativeCandidateRequest) => evaluateNativeCandidate(value, { assertCurrent: () => {} });
  afterEach(() => expect(document.querySelectorAll('[data-blockly-native-candidate]').length).toBe(0));
  const verify = async (value: NativeCandidateRequest, result: Awaited<ReturnType<typeof run>>) => {
    const effects = result.binding!.modelDeclarations ?? [];
    const final = await run({ blocks: [], steps: value.steps, verify: { state: normalizeAbsSerializedWorkspace(result.state),
      contracts: { fields: Object.fromEntries(result.binding!.instances.map(item => [item.id, item.shape.fields])) },
      modelDeclarations: effects.map(effect => ({ ...effect,
        ownerId: result.binding!.instances.find(item => item.start === effect.start)!.id })),
    } });
    expect(final.state['variables']).toEqual(result.state['variables']);
  };
  const generic = (source = 'self_init($device, $reading)\nself_read($device)'): NativeCandidateRequest => ({
    blocks: [], abs: '# ABS Schema: 2\n' + source, modelRequestId: 'explicit-unknown-library', steps: [
      { kind: 'context', mode: 'arduino' }, helper,
      { kind: 'definitions', definitions: [
        { type: 'self_init', message0: '%1 %2', args0: [
          { type: 'field_variable', name: 'OWNER', variableTypes: ['Device'], defaultType: 'Device' },
          { type: 'field_variable', name: 'DATA', variableTypes: ['Sample'], defaultType: 'Sample' },
        ], previousStatement: null, nextStatement: null },
        { type: 'self_read', message0: '%1', args0: [
          { type: 'field_variable', name: 'OWNER', variableTypes: ['Device'], defaultType: 'Device' },
        ], output: 'Number' },
      ] }, { kind: 'script', label: 'unrecognized-self-selecting-library', source: `
        Arduino.modelDeclarations = { self_init: { version: 1, scope: 'workspace', fields: { OWNER: 'Device', DATA: 'Sample' } } };
        Arduino.forBlock.self_init = block => {
          registerVariableToBlockly(block.getField('OWNER').getVariable().name, 'Device');
          registerVariableToBlockly(block.getField('DATA').getVariable().name, 'Sample');
          return '';
        };
        Arduino.forBlock.self_read = block => [block.getField('OWNER').getVariable().name + '.read()', 0];
      ` },
    ],
  });
  const alter = (value: NativeCandidateRequest, source: string) => value.steps.push({ kind: 'script', label: 'explicit-contract-test-change', source });

  it('supports an unknown multi-model initializer and a consumer before it in one batch', async () => {
    const value = generic('self_read($device)\nself_init($device, $reading)'), result = await run(value);
    expect(result.binding!.modelDeclarations!.map(effect => [effect.name, effect.type]))
      .toEqual([['device', 'Device'], ['reading', 'Sample']]);
    await verify(value, result);
  });

  it('does not mistake planned allocations preloaded for identity replay for committed baseline models', async () => {
    const value = generic(), first = await run(value);
    const second = await run({ ...value, variables: first.state['variables'], retainedModelCalls: [], retainedModelIds: [],
      identities: first.binding!.instances.map(instance => ({ start: instance.start, id: 'assigned-' + instance.start })), creations: [] });
    expect(second.binding!.modelDeclarations).toEqual(first.binding!.modelDeclarations);
    expect(second.state['variables']).toEqual(first.state['variables']);
    await verify(value, first);
  });

  it('keeps exactly typed saved identities even with a same-name function model', async () => {
    const value = generic();
    value.variables = [{ id: 'old-function', name: 'device', type: 'FUNC' }, { id: 'old-device', name: 'device', type: 'Device' },
      { id: 'old-data', name: 'reading', type: 'Sample' }];
    const result = await run(value);
    expect([...result.state['variables']].sort((a, b) => a.id.localeCompare(b.id)))
      .toEqual([...value.variables].sort((a, b) => a.id.localeCompare(b.id)));
    await verify(value, result);
  });

  it('rejects a wrong existing type rather than renaming or retyping it', async () => {
    const value = generic(); value.variables = [{ id: 'old', name: 'device', type: 'Other' }];
    await expectAsync(run(value)).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_SYMBOL_TYPE_MISMATCH' }));
  });

  for (const source of ['self_read($missing)', 'self_read($device)\nself_init($device, $reading) @disabled']) {
    it('does not grant model creation to a consumer or inactive owner: ' + source, async () => {
      await expectAsync(run(generic(source))).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_SYMBOL_MISSING' }));
    });
  }

  it('does not accept declaration evidence without the real helper', async () => {
    const value = generic(); value.steps.splice(1, 1);
    await expectAsync(run(value)).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_MODEL_INITIALIZER_INVALID' }));
  });

  it('accepts an explicit fixed type when the real variable field permits every type', async () => {
    const value = generic();
    (value.steps[2] as { definitions: any[] }).definitions[0].args0[0].variableTypes = null;
    const result = await run(value);
    expect(result.state['variables'].find((model: any) => model.name === 'device').type).toBe('Device');
    await verify(value, result);
  });

  for (const source of [
    `Object.defineProperty(Arduino, 'modelDeclarations', { get() { throw new Error('getter must not run'); }, enumerable: true });`,
    `Object.defineProperty(Arduino.modelDeclarations.self_init, 'fields', { get() { throw new Error('getter must not run'); }, enumerable: true });`,
    `Object.setPrototypeOf(Arduino.modelDeclarations.self_init, { borrowed: true });`,
    `Arduino.modelDeclarations.self_init.fields = new Map([['OWNER', 'Device']]);`,
    `Arduino.modelDeclarations.self_init.fields[Symbol('hidden')] = 'Device';`,
    `Arduino.modelDeclarations.self_init.fields = Object.fromEntries(Array.from({length: 33}, (_, i) => ['F' + i, 'Device']));`,
  ]) it('rejects non-data, exotic or oversized contracts without invoking accessors: ' + source, async () => {
    const value = generic(); alter(value, source);
    await expectAsync(run(value)).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_MODEL_INITIALIZER_INVALID' }));
  });

  for (const contract of [null, { version: 2, scope: 'workspace', fields: { OWNER: 'Device' } },
    { version: 1, scope: 'local', fields: { OWNER: 'Device' } },
    { version: 1, scope: 'workspace', fields: {} },
    { version: 1, scope: 'workspace', fields: { OWNER: ['Device'] } },
    { version: 1, scope: 'workspace', fields: { OWNER: 'Other' } },
    { version: 1, scope: 'workspace', fields: { MISSING: 'Device' } },
    { version: 1, scope: 'workspace', fields: { OWNER: 'Device' }, unsafe: true },
  ]) it('rejects unsupported or malformed installed producer contracts: ' + JSON.stringify(contract), async () => {
    const value = generic(); alter(value, 'Arduino.modelDeclarations.self_init = ' + JSON.stringify(contract));
    await expectAsync(run(value)).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_MODEL_INITIALIZER_INVALID' }));
  });

  it('requires an explicit variable reference, not an arbitrary scalar or inferred field default', async () => {
    await expectAsync(run(generic('self_init("device", $reading)')))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_MODEL_INITIALIZER_INVALID' }));
  });

  it('does not accept a library changing its initializer contract during preparation', async () => {
    const value = generic(); alter(value, `
      const original = Arduino.forBlock.self_init;
      Arduino.forBlock.self_init = (...args) => { const result = original(...args); Arduino.modelDeclarations.self_init.fields.DATA = 'Other'; return result; };
    `);
    await expectAsync(run(value)).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_MODEL_INITIALIZER_CHANGED' }));
  });

  it('requires real full-generation registration, not only a preparation declaration', async () => {
    const value = generic(), result = await run(value);
    alter(value, 'Arduino.forBlock.self_init = () => "";');
    await expectAsync(verify(value, result)).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_MODEL_DECLARATION_CHANGED' }));
  });

  it('detects contract changes in full generation even if registration results stay the same', async () => {
    const value = generic(), result = await run(value);
    alter(value, `
      const original = Arduino.forBlock.self_init;
      Arduino.forBlock.self_init = (...args) => { const result = original(...args); Arduino.modelDeclarations.self_init.scope = 'local'; return result; };
    `);
    await expectAsync(verify(value, result)).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_MODEL_INITIALIZER_CHANGED' }));
  });

  it('does not accept two active owners for the same newly declared models', async () => {
    await expectAsync(run(generic('self_init($device, $reading)\nself_init($device, $reading)')))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_MODEL_DECLARATION_CONFLICT' }));
  });

  it('carries actual installed generator metadata through the project runtime and native replay', async () => {
    const runtime = new BlocklyGeneratorRuntimeService();
    try {
      const generator = runtime.activate({ mode: 'arduino', getWorkspace: () => null });
      runtime.loadGenerator('core/registration.js', (helper as { source: string }).source);
      runtime.recordNativeBlockDefinitions(structuredClone(pidModelFixture.blocks), 'PID');
      await runtime.loadGenerator('pid/generator.js', pidModelFixture.source).contractsReady;
      expect((generator as any).modelDeclarations.pid_init.scope).toBe('workspace');
      const replay = runtime.captureNativeReplay();
      const value = { ...request(pid), steps: replay.steps };
      const result = await evaluateNativeCandidate(value, { assertCurrent: replay.assertCurrent });
      expect(result.state['variables'].length).toBe(4);
      await verify(value, result);
    } finally { runtime.destroy(); }
  });

  it('does not reinterpret text fields as model names', async () => {
    const value = generic('self_init("device", $reading)');
    (value.steps[2] as { definitions: any[] }).definitions[0].args0[0] = { type: 'field_input', name: 'OWNER', text: 'device' };
    await expectAsync(run(value)).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_MODEL_INITIALIZER_INVALID' }));
  });

  it('does not use declaration contracts to silently rename a saved selected model', async () => {
    const value = generic(); value.variables = [{ id: 'old-device', name: 'DEVICE', type: 'Device' }];
    await expectAsync(run(value)).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_MODEL_DECLARATION_CONFLICT' }));
  });

  for (const source of [pid + '\npid_compute($myPID)', 'pid_get_input($input)\n' + pid]) {
    it('prepares the actual PID fields without consumer-created default models: ' + source, async () => {
      const value = request(source), result = await run(value);
      expect(result.binding!.modelDeclarations!.map(effect => [effect.name, effect.type]))
        .toEqual([['input', 'double'], ['myPID', 'PID'], ['output', 'double'], ['setpoint', 'double']]);
      expect(result.state['variables'].length).toBe(4);
      await verify(value, result);
    });
  }

  it('can load the legacy PID ABI with existing typed models, preserving exact identities', async () => {
    const value = request(pid);
    value.variables = ['myPID', 'input', 'output', 'setpoint'].map((name, index) => ({
      id: 'saved-' + index, name, type: index ? 'double' : 'PID',
    }));
    const result = await run(value);
    expect(result.state['variables']).toEqual(value.variables);
  });

  it('preserves two legacy controllers sharing a saved input while one controller is edited', async () => {
    const source = pid.replace(', 2, 5, 1,', ', 3, 5, 1,') + '\n'
      + 'pid_init($secondPID, $input, $secondOutput, $secondSetpoint, custom, 2, 5, 1, DIRECT)';
    const value = request(source);
    value.variables = ['myPID', 'input', 'output', 'setpoint', 'secondPID', 'secondOutput', 'secondSetpoint'].map((name, index) => ({
      id: 'saved-shared-' + index, name, type: name.endsWith('PID') ? 'PID' : 'double',
    }));
    value.retainedModelCalls = [value.abs!.lastIndexOf('pid_init')];
    value.retainedModelIds = value.variables.map(model => model.id);
    const result = await run(value);
    expect([...result.state['variables']].sort((a, b) => a.id.localeCompare(b.id)))
      .toEqual([...value.variables].sort((a, b) => a.id.localeCompare(b.id)));
    expect(result.binding!.modelDeclarations).toBeUndefined();
    await verify(value, result);
  });

  it('lets a new controller reference an exact saved input without taking its creation owner', async () => {
    const value = request(pid); value.variables = [{ id: 'old-input', name: 'input', type: 'double' }];
    value.retainedModelCalls = [];
    value.retainedModelIds = ['old-input'];
    const result = await run(value);
    expect(result.state['variables'][0]).toEqual(value.variables[0]);
    expect(result.binding!.modelDeclarations!.map(effect => effect.name)).toEqual(['myPID', 'output', 'setpoint']);
    await verify(value, result);
  });

  it('retains inactive legacy PID fields and protection without creating extra models', async () => {
    const value = request(pid + ' @disabled');
    value.variables = ['myPID', 'input', 'output', 'setpoint'].map((name, index) => ({
      id: 'saved-disabled-' + index, name, type: index ? 'double' : 'PID',
    }));
    const result = await run(value);
    expect(result.binding!.modelDeclarations).toBeUndefined();
    const state = normalizeAbsSerializedWorkspace(result.state), block = state.blocks.blocks[0];
    Object.assign(block, { collapsed: true, deletable: false, editable: false, movable: false,
      disabledReasons: ['MANUALLY_DISABLED', 'LIBRARY_DISABLED'] });
    const final = await run({ blocks: [], steps: value.steps, verify: { state,
      contracts: { fields: Object.fromEntries(result.binding!.instances.map(item => [item.id, item.shape.fields])) },
    } });
    expect(final.state['variables']).toEqual(value.variables);
    expect(final.state['blocks']['blocks'][0]).toEqual(jasmine.objectContaining({ collapsed: true, deletable: false,
      editable: false, movable: false, disabledReasons: ['MANUALLY_DISABLED', 'LIBRARY_DISABLED'] }));
  });

  it('does not grant creation to a lone consuming PID field', async () => {
    await expectAsync(run(request('pid_compute($missing)')))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_SYMBOL_MISSING' }));
  });
});
