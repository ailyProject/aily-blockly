import * as Blockly from 'blockly';
import { indexAbsAbi, createAbsProjection, validateAbsProjection } from './abs-identity-map';
import { decodeAbsState } from './abs-full-state';
import { composeAbs } from './abs-compose';
import { compileAbsDeclarativeContract } from './abs-declarative-contracts';
import { parseAbsSyntax, readAbsSyntax } from './abs-syntax';
import { ABS_SCHEMA_HEADER, type AbsAbiWorkspace } from './abs-state';

describe('ABS digit-prefixed library block types', () => {
  const types = ['74hc595_create', '74hc595_set', '74hc595_setAll', '74hc595_setAllBin', '74hc595_getstate',
    '5p49v60_init', '5p49v60_set_vco', '5p49v60_mux_pll_to_fod', '5p49v60_set_clock_freq', '5p49v60_set_clock_mode', '5p49v60_skew_clock'];
  const definitions = types.map(type => ({ type, message0: '%1',
    args0: [{ type: 'field_input', name: 'VAR', text: 'hc1' }], previousStatement: null, nextStatement: null }));
  const shapes = new Map(definitions.map(definition => [definition.type, compileAbsDeclarativeContract(definition)!]));
  const options = { knownType: (type: string) => shapes.has(type), blockContract: (type: string) => shapes.get(type),
    argumentOrder: (type: string) => shapes.get(type)?.argumentOrder };
  const source = (code: string) => `${ABS_SCHEMA_HEADER}\n${code}`;

  it('exports, validates and reopens a real Blockly chain containing all eleven affected type names', async () => {
    const workspace = new Blockly.Workspace(), restored = new Blockly.Workspace();
    try {
      Blockly.common.defineBlocksWithJsonArray(definitions);
      const blocks = types.map((type, index) => workspace.newBlock(type, `hc-${index}`));
      blocks.slice(0, -1).forEach((block, index) => block.nextConnection!.connect(blocks[index + 1].previousConnection!));
      const state = Blockly.serialization.workspaces.save(workspace) as AbsAbiWorkspace;
      expect([...indexAbsAbi(state).values()].map(block => block.type)).toEqual(types);
      const contracts = { fields: Object.fromEntries(blocks.map(block => [block.id, shapes.get(block.type)!.fields])),
        syntax: Object.fromEntries(blocks.map(block => [block.id, shapes.get(block.type)!.argumentOrder!])) };
      const projection = await createAbsProjection(state, { document: state, contracts, generation: 'numeric-types',
        baselineRef: 'baseline', savedAbiHash: null, scope: { projectKey: 'p', pageId: 'main' } });
      await validateAbsProjection(projection);
      const decoded = await decodeAbsState(projection.abs);
      expect(decoded.workspace).toEqual(state);
      Blockly.serialization.workspaces.load(decoded.workspace, restored);
      expect(Blockly.serialization.workspaces.save(restored)).toEqual(state);
      for (const type of types) expect(projection.abs).toContain(`${type}("hc1")`);
    } finally {
      workspace.dispose(); restored.dispose();
      types.forEach(type => delete Blockly.Blocks[type]);
    }
  });

  it('accepts digit-prefixed roots, inline children, input sections and next chains', () => {
    const nodes = readAbsSyntax(source('74hc595_create(VAR="hc1", VALUE=74hc595_getstate(VAR=$hc1))\n'
      + '    @next:\n        74hc595_set(VAR=$hc1)\n'
      + 'owner()\n    @VALUE: 74hc595_getstate(VAR=$hc1)'));
    expect(nodes[0].type).toBe(types[0]);
    expect(nodes[0].parameters[1].child?.type).toBe(types[4]);
    expect(nodes[0].sections[0].children[0].type).toBe(types[1]);
    expect(nodes[1].sections[0].inline?.child?.type).toBe(types[4]);
  });

  it('uses the same type grammar for structured authoring and projection', () => {
    const result = composeAbs({ blocks: types.map(type => ({ type, fields: { VAR: 'hc1' } })) }, options);
    expect(result.precheck.ok).toBeTrue();
    expect(parseAbsSyntax(result.abs, options).map(node => node.type)).toEqual(types);
  });

  it('continues rejecting malformed types and numeric annotation names without changing number literals', () => {
    for (const type of ['', '74hc595-bad', '74hc595.bad', '74hc595 bad', '74hc595()', 74, null, undefined]) {
      expect(() => indexAbsAbi({ blocks: { blocks: [{ type, id: 'invalid' }] } } as any)).toThrow();
      expect(() => composeAbs({ blocks: [{ type }] }, options)).toThrow();
    }
    for (const code of ['74hc595-bad()', '74hc595.bad()', 'owner() @74disabled']) {
      expect(() => readAbsSyntax(source(code))).toThrow();
    }
    expect(parseAbsSyntax(source('owner(VALUE=74)'))[0].fields['VALUE'].value).toBe(74);
  });
});
