import { fakeAsync, flushMicrotasks, tick } from '@angular/core/testing';
import * as Blockly from 'blockly';
import { BlocklyEditorComponent } from '../../../editors/blockly-editor/blockly-editor.component';
import { _BuilderService } from '../../../editors/blockly-editor/services/builder.service';
import { BehaviorSubject, Subject } from 'rxjs';
import { BlocklyComponent } from '../../../editors/blockly-editor/components/blockly/blockly.component';
import { BlocklyService } from '../../../editors/blockly-editor/services/blockly.service';
import { BlocklyGeneratorRuntimeService } from '../../../editors/blockly-editor/services/blockly-generator-runtime.service';
import { ProjectDebugConfigurationService, projectDataRuntime } from '@domain/project/public-api';

describe('generated artifact retry interaction boundary', () => {
  let component: any;
  let workspace: Blockly.WorkspaceSvg;
  let container: HTMLDivElement;
  let previousBuilder: any;
  beforeEach(() => {
    container = document.createElement('div'); document.body.append(container);
    workspace = Blockly.inject(container, {toolbox: {kind: 'flyoutToolbox', contents: []}});
    component = Object.create(BlocklyComponent.prototype);
    Object.assign(component, {destroy$: new Subject(), generatedArtifactRetryToken: 0,
      generatedArtifactRetryTimer: null, projectService: {currentProjectPath: '/project'},
      blocklyService: {workspace, getWorkspaceContentRevision: jasmine.createSpy('captureRevision').and.returnValue(7)}});
    previousBuilder = window['builder'];
    window['builder'] = {publishArduinoGeneratedCode: jasmine.createSpy('publish')};
  });
  afterEach(() => {
    component.clearGeneratedArtifactRetry(); workspace.currentGesture_ = null;
    workspace.dispose(); container.remove(); window['builder'] = previousBuilder;
  });
  it('does no project serialization or disk publication until the gesture ends', fakeAsync(() => {
    workspace.currentGesture_ = {} as Blockly.Gesture;
    component.scheduleGeneratedArtifactRetry('/project', [], 7);
    tick(3000);
    expect(component.blocklyService.getWorkspaceContentRevision).not.toHaveBeenCalled();
    expect(window['builder'].publishArduinoGeneratedCode).not.toHaveBeenCalled();
    workspace.currentGesture_ = null;
    tick(1000);
    expect(component.blocklyService.getWorkspaceContentRevision).toHaveBeenCalledTimes(1);
    expect(window['builder'].publishArduinoGeneratedCode).toHaveBeenCalledOnceWith('/project', {artifacts: []});
  }));
  it('drops an old project retry before capturing its replacement revision', fakeAsync(() => {
    component.scheduleGeneratedArtifactRetry('/project', [], 7);
    component.projectService.currentProjectPath = '/replacement'; tick(2000);
    expect(component.blocklyService.getWorkspaceContentRevision).not.toHaveBeenCalled();
    expect(window['builder'].publishArduinoGeneratedCode).not.toHaveBeenCalled();
  }));
});

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

describe('fresh prepared code debug consistency projection', () => {
  let component: any, editor: any, debug: ProjectDebugConfigurationService;
  let runtime: BlocklyGeneratorRuntimeService, workspace: Blockly.Workspace;
  let projectPath: BehaviorSubject<string>, revision: number, session: string;
  const digest = () => new Uint8Array(32).fill(0xaa).buffer;
  beforeEach(() => {
    workspace = new Blockly.Workspace(); runtime = new BlocklyGeneratorRuntimeService();
    runtime.activate({ mode: 'arduino', getWorkspace: () => workspace as any });
    revision = 1; session = 'project-session-1'; projectPath = new BehaviorSubject('/project');
    spyOn(projectDataRuntime, 'getSessionToken').and.callFake(() => session);
    debug = new ProjectDebugConfigurationService();
    spyOn<any>(debug, 'readConfigurationFile').and.returnValue({ schemaVersion: 1, kind: 'aily-project-debug-configuration', breakpoints: [] });
    spyOn<any>(debug, 'readArtifactState').and.returnValue({ revision: 'b'.repeat(64), sourceSha256: 'aa'.repeat(32), sourcePath: 'source.txt', consistencyError: '', error: '' });
    editor = Object.create(BlocklyService.prototype);
    Object.assign(editor, {
      _workspace: workspace, workspaceCodeRevision: 1, generatedCodeRevision: -1,
      latestGeneratedCode: 'unverified cached code', codeSubject: new BehaviorSubject('unverified cached code'),
      debugExecutionMarkerSubject: new BehaviorSubject(null), blockCodeMapSubject: new BehaviorSubject(new Map()),
      selectedBlockSubject: new BehaviorSubject(null), selectedBlockIdsSubject: new BehaviorSubject([]),
      codeViewerPublisher: null, getProjectPersistenceRevision: () => revision,
    });
    component = Object.create(BlocklyComponent.prototype);
    Object.assign(component, {
      blocklyService: editor, generatorRuntime: runtime, destroy$: new Subject<void>(),
      projectService: { currentProjectPath$: projectPath, get currentProjectPath() { return projectPath.value; } },
      projectDebugConfigurationService: debug,
      queueProjectBreakpointMarkerSync() {}, queueDebugExecutionMarkerSync() {},
    });
    component.initProjectDebugConfigurationSubscription();
  });
  afterEach(() => { component.destroy$.next(); component.destroy$.complete(); workspace.dispose(); runtime.destroy(); });

  it('hashes a fresh shared publication after reopen, but never replays a cached preview', fakeAsync(() => {
    const hash = spyOn(crypto.subtle, 'digest').and.resolveTo(digest());
    expect(debug.snapshot.buildConsistency).toBe('workspace-unknown');
    expect(hash).not.toHaveBeenCalled();
    editor.publishPreparedCodeView('current prepared code', null);
    expect(debug.snapshot.buildConsistency).toBe('checking');
    flushMicrotasks();
    expect(hash).toHaveBeenCalledTimes(1);
    expect(debug.snapshot.workspaceSourceSha256).toBe('aa'.repeat(32));
    expect(debug.snapshot.buildConsistency).toBe('current');
  }));

  it('keeps a genuine source mismatch dirty instead of labelling any fresh publication current', fakeAsync(() => {
    spyOn(crypto.subtle, 'digest').and.resolveTo(new Uint8Array(32).fill(0xbb).buffer);
    editor.publishPreparedCodeView('different prepared code', null); flushMicrotasks();
    expect(debug.snapshot.buildConsistency).toBe('dirty');
    expect(debug.snapshot.workspaceSourceSha256).toBe('bb'.repeat(32));
  }));

  it('does not consume reset notifications without a current workspace', fakeAsync(() => {
    const hash = spyOn(crypto.subtle, 'digest').and.resolveTo(digest());
    editor._workspace = null; editor.codeSubject.next(''); flushMicrotasks();
    expect(hash).not.toHaveBeenCalled();
    expect(debug.snapshot.buildConsistency).toBe('workspace-unknown');
  }));

  for (const invalidation of ['edit', 'silent-load', 'workspace', 'runtime', 'project-aba', 'destroy']) {
    it(`rejects an old successful hash after ${invalidation}`, fakeAsync(() => {
      let finish!: (value: ArrayBuffer) => void;
      spyOn(crypto.subtle, 'digest').and.returnValue(new Promise(resolve => { finish = resolve; }));
      editor.publishPreparedCodeView('current prepared code', null);
      expect(debug.snapshot.buildConsistency).toBe('checking');
      if (invalidation === 'edit') { editor.markWorkspaceCodeDirty(); debug.markWorkspaceDirty('/project'); }
      if (invalidation === 'silent-load') { revision++; editor.markWorkspaceCodeDirty(); }
      if (invalidation === 'workspace') editor._workspace = new Blockly.Workspace();
      if (invalidation === 'runtime') runtime.updateBoardConfig({ changed: true });
      if (invalidation === 'project-aba') { projectPath.next('/other'); session = 'project-session-2'; projectPath.next('/project'); }
      if (invalidation === 'destroy') { component.destroy$.next(); component.destroy$.complete(); }
      finish(digest()); flushMicrotasks();
      expect(debug.snapshot.workspaceSourceSha256).toBe('');
      expect(debug.snapshot.buildConsistency).not.toBe('current');
      if (invalidation === 'workspace') editor._workspace.dispose();
    }));
  }

  it('does not let an old hash error overwrite the next project state', fakeAsync(() => {
    let fail!: (error: Error) => void;
    spyOn(crypto.subtle, 'digest').and.returnValue(new Promise((_resolve, reject) => { fail = reject; }));
    editor.publishPreparedCodeView('current prepared code', null);
    projectPath.next('/other'); session = 'project-session-2'; projectPath.next('/project');
    const before = debug.snapshot;
    fail(new Error('late old hash failure')); flushMicrotasks();
    expect(debug.snapshot).toEqual(before);
  }));

  it('stops consuming publications when the component owner is destroyed', fakeAsync(() => {
    const hash = spyOn(crypto.subtle, 'digest').and.resolveTo(digest());
    component.destroy$.next(); component.destroy$.complete();
    editor.publishPreparedCodeView('next prepared code', null); flushMicrotasks();
    expect(hash).not.toHaveBeenCalled();
  }));
});
