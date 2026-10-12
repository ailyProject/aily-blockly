import { absJson, createAbsProjection, indexAbsSyntax } from './abs-identity-map';
import { createAbsReconciler, createAbsReconcilerFactory, reconcileAbsDraft } from './abs-reconciler';
import { parseAbsSyntax } from './abs-syntax';
import type { AbsAbiBlock } from './abs-state';
import type { AbsNativeBinding } from './abs-native-binding';
import { createAbsReconcileAnalysis } from './abs-reconcile-analysis';

const source = (text: string) => '# ABS Schema: 2\n' + text;
const project = (blocks: AbsAbiBlock[] = [{ id: 'root', type: 'number', fields: { NUM: 1 }, deletable: false }]) => {
  const workspace = { blocks: { blocks } };
  return createAbsProjection(workspace, { document: workspace, generation: 'analysis', baselineRef: 'analysis',
    savedAbiHash: null, scope: { projectKey: 'project', pageId: 'main' } });
};
function nativeBinding(text: string): AbsNativeBinding {
  const syntax = parseAbsSyntax(text);
  return { source: text, syntax, instances: indexAbsSyntax(syntax).map(({ node }) => ({
    start: node.start, type: node.type, id: 'native-' + node.start, seed: { type: node.type, id: 'native-' + node.start },
    shape: { fields: Object.fromEntries(Object.keys(node.fields).map(name => [name, { type: 'field_number', min: 0, max: 10 }])),
      defaults: {}, inputs: {}, output: false, previous: false, next: false },
  })) };
}

describe('transaction-owned ABS reconciliation analysis', () => {
  it('preserves identities when native serialization changes input property order on a cache hit', async () => {
    const baseline = await project([{ id: 'owner', type: 'owner', inputs: {
      Z: { block: { id: 'number', type: 'number', fields: { NUM: 1 } } },
      A: { block: { id: 'text', type: 'text', fields: { TEXT: 'value' } } },
    } }]);
    const analysis = createAbsReconcileAnalysis(baseline, baseline.abs);
    const syntax = parseAbsSyntax(baseline.abs);
    syntax[0].inputs = Object.fromEntries(Object.entries(syntax[0].inputs).reverse());
    const first = await analysis.match(syntax);
    const reordered = JSON.parse(absJson(syntax));
    expect(indexAbsSyntax(reordered).map(entry => entry.path))
      .not.toEqual(indexAbsSyntax(syntax).map(entry => entry.path));
    const cached = await analysis.match(reordered);
    for (const { path, node } of indexAbsSyntax(reordered)) {
      const original = cached.matches.get(node)!;
      const previous = indexAbsSyntax(syntax).find(entry => entry.path === path)!.node;
      expect(original.type).toBe(node.type);
      expect(cached.originalIds.get(original)).toBe(first.originalIds.get(first.matches.get(previous)!));
    }
  });

  it('reuses an exact baseline across candidates and hashes only changed dependency content', async () => {
    const baseline = await project(), create = createAbsReconcilerFactory();
    const digest = spyOn(crypto.subtle, 'digest').and.callThrough();
    const first = await create(baseline, baseline.abs.replace('NUM=1', 'NUM=2'), 'runtime-a').draft();
    const cold = digest.calls.count(); digest.calls.reset();
    first.workspace.blocks.blocks[0].fields!['NUM'] = 99;
    const second = await create(structuredClone(baseline), baseline.abs.replace('NUM=1', 'NUM=3'), 'runtime-a').draft();
    expect(cold).toBeGreaterThan(1); expect(digest).toHaveBeenCalledTimes(1);
    expect(second.workspace.blocks.blocks[0]).toEqual({ id: 'root', type: 'number', fields: { NUM: 3 }, deletable: false });
    digest.calls.reset();
    const third = await create(baseline, baseline.abs.replace('NUM=1', 'NUM=2'), 'runtime-a').draft();
    expect(digest).not.toHaveBeenCalled(); expect(third.workspace.blocks.blocks[0].fields!['NUM']).toBe(2);
  });

  it('does not carry matching positions or stale provenance across candidate texts', async () => {
    const baseline = await project(), create = createAbsReconcilerFactory();
    const edited = baseline.abs.replace('NUM=1', 'NUM=2');
    await create(baseline, edited, 'runtime').draft();
    const moved = '# comment changes offsets\n' + edited;
    const result = await create(baseline, moved, 'runtime').draft();
    expect(result.identities[0].start).toBe(moved.indexOf('number('));
    expect(result.retained).toEqual(['root']);
    await expectAsync(create(baseline, moved, 'runtime').draft({ sourceEdits: [[{ start: 0, end: 0, text: '# wrong\n' }]] }))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_SOURCE_EDITS_STALE' }));
  });

  it('invalidates all retained analysis on runtime scope changes, even if switching back', async () => {
    const baseline = await project(), edited = baseline.abs.replace('NUM=1', 'NUM=2');
    const create = createAbsReconcilerFactory(), digest = spyOn(crypto.subtle, 'digest').and.callThrough();
    await create(baseline, edited, 'runtime-a').draft();
    const cold = digest.calls.count();
    for (const scope of ['runtime-b', 'runtime-a']) {
      digest.calls.reset(); await create(baseline, edited, scope).draft();
      expect(digest).toHaveBeenCalledTimes(cold);
    }
  });

  it('revalidates complete baseline content instead of trusting generation or map hashes', async () => {
    const baseline = await project(), create = createAbsReconcilerFactory();
    const edited = baseline.abs.replace('NUM=1', 'NUM=2');
    await create(baseline, edited, 'runtime').draft();
    const mutations = [
      value => { value.map.nodes[0].blockId = 'forged'; },
      value => { value.workspace.blocks.blocks[0].deletable = true; },
      value => { value.document.variables = [{ id: 'v', name: 'changed', type: '' }]; },
      value => { value.contracts.fields.root = { NUM: { type: 'field_input' } }; },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(baseline); mutate(changed);
      await expectAsync(create(changed, edited, 'runtime').draft())
        .toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_MAP_INVALID' }));
    }
  });

  it('still invokes current contracts and host adapters across candidates including rejected drafts', async () => {
    const baseline = await project(), create = createAbsReconcilerFactory();
    const edited = baseline.abs.replace('NUM=1', 'NUM=2');
    let max = 10;
    const field = jasmine.createSpy('field').and.callFake(() => ({ type: 'field_number', max }));
    const adapter = jasmine.createSpy('adapter').and.callFake((block: AbsAbiBlock) => { block['data'] = 'fresh-' + max; });
    await create(baseline, edited, 'runtime').draft({ fieldDefinition: field, prepareBlock: adapter });
    max = 1;
    await expectAsync(create(baseline, edited, 'runtime').draft({ fieldDefinition: field, prepareBlock: adapter }))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_FIELD_INVALID' }));
    max = 3;
    const final = await create(baseline, edited, 'runtime').draft({ fieldDefinition: field, prepareBlock: adapter });
    expect(field).toHaveBeenCalledTimes(3); expect(adapter).toHaveBeenCalledTimes(2);
    expect(final.workspace.blocks.blocks[0]['data']).toBe('fresh-3');
  });

  it('retries failed baseline analysis and keeps independent factory instances isolated', async () => {
    const baseline = await project(), edited = baseline.abs.replace('NUM=1', 'NUM=2'), create = createAbsReconcilerFactory();
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    const observed = spyOn(crypto.subtle, 'digest').and.rejectWith(new Error('hash unavailable'));
    await expectAsync(create(baseline, edited, 'runtime').draft()).toBeRejectedWithError('hash unavailable');
    observed.and.callFake(digest); observed.calls.reset();
    await create(baseline, edited, 'runtime').draft(); const cold = observed.calls.count();
    observed.calls.reset();
    await createAbsReconcilerFactory()(baseline, edited, 'runtime').draft();
    expect(observed).toHaveBeenCalledTimes(cold);
  });

  it('validates and matches once, but rebuilds independent drafts and contracts every time', async () => {
    const baseline = await project(), edited = baseline.abs.replace('NUM=1', 'NUM=2');
    const before = absJson(baseline), session = createAbsReconciler(baseline, edited);
    const digest = spyOn(crypto.subtle, 'digest').and.callThrough();
    const prepare = jasmine.createSpy('adapter');
    const first = await session.draft({ prepareBlock: prepare });
    const expected = absJson(first);
    expect(digest.calls.count()).toBeGreaterThan(0); digest.calls.reset();
    first.workspace.blocks.blocks[0].fields!['NUM'] = 999;
    first.contracts.fields['root'] = { NUM: { type: 'field_input' } };
    first.identities.length = 0;
    session.snapshot().workspace.blocks.blocks.length = 0;
    const second = await session.draft({ prepareBlock: prepare });
    expect(absJson(second)).toBe(expected);
    expect(digest).not.toHaveBeenCalled();
    expect(prepare.calls.count()).toBe(2);
    expect(absJson(baseline)).toBe(before);
    expect(Object.isFrozen(session)).toBeTrue();
  });

  it('captures the whole baseline before await and never trusts a newly tampered baseline', async () => {
    const baseline = await project(), edited = baseline.abs.replace('NUM=1', 'NUM=2');
    const session = createAbsReconciler(baseline, edited);
    const pending = session.draft();
    baseline.map.nodes[0].blockId = 'forged';
    baseline.workspace.blocks.blocks[0].fields!['NUM'] = 99;
    expect((await pending).workspace.blocks.blocks[0].id).toBe('root');
    expect((await session.draft()).workspace.blocks.blocks[0].fields!['NUM']).toBe(2);
    await expectAsync(reconcileAbsDraft(baseline, edited)).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_MAP_INVALID' }));
  });

  it('does not reuse successful analysis across different sessions', async () => {
    const baseline = await project(), edited = baseline.abs.replace('NUM=1', 'NUM=2');
    const digest = spyOn(crypto.subtle, 'digest').and.callThrough();
    await createAbsReconciler(baseline, edited).draft();
    const first = digest.calls.count(); digest.calls.reset();
    await createAbsReconciler(baseline, edited).draft();
    expect(first).toBeGreaterThan(0); expect(digest.calls.count()).toBe(first);
  });

  it('rechecks field contracts on cache hits and can retry after a rejected contract', async () => {
    const baseline = await project(), session = createAbsReconciler(baseline, baseline.abs.replace('NUM=1', 'NUM=2'));
    let max = 10;
    const fieldDefinition = jasmine.createSpy('field').and.callFake(() => ({ type: 'field_number', min: 0, max }));
    await session.draft({ fieldDefinition });
    max = 1;
    await expectAsync(session.draft({ fieldDefinition })).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_FIELD_INVALID' }));
    max = 10;
    expect((await session.draft({ fieldDefinition })).workspace.blocks.blocks[0].fields!['NUM']).toBe(2);
    expect(fieldDefinition.calls.count()).toBe(3);
  });

  it('allocates fresh identities per draft and still rejects collisions after a cache hit', async () => {
    const baseline = await project(), session = createAbsReconciler(baseline, baseline.abs + '\nfresh()');
    let count = 0;
    const newId = jasmine.createSpy('allocate').and.callFake(() => 'new-' + ++count);
    expect((await session.draft({ newId })).added).toEqual(['new-1']);
    expect((await session.draft({ newId })).added).toEqual(['new-2']);
    expect(newId.calls.count()).toBe(2);
    await expectAsync(session.draft({ newId: () => 'root' }))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_DUPLICATE_ID' }));
  });

  it('includes exact edit provenance in the key rather than bypassing stale tracked edits', async () => {
    const baseline = await project(), edited = baseline.abs.replace('NUM=1', 'NUM=2');
    const session = createAbsReconciler(baseline, edited);
    await session.draft();
    await expectAsync(session.draft({ sourceEdits: [[{ start: 0, end: 0, text: '# stale\n' }]] }))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_SOURCE_EDITS_STALE' }));
    const tracked = await session.draft({ sourceEdits: [[{ start: 0, end: baseline.abs.length, text: edited }]] });
    expect(tracked.workspace.blocks.blocks[0].id).toBe('root');
  });

  it('rechecks each native instance contract and coverage even for the same bound syntax', async () => {
    const baseline = await project(), edited = baseline.abs.replace('NUM=1', 'NUM=2');
    const session = createAbsReconciler(baseline, edited), binding = nativeBinding(edited);
    await session.draft({ nativeBinding: binding });
    binding.instances[0].shape.fields['NUM'].max = 1;
    await expectAsync(session.draft({ nativeBinding: binding }))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_FIELD_INVALID' }));
    binding.instances.length = 0;
    await expectAsync(session.draft({ nativeBinding: binding }))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_NATIVE_BINDING_INVALID' }));
  });

  it('rematches different bound syntax, rather than keying only on source text', async () => {
    const baseline = await project(), edited = baseline.abs.replace('NUM=1', 'NUM=2');
    const session = createAbsReconciler(baseline, edited), binding = nativeBinding(edited);
    await session.draft({ nativeBinding: binding });
    const digest = spyOn(crypto.subtle, 'digest').and.callThrough();
    binding.syntax[0].fields['NUM'].value = 3;
    const result = await session.draft({ nativeBinding: binding });
    expect(digest.calls.count()).toBeGreaterThan(0);
    expect(result.workspace.blocks.blocks[0].fields!['NUM']).toBe(3);
  });

  it('detaches native model declarations before asynchronous baseline validation', async () => {
    const baseline = await project([]), edited = source('initializer()');
    const binding = nativeBinding(edited);
    binding.modelDeclarations = [{ start: binding.syntax[0].start, blockType: 'initializer', id: 'model', name: 'device', type: 'Driver' }];
    const pending = createAbsReconciler(baseline, edited).draft({ nativeBinding: binding });
    binding.modelDeclarations[0].name = 'changed-after-call';
    expect((await pending).workspace['variables']).toEqual([{ id: 'model', name: 'device', type: 'Driver' }]);
  });

  it('never carries explicit model intents or adapter mutations into a later draft', async () => {
    const baseline = await project(), session = createAbsReconciler(baseline, baseline.abs.replace('NUM=1', 'NUM=2'));
    const previousValues: unknown[] = [];
    const prepareBlock = (_block: AbsAbiBlock, previous?: AbsAbiBlock) => {
      previousValues.push(previous!.fields!['NUM']); previous!.fields!['NUM'] = 99;
    };
    for (const name of ['first', 'second']) {
      const draft = await session.draft({ prepareBlock,
        variableCreation: { requestId: 'analysis-request-' + name, variables: [{ name, type: '' }] } });
      expect((draft.workspace['variables'] as any[]).map(model => model.name)).toEqual([name]);
    }
    expect(previousValues).toEqual([1, 1]);
  });

  it('owns object-valued state returned by pure syntax adapters before hashing', async () => {
    const baseline = await project(), session = createAbsReconciler(baseline, baseline.abs.replace('NUM=1', 'NUM=2'));
    const state = { value: 'captured' };
    const draft = await session.draft({ prepareExtraState: () => {
      queueMicrotask(() => { state.value = 'late mutation'; }); return state;
    } });
    expect(state.value).toBe('late mutation');
    expect(draft.workspace.blocks.blocks[0].extraState).toEqual({ value: 'captured' });
  });
});
