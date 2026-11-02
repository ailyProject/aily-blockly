import { evaluateNativeCandidate } from '../../../editors/blockly-editor/services/blockly-native-candidate';
import type { NativeCandidateRequest } from '../../../editors/blockly-editor/services/blockly-native-candidate-protocol';
import { normalizeAbsSerializedWorkspace } from './abs-serialized-workspace';
import { pidModelFixture } from './abs-native-pid-model.fixture';

describe('explicit shared native initializer models', () => {
  const source = 'shared_init($left, $sample)\nshared_init($right, $sample)';
  const make = (abs = source): NativeCandidateRequest => ({
    blocks: [], abs: '# ABS Schema: 2\n' + abs, modelRequestId: 'shared-native-model-test',
    retainedModelIds: [], retainedModelCalls: [], steps: [
      { kind: 'context', mode: 'arduino' },
      { kind: 'script', label: 'native-registration', source: `
        function registerVariableToBlockly(name, type) {
          const workspace = Blockly.getMainWorkspace();
          if (!workspace.getVariable(name, type)) workspace.createVariable(name, type);
        }
      ` },
      { kind: 'definitions', definitions: [{ type: 'shared_init', message0: '%1 %2', args0: [
        { type: 'field_variable', name: 'OWNER', variableTypes: ['Device'], defaultType: 'Device' },
        { type: 'field_variable', name: 'DATA', variableTypes: ['Sample'], defaultType: 'Sample' },
      ], previousStatement: null, nextStatement: null }] },
      { kind: 'script', label: 'explicit-sharing-contract', source: `
        Arduino.modelDeclarations = { shared_init: { version: 1, scope: 'workspace',
          fields: { OWNER: 'Device', DATA: 'Sample' }, shared: ['DATA'] } };
        Arduino.forBlock.shared_init = block => {
          registerVariableToBlockly(block.getField('OWNER').getVariable().name, 'Device');
          registerVariableToBlockly(block.getField('DATA').getVariable().name, 'Sample');
          return '';
        };
      ` },
    ],
  });
  const run = (value: NativeCandidateRequest) => evaluateNativeCandidate(value, { assertCurrent: () => {} });
  const alter = (value: NativeCandidateRequest, source: string) => value.steps.push({ kind: 'script', label: 'contract-negative', source });
  const verify = async (value: NativeCandidateRequest, result: Awaited<ReturnType<typeof run>>) => {
    const final = await run({ blocks: [], steps: value.steps, verify: {
      state: normalizeAbsSerializedWorkspace(result.state),
      contracts: { fields: Object.fromEntries(result.binding!.instances.map(item => [item.id, item.shape.fields])) },
      modelDeclarations: (result.binding!.modelDeclarations ?? []).map(effect => ({ ...effect,
        ownerId: result.binding!.instances.find(item => item.start === effect.start)!.id })),
    } });
    expect(final.state['variables']).toEqual(result.state['variables']);
  };
  afterEach(() => expect(document.querySelectorAll('[data-blockly-native-candidate]').length).toBe(0));

  it('creates one shared model in a batch and retains the canonical producer through identity replay', async () => {
    const value = make(), first = await run(value);
    expect(first.state['variables'].map((item: any) => item.name).sort()).toEqual(['left', 'right', 'sample']);
    expect(first.binding!.modelDeclarations!.filter(item => item.name === 'sample').length).toBe(1);
    const replay = await run({ ...value, variables: first.state['variables'], creations: [],
      identities: first.binding!.instances.map(item => ({ start: item.start, id: 'assigned-' + item.start })) });
    expect(replay.binding!.modelDeclarations).toEqual(first.binding!.modelDeclarations);
    await verify(value, first);
  });

  it('preserves a shared bootstrap identity without publishing it as a new declaration', async () => {
    const value = make(); value.variables = [{ id: 'saved-sample', name: 'sample', type: 'Sample' }];
    value.retainedModelIds = ['saved-sample'];
    const result = await run(value);
    expect(result.state['variables'].find((item: any) => item.id === 'saved-sample')).toEqual(value.variables[0]);
    expect(result.binding!.modelDeclarations!.map(item => item.name).sort()).toEqual(['left', 'right']);
    await verify(value, result);
  });

  it('keeps exclusive object declarations exclusive', async () => {
    await expectAsync(run(make(source.replace('$right', '$left'))))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_MODEL_DECLARATION_CONFLICT' }));
  });

  it('supports a different explicit producer type that only shares data', async () => {
    const value = make('shared_init($left, $sample)\nshare_data($sample)');
    const definitions = value.steps[2];
    if (definitions.kind !== 'definitions') throw new Error('Missing fixture definitions');
    definitions.definitions.push({ type: 'share_data', message0: '%1', args0: [
      { type: 'field_variable', name: 'DATA', variableTypes: ['Sample'], defaultType: 'Sample' },
    ], previousStatement: null, nextStatement: null });
    alter(value, `Arduino.modelDeclarations.share_data = { version: 1, scope: 'workspace',
      fields: { DATA: 'Sample' }, shared: ['DATA'] };
      Arduino.forBlock.share_data = () => { registerVariableToBlockly('sample', 'Sample'); return ''; };`);
    const result = await run(value);
    expect(result.state['variables'].length).toBe(2);
    expect(result.binding!.modelDeclarations!.map(effect => effect.blockType)).toEqual(['shared_init', 'shared_init']);
    await verify(value, result);
  });

  for (const reversed of [false, true]) {
    it('requires both new producers to allow sharing, in either order: ' + reversed, async () => {
      const lines = ['shared_init($left, $sample)', 'exclusive_init($right, $sample)'];
      const value = make((reversed ? lines.reverse() : lines).join('\n'));
      const definitions = value.steps[2];
      if (definitions.kind !== 'definitions') throw new Error('Missing fixture definitions');
      definitions.definitions.push({ ...structuredClone(definitions.definitions[0]), type: 'exclusive_init' });
      alter(value, `Arduino.modelDeclarations.exclusive_init = { version: 1, scope: 'workspace',
        fields: { OWNER: 'Device', DATA: 'Sample' } };
        Arduino.forBlock.exclusive_init = Arduino.forBlock.shared_init;`);
      await expectAsync(run(value)).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_MODEL_DECLARATION_CONFLICT' }));
    });
  }

  it('does not let a consumer claim another producer\'s shared storage', async () => {
    const value = make(source + '\nshared_read($sample)');
    const definitions = value.steps[2];
    if (definitions.kind !== 'definitions') throw new Error('Missing fixture definitions');
    definitions.definitions.push({ type: 'shared_read', message0: '%1', args0: [
      { type: 'field_variable', name: 'DATA', variableTypes: ['Sample'], defaultType: 'Sample' },
    ], previousStatement: null, nextStatement: null });
    alter(value, `Arduino.forBlock.shared_read = () => '';`);
    const result = await run(value);
    const steps = [...value.steps, { kind: 'script' as const, label: 'consumer-is-not-producer', source: `
      Arduino.forBlock.shared_read = () => { registerVariableToBlockly('sample', 'Sample'); return ''; };
    ` }];
    await expectAsync(verify({ ...value, steps }, result))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_MODEL_DECLARATION_CHANGED' }));
  });

  for (const invalid of ["['MISSING']", "['DATA', 'DATA']", "['DATA', 7]", "'DATA'", "new Array(1)"]) {
    it('rejects an invalid shared-field declaration: ' + invalid, async () => {
      const value = make(); alter(value, 'Arduino.modelDeclarations.shared_init.shared = ' + invalid + ';');
      await expectAsync(run(value)).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_MODEL_INITIALIZER_INVALID' }));
    });
  }

  it('does not invoke an accessor in a shared-field list', async () => {
    const value = make(); alter(value, `Object.defineProperty(Arduino.modelDeclarations.shared_init.shared, '0', {
      enumerable: true, get() { throw new Error('sharing getter must never execute'); } });`);
    await expectAsync(run(value)).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_MODEL_INITIALIZER_INVALID' }));
  });

  it('does not let a secondary shared producer replace the canonical owner proof', async () => {
    const value = make(), result = await run(value);
    const steps = [...value.steps, { kind: 'script' as const, label: 'missing-primary-proof', source: `
      const original = Arduino.forBlock.shared_init;
      Arduino.forBlock.shared_init = block => {
        if (block.getField('OWNER').getVariable().name !== 'left') return original(block);
        registerVariableToBlockly('left', 'Device'); return '';
      };
    ` }];
    await expectAsync(verify({ ...value, steps }, result))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_MODEL_DECLARATION_CHANGED' }));
  });

  it('rejects changing sharing semantics during complete generation', async () => {
    const value = make(), result = await run(value);
    const steps = [...value.steps, { kind: 'script' as const, label: 'changing-sharing-contract', source: `
      const original = Arduino.forBlock.shared_init;
      Arduino.forBlock.shared_init = block => {
        const result = original(block); Arduino.modelDeclarations.shared_init.shared = []; return result;
      };
    ` }];
    await expectAsync(verify({ ...value, steps }, result))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_MODEL_INITIALIZER_CHANGED' }));
  });

  it('supports two real PID initializers sharing new storage without sharing the controller objects', async () => {
    const value = make('pid_init($one, $input, $outputOne, $setpoint, custom, 2, 5, 1, DIRECT)\n'
      + 'pid_init($two, $input, $outputTwo, $setpoint, custom, 3, 5, 1, DIRECT)');
    value.steps[2] = { kind: 'definitions', definitions: structuredClone(pidModelFixture.blocks) };
    value.steps[3] = { kind: 'script', label: 'actual-pid-sharing', source: pidModelFixture.source };
    const result = await run(value);
    expect(result.state['variables'].length).toBe(6);
    expect(result.binding!.modelDeclarations!.filter(item => item.name === 'input').length).toBe(1);
    expect(result.binding!.modelDeclarations!.filter(item => item.name === 'setpoint').length).toBe(1);
    await verify(value, result);
  });
});
