import { absJson } from './abs-json';
import { indexAbsBlockActivity } from './abs-block-activity';
import { walkAbsRawSyntax, type AbsRawNode } from './abs-syntax-binding';
import { readAbsSyntax } from './abs-syntax';
import type { AbsHostBoundCall } from './abs-native-binding';
import type { AbsProjection, AbsSyntaxNode } from './abs-state';
import type { AbsArgumentDefinition } from './abs-syntax';

/** Candidate-local activity. A next link is a sibling, not an input ancestor. */
export function inactiveAbsSyntax(roots: readonly AbsSyntaxNode[]): ReadonlySet<AbsSyntaxNode> {
  const inactive = new Set<AbsSyntaxNode>();
  const pending = roots.map(node => ({ node, outer: false }));
  while (pending.length) {
    const { node, outer } = pending.pop()!;
    const disabled = outer || node.disabled;
    if (disabled) inactive.add(node);
    for (const child of Object.values(node.inputs)) if (child) pending.push({ node: child, outer: disabled });
    if (node.next) pending.push({ node: node.next, outer });
  }
  return inactive;
}

export function samePreservedAbsCall(before: AbsSyntaxNode, after: AbsSyntaxNode): boolean {
  const call = (node: AbsSyntaxNode) => ({ type: node.type, disabled: node.disabled,
    fields: Object.fromEntries(Object.entries(node.fields).map(([name, token]) => [name, { value: token.value, ...(token.reference ? { reference: token.reference } : {}) }])),
    extra: Object.hasOwn(node, 'extraState') ? [node.extraState] : [],
  });
  return absJson(call(before)) === absJson(call(after));
}

/** Only this call's scalar fields configure its own retained instance. Inputs
 * have separate identities/native evidence; their spelling/content must not
 * force execution of an unchanged inactive parent's unavailable providers. */
function ownCallKey(node: AbsRawNode, order?: readonly AbsArgumentDefinition[]): string | undefined {
  const fields: Record<string, unknown> = Object.create(null);
  const positional = order?.filter(argument => argument.kind !== 'statementInput');
  let position = 0;
  for (const parameter of node.parameters) {
    const matches = parameter.name === undefined ? undefined : order?.filter(argument => argument.name === parameter.name);
    const argument = parameter.name === undefined ? positional?.[position++]
      : matches?.find(argument => argument.kind === (parameter.child ? 'valueInput' : 'field')) ?? matches?.[0];
    const name = parameter.name ?? argument?.name;
    if (name === undefined || argument?.kind === 'statementInput' || parameter.child && argument?.kind === 'field') return undefined;
    if (parameter.child || argument?.kind === 'valueInput') continue;
    if (!parameter.token || Object.hasOwn(fields, name)) return undefined;
    fields[name] = { value: parameter.token.value,
      ...(parameter.token.reference ? { reference: parameter.token.reference } : {}) };
  }
  return absJson({ type: node.type, disabled: node.disabled, fields,
    extra: Object.hasOwn(node, 'extraState') ? [node.extraState] : [] });
}

/** Skip discovery callbacks only for unchanged dormant calls. This is parsing
 * coverage, not model/shape authority: the sole identity matcher subsequently
 * proves each preserved call still owns its exact inactive baseline instance. */
export function retainedInactiveAbsCalls(baseline: AbsProjection, syntax: readonly AbsRawNode[]): AbsHostBoundCall[] {
  const activity = indexAbsBlockActivity(baseline.workspace);
  const ids = new Map(baseline.map.nodes.map(node => [node.start, node.blockId]));
  const variants = new Map<string, Map<string, { order?: readonly AbsArgumentDefinition[]; calls: Map<string, AbsHostBoundCall> }>>();
  for (const { node } of walkAbsRawSyntax(readAbsSyntax(baseline.abs))) {
    const id = ids.get(node.start);
    if (!id || activity.get(id) !== false) continue;
    const call: AbsHostBoundCall = { start: 0, type: node.type, preserveInactive: true,
      ...(baseline.contracts.syntax?.[id] ? { argumentOrder: baseline.contracts.syntax[id] } : {}),
      ...(Object.hasOwn(node, 'extraState') ? { extraState: node.extraState } : {}) };
    const signature = ownCallKey(node, call.argumentOrder);
    if (signature === undefined) continue; // Unknown positional syntax is never guessed.
    let type = variants.get(node.type);
    if (!type) variants.set(node.type, type = new Map());
    const orderKey = absJson(call.argumentOrder ?? null);
    let variant = type.get(orderKey);
    if (!variant) type.set(orderKey, variant = { order: call.argumentOrder, calls: new Map() });
    variant.calls.set(signature, call);
  }
  return [...walkAbsRawSyntax(syntax)].flatMap(({ node, disabled }) => {
    if (!disabled) return [];
    let matched: AbsHostBoundCall | undefined;
    for (const variant of variants.get(node.type)?.values() ?? []) {
      const signature = ownCallKey(node, variant.order), call = signature === undefined ? undefined : variant.calls.get(signature);
      if (!call) continue;
      if (matched && absJson(matched) !== absJson(call)) return []; // Ambiguous captured orders still need native discovery.
      matched = call;
    }
    return matched ? [{ ...matched, start: node.start }] : [];
  });
}
