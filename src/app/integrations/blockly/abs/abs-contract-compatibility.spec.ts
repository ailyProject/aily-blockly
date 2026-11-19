import { assertAbsContractsCompatible, compareAbsContracts } from './abs-contract-compatibility';
import { AbsAbiWorkspace, AbsProjectionContracts } from './abs-state';
import type { AbsProcedureStateContract } from './abs-procedures';

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
  const procedure: AbsProcedureStateContract = { role: 'definition', namePath: '/fields/NAME', parametersPath: '/extraState/params', parameterNamePath: '/name', returns: false };
  it('accepts omission of an unchanged inactive legacy procedure contract from preview.7', () => {
    const inactive: AbsAbiWorkspace = { blocks: { blocks: [{ ...workspace.blocks.blocks[0], disabledReasons: ['MANUALLY_DISABLED'] }] } };
    const old = { ...before, procedures: { port: procedure } }, current = { ...before, procedures: {} };
    expect(assertAbsContractsCompatible(old, current, inactive)).toEqual(jasmine.objectContaining({ status: 'compatible',
      changes: [jasmine.objectContaining({ reason: 'inactive-procedure-preserved', blockType: 'generic_port' })] }));
    expect(old.procedures.port).toBe(procedure);
  });
  it('keeps active procedure removals, inactive additions/edits and unrelated structure changes incompatible', () => {
    const inactive: AbsAbiWorkspace = { blocks: { blocks: [{ ...workspace.blocks.blocks[0], disabledReasons: ['MANUALLY_DISABLED'] }] } };
    const old = { ...before, procedures: { port: procedure } };
    expect(() => assertAbsContractsCompatible(old, { ...before, procedures: {} }, workspace)).toThrow(jasmine.objectContaining({ code: 'ABS_RUNTIME_CONTRACT_STALE' }));
    for (const current of [
      { ...before, procedures: { port: { ...procedure, returns: true } } },
      { ...before, procedures: {}, syntax: {} },
    ]) expect(compareAbsContracts(old, current, inactive).status).toBe('incompatible');
    expect(compareAbsContracts(before, old, inactive).status).toBe('incompatible');
    expect(compareAbsContracts(old, { ...before, procedures: {} }, { blocks: { blocks: [] } }).status).toBe('incompatible');
  });
  it('does not report a compatible inactive procedure omission as the cause of a separate protocol failure', () => {
    const inactive: AbsAbiWorkspace = { blocks: { blocks: [{ ...workspace.blocks.blocks[0], disabledReasons: ['MANUALLY_DISABLED'] }] } };
    const old = { ...before, procedures: { port: procedure } };
    const current = { fields: { port: { PORT: { type: 'field_input' } } }, procedures: {} };
    expect(() => assertAbsContractsCompatible(old, current, inactive)).toThrowMatching(error =>
      error.code === 'ABS_RUNTIME_CONTRACT_STALE' && error.diagnostic.reason === 'field-protocol-or-selected-value-changed');
  });
});
