import * as Blockly from 'blockly';
import { installBlocklyVariableComparator } from '../../../editors/blockly-editor/utils/blockly-variable-order';
import { evaluateNativeCandidate } from '../../../editors/blockly-editor/services/blockly-native-candidate';

describe('shared native variable ordering', () => {
  const names = ['Z', 'a', 'A', 'ä', 'a\u0308', 'é', 'e', '变量2', '变量10', '变量', 'i', 'İ', 'ı', 'Σ', 'σ', 'ς', '01', '2', '10', '😀', '_', ''];
  const originalOrder = (left: string, right: string) => left.localeCompare(right, undefined, { sensitivity: 'base' });

  it('preserves the bundled comparator for Unicode, case/accent ties and non-numeric ordering', () => {
    installBlocklyVariableComparator();
    const workspace = new Blockly.Workspace();
    try {
      const models = names.map(name => new Blockly.VariableModel(workspace, name, ''));
      for (const left of models) for (const right of models) {
        expect(Math.sign(Blockly.Variables.compareByName(left, right)))
          .withContext(`${left.getName()}/${right.getName()}`).toBe(Math.sign(originalOrder(left.getName(), right.getName())));
      }
      expect([...models].sort(Blockly.Variables.compareByName).map(model => model.getName()))
        .toEqual([...names].sort(originalOrder));
    } finally { workspace.dispose(); }
  });

  it('reads current model names instead of caching a previously sorted variable table', () => {
    installBlocklyVariableComparator();
    const workspace = new Blockly.Workspace();
    try {
      const left = workspace.getVariableMap().createVariable('a', '', 'left'), right = workspace.getVariableMap().createVariable('z', '', 'right');
      expect(Blockly.Variables.compareByName(left, right)).toBeLessThan(0);
      workspace.getVariableMap().renameVariable(left, 'zz');
      expect(Blockly.Variables.compareByName(left, right)).toBeGreaterThan(0);
      Blockly.Variables.deleteVariable(workspace, right);
      workspace.getVariableMap().createVariable('0', '', 'new');
      expect(workspace.getVariableMap().getAllVariables().sort(Blockly.Variables.compareByName).map(model => model.getId())).toEqual(['new', 'left']);
    } finally { workspace.dispose(); }
  });

  it('is idempotent and does not overwrite a later library comparator', () => {
    installBlocklyVariableComparator();
    const compare = Blockly.Variables.compareByName;
    installBlocklyVariableComparator();
    expect(Blockly.Variables.compareByName).toBe(compare);
    const libraryCompare = spyOn(Blockly.Variables, 'compareByName').and.returnValue(0);
    installBlocklyVariableComparator();
    expect(Blockly.Variables.compareByName).toBe(libraryCompare);
  });

  for (const run of [1, 2]) it(`installs before dropdown loading in fresh candidate ${run}, without per-comparison locale setup`, async () => {
    const variableNames = ['Z', 'alpha', 'éclair', '变量2', '变量10'];
    const variables = variableNames.map((name, index) => ({ id: `var-${index}`, name, type: '' }));
    const result = await evaluateNativeCandidate({ variables,
      blocks: [{ id: 'probe', type: 'abs_sort_probe', fields: [{ name: 'VAR', value: { id: 'var-0' } }] }],
      steps: [{ kind: 'script', label: 'variable-order-probe', source: `
        // Assert the actual hot path, not the helper's source or timing on this machine.
        const compare = String.prototype.localeCompare;
        const expected = ${JSON.stringify(variableNames)}.sort((a, b) => compare.call(a, b, undefined, { sensitivity: 'base' }));
        String.prototype.localeCompare = function(other, locales, options) {
          if (options?.sensitivity === 'base') throw Error('repeated variable locale setup');
          return compare.call(this, other, locales, options);
        };
        Blockly.Blocks.abs_sort_probe = { init() {
          const field = new Blockly.FieldVariable('Z');
          this.appendDummyInput().appendField(field, 'VAR');
          field.setValue('var-0');
          for (let i = 0; i < 3; i++) {
            const names = field.getOptions(false).filter(option => this.workspace.getVariableById(option[1])).map(option => option[0]);
            if (JSON.stringify(names) !== JSON.stringify(expected)) throw Error('changed variable dropdown order');
          }
        } };
      ` }],
    }, { assertCurrent() {} });
    expect(result.state['variables']).toEqual(variables.map(({ id, name }) => ({ id, name })));
    expect(result.state['blocks'].blocks[0].fields.VAR).toEqual({ id: 'var-0' });
    expect(document.querySelectorAll('[data-blockly-native-candidate]').length).toBe(0);
  });
});
