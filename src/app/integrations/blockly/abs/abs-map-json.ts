import { absJson } from './abs-json';
import { ABS_PROJECTION_VERSION, AbsSyncError, type AbsIdentityMap } from './abs-state';

const retained = new WeakMap<AbsIdentityMap, any>();
const invalid = (): never => { throw new AbsSyncError('ABS_MAP_INVALID', 'Invalid compact identity map path.'); };
/** Wire schema 2 stores each AST edge once. Domain consumers still see absolute paths. */
export function encodeAbsMap(map: AbsIdentityMap, transport = false): any {
  if (!transport && map.projectionVersion !== ABS_PROJECTION_VERSION) return map;
  const saved = retained.get(map); if (saved) return saved;
  const paths = new Map<string, number>(), keys = new Map<string, number>();
  const nodes = map.nodes.map((node, index) => {
    const path = node.astPath;
    let parent = -1, suffix = path;
    if (!/^\/blocks\/\d+$/.test(path)) {
      const at = path.endsWith('/next') ? path.length - 5 : path.lastIndexOf('/inputs/');
      if (at < 0 || !paths.has(path.slice(0, at))) return invalid();
      parent = paths.get(path.slice(0, at))!; suffix = path.slice(at);
    }
    if (paths.has(path) || keys.has(node.nodeKey)) return invalid();
    paths.set(path, index); keys.set(node.nodeKey, index);
    return { ...node, astPath: [parent, suffix] };
  });
  const symbols = map.symbols.map(symbol => {
    const index = keys.get(symbol.nodeKey); if (index === undefined) return invalid();
    const path = map.nodes[index].astPath;
    if (symbol.astPath !== path && !symbol.astPath.startsWith(path + '/')) return invalid();
    return { ...symbol, astPath: [index, symbol.astPath.slice(path.length)] };
  });
  return { ...map, schemaVersion: 2, nodes, symbols };
}
export function absMapJson(map: AbsIdentityMap): string { return absJson(encodeAbsMap(map)); }

/** Lazy immutable paths keep the renderer from allocating megabytes of repeated
 * ancestors. Only the worker/algorithms that need a path materialize its value. */
export function decodeAbsMap(wire: any, lazy = false): AbsIdentityMap {
  if (wire?.schemaVersion === 1) return wire;
  if (wire?.schemaVersion !== 2 || !Array.isArray(wire.nodes) || !Array.isArray(wire.symbols)) return invalid();
  const paths: string[] = [], keys = new Map<string, number>();
  for (let index = 0; index < wire.nodes.length; index++) {
    const node = wire.nodes[index], edge = node?.astPath;
    if (!Array.isArray(edge) || edge.length !== 2 || !Number.isInteger(edge[0]) || edge[0] < -1 || edge[0] >= index
      || typeof edge[1] !== 'string' || (edge[0] === -1 ? !/^\/blocks\/\d+$/.test(edge[1]) : !/^\/(next|inputs\/[^/]*)$/.test(edge[1]))
      || typeof node.nodeKey !== 'string' || keys.has(node.nodeKey)) return invalid();
    keys.set(node.nodeKey, index);
  }
  const pathAt = (index: number): string => {
    const pending: number[] = [];
    for (let current = index; current !== -1 && paths[current] === undefined; current = wire.nodes[current].astPath[0]) pending.push(current);
    for (const current of pending.reverse()) {
      const [parent, suffix] = wire.nodes[current].astPath;
      paths[current] = (parent === -1 ? '' : paths[parent]) + suffix;
    }
    return paths[index];
  };
  const nodes = wire.nodes.map((node: any, index: number) => {
    const result = { ...node };
    Object.defineProperty(result, 'astPath', { enumerable: true, get: () => pathAt(index) });
    return Object.freeze(result);
  });
  const symbols = wire.symbols.map((symbol: any) => {
    const edge = symbol?.astPath;
    if (!Array.isArray(edge) || edge.length !== 2 || keys.get(symbol.nodeKey) !== edge[0] || typeof edge[1] !== 'string'
      || edge[1] !== '' && !edge[1].startsWith('/')) return invalid();
    const result = { ...symbol };
    Object.defineProperty(result, 'astPath', { enumerable: true, get: () => pathAt(edge[0]) + edge[1] });
    return Object.freeze(result);
  });
  // Freeze the retained wire too: serialization may reuse it only while every
  // exposed domain member and all underlying bytes remain immutable.
  const pending = [wire];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) continue;
    pending.push(...Object.values(value)); Object.freeze(value);
  }
  const map = Object.freeze({ ...wire, schemaVersion: 1, nodes: Object.freeze(nodes), symbols: Object.freeze(symbols) }) as AbsIdentityMap;
  retained.set(map, wire);
  if (!lazy) for (let index = 0; index < nodes.length; index++) pathAt(index);
  return map;
}

export function encodeAbsProjection(projection: import('./abs-state').AbsProjection | null): any {
  return projection ? { ...projection, map: encodeAbsMap(projection.map, true) } : projection;
}
export function decodeAbsProjection(projection: any, lazy = false): import('./abs-state').AbsProjection | null {
  return projection ? { ...projection, map: decodeAbsMap(projection.map, lazy) } : projection;
}
