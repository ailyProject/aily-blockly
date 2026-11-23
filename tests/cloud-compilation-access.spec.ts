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
    { loggedIn: true, plan: 'free', allowed: true },
    { loggedIn: true, plan: null, allowed: true },
    { loggedIn: true, plan: 'pro', allowed: true },
    { loggedIn: true, plan: ' Pro_plus ', allowed: true },
    { loggedIn: true, plan: 'professional', allowed: true },
  ]) it(`gates saved cloud preference for ${JSON.stringify(state)}`, () => {
    account(state.loggedIn, state.plan);
    expect(config.getCompileBackend()).toBe(state.allowed ? 'cloud' : 'local');
    const project = Object.assign(Object.create(ProjectService.prototype), { configService: config, currentProjectPathSubject: { value: '/project' } });
    const blockly = Object.assign(Object.create(_BuilderService.prototype), { configService: config, projectService: project });
    expect(project.isCloudBuild()).toBe(state.allowed);
    expect(blockly.isCloudBuild()).toBe(state.allowed);
    expect(config.data.compile.backend).toBe('cloud');
  });

  it('keeps cloud work across plan changes and invalidates it across logout and login', () => {
    account(true, 'pro');
    const project = Object.assign(Object.create(ProjectService.prototype), { configService: config });
    const session = project.getProjectDependencySession('/cloud');
    const before = config.getCompileSettingsKey();
    account(true, 'pro', 'free');
    expect(config.getCompileBackend()).toBe('cloud');
    expect(config.getCompileSettingsKey()).toBe(before);
    project.assertProjectDependencySession(session);
    account(false, 'pro');
    expect(config.getCompileBackend()).toBe('local');
    let cancellation: any;
    try { project.assertProjectDependencySession(session); } catch (error) { cancellation = error; }
    expect(cancellation).toEqual(jasmine.objectContaining({
      code: 'PROJECT_DEPENDENCY_CANCELLED', reason: 'compile-settings-changed',
    }));
    account(true, 'free');
    expect(config.getCompileSettingsKey()).not.toBe(before);
    expect(config.getCompileBackend()).toBe('cloud');
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

  it('restores local SDK requirements after logout', async () => {
    window['path'] = { getAppDataPath: () => '/sdk', isExists: () => false, join: (...parts: string[]) => parts.join('/') };
    const project = Object.assign(Object.create(ProjectService.prototype), { configService: config, currentProjectPathSubject: { value: '/project' } });
    const npm = Object.assign(Object.create(NpmService.prototype), { configService: config, prjService: project,
      getPlatformPathBases: async () => ({ sdkBase: '/sdk', compilersBase: '/tools', toolsBase: '/tools' }) });
    const board = { boardDependencies: { '@aily-project/sdk-test': '1.0.0' } };
    account(true, 'free');
    expect(await npm.getMissingBoardDependencies(board)).toEqual([]);
    account(false, null);
    expect(await npm.getMissingBoardDependencies(board)).toEqual(['@aily-project/sdk-test@1.0.0']);
  });

  it('submits Coder compilation to the cloud with a free account and to local after logout', async () => {
    const runCompile = jasmine.createSpy('runCompile').and.resolveTo({ success: true, result: { state: 'done' } });
    const project = Object.assign(Object.create(ProjectService.prototype), {
      configService: config, currentProjectPathSubject: { value: '/project' },
      getProjectDependencyBlockMessage: () => undefined,
    });
    const compile = Object.assign(Object.create(CompileService.prototype), {
      metrics: { record: () => {} },
      npmService: { ensureLocalCompilerDependencies: async () => {}, prepareCompileBackend: async () => {} },
      configService: config,
      projectService: project,
      application: { startBuild: () => true, updateNotice: () => {} },
      runCompile, t: (key: string) => key,
    });
    account(true, 'free');
    await compile.runCompileFromDisk();
    expect(runCompile.calls.mostRecent().args[2].cloud).toBeTrue();
    account(false, null);
    await compile.runCompileFromDisk();
    expect(runCompile.calls.mostRecent().args[2].cloud).toBeFalse();
  });

  it('enters Blockly local build and invalidates old cloud artifacts after logout', async () => {
    account(true, 'free');
    account(false, null);
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
    for (const [region, buildFlavor] of [
      ['cn', 'cn'], ['eu', 'global'], ['localhost', 'cn'], ['localhost', 'global'], [undefined, 'cn'],
    ]) {
      it(`checks platform and edition for saved cloud preference and settings: ${platform}/${region}/${buildFlavor}`, async () => {
        window['platform'] = { type: platform };
        config.data.region = region;
        config.data.build_flavor = buildFlavor;
        account(true, 'free');
        const allowed = (platform === 'win32' || platform === 'linux') && (region === 'cn' || region === 'localhost') && buildFlavor === 'cn';
        const component = settings();
        // An older main-window response must not bypass the current environment check.
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

  it('rejects click and keyboard handlers when signed out, even when previously enabled', async () => {
    const health = jasmine.createSpy('health').and.resolveTo({ healthy: true });
    window['cloudBuild'] = { health };
    spyOn(config, 'saveCompileSettings').and.resolveTo();
    const component = settings();
    account(false, 'free');
    expect(component.cloudCompilationEnabled).toBeFalse();
    await component.onCloudCompilationChange(true);
    await component.onCloudCompilationChange(false);
    expect(health).not.toHaveBeenCalled();
    expect(config.saveCompileSettings).not.toHaveBeenCalled();
  });

  it('does not enable cloud when the user signs out during the gateway check', async () => {
    account(true, 'free');
    config.data.compile.backend = 'local';
    let resolveHealth!: (value: any) => void;
    window['cloudBuild'] = { health: () => new Promise(resolve => { resolveHealth = resolve; }) };
    spyOn(config, 'saveCompileSettings').and.resolveTo();
    const component = settings();
    const pending = component.onCloudCompilationChange(true);
    account(false, null);
    resolveHealth({ healthy: true });
    await pending;
    expect(config.saveCompileSettings).not.toHaveBeenCalled();
    expect(component.cloudConnectionChecking).toBeFalse();
    expect(config.data.compile.backend).toBe('local');
  });

  it('uses the main-window login state in settings without creating a second login session', async () => {
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

  it('discards a late signed-in response after a newer signed-out response', async () => {
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
