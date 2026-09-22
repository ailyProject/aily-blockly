import type * as Blockly from 'blockly';
import { captureAbsFieldContract } from './abs-runtime-field-contract';
import { AbsFieldDefinition } from './abs-field-values';
import { AbsAbiWorkspace, AbsProjectionContracts, AbsSyncError, getAbsFieldDefinition } from './abs-state';
import { indexAbsAbi } from './abs-identity-map';
import type { DeclarativeBlockSnapshot } from '../../../editors/blockly-editor/services/blockly-declarative-block-catalog';
import { captureAbsDeclarativeContracts } from './abs-declarative-contracts';
import { nativeAbsArgumentOrder } from './abs-native-arguments';

/** Captures existing instances only. No probe blocks, global cache, library edits or Runtime rebuild. */
export function captureAbsRuntimeContracts(
  workspace: Blockly.Workspace, serialized: AbsAbiWorkspace, assertCurrent: () => void, definitions?: DeclarativeBlockSnapshot,
): { contracts: AbsProjectionContracts; fieldDefinition: (type: string, field: string, id?: string) => AbsFieldDefinition | undefined } {
  assertCurrent();
  const states = indexAbsAbi(serialized);
  const contracts: AbsProjectionContracts = { fields: Object.create(null) };
  const declared = definitions && captureAbsDeclarativeContracts(definitions);
  for (const block of workspace.getAllBlocks(false)) {
    const state = states.get(block.id);
    if (!state) continue;
    const fields: Record<string, AbsFieldDefinition> = Object.create(null);
    for (const input of block.inputList) {
      for (const field of input.fieldRow) {
        if (!field.name || field.SERIALIZABLE === false) continue;
        try {
          fields[field.name] = captureAbsFieldContract(field, state.fields?.[field.name]);
        } catch (error) {
          throw new AbsSyncError('ABS_FIELD_CONTRACT_UNAVAILABLE', `${block.type}.${field.name}: ${String(error)}`, undefined, [block.id]);
        }
        assertCurrent();
      }
    }
    contracts.fields[block.id] = fields;
    // Static JSON provides original args order; visual inputList order is not equivalent.
    const shape = declared?.get(block.type, state.extraState, state.fields);
    const native = definitions?.nativeStructure?.(block);
    const declaration = definitions?.get(block.type) ?? definitions?.nativeJson?.(block);
    const order = shape?.argumentOrder ?? (native ? nativeAbsArgumentOrder(declaration ?? { type: block.type }, native) : undefined);
    if (order && Object.keys(fields).every(name => order.some(arg => arg.kind === 'field' && arg.name === name))
      && Object.keys(state.inputs ?? {}).every(name => order.some(arg => arg.kind !== 'field' && arg.name === name))) {
      (contracts.syntax ??= Object.create(null))[block.id] = order;
      if (shape?.fieldShape) (contracts.selectors ??= Object.create(null))[block.id] = [...new Set(shape.fieldShape.map(rule => rule.field))];
      else if (!shape && declaration && native) {
        const selectors = Object.keys(declaration).filter(key => /^args\d+$/.test(key))
          .sort((a, b) => Number(a.slice(4)) - Number(b.slice(4))).flatMap(key => declaration[key])
          // A plain enum does not configure native shape. Only validator-bearing
          // selectors constrain captured variants; reading the callback never runs it.
          .filter(arg => arg?.type === 'field_dropdown' && fields[arg.name]
            && block.getField(arg.name)?.getValidator()).map(arg => arg.name);
        if (selectors.length) (contracts.selectors ??= Object.create(null))[block.id] = selectors;
      }
    }
  }
  assertCurrent();
  return {
    contracts,
    fieldDefinition: (type, field, id) => {
      assertCurrent();
      if (!id) return undefined; // New blocks need host/static definitions, not another block's dynamic options.
      if (states.get(id)?.type !== type) throw new AbsSyncError('ABS_FIELD_CONTRACT_UNAVAILABLE', 'Field contract belongs to a different block.');
      return getAbsFieldDefinition(contracts, id, field);
    },
  };
}
