import type { NativeReplayStep } from '../../../editors/blockly-editor/services/blockly-native-candidate-protocol';

/** Unknown synchronous implementation, not a production adapter/template. */
export const nativeDefaultSource = `
  Blockly.Blocks.native_default_leaf = { init() {
    this.appendValueInput('CHILD').setCheck('Number'); this.setOutput(true, 'Number');
  } };
  Blockly.Blocks.native_default_owner = {
    init() {
      this.appendDummyInput().appendField(new Blockly.FieldDropdown([['A', 'A'], ['B', 'B']], mode => {
        if (mode === 'B' && this.getInput('VALUE')) this.makeDefault();
        return mode;
      }), 'MODE');
      this.appendValueInput('VALUE').setCheck('Number');
      this.makeDefault();
    },
    makeDefault() {
      const connection = this.getInput('VALUE').connection;
      const old = connection.targetBlock(); if (old) old.dispose(false);
      const leaf = this.workspace.newBlock('native_default_leaf');
      const number = this.workspace.newBlock('math_number'); number.setFieldValue(5, 'NUM');
      if (this.workspace.rendered) { leaf.initSvg(); number.initSvg(); leaf.render(); number.render(); }
      leaf.getInput('CHILD').connection.connect(number.outputConnection);
      connection.connect(leaf.outputConnection);
    },
    loadExtraState(state) { this.modeState = state; this.makeDefault(); },
    saveExtraState() { return this.modeState ?? null; },
  };
  Arduino.forBlock.native_default_owner = block => Arduino.valueToCode(block, 'VALUE', 0) + ';\\n';
  Arduino.forBlock.native_default_leaf = block => [Arduino.valueToCode(block, 'CHILD', 0), 0];
  Arduino.forBlock.math_number = block => [String(block.getFieldValue('NUM')), 0];
`;

export const nativeDefaultSteps: NativeReplayStep[] = [
  { kind: 'context', mode: 'arduino' },
  { kind: 'definitions', definitions: [{ type: 'math_number', message0: '%1', args0: [
    { type: 'field_number', name: 'NUM', value: 0 },
  ], output: 'Number' }] },
  { kind: 'script', label: 'unrecognized-default-children', source: nativeDefaultSource },
];
