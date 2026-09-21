import { assertAbsVariableCreations, prepareAbsVariableCreations } from './abs-variable-intents';
import { absJson, createAbsProjection } from './abs-identity-map';
import { reconcileAbsDraft } from './abs-reconciler';
import { compileAbsDeclarativeContract } from './abs-declarative-contracts';

describe('explicit native variable preparation', () => {
  const requestId = 'variable-request-0001';
  const empty = () => ({ blocks: { blocks: [] } });
  const intent = (variables: any[]) => ({ requestId, variables });
  it('prepares stable host IDs without changing existing opaque model data', () => {
    const workspace: any = { ...empty(), variables: [{ name: 'old', id: 'old-id', type: '', opaque: { keep: true } }] };
    const other = structuredClone(workspace);
    prepareAbsVariableCreations(workspace, intent([{ name: 'counter' }, { name: 'typed', type: 'Number' }]));
    prepareAbsVariableCreations(other, intent([{ name: 'counter' }, { name: 'typed', type: 'Number' }]));
    expect(workspace).toEqual(other);
    expect(workspace.variables[0]).toEqual({ name: 'old', id: 'old-id', type: '', opaque: { keep: true } });
    expect(workspace.variables[1]).toEqual({ name: 'counter', id: `abs-variable:${requestId}:0`, type: '' });
  });
  it('rejects invalid shapes, caller IDs and unbounded or noncanonical data', () => {
    for (const value of [null, {}, [], Array(129).fill({ name: 'a' }), [{ name: '' }], [{ name: ' a' }], [{ name: 'a\nb' }],
      [{ name: 'a', id: 'agent-id' }], [{ name: 'a', type: null }], [{ name: 'a'.repeat(257) }]]) {
      expect(() => assertAbsVariableCreations(value)).toThrow();
    }
    expect(() => assertAbsVariableCreations(undefined)).not.toThrow();
  });
  it('rejects duplicate names across case/types and never partially updates the table', () => {
    const workspace: any = { ...empty(), variables: [{ name: 'Counter', id: 'existing', type: 'Number' }] };
    const before = absJson(workspace);
    for (const variables of [[{ name: 'fresh' }, { name: 'counter' }], [{ name: 'fresh' }, { name: 'FRESH', type: 'Number' }]]) {
      expect(() => prepareAbsVariableCreations(workspace, intent(variables))).toThrow();
      expect(absJson(workspace)).toBe(before);
    }
  });
  it('resolves names against the candidate model table without changing the validated baseline', async () => {
    const workspace = empty();
    const baseline = await createAbsProjection(workspace, { document: workspace, generation: 'base', baselineRef: 'baselines/base.json',
      savedAbiHash: null, scope: { projectKey: 'p', pageId: 'main' } });
    const before = absJson(baseline);
    const result = await reconcileAbsDraft(baseline, '# ABS Schema: 2\nget(VAR="counter")', {
      variableCreation: intent([{ name: 'counter' }]), newId: () => 'get-id',
      blockContract: () => compileAbsDeclarativeContract({ type: 'get', args0: [{ type: 'field_variable', name: 'VAR' }], output: null }),
    });
    expect(result.workspace.blocks.blocks[0].fields!['VAR']).toEqual({ id: `abs-variable:${requestId}:0` });
    expect(absJson(baseline)).toBe(before);
    const onlyModels = await reconcileAbsDraft(baseline, baseline.abs, { variableCreation: intent([{ name: 'counter' }]) });
    expect(onlyModels.workspace['variables']).toEqual(result.workspace['variables']);
    expect(onlyModels.added).toEqual([]);
  });
  it('detaches model intents before awaiting baseline validation', async () => {
    const workspace = empty();
    const baseline = await createAbsProjection(workspace, { document: workspace, generation: 'base', baselineRef: 'baselines/base.json',
      savedAbiHash: null, scope: { projectKey: 'p', pageId: 'main' } });
    const creation = intent([{ name: 'counter' }]);
    const pending = reconcileAbsDraft(baseline, baseline.abs, { variableCreation: creation });
    creation.variables[0].name = 'late';
    expect((await pending).workspace['variables']).toEqual([{ name: 'counter', type: '', id: `abs-variable:${requestId}:0` }]);
  });
});
