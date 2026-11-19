import * as Blockly from 'blockly';
import {bindBlocklyPointerBoundary} from '../src/app/editors/blockly-editor/utils/blockly-pointer-boundary';

describe('Blockly mouse document boundary with the shipped core', () => {
  let host: HTMLDivElement;
  let workspace: Blockly.WorkspaceSvg;
  let release: () => void;
  let capture: jasmine.Spy;
  let target: HTMLElement;
  const pointer = (node: EventTarget, type: string, overrides: PointerEventInit = {}) => {
    node.dispatchEvent(new PointerEvent(type, {bubbles: true, pointerId: 1, pointerType: 'mouse',
      button: 0, buttons: 1, clientX: 100, clientY: 100, ...overrides}));
  };
  const background = () => workspace.getParentSvg().querySelector('.blocklyMainBackground')!;
  const start = () => {
    pointer(background(), 'pointerdown');
    pointer(document, 'pointermove', {clientX: 140, clientY: 130});
    expect(workspace.isDragging()).toBeTrue();
  };
  const expectStopped = () => {
    expect(workspace.getGesture()).toBeNull();
    expect(workspace.isDragging()).toBeFalse();
    expect(document.documentElement.classList.contains('aily-blockly-mouse-drag')).toBeFalse();
    const position = [workspace.scrollX, workspace.scrollY];
    pointer(document, 'pointermove', {clientX: 250, clientY: 260, buttons: 0});
    expect([workspace.scrollX, workspace.scrollY]).toEqual(position);
  };
  beforeEach(() => {
    host = document.createElement('div');
    host.style.cssText = 'width:800px;height:600px';
    document.body.append(host);
    workspace = Blockly.inject(host, {scrollbars: true, move: {drag: true, scrollbars: true}});
    target = workspace.getInjectionDiv();
    capture = spyOn(target, 'setPointerCapture').and.stub();
    release = bindBlocklyPointerBoundary(workspace);
  });
  afterEach(() => {
    release();
    workspace.dispose();
    host.remove();
  });

  it('captures on a stable host and leaves normal release to the native gesture', () => {
    start();
    expect(capture).toHaveBeenCalledOnceWith(1);
    expect(document.documentElement.classList.contains('aily-blockly-mouse-drag')).toBeTrue();
    const cancel = spyOn(workspace, 'cancelCurrentGesture').and.callThrough();
    pointer(document, 'pointerup', {clientX: 170, clientY: 140, buttons: 0});
    expectStopped();
    expect(cancel).not.toHaveBeenCalled();
  });

  for (const end of ['blur', 'lostpointercapture', 'pointercancel', 'hidden', 'dispose', 'buttons-zero']) {
    it(`stops the native gesture on ${end} and permits another drag`, () => {
      start();
      if (end === 'blur') window.dispatchEvent(new Event('blur'));
      else if (end === 'hidden') {
        const visibility = spyOnProperty(document, 'visibilityState', 'get').and.returnValue('hidden');
        document.dispatchEvent(new Event('visibilitychange'));
        visibility.and.callThrough();
      } else if (end === 'dispose') release();
      else pointer(end === 'lostpointercapture' ? target : document,
        end === 'buttons-zero' ? 'pointermove' : end, {buttons: 0});
      expectStopped();
      start();
      pointer(document, 'pointerup', {buttons: 0});
      expectStopped();
    });
  }

  it('recovers before applying the return position when native capture is unavailable', () => {
    capture.and.throwError('capture unavailable');
    start();
    const position = [workspace.scrollX, workspace.scrollY];
    pointer(document, 'pointermove', {buttons: 0, clientX: 500, clientY: 400});
    expectStopped();
    expect([workspace.scrollX, workspace.scrollY]).toEqual(position);
  });

  it('ignores another pointer and keeps a held drag active', () => {
    start();
    const gesture = workspace.getGesture();
    pointer(target, 'lostpointercapture', {pointerId: 2, buttons: 0});
    expect(workspace.getGesture()).toBe(gesture);
    pointer(document, 'pointermove', {clientX: 190, clientY: 170});
    expect(workspace.isDragging()).toBeTrue();
    pointer(document, 'pointerup', {buttons: 0});
    expectStopped();
  });

  for (const end of ['blur', 'lostpointercapture', 'pointercancel', 'buttons-zero']) {
    it(`cleans independent scrollbar bindings on ${end}`, () => {
      const scrollbar = workspace.scrollbar!.hScroll as any;
      pointer(scrollbar.svgHandle, 'pointerdown');
      expect(scrollbar.onMouseMoveWrapper_).toBeTruthy();
      if (end === 'blur') window.dispatchEvent(new Event('blur'));
      else pointer(end === 'lostpointercapture' ? target : document,
        end === 'buttons-zero' ? 'pointermove' : end, {buttons: 0});
      expect(scrollbar.onMouseMoveWrapper_).toBeNull();
      expect(scrollbar.onMouseUpWrapper_).toBeNull();
    });
  }

  it('does not capture child HTML inputs, other surfaces, touch or right clicks', async () => {
    const foreign = document.createElementNS('http://www.w3.org/2000/svg', 'foreignObject');
    const input = document.createElement('input');
    foreign.append(input); workspace.getParentSvg().append(foreign);
    pointer(input, 'pointerdown');
    pointer(document.body, 'pointerdown');
    pointer(background(), 'pointerdown', {pointerType: 'touch'});
    workspace.cancelCurrentGesture();
    pointer(background(), 'pointerdown', {button: 2, buttons: 2});
    expect(capture).not.toHaveBeenCalled();
    Blockly.ContextMenu.hide();
    // Native menu dismissal restores focus in a queued task, before disposal.
    await new Promise(resolve => setTimeout(resolve, 0));
  });

  it('releases capture on teardown and does not retain listeners', () => {
    start();
    spyOn(target, 'hasPointerCapture').and.returnValue(true);
    const releaseCapture = spyOn(target, 'releasePointerCapture').and.callFake(id => {
      pointer(target, 'lostpointercapture', {pointerId: id});
    });
    release();
    expectStopped();
    expect(releaseCapture).toHaveBeenCalledOnceWith(1);
    capture.calls.reset();
    pointer(background(), 'pointerdown');
    expect(capture).not.toHaveBeenCalled();
  });

  it('captures flyout blocks and releases the independent flyout scrollbar', () => {
    release(); workspace.dispose();
    Blockly.Blocks['boundary_probe'] = {init() { this.appendDummyInput().appendField('probe'); }};
    workspace = Blockly.inject(host, {scrollbars: true,
      toolbox: {kind: 'flyoutToolbox', contents: [{kind: 'block', type: 'boundary_probe'}]}});
    target = workspace.getInjectionDiv();
    capture = spyOn(target, 'setPointerCapture').and.stub();
    release = bindBlocklyPointerBoundary(workspace);
    const flyout = workspace.getFlyout()!.getWorkspace();
    pointer(flyout.getTopBlocks(false)[0].getSvgRoot(), 'pointerdown');
    expect(capture).toHaveBeenCalledOnceWith(1);
    pointer(document, 'pointerup', {buttons: 0});
    const scrollbar = (flyout.scrollbar as any).vScroll || flyout.scrollbar;
    pointer(scrollbar.svgHandle, 'pointerdown');
    expect(scrollbar.onMouseMoveWrapper_).toBeTruthy();
    window.dispatchEvent(new Event('blur'));
    expect(scrollbar.onMouseMoveWrapper_).toBeNull();
    delete Blockly.Blocks['boundary_probe'];
  });
});
