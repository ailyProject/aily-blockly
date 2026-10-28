import * as Blockly from 'blockly';
import {BlocklyGeneratorRuntimeService} from '../src/app/editors/blockly-editor/services/blockly-generator-runtime.service';
import '../src/app/editors/blockly-editor/utils/blockly-legacy-library-compat';
import {BlockSearcher} from '../src/app/editors/blockly-editor/components/blockly/plugins/toolbox-search/src/block_searcher';
import {ToolboxSearchCategory} from '../src/app/editors/blockly-editor/components/blockly/plugins/toolbox-search/src/toolbox_search';
import {incrementFieldInputValues} from '../src/app/editors/blockly-editor/components/blockly/plugins/workspace-multiselect/global';

describe('Declaration copy and toolbox search', () => {
  it('keeps pasted declarations unique while preserving literal text and existing names', () => {
    const workspace = new Blockly.Workspace();
    Blockly.Blocks['copy_declaration_probe'] = {init() {
      this.appendDummyInput().appendField(new Blockly.FieldTextInput('item'), 'VAR')
        .appendField(new Blockly.FieldTextInput('item'), 'TEXT');
      this.setPreviousStatement(true); this.setNextStatement(true);
    }};
    try {
      const make = (name: string) => {
        const block = workspace.newBlock('copy_declaration_probe'); block.setFieldValue(name, 'VAR'); return block;
      };
      const originals = [make('item'), make('item2'), make('item9')];
      const copies = [make('item'), make('item2'), make('item9'), make('unique')];
      copies.slice(1).forEach((block, index) => copies[index].nextConnection!.connect(block.previousConnection!));
      incrementFieldInputValues(copies[0], workspace);
      expect(copies.map(block => block.getFieldValue('VAR'))).toEqual(['item3', 'item4', 'item10', 'unique']);
      expect(originals.map(block => block.getFieldValue('VAR'))).toEqual(['item', 'item2', 'item9']);
      expect(copies.map(block => block.getFieldValue('TEXT'))).toEqual(['item', 'item', 'item', 'item']);
      const next = make('item'); incrementFieldInputValues(next, workspace);
      expect(next.getFieldValue('VAR')).toBe('item5');
    } finally { workspace.dispose(); delete Blockly.Blocks['copy_declaration_probe']; }
  });

  it('undoes declaration deletion and library variable cleanup together', async () => {
    const host = document.createElement('div'); document.body.append(host);
    const workspace = Blockly.inject(host, {sounds: false});
    const runtime = new BlocklyGeneratorRuntimeService();
    runtime.activate({mode: 'arduino', getWorkspace: () => workspace});
    runtime.loadGenerator('cleanup-probe/generator.js', `
      Blockly.Blocks.cleanup_probe = {init() { this.appendDummyInput().appendField('declaration'); }};
      Blockly.getMainWorkspace().addChangeListener(event => {
        if (event.type === Blockly.Events.BLOCK_DELETE) Blockly.getMainWorkspace().deleteVariableById('cleanup-variable');
      });
    `);
    const settle = () => new Promise(resolve => setTimeout(resolve, 30));
    try {
      workspace.getVariableMap().createVariable('probe', '', 'cleanup-variable');
      const block = workspace.newBlock('cleanup_probe'); block.initSvg(); block.render();
      const id = block.id; await settle(); workspace.clearUndo();
      Blockly.Events.setGroup(true);
      block.dispose(false);
      Blockly.Events.setGroup(false);
      await settle();
      expect(workspace.getVariableMap().getVariableById('cleanup-variable')).toBeNull();
      workspace.undo(false); await settle();
      expect(workspace.getBlockById(id)).not.toBeNull();
      expect(workspace.getVariableMap().getVariableById('cleanup-variable')).not.toBeNull();
      workspace.undo(true); await settle();
      expect(workspace.getBlockById(id)).toBeNull();
      expect(workspace.getVariableMap().getVariableById('cleanup-variable')).toBeNull();
    } finally { workspace.dispose(); runtime.destroy(); host.remove(); }
  });

  it('indexes preview text without activating live declaration initialization', () => {
    let liveInitializations = 0;
    Blockly.Blocks['search_preview_probe'] = {init() {
      this.appendDummyInput().appendField('Searchable probe');
      if (!this.isInFlyout) liveInitializations++;
    }};
    try {
      const search = new BlockSearcher(); search.indexBlocks(['search_preview_probe']);
      expect(search.blockTypesMatching('Searchable')).toContain('search_preview_probe');
      expect(liveInitializations).toBe(0);
    } finally { delete Blockly.Blocks['search_preview_probe']; }
  });

  it('leaves search indexing lazy across toolbox refreshes and searches the updated definition', () => {
    let initializations = 0;
    Blockly.Blocks['search_lazy_probe'] = {init() { initializations++; this.appendDummyInput().appendField('Searchable probe'); }};
    const host = document.createElement('div'); host.style.cssText = 'width:800px;height:600px'; document.body.append(host);
    const toolbox: Blockly.utils.toolbox.ToolboxInfo = {kind: 'categoryToolbox', contents: [
      {kind: ToolboxSearchCategory.SEARCH_CATEGORY_KIND, name: 'Search'},
      {kind: 'category', name: 'Probes', contents: [{kind: 'block', type: 'search_lazy_probe'}]},
    ]};
    const workspace = Blockly.inject(host, {toolbox, sounds: false});
    try {
      for (let i = 0; i < 5; i++) workspace.updateToolbox(toolbox);
      expect(initializations).toBe(0);
      const category = workspace.getToolbox()!.getToolboxItems()[0] as any;
      category.searchField.value = 'Searchable'; category.matchBlocks();
      expect(category.getContents()).toContain(jasmine.objectContaining({type: 'search_lazy_probe'}));
      expect(initializations).toBeGreaterThan(0);
      const afterSearch = initializations;
      category.searchField.value = 'probe'; category.matchBlocks();
      expect(initializations).toBe(afterSearch);
    } finally { workspace.dispose(); host.remove(); delete Blockly.Blocks['search_lazy_probe']; }
  });
});
