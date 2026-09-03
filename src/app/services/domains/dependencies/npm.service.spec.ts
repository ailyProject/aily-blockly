import { NpmService } from './npm.service';

describe('NpmService installBoardDeps', () => {
  function createService(boardPlatformDepsReady: boolean) {
    const service = Object.create(NpmService.prototype) as any;
    const application = {
      currentProcessState: 'IDLE',
      startInstall: jasmine.createSpy('startInstall').and.callFake(() => {
        application.currentProcessState = 'INSTALLING';
        return true;
      }),
      finishInstall: jasmine.createSpy('finishInstall').and.callFake(() => {
        application.currentProcessState = 'IDLE';
      })
    };

    service.isInstalling = false;
    service.boardDepsInstallPromise = undefined;
    service.boardDependencyInstallProgress = undefined;
    service.prjService = {
      currentProjectPath: '/tmp/blockly-project',
      getBoardPackageJson: jasmine.createSpy('getBoardPackageJson').and.resolveTo({
        boardDependencies: { '@aily-project/sdk-test': '1.0.0' }
      }),
      getPackageJson: jasmine.createSpy('getPackageJson').and.resolveTo({})
    };
    service.application = application;
    service.areBoardPlatformDepsReady = jasmine.createSpy('areBoardPlatformDepsReady').and.resolveTo(boardPlatformDepsReady);
    service.isAilyCodeProjectRoot = jasmine.createSpy('isAilyCodeProjectRoot').and.returnValue(false);
    service.recordGlobalDependencyUsage = jasmine.createSpy('recordGlobalDependencyUsage').and.resolveTo();
    service.installBoardDependencies = jasmine.createSpy('installBoardDependencies').and.resolveTo();
    service.installPlatformPackageForAilyCodeProject = jasmine.createSpy('installPlatformPackageForAilyCodeProject').and.resolveTo();

    return { service, application };
  }

  it('does not enter INSTALLING when the board platform is already ready', async () => {
    const { service, application } = createService(true);

    await service.installBoardDeps();

    expect(application.startInstall).not.toHaveBeenCalled();
    expect(application.finishInstall).not.toHaveBeenCalled();
    expect(service.installBoardDependencies).not.toHaveBeenCalled();
    expect(service.recordGlobalDependencyUsage).toHaveBeenCalledTimes(2);
    expect(service.isInstalling).toBeFalse();
  });

  it('enters INSTALLING only after the readiness check finds missing platform dependencies', async () => {
    const { service, application } = createService(false);

    await service.installBoardDeps();

    expect(service.areBoardPlatformDepsReady).toHaveBeenCalledBefore(application.startInstall);
    expect(application.startInstall).toHaveBeenCalledTimes(1);
    expect(service.installBoardDependencies).toHaveBeenCalledOnceWith(
      { boardDependencies: { '@aily-project/sdk-test': '1.0.0' } },
      false,
      true
    );
    expect(application.finishInstall).toHaveBeenCalledOnceWith(true);
    expect(service.isInstalling).toBeFalse();
  });
});
