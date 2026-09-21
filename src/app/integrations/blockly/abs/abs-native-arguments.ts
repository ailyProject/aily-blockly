import type { NativeInputDeclaration } from '../../../editors/blockly-editor/services/blockly-native-structure';
import { parseBlockDefinition } from './block-definition.model';
import type { AbsArgumentDefinition } from './abs-syntax';
import { absArgumentKey as key, hasUniqueAbsArguments } from './abs-argument-identity';

/** Declared arguments keep their source positions; remaining dynamic arguments
 * follow in native order, as in the original converter and library ABS examples.
 * Visual insertion/move operations cannot shift a declared positional argument. */
export function nativeAbsArgumentOrder(json: Record<string, any>, trace: readonly NativeInputDeclaration[]): AbsArgumentDefinition[] | undefined {
  const source = parseBlockDefinition(json, '');
  if (!source) return undefined;
  const rows = trace.map(({ input, fields }) => {
    const args: AbsArgumentDefinition[] = fields.filter(field => field.name && field.SERIALIZABLE !== false)
      .map(field => ({ name: field.name!, kind: 'field' }));
    if (input.connection) {
      const kind = input.connection.type === 1 ? 'valueInput' : input.connection.type === 3 ? 'statementInput' : undefined;
      if (!kind) return undefined;
      args.push({ name: input.name, kind });
    }
    return args;
  });
  if (rows.some(row => !row)) return undefined;
  const native = rows.flat() as AbsArgumentDefinition[];
  if (!hasUniqueAbsArguments(native) || !hasUniqueAbsArguments(source.argsOrder)) return undefined;
  const active = new Set(native.map(key));
  const base = source.argsOrder.filter(arg => active.has(key(arg)));
  const baseKeys = new Set(base.map(key));
  return [...base, ...native.filter(arg => !baseKeys.has(key(arg)))];
}
