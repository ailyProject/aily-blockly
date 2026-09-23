import * as Blockly from 'blockly';
import { BlocklyService } from '../../../editors/blockly-editor/services/blockly.service';
import { BlocklyDeclarativeBlockCatalog } from '../../../editors/blockly-editor/services/blockly-declarative-block-catalog';
import { nativeFieldOrder, orderAbsNativeFields } from './abs-native-field-order';
import { withNativeStateLoading } from '../../../editors/blockly-editor/services/blockly-native-state-loading';
import { absJson } from './abs-json';

describe('declared field order at normal project load', () => {
  let workspace: Blockly.Workspace, catalog: BlocklyDeclarativeBlockCatalog;
  const type = 'field_order_reopen', extension = 'field_order_reopen_extension';
  const state = () => ({ blocks: { blocks: [{ type, id: 'kept-id', fields: { DETAIL: 'kept text', MODE: 'B' }, deletable: false }] } });
  beforeEach(() => {
    workspace = new Blockly.Workspace(); catalog = new BlocklyDeclarativeBlockCatalog();
    Blockly.Extensions.register(extension, function() {
      this.getField('MODE').setValidator(mode => {
        if (this.getInput('detail')) this.removeInput('detail');
        if (mode === 'B') this.appendDummyInput('detail').appendField(new Blockly.FieldTextInput('default'), 'DETAIL');
        return mode;
      });
    });
    const json = { type, message0: '%1', args0: [{ type: 'field_dropdown', name: 'MODE', options: [['A', 'A'], ['B', 'B']] }], extensions: [extension] };
    Blockly.defineBlocksWithJsonArray([json]); catalog.record(json, Blockly.Blocks[type]);
  });
  afterEach(() => { workspace.dispose(); delete Blockly.Blocks[type]; Blockly.Extensions.unregister(extension); });

  it('uses the real ordinary load entry and preserves a later-created field without mutating saved input', () => {
    const input = state(), before = absJson(input);
    BlocklyService.prototype.loadWorkspaceJson.call({ workspace, iconsMap: new Map(), cloneJson: value => structuredClone(value),
      assertWorkspaceEditAvailable() {}, captureDeclarativeBlockDefinitions: () => catalog.capture(Blockly.Blocks),
      scheduleWorkspaceRenderAfterLoad() {},
    } as any, input);
    expect(workspace.getBlockById('kept-id')!.getFieldValue('DETAIL')).toBe('kept text');
    expect(workspace.getBlockById('kept-id')!.isDeletable()).toBeFalse();
    expect(absJson(input)).toBe(before);
  });

  it('retains exact instance order over type fallback and leaves unknown declarations unchanged', () => {
    const input = state();
    orderAbsNativeFields(input, { fields: {}, syntax: { 'kept-id': [{ name: 'DETAIL', kind: 'field' }, { name: 'MODE', kind: 'field' }] } });
    expect(Object.keys(input.blocks.blocks[0].fields)).toEqual(['DETAIL', 'MODE']);
    expect(nativeFieldOrder(workspace.newBlock(type), { types: [], registered: () => false, get: () => undefined, assertCurrent() {} })).toEqual([]);
    expect(Object.keys(input.blocks.blocks[0].fields)).toEqual(['DETAIL', 'MODE']);
  });

  it('checks declaration freshness before clearing a live workspace', () => {
    workspace.newBlock(type, 'original');
    expect(() => BlocklyService.prototype.loadWorkspaceJson.call({ workspace, iconsMap: new Map(), cloneJson: value => structuredClone(value),
      assertWorkspaceEditAvailable() {}, captureDeclarativeBlockDefinitions: () => ({ assertCurrent() { throw Error('stale'); } }),
    } as any, state())).toThrowError('stale');
    expect(workspace.getBlockById('original')).not.toBeNull();
  });

  it('keeps normal empty and ID-less native loading compatible', () => {
    const definitions = catalog.capture(Blockly.Blocks);
    expect(() => withNativeStateLoading(Blockly, workspace, {}, () => Blockly.serialization.workspaces.load({}, workspace))).not.toThrow();
    const input: any = state(); delete input.blocks.blocks[0].id;
    withNativeStateLoading(Blockly, workspace, input, () => Blockly.serialization.workspaces.load(input, workspace), block => nativeFieldOrder(block, definitions));
    expect(workspace.getAllBlocks(false)[0].getFieldValue('DETAIL')).toBe('kept text');
    expect(input.blocks.blocks[0].id).toBeUndefined();
  });

  it('restores captured root order across shared/page ownership without weakening complete readback', () => {
    const shared = { type, id: 'shared-root' }, local = { type, id: 'local-root' };
    const page = { id: 'main', content: { blocks: { blocks: [local] } } };
    const document = { sharedModel: { procedureBlocks: [shared] }, pages: [page] };
    const context: any = { workspace, getActivePage: () => page, getStoredProjectDocument: () => document,
      loadWorkspaceJson: value => Blockly.serialization.workspaces.load(value, workspace),
      selectedBlockSubject: { next() {} }, selectedBlockIdsSubject: { next() {} }, loadLibraryFinishedLoadingSubject: { next() {} },
      requestWorkspaceVisualRefresh: jasmine.createSpy('visualRefresh'),
      closeWorkspaceBlockSearch() {}, restoreWorkspaceViewState() {}, persistActiveWorkspaceToState() {}, mountExternalToolbox() {} };
    const load = (BlocklyService.prototype as any).loadActivePageIntoWorkspace;
    load.call(context, undefined, ['local-root', 'shared-root']);
    expect(workspace.getTopBlocks(false).map(block => block.id)).toEqual(['local-root', 'shared-root']);
    expect(document.sharedModel.procedureBlocks).toEqual([shared]);
    const clear = spyOn(workspace, 'clear').and.callThrough();
    for (const order of [['local-root'], ['local-root', 'local-root'], ['local-root', 'missing']]) {
      expect(() => load.call(context, undefined, order)).toThrowError(/root identities/);
    }
    expect(clear).not.toHaveBeenCalled();
    expect(context.requestWorkspaceVisualRefresh).toHaveBeenCalledTimes(1);
  });
});
