import { AbsArgumentDefinition, parseAbsSyntax } from './abs-syntax';
import { ABS_SCHEMA_HEADER } from './abs-state';

describe('ABS definition-bound positional arguments', () => {
  const source = (code: string) => `${ABS_SCHEMA_HEADER}\n${code}`;
  const order: AbsArgumentDefinition[] = [{ name: 'textValue', kind: 'field' }, { name: 'VALUE', kind: 'valueInput' }, { name: 'BODY', kind: 'statementInput' }];
  const options = { argumentOrder: (type: string) => type === 'root' ? order : [{ name: 'NUM', kind: 'field' as const }] };

  it('maps positions using the complete definition and preserves nested source ranges', () => {
    const text = source('root("001", num(2))\n    @BODY:\n        task(NUM=3)');
    const node = parseAbsSyntax(text, options)[0];
    expect(node.fields['textValue'].value).toBe('001');
    expect(node.inputs['VALUE']!.fields['NUM'].value).toBe(2);
    expect(text.slice(node.inputs['VALUE']!.start, node.inputs['VALUE']!.end)).toBe('num(2)');
    expect(node.inputs['BODY']!.type).toBe('task');
  });
  it('allows named arguments after positions and a null value input', () => {
    const node = parseAbsSyntax(source('root("text", VALUE=null)'), options)[0];
    expect(node.inputs['VALUE']).toBeNull();
  });
  for (const text of ['root(1)', 'root("x", 2)', 'root(textValue="x", num(2))', 'root("x", textValue="again")', 'root("x", num(2), 3)']) {
    it(`rejects unbound/ambiguous argument use: ${text}`, () => {
      expect(() => parseAbsSyntax(source(text), text === 'root(1)' ? {} : options)).toThrow();
    });
  }
  it('does not accept a duplicate definition as an identity/position hint', () => {
    expect(() => parseAbsSyntax(source('root(1)'), { argumentOrder: () => [order[0], order[0]] })).toThrow();
  });
  it('records literal boundaries for quoted names, positional fields and extra JSON', () => {
    const text = source('root(\r\n \'# 中文 😀 (, )\\\'\', VALUE=num(NUM=2)\r\n) @extra:{"frames":[1,2]} # keep');
    const node = parseAbsSyntax(text, options)[0];
    const range = node.fieldRanges['textValue'];
    expect(text.slice(range.start, range.end)).toBe("'# 中文 😀 (, )\\''");
    expect(node.fields['textValue'].value).toBe("# 中文 😀 (, )'");
    expect(text.slice(node.extraRange!.start, node.extraRange!.end)).toBe('{"frames":[1,2]}');
    const inner = node.inputs['VALUE']!;
    expect(text.slice(inner.fieldRanges['NUM'].start, inner.fieldRanges['NUM'].end)).toBe('2');
    const quoted = parseAbsSyntax(source('root("a/b~c"="value")'))[0];
    expect(quoted.fieldRanges['a/b~c']).toBeDefined();
    expect(node.fieldRanges['VALUE']).toBeUndefined();
  });
});
