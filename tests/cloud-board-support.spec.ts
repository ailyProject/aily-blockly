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

  for (const reason of ['not_enabled', 'not_supported', 'offline']) it(`${reason} requires explicit local selection before preparing SDK dependencies`, async () => {
    support.reason = reason;
    await expectAsync(npm.prepareCompileBackend('/project')).toBeRejectedWith(jasmine.objectContaining({ code: 'CLOUD_BOARD_UNSUPPORTED' }));
    expect(project.isCloudBuild()).toBeTrue();
    expect(npm.installBoardDeps).not.toHaveBeenCalled();
    expect(npm.ensureCoderDependencyLibrarySources).not.toHaveBeenCalled();
    const operation = project.beginBuildBackendOperation(); operation.useLocal();
    await npm.prepareLocalCompileBackend('/project', () => false, () => {});
    expect(project.isCloudBuild()).toBeFalse();
    expect(config.data.compile.backend).toBe('cloud');
    expect(npm.installBoardDeps).toHaveBeenCalledTimes(1);
    expect(npm.ensureCoderDependencyLibrarySources).toHaveBeenCalled();
    expect(npm.getMissingBoardDependencies(JSON.parse(files.get(`/project/node_modules/${boardModule}/package.json`)!))).toEqual(['@aily-project/sdk-test@1.0.0']);
    expect(window['cloudBuild'].boardSupport).toHaveBeenCalledWith(jasmine.objectContaining({ boardModule, boardVersion: '3.2.1' }));
    operation.release();
    expect(project.isCloudBuild()).toBeTrue();
  });

  it('rechecks a previously unsupported board on compile without automatic local preparation', async () => {
    await expectAsync(npm.prepareCompileBackend('/project')).toBeRejectedWith(jasmine.objectContaining({ code: 'CLOUD_BOARD_UNSUPPORTED' }));
    support.supported = true;
    await npm.prepareCompileBackend('/project');
    expect(project.isCloudBuild()).toBeTrue();
    expect(npm.installBoardDeps).not.toHaveBeenCalled();
    expect(window['cloudBuild'].boardSupport).toHaveBeenCalledTimes(2);
  });

  it('does not reuse unsupported board status for another project or installed board version', async () => {
    await expectAsync(project.resolveCompileBackend()).toBeRejectedWith(jasmine.objectContaining({ code: 'CLOUD_BOARD_UNSUPPORTED' }));
    files.set('/other/package.json', files.get('/project/package.json')!);
    files.set(`/other/node_modules/${boardModule}/package.json`, files.get(`/project/node_modules/${boardModule}/package.json`)!);
    project.currentProjectPathSubject.value = '/other';
    support.supported = true;
    expect(await project.resolveCompileBackend()).toBe('cloud');
    expect(window['cloudBuild'].boardSupport).toHaveBeenCalledTimes(2);
    project.currentProjectPathSubject.value = '/project';
    files.set(`/project/node_modules/${boardModule}/package.json`, JSON.stringify({ name: boardModule, version: '3.2.2' }));
    expect(project.isCloudBuild()).toBeTrue();
    await project.resolveCompileBackend();
    expect(window['cloudBuild'].boardSupport).toHaveBeenCalledTimes(3);
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
    let cancelled = false;
    window['cloudBuild'].boardSupport.and.callFake(async () => { cancelled = true; return support; });
    await expectAsync(npm.prepareCompileBackend('/project', () => cancelled)).toBeRejectedWith(jasmine.objectContaining({ code: 'CANCELLED' }));
    expect(npm.installBoardDeps).not.toHaveBeenCalled();
  });

  for (const supported of [true, false]) it(`refreshes board support before returning to cloud (supported=${supported})`, async () => {
    support.supported = true;
    await project.resolveCompileBackend();
    const operation = project.beginBuildBackendOperation(); operation.useLocal();
    support.supported = supported;
    npm.ensureCloudLibrarySources = jasmine.createSpy('cloudSources').and.resolveTo();
    operation.useCloud();
    if (supported) expect(await npm.prepareCloudCompileBackend('/project', () => false)).toBeTrue();
    else await expectAsync(npm.prepareCloudCompileBackend('/project', () => false))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'CLOUD_BOARD_UNSUPPORTED' }));
    expect(project.isCloudBuild()).toBeTrue();
    expect(npm.installBoardDeps).not.toHaveBeenCalled();
    expect(window['cloudBuild'].boardSupport).toHaveBeenCalledTimes(2);
    expect(npm.ensureCloudLibrarySources.calls.count()).toBe(supported ? 1 : 0);
    expect(project.syncCurrentBoardConfig).not.toHaveBeenCalled();
    operation.release();
  });

  for (const phase of ['initial', 'reentry']) {
    it(`does not query board support when ${phase} preparation is already cancelled`, async () => {
      const prepare = phase === 'initial' ? 'prepareCompileBackend' : 'prepareCloudCompileBackend';
      await expectAsync(npm[prepare]('/project', () => true)).toBeRejectedWith(jasmine.objectContaining({ code: 'CANCELLED' }));
      expect(window['cloudBuild'].boardSupport).not.toHaveBeenCalled();
      expect(npm.installBoardDeps).not.toHaveBeenCalled();
    });
  }

  it('keeps cancellation authoritative over an unsupported result during cloud reentry', async () => {
    let cancelled = false;
    npm.ensureCloudLibrarySources = jasmine.createSpy('cloudSources').and.resolveTo();
    window['cloudBuild'].boardSupport.and.callFake(async () => { cancelled = true; return support; });
    await expectAsync(npm.prepareCloudCompileBackend('/project', () => cancelled)).toBeRejectedWith(jasmine.objectContaining({ code: 'CANCELLED' }));
    expect(npm.ensureCloudLibrarySources).not.toHaveBeenCalled();
    expect(npm.installBoardDeps).not.toHaveBeenCalled();
  });

  for (const code of ['CLOUD_BOARD_UNSUPPORTED', 'GATEWAY_TIMEOUT', 'CLOUD_BRIDGE_UNAVAILABLE', 'CLOUD_BOARD_PROFILE_INVALID']) {
    it(`does not silently resume locally after ${code} during cloud reentry`, async () => {
      npm.ensureCloudLibrarySources = jasmine.createSpy('cloudSources').and.resolveTo();
      window['cloudBuild'].boardSupport.and.rejectWith(Object.assign(new Error(code), { code }));
      await expectAsync(npm.prepareCloudCompileBackend('/project', () => false)).toBeRejectedWith(jasmine.objectContaining({ code }));
      expect(npm.ensureCloudLibrarySources).not.toHaveBeenCalled();
      expect(npm.installBoardDeps).not.toHaveBeenCalled();
    });
  }

  it('does not resume locally when a late unsupported reply belongs to a different project', async () => {
    window['cloudBuild'].boardSupport.and.callFake(async () => {
      project.currentProjectPathSubject.value = '/other';
      return support;
    });
    await expectAsync(npm.prepareCloudCompileBackend('/project', () => false))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'PROJECT_DEPENDENCY_CANCELLED' }));
    expect(npm.installBoardDeps).not.toHaveBeenCalled();
  });

  it('blocks disk compilation for an unsupported cloud board until local is selected', async () => {
    const runCompile = jasmine.createSpy('runCompile').and.resolveTo({ success: true, result: { state: 'done' } });
    const compile = Object.assign(Object.create(CompileService.prototype), {
      metrics: { record: () => {} },
      configService: config, projectService: project, npmService: npm,
      application: { startBuild: () => true, updateNotice: () => {} }, runCompile, t: (key: string) => key,
    });
    const blocked = await compile.runCompileFromDisk();
    expect(blocked.success).toBeFalse();
    expect(blocked.result.text).toContain('PROJECT.CLOUD_BOARD_UNSUPPORTED');
    expect(runCompile).not.toHaveBeenCalled();
    expect(npm.installBoardDeps).not.toHaveBeenCalled();
    config.data.compile.backend = 'local';
    expect((await compile.runCompileFromDisk()).success).toBeTrue();
    expect(runCompile.calls.mostRecent().args[2].cloud).toBeFalse();
  });

  it('prepares local SDKs and sources only after invalidating the cloud artifact', async () => {
    const operation = project.beginBuildBackendOperation(); operation.useLocal();
    const events: string[] = [];
    window['cloudBuild'].invalidate = async () => { events.push('invalidate'); };
    npm.installBoardDeps.and.callFake(async () => { events.push('SDK'); });
    npm.ensureCoderDependencyLibrarySources.and.callFake(async () => { events.push('sources'); return true; });
    await npm.prepareLocalCompileBackend('/project', () => false, () => {});
    expect(events).toEqual(['invalidate', 'SDK', 'sources']);
    expect(project.syncCurrentBoardConfig).not.toHaveBeenCalled();
    operation.release(); expect(project.isCloudBuild()).toBeTrue();
  });

  it('does not continue local preparation after cancellation or missing sources', async () => {
    const operation = project.beginBuildBackendOperation(); operation.useLocal();
    window['cloudBuild'].invalidate = async () => {};
    await expectAsync(npm.prepareLocalCompileBackend('/project', () => true, () => {})).toBeRejectedWith(jasmine.objectContaining({ code: 'CANCELLED' }));
    expect(npm.installBoardDeps).not.toHaveBeenCalled();
    npm.ensureCoderDependencyLibrarySources.and.resolveTo(false);
    await expectAsync(npm.prepareLocalCompileBackend('/project', () => false, () => {})).toBeRejectedWithError('NPM.DEPS_RETRY_REQUIRED');
    expect(project.syncCurrentBoardConfig).not.toHaveBeenCalled();
    operation.release();
  });

  it('keeps Stop available while downloading SDKs and ignores progress after cancellation', async () => {
    const operation = project.beginBuildBackendOperation(); operation.useLocal();
    const notice = jasmine.createSpy('notice'); npm.application = { updateNotice: notice };
    let cancelled = false;
    const stop = () => { cancelled = true; };
    npm.installBoardDeps.and.callFake(async (session: any) => {
      const progress = { session, lastProgress: 0, name: 'SDK' };
      npm.updateBoardDependencyNotice(progress, 10);
      expect(notice.calls.mostRecent().args[0].stop).toBe(stop);
      notice.calls.mostRecent().args[0].stop();
      npm.updateBoardDependencyNotice(progress, 20);
      expect(notice).toHaveBeenCalledTimes(1);
    });
    await expectAsync(npm.prepareLocalCompileBackend('/project', () => cancelled, stop))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'CANCELLED' }));
    expect(npm.localCompilePreparation).toBeUndefined();
    expect(npm.ensureCoderDependencyLibrarySources).not.toHaveBeenCalled();
    operation.release();
  });

  it('does not invalidate Blockly cloud artifacts until local is explicitly selected', async () => {
    const invalidate = jasmine.createSpy('invalidate').and.rejectWith(new Error('local-boundary'));
    window['cloudBuild'].invalidate = invalidate;
    const blockly = Object.assign(Object.create(_BuilderService.prototype), {
      metrics: { record: () => {} },
      configService: config, projectService: project, npmService: npm,
      workflowService: { startBuild: () => true, finishBuild: () => {} },
      clearProgressTimer: () => {}, handleCompileError: () => {},
      t: (key: string) => key,
    });
    await expectAsync(blockly.build()).toBeRejected();
    expect(invalidate).not.toHaveBeenCalled();
    expect(npm.installBoardDeps).not.toHaveBeenCalled();
    config.data.compile.backend = 'local';
    await expectAsync(blockly.build()).toBeRejected();
    expect(invalidate).toHaveBeenCalledOnceWith({ projectPath: '/project' });
  });
});
