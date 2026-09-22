import type { NativeReplayStep } from '../../../editors/blockly-editor/services/blockly-native-candidate-protocol';

/** Unknown library: no production block-type/source recognizer covers these names. */
export const modelDefinitions = [
  { type: 'test_object_init', message0: '%1 %2', args0: [
    { type: 'field_input', name: 'NAME', text: 'sensor' },
    { type: 'field_dropdown', name: 'KIND', options: [['Sensor', 'Sensor'], ['Other', 'Other']] },
  ], previousStatement: null, nextStatement: null },
  { type: 'test_object_read', message0: '%1', args0: [
    { type: 'field_variable', name: 'OBJECT', variableTypes: ['Sensor'], defaultType: 'Sensor' },
  ], output: 'Number' },
];
export const modelSource = `
  function registerVariableToBlockly(name, type) {
    const workspace = Blockly.getMainWorkspace();
    if (!workspace.getVariable(name)) workspace.createVariable(name, type);
  }
  Arduino.forBlock.test_object_init = block => {
    registerVariableToBlockly(block.getFieldValue('NAME'), block.getFieldValue('KIND'));
    registerVariableToBlockly(block.getFieldValue('NAME'), block.getFieldValue('KIND'));
    return '';
  };
  Arduino.forBlock.test_object_read = block => [block.getField('OBJECT').getVariable().name + '.read()', 0];
`;
export const modelSteps: NativeReplayStep[] = [
  { kind: 'context', mode: 'arduino' },
  { kind: 'definitions', definitions: modelDefinitions },
  { kind: 'script', source: modelSource, label: 'unrecognized-object-library' },
];
