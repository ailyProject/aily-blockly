import { migrateLegacyShadowIdentities } from './legacy-shadow-identities';
import { collectProjectBlockLocations } from './project-data/project-data-payloads';

describe('legacy hidden shadow identities', () => {
  const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  const shadow = () => ({ type: 'math_number', id: 'fallback', fields: { NUM: 1500 } });
  const parent = (id: string) => ({ type: 'arbitrary_library', id, inputs: { VALUE: {
    shadow: shadow(), block: { type: 'math_number', id: `value-${id}`, fields: { NUM: 42 } },
  } } });
  const source = () => ({ blocks: { blocks: [parent('a'), parent('b')] }, variables: [{ id: 'model', name: 'counter', type: '' }] });
  let next: number;
  const generate = () => `new-${++next}`;
  beforeEach(() => { next = 0; });

  it('changes only subsequent hidden identities and reports each ownership path', () => {
    const input = source(), before = copy(input);
    const result = migrateLegacyShadowIdentities(input, generate);
    expect(input).toEqual(before);
    expect(result.changes).toEqual([{ jsonPointer: '/blocks/blocks/1/inputs/VALUE/shadow/id', oldId: 'fallback',
      newId: 'new-1', ownerConnection: '/blocks/blocks/1/inputs/VALUE', reason: 'duplicate-hidden-shadow' }]);
    const expected = copy(input); expected.blocks.blocks[1].inputs.VALUE.shadow.id = 'new-1';
    expect(result.document).toEqual(expected);
    expect(migrateLegacyShadowIdentities(result.document, generate)).toEqual({ document: result.document, changes: [] });
  });
  it('handles 96 occurrences without changing defaults, models, or live connections', () => {
    const input = { blocks: { blocks: Array.from({ length: 96 }, (_, i) => parent(`p-${i}`)) } };
    const result = migrateLegacyShadowIdentities(input, generate);
    expect(result.changes.length).toBe(95);
    const entries = collectProjectBlockLocations(result.document);
    expect(new Set(entries.map(x => x.state['id'])).size).toBe(entries.length);
    for (const root of result.document.blocks.blocks) root.inputs.VALUE.shadow.id = 'fallback';
    expect(result.document).toEqual(input);
  });
  it('does not treat an existing data-schema marker as proof of valid identities', () => {
    const input = { ...source(), $ailyProjectData: { version: 1 } };
    const result = migrateLegacyShadowIdentities(input, generate);
    expect(result.changes.length).toBe(1);
    expect(result.document.$ailyProjectData).toEqual(input.$ailyProjectData);
  });
  it('refuses unresolved external payloads before allocating any identity', () => {
    const input = { ...source(), payload: { $ailyData: { schemaVersion: 1, id: `sha256:${'a'.repeat(64)}`,
      codec: 'canonical-json-v1', logicalType: 'json', storage: 'raw-v1', rawLength: 8, storedLength: 8 } } };
    const before = copy(input);
    expect(() => migrateLegacyShadowIdentities(input, generate)).toThrowError(/External structured data/);
    expect(input).toEqual(before); expect(next).toBe(0);
  });
  it('preserves immutable binary assets without interpreting their bytes as identities', () => {
    const input = { ...source(), image: { $ailyData: { schemaVersion: 1, id: `sha256:${'a'.repeat(64)}`,
      codec: 'image-original-v1', logicalType: 'binary', storage: 'raw-v1', rawLength: 8, storedLength: 8 } } };
    const result = migrateLegacyShadowIdentities(input, generate);
    expect(result.changes.length).toBe(1); expect(result.document.image).toEqual(input.image);
  });
  it('inherits hidden ownership through nested inputs and next chains', () => {
    const input: any = source();
    for (const root of input.blocks.blocks) root.inputs.VALUE.shadow.inputs = { X: {
      block: { type: 'custom', id: 'nested', next: { block: { type: 'custom', id: 'tail' } } },
    } };
    const result = migrateLegacyShadowIdentities(input, generate);
    expect(result.changes.map(x => x.oldId)).toEqual(['fallback', 'nested', 'tail']);
    expect(result.changes.every(x => x.ownerConnection === '/blocks/blocks/1/inputs/VALUE')).toBeTrue();
  });
  for (const mode of ['active', 'visible-shadow', 'mixed'] as const) {
    it(`refuses ${mode} collisions without touching the source`, () => {
      const input: any = source();
      if (mode === 'active') input.blocks.blocks[1].id = 'a';
      if (mode === 'visible-shadow') for (const root of input.blocks.blocks) delete root.inputs.VALUE.block;
      if (mode === 'mixed') delete input.blocks.blocks[1].inputs.VALUE.block;
      const before = copy(input);
      expect(() => migrateLegacyShadowIdentities(input, generate)).toThrowError(/Duplicate identity/);
      expect(input).toEqual(before); expect(next).toBe(0);
    });
  }
  for (const extra of [{ extraState: { owner: 'fallback' } }, { data: 'fallback' }, { extension: { fallback: true } }]) {
    it(`refuses unknown references ${JSON.stringify(extra)}`, () => {
      expect(() => migrateLegacyShadowIdentities({ ...source(), ...extra }, generate)).toThrowError(/Cannot safely rename/);
      expect(next).toBe(0);
    });
  }
  it('preserves known variable model and dropdown references in their own namespace', () => {
    const input: any = source(); input.variables[0].id = 'fallback';
    input.blocks.blocks[0].fields = { VAR: { id: 'fallback' } };
    const result = migrateLegacyShadowIdentities(input, generate);
    expect(result.document.variables).toEqual(input.variables);
    expect(result.document.blocks.blocks[0].fields).toEqual(input.blocks.blocks[0].fields);
  });
  it('reserves the complete graph including blocks visited later', () => {
    const input = source(); input.blocks.blocks[1].inputs.VALUE.block.id = 'new-1';
    expect(migrateLegacyShadowIdentities(input, generate).changes[0].newId).toBe('new-2');
  });
  it('deduplicates proven shared ownership before planning; mirrors receive the same changes', () => {
    const root = { type: 'definition', id: 'definition', inputs: { BODY: { block: parent('a') } }, next: { block: parent('b') } };
    const input = { schemaVersion: 3, activePageId: 'p1', openedPageIds: ['p1'], sharedModel: { procedureBlocks: [root] },
      pages: ['p1', 'p2'].map(id => ({ id, title: id, content: { blocks: { blocks: [copy(root)] } } })) };
    const result = migrateLegacyShadowIdentities(input, generate);
    expect(result.changes.length).toBe(1);
    expect(result.document.pages.every(p => JSON.stringify(p.content.blocks.blocks[0]) === JSON.stringify(result.document.sharedModel.procedureBlocks[0]))).toBeTrue();
    expect(migrateLegacyShadowIdentities(result.document, generate).changes).toEqual([]);
  });
  it('does not split conflicting shared mirrors', () => {
    const root = parent('a');
    const input = { sharedModel: { procedureBlocks: [root] }, pages: [{ content: { blocks: { blocks: [{ ...copy(root), disabled: true }] } } }] };
    expect(() => migrateLegacyShadowIdentities(input, generate)).toThrowError(/Shared definition copies differ/);
  });
});
