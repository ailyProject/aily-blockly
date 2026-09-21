import { evaluateNativeCandidate } from '../../../editors/blockly-editor/services/blockly-native-candidate';
import { assertSynchronousNativeCandidate } from '../../../editors/blockly-editor/services/blockly-native-candidate-policy';
import type { NativeCandidateRequest } from '../../../editors/blockly-editor/services/blockly-native-candidate-protocol';
import { createAbsProjection } from './abs-identity-map';
import { reconcileAbsDraft } from './abs-reconciler';

describe('mixed host preparation and native discovery boundary', () => {
  const source = '# ABS Schema: 2\nhost_model("work")\n    native_number(7)';
  const request = (): NativeCandidateRequest => ({ abs: source, blocks: [],
    hostCalls: [{ start: source.indexOf('host_model'), type: 'host_model', argumentOrder: [
      { name: 'NAME', kind: 'field' }, { name: 'BODY', kind: 'statementInput' },
    ] }], steps: [{ kind: 'script', label: 'no-discovery-model-effects', source: `
      Blockly.Blocks.host_model = { init() { throw Error('host model initialized during discovery'); } };
    ` }, { kind: 'definitions', definitions: [
      { type: 'native_number', message0: '%1', args0: [{ type: 'field_number', name: 'NUM', value: 0 }], output: 'Number' },
    ] }] });
  const run = (input: NativeCandidateRequest) => evaluateNativeCandidate(input, { assertCurrent: () => {} });
  afterEach(() => expect(document.querySelector('[data-blockly-native-candidate]')).toBeNull());

  it('binds all source calls but executes only native calls; does not claim a cross-boundary connection was checked', async () => {
    const input = request(), result = await run(input);
    expect(result.binding!.syntax[0].fields['NAME'].value).toBe('work');
    expect(result.binding!.syntax[0].inputs['BODY']!.type).toBe('native_number');
    expect(result.binding!.instances.map(item => item.type)).toEqual(['native_number']);
    expect(result.state['blocks'].blocks.map(block => block.type)).toEqual(['native_number']);
    expect(result.binding!.hostCalls).toEqual(input.hostCalls!);
    input.identities = [{ start: source.indexOf('host_model'), id: 'host-final' }, { start: source.indexOf('native_number'), id: 'native-final' }];
    expect((await run(input)).binding!.instances[0].id).toBe('native-final');
  });

  it('does not accept caller-supplied hosted evidence without a captured preparation adapter', async () => {
    const binding = (await run(request())).binding!;
    const workspace = { blocks: { blocks: [] } };
    const base = await createAbsProjection(workspace, { document: workspace, contracts: { fields: {} },
      generation: 'g', baselineRef: 'b', savedAbiHash: null, scope: { projectKey: 'p', pageId: 'main' } });
    for (const options of [{}, { hostPrepared: () => true }]) {
      await expectAsync(reconcileAbsDraft(base, source, { ...options, nativeBinding: binding }))
        .toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_NATIVE_BINDING_INVALID' }));
    }
  });

  it('carries host-prepared shorthand state without constructing the model block', async () => {
    const input = request();
    input.hostCalls![0].extraState = { params: [{ type: 'int', name: 'amount' }] };
    const result = await run(input);
    expect(result.binding!.syntax[0].extraState).toEqual(input.hostCalls![0].extraState);
    expect(result.binding!.hostCalls).toEqual(input.hostCalls!);
    expect(result.binding!.instances.map(item => item.type)).toEqual(['native_number']);
  });

  it('rejects unused, wrong-type and duplicate host call descriptors', async () => {
    for (const mutate of [input => { input.hostCalls[0].start = 0; }, input => { input.hostCalls[0].type = 'other'; },
      input => { input.hostCalls.push(input.hostCalls[0]); }]) {
      const input = request(); mutate(input); await expectAsync(run(input)).toBeRejected();
    }
  });

  it('validates hosted binding transport and keeps ABI verification separate', () => {
    const sameName = request();
    sameName.hostCalls![0].argumentOrder = [{ name: 'NAME', kind: 'field' }, { name: 'NAME', kind: 'valueInput' }];
    expect(() => assertSynchronousNativeCandidate(sameName)).not.toThrow();
    sameName.hostCalls![0].argumentOrder[1].kind = 'field';
    expect(() => assertSynchronousNativeCandidate(sameName)).toThrow();
    for (const change of [
      { hostCalls: [{ start: -1, type: 'host_model' }] },
      { hostCalls: [{ start: 0, type: 'host_model', argumentOrder: [{ name: 'X', kind: 'guessed' }] }] },
      { verify: { state: { blocks: { blocks: [] } }, contracts: { fields: {} } } },
      { abs: undefined },
    ]) expect(() => assertSynchronousNativeCandidate({ ...request(), ...change } as NativeCandidateRequest)).toThrow();
  });
});
