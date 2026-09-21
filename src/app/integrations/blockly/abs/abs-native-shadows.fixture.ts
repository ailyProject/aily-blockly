/** Native setShadowState constructs and retires these hidden trees itself. */
export const nativeDormantSource = `
  const nativeMakeDefault = Blockly.Blocks.native_default_owner.makeDefault;
  Blockly.Blocks.native_default_owner.makeDefault = function() {
    nativeMakeDefault.call(this);
    this.getInputTargetBlock('VALUE').getInput('CHILD').connection.setShadowState({
      type: 'math_number', fields: { NUM: 11 }
    });
    this.getInput('VALUE').connection.setShadowState({ type: 'native_default_leaf', inputs: {
      CHILD: { shadow: { type: 'math_number', fields: { NUM: 13 } } }
    } });
  };
`;
