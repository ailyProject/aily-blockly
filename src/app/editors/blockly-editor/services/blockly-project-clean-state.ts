import { canonicalJsonStringify } from '@domain/project/public-api';
import { collectProjectBlocks } from '@domain/project/project-data/public-api';
import { assertAbsReadback } from '../../../integrations/blockly/abs/abs-readback';
import type { AbsAbiBlock, AbsAbiWorkspace } from '../../../integrations/blockly/abs/abs-state';
import { BlocklyProjectDocument, composeBlocklyPage } from './blockly-project-model';

const same = (a: unknown, b: unknown) => a === undefined || b === undefined
  ? a === b : canonicalJsonStringify(a) === canonicalJsonStringify(b);
type RuntimeView = (workspace: AbsAbiWorkspace) => AbsAbiWorkspace;

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
  for (const page of before.pages) {
    const source = composeBlocklyPage(before, page.id), actual = composeBlocklyPage(after, page.id);
    // Only the active page was loaded. Reuse the loader's compatibility view;
    // do not mistake its deliberate migration for lost state or migrate untouched pages.
    const expected = page.id === before.activePageId ? runtimeView(source) : source;
    if (!same([...indexLoadedBlocks(expected).keys()].sort(), [...indexLoadedBlocks(actual).keys()].sort())) {
      throw new Error('Project block identities changed during loading.');
    }
    const variables = (state: any) => (state.variables ?? []).map((model: any) => model.id).sort();
    if (!same(variables(expected), variables(actual))) throw new Error('Project variable identities changed during loading.');
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
    this.accepted = { scope: [...scope], disk, document: structuredClone(document) };
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
    original.content = structuredClone(target.content);
    // First activation may initialize an omitted viewport. Only accept it
    // when no user layout change was present before this load.
    if (same(original.viewState, source.viewState)) {
      if (target.viewState) original.viewState = structuredClone(target.viewState);
      else delete original.viewState;
    }
    baseline.sharedModel = structuredClone(after.sharedModel);
  }

  private matches(scope: readonly unknown[]): boolean {
    return this.accepted!.scope.length === scope.length && this.accepted!.scope.every((value, index) => value === scope[index]);
  }
}
