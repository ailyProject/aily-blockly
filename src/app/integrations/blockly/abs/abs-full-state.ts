import { composeBlocklyPage } from '../../../editors/blockly-editor/services/blockly-project-model';
import { absSyntaxOptions } from './abs-syntax-contracts';
import { absJson } from './abs-json';
import { hashAbsText, indexAbsSyntax } from './abs-identity-map';
import { parseAbsSyntax } from './abs-syntax';
import { AbsAbiBlock, AbsAbiWorkspace, AbsProjectionContracts, AbsSyntaxNode, AbsSyncError, absInputPath } from './abs-state';

/** The readable program owns visible values; this section owns everything it cannot express. */
const MARKER = '\n# @project-state:';
interface NodeState {
  attributes: Record<string, unknown>;
  fields?: Record<string, unknown>;
  inputs?: Record<string, { kind?: 'block' | 'shadow'; edge: Record<string, unknown> }>;
  next?: Record<string, unknown>;
}
interface FullState {
  version: 1 | 2;
  programHash: string;
  document: unknown;
  workspace?: AbsAbiWorkspace;
  workspacePage?: string;
  syntax: AbsAbiWorkspace;
  roots: Array<{ location: Array<string | number>; path: string }>;
  nodes: Record<string, NodeState> | NodeState[];
  contracts: AbsProjectionContracts;
}
const invalid = (message: string): never => { throw new AbsSyncError('ABS_STATE_INVALID', message); };
export function splitAbsState(source: string): { program: string; state: string | null } {
  const at = source.indexOf(MARKER);
  if (at < 0) return { program: source, state: null };
  if (source.indexOf(MARKER, at + MARKER.length) >= 0) return invalid('Duplicate project state section.');
  const end = source.indexOf('\n', at + MARKER.length);
  const state = source.slice(at + MARKER.length, end < 0 ? source.length : end).trim();
  if (!state) return invalid('Project state is empty.');
  return { program: source.slice(0, at) + (end < 0 ? '' : source.slice(end)), state };
}
export function assertAbsStateUnchanged(candidate: string, baseline: string): void {
  const next = splitAbsState(candidate).state;
  if (next !== null && next !== splitAbsState(baseline).state) {
    throw new AbsSyncError('ABS_STATE_EDIT_FORBIDDEN', 'Project state is host-owned. Edit the readable blocks; use history to restore a complete snapshot.');
  }
}

export async function encodeAbsState(program: string, document: unknown,
  blocks: ReadonlyMap<string, AbsAbiBlock>, contracts: AbsProjectionContracts, workspace: AbsAbiWorkspace, legacyPaths = false): Promise<string> {
  // Preorder already belongs to the readable program. Repeating every full
  // ancestor path here makes long chains quadratic in bytes as well as time.
  const nodes: FullState['nodes'] = legacyPaths ? Object.create(null) : [];
  for (const { node, path } of indexAbsSyntax(parseAbsSyntax(program, absSyntaxOptions(workspace, contracts)))) {
    const original = blocks.get(path) ?? invalid('Visible block is missing from the renderer.');
    // Each descendant has its own entry. Copying the whole remaining subtree
    // before discarding its links makes long statement chains quadratic.
    const { type, fields, inputs, next, extraState, ...attributes } = original;
    const residual: NodeState = { attributes };
    if (fields !== undefined) residual.fields = Object.fromEntries(Object.entries(fields)
      .filter(([key, value]) => absJson(value) !== absJson(node.fields[key]?.value)));
    if (inputs !== undefined) residual.inputs = Object.fromEntries(Object.entries(inputs).map(([name, input]) => {
      const edge = { ...input };
      let kind: 'block' | 'shadow' | undefined;
      if (edge.block) { delete edge.block; kind = 'block'; }
      else if (edge.shadow) { delete edge.shadow; kind = 'shadow'; }
      return [name, { ...(kind ? { kind } : {}), edge }];
    }));
    if (next !== undefined) { const { block, ...edge } = next; residual.next = edge; }
    if (Array.isArray(nodes)) nodes.push(JSON.parse(absJson(residual)));
    else nodes[path] = JSON.parse(absJson(residual));
  }
  const roots: FullState['roots'] = [];
  const rootBlocks = new Map([...blocks].filter(([path]) => /^\/blocks\/\d+$/.test(path))
    .map(([path, block]) => [block.id, { path, json: absJson(block) }]));
  const strip = (value: any, location: Array<string | number>): any => {
    if (!value || typeof value !== 'object') return value;
    const match = typeof value.id === 'string' ? rootBlocks.get(value.id) : undefined;
    if (match && absJson(value) === match.json) { roots.push({ location, path: match.path }); return null; }
    if (Array.isArray(value)) return value.map((item, index) => strip(item, [...location, index]));
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, strip(item, [...location, key])]));
  };
  const skeleton = strip(document, []);
  if (new Set(roots.map(root => root.path)).size !== rootBlocks.size) return invalid('Project document does not contain every visible root.');
  // Captured grammar variants are read-only parsing hints, never replacement block state.
  const syntax: AbsAbiWorkspace = { blocks: { blocks: [...blocks.values()].map(block => ({
    id: block.id, type: block.type,
    ...(Object.hasOwn(block, 'extraState') ? { extraState: block.extraState } : {}),
    fields: Object.fromEntries((contracts.selectors?.[block.id] ?? []).filter(name => Object.hasOwn(block.fields ?? {}, name))
      .map(name => [name, block.fields![name]])),
  })) } };
  const project = document as any;
  let workspaceState: Pick<FullState, 'workspace' | 'workspacePage'>;
  if (project?.schemaVersion === 3 && Array.isArray(project.pages) && project.sharedModel) {
    const page = project.pages.find((page: any) => absJson(composeBlocklyPage(project, page.id)) === absJson(workspace));
    if (!page) return invalid('The composed workspace differs from its complete project document.');
    workspaceState = { workspacePage: page.id };
  } else workspaceState = { workspace: { ...workspace, blocks: { ...workspace.blocks, blocks: [] } } };
  const state: FullState = { ...workspaceState, syntax, version: legacyPaths ? 1 : 2, programHash: await hashAbsText(program), document: skeleton, roots, nodes, contracts };
  return program + MARKER + absJson(state);
}

/** Only complete, unedited snapshots decode. An edited body remains a draft until reconciliation. */
export async function decodeAbsState(source: string): Promise<{ document: unknown; workspace: AbsAbiWorkspace; contracts: AbsProjectionContracts }> {
  const { program, state: text } = splitAbsState(source);
  if (text === null) return invalid('ABS has no complete project state.');
  let state: FullState;
  try { state = JSON.parse(text); } catch { return invalid('Malformed project state JSON.'); }
  if (![1, 2].includes(state?.version) || state.programHash !== await hashAbsText(program)
    || !Array.isArray(state.roots) || !state.nodes || typeof state.nodes !== 'object'
    || Array.isArray(state.nodes) !== (state.version === 2) || !state.contracts?.fields) {
    return invalid('Incomplete or edited ABS snapshot; apply the draft against its baseline first.');
  }
  const used = new Set<string>();
  const built = new Map<string, AbsAbiBlock>();
  const syntaxRoots = parseAbsSyntax(program, state.syntax ? absSyntaxOptions(state.syntax, state.contracts) : {});
  const entries = indexAbsSyntax(syntaxRoots);
  for (let index = entries.length - 1; index >= 0; index--) {
    const { node, path } = entries[index], key = state.version === 2 ? index : path;
    if (!Object.hasOwn(state.nodes, key) || used.has(path)) return invalid('Missing or duplicate block state.');
    used.add(path);
    const residual: NodeState = Array.isArray(state.nodes) ? state.nodes[index] : state.nodes[path];
    const block = { ...residual.attributes, type: node.type } as AbsAbiBlock;
    if (residual.fields !== undefined) block.fields = { ...Object.fromEntries(Object.entries(node.fields).map(([key, token]) => [key, token.value])), ...residual.fields };
    if (Object.hasOwn(node, 'extraState')) block.extraState = node.extraState;
    if (residual.inputs !== undefined) block.inputs = Object.fromEntries(Object.entries(residual.inputs).map(([name, input]) => {
      const child = node.inputs[name];
      if (!!child !== !!input.kind) return invalid('Input state does not match the readable program.');
      return [name, { ...input.edge, ...(child ? { [input.kind!]: built.get(absInputPath(path, name)) ?? invalid('Missing input block state.') } : {}) }];
    }));
    if (residual.next !== undefined) {
      if (!node.next) return invalid('Next block is missing.');
      block.next = { ...residual.next, block: built.get(`${path}/next`) ?? invalid('Missing next block state.') };
    }
    built.set(path, block);
  }
  const roots = syntaxRoots.map((_, index) => built.get(`/blocks/${index}`)!);
  if (used.size !== Object.keys(state.nodes).length) return invalid('Unused block state.');
  const document: any = state.document;
  const restored = new Set<number>();
  for (const hole of state.roots) {
    if (!Array.isArray(hole.location) || !hole.location.length || !/^\/blocks\/\d+$/.test(hole.path)) return invalid('Invalid root location.');
    const index = Number(hole.path.slice('/blocks/'.length));
    if (!roots[index]) return invalid('Missing root.');
    let target = document;
    for (const key of hole.location.slice(0, -1)) {
      if (!target || typeof target !== 'object' || !Object.hasOwn(target, key)) return invalid('Invalid project container.');
      target = target[key];
    }
    const key = hole.location[hole.location.length - 1];
    if (!target || !Object.hasOwn(target, key) || target[key] !== null) return invalid('Root slot is not empty.');
    target[key] = JSON.parse(absJson(roots[index])); restored.add(index);
  }
  if (restored.size !== roots.length) return invalid('Unowned root blocks.');
  const workspace = state.workspacePage ? composeBlocklyPage(document, state.workspacePage)
    : state.workspace ? { ...state.workspace, blocks: { ...state.workspace.blocks, blocks: roots } } : invalid('Workspace owner is missing.');
  return { document, workspace, contracts: state.contracts };
}
