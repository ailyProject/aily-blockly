import * as Blockly from 'blockly';

export type RuntimeBlockArgumentKind = 'field' | 'valueInput' | 'statementInput';

export interface RuntimeBlockMetadata {
  type: string;
  library: string;
  fieldNames: string[];
  fieldTypes: Record<string, string>;
  valueInputNames: string[];
  statementInputNames: string[];
  argsOrder: Array<{ name: string; kind: RuntimeBlockArgumentKind }>;
  hasOutput: boolean;
  outputType?: string | string[];
  hasPrevious: boolean;
  hasNext: boolean;
  isRootBlock: boolean;
  mutator?: string;
  raw: Record<string, unknown>;
}

const FIELD_TYPES: Array<[string, unknown]> = [
  ['field_variable', (Blockly as any).FieldVariable],
  ['field_dropdown', (Blockly as any).FieldDropdown],
  ['field_number', (Blockly as any).FieldNumber],
  ['field_input', (Blockly as any).FieldTextInput],
  ['field_checkbox', (Blockly as any).FieldCheckbox],
  ['field_label_serializable', (Blockly as any).FieldLabelSerializable],
];

function runtimeFieldType(field: any): string {
  for (const [type, constructor] of FIELD_TYPES) {
    if (typeof constructor === 'function' && field instanceof (constructor as new (...args: any[]) => unknown)) {
      return type;
    }
  }
  return 'field_custom';
}

export interface RuntimeFieldContract {
  type: string;
  options?: Array<[unknown, string | number | boolean]>;
  min?: number;
  max?: number;
  precision?: number;
  valueType?: 'string' | 'number' | 'boolean' | 'json';
  variableTypes?: string[];
}

/** Actual field contract, not a field-name heuristic or a probe block's defaults. */
export function serializeRuntimeFieldContract(field: any, serializedValue?: unknown): RuntimeFieldContract {
  let type = runtimeFieldType(field);
  // Custom serializers may return structured state even when extending a text/dropdown widget.
  if (serializedValue !== null && typeof serializedValue === 'object' && type !== 'field_variable') type = 'field_custom';
  const result: RuntimeFieldContract = { type };
  if (type === 'field_variable' && Array.isArray(field.variableTypes)) result.variableTypes = [...field.variableTypes];
  if (type === 'field_dropdown') {
    const options: unknown = field.getOptions(false);
    if (!Array.isArray(options)) throw new Error('Dropdown options are not an array.');
    result.options = options.filter(option => option !== 'separator').map(option => {
      if (!Array.isArray(option) || option.length < 2 || !['string', 'number', 'boolean'].includes(typeof option[1])) {
        throw new Error('Dropdown option has an invalid serialized value.');
      }
      // Labels may be DOM/images and are not needed for validating the stored option value.
      return [typeof option[0] === 'string' ? option[0] : null, option[1]];
    });
  }
  if (type === 'field_number') {
    for (const [key, method] of [['min', 'getMin'], ['max', 'getMax'], ['precision', 'getPrecision']] as const) {
      const value = field[method]();
      if (Number.isFinite(value)) result[key] = value;
    }
  }
  if (type === 'field_custom') {
    const valueType = typeof serializedValue;
    result.valueType = valueType === 'string' || valueType === 'number' || valueType === 'boolean' ? valueType : 'json';
  }
  return result;
}

export function changedRuntimeBlockTypes(
  before: Map<string, unknown>,
  after: Record<string, unknown>,
): string[] {
  return Object.entries(after)
    .filter(([type, definition]) => before.get(type) !== definition)
    .map(([type]) => type)
    .sort();
}

export function serializeRuntimeBlockMetadata(
  type: string,
  library: string,
  block: any,
): RuntimeBlockMetadata {
  const fieldNames: string[] = [];
  const fieldTypes: Record<string, string> = {};
  const valueInputNames: string[] = [];
  const statementInputNames: string[] = [];
  const argsOrder: RuntimeBlockMetadata['argsOrder'] = [];
  const rawArgs: Array<Record<string, unknown>> = [];

  for (const input of block?.inputList || []) {
    for (const field of input?.fieldRow || []) {
      if (!field?.name || field.SERIALIZABLE === false) {
        continue;
      }
      const contract = serializeRuntimeFieldContract(field);
      const fieldType = contract.type;
      fieldNames.push(field.name);
      fieldTypes[field.name] = fieldType;
      argsOrder.push({ name: field.name, kind: 'field' });
      rawArgs.push({
        ...contract,
        name: field.name,
      });
    }

    const inputName = typeof input?.name === 'string' ? input.name : '';
    if (!inputName || !input.connection) {
      continue;
    }
    if (input.connection.type === 1) {
      valueInputNames.push(inputName);
      argsOrder.push({ name: inputName, kind: 'valueInput' });
      rawArgs.push({ type: 'input_value', name: inputName });
    } else if (input.connection.type === 3) {
      statementInputNames.push(inputName);
      argsOrder.push({ name: inputName, kind: 'statementInput' });
      rawArgs.push({ type: 'input_statement', name: inputName });
    }
  }

  const outputType = block?.outputConnection?.getCheck?.() || undefined;
  const hasOutput = !!block?.outputConnection;
  const hasPrevious = !!block?.previousConnection;
  const hasNext = !!block?.nextConnection;
  const mutator = typeof block?.saveExtraState === 'function' ? 'runtime_dynamic' : undefined;
  const raw: Record<string, unknown> = {
    type,
    args0: rawArgs,
    ...(hasOutput ? { output: outputType || null } : {}),
    ...(hasPrevious ? { previousStatement: null } : {}),
    ...(hasNext ? { nextStatement: null } : {}),
    ...(mutator ? { mutator } : {}),
  };

  return {
    type,
    library,
    fieldNames,
    fieldTypes,
    valueInputNames,
    statementInputNames,
    argsOrder,
    hasOutput,
    ...(outputType ? { outputType } : {}),
    hasPrevious,
    hasNext,
    isRootBlock: !hasOutput && !hasPrevious && !hasNext,
    ...(mutator ? { mutator } : {}),
    raw,
  };
}
