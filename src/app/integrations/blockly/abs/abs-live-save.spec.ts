import { fakeAsync, flushMicrotasks, tick } from '@angular/core/testing';
import { BlocklyLiveOperationBridgeService } from '@integration/automation/public-api';
import { BlocklyEditorAutomationAdapter } from '../blockly-editor-automation.adapter';
import { ProjectApplicationAdapter } from '../../project/project-application.adapter';
import { AbsWorkspaceSyncService } from './abs-workspace-sync.service';

describe('ABS save with deferred generated code', () => {
  let previousLibraries: any;
  beforeEach(() => { previousLibraries = window['libraryDependencies']; });
  afterEach(() => { window['libraryDependencies'] = previousLibraries; });
  for (const dependencyFailure of [false, true]) it(`retains committed facts and separates dependency failure=${dependencyFailure}`, async () => {
    let save!: (path: string) => Promise<any>;
    const project = { currentProjectPath: '/isolated', setAbsSaveHandler: handler => { save = handler; } };
    const service = new AbsWorkspaceSyncService({} as any, project as any);
    const exportGeneration = spyOn(service, 'exportGeneration').and.resolveTo({
      publication: { status: 'COMMITTED' }, requiresReload: false, warnings: ['busy'],
      derivedOutputs: { published: false, code: 'BUILD_WORKSPACE_BUSY', error: 'active build' },
    } as any);
    window['libraryDependencies'] = { save: jasmine.createSpy('libraries').and.callFake(async () => {
      if (dependencyFailure) throw new Error('dependency save failed');
    }) };
    expect(await save('/isolated')).toEqual(jasmine.objectContaining({ projectSaved: true,
      generatedCodePublished: false, partial: true,
      code: dependencyFailure ? 'PROJECT_DEPENDENCY_SAVE_FAILED' : 'BUILD_WORKSPACE_BUSY' }));
    expect(exportGeneration).toHaveBeenCalledOnceWith({ save: true });
  });
});

describe('live Blockly save completion', () => {
  function fixture() {
    const service: any = Object.create(BlocklyLiveOperationBridgeService.prototype);
    service.aiWritingDepth = 0;
    service.projectService = {
      currentProjectPath: '/isolated',
      ensureBlocklyLibraryRuntimeReady: jasmine.createSpy('ready').and.resolveTo(),
      save: jasmine.createSpy('uiActionSave').and.throwError('Must not use a detached UI feedback timer'),
    };
    let resolveSave!: () => void, rejectSave!: (error: Error) => void;
    const save = new Promise<void>((resolve, reject) => { resolveSave = resolve; rejectSave = reject; });
    const workspace = { getTopBlocks: () => [{}, {}], cleanUp: jasmine.createSpy('cleanUp') };
    service.blocklyEditor = {
      getWorkspace: () => workspace,
      runWorkspaceOperation: async operation => operation(),
      saveProject: jasmine.createSpy('editorSave').and.returnValue(save),
      setAiWritingActive: jasmine.createSpy('writing'),
    };
    return { service, workspace, resolveSave, rejectSave };
  }

  for (const operation of ['executeBlocksTidy', 'executeProjectSave']) {
    it(`${operation} rejects a project switch during readiness without touching the replacement workspace`, async () => {
      const f = fixture();
      f.service.projectService.ensureBlocklyLibraryRuntimeReady.and.callFake(async () => {
        f.service.projectService.currentProjectPath = '/replacement';
      });
      await expectAsync(f.service[operation]()).toBeRejectedWithError(/所属项目已改变/);
      expect(f.workspace.cleanUp).not.toHaveBeenCalled();
      expect(f.service.blocklyEditor.saveProject).not.toHaveBeenCalled();
    });

    it(`${operation} waits for the real save even beyond the old five-second feedback deadline`, fakeAsync(() => {
      const f = fixture(), result = jasmine.createSpy('result');
      f.service.runBlockWritingOperation(() => f.service[operation]()).then(result);
      flushMicrotasks();
      expect(f.service.blocklyEditor.saveProject).toHaveBeenCalledOnceWith('/isolated');
      tick(6000);
      expect(result).not.toHaveBeenCalled(); expect(f.service.aiWritingDepth).toBe(1);
      f.resolveSave(); flushMicrotasks();
      expect(result).toHaveBeenCalledOnceWith(jasmine.objectContaining({ ok: true, project: '/isolated' }));
      expect(f.service.aiWritingDepth).toBe(0);
      expect(f.service.projectService.save).not.toHaveBeenCalled();
    }));

    it(`${operation} reports the real failure and releases writing ownership once`, fakeAsync(() => {
      const f = fixture(), result = jasmine.createSpy('result');
      f.service.runBlockWritingOperation(() => f.service[operation]()).then(result);
      flushMicrotasks(); tick(6000);
      f.rejectSave(new Error('disk commit failed')); flushMicrotasks();
      expect(result).toHaveBeenCalledOnceWith(jasmine.objectContaining({ ok: false, project: '/isolated', message: jasmine.stringMatching('disk commit failed') }));
      expect(f.service.aiWritingDepth).toBe(0);
      expect(f.service.blocklyEditor.setAiWritingActive.calls.allArgs()).toEqual([
        ['live-blockly-operation', true], ['live-blockly-operation', false],
      ]);
    }));

    for (const code of ['BUILD_WORKSPACE_BUSY', 'PROJECT_DEPENDENCY_SAVE_FAILED']) {
      it(`${operation} keeps a saved source in place after ${code}`, async () => {
        const f = fixture();
        const pending = f.service[operation]();
        f.rejectSave(Object.assign(new Error('The source is saved; a later stage failed.'), {
          code, projectSaved: true, generatedCodePublished: false, partial: true,
        }));
        const result = await pending;
        expect(result).toEqual(jasmine.objectContaining({ ok: false, projectSaved: true,
          generatedCodePublished: false, partial: true, code }));
        expect(result.recovery).toContain('this same project');
        expect(result.recovery).not.toContain('fork');
      });
    }
  }

  it('rejects a project switch while tidy is queued before touching either workspace', async () => {
    const f = fixture();
    f.service.blocklyEditor.runWorkspaceOperation = async operation => {
      f.service.projectService.currentProjectPath = '/replacement';
      return operation();
    };
    await expectAsync(f.service.executeBlocksTidy()).toBeRejectedWithError(/所属项目已改变/);
    expect(f.workspace.cleanUp).not.toHaveBeenCalled();
    expect(f.service.blocklyEditor.saveProject).not.toHaveBeenCalled();
  });
});

describe('save outcome adapters', () => {
  const partial = { projectSaved: true, generatedCodePublished: false, partial: true,
    code: 'BUILD_WORKSPACE_BUSY', error: 'Project saved; generated code is busy.' };

  it('keeps committed source facts in the legacy UI action acknowledgement', async () => {
    const adapter: any = Object.create(ProjectApplicationAdapter.prototype);
    adapter.actionService = { dispatch: (_type, _payload, acknowledge) => acknowledge({ success: true, data: partial }) };
    expect(await adapter.dispatchProjectSave('/isolated', 5000)).toEqual({ ...partial, success: false });
  });

  it('turns a partial direct editor save into a diagnostic carrying the committed facts', async () => {
    const adapter = new BlocklyEditorAutomationAdapter({ save: async () => partial } as any, {} as any);
    await expectAsync(adapter.saveProject('/isolated')).toBeRejectedWith(jasmine.objectContaining(partial));
  });
});
