import { Component, ElementRef, OnInit, OnDestroy, AfterViewInit, ViewChild } from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { CommonModule } from '@angular/common';
import { ActivatedRoute } from '@angular/router';
import { NzMessageService } from 'ng-zorro-antd/message';
import { NzModalService } from 'ng-zorro-antd/modal';
import { TranslateService } from '@ngx-translate/core';
import { Subscription } from 'rxjs';
import { ProjectService } from '@domain/project/public-api';
import { NotificationComponent } from '../../components/notification/notification.component';
import { BuilderService } from '../code-editor/services/builder.service';
import { BuilderService as TopBuilderService } from '@domain/build/public-api';
import { UploaderService } from '@domain/device/public-api';
import {
  ElectronService,
  CmdService,
  type CmdOutput,
  type RendererLifecycleEvent,
} from '@core/platform/public-api';
import { ConfigService, ThemeService } from '@core/preferences/public-api';
import {
  CodeEditorProProjectService,
  type CodeEditorProPersistenceBridge,
} from './services/code-editor-pro-project.service';
import { CodeCompletionHostBridgeService } from './services/code-completion-host-bridge.service';
import { NpmService } from '@domain/dependencies/public-api';
import { resolveActualBuildOutputs, type BuildArtifactV1 } from '../../utils/builder.utils';
import { resolvePlatformPackagesForCurrentProject } from '../../utils/platform-packages.utils';
import { UiService } from '@core/app-shell/public-api';
import { AiCoderDiffBridgeService } from '@integration/automation/public-api';
import { ChildToolHostInfo, ChildToolProcessService, RequiredSubappService } from '@integration/subapps/public-api';
import { AILY_CODER_EDITOR_SUBAPP_ID } from '../../configs/required-subapp.config';
import {
  CoderLoadingComponent,
  CoderLoadingStage,
} from './coder-loading/coder-loading.component';
import {
  normalizeAilyCoderHostLanguage,
  toAilyCoderWorkbenchLocale,
} from './services/aily-coder-library-context';

/** 与独立 aily-coder-editor 子应用包 src/hostEmbedContext.ts 中 channel 常量一致 */
const AILY_CODER_EDITOR_HOST_CONTEXT_CHANNEL = 'aily-coder-editor-host-context';
/** iframe 已完成监听后主动索要上下文，避免一次性 postMessage 早于子应用监听器。 */
const AILY_CODER_EDITOR_HOST_CONTEXT_REQUEST_CHANNEL = 'aily-coder-editor-host-context-request';
/** 内嵌 Coder 请求在系统文件管理器中显示绝对路径 */
const AILY_CODER_EDITOR_REVEAL_IN_OS_CHANNEL = 'aily-coder-editor-reveal-in-os';
/** Aily View：Installed Libraries 展开/折叠时同步宿主库管理侧栏 */
const AILY_CODER_EDITOR_OPEN_LIBRARY_MANAGER_CHANNEL = 'aily-coder-editor-open-library-manager';
/** Aily View MCU 单击：请求宿主打开切换开发板弹窗 */
const AILY_CODER_EDITOR_OPEN_BOARD_SELECTOR_CHANNEL = 'aily-coder-editor-open-board-selector';
/** Aily View：复制路径等写入系统剪贴板（iframe 内 Clipboard API 被 Permissions-Policy 禁用） */
const AILY_CODER_EDITOR_CLIPBOARD_WRITE_CHANNEL = 'aily-coder-editor-clipboard-write';
/** Extension Host（Worker）无 window，用 BroadcastChannel 与宿主通信；须与 ailyViewExplorer 一致 */
const AILY_EMBED_OS_REVEAL_CHANNEL = 'aily-embed-os-reveal';
const AILY_EMBED_OPEN_LIBRARY_MANAGER_CHANNEL = 'aily-embed-open-library-manager';
const AILY_EMBED_OPEN_BOARD_SELECTOR_CHANNEL = 'aily-embed-open-board-selector';
const AILY_EMBED_CLIPBOARD_WRITE_CHANNEL = 'aily-embed-clipboard-write';
/** 与独立 aily-coder-editor 子应用包 src/embedLayoutSync.ts 一致 */
const CODER_HOST_LAYOUT_REFRESH_CHANNEL = 'aily-coder-editor-host-layout-refresh';
/** 宿主 → iframe：磁盘 watch 事件（与 parentBackedNativeFs.ts 一致） */
const CODEMBED_NATIVE_FS_WATCH_EVENT = 'aily-coder-editor-native-fs-watch-event';
const AILY_CODER_EDITOR_READY_PROTOCOL_CHANNEL = 'aily-coder-editor-ready-protocol';
const AILY_CODER_EDITOR_READY_CHANNEL = 'aily-coder-editor-ready';
const AILY_CODER_EDITOR_READY_PROTOCOL_VERSION = 1;
const CODER_LOADER_DELAY_MS = 150;
const CODER_LEGACY_READY_FALLBACK_MS = 2400;
const CODER_READY_TIMEOUT_MS = 30000;
const CODER_READY_TIMEOUT_DRIFT_GRACE_MS = 5000;
const CODER_REVEAL_DURATION_MS = 480;
const CODER_GIT_COMMAND_TIMEOUT_MS = 30000;
const CODER_GIT_MAX_STDOUT_CHARS = 16 * 1024 * 1024;
const CODER_GIT_MAX_STDERR_CHARS = 64 * 1024;
const AILY_CODER_EDITOR_NATIVE_SEARCH_PROTOCOL_VERSION = 1;
const CODER_NATIVE_SEARCH_MAX_RESULTS = 1000;
const CODER_NATIVE_SEARCH_MAX_GLOBS = 128;
const CODER_NATIVE_SEARCH_MAX_GLOB_LENGTH = 1000;
const CODER_NATIVE_SEARCH_MAX_PATTERN_LENGTH = 10000;
const CODER_NATIVE_SEARCH_MAX_FILE_SIZE = 20 * 1024 * 1024;
const AILY_CODER_EDITOR_HOST_LIFECYCLE_REQUEST_CHANNEL = 'aily-coder-editor-host-lifecycle-request';
const AILY_CODER_EDITOR_HOST_LIFECYCLE_RESPONSE_CHANNEL = 'aily-coder-editor-host-lifecycle-response';
/** Coder 生成或依赖目录不进入默认搜索、Git 状态与提交。 */
const CODER_GIT_SYSTEM_DIRECTORIES = [
  '.aily',
  '.build',
  '.log',
  '.workspace-history',
  'node_modules',
] as const;
const CODER_GIT_PATHSPECS = [
  '.',
  ...CODER_GIT_SYSTEM_DIRECTORIES.map((name) => `:(glob,exclude)**/${name}/**`),
] as const;

type CoderGitHistoryRef = {
  id: string;
  name: string;
  revision: string;
  category: 'head' | 'local' | 'remote' | 'tag';
};

type CoderGitHistoryRefs = {
  current?: CoderGitHistoryRef;
  remote?: CoderGitHistoryRef;
  refs: CoderGitHistoryRef[];
};

type CoderNativeSearchApi = {
  searchText?: (params: Record<string, unknown>) => Promise<unknown>;
  cancelSearch?: (requestId: string) => void;
};

function normalizeCoderNativeSearchRequestId(value: unknown): string {
  const requestId = typeof value === 'string' ? value.trim() : '';
  if (!requestId || requestId.length > 200 || requestId.includes('\0')) {
    throw new Error('原生搜索 requestId 无效');
  }
  return requestId;
}

function normalizeCoderNativeSearchGlobs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    if (result.length >= CODER_NATIVE_SEARCH_MAX_GLOBS) break;
    const glob = typeof item === 'string' ? item.trim() : '';
    if (!glob || glob.length > CODER_NATIVE_SEARCH_MAX_GLOB_LENGTH || glob.includes('\0')) {
      continue;
    }
    if (!result.includes(glob)) result.push(glob);
  }
  return result;
}

function boundedCoderNativeSearchInteger(
  value: unknown,
  fallback: number,
  maximum: number,
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(maximum, Math.max(1, Math.trunc(parsed)));
}

@Component({
  selector: 'app-code-editor-pro',
  imports: [CommonModule, NotificationComponent, CoderLoadingComponent],
  providers: [CodeCompletionHostBridgeService],
  templateUrl: './code-editor-pro.component.html',
  styleUrl: './code-editor-pro.component.scss',
})
export class CodeEditorProComponent implements OnInit, OnDestroy, AfterViewInit {
  @ViewChild('coderEmbedFrame') coderEmbedFrame?: ElementRef<HTMLIFrameElement>;

  private readonly onEmbedLayoutResize = () => this.requestCoderEmbedLayoutRefresh();

  private embedHostResizeObserver?: ResizeObserver;

  coderEmbedSrc: SafeResourceUrl | null = null;
  coderEmbedError: string | null = null;
  coderEmbedLoading = true;
  coderEmbedLoaderVisible = false;
  coderEmbedFrameReady = false;
  private coderWorkbenchReady = false;
  coderEmbedRevealing = false;
  coderLoadingStage: CoderLoadingStage = 'project';
  /** 内嵌 iframe 打开的本地工程根路径（Electron postMessage FS 断言用） */
  private coderEmbedWorkspaceRoot: string | null = null;
  private coderEmbedRevealTimer?: ReturnType<typeof setTimeout>;
  private coderEmbedLoaderDelayTimer?: ReturnType<typeof setTimeout>;
  private coderLegacyReadyTimer?: ReturnType<typeof setTimeout>;
  private coderReadyTimeoutTimer?: ReturnType<typeof setTimeout>;
  private coderReadyProtocolSupported = false;
  private coderSystemSuspended = false;
  private coderScreenLocked = false;
  private readonly onDocumentVisibilityChange = () => this.syncCoderReadyTimeoutForLifecycle();
  /** Workbench 当前启动时使用的宿主语言；核心语言包只能在初始化前加载。 */
  private coderEmbedHostLanguage: string | null = null;
  private coderLanguageReloadGeneration = 0;

  private readonly coderDevEmbedBase = 'http://127.0.0.1:5174/';
  private coderRuntimeHostInfo: ChildToolHostInfo | null = null;
  private coderRuntimeAcquirePromise: Promise<ChildToolHostInfo> | null = null;
  private coderBootstrapGeneration = 0;
  private destroyed = false;

  private readonly coderNativeFsBridgeListener = (ev: MessageEvent) => this.onCoderNativeFsMessage(ev);
  private readonly coderPersistenceBridge: CodeEditorProPersistenceBridge = {
    saveAll: async () => {
      const result = await this.requestCoderLifecycle('save-all');
      return { ok: result.ok, ...(result.message ? { message: result.message } : {}) };
    },
    hasUnsavedChanges: async () => {
      const result = await this.requestCoderLifecycle('status');
      if (!result.ok) {
        throw new Error(result.message || '无法检查 Aily Coder 未保存状态');
      }
      return result.dirtyAfter > 0;
    },
  };

  /** Worker 内扩展通过 BroadcastChannel 请求访达/资源管理器高亮 */
  private ailyOsRevealBc?: BroadcastChannel;
  /** Worker 兜底：同步右上角库管理展开/收起 */
  private ailyOpenLibManagerBc?: BroadcastChannel;
  /** Worker 兜底：Aily View MCU 打开切换开发板弹窗 */
  private ailyOpenBoardSelectorBc?: BroadcastChannel;
  /** Worker 兜底：Aily View 复制路径写入系统剪贴板 */
  private ailyClipboardWriteBc?: BroadcastChannel;
  /** 随组件统一释放的长生命周期 Subject / Route 订阅。 */
  private readonly componentSubscriptions = new Subscription();
  /** 内嵌 Coder nativeFsWatchStart 注册的宿主 fs.watch 句柄 */
  private coderEmbedFsWatchers = new Map<number, () => void>();
  private coderEmbedFsWatchSeq = 0;
  /** iframe 发起、Electron ripgrep 主进程仍在执行的搜索。 */
  private readonly coderNativeSearchRequestIds = new Set<string>();
  /** 监听 .aily/build 与全局 aily-builder 缓存变更，编译产物增删后同步 hints / hostContext */
  private disposeBuildOutputsWatch?: () => void;
  private disposeGlobalBuildOutputsWatch?: () => void;
  private buildOutputsWatchDebounce?: ReturnType<typeof setTimeout>;
  /** 只允许最近一次异步 host-context 解析结果写入 iframe，避免空旧快照覆盖完整目录。 */
  private coderHostContextGeneration = 0;

  constructor(
    private projectService: ProjectService,
    private proProject: CodeEditorProProjectService,
    private activatedRoute: ActivatedRoute,
    private message: NzMessageService,
    private builderService: BuilderService,
    private topBuilderService: TopBuilderService,
    private uploadService: UploaderService,
    private electronService: ElectronService,
    private sanitizer: DomSanitizer,
    private themeService: ThemeService,
    private configService: ConfigService,
    private npmService: NpmService,
    private uiService: UiService,
    private aiCoderDiffBridge: AiCoderDiffBridgeService,
    private cmdService: CmdService,
    private readonly childToolProcess: ChildToolProcessService,
    private readonly requiredSubapps: RequiredSubappService,
    private readonly translate: TranslateService,
    private readonly modal: NzModalService,
    private readonly elementRef: ElementRef<HTMLElement>,
    private readonly codeCompletionHostBridge: CodeCompletionHostBridgeService,
  ) {
    toObservable(this.themeService.theme)
      .pipe(takeUntilDestroyed())
      .subscribe(() => {
        const root = this.coderEmbedWorkspaceRoot;
        if (root) void this.pushAilyCoderHostContext(root);
      });
  }

  ngOnInit() {
    this.proProject.registerPersistenceBridge(this.coderPersistenceBridge);
    window.addEventListener('message', this.coderNativeFsBridgeListener);
    document.addEventListener('visibilitychange', this.onDocumentVisibilityChange);
    this.coderSystemSuspended = this.electronService.isRendererSuspended;
    this.coderScreenLocked = this.electronService.isRendererScreenLocked;
    this.componentSubscriptions.add(
      this.electronService.rendererLifecycle$.subscribe((event) => {
        this.onCoderRendererLifecycle(event);
      }),
    );
    try {
      this.ailyOsRevealBc = new BroadcastChannel(AILY_EMBED_OS_REVEAL_CHANNEL);
      this.ailyOsRevealBc.addEventListener('message', (ev: MessageEvent) => {
        const p = ev.data as { absPath?: string };
        if (typeof p?.absPath === 'string' && p.absPath) {
          void this.runHostRevealInOs(p.absPath);
        }
      });
    } catch {
      /* 浏览器极旧环境无 BroadcastChannel */
    }
    try {
      this.ailyOpenLibManagerBc = new BroadcastChannel(AILY_EMBED_OPEN_LIBRARY_MANAGER_CHANNEL);
      this.ailyOpenLibManagerBc.addEventListener('message', (ev: MessageEvent) => {
        const open = (ev.data as { open?: boolean })?.open !== false;
        this.syncHostLibraryManager(open);
      });
    } catch {
      /* 浏览器极旧环境无 BroadcastChannel */
    }
    try {
      this.ailyOpenBoardSelectorBc = new BroadcastChannel(AILY_EMBED_OPEN_BOARD_SELECTOR_CHANNEL);
      this.ailyOpenBoardSelectorBc.addEventListener('message', () => {
        void this.uiService.openBoardSelector();
      });
    } catch {
      /* 浏览器极旧环境无 BroadcastChannel */
    }
    try {
      this.ailyClipboardWriteBc = new BroadcastChannel(AILY_EMBED_CLIPBOARD_WRITE_CHANNEL);
      this.ailyClipboardWriteBc.addEventListener('message', (ev: MessageEvent) => {
        const text = (ev.data as { text?: string })?.text;
        if (typeof text === 'string') {
          this.electronService.clipboardWriteText(text);
        }
      });
    } catch {
      /* 浏览器极旧环境无 BroadcastChannel */
    }
    // 编译完成后重写 hints + 推送 hostCtx，让 Coder 端产物节点立刻拿到真实绝对路径
    this.componentSubscriptions.add(
      this.topBuilderService.buildFinishedSubject.subscribe(({ success }) => {
        if (!success) return;
        const root = this.coderEmbedWorkspaceRoot;
        if (!root) return;
        void this.writeCoderEmbedHints(root);
        void this.pushAilyCoderHostContext(root);
      }),
    );
    // 切换主板后 boardDependencies 变化，刷新 Platform Packages 与 Header 开发板名
    this.componentSubscriptions.add(
      this.projectService.boardChangeSubject.subscribe(() => {
        const root = this.coderEmbedWorkspaceRoot;
        if (!root) return;
        void this.syncBoardConfigForHeader();
        void this.writeCoderEmbedHints(root);
        void this.pushAilyCoderHostContext(root);
      }),
    );
    // 子应用语言由主软件统一控制。VS Code 核心语言包必须在 Workbench 初始化前加载，
    // 因此先保存编辑器，再只重启 iframe（Runtime 进程保持不变）。
    this.componentSubscriptions.add(
      this.translate.onLangChange.subscribe(() => {
        const root = this.coderEmbedWorkspaceRoot;
        if (!root) return;
        const hostLanguage = this.translate.currentLang || this.translate.defaultLang || 'en';
        const nextLanguage = normalizeAilyCoderHostLanguage(hostLanguage);
        const generation = ++this.coderLanguageReloadGeneration;
        if (!this.coderEmbedSrc || this.coderEmbedHostLanguage === nextLanguage) {
          void this.pushAilyCoderHostContext(root);
          return;
        }
        void this.reloadCoderEmbedForLanguage(root, nextLanguage, generation);
      }),
    );
    this.componentSubscriptions.add(
      this.configService.libraryListChanged$.subscribe((libraryList) => {
        if (libraryList.length === 0) return;
        const root = this.coderEmbedWorkspaceRoot;
        if (root) void this.pushAilyCoderHostContext(root);
      }),
    );
    this.proProject.init();
    this.componentSubscriptions.add(
      this.activatedRoute.queryParams.subscribe((params) => {
        if (params['path']) {
          void this.bootstrap(params['path']);
        } else {
          this.coderEmbedLoading = false;
          this.coderEmbedLoaderVisible = true;
          this.coderEmbedError = '没有找到项目路径';
          this.message.error('没有找到项目路径');
        }
      }),
    );
    window.history.replaceState(null, '', window.location.href);
    window.history.pushState(null, '', window.location.href);

    // 右侧工具面板开关后通知 iframe 内 workbench 按新宽度重排
    this.componentSubscriptions.add(
      this.uiService.actionSubject.subscribe((e: { type?: string; action?: string }) => {
        if (e?.type === 'tool') {
          requestAnimationFrame(() => this.requestCoderEmbedLayoutRefresh());
        }
      }),
    );
  }

  ngAfterViewInit(): void {
    window.addEventListener('resize', this.onEmbedLayoutResize);
    const host = this.elementRef.nativeElement.querySelector<HTMLElement>('.code-editor-pro');
    if (host) {
      this.embedHostResizeObserver = new ResizeObserver(() => this.requestCoderEmbedLayoutRefresh());
      this.embedHostResizeObserver.observe(host);
    }
  }

  /** 通知 iframe 内 workbench 按当前 iframe 宽度重排 */
  private requestCoderEmbedLayoutRefresh(): void {
    const win = this.coderEmbedFrame?.nativeElement?.contentWindow;
    if (!win) {
      return;
    }
    win.postMessage({ channel: CODER_HOST_LAYOUT_REFRESH_CHANNEL }, '*');
  }

  /**
   * 先 loadProject 设置 currentProjectPath，再安装依赖；最后启动 iframe（避免 installBoardDeps 读错工程路径）。
   */
  private async bootstrap(projectPath: string) {
    const generation = ++this.coderBootstrapGeneration;
    const isCurrent = () => !this.destroyed && generation === this.coderBootstrapGeneration;
    try {
      this.beginCoderEmbedLoading();
      const pathApi = window['path'] as { resolve?: (p: string) => string };
      const resolved = pathApi.resolve ? pathApi.resolve(projectPath) : projectPath;
      this.coderEmbedWorkspaceRoot = resolved;
      this.aiCoderDiffBridge.setWorkspaceRoot(resolved);
      await this.ensureProjectPackageJsonExists(resolved);
      if (!isCurrent()) return;
      await this.loadProject(resolved);
      if (!isCurrent()) return;
      void this.ensureNpmDepsWithRetry(resolved);
      await this.initCoderEmbed(resolved, false);
      if (!isCurrent()) return;
      this.setupBuildOutputsWatch(resolved);
    } catch (error: any) {
      if (!isCurrent()) return;
      console.error('加载项目失败', error);
      this.detachCoderEmbedFrame();
      this.clearCoderEmbedLoadingTimers();
      this.coderEmbedLoading = false;
      this.coderEmbedLoaderVisible = true;
      this.coderEmbedFrameReady = false;
      this.coderEmbedRevealing = false;
      this.coderEmbedSrc = null;
      this.coderEmbedError = error?.message || String(error || '加载项目失败');
      this.message.error('加载项目失败，请检查项目文件是否完整');
    }
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.clearCoderEmbedLoadingTimers();
    this.proProject.unregisterPersistenceBridge(this.coderPersistenceBridge);
    this.coderWorkbenchReady = false;
    this.embedHostResizeObserver?.disconnect();
    this.embedHostResizeObserver = undefined;
    window.removeEventListener('resize', this.onEmbedLayoutResize);
    window.removeEventListener('message', this.coderNativeFsBridgeListener);
    document.removeEventListener('visibilitychange', this.onDocumentVisibilityChange);
    this.ailyOsRevealBc?.close();
    this.ailyOsRevealBc = undefined;
    this.ailyOpenLibManagerBc?.close();
    this.ailyOpenLibManagerBc = undefined;
    this.ailyOpenBoardSelectorBc?.close();
    this.ailyOpenBoardSelectorBc = undefined;
    this.ailyClipboardWriteBc?.close();
    this.ailyClipboardWriteBc = undefined;
    this.componentSubscriptions.unsubscribe();
    this.detachCoderEmbedFrame();
    this.stopBuildOutputsWatch();
    this.codeCompletionHostBridge.dispose();
    this.aiCoderDiffBridge.setWorkspaceRoot(null);
    this.coderEmbedWorkspaceRoot = null;
    if (this.coderRuntimeHostInfo) {
      this.coderRuntimeHostInfo = null;
      void this.childToolProcess.release(AILY_CODER_EDITOR_SUBAPP_ID);
    }
    this.proProject.destroy();
    this.builderService.cancel();
    this.uploadService.cancel();
    this.electronService.setTitle(this.configService.getApplicationName());
  }

  private requestCoderLifecycle(
    action: 'status' | 'save-all',
    timeoutMs = 10_000,
  ): Promise<{ ok: boolean; dirtyBefore: number; dirtyAfter: number; message?: string }> {
    const target = this.coderEmbedFrame?.nativeElement?.contentWindow;
    if (!target || !this.coderWorkbenchReady) {
      return Promise.resolve({
        ok: false,
        dirtyBefore: 0,
        dirtyAfter: 0,
        message: 'Aily Coder 编辑器尚未就绪',
      });
    }

    const requestId = `aily-coder-editor-lifecycle-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return new Promise(resolve => {
      let settled = false;
      const finish = (result: { ok: boolean; dirtyBefore: number; dirtyAfter: number; message?: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        window.removeEventListener('message', listener);
        resolve(result);
      };
      const listener = (event: MessageEvent) => {
        if (event.source !== target) return;
        const payload = event.data as {
          channel?: string;
          requestId?: string;
          ok?: boolean;
          dirtyBefore?: number;
          dirtyAfter?: number;
          message?: string;
        };
        if (
          payload?.channel !== AILY_CODER_EDITOR_HOST_LIFECYCLE_RESPONSE_CHANNEL ||
          payload.requestId !== requestId
        ) {
          return;
        }
        finish({
          ok: payload.ok === true,
          dirtyBefore: Number.isFinite(payload.dirtyBefore) ? Number(payload.dirtyBefore) : 0,
          dirtyAfter: Number.isFinite(payload.dirtyAfter) ? Number(payload.dirtyAfter) : 0,
          ...(typeof payload.message === 'string' && payload.message ? { message: payload.message } : {}),
        });
      };
      const timer = setTimeout(() => finish({
        ok: false,
        dirtyBefore: 0,
        dirtyAfter: 0,
        message: '等待 Aily Coder 保存确认超时',
      }), timeoutMs);

      window.addEventListener('message', listener);
      target.postMessage({
        channel: AILY_CODER_EDITOR_HOST_LIFECYCLE_REQUEST_CHANNEL,
        requestId,
        action,
      }, '*');
    });
  }

  /**
   * 无 package.json 时从 .ino 生成最小 stub，再与 iframe 并行读盘，避免工作区先打开后才有 json。
   */
  private async ensureProjectPackageJsonExists(projectPath: string): Promise<void> {
    if (this.electronService.exists(projectPath + '/package.json')) {
      return;
    }
    const fileList = this.electronService.readDir(projectPath);
    if (this.hasFileWithExtension(fileList, '.ino')) {
      const projectName = projectPath.split(/[/\\]/).filter(Boolean).pop() || '';
      const packageData = {
        version: '1.0.0',
        name: projectName,
        platform: 'arduino',
      };
      this.electronService.writeFile(projectPath + '/package.json', JSON.stringify(packageData));
    }
  }

  /**
   * 写入工程上下文并标为已加载（不含 npm；依赖安装由 bootstrap 中单独 void 启动）。
   */
  async loadProject(projectPath: string): Promise<void> {
    const packageJson = JSON.parse(this.electronService.readFile(`${projectPath}/package.json`));
    this.electronService.setTitle(`${this.configService.getApplicationName()} - ${packageJson.name}`);
    this.projectService.currentPackageData = packageJson;
    this.projectService.addRecentlyProject({
      name: packageJson.name,
      path: projectPath,
      nickname: packageJson.nickname || packageJson.name,
    });
    this.projectService.currentPackageData = packageJson;
    this.projectService.currentProjectPath = projectPath;
    this.projectService.stateSubject.next('loaded');
    // 依赖已存在时尽早同步，供 Header 串口/开发板菜单使用
    void this.syncBoardConfigForHeader();
  }

  /** 与 Blockly loadProject 一致：写入 ProjectService.currentBoardConfig */
  private async syncBoardConfigForHeader(): Promise<void> {
    await this.projectService.syncCurrentBoardConfig();
  }

  /**
   * 与 Blockly loadProject 对齐：工程依赖 await 检查；平台 sdk/tool 后台安装且已就绪则跳过。
   */
  private ensureNpmDepsWithRetry(projectPath: string): void {
    const refreshEmbedAfterDeps = () => {
      if (this.coderEmbedWorkspaceRoot !== projectPath) {
        return;
      }
      void this.syncBoardConfigForHeader();
      void this.writeCoderEmbedHints(projectPath);
      void this.pushAilyCoderHostContext(projectPath);
    };

    const run = async () => {
      if (this.coderEmbedWorkspaceRoot !== projectPath) {
        return;
      }
      await this.npmService.ensureProjectAndBoardDeps(projectPath, {
        onRetryInstall: () => void run(),
        onBoardDepsSettled: refreshEmbedAfterDeps,
      });
    };
    void run();
  }

  private async initCoderEmbed(projectPath: string, resetLoading = true) {
    try {
      if (!this.isCurrentCoderWorkspace(projectPath)) return;
      if (resetLoading) {
        this.beginCoderEmbedLoading();
      }
      await this.writeCoderEmbedHints(projectPath);
      if (!this.isCurrentCoderWorkspace(projectPath)) return;
      this.coderLoadingStage = 'dependency';
      let base: string;
      if (this.electronService.isElectron) {
        await this.requiredSubapps.ensureInstalled(AILY_CODER_EDITOR_SUBAPP_ID);
        if (!this.isCurrentCoderWorkspace(projectPath)) return;
        this.coderLoadingStage = 'runtime';
        base = (await this.acquireCoderRuntime()).url;
      } else {
        this.coderLoadingStage = 'runtime';
        base = this.coderDevEmbedBase;
      }
      if (!this.isCurrentCoderWorkspace(projectPath)) return;
      const u = new URL(base.endsWith('/') ? base : `${base}/`);
      u.searchParams.set('mode', 'full-workbench');
      u.searchParams.set('folder', projectPath);
      u.searchParams.set('theme', this.themeService.theme());
      const hostLanguage = this.translate.currentLang || this.translate.defaultLang || 'en';
      this.coderEmbedHostLanguage = normalizeAilyCoderHostLanguage(hostLanguage);
      u.searchParams.set('lang', hostLanguage);
      const coderLocale = toAilyCoderWorkbenchLocale(hostLanguage);
      if (coderLocale) {
        u.searchParams.set('locale', coderLocale);
      }
      if (this.electronService.isElectron) {
        u.searchParams.set('nativeFsBridge', 'true');
      }
      this.coderLoadingStage = 'workbench';
      this.coderEmbedSrc = this.sanitizer.bypassSecurityTrustResourceUrl(u.toString());
      this.coderEmbedError = null;
      // iframe (load) 里会 postMessage；此处若 iframe 已缓存瞬时完成，再补一发
      setTimeout(() => void this.pushAilyCoderHostContext(projectPath), 0);
    } catch (e: any) {
      if (!this.isCurrentCoderWorkspace(projectPath)) return;
      console.error(e);
      this.detachCoderEmbedFrame();
      this.clearCoderEmbedLoadingTimers();
      this.coderEmbedLoading = false;
      this.coderEmbedLoaderVisible = true;
      this.coderEmbedFrameReady = false;
      this.coderEmbedRevealing = false;
      this.coderEmbedSrc = null;
      this.coderEmbedError = e?.message || String(e);
      this.message.error('无法启动内嵌代码编辑器：' + this.coderEmbedError);
    }
  }

  /**
   * Workbench NLS 在模块初始化时固化，无法通过 host-context 安全热替换。
   * 重载前要求所有已打开文件落盘；保存失败时保留当前 iframe，避免丢失修改。
   */
  private async reloadCoderEmbedForLanguage(
    projectRoot: string,
    nextLanguage: string,
    generation: number,
  ): Promise<void> {
    // 自定义 Webview 可先热更新；核心 Search/SCM 标题在后续 iframe 重启时更新。
    void this.pushAilyCoderHostContext(projectRoot);

    if (this.coderWorkbenchReady) {
      const saveResult = await this.requestCoderLifecycle('save-all');
      if (
        generation !== this.coderLanguageReloadGeneration
        || !this.isCurrentCoderWorkspace(projectRoot)
      ) {
        return;
      }
      if (!saveResult.ok || saveResult.dirtyAfter > 0) {
        console.warn('[CodeEditorPro] language reload skipped because editors could not be saved', saveResult);
        const detail = saveResult.message || this.translate.instant('UPDATE_DIALOG.SAVE_FAILED');
        this.message.warning(this.translate.instant('LIBRARY_PUBLISH.RELOAD_SAVE_FAILED', {
          error: detail,
        }));
        return;
      }
    }

    if (
      generation !== this.coderLanguageReloadGeneration
      || !this.isCurrentCoderWorkspace(projectRoot)
      || normalizeAilyCoderHostLanguage(
        this.translate.currentLang || this.translate.defaultLang || 'en',
      ) !== nextLanguage
    ) {
      return;
    }
    await this.initCoderEmbed(projectRoot);
  }

  private async acquireCoderRuntime(): Promise<ChildToolHostInfo> {
    if (this.coderRuntimeHostInfo) {
      return this.coderRuntimeHostInfo;
    }
    if (!this.coderRuntimeAcquirePromise) {
      const pending = this.childToolProcess.acquire(AILY_CODER_EDITOR_SUBAPP_ID)
        .then((hostInfo) => {
          if (this.destroyed) {
            void this.childToolProcess.release(AILY_CODER_EDITOR_SUBAPP_ID);
            throw new Error('Coder editor was closed before its Runtime finished starting');
          }
          this.coderRuntimeHostInfo = hostInfo;
          return hostInfo;
        })
        .finally(() => {
          if (this.coderRuntimeAcquirePromise === pending) {
            this.coderRuntimeAcquirePromise = null;
          }
        });
      this.coderRuntimeAcquirePromise = pending;
    }
    return this.coderRuntimeAcquirePromise;
  }

  /**
   * iframe 每次加载完成后向 aily-coder-editor 同步宿主上下文（构建目录等），避免依赖 ProjectService 竞态。
   */
  onCoderEmbedFrameLoad(): void {
    const frame = this.coderEmbedFrame?.nativeElement;
    const root = this.coderEmbedWorkspaceRoot;
    this.coderWorkbenchReady = false;
    if (this.coderEmbedLoading) {
      this.coderLoadingStage = 'workbench';
    }
    if (root) {
      this.aiCoderDiffBridge.setWorkspaceRoot(root);
    }
    this.aiCoderDiffBridge.registerEmbed(frame?.contentWindow ?? null);
    this.codeCompletionHostBridge.registerFrame(frame?.contentWindow ?? null);
    if (root) {
      void this.pushAilyCoderHostContext(root);
    }
    requestAnimationFrame(() => this.requestCoderEmbedLayoutRefresh());

    if (!this.coderEmbedLoading) {
      return;
    }
    if (this.coderReadyProtocolSupported) {
      this.armCoderReadyTimeout();
      return;
    }
    this.clearCoderLegacyReadyTimer();
    this.coderLegacyReadyTimer = setTimeout(() => {
      this.coderLegacyReadyTimer = undefined;
      if (!this.coderReadyProtocolSupported) {
        this.completeCoderEmbedLoading();
      }
    }, CODER_LEGACY_READY_FALLBACK_MS);
  }

  private beginCoderEmbedLoading(): void {
    this.clearCoderEmbedLoadingTimers();
    this.detachCoderEmbedFrame();
    this.coderEmbedLoading = true;
    this.coderEmbedLoaderVisible = false;
    this.coderEmbedFrameReady = false;
    this.coderWorkbenchReady = false;
    this.coderEmbedRevealing = false;
    this.coderReadyProtocolSupported = false;
    this.coderLoadingStage = 'project';
    this.coderEmbedError = null;
    this.coderEmbedLoaderDelayTimer = setTimeout(() => {
      this.coderEmbedLoaderDelayTimer = undefined;
      if (this.coderEmbedLoading && !this.coderEmbedError) {
        this.coderEmbedLoaderVisible = true;
      }
    }, CODER_LOADER_DELAY_MS);
  }

  retryCoderEmbed(): void {
    const root = this.coderEmbedWorkspaceRoot;
    if (root) {
      void this.initCoderEmbed(root);
    }
  }

  confirmReinstallCoderEmbed(): void {
    if (!this.coderEmbedWorkspaceRoot) return;
    this.modal.confirm({
      nzClassName: 'subapp-service-confirm-modal',
      nzTitle: this.translate.instant('CODER_SUBAPP_INSTALL.REINSTALL_TITLE'),
      nzContent: this.translate.instant('CODER_SUBAPP_INSTALL.REINSTALL_HINT'),
      nzOkText: this.translate.instant('CODER_SUBAPP_INSTALL.REINSTALL_CONFIRM'),
      nzCancelText: this.translate.instant('COMMON.CANCEL'),
      nzOkDanger: true,
      nzMaskClosable: false,
      nzOnOk: () => this.reinstallCoderEmbed(),
    });
  }

  private async reinstallCoderEmbed(): Promise<void> {
    const root = this.coderEmbedWorkspaceRoot;
    if (!root) return;

    this.beginCoderEmbedLoading();
    this.coderEmbedLoaderVisible = true;
    this.coderLoadingStage = 'dependency';
    try {
      const pendingAcquire = this.coderRuntimeAcquirePromise;
      await this.childToolProcess.forceStop(AILY_CODER_EDITOR_SUBAPP_ID);
      if (pendingAcquire) {
        await pendingAcquire.catch(() => undefined);
      }
      this.coderRuntimeHostInfo = null;
      this.coderRuntimeAcquirePromise = null;
      if (!this.isCurrentCoderWorkspace(root)) return;
      await this.requiredSubapps.reinstall(AILY_CODER_EDITOR_SUBAPP_ID);
      if (!this.isCurrentCoderWorkspace(root)) return;
      await this.initCoderEmbed(root, false);
    } catch (error: any) {
      if (!this.isCurrentCoderWorkspace(root)) return;
      console.error('Aily Coder Editor reinstallation failed', error);
      this.detachCoderEmbedFrame();
      this.clearCoderEmbedLoadingTimers();
      this.coderEmbedLoading = false;
      this.coderEmbedLoaderVisible = true;
      this.coderEmbedFrameReady = false;
      this.coderEmbedRevealing = false;
      this.coderEmbedSrc = null;
      this.coderEmbedError = error?.message || String(error);
    }
  }

  private completeCoderEmbedLoading(): void {
    if (!this.coderEmbedLoading) return;
    this.clearCoderLegacyReadyTimer();
    this.clearCoderReadyTimeoutTimer();
    this.coderLoadingStage = 'ready';
    this.coderEmbedFrameReady = true;

    if (!this.coderEmbedLoaderVisible) {
      this.clearCoderLoaderDelayTimer();
      this.coderEmbedLoading = false;
      this.coderEmbedRevealing = false;
      return;
    }

    this.coderEmbedRevealing = true;
    this.clearCoderEmbedRevealTimer();
    this.coderEmbedRevealTimer = setTimeout(() => {
      this.coderEmbedLoading = false;
      this.coderEmbedLoaderVisible = false;
      this.coderEmbedRevealing = false;
      this.coderEmbedRevealTimer = undefined;
    }, CODER_REVEAL_DURATION_MS);
  }

  private armCoderReadyTimeout(): void {
    this.clearCoderReadyTimeoutTimer();
    if (this.isCoderReadyTimeoutPaused()) return;
    const armedAt = Date.now();
    this.coderReadyTimeoutTimer = setTimeout(() => {
      this.coderReadyTimeoutTimer = undefined;
      if (!this.coderEmbedLoading || !this.coderReadyProtocolSupported) return;
      if (this.isCoderReadyTimeoutPaused()) return;
      // Chromium may deliver an expired timer immediately after a long sleep even
      // when the lifecycle IPC is queued behind it. Give Workbench a fresh active
      // interval instead of turning scheduler suspension into a startup failure.
      if (Date.now() - armedAt > CODER_READY_TIMEOUT_MS + CODER_READY_TIMEOUT_DRIFT_GRACE_MS) {
        this.armCoderReadyTimeout();
        return;
      }
      const error = this.translate.instant('AILY_CODE_LOADING.TIMEOUT');
      this.clearCoderEmbedLoadingTimers();
      this.coderEmbedLoading = false;
      this.coderEmbedLoaderVisible = true;
      this.coderEmbedFrameReady = false;
      this.coderEmbedRevealing = false;
      this.detachCoderEmbedFrame();
      this.coderEmbedSrc = null;
      this.coderEmbedError = error;
      this.message.error(error);
    }, CODER_READY_TIMEOUT_MS);
  }

  private onCoderRendererLifecycle(event: RendererLifecycleEvent): void {
    if (event.kind === 'suspend') this.coderSystemSuspended = true;
    if (event.kind === 'resume') this.coderSystemSuspended = false;
    if (event.kind === 'lock-screen') this.coderScreenLocked = true;
    if (event.kind === 'unlock-screen') this.coderScreenLocked = false;
    this.syncCoderReadyTimeoutForLifecycle();
  }

  private syncCoderReadyTimeoutForLifecycle(): void {
    if (this.isCoderReadyTimeoutPaused()) {
      this.clearCoderReadyTimeoutTimer();
      return;
    }
    if (
      this.coderEmbedLoading
      && this.coderReadyProtocolSupported
      && !this.coderReadyTimeoutTimer
    ) {
      this.armCoderReadyTimeout();
    }
  }

  private isCoderReadyTimeoutPaused(): boolean {
    return this.coderSystemSuspended || this.coderScreenLocked || document.hidden;
  }

  private clearCoderEmbedLoadingTimers(): void {
    this.clearCoderEmbedRevealTimer();
    this.clearCoderLoaderDelayTimer();
    this.clearCoderLegacyReadyTimer();
    this.clearCoderReadyTimeoutTimer();
  }

  private clearCoderEmbedRevealTimer(): void {
    if (this.coderEmbedRevealTimer) {
      clearTimeout(this.coderEmbedRevealTimer);
      this.coderEmbedRevealTimer = undefined;
    }
  }

  private clearCoderLoaderDelayTimer(): void {
    if (this.coderEmbedLoaderDelayTimer) {
      clearTimeout(this.coderEmbedLoaderDelayTimer);
      this.coderEmbedLoaderDelayTimer = undefined;
    }
  }

  private clearCoderLegacyReadyTimer(): void {
    if (this.coderLegacyReadyTimer) {
      clearTimeout(this.coderLegacyReadyTimer);
      this.coderLegacyReadyTimer = undefined;
    }
  }

  private clearCoderReadyTimeoutTimer(): void {
    if (this.coderReadyTimeoutTimer) {
      clearTimeout(this.coderReadyTimeoutTimer);
      this.coderReadyTimeoutTimer = undefined;
    }
  }

  /** 解析编译产物并生成 hints / hostContext 共用的构建输出字段 */
  private async resolveEmbedBuildOutputs(projectRoot: string): Promise<{
    buildPath: string;
    artifacts: BuildArtifactV1[];
    mainHexAbs?: string;
    mainHexRelPath?: string;
  }> {
    const primaryBuildPath = await this.projectService.getBuildPath();
    const { buildPath, artifacts } = await resolveActualBuildOutputs(projectRoot, primaryBuildPath);
    const hex = artifacts.find((a) => a.label === 'main.hex');
    return {
      buildPath,
      artifacts,
      mainHexAbs: hex?.abs,
      mainHexRelPath: hex?.rel,
    };
  }

  /**
   * 写入内嵌 Coder 可读的路径提示。
   * buildPath 与 buildArtifacts 来自 resolveActualBuildOutputs，覆盖 aily-builder 全局缓存目录。
   * 文件位于 .aily/下，仓库 .gitignore 已忽略 .aily/。
   */
  private async writeCoderEmbedHints(projectRoot: string): Promise<void> {
    if (!this.isCurrentCoderWorkspace(projectRoot)) return;
    try {
      const pathApi = window['path'] as { join: (...s: string[]) => string };
      const fsAny = window['fs'] as { mkdirSync?: (p: string, o?: { recursive?: boolean }) => void };
      const { buildPath, artifacts, mainHexAbs, mainHexRelPath } =
        await this.resolveEmbedBuildOutputs(projectRoot);
      const ailyDir = pathApi.join(projectRoot, '.aily');
      if (!this.electronService.exists(ailyDir) && typeof fsAny?.mkdirSync === 'function') {
        fsAny.mkdirSync(ailyDir, { recursive: true });
      }
      const hintsPath = pathApi.join(projectRoot, '.aily', 'coder-embed-hints.json');
      const platformPackages = await this.loadPlatformPackagesForEmbed();
      const boardProfile = await this.buildBoardProfileForEmbed(projectRoot);
      // 无任何真实产物时不写入 buildPath，避免 Coder 侧误展示虚拟节点
      const payload = {
        v: 1,
        ...(artifacts.length > 0
          ? {
              buildPath,
              buildArtifacts: artifacts.map((a) => ({
                label: a.label,
                abs: a.abs,
                ...(a.rel ? { rel: a.rel } : {}),
              })),
              ...(mainHexAbs ? { mainHexAbs, ...(mainHexRelPath ? { mainHexRelPath } : {}) } : {}),
            }
          : {}),
        ...(platformPackages.length > 0 ? { platformPackages } : {}),
        ...(boardProfile ? { boardProfile } : {}),
      };
      if (!this.isCurrentCoderWorkspace(projectRoot)) return;
      this.electronService.writeFile(hintsPath, JSON.stringify(payload, null, 2));
    } catch (e) {
      console.warn('[CodeEditorPro] writeCoderEmbedHints', e);
    }
  }

  /**
   * 先同步注入工作区与语言，再异步补充构建产物和平台包。
   * Coder 库目录由子应用按当前区域独立加载，不再从 Blockly 库目录注入。
   */
  private async pushAilyCoderHostContext(projectRoot: string): Promise<void> {
    if (!this.isCurrentCoderWorkspace(projectRoot)) return;
    const generation = ++this.coderHostContextGeneration;
    const win = this.coderEmbedFrame?.nativeElement?.contentWindow;
    if (!win) {
      return;
    }
    const hostLanguage = this.translate.currentLang || this.translate.defaultLang || 'en';
    const appDataPath = window['path'].getAppDataPath() as string;
    if (
      this.isCurrentCoderWorkspace(projectRoot)
      && win === this.coderEmbedFrame?.nativeElement?.contentWindow
    ) {
      win.postMessage({
        channel: AILY_CODER_EDITOR_HOST_CONTEXT_CHANNEL,
        payload: {
          v: 1 as const,
          workspaceRoot: projectRoot,
          appDataPath,
          meta: { theme: this.themeService.theme(), lang: hostLanguage },
        },
      }, '*');
    }
    try {
      const [buildOutputs, platformPackages, boardProfile] = await Promise.all([
        this.resolveEmbedBuildOutputs(projectRoot),
        this.loadPlatformPackagesForEmbed(),
        this.buildBoardProfileForEmbed(projectRoot),
      ]);
      const { buildPath, artifacts, mainHexAbs, mainHexRelPath } = buildOutputs;
      const payload = {
        v: 1 as const,
        workspaceRoot: projectRoot,
        appDataPath,
        ...(artifacts.length > 0
          ? {
              buildPath,
              buildArtifacts: artifacts.map((a) => ({
                label: a.label,
                absPath: a.abs,
                ...(a.rel ? { relPath: a.rel } : {}),
              })),
              ...(mainHexAbs
                ? {
                    mainHexAbsPath: mainHexAbs,
                    ...(mainHexRelPath ? { mainHexRelPath } : {}),
                  }
                : {}),
            }
          : {}),
        ...(platformPackages.length > 0 ? { platformPackages } : {}),
        ...(boardProfile ? { boardProfile } : {}),
        meta: { theme: this.themeService.theme(), lang: hostLanguage },
      };
      if (
        generation !== this.coderHostContextGeneration
        || !this.isCurrentCoderWorkspace(projectRoot)
        || win !== this.coderEmbedFrame?.nativeElement?.contentWindow
      ) {
        return;
      }
      win.postMessage({ channel: AILY_CODER_EDITOR_HOST_CONTEXT_CHANNEL, payload }, '*');
    } catch (e) {
      console.warn('[CodeEditorPro] postMessage host context 失败', e);
    }
  }

  private isCurrentCoderWorkspace(projectRoot: string): boolean {
    return !this.destroyed && this.coderEmbedWorkspaceRoot === projectRoot;
  }

  /**
   * Blockly 主板「一板多类型」：来自主板 npm 包 package.json 的 mode[]，
   * 当前选中项对齐工程 package.json devmode/framework。
   */
  private async buildBoardProfileForEmbed(projectRoot: string): Promise<
    | {
        boardName?: string;
        boardNickname?: string;
        frameworkModes: Array<{
          id: string;
          label: string;
          description?: string;
          selected?: boolean;
        }>;
      }
    | undefined
  > {
    try {
      const boardPkg = await this.projectService.getBoardPackageJson();
      const boardJson = this.projectService.currentBoardConfig as Record<string, unknown> | null;
      const pkg = this.projectService.currentPackageData;
      const modeList: string[] = [];
      if (Array.isArray(boardPkg?.mode) && boardPkg.mode.length > 0) {
        for (const m of boardPkg.mode) {
          const s = String(m ?? '').trim();
          if (s) {
            modeList.push(s);
          }
        }
      }
      const pkgAny = pkg as { devmode?: string; framework?: string } | undefined;
      let currentFramework = String(pkgAny?.devmode ?? pkgAny?.framework ?? '').trim();
      if (!currentFramework && modeList.length > 0) {
        currentFramework = modeList[0];
      }
      if (modeList.length === 0 && boardJson?.['type']) {
        modeList.push(String(boardJson['type']));
      }
      if (modeList.length === 0) {
        return undefined;
      }
      const frameworkModes = modeList.map((id) => ({
        id,
        label: id,
        selected: id === currentFramework,
      }));
      return {
        boardName: (boardJson?.['name'] as string) ?? boardPkg?.name,
        boardNickname:
          boardPkg?.nickname ??
          boardPkg?.displayName ??
          (pkg?.board as { nickname?: string } | undefined)?.nickname,
        frameworkModes,
      };
    } catch (e) {
      console.warn('[CodeEditorPro] buildBoardProfileForEmbed', e);
      return undefined;
    }
  }

  /** 从当前工程有效平台依赖（主板 + platform runtimeDependencies）解析全局 sdk/tools 目录 */
  private async loadPlatformPackagesForEmbed() {
    try {
      return await resolvePlatformPackagesForCurrentProject(async () => {
        return this.projectService.getEffectiveBoardDependencies();
      });
    } catch (e) {
      console.warn('[CodeEditorPro] loadPlatformPackagesForEmbed', e);
      return [];
    }
  }

  private hasFileWithExtension(
    fileList: Array<{ name: string; parentPath: string; path: string }>,
    extension: string,
  ): boolean {
    return fileList.some((file) => file.name.toLowerCase().endsWith(extension.toLowerCase()));
  }

  /**
   * preload `fs.watch` 历史上可能返回 `() => void` 或 `{ close() }`（后者会覆盖前者定义）。
   * 统一为可安全重复调用的 dispose 函数。
   */
  private coerceFsWatchDispose(handle: unknown): () => void {
    if (typeof handle === 'function') {
      return handle as () => void;
    }
    const close = (handle as { close?: () => void } | null)?.close;
    if (typeof close === 'function') {
      return () => close.call(handle);
    }
    return () => {};
  }

  /** 销毁 iframe 时关闭全部 nativeFsWatchStart 注册的 fs.watch */
  private stopAllCoderEmbedFsWatchers(): void {
    for (const watchId of [...this.coderEmbedFsWatchers.keys()]) {
      this.stopCoderEmbedFsWatcher(watchId);
    }
  }

  private stopCoderEmbedFsWatcher(watchId: number): void {
    const dispose = this.coderEmbedFsWatchers.get(watchId);
    if (!dispose) return;
    this.coderEmbedFsWatchers.delete(watchId);
    try {
      dispose();
    } catch {
      /* 路径已删或 watcher 已关闭 */
    }
  }

  /** iframe 重载或销毁前统一断开消息桥和其注册的宿主 watcher。 */
  private detachCoderEmbedFrame(): void {
    this.stopAllCoderEmbedFsWatchers();
    this.stopAllCoderNativeSearches();
    this.codeCompletionHostBridge.registerFrame(null);
    this.aiCoderDiffBridge.registerEmbed(null);
  }

  private getCoderNativeSearchApi(): CoderNativeSearchApi | undefined {
    return window['ripgrep'] as CoderNativeSearchApi | undefined;
  }

  /** iframe 重载时不保留无消费者的 rg 子进程。 */
  private stopAllCoderNativeSearches(): void {
    const searchApi = this.getCoderNativeSearchApi();
    for (const requestId of this.coderNativeSearchRequestIds) {
      try {
        searchApi?.cancelSearch?.(requestId);
      } catch {
        /* Electron 正在退出时 IPC 可能已释放。 */
      }
    }
    this.coderNativeSearchRequestIds.clear();
  }

  /** 关闭 .aily/build 与全局编译缓存目录监听 */
  private stopBuildOutputsWatch(): void {
    if (this.buildOutputsWatchDebounce != null) {
      clearTimeout(this.buildOutputsWatchDebounce);
      this.buildOutputsWatchDebounce = undefined;
    }
    this.disposeBuildOutputsWatch?.();
    this.disposeBuildOutputsWatch = undefined;
    this.disposeGlobalBuildOutputsWatch?.();
    this.disposeGlobalBuildOutputsWatch = undefined;
  }

  /**
   * 递归监听 `.aily/build` 与全局 aily-builder 编译缓存：产物落在编译环境目录时也能实时同步。
   */
  private setupBuildOutputsWatch(projectRoot: string): void {
    this.stopBuildOutputsWatch();
    const pathApi = window['path'] as {
      join: (...s: string[]) => string;
      getAilyBuilderBuildPath?: () => string;
    };
    const fsAny = window['fs'] as {
      watch?: (
        path: string,
        cb: (ev: { eventType?: string; filename?: string }) => void,
        options?: { recursive?: boolean },
      ) => () => void;
      existsSync?: (p: string) => boolean;
      mkdirSync?: (p: string, o?: { recursive?: boolean }) => void;
    };
    if (typeof fsAny?.watch !== 'function') {
      return;
    }
    const buildRoot = pathApi.join(projectRoot, '.aily', 'build');
    const globalBuildRoot = pathApi.getAilyBuilderBuildPath?.() ?? '';
    if (!fsAny.existsSync?.(buildRoot) && typeof fsAny.mkdirSync === 'function') {
      try {
        fsAny.mkdirSync(buildRoot, { recursive: true });
      } catch {
        /* 工程根只读等极端情况 */
      }
    }
    const scheduleRefresh = (): void => {
      if (this.coderEmbedWorkspaceRoot !== projectRoot) {
        return;
      }
      if (this.buildOutputsWatchDebounce != null) {
        clearTimeout(this.buildOutputsWatchDebounce);
      }
      this.buildOutputsWatchDebounce = setTimeout(() => {
        this.buildOutputsWatchDebounce = undefined;
        if (this.coderEmbedWorkspaceRoot !== projectRoot) {
          return;
        }
        void this.writeCoderEmbedHints(projectRoot);
        void this.pushAilyCoderHostContext(projectRoot);
      }, 200);
    };
    try {
      this.disposeBuildOutputsWatch = this.coerceFsWatchDispose(
        fsAny.watch(buildRoot, () => scheduleRefresh(), { recursive: true }),
      );
    } catch {
      /* watch 不可用时仍依赖 compile 完成后的主动推送 */
    }
    if (globalBuildRoot && fsAny.existsSync?.(globalBuildRoot)) {
      try {
        this.disposeGlobalBuildOutputsWatch = this.coerceFsWatchDispose(
          fsAny.watch(globalBuildRoot, () => scheduleRefresh(), { recursive: true }),
        );
      } catch {
        /* 全局缓存目录 watch 失败时仍依赖 buildFinished */
      }
    }
  }

  /** 将宿主 fs.watch 事件推送给内嵌 Coder iframe */
  private pushCoderNativeFsWatchEvent(
    watchId: number,
    event: { eventType?: string; filename?: string; error?: string },
  ): void {
    const win = this.coderEmbedFrame?.nativeElement?.contentWindow;
    if (!win) {
      return;
    }
    try {
      win.postMessage(
        {
          channel: CODEMBED_NATIVE_FS_WATCH_EVENT,
          watchId,
          eventType: event?.eventType,
          filename: event?.filename,
          error: event?.error,
        },
        '*',
      );
    } catch {
      /* ignore */
    }
  }

  private replyCoderNativeFs(
    src: Window | null | undefined,
    id: number,
    result?: unknown,
    error?: string,
  ) {
    try {
      src?.postMessage(
        {
          channel: 'aily-coder-editor-native-fs-reply',
          id,
          ...(error ? { error } : {}),
          ...(result !== undefined ? { result } : {}),
        },
        '*',
      );
    } catch {
      /* ignore */
    }
  }

  private runSingleCoderGitCommand(command: string, args: string[], cwd: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const streamId = `coder_git_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];
      let stdoutSize = 0;
      let stderrSize = 0;
      let settled = false;
      let subscription: Subscription | undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        subscription?.unsubscribe();
        if (error) {
          reject(error);
        } else {
          resolve(stdoutChunks.join(''));
        }
      };
      const failAndKill = (message: string) => {
        void this.cmdService.kill(streamId).catch(() => false);
        finish(new Error(message));
      };

      timeout = setTimeout(
        () => failAndKill(`Git 命令执行超过 ${CODER_GIT_COMMAND_TIMEOUT_MS / 1000} 秒，已终止`),
        CODER_GIT_COMMAND_TIMEOUT_MS,
      );

      subscription = this.cmdService.spawn(
        command,
        args,
        {
          cwd,
          shellProfile: false,
          streamId,
        },
        true,
      ).subscribe({
        next: (event: CmdOutput) => {
          if (event.type === 'stdout') {
            const chunk = event.data ?? '';
            if (stdoutSize + chunk.length > CODER_GIT_MAX_STDOUT_CHARS) {
              failAndKill('Git 命令输出过大，已终止以保护编辑器进程');
              return;
            }
            stdoutSize += chunk.length;
            stdoutChunks.push(chunk);
            return;
          }
          if (event.type === 'stderr') {
            const chunk = event.data ?? '';
            if (stderrSize < CODER_GIT_MAX_STDERR_CHARS) {
              const remaining = CODER_GIT_MAX_STDERR_CHARS - stderrSize;
              const kept = chunk.slice(0, remaining);
              stderrSize += kept.length;
              stderrChunks.push(kept);
            }
            return;
          }
          if (event.type === 'error') {
            finish(new Error(event.error || stderrChunks.join('') || 'Git 命令执行失败'));
            return;
          }
          if (event.type === 'close') {
            if (stdoutSize === 0 && typeof event.stdout === 'string') {
              stdoutChunks.push(event.stdout);
            }
            if (stderrSize === 0 && typeof event.stderr === 'string') {
              stderrChunks.push(event.stderr.slice(0, CODER_GIT_MAX_STDERR_CHARS));
            }
            if ((event.code ?? 0) === 0) {
              finish();
            } else {
              finish(new Error(
                stderrChunks.join('')
                || stdoutChunks.join('')
                || `git ${args[0] ?? ''} 执行失败`,
              ));
            }
          }
        },
        error: (error: unknown) => finish(error instanceof Error ? error : new Error(String(error))),
      });
    });
  }

  private isGitExecutableMissing(error: unknown): boolean {
    const message = (error instanceof Error ? error.message : String(error ?? '')).toLowerCase();
    return message.includes('enoent')
      || message.includes('command not found')
      || message.includes('not recognized')
      || (message.includes('无法将') && message.includes('识别'))
      || message.includes('不是内部或外部命令');
  }

  private isNotGitRepository(error: unknown): boolean {
    const message = (error instanceof Error ? error.message : String(error ?? '')).toLowerCase();
    return message.includes('not a git repository')
      || message.includes('不是一个 git 仓库')
      || message.includes('不是 git 仓库');
  }

  private coderGitExecutableCandidates(): string[] {
    const pathApi = window['path'] as {
      join?: (...parts: string[]) => string;
      getUserHome?: () => string;
    };
    const fsAny = window['fs'] as { existsSync?: (path: string) => boolean };
    if (!pathApi.join || !fsAny.existsSync) return [];

    const platform = (window as any).electronAPI?.platform?.type as string | undefined;
    const home = pathApi.getUserHome?.() ?? '';
    const candidates: string[] = [];
    if (platform === 'win32') {
      const roots = new Set<string>(['C:\\']);
      for (const value of [home, this.coderEmbedWorkspaceRoot ?? '']) {
        const match = value.match(/^[a-zA-Z]:[\\/]/);
        if (match) roots.add(`${match[0][0].toUpperCase()}:\\`);
      }
      for (const root of roots) {
        candidates.push(
          pathApi.join(root, 'Program Files', 'Git', 'cmd', 'git.exe'),
          pathApi.join(root, 'Program Files', 'Git', 'bin', 'git.exe'),
          pathApi.join(root, 'Program Files (x86)', 'Git', 'cmd', 'git.exe'),
        );
      }
      if (home) {
        candidates.push(pathApi.join(home, 'AppData', 'Local', 'Programs', 'Git', 'cmd', 'git.exe'));
      }
    } else {
      candidates.push('/usr/bin/git', '/opt/homebrew/bin/git', '/usr/local/bin/git', '/opt/local/bin/git');
    }
    return [...new Set(candidates)].filter((candidate) => fsAny.existsSync?.(candidate));
  }

  private async runCoderGitCommand(args: string[], cwd: string): Promise<string> {
    try {
      return await this.runSingleCoderGitCommand('git', args, cwd);
    } catch (error) {
      if (!this.isGitExecutableMissing(error)) throw error;
      for (const executable of this.coderGitExecutableCandidates()) {
        try {
          return await this.runSingleCoderGitCommand(executable, args, cwd);
        } catch (fallbackError) {
          if (!this.isGitExecutableMissing(fallbackError)) throw fallbackError;
        }
      }
      throw error;
    }
  }

  private assertCoderGitRelativePath(value: unknown): string {
    const normalized = String(value ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
    const pathApi = window['path'] as { isAbsolute?: (path: string) => boolean };
    const segments = normalized.split('/');
    if (
      !normalized
      || normalized.includes('\0')
      || pathApi.isAbsolute?.(normalized)
      || segments.includes('..')
      || segments.some((segment) =>
        CODER_GIT_SYSTEM_DIRECTORIES.includes(segment.toLowerCase() as typeof CODER_GIT_SYSTEM_DIRECTORIES[number])
      )
    ) {
      throw new Error('无效的 Git 工作区相对路径');
    }
    return normalized;
  }

  private assertCoderGitRevision(value: unknown): string {
    const revision = String(value ?? '').trim();
    if (!/^[0-9a-f]{40,64}$/i.test(revision)) {
      throw new Error('无效的 Git 提交版本');
    }
    return revision;
  }

  private async readCoderGitHistoryRefs(cwd: string): Promise<CoderGitHistoryRefs> {
    try {
      await this.runCoderGitCommand(['rev-parse', '--show-toplevel'], cwd);
    } catch (error) {
      if (this.isNotGitRepository(error)) return { refs: [] };
      throw error;
    }

    let headRevision: string;
    try {
      headRevision = (
        await this.runCoderGitCommand(['rev-parse', '--verify', 'HEAD'], cwd)
      ).trim();
    } catch {
      return { refs: [] };
    }

    const rawRefs = await this.runCoderGitCommand(
      [
        'for-each-ref',
        '--format=%(objectname)%00%(*objectname)%00%(refname)%00%(refname:short)',
        'refs/heads',
        'refs/remotes',
        'refs/tags',
      ],
      cwd,
    );
    const refs: CoderGitHistoryRef[] = rawRefs.split(/\r?\n/).flatMap((line) => {
      if (!line) return [];
      const [objectName = '', peeledName = '', id = '', name = ''] = line.split('\0');
      const revision = peeledName || objectName;
      if (!id || !name || !/^[0-9a-f]{40,64}$/i.test(revision)) return [];
      const category = id.startsWith('refs/heads/')
        ? 'local' as const
        : id.startsWith('refs/remotes/')
          ? 'remote' as const
          : 'tag' as const;
      return [{ id, name, revision, category }];
    });

    const branchName = (
      await this.runCoderGitCommand(['branch', '--show-current'], cwd)
    ).trim();
    const branchRef = refs.find(
      (ref) => ref.id === `refs/heads/${branchName}` && ref.category === 'local',
    );
    const current: CoderGitHistoryRef = branchRef ?? {
      id: 'HEAD',
      name: branchName || 'HEAD',
      revision: headRevision,
      category: branchName ? 'local' as const : 'head' as const,
    };
    if (!branchRef) refs.unshift(current);

    let upstreamName = '';
    try {
      upstreamName = (
        await this.runCoderGitCommand(
          ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
          cwd,
        )
      ).trim();
    } catch {
      /* 当前分支没有 upstream。 */
    }
    const remote = refs.find((ref) => ref.id === `refs/remotes/${upstreamName}`);
    return {
      current,
      ...(remote?.category === 'remote' ? { remote } : {}),
      refs,
    };
  }

  /**
   * 在访达中高亮路径：允许工程根内、getBuildPath() 推断目录、或 aily-builder 全局缓存目录下的产物。
   * 同时校验 resolveActualBuildOutputs 解析的编译产物路径，覆盖产物落到 ~/Library/aily-builder 的常见情况。
   */
  private async resolvePathForRevealInOs(absPath: string): Promise<string | null> {
    const pathApi = window['path'] as {
      resolve?: (p: string) => string;
      join: (...s: string[]) => string;
      sep?: string;
      getAilyBuilderBuildPath?: () => string;
    };
    const sep = pathApi.sep ?? '/';
    const normalized = pathApi.resolve ? pathApi.resolve(absPath) : absPath;
    try {
      return this.assertPathInsideCoderEmbedRoot(normalized);
    } catch {
      /* 继续尝试构建产物目录 */
    }
    try {
      const root = this.coderEmbedWorkspaceRoot;
      const primaryBuild = await this.projectService.getBuildPath();
      // primaryBuild 命中：与 dev-tool openCompileFolder 同源
      const bpNorm = pathApi.resolve ? pathApi.resolve(primaryBuild) : primaryBuild;
      if (normalized.startsWith(bpNorm + sep) || normalized === bpNorm) {
        return normalized;
      }
      // 编译产物路径命中：覆盖 aily-builder 把产物落到全局缓存目录
      if (root) {
        const { buildPath, artifacts } = await resolveActualBuildOutputs(root, primaryBuild);
        for (const art of artifacts) {
          const artNorm = pathApi.resolve ? pathApi.resolve(art.abs) : art.abs;
          if (artNorm === normalized) {
            return normalized;
          }
        }
        const realBuildNorm = pathApi.resolve ? pathApi.resolve(buildPath) : buildPath;
        if (normalized.startsWith(realBuildNorm + sep) || normalized === realBuildNorm) {
          return normalized;
        }
      }
      // 兜底：aily-builder 全局根下任何路径都放行（节点 absolutePath 由 IDE 自身写入，可信）
      const globalRoot = pathApi.getAilyBuilderBuildPath?.();
      if (globalRoot) {
        const globalNorm = pathApi.resolve ? pathApi.resolve(globalRoot) : globalRoot;
        if (normalized === globalNorm || normalized.startsWith(globalNorm + sep)) {
          return normalized;
        }
      }
      // Platform Packages：全局 appdata/aily-project 下的 sdk、tools、compiler 目录
      const appDataRoot = window['path'].getAppDataPath?.() as string | undefined;
      if (appDataRoot) {
        const appDataNorm = pathApi.resolve ? pathApi.resolve(appDataRoot) : appDataRoot;
        if (normalized === appDataNorm || normalized.startsWith(appDataNorm + sep)) {
          return normalized;
        }
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  /**
   * postMessage / BroadcastChannel 统一入口：校验路径后 shell.showItemInFolder。
   * 文件已生成 -> 定位并选中；尚未生成（如未编译的 main.hex）-> 回退打开父目录，避免「点击无反应」。
   */
  private async runHostRevealInOs(absPathRaw: string): Promise<void> {
    const resolved = await this.resolvePathForRevealInOs(absPathRaw);
    if (resolved == null) {
      this.message.warning('无法在访达中显示：路径不在允许的工程或构建目录内');
      return;
    }
    const fsApi = window['fs'] as {
      existsSync?: (p: string) => boolean;
      isDirectory?: (p: string) => boolean;
    } | undefined;
    const pathApi = window['path'] as { dirname?: (p: string) => string } | undefined;
    const electronShell = (
      window as unknown as {
        electronAPI?: { shell?: { showItemInFolder?: (p: string) => void } };
      }
    ).electronAPI?.shell;
    const otherApi = (window as unknown as {
      other?: { openByExplorer?: (p: string) => void };
    }).other;
    try {
      if (fsApi?.existsSync?.(resolved)) {
        // 平台包等为目录：用资源管理器/Finder 打开文件夹；文件则高亮选中（同 main.hex）
        if (fsApi.isDirectory?.(resolved)) {
          otherApi?.openByExplorer?.(resolved);
          return;
        }
        electronShell?.showItemInFolder?.(resolved);
        return;
      }
      // 文件不存在：尝试打开父目录，至少把用户带到「应该所在」的位置
      const parent = pathApi?.dirname?.(resolved);
      if (parent && fsApi?.existsSync?.(parent)) {
        otherApi?.openByExplorer?.(parent);
        this.message.info('目标文件尚未生成，已打开所在目录');
        return;
      }
      this.message.warning('文件与所在目录均不存在，无法定位');
    } catch (e) {
      console.warn('[CodeEditorPro] showItemInFolder', e);
      this.message.warning('无法在访达中显示');
    }
  }

  /** 将Coder iframe 请求的绝对路径规范到当前工程目录内 */
  private assertPathInsideCoderEmbedRoot(candidatePath: string): string {
    const root = this.coderEmbedWorkspaceRoot;
    if (!root?.trim()) {
      throw new Error('未初始化工程路径');
    }
    const pathApi = window['path'] as {
      resolve?: (p: string) => string;
      relative?: (from: string, to: string) => string;
      isAbsolute?: (p: string) => boolean;
    };
    const resolvedRoot = pathApi.resolve ? pathApi.resolve(root) : root;
    const full = pathApi.resolve ? pathApi.resolve(candidatePath) : candidatePath;
    const rel = pathApi.relative ? pathApi.relative(resolvedRoot, full) : '';
    const inside =
      rel === '' ||
      (!rel.startsWith('..') && !(pathApi.isAbsolute?.(rel) ?? false));
    if (!inside) {
      throw new Error('路径不在当前工程目录内');
    }
    return full;
  }

  /**
   * nativeFsStat：允许工程根、全局 aily-builder 编译缓存、全局 aily-project 平台包目录。
   */
  private assertPathAllowedForCoderNativeFsStat(candidatePath: string): string {
    const pathApi = window['path'] as {
      resolve?: (p: string) => string;
      sep?: string;
      getAppDataPath?: () => string;
      getAilyBuilderBuildPath?: () => string;
    };
    const sep = pathApi.sep ?? '/';
    const normalized = pathApi.resolve ? pathApi.resolve(candidatePath) : candidatePath;
    try {
      return this.assertPathInsideCoderEmbedRoot(normalized);
    } catch {
      /* 继续校验全局目录 */
    }
    const globalBuildRoot = pathApi.getAilyBuilderBuildPath?.();
    if (globalBuildRoot) {
      const globalNorm = pathApi.resolve ? pathApi.resolve(globalBuildRoot) : globalBuildRoot;
      if (
        normalized === globalNorm ||
        normalized.startsWith(globalNorm + sep) ||
        normalized.toLowerCase().startsWith((globalNorm + sep).toLowerCase())
      ) {
        return normalized;
      }
    }
    const appDataRoot = pathApi.getAppDataPath?.();
    if (appDataRoot) {
      const appDataNorm = pathApi.resolve ? pathApi.resolve(appDataRoot) : appDataRoot;
      if (
        normalized === appDataNorm ||
        normalized.startsWith(appDataNorm + sep) ||
        normalized.toLowerCase().startsWith((appDataNorm + sep).toLowerCase())
      ) {
        return normalized;
      }
    }
    throw new Error('路径不在允许的工程、编译缓存或平台包目录内');
  }

  /**
   * 只读 native-fs：允许工程根、全局 aily-project（sdk/boards.txt 等），与 resolvePathForRevealInOs 策略一致。
   */
  private assertPathAllowedForCoderNativeFsRead(candidatePath: string): string {
    const pathApi = window['path'] as {
      resolve?: (p: string) => string;
      normalize?: (p: string) => string;
      sep?: string;
      getAppDataPath?: () => string;
    };
    const sep = pathApi.sep ?? '/';
    const normalized = pathApi.resolve ? pathApi.resolve(candidatePath) : candidatePath;
    try {
      return this.assertPathInsideCoderEmbedRoot(normalized);
    } catch {
      /* 继续校验全局平台包目录 */
    }
    const appDataRoot = pathApi.getAppDataPath?.();
    if (appDataRoot) {
      const appDataNorm = pathApi.resolve ? pathApi.resolve(appDataRoot) : appDataRoot;
      if (
        normalized === appDataNorm ||
        normalized.startsWith(appDataNorm + sep) ||
        normalized.toLowerCase().startsWith((appDataNorm + sep).toLowerCase())
      ) {
        return normalized;
      }
    }
    throw new Error('路径不在允许的工程或平台包目录内');
  }

  /** 与 Aily View 中 Installed Libraries 展开状态同步库管理侧栏 */
  private syncHostLibraryManager(open: boolean): void {
    if (open) {
      this.uiService.openTool('lib-manager');
    } else {
      this.uiService.closeTool('lib-manager');
    }
  }

  private async onCoderNativeFsMessage(ev: MessageEvent): Promise<void> {
    if (this.codeCompletionHostBridge.handleMessage(ev)) {
      return;
    }
    const msg = ev.data as {
      channel?: string;
      version?: number;
      id?: number;
      op?: string;
      payload?: Record<string, unknown>;
      absPath?: string;
    };
    if (msg?.channel === AILY_CODER_EDITOR_HOST_CONTEXT_REQUEST_CHANNEL) {
      const frameWindow = this.coderEmbedFrame?.nativeElement?.contentWindow;
      const root = this.coderEmbedWorkspaceRoot;
      if (frameWindow && root && ev.source === frameWindow) {
        void this.pushAilyCoderHostContext(root);
      }
      return;
    }
    if (
      msg?.channel === AILY_CODER_EDITOR_READY_PROTOCOL_CHANNEL
      || msg?.channel === AILY_CODER_EDITOR_READY_CHANNEL
    ) {
      const frameWindow = this.coderEmbedFrame?.nativeElement?.contentWindow;
      if (
        !frameWindow
        || ev.source !== frameWindow
      ) {
        return;
      }
      if (msg.channel === AILY_CODER_EDITOR_READY_PROTOCOL_CHANNEL) {
        if (msg.version !== AILY_CODER_EDITOR_READY_PROTOCOL_VERSION) return;
        if (!this.coderEmbedLoading) return;
        this.coderReadyProtocolSupported = true;
        this.coderLoadingStage = 'workbench';
        this.clearCoderLegacyReadyTimer();
        this.armCoderReadyTimeout();
      } else if (
        msg.version === undefined
        || msg.version === AILY_CODER_EDITOR_READY_PROTOCOL_VERSION
      ) {
        this.coderReadyProtocolSupported = true;
        this.coderWorkbenchReady = true;
        if (this.coderEmbedLoading) this.completeCoderEmbedLoading();
        // iframe load / host theme events can race with a language-triggered navigation.
        // Replay the latest snapshot only after the new Workbench has installed its
        // host-context listener so a simultaneous theme change cannot be lost.
        const root = this.coderEmbedWorkspaceRoot;
        if (root) void this.pushAilyCoderHostContext(root);
      }
      return;
    }
    // 内嵌编辑器：在访达 / 资源管理器中高亮文件（工程根内或当前 getBuildPath 产物目录）
    if (msg?.channel === AILY_CODER_EDITOR_REVEAL_IN_OS_CHANNEL) {
      void this.runHostRevealInOs(String(msg.absPath ?? ''));
      return;
    }
    if (msg?.channel === AILY_CODER_EDITOR_OPEN_LIBRARY_MANAGER_CHANNEL) {
      const open =
        (msg as { open?: boolean }).open !== false;
      this.syncHostLibraryManager(open);
      return;
    }
    if (msg?.channel === AILY_CODER_EDITOR_OPEN_BOARD_SELECTOR_CHANNEL) {
      void this.uiService.openBoardSelector();
      return;
    }
    if (msg?.channel === AILY_CODER_EDITOR_CLIPBOARD_WRITE_CHANNEL) {
      const text = (msg as { text?: string }).text;
      if (typeof text === 'string') {
        this.electronService.clipboardWriteText(text);
      }
      return;
    }
    if (msg?.channel !== 'aily-coder-editor-native-fs' || typeof msg.id !== 'number' || !msg.op) {
      return;
    }
    if (ev.source !== this.coderEmbedFrame?.nativeElement?.contentWindow) {
      return;
    }
    const replyErr = (e: unknown) =>
      this.replyCoderNativeFs(
        ev.source as Window | undefined | null,
        msg.id as number,
        undefined,
        e instanceof Error ? e.message : String(e),
      );

    try {
      const payload = msg.payload ?? {};
      const fsAny = window['fs'] as any;
      if (!window['path']?.['resolve'] || !fsAny?.['existsSync']) {
        replyErr(new Error('文件系统不可用（非 Electron 环境？）'));
        return;
      }
      switch (msg.op) {
        case 'nativeSearchCapabilities': {
          const searchApi = this.getCoderNativeSearchApi();
          this.replyCoderNativeFs(ev.source as Window, msg.id!, {
            protocolVersion: AILY_CODER_EDITOR_NATIVE_SEARCH_PROTOCOL_VERSION,
            textSearch: typeof searchApi?.searchText === 'function',
            cancellation: typeof searchApi?.cancelSearch === 'function',
          });
          break;
        }
        case 'nativeSearchCancel': {
          const requestId = normalizeCoderNativeSearchRequestId(payload['requestId']);
          this.getCoderNativeSearchApi()?.cancelSearch?.(requestId);
          this.coderNativeSearchRequestIds.delete(requestId);
          this.replyCoderNativeFs(ev.source as Window, msg.id!, {});
          break;
        }
        case 'nativeSearchText': {
          const workspaceRoot = this.assertPathInsideCoderEmbedRoot(
            String(payload['workspaceRoot']),
          );
          const requestId = normalizeCoderNativeSearchRequestId(payload['requestId']);
          const pattern = typeof payload['pattern'] === 'string' ? payload['pattern'] : '';
          if (
            !pattern
            || pattern.length > CODER_NATIVE_SEARCH_MAX_PATTERN_LENGTH
            || pattern.includes('\0')
          ) {
            replyErr(new Error('原生搜索 pattern 为空、过长或包含非法字符'));
            return;
          }
          const searchApi = this.getCoderNativeSearchApi();
          if (typeof searchApi?.searchText !== 'function') {
            replyErr(new Error('当前 Electron 宿主不支持原生文本搜索'));
            return;
          }
          this.coderNativeSearchRequestIds.add(requestId);
          try {
            const result = await searchApi.searchText({
              requestId,
              path: workspaceRoot,
              pattern,
              isRegex: !!payload['isRegex'],
              isCaseSensitive: !!payload['isCaseSensitive'],
              isWordMatch: !!payload['isWordMatch'],
              isMultiline: !!payload['isMultiline'],
              usePCRE2: !!payload['usePCRE2'],
              includeIgnoredFiles: !!payload['includeIgnoredFiles'],
              includeHidden: payload['includeHidden'] !== false,
              includeGlobs: normalizeCoderNativeSearchGlobs(payload['includeGlobs']),
              excludeGlobs: normalizeCoderNativeSearchGlobs(payload['excludeGlobs']),
              maxResults: boundedCoderNativeSearchInteger(
                payload['maxResults'],
                500,
                CODER_NATIVE_SEARCH_MAX_RESULTS,
              ),
              maxLineLength: boundedCoderNativeSearchInteger(
                payload['maxLineLength'],
                500,
                2000,
              ),
              maxFileSize: boundedCoderNativeSearchInteger(
                payload['maxFileSize'],
                10 * 1024 * 1024,
                CODER_NATIVE_SEARCH_MAX_FILE_SIZE,
              ),
            });
            this.replyCoderNativeFs(ev.source as Window, msg.id!, result);
          } finally {
            this.coderNativeSearchRequestIds.delete(requestId);
          }
          break;
        }
        case 'nativeFsStat': {
          const abs = this.assertPathAllowedForCoderNativeFsStat(String(payload['path']));
          if (!fsAny['existsSync'](abs)) {
            this.replyCoderNativeFs(ev.source as Window, msg.id!, {
              exists: false,
              size: 0,
              mtimeMs: 0,
            });
            return;
          }
          const st = fsAny['statSync'](abs) as {
            size: number;
            mtime: string;
            _isDirectory?: boolean;
            _isFile?: boolean;
          };
          this.replyCoderNativeFs(ev.source as Window, msg.id!, {
            exists: true,
            _isDirectory: st._isDirectory,
            _isFile: st._isFile,
            size: st.size,
            mtimeMs: Date.parse(st.mtime),
          });
          break;
        }
        case 'nativeFsReaddir': {
          const abs = this.assertPathInsideCoderEmbedRoot(String(payload['path']));
          const list = fsAny['readDirSync'](abs) as Array<{
            name: string;
            _isDirectory: boolean;
            _isFile: boolean;
          }>;
          this.replyCoderNativeFs(ev.source as Window, msg.id!, list);
          break;
        }
        case 'nativeFsReadBinary': {
          const abs = this.assertPathAllowedForCoderNativeFsRead(String(payload['path']));
          const base64 = fsAny['readFileAsBase64'](abs) as string;
          this.replyCoderNativeFs(ev.source as Window, msg.id!, { base64 });
          break;
        }
        case 'nativeFsWriteBinary': {
          const abs = this.assertPathInsideCoderEmbedRoot(String(payload['path']));
          fsAny['writeBase64File'](abs, String(payload['base64'] ?? ''));
          this.replyCoderNativeFs(ev.source as Window, msg.id!, {});
          break;
        }
        case 'nativeFsMkdir': {
          const abs = this.assertPathInsideCoderEmbedRoot(String(payload['path']));
          fsAny['mkdirSync'](abs);
          this.replyCoderNativeFs(ev.source as Window, msg.id!, {});
          break;
        }
        case 'nativeFsDelete': {
          const abs = this.assertPathInsideCoderEmbedRoot(String(payload['path']));
          const recursive = !!payload['recursive'];
          if (fsAny['isDirectory'](abs)) {
            if (recursive) {
              fsAny['rmdirSync'](abs);
            } else {
              const entries = fsAny['readDirSync'](abs) as unknown[];
              if (entries?.length > 0) {
                replyErr(new Error('目录非空'));
                return;
              }
              fsAny['rmdirSync'](abs);
            }
          } else {
            fsAny['unlinkSync'](abs);
          }
          this.replyCoderNativeFs(ev.source as Window, msg.id!, {});
          break;
        }
        case 'nativeFsRename': {
          const from = this.assertPathInsideCoderEmbedRoot(String(payload['oldPath']));
          const to = this.assertPathInsideCoderEmbedRoot(String(payload['newPath']));
          const overwrite = !!payload['overwrite'];
          if (fsAny['existsSync'](to)) {
            if (!overwrite) {
              replyErr(new Error('目标已存在'));
              return;
            }
            const dir = fsAny['isDirectory'](to);
            if (typeof fsAny['rmSync'] === 'function') {
              fsAny['rmSync'](to, { recursive: true, force: true });
            } else if (dir) {
              fsAny['rmdirSync'](to);
            } else {
              fsAny['unlinkSync'](to);
            }
          }
          fsAny['renameSync'](from, to);
          this.replyCoderNativeFs(ev.source as Window, msg.id!, {});
          break;
        }
        case 'nativeFsWatchStart': {
          const abs = this.assertPathInsideCoderEmbedRoot(String(payload['path']));
          const recursive = !!payload['recursive'];
          const fsWatch = fsAny['watch'] as
            | ((
                path: string,
                cb: (
                  eventTypeOrEvent: string | { eventType?: string; filename?: string; error?: string },
                  filename?: string | null,
                ) => void,
                options?: { recursive?: boolean },
              ) => () => void)
            | undefined;
          if (typeof fsWatch !== 'function') {
            replyErr(new Error('fs.watch 不可用'));
            return;
          }
          const watchId = ++this.coderEmbedFsWatchSeq;
          try {
            let watcherFailed = false;
            const rawDispose = fsWatch(
              abs,
              (eventTypeOrEvent, filenameArg) => {
                const event = typeof eventTypeOrEvent === 'object' && eventTypeOrEvent !== null
                  ? eventTypeOrEvent
                  : {
                      eventType: String(eventTypeOrEvent ?? ''),
                      filename: filenameArg ?? undefined,
                    };
                this.pushCoderNativeFsWatchEvent(watchId, event);
                if (event.eventType === 'error') {
                  watcherFailed = true;
                  this.stopCoderEmbedFsWatcher(watchId);
                }
              },
              { recursive },
            );
            const dispose = this.coerceFsWatchDispose(rawDispose);
            if (watcherFailed) {
              dispose();
            } else {
              this.coderEmbedFsWatchers.set(watchId, dispose);
            }
            this.replyCoderNativeFs(ev.source as Window, msg.id!, { watchId });
          } catch (e: unknown) {
            replyErr(e);
          }
          break;
        }
        case 'nativeFsWatchStop': {
          const watchId = Number(payload['watchId']);
          this.stopCoderEmbedFsWatcher(watchId);
          this.replyCoderNativeFs(ev.source as Window, msg.id!, {});
          break;
        }
        case 'nativeGitStatus': {
          const workspaceRoot = this.assertPathInsideCoderEmbedRoot(String(payload['workspaceRoot']));
          let status: string;
          try {
            status = await this.runCoderGitCommand(
              [
                '-c',
                'core.quotepath=false',
                '-c',
                'status.relativePaths=true',
                'status',
                '--porcelain=v1',
                '-z',
                '--untracked-files=all',
                '--ignored=no',
                '--',
                ...CODER_GIT_PATHSPECS,
              ],
              workspaceRoot,
            );
          } catch (error) {
            if (!this.isNotGitRepository(error)) throw error;
            this.replyCoderNativeFs(ev.source as Window, msg.id!, {
              initialized: false,
              status: '',
            });
            break;
          }
          this.replyCoderNativeFs(ev.source as Window, msg.id!, {
            initialized: true,
            status,
          });
          break;
        }
        case 'nativeGitInit': {
          const workspaceRoot = this.assertPathInsideCoderEmbedRoot(String(payload['workspaceRoot']));
          const summary = await this.runCoderGitCommand(['init'], workspaceRoot);
          this.replyCoderNativeFs(ev.source as Window, msg.id!, { summary: summary.trim() });
          break;
        }
        case 'nativeGitHistoryRefs': {
          const workspaceRoot = this.assertPathInsideCoderEmbedRoot(String(payload['workspaceRoot']));
          const result = await this.readCoderGitHistoryRefs(workspaceRoot);
          this.replyCoderNativeFs(ev.source as Window, msg.id!, result);
          break;
        }
        case 'nativeGitHistoryItems': {
          const workspaceRoot = this.assertPathInsideCoderEmbedRoot(String(payload['workspaceRoot']));
          const inputRevisions = Array.isArray(payload['revisions']) ? payload['revisions'] : [];
          const revisions = [...new Set(inputRevisions.map((value) => this.assertCoderGitRevision(value)))];
          if (revisions.length > 32) {
            replyErr(new Error('Git Graph 一次最多查询 32 个引用'));
            return;
          }
          if (revisions.length === 0) {
            try {
              revisions.push((await this.runCoderGitCommand(['rev-parse', '--verify', 'HEAD'], workspaceRoot)).trim());
            } catch {
              this.replyCoderNativeFs(ev.source as Window, msg.id!, { history: '' });
              break;
            }
          }
          const skip = Math.max(0, Math.min(1000000, Math.trunc(Number(payload['skip']) || 0)));
          const limit = Math.max(1, Math.min(1000, Math.trunc(Number(payload['limit']) || 50)));
          const filterText = String(payload['filterText'] ?? '').trim();
          if (filterText.length > 500 || filterText.includes('\0')) {
            replyErr(new Error('Git Graph 过滤文本无效'));
            return;
          }
          const history = await this.runCoderGitCommand(
            [
              'log',
              '--topo-order',
              '--date-order',
              `--skip=${skip}`,
              `--max-count=${limit}`,
              ...(filterText
                ? ['--regexp-ignore-case', '--fixed-strings', `--grep=${filterText}`]
                : []),
              '--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%s%x00%B%x00',
              ...revisions,
            ],
            workspaceRoot,
          );
          this.replyCoderNativeFs(ev.source as Window, msg.id!, { history });
          break;
        }
        case 'nativeGitHistoryItemChanges': {
          const workspaceRoot = this.assertPathInsideCoderEmbedRoot(String(payload['workspaceRoot']));
          const historyItemId = this.assertCoderGitRevision(payload['historyItemId']);
          const historyItemParentId = payload['historyItemParentId'] == null
            ? undefined
            : this.assertCoderGitRevision(payload['historyItemParentId']);
          const args = historyItemParentId
            ? [
                'diff',
                '--name-status',
                '-z',
                '--find-renames',
                historyItemParentId,
                historyItemId,
                '--',
                ...CODER_GIT_PATHSPECS,
              ]
            : [
                'diff-tree',
                '--root',
                '--no-commit-id',
                '--name-status',
                '-r',
                '-z',
                '--find-renames',
                historyItemId,
                '--',
                ...CODER_GIT_PATHSPECS,
              ];
          const changes = await this.runCoderGitCommand(args, workspaceRoot);
          this.replyCoderNativeFs(ev.source as Window, msg.id!, { changes });
          break;
        }
        case 'nativeGitHistoryMergeBase': {
          const workspaceRoot = this.assertPathInsideCoderEmbedRoot(String(payload['workspaceRoot']));
          const revisions = Array.isArray(payload['revisions'])
            ? payload['revisions'].map((value) => this.assertCoderGitRevision(value))
            : [];
          if (revisions.length < 2 || revisions.length > 32) {
            replyErr(new Error('Git Graph 共同祖先参数无效'));
            return;
          }
          let revision: string | undefined;
          try {
            revision = (
              await this.runCoderGitCommand(['merge-base', '--octopus', ...revisions], workspaceRoot)
            ).trim() || undefined;
          } catch {
            revision = undefined;
          }
          this.replyCoderNativeFs(ev.source as Window, msg.id!, { revision });
          break;
        }
        case 'nativeGitShowRevisionFile': {
          const workspaceRoot = this.assertPathInsideCoderEmbedRoot(String(payload['workspaceRoot']));
          const revision = this.assertCoderGitRevision(payload['revision']);
          const relativePath = this.assertCoderGitRelativePath(payload['relativePath']);
          const prefix = (
            await this.runCoderGitCommand(['rev-parse', '--show-prefix'], workspaceRoot)
          ).trim().replace(/\\/g, '/');
          const content = await this.runCoderGitCommand(
            ['show', `${revision}:${prefix}${relativePath}`],
            workspaceRoot,
          );
          this.replyCoderNativeFs(ev.source as Window, msg.id!, { content });
          break;
        }
        case 'nativeGitShowHead': {
          const workspaceRoot = this.assertPathInsideCoderEmbedRoot(String(payload['workspaceRoot']));
          const relativePath = this.assertCoderGitRelativePath(payload['relativePath']);
          const prefix = (
            await this.runCoderGitCommand(['rev-parse', '--show-prefix'], workspaceRoot)
          ).trim().replace(/\\/g, '/');
          const content = await this.runCoderGitCommand(
            ['show', `HEAD:${prefix}${relativePath}`],
            workspaceRoot,
          );
          this.replyCoderNativeFs(ev.source as Window, msg.id!, { content });
          break;
        }
        case 'nativeGitCommit': {
          const workspaceRoot = this.assertPathInsideCoderEmbedRoot(String(payload['workspaceRoot']));
          const message = String(payload['message'] ?? '').trim();
          if (!message || message.length > 10000 || message.includes('\0')) {
            replyErr(new Error('提交消息为空或过长'));
            return;
          }
          try {
            await this.runCoderGitCommand(['rev-parse', '--show-toplevel'], workspaceRoot);
          } catch (error) {
            if (!this.isNotGitRepository(error)) throw error;
            await this.runCoderGitCommand(['init'], workspaceRoot);
          }
          await this.runCoderGitCommand(
            ['add', '-A', '--', ...CODER_GIT_PATHSPECS],
            workspaceRoot,
          );
          const summary = await this.runCoderGitCommand(
            ['commit', '-m', message, '--', ...CODER_GIT_PATHSPECS],
            workspaceRoot,
          );
          this.replyCoderNativeFs(ev.source as Window, msg.id!, { summary: summary.trim() });
          break;
        }
        default:
          replyErr(new Error(`未知 nativeFs op: ${msg.op}`));
      }
    } catch (e: unknown) {
      replyErr(e);
    }
  }
}
