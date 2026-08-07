import { DevToolDragController, DragBounds, DragPoint } from './dev-tool-drag-controller';

describe('DevToolDragController', () => {
  const bounds: DragBounds = { maxX: 400, minY: 1, maxY: 260 };
  let handle: HTMLElement;
  let controller: DevToolDragController;
  let animationFrames: Map<number, FrameRequestCallback>;
  let nextAnimationFrameId: number;
  let appliedPositions: DragPoint[];
  let draggingChanges: boolean[];

  beforeEach(() => {
    handle = document.createElement('div');
    document.body.appendChild(handle);
    spyOn(handle, 'setPointerCapture');
    spyOn(handle, 'hasPointerCapture').and.returnValue(true);
    spyOn(handle, 'releasePointerCapture');

    animationFrames = new Map();
    nextAnimationFrameId = 1;
    spyOn(window, 'requestAnimationFrame').and.callFake(callback => {
      const id = nextAnimationFrameId++;
      animationFrames.set(id, callback);
      return id;
    });
    spyOn(window, 'cancelAnimationFrame').and.callFake(id => {
      animationFrames.delete(id);
    });
    appliedPositions = [];
    draggingChanges = [];
    controller = new DevToolDragController({
      handle,
      initialPosition: { x: 200, y: 1 },
      getBounds: () => bounds,
      applyPosition: position => appliedPositions.push({ ...position }),
      onDraggingChange: dragging => draggingChanges.push(dragging),
    });
    controller.connect();
  });

  afterEach(() => {
    controller.disconnect();
    handle.remove();
  });

  it('coalesces pointer moves into one position update per animation frame', () => {
    handle.dispatchEvent(pointerEvent('pointerdown', 7, 50, 20));
    handle.dispatchEvent(pointerEvent('pointermove', 7, 60, 15));
    handle.dispatchEvent(pointerEvent('pointermove', 7, 70, 10));

    expect(animationFrames.size).toBe(1);
    expect(appliedPositions).toEqual([]);

    flushNextAnimationFrame();

    expect(appliedPositions).toEqual([{ x: 220, y: 11 }]);
    expect(draggingChanges).toEqual([true]);
  });

  it('commits the final pointer position when released before the next frame', () => {
    handle.dispatchEvent(pointerEvent('pointerdown', 9, 50, 20));
    handle.dispatchEvent(pointerEvent('pointermove', 9, 60, 15));
    handle.dispatchEvent(pointerEvent('pointerup', 9, 80, 5));

    expect(animationFrames.size).toBe(0);
    expect(appliedPositions).toEqual([{ x: 230, y: 16 }]);
    expect(draggingChanges).toEqual([true, false]);
    expect(controller.isDragging).toBeFalse();
  });

  it('preserves dragging with a cleaned-up document fallback when pointer capture is unavailable', () => {
    (handle.setPointerCapture as jasmine.Spy).and.throwError('capture unavailable');

    handle.dispatchEvent(pointerEvent('pointerdown', 10, 50, 20));
    document.dispatchEvent(pointerEvent('pointermove', 10, 70, 10));
    flushNextAnimationFrame();
    document.dispatchEvent(pointerEvent('pointerup', 10, 80, 5));

    expect(appliedPositions).toEqual([
      { x: 220, y: 11 },
      { x: 230, y: 16 },
    ]);
    expect(draggingChanges).toEqual([true, false]);
    expect(controller.isDragging).toBeFalse();

    document.dispatchEvent(pointerEvent('pointermove', 10, 90, 0));
    expect(animationFrames.size).toBe(0);
  });

  it('ends dragging on cancel, lost capture, and window blur', () => {
    handle.dispatchEvent(pointerEvent('pointerdown', 11, 50, 20));
    handle.dispatchEvent(pointerEvent('pointercancel', 11, 50, 20));
    expect(controller.isDragging).toBeFalse();

    handle.dispatchEvent(pointerEvent('pointerdown', 12, 50, 20));
    handle.dispatchEvent(pointerEvent('lostpointercapture', 12, 50, 20));
    expect(controller.isDragging).toBeFalse();

    handle.dispatchEvent(pointerEvent('pointerdown', 13, 50, 20));
    window.dispatchEvent(new Event('blur'));
    expect(controller.isDragging).toBeFalse();

    handle.dispatchEvent(pointerEvent('pointermove', 13, 80, 5));
    expect(animationFrames.size).toBe(0);
    expect(draggingChanges).toEqual([true, false, true, false, true, false]);
  });

  it('cleans up a pending frame and all listeners when disconnected', () => {
    handle.dispatchEvent(pointerEvent('pointerdown', 21, 50, 20));
    handle.dispatchEvent(pointerEvent('pointermove', 21, 70, 10));
    expect(animationFrames.size).toBe(1);

    controller.disconnect();

    expect(animationFrames.size).toBe(0);
    expect(controller.isDragging).toBeFalse();

    handle.dispatchEvent(pointerEvent('pointerdown', 22, 50, 20));
    handle.dispatchEvent(pointerEvent('pointermove', 22, 90, 0));
    expect(animationFrames.size).toBe(0);
  });

  function flushNextAnimationFrame(): void {
    const next = animationFrames.entries().next();
    expect(next.done).toBeFalse();
    const [id, callback] = next.value;
    animationFrames.delete(id);
    callback(performance.now());
  }

  function pointerEvent(
    type: string,
    pointerId: number,
    clientX: number,
    clientY: number,
  ): PointerEvent {
    return new PointerEvent(type, {
      pointerId,
      button: 0,
      clientX,
      clientY,
      bubbles: true,
      cancelable: true,
    });
  }
});
