import { BehaviorSubject } from 'rxjs';
import { canonicalProjectJsonStringify } from '@domain/project/project-document/public-api';
import { BlocklyProjectDocument, BlocklyWorkspaceViewState, normalizeBlocklyViewState } from './blockly-project-model';

const contentText = ({ pages, $ailyProjectData, ...document }: BlocklyProjectDocument): string =>
  canonicalProjectJsonStringify({ ...document, pages: pages.map(({ viewState, ...page }) => page) });
const viewText = (view: BlocklyWorkspaceViewState | undefined): string =>
  canonicalProjectJsonStringify(view && normalizeBlocklyViewState(view));

/** Title hint only. Save/close/Agent verification still uses the authoritative
 * persistence checks. Ordinary edits and viewport events never capture a project. */
export class BlocklyProjectDirtyState {
  readonly changed = new BehaviorSubject(false);
  private baseline?: string;
  private baselineDocumentText?: string;
  private views = new Map<string, string>();
  private dirtyViews = new Set<string>();
  private contentDirty = false;
  private pending = false;
  private checkpoint: unknown;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private readonly capture: () => BlocklyProjectDocument,
    private readonly undoHead: () => unknown,
    private readonly blocked: () => boolean,
    private readonly outsideAngular: (action: () => void) => void) {}

  reset(): void {
    clearTimeout(this.timer); this.timer = undefined;
    this.baseline = this.baselineDocumentText = undefined;
    this.views.clear(); this.dirtyViews.clear(); this.contentDirty = this.pending = false;
    this.checkpoint = undefined;
    this.publish();
  }

  remember(document: BlocklyProjectDocument): void {
    this.reset();
    this.setBaseline(document);
    this.checkpoint = this.undoHead();
  }

  /** Only admitted serializer defaults may adjust a saved baseline. Hydrating
   * an edited page or rebuilding libraries must not acknowledge local edits. */
  acceptHydration(baseline: BlocklyProjectDocument | undefined): void {
    if (!baseline || this.baseline === undefined) return;
    this.setBaseline(baseline);
    this.invalidate();
  }

  private setBaseline(document: BlocklyProjectDocument): void {
    this.baseline = contentText(document);
    this.baselineDocumentText = canonicalProjectJsonStringify(document);
    this.views = new Map(document.pages.map(page => [page.id, viewText(page.viewState)]));
  }

  viewport(pageId: string, view: BlocklyWorkspaceViewState | undefined): void {
    if (this.baseline === undefined) return;
    if (this.views.get(pageId) === viewText(view)) this.dirtyViews.delete(pageId);
    else this.dirtyViews.add(pageId);
    this.publish();
  }

  edited(recordUndo: boolean): void {
    if (this.baseline === undefined) return;
    this.contentDirty = true;
    this.publish();
    // Native undo/redo emits non-recording events. Verify only when returning
    // to the saved checkpoint, never infer cleanliness from stack length alone.
    if (!recordUndo && this.undoHead() === this.checkpoint) this.invalidate();
  }

  /** Page/model replacements, event-free transactions and hydration are less
   * frequent boundaries; coalesce them and compare memory, without disk/IPC. */
  invalidate(): void {
    if (this.baseline === undefined) return;
    this.pending = true;
    clearTimeout(this.timer);
    this.outsideAngular(() => { this.timer = setTimeout(() => this.reconcile(), 200); });
  }

  private reconcile(): void {
    this.timer = undefined;
    if (!this.pending || this.baseline === undefined) return;
    if (this.blocked()) { this.invalidate(); return; }
    try {
      const document = this.capture();
      this.contentDirty = contentText(document) !== this.baseline;
      this.dirtyViews.clear();
      for (const page of document.pages) {
        if (this.views.get(page.id) !== viewText(page.viewState)) this.dirtyViews.add(page.id);
      }
      this.pending = false;
      if (!this.contentDirty) this.checkpoint = this.undoHead();
      this.publish();
    } catch {
      // A busy/quarantined workspace cannot establish a clean baseline.
      // A later transaction or edit will retry; do not spin on a broken project.
      this.contentDirty = true; this.publish();
    }
  }

  /** Reuse canonical bytes already produced for code/save/Agent work. This
   * also recognizes manually reverting a field without adding serialization. */
  observeSnapshot(documentText: string): void {
    if (this.baselineDocumentText === undefined || documentText !== this.baselineDocumentText) return;
    this.contentDirty = false; this.dirtyViews.clear(); this.pending = false;
    clearTimeout(this.timer); this.timer = undefined;
    this.checkpoint = this.undoHead();
    this.publish();
  }

  private publish(): void {
    const dirty = this.contentDirty || this.dirtyViews.size > 0;
    if (dirty !== this.changed.value) this.changed.next(dirty);
  }
}
