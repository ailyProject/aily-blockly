/** JSON boundaries shared by ABS syntax and resource discovery; no Blockly or I/O. */
export interface AbsJsonToken {
  start: number;
  end: number;
  value: unknown;
}

export class AbsTokenError extends Error {
  constructor(message: string, readonly offset: number) {
    super(`${message} at offset ${offset}.`);
    this.name = 'AbsTokenError';
  }
}

/** Single-quoted ABS text uses JSON escapes plus \'; never JavaScript evaluation. */
export function readAbsSingleQuotedToken(source: string, start: number): AbsJsonToken {
  if (source[start] !== "'") throw new AbsTokenError('Expected a single-quoted string', start);
  const parts: string[] = [];
  let segment = start + 1;
  for (let index = segment; index < source.length; index++) {
    const char = source[index];
    if (char === "'") {
      parts.push(source.slice(segment, index));
      return { start, end: index + 1, value: parts.join('') };
    }
    if (char.charCodeAt(0) < 32) throw new AbsTokenError('Unescaped control character in string', index);
    if (char !== '\\') continue;
    parts.push(source.slice(segment, index));
    const escaped = source[++index];
    if (escaped === "'") parts.push("'");
    else {
      const length = escaped === 'u' ? 5 : 1;
      const escape = source.slice(index, index + length);
      try { parts.push(JSON.parse('"\\' + escape + '"')); }
      catch { throw new AbsTokenError('Invalid string escape', index - 1); }
      index += length - 1;
    }
    segment = index + 1;
  }
  throw new AbsTokenError('Unterminated string', start);
}

export function readAbsJsonToken(source: string, start: number): AbsJsonToken {
  const first = source[start];
  if (first !== '"' && first !== '{' && first !== '[') {
    throw new AbsTokenError('Expected a JSON string, object or array', start);
  }
  const stack: string[] = [];
  let quoted = false;
  let escaped = false;
  for (let index = start; index < source.length; index++) {
    const char = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{' || char === '[') stack.push(char === '{' ? '}' : ']');
    else if (char === '}' || char === ']') {
      if (stack.pop() !== char) throw new AbsTokenError('Mismatched JSON delimiter', index);
    }
    if (!quoted && stack.length === 0) {
      try {
        return { start, end: index + 1, value: JSON.parse(source.slice(start, index + 1)) };
      } catch {
        throw new AbsTokenError('Malformed JSON literal', start);
      }
    }
  }
  throw new AbsTokenError('Unterminated JSON literal', start);
}

export function scanAbsJsonTokens(source: string): {
  tokens: AbsJsonToken[];
  errors: AbsTokenError[];
} {
  const tokens: AbsJsonToken[] = [];
  const errors: AbsTokenError[] = [];
  for (let index = 0; index < source.length;) {
    const char = source[index];
    if (char === '#') {
      const end = source.indexOf('\n', index);
      index = end < 0 ? source.length : end + 1;
    } else if (char === '"' || char === '{' || char === '[') {
      try {
        const token = readAbsJsonToken(source, index);
        tokens.push(token);
        index = token.end;
      } catch (error) {
        errors.push(error as AbsTokenError);
        // A broken string/container has no reliable subsequent token boundary.
        break;
      }
    } else if (char === "'") {
      // Legacy single-quoted strings are opaque, not resource containers.
      const start = index++;
      let closed = false;
      while (index < source.length) {
        const next = source[index++];
        if (next === '\\') index++;
        else if (next === "'") { closed = true; break; }
      }
      if (!closed) errors.push(new AbsTokenError('Unterminated string', start));
    } else index++;
  }
  return { tokens, errors };
}
