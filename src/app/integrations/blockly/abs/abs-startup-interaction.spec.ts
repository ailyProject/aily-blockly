import { fakeAsync, flushMicrotasks, tick } from '@angular/core/testing';
import * as Blockly from 'blockly';
import { BlocklyEditorComponent } from '../../../editors/blockly-editor/blockly-editor.component';
import { _BuilderService } from '../../../editors/blockly-editor/services/builder.service';

describe('project startup publication scheduling', () => {
  let component: any;
  let blocked: boolean;
  beforeEach(() => {
    blocked = false;
    component = Object.create(BlocklyEditorComponent.prototype);
    Object.assign(component, {
      projectLoadSequence: 1, projectLoadedCodeRefreshSequence: 0, projectLoadedCodeRefreshDelayMs: 1000, projectLoadedCodeRefreshTimer: null,
      projectService: { currentProjectPath: '/project' },
      blocklyService: { workspace: {}, isWorkspaceEditBlocked: () => blocked },
      _builderService: { generateAndWriteProjectSourceInBackground: jasmine.createSpy('background').and.resolveTo(true) },
    });
  });
  afterEach(() => component.clearProjectLoadedCodeRefreshTimer());

  it('coalesces startup requests and retries only pending interaction or build contention', fakeAsync(() => {
    component.scheduleProjectLoadedCodeRefresh(); component.scheduleProjectLoadedCodeRefresh();
    blocked = true; tick(1000);
    expect(component._builderService.generateAndWriteProjectSourceInBackground).not.toHaveBeenCalled();
    blocked = false;
    let attempts = 0;
    component._builderService.generateAndWriteProjectSourceInBackground.and.callFake(async () => {
      attempts++;
      if (attempts === 2) throw new Error('BUILD_WORKSPACE_BUSY: compile');
      return attempts > 2;
    });
    tick(3000);
    expect(component._builderService.generateAndWriteProjectSourceInBackground).toHaveBeenCalledTimes(3);
    tick(3000);
    expect(component._builderService.generateAndWriteProjectSourceInBackground).toHaveBeenCalledTimes(3);
  }));

  it('does not restart pending work after navigation or destruction during an await', fakeAsync(() => {
    let finish: (value: boolean) => void;
    component._builderService.generateAndWriteProjectSourceInBackground.and.callFake(() => new Promise(resolve => { finish = resolve; }));
    component.scheduleProjectLoadedCodeRefresh(); tick(1000);
    const cancelled = component._builderService.generateAndWriteProjectSourceInBackground.calls.mostRecent().args[0];
    component.projectLoadSequence++;
    expect(cancelled()).toBeTrue(); finish!(false); flushMicrotasks(); tick(5000);
    expect(component.projectLoadedCodeRefreshTimer).toBeNull();
    expect(component._builderService.generateAndWriteProjectSourceInBackground).toHaveBeenCalledTimes(1);
  }));

  it('drops a timer bound to an old workspace and reports real errors without an endless retry', fakeAsync(() => {
    component.scheduleProjectLoadedCodeRefresh(); component.blocklyService.workspace = {}; tick(1000);
    expect(component._builderService.generateAndWriteProjectSourceInBackground).not.toHaveBeenCalled();
    spyOn(console, 'warn');
    component._builderService.generateAndWriteProjectSourceInBackground.and.rejectWith(new Error('broken generator'));
    component.scheduleProjectLoadedCodeRefresh(); tick(5000);
    expect(component._builderService.generateAndWriteProjectSourceInBackground).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalled();
  }));

  it('invalidates an in-flight attempt when explicitly rescheduled', fakeAsync(() => {
    let finish: (value: boolean) => void;
    component._builderService.generateAndWriteProjectSourceInBackground.and.callFake(() => new Promise(resolve => { finish = resolve; }));
    component.scheduleProjectLoadedCodeRefresh(); tick(1000);
    const cancelled = component._builderService.generateAndWriteProjectSourceInBackground.calls.mostRecent().args[0];
    component.scheduleProjectLoadedCodeRefresh();
    expect(cancelled()).toBeTrue(); finish!(false); flushMicrotasks();
    component._builderService.generateAndWriteProjectSourceInBackground.and.resolveTo(true);
    tick(5000);
    expect(component._builderService.generateAndWriteProjectSourceInBackground).toHaveBeenCalledTimes(2);
  }));
});

describe('project startup source publication', () => {
  let builder: any;
  let workspace: any;
  let prepared: any;
  let previousBuilder: any;
  let input: HTMLInputElement;
  beforeEach(() => {
    previousBuilder = window['builder'];
    window['builder'] = { publishArduinoGeneratedCode: jasmine.createSpy('publishArduino') };
    workspace = { isDragging: () => false, getInjectionDiv: () => document.body };
    prepared = { code: 'latest code', artifacts: [], blockCodeMapText: '[]' };
    spyOn(Blockly.WidgetDiv, 'isVisible').and.returnValue(false);
    spyOn(Blockly.DropDownDiv, 'isVisible').and.returnValue(false);
    builder = Object.create(_BuilderService.prototype);
    Object.assign(builder, {
      projectService: { currentProjectPath: '/project', currentPackageData: { devmode: 'arduino' } },
      electronService: { pathJoin: (...parts) => parts.join('/') },
      writeTextFileAtomic: jasmine.createSpy('writePython').and.resolveTo(),
      blocklyService: { workspace, publishPreparedCodeView: jasmine.createSpy('view'),
        runWithPreparedProjectCode: jasmine.createSpy('exclusive'),
        runWithBackgroundProjectCode: jasmine.createSpy('background').and.callFake(async (consume, interacting) => {
          if (interacting()) return false;
          await consume(prepared, () => { if (interacting()) throw new Error('invalidated'); }); return true;
        }) },
    });
    input = document.createElement('input'); document.body.append(input);
  });
  afterEach(() => { window['builder'] = previousBuilder; input.remove(); });

  it('writes Arduino source and preview from the same background snapshot, without an edit lease', async () => {
    expect(await builder.generateAndWriteProjectSourceInBackground(() => false)).toBeTrue();
    expect(window['builder'].publishArduinoGeneratedCode).toHaveBeenCalledOnceWith('/project', { artifacts: [], sketchCode: 'latest code' });
    expect(builder.blocklyService.publishPreparedCodeView).toHaveBeenCalledOnceWith('latest code', '[]');
    expect(builder.blocklyService.runWithPreparedProjectCode).not.toHaveBeenCalled();
    expect(builder.writeTextFileAtomic).not.toHaveBeenCalled();
  });

  it('preserves Python mode and never writes an Arduino sketch for it', async () => {
    builder.projectService.currentPackageData.devmode = 'python'; prepared.artifacts = null;
    expect(await builder.generateAndWriteProjectSourceInBackground(() => false)).toBeTrue();
    expect(builder.writeTextFileAtomic).toHaveBeenCalledOnceWith('/project/main.py', 'latest code');
    expect(window['builder'].publishArduinoGeneratedCode).not.toHaveBeenCalled();
  });

  it('defers dragging, text editing and dropdowns then publishes once idle', async () => {
    workspace.currentGesture_ = {};
    expect(await builder.generateAndWriteProjectSourceInBackground(() => false)).toBeFalse();
    workspace.currentGesture_ = null; input.focus();
    expect(await builder.generateAndWriteProjectSourceInBackground(() => false)).toBeFalse();
    expect(document.activeElement).toBe(input); input.blur();
    (Blockly.DropDownDiv.isVisible as jasmine.Spy).and.returnValue(true);
    expect(await builder.generateAndWriteProjectSourceInBackground(() => false)).toBeFalse();
    expect(window['builder'].publishArduinoGeneratedCode).not.toHaveBeenCalled();
    (Blockly.DropDownDiv.isVisible as jasmine.Spy).and.returnValue(false);
    expect(await builder.generateAndWriteProjectSourceInBackground(() => false)).toBeTrue();
  });

  it('does not start cancelled work or publish a preview after the source write switches project', async () => {
    expect(await builder.generateAndWriteProjectSourceInBackground(() => true)).toBeFalse();
    expect(builder.blocklyService.runWithBackgroundProjectCode).not.toHaveBeenCalled();
    window['builder'].publishArduinoGeneratedCode.and.callFake(() => { builder.projectService.currentProjectPath = '/other'; });
    await expectAsync(builder.generateAndWriteProjectSourceInBackground(() => false)).toBeRejectedWithError('invalidated');
    expect(builder.blocklyService.publishPreparedCodeView).not.toHaveBeenCalled();
  });
});
