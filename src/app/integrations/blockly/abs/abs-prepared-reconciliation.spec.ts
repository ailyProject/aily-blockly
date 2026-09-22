import * as Blockly from 'blockly';
import 'blockly/blocks';
import { AilyDataRef, assertNoOversizedInlineValues, canonicalJsonStringify, createAilyProjectDataValue } from '@domain/project/public-api';
import { absJson, createAbsProjection, hashAbsText } from './abs-identity-map';
import { prepareAbsReconciliation } from './abs-prepared-reconciliation';
import { reconcileAbs, reconcileAbsDraft } from './abs-reconciler';
import { replaceAbsBoundValues } from './abs-source-edits';
import { ABS_SCHEMA_HEADER, AbsAbiWorkspace } from './abs-state';

describe('ABS v2 source-bound resource preparation', () => {
  const source = (text: string) => `${ABS_SCHEMA_HEADER}\r\n# Project Data Schema: 1 (external-only)\r\n${text}`;
  const text = '中文 😀 # (, ) " \\ '.repeat(2500);
  const page = (): AbsAbiWorkspace => ({ blocks: { blocks: [{ type: 'text', id: 'protected', deletable: false,
    fields: { TEXT: 'old' }, x: 30, y: 60, data: 'keep', icons: { comment: { text: 'note' } } }] } });
  const projection = (workspace = page()) => createAbsProjection(workspace, { document: workspace, generation: 'g1',
    baselineRef: 'baselines/g1.json', scope: { projectKey: 'project', pageId: 'main' }, savedAbiHash: null });
  let current: boolean;
  let runtime: any;
  let values: Map<string, unknown>;
  const assertCurrent = () => { if (!current) throw new Error('stale'); };
  beforeEach(() => {
    current = true;
    values = new Map();
    runtime = {
      put: jasmine.createSpy('put').and.callFake(async request => {
        const bytes = new TextEncoder().encode(request.codec === 'utf8-v1' ? request.value : canonicalJsonStringify(request.value));
        const id = await hashAbsText(request.codec + ':' + canonicalJsonStringify(request.value));
        const ref: AilyDataRef = { $ailyData: { schemaVersion: 1, id: id as `sha256:${string}`, codec: request.codec,
          logicalType: request.codec === 'utf8-v1' ? 'text' : 'json', storage: 'raw-v1', rawLength: bytes.length, storedLength: bytes.length } };
        values.set(id, JSON.parse(JSON.stringify(request.value)));
        return ref;
      }),
      resolve: jasmine.createSpy('resolve').and.callFake(async ref => {
        if (!values.has(ref.$ailyData.id)) throw new Error('missing resource');
        return JSON.parse(JSON.stringify(values.get(ref.$ailyData.id)));
      }),
      flushPending: jasmine.createSpy('flush').and.resolveTo(),
      prepareValue: jasmine.createSpy('prepare').and.resolveTo(),
    };
  });

  it('preserves identity/protection and exact surrounding source while externalizing positional text', async () => {
    const baseline = await projection();
    const code = source(`# same ${JSON.stringify(text)}\r\ntext(\r\n ${JSON.stringify(text)}\r\n) # keep 😀\r\n`);
    const options = { argumentOrder: () => [{ name: 'TEXT', kind: 'field' as const }] };
    await expectAsync(reconcileAbs(baseline, code, options)).toBeRejected();
    expect(runtime.put).not.toHaveBeenCalled();
    const result = await prepareAbsReconciliation(baseline, code, assertCurrent, options, runtime);
    const envelope = createAilyProjectDataValue(result.externalized[0].ref);
    expect(result.abs).toBe(source(`# same ${JSON.stringify(text)}\r\ntext(\r\n ${absJson(envelope)}\r\n) # keep 😀\r\n`));
    expect(result.inputAbs).toBe(code);
    expect(result.retained).toEqual(['protected']);
    expect(result.added).toEqual([]);
    expect(() => assertNoOversizedInlineValues(result.workspace)).not.toThrow();
    expect((await result.materialize()).blocks.blocks[0]).toEqual({ ...page().blocks.blocks[0], fields: { TEXT: text } });
    expect(baseline.workspace).toEqual(page());
  });

  it('externalizes escaped single-quoted fields without treating their contents as syntax', async () => {
    const value = text + "'\n\t中文";
    const single = "'" + JSON.stringify(value).slice(1, -1).replace(/'/g, "\\'") + "'";
    const result = await prepareAbsReconciliation(await projection(), source(`text(TEXT=${single}) # tail`), assertCurrent, {}, runtime);
    expect(result.abs).toContain('$ailyProjectDataValue');
    expect(result.abs.endsWith(' # tail')).toBeTrue();
    expect((await result.materialize()).blocks.blocks[0].fields!['TEXT']).toBe(value);
  });

  it('binds duplicate large values separately across fields, inline inputs, statements and next', async () => {
    const baseline = await projection({ blocks: { blocks: [] } });
    let id = 0;
    const json = JSON.stringify(text);
    const code = source(`parent(TEXT=${json}, VALUE=text(TEXT=${json}))\r\n    @BODY:\r\n        text(TEXT=${json})\r\n        text(TEXT=${json})\r\n    @next:\r\n        text(TEXT=${json}) # tail`);
    const result = await prepareAbsReconciliation(baseline, code, assertCurrent, { newId: () => `new-${++id}` }, runtime);
    expect(result.added.length).toBe(5);
    expect(id).toBe(5); // No second reconciliation/identity allocation during compaction.
    expect(result.externalized.length).toBe(5);
    expect(result.abs.match(/\$ailyProjectDataValue/g)?.length).toBe(5);
    expect((await result.materialize()).blocks.blocks[0].next!.block.fields!['TEXT']).toBe(text);
  });

  it('uses exact JSON Pointers for nested mixed payloads, arrays, empty and prototype-like keys', async () => {
    const existing = await runtime.put({ codec: 'utf8-v1', value: 'kept' });
    const mixed = JSON.parse('{"__proto__":null,"a/b~":null,"":null}');
    Object.assign(mixed, { existing, 'a/b~': text, '': [existing, text] });
    Object.defineProperty(mixed, '__proto__', { value: text, enumerable: true, writable: true });
    const valid = await projection({ blocks: { blocks: [{ type: 'custom', id: 'one' }] } });
    const result = await prepareAbsReconciliation(valid, source(`custom("a/b~"=${JSON.stringify(mixed)}, ""=${JSON.stringify(mixed)})`), assertCurrent, {}, runtime);
    const actual = (await result.materialize()).blocks.blocks[0].fields!;
    expect(actual['a/b~']).toEqual(mixed);
    expect(actual['']).toEqual(mixed);
    expect(Object.hasOwn(actual['a/b~'] as object, '__proto__')).toBeTrue();
    expect(({} as any).polluted).toBeUndefined();
    expect(result.externalized.length).toBe(6);
  });

  it('handles structured and scalar extraState, including a literal @json prefix', async () => {
    for (const extra of [[false, text], '@json:' + text, { frames: Array(10000).fill([1, 2, 3]) }]) {
      const result = await prepareAbsReconciliation(await projection(), source(`text(TEXT="old") @extra:${JSON.stringify(extra)} # extra`), assertCurrent, {}, runtime);
      expect(result.abs.endsWith(' # extra')).toBeTrue();
      expect((await result.materialize()).blocks.blocks[0].extraState).toEqual(extra);
      expect(result.workspace.blocks.blocks[0]['deletable']).toBeFalse();
    }
  });

  it('keeps dormant shadow and opaque workspace state in the baseline, not the ABS source', async () => {
    const ref = await runtime.put({ codec: 'utf8-v1', value: text });
    const envelope = createAilyProjectDataValue(ref);
    const workspace: AbsAbiWorkspace = { blocks: { blocks: [{ type: 'root', id: 'r', inputs: {
      VALUE: { block: { type: 'text', id: 'shown', fields: { TEXT: 'old' } },
        shadow: { type: 'text', id: 'hidden', fields: { TEXT: envelope } } },
    } }] }, customSerializer: { value: envelope } };
    const baseline = await projection(workspace);
    const result = await prepareAbsReconciliation(baseline, baseline.abs.replace('TEXT="old"', `TEXT=${JSON.stringify(text)}`), assertCurrent, {}, runtime);
    expect(result.abs).not.toContain('customSerializer');
    expect(result.abs.match(/\$ailyProjectDataValue/g)?.length).toBe(1);
    const actual = await result.materialize();
    expect(actual.blocks.blocks[0].inputs!['VALUE'].shadow!.fields!['TEXT']).toBe(text);
    expect(actual['customSerializer']).toEqual({ value: text });
  });

  it('supports three prepared projection/reconciliation cycles and real native field readback', async () => {
    let workspace = page();
    for (let cycle = 0; cycle < 3; cycle++) {
      const baseline = await projection(workspace);
      const result = await prepareAbsReconciliation(baseline, source(`text(TEXT=${JSON.stringify(text + cycle)})`), assertCurrent, {}, runtime);
      const actual = await result.materialize();
      const native = new Blockly.Workspace();
      try {
        Blockly.serialization.workspaces.load(actual, native);
        expect(native.getBlockById('protected')!.getFieldValue('TEXT')).toBe(text + cycle);
        expect(native.getBlockById('protected')!.isDeletable()).toBeFalse();
      } finally { native.dispose(); }
      workspace = result.workspace;
      const unchanged = await prepareAbsReconciliation(await projection(workspace), (await projection(workspace)).abs, assertCurrent, {}, runtime);
      expect(unchanged.externalized.length).toBe(0);
      expect(unchanged.workspace).toEqual(workspace);
    }
  });

  it('rejects protection violations and invalid baselines before any resource I/O', async () => {
    const baseline = await projection();
    await expectAsync(prepareAbsReconciliation(baseline, source(`other(TEXT=${JSON.stringify(text)})`), assertCurrent, {}, runtime)).toBeRejected();
    baseline.map.baseAbsHash = 'corrupt';
    await expectAsync(prepareAbsReconciliation(baseline, source(`text(TEXT=${JSON.stringify(text)})`), assertCurrent, {}, runtime)).toBeRejected();
    expect(runtime.put).not.toHaveBeenCalled();
    expect(runtime.prepareValue).not.toHaveBeenCalled();
  });

  it('does not let stale preparation callbacks start resource writes', async () => {
    const baseline = await projection();
    await expectAsync(prepareAbsReconciliation(baseline, source(`text(TEXT=${JSON.stringify(text)})`), assertCurrent,
      { fieldDefinition: () => { current = false; return { type: 'field_input' }; } }, runtime)).toBeRejectedWithError('stale');
    expect(runtime.put).not.toHaveBeenCalled();
  });

  it('does not hide declared procedure parameter paths inside a generic extraState resource', async () => {
    const workspace: AbsAbiWorkspace = { blocks: { blocks: [{ type: 'procedure', id: 'definition',
      fields: { NAME: 'work' }, extraState: { params: [] } }] } };
    const baseline = await createAbsProjection(workspace, { document: workspace, generation: 'g1',
      baselineRef: 'baselines/g1.json', scope: { projectKey: 'project', pageId: 'main' }, savedAbiHash: null,
      contracts: { fields: {}, procedures: { definition: { role: 'definition', namePath: '/fields/NAME',
        parametersPath: '/extraState/params', parameterNamePath: '/name', returns: false } } } });
    const edited = baseline.abs.replace('{"params":[]}', JSON.stringify({ params: [], payload: text }));
    await expectAsync(prepareAbsReconciliation(baseline, edited, assertCurrent, {}, runtime))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_DATA_MODEL_PATH' }));
    expect(baseline.workspace).toEqual(workspace);
  });

  it('also preserves explicit symbol contracts supplied for newly added fields', async () => {
    const workspace: AbsAbiWorkspace = { blocks: { blocks: [] }, variables: [{ id: 'variable', name: text, type: '' }] };
    await expectAsync(prepareAbsReconciliation(await projection(workspace), source(`new_get(VAR=${JSON.stringify(text)})`), assertCurrent, {
      newId: () => 'new', fieldDefinition: () => ({ type: 'field_custom', symbol: { kind: 'variable', storage: 'name' } }),
    }, runtime)).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_DATA_MODEL_PATH' }));
  });

  for (const phase of ['put', 'flushPending', 'prepareValue', 'resolve']) {
    it(`retains the immutable baseline and stops after ${phase} failure`, async () => {
      const baseline = await projection();
      const before = absJson(baseline);
      runtime[phase].and.rejectWith(new Error('failed ' + phase));
      const pending = prepareAbsReconciliation(baseline, source(`text(TEXT=${JSON.stringify(text)})`), assertCurrent, {}, runtime);
      if (phase === 'resolve') await expectAsync((await pending).materialize()).toBeRejectedWithError('failed resolve');
      else await expectAsync(pending).toBeRejectedWithError('failed ' + phase);
      expect(absJson(baseline)).toBe(before);
    });
  }

  it('fails exact-source checks for stale, coerced, missing, duplicate and overlapping bindings', async () => {
    const code = source('text(TEXT="original")');
    const draft = await reconcileAbsDraft(await projection(), code);
    const binding = draft.literals[0];
    const replacement = { jsonPointer: binding.jsonPointer, value: 'new' };
    expect(replaceAbsBoundValues(code, draft.workspace, draft.literals, [replacement])).toBe(source('text(TEXT="new")'));
    expect(() => replaceAbsBoundValues(code.replace('original', 'changed!'), draft.workspace, draft.literals, [replacement])).toThrow();
    expect(() => replaceAbsBoundValues(code, draft.workspace, [], [replacement])).toThrow();
    expect(() => replaceAbsBoundValues(code, draft.workspace, [binding, binding], [replacement])).toThrow();
    expect(() => replaceAbsBoundValues(code, draft.workspace, draft.literals, [replacement, replacement])).toThrow();
    for (const start of [-1, 0.5, NaN]) expect(() => replaceAbsBoundValues(code, draft.workspace, [{ ...binding, start }], [replacement])).toThrow();
    const numberSource = source('text(TEXT=123)');
    const coerced = await reconcileAbsDraft(await projection(), numberSource, { fieldDefinition: () => ({ type: 'field_input' }) });
    expect(() => replaceAbsBoundValues(numberSource, coerced.workspace, coerced.literals, [{ ...replacement, jsonPointer: coerced.literals[0].jsonPointer }])).toThrow();
  });

  it('binds visible shadow literals to their shadow ABI path', async () => {
    const baseline = await projection({ blocks: { blocks: [{ type: 'root', id: 'root', inputs: {
      VALUE: { shadow: { type: 'text', id: 'shadow', fields: { TEXT: 'old' } } },
    } }] } });
    const result = await prepareAbsReconciliation(baseline, baseline.abs.replace('TEXT="old"', `TEXT=${JSON.stringify(text)}`), assertCurrent, {}, runtime);
    expect(result.externalized[0].jsonPointer).toContain('/shadow/fields/TEXT');
    expect((await result.materialize()).blocks.blocks[0].inputs!['VALUE'].shadow!.id).toBe('shadow');
  });

  it('does not replace identical literals or quoted argument names outside the bound target', async () => {
    const code = source('text(TEXT="same", "same"="same") # "same"');
    const draft = await reconcileAbsDraft(await projection(), code);
    const target = draft.literals.find(binding => binding.jsonPointer.endsWith('/fields/same'))!;
    expect(replaceAbsBoundValues(code, draft.workspace, draft.literals, [{ jsonPointer: target.jsonPointer, value: 'changed' }]))
      .toBe(source('text(TEXT="same", "same"="changed") # "same"'));
  });

  it('rejects overlapping parent/child replacement requests without mutating the draft', async () => {
    const code = source('text(TEXT={"nested":{"value":1}})');
    const draft = await reconcileAbsDraft(await projection(), code);
    const pointer = draft.literals[0].jsonPointer;
    const before = absJson(draft);
    expect(() => replaceAbsBoundValues(code, draft.workspace, draft.literals, [
      { jsonPointer: pointer + '/nested/value', value: 2 }, { jsonPointer: pointer + '/nested', value: {} },
    ])).toThrow();
    expect(absJson(draft)).toBe(before);
  });
});
