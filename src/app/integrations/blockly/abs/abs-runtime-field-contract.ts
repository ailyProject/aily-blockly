import { serializeRuntimeFieldContract } from '../../../editors/blockly-editor/services/blockly-runtime-block-metadata';
import type { AbsFieldDefinition } from './abs-field-values';

/** The host and isolated realm describe the same native model-backed field protocol. */
export function captureAbsFieldContract(field: unknown, serializedValue?: unknown): AbsFieldDefinition {
  const { variableTypes, ...definition } = serializeRuntimeFieldContract(field, serializedValue);
  return { ...definition, ...(definition.type === 'field_variable' ? { symbol: {
    kind: 'variable' as const, storage: 'variable-state' as const,
    ...(variableTypes ? { allowedTypes: variableTypes } : {}),
  } } : {}) };
}
