import type { StructuralMutationRecipe } from '../../../editors/blockly-editor/components/blockly/plugins/block-plus-minus/src/structural-mutators';
import type { AbsArgumentDefinition, AbsRawNode } from './abs-syntax-binding';
import { AbsSyncError } from './abs-state';

/** The bundled serializer contract, shared by shape preparation and syntax sugar. */
export function structuralExtraState(recipe: StructuralMutationRecipe, count: number, enabled: boolean | undefined, declaredOptional: boolean): Record<string, unknown> | undefined {
  const extra: Record<string, unknown> = {};
  if (recipe.serialization !== 'sparse' || count !== 0) extra[recipe.count] = count;
  if (recipe.optional && (recipe.serialization !== 'sparse' || enabled !== false || declaredOptional)) extra[recipe.optional.key] = enabled;
  const empty = recipe.serialization === 'sparse' ? !Object.keys(extra).length
    : recipe.serialization === 'all' && count === 0 && enabled === recipe.optional?.default;
  return empty ? undefined : extra;
}

/** Only an attested repeated-input recipe may derive state from source slots.
 * Explicit @extra wins, including empty/sparse shapes; unknown mutators stay opaque.
 * This is a pure source operation, not a probe block or a library callback. */
export function prepareAbsStructuralSyntax(node: AbsRawNode, recipe: StructuralMutationRecipe | undefined,
  arguments_: readonly AbsArgumentDefinition[] | undefined): unknown {
  if (Object.hasOwn(node, 'extraState') || !recipe || !arguments_) return node.extraState;
  const fail = (message: string): never => { throw new AbsSyncError('ABS_SYNTAX_INVALID', message, node); };
  const index = (name: string): number | undefined => {
    for (const input of recipe.repeated) {
      if (!name.toLowerCase().startsWith(input.prefix.toLowerCase())) continue;
      const suffix = name.slice(input.prefix.length);
      if (!/^(0|[1-9]\d*)$/.test(suffix)) continue;
      const number = Number(suffix);
      if (number < recipe.start) continue;
      if (!Number.isSafeInteger(number) || number - recipe.start >= 1024) fail('Repeated input exceeds the structural budget.');
      return number - recipe.start;
    }
    return undefined;
  };
  const fixed = arguments_.filter(arg => arg.kind !== 'statementInput' && index(arg.name) === undefined).length;
  const width = recipe.repeated.filter(arg => arg.kind === 'valueInput').length;
  const positional = node.parameters.filter(parameter => parameter.name === undefined).length;
  const countFromPosition = width ? Math.ceil(Math.max(0, positional - fixed) / width) : 0;
  const used = new Set(Array.from({ length: countFromPosition }, (_, i) => i));
  const names = [...node.parameters.map(parameter => parameter.name), ...node.sections.map(section => section.name)];
  for (const name of names) if (name !== undefined) {
    const ordinal = index(name);
    if (ordinal !== undefined) used.add(ordinal);
  }
  const count = used.size ? Math.max(...used) + 1 : 0;
  if (count > 1024 || used.size !== count) fail('Repeated inputs must be contiguous; use explicit @extra to preserve empty slots.');
  const declaredOptional = !!recipe.optional && arguments_.some(arg => arg.name === recipe.optional!.input);
  const enabled = recipe.optional ? declaredOptional || names.some(name => name?.toLowerCase() === recipe.optional!.input.toLowerCase()) : undefined;
  return structuralExtraState(recipe, count, enabled, declaredOptional);
}
