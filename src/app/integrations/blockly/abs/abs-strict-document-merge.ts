import { absJson } from './abs-json';
import {
  AbsSyncError,
  getAbsFieldDefinition,
  type AbsProjectionContracts,
} from './abs-state';
import { AbsSymbols } from './abs-symbols';
import { getAbsProcedureReferences } from './abs-procedures';

type RecordValue = Record<string, any>;
type Owner =
  | { root: string }
  | { parent: string; input?: string; kind: 'block' | 'shadow' };
interface Node {
  value: any;
  owner: Owner;
}
interface Graph {
  value: any;
  kind: 'document' | 'workspace' | 'value';
  nodes: Map<string, Node>;
}
type Role =
  | Graph['kind']
  | 'page'
  | 'shared'
  | 'blocks'
  | 'node'
  | 'payload'
  | 'fields'
  | 'inputs'
  | 'slot'
  | 'model'
  | 'atom'
  | 'pages'
  | 'models'
  | 'records'
  | 'order';

export interface AbsStrictDocumentMergeOptions {
  /** Host-captured schema only. Opaque payloads never imply model references.
   * Complete-page coverage for shared changes remains a host admission. */
  referenceContracts?: Readonly<Record<string, AbsProjectionContracts>>;
}
const object = (value: any): boolean =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const equal = (left: any, right: any) =>
  left === right ||
  (left !== undefined &&
    right !== undefined &&
    absJson(left) === absJson(right));
const copy = <T>(value: T): T =>
  value === undefined ? value : JSON.parse(absJson(value));
const key = (value: string) => value.replace(/~/g, '~0').replace(/\//g, '~1');
const own = (value: RecordValue, property: string) =>
  Object.hasOwn(value, property) ? value[property] : undefined;
const conflict = (path: string, reason: string): never => {
  throw new AbsSyncError(
    'ABS_DOCUMENT_MERGE_CONFLICT',
    `The candidate overlaps current Working state at ${path || '/'}. Both versions are retained.`,
    undefined,
    [],
    { reason, field: path || '/' },
  );
};
const define = (target: RecordValue, name: string, value: any) => {
  if (value !== undefined)
    Object.defineProperty(target, name, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
};
function identities(items: any, path: string): Map<string, any> {
  if (!Array.isArray(items)) return conflict(path, 'invalid-identity-table');
  const result = new Map<string, any>();
  for (const item of items) {
    if (
      !object(item) ||
      typeof item.id !== 'string' ||
      !item.id ||
      result.has(item.id)
    )
      return conflict(path, 'duplicate-or-missing-identity');
    result.set(item.id, item);
  }
  return result;
}

/** Detach once, then flatten known Blockly edges without copying each subtree.
 * IDs inside extension data are ordinary data, never implicitly graph nodes. */
function graph(source: any): Graph {
  let value: any;
  try {
    value = copy(source);
  } catch {
    return conflict('', 'invalid-json-document');
  }
  const kind =
    object(value) && Object.hasOwn(value, 'pages')
      ? 'document'
      : object(value) &&
          Object.hasOwn(value, 'blocks') &&
          !Array.isArray(value.blocks)
        ? 'workspace'
        : 'value';
  const nodes = new Map<string, Node>();
  const pending: Array<{ value: any; owner: Owner; depth: number }> = [];
  const roots = (items: any, path: string) => {
    if (!Array.isArray(items)) return conflict(path, 'invalid-root-list');
    for (let at = 0; at < items.length; at++) {
      const block = items[at];
      if (!object(block) || typeof block.id !== 'string' || !block.id)
        return conflict(path, 'missing-block-identity');
      pending.push({ value: block, owner: { root: path }, depth: 0 });
      items[at] = block.id;
    }
  };
  const workspace = (state: any, path: string) => {
    if (!object(state) || !object(state.blocks))
      return conflict(path, 'invalid-workspace');
    roots(state.blocks.blocks, `${path}/blocks/blocks`);
    if (state.variables !== undefined)
      identities(state.variables, `${path}/variables`);
  };
  if (kind === 'document') {
    const pages = identities(value.pages, '/pages');
    if (
      value.schemaVersion !== 3 ||
      !pages.size ||
      !pages.has(value.activePageId) ||
      !Array.isArray(value.openedPageIds) ||
      new Set(value.openedPageIds).size !== value.openedPageIds.length ||
      value.openedPageIds.some(
        (id: any) => typeof id !== 'string' || !pages.has(id),
      ) ||
      !object(value.sharedModel)
    ) {
      return conflict('', 'invalid-project-document');
    }
    for (const page of pages.values())
      workspace(page.content, `/pages/${key(page.id)}/content`);
    roots(value.sharedModel.procedureBlocks, '/sharedModel/procedureBlocks');
    if (value.sharedModel.variables !== undefined)
      identities(value.sharedModel.variables, '/sharedModel/variables');
  } else if (kind === 'workspace') workspace(value, '');
  // Preserve the generic History API's explicit root identity table. Nested
  // extension arrays are not guessed to be model or block tables.
  else if (object(value) && Array.isArray(value.blocks))
    identities(value.blocks, '/blocks');
  while (pending.length) {
    const item = pending.pop()!,
      block = item.value;
    if (
      !object(block) ||
      typeof block.id !== 'string' ||
      !block.id ||
      typeof block.type !== 'string' ||
      !block.type ||
      nodes.has(block.id) ||
      nodes.size >= 100000 ||
      item.depth > 128
    )
      return conflict('/blocks', 'invalid-or-duplicate-block-identity');
    nodes.set(block.id, { value: block, owner: item.owner });
    if (block.inputs !== undefined && !object(block.inputs))
      return conflict(`/nodes/${key(block.id)}/inputs`, 'invalid-inputs');
    const child = (slot: any, name: 'block' | 'shadow', input?: string) => {
      if (!Object.hasOwn(slot, name)) return;
      const nested = slot[name];
      if (!object(nested) || typeof nested.id !== 'string' || !nested.id)
        return conflict(`/nodes/${key(block.id)}`, 'invalid-child');
      pending.push({
        value: nested,
        owner: {
          parent: block.id,
          ...(input !== undefined ? { input } : {}),
          kind: name,
        },
        depth: input === undefined ? item.depth : item.depth + 1,
      });
      slot[name] = nested.id;
    };
    for (const [name, slot] of Object.entries(block.inputs ?? {})) {
      if (!object(slot))
        return conflict(
          `/nodes/${key(block.id)}/inputs/${key(name)}`,
          'invalid-input-slot',
        );
      child(slot, 'block', name);
      child(slot, 'shadow', name);
    }
    if (block.next !== undefined) {
      if (!object(block.next))
        return conflict(`/nodes/${key(block.id)}/next`, 'invalid-next-slot');
      child(block.next, 'block');
    }
  }
  return { value, kind, nodes };
}

/** Choose a genuine common-ID reorder, then keep both branches' insertions and
 * adjacent anchors. O(n) constraints and an O(n log n) stable topological sort. */
function order(
  base: string[],
  current: string[],
  target: string[],
  wanted: Set<string>,
  path: string,
): string[] {
  const filter = (items: string[]) => items.filter((id) => wanted.has(id));
  base = filter(base);
  current = filter(current);
  target = filter(target);
  const b = new Set(base),
    t = new Set(target),
    common = new Set(current.filter((id) => t.has(id)));
  const oldCommon = new Set([...common].filter((id) => b.has(id)));
  const old = base.filter((id) => oldCommon.has(id)),
    live = current.filter((id) => oldCommon.has(id)),
    next = target.filter((id) => oldCommon.has(id));
  const changed = !equal(old, next);
  if (changed && !equal(old, live) && !equal(live, next))
    return conflict(path, 'different-order');
  const primary = changed ? target : current,
    secondary = changed ? current : target,
    core = primary.filter((id) => common.has(id));
  if (
    [...common].some((id) => !b.has(id)) &&
    !equal(
      core,
      secondary.filter((id) => common.has(id)),
    )
  )
    return conflict(path, 'different-insertion-order');
  const edges = new Map<string, Set<string>>(),
    degree = new Map<string, number>(),
    rank = new Map<string, number>();
  for (const id of [...primary, ...secondary, ...base, ...wanted]) {
    if (!rank.has(id)) rank.set(id, rank.size);
    edges.set(id, new Set());
    degree.set(id, 0);
  }
  const edge = (left: string, right: string) => {
    if (left !== right && !edges.get(left)!.has(right)) {
      edges.get(left)!.add(right);
      degree.set(right, degree.get(right)! + 1);
    }
  };
  for (let at = 1; at < core.length; at++) edge(core[at - 1], core[at]);
  for (const sequence of [current, target])
    for (let at = 1; at < sequence.length; at++) {
      if (!common.has(sequence[at - 1]) || !common.has(sequence[at]))
        edge(sequence[at - 1], sequence[at]);
    }
  const heap: string[] = [];
  const push = (id: string) => {
    let at = heap.length;
    heap.push(id);
    while (at) {
      const parent = (at - 1) >> 1;
      if (rank.get(heap[parent])! <= rank.get(id)!) break;
      heap[at] = heap[parent];
      at = parent;
    }
    heap[at] = id;
  };
  const pop = () => {
    const first = heap[0],
      last = heap.pop()!;
    if (heap.length) {
      let at = 0;
      while (at * 2 + 1 < heap.length) {
        let child = at * 2 + 1;
        if (
          child + 1 < heap.length &&
          rank.get(heap[child + 1])! < rank.get(heap[child])!
        )
          child++;
        if (rank.get(last)! <= rank.get(heap[child])!) break;
        heap[at] = heap[child];
        at = child;
      }
      heap[at] = last;
    }
    return first;
  };
  for (const [id, count] of degree) if (!count) push(id);
  const result: string[] = [];
  while (heap.length) {
    const id = pop();
    result.push(id);
    for (const next of edges.get(id)!) {
      const count = degree.get(next)! - 1;
      degree.set(next, count);
      if (!count) push(next);
    }
  }
  if (result.length !== wanted.size) return conflict(path, 'cyclic-order');
  return result;
}

/** Merge a fixed base/target delta into current complete Working state. No
 * unknown source identity is granted, no baseline rebound and no publication. */
export function mergeAbsStrictDocument<T>(
  base: T,
  current: T,
  target: T,
  options: AbsStrictDocumentMergeOptions = {},
): T {
  const before = graph(base),
    live = graph(current),
    desired = graph(target);
  if (before.kind !== live.kind || before.kind !== desired.kind)
    return conflict('', 'different-document-kind');
  const nodes = new Map<string, Node>(),
    rootIds = new Map<string, Set<string>>();
  const childRole = (role: Role, property: string): Role => {
    if (role === 'document')
      return property === 'pages'
        ? 'pages'
        : property === 'sharedModel'
          ? 'shared'
          : 'atom';
    if (role === 'workspace')
      return property === 'blocks'
        ? 'blocks'
        : property === 'variables'
          ? 'models'
          : 'atom';
    if (role === 'value') return property === 'blocks' ? 'records' : 'atom';
    if (role === 'page') return property === 'content' ? 'workspace' : 'atom';
    if (role === 'shared')
      return property === 'procedureBlocks'
        ? 'order'
        : property === 'variables'
          ? 'models'
          : 'atom';
    if (role === 'blocks') return property === 'blocks' ? 'order' : 'atom';
    if (role === 'node') return property === 'value' ? 'payload' : 'atom';
    if (role === 'payload')
      return property === 'fields'
        ? 'fields'
        : property === 'inputs'
          ? 'inputs'
          : property === 'next'
            ? 'slot'
            : 'atom';
    if (role === 'inputs') return 'slot';
    return 'atom';
  };
  const merge = (
    old: any,
    now: any,
    next: any,
    path: string,
    role: Role,
  ): any => {
    if (role === 'order') {
      if (
        ![old, now, next].every(
          (value) => value === undefined || Array.isArray(value),
        )
      )
        return conflict(path, 'invalid-root-order');
      return order(
        old ?? [],
        now ?? [],
        next ?? [],
        rootIds.get(path) ?? new Set(),
        path,
      );
    }
    if (
      ['pages', 'models', 'records'].includes(role) &&
      [old, now, next].every(
        (value) =>
          Array.isArray(value) || (role === 'models' && value === undefined),
      )
    ) {
      if (old === undefined && now === undefined && next === undefined)
        return undefined;
      const b = identities(old ?? [], path),
        c = identities(now ?? [], path),
        t = identities(next ?? [], path),
        merged = new Map<string, any>();
      for (const id of new Set([...b.keys(), ...c.keys(), ...t.keys()])) {
        const value = merge(
          b.get(id),
          c.get(id),
          t.get(id),
          `${path}/${key(id)}`,
          role === 'pages' ? 'page' : 'model',
        );
        if (value !== undefined) merged.set(id, value);
      }
      return order(
        [...b.keys()],
        [...c.keys()],
        [...t.keys()],
        new Set(merged.keys()),
        path,
      ).map((id) => merged.get(id));
    }
    if (equal(old, next)) return copy(now);
    if (equal(old, now) || equal(now, next)) return copy(next);
    // These two schema dictionaries may be omitted when empty. Their entries,
    // not the existence of the container, are independent editable locations.
    if (
      (role === 'fields' || role === 'inputs') &&
      [old, now, next].every((value) => value === undefined || object(value))
    ) {
      old ??= {};
      now ??= {};
      next ??= {};
    }
    if (role === 'atom' || !object(old) || !object(now) || !object(next))
      return conflict(path, 'different-value-or-delete-edit');
    if (role === 'payload' && (old.type !== now.type || old.type !== next.type))
      return conflict(path, 'type-change-overlap');
    const result: RecordValue = {};
    for (const property of new Set([
      ...Object.keys(old),
      ...Object.keys(now),
      ...Object.keys(next),
    ])) {
      define(
        result,
        property,
        merge(
          own(old, property),
          own(now, property),
          own(next, property),
          `${path}/${key(property)}`,
          childRole(role, property),
        ),
      );
    }
    return result;
  };
  for (const id of new Set([
    ...before.nodes.keys(),
    ...live.nodes.keys(),
    ...desired.nodes.keys(),
  ])) {
    const value = merge(
      before.nodes.get(id),
      live.nodes.get(id),
      desired.nodes.get(id),
      `/nodes/${key(id)}`,
      'node',
    );
    if (value !== undefined) {
      nodes.set(id, value);
      if ('root' in value.owner) {
        let ids = rootIds.get(value.owner.root);
        if (!ids) rootIds.set(value.owner.root, (ids = new Set()));
        ids.add(id);
      }
    }
  }
  const value = merge(before.value, live.value, desired.value, '', before.kind);
  restoreGraph(value, before.kind, nodes, rootIds);
  validateReferences(value, before.kind, options.referenceContracts);
  return value;
}

function restoreGraph(
  value: any,
  kind: Graph['kind'],
  nodes: Map<string, Node>,
  expectedRoots: Map<string, Set<string>>,
) {
  if (kind === 'value') return;
  const roots = new Map<string, string[]>(),
    containers: Array<{ parent: RecordValue; property: string; path: string }> =
      [];
  const workspace = (state: any, path: string) =>
    containers.push({
      parent: state.blocks,
      property: 'blocks',
      path: `${path}/blocks/blocks`,
    });
  if (kind === 'document') {
    const pages = identities(value.pages, '/pages');
    if (
      !pages.has(value.activePageId) ||
      !Array.isArray(value.openedPageIds) ||
      value.openedPageIds.some((id: string) => !pages.has(id))
    )
      return conflict('/pages', 'missing-selected-page');
    for (const page of pages.values())
      workspace(page.content, `/pages/${key(page.id)}/content`);
    containers.push({
      parent: value.sharedModel,
      property: 'procedureBlocks',
      path: '/sharedModel/procedureBlocks',
    });
  } else workspace(value, '');
  const seen = new Set<string>();
  for (const container of containers) {
    const ids = container.parent[container.property],
      wanted = expectedRoots.get(container.path) ?? new Set();
    if (
      !Array.isArray(ids) ||
      ids.length !== wanted.size ||
      ids.some((id) => typeof id !== 'string' || !wanted.has(id))
    )
      return conflict(container.path, 'root-membership-changed');
    roots.set(container.path, ids);
    for (const id of ids) {
      if (seen.has(id) || nodes.get(id)?.value.shadow === true)
        return conflict(container.path, 'invalid-or-multiple-root-owner');
      seen.add(id);
    }
  }
  for (const [path, ids] of expectedRoots)
    if (ids.size && !roots.has(path))
      return conflict(path, 'deleted-page-or-owner');
  const children = new Map<string, string[]>();
  const check = (parent: string, child: any, owner: Owner, path: string) => {
    const node = nodes.get(child);
    if (
      typeof child !== 'string' ||
      !node ||
      !equal(node.owner, owner) ||
      seen.has(child)
    )
      return conflict(path, 'missing-or-multiply-owned-child');
    seen.add(child);
    children.get(parent)!.push(child);
  };
  for (const [id, node] of nodes) {
    children.set(id, []);
    for (const [input, slot] of Object.entries(node.value.inputs ?? {}) as [
      string,
      RecordValue,
    ][]) {
      for (const kind of ['block', 'shadow'] as const)
        if (Object.hasOwn(slot, kind))
          check(
            id,
            slot[kind],
            { parent: id, input, kind },
            `/nodes/${key(id)}/inputs/${key(input)}/${kind}`,
          );
    }
    if (node.value.next && Object.hasOwn(node.value.next, 'block'))
      check(
        id,
        node.value.next.block,
        { parent: id, kind: 'block' },
        `/nodes/${key(id)}/next/block`,
      );
  }
  if (seen.size !== nodes.size) return conflict('/nodes', 'orphaned-block');
  const reachable = new Set<string>(),
    pending = [...roots.values()].flat();
  while (pending.length) {
    const id = pending.pop()!;
    if (reachable.has(id)) return conflict('/nodes', 'cyclic-block-graph');
    reachable.add(id);
    pending.push(...children.get(id)!);
  }
  if (reachable.size !== nodes.size)
    return conflict('/nodes', 'cyclic-block-graph');
  for (const node of nodes.values()) {
    for (const slot of Object.values(
      node.value.inputs ?? {},
    ) as RecordValue[]) {
      for (const kind of ['block', 'shadow'])
        if (Object.hasOwn(slot, kind))
          slot[kind] = nodes.get(slot[kind])!.value;
    }
    if (node.value.next && Object.hasOwn(node.value.next, 'block'))
      node.value.next.block = nodes.get(node.value.next.block)!.value;
  }
  for (const container of containers)
    container.parent[container.property] = roots
      .get(container.path)!
      .map((id) => nodes.get(id)!.value);
}

function validateReferences(
  value: any,
  kind: Graph['kind'],
  contracts?: Readonly<Record<string, AbsProjectionContracts>>,
) {
  if (kind === 'value') return;
  const states: Array<{ id: string; workspace: any }> = [];
  if (kind === 'document') {
    if (value.sharedModel.variables !== undefined)
      identities(value.sharedModel.variables, '/sharedModel/variables');
    for (const page of value.pages) {
      if (page.content.variables !== undefined)
        identities(page.content.variables, `/pages/${key(page.id)}/variables`);
      if (contracts && Object.hasOwn(contracts, page.id))
        states.push({
          id: page.id,
          workspace: {
            ...page.content,
            blocks: {
              ...page.content.blocks,
              blocks: [
                ...value.sharedModel.procedureBlocks,
                ...page.content.blocks.blocks,
              ],
            },
            ...(value.sharedModel.variables !== undefined
              ? { variables: value.sharedModel.variables }
              : {}),
          },
        });
    }
  } else states.push({ id: '$workspace', workspace: value });
  for (const state of states) {
    if (state.workspace.variables !== undefined)
      identities(
        state.workspace.variables,
        `/pages/${key(state.id)}/variables`,
      );
    const contract =
      contracts && Object.hasOwn(contracts, state.id)
        ? contracts[state.id]
        : undefined;
    if (!contract) continue;
    try {
      const symbols = new AbsSymbols(state.workspace, value, contract),
        pending = [...state.workspace.blocks.blocks];
      while (pending.length) {
        const block = pending.pop()!;
        for (const [name, stored] of Object.entries(block.fields ?? {})) {
          const symbol = getAbsFieldDefinition(
            contract,
            block.id,
            name,
          )?.symbol;
          if (symbol) symbols.project(stored, symbol);
        }
        for (const slot of Object.values(block.inputs ?? {}) as RecordValue[]) {
          if (slot['block']) pending.push(slot['block']);
          if (slot['shadow']) pending.push(slot['shadow']);
        }
        if (block.next?.block) pending.push(block.next.block);
      }
      getAbsProcedureReferences(state.workspace, contract.procedures);
    } catch {
      conflict(`/pages/${key(state.id)}/references`, 'invalid-model-reference');
    }
  }
}
