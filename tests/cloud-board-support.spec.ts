import { ProjectService } from '../src/app/services/domains/project/project.service';
import { NpmService } from '../src/app/services/domains/dependencies/npm.service';
import { CompileService } from '../src/app/services/domains/build/compile.service';
import { _BuilderService } from '../src/app/editors/blockly-editor/services/builder.service';

describe('board cloud support and local fallback', () => {
  let project: any, config: any, npm: any, files: Map<string, string>, support: any;
  let original: Record<string, any>;
  const boardModule = '@aily-project/board-test';
  beforeEach(() => {
    original = { cloudBuild: window['cloudBuild'], path: window['path'], fs: window['fs'] };
    files = new Map([
      ['/project/package.json', JSON.stringify({ dependencies: { [boardModule]: '3.2.1' } })],
      [`/project/node_modules/${boardModule}/package.json`, JSON.stringify({ name: boardModule, version: '3.2.1', boardDependencies: { '@aily-project/sdk-test': '1.0.0' } })],
    ]);
    window['path'] = { join: (...parts: string[]) => parts.join('/'), getAppDataPath: () => '/app', isExists: () => false };
    window['fs'] = { existsSync: (file: string) => files.has(file), readFileSync: (file: string) => files.get(file) };
    support = { boardModule, boardVersion: '3.2.1', supported: false, available: false, reason: 'not_enabled' };
    window['cloudBuild'] = { boardSupport: jasmine.createSpy('support').and.callFake(async () => ({ ...support })) };
    config = { data: { compile: { backend: 'cloud' }, cloud: { gatewayUrl: 'http://localhost:4318' } },
      getCompileBackend: () => config.data.compile.backend, getCompileSettingsKey: () => config.data.compile.backend,
      getCloudBuildSettings: () => config.data.cloud, isCoderProduct: () => false };
    project = Object.assign(Object.create(ProjectService.prototype), {
      configService: config, currentProjectPathSubject: { value: '/project' },
      electronService: { readFile: (file: string) => files.get(file) },
      translate: { instant: (key: string) => key },
      getEffectivePackageText: (file: string) => files.get(file + '/package.json'),
      getPackageJson: async () => JSON.parse(files.get(project.currentProjectPath + '/package.json')!),
      isAilyCodeProject: () => false,
      syncCurrentBoardConfig: jasmine.createSpy('syncBoard').and.resolveTo(true),
    });
    npm = Object.assign(Object.create(NpmService.prototype), {
      configService: config, prjService: project, translate: project.translate,
      installBoardDeps: jasmine.createSpy('localDeps').and.resolveTo(),
      ensureCoderDependencyLibrarySources: jasmine.createSpy('localSources').and.resolveTo(true),
    });
  });
  afterEach(() => Object.assign(window, original));

  for (const reason of ['not_enabled', 'not_supported', 'offline']) it(`${reason} uses local SDK dependencies while preserving the cloud preference`, async () => {
    support.reason = reason;
    await npm.prepareCompileBackend('/project');
    expect(project.isCloudBuild()).toBeFalse();
    expect(config.data.compile.backend).toBe('cloud');
    expect(npm.installBoardDeps).toHaveBeenCalledTimes(1);
    expect(npm.ensureCoderDependencyLibrarySources).toHaveBeenCalled();
    expect(npm.getMissingBoardDependencies(JSON.parse(files.get(`/project/node_modules/${boardModule}/package.json`)!))).toEqual(['@aily-project/sdk-test@1.0.0']);
    expect(window['cloudBuild'].boardSupport).toHaveBeenCalledWith(jasmine.objectContaining({ boardModule, boardVersion: '3.2.1' }));
  });

  it('rechecks on compile and restores cloud routing once the board is enabled', async () => {
    await npm.prepareCompileBackend('/project');
    support.supported = true;
    await npm.prepareCompileBackend('/project');
    expect(project.isCloudBuild()).toBeTrue();
    expect(npm.installBoardDeps).toHaveBeenCalledTimes(1);
    expect(window['cloudBuild'].boardSupport).toHaveBeenCalledTimes(2);
  });

  it('does not carry fallback into another project or installed board version', async () => {
    await project.resolveCompileBackend();
    expect(project.isCloudBuild('/other')).toBeTrue();
    files.set(`/project/node_modules/${boardModule}/package.json`, JSON.stringify({ name: boardModule, version: '3.2.2' }));
    expect(project.isCloudBuild()).toBeTrue();
    support.supported = true;
    await project.resolveCompileBackend();
    expect(window['cloudBuild'].boardSupport.calls.mostRecent().args[0].boardVersion).toBe('3.2.2');
  });

  it('does not apply a late support response after a project switch', async () => {
    window['cloudBuild'].boardSupport.and.callFake(async () => {
      project.currentProjectPathSubject.value = '/other';
      return support;
    });
    await expectAsync(project.resolveCompileBackend()).toBeRejectedWith(jasmine.objectContaining({ code: 'PROJECT_DEPENDENCY_CANCELLED' }));
    expect(project.boardCompileBackends).toBeUndefined();
  });

  it('keeps transport errors visible without downloading local tools', async () => {
    window['cloudBuild'].boardSupport.and.rejectWith(Object.assign(new Error('timeout'), { code: 'GATEWAY_TIMEOUT' }));
    await expectAsync(npm.prepareCompileBackend('/project')).toBeRejectedWith(jasmine.objectContaining({ code: 'GATEWAY_TIMEOUT' }));
    expect(project.isCloudBuild()).toBeTrue();
    expect(npm.installBoardDeps).not.toHaveBeenCalled();
  });

  for (const oldHost of ['preload', 'main-process']) it(`requests a full restart for an outdated ${oldHost} without treating it as an unsupported board`, async () => {
    if (oldHost === 'preload') delete window['cloudBuild'].boardSupport;
    else window['cloudBuild'].boardSupport.and.rejectWith({ code: 'CLOUD_BUILD_ERROR', message: 'Unknown cloud build operation.' });
    await expectAsync(npm.prepareCompileBackend('/project')).toBeRejectedWith(jasmine.objectContaining({
      code: 'CLOUD_BRIDGE_UNAVAILABLE', message: 'PROJECT.CLOUD_BRIDGE_RESTART_REQUIRED',
    }));
    expect(project.isCloudBuild()).toBeTrue();
    expect(npm.installBoardDeps).not.toHaveBeenCalled();
  });

  it('does not start local SDK installation after the build was cancelled during lookup', async () => {
    await expectAsync(npm.prepareCompileBackend('/project', () => true)).toBeRejectedWith(jasmine.objectContaining({ code: 'CANCELLED' }));
    expect(npm.installBoardDeps).not.toHaveBeenCalled();
  });

  it('enters the normal disk compiler branch after fallback', async () => {
    const runCompile = jasmine.createSpy('runCompile').and.resolveTo({ success: true, result: { state: 'done' } });
    const compile = Object.assign(Object.create(CompileService.prototype), {
      configService: config, projectService: project, npmService: npm,
      application: { startBuild: () => true, updateNotice: () => {} }, runCompile, t: (key: string) => key,
    });
    expect((await compile.runCompileFromDisk()).success).toBeTrue();
    expect(runCompile.calls.mostRecent().args[2].cloud).toBeFalse();
  });

  it('enters the Blockly local branch and invalidates cloud artifacts after fallback', async () => {
    const invalidate = jasmine.createSpy('invalidate').and.rejectWith(new Error('local-boundary'));
    window['cloudBuild'].invalidate = invalidate;
    const blockly = Object.assign(Object.create(_BuilderService.prototype), {
      configService: config, projectService: project, npmService: npm,
      workflowService: { startBuild: () => true, finishBuild: () => {} },
      clearProgressTimer: () => {}, handleCompileError: () => {},
      t: (key: string) => key,
    });
    await expectAsync(blockly.build()).toBeRejected();
    expect(invalidate).toHaveBeenCalledOnceWith({ projectPath: '/project' });
    expect(npm.installBoardDeps).toHaveBeenCalled();
  });
});
