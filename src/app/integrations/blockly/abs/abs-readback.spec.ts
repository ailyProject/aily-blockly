import * as Blockly from 'blockly';
import { assertAbsReadback } from './abs-readback';
import { AbsAbiWorkspace } from './abs-state';
import { captureAbsRuntimeContracts } from './abs-runtime-contracts';

describe('ABS complete readback and explicit defaults', () => {
  const graph = (): AbsAbiWorkspace => ({ blocks: { languageVersion: 0, blocks: [{ type: 'root', id: 'r', x: 30, y: 40,
    deletable: false, data: 'opaque', icons: { comment: { text: 'comment' } }, inputs: {
      INPUT: { block: { type: 'child', id: 'c', fields: { TEXT: 'same' } }, shadow: { type: 'child', id: 's', fields: { TEXT: 'shadow' } } },
    }, next: { block: { type: 'tail', id: 't' } } }] }, customSerializer: { data: [1, false] } });
  const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
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
