import * as Blockly from 'blockly';
import { assertNoOpaqueBlockReferences, freshProjectBlockId, ProjectBlockIdentityError } from '@domain/project/public-api';
import { collectProjectBlockLocations } from '@domain/project/project-data/public-api';

/** Follow native cut/paste semantics: retain unoccupied identities, allocate for
 * collisions against the FULL project (not only instantiated blocks). */
export function prepareBlockCopyIdentities<T>(state: T, occupied: ReadonlySet<string>, generate: () => string,
  variableIds: readonly string[] = []): T {
  const block = JSON.parse(JSON.stringify(state));
  const document = { blocks: { blocks: [block] }, variables: variableIds.map(id => ({ id })) };
  const entries = collectProjectBlockLocations(document);
  const groups = new Map<string, typeof entries>();
  for (const entry of entries) {
    const id = entry.state['id'];
    if (id === undefined) continue;
    if (typeof id !== 'string' || !id) throw new ProjectBlockIdentityError('BLOCKLY_DUPLICATE_ID', 'Invalid copied block identity.');
    groups.set(id, [...(groups.get(id) ?? []), entry]);
  }
  for (const [id, values] of groups) if (values.length > 1 && values.some(entry => !entry.hiddenOwner)) {
    throw new ProjectBlockIdentityError('BLOCKLY_DUPLICATE_ID', 'Ambiguous visible block identities in clipboard.', { blockId: id });
  }
  const renaming = new Set([...groups].filter(([id, values]) => occupied.has(id) || values.length > 1).map(([id]) => id));
  assertNoOpaqueBlockReferences(document, entries, renaming);
  const reserved = new Set([...occupied, ...groups.keys()]);
  for (const [id, values] of groups) for (const entry of occupied.has(id) ? values : values.slice(1)) {
    entry.state['id'] = freshProjectBlockId(reserved, generate);
  }
  return block;
}

const workspaces = new WeakMap<Blockly.WorkspaceSvg, () => unknown>();
let registered: Blockly.clipboard.BlockPaster | undefined;

/** One supported clipboard registry boundary covers shortcuts, context-menu
 * duplicate and multiselect. Never intercept loading, moving or undo/redo. */
export function registerProjectBlockPaster(workspace: Blockly.WorkspaceSvg, project: () => unknown): () => void {
  const current = Blockly.registry.getObject(Blockly.registry.Type.PASTER, Blockly.clipboard.BlockPaster.TYPE);
  if (current !== registered) {
    if (!current) throw new Error('Native block paster is unavailable.');
    registered = new class extends Blockly.clipboard.BlockPaster {
      override paste(data: Parameters<Blockly.clipboard.BlockPaster['paste']>[0], target: Blockly.WorkspaceSvg,
        coordinate?: Blockly.utils.Coordinate): Blockly.BlockSvg | null {
        const capture = workspaces.get(target);
        if (!capture) return current.paste(data, target, coordinate) as Blockly.BlockSvg | null;
        const occupied = new Set(collectProjectBlockLocations(capture()).map(entry => entry.state['id']).filter((id): id is string => typeof id === 'string'));
        const state = prepareBlockCopyIdentities(data.blockState, occupied, () => Blockly.utils.idGenerator.genUid(),
          target.getVariableMap().getAllVariables().map(model => model.getId()));
        const copy = { ...data, blockState: state };
        return current.paste(copy, target, coordinate) as Blockly.BlockSvg | null;
      }
    }();
    Blockly.clipboard.registry.unregister(Blockly.clipboard.BlockPaster.TYPE);
    Blockly.clipboard.registry.register(Blockly.clipboard.BlockPaster.TYPE, registered);
  }
  workspaces.set(workspace, project);
  return () => { workspaces.delete(workspace); };
}
