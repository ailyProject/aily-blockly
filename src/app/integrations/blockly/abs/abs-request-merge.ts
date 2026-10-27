import { absJson } from './abs-json';
import { AbsAbiBlock, AbsAbiWorkspace, AbsSyncError } from './abs-state';

const copy = <T>(value: T): T => value === undefined ? value : JSON.parse(absJson(value));
const equal = (a: unknown, b: unknown) => a === b || a !== undefined && b !== undefined && absJson(a) === absJson(b);
const object = (value: any): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);

/** The request owns its actual delta; an unchanged property still belongs to the user. */
function mergeValue(base: any, current: any, target: any): any {
  if (equal(base, target)) return copy(current);
  if (equal(base, current) || equal(current, target)) return copy(target);
  if (object(base) && object(current) && object(target)) {
    const result: Record<string, any> = {};
    for (const key of new Set([...Object.keys(base), ...Object.keys(current), ...Object.keys(target)])) {
      const value = mergeValue(base[key], current[key], target[key]);
      if (value !== undefined) Object.defineProperty(result, key, { value, enumerable: true, configurable: true, writable: true });
    }
    return result;
  }
  if ([base, current, target].every(Array.isArray)
    && [base, current, target].every(list => list.every(item => object(item) && typeof item['id'] === 'string'))) {
    const index = (list: any[]) => Object.fromEntries(list.map(item => [item.id, item]));
    const b = index(base), c = index(current), t = index(target);
    return mergeOrder(base.map(v => v.id), current.map(v => v.id), target.map(v => v.id))
      .map(id => mergeValue(b[id], c[id], t[id])).filter(value => value !== undefined);
  }
  return copy(target);
}

function mergeOrder(base: string[], current: string[], target: string[]): string[] {
  if (equal(base, target)) return [...current];
  const result = target.filter(id => !base.includes(id) || current.includes(id));
  for (let i = 0; i < current.length; i++) {
    const id = current[i];
    if (base.includes(id) || result.includes(id)) continue;
    const next = current.slice(i + 1).find(value => result.includes(value));
    result.splice(next === undefined ? result.length : result.indexOf(next), 0, id);
  }
  return result;
}

type Edge = { parent: string; input?: string; kind: 'block' | 'shadow' };
function graph(workspace: AbsAbiWorkspace) {
  const nodes: Record<string, any> = Object.create(null), parents = new Map<string, Edge>();
  const visit = (block: AbsAbiBlock, edge?: Edge): string => {
    if (!block?.id || nodes[block.id]) throw new AbsSyncError('ABS_IDENTITY_AMBIGUOUS', 'Concurrent workspace has duplicate/missing block identities.');
    const node: any = copy(block); delete node.x; delete node.y;
    nodes[block.id] = node;
    if (edge) parents.set(block.id, edge);
    for (const [input, value] of Object.entries(block.inputs ?? {})) {
      for (const kind of ['block', 'shadow'] as const) if (value[kind]) node.inputs[input][kind] = visit(value[kind]!, { parent: block.id, input, kind });
    }
    if (block.next?.block) node.next.block = visit(block.next.block, { parent: block.id, kind: 'block' });
    return block.id;
  };
  const roots = workspace.blocks.blocks.map(block => visit(block));
  const metadata = copy(workspace); metadata.blocks.blocks = [];
  return { nodes, roots, parents, metadata };
}

/** Merge by stable block identity, not serialized array offsets. Connections on
 * the path to an AI-edited block are part of that request's dependency context. */
export function mergeAbsRequestWorkspace(base: AbsAbiWorkspace, current: AbsAbiWorkspace, target: AbsAbiWorkspace): AbsAbiWorkspace {
  const b = graph(base), c = graph(current), t = graph(target);
  const nodes: Record<string, any> = mergeValue(b.nodes, c.nodes, t.nodes);
  const required = new Set<string>();
  const requirePath = (id: string) => {
    if (required.has(id)) return;
    required.add(id);
    const edge = t.parents.get(id);
    if (edge) requirePath(edge.parent);
  };
  for (const [id, node] of Object.entries(t.nodes)) {
    if (!equal(b.nodes[id], node)) requirePath(id);
    const old = b.parents.get(id), next = t.parents.get(id);
    if (!equal(old, next)) requirePath(id);
  }
  const restoreSubtree = (id: string) => {
    const node = nodes[id] ??= copy(t.nodes[id]);
    if (node.next?.block && !nodes[node.next.block]) restoreSubtree(node.next.block);
    for (const value of Object.values(node.inputs ?? {}) as any[]) {
      for (const kind of ['block', 'shadow']) if (value[kind] && !nodes[value[kind]]) restoreSubtree(value[kind]);
    }
  };
  for (const id of required) if (!c.nodes[id]) restoreSubtree(id);
  // Detach all request-owned edges in one traversal before restoring them.
  // A full-request rewrite must not scan every block once per edited block.
  for (const node of Object.values(nodes)) {
    if (required.has(node.next?.block)) delete node.next;
    for (const value of Object.values(node.inputs ?? {}) as any[]) {
      if (required.has(value.block)) delete value.block;
      if (required.has(value.shadow)) delete value.shadow;
    }
  }
  for (const id of required) {
    const edge = t.parents.get(id);
    if (!edge) continue;
    const parent = nodes[edge.parent];
    if (edge.input !== undefined) {
      parent.inputs ??= {};
      parent.inputs[edge.input] ??= copy(t.nodes[edge.parent].inputs[edge.input]);
      parent.inputs[edge.input][edge.kind] = id;
    } else parent.next = { ...parent.next, block: id };
  }
  const parents = new Set<string>();
  for (const node of Object.values(nodes)) {
    if (node.next?.block && nodes[node.next.block]) parents.add(node.next.block);
    for (const value of Object.values(node.inputs ?? {}) as any[]) {
      for (const kind of ['block', 'shadow']) if (value[kind] && nodes[value[kind]]) parents.add(value[kind]);
    }
  }
  const roots = mergeOrder(b.roots, c.roots, t.roots);
  for (const id of t.roots) if (required.has(id) && !roots.includes(id)) roots.push(id);
  // A user-added block displaced from an AI-owned connection remains a loose
  // block. Silently dropping it would discard an unrelated edit. Shadows are
  // connection defaults and cannot become independent top-level blocks.
  for (const id of Object.keys(nodes)) {
    if (!parents.has(id) && !roots.includes(id) && !nodes[id].shadow) roots.push(id);
  }
  const visited = new Set<string>();
  const build = (id: string): AbsAbiBlock => {
    if (!nodes[id] || visited.has(id)) throw new AbsSyncError('ABS_IDENTITY_AMBIGUOUS', 'Concurrent merge has a missing, cyclic or multiply connected block.');
    visited.add(id);
    const node = copy(nodes[id]);
    for (const value of Object.values(node.inputs ?? {}) as any[]) {
      for (const kind of ['block', 'shadow']) {
        if (value[kind] && nodes[value[kind]]) value[kind] = build(value[kind]);
        else delete value[kind];
      }
    }
    if (node.next?.block && nodes[node.next.block]) node.next.block = build(node.next.block);
    else delete node.next;
    return node;
  };
  const result = mergeValue(b.metadata, c.metadata, t.metadata) as AbsAbiWorkspace;
  result.blocks.blocks = [...new Set(roots)].filter(id => nodes[id] && !parents.has(id)).map(build);
  const positions = new Map([...base.blocks.blocks, ...target.blocks.blocks, ...current.blocks.blocks].map(block => [block.id, block]));
  for (const block of result.blocks.blocks) {
    block['x'] = positions.get(block.id)?.['x'] ?? 0;
    block['y'] = positions.get(block.id)?.['y'] ?? 0;
  }
  for (const id of required) if (!visited.has(id)) throw new AbsSyncError('ABS_IDENTITY_AMBIGUOUS', 'Concurrent merge lost an AI request dependency.');
  return result;
}
