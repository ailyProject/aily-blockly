import { externalizeGenericProjectDataValues, materializeGenericProjectDataValues, materializePreparedGenericProjectDataValues } from './project-data-generic-values';
import { assertNoOversizedInlineValues, findOversizedInlineValues } from './project-data-policy';
import { AilyDataRef, createAilyProjectDataValue } from './project-data.types';
import { canonicalJsonStringify } from './project-data-codec.registry';
import * as Blockly from 'blockly';
import { ProjectDataStore } from './project-data-store';

describe('generic Project Data payload boundaries', () => {
  it('canonicalizes null-prototype serializer dictionaries without accepting class instances', () => {
    const data = Object.assign(Object.create(null), JSON.parse('{"z":1,"__proto__":{"safe":true}}'));
    expect(canonicalJsonStringify(data)).toBe('{"__proto__":{"safe":true},"z":1}');
    for (const value of [new Date(), new Map(), new (class Payload { value = 1; })()]) {
      expect(() => canonicalJsonStringify(value)).toThrow();
    }
  });
  let values: Map<string, unknown>;
  let put: jasmine.Spy;
  const read = (ref: AilyDataRef) => values.get(ref.$ailyData.id);
  const reader = { resolve: async <T>(ref: AilyDataRef) => read(ref) as T };
  beforeEach(() => {
    values = new Map();
    put = jasmine.createSpy('put').and.callFake(async ({ value, codec }) => {
      const id = `sha256:${String(values.size + 1).padStart(64, '0')}` as const;
      values.set(id, value);
      return { $ailyData: { schemaVersion: 1, id, codec, logicalType: codec === 'utf8-v1' ? 'text' : 'json',
        storage: 'raw-v1', rawLength: 40000, storedLength: 40000 } } satisfies AilyDataRef;
    });
  });
  const workspace = (state: object) => ({ blocks: { blocks: [{ type: 'unknown_library_block', id: 'a', ...state }] } });

  it('round trips fields, extraState, data, icons and fallback shadows without library changes', async () => {
    const large = '😀'.repeat(10000);
    const document = workspace({ fields: { X: large }, extraState: [large], data: large,
      icons: { comment: { text: large } }, inputs: { X: { shadow: { type: 'custom_shadow', id: 's', fields: { X: large } } } } });
    expect(findOversizedInlineValues(document).length).toBe(5);
    const prepared = await externalizeGenericProjectDataValues(document, { put });
    expect(prepared.externalized.length).toBe(5);
    expect(() => assertNoOversizedInlineValues(prepared.document)).not.toThrow();
    expect(await materializeGenericProjectDataValues(prepared.document, reader)).toEqual(document);
    expect(materializePreparedGenericProjectDataValues(prepared.document, read)).toEqual(document);
    expect(document.blocks.blocks[0]['data']).toBe(large);
    expect(prepared.document.blocks.blocks[0].id).toBe('a');
  });

  it('keeps existing refs discoverable while externalizing their oversized siblings', async () => {
    const ref = await put({ codec: 'utf8-v1', value: 'existing' });
    const document = workspace({ fields: { MIXED: { ref, data: 'x'.repeat(40000), nested: [ref, 'y'.repeat(40000)] } } });
    expect(findOversizedInlineValues(document).length).toBe(2);
    const prepared = await externalizeGenericProjectDataValues(document, { put });
    expect(prepared.externalized.map(entry => entry.jsonPointer)).toEqual([
      '/blocks/blocks/0/fields/MIXED/data', '/blocks/blocks/0/fields/MIXED/nested/1',
    ]);
    expect(() => assertNoOversizedInlineValues(prepared.document)).not.toThrow();
    expect(await materializeGenericProjectDataValues(prepared.document, reader)).toEqual(document);
    const count = put.calls.count();
    expect((await externalizeGenericProjectDataValues(prepared.document, { put })).document).toEqual(prepared.document);
    expect(put.calls.count()).toBe(count);
  });

  it('uses UTF-8 bytes and only externalizes above the threshold', async () => {
    const prepared = await externalizeGenericProjectDataValues(workspace({ fields: { A: 'x'.repeat(32768), B: '界'.repeat(11000) } }), { put });
    expect(prepared.externalized.length).toBe(1);
    expect(prepared.externalized[0].fieldName).toBe('B');
    expect(prepared.externalized[0].canonicalLength).toBe(33000);
  });

  it('externalizes opaque workspace serializers even with no blocks, not duck-typed fields within them', async () => {
    const document = { 'custom/serializer~1': { type: 'not_a_block', id: 'opaque', fields: { TEXT: '界'.repeat(20000) } } };
    const prepared = await externalizeGenericProjectDataValues(document, { put });
    expect(prepared.externalized.map(entry => entry.jsonPointer)).toEqual(['/custom~1serializer~01']);
    expect(prepared.externalized[0].blockId).toBeUndefined();
    expect(prepared.externalized[0].codec).toBe('canonical-json-v1');
    expect(await materializeGenericProjectDataValues(prepared.document, reader)).toEqual(document);
    expect(materializePreparedGenericProjectDataValues(prepared.document, read)).toEqual(document);
  });

  it('handles inactive pages/shared block payloads while leaving page and document metadata alone', async () => {
    const large = 'x'.repeat(40000);
    const document = { schemaVersion: 3, metadata: { fields: { TITLE: large } },
      pages: [{ id: 'main', content: workspace({ fields: { TEXT: large } }) },
        { id: 'other', viewState: { fields: { TITLE: large } }, content: { models: [large] } }],
      sharedModel: { procedureBlocks: [{ type: 'definition', extraState: { params: [large] } }],
        variables: [{ id: 'variable', name: 'Name', type: '', extension: large }] } };
    const prepared = await externalizeGenericProjectDataValues(document, { put });
    expect(prepared.externalized.map(entry => entry.jsonPointer)).toEqual([
      '/pages/0/content/blocks/blocks/0/fields/TEXT', '/pages/1/content/models',
      '/sharedModel/procedureBlocks/0/extraState', '/sharedModel/variables/0/extension',
    ]);
    expect(prepared.document.metadata).toEqual(document.metadata);
    expect(prepared.document.sharedModel.variables[0].id).toBe('variable');
    expect(await materializeGenericProjectDataValues(prepared.document, reader)).toEqual(document);
    expect(findOversizedInlineValues(prepared.document)).toEqual([]);
  });

  it('never externalizes a large block graph or official variable identity table as a payload', async () => {
    const document = { variables: Array.from({ length: 2000 }, (_, i) => ({ id: `v${i}`, name: `Variable ${i}`, type: '' })),
      blocks: { blocks: Array.from({ length: 2000 }, (_, i) => ({ type: 'plain', id: `b${i}`, fields: { TEXT: 'small' } })) } };
    expect(JSON.stringify(document).length).toBeGreaterThan(32768);
    const prepared = await externalizeGenericProjectDataValues(document, { put });
    expect(prepared.document).toEqual(document);
    expect(put).not.toHaveBeenCalled();
  });

  it('keeps resource roots visible in mixed serializers and rejects malformed serializer envelopes', async () => {
    const existing = await put({ codec: 'utf8-v1', value: 'existing' });
    const document = { custom: { existing, nested: ['x'.repeat(40000)] } };
    const prepared = await externalizeGenericProjectDataValues(document, { put });
    expect(prepared.externalized.map(entry => entry.jsonPointer)).toEqual(['/custom/nested']);
    expect(ProjectDataStore.prototype.collectReferences(prepared.document).length).toBe(2);
    expect(await materializeGenericProjectDataValues(prepared.document, reader)).toEqual(document);
    await expectAsync(externalizeGenericProjectDataValues({ custom: { $ailyProjectDataValue: {} } }, { put })).toBeRejected();
    expect(() => assertNoOversizedInlineValues({ custom: { $ailyProjectDataValue: {} } })).toThrow();
  });

  it('restores real Blockly workspace serializers before native load for three rounds', async () => {
    const name = 'abs_test_project_data_serializer';
    const payload = { records: [{ id: 'model', fields: { TEXT: '😀'.repeat(10000) } }] };
    let state = JSON.parse(JSON.stringify(payload));
    const native = new Blockly.Workspace();
    Blockly.serialization.registry.register(name, {
      priority: 10, save: () => state, clear: () => { state = {}; }, load: value => { state = value; },
    });
    try {
      for (let round = 0; round < 3; round++) {
        const saved = Blockly.serialization.workspaces.save(native);
        const prepared = await externalizeGenericProjectDataValues(saved, { put });
        expect(prepared.externalized[0].jsonPointer).toBe(`/${name}`);
        const restored = await materializeGenericProjectDataValues(JSON.parse(JSON.stringify(prepared.document)), reader);
        Blockly.serialization.workspaces.load(restored, native);
        expect(state).toEqual(payload);
        expect(Blockly.serialization.workspaces.save(native)).toEqual(saved);
      }
    } finally { native.dispose(); Blockly.serialization.registry.unregister(name); }
  });

  it('handles standalone clipboard blocks and diagnoses cycles without interpreting payload contents as blocks', async () => {
    const block: any = { type: 'clipboard', fields: { TEXT: 'x'.repeat(40000) } };
    const prepared = await externalizeGenericProjectDataValues(block, { put });
    expect(prepared.externalized[0].jsonPointer).toBe('/fields/TEXT');
    block.next = { block };
    expect(() => assertNoOversizedInlineValues(block)).toThrow();
  });

  it('does not leak mutable prepared objects into field loadState', async () => {
    const ref = await put({ codec: 'canonical-json-v1', value: { frames: [1, 2] } });
    const document = workspace({ extraState: createAilyProjectDataValue(ref) });
    const restored = materializePreparedGenericProjectDataValues(document, read) as any;
    restored.blocks.blocks[0].extraState.frames[0] = 999;
    expect(read(ref)).toEqual({ frames: [1, 2] });
  });

  it('preserves special object keys during nested materialization', async () => {
    const ref = await put({ codec: 'utf8-v1', value: 'large text' });
    const payload = JSON.parse(`{"__proto__":${JSON.stringify(createAilyProjectDataValue(ref))}}`);
    const restored = await materializeGenericProjectDataValues(workspace({ extraState: payload }), reader) as any;
    expect(Object.hasOwn(restored.blocks.blocks[0].extraState, '__proto__')).toBeTrue();
    expect(restored.blocks.blocks[0].extraState['__proto__']).toBe('large text');
  });

  it('rejects nested malformed envelopes before writing any enclosing resource', async () => {
    const document = workspace({ extraState: { bad: { $ailyProjectDataValue: {} }, text: 'x'.repeat(40000) } });
    await expectAsync(externalizeGenericProjectDataValues(document, { put })).toBeRejected();
    expect(put).not.toHaveBeenCalled();
    expect(() => assertNoOversizedInlineValues(document)).toThrow();
  });

  it('rejects missing values, invalid codec results and hidden resource roots', async () => {
    const text = await put({ codec: 'utf8-v1', value: 42 });
    await expectAsync(materializeGenericProjectDataValues(workspace({ data: createAilyProjectDataValue(text) }), reader)).toBeRejected();
    const nested = await put({ codec: 'canonical-json-v1', value: { ref: text } });
    expect(() => materializePreparedGenericProjectDataValues(workspace({ extraState: createAilyProjectDataValue(nested) }), read)).toThrow();
    values.clear();
    await expectAsync(materializeGenericProjectDataValues(workspace({ data: createAilyProjectDataValue(text) }), reader)).toBeRejected();
  });
});
