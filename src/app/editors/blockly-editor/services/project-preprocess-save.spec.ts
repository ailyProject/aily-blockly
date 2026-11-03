import { fakeAsync, tick } from '@angular/core/testing';
import { _BuilderService } from './builder.service';
import { _ProjectService } from './project.service';
import { ProcessState } from '@core/app-shell/public-api';

describe('complete save and background preprocess handoff', () => {
  function builder() {
    const service: any = Object.create(_BuilderService.prototype);
    Object.assign(service, {
      initialized: true, preprocessRunGeneration: 1, preprocessSavePauses: 0,
      projectService: { currentProjectPath: '/project' },
      configService: { getCompileBackend: () => 'local' },
      npmService: { isInstalling: false }, workflowService: { currentState: ProcessState.IDLE },
      blocklyService: { aiWaiting: false }, getPendingChatBlockingOperationCount: () => 0,
      triggerPendingPrecompile: jasmine.createSpy('resume'), cmdService: { kill: jasmine.createSpy('kill') },
    });
    return service;
  }

  it('waits for the existing preprocess, pauses queued work through save, and never terminates its owner', fakeAsync(() => {
    const service = builder();
    service.preprocessProcess = {};
    service.preprocessStreamId = 'real-background';
    let release: (() => void) | undefined;
    service.pauseBackgroundPreprocessForSave('/project').then((value: () => void) => { release = value; });
    tick(500);
    expect(release).toBeUndefined();
    expect(service.cmdService.kill).not.toHaveBeenCalled();
    service.preprocessProcess = null;
    service.preprocessStreamId = null;
    tick(100);
    expect(typeof release).toBe('function');
    expect(service.isInstallInProgress()).toBeTrue();
    expect(service.shouldCancelBackgroundPreprocess(1)).toBeTrue();
    release!();
    release!();
    expect(service.preprocessSavePauses).toBe(0);
    expect(service.triggerPendingPrecompile).toHaveBeenCalledTimes(1);
  }));

  it('releases scheduling on a changed project while retaining its live preprocess', fakeAsync(() => {
    const service = builder();
    service.preprocessStreamId = 'still-owned';
    let failure: any;
    service.pauseBackgroundPreprocessForSave('/project').catch((error: unknown) => { failure = error; });
    tick();
    service.projectService.currentProjectPath = '/other';
    tick(100);
    expect(failure.message).toContain('project changed');
    expect(service.preprocessSavePauses).toBe(0);
    expect(service.preprocessStreamId).toBe('still-owned');
    expect(service.cmdService.kill).not.toHaveBeenCalled();
    expect(service.triggerPendingPrecompile).not.toHaveBeenCalled();
  }));

  it('a long-running owner remains protected when the drain budget expires', fakeAsync(() => {
    const service = builder();
    service.preprocessStreamId = 'slow-owner';
    let failure: any;
    service.pauseBackgroundPreprocessForSave('/project').catch((error: unknown) => { failure = error; });
    tick(60_000);
    expect(failure.code).toBe('BACKGROUND_PREPROCESS_BUSY');
    expect(service.preprocessSavePauses).toBe(0);
    expect(service.preprocessStreamId).toBe('slow-owner');
    expect(service.cmdService.kill).not.toHaveBeenCalled();
  }));

  for (const fails of [false, true]) {
    it(`keeps the pause until the actual save ${fails ? 'fails' : 'commits'}`, async () => {
      const project: any = Object.create(_ProjectService.prototype);
      const release = jasmine.createSpy('release');
      let drain!: () => void, complete!: () => void;
      const ready = new Promise<void>(resolve => { drain = resolve; });
      const saved = new Promise<void>(resolve => { complete = resolve; });
      const save = jasmine.createSpy('save').and.callFake(async () => {
        await saved;
        if (fails) throw new Error('publication failed');
        return { projectSaved: true, generatedCodePublished: true, partial: false };
      });
      project.bindPreprocessSaveGuard(async (path: string) => {
        expect(path).toBe('/project');
        await ready;
        return release;
      });
      project.absSaveHandler = save;
      const operation = project.save('/project').catch((error: unknown) => error);
      expect(save).not.toHaveBeenCalled();
      drain();
      await Promise.resolve();
      await Promise.resolve();
      expect(save).toHaveBeenCalledTimes(1);
      expect(release).not.toHaveBeenCalled();
      complete();
      const result = await operation;
      expect(release).toHaveBeenCalledTimes(1);
      if (fails) expect(result.message).toBe('publication failed');
      else expect(result.projectSaved).toBeTrue();
    });
  }

  it('an older editor cannot unbind the new editor save guard', async () => {
    const project: any = Object.create(_ProjectService.prototype);
    const oldGuard = jasmine.createSpy('oldGuard').and.resolveTo(() => {});
    const nextRelease = jasmine.createSpy('nextRelease');
    const nextGuard = jasmine.createSpy('nextGuard').and.resolveTo(nextRelease);
    const unbindOld = project.bindPreprocessSaveGuard(oldGuard);
    const unbindNext = project.bindPreprocessSaveGuard(nextGuard);
    project.absSaveHandler = jasmine.createSpy('save').and.resolveTo({ projectSaved: true });
    unbindOld();
    await project.save('/project');
    expect(oldGuard).not.toHaveBeenCalled();
    expect(nextGuard).toHaveBeenCalledOnceWith('/project');
    expect(nextRelease).toHaveBeenCalledTimes(1);
    unbindNext();
    await project.save('/project');
    expect(nextGuard).toHaveBeenCalledTimes(1);
  });
});
