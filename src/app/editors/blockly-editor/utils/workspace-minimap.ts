import * as Blockly from 'blockly';
import { drawMinimapShape, prepareMinimapCanvas, type MinimapScene, type MinimapShape } from './minimap-scene';
import {isBlocklyWorkspaceInteracting} from './blockly-performance';

const SVG_NS = 'http://www.w3.org/2000/svg';
const CONTENT_EVENTS = new Set([
  'finished_loading', 'create', 'delete', 'change', 'move',
  'comment_create', 'comment_delete', 'comment_change', 'comment_move',
  'var_create', 'var_delete', 'var_rename',
]);
let nextSourceId = 0;

/** No second Blockly model/rendering workspace. Small diagrams snapshot the
 * existing SVG, including custom fields. Large diagrams use a level-of-detail
 * overview: bounded geometry reads, then off-thread canvas painting. Navigation
 * stays on the main thread; no serialization or block constructors are needed.
 */
export class WorkspaceMinimap {
  private readonly wrapper = document.createElement('div');
  private readonly svg = document.createElementNS(SVG_NS, 'svg');
  private readonly content = document.createElementNS(SVG_NS, 'g');
  private readonly focus = document.createElementNS(SVG_NS, 'rect');
  private readonly resizeObserver: ResizeObserver;
  private frame: number | null = null;
  private waitingForRender = false;
  private contentDirty = true;
  private disposed = false;
  private pointerId: number | null = null;
  private scale = 1;
  private offsetX = 0;
  private offsetY = 0;
  private canvas = document.createElement('canvas');
  private worker: Worker | null = null;
  private workerFailed = false;
  private workerBusy = false;
  private scene: MinimapScene | null = null;
  private sceneVersion = 0;
  private captureFrame: number | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly workspace: Blockly.WorkspaceSvg,
    private readonly editBlocked: () => boolean = () => false) {
    this.wrapper.className = 'blockly-minimap';
    this.wrapper.dataset['minimapMode'] = 'svg-snapshot';
    this.wrapper.tabIndex = 0;
    this.wrapper.setAttribute('role', 'application');
    this.wrapper.setAttribute('aria-label', Blockly.Msg['MINIMAP_ARIA_LABEL'] ||
      'Workspace minimap. Use the arrow keys to pan the workspace.');
    this.svg.setAttribute('width', '100%');
    this.svg.setAttribute('height', '100%');
    this.svg.setAttribute('aria-hidden', 'true');
    this.svg.style.pointerEvents = 'none';
    this.focus.setAttribute('class', 'blockly-focus-region');
    this.focus.setAttribute('fill', 'none');
    this.focus.setAttribute('stroke', 'currentColor');
    this.focus.setAttribute('stroke-width', '1');
    this.svg.append(this.content, this.focus);
    this.canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;display:none';
    this.canvas.setAttribute('aria-hidden', 'true');
    this.svg.style.position = 'relative';
    this.wrapper.append(this.canvas, this.svg);
    this.workspace.getInjectionDiv().parentElement?.append(this.wrapper);
    this.wrapper.addEventListener('pointerdown', this.onPointerDown);
    this.wrapper.addEventListener('pointermove', this.onPointerMove);
    this.wrapper.addEventListener('pointerup', this.onPointerUp);
    this.wrapper.addEventListener('pointercancel', this.onPointerUp);
    this.wrapper.addEventListener('lostpointercapture', this.onPointerUp);
    this.wrapper.addEventListener('keydown', this.onKeyDown);
    this.workspace.addChangeListener(this.onViewportChange);
    this.resizeObserver = new ResizeObserver(() => this.requestSync());
    this.resizeObserver.observe(this.wrapper);
    this.requestSync();
  }

  requestSync(event?: {type?: string}): void {
    if (this.disposed) return;
    if (event?.type && event.type !== 'viewport_change' && !CONTENT_EVENTS.has(event.type)) return;
    this.contentDirty ||= event?.type !== 'viewport_change';
    if (this.frame !== null || this.waitingForRender) return;
    this.waitingForRender = true;
    // Observe final geometry, never flush/re-render the main workspace here.
    void Blockly.renderManagement.finishQueuedRenders().then(() => {
      this.waitingForRender = false;
      if (!this.disposed) this.frame = requestAnimationFrame(() => this.update());
    });
  }

  dispose(): void {
    this.disposed = true;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.workspace.removeChangeListener(this.onViewportChange);
    this.resizeObserver.disconnect();
    if (this.captureFrame !== null) cancelAnimationFrame(this.captureFrame);
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.worker?.terminate();
    this.wrapper.removeEventListener('pointerdown', this.onPointerDown);
    this.wrapper.removeEventListener('pointermove', this.onPointerMove);
    this.wrapper.removeEventListener('pointerup', this.onPointerUp);
    this.wrapper.removeEventListener('pointercancel', this.onPointerUp);
    this.wrapper.removeEventListener('lostpointercapture', this.onPointerUp);
    this.wrapper.removeEventListener('keydown', this.onKeyDown);
    this.wrapper.remove();
  }

  private readonly onViewportChange = (event: Blockly.Events.Abstract): void => {
    if (event.type === 'viewport_change') this.requestSync(event);
  };

  private update(): void {
    this.frame = null;
    if (this.disposed) return;
    const deferContent = this.contentDirty && (this.editBlocked() || isBlocklyWorkspaceInteracting(this.workspace));
    if (deferContent && this.retryTimer === null) {
      // Retry only pending work, not an idle polling loop. Viewport navigation
      // below stays live while a drag, field editor or AI transaction is active.
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.requestSync({type: 'viewport_change'});
      }, 100);
    }
    if (this.contentDirty && !deferContent) {
      this.contentDirty = false;
      const visibleRoots = this.workspace.getTopBlocks(false)
        .filter(block => block.getSvgRoot().getAttribute('data-aily-function-hidden') !== 'true');
      const visibleBlocks: Blockly.BlockSvg[] = [];
      const pending = [...visibleRoots];
      while (pending.length) { const block = pending.pop()!; visibleBlocks.push(block); pending.push(...block.getChildren(false)); }
      const overview = visibleBlocks.length > 300;
      this.wrapper.dataset['minimapMode'] = overview ? 'canvas-worker' : 'svg-snapshot';
      this.canvas.style.display = overview ? 'block' : 'none';
      const sources = new Set<SVGElement>(overview ? [] : [
          ...visibleRoots.map(block => block.getSvgRoot()),
          ...(this.workspace.getTopComments() as Blockly.comments.RenderedWorkspaceComment[]).map(comment => comment.getSvgRoot()),
        ]);
      // Never use a live <use>: a small stack can grow to thousands of nodes
      // during loading, before the next frame can switch to the worker view.
      this.content.replaceChildren();
      this.wrapper.className = ['blockly-minimap', ...this.workspace.getInjectionDiv().classList]
        .filter(name => name !== 'injectionDiv').join(' ');
      this.svg.classList.add('blocklySvg');
      const captureSnapshots = () => {
        for (const source of sources) {
          if (!source.id) source.id = `aily-minimap-source-${++nextSourceId}`;
          const reference = source.cloneNode(true) as SVGElement;
          reference.dataset['minimapSource'] = source.id;
          // cloneNode copies canvas dimensions, not its bitmap. Custom fields
          // embedded in foreignObject must retain their rendered preview too.
          const canvases = source.querySelectorAll('canvas');
          reference.querySelectorAll('canvas').forEach((canvas, index) => {
            if (canvases[index].width && canvases[index].height) {
              canvas.getContext('2d')?.drawImage(canvases[index], 0, 0);
            }
          });
          for (const element of [reference, ...reference.querySelectorAll('*')]) {
            element.removeAttribute('id');
            element.removeAttribute('tabindex');
            element.classList.remove('blocklyDraggable', 'blocklySelected', 'blocklyDragging');
            if (element.matches('input,textarea,select,button,[contenteditable],a')) element.setAttribute('tabindex', '-1');
          }
          this.content.append(reference);
        }
      };
      const viewport = this.workspace.getViewportRenderer();
      if (!overview && viewport) viewport.withAllBlocksRendered(captureSnapshots);
      else captureSnapshots();
      const box = this.workspace.getBlocksBoundingBox();
      const width = Math.max(1, this.wrapper.clientWidth);
      const height = Math.max(1, this.wrapper.clientHeight);
      const padding = 8;
      this.scale = Math.min(Math.max(1, width - padding * 2) / Math.max(1, box.right - box.left),
        Math.max(1, height - padding * 2) / Math.max(1, box.bottom - box.top), 1);
      this.offsetX = (width - (box.right - box.left) * this.scale) / 2 - box.left * this.scale;
      this.offsetY = (height - (box.bottom - box.top) * this.scale) / 2 - box.top * this.scale;
      this.content.setAttribute('transform', `translate(${this.offsetX},${this.offsetY}) scale(${this.scale})`);
      this.sceneVersion++;
      if (this.captureFrame !== null) cancelAnimationFrame(this.captureFrame);
      if (overview) this.captureOverview(width, height);
      else {
        this.scene = null;
        this.wrapper.dataset['minimapShapes'] = String(visibleBlocks.length);
        this.wrapper.dataset['minimapReady'] = 'true';
      }
    }
    const view = this.workspace.getMetricsManager().getViewMetrics(true);
    this.focus.setAttribute('x', String(view.left * this.scale + this.offsetX));
    this.focus.setAttribute('y', String(view.top * this.scale + this.offsetY));
    this.focus.setAttribute('width', String(Math.max(1, view.width * this.scale)));
    this.focus.setAttribute('height', String(Math.max(1, view.height * this.scale)));
  }

  /** Bounded main-thread reads of already computed geometry; no text measuring,
   * XML, block constructors, layout reads per block, or recursive DOM copies. */
  private captureOverview(width: number, height: number): void {
    const version = this.sceneVersion;
    this.wrapper.dataset['minimapReady'] = 'false';
    const pending = this.workspace.getTopBlocks(false).reverse();
    const shapes: MinimapShape[] = [];
    const collect = () => {
      this.captureFrame = null;
      if (this.disposed || version !== this.sceneVersion || this.deferCaptureForInteraction()) return;
      const start = performance.now();
      do {
        const block = pending.pop();
        if (!block) break;
        if (block.isDisposed() || block.getSvgRoot().style.display === 'none') continue;
        const point = block.getRelativeToSurfaceXY();
        shapes.push({id: block.id, path: block.pathObject.svgPath.getAttribute('d') || '',
          colour: block.getColour(), x: point.x, y: point.y, opacity: block.isEnabled() ? 1 : 0.45});
        const children = block.getChildren(false);
        for (let i = children.length - 1; i >= 0; i--) pending.push(children[i]);
      } while (pending.length && performance.now() - start < 4);
      if (pending.length) {
        this.captureFrame = requestAnimationFrame(collect);
        return;
      }
      for (const comment of this.workspace.getTopComments() as Blockly.comments.RenderedWorkspaceComment[]) {
        const box = comment.getBoundingRectangle();
        shapes.push({id: comment.id, path: `M0 0h${box.right - box.left}v${box.bottom - box.top}H0Z`,
          colour: '#d4bd77', x: box.left, y: box.top, opacity: 0.8});
      }
      this.scene = {version, width, height, pixelRatio: Math.min(devicePixelRatio || 1, 2),
        scale: this.scale, offsetX: this.offsetX, offsetY: this.offsetY, shapes};
      this.paintOverview(this.scene);
    };
    this.captureFrame = requestAnimationFrame(collect);
  }

  private deferCaptureForInteraction(): boolean {
    if (!this.editBlocked() && !isBlocklyWorkspaceInteracting(this.workspace)) return false;
    // A capture can start at idle and still be in flight when a drag begins.
    // Drop that partial scene and rebuild the latest geometry after interaction.
    this.contentDirty = true;
    this.requestSync({type: 'viewport_change'});
    return true;
  }

  private paintOverview(scene: MinimapScene): void {
    if (!this.workerFailed && !this.worker) {
      try {
        this.worker = new Worker(new URL('./minimap-render.worker', import.meta.url), {type: 'module'});
        this.worker.onmessage = (event: MessageEvent<{version: number; shapes: number}>) => {
          this.workerBusy = false;
          if (event.data.version === this.sceneVersion && !this.disposed) {
            this.wrapper.dataset['minimapReady'] = 'true';
            this.wrapper.dataset['minimapShapes'] = String(event.data.shapes);
          }
          // At most one scene in flight and one newest pending scene.
          if (!this.disposed && this.scene && this.scene.version > event.data.version) {
            this.paintOverview(this.scene);
          }
        };
        this.worker.onerror = () => this.useCanvasFallback();
        const canvas = this.canvas.transferControlToOffscreen();
        this.worker.postMessage({canvas}, [canvas]);
      } catch {
        this.useCanvasFallback();
        return;
      }
    }
    if (this.worker) {
      if (this.workerBusy) return;
      this.workerBusy = true;
      this.worker.postMessage({scene});
      return;
    }
    // CSP/older browser fallback still yields between small painting batches.
    this.wrapper.dataset['minimapMode'] = 'canvas-main-thread';
    const context = this.canvas.getContext('2d');
    if (!context) return;
    prepareMinimapCanvas(context, scene);
    let index = 0;
    const paint = () => {
      this.captureFrame = null;
      if (this.disposed || scene.version !== this.sceneVersion || this.deferCaptureForInteraction()) return;
      const start = performance.now();
      while (index < scene.shapes.length && performance.now() - start < 4) {
        drawMinimapShape(context, scene.shapes[index++]);
      }
      if (index < scene.shapes.length) this.captureFrame = requestAnimationFrame(paint);
      else {
        this.wrapper.dataset['minimapReady'] = 'true';
        this.wrapper.dataset['minimapShapes'] = String(scene.shapes.length);
      }
    };
    this.captureFrame = requestAnimationFrame(paint);
  }

  private useCanvasFallback(): void {
    if (this.disposed) return;
    this.workerFailed = true;
    this.worker?.terminate();
    this.worker = null;
    this.workerBusy = false;
    // A transferred canvas cannot acquire a main-thread context.
    const replacement = this.canvas.cloneNode() as HTMLCanvasElement;
    this.canvas.replaceWith(replacement);
    this.canvas = replacement;
    if (this.scene) this.paintOverview(this.scene);
  }

  private panTo(event: PointerEvent): void {
    const rect = this.svg.getBoundingClientRect();
    const x = (event.clientX - rect.left - this.offsetX) / this.scale;
    const y = (event.clientY - rect.top - this.offsetY) / this.scale;
    const view = this.workspace.getMetricsManager().getViewMetrics(true);
    this.workspace.scroll((view.width / 2 - x) * this.workspace.scale,
      (view.height / 2 - y) * this.workspace.scale);
    this.requestSync({type: 'viewport_change'});
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    this.wrapper.focus({preventScroll: true});
    this.pointerId = event.pointerId;
    this.wrapper.setPointerCapture(event.pointerId);
    this.panTo(event);
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (event.pointerId === this.pointerId) this.panTo(event);
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (event.pointerId !== this.pointerId) return;
    this.pointerId = null;
    if (this.wrapper.hasPointerCapture(event.pointerId)) this.wrapper.releasePointerCapture(event.pointerId);
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    const direction: Record<string, [number, number]> = {
      ArrowLeft: [1, 0], ArrowRight: [-1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1],
    };
    const delta = direction[event.key];
    if (!delta) return;
    event.preventDefault();
    event.stopPropagation();
    const step = event.shiftKey ? 200 : 40;
    this.workspace.scroll(this.workspace.scrollX + delta[0] * step,
      this.workspace.scrollY + delta[1] * step);
    this.requestSync({type: 'viewport_change'});
  };
}
