import { assertAbsResourceContracts } from './abs-resource-contracts';
import { AbsAbiWorkspace, AbsProjectionContracts } from './abs-state';

describe('ABS resource/model protocol boundary', () => {
  const workspace = (): AbsAbiWorkspace => ({ blocks: { blocks: [{ type: 'custom', id: 'b', fields: { VAR: 'v' } }] },
    models: [{ id: 'v', label: 'name', kind: 'number', payload: 'opaque' }] });
  const contracts: AbsProjectionContracts = { fields: { b: { VAR: { type: 'field_custom', symbol: { kind: 'variable', storage: 'id' } } } },
    symbolTables: [{ kind: 'variable', source: 'workspace', path: '/models', idPath: '/id', namePath: '/label', typePath: '/kind' }] };
  it('allows model payload storage changes while keeping identity/name/type and field references', () => {
    const before = workspace(); const after = workspace();
    (after['models'] as any[])[0].payload = { ref: 'resource' };
    expect(() => assertAbsResourceContracts(before, after, contracts)).not.toThrow();
  });
  for (const property of ['id', 'label', 'kind']) {
    it(`rejects hiding a declared model ${property} path`, () => {
      const before = workspace(); const after = workspace();
      (after['models'] as any[])[0][property] = { ref: 'resource' };
      expect(() => assertAbsResourceContracts(before, after, contracts)).toThrow();
    });
  }
  it('rejects hidden tables, field references and block removal', () => {
    const before = workspace();
    for (const after of [{ ...workspace(), models: {} }, { ...workspace(), models: [] },
      { ...workspace(), blocks: { blocks: [] } }]) {
      expect(() => assertAbsResourceContracts(before, after, contracts)).toThrow();
    }
    const after = workspace(); after.blocks.blocks[0].fields!['VAR'] = { ref: 'resource' };
    expect(() => assertAbsResourceContracts(before, after, contracts)).toThrow();
  });
  it('does not interpret inherited object keys as instance contracts', () => {
    const before = workspace(); before.blocks.blocks[0].id = '__proto__';
    const after = JSON.parse(JSON.stringify(before));
    expect(() => assertAbsResourceContracts(before, after, { fields: {}, procedures: {} })).not.toThrow();
  });
});
