import { BlocklyProjectDocument, composeBlocklyPage } from '../../../editors/blockly-editor/services/blockly-project-model';
import { absJson } from './abs-identity-map';
import { AbsPageReferenceContract } from './abs-project-references';

/** Serializable evidence, not live fields or callbacks. A different session/state cannot borrow it. */
export class AbsReferenceContractCache {
  private scope: readonly unknown[] = [];
  private readonly pages = new Map<string, { workspace: string; contract: string }>();
  private size = 0;
  private epoch = 0;
  constructor(private readonly maxCharacters = 4 * 1024 * 1024) {
    if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 0) throw new Error('Reference cache limit must be a non-negative integer.');
  }
  get revision(): number { return this.epoch; }

  setScope(...scope: readonly unknown[]): void {
    if (scope.length !== this.scope.length || scope.some((value, index) => value !== this.scope[index])) {
      this.clear();
      this.scope = scope;
    }
  }
  clear(): void { this.pages.clear(); this.scope = []; this.size = 0; this.epoch++; }
  forget(pageId: string): void {
    const entry = this.pages.get(pageId);
    if (entry) this.size -= entry.workspace.length + entry.contract.length;
    this.pages.delete(pageId);
  }
  remember(document: BlocklyProjectDocument, pageId: string, contract: AbsPageReferenceContract): void {
    this.forget(pageId);
    const entry = { workspace: absJson(composeBlocklyPage(document, pageId)), contract: absJson(contract) };
    const size = entry.workspace.length + entry.contract.length;
    if (size > this.maxCharacters) return; // Missing evidence fails closed, never exhaust memory to keep it.
    while (this.size + size > this.maxCharacters) this.forget(this.pages.keys().next().value!);
    this.pages.set(pageId, entry);
    this.size += size;
  }
  matching(document: BlocklyProjectDocument): Record<string, AbsPageReferenceContract> {
    const result: Record<string, AbsPageReferenceContract> = Object.create(null);
    const currentPages = new Set(document.pages.map(page => page.id));
    for (const [id, entry] of this.pages) {
      if (!currentPages.has(id)) { this.forget(id); continue; }
      if (entry.workspace === absJson(composeBlocklyPage(document, id))) result[id] = JSON.parse(entry.contract);
    }
    return result;
  }
}
