import { isAilyDataRef, isAilyProjectDataValue, ProjectDataError } from './project-data.types';

export interface ProjectDataPayload {
  readonly owner: Record<string, unknown>;
  readonly key: string;
  readonly jsonPointer: string;
  readonly blockId?: string;
  readonly blockType?: string;
  readonly fieldName?: string;
}

export function projectDataChildPointer(parent: string, key: string): string {
  return `${parent}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`;
}

/** Serialization boundaries, not library/field names. Never replaces block graphs. */
export function collectProjectDataPayloads(document: unknown): ProjectDataPayload[] {
  const result: ProjectDataPayload[] = [];
  visitProjectDataDocument(document, payload => result.push(payload));
  return result;
}

export function collectProjectBlocks(document: unknown): Array<{ state: Record<string, unknown>; jsonPointer: string }> {
  const result: Array<{ state: Record<string, unknown>; jsonPointer: string }> = [];
  visitProjectDataDocument(document, () => {}, (state, jsonPointer) => result.push({ state, jsonPointer }));
  return result;
}

export interface ProjectBlockLocation {
  state: Record<string, unknown>;
  jsonPointer: string;
  /** Outermost connection whose stored shadow is covered by an actual block. */
  hiddenOwner?: string;
}

export function collectProjectBlockLocations(document: unknown): ProjectBlockLocation[] {
  const result: ProjectBlockLocation[] = [];
  visitProjectDataDocument(document, () => {}, (state, jsonPointer, hiddenOwner) => result.push({ state, jsonPointer, hiddenOwner }));
  return result;
}

function visitProjectDataDocument(document: unknown, onPayload: (payload: ProjectDataPayload) => void,
  onBlock: (state: Record<string, unknown>, pointer: string, hiddenOwner?: string) => void = () => {}): void {
  const seen = new WeakSet<object>();
  const record = (value: unknown): Record<string, unknown> | null => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (seen.has(value)) throw new ProjectDataError('corrupt', 'Project document contains a cycle or shared object.');
    seen.add(value);
    return value as Record<string, unknown>;
  };
  const add = (owner: Record<string, unknown>, key: string, pointer: string,
    context: Pick<ProjectDataPayload, 'blockId' | 'blockType' | 'fieldName'> = {}) => {
    onPayload({ owner, key, jsonPointer: projectDataChildPointer(pointer, key), ...context });
  };
  const block = (value: unknown, pointer: string) => {
    // Preserve depth-first serialization order without consuming the call stack
    // for long statement chains or deeply nested value/statement inputs.
    const pending: Array<{ value: unknown; pointer: string; connection: boolean; hiddenOwner?: string }> = [
      { value, pointer, connection: false },
    ];
    while (pending.length) {
      const { value, pointer, connection, hiddenOwner } = pending.pop()!;
      const state = record(value);
      if (!state) continue;
      if (connection) {
        if (state['shadow']) pending.push({ value: state['shadow'], pointer: `${pointer}/shadow`, connection: false,
          hiddenOwner: hiddenOwner ?? (state['block'] ? pointer : undefined) });
        if (state['block']) pending.push({ value: state['block'], pointer: `${pointer}/block`, connection: false, hiddenOwner });
        continue;
      }
      onBlock(state, pointer, hiddenOwner);
      const context = { blockId: state['id'] as string | undefined, blockType: state['type'] as string | undefined };
      const fields = record(state['fields']);
      if (fields) for (const fieldName of Object.keys(fields)) {
        add(fields, fieldName, `${pointer}/fields`, { ...context, fieldName });
      }
      for (const key of ['extraState', 'data', 'icons']) {
        if (Object.hasOwn(state, key)) add(state, key, pointer, context);
      }
      const inputs = record(state['inputs']);
      pending.push({ value: state['next'], pointer: `${pointer}/next`, connection: true, hiddenOwner });
      const entries = inputs ? Object.entries(inputs) : [];
      for (let index = entries.length - 1; index >= 0; index--) {
        const [name, value] = entries[index];
        pending.push({ value, pointer: projectDataChildPointer(`${pointer}/inputs`, name), connection: true, hiddenOwner });
      }
    }
  };
  const blocks = (values: unknown, pointer: string) => {
    if (Array.isArray(values)) values.forEach((value, index) => block(value, `${pointer}/${index}`));
  };
  const variables = (values: unknown, pointer: string) => {
    // Keep official model identities inline; extension payloads may be externalized.
    if (Array.isArray(values)) values.forEach((value, index) => {
      const model = record(value);
      if (model) for (const key of Object.keys(model)) {
        if (!['id', 'name', 'type'].includes(key)) add(model, key, `${pointer}/${index}`);
      }
    });
  };
  const workspace = (state: Record<string, unknown>, pointer: string) => {
    const graph = record(state['blocks']);
    if (graph) blocks(graph['blocks'], `${pointer}/blocks/blocks`);
    variables(state['variables'], `${pointer}/variables`);
    for (const key of Object.keys(state)) {
      // Each remaining top-level property is an opaque workspace serializer.
      // Do not infer block/model semantics from keys inside its payload.
      if (!['blocks', 'variables', '$ailyProjectData'].includes(key)) add(state, key, pointer);
    }
  };
  const root = record(document);
  if (!root) return;
  if (Array.isArray(root['pages'])) {
    root['pages'].forEach((value, index) => {
      const page = record(value);
      const content = page && record(page['content']);
      if (content) workspace(content, `/pages/${index}/content`);
    });
    const shared = record(root['sharedModel']);
    if (shared) {
      blocks(shared['procedureBlocks'], '/sharedModel/procedureBlocks');
      variables(shared['variables'], '/sharedModel/variables');
    }
  } else if (typeof root['type'] === 'string') {
    // Standalone block serialization is also used by clipboard consumers.
    seen.delete(root);
    block(root, '');
  } else workspace(root, '');
}

export function assertProjectDataEnvelope(value: unknown, pointer: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  if ((Object.hasOwn(value, '$ailyProjectDataValue') && !isAilyProjectDataValue(value))
    || (Object.hasOwn(value, '$ailyData') && !isAilyDataRef(value))) {
    throw new ProjectDataError('invalid-ref', `Invalid project data envelope at ${pointer || '/'}.`);
  }
}

/** References must stay visible to reference discovery/GC, including mixed payloads. */
export function containsProjectDataReference(value: unknown): boolean {
  const pending = [{ value, leaving: false }];
  const seen = new WeakSet<object>();
  const active = new WeakSet<object>();
  let found = false;
  while (pending.length) {
    const { value: current, leaving } = pending.pop()!;
    if (!current || typeof current !== 'object') continue;
    if (leaving) { active.delete(current); continue; }
    if (active.has(current)) throw new ProjectDataError('corrupt', 'Project payload contains a cycle.');
    if (seen.has(current)) continue;
    assertProjectDataEnvelope(current, '');
    seen.add(current);
    if (isAilyDataRef(current) || isAilyProjectDataValue(current)) { found = true; continue; }
    active.add(current);
    pending.push({ value: current, leaving: true });
    for (const member of Object.values(current)) pending.push({ value: member, leaving: false });
  }
  return found;
}

export function cloneProjectDataJson<T>(value: T): T {
  try { return JSON.parse(JSON.stringify(value)); }
  catch (error) { throw new ProjectDataError('corrupt', 'Project document is not serializable JSON.', { cause: String(error) }); }
}
