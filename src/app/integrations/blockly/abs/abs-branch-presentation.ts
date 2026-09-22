import type { AbsArgumentDefinition } from './abs-syntax';

/** Presentation policy for the core branch constructs, not a second grammar or
 * a library shape adapter. Actual inputs still come from the captured contract. */
export function absBranchInputs(type: string, order: readonly AbsArgumentDefinition[] | undefined): string[] | undefined {
  const prefix = type === 'controls_if' || type === 'controls_ifelse' ? 'IF' : type === 'controls_switch' ? 'CASE' : undefined;
  if (!prefix || !order) return undefined;
  const inputs = order.filter(arg => arg.kind !== 'field');
  if (!inputs.some(arg => arg.name === prefix + '0' && arg.kind === 'valueInput')
    || !inputs.some(arg => arg.name === 'DO0' && arg.kind === 'statementInput')) return undefined;
  const indices = new Set<number>();
  for (const input of inputs) {
    const match = new RegExp(`^(?:${prefix}|DO)(\\d+)$`).exec(input.name);
    if (match) indices.add(Number(match[1]));
  }
  return [...(type === 'controls_switch' ? ['SWITCH'] : []),
    ...[...indices].sort((a, b) => a - b).flatMap(index => [prefix + index, 'DO' + index]),
    ...inputs.map(arg => arg.name)].filter((name, index, all) => all.indexOf(name) === index);
}
