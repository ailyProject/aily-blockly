import { createAbsProjection } from './abs-identity-map';
import { readAbsSyntax } from './abs-syntax';
import { retainedInactiveAbsCalls } from './abs-native-preservation';
import type { AbsAbiWorkspace, AbsProjectionContracts } from './abs-state';

describe('inactive own-call discovery preservation', () => {
  const create = async (knownOrder = true) => {
    const workspace: AbsAbiWorkspace = { blocks: { blocks: [{ type: 'preserved_parent', id: 'parent',
      disabledReasons: ['MANUALLY_DISABLED'], deletable: false, fields: { MODE: 'OLD' }, extraState: { shape: 1 },
      inputs: { VALUE: { block: { type: 'preserved_value', id: 'child', fields: { NUM: 1 } } } } }] } };
    const contracts: AbsProjectionContracts = { fields: {
      parent: { MODE: { type: 'field_dropdown', preservedValue: { value: 'OLD' } } }, child: { NUM: { type: 'field_number' } },
    }, ...(knownOrder ? { syntax: {
      parent: [{ name: 'MODE', kind: 'field' as const }, { name: 'VALUE', kind: 'valueInput' as const }],
      child: [{ name: 'NUM', kind: 'field' as const }],
    } } : {}) };
    return createAbsProjection(workspace, { document: workspace, contracts, generation: 'inactive-own-call', baselineRef: 'inactive-own-call',
      scope: { projectKey: 'isolated', pageId: 'main' }, savedAbiHash: null });
  };
  const calls = async (source: string, knownOrder = true) => retainedInactiveAbsCalls(await create(knownOrder),
    readAbsSyntax('# ABS Schema: 2\n' + source));
  it('keeps a known positional parent while an inline value changes or becomes an empty value input', async () => {
    for (const child of ['preserved_value(2)', 'null']) {
      const result = await calls(`preserved_parent(OLD, ${child}) @extra:{"shape":1} @disabled`);
      expect(result.some(call => call.type === 'preserved_parent')).toBeTrue();
      expect(result.some(call => call.type === 'preserved_value')).toBeFalse();
    }
  });
  it('compares named own fields without parameter order and independently of inline children', async () => {
    for (const knownOrder of [false, true]) {
      const result = await calls('preserved_parent(VALUE=preserved_value(NUM=2), MODE="OLD") @extra:{"shape":1} @disabled', knownOrder);
      expect(result.some(call => call.type === 'preserved_parent')).toBeTrue();
    }
  });
  it('does not grant preservation for own field, reference, extraState or active-state changes', async () => {
    for (const source of [
      'preserved_parent(NEW, preserved_value(1)) @extra:{"shape":1} @disabled',
      'preserved_parent($OLD, preserved_value(1)) @extra:{"shape":1} @disabled',
      'preserved_parent(OLD, preserved_value(1)) @extra:{"shape":2} @disabled',
      'preserved_parent(OLD, preserved_value(1)) @extra:{"shape":1}',
    ]) expect((await calls(source)).some(call => call.type === 'preserved_parent')).toBeFalse();
  });
  it('does not infer positional ownership when the baseline captured no argument order', async () => {
    const result = await calls('preserved_parent(OLD, preserved_value(NUM=1)) @extra:{"shape":1} @disabled', false);
    expect(result.some(call => call.type === 'preserved_parent')).toBeFalse();
  });
});
