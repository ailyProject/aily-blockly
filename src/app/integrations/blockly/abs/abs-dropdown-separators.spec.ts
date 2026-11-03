import { compileAbsDeclarativeContract } from './abs-declarative-contracts';
import { resolveAbsFieldValue, readAbsFieldToken } from './abs-field-values';
import { resolveBoardJsonBindings } from '../../../editors/blockly-editor/components/blockly/board-json-bindings';

describe('ABS dropdown display separators', () => {
  const declaration = (options: unknown[]) => ({ type: 'dropdown_fixture', args0: [
    { type: 'field_dropdown', name: 'TYPE', options },
  ] });

  it('accepts the normal library binding result without making separators selectable', () => {
    const bound = resolveBoardJsonBindings(declaration([['int', 'int'], ['---', '---'], ['String', 'String']]), {});
    expect(bound.args0[0].options[1]).toBe('separator');
    const shape = compileAbsDeclarativeContract(bound);
    expect(shape).toBeDefined();
    expect(shape?.fields['TYPE'].options).toEqual([[null, 'int'], [null, 'String']]);
    expect(shape?.defaults['TYPE']).toBe('int');
    if (!shape) return;
    expect(() => resolveAbsFieldValue(readAbsFieldToken('separator'), shape.fields['TYPE'])).toThrow();
    expect(() => resolveAbsFieldValue(readAbsFieldToken('"---"'), shape.fields['TYPE'])).toThrow();
  });

  it('uses the first selectable option after leading display separators', () => {
    const shape = compileAbsDeclarativeContract(declaration(['separator', ['String', 'String'], 'separator']));
    expect(shape?.defaults['TYPE']).toBe('String');
    expect(shape?.fields['TYPE'].options).toEqual([[null, 'String']]);
  });

  for (const options of [[], ['separator'], ['separator', 'unknown'], [['bad', 1], 'separator']]) {
    it(`rejects absent selectable options or malformed options: ${JSON.stringify(options)}`, () => {
      expect(compileAbsDeclarativeContract(declaration(options))).toBeUndefined();
    });
  }
});
