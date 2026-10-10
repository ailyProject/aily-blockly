import { ElementRef } from '@angular/core';
import { fakeAsync, tick } from '@angular/core/testing';
import { DevToolComponent } from './dev-tool.component';

describe('DevToolComponent position persistence', () => {
  interface Harness {
    component: DevToolComponent;
    container: HTMLDivElement;
    box: HTMLDivElement;
    handle: HTMLDivElement;
    config: { data: { devToolPosition: unknown }; save: jasmine.Spy };
  }
  const harnesses: Harness[] = [];

  function createHarness(saved?: unknown, width = 800, height = 600): Harness {
    const container = document.createElement('div');
    container.style.cssText = `position: relative; width: ${width}px; height: ${height}px;`;
    const box = document.createElement('div');
    box.style.cssText = 'position: absolute; left: 0; bottom: 0; width: 200px; height: 40px;';
    const handle = document.createElement('div');
    box.appendChild(handle);
    container.appendChild(box);
    document.body.appendChild(container);

    const config = {
      data: { devToolPosition: saved },
      save: jasmine.createSpy('save').and.resolveTo(),
    };
    const zone = { run: (fn: () => void) => fn(), runOutsideAngular: (fn: () => void) => fn() };
    const component = new DevToolComponent(
      null!, null!, null!, config as any, null!, null!, null!, null!,
      null!, null!, null!, null!, null!, null!, zone as any,
    );
    Object.assign(component, { devtoolBox: new ElementRef(box), dragHandle: new ElementRef(handle) });
    // Exercise the native listeners even when synthetic events cannot capture a pointer.
    spyOn(handle, 'setPointerCapture').and.throwError('Synthetic pointer');
    const harness = { component, container, box, handle, config };
    harnesses.push(harness);
    component.ngAfterViewInit();
    tick(20);
    return harness;
  }

  function pointer(target: EventTarget, type: string, x: number, y: number) {
    target.dispatchEvent(new PointerEvent(type, {
      pointerId: 1, button: 0, clientX: x, clientY: y, bubbles: true,
    }));
  }

  function resize(harness: ReturnType<typeof createHarness>, width: number, height: number) {
    harness.container.style.width = `${width}px`;
    harness.container.style.height = `${height}px`;
    (harness.component as any).onContainerResize();
    tick(20);
  }

  afterEach(() => {
    for (const harness of harnesses.splice(0)) {
      harness.component.ngOnDestroy();
      harness.container.remove();
    }
  });

  it('centers without a valid preference and does not write during initialization', fakeAsync(() => {
    for (const saved of [undefined, { x: '12', y: 10 }, { x: -1, y: 5 }, { x: 10, y: NaN }]) {
      const harness = createHarness(saved);
      expect(harness.box.style.transform).toBe('translate3d(300px, -1px, 0px)');
      expect(harness.config.save).not.toHaveBeenCalled();
    }
  }));

  it('saves the final pointer position once and restores it in a recreated editor', fakeAsync(() => {
    const harness = createHarness({ x: 210, y: 83 });
    expect(harness.box.style.transform).toBe('translate3d(210px, -83px, 0px)');
    pointer(harness.handle, 'pointerdown', 220, 400);
    pointer(document, 'pointermove', 250, 385);
    tick(20);
    expect(harness.config.save).not.toHaveBeenCalled();
    // Pointerup can arrive before the final animation frame.
    pointer(document, 'pointerup', 285, 365);
    expect(harness.config.save).toHaveBeenCalledTimes(1);
    expect(harness.config.data.devToolPosition).toEqual({ x: 275, y: 118 });
    const persisted = JSON.parse(JSON.stringify(harness.config.data));
    harness.component.ngOnDestroy();

    const reloaded = createHarness(persisted.devToolPosition);
    expect(reloaded.box.style.transform).toBe('translate3d(275px, -118px, 0px)');
    expect(reloaded.config.save).not.toHaveBeenCalled();
  }));

  it('keeps the saved preference through a smaller editor, a handle click, and reopening', fakeAsync(() => {
    const harness = createHarness({ x: 550, y: 400 });
    resize(harness, 400, 200);
    expect(harness.box.style.transform).toBe('translate3d(200px, -160px, 0px)');
    pointer(harness.handle, 'pointerdown', 210, 30);
    pointer(document, 'pointerup', 210, 30);
    expect(harness.config.save).not.toHaveBeenCalled();
    resize(harness, 800, 600);
    expect(harness.box.style.transform).toBe('translate3d(550px, -400px, 0px)');
    harness.component.ngOnDestroy();

    const reloaded = createHarness(harness.config.data.devToolPosition, 400, 200);
    expect(reloaded.box.style.transform).toBe('translate3d(200px, -160px, 0px)');
    resize(reloaded, 800, 600);
    expect(reloaded.box.style.transform).toBe('translate3d(550px, -400px, 0px)');
    expect(reloaded.config.save).not.toHaveBeenCalled();
  }));

  it('stores a deliberate move at the editor edge within bounds', fakeAsync(() => {
    const harness = createHarness({ x: 550, y: 400 }, 400, 200);
    pointer(harness.handle, 'pointerdown', 210, 30);
    pointer(document, 'pointerup', -100, 500);
    expect(harness.config.data.devToolPosition).toEqual({ x: 0, y: 1 });
    expect(harness.box.style.transform).toBe('translate3d(0px, -1px, 0px)');
    expect(harness.config.save).toHaveBeenCalledTimes(1);
  }));

  it('saves an interrupted drag once when the window loses focus', fakeAsync(() => {
    const harness = createHarness({ x: 210, y: 83 });
    pointer(harness.handle, 'pointerdown', 220, 400);
    pointer(document, 'pointermove', 250, 385);
    window.dispatchEvent(new Event('blur'));
    pointer(document, 'pointerup', 250, 385);
    expect(harness.config.data.devToolPosition).toEqual({ x: 240, y: 98 });
    expect(harness.config.save).toHaveBeenCalledTimes(1);
  }));

  it('does not persist an unfinished drag on component destruction', fakeAsync(() => {
    const harness = createHarness({ x: 210, y: 83 });
    pointer(harness.handle, 'pointerdown', 220, 400);
    pointer(document, 'pointermove', 250, 385);
    harness.component.ngOnDestroy();
    tick(20);
    expect(harness.config.data.devToolPosition).toEqual({ x: 210, y: 83 });
    expect(harness.config.save).not.toHaveBeenCalled();
  }));
});
