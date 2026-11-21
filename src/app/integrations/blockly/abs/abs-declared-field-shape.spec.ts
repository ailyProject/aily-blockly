import { BlocklyDeclarativeBlockCatalog } from '../../../editors/blockly-editor/services/blockly-declarative-block-catalog';
import { describeAbsBlockCapability } from './abs-block-capabilities';

describe('declared ABS configuration advice', () => {
  const definition = () => ({ type: 'delay_range_probe', message0: '%1', args0: [
    { type: 'field_dropdown', name: 'MODE', options: [['Fixed', 'fixed'], ['Range', 'range']] },
  ], extensions: ['unrecognized_native_shape'], ailyFieldShape: [{ field: 'MODE', values: ['range'], args: [
    { type: 'input_value' as const, name: 'START', default: { type: 'math_number', fields: { NUM: 15 } } },
    { type: 'input_value' as const, name: 'END', default: { type: 'math_number', fields: { NUM: 45 } } },
  ] }] });
  function capability(source: Record<string, any>, nativeValidation: boolean) {
    const catalog = new BlocklyDeclarativeBlockCatalog();
    const init = jasmine.createSpy('native init');
    const registered = { init };
    catalog.record(source, registered);
    const snapshot = catalog.capture({ [source['type']]: registered });
    const result = describeAbsBlockCapability(snapshot, source['type'], nativeValidation);
    expect(init).not.toHaveBeenCalled();
    return result;
  }

  it('exposes options and defaults without granting a shape or skipping native validation', () => {
    const source = definition();
    expect(capability(source, true)).toEqual({ type: source.type, level: 'validate', contract: 'native-sync-v1',
      reason: 'candidate-validation-required', declaredFieldShape: source.ailyFieldShape });
    expect(capability(source, false)).toEqual({ type: source.type, level: 'preserve-only', reason: 'no-prepared-shape-contract' });
  });

  it('retains native validation when an older library omits advice or a declaration is invalid', () => {
    const unchanged = { type: 'delay_range_probe', level: 'validate', contract: 'native-sync-v1', reason: 'candidate-validation-required' } as const;
    const { ailyFieldShape: _omitted, ...older } = definition();
    expect(capability(older, true)).toEqual(unchanged);
    const badSelector = definition(); badSelector.ailyFieldShape[0].values = ['unknown'];
    expect(capability(badSelector, true)).toEqual(unchanged);
    const duplicateArgument = definition(); duplicateArgument.ailyFieldShape[0].args[1].name = 'START';
    expect(capability(duplicateArgument, true)).toEqual(unchanged);
    const invalidDefault = definition(); invalidDefault.ailyFieldShape[0].args[0].default.fields.NUM = Infinity;
    expect(capability(invalidDefault, true)).toEqual(unchanged);
  });
});
