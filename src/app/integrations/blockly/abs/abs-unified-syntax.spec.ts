import * as Blockly from 'blockly';
import { BlocklyDeclarativeBlockCatalog } from '../../../editors/blockly-editor/services/blockly-declarative-block-catalog';
import { compileAbsDeclarativeContract } from './abs-declarative-contracts';
import { captureAbsRuntimeContracts } from './abs-runtime-contracts';
import { absJson, createAbsProjection, indexAbsSyntax, validateAbsProjection } from './abs-identity-map';
import { absSyntaxOptions } from './abs-syntax-contracts';
import { parseAbsSyntax } from './abs-syntax';
import { reconcileAbsDraft } from './abs-reconciler';
import { AbsAbiWorkspace, AbsProjectionContracts, ABS_SCHEMA_HEADER } from './abs-state';
import { convertAbiToAbs, convertAbsToAbi } from './abi-abs-converter';
import { getGlobalBlockMetas, setGlobalBlockMetas } from './block-definition.service';
import { parseBlockDefinition } from './block-definition.model';

describe('ABS unified definition-order syntax', () => {
  const definition = {
    type: 'abs_order_decl', message0: '%1 %2 %3', args0: [
      { type: 'field_input', name: 'VAR', text: 'counter' },
      { type: 'input_value', name: 'VALUE' },
      { type: 'field_dropdown', name: 'TYPE', options: [['integer', 'int'], ['float', 'float']] },
    ], previousStatement: null, nextStatement: null,
  };
  const definitions = [definition,
    { type: 'abs_order_number', message0: '%1', args0: [{ type: 'field_number', name: 'NUM', value: 0 }], output: null },
    { type: 'abs_order_root', message0: '%1', args0: [{ type: 'input_statement', name: 'BODY' }] },
    { type: 'variables_get', args0: [{ type: 'field_variable', name: 'VAR' }], output: null },
    { type: 'abs_order_set', args0: [{ type: 'field_variable', name: 'VAR' }, { type: 'input_value', name: 'VALUE' }], previousStatement: null, nextStatement: null },
  ];
  const shapes = new Map(definitions.map(json => [json.type, compileAbsDeclarativeContract(json)!]));
  const options = { argumentOrder: (type: string) => shapes.get(type)?.argumentOrder,
    fieldDefinition: (type: string, name: string) => shapes.get(type)?.fields[name], blockContract: (type: string) => shapes.get(type) };
  const source = (code: string) => `${ABS_SCHEMA_HEADER}\n${code}`;
  const project = (workspace: AbsAbiWorkspace, contracts: AbsProjectionContracts) => createAbsProjection(workspace, {
    document: workspace, contracts, generation: 'g', baselineRef: 'r', savedAbiHash: null, scope: { projectKey: 'p', pageId: 'main' },
  });

  it('keeps interleaved value/field positions and numeric args-group order, excluding UI/statement entries', () => {
    const shape = compileAbsDeclarativeContract({ type: 'any_library', args10: [{ type: 'field_input', name: 'LAST' }],
      args2: [{ type: 'field_dropdown', name: 'TYPE', options: [['int', 'int']] }], args0: [
        { type: 'field_input', name: 'NAME' }, { type: 'input_statement', name: 'BODY' },
        { type: 'input_value', name: 'VALUE' }, { type: 'field_label', text: 'UI only' },
      ] })!;
    expect(shape.argumentOrder!.map(arg => arg.name)).toEqual(['NAME', 'BODY', 'VALUE', 'TYPE', 'LAST']);
    const node = parseAbsSyntax(source('any_library("counter", abs_order_number(7), int, "last")'), {
      ...options, argumentOrder: type => type === 'any_library' ? shape.argumentOrder : options.argumentOrder(type),
    })[0];
    expect(node.fields['NAME'].value).toBe('counter');
    expect(node.fields['TYPE'].value).toBe('int');
    expect(node.fields['LAST'].value).toBe('last');
    expect(node.inputs['VALUE']!.fields['NUM'].value).toBe(7);
    expect(() => parseAbsSyntax(source('abs_order_decl("counter", int, abs_order_number(7))'), options)).toThrow();
  });

  it('retains the existing converter argument order, rather than defining a new language order', async () => {
    const previous = getGlobalBlockMetas();
    setGlobalBlockMetas(new Map(definitions.map(json => [json.type, parseBlockDefinition(json, 'test')!])));
    try {
      const workspace: AbsAbiWorkspace = { blocks: { blocks: [{ type: 'abs_order_decl', id: 'd', fields: { TYPE: 'int', VAR: 'counter' },
        inputs: { VALUE: { block: { type: 'abs_order_number', id: 'n', fields: { NUM: 7 } } } } }] } };
      const oldAbs = convertAbiToAbs(workspace, { includeHeader: false, explicitBlockTypes: true });
      expect(oldAbs).toContain('abs_order_decl("counter", abs_order_number(7), "int")');
      const node = parseAbsSyntax(source(oldAbs), options)[0];
      expect(node.fields['VAR'].value).toBe('counter');
      expect(node.fields['TYPE'].value).toBe('int');
      expect(node.inputs['VALUE']!.fields['NUM'].value).toBe(7);
      const projection = await project(workspace, { fields: { d: shapes.get('abs_order_decl')!.fields, n: shapes.get('abs_order_number')!.fields },
        syntax: { d: shapes.get('abs_order_decl')!.argumentOrder!, n: shapes.get('abs_order_number')!.argumentOrder! } });
      const parsedByOld = convertAbsToAbi(projection.abs);
      expect(parsedByOld.success).toBeTrue();
      expect(parsedByOld.abiJson.blocks.blocks[0].fields).toEqual(workspace.blocks.blocks[0].fields);
      expect(parsedByOld.abiJson.blocks.blocks[0].inputs.VALUE.block.fields.NUM).toBe(7);
    } finally { setGlobalBlockMetas(previous); }
  });

  it('captures original JSON order, exports and reloads real Blockly blocks without moving a value behind fields', async () => {
    const workspace = new Blockly.Workspace(), restored = new Blockly.Workspace(), catalog = new BlocklyDeclarativeBlockCatalog();
    const registered = definitions.slice(0, 3);
    try {
      for (const json of registered) {
        Blockly.common.defineBlocksWithJsonArray([json]);
        catalog.record(json, Blockly.Blocks[json.type]);
      }
      const root = workspace.newBlock('abs_order_root', 'root'); root.setDeletable(false);
      const declaration = workspace.newBlock('abs_order_decl', 'decl');
      const number = workspace.newBlock('abs_order_number', 'num'); number.setFieldValue(7, 'NUM');
      root.getInput('BODY')!.connection!.connect(declaration.previousConnection!);
      declaration.getInput('VALUE')!.connection!.connect(number.outputConnection!);
      const state = Blockly.serialization.workspaces.save(workspace) as AbsAbiWorkspace;
      const captured = captureAbsRuntimeContracts(workspace, state, () => {}, catalog.capture(Blockly.Blocks));
      expect(captured.contracts.syntax!['decl'].map(arg => arg.name)).toEqual(['VAR', 'VALUE', 'TYPE']);
      const baseline = await project(state, captured.contracts);
      expect(baseline.abs).toContain('abs_order_root()\n    abs_order_decl("counter", abs_order_number(7), int)');
      expect(baseline.abs).not.toContain('@BODY:');
      expect(baseline.abs).not.toContain('deletable');
      expect(baseline.map.nodes.find(node => node.blockId === 'num')?.astPath).toBe('/blocks/0/inputs/BODY/inputs/VALUE');
      const edit = await reconcileAbsDraft(baseline, baseline.abs.replace('abs_order_number(7)', 'abs_order_number(9)'), options);
      Blockly.serialization.workspaces.load(edit.workspace, restored);
      expect(restored.getBlockById('num')!.getFieldValue('NUM')).toBe(9);
      expect(restored.getBlockById('decl')!.getFieldValue('TYPE')).toBe('int');
      expect(restored.getBlockById('root')!.isDeletable()).toBeFalse();
      expect(edit.added).toEqual([]); expect(edit.removed).toEqual([]);
      const next = await project(edit.workspace, edit.contracts);
      await validateAbsProjection(next);
      expect(next.abs).toContain('abs_order_decl("counter", abs_order_number(9), int)');
    } finally {
      workspace.dispose(); restored.dispose();
      for (const json of registered) delete Blockly.Blocks[json.type];
    }
  });

  it('exports null value arguments once, retaining positions of following fields', async () => {
    const workspace: AbsAbiWorkspace = { blocks: { blocks: [{ type: 'abs_order_decl', id: 'd', fields: { TYPE: 'int', VAR: 'counter' }, inputs: { VALUE: {} } }] } };
    const baseline = await project(workspace, { fields: { d: shapes.get('abs_order_decl')!.fields }, syntax: { d: shapes.get('abs_order_decl')!.argumentOrder! } });
    expect(baseline.abs).toContain('abs_order_decl("counter", null, int)');
    expect(baseline.abs).not.toContain('@VALUE:');
    await validateAbsProjection(baseline);
    expect((await reconcileAbsDraft(baseline, baseline.abs + '\n# comment', options)).workspace).toEqual(workspace);
  });

  it('maps a variable field without a block and a bare value reference to one identity-preserving getter', async () => {
    const workspace: AbsAbiWorkspace = { variables: [{ id: 'v', name: 'counter', type: '' }], blocks: { blocks: [
      { type: 'abs_order_set', id: 's', fields: { VAR: { id: 'v' } }, inputs: { VALUE: { block: { type: 'variables_get', id: 'g', fields: { VAR: { id: 'v' } } } } } },
    ] } };
    const contracts = { fields: { s: shapes.get('abs_order_set')!.fields, g: shapes.get('variables_get')!.fields },
      syntax: { s: shapes.get('abs_order_set')!.argumentOrder!, g: shapes.get('variables_get')!.argumentOrder! } };
    let baseline = await project(workspace, contracts);
    expect(baseline.abs).toContain('abs_order_set($counter, variables_get($counter))');
    for (let i = 0; i < 3; i++) {
      const text = baseline.abs.replace('variables_get($counter)', '$counter');
      const entries = indexAbsSyntax(parseAbsSyntax(text, options));
      expect(entries.length).toBe(2);
      expect(text.slice(entries[1].node.start, entries[1].node.end)).toBe('$counter');
      const result = await reconcileAbsDraft(baseline, text, options);
      expect(result.workspace).toEqual(workspace); expect(result.added).toEqual([]); expect(result.removed).toEqual([]);
      baseline = await project(result.workspace, result.contracts);
    }
    await expectAsync(reconcileAbsDraft(baseline, baseline.abs.replaceAll('$counter', '$missing'), options)).toBeRejected();
    expect(workspace['variables']).toEqual([{ id: 'v', name: 'counter', type: '' }]);
  });

  it('chains only a proven single statement body and accepts a known inline value section', () => {
    const roots = parseAbsSyntax(source('abs_order_root()\n    abs_order_decl("a", null, int)\n    abs_order_decl("b", null, int)\nabs_order_root()'), options);
    expect(roots.length).toBe(2);
    expect(roots[0].next).toBeUndefined();
    expect(roots[0].inputs['BODY']!.next!.fields['VAR'].value).toBe('b');
    const node = parseAbsSyntax(source('abs_order_decl(VAR="a", TYPE=int)\n    @VALUE: abs_order_number(7)'), options)[0];
    expect(node.inputs['VALUE']!.fields['NUM'].value).toBe(7);
    expect(() => parseAbsSyntax(source('unknown()\n    abs_order_number(1)'), options)).toThrow();
    expect(() => parseAbsSyntax(source('abs_order_decl(VAR="a", TYPE=int)\n    @VALUE:\n        abs_order_number(1)\n        abs_order_number(2)'), options)).toThrow();
  });

  it('keeps disagreeing instance orders named-only and hashes the proven order with the baseline', async () => {
    const fields = shapes.get('abs_order_decl')!.fields, order = shapes.get('abs_order_decl')!.argumentOrder!;
    const workspace: AbsAbiWorkspace = { blocks: { blocks: ['a', 'b'].map(id => ({ type: 'abs_order_decl', id, fields: { VAR: id, TYPE: 'int' } })) } };
    const contracts = { fields: { a: fields, b: fields }, syntax: { a: order, b: [order[0], order[2], order[1]] } };
    expect(absSyntaxOptions(workspace, contracts, options).argumentOrder!('abs_order_decl')).toBeUndefined();
    const baseline = await project(workspace, contracts);
    expect(baseline.abs).toContain('VAR="a"');
    baseline.contracts.syntax!['b'] = order;
    await expectAsync(validateAbsProjection(baseline)).toBeRejected();
  });

  it('preserves an existing instance order when canonical export reorders opaque extraState keys', async () => {
    const fields = shapes.get('abs_order_decl')!.fields, order = shapes.get('abs_order_decl')!.argumentOrder!;
    const workspace: AbsAbiWorkspace = { blocks: { blocks: [{ type: 'abs_order_decl', id: 'd',
      fields: { VAR: 'counter', TYPE: 'int' }, extraState: { z: 1, a: { y: 2, b: 3 } } }] } };
    const contracts = { fields: { d: fields }, syntax: { d: order } };
    const syntax = absSyntaxOptions(workspace, contracts);
    expect(syntax.argumentOrder!('abs_order_decl', { a: { b: 3, y: 2 }, z: 1 })).toEqual(order);
    expect(syntax.argumentOrder!('abs_order_decl', { a: { b: 3, y: 2 }, z: 2 })).toBeUndefined();
    const baseline = await project(workspace, contracts);
    expect((await reconcileAbsDraft(baseline, baseline.abs)).workspace).toEqual(workspace);
  });

  it('does not turn unchanged text into a reference or scan Project Data JSON as variables', async () => {
    const workspace: AbsAbiWorkspace = { blocks: { blocks: [{ type: 'abs_order_decl', id: 'd', fields: { VAR: 'counter', TYPE: 'int' } }] } };
    const baseline = await project(workspace, { fields: { d: shapes.get('abs_order_decl')!.fields }, syntax: { d: shapes.get('abs_order_decl')!.argumentOrder! } });
    await expectAsync(reconcileAbsDraft(baseline, baseline.abs.replace('"counter"', '$counter'), options)).toBeRejected();
    const payload = { $ailyProjectDataValue: { $ailyData: { text: '$counter' } } };
    expect(parseAbsSyntax(source(`any(TEXT=${absJson(payload)})`))[0].fields['TEXT'].value).toEqual(payload);
  });
});
