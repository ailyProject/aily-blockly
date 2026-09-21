import { parseAbsSyntax } from './abs-syntax';
import { parseBlockDefinition } from './block-definition.model';
import { resolveAbsFieldValue } from './abs-field-values';
import { createAbsProjection, validateAbsProjection } from './abs-identity-map';
import { reconcileAbsDraft } from './abs-reconciler';
import { type AbsAbiWorkspace, type AbsProjectionContracts } from './abs-state';

describe('retained unambiguous ABS shorthand', () => {
  const definitions = [
    { type: 'arduino_setup', args0: [{ name: 'BODY', type: 'input_statement' }] },
    { type: 'controls_ifelse', args0: [{ name: 'IF0', type: 'input_value' }, { name: 'DO0', type: 'input_statement' }, { name: 'ELSE', type: 'input_statement' }] },
    { type: 'consume', args0: [{ name: 'VALUE', type: 'input_value' }] },
    { type: 'time_millis', output: 'Number' },
    { type: 'math_number', args0: [{ name: 'NUM', type: 'field_number' }] },
    { type: 'logic_boolean', args0: [{ name: 'BOOL', type: 'field_dropdown', options: [['true', 'true'], ['false', 'false']] }] },
    { type: 'qualifier', args0: [{ name: 'MODE', type: 'field_dropdown', options: [['none', ''], ['static', 'static']] }] },
  ];
  const metadata = new Map(definitions.map(definition => [definition.type, parseBlockDefinition(definition, '')!]));
  const options = { argumentOrder: (type: string) => metadata.get(type)?.argsOrder,
    fieldDefinition: (type: string, name: string) => metadata.get(type)?.fieldDefinitions?.get(name) };
  const parse = (source: string) => parseAbsSyntax('# ABS Schema: 2\n' + source, options);

  for (const indent of ['  ', '    ', '\t']) it('preserves offsets with consistent indentation ' + JSON.stringify(indent), () => {
    const source = `arduino_setup\n${indent}consume(time_millis)\n${indent}consume(math_number(3,))`;
    const root = parse(source)[0], first = root.inputs['BODY']!;
    expect(first.inputs['VALUE']!.type).toBe('time_millis');
    expect(first.next!.inputs['VALUE']!.fields['NUM'].value).toBe(3);
    const text = '# ABS Schema: 2\n' + source;
    expect(text.slice(first.inputs['VALUE']!.start, first.inputs['VALUE']!.end)).toBe('time_millis');
  });
  it('accepts an omitted argument only when the actual dropdown permits the empty option', () => {
    const token = parse('qualifier(,)')[0].fields['MODE'];
    expect(resolveAbsFieldValue(token, options.fieldDefinition('qualifier', 'MODE'))).toBe('');
    expect(() => resolveAbsFieldValue(token, { type: 'field_number' })).toThrow();
    expect(() => resolveAbsFieldValue(token, { type: 'field_input' })).toThrow();
    expect(() => parse('consume(,)')).toThrow();
  });
  it('retains core conditional default bodies and unambiguous case-insensitive section names', () => {
    const node = parse('controls_ifelse(true)\n    consume(1)\n    @else:\n        consume(2)')[0];
    expect(node.inputs['DO0']!.inputs['VALUE']!.fields['NUM'].value).toBe(1);
    expect(node.inputs['ELSE']!.inputs['VALUE']!.fields['NUM'].value).toBe(2);
    expect(parse('controls_ifelse()\n    @if0: true\n    @do0:\n        consume(1)')[0].inputs['IF0']!.type).toBe('logic_boolean');
  });
  for (const source of ['consume(unknown_word)', 'consume', 'unknown_block',
    'arduino_setup()\n  consume(1)\n\tconsume(2)', 'consume(1 2)', 'consume(VALUE=1, 2)']) {
    it('does not guess malformed input: ' + source, () => expect(() => parse(source)).toThrow());
  }
});

describe('branch presentation keeps ABS-map identity', () => {
  for (const type of ['controls_if', 'controls_switch']) it('pairs conditions and bodies while retaining immutable identities: ' + type, async () => {
    const prefix = type === 'controls_if' ? 'IF' : 'CASE', tail = type === 'controls_if' ? 'ELSE' : 'DEFAULT';
    const fields: AbsProjectionContracts['fields'] = { branch: {} };
    const syntax: NonNullable<AbsProjectionContracts['syntax']> = {};
    const number = (id: string, n: number) => {
      fields[id] = { NUM: { type: 'field_number' } }; syntax[id] = [{ name: 'NUM', kind: 'field' }];
      return { block: { type: 'math_number', id, fields: { NUM: n } } };
    };
    const statement = (id: string) => { fields[id] = {}; syntax[id] = []; return { block: { type: 'act', id } }; };
    const inputs = { [tail]: statement('tail'), DO1: statement('body1'), [prefix + '1']: number('v1', 2),
      DO0: statement('body0'), [prefix + '0']: number('v0', 1), ...(type === 'controls_switch' ? { SWITCH: number('selector', 2) } : {}) };
    syntax['branch'] = Object.keys(inputs).map(name => ({ name,
      kind: name.startsWith(prefix) || name === 'SWITCH' ? 'valueInput' as const : 'statementInput' as const }));
    const workspace: AbsAbiWorkspace = { blocks: { blocks: [{ type, id: 'branch', deletable: false, x: 30, y: 60,
      extraState: type === 'controls_if' ? { elseIfCount: 1, hasElse: true } : { caseCount: 1, hasDefault: true }, inputs }] } };
    const baseline = await createAbsProjection(workspace, { document: workspace, contracts: { fields, syntax }, generation: 'branches',
      baselineRef: 'base', savedAbiHash: null, scope: { projectKey: 'p', pageId: 'main' } });
    expect(baseline.abs).toContain(type + '()');
    const markers = [...baseline.abs.matchAll(/@(\w+):(?=[ \n])/g)].map(match => match[1]);
    expect(markers).toEqual([...(type === 'controls_switch' ? ['SWITCH'] : []), prefix + '0', 'DO0', prefix + '1', 'DO1', tail]);
    await validateAbsProjection(baseline);
    const result = await reconcileAbsDraft(baseline, baseline.abs.replace('math_number(1)', 'math_number(9)'));
    expect(result.workspace.blocks.blocks[0].inputs![prefix + '0'].block!.id).toBe('v0');
    expect(result.workspace.blocks.blocks[0].inputs![prefix + '0'].block!.fields!['NUM']).toBe(9);
    expect(result.workspace.blocks.blocks[0]['deletable']).toBeFalse();
    expect(result.added).toEqual([]); expect(result.removed).toEqual([]);
  });
});
