import { canonicalProjectJsonStringify, cloneProjectJson } from '@domain/project/project-document/public-api';
import { collectProjectBlocks } from '@domain/project/project-data/public-api';
import { assertAbsReadback } from '../../../integrations/blockly/abs/abs-readback';
import type { AbsAbiBlock, AbsAbiWorkspace } from '../../../integrations/blockly/abs/abs-state';
import { BlocklyProjectDocument, composeBlocklyPage } from './blockly-project-model';

const same = (a: unknown, b: unknown) => a === undefined || b === undefined
  ? a === b : canonicalProjectJsonStringify(a) === canonicalProjectJsonStringify(b);
type RuntimeView = (workspace: AbsAbiWorkspace) => AbsAbiWorkspace;

/** A newly introduced variable field may create its default model when an old
 * archive omitted that field. Accept only models referenced by those omitted
 * fields, never missing/replaced saved models or unrelated new variables. */
const loadedDefaultVariableIds = (expected: AbsAbiWorkspace, actual: AbsAbiWorkspace): Set<string> => {
  const defaults = new Set<string>();
  const blocks = indexLoadedBlocks(actual);
  for (const [id, saved] of indexLoadedBlocks(expected)) {
    const loaded = blocks.get(id);
    for (const [name, value] of Object.entries(loaded?.fields ?? {})) {
      if (!Object.hasOwn(saved.fields ?? {}, name) && value && typeof value === 'object'
        && !Array.isArray(value) && typeof value['id'] === 'string') defaults.add(value['id']);
    }
  }
  return defaults;
};
const assertLoadedVariables = (expected: AbsAbiWorkspace, actual: AbsAbiWorkspace, defaults: ReadonlySet<string>): void => {
  const variableIds = (state: AbsAbiWorkspace): Set<string> => {
    const models = state['variables'] ?? [];
    if (!Array.isArray(models) || models.some(model => typeof model?.id !== 'string' || !model.id)) {
      throw new Error('Invalid variable identities in the loaded project.');
    }
    const ids = new Set<string>(models.map(model => model.id));
    if (ids.size !== models.length) throw new Error('Duplicate variable identities in the loaded project.');
    return ids;
  };
  const expectedIds = variableIds(expected), actualIds = variableIds(actual);
  if ([...expectedIds].some(id => !actualIds.has(id))
    || [...actualIds].some(id => !expectedIds.has(id) && !defaults.has(id))) {
    throw new Error('Project variable identities changed during loading.');
  }
};

const indexLoadedBlocks = (workspace: AbsAbiWorkspace): Map<string, AbsAbiBlock> => {
  const result = new Map<string, AbsAbiBlock>();
  for (const { state } of collectProjectBlocks(workspace)) {
    const block = state as AbsAbiBlock;
    if (typeof block.id !== 'string' || !block.id || typeof block.type !== 'string' || result.has(block.id) || result.size >= 100000) {
      throw new Error('Invalid block identities in the loaded project.');
    }
    result.set(block.id, block);
  }
  return result;
};

/** Only serialization defaults may be added. Persisted state may not disappear.
 * This admission check never runs a generator or mutates a workspace. */
export function assertProjectLoadPreserved(before: BlocklyProjectDocument, after: BlocklyProjectDocument,
  runtimeView: RuntimeView = workspace => workspace): void {
  const envelope = ({ pages, sharedModel, ...document }: BlocklyProjectDocument) => ({ ...document,
    pages: pages.map(({ content, viewState, ...page }) => page) });
  if (!same(envelope(before), envelope(after))) throw new Error('Project metadata changed during loading.');
  const defaultVariables = loadedDefaultVariableIds(runtimeView(composeBlocklyPage(before, before.activePageId)),
    composeBlocklyPage(after, before.activePageId));
  for (const page of before.pages) {
    const source = composeBlocklyPage(before, page.id), actual = composeBlocklyPage(after, page.id);
    // Only the active page was loaded. Reuse the loader's compatibility view;
    // do not mistake its deliberate migration for lost state or migrate untouched pages.
    const expected = page.id === before.activePageId ? runtimeView(source) : source;
    if (!same([...indexLoadedBlocks(expected).keys()].sort(), [...indexLoadedBlocks(actual).keys()].sort())) {
      throw new Error('Project block identities changed during loading.');
    }
    assertLoadedVariables(expected, actual, defaultVariables);
    assertAbsReadback(expected, actual, { mode: 'requested', index: indexLoadedBlocks });
  }
  const extensions = ({ variables, procedureBlocks, ...rest }: any) => rest;
  if (!same(extensions(before.sharedModel), extensions(after.sharedModel))) throw new Error('Shared project data changed during loading.');
}

/** An editor-session record, not an ABS projection or a new persistent format. */
export class BlocklyProjectCleanState {
  private accepted?: { scope: readonly unknown[]; disk: string; document: BlocklyProjectDocument };
  private failure?: Error;

  constructor(private readonly runtimeView?: RuntimeView) {}

  clear(): void { this.accepted = undefined; this.failure = undefined; }

  remember(scope: readonly unknown[], disk: string, document: BlocklyProjectDocument): void {
    this.accepted = { scope: [...scope], disk, document: cloneProjectJson(document) };
    this.failure = undefined;
  }

  reject(error: unknown): void {
    this.clear();
    this.failure = error instanceof Error ? error : new Error(String(error));
  }

  compare(scope: readonly unknown[], disk: string, document: BlocklyProjectDocument): boolean | undefined {
    if (this.failure) throw this.failure;
    if (!this.accepted) return undefined;
    if (!this.matches(scope)) throw new Error('Project runtime changed; save or reload before checking unsaved state.');
    if (disk !== this.accepted.disk) throw new Error('project.abi changed outside this editor; review or reload the project before closing.');
    return !same(document, this.accepted.document);
  }

  /** Visiting an untouched page may add serialization defaults, but must never
   * acknowledge edits to that page, another page, shared models, titles or tabs. */
  acceptHydration(scope: readonly unknown[], before: BlocklyProjectDocument, after: BlocklyProjectDocument): void {
    if (!this.accepted || !this.matches(scope)) return;
    try { assertProjectLoadPreserved(before, after, this.runtimeView); } catch { return; }
    const baseline = this.accepted.document;
    const id = before.activePageId;
    const source = before.pages.find(page => page.id === id);
    const target = after.pages.find(page => page.id === id);
    const original = baseline.pages.find(page => page.id === id);
    if (!source || !target || !original || !same(original.content, source.content)
      || !same(baseline.sharedModel, before.sharedModel)) return;
    original.content = cloneProjectJson(target.content);
    // First activation may initialize an omitted viewport. Only accept it
    // when no user layout change was present before this load.
    if (same(original.viewState, source.viewState)) {
      if (target.viewState) original.viewState = cloneProjectJson(target.viewState);
      else delete original.viewState;
    }
    baseline.sharedModel = cloneProjectJson(after.sharedModel);
  }

  private matches(scope: readonly unknown[]): boolean {
    return this.accepted!.scope.length === scope.length && this.accepted!.scope.every((value, index) => value === scope[index]);
  }
}
