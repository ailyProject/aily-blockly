import * as Blockly from 'blockly';
import { prepareBlockCopyIdentities, registerProjectBlockPaster } from '../../../editors/blockly-editor/services/blockly-copy-identities';
import { collectProjectBlockLocations } from '@domain/project/project-data/public-api';

describe('project clipboard identity boundary', () => {
  const state = () => ({ type: 'copy_identity_owner', id: 'parent', inputs: { VALUE: {
    block: { type: 'copy_identity_number', id: 'actual', fields: { NUM: 42 } },
    shadow: { type: 'copy_identity_number', id: 'fallback', fields: { NUM: 1500 } },
  } } });
  const ids = (value: unknown) => collectProjectBlockLocations(value).map(entry => entry.state['id'] as string);
  let count: number;
  const generate = () => `copy-${++count}`;
  beforeEach(() => { count = 0; });
  it('clones and reserves hidden IDs as well as actual instances', () => {
    const source = state(), before = JSON.stringify(source);
    const result = prepareBlockCopyIdentities(source, new Set(ids(source)), generate);
    expect(ids(result)).toEqual(['copy-1', 'copy-2', 'copy-3']);
    expect(JSON.stringify(source)).toBe(before);
    expect(result.inputs.VALUE.shadow.fields.NUM).toBe(1500);
  });
  it('keeps cut identities when they no longer exist in the target project', () => {
    expect(prepareBlockCopyIdentities(state(), new Set(), generate)).toEqual(state());
    expect(count).toBe(0);
  });
  it('reserves inactive-page identities and avoids future source IDs during allocation', () => {
    const source = state(); source.inputs.VALUE.shadow.id = 'copy-1';
    const result = prepareBlockCopyIdentities(source, new Set(['parent', 'copy-1']), generate);
    expect(result.id).toBe('copy-2'); expect(result.inputs.VALUE.shadow.id).toBe('copy-3');
    expect(result.inputs.VALUE.block.id).toBe('actual');
  });
  it('rejects unknown internal references rather than silently breaking them', () => {
    expect(() => prepareBlockCopyIdentities({ ...state(), extraState: { target: 'parent' } }, new Set(['parent']), generate))
      .toThrowError(/Cannot safely rename/);
    expect(count).toBe(0);
  });
  it('does not rename a variable model or its dropdown reference', () => {
    const source = { ...state(), fields: { VAR: { id: 'fallback', name: 'x', type: '' } } };
    const result = prepareBlockCopyIdentities(source, new Set(ids(source)), generate, ['fallback']);
    expect(result.fields).toEqual(source.fields); expect(result.inputs.VALUE.shadow.id).not.toBe('fallback');
  });
  for (const codec of ['raw-binary-v1', 'u8g2-xbm-frames-v1', 'tft-rgb565-be-frames-v1']) {
    it(`keeps Project Data ${codec} media shared while renewing block identities`, () => {
      const source = { ...state(), fields: { MEDIA: { ref: { $ailyData: { schemaVersion: 1, id: `sha256:${'a'.repeat(64)}`,
        codec, logicalType: 'binary', storage: 'raw-v1', rawLength: 8, storedLength: 8 } } } } };
      const result = prepareBlockCopyIdentities(source, new Set(ids(source)), generate);
      expect(result.fields).toEqual(source.fields); expect(result.id).not.toBe(source.id);
    });
  }

  describe('real SVG clipboard and native shadow lifecycle', () => {
    let element: HTMLDivElement, workspace: Blockly.WorkspaceSvg, release: () => void;
    let previousUndo: boolean, previousGroup: string;
    const serialized = () => Blockly.serialization.workspaces.save(workspace);
    // Native Blockly dispatches change events on animation-frame + timeout,
    // not the next timeout alone. Observe that boundary before undo assertions.
    const flushEvents = () => new Promise<void>(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
    beforeEach(() => {
      previousUndo = Blockly.Events.getRecordUndo(); previousGroup = Blockly.Events.getGroup();
      Blockly.Events.setRecordUndo(true); Blockly.Events.setGroup(false);
      Blockly.defineBlocksWithJsonArray([
        { type: 'copy_identity_number', message0: '%1', args0: [{ type: 'field_number', name: 'NUM', value: 0 }], output: null },
        { type: 'copy_identity_owner', message0: 'value %1', args0: [{ type: 'input_value', name: 'VALUE' }], previousStatement: null, nextStatement: null },
      ]);
      element = document.createElement('div'); element.style.cssText = 'width:600px;height:400px'; document.body.appendChild(element);
      workspace = Blockly.inject(element, { toolbox: undefined });
      release = registerProjectBlockPaster(workspace, serialized);
      Blockly.serialization.blocks.append(state(), workspace);
    });
    afterEach(() => {
      release(); workspace.dispose(); element.remove(); delete Blockly.Blocks['copy_identity_number']; delete Blockly.Blocks['copy_identity_owner'];
      Blockly.Events.setRecordUndo(previousUndo); Blockly.Events.setGroup(previousGroup);
    });
    it('uses the same paste boundary for repeated copies and keeps default ownership on unplug', () => {
      const original = workspace.getBlockById('parent')!;
      const copy = original.toCopyData()!;
      const before = JSON.stringify(copy);
      const pasted = [1, 2].map(() => Blockly.clipboard.paste(copy, workspace) as Blockly.BlockSvg);
      const all = ids(serialized()); expect(new Set(all).size).toBe(all.length);
      expect(JSON.stringify(copy)).toBe(before);
      const owners = [original, ...pasted];
      const fallbacks = owners.map(block => block.getInput('VALUE')!.connection!.getShadowState()!.id);
      expect(new Set(fallbacks).size).toBe(3);
      for (const [index, block] of owners.entries()) {
        block.getInputTargetBlock('VALUE')!.outputConnection!.disconnect();
        const fallback = block.getInputTargetBlock('VALUE')!;
        expect(fallback.id).toBe(fallbacks[index]!); expect(fallback.isShadow()).toBeTrue();
        expect(fallback.getFieldValue('NUM')).toBe(1500);
      }
    });
    it('preserves IDs through native undo/redo and cut/paste', async () => {
      await flushEvents(); workspace.clearUndo();
      const original = workspace.getBlockById('parent')!;
      Blockly.Events.setGroup(true);
      const pasted = Blockly.clipboard.paste(original.toCopyData()!, workspace) as Blockly.BlockSvg;
      const pastedState = Blockly.serialization.blocks.save(pasted)!;
      Blockly.Events.setGroup(false);
      await flushEvents();
      expect(workspace.getUndoStack().some(event => event.type === Blockly.Events.BLOCK_CREATE
        && (event as Blockly.Events.BlockCreate).blockId === pasted.id))
        .withContext(`Native paste must record creation before undo: ${JSON.stringify(workspace.getUndoStack().map(event => event.toJson()))}`).toBeTrue();
      workspace.undo(false); expect(workspace.getBlockById(pasted.id)).toBeNull();
      workspace.undo(true);
      expect(Blockly.serialization.blocks.save(workspace.getBlockById(pastedState.id!)!)!).toEqual(pastedState);
      const cutData = original.toCopyData()!; original.dispose(false);
      const moved = Blockly.clipboard.paste(cutData, workspace) as Blockly.BlockSvg;
      expect(moved.id).toBe('parent');
      expect(moved.getInput('VALUE')!.connection!.getShadowState()!.id).toBe('fallback');
    });
  });
});
