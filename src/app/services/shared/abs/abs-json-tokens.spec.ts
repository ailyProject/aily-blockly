import { readAbsJsonToken, readAbsSingleQuotedToken, scanAbsJsonTokens } from './abs-json-tokens';

describe('shared ABS JSON boundaries', () => {
  it('stops at the exact JSON boundary with nested arrays and escaped quotes', () => {
    const value = { text: 'slash\\', quote: '\"#)', items: [{ value: false }] };
    const json = JSON.stringify(value);
    const token = readAbsJsonToken('x=' + json + ', next()', 2);
    expect(token).toEqual({ start: 2, end: json.length + 2, value });
  });
  it('ignores comments and braces in quoted text', () => {
    const result = scanAbsJsonTokens('a(X="[fake]", Y={"x":1}) # {malformed\nb(X=[1])');
    expect(result.errors).toEqual([]);
    expect(result.tokens.map(token => token.value)).toEqual(['[fake]', { x: 1 }, [1]]);
  });
  for (const json of ['[1}', '{"x":', '"unterminated', '{invalid}']) {
    it(`reports malformed input without treating it as a complete empty set: ${json}`, () => {
      expect(scanAbsJsonTokens(`a(X=${json}`).errors.length).toBe(1);
    });
  }
});

describe('ABS single-quoted text boundaries', () => {
  it('decodes JSON escapes, escaped apostrophes and Unicode at exact UTF-16 offsets', () => {
    const raw = "'quote\\' slash\\\\ tab\\t line\\n unicode\\u4e2d 😀 \" # (,)'";
    expect(readAbsSingleQuotedToken('x=' + raw + ',next', 2)).toEqual({ start: 2, end: 2 + raw.length,
      value: 'quote\' slash\\ tab\t line\n unicode中 😀 " # (,)' });
  });
  for (const raw of ["'unterminated", "'line\nbreak'", "'\\x41'", "'\\q'", "'\\u12xz'", "'tail\\", '"wrong quote"']) {
    it(`rejects malformed/unsupported text ${JSON.stringify(raw)}`, () => {
      expect(() => readAbsSingleQuotedToken(raw, 0)).toThrow();
    });
  }
});
