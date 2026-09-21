import type * as Blockly from 'blockly';
import type { NativeUiTasks } from './blockly-native-ui-tasks';

/** Real Blockly graphics in the disposable candidate document, never the editor.
 * Animation frames use the same bounded, semantics-checked queue as UI timers;
 * there is no browser frame race or arbitrary asynchronous library completion. */
export function createNativeCandidateGraphics(native: typeof Blockly, tasks: NativeUiTasks): Blockly.WorkspaceSvg {
  Object.defineProperty(window, 'requestAnimationFrame', { configurable: false, writable: false,
    value: (callback: FrameRequestCallback) => tasks.set(() => callback(performance.now()), 0) });
  Object.defineProperty(window, 'cancelAnimationFrame', { configurable: false, writable: false,
    value: (id: number) => tasks.clear(id) });
  const container = document.createElement('div');
  container.style.cssText = 'width:1024px;height:768px;';
  document.body.appendChild(container);
  return native.inject(container, { sounds: false, trashcan: false, scrollbars: false,
    move: { drag: false, wheel: false, scrollbars: false }, zoom: { controls: false, wheel: false } });
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
