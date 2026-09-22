import { AilyDataRef, areAilyDataRefsEquivalent, assertAilyDataRef, ProjectDataError } from './project-data.types';

/** The field API accepts both native JSON values and serialized JSON state. */
export function projectDataFieldReference(fieldState: unknown, fieldName: string): AilyDataRef {
  if (typeof fieldState === 'string') {
    try { fieldState = JSON.parse(fieldState); }
    catch { throw new ProjectDataError('invalid-ref', `Field ${fieldName} does not contain valid JSON state.`); }
  }
  const refs = collectProjectDataReferences(fieldState);
  if (refs.length !== 1) throw new ProjectDataError('invalid-ref',
    `Field ${fieldName} must contain exactly one project data reference; received ${refs.length}.`);
  return refs[0];
}

/** Shared discovery for storage, GC and detached consumers; no filesystem access. */
export function collectProjectDataReferences(value: unknown): AilyDataRef[] {
  const refs = new Map<string, AilyDataRef>();
  const visited = new Set<object>();
  const pending: unknown[] = [value];
  while (pending.length) {
    const current = pending.pop();
    if (typeof current === 'string' && current.includes('$ailyData') && current.trim().startsWith('{')) {
      let parsed: unknown;
      try { parsed = JSON.parse(current); }
      catch (error) { throw new ProjectDataError('invalid-ref', 'String containing reserved $ailyData metadata is invalid JSON.', { cause: String(error) }); }
      pending.push(parsed); continue;
    }
    if (!current || typeof current !== 'object' || visited.has(current)) continue;
    visited.add(current);
    if (!Array.isArray(current) && Object.hasOwn(current, '$ailyData')) {
      assertAilyDataRef(current);
      const previous = refs.get(current.$ailyData.id);
      if (previous && !areAilyDataRefsEquivalent(previous, current)) {
        throw new ProjectDataError('corrupt', `Conflicting metadata for project data ID: ${current.$ailyData.id}`);
      }
      refs.set(current.$ailyData.id, current); continue;
    }
    const members = Object.values(current);
    for (let index = members.length - 1; index >= 0; index--) pending.push(members[index]);
  }
  return [...refs.values()];
}
