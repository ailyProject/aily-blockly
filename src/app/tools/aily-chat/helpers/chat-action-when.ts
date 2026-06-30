export type ChatActionWhenContextValue = boolean | string | undefined;

export type ChatActionWhenContextMap = Record<string, ChatActionWhenContextValue>;

export function evaluateChatActionWhenClause(
  when: string | undefined,
  context: ChatActionWhenContextMap,
): boolean {
  if (!when) {
    return true;
  }

  return when
    .split('&&')
    .map(part => part.trim())
    .filter(part => part.length > 0)
    .every(part => evaluateChatActionWhenAtom(part, context));
}

function evaluateChatActionWhenAtom(atom: string, context: ChatActionWhenContextMap): boolean {
  if (atom.startsWith('!')) {
    return !readBooleanContextValue(context, atom.slice(1).trim());
  }

  const comparison = atom.match(/^([A-Za-z0-9_]+)\s*(==|!=)\s*(.+)$/);
  if (comparison) {
    const [, key, operator, rawExpected] = comparison;
    const actual = readContextValue(context, key);
    const expected = normalizeContextLiteral(rawExpected.trim());
    return operator === '==' ? actual === expected : actual !== expected;
  }

  return readBooleanContextValue(context, atom);
}

function readBooleanContextValue(context: ChatActionWhenContextMap, key: string): boolean {
  return readContextValue(context, key) === true;
}

function readContextValue(context: ChatActionWhenContextMap, key: string): ChatActionWhenContextValue {
  return key in context ? context[key] : undefined;
}

function normalizeContextLiteral(literal: string): ChatActionWhenContextValue {
  const trimmedLiteral = literal.replace(/^['"]|['"]$/g, '');
  if (trimmedLiteral === 'true') {
    return true;
  }
  if (trimmedLiteral === 'false') {
    return false;
  }

  return trimmedLiteral;
}