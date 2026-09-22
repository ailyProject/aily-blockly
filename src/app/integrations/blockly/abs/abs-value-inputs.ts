import { readAbsFieldToken, AbsFieldToken } from './abs-field-values';
import type { AbsSyntaxOptions } from './abs-syntax';
import { AbsSourceRange, AbsSyntaxNode, AbsSyncError } from './abs-state';

/** Compatibility spelling only. A field literal never passes through this function. */
export function expandAbsValueInput(token: AbsFieldToken, range: AbsSourceRange, options: AbsSyntaxOptions): AbsSyntaxNode | null {
  if (token.omitted) throw new AbsSyncError('ABS_SYNTAX_INVALID', 'An empty value argument is ambiguous; use null for an unconnected input.', range);
  if (token.value === null) return null;
  if (!token.quoted && !token.reference && typeof token.value === 'string' && /^[A-Za-z_]\w*$/.test(token.value)
    && options.argumentOrder?.(token.value)?.length === 0) {
    return { type: token.value, fields: {}, fieldRanges: {}, inputs: Object.create(null), disabled: false, start: range.start, end: range.end };
  }
  let type: string, name: string, value = token;
  if (token.reference) { type = 'variables_get'; name = 'VAR'; }
  else if (typeof token.value === 'number') { type = 'math_number'; name = 'NUM'; }
  // Keep booleans typed: the shared field resolver selects the actual dropdown value.
  else if (typeof token.value === 'boolean') { type = 'logic_boolean'; name = 'BOOL'; }
  else if (token.quoted && typeof token.value === 'string') { type = 'text'; name = 'TEXT'; }
  else if (!token.quoted && ['HIGH', 'LOW'].includes(token.value as string)) {
    type = 'math_number'; name = 'NUM'; value = readAbsFieldToken(token.value === 'HIGH' ? '1' : '0');
  } else throw new AbsSyncError('ABS_SYNTAX_INVALID', 'A value input requires a block expression or a supported literal.', range);
  const order = options.argumentOrder?.(type), field = options.fieldDefinition?.(type, name);
  if (order?.length !== 1 || order[0].kind !== 'field' || order[0].name !== name || !field
    || token.reference && field.symbol?.kind !== 'variable') {
    throw new AbsSyncError('ABS_SYNTAX_INVALID', `Value shorthand requires the host ${type} contract; use an explicit supported value block.`, range);
  }
  const source = { start: range.start, end: range.end };
  return { type, fields: { [name]: value }, fieldRanges: { [name]: source }, inputs: Object.create(null), disabled: false, ...source };
}
