import { CodeEditorFrameComponent } from './code-editor-frame.component';

describe('CodeEditorFrameComponent ready timeout lifecycle', () => {
  let component: any;

  beforeEach(() => {
    jasmine.clock().install();
    jasmine.clock().mockDate(new Date('2026-09-02T04:00:00Z'));
    component = Object.create(CodeEditorFrameComponent.prototype);
    component.coderEmbedLoading = true;
    component.coderReadyProtocolSupported = true;
    component.coderSystemSuspended = false;
    component.coderScreenLocked = false;
    component.coderEmbedLoaderVisible = false;
    component.coderEmbedFrameReady = false;
    component.coderEmbedRevealing = false;
    component.coderEmbedSrc = 'http://127.0.0.1:12345/';
    component.coderEmbedError = null;
    component.translate = { instant: () => '代码工作区启动超时，请重试' };
    component.message = { error: jasmine.createSpy('error') };
    spyOn(component, 'detachCoderEmbedFrame');
  });

  afterEach(() => {
    component.clearCoderReadyTimeoutTimer();
    jasmine.clock().uninstall();
  });

  it('does not consume the ready timeout while the system is suspended', () => {
    component.armCoderReadyTimeout();
    component.onCoderRendererLifecycle({ kind: 'suspend', generation: 1 });
    jasmine.clock().tick(2 * 60 * 60 * 1000);

    expect(component.coderEmbedError).toBeNull();
    expect(component.detachCoderEmbedFrame).not.toHaveBeenCalled();

    component.onCoderRendererLifecycle({ kind: 'resume', generation: 1 });
    jasmine.clock().tick(29_999);
    expect(component.coderEmbedError).toBeNull();
    jasmine.clock().tick(1);
    expect(component.coderEmbedError).toBe('代码工作区启动超时，请重试');
  });

  it('keeps the timeout paused until both resume and screen unlock have occurred', () => {
    component.armCoderReadyTimeout();
    component.onCoderRendererLifecycle({ kind: 'lock-screen', generation: 1 });
    component.onCoderRendererLifecycle({ kind: 'suspend', generation: 1 });
    jasmine.clock().tick(2 * 60 * 60 * 1000);

    component.onCoderRendererLifecycle({ kind: 'resume', generation: 1 });
    jasmine.clock().tick(30_000);
    expect(component.coderEmbedError).toBeNull();

    component.onCoderRendererLifecycle({ kind: 'unlock-screen', generation: 1 });
    jasmine.clock().tick(30_000);
    expect(component.coderEmbedError).toBe('代码工作区启动超时，请重试');
  });

  it('stops the old runtime, reinstalls the package, and starts a fresh embed', async () => {
    component.coderEmbedWorkspaceRoot = '/projects/coder-demo';
    component.coderRuntimeHostInfo = { url: 'http://127.0.0.1:12345/' };
    component.coderRuntimeAcquirePromise = null;
    component.beginCoderEmbedLoading = jasmine.createSpy('beginCoderEmbedLoading');
    component.isCurrentCoderWorkspace = jasmine.createSpy('isCurrentCoderWorkspace').and.returnValue(true);
    component.childToolProcess = {
      forceStop: jasmine.createSpy('forceStop').and.resolveTo(),
    };
    component.requiredSubapps = {
      reinstall: jasmine.createSpy('reinstall').and.resolveTo({ installedNow: true }),
    };
    component.initCoderEmbed = jasmine.createSpy('initCoderEmbed').and.resolveTo();

    await component.reinstallCoderEmbed();

    expect(component.childToolProcess.forceStop).toHaveBeenCalledOnceWith('aily-coder-editor');
    expect(component.requiredSubapps.reinstall).toHaveBeenCalledOnceWith('aily-coder-editor');
    expect(component.initCoderEmbed).toHaveBeenCalledOnceWith('/projects/coder-demo', false);
    expect(component.coderRuntimeHostInfo).toBeNull();
  });

  it('does not erase complete catalog context during repeated ready/theme replay', async () => {
    const previousPath = window['path']; window['path'] = { getAppDataPath: () => '/app-data' } as any;
    try {
      const postMessage = jasmine.createSpy('postMessage'); const frame = { postMessage };
      component.coderHostContextGeneration = 0;
      component.coderEmbedFrame = { nativeElement: { contentWindow: frame } };
      component.isCurrentCoderWorkspace = () => true;
      component.translate = { currentLang: 'zh_cn' }; component.themeService = { theme: () => 'dark' };
      component.resolveEmbedBuildOutputs = async () => ({ artifacts: [] });
      component.loadPlatformPackagesForEmbed = async () => [{ name: 'sdk', path: '/sdk' }];
      component.buildBoardProfileForEmbed = async () => ({ boardName: 'esp32' });
      component.codeSuggestionHostBridge = { registerDeclarationRoots: () => {} };
      await component.pushAilyCoderHostContext('/project');
      expect(postMessage.calls.allArgs().filter(args => !args[0].payload.boardProfile).length).toBe(1);
      postMessage.calls.reset();
      await Promise.all([component.pushAilyCoderHostContext('/project'), component.pushAilyCoderHostContext('/project'), component.pushAilyCoderHostContext('/project')]);
      expect(postMessage).toHaveBeenCalledTimes(1);
      expect(postMessage.calls.mostRecent().args[0].payload.boardProfile.boardName).toBe('esp32');
    } finally { window['path'] = previousPath; }
  });

  it('projects Coder library operations into the matching project log and host messages', async () => {
    const frameWindow = {};
    const log = { update: jasmine.createSpy('log.update') };
    component.projectPath = '/projects/coder-demo';
    component.coderEmbedFrame = { nativeElement: { contentWindow: frameWindow } };
    component.codeSuggestionHostBridge = { handleMessage: () => false };
    component.coderRuntime = {
      getSession: jasmine.createSpy('getSession').and.returnValue({ log }),
    };
    component.message = {
      loading: jasmine.createSpy('loading'),
      success: jasmine.createSpy('success'),
      error: jasmine.createSpy('error'),
    };
    component.translate = {
      instant: jasmine.createSpy('instant').and.callFake((key: string) => ({
        'LIB_MANAGER.INSTALLING': '正在安装',
        'LIB_MANAGER.INSTALLED': '已安装',
        'LIB_MANAGER.INSTALL_FAILED': '安装失败',
        'LIB_MANAGER.UNINSTALLING': '正在卸载',
        'LIB_MANAGER.UNINSTALLED': '已卸载',
        'NPM.UNINSTALL_FAILED_TITLE': '卸载失败',
      }[key])),
    };

    const emit = (
      source: unknown,
      state: 'loading' | 'success' | 'error',
      action: 'install' | 'uninstall',
      error?: string,
    ) =>
      component.onCoderNativeFsMessage({
        source,
        data: {
          channel: 'aily-coder-editor-library-operation-feedback',
          state,
          action,
          libraryName: 'Sensor',
          command: action === 'install'
            ? 'npm install @aily-project-coder/lib-sensor@1.2.3 --save --save-exact --ignore-scripts --no-audit --no-fund'
            : 'npm uninstall @aily-project-coder/lib-sensor --ignore-scripts --no-audit --no-fund',
          error,
        },
      });

    await emit({}, 'success', 'install');
    expect(log.update).not.toHaveBeenCalled();

    await emit(frameWindow, 'loading', 'install');
    await emit(frameWindow, 'success', 'install');
    await emit(frameWindow, 'error', 'install', 'npm exited with code 1');
    await emit(frameWindow, 'loading', 'uninstall');
    await emit(frameWindow, 'success', 'uninstall');
    await emit(frameWindow, 'error', 'uninstall', 'package is in use');

    expect(log.update.calls.allArgs()).toEqual([
      [{
        title: '执行命令',
        detail: 'npm install @aily-project-coder/lib-sensor@1.2.3 --save --save-exact --ignore-scripts --no-audit --no-fund',
        state: 'info',
      }],
      [{
        title: '命令执行失败',
        detail: 'npm install @aily-project-coder/lib-sensor@1.2.3 --save --save-exact --ignore-scripts --no-audit --no-fund\nnpm exited with code 1',
        state: 'error',
      }],
      [{
        title: '执行命令',
        detail: 'npm uninstall @aily-project-coder/lib-sensor --ignore-scripts --no-audit --no-fund',
        state: 'info',
      }],
      [{
        title: '命令执行失败',
        detail: 'npm uninstall @aily-project-coder/lib-sensor --ignore-scripts --no-audit --no-fund\npackage is in use',
        state: 'error',
      }],
    ]);
    expect(component.message.loading.calls.allArgs()).toEqual([
      ['Sensor 正在安装...'],
      ['Sensor 正在卸载...'],
    ]);
    expect(component.message.success.calls.allArgs()).toEqual([
      ['Sensor 已安装'],
      ['Sensor 已卸载'],
    ]);
    expect(component.message.error.calls.allArgs()).toEqual([
      ['Sensor 安装失败: npm exited with code 1'],
      ['Sensor 卸载失败: package is in use'],
    ]);
  });
});
