import type * as Blockly from 'blockly';
import type { AbsNativeBlock } from '../../../integrations/blockly/abs/abs-native-binding';
import { captureAbsFieldContract } from '../../../integrations/blockly/abs/abs-runtime-field-contract';
import { nativeAbsArgumentOrder } from '../../../integrations/blockly/abs/abs-native-arguments';
import type { NativeCandidateWorkspace } from './blockly-native-candidate-workspace';

/** Same live-instance evidence for explicit calls, visible defaults and dormant shadows. */
export function captureNativeBlock(execution: NativeCandidateWorkspace, declarations: Map<string, Record<string, any>>,
  block: Blockly.Block, state: AbsNativeBlock['seed']): AbsNativeBlock {
  const trace = execution.observer.readNativeBlockStructure(block);
  if (!trace || !state || state.id !== block.id || state.type !== block.type) throw new Error('Native candidate lost its declaration trace or identity.');
  const seed = structuredClone(state);
  const fields = Object.create(null), inputs = Object.create(null);
  for (const { input, fields: row } of trace) {
    for (const field of row) if (field.name && field.SERIALIZABLE !== false) fields[field.name] = captureAbsFieldContract(field, seed.fields?.[field.name]);
    if (input.connection) inputs[input.name] = input.connection.type === execution.native.ConnectionType.INPUT_VALUE ? 'value' : 'statement';
  }
  const argumentOrder = nativeAbsArgumentOrder(execution.observer.readNativeBlockJson(block) ?? declarations.get(block.type) ?? { type: block.type }, trace);
  if (!argumentOrder) throw new Error('Native candidate has an incomplete or ambiguous argument declaration.');
  if (Object.keys(fields).some(name => !Object.hasOwn(seed.fields ?? {}, name))) throw new Error('Native candidate has incomplete field serialization.');
  // Topology has separate ownership evidence; layout is always host-owned.
  delete seed.inputs; delete seed.next; delete seed['x']; delete seed['y'];
  return { id: block.id, type: block.type, seed,
    shape: { fields, defaults: structuredClone(seed.fields ?? {}), inputs, argumentOrder,
      output: !!block.outputConnection, previous: !!block.previousConnection, next: !!block.nextConnection,
      ...(Object.hasOwn(seed, 'extraState') ? { extraState: seed.extraState } : {}) } };
}
