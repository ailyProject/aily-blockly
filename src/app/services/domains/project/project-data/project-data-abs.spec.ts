import { extractStructuredAbsValues } from './project-data-abs';

describe('ABS structured resource discovery', () => {
  it('finds raw JSON fields and extraState without scanning comments or string contents', () => {
    const text = 'block(FIELD={"ref":{"id":"resource"}}, TEXT="{not JSON}") @extra:[false,1]\n# {broken';
    expect(extractStructuredAbsValues(text, { strict: true })).toEqual([
      { ref: { id: 'resource' } }, [false, 1],
    ]);
  });

  it('rejects malformed raw JSON when resource consumers require complete input', () => {
    expect(() => extractStructuredAbsValues('block(FIELD={"ref":', { strict: true })).toThrow();
  });

  it('keeps the existing legacy resource format until the coordinated format cutover', () => {
    const data = { ref: 'saved' };
    expect(extractStructuredAbsValues(`a(X=${JSON.stringify('@json:' + JSON.stringify(data))})`, { strict: true })).toEqual([data]);
    expect(() => extractStructuredAbsValues('a(X="@json:broken")', { strict: true })).toThrow();
  });
});
