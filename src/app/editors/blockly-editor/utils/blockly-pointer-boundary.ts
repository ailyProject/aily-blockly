import * as Blockly from 'blockly';

const DRAG_CLASS = 'aily-blockly-mouse-drag';

// Blockly 13.3 scrollbars own document listeners independently of Gesture.
// Keep this private contract here and exercise it against the shipped core.
interface ScrollbarDrag {
  svgHandle: SVGElement;
  onMouseUpHandle(): void;
}

/** Keep native mouse drags in the host document when crossing child iframes. */
export function bindBlocklyPointerBoundary(workspace: Blockly.WorkspaceSvg): () => void {
  const captureTarget = workspace.getInjectionDiv();
  const doc = captureTarget.ownerDocument;
  const view = doc.defaultView!;
  let active: {pointerId: number; scrollbar?: ScrollbarDrag} | null = null;

  const flyoutWorkspace = () => workspace.getFlyout()?.getWorkspace();
  const scrollbars = (): ScrollbarDrag[] => {
    return [workspace, flyoutWorkspace()].flatMap(ws => {
      const bar = ws?.scrollbar as unknown as (ScrollbarDrag & {
        hScroll?: ScrollbarDrag; vScroll?: ScrollbarDrag;
      }) | null;
      return [bar, bar?.hScroll, bar?.vScroll].filter(candidate => !!candidate?.svgHandle) as ScrollbarDrag[];
    });
  };

  const finish = (cancel: boolean): void => {
    const previous = active;
    if (!previous) return;
    // Clear first: releasing capture or restoring drag layers may re-enter.
    active = null;
    doc.documentElement.classList.remove(DRAG_CLASS);
    doc.removeEventListener('pointermove', onMove, true);
    doc.removeEventListener('pointerup', onUp, true);
    doc.removeEventListener('pointercancel', onCancel, true);
    captureTarget.removeEventListener('lostpointercapture', onCancel);
    view.removeEventListener('blur', onBlur);
    doc.removeEventListener('visibilitychange', onVisibilityChange);
    try {
      if (cancel) {
        // Use the last native drag position; returning with buttons=0 must not
        // jump a block, trigger a field click, or create a fresh drop target.
        workspace.cancelCurrentGesture();
        flyoutWorkspace()?.cancelCurrentGesture();
        previous.scrollbar?.onMouseUpHandle();
      }
    } finally {
      if (captureTarget.hasPointerCapture(previous.pointerId)) {
        captureTarget.releasePointerCapture(previous.pointerId);
      }
    }
  };

  const onMove = (event: PointerEvent): void => {
    if (event.pointerId === active?.pointerId && (event.buttons & 1) === 0) finish(true);
  };
  const onUp = (event: PointerEvent): void => {
    // Let Blockly's original pointerup run once, including field clicks and
    // block connection/delete logic. Only retire our capture bookkeeping.
    if (event.pointerId === active?.pointerId) finish(false);
  };
  const onCancel = (event: PointerEvent): void => {
    if (event.pointerId === active?.pointerId) finish(true);
  };
  const onBlur = (): void => finish(true);
  const onVisibilityChange = (): void => {
    if (doc.visibilityState === 'hidden') finish(true);
  };
  const onDown = (event: PointerEvent): void => {
    if (event.pointerType !== 'mouse' || event.button !== 0) return;
    const target = event.target;
    if (!(target instanceof Element) || target.closest('foreignObject')) return;
    const scrollbar = scrollbars().find(bar => bar.svgHandle?.contains(target));
    // Scrollbar SVGs are siblings of the workspace SVG in Blockly 13.
    if (!scrollbar && !workspace.getParentSvg().contains(target) && !flyoutWorkspace()?.getParentSvg().contains(target)) return;
    finish(true);
    active = {pointerId: event.pointerId, scrollbar};
    // Electron 35 can route releases to a child frame even with native capture.
    // Temporarily keep hit testing in this document, including newly opened
    // child frames. Do not touch the children's inline styles or event handlers.
    doc.documentElement.classList.add(DRAG_CLASS);
    doc.addEventListener('pointermove', onMove, true);
    doc.addEventListener('pointerup', onUp, true);
    doc.addEventListener('pointercancel', onCancel, true);
    captureTarget.addEventListener('lostpointercapture', onCancel);
    view.addEventListener('blur', onBlur);
    doc.addEventListener('visibilitychange', onVisibilityChange);
    try {
      // Capture on the stable injection div, never a block that is reparented
      // into the drag layer or a flyout that auto-closes during the gesture.
      captureTarget.setPointerCapture(event.pointerId);
    } catch {
      // Detached surfaces / unavailable capture still recover on re-entry or blur.
    }
  };

  // Native Blockly stops pointerdown propagation before it reaches this div.
  doc.addEventListener('pointerdown', onDown, true);
  return () => {
    doc.removeEventListener('pointerdown', onDown, true);
    finish(true);
  };
}
