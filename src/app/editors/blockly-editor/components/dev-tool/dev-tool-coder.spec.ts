import { BehaviorSubject, Subject } from 'rxjs';
import { DevToolComponent } from './dev-tool.component';

describe('DevToolComponent in Coder mode', () => {
  const projectPath = '/workspace/coder-a';

  function createHarness(mode: 'blockly' | 'coder' = 'coder') {
    const path$ = new BehaviorSubject(projectPath);
    const projectService = {
      currentProjectPath: projectPath,
      currentProjectPath$: path$.asObservable(),
      boardChangeSubject: new Subject<void>(),
      isProjectOpening: false,
      getProjectMode: jasmine.createSpy('getProjectMode').and.returnValue(mode),
      getCoderOperation: jasmine.createSpy('getCoderOperation').and.returnValue(null),
      getBoardPackagePath: jasmine.createSpy('getBoardPackagePath').and.callFake(async () =>
        `${projectService.currentProjectPath}/node_modules/board`),
      save: jasmine.createSpy('save').and.resolveTo({ success: true }),
      projectOpen: jasmine.createSpy('projectOpen').and.resolveTo(true),
    };
    const builderService = { clearBuildCache: jasmine.createSpy('clearBuildCache').and.resolveTo() };
    const actionService = { dispatch: jasmine.createSpy('dispatch') };
    const electronService = { deleteDir: jasmine.createSpy('deleteDir') };
    const messageService = {
      success: jasmine.createSpy('success'),
      warning: jasmine.createSpy('warning'),
      error: jasmine.createSpy('error'),
    };
    const component = Object.create(DevToolComponent.prototype) as DevToolComponent;
    Object.assign(component, {
      projectService, builderService, actionService, electronService, messageService,
      configService: { data: { devmode: { enabled: false, autoSave: true } } },
      ailyChatDemandSession: { diagramGenerationState$: new BehaviorSubject({ architecture: null, schematic: null }) },
      ngZone: { run: (fn: () => void) => fn() },
    });
    spyOn(component, 'loadBoardInfo');
    component.ngOnInit();
    return { component, path$, projectService, builderService, actionService, electronService, messageService };
  }

  it('uses Coder reload persistence without a second Blockly save', async () => {
    const { component, projectService } = createHarness();
    await component.reload();
    expect(projectService.save).not.toHaveBeenCalled();
    expect(projectService.projectOpen).toHaveBeenCalledOnceWith(projectPath, { reason: 'reload' });
    component.ngOnDestroy();
  });

  it('keeps the Blockly save before reload', async () => {
    const { component, projectService } = createHarness('blockly');
    await component.reload();
    expect(projectService.save).toHaveBeenCalledOnceWith(projectPath);
    expect(projectService.projectOpen).toHaveBeenCalledOnceWith(projectPath, { reason: 'reload' });
    component.ngOnDestroy();
  });

  it('clears only Coder rebuildable cache and blocks an active operation', async () => {
    const { component, projectService, builderService, actionService, electronService, messageService } = createHarness();
    await component.clear();
    expect(builderService.clearBuildCache).toHaveBeenCalledOnceWith(projectPath);
    expect(actionService.dispatch).not.toHaveBeenCalled();
    expect(electronService.deleteDir).not.toHaveBeenCalled();

    projectService.getCoderOperation.and.returnValue({ kind: 'build' });
    await component.clear();
    expect(builderService.clearBuildCache).toHaveBeenCalledTimes(1);
    expect(messageService.warning).toHaveBeenCalled();
    component.ngOnDestroy();
  });

  it('refreshes the board package when the active Coder tab changes', async () => {
    const { component, path$, projectService } = createHarness();
    const resolveBoardPackagePath = (component as any).resolveBoardPackagePath.bind(component);
    expect(await resolveBoardPackagePath()).toBe(`${projectPath}/node_modules/board`);
    projectService.currentProjectPath = '/workspace/coder-b';
    path$.next(projectService.currentProjectPath);
    expect(await resolveBoardPackagePath()).toBe('/workspace/coder-b/node_modules/board');
    expect(projectService.getBoardPackagePath).toHaveBeenCalledTimes(2);
    component.ngOnDestroy();
  });
});
