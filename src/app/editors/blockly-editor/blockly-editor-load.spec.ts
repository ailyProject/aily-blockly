import { BehaviorSubject, Subject } from 'rxjs';
import * as Blockly from 'blockly';
import { BlocklyEditorComponent } from './blockly-editor.component';
import { ProjectService, projectDataRuntime } from '@domain/project/public-api';
import { BlocklyService } from './services/blockly.service';
import { canTransferProjectAbi } from './utils/project-abi-transfer';
import { BlocklyLibraryPackageService } from '@domain/dependencies/public-api';

describe('legacy native-procedure library validation', () => {
  function fixture() {
    const service: any = Object.create(BlocklyLibraryPackageService.prototype);
    service.electronService = { exists: () => true, readFile: () => 'Arduino.forBlock.procedures_defnoreturn = () => "";' };
    const snapshot: any = { readErrors: [], packageJson: { name: '@aily-project/lib-core-functions', version: '0.0.1' },
      blockJson: [], toolboxJson: { kind: 'category', name: '函数定义', custom: 'PROCEDURE' },
      paths: { packageJson: 'package.json', blockJson: 'block.json', toolboxJson: 'toolbox.json', generatorJs: 'generator.js' } };
    snapshot.toolboxRoot = snapshot.toolboxJson;
    return { service, snapshot };
  }
  it('accepts the published dynamic native-procedure category without declarative shapes or static contents', () => {
    const { service, snapshot } = fixture();
    expect(service.validateLibraryPackage(snapshot).errors).toEqual([]);
  });
  it('still rejects an empty shape list from an ordinary or new functions library', () => {
    const { service, snapshot } = fixture();
    snapshot.packageJson.version = '1.0.1';
    expect(service.validateLibraryPackage(snapshot).valid).toBeFalse();
  });
  it('keeps malformed static categories and unknown dynamic callbacks invalid', () => {
    const { service, snapshot } = fixture();
    snapshot.toolboxJson.custom = 'UNKNOWN';
    expect(service.validateLibraryPackage(snapshot).valid).toBeFalse();
  });
  it('keeps a broken generator invalid even for the legacy native library', () => {
    const { service, snapshot } = fixture();
    service.electronService.readFile = () => 'Arduino.forBlock.broken = ;';
    expect(service.validateLibraryPackage(snapshot).valid).toBeFalse();
  });
});

describe('failed Blockly open recovery', () => {
  for (const toolboxReady of [false, true]) {
    it(`${toolboxReady ? 'preserves a loaded toolbox' : 'disposes an unprepared runtime'} after program load failure`, async () => {
      const route = new Subject<any>(); const board = new Subject<any>();
      const component: any = Object.create(BlocklyEditorComponent.prototype);
      Object.assign(component, {
        projectLoadSequence: 0, activatedRoute: { queryParams: route },
        _projectService: { init() {} }, _builderService: { init() {} }, _uploadService: { init() {} },
        projectService: { boardConfigUpdatedSubject: board, beginBlocklyProjectLoad() {},
          markBlocklyProjectLoadFailed: jasmine.createSpy('failed') },
        uiService: { updateFooterState: jasmine.createSpy('footer') },
        message: { error: jasmine.createSpy('error') },
        localLibrarySyncService: { stop: jasmine.createSpy('stop') },
        clearProjectLoadedCodeRefreshTimer: jasmine.createSpy('clearRefresh'),
        stopPackageJsonDependencyWatch: jasmine.createSpy('stopWatch'),
        abortFailedProjectLoad: jasmine.createSpy('abort'),
        loadProject: async () => {
          if (toolboxReady) component.toolboxReadyProjectPath = '/failed';
          throw new Error('Blockly changed or discarded persisted state at /attributes/extraState.');
        },
      });
      spyOn(projectDataRuntime, 'configure');
      spyOn(projectDataRuntime, 'getSessionToken').and.returnValue('session');
      spyOn(window.history, 'replaceState'); spyOn(window.history, 'pushState');
      component.ngOnInit();
      try {
        route.next({ path: '/failed' });
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(component.loadedProjectPath).toBeUndefined();
        expect(component.projectService.markBlocklyProjectLoadFailed).toHaveBeenCalledWith('/failed', jasmine.stringMatching(/extraState/));
        expect(component.uiService.updateFooterState).toHaveBeenCalledWith(jasmine.objectContaining({ state: 'error' }));
        if (toolboxReady) {
          expect(component.abortFailedProjectLoad).not.toHaveBeenCalled();
          expect(component.toolboxOnlyProjectPath).toBe('/failed');
          expect(component.stopPackageJsonDependencyWatch).toHaveBeenCalled();
        } else {
          expect(component.abortFailedProjectLoad).toHaveBeenCalled();
        }
      } finally { component.projectRouteSubscription.unsubscribe(); component.boardConfigUpdatedSubscription.unsubscribe(); }
    });
  }

});

describe('deep project ABI parser transport', () => {
  it('bypasses structured cloning of long graphs without parsing twice', async () => {
    const component: any = Object.create(BlocklyEditorComponent.prototype);
    const text = '['.repeat(2300) + '0' + ']'.repeat(2300);
    component.waitForNextFrame = jasmine.createSpy('frame').and.resolveTo();
    component.parseProjectAbiContentInWorker = jasmine.createSpy('worker').and.throwError('must not transfer');
    const parsed = await component.parseProjectAbiContent(text);
    let tail = parsed; for (let i = 0; i < 2300; i++) tail = tail[0];
    expect(tail).toBe(0);
    expect(component.parseProjectAbiContentInWorker).not.toHaveBeenCalled();
    expect(component.waitForNextFrame).toHaveBeenCalledTimes(1);
    await expectAsync(component.parseProjectAbiContent('['.repeat(2300))).toBeRejectedWithError(SyntaxError);
  });
  it('ignores braces, escaped quotes and backslashes inside saved strings', () => {
    expect(canTransferProjectAbi(JSON.stringify({ text: '{[\\"'.repeat(3000) }))).toBeTrue();
    expect(canTransferProjectAbi('['.repeat(256) + '0' + ']'.repeat(256))).toBeTrue();
    expect(canTransferProjectAbi('['.repeat(257) + '0' + ']'.repeat(257))).toBeFalse();
  });
});

describe('project load normalization context', () => {
  let component: any;
  let current: boolean;
  const guard = () => { if (!current) throw new Error('stale load'); };
  beforeEach(() => {
    current = true;
    component = Object.create(BlocklyEditorComponent.prototype);
    component.electronService = { pathJoin: (...parts: string[]) => parts.join('/'), readFileAsync: jasmine.createSpy('read').and.resolveTo('{}') };
    component.parseProjectAbiContent = jasmine.createSpy('parse').and.callFake(async text => JSON.parse(text));
    component.projectService = { ensureProjectDataSchemaForLoad: jasmine.createSpy('normalize').and.callFake(async (_path, document) => document) };
    component.blocklyService = { normalizeProjectAbiForLoad: jasmine.createSpy('model').and.callFake(value => value) };
  });
  it('does not begin migration after navigation during the file read', async () => {
    component.electronService.readFileAsync.and.callFake(async () => { current = false; return '{}'; });
    await expectAsync(component.loadProjectAbiDocument('D:/old', guard)).toBeRejectedWithError('stale load');
    expect(component.parseProjectAbiContent).not.toHaveBeenCalled();
    expect(component.projectService.ensureProjectDataSchemaForLoad).not.toHaveBeenCalled();
  });
  it('does not begin migration after navigation during worker parsing', async () => {
    component.parseProjectAbiContent.and.callFake(async () => { current = false; return {}; });
    await expectAsync(component.loadProjectAbiDocument('D:/old', guard)).toBeRejectedWithError('stale load');
    expect(component.projectService.ensureProjectDataSchemaForLoad).not.toHaveBeenCalled();
  });
  it('passes the same guard to disk and in-memory template normalization', async () => {
    component.electronService.readFileAsync.and.resolveTo('{"blocks":{"blocks":[]}}');
    const template = { blocks: { blocks: [{ type: 'arduino_setup', id: 'protected', deletable: false }] } };
    component.readCurrentBoardTemplateAbi = jasmine.createSpy('template').and.resolveTo(template);
    const result = await component.loadProjectAbiDocument('D:/project', guard);
    expect(result.usedBoardTemplate).toBeTrue();
    expect(result.diskText).toBe('{"blocks":{"blocks":[]}}');
    expect(component.projectService.ensureProjectDataSchemaForLoad.calls.argsFor(0)[3]).toBe(guard);
    expect(component.projectService.ensureProjectDataSchemaForLoad.calls.argsFor(1)).toEqual(['D:/project', template, undefined, guard]);
  });
  it('anchors exact migration publication bytes rather than rereading a possible external edit', async () => {
    component.projectService.ensureProjectDataSchemaForLoad.and.callFake(async (_path, document, _text, check, published) => {
      check(); published('{"migrated":true}');
      component.electronService.readFileAsync.and.resolveTo('{"external":true}');
      return document;
    });
    const result = await component.loadProjectAbiDocument('D:/project', guard);
    expect(result.diskText).toBe('{"migrated":true}');
    expect(component.electronService.readFileAsync).toHaveBeenCalledTimes(1);
  });
  it('does not return an old document after normalization completes in a new context', async () => {
    component.projectService.ensureProjectDataSchemaForLoad.and.callFake(async () => { current = false; return {}; });
    await expectAsync(component.loadProjectAbiDocument('D:/old', guard)).toBeRejectedWithError('stale load');
    expect(component.blocklyService.normalizeProjectAbiForLoad).not.toHaveBeenCalled();
  });

  it('late failure of a route load cannot abort or mark failed a newer project', async () => {
    const route = new Subject<any>(); const board = new Subject<any>(); let session = 0;
    component.projectLoadSequence = 0; component.loadedProjectPath = null;
    component.activatedRoute = { queryParams: route };
    component._projectService = { init: () => {} }; component._builderService = { init: () => {} }; component._uploadService = { init: () => {} };
    Object.assign(component.projectService, { boardConfigUpdatedSubject: board,
      beginBlocklyProjectLoad: () => {}, markBlocklyProjectLoadFailed: jasmine.createSpy('failed') });
    component.abortFailedProjectLoad = jasmine.createSpy('abort'); component.message = { error: jasmine.createSpy('error') };
    let rejectOld!: (error: Error) => void;
    component.loadProject = jasmine.createSpy('load').and.callFake(path => path === 'old'
      ? new Promise((_, reject) => { rejectOld = reject; }) : Promise.resolve());
    spyOn(projectDataRuntime, 'configure').and.callFake(() => { session++; });
    spyOn(projectDataRuntime, 'getSessionToken').and.callFake(() => String(session));
    spyOn(window.history, 'replaceState'); spyOn(window.history, 'pushState');
    component.ngOnInit();
    try {
      route.next({ path: 'old' }); route.next({ path: 'new' });
      rejectOld(new Error('old host acknowledgement failed'));
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(component.loadedProjectPath).toBe('new');
      expect(component.abortFailedProjectLoad).not.toHaveBeenCalled();
      expect(component.projectService.markBlocklyProjectLoadFailed).not.toHaveBeenCalled();
      expect(component.message.error).not.toHaveBeenCalled();
    } finally { component.projectRouteSubscription.unsubscribe(); component.boardConfigUpdatedSubscription.unsubscribe(); }
  });
});

describe('Blockly dependency preparation cancellation', () => {
  it('restores an unchanged viewport without closing a category opened during startup', async () => {
    const host = document.createElement('div');
    host.style.cssText = 'width:800px;height:600px'; document.body.append(host);
    Blockly.Blocks['startup_view_probe'] = {init() {this.appendDummyInput().appendField('probe');}};
    const workspace = Blockly.inject(host, {toolbox: {kind: 'categoryToolbox', contents: [
      {kind: 'category', name: 'Probe', contents: [{kind: 'block', type: 'startup_view_probe'}]},
    ]}, zoom: {startScale: 1, minScale: 0.5, maxScale: 2}, move: {scrollbars: true}});
    const service: any = Object.create(BlocklyService.prototype);
    Object.defineProperty(service, 'workspace', {value: workspace});
    try {
      workspace.getToolbox()!.selectItemByPosition(0);
      await Blockly.renderManagement.finishQueuedRenders();
      expect(workspace.getFlyout()!.isVisible()).toBeTrue();
      service.restoreWorkspaceViewState({scale: 1, scrollX: 0, scrollY: 0});
      expect(workspace.getFlyout()!.isVisible()).toBeTrue();
      service.restoreWorkspaceViewState({scale: 0.75, scrollX: 0, scrollY: 0});
      expect(workspace.scale).toBe(0.75);
    } finally {workspace.dispose(); host.remove(); delete Blockly.Blocks['startup_view_probe'];}
  });
  it('unsubscribes a workspace readiness wait when its session is aborted', async () => {
    const service: any = Object.create(BlocklyService.prototype);
    const ready = new BehaviorSubject(null);
    service.workspaceReadySubject = ready;
    const controller = new AbortController();
    const waiting = service.waitForWorkspace(controller.signal);
    expect(ready.observers.length).toBe(1);
    controller.abort();
    await expectAsync(waiting).toBeRejected();
    expect(ready.observers.length).toBe(0);
  });

  it('cancels a suspended animation frame instead of waiting for it on close', async () => {
    const component: any = Object.create(BlocklyEditorComponent.prototype);
    const controller = new AbortController();
    spyOn(window, 'requestAnimationFrame').and.returnValue(42);
    const cancel = spyOn(window, 'cancelAnimationFrame');
    const waiting = component.waitForNextFrame(controller.signal);
    controller.abort();
    await expectAsync(waiting).toBeRejected();
    expect(cancel).toHaveBeenCalledOnceWith(42);
  });

  it('terminates a cancelled parser worker without starting the main-thread fallback', async () => {
    const component: any = Object.create(BlocklyEditorComponent.prototype);
    const worker = { postMessage: jasmine.createSpy('post'), terminate: jasmine.createSpy('terminate') };
    spyOn(window, 'Worker').and.returnValue(worker as any);
    component.parseProjectAbiContentOnMainThread = jasmine.createSpy('fallback');
    const controller = new AbortController();
    const parsing = component.parseProjectAbiContent('{}', controller.signal);
    controller.abort();
    await expectAsync(parsing).toBeRejected();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(component.parseProjectAbiContentOnMainThread).not.toHaveBeenCalled();
  });

  it('settles a missing-library dialog on close and rejects its old install callback', async () => {
    const lifecycle = (Object.create(ProjectService.prototype) as any).dependencyLifecycle;
    const session = lifecycle.beginPreparation('/project');
    const component: any = Object.create(BlocklyEditorComponent.prototype);
    component.projectService = {
      assertProjectDependencySession: (current: any) => lifecycle.assertCurrent(current),
      runProjectDependencyTask: (current: any, work: () => Promise<any>) => lifecycle.run(current, work),
    };
    const closed = new Subject<any>();
    const modal = { afterClose: closed, destroy: jasmine.createSpy('destroy').and.callFake(() => closed.next(undefined)) };
    let install!: () => Promise<void>;
    component.modal = { create: (options: any) => { install = () => options.nzData.installFn([]); return modal; } };
    component.installMissingBlocklyLibraries = jasmine.createSpy('install').and.resolveTo();
    const waiting = lifecycle.run(session, () => component.restoreMissingProjectLibraries('/project', [], session));
    lifecycle.cancel('/project');
    await expectAsync(waiting).toBeRejectedWith(jasmine.objectContaining({ code: 'PROJECT_DEPENDENCY_CANCELLED' }));
    await lifecycle.waitForIdle(session);
    expect(modal.destroy).toHaveBeenCalledTimes(1);
    await expectAsync(install()).toBeRejectedWith(jasmine.objectContaining({ code: 'PROJECT_DEPENDENCY_CANCELLED' }));
    expect(component.installMissingBlocklyLibraries).not.toHaveBeenCalled();
    closed.complete();
  });
});
