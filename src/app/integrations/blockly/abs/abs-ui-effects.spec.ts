import * as Blockly from 'blockly';
import { provesBlocklyUiOnly } from '../../../editors/blockly-editor/services/blockly-ui-effect-proof';
import { captureBlocklyUiExtensionContracts } from '../../../editors/blockly-editor/services/blockly-ui-extension-contracts';
import { BlocklyDeclarativeBlockCatalog } from '../../../editors/blockly-editor/services/blockly-declarative-block-catalog';
import { describeAbsBlockCapability } from './abs-block-capabilities';

describe('declaration UI effect proof', () => {
  const tooltip = function(this: any) {
    const block = this;
    this.setTooltip(function() {
      const op = block.getFieldValue('MODE');
      const messages = window['libraryMessages']?.tooltips;
      if (messages && messages[op]) return messages[op];
      return 'fallback';
    });
  };
  it('recognizes readonly tooltips without executing the registration or callback', () => {
    const probe = spyOn(Blockly.Workspace.prototype, 'newBlock').and.callThrough();
    expect(provesBlocklyUiOnly(tooltip)).toBeTrue();
    expect(provesBlocklyUiOnly(function(this: any) { this.setTooltip(() => this.getFieldValue('OTHER')); })).toBeTrue();
    expect(probe).not.toHaveBeenCalled();
  });
  it('rejects writes, arbitrary helper calls, model creation and alias shadowing', () => {
    for (const fn of [
      function(this: any) { this.appendValueInput('NEW'); },
      function(this: any) { setTimeout(() => this.workspace.newBlock('text')); },
      function(this: any) { this.setTooltip(() => this.workspace.createVariable('x')); },
      function(this: any) { this.setTooltip(() => { this.state = 1; return ''; }); },
      function(this: any) { const block = this; this.setTooltip(() => { const block = window['other']; return block.getFieldValue('X'); }); },
      function(this: any) { this.setTooltip(() => window['helper']()); },
      function(this: any) { this.setTooltip(() => this.getFieldValue('X')); this.setOnChange(() => {}); },
      new Function('return () => this.setTooltip(() => "lexical receiver")')(),
    ]) expect(provesBlocklyUiOnly(fn)).toBeFalse();
  });
  it('classifies the shared visibility effect with literal substitutions, but rejects additional effects', () => {
    const visibility = function(this: any) {
      let renderScheduled = false;
      const getLoopInput = () => {
        return this.inputList.find(input => input.fieldRow && input.fieldRow.some(field => field.name === 'OTHER_INPUT'));
      };
      const scheduleRender = () => {
        if (!this.rendered || renderScheduled) { return; }
        renderScheduled = true;
        Promise.resolve().then(() => {
          renderScheduled = false;
          const rootBlock = typeof this.getRootBlock === 'function' ? this.getRootBlock() : this;
          if (rootBlock && rootBlock.rendered) { rootBlock.render(); }
          else if (this.rendered) { this.render(); }
        });
      };
      const updatePlaybackMode = modeValue => {
        const loopInput = getLoopInput();
        if (loopInput) { loopInput.setVisible(modeValue === 'OTHER_MODE'); }
        scheduleRender();
      };
      this.getField('MODE').setValidator(option => { updatePlaybackMode(option); return option; });
      updatePlaybackMode(this.getFieldValue('MODE'));
    };
    expect(provesBlocklyUiOnly(visibility)).toBeTrue();
    // Test-only source mutation verifies the complete callback, not a suggestive substring.
    const changed = new Function('return (' + visibility.toString().replace('return option;', 'this.appendValueInput("X"); return option;') + ')')();
    expect(provesBlocklyUiOnly(changed)).toBeFalse();
  });
  it('uses any extension name and invalidates evidence if its registration changes', () => {
    const name = 'abs_unrelated_display_extension', type = 'abs_unrelated_display_block';
    const registry = (Blockly.Extensions as any).TEST_ONLY.allExtensions;
    Blockly.Extensions.register(name, tooltip);
    try {
      const json = { type, message0: '%1', args0: [{ type: 'field_input', name: 'TEXT', text: '' }], extensions: [name], output: null };
      Blockly.defineBlocksWithJsonArray([json]);
      const catalog = new BlocklyDeclarativeBlockCatalog(); catalog.record(json, Blockly.Blocks[type]);
      expect(describeAbsBlockCapability(catalog.capture(Blockly.Blocks), type)).toEqual(jasmine.objectContaining({ level: 'create' }));
      const proof = captureBlocklyUiExtensionContracts(); expect(proof.supports(name)).toBeTrue();
      registry[name] = function(this: any) { this.appendValueInput('UNVERIFIED'); };
      expect(() => proof.assertCurrent()).toThrow();
      expect(captureBlocklyUiExtensionContracts().supports(name)).toBeFalse();
    } finally { Blockly.Extensions.unregister(name); delete Blockly.Blocks[type]; }
  });
});
