import type * as Blockly from 'blockly';
import { ConnectionType } from 'blockly/core';

/** Core ABS semantics: a for counter is a declaration, unlike an ordinary
 * field_variable consumer. Do not infer this capability from a field name or
 * grant it to arbitrary library blocks. The native shape must also agree. */
export function nativeLoopVariable(block: Blockly.Block): Blockly.FieldVariable | undefined {
  if (block.type !== 'controls_for' || !block.previousConnection || !block.nextConnection || block.outputConnection
    || !['FROM', 'TO', 'BY'].every(name => block.getInput(name)?.connection?.type === ConnectionType.INPUT_VALUE)
    || block.getInput('DO')?.connection?.type !== ConnectionType.NEXT_STATEMENT) return undefined;
  const field = block.getField('VAR') as Blockly.FieldVariable | null;
  return field && typeof field.getVariable === 'function'
    && (field.variableTypes === null || Array.isArray(field.variableTypes) && field.variableTypes.includes('')) ? field : undefined;
}
