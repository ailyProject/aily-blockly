import { canonicalJsonStringify } from '@domain/project/public-api';

export interface BlocklyWorkspaceViewState {
  scale: number;
  scrollX: number;
  scrollY: number;
}

/** Persist pan positions at micro-pixel precision, not scrollbar arithmetic noise.
 * This normalizes UI coordinates only; scale, code values and extension data stay exact.
 */
export function normalizeBlocklyViewState(value: BlocklyWorkspaceViewState): BlocklyWorkspaceViewState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const result = { ...value };
  for (const key of ['scrollX', 'scrollY'] as const) {
    if (typeof result[key] === 'number' && Number.isFinite(result[key])) result[key] = Number(result[key].toFixed(6)) || 0;
  }
  return result;
}
export interface BlocklySharedModel {
  variables?: any[];
  procedureBlocks: any[];
  [key: string]: unknown;
}
export interface BlocklyPageSnapshot {
  id: string;
  title: string;
  content: any;
  viewState?: BlocklyWorkspaceViewState;
  [key: string]: unknown;
}
export interface BlocklyProjectDocument {
  schemaVersion: number;
  activePageId: string;
  openedPageIds: string[];
  pages: BlocklyPageSnapshot[];
  sharedModel: BlocklySharedModel;
  [key: string]: unknown;
}
export type BlocklyRootRole = 'definition' | 'call' | 'local' | undefined;
export type BlocklyRootClassifier = (block: any) => BlocklyRootRole;

export class BlocklyProjectModelError extends Error {
  constructor(readonly code: string, message: string, readonly blockIds: readonly string[] = []) {
    super(message);
    this.name = 'BlocklyProjectModelError';
  }
}
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const same = (a: unknown, b: unknown) => canonicalJsonStringify(a) === canonicalJsonStringify(b);
const fail = (code: string, message: string, ids: string[] = []): never => { throw new BlocklyProjectModelError(code, message, ids); };

export function normalizeBlocklyWorkspace(value: any): any {
  const state = value == null ? {} : copy(value);
  if (!state || typeof state !== 'object' || Array.isArray(state)) fail('BLOCKLY_WORKSPACE_INVALID', 'Expected serialized workspace state.');
  if (state.blocks !== undefined && (!state.blocks || typeof state.blocks !== 'object' || Array.isArray(state.blocks))) fail('BLOCKLY_WORKSPACE_INVALID', 'Invalid block serializer state.');
  state.blocks ??= { languageVersion: 0, blocks: [] };
  if (state.blocks.blocks !== undefined && !Array.isArray(state.blocks.blocks)) fail('BLOCKLY_WORKSPACE_INVALID', 'Invalid root block list.');
  state.blocks.blocks ??= [];
  return state;
}

/** Pure ownership normalization. Unknown existing shared roots stay shared until a host capability resolves them. */
export function normalizeBlocklyOwnership(
  source: BlocklyProjectDocument, role: BlocklyRootClassifier = () => undefined,
  explicitOwners: Readonly<Record<string, string>> = {},
): BlocklyProjectDocument {
  const document = copy(source);
  if (!Array.isArray(document.pages) || !document.pages.length) fail('BLOCKLY_PAGE_INVALID', 'Project needs at least one page.');
  const pageIds = new Set(document.pages.map(page => page.id));
  if (pageIds.size !== document.pages.length || [...pageIds].some(id => typeof id !== 'string' || !id)
    || !pageIds.has(document.activePageId)) fail('BLOCKLY_PAGE_INVALID', 'Page identities or active page are invalid.');
  if (document.sharedModel?.procedureBlocks !== undefined && !Array.isArray(document.sharedModel.procedureBlocks)) {
    fail('BLOCKLY_MODEL_INVALID', 'Expected shared root block list.');
  }
  document.sharedModel = { ...document.sharedModel, procedureBlocks: [...(document.sharedModel?.procedureBlocks ?? [])] };
  document.pages = document.pages.map(page => ({ ...page, content: normalizeBlocklyWorkspace(page.content),
    ...(page.viewState ? { viewState: normalizeBlocklyViewState(page.viewState) } : {}) }));
  const shared = new Map<string, any>();
  for (const block of document.sharedModel.procedureBlocks) {
    if (!block || typeof block.id !== 'string' || !block.id || shared.has(block.id)) fail('BLOCKLY_MODEL_ID_INVALID', 'Shared roots require unique identities.');
    shared.set(block.id, block);
  }
  for (const [id, block] of shared) {
    const kind = role(block);
    if (kind !== 'call' && kind !== 'local') continue;
    const containing = document.pages.filter(page => page.content.blocks.blocks.some(candidate => candidate.id === id));
    const owner = Object.hasOwn(explicitOwners, id) ? explicitOwners[id]
      : containing.length === 1 ? containing[0].id : document.pages.length === 1 ? document.pages[0].id : undefined;
    if (!owner || !pageIds.has(owner) || containing.some(page => page.id !== owner)) {
      fail('BLOCKLY_SHARED_OWNER_REQUIRED', 'A non-definition in shared state has no proven page owner. Resolve ownership explicitly; original data was retained.', [id]);
    }
    const roots = document.pages.find(page => page.id === owner)!.content.blocks.blocks;
    const existing = roots.find(candidate => candidate.id === id);
    if (existing && !same(existing, block)) fail('BLOCKLY_MODEL_CONFLICT', 'Shared and page copies differ.', [id]);
    if (!existing) roots.push(block);
    shared.delete(id);
  }
  for (const page of document.pages) {
    page.content.blocks.blocks = page.content.blocks.blocks.filter(block => {
      if (role(block) !== 'definition' && !shared.has(block.id)) return true;
      if (typeof block.id !== 'string' || !block.id) fail('BLOCKLY_MODEL_ID_INVALID', 'A shared definition needs a stable identity.');
      if (shared.has(block.id) && !same(shared.get(block.id), block)) fail('BLOCKLY_MODEL_CONFLICT', 'Shared definition copies differ.', [block.id]);
      shared.set(block.id, block);
      return false;
    });
  }
  const variables = new Map<string, any>();
  let hasVariables = Object.hasOwn(document.sharedModel, 'variables');
  for (const table of [document.sharedModel.variables, ...document.pages.map(page => page.content.variables)]) {
    if (table === undefined) continue;
    hasVariables = true;
    if (!Array.isArray(table)) fail('BLOCKLY_VARIABLE_INVALID', 'Expected a variable model table.');
    for (const model of table) {
      if (!model || typeof model.id !== 'string' || !model.id) fail('BLOCKLY_VARIABLE_INVALID', 'A variable requires a stable identity.');
      const previous = variables.get(model.id);
      if (previous && !same({ ...previous, type: previous.type ?? '' }, { ...model, type: model.type ?? '' })) {
        fail('BLOCKLY_MODEL_CONFLICT', 'Variable models with the same ID differ.', [model.id]);
      }
      if (!previous) variables.set(model.id, model);
    }
  }
  document.pages.forEach(page => { delete page.content.variables; });
  document.sharedModel.procedureBlocks = [...shared.values()];
  if (hasVariables) document.sharedModel.variables = [...variables.values()];
  else delete document.sharedModel.variables;
  assertBlocklyDocumentIdentities(document);
  return document;
}

/** Compose a normalized document; ownership is resolved separately, never inferred here. */
export function composeBlocklyPage(document: BlocklyProjectDocument, pageId: string): any {
  const page = document.pages.find(item => item.id === pageId);
  if (!page) fail('BLOCKLY_PAGE_INVALID', 'Target page does not exist.');
  const workspace = normalizeBlocklyWorkspace(page.content);
  workspace.blocks.blocks = [...copy(document.sharedModel.procedureBlocks), ...workspace.blocks.blocks];
  if (document.sharedModel.variables !== undefined) workspace.variables = copy(document.sharedModel.variables);
  else delete workspace.variables;
  return workspace;
}

export function replaceBlocklyPageWorkspace(
  source: BlocklyProjectDocument, pageId: string, value: any, role: BlocklyRootClassifier,
  viewState?: BlocklyWorkspaceViewState,
): BlocklyProjectDocument {
  const document = normalizeBlocklyOwnership(source, role);
  const page = document.pages.find(item => item.id === pageId);
  if (!page) fail('BLOCKLY_PAGE_INVALID', 'Target page does not exist.');
  const workspace = normalizeBlocklyWorkspace(value);
  const sharedIds = new Set(document.sharedModel.procedureBlocks.map(block => block.id));
  const isShared = (block: any) => role(block) === 'definition' || sharedIds.has(block.id);
  document.sharedModel.procedureBlocks = workspace.blocks.blocks.filter(isShared);
  page.content = { ...workspace, blocks: { ...workspace.blocks, blocks: workspace.blocks.blocks.filter(block => !isShared(block)) } };
  if (workspace.variables !== undefined) document.sharedModel.variables = workspace.variables;
  else delete document.sharedModel.variables;
  delete page.content.variables;
  if (viewState) page.viewState = copy(viewState);
  assertBlocklyDocumentIdentities(document);
  return document;
}

export function assertBlocklyDocumentIdentities(document: BlocklyProjectDocument): void {
  const seen = new Set<string>();
  const pending = [...document.sharedModel.procedureBlocks, ...document.pages.flatMap(page => page.content.blocks.blocks)];
  let count = 0;
  while (pending.length) {
    const block = pending.pop();
    if (!block || typeof block !== 'object' || ++count > 100000) fail('BLOCKLY_MODEL_INVALID', 'Invalid or excessive block graph.');
    // Legacy unsaved local blocks can acquire IDs on first native load; shared identities cannot.
    if (block.id !== undefined) {
      if (typeof block.id !== 'string' || !block.id || seen.has(block.id)) fail('BLOCKLY_DUPLICATE_ID', 'Duplicate or invalid block identity across pages/shared state.', [block.id]);
      seen.add(block.id);
    }
    for (const input of Object.values(block.inputs ?? {}) as any[]) {
      if (input.block) pending.push(input.block);
      if (input.shadow) pending.push(input.shadow);
    }
    if (block.next?.block) pending.push(block.next.block);
  }
}
