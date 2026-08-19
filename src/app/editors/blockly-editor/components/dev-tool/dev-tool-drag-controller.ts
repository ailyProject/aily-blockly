export interface DragPoint {
  x: number;
  y: number;
}

export interface DragBounds {
  maxX: number;
  minY: number;
  maxY: number;
}

interface DragState {
  pointerId: number;
  pointerStart: DragPoint;
  positionStart: DragPoint;
  pendingPosition: DragPoint;
  bounds: DragBounds;
  hasPointerCapture: boolean;
}

export interface DevToolDragControllerOptions {
  handle: HTMLElement;
  initialPosition: DragPoint;
  getBounds: () => DragBounds;
  applyPosition: (position: DragPoint, bounds: DragBounds) => void;
  onDraggingChange: (dragging: boolean) => void;
}

export class DevToolDragController {
  private position: DragPoint;
  private dragState: DragState | null = null;
  private animationFrame: number | null = null;
  private connected = false;

  constructor(private readonly options: DevToolDragControllerOptions) {
    this.position = { ...options.initialPosition };
  }

  get isDragging(): boolean {
    return this.dragState !== null;
  }

  connect(): void {
    if (this.connected) {
      return;
    }
    this.connected = true;

    const handle = this.options.handle;
    handle.addEventListener('pointerdown', this.onPointerDown);
    handle.addEventListener('lostpointercapture', this.onPointerEnd);
    window.addEventListener('blur', this.onWindowBlur);
  }

  disconnect(): void {
    if (!this.connected) {
      return;
    }
    this.connected = false;

    const handle = this.options.handle;
    handle.removeEventListener('pointerdown', this.onPointerDown);
    handle.removeEventListener('lostpointercapture', this.onPointerEnd);
    window.removeEventListener('blur', this.onWindowBlur);
    this.stopDrag(false, false);
  }

  setPosition(position: DragPoint, bounds = this.options.getBounds()): void {
    this.position = { ...position };
    this.options.applyPosition(this.position, bounds);
  }

  refreshBounds(bounds = this.options.getBounds()): void {
    if (this.dragState) {
      this.dragState.bounds = bounds;
    }
    this.options.applyPosition(this.position, bounds);
  }

  private onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || this.dragState !== null) {
      return;
    }

    let hasPointerCapture = false;
    try {
      this.options.handle.setPointerCapture(event.pointerId);
      hasPointerCapture = true;
    } catch {
      // Document listeners preserve dragging when capture is unavailable.
    }

    const bounds = this.options.getBounds();
    const positionStart = {
      x: clamp(this.position.x, 0, bounds.maxX),
      y: clamp(this.position.y, bounds.minY, bounds.maxY),
    };
    this.dragState = {
      pointerId: event.pointerId,
      pointerStart: { x: event.clientX, y: event.clientY },
      positionStart,
      pendingPosition: { ...positionStart },
      bounds,
      hasPointerCapture,
    };

    this.addDocumentDragListeners();
    this.options.onDraggingChange(true);
    event.preventDefault();
  };

  private onPointerMove = (event: PointerEvent): void => {
    if (event.pointerId !== this.dragState?.pointerId) {
      return;
    }

    this.updatePendingPosition(event);
    if (this.animationFrame === null) {
      this.animationFrame = window.requestAnimationFrame(() => {
        this.animationFrame = null;
        this.commitPendingPosition();
      });
    }
    event.preventDefault();
  };

  private onPointerEnd = (event: PointerEvent): void => {
    if (event.pointerId !== this.dragState?.pointerId) {
      return;
    }

    if (event.type === 'pointerup') {
      this.updatePendingPosition(event);
    }
    this.stopDrag(true, event.type !== 'lostpointercapture');
  };

  private onWindowBlur = (): void => {
    this.stopDrag(true);
  };

  private stopDrag(commitPending: boolean, releaseCapture = true): void {
    const dragState = this.dragState;
    if (!dragState) {
      return;
    }

    if (this.animationFrame !== null) {
      window.cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }
    if (commitPending) {
      this.commitPendingPosition();
    }
    this.removeDocumentDragListeners();

    this.dragState = null;
    this.options.onDraggingChange(false);

    const handle = this.options.handle;
    if (releaseCapture && dragState.hasPointerCapture && handle.hasPointerCapture(dragState.pointerId)) {
      handle.releasePointerCapture(dragState.pointerId);
    }
  }

  private addDocumentDragListeners(): void {
    document.addEventListener('pointermove', this.onPointerMove);
    document.addEventListener('pointerup', this.onPointerEnd);
    document.addEventListener('pointercancel', this.onPointerEnd);
  }

  private removeDocumentDragListeners(): void {
    document.removeEventListener('pointermove', this.onPointerMove);
    document.removeEventListener('pointerup', this.onPointerEnd);
    document.removeEventListener('pointercancel', this.onPointerEnd);
  }

  private updatePendingPosition(event: PointerEvent): void {
    const dragState = this.dragState;
    if (!dragState) {
      return;
    }

    const nextX = dragState.positionStart.x + event.clientX - dragState.pointerStart.x;
    const nextY = dragState.positionStart.y - (event.clientY - dragState.pointerStart.y);
    dragState.pendingPosition = {
      x: clamp(nextX, 0, dragState.bounds.maxX),
      y: clamp(nextY, dragState.bounds.minY, dragState.bounds.maxY),
    };
  }

  private commitPendingPosition(): void {
    const dragState = this.dragState;
    if (!dragState || pointsEqual(this.position, dragState.pendingPosition)) {
      return;
    }

    this.position = { ...dragState.pendingPosition };
    this.options.applyPosition(this.position, dragState.bounds);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

function pointsEqual(left: DragPoint, right: DragPoint): boolean {
  return left.x === right.x && left.y === right.y;
}
