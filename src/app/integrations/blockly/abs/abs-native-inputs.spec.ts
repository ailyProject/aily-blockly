import * as Blockly from 'blockly';
import { evaluateNativeCandidate } from '../../../editors/blockly-editor/services/blockly-native-candidate';
import type { NativeCandidateRequest } from '../../../editors/blockly-editor/services/blockly-native-candidate-protocol';
import { createAilyProjectDataValue } from '@domain/project/public-api';

describe('native candidate owned model and resource inputs', () => {
  const variable = { type: 'variables_get', message0: '%1', args0: [{ type: 'field_variable', name: 'VAR', variable: 'unused-default' }], output: null };
  const holder = { type: 'native_model_input', message0: '%1 %2', args0: [
    { type: 'field_variable', name: 'SELECT', variable: 'unused-default' }, { type: 'input_value', name: 'VALUE' },
  ], output: null };
  const request = (code: string): NativeCandidateRequest => ({ blocks: [], abs: '# ABS Schema: 2\n' + code,
    variables: [{ id: 'counter-id', name: 'counter', type: '' }],
    steps: [{ kind: 'definitions', definitions: [variable, holder] }] });
  const run = (value: NativeCandidateRequest) => evaluateNativeCandidate(value, { assertCurrent: () => {} });
  afterEach(() => expect(document.querySelector('[data-blockly-native-candidate]')).toBeNull());

  for (const value of ['variables_get($counter)', '$counter']) it(`binds a variable dropdown and value input (${value}) without incidental default models`, async () => {
    const probe = spyOn(Blockly.Workspace.prototype, 'createVariable').and.callThrough();
    const result = await run(request(`native_model_input($counter, ${value})`));
    const root = result.state['blocks'].blocks[0];
    expect(root.fields.SELECT).toEqual({ id: 'counter-id' });
    expect(root.inputs.VALUE.block.type).toBe('variables_get');
    expect(root.inputs.VALUE.block.fields.VAR).toEqual({ id: 'counter-id' });
    expect(result.state['variables']).toEqual([{ id: 'counter-id', name: 'counter' }]);
    expect(result.binding!.instances.find(instance => instance.type === 'native_model_input')!.shape.fields['SELECT'].symbol)
      .toEqual({ kind: 'variable', storage: 'variable-state' });
    expect(probe).not.toHaveBeenCalled();
  });

  it('resolves typed models by the actual field protocol and rejects missing/ambiguous names', async () => {
    const input = request('variables_get($counter)');
    input.variables!.push({ id: 'typed-id', name: 'counter', type: 'typed' });
    await expectAsync(run(input)).toBeRejectedWithError(/Cannot uniquely resolve/);
    (input.steps[0] as any).definitions[0] = { ...variable, args0: [{ ...variable.args0[0], variableTypes: ['typed'], defaultType: 'typed' }] };
    expect((await run(input)).state['blocks'].blocks[0].fields.VAR).toEqual({ id: 'typed-id' });
    input.abs = '# ABS Schema: 2\nvariables_get($missing)';
    await expectAsync(run(input)).toBeRejectedWithError(/Cannot uniquely resolve/);
  });

  for (const effect of [
    `this.workspace.createVariable('extra')`,
    `this.workspace.renameVariableById('counter-id', 'renamed')`,
    `this.workspace.deleteVariableById('counter-id')`,
    `try { Blockly.Blocks.callback_registered = {init(){}}; } catch {}`,
    `try { Blockly.defineBlocksWithJsonArray([{type:'callback_registered',message0:'extra'}]); } catch {}`,
  ]) it(`does not adopt callback model effects: ${effect}`, async () => {
    const input = request('native_model_input($counter, null)');
    input.steps.push({ kind: 'script', label: 'model-effect', source: `
      const init = Blockly.Blocks.native_model_input.init;
      Blockly.Blocks.native_model_input.init = function() { init.call(this); ${effect}; };
    ` });
    await expectAsync(run(input)).toBeRejected();
  });

  const ref = { $ailyData: { schemaVersion: 1 as const, id: `sha256:${'a'.repeat(64)}` as `sha256:${string}`,
    logicalType: 'text' as const, codec: 'utf8-v1', storage: 'raw-v1' as const, rawLength: 40000, storedLength: 40000 } };
  const resource = (): NativeCandidateRequest => ({ blocks: [],
    abs: '# ABS Schema: 2\nnative_text(' + JSON.stringify(createAilyProjectDataValue(ref)) + ')',
    values: [{ ref, value: 'x'.repeat(40000) }], steps: [{ kind: 'definitions', definitions: [
      { type: 'native_text', message0: '%1', args0: [{ type: 'field_input', name: 'TEXT', text: '' }], output: null },
    ] }] });

  it('hydrates a large field from a detached value snapshot while retaining compact ABS tokens and offsets', async () => {
    const input = resource(), result = await run(input);
    expect(result.state['blocks'].blocks[0].fields.TEXT).toBe('x'.repeat(40000));
    expect(result.binding!.source).toBe(input.abs!);
    expect(result.binding!.syntax[0].fields['TEXT'].value).toEqual(createAilyProjectDataValue(ref));
    expect(input.abs!.slice(result.binding!.syntax[0].fieldRanges['TEXT'].start, result.binding!.syntax[0].fieldRanges['TEXT'].end))
      .toBe(JSON.stringify(createAilyProjectDataValue(ref)));
    expect(input.values![0].value).toBe('x'.repeat(40000));
  });

  it('rejects missing/changed/duplicate snapshots instead of silently using empty values', async () => {
    const missing = resource(); missing.values = [];
    await expectAsync(run(missing)).toBeRejectedWithError(/not prepared/);
    const altered = resource(); altered.values = [{ ref: { $ailyData: { ...ref.$ailyData, rawLength: 1 } }, value: 'x' }];
    await expectAsync(run(altered)).toBeRejectedWithError(/metadata changed/);
    const duplicate = resource(); duplicate.values!.push(duplicate.values![0]);
    await expectAsync(run(duplicate)).toBeRejectedWithError(/duplicate references/);
    const wrongType = resource(); wrongType.values![0].value = [1, 2];
    await expectAsync(run(wrongType)).toBeRejectedWithError(/invalid utf8-v1 value/);
  });

  it('hydrates nested JSON/array extraState through the same payload mechanism, without changing ABS metadata', async () => {
    const jsonRef = { $ailyData: { ...ref.$ailyData, codec: 'canonical-json-v1', logicalType: 'json' as const } };
    const payload = { frames: [[1, 2], [3, 4]], labels: ['one', 'two'] };
    const input = resource();
    input.values = [{ ref: jsonRef, value: payload }];
    const extra = { payload: createAilyProjectDataValue(jsonRef) };
    input.abs = '# ABS Schema: 2\nnative_text("header") @extra:' + JSON.stringify(extra);
    input.steps.push({ kind: 'script', label: 'opaque-native-state', source: `
      const init = Blockly.Blocks.native_text.init;
      Blockly.Blocks.native_text.init = function() { init.call(this);
        this.loadExtraState = state => { this.payload = state.payload; };
        this.saveExtraState = () => ({payload: this.payload});
      };
    ` });
    const result = await run(input);
    expect(result.state['blocks'].blocks[0].extraState).toEqual({ payload });
    expect(result.binding!.syntax[0].extraState).toEqual(extra);
    expect(input.values[0].value).toEqual(payload);
  });
});
