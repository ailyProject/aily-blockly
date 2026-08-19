import * as Blockly from 'blockly';

import {
  changedRuntimeBlockTypes,
  serializeRuntimeBlockMetadata,
} from './blockly-runtime-block-metadata';

describe('Blockly runtime block metadata', () => {
  it('detects block definitions added or replaced by generator.js', () => {
    const unchanged = { init() {} };
    const before = new Map<string, unknown>([
      ['static_block', unchanged],
      ['replaced_block', { init() {} }],
    ]);

    expect(changedRuntimeBlockTypes(before, {
      static_block: unchanged,
      replaced_block: { init() {} },
      dynamic_block: { init() {} },
    })).toEqual(['dynamic_block', 'replaced_block']);
  });

  it('serializes a JS-only function call block into the stable AI metadata contract', () => {
    const workspace = new Blockly.Workspace();
    Blockly.Blocks['runtime_function_call_test'] = {
      init() {
        this.appendDummyInput()
          .appendField('call')
          .appendField(new Blockly.FieldVariable(null, null, ['FUNC'], 'FUNC'), 'FUNC_NAME');
        this.setPreviousStatement(true);
        this.setNextStatement(true);
        (this as any).saveExtraState = () => ({ extraCount: 0 });
      },
    };

    try {
      const block = workspace.newBlock('runtime_function_call_test');
      const metadata = serializeRuntimeBlockMetadata(
        'runtime_function_call_test',
        '@aily-project/lib-core-functions',
        block,
      );

      expect(metadata.fieldNames).toEqual(['FUNC_NAME']);
      expect(metadata.fieldTypes).toEqual({ FUNC_NAME: 'field_variable' });
      expect(metadata.argsOrder).toEqual([{ name: 'FUNC_NAME', kind: 'field' }]);
      expect(metadata.hasPrevious).toBeTrue();
      expect(metadata.hasNext).toBeTrue();
      expect(metadata.mutator).toBe('runtime_dynamic');
    } finally {
      workspace.dispose();
      delete Blockly.Blocks['runtime_function_call_test'];
    }
  });
});
