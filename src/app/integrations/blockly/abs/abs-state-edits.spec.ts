import { createAbsProjection } from './abs-identity-map';
import { reconcileAbsDraft } from './abs-reconciler';
import { splitAbsState } from './abs-full-state';
import { assertAbsRuntimeShapeSupported } from './abs-workspace-state';
import { applyAbsStateEdits } from './abs-state-edits';
import { parseAbsSyntax } from './abs-syntax';
import { AbsAbiBlock } from './abs-state';

describe('controlled ABS state edits', () => {
  const parse = (source: string) => parseAbsSyntax('# ABS Schema: 2\n' + source)[0];
  const block = (): AbsAbiBlock => ({ type: 'root', id: 'setup', deletable: false,
    icons: { comment: { text: 'old', pinned: true, width: 120 } },
    inputs: { VALUE: { block: { id: 'value', type: 'number' }, shadow: { id: 'hidden', type: 'number',
      deletable: false, disabledReasons: ['MANUALLY_DISABLED'], fields: { NUM: 7 } } } } });
  const field = () => ({ type: 'field_number', min: 0, max: 100 });
  it('changes comment text and dormant field values while retaining identity and restrictions', () => {
    const candidate = block(); candidate['comment'] = 'legacy';
    applyAbsStateEdits(candidate, parse('root() @comment:"new\\nline" @shadow_fields:{"VALUE":{"NUM":9}}'), field);
    expect(candidate['comment']).toBeUndefined();
    expect(candidate['deletable']).toBeFalse();
    expect(candidate['icons']).toEqual({ comment: { text: 'new\nline', pinned: true, width: 120, height: 80 } });
    expect(candidate.inputs!['VALUE'].shadow).toEqual({ id: 'hidden', type: 'number', deletable: false,
      disabledReasons: ['MANUALLY_DISABLED'], fields: { NUM: 9 } });
  });
  it('refuses identity injection, locked shadows, missing definitions and nonexistent shadows', () => {
    for (const source of ['root() @shadow_fields:{"VALUE":{"id":"replaced"}}', 'root() @shadow_fields:{"OTHER":{"NUM":9}}']) {
      expect(() => applyAbsStateEdits(block(), parse(source), field)).toThrow();
    }
    const lockedParent = block(); lockedParent['editable'] = false;
    expect(() => applyAbsStateEdits(lockedParent, parse('root() @shadow_fields:{"VALUE":{"NUM":9}}'), field)).toThrow();
    const candidate = block(); candidate.inputs!['VALUE'].shadow!['editable'] = false;
    expect(() => applyAbsStateEdits(candidate, parse('root() @shadow_fields:{"VALUE":{"NUM":9}}'), field)).toThrow();
    expect(() => applyAbsStateEdits(block(), parse('root() @shadow_fields:{"VALUE":{"NUM":9}}'), () => undefined)).toThrow();
  });
  it('carries the captured dormant-field contract through reconciliation and shape validation', async () => {
    const workspace = { blocks: { blocks: [block()] } };
    const baseline = await createAbsProjection(workspace, { document: workspace, generation: 'shadow', baselineRef: 'shadow',
      savedAbiHash: null, scope: { projectKey: 'p', pageId: 'main' } });
    const result = await reconcileAbsDraft(baseline, splitAbsState(baseline.abs).program + ' @shadow_fields:{"VALUE":{"NUM":9}}', { fieldDefinition: field });
    expect(() => assertAbsRuntimeShapeSupported(baseline.workspace, result.workspace, result.contracts)).not.toThrow();
    expect(result.contracts.fields['hidden']['NUM']).toEqual(field());
    expect(baseline.contracts.fields['hidden']).toBeUndefined();
  });
  it('rejects malformed annotations and supports explicit comment removal', () => {
    for (const source of ['root() @comment:{}', 'root() @shadow_fields:[]', 'root() @comment:"a" @comment:null']) expect(() => parse(source)).toThrow();
    const candidate = block(); applyAbsStateEdits(candidate, parse('root() @comment:null'), field);
    expect(candidate['icons']).toBeUndefined();
  });
});
