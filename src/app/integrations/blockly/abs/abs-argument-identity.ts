import type { AbsArgumentDefinition } from './abs-syntax-binding';

/** Blockly fields and inputs have separate namespaces. Value and statement
 * connections, however, share the input namespace. This is internal identity,
 * not a new ABS spelling or a block-name-specific exception. */
export const absArgumentKey = (arg: AbsArgumentDefinition): string =>
  `${arg.kind === 'field' ? 'field' : 'input'}:${arg.name}`;

export function hasUniqueAbsArguments(args: readonly AbsArgumentDefinition[]): boolean {
  return new Set(args.map(absArgumentKey)).size === args.length;
}
