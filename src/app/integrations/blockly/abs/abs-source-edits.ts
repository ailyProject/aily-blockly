import { absJson } from './abs-identity-map';
import { readAbsFieldToken } from './abs-field-values';
import type { AbsLiteralBinding } from './abs-reconciler';
import { readAbsStatePath } from './abs-state-path';
import { AbsSyncError } from './abs-state';

export interface AbsBoundValueReplacement { readonly jsonPointer: string; readonly value: unknown }

/** Exact AST/ABI bindings only. Equal text elsewhere, comments and inherited state are not targets. */
export function replaceAbsBoundValues(
  source: string, draft: unknown, bindings: readonly AbsLiteralBinding[], replacements: readonly AbsBoundValueReplacement[],
): string {
  if (!replacements.length) return source;
  const fail = () => new AbsSyncError('ABS_DATA_LITERAL_REQUIRED',
    'Large value has no exact, unchanged ABS literal binding; source was retained.');
  const byPointer = new Map(bindings.map(binding => [binding.jsonPointer, binding]));
  if (byPointer.size !== bindings.length) throw fail();
  const edits = new Map<AbsLiteralBinding, { value: unknown; paths: string[] }>();
  for (const replacement of replacements) {
    // Also rejects invalid JSON Pointer escapes, never follows prototype properties.
    if (readAbsStatePath(draft, replacement.jsonPointer) === undefined) throw fail();
    let pointer = replacement.jsonPointer;
    while (!byPointer.has(pointer) && pointer) pointer = pointer.slice(0, pointer.lastIndexOf('/'));
    const binding = byPointer.get(pointer);
    if (!binding || !Number.isSafeInteger(binding.start) || !Number.isSafeInteger(binding.end)
      || binding.start < 0 || binding.end <= binding.start || binding.end > source.length) throw fail();
    let edit = edits.get(binding);
    if (!edit) {
      let value: unknown;
      try { value = readAbsFieldToken(source.slice(binding.start, binding.end)).value; }
      catch { throw fail(); }
      // Binding cannot be borrowed after field coercion, default inference or a stale source edit.
      if (absJson(value) !== absJson(readAbsStatePath(draft, pointer))) throw fail();
      edit = { value, paths: [] };
      edits.set(binding, edit);
    }
    const relative = replacement.jsonPointer.slice(pointer.length);
    if (edit.paths.some(path => path === relative || path.startsWith(relative + '/') || relative.startsWith(path + '/'))) throw fail();
    edit.paths.push(relative);
    const value = JSON.parse(absJson(replacement.value));
    if (!relative) edit.value = value;
    else {
      const parent = readAbsStatePath(edit.value, relative.slice(0, relative.lastIndexOf('/')));
      const key = relative.slice(relative.lastIndexOf('/') + 1).replace(/~1/g, '/').replace(/~0/g, '~');
      if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, key)) throw fail();
      Object.defineProperty(parent, key, { value, enumerable: true, configurable: true, writable: true });
    }
  }
  const parts: string[] = [];
  let offset = 0;
  for (const [binding, edit] of [...edits].sort(([left], [right]) => left.start - right.start)) {
    if (binding.start < offset) throw fail();
    parts.push(source.slice(offset, binding.start), JSON.stringify(edit.value));
    offset = binding.end;
  }
  parts.push(source.slice(offset));
  return parts.join('');
}
