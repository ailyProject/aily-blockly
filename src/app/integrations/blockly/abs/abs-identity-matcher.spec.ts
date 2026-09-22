import { createAbsProjection, indexAbsAbi } from './abs-identity-map';
import { reconcileAbs } from './abs-reconciler';
import type { AbsAbiBlock, AbsAbiWorkspace } from './abs-state';

describe('ABS structure edits preserve identity independently of placement', () => {
  const project = (blocks: AbsAbiBlock[]) => {
    const workspace: AbsAbiWorkspace = { blocks: { blocks } };
    return createAbsProjection(workspace, { document: workspace, generation: 'structure', baselineRef: 'structure',
      scope: { projectKey: 'test', pageId: 'main' }, savedAbiHash: null });
  };
  const num = (id: string, value = 0): AbsAbiBlock => ({ type: 'math_number', id, fields: { NUM: value } });
  const source = (text: string) => '# ABS Schema: 2\n' + text;
  const baseline = () => project([
    { type: 'arduino_global', id: 'global', deletable: false },
    { type: 'arduino_loop', id: 'loop', deletable: false, inputs: { BODY: { block: {
      type: 'sample', id: 'sample', data: 'retained metadata', deletable: false,
      inputs: { VALUE: { block: num('sample-zero'), shadow: { ...num('dormant', 9), data: 'fallback' } } }, next: { block: {
        type: 'draw', id: 'draw', inputs: { X: { block: num('draw-zero') } },
        next: { block: { type: 'time_delay', id: 'delay', inputs: { VALUE: { block: num('interval', 2000) } } } },
      } },
    } } } },
  ]);
  const wrapped = source(`arduino_global()
    @BODY:
        variable_define(NAME="lastUpdate", VALUE=math_number(NUM=0))
arduino_loop()
    @BODY:
        controls_if(IF0=math_number(NUM=2000))
            @DO0:
                sample(VALUE=math_number(NUM=0))
                draw(X=math_number(NUM=0))`);

  it('wraps the existing body, adds a same-type zero and replaces delay without per-block edits', async () => {
    const base = await baseline();
    const result = await reconcileAbs(base, wrapped);
    const blocks = indexAbsAbi(result.workspace);
    expect(result.removed).toEqual(['delay']);
    expect(result.retained).toEqual(jasmine.arrayContaining(['global', 'loop', 'sample', 'sample-zero', 'draw', 'draw-zero', 'interval']));
    expect(blocks.get('sample')!['data']).toBe('retained metadata');
    expect(blocks.get('sample')!['deletable']).toBeFalse();
    expect(blocks.get('sample')!.inputs!['VALUE'].shadow!.id).toBe('dormant');
    expect(blocks.get('dormant')!['data']).toBe('fallback');
    const declaration = [...blocks.values()].find(block => block.type === 'variable_define')!;
    expect(result.added).toContain(declaration.inputs!['VALUE'].block!.id);
    expect(base.workspace.blocks.blocks[1].inputs!['BODY'].block!.id).toBe('sample');
  });

  it('unwraps an ordered repeated sequence without swapping hidden metadata', async () => {
    const base = await project([{ type: 'root', id: 'root', inputs: { BODY: { block: { type: 'wrapper', id: 'wrapper', inputs: {
      BODY: { block: { type: 'step', id: 'a', data: 'first', next: { block: { type: 'step', id: 'b', data: 'second' } } } },
    } } } } }]);
    const result = await reconcileAbs(base, source('root()\n    @BODY:\n        step()\n        step()'));
    expect(result.removed).toEqual(['wrapper']);
    const blocks = indexAbsAbi(result.workspace);
    expect(blocks.get('root')!.inputs!['BODY'].block!.id).toBe('a');
    expect(blocks.get('a')!.next!.block.id).toBe('b');
    expect(blocks.get('a')!['data']).toBe('first');
    expect(blocks.get('b')!['data']).toBe('second');
  });

  it('does not confuse an unrelated removed number with a new number under a new parent', async () => {
    const base = await project([{ type: 'old', id: 'old', inputs: { X: { block: num('deleted', 2000) } } }]);
    const result = await reconcileAbs(base, source('new(VALUE=math_number(NUM=0))'));
    expect(result.removed).toEqual(['old', 'deleted']);
    expect(result.retained).toEqual([]);
    expect(result.added.length).toBe(2);
  });

  for (const tracking of [false, true]) it(`rebuilds repeated ordinary nested calls atomically with tracking=${tracking}`, async () => {
    const base = await project([{ type: 'root', id: 'root', deletable: false, inputs: { BODY: { block: {
      type: 'draw', id: 'a', inputs: { X: { block: num('x1', 1) } }, next: { block: {
        type: 'draw', id: 'b', inputs: { X: { block: num('x2', 2) } },
      } },
    } } } }]);
    const edited = source('root()\n    @BODY:\n        draw(X=math_number(NUM=3))\n        draw(X=math_number(NUM=4))\n        draw(X=math_number(NUM=5))');
    const result = await reconcileAbs(base, edited, { ...(tracking ? {
      sourceEdits: [[{ start: 0, end: base.abs.length, text: edited }]],
    } : {}) });
    const blocks = indexAbsAbi(result.workspace);
    expect(result.retained).toContain('root'); expect(result.removed).toEqual(['a', 'x1', 'b', 'x2']);
    expect([...blocks.values()].filter(block => block.type === 'draw').length).toBe(3);
    expect([...blocks.values()].filter(block => block.type === 'math_number').map(block => block.fields!['NUM'])).toEqual([3, 4, 5]);
    expect(blocks.get('root')!['deletable']).toBeFalse();
  });

  for (const state of [
    { data: 'opaque' }, { icons: { comment: { text: 'keep' } } }, { editable: false },
    { customFutureState: { value: 1 } }, { inputs: { X: { block: num('visible'), shadow: num('fallback', 9) } } },
  ]) it('does not rebuild ambiguous non-reconstructible state: ' + Object.keys(state)[0], async () => {
    const base = await project([{ type: 'step', id: 'a', ...state }, { type: 'step', id: 'b' }]);
    await expectAsync(reconcileAbs(base, source('step(VALUE=1)\nstep(VALUE=2)\nstep(VALUE=3)')))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_IDENTITY_AMBIGUOUS' }));
  });

  it('checks hidden descendants even when their owner cannot be matched', async () => {
    const base = await project([{ type: 'step', id: 'a', inputs: { X: { block: { ...num('hidden', 1), data: 'keep' } } } },
      { type: 'step', id: 'b', inputs: { X: { block: num('plain', 2) } } }]);
    await expectAsync(reconcileAbs(base, source('step(X=math_number(NUM=3))\nstep(X=math_number(NUM=4))')))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_IDENTITY_AMBIGUOUS' }));
  });

  it('protects block identities referenced by an unknown serializer outside the block graph', async () => {
    const workspace: AbsAbiWorkspace = { blocks: { blocks: [num('referenced', 1), num('other', 2)] },
      extension: { selectedBlock: 'referenced' } };
    const base = await createAbsProjection(workspace, { document: workspace, generation: 'reference', baselineRef: 'reference',
      scope: { projectKey: 'test', pageId: 'main' }, savedAbiHash: null });
    await expectAsync(reconcileAbs(base, source('math_number(NUM=3)\nmath_number(NUM=4)')))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_IDENTITY_AMBIGUOUS' }));
    await expectAsync(reconcileAbs(base, source('')))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_REFERENCED_BLOCK_MISSING' }));
  });

  it('keeps an edited child with its proven owner instead of stealing it for a new identical value', async () => {
    const base = await project([{ type: 'root', id: 'root', inputs: { X: { block: { ...num('owned'), data: 'owned metadata' } } } }]);
    const result = await reconcileAbs(base, source('root(X=math_number(NUM=1))\nother(X=math_number(NUM=0))'));
    const blocks = indexAbsAbi(result.workspace);
    expect(blocks.get('root')!.inputs!['X'].block!.id).toBe('owned');
    expect(blocks.get('owned')!.fields!['NUM']).toBe(1);
    expect(result.added.length).toBe(2);
  });

  it('rejects indistinguishable moves instead of transferring protected identity arbitrarily', async () => {
    const base = await project([
      { type: 'left', id: 'left', inputs: { X: { block: { ...num('a'), data: 'a' } } } },
      { type: 'right', id: 'right', inputs: { X: { block: { ...num('b'), data: 'b', deletable: false } } } },
    ]);
    await expectAsync(reconcileAbs(base, source('other(X=math_number(NUM=0))'))).toBeRejectedWith(jasmine.objectContaining({
      code: 'ABS_IDENTITY_AMBIGUOUS', diagnostic: jasmine.objectContaining({ reason: 'indistinguishable-relocation', blockType: 'math_number' }),
    }));
  });

  it('still refuses protected deletion and disabled-state changes during reparenting', async () => {
    const base = await baseline();
    await expectAsync(reconcileAbs(base, source('arduino_global()\narduino_loop()')))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_PROTECTED_BLOCK_MISSING' }));
    const disabled = await project([{ type: 'step', id: 'step', disabled: true }]);
    const start = disabled.abs.indexOf('step');
    const after = source('wrapper()\n    @BODY:\n        step()');
    // Keeping the call token cannot grant permission to remove its disabled flag.
    const edits = [[{ start: 0, end: start, text: after.slice(0, after.indexOf('step')) },
      { start: start + 'step()'.length, end: disabled.abs.length, text: '' }]];
    await expectAsync(reconcileAbs(disabled, after, { sourceEdits: edits }))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_STATE_EDIT_REQUIRES_HOST' }));
  });
});
