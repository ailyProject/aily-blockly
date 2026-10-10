import * as Blockly from 'blockly';
import 'blockly/blocks';
import { loadBlocklyWorkspace } from './blockly-performance';

describe('batched Blockly text measurement', () => {
  let host: HTMLDivElement;
  let workspace: Blockly.WorkspaceSvg;
  beforeEach(() => {
    Blockly.Events.disable();
    host = document.createElement('div');
    host.style.cssText = 'width:800px;height:600px';
    document.body.appendChild(host);
  });
  afterEach(() => {
    workspace?.dispose(); host.remove(); Blockly.Events.enable();
  });

  for (const rtl of [false, true]) it(`retains native field and block geometry, variables and state (RTL=${rtl})`, () => {
    workspace = Blockly.inject(host, {renderer: 'thrasos', rtl, sounds: false});
    const state = {variables: [{name: '温度', id: 'temperature'}], blocks: {languageVersion: 0, blocks: [
      {type: 'math_arithmetic', id: 'dropdown', fields: {OP: 'MULTIPLY'}},
      {type: 'variables_get', id: 'variable', fields: {VAR: {id: 'temperature'}}},
      {type: 'math_number', id: 'number', fields: {NUM: -1234.56}},
      ...Array.from({length: 1000}, (_, index) => ({type: 'text', id: `label-${index}`, fields: {TEXT: `文本 ${index} Ω`}})),
    ]}};
    const geometry = () => workspace.getAllBlocks(false).map(block => ({
      id: block.id, width: block.width, height: block.height,
      fields: block.inputList.flatMap(input => input.fieldRow.map(field => ({
        value: field.getValue(), width: field.getSize().width, height: field.getSize().height,
        text: field.getSvgRoot()?.textContent,
      }))),
    })).sort((a, b) => a.id.localeCompare(b.id));
    Blockly.utils.dom.startTextWidthCache();
    try {Blockly.serialization.workspaces.load(state, workspace); Blockly.renderManagement.triggerQueuedRenders(workspace);}
    finally {Blockly.utils.dom.stopTextWidthCache();}
    const expectedGeometry = geometry();
    const expectedState = Blockly.serialization.workspaces.save(workspace);
    loadBlocklyWorkspace(workspace, state);
    expect(geometry()).toEqual(expectedGeometry);
    expect(Blockly.serialization.workspaces.save(workspace)).toEqual(expectedState);
  });

  it('restores the block serializer after a failed load and allows the next load', () => {
    workspace = Blockly.inject(host, {sounds: false});
    const serializer = Blockly.registry.getObject<Blockly.serialization.blocks.BlockSerializer>(Blockly.registry.Type.SERIALIZER, 'blocks')!;
    const descriptor = Object.getOwnPropertyDescriptor(serializer, 'load');
    const original = serializer.load;
    const recordUndo = Blockly.Events.getRecordUndo();
    const group = Blockly.Events.getGroup();
    expect(() => loadBlocklyWorkspace(workspace, {blocks: {blocks: [{type: 'missing_perf_block_type'}]}})).toThrow();
    expect(serializer.load).toBe(original);
    expect(Object.getOwnPropertyDescriptor(serializer, 'load')).toEqual(descriptor);
    expect(Blockly.Events.getRecordUndo()).toBe(recordUndo);
    expect(Blockly.Events.getGroup()).toBe(group);
    loadBlocklyWorkspace(workspace, {blocks: {blocks: [{type: 'text', id: 'recovered'}]}});
    expect(workspace.getBlockById('recovered')).not.toBeNull();
  });

  it('retains a registered custom block serializer', () => {
    workspace = Blockly.inject(host, {sounds: false});
    const serializer = Blockly.registry.getObject<Blockly.serialization.blocks.BlockSerializer>(Blockly.registry.Type.SERIALIZER, 'blocks')!;
    const original = serializer.load;
    const custom = jasmine.createSpy('custom serializer').and.callFake((state, target) => original.call(serializer, state, target));
    serializer.load = custom;
    try {
      loadBlocklyWorkspace(workspace, {blocks: {blocks: [{type: 'text', id: 'custom'}]}});
      expect(custom).toHaveBeenCalledTimes(1);
      expect(serializer.load).toBe(custom);
    } finally {delete (serializer as Partial<Blockly.serialization.blocks.BlockSerializer>).load;}
  });
});
