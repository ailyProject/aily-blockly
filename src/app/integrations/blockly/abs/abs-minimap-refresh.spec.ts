import { Subject } from 'rxjs';
import * as Blockly from 'blockly';
import { BlocklyComponent } from '../../../editors/blockly-editor/components/blockly/blockly.component';
import { WorkspaceMinimap } from '../../../editors/blockly-editor/utils/workspace-minimap';
import { BlocklyService } from '../../../editors/blockly-editor/services/blockly.service';

describe('bulk workspace minimap refresh', () => {
  let component: any;
  let editor: any;
  let workspace: Blockly.WorkspaceSvg;
  let minimap: WorkspaceMinimap;
  let host: HTMLDivElement;
  let blocked: boolean;
  let input: HTMLInputElement;

  beforeEach(() => {
    host = document.createElement('div'); host.style.cssText = 'width:800px;height:600px'; document.body.append(host);
    workspace = Blockly.inject(host, { scrollbars: true }); blocked = false;
    minimap = new WorkspaceMinimap(workspace, () => blocked);
    const refresh = new Subject<Blockly.WorkspaceSvg>();
    editor = Object.create(BlocklyService.prototype);
    Object.defineProperty(editor, 'workspace', {value: workspace, writable: true});
    Object.assign(editor, {workspaceVisualRefreshRequestSubject: refresh, workspaceVisualRefreshRequested$: refresh.asObservable()});
    component = Object.create(BlocklyComponent.prototype);
    Object.assign(component, { blocklyService: editor, minimap,
      ngZone: { runOutsideAngular: fn => fn() }, destroy$: new Subject<void>() });
    spyOn(Blockly.WidgetDiv, 'isVisible').and.returnValue(false);
    spyOn(Blockly.DropDownDiv, 'isVisible').and.returnValue(false);
    input = document.createElement('input'); document.body.append(input);
    component.initMinimapVisualRefresh();
  });
  afterEach(() => {
    component.destroy$.next(); component.destroy$.complete();
    minimap.dispose(); input.remove(); workspace.dispose(); host.remove();
  });
  const changeSilently = (value: number) => {
    Blockly.Events.disable();
    try {
      workspace.clear(); const block = workspace.newBlock('math_number', 'bulk-number');
      block.setFieldValue(value, 'NUM'); block.initSvg(); block.render();
    } finally { Blockly.Events.enable(); }
    editor.requestWorkspaceVisualRefresh();
  };

  const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  const content = () => host.querySelector('[data-minimap-source]')?.textContent ?? '';
  const waitForContent = async (expected: string) => {
    for (let i = 0; i < 60; i++) { await frame(); if (content() === expected) return; }
    expect(content()).toBe(expected);
  };

  it('coalesces silent imports and renders the latest fields and deletions after the lease ends', async () => {
    await frame(); blocked = true;
    changeSilently(1); changeSilently(2); await frame();
    expect(content()).toBe('');
    blocked = false; await waitForContent(workspace.getBlockById('bulk-number')!.getSvgRoot().textContent!);
    Blockly.Events.disable();
    try { workspace.clear(); } finally { Blockly.Events.enable(); }
    editor.requestWorkspaceVisualRefresh(); await waitForContent('');
  });

  it('keeps input focused while pending, then refreshes on idle without generating code', async () => {
    await frame(); input.focus(); changeSilently(42); await frame();
    expect(document.activeElement).toBe(input); expect(content()).toBe('');
    input.blur(); await waitForContent(workspace.getBlockById('bulk-number')!.getSvgRoot().textContent!);
  });

  it('does not schedule work when disabled, disposed or receiving another workspace', async () => {
    await frame(); const sync = spyOn(minimap, 'requestSync').and.callThrough();
    component.minimap = null; editor.requestWorkspaceVisualRefresh();
    expect(sync).not.toHaveBeenCalled();
    component.minimap = minimap;
    const other = new Blockly.Workspace();
    try { editor.workspaceVisualRefreshRequestSubject.next(other); expect(sync).not.toHaveBeenCalled(); }
    finally { other.dispose(); }
    component.destroy$.next(); editor.requestWorkspaceVisualRefresh(); await frame();
    expect(sync).not.toHaveBeenCalled();
  });

  it('preserves an existing disabled event scope without suppressing or replaying events', async () => {
    changeSilently(3); Blockly.Events.disable();
    try { await frame(); expect(Blockly.Events.isEnabled()).toBeFalse(); }
    finally { Blockly.Events.enable(); }
    expect(Blockly.Events.isEnabled()).toBeTrue();
  });
});
