import { updateProjectBlockFields } from './project-block-field-updates';

describe('pure project field updates', () => {
  const block = (id: string, extra: object = {}) => ({ type: 'any_library', id, deletable: false, fields: { TEXT: 'before' }, ...extra });
  it('updates pages, shared procedures, shadow and next using the same serialization boundaries', () => {
    const original = { pages: [{ content: { blocks: { blocks: [block('a', { inputs: { X: { block: block('b'), shadow: block('s') } },
      next: { block: block('n') } })] }, customSerializer: { id: 'opaque', type: 'any_library', fields: { TEXT: 'keep' } } } },
      { content: { blocks: { blocks: [block('page2')] } } }], sharedModel: { procedureBlocks: [block('p')] } };
    const result = updateProjectBlockFields(original, { a: 'A', b: 2, s: false, n: 'N', page2: 'P2', p: 'P' });
    expect(result.changed).toBeTrue();
    expect(JSON.stringify(original)).not.toContain('P2');
    expect(result.document.pages[0].content.blocks.blocks[0].deletable).toBeFalse();
    expect(result.document.pages[0].content.customSerializer.fields.TEXT).toBe('keep');
    expect(() => updateProjectBlockFields(original, { opaque: 'bad' })).toThrowError(/unknown block/);
  });
  it('supports JSON arrays and objects through an explicit field/value envelope', () => {
    const value = { frames: [[1, 2]], text: '大值'.repeat(20000) };
    const result = updateProjectBlockFields({ blocks: { blocks: [block('a')] } }, { a: { field: 'DATA', value } });
    expect(result.document.blocks.blocks[0].fields['DATA']).toEqual(value);
    value.frames[0][0] = 99;
    expect(result.document.blocks.blocks[0].fields['DATA'].frames[0][0]).toBe(1);
  });
  it('preserves no-op and empty updates without pretending the document changed', () => {
    const document = { blocks: { blocks: [block('a')] } };
    expect(updateProjectBlockFields(document, { a: 'before' }).changed).toBeFalse();
    expect(updateProjectBlockFields(document, {}).changed).toBeFalse();
  });
  it('rejects unknown or ambiguous IDs atomically, preserving the input', () => {
    const document = { blocks: { blocks: [block('a')] } };
    expect(() => updateProjectBlockFields(document, { a: 'after', missing: 1 })).toThrow();
    expect(document.blocks.blocks[0].fields.TEXT).toBe('before');
    expect(() => updateProjectBlockFields({ blocks: { blocks: [block('a'), block('a')] } }, { a: 1 })).toThrowError(/Duplicate/);
  });
  it('treats prototype-like identities and fields as data, not object prototype assignment', () => {
    const result = updateProjectBlockFields({ blocks: { blocks: [block('__proto__')] } },
      JSON.parse('{"__proto__":{"field":"__proto__","value":{"safe":true}}}'));
    expect(Object.hasOwn(result.document.blocks.blocks[0].fields, '__proto__')).toBeTrue();
    expect(({} as any).safe).toBeUndefined();
  });
  for (const value of [undefined, NaN, Infinity, () => {}, [1, 2], { field: 'X' }, { value: 1, field: 2 }, { value: undefined }, { value: 1, other: 2 }]) {
    it(`rejects invalid/non-JSON updates: ${String(value)}`, () => {
      expect(() => updateProjectBlockFields({ blocks: { blocks: [block('a')] } }, { a: value } as any)).toThrow();
    });
  }
});
