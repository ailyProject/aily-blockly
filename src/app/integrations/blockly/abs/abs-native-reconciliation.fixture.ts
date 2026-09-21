import type { NativeReplayStep } from '../../../editors/blockly-editor/services/blockly-native-candidate-protocol';

/** Deliberately unknown extension. No production source/shape recognizer knows this fixture. */
export const nativeReconciliationDefinition = { type: 'native_commit_shape', message0: '%1 %2', args0: [
  { type: 'field_dropdown', name: 'MODE', options: [['A', 'A'], ['B', 'B']] },
  { type: 'input_value', name: 'VALUE', check: 'Number' },
], extensions: ['native_commit_extension'], previousStatement: null, nextStatement: null };

export const nativeReconciliationScript = `
  Blockly.Blocks.abs_sync_root = { init() {
    this.appendDummyInput().appendField(new Blockly.FieldTextInput(''), 'TEXT');
    this.appendValueInput('VALUE').setCheck('Number');
  } };
  Blockly.Extensions.register('native_commit_extension', function() {
    const update = mode => {
      if (this.getInput('DETAIL')) this.removeInput('DETAIL');
      if (mode === 'B') this.appendDummyInput('DETAIL').appendField(new Blockly.FieldTextInput('default'), 'DETAIL');
      return mode;
    };
    this.getField('MODE').setValidator(update);
    // ID-dependent defaults must use final map identity, never the scratch offset ID.
    this.data = 'native:' + this.id;
  });
  Arduino.forBlock.abs_sync_root = block => Arduino.valueToCode(block, 'VALUE', 0) + ';\\n';
  Arduino.forBlock.native_commit_shape = block => Arduino.valueToCode(block, 'VALUE', 0) + ';\\n';
  Arduino.forBlock.math_number = block => [String(block.getFieldValue('NUM')), 0];
`;

export const nativeReconciliationSteps: NativeReplayStep[] = [
  { kind: 'context', mode: 'arduino' },
  { kind: 'script', label: 'unknown-native-commit', source: nativeReconciliationScript },
  { kind: 'definitions', definitions: [nativeReconciliationDefinition, {
    type: 'math_number', message0: '%1', args0: [{ type: 'field_number', name: 'NUM', value: 0 }], output: 'Number',
  }] },
];
