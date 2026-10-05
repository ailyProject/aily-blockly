import * as Blockly from 'blockly';
import { assertAbsReadback, createAbsReadbackVerifier } from './abs-readback';
import { AbsAbiWorkspace } from './abs-state';
import { captureAbsRuntimeContracts } from './abs-runtime-contracts';

describe('ABS complete readback and explicit defaults', () => {
  const graph = (): AbsAbiWorkspace => ({ blocks: { languageVersion: 0, blocks: [{ type: 'root', id: 'r', x: 30, y: 40,
    deletable: false, data: 'opaque', icons: { comment: { text: 'comment' } }, inputs: {
      INPUT: { block: { type: 'child', id: 'c', fields: { TEXT: 'same' } }, shadow: { type: 'child', id: 's', fields: { TEXT: 'shadow' } } },
    }, next: { block: { type: 'tail', id: 't' } } }] }, customSerializer: { data: [1, false] } });
  const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  it('owns the expected graph and options independently of callers and previously verified readbacks', () => {
    const expected = graph(), actual = graph();
    const options = { mode: 'complete' as const };
    const verify = createAbsReadbackVerifier(expected, options);
    expected.blocks.blocks[0]['data'] = 'caller changed';
    (options as any).mode = 'requested';
    verify(actual);
    actual.blocks.blocks[0].inputs!['INPUT'].shadow!.fields!['TEXT'] = 'changed later';
    expect(() => verify(actual)).toThrow();
    expect(() => verify(graph())).not.toThrow();
    const extra = graph(); extra.blocks.blocks.push({ type: 'child', id: 'extra' });
    expect(() => verify(extra)).toThrow();
  });
  it('rechecks complete current topology, models, constraints and serializer contents after successful reads', () => {
    const expected = graph(); expected['variables'] = [{ id: 'v', name: 'value', type: '', opaque: 7 }];
    const verify = createAbsReadbackVerifier(expected);
    const changes: Array<(state: AbsAbiWorkspace) => void> = [
      state => { state.blocks.blocks[0].inputs!['OTHER'] = state.blocks.blocks[0].inputs!['INPUT']; delete state.blocks.blocks[0].inputs!['INPUT']; },
      state => { state.blocks.blocks[0].next!.block!.id = 'r'; },
      state => { state.blocks.blocks[0]['deletable'] = true; },
      state => { state.blocks.blocks[0].inputs!['INPUT']['metadata'] = 'extra'; },
      state => { (state['variables'] as any[])[0].opaque = 8; },
      state => { state['customSerializer'] = { data: [1, true] }; },
    ];
    for (const change of changes) {
      const actual = clone(expected); verify(actual); change(actual);
      expect(() => verify(actual)).toThrow();
      expect(() => verify(clone(expected))).not.toThrow();
    }
  });
  it('does not cache field contract callbacks or accept inconsistent variable-state models', () => {
    const expected: AbsAbiWorkspace = { variables: [{ id: 'v', name: 'value', type: '' }],
      blocks: { blocks: [{ id: 'b', type: 'child', fields: { VAR: { id: 'v', name: 'wrong' } } }] } };
    let typed = false;
    const definition = jasmine.createSpy('fieldDefinition').and.callFake(() => typed
      ? { type: 'field_variable', symbol: { kind: 'variable', storage: 'variable-state' } } : undefined);
    const verify = createAbsReadbackVerifier(expected, { fieldDefinition: definition });
    verify(clone(expected)); expect(definition).toHaveBeenCalledTimes(2);
    typed = true;
    expect(() => verify(clone(expected))).toThrow();
    expect(definition.calls.count()).toBeGreaterThan(2);
  });
  it('preserves requested-mode defaults and complete-mode normalization in a reusable verifier', () => {
    const expected: AbsAbiWorkspace = { blocks: { blocks: [{ id: 'b', type: 'child', x: 30.5, y: 70.8,
      enabled: false, fields: { C: 'FALSE' } }] } };
    const actual = clone(expected); actual.blocks.blocks[0]['x'] = 31; actual.blocks.blocks[0]['y'] = 71;
    delete actual.blocks.blocks[0]['enabled']; actual.blocks.blocks[0]['disabledReasons'] = ['MANUALLY_DISABLED'];
    actual.blocks.blocks[0].fields!['C'] = false;
    const fieldDefinition = () => ({ type: 'field_checkbox' });
    const complete = createAbsReadbackVerifier(expected, { fieldDefinition });
    expect(() => complete(actual)).not.toThrow();
    actual.blocks.blocks[0]['editable'] = false;
    expect(() => complete(actual)).toThrow();
    const requested = createAbsReadbackVerifier(expected, { mode: 'requested', fieldDefinition });
    expect(() => requested(actual)).not.toThrow();
    const strict = clone(expected); strict.blocks.blocks[0]['editable'] = true;
    expect(() => createAbsReadbackVerifier(strict, { mode: 'requested', fieldDefinition })(actual)).toThrow();
  });
  it('does not retain actual state or trust a successful read as a future revision', () => {
    const actual = graph(); let text = 'same';
    Object.defineProperty(actual.blocks.blocks[0].inputs!['INPUT'].block!.fields!, 'TEXT', { enumerable: true, get: () => text });
    const verify = createAbsReadbackVerifier(graph());
    verify(actual); text = 'mutated without events';
    expect(() => verify(actual)).toThrow();
    text = 'same'; expect(() => verify(actual)).not.toThrow();
  });
  it('compares all hidden attributes and arbitrary serializers without name heuristics', () => {
    for (const key of ['data', 'icons', 'deletable']) {
      const expected = graph(), actual = graph();
      delete actual.blocks.blocks[0][key];
      expect(() => assertAbsReadback(expected, actual)).toThrow();
    }
    const actual = graph(); delete actual['customSerializer'];
    expect(() => assertAbsReadback(graph(), actual)).toThrow();
    expect(() => assertAbsReadback(graph(), actual, { mode: 'requested' })).toThrow();
  });
  it('detects a disconnected, moved or retyped child even with the same field values and IDs', () => {
    for (const change of ['disconnect', 'move', 'type']) {
      const actual = graph(); const input = actual.blocks.blocks[0].inputs!['INPUT'];
      if (change === 'disconnect') { actual.blocks.blocks.push(input.block!); delete input.block; }
      if (change === 'move') { actual.blocks.blocks[0].inputs!['OTHER'] = input; delete actual.blocks.blocks[0].inputs!['INPUT']; }
      if (change === 'type') input.block!.type = 'replacement';
      expect(() => assertAbsReadback(graph(), actual, { mode: 'requested' })).toThrow();
    }
  });
  it('rejects extra blocks, missing shadows and changed root order in complete mode', () => {
    const actual = graph(); actual.blocks.blocks.push({ type: 'surprise', id: 'new' });
    expect(() => assertAbsReadback(graph(), actual)).toThrow();
    const reordered = clone(actual); reordered.blocks.blocks.reverse();
    expect(() => assertAbsReadback(actual, reordered)).toThrow();
    delete actual.blocks.blocks[0].inputs!['INPUT'].shadow;
    expect(() => assertAbsReadback(graph(), actual, { mode: 'requested' })).toThrow();
  });
  it('requires defaults in the prepared candidate and rejects additional state even for new blocks', () => {
    const expected: AbsAbiWorkspace = { blocks: { blocks: [{ type: 'custom', id: 'n' }] } };
    const actual = clone(expected); actual.blocks.blocks[0].fields = { default: 'value' };
    expect(() => assertAbsReadback(expected, actual)).toThrow();
    expected.blocks.blocks[0].fields = { default: 'value' };
    expect(() => assertAbsReadback(expected, actual)).not.toThrow();
    expected.blocks.blocks[0].extraState = { requested: 'kept' };
    expect(() => assertAbsReadback(expected, actual)).toThrow();
  });
  it('treats variables as ID-keyed models, preserving every row and opaque attribute', () => {
    const expected = graph(); expected['variables'] = [{ id: 'a', name: 'A', type: '', custom: 1 }, { id: 'b', name: 'B' }];
    const actual = clone(expected); (actual['variables'] as any[]).reverse();
    expect(() => assertAbsReadback(expected, actual)).not.toThrow();
    (actual['variables'] as any[])[1].custom = 2;
    expect(() => assertAbsReadback(expected, actual)).toThrow();
  });
  it('normalizes only native serializer defaults, coordinates, disabled reasons and checkbox forms', () => {
    const ws = new Blockly.Workspace();
    Blockly.Blocks['abs_full_readback'] = { init() { this.appendDummyInput().appendField(new Blockly.FieldCheckbox('FALSE'), 'C'); } };
    Blockly.Events.disable();
    try {
      const expected: AbsAbiWorkspace = { blocks: { blocks: [{ type: 'abs_full_readback', id: 'b', x: 30.5, y: 70.8,
        deletable: true, movable: true, editable: true, collapsed: false, enabled: false, data: '', extraState: null, fields: { C: 'FALSE' } }] } };
      Blockly.serialization.workspaces.load(expected, ws);
      const actual = Blockly.serialization.workspaces.save(ws) as AbsAbiWorkspace;
      const contracts = captureAbsRuntimeContracts(ws, actual, () => undefined);
      expect(() => assertAbsReadback(expected, actual, contracts)).not.toThrow();
      actual.blocks.blocks[0]['deletable'] = false;
      expect(() => assertAbsReadback(expected, actual, { ...contracts, mode: 'requested' })).toThrow();
    } finally { ws.dispose(); delete Blockly.Blocks['abs_full_readback']; Blockly.Events.enable(); }
  });
});
