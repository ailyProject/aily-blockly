import { createAbsProjection, indexAbsAbi, indexAbsSyntax } from './abs-identity-map';
import { reconcileAbsDraft } from './abs-reconciler';
import { parseAbsSyntax, AbsArgumentDefinition } from './abs-syntax';
import { AbsAbiBlock, AbsProjectionContracts, AbsSyntaxNode } from './abs-state';
import { layoutSource, layoutEdits } from './abs-layout-session.fixture';
import { syntax as thermometerSyntax } from './abs-thermometer-session.fixture';

const orders: Record<string, AbsArgumentDefinition[]> = {
  dht_read_success: [{ kind: 'field', name: 'VAR' }],
  math_round: [{ kind: 'field', name: 'OP' }, { kind: 'valueInput', name: 'NUM' }],
  u8g2_set_draw_color: [{ kind: 'field', name: 'COLOR' }],
  u8g2_draw_rectangle: ['X', 'Y', 'W', 'H'].map(name => ({ kind: 'valueInput', name } as AbsArgumentDefinition))
    .concat({ kind: 'field', name: 'FILL' }),
  u8g2_draw_line: ['X1', 'Y1', 'X2', 'Y2'].map(name => ({ kind: 'valueInput', name })),
};
const variable = { type: 'field_variable', symbol: { kind: 'variable' as const, storage: 'variable-state' as const } };
const syntax = {
  argumentOrder: (type: string, state?: unknown) => orders[type] ?? thermometerSyntax.argumentOrder(type, state),
  fieldDefinition: (type: string, name: string) => name === 'VAR' && type !== 'variable_define'
    && type !== 'dht_init' && type !== 'serial_println' ? variable : thermometerSyntax.fieldDefinition(type, name),
};

describe('first complete layout candidate from the reported 18-minute session', () => {
  for (const tracked of [false, true]) it(`reconciles all six draw calls at once, tracked=${tracked}`, async () => {
    const contracts: AbsProjectionContracts = { fields: {}, syntax: {} };
    let serial = 0;
    const build = (node: AbsSyntaxNode): AbsAbiBlock => {
      const id = 'baseline-' + serial++;
      contracts.syntax![id] = syntax.argumentOrder(node.type, node.extraState)!;
      contracts.fields[id] = Object.fromEntries(Object.entries(node.fields).map(([name, token]) => [name,
        syntax.fieldDefinition(node.type, name) ?? { type: typeof token.value === 'string' && !token.quoted ? 'field_dropdown' : 'field_input' }]));
      return { type: node.type, id,
        fields: Object.fromEntries(Object.entries(node.fields).map(([name, token]) => [name,
          token.reference ? { id: 'model-' + token.value } : token.value])),
        ...(Object.hasOwn(node, 'extraState') ? { extraState: node.extraState } : {}),
        ...(Object.keys(node.inputs).length ? { inputs: Object.fromEntries(Object.entries(node.inputs)
          .map(([name, child]) => [name, child ? { block: build(child) } : {}])) } : {}),
        ...(node.next ? { next: { block: build(node.next) } } : {}),
      };
    };
    const roots = parseAbsSyntax(layoutSource, syntax).map(build);
    roots.forEach(root => root['deletable'] = false);
    const workspace = { blocks: { blocks: roots }, variables: ['temperature', 'humidity', 'lastUpdate', 'dht']
      .map(name => ({ id: 'model-' + name, name, type: name === 'dht' ? 'DHT' : '' })) };
    const baseline = await createAbsProjection(workspace, { document: workspace, contracts,
      generation: 'layout-session', baselineRef: 'layout-session', scope: { projectKey: 'test', pageId: 'main' }, savedAbiHash: null });
    const originalAbs = baseline.abs;
    expect(originalAbs).toContain('controls_if()\n        @IF0: logic_compare(');
    expect(indexAbsSyntax(parseAbsSyntax(originalAbs, syntax)).length).toBe(indexAbsAbi(workspace).size);
    // Replay the recorded agent draft in its original positional spelling; it
    // must still reconcile against today's paired-section canonical export.
    let edited = layoutSource;
    for (const edit of layoutEdits) {
      expect(edited.split(edit.oldText).length).toBe(2);
      edited = edited.replace(edit.oldText, edit.newText);
    }
    const result = await reconcileAbsDraft(baseline, edited, { ...syntax,
      variableCreation: { requestId: 'layout-session-request', variables: [{ name: 'tempInt', type: 'int' }, { name: 'humiInt', type: 'int' }] },
      ...(tracked ? { sourceEdits: [[{ start: 0, end: baseline.abs.length, text: edited }]] } : {}),
    });
    const blocks = [...indexAbsAbi(result.workspace).values()];
    expect(blocks.filter(block => block.type === 'u8g2_draw_str').length).toBe(6);
    expect(blocks.filter(block => block.type === 'u8g2_send_buffer').length).toBe(1);
    expect(blocks.filter(block => block.type === 'u8g2_clear_buffer').length).toBe(1);
    expect(result.retained).toEqual(jasmine.arrayContaining(roots.map(root => root.id)));
    expect(result.added.length).toBeGreaterThan(0);
    expect(indexAbsSyntax(parseAbsSyntax(edited, syntax)).length).toBe(blocks.length);
    expect(baseline.abs).toBe(originalAbs); // The immutable base is not a temporary reduced program.
  });
});
