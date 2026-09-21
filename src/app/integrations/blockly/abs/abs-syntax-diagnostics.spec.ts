import { readAbsSyntax } from './abs-syntax';
import { serializeAbsFailure } from './abs-diagnostics';
import { AbsGenerationToolsService } from './abs-generation-tools.service';

describe('ABS argument boundary diagnostics', () => {
  const header = '# ABS Schema: 2\n';
  function failure(body: string) {
    try { readAbsSyntax(header + body); fail('accepted malformed syntax'); }
    catch (error) { return serializeAbsFailure(error); }
    throw new Error('expected failure');
  }

  it('reads space-containing enum atoms as one parameter without guessing a field', () => {
    for (const [type, value] of [['variable_define', 'unsigned long'], ['device', 'fast mode'], ['device', '高速 模式']]) {
      const body = `${type}("counter", ${value}, math_number(0))`;
      const result = readAbsSyntax(header + body);
      expect(result[0].parameters.length).toBe(3);
      expect(result[0].parameters[1].token!.value).toBe(value);
      const corrected = readAbsSyntax(header + body.replace(value, JSON.stringify(value)));
      expect(corrected[0].parameters[1].token!.value).toBe(value);
    }
  });

  it('keeps named and nested call context and explains missing separators', () => {
    const named = readAbsSyntax(header + 'outer(inner(TYPE=unsigned long))');
    expect(named[0].parameters[0].child!.parameters[0].token!.value).toBe('unsigned long');
    for (const body of ['outer(inner(1) inner(2))', 'outer(1 2)', 'outer("x" "y")', 'outer(1',
      'outer(int math_number(2))', 'outer(int NEXT=2)', 'outer($one $two)', 'outer(unsigned\nlong)']) {
      const result = failure(body);
      expect(result.diagnostic!.reason).toBe('argument-separator');
      expect(result.diagnostic!.hint).toContain('commas');
      expect(result.range!.start).toBeLessThanOrEqual((header + body).length);
    }
  });

  it('preserves existing bare enum, variable shorthand, multiline and quoted forms', () => {
    for (const body of ['define("counter", int, math_number(7))', 'set($counter, $counter)',
      'define("counter", "unsigned long", math_number(0))', 'device("a,b", "read()")',
      'device(\n  fast,\n  math_number(0)\n)', "device('fast mode')"]) {
      expect(() => readAbsSyntax(header + body)).not.toThrow();
    }
    expect(readAbsSyntax(header + 'device(1,)')[0].parameters.length).toBe(1);
  });

  it('returns line, column, context and recovery through the tool boundary without a success receipt', async () => {
    const source = header + 'device(\n  1 2\n)';
    const sync = { exportGeneration: async () => readAbsSyntax(source) };
    const result: any = await new AbsGenerationToolsService(sync as any).execute('abs_projection', {
      version: 2, requestId: 'syntax-diagnostic', expectedAbiHash: 'sha256:' + 'a'.repeat(64),
    }, source);
    expect(result.ok).toBeFalse();
    expect(result.location).toEqual({ line: 3, column: 5 });
    expect(result.diagnostic.received).toContain('1 2');
    expect(result.recovery).toBe(result.diagnostic.hint);
    expect(result.receipt).toBeUndefined();
  });

  it('bounds context even for a large nested argument', () => {
    const result = failure(`device(text("${'x'.repeat(10000)}") other())`);
    expect(result.diagnostic!.received!.toString().length).toBeLessThanOrEqual(160);
    expect(JSON.stringify(result).length).toBeLessThan(1000);
    expect(readAbsSyntax(header + `device(unsigned ${'word'.repeat(100)})`)[0].parameters.length).toBe(1);
  });
});
