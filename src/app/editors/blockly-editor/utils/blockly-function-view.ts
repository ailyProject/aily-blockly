import * as Blockly from 'blockly';

export interface BlocklyFunctionViewOption { id: string; label: string; count: number }
export interface BlocklyFunctionViewState {
  scopeId: string;
  options: BlocklyFunctionViewOption[];
  visibleCount: number;
  totalCount: number;
}
export const emptyBlocklyFunctionView = (): BlocklyFunctionViewState => ({ scopeId: '', options: [], visibleCount: 0, totalCount: 0 });
const OTHER = '@other';
const HIDDEN = 'data-aily-function-hidden';

/** Only the view is filtered. Native models, connections, variables, undo events,
 * serialization and generators must continue to see the complete workspace. */
export function isBlocklyFunctionViewBlockVisible(block: Blockly.BlockSvg): boolean {
  return block.getRootBlock().getSvgRoot()?.getAttribute(HIDDEN) !== 'true';
}

function functionLabel(block: Blockly.BlockSvg | null): string | undefined {
  if (!block) return undefined;
  const entry: Record<string, string> = { arduino_global: 'BLOCKLY_FUNCTION_VIEW.GLOBAL', arduino_setup: 'setup()', arduino_loop: 'loop()' };
  if (entry[block.type]) return entry[block.type];
  const procedure = block as Blockly.BlockSvg & { getProcedureDef?(): [string, string[], boolean]; isProcedureDef?(): boolean };
  if (block.type === 'custom_function_def') return `${block.getFieldValue('FUNC_NAME') || '未命名函数'}()`;
  if (typeof procedure.getProcedureDef === 'function') return `${procedure.getProcedureDef()[0] || '未命名函数'}()`;
  if (procedure.isProcedureDef?.()) return `${block.getFieldValue('NAME') || '未命名函数'}()`;
  return undefined;
}

function blockTree(root: Blockly.BlockSvg): Blockly.BlockSvg[] {
  const pending: Blockly.Block[] = [root];
  const blocks: Blockly.BlockSvg[] = [];
  while (pending.length) { const block = pending.pop()!; blocks.push(block as Blockly.BlockSvg); pending.push(...block.getChildren(false)); }
  return blocks;
}

export class BlocklyFunctionView {
  private scopeId = '';
  private hidden = new Map<Blockly.BlockSvg, string>();
  private hiddenBubbles = new Map<SVGElement, string>();
  private extraRoots = new Set<string>();
  private visibleIds = new Set<string>();
  private frame: number | null = null;
  private topologyDirty = true;
  private trees = new Map<Blockly.BlockSvg, Blockly.BlockSvg[]>();
  private rootsByBlock = new WeakMap<Blockly.BlockSvg, Blockly.BlockSvg>();
  private lastState = '';
  private disposed = false;
  private views = new Map<string, { scale: number; x: number; y: number }>();
  private readonly originalBounds: Blockly.WorkspaceSvg['getBlocksBoundingBox'];
  private readonly originalCenter: Blockly.WorkspaceSvg['centerOnBlock'];
  private readonly originalDragChecks: Blockly.IConnectionChecker['doDragChecks'];

  constructor(private workspace: Blockly.WorkspaceSvg, private changed: (state: BlocklyFunctionViewState) => void) {
    this.originalBounds = workspace.getBlocksBoundingBox;
    this.originalCenter = workspace.centerOnBlock;
    this.originalDragChecks = workspace.connectionChecker.doDragChecks;
    workspace.getBlocksBoundingBox = () => {
      if (!this.scopeId) return this.originalBounds.call(workspace);
      const elements = workspace.getTopBoundedElements().filter(element =>
        !(element instanceof Blockly.BlockSvg) || isBlocklyFunctionViewBlockVisible(element));
      const bounds = new Blockly.utils.Rect(0, 0, 0, 0);
      for (const [index, element] of elements.entries()) {
        const rect = element.getBoundingRectangle();
        if (!index) Object.assign(bounds, rect);
        else { bounds.top = Math.min(bounds.top, rect.top); bounds.bottom = Math.max(bounds.bottom, rect.bottom);
          bounds.left = Math.min(bounds.left, rect.left); bounds.right = Math.max(bounds.right, rect.right); }
      }
      return bounds;
    };
    workspace.centerOnBlock = (id, blockOnly) => {
      this.reveal(id);
      this.originalCenter.call(workspace, id, blockOnly);
    };
    const view = this;
    workspace.connectionChecker.doDragChecks = function(a, b, distance) {
      // A drag may never attach to an invisible function. Programmatic/undo/AI
      // connections still use the original complete model without restrictions.
      // Reject distant candidates before any ancestry lookup. In a settled
      // function view the root index avoids walking deep hidden stacks on every
      // pointer move. Pending topology changes and new preview blocks use the
      // live model until the next refresh; programmatic connections are untouched.
      if (view.scopeId && (a.distanceFrom(b) > distance
        || !view.dragTargetVisible(a.getSourceBlock()) || !view.dragTargetVisible(b.getSourceBlock()))) return false;
      return view.originalDragChecks.call(this, a, b, distance);
    };
    workspace.addChangeListener(this.onChange);
    this.refresh();
  }

  private onChange = (event: Blockly.Events.Abstract): void => {
    if (event.type === Blockly.Events.SELECTED) {
      const id = (event as Blockly.Events.Selected).newElementId;
      if (id && Blockly.getSelected()?.id === id) this.reveal(id);
      return;
    }
    if (event.type === Blockly.Events.BUBBLE_OPEN) {
      const block = this.workspace.getBlockById((event as Blockly.Events.BubbleOpen).blockId);
      if (block) this.syncBubble(block, !isBlocklyFunctionViewBlockVisible(block));
      return;
    }
    if (!['create', 'delete', 'move', 'change', 'finished_loading'].includes(event.type)) return;
    if (event.type === Blockly.Events.BLOCK_MOVE) {
      const move = event as Blockly.Events.BlockMove;
      if (move.oldParentId === move.newParentId && move.oldInputName === move.newInputName) return;
    }
    if (event.type === Blockly.Events.BLOCK_CHANGE) {
      const change = event as Blockly.Events.BlockChange;
      if (change.element !== 'mutation' && !functionLabel(this.workspace.getBlockById(change.blockId))) return;
      this.topologyDirty ||= change.element === 'mutation';
    } else this.topologyDirty = true;
    if (this.scopeId && event.type === Blockly.Events.BLOCK_CREATE) {
      for (const id of (event as Blockly.Events.BlockCreate).ids ?? []) this.extraRoots.add(id);
    }
    if (this.frame !== null) return;
    this.frame = requestAnimationFrame(() => { this.frame = null; this.refresh(false); });
  };

  /** Bulk loads can suppress Blockly events. Reset scratch blocks and viewports
   * at page/project boundaries; an unchanged root id can retain its scope. */
  loaded(): void {
    this.extraRoots.clear(); this.visibleIds.clear(); this.views.clear();
    this.refresh();
  }

  setScope(id: string): boolean {
    this.refresh();
    if (id === this.scopeId || (id && id !== OTHER && !functionLabel(this.workspace.getBlockById(id)))) return false;
    this.views.set(this.scopeId, { scale: this.workspace.scale, x: this.workspace.scrollX, y: this.workspace.scrollY });
    this.scopeId = id; this.extraRoots.clear(); this.visibleIds.clear();
    this.refresh(false);
    const view = this.views.get(id);
    if (view) { this.workspace.setScale(view.scale); this.workspace.scroll(view.x, view.y); }
    else if (id && id !== OTHER) {
      const position = this.workspace.getBlockById(id)!.getRelativeToSurfaceXY();
      // Start at the function header even when its body is taller than the
      // viewport; centering the full root would hide the name and parameters.
      this.workspace.scroll(32 - position.x * this.workspace.scale, 64 - position.y * this.workspace.scale);
    }
    else this.workspace.scrollCenter();
    return true;
  }

  reveal(id: string): void {
    const block = this.workspace.getBlockById(id);
    if (!block || !this.scopeId || isBlocklyFunctionViewBlockVisible(block)) return;
    const root = block.getRootBlock();
    this.setScope(functionLabel(root) ? root.id : OTHER);
  }

  private dragTargetVisible(block: Blockly.BlockSvg): boolean {
    const root = !this.topologyDirty && this.rootsByBlock.get(block) || block.getRootBlock();
    return root.getSvgRoot()?.getAttribute(HIDDEN) !== 'true';
  }

  refresh(rebuild = true): void {
    if (this.disposed) return;
    let visibilityChanged = false;
    const roots = this.workspace.getTopBlocks(false).filter(block => !block.isInsertionMarker());
    if (rebuild || this.topologyDirty) {
      this.trees.clear(); this.rootsByBlock = new WeakMap();
      for (const root of roots) {
        const tree = blockTree(root); this.trees.set(root, tree);
        for (const block of tree) this.rootsByBlock.set(block, root);
      }
      this.topologyDirty = false;
    }
    const functions = roots.map(block => ({ block, label: functionLabel(block), count: this.trees.get(block)?.length ?? 0 }));
    if (this.scopeId && this.scopeId !== OTHER && !functions.some(item => item.block.id === this.scopeId && item.label)) this.scopeId = '';
    const visibleRoots = new Set<Blockly.BlockSvg>();
    const options: BlocklyFunctionViewOption[] = [];
    let otherCount = 0, totalCount = 0, visibleCount = 0;
    for (const { block, label, count } of functions) {
      totalCount += count;
      if (label) options.push({ id: block.id, label, count });
      else otherCount += count;
      // Keep newly dragged/pasted/disconnected blocks available for editing.
      // Existing hidden roots stay hidden; switching resets this scratch set.
      if (this.scopeId && !label && this.visibleIds.has(block.id)) this.extraRoots.add(block.id);
      if (!this.scopeId || block.id === this.scopeId || (this.scopeId === OTHER && !label) || this.extraRoots.has(block.id)) {
        visibleRoots.add(block); visibleCount += count;
      }
    }
    for (const [block, display] of this.hidden) {
      if (!roots.includes(block) || visibleRoots.has(block)) {
        visibilityChanged = true;
        block.getSvgRoot()?.style.setProperty('display', display);
        block.getSvgRoot()?.removeAttribute(HIDDEN); this.hidden.delete(block);
      }
    }
    for (const block of roots) {
      const svg = block.getSvgRoot();
      if (!svg || visibleRoots.has(block) || this.hidden.has(block)) continue;
      visibilityChanged = true;
      this.hidden.set(block, svg.style.display);
      svg.style.display = 'none'; svg.setAttribute(HIDDEN, 'true');
    }
    this.refreshBubbles();
    if (visibilityChanged) this.workspace.getViewportRenderer()?.schedule();
    this.visibleIds.clear();
    for (const root of visibleRoots) {
      for (const block of this.trees.get(root) ?? []) this.visibleIds.add(block.id);
    }
    if (otherCount || this.scopeId === OTHER) options.push({ id: OTHER, label: 'BLOCKLY_FUNCTION_VIEW.OTHER', count: otherCount });
    const state = { scopeId: this.scopeId, options, visibleCount, totalCount };
    const key = JSON.stringify(state);
    if (key !== this.lastState) { this.lastState = key; this.changed(state); this.workspace.resizeContents(); }
  }

  private refreshBubbles(): void {
    for (const [svg, display] of this.hiddenBubbles) svg.style.setProperty('display', display);
    this.hiddenBubbles.clear();
    for (const root of this.hidden.keys()) {
      for (const block of this.trees.get(root) ?? []) this.syncBubble(block, true);
    }
  }

  private syncBubble(block: Blockly.BlockSvg, hide: boolean): void {
    for (const icon of block.getIcons()) {
      // Closing native comments would change their serialized pinned state.
      // Bubble-open events update only their owning block, never the whole file.
      for (const slot of ['textInputBubble', 'textBubble', 'miniWorkspaceBubble']) {
        const svg = (icon as any)[slot]?.getSvgRoot?.() as SVGElement | undefined;
        if (!svg) continue;
        if (hide) {
          if (!this.hiddenBubbles.has(svg)) this.hiddenBubbles.set(svg, svg.style.display);
          const focused = svg.ownerDocument.activeElement;
          if (focused && svg.contains(focused)) (focused as HTMLElement).blur();
          svg.style.display = 'none';
        } else if (this.hiddenBubbles.has(svg)) {
          svg.style.setProperty('display', this.hiddenBubbles.get(svg)!); this.hiddenBubbles.delete(svg);
        }
      }
    }
  }

  /** SVG export retains its original whole-workspace behavior without changing
   * selection, history or the active function. */
  withAllVisible<T>(operation: () => T): T {
    for (const [block, display] of this.hidden) block.getSvgRoot()?.style.setProperty('display', display);
    for (const [svg, display] of this.hiddenBubbles) svg.style.setProperty('display', display);
    const bounds = this.workspace.getBlocksBoundingBox;
    this.workspace.getBlocksBoundingBox = this.originalBounds;
    this.workspace.getViewportRenderer()?.schedule();
    try { return operation(); }
    finally {
      this.workspace.getBlocksBoundingBox = bounds;
      for (const block of this.hidden.keys()) block.getSvgRoot()?.style.setProperty('display', 'none');
      for (const svg of this.hiddenBubbles.keys()) svg.style.display = 'none';
      this.workspace.getViewportRenderer()?.schedule();
      this.workspace.getViewportRenderer()?.refresh();
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.workspace.removeChangeListener(this.onChange);
    for (const [block, display] of this.hidden) { block.getSvgRoot()?.style.setProperty('display', display); block.getSvgRoot()?.removeAttribute(HIDDEN); }
    for (const [svg, display] of this.hiddenBubbles) svg.style.setProperty('display', display);
    this.workspace.getBlocksBoundingBox = this.originalBounds;
    this.workspace.centerOnBlock = this.originalCenter;
    this.workspace.connectionChecker.doDragChecks = this.originalDragChecks;
    this.workspace.getViewportRenderer()?.schedule();
    this.trees.clear();
  }
}
