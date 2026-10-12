import type * as Blockly from 'blockly';
import type { NativeUiTasks } from './blockly-native-ui-tasks';
import type { NativeGraphicsContext } from './blockly-native-graphics-context';

/** Real Blockly graphics in the disposable candidate document, never the editor.
 * Animation frames use the same bounded, semantics-checked queue as UI timers;
 * there is no browser frame race or arbitrary asynchronous library completion. */
export function createNativeCandidateGraphics(native: typeof Blockly, tasks: NativeUiTasks, graphics?: NativeGraphicsContext): Blockly.WorkspaceSvg {
  // Blockly renders also bump nearby disconnected roots. Deserialization turns
  // connection tracking back on in a deferred task, so disabling it only while
  // constructing blocks does not protect a later render of the saved layout.
  // Candidates have no pointer interaction: retain their explicit coordinates.
  // This prototype belongs to the disposable realm, never the live editor.
  // Native rendering, connection checking and semantic readback remain enabled.
  native.BlockSvg.prototype.bumpNeighbours = function() {};
  const queueRender = native.BlockSvg.prototype.queueRender;
  native.BlockSvg.prototype.queueRender = function() {
    return tasks.coreRender(() => queueRender.call(this));
  };
  Object.defineProperty(window, 'requestAnimationFrame', { configurable: false, writable: false,
    value: (callback: FrameRequestCallback) => tasks.set(() => callback(performance.now()), 0) });
  Object.defineProperty(window, 'cancelAnimationFrame', { configurable: false, writable: false,
    value: (id: number) => tasks.clear(id) });
  const container = document.createElement('div');
  container.style.cssText = 'width:1024px;height:768px;';
  document.body.appendChild(container);
  // Aily renderers consume these data-only icons when measuring a block. Use
  // the host's actual map, not reprocessed JSON or guessed library metadata.
  if (graphics) (window as any).__ailyBlockDefinitionsMap = new Map(structuredClone(graphics.blockIcons));
  const workspace = native.inject(container, {
    ...(graphics ? { renderer: graphics.renderer, rendererOverrides: graphics.rendererOverrides ?? undefined,
      rtl: graphics.rtl, oneBasedIndex: graphics.oneBasedIndex,
      theme: native.Theme.defineTheme(graphics.theme.name, structuredClone(graphics.theme)) } : {}),
    sounds: false, trashcan: false, scrollbars: false,
    move: { drag: false, wheel: false, scrollbars: false }, zoom: { controls: false, wheel: false } });
  workspace.setViewportRendering(graphics?.viewportRendering ?? true);
  const viewport = workspace.getViewportRenderer();
  if (viewport) {
    // Keep every field/icon initializer observable, including offscreen blocks.
    // Only SVG mounting is virtualized here; candidate validation must not defer
    // a view's semantic effects until a user scrolls the real editor.
    viewport.deferView = (_block, create) => { create(); return () => {}; };
  }
  return workspace;
}

/** Use the native view lifecycle, including custom fields, inside creation ownership. */
export function initializeNativeCandidateBlock(block: Blockly.Block): void {
  if (!block.workspace.rendered) return;
  const svg = block as Blockly.BlockSvg;
  // Match native deserialization: no interactive neighbour bumping while a
  // candidate is being constructed. Explicit connection checking stays native.
  svg.setConnectionTracking(false);
  svg.initSvg();
  svg.queueRender();
}
