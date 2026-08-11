import * as Blockly from 'blockly/core';

import {
  incrementFieldInputValues,
  isFieldInputIncrementable,
  registerFieldInputIncrementPolicy,
} from './global.js';
import {shouldAutoFocusWorkspace} from './workspace-auto-focus.js';

const VARIABLE_BLOCK = 'test_copy_increment_variable';
const LITERAL_BLOCK = 'test_copy_increment_literal';
const NAMED_DEFINITION_BLOCK = 'test_copy_increment_named_definition';
const NAMED_REFERENCE_BLOCK = 'test_copy_increment_named_reference';

describe('workspace multiselect field_input increment policy', () => {
  let workspace: Blockly.Workspace;

  beforeAll(() => {
    Blockly.defineBlocksWithJsonArray([
      {
        type: VARIABLE_BLOCK,
        message0: 'declare %1 value %2',
        args0: [
          {type: 'field_input', name: 'VAR', text: 'value'},
          {type: 'input_value', name: 'VALUE'},
        ],
        previousStatement: null,
        nextStatement: null,
      },
      {
        type: LITERAL_BLOCK,
        message0: '%1',
        args0: [{type: 'field_input', name: 'TEXT', text: 'literal'}],
        output: 'String',
      },
      {
        type: NAMED_DEFINITION_BLOCK,
        message0: 'define %1',
        args0: [{type: 'field_input', name: 'NAME', text: 'function'}],
        previousStatement: null,
        nextStatement: null,
      },
      {
        type: NAMED_REFERENCE_BLOCK,
        message0: 'call %1',
        args0: [{type: 'field_input', name: 'NAME', text: 'function'}],
        previousStatement: null,
        nextStatement: null,
      },
    ]);
  });

  beforeEach(() => {
    workspace = new Blockly.Workspace();
    registerFieldInputIncrementPolicy(VARIABLE_BLOCK, null);
    registerFieldInputIncrementPolicy(LITERAL_BLOCK, null);
    registerFieldInputIncrementPolicy(NAMED_DEFINITION_BLOCK, ['NAME']);
    registerFieldInputIncrementPolicy(NAMED_REFERENCE_BLOCK, []);
  });

  afterEach(() => {
    workspace.dispose();
  });

  afterAll(() => {
    registerFieldInputIncrementPolicy(VARIABLE_BLOCK, null);
    registerFieldInputIncrementPolicy(LITERAL_BLOCK, null);
    registerFieldInputIncrementPolicy(NAMED_DEFINITION_BLOCK, null);
    registerFieldInputIncrementPolicy(NAMED_REFERENCE_BLOCK, null);
    delete Blockly.Blocks[VARIABLE_BLOCK];
    delete Blockly.Blocks[LITERAL_BLOCK];
    delete Blockly.Blocks[NAMED_DEFINITION_BLOCK];
    delete Blockly.Blocks[NAMED_REFERENCE_BLOCK];
  });

  it('increments legacy variable/object name fields', () => {
    const original = workspace.newBlock(VARIABLE_BLOCK);
    const duplicate = workspace.newBlock(VARIABLE_BLOCK);
    original.setFieldValue('sensor', 'VAR');
    duplicate.setFieldValue('sensor', 'VAR');

    incrementFieldInputValues(duplicate, workspace);

    expect(duplicate.getFieldValue('VAR')).toBe('sensor2');
  });

  it('keeps a copied string literal unchanged inside a variable block', () => {
    const original = workspace.newBlock(VARIABLE_BLOCK);
    const originalLiteral = workspace.newBlock(LITERAL_BLOCK);
    original.setFieldValue('message', 'VAR');
    originalLiteral.setFieldValue('plain text', 'TEXT');
    original.getInput('VALUE')!.connection!.connect(originalLiteral.outputConnection!);

    const duplicate = workspace.newBlock(VARIABLE_BLOCK);
    const duplicateLiteral = workspace.newBlock(LITERAL_BLOCK);
    duplicate.setFieldValue('message', 'VAR');
    duplicateLiteral.setFieldValue('plain text', 'TEXT');
    duplicate.getInput('VALUE')!.connection!.connect(duplicateLiteral.outputConnection!);

    incrementFieldInputValues(duplicate, workspace);

    expect(duplicate.getFieldValue('VAR')).toBe('message2');
    expect(duplicateLiteral.getFieldValue('TEXT')).toBe('plain text');
  });

  it('increments explicitly declared names but not same-named references', () => {
    const originalDefinition = workspace.newBlock(NAMED_DEFINITION_BLOCK);
    const reference = workspace.newBlock(NAMED_REFERENCE_BLOCK);
    const duplicateDefinition = workspace.newBlock(NAMED_DEFINITION_BLOCK);
    const duplicateReference = workspace.newBlock(NAMED_REFERENCE_BLOCK);
    originalDefinition.setFieldValue('render', 'NAME');
    reference.setFieldValue('render', 'NAME');
    duplicateDefinition.setFieldValue('render', 'NAME');
    duplicateReference.setFieldValue('render', 'NAME');

    incrementFieldInputValues(duplicateDefinition, workspace);
    incrementFieldInputValues(duplicateReference, workspace);

    expect(duplicateDefinition.getFieldValue('NAME')).toBe('render2');
    expect(duplicateReference.getFieldValue('NAME')).toBe('render');
  });

  it('does not treat literal field names as declarations', () => {
    for (const fieldName of ['TEXT', 'CHAR', 'CODE', 'URL', 'ADDRESS', 'NUM']) {
      expect(isFieldInputIncrementable('unconfigured_literal', fieldName))
        .withContext(fieldName)
        .toBeFalse();
    }
  });
});

describe('workspace multiselect hover autofocus', () => {
  let workspaceFocusTarget: HTMLDivElement;

  beforeEach(() => {
    workspaceFocusTarget = document.createElement('div');
  });

  it('preserves focus owned by an embedded child app iframe', () => {
    const iframe = document.createElement('iframe');

    expect(shouldAutoFocusWorkspace(undefined, iframe, workspaceFocusTarget))
      .toBeFalse();
  });

  it('preserves the existing host input and textarea behavior', () => {
    const input = document.createElement('input');
    const textarea = document.createElement('textarea');

    expect(shouldAutoFocusWorkspace(undefined, input, workspaceFocusTarget))
      .toBeFalse();
    expect(shouldAutoFocusWorkspace(undefined, textarea, workspaceFocusTarget))
      .toBeFalse();
  });

  it('does not refocus a workspace that already owns focus', () => {
    expect(shouldAutoFocusWorkspace(
      undefined,
      workspaceFocusTarget,
      workspaceFocusTarget,
    )).toBeFalse();
  });

  it('honors an explicitly disabled workspace autofocus option', () => {
    const button = document.createElement('button');

    expect(shouldAutoFocusWorkspace(false, button, workspaceFocusTarget))
      .toBeFalse();
  });

  it('keeps the original autofocus behavior for ordinary elements', () => {
    const button = document.createElement('button');

    expect(shouldAutoFocusWorkspace(undefined, button, workspaceFocusTarget))
      .toBeTrue();
  });
});
