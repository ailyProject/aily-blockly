import { createAbsProjection, absJson } from './abs-identity-map';
import { reconcileAbsDraft } from './abs-reconciler';
import { compileAbsDeclarativeContract } from './abs-declarative-contracts';
import { captureAbsVariableDeclarations } from './abs-declaration-intents';
import { AbsAbiWorkspace } from './abs-state';

describe('ordinary declarations prepare native models once', () => {
  const owner = { type: 'global', message0: '%1', args0: [{ type: 'input_statement', name: 'BODY' }] };
  const definitions = [owner, { type: 'declare', args0: [{ type: 'field_input', name: 'VAR' },
    { type: 'field_dropdown', name: 'TYPE', options: [['int', 'int'], ['float', 'float']] }, { type: 'input_value', name: 'VALUE' }],
    previousStatement: null, nextStatement: null },
    { type: 'variables_get', args0: [{ type: 'field_variable', name: 'VAR' }], output: null },
    { type: 'assign', args0: [{ type: 'field_variable', name: 'VAR' }, { type: 'input_value', name: 'VALUE' }], previousStatement: null, nextStatement: null },
    { type: 'number', args0: [{ type: 'field_number', name: 'NUM' }], output: 'Number' }];
  const shapes = new Map(definitions.map(json => [json.type, compileAbsDeclarativeContract(json)!]));
  const effect = { nameField: 'VAR', nativeType: '', owner: { type: 'global', input: 'BODY' } };
  const options = { argumentOrder: type => shapes.get(type)?.argumentOrder, fieldDefinition: (type, name) => shapes.get(type)?.fields[name],
    blockContract: type => shapes.get(type), declaration: type => type === 'declare' ? effect : undefined };
  const source = '# ABS Schema: 2\nglobal()\n    declare("counter", int, number(7))\n    assign($counter, $counter)';
  const project = (workspace: AbsAbiWorkspace = { blocks: { blocks: [] } }, contracts: any = { fields: {} }) => createAbsProjection(workspace, {
    document: workspace, contracts, generation: 'base', baselineRef: 'base', scope: { projectKey: 'p', pageId: 'main' }, savedAbiHash: null,
  });
  const reject = async (base: Awaited<ReturnType<typeof project>>, text: string, code: string, extra = {}) => {
    const before = absJson(base);
    await expectAsync(reconcileAbsDraft(base, text, { ...options, ...extra })).toBeRejectedWith(jasmine.objectContaining({ code }));
    expect(absJson(base)).toBe(before);
  };
  it('requires both attested generator effect and trusted declaration/owner shapes', () => {
    const snapshot: any = { assertCurrent() {}, variableDeclarations: { get: type => type === 'declare' ? effect : undefined } };
    expect(captureAbsVariableDeclarations(snapshot, type => shapes.get(type))('declare')).toEqual(effect);
    expect(captureAbsVariableDeclarations({ ...snapshot, variableDeclarations: undefined }, type => shapes.get(type))('declare')).toBeUndefined();
    expect(captureAbsVariableDeclarations(snapshot, () => undefined)('declare')).toBeUndefined();
    expect(captureAbsVariableDeclarations(snapshot, type => type === 'declare' ? { ...shapes.get(type)!, fields: {} } : shapes.get(type))('declare')).toBeUndefined();
  });
  it('prepares stable empty-type models before forward references, without mutating the baseline', async () => {
    const base = await project(), before = absJson(base);
    const text = '# ABS Schema: 2\nglobal()\n    assign($counter, $counter)\n    declare("counter", int, number(7))';
    const first = await reconcileAbsDraft(base, text, options), second = await reconcileAbsDraft(base, text, options);
    const models = first.workspace['variables'] as any[];
    expect(models.length).toBe(1); expect(models[0].name).toBe('counter'); expect(models[0].type).toBe('');
    expect(second.workspace['variables']).toEqual(models);
    const assign = first.workspace.blocks.blocks[0].inputs!['BODY'].block!;
    expect(assign.fields!['VAR']).toEqual({ id: models[0].id });
    expect(assign.inputs!['VALUE'].block!.fields!['VAR']).toEqual({ id: models[0].id });
    expect(absJson(base)).toBe(before);
  });
  it('keeps declaration/getter/model identities after canonical export and a second edit', async () => {
    const draft = await reconcileAbsDraft(await project(), source, options);
    const base = await project(draft.workspace, draft.contracts);
    const changed = await reconcileAbsDraft(base, base.abs.replace('number(7)', 'number(9)'), options);
    expect(changed.workspace['variables']).toEqual(draft.workspace['variables']);
    expect(changed.added).toEqual([]); expect(changed.removed).toEqual([]);
    expect(changed.retained.length).toBe(5);
  });
  it('deduplicates an agreeing explicit transition intent and refuses a different native type', async () => {
    const base = await project(), requestId = 'declaration-request-0001';
    const result = await reconcileAbsDraft(base, source, { ...options, variableCreation: { requestId, variables: [{ name: 'counter' }] } });
    expect(result.workspace['variables']).toEqual([{ name: 'counter', type: '', id: `abs-variable:${requestId}:0` }]);
    await reject(base, source, 'ABS_DECLARATION_MODEL_CONFLICT', { variableCreation: { requestId, variables: [{ name: 'counter', type: 'int' }] } });
  });
  it('preserves an existing unambiguous model including opaque data', async () => {
    const workspace = { blocks: { blocks: [] }, variables: [{ id: 'model', name: 'counter', type: '', opaque: true }] };
    const result = await reconcileAbsDraft(await project(workspace), source, options);
    expect(result.workspace['variables']).toEqual(workspace.variables);
  });
  it('preserves an existing special declaration name during an unrelated value edit', async () => {
    const draft = await reconcileAbsDraft(await project(), source.split('\n    assign')[0], options);
    draft.workspace.blocks.blocks[0].inputs!['BODY'].block!.fields!['VAR'] = '已有变量';
    (draft.workspace['variables'] as any[])[0].name = '已有变量';
    const base = await project(draft.workspace, draft.contracts);
    const changed = await reconcileAbsDraft(base, base.abs.replace('number(7)', 'number(9)'), options);
    expect(changed.workspace['variables']).toEqual(draft.workspace['variables']);
    expect(changed.added).toEqual([]);
  });
  it('rejects duplicates, case/type ambiguity, implicit renames and missing retained models', async () => {
    await reject(await project(), source + '\n    declare("counter", int, number(8))', 'ABS_DECLARATION_DUPLICATE');
    for (const models of [[{ name: 'Counter', type: '', id: 'one' }], [{ name: 'counter', type: 'Number', id: 'one' }],
      [{ name: 'counter', type: '', id: 'one' }, { name: 'counter', type: 'Number', id: 'two' }]]) {
      await reject(await project({ blocks: { blocks: [] }, variables: models }), source, 'ABS_DECLARATION_MODEL_CONFLICT');
    }
    const draft = await reconcileAbsDraft(await project(), source, options), base = await project(draft.workspace, draft.contracts);
    await reject(base, base.abs.replace('"counter"', '"renamed"'), 'ABS_DECLARATION_RENAME_REQUIRES_HOST');
    const onlyDeclaration = await reconcileAbsDraft(await project(), source.split('\n    assign')[0], options);
    delete onlyDeclaration.workspace['variables'];
    const lost = await project(onlyDeclaration.workspace, onlyDeclaration.contracts);
    await reject(lost, lost.abs.replace('number(7)', 'number(9)'), 'ABS_DECLARATION_MODEL_MISSING');
  });
  it('rejects undeclared typos, unproved scopes, missing/text-reference names and reference-only model creation', async () => {
    const base = await project();
    await reject(base, source.replace('assign($counter', 'assign($counetr'), 'ABS_SYMBOL_MISSING');
    await reject(base, '# ABS Schema: 2\ndeclare("counter", int, number(7))', 'ABS_DECLARATION_SCOPE_UNSUPPORTED');
    await reject(base, source.replace('"counter"', '$counter'), 'ABS_DECLARATION_INVALID');
    await reject(base, '# ABS Schema: 2\nglobal()\n    declare(TYPE=int)', 'ABS_DECLARATION_INVALID');
    await reject(base, '# ABS Schema: 2\nglobal()\n    assign($counter, number(7))', 'ABS_SYMBOL_MISSING');
  });
});
