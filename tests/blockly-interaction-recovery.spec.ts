import * as Blockly from 'blockly';
import { installBlocklyInteractionRecovery } from '../src/app/editors/blockly-editor/utils/blockly-interaction-recovery';

describe('Blockly exception recovery with the shipped core', () => {
  let host: HTMLDivElement;
  let workspace: Blockly.WorkspaceSvg;
  let first: Blockly.BlockSvg;
  let second: Blockly.BlockSvg;
  let focus: Blockly.FocusManager;
  const failure = new Error('one-shot focus callback failure');

  function failOnce(object: object, method: string) {
    const original = object[method];
    object[method] = function(...args: unknown[]) {
      object[method] = original;
      throw failure;
    };
  }

  beforeAll(() => {
    installBlocklyInteractionRecovery();
    focus = Blockly.getFocusManager();
  });
  beforeEach(() => {
    host = document.createElement('div');
    host.style.cssText = 'width:800px;height:600px';
    document.body.append(host);
    Blockly.Blocks['recovery_probe'] = { init() { this.appendDummyInput().appendField('probe'); } };
    workspace = Blockly.inject(host, {});
    first = workspace.newBlock('recovery_probe');
    second = workspace.newBlock('recovery_probe');
    for (const block of [first, second]) { block.initSvg(); block.render(); }
    second.moveBy(200, 100);
    focus.focusNode(first);
  });
  afterEach(() => {
    workspace.dispose();
    host.remove();
    delete Blockly.Blocks['recovery_probe'];
  });

  function expectUsable() {
    expect((focus as any).lockFocusStateChanges).toBeFalse();
    expect((focus as any).isUpdatingFocusedNode).toBeFalse();
    focus.focusNode(second);
    expect(document.activeElement).toBe(second.getFocusableElement());
    expect(focus.getFocusedNode()).toBe(second);
  }

  for (const method of ['onNodeFocus', 'onNodeBlur']) {
    it(`keeps the original ${method} error and allows subsequent focus`, () => {
      failOnce(method === 'onNodeFocus' ? second : first, method);
      expect(() => focus.focusNode(second)).toThrow(failure);
      expectUsable();
    });
  }

  it('recovers from a tree blur callback exception', () => {
    const input = document.createElement('input');
    host.append(input);
    failOnce(workspace, 'onTreeBlur');
    expect(() => focus.takeEphemeralFocus(input)).toThrow(failure);
    expect(focus.ephemeralFocusTaken()).toBeFalse();
    expectUsable();
  });

  it('recovers from a tree focus callback exception while returning ephemeral focus', () => {
    const input = document.createElement('input');
    host.append(input);
    const release = focus.takeEphemeralFocus(input);
    failOnce(workspace, 'onTreeFocus');
    expect(() => release()).toThrow(failure);
    expect(focus.ephemeralFocusTaken()).toBeFalse();
    expectUsable();
  });

  it('releases an ephemeral focus acquisition that failed before returning its release callback', () => {
    const input = document.createElement('input');
    host.append(input);
    failOnce(first, 'onNodeBlur');
    expect(() => focus.takeEphemeralFocus(input)).toThrow(failure);
    expect(focus.ephemeralFocusTaken()).toBeFalse();
    const release = focus.takeEphemeralFocus(input);
    expect(document.activeElement).toBe(input);
    expect(() => focus.takeEphemeralFocus(input)).toThrowError(/already held/);
    expect(focus.ephemeralFocusTaken()).toBeTrue();
    release();
    expectUsable();
  });

  it('still rejects reentrant changes throughout the callback, including after a caught nested error', () => {
    const original = second.onNodeFocus;
    second.onNodeFocus = function() {
      expect(() => focus.focusNode(first)).toThrowError(/focus\/blur callback/);
      expect(() => focus.focusNode(first)).toThrowError(/focus\/blur callback/);
      original.call(this);
    };
    focus.focusNode(second);
    second.onNodeFocus = original;
    expectUsable();
  });

  it('does not lose the focus guard after repeated installation', () => {
    installBlocklyInteractionRecovery();
    failOnce(second, 'onNodeFocus');
    expect(() => focus.focusNode(second)).toThrow(failure);
    expectUsable();
  });

  function startGesture() {
    const event = new PointerEvent('pointerdown', {pointerId: 1, pointerType: 'mouse', clientX: 40, clientY: 40});
    Blockly.Touch.shouldHandleEvent(event);
    const gesture = workspace.getGesture(event)!;
    gesture.handleBlockStart(event, first);
    gesture.handleWsStart(event, workspace);
    return gesture;
  }

  it('disposes a gesture whose dropdown focus restoration fails during startup', () => {
    const input = document.createElement('input');
    host.append(input);
    const release = focus.takeEphemeralFocus(input);
    const hideChaff = spyOn(workspace, 'hideChaff').and.callFake(() => release());
    failOnce(first, 'onNodeFocus');
    expect(() => startGesture()).toThrow(failure);
    expect(workspace.getGesture()).toBeNull();
    hideChaff.and.callThrough();
    expectUsable();
    const next = startGesture();
    next.cancel();
    expect(workspace.getGesture()).toBeNull();
  });

  it('disposes a pointer-up gesture even when its field callback throws', () => {
    const gesture = startGesture();
    spyOn(gesture as any, 'isFieldClick').and.returnValue(true);
    spyOn(gesture as any, 'doFieldClick').and.callFake(() => {
      failOnce(second, 'onNodeFocus');
      focus.focusNode(second);
    });
    expect(() => gesture.handleUp(new PointerEvent('pointerup', {pointerId: 1, pointerType: 'mouse', clientX: 40, clientY: 40}))).toThrow(failure);
    expect(workspace.getGesture()).toBeNull();
    expect((gesture as any).boundEvents.length).toBe(0);
    expectUsable();
    startGesture().cancel();
  });

  it('cleans up a drag whose layer focus callback fails during pointer movement', async () => {
    const gesture = startGesture();
    // Exercise Electron 35's fallback DOM reparenting even on newer Chrome.
    Object.defineProperty(workspace.getLayerManager()!.getDragLayer(), 'moveBefore', {value: undefined, configurable: true});
    failOnce(first, 'onNodeFocus');
    expect(() => gesture.handleMove(new PointerEvent('pointermove', {pointerId: 1, pointerType: 'mouse', clientX: 100, clientY: 100}))).toThrow(failure);
    await Blockly.renderManagement.finishQueuedRenders();
    expect(workspace.getGesture()).toBeNull();
    expect(first.isDragging()).toBeFalse();
    expect(first.getSvgRoot().parentNode).toBe(workspace.getLayerManager()!.getBlockLayer());
    expect(Blockly.Events.getGroup()).toBe('');
    expectUsable();
    startGesture().cancel();
  });

  for (const end of ['up', 'cancel']) it(`cleans up native drag layers when focus restoration fails during ${end}`, async () => {
    await new Promise(resolve => setTimeout(resolve, 10));
    workspace.clearUndo();
    const initial = first.getRelativeToSurfaceXY();
    const gesture = startGesture();
    gesture.handleMove(new PointerEvent('pointermove', {pointerId: 1, pointerType: 'mouse', clientX: 100, clientY: 100}));
    expect(first.isDragging()).toBeTrue();
    Object.defineProperty(workspace.getLayerManager()!.getBlockLayer(), 'moveBefore', {value: undefined, configurable: true});
    failOnce(first, 'onNodeFocus');
    expect(() => end === 'up'
      ? gesture.handleUp(new PointerEvent('pointerup', {pointerId: 1, pointerType: 'mouse', clientX: 100, clientY: 100}))
      : gesture.cancel()).toThrow(failure);
    await Blockly.renderManagement.finishQueuedRenders();
    expect(workspace.getGesture()).toBeNull();
    expect(first.isDragging()).toBeFalse();
    expect(first.getSvgRoot().parentNode).toBe(workspace.getLayerManager()!.getBlockLayer());
    expect(Blockly.Events.getGroup()).toBe('');
    await new Promise(resolve => setTimeout(resolve, 10));
    workspace.undo(false);
    expect(first.getRelativeToSurfaceXY()).toEqual(initial);
    expectUsable();
    startGesture().cancel();
  });
});
