import type * as Blockly from 'blockly';
import { AbsAbiWorkspace, AbsSyncError } from './abs-state';
import { indexAbsAbi } from './abs-identity-map';
import { AbsProcedureStateContract, getAbsProcedureReferences } from './abs-procedures';
import { captureAbsCustomFunctions } from './abs-custom-functions';
import type { DeclarativeBlockSnapshot } from '../../../editors/blockly-editor/services/blockly-declarative-block-catalog';

/** Capture only explicit native or source-attested custom procedure contracts.
 * Capability getters identify legacy roles; custom protocol paths come from its
 * pure adapter, never from guessing arbitrary serializer values or block names.
 */
export function captureAbsProcedureContracts(workspace: Blockly.Workspace, serialized: AbsAbiWorkspace, assertCurrent: () => void, definitions?: DeclarativeBlockSnapshot) {
  assertCurrent();
  const blocks = indexAbsAbi(serialized);
  const contracts: Record<string, AbsProcedureStateContract> = Object.create(null);
  const custom = definitions && captureAbsCustomFunctions(definitions);
  for (const block of workspace.getAllBlocks(false) as any[]) {
    const state = blocks.get(block.id);
    if (!state) continue;
    const customShape = custom?.existing(state);
    if (customShape) { contracts[block.id] = customShape.procedure!; continue; }
    const fail = (): never => { throw new AbsSyncError('ABS_PROCEDURE_CONTRACT_UNSUPPORTED', 'Procedure serialization requires an explicit host adapter.', undefined, [block.id]); };
    if (typeof block.getProcedureModel === 'function') fail();
    if (typeof block.getProcedureDef === 'function') {
      const definition = block.getProcedureDef();
      const params = (state.extraState as any)?.params ?? [];
      if (!Array.isArray(definition) || definition.length !== 3 || definition[0] !== state.fields?.['NAME'] || typeof definition[2] !== 'boolean'
        || !Array.isArray(definition[1]) || !Array.isArray(params)
        || definition[1].length !== params.length || params.some((param, index) => param?.name !== definition[1][index])) fail();
      contracts[block.id] = { role: 'definition', namePath: '/fields/NAME', parametersPath: '/extraState/params',
        parameterNamePath: '/name', parameterVariableIdPath: '/id', returns: definition[2] };
    } else if (typeof block.getProcedureCall === 'function') {
      if (block.getProcedureCall() !== (state.extraState as any)?.name) fail();
      contracts[block.id] = { role: 'call', namePath: '/extraState/name', parametersPath: '/extraState/params',
        parameterNamePath: '', returns: !!block.outputConnection };
    }
    assertCurrent();
  }
  getAbsProcedureReferences(serialized, contracts);
  assertCurrent();
  return contracts;
}
