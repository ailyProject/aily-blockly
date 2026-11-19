import type { DeclarativeBlockSnapshot } from '../../../editors/blockly-editor/services/blockly-declarative-block-catalog';
import { captureAbsDeclarativeContracts } from './abs-declarative-contracts';
import { captureAbsCustomFunctions } from './abs-custom-functions';
import { captureAbsVariableDeclarations } from './abs-declaration-intents';

/** Discovery is advice, never an apply receipt. No instance, serializer or generator callbacks. */
export function captureAbsBlockCapabilities(snapshot: DeclarativeBlockSnapshot, nativeValidation = false) {
  const shapes = captureAbsDeclarativeContracts(snapshot);
  const custom = captureAbsCustomFunctions(snapshot);
  const declare = captureAbsVariableDeclarations(snapshot, shapes.get);
  return (type: string) => {
    snapshot.assertCurrent();
    if (!snapshot.registered(type)) return { type, level: 'unavailable' as const, reason: 'not-registered' };
    const customFunction = custom.describe(type)?.protocol;
    if (customFunction) return { type, level: 'reshape' as const, contract: 'library-custom-functions-v1', customFunction };
    const procedure = snapshot.procedure?.(type);
    if (procedure) return { type, level: 'reshape' as const, contract: 'bundled-procedures-v1', procedure };
    const shape = shapes.get(type);
    if (!shape) return nativeValidation
      ? { type, level: 'validate' as const, contract: 'native-sync-v1', reason: 'candidate-validation-required' }
      : { type, level: 'preserve-only' as const, reason: 'no-prepared-shape-contract' };
    // Defaults can contain large payloads; discovery needs field constraints and connection kinds only.
    const { defaults, ...constraints } = shape;
    if (shape.mutation) return { type, level: 'reshape' as const, contract: 'structural-mutator-v1', shape: constraints };
    if (shape.fieldShape) {
      // Native redundant XML is an internal preparation detail, not another Agent input.
      const { extraState, fieldShape, ...fieldConstraints } = constraints;
      return { type, level: 'reshape' as const, contract: 'field-shape-v1', shape: {
        ...fieldConstraints, fieldShape: fieldShape!.map(({ mutationAttribute, mutationNamespace, afterInput, ...rule }) => rule),
      } };
    }
    const declaration = declare(type);
    return { type, level: 'create' as const, contract: 'declarative-v1', shape: constraints, ...(declaration ? { declaration } : {}) };
  };
}

export function describeAbsBlockCapability(snapshot: DeclarativeBlockSnapshot, type: string, nativeValidation = false) {
  return captureAbsBlockCapabilities(snapshot, nativeValidation)(type);
}
