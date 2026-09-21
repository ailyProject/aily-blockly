import { expandAbsValueInput } from './abs-value-inputs';
import { AbsSyncError, type AbsSyntaxNode } from './abs-state';
import type { AbsFieldDefinition, AbsFieldToken } from './abs-field-values';
import type { BlockMeta } from './block-definition.model';
import { hasUniqueAbsArguments } from './abs-argument-identity';

export type AbsArgumentDefinition = BlockMeta['argsOrder'][number];
export interface AbsSyntaxOptions {
  prepareExtraState?: (node: AbsRawNode) => unknown;
  argumentOrder?: (type: string, extraState?: unknown, fields?: Readonly<Record<string, unknown>>) => readonly AbsArgumentDefinition[] | undefined;
  fieldSelectors?: (type: string) => readonly string[] | undefined;
  fieldDefinition?: (type: string, name: string) => AbsFieldDefinition | undefined;
}

export interface AbsRawValue { token?: AbsFieldToken; child?: AbsRawNode; start: number; end: number }
export interface AbsRawNode {
  type: string;
  parameters: Array<AbsRawValue & { name?: string }>;
  sections: Array<{ name?: string; inline?: AbsRawValue; children: AbsRawNode[] }>;
  disabled: boolean;
  omittedParentheses?: true;
  extraState?: unknown;
  extraRange?: { start: number; end: number };
  start: number;
  end: number;
}

/** Traverse source calls without binding slots or executing any runtime callback. */
export function* walkAbsRawSyntax(roots: readonly AbsRawNode[], disabled = false): Generator<{ node: AbsRawNode; disabled: boolean }> {
  for (const node of roots) {
    const inactive = disabled || node.disabled;
    yield { node, disabled: inactive };
    for (const parameter of node.parameters) if (parameter.child) yield* walkAbsRawSyntax([parameter.child], inactive);
    for (const section of node.sections) {
      if (section.inline?.child) yield* walkAbsRawSyntax([section.inline.child], inactive);
      yield* walkAbsRawSyntax(section.children, inactive);
    }
  }
}

/** Optional per-instance consumer. Native consumers belong only in a disposable realm.
 * The normal parser uses the same binder without any runtime effects.
 */
export interface AbsInstanceBinding extends AbsSyntaxOptions {
  field?: (name: string, token: AbsFieldToken) => void;
  input?: (name: string, child: AbsSyntaxNode | null) => void;
}

export function bindAbsSyntax(raw: readonly AbsRawNode[], options: AbsSyntaxOptions = {},
  createBinding?: (node: AbsSyntaxNode) => AbsInstanceBinding): AbsSyntaxNode[] {
  const bindings = new WeakMap<AbsSyntaxNode, AbsInstanceBinding>();
  const fail = (node: { start: number; end: number }, message: string): never => {
    throw new AbsSyncError('ABS_SYNTAX_INVALID', message, { start: node.start, end: node.end });
  };
  const connect = (node: AbsSyntaxNode, name: string, child: AbsSyntaxNode | null) => {
    if (name === 'next') {
      if (node.next || !child) fail(node, 'Duplicate or empty @next.');
      node.next = child;
    } else {
      if (Object.hasOwn(node.inputs, name)) throw new AbsSyncError('ABS_SYNTAX_INVALID', `Duplicate input ${name}.`, node, [], {
        blockType: node.type, field: name, reason: 'duplicate-input',
        hint: `Input ${name} is already assigned. Supply it once: either in the call's positional/named arguments or in @${name}:, not both. Replace the existing argument rather than adding a second assignment.`,
      });
      node.inputs[name] = child;
    }
    bindings.get(node)?.input?.(name, child);
  };
  const chain = (children: AbsRawNode[], statements: boolean): AbsSyntaxNode | null => {
    if (!children.length) return null;
    if (!statements && children.length > 1) fail(children[1], 'A value input accepts one block, not a statement chain.');
    const head = bind(children[0]);
    let tail = head;
    for (const child of children.slice(1)) {
      if (tail.next) fail(child, 'A chain cannot have both an explicit and implicit next.');
      const next = bind(child); connect(tail, 'next', next); tail = next;
    }
    return head;
  };
  const bind = (raw: AbsRawNode): AbsSyntaxNode => {
    const node: AbsSyntaxNode = {
      type: raw.type, fields: Object.create(null), fieldRanges: Object.create(null), inputs: Object.create(null),
      disabled: raw.disabled, start: raw.start, end: raw.end,
    };
    if (Object.hasOwn(raw, 'extraState')) { node.extraState = raw.extraState; node.extraRange = raw.extraRange; }
    else {
      const prepared = options.prepareExtraState?.(raw);
      if (prepared !== undefined) node.extraState = prepared;
    }
    const alias = ({ number: 'math_number', var: 'variables_get' } as Record<string, string>)[node.type];
    if (alias && !options.argumentOrder?.(node.type) && options.argumentOrder?.(alias)) node.type = alias;
    if (raw.omittedParentheses) {
      const args = options.argumentOrder?.(node.type);
      if (!args || args.some(arg => arg.kind !== 'statementInput')) fail(raw, 'Only a known argument-free block may omit parentheses.');
    }
    const binding = createBinding?.(node);
    if (binding) bindings.set(node, binding);
    const current = { ...options, ...binding };
    const order = (values: Readonly<Record<string, unknown>> = {}) => current.argumentOrder?.(node.type, node.extraState,
      { ...values, ...Object.fromEntries(Object.entries(node.fields).map(([name, token]) => [name, token.value])) });
    const value = (parameter: AbsRawValue) => parameter.child ? bind(parameter.child)
      : expandAbsValueInput(parameter.token!, parameter, options);
    const selectors = new Set(current.fieldSelectors?.(node.type));
    const namedSelectors = Object.fromEntries(raw.parameters.filter(p => p.name && p.token && selectors.has(p.name)).map(p => [p.name!, p.token!.value]));
    let position = 0;
    for (const parameter of raw.parameters) {
      const args = order(namedSelectors);
      let name = parameter.name;
      let argument: AbsArgumentDefinition | undefined;
      if (name === undefined) {
        if (!args || !hasUniqueAbsArguments(args)) fail(parameter, 'Positional arguments require a complete, unambiguous definition.');
        argument = args!.filter(argument => argument.kind !== 'statementInput')[position++];
        name = argument?.name;
        if (name === undefined) fail(parameter, 'No positional field/value input is available; use a named section for statements.');
      } else {
        const matches = args?.filter(arg => arg.name === name);
        // A nested call denotes a value connection; a scalar chooses a field
        // when both namespaces exist. @NAME: explicitly addresses the input,
        // including literal shorthand. Neither spelling creates a new syntax.
        argument = matches?.find(arg => parameter.child ? arg.kind === 'valueInput' : arg.kind === 'field') ?? matches?.[0];
      }
      if (argument?.kind === 'valueInput') {
        connect(node, name, value(parameter));
      } else if (parameter.child) {
        if (argument) fail(parameter, `Argument ${name} is not a value input.`);
        connect(node, name, bind(parameter.child));
      } else {
        if (argument && argument.kind !== 'field') fail(parameter, `Argument ${name} requires a block input.`);
        if (Object.hasOwn(node.fields, name)) fail(parameter, `Duplicate argument ${name}.`);
        node.fields[name] = parameter.token!;
        node.fieldRanges[name] = { start: parameter.start, end: parameter.end };
        binding?.field?.(name, parameter.token!);
      }
    }
    for (const section of raw.sections) {
      if (section.name === undefined) {
        const slots = order()?.filter(argument => argument.kind === 'statementInput');
        const slot = slots?.length === 1 ? slots[0] : ['controls_if', 'controls_ifelse'].includes(node.type)
          ? slots?.find(slot => slot.name === 'DO0') : undefined;
        if (!slot) fail(node, 'An implicit body requires exactly one known statement input; use @NAME:.');
        connect(node, slot!.name, chain(section.children, true));
      } else {
        const args = order();
        const exact = args?.filter(argument => argument.name === section.name);
        const folded = args?.filter(argument => argument.name.toLowerCase() === section.name!.toLowerCase());
        const name = exact?.length || !folded?.length || new Set(folded.map(arg => arg.name)).size !== 1
          ? section.name : folded[0].name;
        const matches = args?.filter(argument => argument.name === name);
        const argument = matches?.find(argument => argument.kind !== 'field') ?? matches?.[0];
        if (argument?.kind === 'field') fail(node, `Argument ${section.name} is a field, not an input.`);
        if (section.inline && argument?.kind !== 'valueInput') fail(node, 'An inline section requires a known value input.');
        connect(node, name, section.inline ? value(section.inline) : chain(section.children, argument?.kind !== 'valueInput'));
      }
    }
    return node;
  };
  return raw.map(bind);
}
