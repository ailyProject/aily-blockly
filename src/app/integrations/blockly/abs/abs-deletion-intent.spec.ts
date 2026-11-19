import { assertAbsDeletionIntent } from './abs-deletion-intent';
import { createAbsProjection, hashAbsText } from './abs-identity-map';
import { reconcileAbsDraft } from './abs-reconciler';
import { parseAbsSyntax } from './abs-syntax';

describe('explicit deletion evidence for bound ABS candidates', () => {
  async function fixture() {
    const workspace = { blocks: { blocks: [{ id: 'setup', type: 'setup', deletable: false, inputs: {
      BODY: { block: { id: 'keep', type: 'keep', next: { block: { id: 'omitted', type: 'tail' } } } },
    } }, { id: 'other', type: 'other', fields: { VALUE: 1 } }] } };
    return createAbsProjection(workspace, { document: workspace, generation: 'original', baselineRef: 'original',
      savedAbiHash: await hashAbsText(JSON.stringify(workspace)), scope: { projectKey: 'project', pageId: 'main' } });
  }
  const removeCall = (source: string, type: string) => {
    const call = source.indexOf(type + '('), end = source.indexOf(')', call) + 1;
    const continuation = source.slice(0, call).match(/\n[ \t]*@next:[ \t]*\n[ \t]*$/);
    const start = continuation ? call - continuation[0].length : call;
    return { source: source.slice(0, start) + source.slice(end), edit: { start, end, text: '' } };
  };

  it('reproduces a structurally valid partial replacement and rejects it when external deletion evidence is required', async () => {
    const base = await fixture(), omitted = removeCall(base.abs, 'tail');
    const before = JSON.stringify(base);
    const legacy = await reconcileAbsDraft(base, omitted.source);
    expect(legacy.removed).toContain('omitted');
    await expectAsync(reconcileAbsDraft(base, omitted.source, { requireDeletionEvidence: true }))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_DELETION_INTENT_REQUIRED', blockIds: ['omitted'] }));
    expect(JSON.stringify(base)).toBe(before);
  });

  it('accepts the same intentional deletion through exact tracked source edits', async () => {
    const base = await fixture(), deletion = removeCall(base.abs, 'tail');
    const result = await reconcileAbsDraft(base, deletion.source,
      { requireDeletionEvidence: true, sourceEdits: [[deletion.edit]] });
    expect(result.removed).toEqual(['omitted']); expect(result.retained).toContain('keep');
    expect(result.retained).toContain('other');
  });

  it('does not authorize omitted calls merely because an unrelated or forged edit array is present', async () => {
    const base = await fixture(), deletion = removeCall(base.abs, 'tail');
    expect(() => assertAbsDeletionIntent(base, deletion.source, ['omitted'], [[{ start: 0, end: 0, text: '# unrelated\n' }]]))
      .toThrowMatching(error => error.code === 'ABS_SOURCE_EDITS_STALE');
    expect(() => assertAbsDeletionIntent(base, deletion.source, ['omitted'], []))
      .toThrowMatching(error => error.code === 'ABS_SOURCE_EDITS_INVALID');
  });

  it('does not block additions or retained field edits without deletions, and does not treat implicit defaults as program intent', async () => {
    const base = await fixture();
    const added = await reconcileAbsDraft(base, base.abs + '\nnew_call()\n', { requireDeletionEvidence: true });
    expect(added.removed).toEqual([]); expect(added.added.length).toBe(1);
    const edited = await reconcileAbsDraft(base, base.abs.replace('VALUE=1', 'VALUE=2'), {
      requireDeletionEvidence: true, fieldDefinition: () => ({ type: 'field_number' }),
    });
    expect(edited.removed).toEqual([]); expect(edited.retained).toContain('other');
    expect(() => assertAbsDeletionIntent(base, base.abs, ['implicit-shadow-default'])).not.toThrow();
  });

  it('retains existing protected-block checks ahead of deletion admission', async () => {
    const base = await fixture();
    const root = parseAbsSyntax(base.abs).find(node => node.type === 'setup')!;
    const source = base.abs.slice(0, root.start) + base.abs.slice(root.end);
    await expectAsync(reconcileAbsDraft(base, source, { requireDeletionEvidence: true }))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_PROTECTED_BLOCK_MISSING' }));
  });
});
