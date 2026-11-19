import * as Blockly from 'blockly';
import { withNativeFragmentRenders } from './blockly-native-render-batch';

describe('native fragment ancestor rendering', () => {
  let host: HTMLDivElement, workspace: Blockly.WorkspaceSvg;
  beforeEach(() => {
    host = document.createElement('div'); document.body.append(host);
    workspace = Blockly.inject(host, { sounds: false });
    Blockly.Blocks['fragment_parent'] = { init() { this.appendValueInput('VALUE'); this.setOutput(true); } };
    Blockly.Blocks['fragment_value'] = { init() {
      this.appendDummyInput().appendField(new Blockly.FieldTextInput('wide value'), 'TEXT'); this.setOutput(true);
    } };
  });
  afterEach(() => {
    workspace.dispose(); host.remove(); delete Blockly.Blocks['fragment_parent']; delete Blockly.Blocks['fragment_value'];
  });

  it('updates an existing ancestor and restores normal rendering after attaching a fragment', () => {
    const parent = workspace.newBlock('fragment_parent'); parent.initSvg(); parent.render();
    const width = parent.width;
    const release = Blockly.renderManagement.beginWorkspaceRenderBatch(workspace);
    try {
      withNativeFragmentRenders(workspace, () => Blockly.serialization.blocks.appendInternal({
        type: 'fragment_value', id: 'value', fields: { TEXT: 'a much wider value than the empty parent' },
      }, workspace, { parentConnection: parent.getInput('VALUE')!.connection! }));
    } finally { release(); }
    const child = workspace.getBlockById('value')!;
    expect(child.getParent()).toBe(parent);
    expect(parent.width).toBeGreaterThan(width);
    expect(child.queueRender).toBe(Blockly.BlockSvg.prototype.queueRender);
    expect(Object.hasOwn(child, 'queueRender')).toBeFalse();
    const expandedWidth = parent.width;
    child.setFieldValue('short', 'TEXT'); Blockly.renderManagement.triggerQueuedRenders(workspace);
    expect(parent.width).toBeLessThan(expandedWidth);
  });

  it('preserves a custom renderer and restores created instances after an exception', () => {
    const custom = jasmine.createSpy('custom').and.resolveTo();
    Blockly.Blocks['fragment_value'].init = function() { this.queueRender = custom; };
    let block: Blockly.BlockSvg;
    expect(() => withNativeFragmentRenders(workspace, () => {
      block = workspace.newBlock('fragment_parent');
      const extension = workspace.newBlock('fragment_value');
      expect(extension.queueRender).toBe(custom);
      throw new Error('native failed');
    })).toThrowError('native failed');
    expect(block!.queueRender).toBe(Blockly.BlockSvg.prototype.queueRender);
    expect(Object.hasOwn(block!, 'queueRender')).toBeFalse();
  });

  it('retains a method installed by a native field callback during loading', () => {
    const custom = jasmine.createSpy('extension render').and.resolveTo();
    const block = withNativeFragmentRenders(workspace, () => {
      const value = workspace.newBlock('fragment_parent');
      value.queueRender = custom;
      return value;
    });
    expect(block.queueRender).toBe(custom);
  });
});
