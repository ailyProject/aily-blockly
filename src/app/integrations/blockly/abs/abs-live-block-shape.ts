/** Read-only structural metadata. Never construct a block to inspect its definition. */
export interface AbsLiveBlockShape {
  argsOrder: Array<{ name: string; kind: 'field' | 'valueInput' | 'statementInput' }>;
  fieldNames: string[];
  valueInputNames: string[];
  statementInputNames: string[];
  fieldVariableTypes: Record<string, string>;
  hasStatementInput: boolean;
}

function readBlockShape(block: any): AbsLiveBlockShape {
  const shape: AbsLiveBlockShape = {
    argsOrder: [], fieldNames: [], valueInputNames: [], statementInputNames: [],
    fieldVariableTypes: Object.create(null), hasStatementInput: false,
  };
  for (const input of block.inputList || []) {
    for (const field of input.fieldRow || []) {
      if (!field.name || !field.SERIALIZABLE) continue;
      shape.argsOrder.push({ name: field.name, kind: 'field' });
      shape.fieldNames.push(field.name);
      if (typeof field.getVariable === 'function') {
        // Only explicit constraints; getVariableTypes() can include unrelated workspace types.
        shape.fieldVariableTypes[field.name] = field.variableTypes?.[0] || field.defaultType || '';
      }
    }
    if (input.connection?.type === 1) {
      shape.argsOrder.push({ name: input.name, kind: 'valueInput' });
      shape.valueInputNames.push(input.name);
    } else if (input.connection?.type === 3) {
      shape.argsOrder.push({ name: input.name, kind: 'statementInput' });
      shape.statementInputNames.push(input.name);
    }
  }
  shape.hasStatementInput = shape.statementInputNames.length > 0;
  return shape;
}

/** An ID selects the actual mutator shape. Without an ID, only an unambiguous type is usable. */
export function queryLiveAbsBlockShape(blockType: string, blockId?: string): AbsLiveBlockShape | undefined {
  const workspace = (globalThis as any).Blockly?.getMainWorkspace?.();
  if (!workspace) return undefined;
  if (blockId) {
    const block = workspace.getBlockById(blockId);
    return block?.type === blockType ? readBlockShape(block) : undefined;
  }
  const blocks = workspace.getBlocksByType(blockType, false);
  if (!blocks.length) return undefined;
  const shape = readBlockShape(blocks[0]);
  const signature = JSON.stringify(shape);
  return blocks.slice(1).every((block: any) => JSON.stringify(readBlockShape(block)) === signature)
    ? shape : undefined;
}
