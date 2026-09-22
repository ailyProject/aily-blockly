import type { StructuralMutationRecipe } from '../../../editors/blockly-editor/components/blockly/plugins/block-plus-minus/src/structural-mutators';
import type { AbsBlockShapeContract } from './abs-declarative-contracts';
import { AbsSyncError } from './abs-state';
import { structuralExtraState } from './abs-structural-syntax';

/** Detached structural state only; models and library side effects are not inferred. */
export function prepareAbsStructuralShape(base: AbsBlockShapeContract, recipe: StructuralMutationRecipe, state?: unknown): AbsBlockShapeContract {
  const fail = (message: string): never => { throw new AbsSyncError('ABS_RUNTIME_SHAPE_UNSUPPORTED', message); };
  const provided = state !== undefined && state !== null;
  if (provided && (typeof state !== 'object' || Array.isArray(state)
    || Object.keys(state).some(key => key !== recipe.count && key !== recipe.optional?.key))) fail('Unknown structural mutation state.');
  const value = (state ?? {}) as Record<string, unknown>;
  const count = Object.hasOwn(value, recipe.count) ? value[recipe.count] : recipe.initial;
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || count > 1024) fail('Mutation count must be an integer between 0 and 1024.');
  const option = recipe.optional;
  const enabled = option ? Object.hasOwn(value, option.key) ? value[option.key]
    : provided ? option.default : Object.hasOwn(base.inputs, option.input) : undefined;
  if (option && typeof enabled !== 'boolean') fail('Mutation flag must be boolean.');
  let order = [...base.argumentOrder!];
  if (recipe.replace) order = order.filter(arg => !recipe.repeated.some(input => arg.kind === input.kind && new RegExp('^' + input.prefix + '\\d+$').test(arg.name)));
  if (option) order = order.filter(arg => arg.name !== option.input);
  for (let i = 0; i < (count as number); i++) for (const input of recipe.repeated) {
    const name = input.prefix + (i + recipe.start);
    if (order.some(arg => arg.name === name)) fail('Mutation input collides with a declared argument.');
    order.push({ name, kind: input.kind });
  }
  if (option && enabled) order.push({ name: option.input, kind: 'statementInput' });
  const extraState = structuralExtraState(recipe, count as number, enabled as boolean | undefined, !!option && Object.hasOwn(base.inputs, option.input));
  const inputs = Object.fromEntries(order.filter(arg => arg.kind !== 'field').map(arg => [arg.name, arg.kind === 'valueInput' ? 'value' as const : 'statement' as const]));
  return { ...base, inputs, argumentOrder: order, ...(extraState === undefined ? {} : { extraState }),
    mutation: { ...recipe, maxCount: 1024 } };
}
