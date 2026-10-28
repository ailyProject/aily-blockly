import { parseAbsSyntax } from './abs-syntax';

describe('ABS protection annotations', () => {
  const parse = (call: string) => parseAbsSyntax('# ABS Schema: 2\n' + call);

  it('binds explicit protection independently of disabled and mutation state', () => {
    const node = parse('root() @protect:{"deletable":false,"movable":false,"editable":false} @disabled @extra:{"count":2}')[0];
    expect(node.protection).toEqual({ deletable: false, movable: false, editable: false });
    expect(node.disabled).toBeTrue();
    expect(node.extraState).toEqual({ count: 2 });
  });

  it('supports protection on nested value calls without consuming their parent arguments', () => {
    const node = parse('root(VALUE=number(NUM=2) @protect:{"movable":false}, TEXT="after")')[0];
    expect(node.inputs['VALUE']!.protection).toEqual({ movable: false });
    expect(node.fields['TEXT'].value).toBe('after');
  });

  for (const value of ['null', '[]', '{}', '{"deletable":true}', '{"movable":0}', '{"editable":"false"}',
    '{"disabled":true}', '{"id":"injected"}', '{"__proto__":{}}']) {
    it('rejects non-protective or unrecognized state ' + value, () => {
      expect(() => parse('root() @protect:' + value)).toThrow();
    });
  }

  it('rejects duplicate protection annotations', () => {
    expect(() => parse('root() @protect:{"deletable":false} @protect:{"movable":false}')).toThrow();
  });
});
