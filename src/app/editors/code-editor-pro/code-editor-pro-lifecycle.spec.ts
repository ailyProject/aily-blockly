import { CodeEditorProComponent } from './code-editor-pro.component';

describe('CodeEditorProComponent ready timeout lifecycle', () => {
  let component: any;

  beforeEach(() => {
    jasmine.clock().install();
    jasmine.clock().mockDate(new Date('2026-09-02T04:00:00Z'));
    component = Object.create(CodeEditorProComponent.prototype);
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
});
