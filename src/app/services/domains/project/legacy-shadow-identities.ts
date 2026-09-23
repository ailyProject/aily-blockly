import { canonicalJsonStringify, createDefaultProjectDataCodecRegistry } from './project-data/project-data-codec.registry';
import { collectProjectBlockLocations, ProjectBlockLocation, projectDataChildPointer } from './project-data/project-data-payloads';
import { isAilyDataRef } from './project-data/project-data.types';

export class ProjectBlockIdentityError extends Error {
  constructor(readonly code: string, message: string, readonly details: Readonly<Record<string, unknown>> = {}) {
    super(message); this.name = 'ProjectBlockIdentityError';
  }
}
export interface ShadowIdentityChange {
  jsonPointer: string;
  oldId: string;
  newId: string;
  ownerConnection: string;
  reason: 'duplicate-hidden-shadow';
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const pointerId = (entry: ProjectBlockLocation) => `${entry.jsonPointer}/id`;
const payloadCodecs = createDefaultProjectDataCodecRegistry();

/** Known model IDs have a different namespace. Everything else is opaque: fail
 * closed when it could reference a block being renamed, never rewrite arbitrary id keys. */
export function assertNoOpaqueBlockReferences(document: any, entries: readonly ProjectBlockLocation[], ids: ReadonlySet<string>): void {
  if (!ids.size) return;
  const definitions = new Set(entries.map(pointerId));
  const models = new Set<string>();
  const tables = Array.isArray(document?.pages)
    ? [[document.sharedModel?.variables, '/sharedModel/variables'], ...document.pages.map((p: any, i: number) => [p.content?.variables, `/pages/${i}/content/variables`])]
    : [[document?.variables, '/variables']];
  for (const [values, pointer] of tables) if (Array.isArray(values)) values.forEach((model, i) => {
    if (typeof model?.id === 'string') { models.add(model.id); definitions.add(`${pointer}/${i}/id`); }
  });
  for (const entry of entries) {
    for (const [name, value] of Object.entries(entry.state['fields'] ?? {})) {
      if (value && typeof value === 'object' && models.has((value as any).id)) {
        definitions.add(`${projectDataChildPointer(`${entry.jsonPointer}/fields`, name)}/id`);
      }
    }
  }
  const pending: Array<{ value: any; pointer: string }> = [{ value: document, pointer: '' }];
  while (pending.length) {
    const { value, pointer } = pending.pop()!;
    if (definitions.has(pointer)) continue;
    if (typeof value === 'string' && ids.has(value)) {
      throw new ProjectBlockIdentityError('BLOCKLY_IDENTITY_REFERENCE_AMBIGUOUS',
        `Cannot safely rename block identity referenced at ${pointer}; original project retained.`, { jsonPointer: pointer, blockId: value });
    }
    if (!value || typeof value !== 'object') continue;
    if (Object.hasOwn(value, '$ailyData')) {
      // Known binary codecs expose immutable bytes, not a serialized identity
      // graph. Keep their content-addressed references shared when copying media.
      if (isAilyDataRef(value) && value.$ailyData.logicalType === 'binary'
        && payloadCodecs.has(value.$ailyData.codec) && payloadCodecs.get(value.$ailyData.codec).logicalType === 'binary') continue;
      throw new ProjectBlockIdentityError('BLOCKLY_IDENTITY_REFERENCE_UNRESOLVED',
        `External structured data at ${pointer} must be inspected before identities can be renamed; original project retained.`, { jsonPointer: pointer });
    }
    for (const [key, child] of Object.entries(value)) {
      const childPointer = projectDataChildPointer(pointer, key);
      if (ids.has(key)) throw new ProjectBlockIdentityError('BLOCKLY_IDENTITY_REFERENCE_AMBIGUOUS',
        `Cannot safely rename block identity used as a key at ${childPointer}.`, { jsonPointer: childPointer, blockId: key });
      pending.push({ value: child, pointer: childPointer });
    }
  }
}

export function freshProjectBlockId(reserved: Set<string>, generate: () => string): string {
  for (let attempt = 0; attempt < 100; attempt++) {
    const id = generate();
    if (typeof id === 'string' && id && !reserved.has(id)) { reserved.add(id); return id; }
  }
  throw new ProjectBlockIdentityError('BLOCKLY_IDENTITY_ALLOCATION_FAILED', 'Cannot allocate a unique block identity.');
}

/** Pure, narrow import migration. A shared root's byte-equivalent page mirrors
 * are one owner, not copies. Reflect changes into those mirrors so the existing
 * ownership normalizer can still merge them; never split a shared definition. */
export function migrateLegacyShadowIdentities<T>(source: T, generate: () => string = () => globalThis.crypto.randomUUID()): {
  document: T; changes: ShadowIdentityChange[];
} {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return { document: source, changes: [] };
  const document: any = clone(source);
  const entries = collectProjectBlockLocations(document);
  const aliases = new Map<string, string>();
  if (Array.isArray(document?.pages)) {
    const shared = new Map<string, ProjectBlockLocation>();
    for (const entry of entries.filter(item => /^\/sharedModel\/procedureBlocks\/\d+$/.test(item.jsonPointer))) {
      const id = entry.state['id'];
      if (typeof id !== 'string' || shared.has(id)) throw new ProjectBlockIdentityError('BLOCKLY_MODEL_ID_INVALID', 'Shared roots require unique identities.');
      shared.set(id, entry);
    }
    for (const entry of entries.filter(item => /^\/pages\/\d+\/content\/blocks\/blocks\/\d+$/.test(item.jsonPointer))) {
      const owner = shared.get(entry.state['id'] as string);
      if (!owner) continue;
      if (canonicalJsonStringify(entry.state) !== canonicalJsonStringify(owner.state)) {
        throw new ProjectBlockIdentityError('BLOCKLY_MODEL_CONFLICT', 'Shared definition copies differ; original project retained.', { blockId: entry.state['id'] });
      }
      aliases.set(entry.jsonPointer, owner.jsonPointer);
    }
  }
  const groups = new Map<string, ProjectBlockLocation[]>();
  for (const entry of entries) {
    if ([...aliases.keys()].some(pointer => entry.jsonPointer === pointer || entry.jsonPointer.startsWith(pointer + '/'))) continue;
    const id = entry.state['id'];
    if (id === undefined) continue; // Native loading owns first IDs on legacy unsaved blocks.
    if (typeof id !== 'string' || !id) throw new ProjectBlockIdentityError('BLOCKLY_DUPLICATE_ID', `Invalid block identity at ${pointerId(entry)}.`);
    groups.set(id, [...(groups.get(id) ?? []), entry]);
  }
  const duplicates = [...groups].filter(([, values]) => values.length > 1);
  for (const [id, values] of duplicates) if (values.some(entry => !entry.hiddenOwner)) {
    throw new ProjectBlockIdentityError('BLOCKLY_DUPLICATE_ID',
      `Duplicate identity ${id} includes a visible block; automatic migration only covers hidden defaults.`,
      { blockId: id, paths: values.map(pointerId) });
  }
  if (!duplicates.length) return { document: source, changes: [] };
  assertNoOpaqueBlockReferences(document, entries, new Set(duplicates.map(([id]) => id)));
  const reserved = new Set(groups.keys());
  const changes: ShadowIdentityChange[] = [];
  for (const [oldId, values] of duplicates) for (const entry of values.slice(1)) {
    const newId = freshProjectBlockId(reserved, generate);
    entry.state['id'] = newId;
    changes.push({ jsonPointer: pointerId(entry), oldId, newId, ownerConnection: entry.hiddenOwner!, reason: 'duplicate-hidden-shadow' });
  }
  const byPointer = new Map(entries.map(entry => [entry.jsonPointer, entry]));
  for (const entry of entries) for (const [alias, owner] of aliases) {
    if (entry.jsonPointer === alias || entry.jsonPointer.startsWith(alias + '/')) {
      const canonical = byPointer.get(owner + entry.jsonPointer.slice(alias.length));
      if (canonical && Object.hasOwn(canonical.state, 'id')) entry.state['id'] = canonical.state['id'];
    }
  }
  return { document, changes };
}
