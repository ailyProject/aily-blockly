import { fakeAsync, flushMicrotasks, tick } from '@angular/core/testing';
import { Subject } from 'rxjs';
import * as Blockly from 'blockly';
import 'blockly/blocks';
import { BlocklyComponent } from '../../../editors/blockly-editor/components/blockly/blockly.component';
import { BlocklyService } from '../../../editors/blockly-editor/services/blockly.service';

describe('bulk workspace minimap refresh', () => {
  let component: any;
  let editor: any;
  let workspace: Blockly.Workspace;
  let mirror: Blockly.Workspace;
  let blocked: boolean;
  let input: HTMLInputElement;

  beforeEach(() => {
    workspace = new Blockly.Workspace(); mirror = new Blockly.Workspace(); blocked = false;
    Object.assign(workspace, { isDragging: () => false, getInjectionDiv: () => document.body });
    Object.assign(mirror, { zoomToFit: jasmine.createSpy('zoomToFit') });
    const refresh = new Subject<Blockly.WorkspaceSvg>();
    editor = Object.create(BlocklyService.prototype);
    Object.defineProperty(editor, 'workspace', { value: workspace });
    Object.assign(editor, { workspaceVisualRefreshRequestSubject: refresh,
      workspaceVisualRefreshRequested$: refresh.asObservable(), isWorkspaceEditBlocked: () => blocked });
    component = Object.create(BlocklyComponent.prototype);
    Object.assign(component, { blocklyService: editor, minimap: { minimapWorkspace: mirror },
      minimapSyncSubject: new Subject<void>(), destroy$: new Subject<void>(),
      minimapDirtyVersion: 0, minimapSyncedVersion: 0, minimapSyncInProgress: false, minimapSyncQueued: false });
    spyOn(Blockly.WidgetDiv, 'isVisible').and.returnValue(false);
    spyOn(Blockly.DropDownDiv, 'isVisible').and.returnValue(false);
    input = document.createElement('input'); document.body.append(input);
    component.initMinimapSyncDebounce();
  });

  afterEach(() => {
    component.destroy$.next(); component.destroy$.complete();
    input.remove(); workspace.dispose(); mirror.dispose();
  });

  const changeSilently = (value: number) => {
    Blockly.Events.disable();
    try {
      workspace.clear(); workspace.newBlock('math_number', 'bulk-number').setFieldValue(value, 'NUM');
    } finally { Blockly.Events.enable(); }
    editor.requestWorkspaceVisualRefresh();
  };

  it('coalesces silent imports and renders the latest fields and deletions after the lease ends', fakeAsync(() => {
    blocked = true;
    changeSilently(1); changeSilently(2); tick(500);
    expect(mirror.getAllBlocks(false).length).toBe(0);
    blocked = false; tick(500); flushMicrotasks();
    expect(mirror.getBlocksByType('math_number', false)[0]?.getFieldValue('NUM')).toBe(2);
    expect((mirror as any).zoomToFit).toHaveBeenCalledTimes(1);
    Blockly.Events.disable();
    try { workspace.clear(); } finally { Blockly.Events.enable(); }
    editor.requestWorkspaceVisualRefresh(); tick(500); flushMicrotasks();
    expect(mirror.getAllBlocks(false).length).toBe(0);
  }));

  it('keeps input focused while pending, then refreshes on idle without generating code', fakeAsync(() => {
    input.focus(); changeSilently(42); tick(1000);
    expect(document.activeElement).toBe(input);
    expect(mirror.getAllBlocks(false).length).toBe(0);
    input.blur(); tick(500); flushMicrotasks();
    expect(mirror.getBlocksByType('math_number', false)[0]?.getFieldValue('NUM')).toBe(42);
  }));

  it('does not schedule work when disabled, disposed or receiving another workspace', fakeAsync(() => {
    component.minimap = null; changeSilently(1); tick(1000);
    expect(component.minimapDirtyVersion).toBe(0);
    component.minimap = { minimapWorkspace: mirror };
    editor.workspaceVisualRefreshRequestSubject.next(mirror); tick(500);
    expect(component.minimapDirtyVersion).toBe(0);
    component.destroy$.next(); editor.requestWorkspaceVisualRefresh(); tick(500);
    expect(component.minimapDirtyVersion).toBe(0);
  }));

  it('balances its event suppression inside an existing disabled scope', fakeAsync(() => {
    changeSilently(3);
    Blockly.Events.disable();
    try { tick(500); flushMicrotasks(); expect(Blockly.Events.isEnabled()).toBeFalse(); }
    finally { Blockly.Events.enable(); }
    expect(Blockly.Events.isEnabled()).toBeTrue();
  }));
});
