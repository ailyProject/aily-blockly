import { absSyntaxOptions } from './abs-syntax-contracts';

describe('captured ABS syntax lookup', () => {
  it('indexes repeated shapes once instead of rescanning every instance per call', () => {
    const blocks = Array.from({ length: 2800 }, (_, i) => ({ type: 'number', id: `n${i}`, fields: { NUM: i } }));
    let reads = 0;
    const order = [{ name: 'NUM', kind: 'field' as const }];
    const syntax = new Proxy(Object.fromEntries(blocks.map(b => [b.id, order])), {
      get(target, key) { reads++; return Reflect.get(target, key); },
    });
    const lookup = absSyntaxOptions({ blocks: { blocks } }, {
      fields: Object.fromEntries(blocks.map(b => [b.id, { NUM: { type: 'field_number' } }])), syntax,
    });
    for (const block of blocks) expect(lookup.argumentOrder!('number', undefined, block.fields)).toEqual(order);
    expect(reads).toBe(blocks.length);
  });

  it('separates selected variants, missing selectors and extra state', () => {
    const order = (field: string) => [{ name: 'MODE', kind: 'field' as const }, { name: field, kind: 'valueInput' as const }];
    const lookup = absSyntaxOptions({ blocks: { blocks: [
      { id: 'a', type: 'shape', fields: { MODE: 'A' }, extraState: { count: 1 } },
      { id: 'b', type: 'shape', fields: { MODE: 'B' }, extraState: { count: 1 } },
    ] } }, { fields: { a: {}, b: {} }, selectors: { a: ['MODE'], b: ['MODE'] }, syntax: { a: order('A'), b: order('B') } });
    for (let i = 0; i < 2; i++) {
      expect(lookup.argumentOrder!('shape', { count: 1 }, { MODE: 'A' })).toEqual(order('A'));
      expect(lookup.argumentOrder!('shape', { count: 1 }, { MODE: 'B' })).toEqual(order('B'));
      expect(lookup.argumentOrder!('shape', { count: 1 }, {})).toEqual(order('A').slice(0, 1));
      expect(lookup.argumentOrder!('shape', { count: 2 }, { MODE: 'A' })).toBeUndefined();
    }
  });

  it('does not cache live fallback declarations as baseline evidence', () => {
    let name = 'A';
    const lookup = absSyntaxOptions({ blocks: { blocks: [] } }, { fields: {} }, {
      argumentOrder: () => [{ name, kind: 'field' }], fieldDefinition: () => ({ type: name }),
    });
    expect(lookup.argumentOrder!('new')![0].name).toBe('A');
    name = 'B';
    expect(lookup.argumentOrder!('new')![0].name).toBe('B');
    expect(lookup.fieldDefinition!('new', 'value')!.type).toBe('B');
  });
});
