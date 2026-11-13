import { BehaviorSubject, Subject } from 'rxjs';
import { canonicalProjectJsonStringify } from '@domain/project/project-document/public-api';
import { BlocklyProjectDocument, BlocklyWorkspaceViewState, normalizeBlocklyViewState } from './blockly-project-model';

const contentText = ({ pages, $ailyProjectData, ...document }: BlocklyProjectDocument): string =>
  canonicalProjectJsonStringify({ ...document, pages: pages.map(({ viewState, ...page }) => page) });
const viewText = (view: BlocklyWorkspaceViewState | undefined): string =>
  canonicalProjectJsonStringify(view && normalizeBlocklyViewState(view));

/** Lightweight change hints. Save/close/Agent verification still uses the authoritative
 * persistence checks. Ordinary edits and viewport events never capture a project. */
export class BlocklyProjectDirtyState {
  readonly changed = new BehaviorSubject(false);
  readonly activity = new Subject<void>();
  private baseline?: string;
  private baselineDocumentText?: string;
  private views = new Map<string, string>();
  private observedViews = new Map<string, string>();
  private observedContent?: string;
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
    this.views.clear(); this.observedViews.clear(); this.observedContent = undefined;
    this.dirtyViews.clear(); this.contentDirty = this.pending = false;
    this.checkpoint = undefined;
    this.publish();
  }

  remember(document: BlocklyProjectDocument): void {
    this.reset();
    this.setBaseline(document);
    this.observedContent = this.baseline;
    this.observedViews = new Map(this.views);
    this.checkpoint = this.undoHead();
  }

  /** A recovered view is compared with its real saved source, never itself. */
  recover(saved: BlocklyProjectDocument, current: BlocklyProjectDocument): void {
    this.remember(saved);
    this.contentDirty = contentText(saved) !== contentText(current);
    this.publish();
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
    const next = viewText(view);
    const moved = this.observedViews.get(pageId) !== next;
    this.observedViews.set(pageId, next);
    if (this.views.get(pageId) === next) this.dirtyViews.delete(pageId);
    else this.dirtyViews.add(pageId);
    this.publish();
    // Repeated resize/restore events at the same position are not new edits.
    // Every actual pan/zoom restarts idle saving, even when already dirty.
    if (moved && this.changed.value) this.activity.next();
  }

  edited(recordUndo: boolean): void {
    if (this.baseline === undefined) return;
    this.activity.next();
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
      const content = contentText(document);
      let edited = content !== this.observedContent;
      this.observedContent = content;
      this.contentDirty = content !== this.baseline;
      const currentViews = new Map<string, string>();
      this.dirtyViews.clear();
      for (const page of document.pages) {
        const view = viewText(page.viewState);
        currentViews.set(page.id, view);
        if (this.observedViews.get(page.id) !== view) edited = true;
        if (this.views.get(page.id) !== view) this.dirtyViews.add(page.id);
      }
      this.observedViews = currentViews;
      this.pending = false;
      if (!this.contentDirty) this.checkpoint = this.undoHead();
      this.publish();
      // Hydration and save readbacks also invalidate. Only a changed, unsaved
      // document should start another save, never an unchanged readback.
      if (edited && this.changed.value) this.activity.next();
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
    this.observedContent = this.baseline;
    this.observedViews = new Map(this.views);
    clearTimeout(this.timer); this.timer = undefined;
    this.checkpoint = this.undoHead();
    this.publish();
  }

  private publish(): void {
    const dirty = this.contentDirty || this.dirtyViews.size > 0;
    if (dirty !== this.changed.value) this.changed.next(dirty);
  }
}
