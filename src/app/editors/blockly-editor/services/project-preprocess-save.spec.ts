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

  it('gives save priority over only its tracked background stream and holds the pause through save', fakeAsync(() => {
    const service = builder();
    service.preprocessProcess = { unsubscribe: jasmine.createSpy('unsubscribe') };
    service.preprocessStreamId = 'owned-background';
    service.streamId = 'active-user-build';
    let stopped!: (confirmed: boolean) => void;
    service.cmdService.kill.and.returnValue(new Promise<boolean>(resolve => { stopped = resolve; }));
    let release: (() => void) | undefined;
    service.pauseBackgroundPreprocessForSave('/project').then((value: () => void) => { release = value; });
    tick();
    expect(service.cmdService.kill).toHaveBeenCalledOnceWith('owned-background');
    expect(service.preprocessStreamId).toBe('owned-background');
    expect(release).toBeUndefined();
    stopped(true);
    tick();
    expect(typeof release).toBe('function');
    expect(service.isInstallInProgress()).toBeTrue();
    expect(service.pendingPrecompile).toBeTrue();
    expect(service.triggerPendingPrecompile).not.toHaveBeenCalled();
    release!();
    release!();
    expect(service.preprocessSavePauses).toBe(0);
    expect(service.triggerPendingPrecompile).toHaveBeenCalledTimes(1);
  }));

  it('does not terminate another project when the save request is already stale', fakeAsync(() => {
    const service = builder();
    service.preprocessStreamId = 'other-project-background';
    service.projectService.currentProjectPath = '/other';
    let failure: any;
    service.pauseBackgroundPreprocessForSave('/project').catch((error: unknown) => { failure = error; });
    tick();
    expect(failure.message).toContain('project changed');
    expect(service.preprocessSavePauses).toBe(0);
    expect(service.preprocessStreamId).toBe('other-project-background');
    expect(service.cmdService.kill).not.toHaveBeenCalled();
    expect(service.triggerPendingPrecompile).not.toHaveBeenCalled();
  }));

  it('retains ownership on an unconfirmed stop and permits a subsequent save retry', fakeAsync(() => {
    const service = builder();
    service.preprocessStreamId = 'owned-background';
    service.cmdService.kill.and.resolveTo(false);
    let failure: any, release: (() => void) | undefined;
    service.pauseBackgroundPreprocessForSave('/project').catch((error: unknown) => { failure = error; });
    tick();
    expect(failure.message).toContain('未确认停止');
    expect(service.preprocessSavePauses).toBe(0);
    expect(service.preprocessStreamId).toBe('owned-background');
    service.cmdService.kill.and.resolveTo(true);
    service.pauseBackgroundPreprocessForSave('/project').then((value: () => void) => { release = value; });
    tick();
    expect(typeof release).toBe('function');
    expect(service.preprocessStreamId).toBeNull();
    release!();
    expect(service.preprocessSavePauses).toBe(0);
  }));

  it('shares cancellation and resumes background work only after concurrent saves both finish', fakeAsync(() => {
    const service = builder();
    service.preprocessStreamId = 'owned-background';
    let stopped!: (confirmed: boolean) => void;
    service.cmdService.kill.and.returnValue(new Promise<boolean>(resolve => { stopped = resolve; }));
    let first!: () => void, second!: () => void;
    service.pauseBackgroundPreprocessForSave('/project').then((release: () => void) => { first = release; });
    service.pauseBackgroundPreprocessForSave('/project').then((release: () => void) => { second = release; });
    tick();
    expect(service.cmdService.kill).toHaveBeenCalledOnceWith('owned-background');
    stopped(true);
    tick();
    first();
    expect(service.isInstallInProgress()).toBeTrue();
    expect(service.triggerPendingPrecompile).not.toHaveBeenCalled();
    second();
    expect(service.isInstallInProgress()).toBeFalse();
    expect(service.triggerPendingPrecompile).toHaveBeenCalledTimes(1);
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
