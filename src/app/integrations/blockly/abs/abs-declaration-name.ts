// Core ordinary declarations emit their name as a C++ identifier, without
// Blockly.Names sanitization. Keep the actual model spelling; never rename it.
const keywords = new Set(`alignas alignof and and_eq asm auto bitand bitor bool break case catch char char8_t char16_t char32_t class compl concept const consteval constexpr constinit const_cast continue co_await co_return co_yield decltype default delete do double dynamic_cast else enum explicit export extern false float for friend goto if inline int long mutable namespace new noexcept not not_eq nullptr operator or or_eq private protected public register reinterpret_cast requires return short signed sizeof static static_assert static_cast struct switch template this thread_local throw true try typedef typeid typename union unsigned using virtual void volatile wchar_t while xor xor_eq`.split(' '));

/** A literal identifier only. No scope expressions, punctuation or implicit
 * normalization; retained declarations follow the existing identity checks. */
export function ordinaryDeclarationNameProblem(name: string): string | undefined {
  if (!name || name.length > 256) return 'identifier-length';
  if (!/^[\p{ID_Start}_][\p{ID_Continue}_]*$/u.test(name)) return 'identifier-characters';
  if (keywords.has(name)) return 'reserved-identifier';
  return undefined;
}
