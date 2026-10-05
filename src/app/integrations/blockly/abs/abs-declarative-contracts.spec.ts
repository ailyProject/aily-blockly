import * as Blockly from 'blockly';
import { BlocklyDeclarativeBlockCatalog } from '../../../editors/blockly-editor/services/blockly-declarative-block-catalog';
import { captureAbsDeclarativeContracts, compileAbsDeclarativeContract } from './abs-declarative-contracts';
import { createAbsProjection } from './abs-identity-map';
import { reconcileAbsDraft } from './abs-reconciler';
import { assertAbsRuntimeShapeSupported } from './abs-workspace-state';

describe('declaration-backed prepared ABS shapes', () => {
  const definition = () => ({ type: 'abs_decl', message0: '%1 %2 %3 %4 %5', args0: [
    { type: 'field_input', name: 'TEXT', text: 'initial' },
    { type: 'field_number', name: 'NUM', value: 2, min: 0, max: 10, precision: 0.5 },
    { type: 'field_checkbox', name: 'CHECK', checked: true },
    { type: 'field_dropdown', name: 'MODE', options: [['A', 'a'], ['B', 'b']] },
    { type: 'input_value', name: 'VALUE' },
  ], output: 'String' });
  const empty = { blocks: { blocks: [] } };
  for (const change of ['init', 'source', 'prototype', 'reset'])
  it(`rejects ${change} changes before a batched synchronous read can escape`, () => {
    const catalog = new BlocklyDeclarativeBlockCatalog(), source = definition();
    const entry = { init() {} }, registry = { abs_decl: entry };
    catalog.record(source, entry); const snapshot = catalog.capture(registry);
    expect(() => snapshot.withSynchronousRead!(() => {
      snapshot.get('abs_decl');
      if (change === 'init') entry.init = () => {};
      if (change === 'source') source.message0 = 'changed';
      if (change === 'prototype') Object.setPrototypeOf(entry, {});
      if (change === 'reset') catalog.clear();
      return 'must not escape';
    })).toThrowError(/definitions changed/);
  });
  it('does not extend a synchronous declaration read over an async boundary', () => {
    const snapshot = new BlocklyDeclarativeBlockCatalog().capture({});
    expect(() => snapshot.withSynchronousRead!(() => Promise.resolve())).toThrowError(/must be synchronous/);
    expect(() => snapshot.assertCurrent()).not.toThrow();
  });
  const baseline = () => createAbsProjection(empty, { document: empty, generation: 'base', baselineRef: 'baselines/base.json',
    savedAbiHash: null, scope: { projectKey: 'p', pageId: 'main' } });

  it('checks declaration integrity at traversal boundaries instead of rescanning every used type for every block', async () => {
    const catalog = new BlocklyDeclarativeBlockCatalog(), registry = {}, sources = new Set<object>();
    for (let i = 0; i < 40; i++) {
      const source = { type: `perf_${i}`, message0: '%1', args0: [{ type: 'field_number', name: 'NUM', value: 0 }] };
      sources.add(source); registry[source.type] = { init() {} }; catalog.record(source, registry[source.type]);
    }
    const snapshot = catalog.capture(registry), shapes = captureAbsDeclarativeContracts(snapshot);
    const projection = await baseline();
    const stringify = spyOn(JSON, 'stringify').and.callThrough();
    const result = await reconcileAbsDraft(projection,
      '# ABS Schema: 2\n' + Array.from({ length: 400 }, (_, i) => `perf_${i % 40}(NUM=${i})`).join('\n'),
      { blockContract: shapes.get, withSynchronousRead: snapshot.withSynchronousRead });
    expect(result.added.length).toBe(400);
    expect(result.workspace.blocks.blocks[399].fields!['NUM']).toBe(399);
    // Count actual source serialization, not elapsed time or copied guard logic.
    expect(stringify.calls.allArgs().filter(args => sources.has(args[0])).length).toBeLessThan(2400);
  });

  it('rejects declarations changed by a preparation callback before the reconciled tree escapes', async () => {
    const catalog = new BlocklyDeclarativeBlockCatalog(), source = definition();
    const entry = { init() {} }, registry = { abs_decl: entry };
    catalog.record(source, entry);
    const snapshot = catalog.capture(registry), shapes = captureAbsDeclarativeContracts(snapshot);
    await expectAsync(reconcileAbsDraft(await baseline(), '# ABS Schema: 2\nabs_decl(NUM=3)', {
      blockContract: shapes.get, withSynchronousRead: snapshot.withSynchronousRead,
      prepareBlock: () => { source.message0 = 'changed during traversal'; },
    })).toBeRejectedWithError(/definitions changed/);
  });

  it('compiles fields, exact serialized defaults and connection kinds without constructing blocks', () => {
    const probe = spyOn(Blockly.Workspace.prototype, 'newBlock').and.callThrough();
    const shape = compileAbsDeclarativeContract(definition())!;
    expect(shape.defaults).toEqual({ TEXT: 'initial', NUM: 2, CHECK: true, MODE: 'a' });
    expect(shape.fields['NUM']).toEqual({ type: 'field_number', min: 0, max: 10, precision: 0.5 });
    expect(shape.inputs).toEqual({ VALUE: 'value' }); expect(shape.output).toBeTrue(); expect(probe).not.toHaveBeenCalled();
  });

  it('rejects executable/dynamic or unsupported definitions, not just known library names', () => {
    for (const extra of [{ extensions: ['any_extension'] }, { mutator: 'any_mutator' }, { extensions: {} }, { data: 'opaque' }]) {
      expect(compileAbsDeclarativeContract({ ...definition(), ...extra })).toBeUndefined();
    }
    for (const arg of [{ type: 'field_custom', name: 'DATA' }, { type: 'field_input', name: 'T', text: '%{BKY_UNRESOLVED}' },
      { type: 'field_number', name: 'N', min: 1, value: 0 }, { type: 'field_dropdown', name: 'D', options: () => [] }]) {
      expect(compileAbsDeclarativeContract({ type: 'anything', args0: [arg] })).toBeUndefined();
    }
  });

  it('requires explicit variable references and retains the allowed type contract', () => {
    const shape = compileAbsDeclarativeContract({ type: 'variable', args0: [{ type: 'field_variable', name: 'V', variableTypes: ['Number'] }] })!;
    expect(shape.defaults).toEqual({});
    expect(shape.fields['V'].symbol).toEqual({ kind: 'variable', storage: 'variable-state', allowedTypes: ['Number'] });
  });

  for (const extension of ['contextMenu_variableSetterGetter', 'parent_tooltip_when_inline']) it(`accepts only the bundled ${extension} identity, including arbitrary library block names`, () => {
    const catalog = new BlocklyDeclarativeBlockCatalog();
    const source = { type: 'any_library_get', args0: [{ type: 'field_variable', name: 'VAR' }], extensions: [extension] };
    const entry = { init() {} }, registry = { any_library_get: entry };
    catalog.record(source, entry);
    expect(compileAbsDeclarativeContract(source)).toBeUndefined();
    const snapshot = captureAbsDeclarativeContracts(catalog.capture(registry));
    expect(snapshot.get(source.type)).toBeDefined();
    const extensions = (Blockly.Extensions as any).TEST_ONLY.allExtensions;
    const original = extensions[extension];
    try {
      extensions[extension] = () => {};
      expect(() => snapshot.assertCurrent()).toThrow();
      expect(captureAbsDeclarativeContracts(catalog.capture(registry)).get(source.type)).toBeUndefined();
    } finally { extensions[extension] = original; }
  });

  it('merges exact prepared defaults while normalizing explicitly supplied fields', async () => {
    const blockContract = () => compileAbsDeclarativeContract(definition());
    const result = await reconcileAbsDraft(await baseline(), '# ABS Schema: 2\nabs_decl(NUM=2.5, CHECK=false)', { blockContract, newId: () => 'new' });
    expect(result.workspace.blocks.blocks[0].fields).toEqual({ TEXT: 'initial', NUM: 2.5, CHECK: false, MODE: 'a' });
    expect(result.contracts.fields['new']['MODE'].options).toEqual([[null, 'a'], [null, 'b']]);
    expect(() => assertAbsRuntimeShapeSupported(empty, result.workspace, result.contracts, blockContract)).not.toThrow();
  });

  it('rejects missing model fields, unknown inputs and impossible prepared connections', () => {
    const shapes = {
      parent: compileAbsDeclarativeContract({ type: 'parent', args0: [{ type: 'input_value', name: 'VALUE' }] }),
      statement: compileAbsDeclarativeContract({ type: 'statement', previousStatement: null }),
      variable: compileAbsDeclarativeContract({ type: 'variable', args0: [{ type: 'field_variable', name: 'V' }] }),
    };
    const get = type => shapes[type];
    for (const block of [
      { type: 'variable', id: 'v' },
      { type: 'parent', id: 'p', inputs: { UNKNOWN: { block: { type: 'statement', id: 's' } } } },
      { type: 'parent', id: 'p', inputs: { VALUE: { block: { type: 'statement', id: 's' } } } },
    ]) expect(() => assertAbsRuntimeShapeSupported(empty, { blocks: { blocks: [block] } }, { fields: {} }, get)).toThrow();
  });

  it('does not transfer a declaration to an overridden registration and returns detached JSON', () => {
    const catalog = new BlocklyDeclarativeBlockCatalog(), source = definition(), entry = { init() {} }, registry = { abs_decl: entry };
    catalog.record(source, entry);
    const first = catalog.capture(registry), copy = first.get('abs_decl')!;
    copy['args0'][0].text = 'changed copy'; expect(first.get('abs_decl')!['args0'][0].text).toBe('initial');
    registry.abs_decl = { init() {} }; expect(() => first.assertCurrent()).toThrow();
    expect(catalog.capture(registry).get('abs_decl')).toBeUndefined();
  });

  for (const change of ['init', 'source', 'prototype', 'reset', 'reload']) it(`invalidates captured provenance after ${change}`, () => {
    const catalog = new BlocklyDeclarativeBlockCatalog(), source = definition(), entry = { init() {} }, registry = { abs_decl: entry };
    catalog.record(source, entry);
    const snapshot = captureAbsDeclarativeContracts(catalog.capture(registry)); expect(snapshot.get('abs_decl')).toBeDefined();
    if (change === 'init') entry.init = () => {};
    else if (change === 'source') source.args0[0]['text'] = 'late';
    else if (change === 'prototype') Object.setPrototypeOf(entry, {});
    else if (change === 'reset') catalog.clear();
    else catalog.record(definition(), entry);
    expect(() => snapshot.get('abs_decl')).toThrow();
  });
});
