/** Encode data as one C++ string literal. ABS/ABI retain the original characters. */
export function cppStringLiteral(value: string): string {
  const escapes: Record<string, string> = { '"': '\\"', '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t' };
  return '"' + value.replace(/["\\\x00-\x1f\x7f]/g, char => escapes[char]
    ?? '\\' + char.charCodeAt(0).toString(8).padStart(3, '0')) + '"';
}
