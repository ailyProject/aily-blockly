import { checkAbsDocumentation } from './abs-documentation';

describe('README ABS syntax checks', () => {
  const check = (text: string) => checkAbsDocumentation({ version: 1, documents: [{ name: 'README_AI.md', text }] });
  it('uses the real parser for nested calls, variables and enum quoting', () => {
    const report = check('```abs\nvariable_define("counter", "unsigned long", math_number(0))\nvariables_set($counter, variables_get($counter))\n```');
    expect(report.status).toBe('passed');
    expect(report.exampleCount).toBe(1);
    expect(check('```abs\nvariable_define("counter", unsigned long, math_number(0))\n```').status).toBe('passed');
    const bad = check('```abs\nvariable_define("counter", unsigned long math_number(0))\n```');
    expect(bad.status).toBe('failed');
    expect(bad.documents[0].examples[0].diagnostic.hint).toContain('commas');
    expect(bad.documents[0].examples[0].location.line).toBe(1);
  });
  it('extracts only labelled ABS fences, including nested Markdown and CRLF', () => {
    const report = check('```js\nbroken(\n```\n> ~~~ABS\r\n> unknown(1)\r\n> ~~~\r\n\n- Example:\n\n  ```abs\n  other(2)\n  ```');
    expect(report.exampleCount).toBe(2);
    expect(report.status).toBe('passed');
    expect(report.notRun).toContain('block-bindings');
  });
  it('does not certify absent examples, empty examples or incompatible schema', () => {
    expect(check('Example: `unknown()`').status).toBe('no-examples');
    expect(check('```abs\n```').status).toBe('failed');
    expect(check('```abs\n# ABS Schema: 1\nunknown()\n```').status).toBe('failed');
    expect(check('```abs\n# ABS Schema: 2\nunknown(\n```').documents[0].examples[0].location.line).toBe(2);
  });
  it('bounds inputs and checks both documents without stopping after the first invalid example', () => {
    expect(() => check('x'.repeat(65537))).toThrow();
    expect(() => check('```abs\nx()\n```\n'.repeat(65))).toThrow();
    const report = checkAbsDocumentation({ version: 1, documents: [
      { name: 'README.md', text: '```abs\nx(\n```' },
      { name: 'README_AI.md', text: '```abs\ny()\n```\n```abs\nz(\n```' },
    ] });
    expect(report.exampleCount).toBe(3);
    expect(report.documents[1].examples[1].status).toBe('failed');
    expect(() => checkAbsDocumentation({ version: 1, documents: [{ name: '../x', text: '' }] })).toThrow();
  });
});
