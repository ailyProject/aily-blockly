/** Structured-clone transport has a much smaller nesting budget than JSON.parse.
 * Skip the worker round trip for deep statement graphs; strings and escaped
 * quotes must not contribute to this transport-only bound. Parsing still validates
 * the complete JSON, and project/payload admission keeps its separate limits. */
export function canTransferProjectAbi(content: string): boolean {
  let depth = 0, quoted = false, escaped = false;
  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if ((char === '{' || char === '[') && ++depth > 256) return false;
    else if (char === '}' || char === ']') depth--;
  }
  return true;
}
