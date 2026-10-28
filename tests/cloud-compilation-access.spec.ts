import { BehaviorSubject } from 'rxjs';
import { AuthService } from '../src/app/services/core/auth/auth.service';
import { ConfigService } from '../src/app/services/core/preferences/config.service';
import { NpmService } from '../src/app/services/domains/dependencies/npm.service';
import { ProjectService } from '../src/app/services/domains/project/project.service';
import { CompileService } from '../src/app/services/domains/build/compile.service';
import { _BuilderService } from '../src/app/editors/blockly-editor/services/builder.service';
import { SettingsComponent } from '../src/app/windows/settings/settings.component';

describe('cloud compilation account access', () => {
  let auth: any;
  let config: ConfigService;
  let originalCloud: any;
  let originalPath: any;
  let originalPlatform: any;

  function account(loggedIn: boolean, plan: string | null, creditPlan?: string) {
    auth.authSnapshotSubject.next(plan === null ? null : {
      plan,
      ...(creditPlan ? { quotaInfoSnapshot: { creditSnapshot: { subscription_plan: creditPlan } } } : {}),
    });
    auth.isLoggedInSubject.next(loggedIn);
  }

  beforeEach(() => {
    originalCloud = window['cloudBuild'];
    originalPath = window['path'];
    originalPlatform = window['platform'];
    window['platform'] = { type: 'win32' };
    auth = Object.create(AuthService.prototype);
    auth.isLoggedInSubject = new BehaviorSubject(false);
    auth.authSnapshotSubject = new BehaviorSubject(null);
    auth.isLoggedIn$ = auth.isLoggedInSubject.asObservable();
    auth.authSnapshot$ = auth.authSnapshotSubject.asObservable();
    config = new ConfigService({} as any, { isElectron: false } as any, auth);
    config.data = { region: 'cn', compile: { backend: 'cloud' } };
  });

  afterEach(() => {
    window['cloudBuild'] = originalCloud;
    window['path'] = originalPath;
    window['platform'] = originalPlatform;
    auth.isLoggedInSubject.complete();
    auth.authSnapshotSubject.complete();
  });

  for (const state of [
    { loggedIn: false, plan: 'pro', allowed: false },
    { loggedIn: true, plan: 'free', allowed: false },
    { loggedIn: true, plan: null, allowed: false },
    { loggedIn: true, plan: 'pro', allowed: true },
    { loggedIn: true, plan: ' Pro_plus ', allowed: true },
    { loggedIn: true, plan: 'professional', allowed: false },
  ]) it(`gates saved cloud preference for ${JSON.stringify(state)}`, () => {
    account(state.loggedIn, state.plan);
    expect(config.getCompileBackend()).toBe(state.allowed ? 'cloud' : 'local');
    const project = Object.assign(Object.create(ProjectService.prototype), { configService: config, currentProjectPathSubject: { value: '/project' } });
    const blockly = Object.assign(Object.create(_BuilderService.prototype), { configService: config, projectService: project });
    expect(project.isCloudBuild()).toBe(state.allowed);
    expect(blockly.isCloudBuild()).toBe(state.allowed);
    expect(config.data.compile.backend).toBe('cloud');
  });

  it('uses the current Credit plan and invalidates old cloud work across logout and login', () => {
    account(true, 'pro');
    const project = Object.assign(Object.create(ProjectService.prototype), { configService: config });
    const session = project.getProjectDependencySession('/cloud');
    const before = config.getCompileSettingsKey();
    account(false, 'pro');
    expect(config.getCompileBackend()).toBe('local');
    let cancellation: any;
    try { project.assertProjectDependencySession(session); } catch (error) { cancellation = error; }
    expect(cancellation).toEqual(jasmine.objectContaining({
      code: 'PROJECT_DEPENDENCY_CANCELLED', reason: 'compile-settings-changed',
    }));
    account(true, 'pro');
    expect(config.getCompileSettingsKey()).not.toBe(before);
    account(true, 'pro', 'free');
    expect(config.getCompileBackend()).toBe('local');
    auth.authSessionInvalidating = true;
    account(true, 'pro');
    expect(config.getCompileBackend()).toBe('local');
  });

  it('keeps a local project preparation alive when account access is restored during refresh', async () => {
    config.data.compile.backend = 'local';
    const project = Object.assign(Object.create(ProjectService.prototype), { configService: config });
    const session = project.getProjectDependencySession('/refresh');
    const settingsKey = config.getCompileSettingsKey();
    const reloaded = jasmine.createSpy('reloaded');
    const subscription = config.configReloaded$.subscribe(reloaded);
    try {
      await project.runProjectDependencyTask(session, async () => {
        account(true, 'pro');
        project.assertProjectDependencySession(session);
        account(false, null);
        project.assertProjectDependencySession(session);
      });
      expect(config.getCompileSettingsKey()).toBe(settingsKey);
      expect(project.getProjectDependencySession('/refresh')).toBe(session);
      expect(reloaded).toHaveBeenCalled();
    } finally { subscription.unsubscribe(); }
  });

  it('restores local SDK requirements when Pro access is lost', () => {
    window['path'] = { getAppDataPath: () => '/sdk', isExists: () => false };
    const project = Object.assign(Object.create(ProjectService.prototype), { configService: config, currentProjectPathSubject: { value: '/project' } });
    const npm = Object.assign(Object.create(NpmService.prototype), { configService: config, prjService: project });
    const board = { boardDependencies: { '@aily-project/sdk-test': '1.0.0' } };
    account(true, 'pro');
    expect(npm.getMissingBoardDependencies(board)).toEqual([]);
    account(true, 'free');
    expect(npm.getMissingBoardDependencies(board)).toEqual(['@aily-project/sdk-test@1.0.0']);
  });

  it('submits Coder compilation to the local branch with a saved cloud preference after logout', async () => {
    account(true, 'pro');
    account(false, null);
    const runCompile = jasmine.createSpy('runCompile').and.resolveTo({ success: true, result: { state: 'done' } });
    const compile = Object.assign(Object.create(CompileService.prototype), {
      metrics: { record: () => {} },
      configService: config,
      projectService: { captureCurrentProjectGuard: () => () => true, beginBuildBackendOperation: () => ({ release() {} }), currentProjectPath: '/project', getProjectDependencyBlockMessage: () => undefined },
      application: { startBuild: () => true, updateNotice: () => {} },
      runCompile, t: (key: string) => key,
    });
    await compile.runCompileFromDisk();
    expect(runCompile.calls.mostRecent().args[2].cloud).toBeFalse();
  });

  it('enters Blockly local build and invalidates old cloud artifacts after downgrade', async () => {
    account(true, 'pro');
    account(true, 'free');
    // Stop at the first local-only boundary; no compiler or remote task is launched.
    const invalidate = jasmine.createSpy('invalidate').and.rejectWith(new Error('local-boundary'));
    window['cloudBuild'] = { invalidate };
    const blockly = Object.assign(Object.create(_BuilderService.prototype), {
      metrics: { record: () => {} },
      configService: config,
      projectService: { captureCurrentProjectGuard: () => () => true, beginBuildBackendOperation: () => ({ release() {} }), currentProjectPath: '/project', currentPackageData: {} },
      workflowService: { startBuild: () => true, finishBuild: () => {} },
      clearProgressTimer: () => {}, handleCompileError: () => {},
    });
    await expectAsync(blockly.build()).toBeRejectedWith(jasmine.objectContaining({ text: 'local-boundary' }));
    expect(invalidate).toHaveBeenCalledOnceWith({ projectPath: '/project' });
  });

  function settings(): any {
    return Object.assign(Object.create(SettingsComponent.prototype), {
      configService: config, electronService: { isElectron: false },
      cloudConnectionRequestId: 0, cloudAccessRequestId: 0,
      cdr: { markForCheck: () => {} }, translateService: { instant: (key: string) => key },
    });
  }

  for (const platform of ['win32', 'darwin', 'linux', undefined]) {
    for (const region of ['cn', 'eu', 'localhost', undefined]) {
      it(`limits saved cloud preference and settings to Windows cn: ${platform}/${region}`, async () => {
        window['platform'] = { type: platform };
        config.data.region = region;
        account(true, 'pro');
        const allowed = platform === 'win32' && region === 'cn';
        const component = settings();
        // A stale Pro response must not bypass the local platform/region guard.
        component.hostCloudCompilationAllowed = true;
        expect(config.getCompileBackend()).toBe(allowed ? 'cloud' : 'local');
        expect(component.showCloudCompilation).toBe(allowed);
        expect(component.cloudCompilationEnabled).toBe(allowed);
        const project = Object.assign(Object.create(ProjectService.prototype), {
          configService: config, currentProjectPathSubject: { value: '/project' },
        });
        const operation = project.beginBuildBackendOperation();
        operation.useLocal();
        if (!allowed) {
          expect(() => operation.useCloud()).toThrow();
          const health = jasmine.createSpy('health');
          window['cloudBuild'] = { health };
          spyOn(config, 'saveCompileSettings').and.resolveTo();
          await component.onCloudCompilationChange(true);
          expect(health).not.toHaveBeenCalled();
          expect(config.saveCompileSettings).not.toHaveBeenCalled();
        }
        operation.release();
        expect(config.data.compile.backend).toBe('cloud');
      });
    }
  }

  it('does not enable cloud when the region changes during the gateway check', async () => {
    account(true, 'pro');
    config.data.compile.backend = 'local';
    let resolveHealth!: (value: any) => void;
    window['cloudBuild'] = { health: () => new Promise(resolve => { resolveHealth = resolve; }) };
    spyOn(config, 'saveCompileSettings').and.resolveTo();
    const component = settings();
    const pending = component.onCloudCompilationChange(true);
    config.data.region = 'eu';
    resolveHealth({ healthy: true });
    await pending;
    expect(config.saveCompileSettings).not.toHaveBeenCalled();
    expect(config.data.compile.backend).toBe('local');
  });

  it('rejects click and keyboard handlers without Pro, even when previously enabled', async () => {
    const health = jasmine.createSpy('health').and.resolveTo({ healthy: true });
    window['cloudBuild'] = { health };
    spyOn(config, 'saveCompileSettings').and.resolveTo();
    const component = settings();
    for (const loggedIn of [false, true]) {
      account(loggedIn, 'free');
      expect(component.cloudCompilationEnabled).toBeFalse();
      await component.onCloudCompilationChange(true);
      await component.onCloudCompilationChange(false);
    }
    expect(health).not.toHaveBeenCalled();
    expect(config.saveCompileSettings).not.toHaveBeenCalled();
  });

  it('does not enable cloud when the account changes during the gateway check', async () => {
    account(true, 'pro');
    config.data.compile.backend = 'local';
    let resolveHealth!: (value: any) => void;
    window['cloudBuild'] = { health: () => new Promise(resolve => { resolveHealth = resolve; }) };
    spyOn(config, 'saveCompileSettings').and.resolveTo();
    const component = settings();
    const pending = component.onCloudCompilationChange(true);
    account(true, 'free');
    resolveHealth({ healthy: true });
    await pending;
    expect(config.saveCompileSettings).not.toHaveBeenCalled();
    expect(component.cloudConnectionChecking).toBeFalse();
    expect(config.data.compile.backend).toBe('local');
  });

  it('allows a Pro main-window snapshot in settings without creating a second login session', async () => {
    const component = settings();
    component.getHostAuthState = async () => ({ canUseCloudCompilation: true });
    await component.refreshCloudCompilationAccess();
    expect(component.cloudCompilationEnabled).toBeTrue();
    expect(auth.isLoggedIn).toBeFalse();
    component.getHostAuthState = async () => ({ canUseCloudCompilation: false });
    await component.refreshCloudCompilationAccess();
    expect(component.cloudCompilationEnabled).toBeFalse();
    expect(component.cloudConnectionStatus).toBe('');
  });

  it('discards a late Pro response after a newer signed-out response', async () => {
    const component = settings();
    let resolveOld!: (value: any) => void;
    component.getHostAuthState = () => new Promise(resolve => { resolveOld = resolve; });
    const old = component.refreshCloudCompilationAccess();
    component.getHostAuthState = async () => ({ canUseCloudCompilation: false });
    await component.refreshCloudCompilationAccess();
    resolveOld({ canUseCloudCompilation: true });
    await old;
    expect(component.canUseCloudCompilation).toBeFalse();
  });
});
