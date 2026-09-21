import type { AbsAbiWorkspace, AbsProjectionContracts } from './abs-state';
import { indexAbsAbi } from './abs-abi-index';
import type { AbsArgumentDefinition } from './abs-syntax-binding';
import type { DeclarativeBlockSnapshot } from '../../../editors/blockly-editor/services/blockly-declarative-block-catalog';
import { parseBlockDefinition } from './block-definition.model';
import type * as Blockly from 'blockly';
import { nativeAbsArgumentOrder } from './abs-native-arguments';

/** Read the current actual construction on every step: a selector can add fields. */
export function nativeFieldOrder(block: Blockly.Block, definitions: DeclarativeBlockSnapshot): string[] | undefined {
  definitions.assertCurrent();
  const json = definitions.get(block.type) ?? definitions.nativeJson?.(block) ?? { type: block.type };
  const trace = definitions.nativeStructure?.(block);
  const args = trace ? nativeAbsArgumentOrder(json, trace) : parseBlockDefinition(json, '')?.argsOrder;
  return args?.filter(arg => arg.kind === 'field').map(arg => arg.name);
}

function orderFields(block: Record<string, any>, order?: readonly AbsArgumentDefinition[]): void {
  const fields = block['fields'];
  if (!order || !fields || typeof fields !== 'object' || Array.isArray(fields)) return;
  const names = [...order.filter(arg => arg.kind === 'field').map(arg => arg.name), ...Object.keys(fields)];
  block['fields'] = Object.fromEntries([...new Set(names)].filter(name => Object.hasOwn(fields, name)).map(name => [name, fields[name]]));
}

/** Reorder only the detached loading view. Canonical ABI/map bytes remain unchanged. */
export function orderAbsNativeFields(state: AbsAbiWorkspace, contracts?: AbsProjectionContracts): void {
  for (const block of indexAbsAbi(state).values()) {
    orderFields(block, contracts?.syntax?.[block.id]);
  }
}
