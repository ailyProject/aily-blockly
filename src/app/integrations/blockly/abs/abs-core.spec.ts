import { parseBlockDefinition } from './block-definition.model';
import { readAbsFieldToken, resolveAbsFieldValue } from './abs-field-values';
import { assertAbsBaselineContext, createAbsProjection, hashAbsText, indexAbsSyntax, validateAbsProjection } from './abs-identity-map';
import { assertAbsProtectedBlocks, assertAbsReadback } from './abs-import-policy';
import { reconcileAbs } from './abs-reconciler';
import { parseAbsSyntax } from './abs-syntax';
import { ABS_SCHEMA_HEADER, AbsAbiBlock, AbsAbiWorkspace, AbsSyncError } from './abs-state';

const block = (id: string, fields: Record<string, unknown> = {}): AbsAbiBlock => ({ type: 'delay', id, fields });
const workspace = (...blocks: AbsAbiBlock[]): AbsAbiWorkspace => ({ blocks: { languageVersion: 0, blocks } });
const project = (abi: AbsAbiWorkspace) => createAbsProjection(abi, {
  document: abi, generation: 'g1', baselineRef: 'baseline-1',
  scope: { projectKey: 'project', pageId: 'main' }, savedAbiHash: null,
});
const source = (code: string) => `${ABS_SCHEMA_HEADER}\n${code}`;

describe('ABS v2 pure syntax', () => {
  it('tracks distinct source ranges for inline nodes and escaped JSON', () => {
    const code = source('root(TEXT="# \\\" \\\\ 😀", VALUE=num(NUM=1) @extra:[false,{"x":"(,)"}]) # comment');
    const entries = indexAbsSyntax(parseAbsSyntax(code));
    expect(entries.length).toBe(2);
    expect(code.slice(entries[1].node.start, entries[1].node.end)).toContain('num(NUM=1)');
    expect(entries[1].node.extraState).toEqual([false, { x: '(,)' }]);
  });
  it('distinguishes root next chains, input chains and independent roots', () => {
    const nodes = parseAbsSyntax(source('a()\n    @next:\n        b()\nc()\n    @BODY:\n        d()\n        e()'));
    expect(nodes.length).toBe(2);
    expect(nodes[0].next?.type).toBe('b');
    expect(nodes[1].inputs['BODY']?.next?.type).toBe('e');
  });
  it('accepts CRLF, comments and multiline calls without rewriting source offsets', () => {
    const code = source('root(\r\n TEXT="hello", VALUE=num(NUM=2)\r\n)\r\n# end');
    expect(parseAbsSyntax(code)[0].fields['TEXT'].value).toBe('hello');
  });
  for (const code of ['root(X=1,X=2)', 'root(X={bad})', 'root() junk', 'root() @meta:{}', 'root()\n    @next:', 'root(X="unterminated)']) {
    it(`rejects malformed/unsupported syntax: ${code}`, () => {
      expect(() => parseAbsSyntax(source(code))).toThrow();
    });
  }
  it('rejects unversioned input and top-level indentation', () => {
    expect(() => parseAbsSyntax('root()')).toThrow();
    expect(() => parseAbsSyntax(source('    root()'))).toThrow();
  });
  it('includes empty input sections in the owner source range', () => {
    const text = source('root()\n    @BODY:\nother()');
    const roots = parseAbsSyntax(text);
    expect(text.slice(roots[0].start, roots[0].end)).toContain('@BODY:');
    expect(roots[0].end).toBeLessThanOrEqual(roots[1].start);
  });
});

describe('ABS field contracts', () => {
  const dropdown = { type: 'field_dropdown', options: [['yes', 'true'], ['no', 'false']] as const };
  it('does not use names to interpret booleans, numbers or strings', () => {
    expect(resolveAbsFieldValue(readAbsFieldToken('false'), dropdown)).toBe('false');
    expect(resolveAbsFieldValue(readAbsFieldToken('false'), { type: 'field_checkbox' })).toBe('FALSE');
    expect(resolveAbsFieldValue(readAbsFieldToken('"001"'), { type: 'field_input' })).toBe('001');
    expect(resolveAbsFieldValue(readAbsFieldToken('001'), { type: 'custom', valueType: 'string' })).toBe('001');
    expect(resolveAbsFieldValue(readAbsFieldToken('[false,1]'), { type: 'field_custom' })).toEqual([false, 1]);
  });
  it('retains nested project-data state without the deleted legacy field helper', () => {
    const value = { schemaVersion: 1, frames: { $ailyData: { id: `sha256:${'a'.repeat(64)}` } } };
    const token = readAbsFieldToken(JSON.stringify(value));
    expect(resolveAbsFieldValue(token, { type: 'field_custom', valueType: 'json' })).toBe(token.value);
    expect(token.value).toEqual(value);
  });
  it('rejects invalid and ambiguous dropdown coercions', () => {
    expect(() => resolveAbsFieldValue(readAbsFieldToken('"FALSE"'), dropdown)).toThrow();
    expect(() => resolveAbsFieldValue(readAbsFieldToken('false'), {
      type: 'field_dropdown', options: [['lower', 'false'], ['upper', 'FALSE']],
    })).toThrow();
  });

  it('accepts exact numeric dropdown lexemes without approximating other enum keys', () => {
    const pins = { type: 'field_dropdown', options: [['pin', '18'], ['padded', '018']] as const };
    expect(resolveAbsFieldValue(readAbsFieldToken('18'), pins)).toBe('18');
    expect(resolveAbsFieldValue(readAbsFieldToken('"18"'), pins)).toBe('18');
    for (const source of ['18.0', '1.8e1', '19']) expect(() => resolveAbsFieldValue(readAbsFieldToken(source), pins)).toThrow();
  });
  it('rejects lossy number coercions', () => {
    for (const text of ['1e999', 'null', 'false', '1.5', '11']) {
      expect(() => resolveAbsFieldValue(readAbsFieldToken(text), { type: 'field_number', min: 0, max: 10, precision: 1 })).toThrow();
    }
  });
  it('discovers arbitrary field types and every args group through one metadata parser', () => {
    const meta = parseBlockDefinition({
      type: 'unfamiliar_root', args0: [{ type: 'field_new_library_type', name: 'mixedCase' }],
      args12: [{ type: 'field_dropdown', name: 'MODE', options: [['no', 'false']] }],
    }, 'read-only-library')!;
    expect(meta.isRootBlock).toBeTrue();
    expect(meta.fieldNames).toEqual(['mixedCase', 'MODE']);
    expect(meta.fieldDefinitions?.get('MODE')?.options).toEqual([['no', 'false']]);
  });
});

describe('ABS identity projection and baseline merge', () => {
  it('retains all metadata without inline meta, including disabled nodes and hidden shadows', async () => {
    const abi = workspace({
      type: 'root', id: 'root-id', x: 30, y: 60, deletable: false, movable: false,
      editable: false, collapsed: true, inline: false, data: 'opaque', icons: { comment: { text: 'note' } },
      disabledReasons: ['user'], extraState: { ids: ['x::PARAM'], value: false },
      inputs: { VALUE: { block: block('real', { NUM: 1 }), shadow: block('shadow', { NUM: 0 }) } },
      next: { block: block('tail') },
    });
    abi['customSerializer'] = { state: ['unreferenced'] };
    const projection = await project(abi);
    expect(projection.abs).not.toContain('@meta');
    expect(projection.abs).not.toContain('root-id');
    expect(projection.abs).toContain('@disabled');
    expect(projection.map.nodes.length).toBe(3);
    expect((await reconcileAbs(projection, projection.abs)).workspace).toEqual(abi);
  });
  it('inherits identity/protection and opaque state when changing a field', async () => {
    const abi = workspace({ ...block('protected', { VALUE: 'old' }), deletable: false, x: 12, data: 'keep' });
    const baseline = await project(abi);
    const result = await reconcileAbs(baseline, baseline.abs.replace('"old"', '"new"'));
    expect(result.workspace.blocks.blocks[0]).toEqual({ ...abi.blocks.blocks[0], fields: { VALUE: 'new' } });
    expect(abi.blocks.blocks[0].fields!['VALUE']).toBe('old');
    expect(result.retained).toEqual(['protected']);
  });
  it('can re-export and merge the prepared ABI repeatedly without changing JSON contracts', async () => {
    let abi = workspace({ type: 'parent', id: 'p', inputs: { VALUE: { block: block('v', { X: 1 }) } } });
    for (let value = 2; value < 5; value++) {
      const baseline = await project(abi);
      abi = (await reconcileAbs(baseline, baseline.abs.replace(`X=${value - 1}`, `X=${value}`))).workspace;
      expect(abi.blocks.blocks[0].inputs!['VALUE'].block!.id).toBe('v');
      expect(() => assertAbsReadback(abi, JSON.parse(JSON.stringify(abi)))).not.toThrow();
    }
  });
  it('preserves JSON keys such as __proto__ as data, not prototype setters', async () => {
    const data = JSON.parse('{"__proto__":{"kept":true},"name":"payload"}');
    const baseline = await project(workspace(block('a', { DATA: data, X: 1 })));
    const abi = (await reconcileAbs(baseline, baseline.abs.replace('X=1', 'X=2'))).workspace;
    expect(abi.blocks.blocks[0].fields!['DATA']).toEqual(data);
    expect(JSON.stringify(abi)).toContain('__proto__');
    expect(({} as Record<string, unknown>)['kept']).toBeUndefined();
  });
  it('does not strip array/boolean extraState or keys that look like IDs', async () => {
    const baseline = await project(workspace({ ...block('a', { X: 1 }), extraState: [false, 'a::ID'] }));
    const result = await reconcileAbs(baseline, baseline.abs.replace('X=1', 'X=2'));
    expect(result.workspace.blocks.blocks[0].extraState).toEqual([false, 'a::ID']);
  });
  it('rejects deletion of a protected descendant before returning a candidate', async () => {
    const baseline = await project(workspace({ type: 'parent', id: 'p', inputs: { VALUE: { block: { ...block('child'), deletable: false } } } }));
    await expectAsync(reconcileAbs(baseline, source(''))).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_PROTECTED_BLOCK_MISSING' }));
  });
  it('allows ordinary statements under a protected container to be removed', async () => {
    const baseline = await project(workspace({ type: 'parent', id: 'p', deletable: false, inputs: { BODY: { block: block('child') } } }));
    const result = await reconcileAbs(baseline, source('parent()'));
    expect(result.removed).toEqual(['child']);
    expect(result.workspace.blocks.blocks[0]['deletable']).toBeFalse();
  });
  it('rejects ambiguous repeated blocks even if only one is protected', async () => {
    const baseline = await project(workspace({ ...block('a', { NUM: 1 }), deletable: false }, block('b', { NUM: 1 })));
    await expectAsync(reconcileAbs(baseline, source('delay(NUM=1)'))).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_IDENTITY_AMBIGUOUS' }));
  });
  it('does not assign hidden state by list position after ambiguous edits', async () => {
    const baseline = await project(workspace({ ...block('a'), data: 'a' }, { ...block('b'), data: 'b' }));
    await expectAsync(reconcileAbs(baseline, source('delay(X=2)'))).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_IDENTITY_AMBIGUOUS' }));
  });
  it('keeps identity through uniquely identifiable root reordering', async () => {
    const baseline = await project(workspace(block('a', { X: 1 }), block('b', { X: 2 })));
    const result = await reconcileAbs(baseline, source('delay(X=2)\ndelay(X=1)'));
    expect(result.workspace.blocks.blocks.map(value => value.id)).toEqual(['b', 'a']);
  });
  it('allocates new identities only once and rejects collisions', async () => {
    const baseline = await project(workspace(block('a')));
    const allocate = jasmine.createSpy('newId').and.returnValue('new');
    const result = await reconcileAbs(baseline, source('delay()\nfresh()'), { newId: allocate });
    expect(result.added).toEqual(['new']);
    expect(allocate).toHaveBeenCalledTimes(1);
    await expectAsync(reconcileAbs(baseline, source('delay()\nfresh()'), { newId: () => 'a' })).toBeRejected();
  });
  it('preserves fallback shadow when the real value block is removed', async () => {
    const baseline = await project(workspace({ type: 'parent', id: 'p', inputs: { VALUE: { block: block('real', { X: 1 }), shadow: block('fallback', { X: 0 }) } } }));
    const result = await reconcileAbs(baseline, source('parent()'));
    expect(result.workspace.blocks.blocks[0].inputs!['VALUE']).toEqual({ shadow: block('fallback', { X: 0 }) });
  });
  it('rejects attempts to enable a node by dropping @disabled', async () => {
    const baseline = await project(workspace({ ...block('a'), disabledReasons: ['user'] }));
    await expectAsync(reconcileAbs(baseline, source('delay()'))).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_STATE_EDIT_REQUIRES_HOST' }));
  });
  it('validates the map against original content rather than trusting its block IDs', async () => {
    const baseline = await project(workspace(block('a'), { type: 'second', id: 'b' }));
    baseline.map.nodes[0].blockId = 'b';
    await expectAsync(validateAbsProjection(baseline)).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_MAP_INVALID' }));
  });
  it('includes immutable full-project context in its hash without losing other pages', async () => {
    const abi = workspace(block('a'));
    const document = { pages: [{ id: 'other', content: workspace(block('other')) }] };
    const baseline = await createAbsProjection(abi, { document, generation: 'g', baselineRef: 'r', savedAbiHash: null, scope: { projectKey: 'p', pageId: 'main' } });
    document.pages[0].id = 'changed';
    await expectAsync(validateAbsProjection(baseline)).toBeResolved();
    expect(baseline.document).not.toEqual(document);
    expect(baseline.map.pageAbiHash).not.toBe(baseline.map.baseAbiHash);
  });
  it('rejects oversized inline data and duplicate IDs, including hidden shadows', async () => {
    await expectAsync(project(workspace(block('a', { TEXT: 'x'.repeat(40 * 1024) })))).toBeRejected();
    await expectAsync(project(workspace({ type: 'root', id: 'a', inputs: { X: { shadow: block('a') } } }))).toBeRejected();
  });
  it('hashes exact UTF-8 content, including line endings', async () => {
    expect(await hashAbsText('abc')).toBe('sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(await hashAbsText('a\nb')).not.toBe(await hashAbsText('a\r\nb'));
  });
  it('does not attach identities to duplicate roots by position when their children differ', async () => {
    const baseline = await project(workspace(
      { type: 'parent', id: 'a', data: 'a', inputs: { VALUE: { block: block('va', { X: 1 }) } } },
      { type: 'parent', id: 'b', data: 'b', inputs: { VALUE: { block: block('vb', { X: 2 }) } } },
    ));
    const result = await reconcileAbs(baseline, source('parent(VALUE=delay(X=2))\nparent(VALUE=delay(X=1))'));
    expect(result.workspace.blocks.blocks.map(value => [value.id, value['data']])).toEqual([['b', 'b'], ['a', 'a']]);
  });
  it('preserves metadata through comment-only edits and repeated nodes in unchanged owner groups', async () => {
    const abi = workspace({ type: 'parent', id: 'p', data: 'keep', inputs: {
      BODY: { block: { ...block('a'), next: { block: { ...block('b'), deletable: false } } } }, EMPTY: {},
    } });
    const baseline = await project(abi);
    expect((await reconcileAbs(baseline, baseline.abs + '\n# note\n')).workspace).toEqual(abi);
  });
  it('rejects stale host context independently of map self-consistency', async () => {
    const baseline = await project(workspace(block('a')));
    const context = {
      generation: baseline.map.generation, scope: baseline.map.scope,
      currentAbiHash: baseline.map.baseAbiHash, currentPageAbiHash: baseline.map.pageAbiHash, savedAbiHash: null,
    };
    expect(() => assertAbsBaselineContext(baseline.map, context)).not.toThrow();
    expect(() => assertAbsBaselineContext(baseline.map, { ...context, generation: 'old' })).toThrowError(AbsSyncError);
    expect(() => assertAbsBaselineContext(baseline.map, { ...context, savedAbiHash: 'external-save' })).toThrowError(AbsSyncError);
    expect(() => assertAbsBaselineContext(baseline.map, { ...context, scope: { projectKey: 'other', pageId: 'main' } })).toThrowError(AbsSyncError);
  });
});

describe('ABS apply policies', () => {
  it('guards unlock and type replacement independently of the parser', () => {
    const abi = workspace({ ...block('a'), deletable: false });
    expect(() => assertAbsProtectedBlocks(abi, workspace(block('a')))).toThrowError(AbsSyncError);
    expect(() => assertAbsProtectedBlocks(abi, workspace({ type: 'other', id: 'a', deletable: false }))).toThrowError(AbsSyncError);
  });
  it('detects real field fallback/object coercion while ignoring JSON key order', () => {
    expect(() => assertAbsReadback(workspace(block('a', { MODE: 'false' })), workspace(block('a', { MODE: 'true' })))).toThrow();
    expect(() => assertAbsReadback(workspace(block('a', { A: 1, B: 2 })), workspace(block('a', { B: 2, A: 1 })))).not.toThrow();
  });
});
