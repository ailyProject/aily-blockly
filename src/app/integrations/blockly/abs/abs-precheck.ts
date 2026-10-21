import { readAbsSyntax, type AbsSyntaxOptions } from './abs-syntax';
import { bindAbsSyntax, walkAbsRawSyntax, type AbsRawNode } from './abs-syntax-binding';
import { resolveAbsFieldValue } from './abs-field-values';
import { AbsSyncError } from './abs-state';
import { serializeAbsFailure, type AbsFailure } from './abs-diagnostics';
import type { AbsBlockShapeContract } from './abs-declarative-contracts';
import { prepareAbsStructuralSyntax } from './abs-structural-syntax';

export interface AbsAuthoringContracts extends AbsSyntaxOptions {
  blockContract(type: string, extra?: unknown, fields?: Readonly<Record<string, unknown>>): AbsBlockShapeContract | undefined;
  knownType?(type: string): boolean;
  /** Function/model adapters may require request-bound identities not prepared yet. */
  deferType?(type: string): boolean;
}
export interface AbsPrecheckResult {
  ok: boolean;
  scope: 'static-precheck';
  nativeValidationRequired: true;
  diagnostics: Array<AbsFailure & { line: number; column: number }>;
  deferredTypes: string[];
  truncated: boolean;
}
export class AbsPrecheckFailure extends AbsSyncError {
  constructor(readonly precheck: AbsPrecheckResult) {
    super('ABS_PRECHECK_FAILED', `${precheck.diagnostics.length} static ABS error(s); no native preparation or application started.`,
      precheck.diagnostics[0]?.range, [], { hint: 'Correct all reported diagnostics in the same candidate, then apply once. Static checks do not replace native validation.' });
  }
}

/** Use the same attested mutator recipes as reconciliation, including implicit
 * IF/ELSE slots and variable-length value lists. Never guess library shapes. */
export function authoringExtraState(node: AbsRawNode, contracts: AbsAuthoringContracts): unknown {
  if (Object.hasOwn(node, 'extraState')) return node.extraState;
  const prepared = contracts.prepareExtraState?.(node);
  if (prepared !== undefined) return prepared;
  const shape = contracts.blockContract(node.type);
  return prepareAbsStructuralSyntax(node, shape?.mutation, shape?.argumentOrder);
}

/** Check independent nodes against the same parser/binder/contracts as apply.
 * No parser recovery after a lexical failure: guessing boundaries can misdiagnose
 * multiline strings or attach a branch to the wrong parent. Unknown dynamic
 * shapes remain deferred to the authoritative native candidate, never rejected. */
export function precheckAbs(source: string, contracts: AbsAuthoringContracts): AbsPrecheckResult {
  const result: AbsPrecheckResult = { ok: true, scope: 'static-precheck', nativeValidationRequired: true,
    diagnostics: [], deferredTypes: [], truncated: false };
  const deferred = new Set<string>();
  const report = (error: unknown, node?: { start: number; end: number }) => {
    result.ok = false;
    if (result.diagnostics.length >= 64) { result.truncated = true; return; }
    const failure = serializeAbsFailure(error);
    const position = failure.range ?? node ?? { start: 0, end: 0 };
    const range = { start: position.start, end: position.end };
    result.diagnostics.push({ ...failure, range, line: source.slice(0, range.start).split('\n').length,
      column: range.start - source.lastIndexOf('\n', range.start - 1) });
  };
  const fail = (message: string, node: { start: number; end: number }) => report(new AbsSyncError('ABS_SYNTAX_INVALID', message, node));
  let roots: AbsRawNode[];
  try { roots = readAbsSyntax(source); } catch (error) { report(error); return result; }
  // A placeholder retains connection cardinality while each real child is checked
  // separately. It has no fields, callbacks or workspace/model identity.
  const placeholder = (node: AbsRawNode): AbsRawNode => ({ type: '__precheck_child', parameters: [], sections: [], disabled: false, start: node.start, end: node.end });
  for (const { node } of walkAbsRawSyntax(roots)) {
    if (result.truncated) break;
    try {
      if (contracts.deferType?.(node.type)) { deferred.add(node.type); continue; }
      const extra = authoringExtraState(node, contracts);
      const selectors = Object.fromEntries(node.parameters.filter(p => p.name && p.token).map(p => [p.name!, p.token!.value]));
      // Resolve positional field selectors through the real binder before asking
      // for the final shape. Definitions with no pure order are native-only.
      const initial = contracts.blockContract(node.type, extra, selectors);
      const order = contracts.argumentOrder?.(node.type, extra, selectors) ?? initial?.argumentOrder;
      if (!initial || !order) {
        if (contracts.knownType && !contracts.knownType(node.type) && !['number', 'var'].includes(node.type)) fail(`Unknown block type ${node.type}.`, node);
        else deferred.add(node.type);
        continue;
      }
      const shallow: AbsRawNode = { ...node, parameters: node.parameters.map(p => p.child ? { ...p, child: placeholder(p.child) } : p),
        sections: node.sections.map(s => ({ ...s, children: s.children.map(placeholder),
          ...(s.inline?.child ? { inline: { ...s.inline, child: placeholder(s.inline.child) } } : {}) })) };
      const [bound] = bindAbsSyntax([shallow], { ...contracts,
        prepareExtraState: raw => raw.type === node.type ? extra : undefined,
        argumentOrder: (type, state, fields) => type === node.type
          ? contracts.argumentOrder?.(type, state, fields) ?? contracts.blockContract(type, state, fields)?.argumentOrder : undefined });
      const shape = contracts.blockContract(node.type, bound.extraState, Object.fromEntries(Object.entries(bound.fields).map(([name, token]) => [name, token.value])));
      if (!shape) { deferred.add(node.type); continue; }
      for (const [name, token] of Object.entries(bound.fields)) {
        const location = bound.fieldRanges[name] ?? node;
        if (!Object.hasOwn(shape.fields, name)) { fail(`Unknown field ${name} on ${node.type}.`, location); continue; }
        const definition = shape.fields[name];
        try {
          if (definition.symbol) {
            if (typeof token.value !== 'string' || !token.value) throw new Error('A model field requires a nonempty name.');
          } else resolveAbsFieldValue(token, definition);
        } catch (error) {
          report(error instanceof AbsSyncError ? error : new AbsSyncError('ABS_FIELD_INVALID', String(error), location), location);
        }
      }
      for (const name of Object.keys(bound.inputs)) {
        if (!Object.hasOwn(shape.inputs, name)) fail(`Unknown input @${name} on ${node.type}; check which parent owns this section and its indentation.`, node);
      }
    } catch (error) { report(error, node); }
  }
  result.deferredTypes = [...deferred].slice(0, 64);
  return result;
}
