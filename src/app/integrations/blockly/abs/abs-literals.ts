/** Small lexical helpers for the legacy parser during the v2 cutover. */
export function isAbsEscaped(source: string, index: number): boolean {
  let backslashes = 0;
  while (index > 0 && source[--index] === '\\') backslashes++;
  return backslashes % 2 === 1;
}

/** Visit characters outside quoted strings; escaped quotes/backslashes are opaque. */
function findUnquoted(source: string, predicate: (char: string, index: number) => boolean): number {
  let quote = '';
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (quote) {
      if (char === quote && !isAbsEscaped(source, index)) quote = '';
    } else if (char === '"' || char === "'") quote = char;
    else if (predicate(char, index)) return index;
  }
  return -1;
}

export function stripAbsLineComment(source: string): string {
  const index = findUnquoted(source, char => char === '#');
  return index < 0 ? source : source.slice(0, index).trimEnd();
}

export function findAbsExtraAnnotation(source: string): number {
  let depth = 0;
  return findUnquoted(source, (char, index) => {
    if (char === '(' || char === '[' || char === '{') depth++;
    else if (char === ')' || char === ']' || char === '}') depth--;
    return depth === 0 && source.startsWith('@extra:', index);
  });
}
