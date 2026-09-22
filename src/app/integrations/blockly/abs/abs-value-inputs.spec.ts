import { compileAbsDeclarativeContract } from './abs-declarative-contracts';
import { resolveAbsFieldValue } from './abs-field-values';
import { parseAbsSyntax } from './abs-syntax';

describe('definition-bound historical value shorthands', () => {
  const shapes = new Map([
    { type: 'sink', args0: [{ type: 'field_number', name: 'COUNT' }, { type: 'input_value', name: 'VALUE' }] },
    { type: 'math_number', args0: [{ type: 'field_number', name: 'NUM' }], output: 'Number' },
    { type: 'text', args0: [{ type: 'field_input', name: 'TEXT' }], output: 'String' },
    { type: 'logic_boolean', args0: [{ type: 'field_dropdown', name: 'BOOL', options: [['true', 'TRUE'], ['false', 'FALSE']] }], output: 'Boolean' },
    { type: 'variables_get', args0: [{ type: 'field_variable', name: 'VAR' }], output: null },
  ].map(json => [json.type, compileAbsDeclarativeContract(json)!]));
  const options = { argumentOrder: (type: string) => shapes.get(type)?.argumentOrder,
    fieldDefinition: (type: string, name: string) => shapes.get(type)?.fields[name] };
  const parse = (value: string) => parseAbsSyntax('# ABS Schema: 2\nsink(5, ' + value + ')', options)[0];
  for (const [value, type, field, expected] of [
    ['7', 'math_number', 'NUM', 7], ['number(7)', 'math_number', 'NUM', 7],
    ['"hello"', 'text', 'TEXT', 'hello'], ['true', 'logic_boolean', 'BOOL', true],
    ['false', 'logic_boolean', 'BOOL', false], ['HIGH', 'math_number', 'NUM', 1], ['LOW', 'math_number', 'NUM', 0],
    ['$counter', 'variables_get', 'VAR', 'counter'], ['var("counter")', 'variables_get', 'VAR', 'counter'],
  ]) it(`normalizes ${value} only in value slots`, () => {
    const node = parse(String(value)); expect(node.fields['COUNT'].value).toBe(5);
    expect(node.inputs['VALUE']?.type).toBe(String(type)); expect(node.inputs['VALUE']?.fields[String(field)].value).toBe(expected);
  });
  it('does not infer unknown text, accept absent contracts, or expand quoted variable-looking text', () => {
    expect(() => parse('unknown_expression')).toThrow();
    expect(() => parseAbsSyntax('# ABS Schema: 2\nsink(5, 7)', { argumentOrder: options.argumentOrder })).toThrow();
    expect(parse('"$counter"').inputs['VALUE']?.type).toBe('text');
  });
  it('resolves boolean shorthand using the real dropdown values, never labels or assumed casing', () => {
    for (const spelling of ['true', 'false']) {
      const token = parse(spelling).inputs['VALUE']!.fields['BOOL'];
      for (const value of [spelling, spelling.toUpperCase()]) {
        expect(resolveAbsFieldValue(token, { type: 'field_dropdown', options: [['localized label', value]] })).toBe(value);
      }
      for (const values of [[spelling, spelling.toUpperCase()], ['1', '0']]) {
        expect(() => resolveAbsFieldValue(token, { type: 'field_dropdown', options: values.map(value => ['label', value]) })).toThrow();
      }
    }
  });
});
