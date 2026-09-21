import { assertAbsContractsCompatible, compareAbsContracts } from './abs-contract-compatibility';
import { AbsAbiWorkspace, AbsProjectionContracts } from './abs-state';

describe('ABS runtime contract compatibility', () => {
  const workspace: AbsAbiWorkspace = { blocks: { blocks: [{ type: 'generic_port', id: 'port', fields: { PORT: 'A' } }] } };
  const contracts = (options: [string, string][]): AbsProjectionContracts => ({ fields: { port: { PORT: { type: 'field_dropdown', options } } } });
  const before = contracts([['first', 'A'], ['unused', 'B']]);
  it('accepts exact contracts and changing unused options or labels while retaining a valid selection', () => {
    expect(compareAbsContracts(before, before, workspace).status).toBe('exact');
    for (const options of [[['renamed', 'A']], [['first', 'A'], ['new', 'C']]] as [string, string][][]) {
      expect(assertAbsContractsCompatible(before, contracts(options), workspace).status).toBe('compatible');
    }
  });
  it('rejects removal of the selected value and field protocol changes', () => {
    for (const current of [contracts([['unused', 'B']]), { fields: { port: { PORT: { type: 'field_input' } } } }, { fields: {} }]) {
      expect(() => assertAbsContractsCompatible(before, current, workspace))
        .toThrow(jasmine.objectContaining({ code: 'ABS_RUNTIME_CONTRACT_STALE' }));
    }
  });
  it('never treats argument structure, selectors or model tables as a dropdown domain', () => {
    for (const current of [{ ...before, syntax: {} }, { ...before, selectors: {} }, { ...before, symbolTables: [] }]) {
      expect(compareAbsContracts(before, current, workspace).status).toBe('incompatible');
    }
  });
});
