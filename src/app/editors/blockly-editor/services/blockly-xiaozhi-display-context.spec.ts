import * as Blockly from 'blockly';
import { BlocklyGeneratorRuntimeService } from './blockly-generator-runtime.service';

describe('published Xiaozhi display generation', () => {
  it('uses current display declarations before events on every pass and forgets disabled or removed declarations', () => {
    const service = new BlocklyGeneratorRuntimeService(), workspace = new Blockly.Workspace();
    service.activate({mode: 'arduino', getWorkspace: () => null});
    // The same realm-global dependency as the published library, with actual
    // Blockly ordering, fields, generator init and native runtime adapters.
    service.loadGenerator('xiaozhi/display/generator.js', `
      var display_type = 'NONE', display_mode = '';
      Blockly.Blocks.esp32ai_init_display = {init() {
        this.appendDummyInput().appendField(new Blockly.FieldDropdown([['SPI', 'ST7789'], ['OLED', 'SSD1306']]), 'DISPLAY_TYPE');
      }};
      Blockly.Blocks.aivox_display_mode = {init() {
        this.appendDummyInput().appendField(new Blockly.FieldDropdown([['WeChat', 'wechat'], ['Normal', 'normal']]), 'display_mode');
      }};
      Blockly.Blocks.runtime_display_event = {init() { this.appendDummyInput(); }};
      Arduino.forBlock.esp32ai_init_display = block => {display_type = block.getFieldValue('DISPLAY_TYPE'); return '';};
      Arduino.forBlock.aivox_display_mode = block => {display_mode = block.getFieldValue('display_mode'); return '';};
      Arduino.forBlock.aivox_lcd_show_status = () => display_type === 'NONE' ? '' : 'show_' + display_type + '_' + display_mode + '();\\n';
      Arduino.forBlock.runtime_display_event = (block, generator) => {
        generator.addFunction('display_event', 'void onDisplay() {\\n' + generator.forBlock.aivox_lcd_show_status(block, generator) + '}');
        return '';
      };
    `);
    try {
      const event = workspace.newBlock('runtime_display_event');
      const display = workspace.newBlock('esp32ai_init_display'); display.moveBy(0, 100);
      const mode = workspace.newBlock('aivox_display_mode'); mode.moveBy(0, 200);
      const generator = service.getActiveGenerator()!;
      const first = generator.workspaceToCode(workspace);
      expect(first).toContain('show_ST7789_wechat();');
      for (let pass = 0; pass < 6; pass++) expect(generator.workspaceToCode(workspace)).toBe(first);
      display.setFieldValue('SSD1306', 'DISPLAY_TYPE'); mode.setFieldValue('normal', 'display_mode');
      expect(generator.workspaceToCode(workspace)).toContain('show_SSD1306_normal();');
      display.setDisabledReason(true, 'test');
      expect(generator.workspaceToCode(workspace)).not.toContain('show_');
      display.setDisabledReason(false, 'test'); mode.dispose();
      expect(generator.workspaceToCode(workspace)).toContain('show_SSD1306_();');
      display.dispose();
      expect(generator.workspaceToCode(workspace)).not.toContain('show_');
      expect(event.isDisposed()).toBeFalse();
    } finally { workspace.dispose(); service.destroy(); }
  });
});
