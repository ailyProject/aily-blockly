// Executed by the production generator iframe, not by the test's main realm.
Blockly.Blocks.realm_state_fixture = {
  init() {
    this.appendDummyInput().appendField('realm state').appendField(new Blockly.FieldDropdown([['First', 'A']]), 'PICK');
    this.setPreviousStatement(true);
    this.setNextStatement(true);
    this.setColour(160);
    this.fixtureState = { version: 1, params: [{ name: 'value', type: 'int', values: [0, 7, null] }], dictionary: { note: '界😀' } };
    this.workspace.addChangeListener(event => {
      if (event.type === Blockly.Events.FINISHED_LOADING) {
        const field = this.getField('PICK');
        if (!field) return; // An earlier native instance may already be disposed.
        const previous = field.getValue();
        field.setOptions([['First', 'A'], ['Second', 'B']]);
        if (field.getOptions(false).some(option => option[1] === previous)) field.setValue(previous);
      }
    });
  },
  saveExtraState() {
    const state = this.fixtureState;
    return { version: state.version, params: state.params.map(param => ({ name: param.name, type: param.type, values: [...param.values] })),
      dictionary: { ...state.dictionary } };
  },
  loadExtraState(value) { this.fixtureState = value; }
};
Arduino.forBlock['realm_state_fixture'] = function() { return '// preserved realm state fixture\n'; };
Arduino.forBlock['realm_fixture_marker'] = function() { return ''; };
