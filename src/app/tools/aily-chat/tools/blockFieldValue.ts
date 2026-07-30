/**
 * Preserve structured values produced by ABS @json fields. Blockly variable
 * fields are the one special case whose serialized descriptor must be mapped
 * back to an id/name before setFieldValue is called.
 */
export function prepareBlockFieldValue(field: any, value: any): any {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return String(value);

  const isVariableField = typeof field?.getVariable === 'function';
  if (isVariableField) {
    if (typeof value.id === 'string' && value.id) return value.id;
    if (typeof value.name === 'string' && value.name) return value.name;
    return JSON.stringify(value);
  }
  return value;
}
