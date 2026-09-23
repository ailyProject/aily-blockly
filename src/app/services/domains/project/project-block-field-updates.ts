import { cloneProjectDataJson, collectProjectBlocks } from './project-data/project-data-payloads';
import { ProjectDataError } from './project-data/project-data.types';
import { canonicalJsonStringify } from './project-data/project-data-codec.registry';

export type ProjectBlockFieldUpdates = Readonly<Record<string, string | number | boolean | { value: unknown; field?: string }>>;

/** Explicit block identities, never arbitrary object keys or library-specific fields. */
export function updateProjectBlockFields<T>(document: T, updates: ProjectBlockFieldUpdates) {
  const candidate = cloneProjectDataJson(document);
  const requested: ProjectBlockFieldUpdates = JSON.parse(canonicalJsonStringify(updates));
  if (!requested || typeof requested !== 'object' || Array.isArray(requested)) {
    throw new ProjectDataError('corrupt', 'Project field updates must be an object keyed by block ID.');
  }
  if (!Object.keys(requested).length) return { document: candidate, changed: false };
  const blocks = new Map<string, Record<string, unknown>>();
  for (const { state } of collectProjectBlocks(candidate)) {
    const id = state['id'];
    if (typeof id !== 'string') continue;
    if (blocks.has(id)) throw new ProjectDataError('corrupt', `Duplicate project block ID: ${id}`);
    blocks.set(id, state);
  }
  let changed = false;
  for (const [id, update] of Object.entries(requested)) {
    const block = blocks.get(id);
    if (!block) throw new ProjectDataError('corrupt', `Project field update targets an unknown block: ${id}`);
    let field = 'TEXT';
    let value: unknown = update;
    if (update !== null && typeof update === 'object') {
      if (Array.isArray(update) || !Object.hasOwn(update, 'value')
        || Object.keys(update).some(key => key !== 'value' && key !== 'field')) {
        throw new ProjectDataError('corrupt', `Invalid field update for block: ${id}`);
      }
      value = update.value;
      if (update.field !== undefined) field = update.field;
    } else if (!['string', 'number', 'boolean'].includes(typeof update)) {
      throw new ProjectDataError('corrupt', `Invalid field value for block: ${id}`);
    }
    if (typeof field !== 'string') throw new ProjectDataError('corrupt', `Invalid field name for block: ${id}`);
    const fields = block['fields'] ?? {};
    if (typeof fields !== 'object' || Array.isArray(fields)) throw new ProjectDataError('corrupt', `Invalid fields for block: ${id}`);
    if (!Object.hasOwn(fields, field) || JSON.stringify(fields[field]) !== JSON.stringify(value)) {
      Object.defineProperty(fields, field, { value, enumerable: true, writable: true, configurable: true });
      block['fields'] = fields;
      changed = true;
    }
  }
  return { document: candidate, changed };
}
