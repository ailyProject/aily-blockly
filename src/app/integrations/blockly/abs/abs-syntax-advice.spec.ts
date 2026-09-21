import { AbsSyntaxAdviceIndex, describePreparedAbsSyntax } from './abs-syntax-advice';

describe('prepared ABS syntax advice', () => {
  it('uses actual namespaces and options, never payloads or persisted IDs', () => {
    const state = { blocks: { blocks: [{ id: 'private-id', type: 'example', fields: { TEXT: 'private payload' } }] } };
    const result = describePreparedAbsSyntax(state, { fields: { 'private-id': {
      TEXT: { type: 'field_variable', symbol: { kind: 'variable', storage: 'variable-state', allowedTypes: ['SENSOR'] } },
      MODE: { type: 'field_dropdown', options: [['Display', 'KEY']] },
    } }, syntax: { 'private-id': [{ name: 'TEXT', kind: 'field' }, { name: 'TEXT', kind: 'valueInput' }, { name: 'MODE', kind: 'field' }] } },
    [{ start: 25, id: 'private-id' }]);
    expect(result.authority).toBeFalse(); expect(result.variants[0].sourceStart).toBe(25);
    expect(result.variants[0].argsOrder.length).toBe(3);
    expect(result.variants[0].fields['MODE']).toEqual({ type: 'field_dropdown', options: ['KEY'], optionsTruncated: false });
    expect(result.variants[0].fields['TEXT']).toEqual({ type: 'field_variable', variableTypes: ['SENSOR'], variableTypesTruncated: false });
    expect(JSON.stringify(result)).not.toMatch(/private|Display/);
  });

  it('deduplicates shapes and explicitly bounds advice without authorizing omitted variants', () => {
    const blocks = Array.from({ length: 40 }, (_, i) => ({ id: 'b' + i, type: 'type' + i }));
    const result = describePreparedAbsSyntax({ blocks: { blocks } }, {
      fields: {}, syntax: Object.fromEntries(blocks.map(block => [block.id, []])),
    }, blocks.map((block, i) => ({ id: block.id, start: i })));
    expect(result.variants.length).toBe(32); expect(result.truncated).toBeTrue();
  });

  it('retains proven configuration selectors, deduplicates instances and shares validation descriptions', () => {
    const blocks = ['a', 'b', 'c'].map((id, i) => ({ type: 'dynamic', id, fields: { MODE: i === 2 ? 'B' : 'A', DATA: 'x'.repeat(100000) } }));
    const order = [{ name: 'MODE', kind: 'field' as const }, { name: 'DATA', kind: 'field' as const }];
    const contracts = { fields: Object.fromEntries(blocks.map(block => [block.id, {
      MODE: { type: 'field_dropdown', options: [['A', 'A'], ['B', 'B']] as [string, string][] }, DATA: { type: 'field_input' },
    }])), syntax: Object.fromEntries(blocks.map(block => [block.id, order])),
      selectors: Object.fromEntries(blocks.map(block => [block.id, ['MODE']])) };
    const state = { blocks: { blocks } }, identities = blocks.map((block, start) => ({ id: block.id, start }));
    const index = new AbsSyntaxAdviceIndex(state, contracts, identities), result = index.describe(['dynamic']);
    expect(result.variants.length).toBe(2); expect(result.variants.map(item => item.selectors)).toEqual([{ MODE: 'A' }, { MODE: 'B' }]);
    expect(result).toEqual(jasmine.objectContaining({ variants: describePreparedAbsSyntax(state, contracts, identities).variants }));
    expect(JSON.stringify(result).length).toBeLessThan(1500);
    result.variants[0].argsOrder[0].name = 'corrupted';
    expect(index.describe(['dynamic']).variants[0].argsOrder[0].name).toBe('MODE');
    expect(index.describe(['missing']).variants).toEqual([]);
  });

  it('filters requested types before the global response limit and bounds large options', () => {
    const blocks = Array.from({ length: 40 }, (_, i) => ({ id: 'b' + i, type: 't' + i }));
    const index = new AbsSyntaxAdviceIndex({ blocks: { blocks } }, {
      fields: { b39: { DATA: { type: 'field_dropdown', options: [['huge', 'x'.repeat(100000)]] } } },
      syntax: Object.fromEntries(blocks.map(block => [block.id, [{ name: 'DATA', kind: 'field' as const }]])),
    }, blocks.map((block, start) => ({ id: block.id, start })));
    const result = index.describe(['t39']);
    expect(result.variants.length).toBe(1); expect(result.truncated).toBeTrue();
    expect(JSON.stringify(result).length).toBeLessThan(500);
  });
});
