import { AfterViewInit, ChangeDetectorRef, Component, ElementRef, EventEmitter, Input, OnDestroy, OnInit, Output, ViewChild, effect } from '@angular/core';
import * as Blockly from 'blockly';
import { Subject, combineLatest } from 'rxjs';
import { debounceTime, takeUntil, map, distinctUntilChanged, pairwise, startWith } from 'rxjs/operators';
import { TranslateService } from '@ngx-translate/core';

// Blockly 多语言包
import * as zhHans from 'blockly/msg/zh-hans';
import * as zhHant from 'blockly/msg/zh-hant';
import * as en from 'blockly/msg/en';
import * as ja from 'blockly/msg/ja';
import * as ko from 'blockly/msg/ko';
import * as de from 'blockly/msg/de';
import * as fr from 'blockly/msg/fr';
import * as es from 'blockly/msg/es';
import * as pt from 'blockly/msg/pt';
import * as ru from 'blockly/msg/ru';
import * as ar from 'blockly/msg/ar';

// 语言代码到 Blockly 语言包的映射
const BLOCKLY_LOCALES: { [key: string]: any } = {
  'zh_cn': zhHans,
  'zh_hk': zhHant,
  'zh-hans': zhHans,
  'zh-hant': zhHant,
  'en': en,
  'ja': ja,
  'ko': ko,
  'de': de,
  'fr': fr,
  'es': es,
  'pt': pt,
  'ru': ru,
  'ar': ar,
};
// import {
//   ContinuousToolbox,
//   ContinuousFlyout,
//   ContinuousMetrics,
// } from './plugins/continuous-toolbox/src/index.js';
import './plugins/toolbox-search/src/index';
import './plugins/block-plus-minus/src/index.js';
import { arduinoGenerator, type BlockCodeMapping } from './generators/arduino/arduino';
import { micropythonGenerator } from './generators/micropython/micropython';
import { BlocklyService } from '../../services/blockly.service';
import { convertAbiToAbsWithLineMap } from '../../../../tools/aily-chat/public-api';
import { BitmapUploadResponse, GlobalServiceManager } from '../../services/bitmap-upload.service';

import './renderer/aily-icon';
import './renderer/aily-thrasos/thrasos';
import './renderer/aily-zelos/zelos';
import './custom-category';
import './custom-field/field-bitmap';
import './custom-field/field-bitmap-u8g2';
import './custom-field/field-image';
import './custom-field/field-image-preview';
import './custom-field/field-led-matrix';
import './custom-field/field-led-pattern-selector';
import './custom-field/field-tone';
import './custom-field/field-multilineinput';
import './custom-field/field-slider';
import './custom-field/field-angle180';
import './custom-field/field-angle';
import '@blockly/field-colour-hsv-sliders';

import { Multiselect } from './plugins/workspace-multiselect/index.js';
import { PromptDialogComponent } from './components/prompt-dialog/prompt-dialog.component.js';
import { NzModalModule, NzModalService } from 'ng-zorro-antd/modal';
import { NzResizableModule, NzResizeEvent } from 'ng-zorro-antd/resizable';
import * as BlockDynamicConnection from '@blockly/block-dynamic-connection';
import { CommonModule } from '@angular/common';
import { BitmapUploadService } from '../../services/bitmap-upload.service';
import { ImageUploadDialogComponent } from './components/image-upload-dialog/image-upload-dialog.component';
import { HttpErrorResponse } from '@angular/common/http';
import { ConfigService } from '../../../../services/config.service';
import { NoticeService } from '../../../../services/notice.service';
import { CmdService } from '../../../../services/cmd.service';
import { ProjectService } from '../../../../services/project.service';
import { ElectronService } from '../../../../services/electron.service';
import { CrossPlatformCmdService } from '../../../../services/cross-platform-cmd.service';
import { PasteInstallDialogComponent, MissingLibInfo } from '../paste-install-dialog/paste-install-dialog.component';
import { Minimap } from '@blockly/workspace-minimap';
import {
  BLOCKLY_GRID_COLOUR_DARK,
  DarkTheme,
  LightTheme,
  blocklyGridColourForUiTheme,
} from './theme.config';
import type { ThemeMode } from '../../../../services/theme.service';
import { ThemeService } from '../../../../services/theme.service';
import { PlatformService } from '../../../../services/platform.service';
import { applyWindowsBlocklyScrollbarThickness } from '../../utils/apply-windows-blockly-scrollbar-thickness';
import { BlocklyToolboxPaneComponent } from './components/blockly-toolbox-pane/blockly-toolbox-pane.component';
import { BlocklyWorkspacePagesComponent } from './components/blockly-workspace-pages/blockly-workspace-pages.component';
import { CodeViewerIpcService } from '../../services/code-viewer-ipc.service';

/** Flyout 图钉右侧额外留白：Blockly 垂直条在 injectionDiv；vScroll 不可见时 DOM 仍可能有宽度，需一并判断 */
function flyoutPinRightExtraX(
  flyWs: Blockly.WorkspaceSvg,
  svg: SVGSVGElement,
  inject: HTMLElement | null,
  gapPx: number,
): number {
  const vScroll = (flyWs as unknown as { scrollbar?: { vScroll?: { isVisible?: () => boolean } } })
    .scrollbar?.vScroll;
  if (vScroll?.isVisible && !vScroll.isVisible()) return gapPx;

  const bar =
    inject?.querySelector<SVGGElement>('.blocklyFlyoutScrollbar .blocklyScrollbarVertical') ??
    inject?.querySelector<SVGGElement>('.blocklyScrollbarVertical') ??
    svg.querySelector<SVGGElement>('.blocklyScrollbarVertical');
  if (!bar) return gapPx;

  const cs = getComputedStyle(bar);
  if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) <= 0) {
    return gapPx;
  }

  const r = bar.getBoundingClientRect();
  let bw = 0;
  let bh = 0;
  try {
    const b = bar.getBBox();
    bw = b.width;
    bh = b.height;
  } catch {
    /* ignore */
  }
  const h = Math.max(r.height, bh);
  const w = Math.max(r.width, bw);
  if (!Number.isFinite(h + w) || h <= 0.5 || w <= 0.5) return gapPx;
  return gapPx + w;
}

class OverlayFlyoutMetricsManager extends (Blockly as any).MetricsManager {
  constructor(workspace: any) {
    super(workspace);
  }

  getViewMetrics(getWorkspaceCoordinates: boolean | undefined = undefined) {
    const workspace = (this as any).workspace_;
    const scale = getWorkspaceCoordinates ? workspace.scale : 1;
    const svgMetrics = (this as any).getSvgMetrics();
    const toolboxMetrics = (this as any).getToolboxMetrics();
    const toolboxPosition = toolboxMetrics.position;
    const useExternalToolbox = !!workspace.options?.externalToolboxHost;

    if (workspace.getToolbox?.() && !useExternalToolbox) {
      if (
        toolboxPosition == (Blockly as any).TOOLBOX_AT_TOP ||
        toolboxPosition == (Blockly as any).TOOLBOX_AT_BOTTOM
      ) {
        svgMetrics.height -= toolboxMetrics.height;
      } else if (
        toolboxPosition == (Blockly as any).TOOLBOX_AT_LEFT ||
        toolboxPosition == (Blockly as any).TOOLBOX_AT_RIGHT
      ) {
        svgMetrics.width -= toolboxMetrics.width;
      }
    }

    return {
      height: svgMetrics.height / scale,
      width: svgMetrics.width / scale,
      top: -workspace.scrollY / scale,
      left: -workspace.scrollX / scale,
    };
  }

  getAbsoluteMetrics() {
    const workspace = (this as any).workspace_;
    const toolboxMetrics = (this as any).getToolboxMetrics();
    const toolboxPosition = toolboxMetrics.position;
    const useExternalToolbox = !!workspace.options?.externalToolboxHost;

    let absoluteLeft = 0;
    if (!useExternalToolbox && workspace.getToolbox?.() && toolboxPosition == (Blockly as any).TOOLBOX_AT_LEFT) {
      absoluteLeft = toolboxMetrics.width;
    }

    let absoluteTop = 0;
    if (!useExternalToolbox && workspace.getToolbox?.() && toolboxPosition == (Blockly as any).TOOLBOX_AT_TOP) {
      absoluteTop = toolboxMetrics.height;
    }

    return {
      top: absoluteTop,
      left: absoluteLeft,
    };
  }
}

class ExternalToolboxDeleteArea extends Blockly.DeleteArea {
  override id = 'ailyExternalToolboxDeleteArea';

  constructor(private readonly getHostElement: () => HTMLElement | null) {
    super();
  }

  override getClientRect(): Blockly.utils.Rect | null {
    const hostElement = this.getHostElement();
    if (!hostElement) {
      return null;
    }

    const rect = hostElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return null;
    }

    return new Blockly.utils.Rect(rect.top, rect.bottom, rect.left, rect.right);
  }
}

@Component({
  selector: 'blockly-main',
  imports: [
    NzModalModule,
    NzResizableModule,
    CommonModule,
    BlocklyToolboxPaneComponent,
    BlocklyWorkspacePagesComponent,
  ],
  templateUrl: './blockly.component.html',
  styleUrl: './blockly.component.scss',
})
export class BlocklyComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild(BlocklyWorkspacePagesComponent, { static: true }) workspacePaneComponent!: BlocklyWorkspacePagesComponent;
  @ViewChild('layoutElement', { static: true }) private layoutElementRef!: ElementRef<HTMLDivElement>;
  @ViewChild('toolboxPane', { static: true }) private toolboxPaneRef!: ElementRef<HTMLDivElement>;
  @Output() libraryManagerRequested = new EventEmitter<void>();

  readonly toolboxMinWidth = 160;
  readonly toolboxMaxWidth = 420;
  toolboxWidth = 185;
  private pendingToolboxWidth = this.toolboxWidth;
  private toolboxResizeAnimationFrame: number | null = null;
  private workspaceResizeAnimationFrame: number | null = null;
  private isToolboxResizing = false;

  @Input() devmode;
  generator;

  // RxJS debounce optimization
  private codeGenerationSubject = new Subject<void>();
  private minimapSyncSubject = new Subject<void>();
  private destroy$ = new Subject<void>();
  private resizeObserver: ResizeObserver | null = null;
  private minimap: Minimap | null = null;
  /** Flyout 右上角固钉控件（foreignObject 根节点，便于挂在嵌套 SVG 内） */
  private flyoutPinForeignObject: SVGForeignObjectElement | null = null;
  private flyoutPinResizeObserver: ResizeObserver | null = null;
  private flyoutPinButton: HTMLButtonElement | null = null;
  private externalToolboxDeleteArea: ExternalToolboxDeleteArea | null = null;
  private readonly onWorkspacePointerDownBound = (event: PointerEvent) => this.onWorkspacePointerDown(event);
  // Track previous #include and #define for dependency change detection
  private previousDependencies = '';
  // Control bitmap upload handler visibility
  showBitmapUploadHandler = true;

  aiWriting = false;
  showSpinOverlay = false;
  isFadingOut = false;
  private fadeOutTimer: any = null;

  get workspace() {
    return this.blocklyService.workspace;
  }

  set workspace(workspace) {
    this.blocklyService.workspace = workspace;
  }

  get toolbox() {
    return this.blocklyService.toolbox;
  }

  set toolbox(toolbox) {
    this.blocklyService.toolbox = toolbox;
  }

  get draggingBlock() {
    return this.blocklyService.draggingBlock;
  }

  set draggingBlock(draggingBlock: any) {
    this.blocklyService.draggingBlock = draggingBlock;
  }

  get offsetX() {
    return this.blocklyService.offsetX;
  }

  get offsetY() {
    return this.blocklyService.offsetY;
  }

  get pages() {
    return this.blocklyService.getPages();
  }

  get activePageId() {
    return this.blocklyService.getActivePageId();
  }

  get closedPages() {
    return this.blocklyService.getClosedPages();
  }

  options = {
    externalToolboxHost: true,
    flyout: 'overlay',
    toolbox: {
      kind: 'categoryToolbox',
      contents: [],
    },
    // plugins: {
    //   toolbox: ContinuousToolbox,
    //   flyoutsVerticalToolbox: ContinuousFlyout,
    //   metricsManager: ContinuousMetrics,
    // },
    // theme: Blockly.Theme.defineTheme('zelos', DEV_THEME),
    theme: DarkTheme,
    renderer: 'thrasos',
    trashcan: true,
    grid: {
      spacing: 20, // 网格间距为20像素
      length: 2, // 网格点的大小
      colour: BLOCKLY_GRID_COLOUR_DARK,
      snap: true,
    },
    media: 'blockly/media',
    zoom: {
      controls: false,  // 不显示缩放控制按钮
      wheel: true,      // 启用鼠标滚轮缩放
      startScale: 1,  // 初始缩放比例
      maxScale: 1.5,      // 最大缩放比例
      minScale: 0.5,    // 最小缩放比例
      scaleSpeed: 1.05,  // 缩放速度
    },
    multiselectIcon: {
      hideIcon: true
    },
    multiSelectKeys: ['Shift'],
    plugins: {
      metricsManager: OverlayFlyoutMetricsManager,
      connectionPreviewer:
        BlockDynamicConnection.decoratePreviewer(
          Blockly.InsertionMarkerPreviewer,
        ),
    },
  }

  get configData() {
    return this.configService.data;
  }

  constructor(
    private blocklyService: BlocklyService,
    private modal: NzModalService,
    private configService: ConfigService,
    private bitmapUploadService: BitmapUploadService,
    private noticeService: NoticeService,
    private translateService: TranslateService,
    private cdr: ChangeDetectorRef,
    private cmdService: CmdService,
    private projectService: ProjectService,
    private electronService: ElectronService,
    private crossPlatformCmdService: CrossPlatformCmdService,
    private themeService: ThemeService,
    private platformService: PlatformService,
    private codeViewerIpcService: CodeViewerIpcService,
  ) {
    // Initialize GlobalServiceManager with BitmapUploadService
    const globalServiceManager = GlobalServiceManager.getInstance();
    globalServiceManager.setBitmapUploadService(this.bitmapUploadService);

    // 订阅语言变化事件
    this.translateService.onLangChange
      .pipe(takeUntil(this.destroy$))
      .subscribe((event) => {
        this.updateBlocklyLocale(event.lang);
        this.updateFlyoutPinButton();
      });

    // 订阅配置重载，实时应用 flyoutAutoClose 等 blockly 配置
    this.configService.configReloaded$
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => this.applyFlyoutAutoClose());

    // 监听主题变化，动态切换 Blockly 主题与网格颜色
    effect(() => {
      const mode = this.themeService.theme();
      if (this.workspace) {
        this.workspace.setTheme(mode === 'light' ? LightTheme : DarkTheme);
        this.applyBlocklyGridColour(mode);
      }
    });
  }

  ngOnInit(): void {
    this.initAiWritingSubscription();
    this.initDevMode();
    this.initPrompt();
    this.initCodeGenerationDebounce();
    this.initMinimapSyncDebounce();
    this.bitmapUploadService.uploadRequestSubject.subscribe((request) => {
      const modalRef = this.modal.create({
        nzTitle: null,
        nzFooter: null,
        nzClosable: false,
        nzBodyStyle: {
          padding: '0',
        },
        nzContent: ImageUploadDialogComponent,
        nzData: {
          request: request
        },
        nzWidth: '650px',
      });      // 处理弹窗关闭事件
      modalRef.afterClose.subscribe((result) => {
        if (result && result.bitmapArray) {
          console.log('接收到处理后的bitmap数据:', result);
          // 发送处理结果回field
          const response: BitmapUploadResponse = {
            fieldId: request.fieldId,  // 添加字段ID
            data: result,
            success: true,
            // message: '图片处理成功',
            // timestamp: Date.now()
          };

          this.bitmapUploadService.sendUploadResponse(response);
        }
      });
    });
  }

  ngOnDestroy(): void {
    this.removeFlyoutPinControl();
    this.unregisterExternalToolboxDeleteArea();
    this.cancelToolboxResizeAnimationFrame();
    this.cancelWorkspaceResizeAnimationFrame();
    this.workspacePaneComponent?.blocklyHostElement?.removeEventListener('pointerdown', this.onWorkspacePointerDownBound, true);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    // 清理 RxJS 订阅
    this.destroy$.next();
    this.destroy$.complete();
  }

  onPageSelected(pageId: string) {
    if (!pageId || !this.workspace) {
      return;
    }

    this.workspace.hideChaff();
    if (this.blocklyService.switchPage(pageId)) {
      this.syncWorkspaceAfterPageChange();
    }
  }

  onPageAdded() {
    this.workspace?.hideChaff();
    this.blocklyService.createPage();
    this.syncWorkspaceAfterPageChange();
  }

  onPageClosed(pageId: string) {
    if (!pageId) {
      return;
    }

    this.workspace?.hideChaff();
    this.blocklyService.closePage(pageId);
    this.syncWorkspaceAfterPageChange();
  }

  onPageReopened(pageId: string) {
    if (!pageId) {
      return;
    }

    this.workspace?.hideChaff();
    if (this.blocklyService.openPage(pageId, true)) {
      this.syncWorkspaceAfterPageChange();
    }
  }

  onToolboxResizeStart(): void {
    this.isToolboxResizing = true;
  }

  onToolboxResize({ width }: NzResizeEvent): void {
    this.queueToolboxWidth(width);
  }

  onToolboxResizeEnd({ width }: NzResizeEvent): void {
    this.flushToolboxWidth(width);
    this.isToolboxResizing = false;
  }

  private queueToolboxWidth(width: number | undefined): void {
    if (typeof width !== 'number' || !Number.isFinite(width)) {
      return;
    }

    this.pendingToolboxWidth = this.clampToolboxWidth(width);
    if (this.toolboxResizeAnimationFrame !== null) {
      return;
    }

    this.toolboxResizeAnimationFrame = requestAnimationFrame(() => {
      this.toolboxResizeAnimationFrame = null;
      this.applyQueuedToolboxWidth();
    });
  }

  private flushToolboxWidth(width: number | undefined): void {
    if (typeof width === 'number' && Number.isFinite(width)) {
      this.pendingToolboxWidth = this.clampToolboxWidth(width);
    }

    this.cancelToolboxResizeAnimationFrame();
    this.applyQueuedToolboxWidth();
  }

  private applyQueuedToolboxWidth(): void {
    const nextWidth = this.pendingToolboxWidth;
    if (nextWidth === this.toolboxWidth) {
      return;
    }

    this.toolboxWidth = nextWidth;
    this.applyToolboxWidth(nextWidth);
    this.resizeWorkspace();
  }

  private applyToolboxWidth(width: number): void {
    const widthPx = `${width}px`;
    this.layoutElementRef.nativeElement.style.setProperty('grid-template-columns', `${widthPx} minmax(0, 1fr)`);
    this.toolboxPaneRef.nativeElement.style.setProperty('width', widthPx);
  }

  private clampToolboxWidth(width: number): number {
    return Math.min(this.toolboxMaxWidth, Math.max(this.toolboxMinWidth, Math.round(width)));
  }

  private scheduleWorkspaceResize(): void {
    if (!this.workspace || this.workspaceResizeAnimationFrame !== null) {
      return;
    }

    this.workspaceResizeAnimationFrame = requestAnimationFrame(() => {
      this.workspaceResizeAnimationFrame = null;
      this.resizeWorkspace();
    });
  }

  private resizeWorkspace(): void {
    if (this.workspace) {
      Blockly.svgResize(this.workspace);
      this.workspace.recordDragTargets();
    }
  }

  private cancelToolboxResizeAnimationFrame(): void {
    if (this.toolboxResizeAnimationFrame === null) {
      return;
    }

    cancelAnimationFrame(this.toolboxResizeAnimationFrame);
    this.toolboxResizeAnimationFrame = null;
  }

  private cancelWorkspaceResizeAnimationFrame(): void {
    if (this.workspaceResizeAnimationFrame === null) {
      return;
    }

    cancelAnimationFrame(this.workspaceResizeAnimationFrame);
    this.workspaceResizeAnimationFrame = null;
  }

  private initAiWritingSubscription(): void {
    combineLatest([
      this.blocklyService.aiWriting$,
      this.blocklyService.aiWaiting$
    ]).pipe(
      map(([writing, waiting]) => writing || waiting),
      distinctUntilChanged(),
      startWith(false),
      pairwise(),
      takeUntil(this.destroy$)
    ).subscribe(([prev, curr]) => {
      this.aiWriting = curr;
      if (!prev && curr) {
        if (this.fadeOutTimer) {
          clearTimeout(this.fadeOutTimer);
          this.fadeOutTimer = null;
        }
        this.isFadingOut = false;
        this.showSpinOverlay = true;
      } else if (prev && !curr) {
        this.isFadingOut = true;
        this.fadeOutTimer = setTimeout(() => {
          this.showSpinOverlay = false;
          this.isFadingOut = false;
          this.fadeOutTimer = null;
          this.cdr.markForCheck();
        }, 300);
      }
      this.cdr.markForCheck();
    });
  }

  ngAfterViewInit(): void {
    // this.blocklyService.init();
    setTimeout(async () => {
      // 禁用blockly的警告
      console.warn = (function (originalWarn) {
        return function (msg) {
          // 过滤掉块重定义的警告
          if (msg.includes('overwrites previous definition')) {
            return;
          }
          if (msg.includes('CodeGenerator init was not called before blockToCode was called.')) {
            return;
          }
          // 保留其他警告
          originalWarn.apply(console, arguments);
        };
      })(console.warn);
      // 添加递归保护标志，防止无限递归调用
      let isHandlingError = false;
      console.error = ((originalError) => {
        return (message, ...args) => {
          // 防止递归调用
          if (isHandlingError) {
            originalError.apply(console, [message, ...args]);
            return;
          }

          isHandlingError = true;
          try {
            console.log(message, ...args);
            if (!message) {
              return
            }

            // 保留原始错误输出功能
            originalError.apply(console, arguments);
            // 处理特定错误
            if (args[0] instanceof HttpErrorResponse) {
              // console.log('HTTP错误:', args[0]);
              return;
            }
            let errorMessage = message + '   ' + args.join('\n');

            // 常见错误1：Invalid block definition
            let title = message;
            let text = args.join('\n');
            if (errorMessage.includes('Invalid block definition')) {
              title = '无效的块定义';
            }
            if (errorMessage.includes('Invalid default type')) {
              title = '无效的默认类型';
            }
            if (text.startsWith("TypeError: ")) {
              text = text.substring("TypeError: ".length);
            }
            this.noticeService.update({
              title,
              text,
              detail: errorMessage,
              state: 'error',
              setTimeout: 99000,
            });
          } finally {
            isHandlingError = false;
          }
        };
      })(console.error);

      // 根据当前语言设置 Blockly locale
      const currentLang = this.translateService.currentLang || 'zh_cn';
      const locale = BLOCKLY_LOCALES[currentLang] || BLOCKLY_LOCALES['en'] || zhHans;
      Blockly.setLocale(locale);

      // 在工作区创建前设置 block registry 拦截
      this.setupBlockRegistryInterception();
      // 获取当前blockly渲染器
      this.options.renderer = this.configData.blockly.renderer ? ('aily-' + this.configData.blockly.renderer) : 'thrasos';

      // 根据当前主题设置 Blockly 主题与网格颜色（浅色 #ddd / 深色 #393939，见 theme.config）
      const currentTheme = this.themeService.theme();
      this.options.theme = currentTheme === 'light' ? LightTheme : DarkTheme;
      this.options.grid.colour = blocklyGridColourForUiTheme(currentTheme);

      applyWindowsBlocklyScrollbarThickness(this.platformService.isWindows());
      this.workspace = Blockly.inject(this.workspacePaneComponent.blocklyHostElement, this.options);
      this.workspacePaneComponent.blocklyHostElement.addEventListener('pointerdown', this.onWorkspacePointerDownBound, true);
      this.workspace.updateToolbox(this.toolbox);
      this.registerExternalToolboxDeleteArea();
      this.blocklyService.hydrateWorkspaceFromProjectState();
      this.blocklyService.syncToolboxFacadeWithWorkspace();
      // 根据配置决定 flyout 拖出 block 后是否自动关闭（配置重载时会通过 configReloaded$ 实时应用）
      this.applyFlyoutAutoClose();
      this.setupFlyoutPinControl(0);

      const multiselectPlugin = new Multiselect(this.workspace);
      multiselectPlugin.init(this.options);

      // 初始化跨实例复制粘贴的全局桥接
      (window as any).__ailyClipboard = window['clipboard'] || null;
      // 注册跨实例粘贴时缺失库的安装回调
      (window as any).__ailyBlockPasteNeedsInstall = (missingLibs: MissingLibInfo[]) => {
        // Filter to only installable libs (those with a name)
        const installableLibs = missingLibs.filter(l => l.name);
        if (installableLibs.length === 0) {
          // No installable libs info available, still resolve to attempt paste
          return Promise.resolve();
        }
        return new Promise<void>((resolve, reject) => {
          const modalRef = this.modal.create({
            nzTitle: null,
            nzFooter: null,
            nzClosable: false,
            nzBodyStyle: { padding: '0' },
            nzContent: PasteInstallDialogComponent,
            nzData: {
              missingLibs: installableLibs,
              installFn: async (libs: MissingLibInfo[]) => {
                const projectPath = this.projectService.currentProjectPath;
                if (!projectPath) throw new Error('No project path');
                // Separate local libs from npm libs
                const localLibs = libs.filter(l => l.localPath);
                const npmLibs = libs.filter(l => !l.localPath);
                // Handle local libs: copy source folder to current project then npm install from local path
                for (const lib of localLibs) {
                  // Extract the folder name from localPath (e.g. "lib-l298n" from "C:\...\lib-l298n")
                  const folderName = lib.localPath!.split(/[/\\]/).pop()!;
                  const destPath = this.electronService.pathJoin(projectPath, folderName);
                  if (lib.localPath !== destPath) {
                    if (this.electronService.exists(destPath)) {
                      await this.crossPlatformCmdService.removeItem(destPath, true, true);
                    }
                    await this.crossPlatformCmdService.copyItem(lib.localPath!, destPath, true, true);
                  }
                  const { code, stderr } = await this.cmdService.runAsync(
                    `npm install "${destPath}"`, projectPath
                  );
                  if (code !== 0) throw new Error(stderr || `Exit code: ${code}`);
                }
                // Handle npm libs: batch npm install
                if (npmLibs.length > 0) {
                  const pkgs = npmLibs.map(l => l.version ? `${l.name}@${l.version}` : l.name).join(' ');
                  const { code, stderr } = await this.cmdService.runAsync(
                    `npm install ${pkgs}`, projectPath
                  );
                  if (code !== 0) throw new Error(stderr || `Exit code: ${code}`);
                }
                // Load each newly installed library
                for (const lib of libs) {
                  await this.blocklyService.loadLibrary(lib.name, projectPath);
                }
              },
            },
            nzWidth: '450px',
          });
          modalRef.afterClose.subscribe((result: any) => {
            if (result?.result === 'installed') {
              resolve();
            } else {
              reject(new Error('cancelled'));
            }
          });
        });
      };

      if (this.configData.blockly.minimap) {
        this.minimap = new Minimap(this.workspace);
        this.minimap.init();
        // 禁用 minimap 内置的 mirror（Events.fromJson 重放会触发 custom field 的 "associated block is undefined"）
        // 仅使用 syncMinimap 的全量 XML 同步，避免 Events.fromJson 与 custom field 的兼容性问题
        (this.minimap as any).mirror = () => { };
        // 将 focus region 的 update 替换为空实现：mirror 禁用后 minimap 仅由 syncMinimap 更新，空内容时原 update 会算出 NaN 导致 translate(NaN,NaN)；disableFocusRegion 会留下未移除的 resize 监听导致 "must be initialized" 报错
        const fr = (this.minimap as any).focusRegion;
        if (fr) fr.update = () => { };
      }

      this.workspace.addChangeListener(BlockDynamicConnection.finalizeConnections);

      // 监听容器尺寸变化，刷新Blockly工作区
      this.resizeObserver = new ResizeObserver(() => {
        if (this.isToolboxResizing) {
          return;
        }

        this.scheduleWorkspaceResize();
      });
      this.resizeObserver.observe(this.workspacePaneComponent.blocklyHostElement);

      (window as any)['Blockly'] = Blockly;
      // 设置全局工作区引用，供 editBlockTool 使用
      (window as any)['blocklyWorkspace'] = this.workspace;
      this.workspace.addChangeListener((event: any) => {
        this.codeGenerationSubject.next();
        if (event.type !== Blockly.Events.SELECTED) {
          // 工作区变更时同步 Minimap（含 AI 批量修改 blocks 的场景）
          this.minimapSyncSubject.next();
        }

        if (event.type === Blockly.Events.TOOLBOX_ITEM_SELECT) {
          this.blocklyService.syncToolboxFacadeWithWorkspace();
        }

        // 监听 block 选中事件，更新 selectedBlockSubject
        if (event.type === Blockly.Events.SELECTED) {
          const selectedBlockId = event.newElementId || null;
          this.blocklyService.selectedBlockSubject.next(selectedBlockId);
          this.codeViewerIpcService.publishSelection(selectedBlockId);
        }
      });
      this.initLanguage();
    }, 100);
  }

  private syncWorkspaceAfterPageChange() {
    if (!this.workspace) {
      return;
    }

    setTimeout(() => {
      Blockly.svgResize(this.workspace);
      this.workspace.render();
      this.blocklyService.syncToolboxFacadeWithWorkspace();
      this.minimapSyncSubject.next();
      this.codeGenerationSubject.next();
    }, 0);
  }

  private onWorkspacePointerDown(event: PointerEvent) {
    const target = event.target as Element | null;
    if (!target || this.isPointerInsideFlyout(target)) {
      return;
    }

    if (target.closest('.blocklySvg')) {
      this.blocklyService.closeToolboxSearchFlyout();
    }
  }

  private isPointerInsideFlyout(target: Element): boolean {
    return !!target.closest(
      '.blocklyFlyout, .blocklyFlyoutScrollbar, .blocklyWidgetDiv, .blocklyDropDownDiv, .aily-flyout-pin-xhtml',
    );
  }

  private registerExternalToolboxDeleteArea(): void {
    if (!this.workspace) {
      return;
    }

    this.unregisterExternalToolboxDeleteArea(false);
    this.externalToolboxDeleteArea = new ExternalToolboxDeleteArea(() => this.toolboxPaneRef?.nativeElement ?? null);
    this.workspace.getComponentManager().addComponent({
      component: this.externalToolboxDeleteArea,
      capabilities: [
        Blockly.ComponentManager.Capability.DRAG_TARGET,
        Blockly.ComponentManager.Capability.DELETE_AREA,
      ],
      weight: 0,
    }, true);
    this.workspace.recordDragTargets();
  }

  private unregisterExternalToolboxDeleteArea(recordDragTargets = true): void {
    if (!this.workspace || !this.externalToolboxDeleteArea) {
      return;
    }

    try {
      this.workspace.getComponentManager().removeComponent(this.externalToolboxDeleteArea.id);
    } catch (error) {
      console.warn('[Blockly] Failed to unregister external toolbox delete area:', error);
    }
    this.externalToolboxDeleteArea = null;

    if (recordDragTargets) {
      this.workspace.recordDragTargets();
    }
  }

  /** 切换 UI 主题时同步 Blockly 网格 SVG 描边（inject 后需手动更新，见 Grid.createDom） */
  private applyBlocklyGridColour(mode: ThemeMode): void {
    const colour = blocklyGridColourForUiTheme(mode);
    this.options.grid.colour = colour;
    const ws = this.workspace;
    if (!ws) return;
    const grid = ws.getGrid();
    if (!grid) return;
    const pattern = (grid as unknown as { pattern: SVGPatternElement }).pattern;
    if (!pattern) return;
    pattern.querySelectorAll('line').forEach((line) => {
      line.setAttribute('stroke', colour);
    });
  }

  /** 根据配置应用 flyout 自动关闭，支持初始化及配置重载时实时生效 */
  private applyFlyoutAutoClose(): void {
    const ws = this.workspace;
    if (!ws?.getFlyout) return;
    const flyout = ws.getFlyout();
    if (!flyout) return;
    const autoClose = this.configData?.blockly?.flyoutAutoClose !== false;
    (flyout as any).autoClose = autoClose;
    if (!autoClose && !(flyout as any).__resizePatched) {
      (flyout as any).__resizePatched = true;
      const tryResize = () => setTimeout(() => Blockly.svgResize(ws), 0);
      const originalShow = (flyout as any).show?.bind(flyout);
      if (originalShow) {
        (flyout as any).show = (...args: any[]) => {
          const result = originalShow(...args);
          tryResize();
          return result;
        };
      }
      const originalHide = (flyout as any).hide?.bind(flyout);
      if (originalHide) {
        (flyout as any).hide = (...args: any[]) => {
          const result = originalHide(...args);
          tryResize();
          return result;
        };
      }
    }
    this.updateFlyoutPinButton();
  }

  /** 在工具箱 flyout 容器右上角挂载固钉，切换逻辑与配置项「自动关闭工具箱」一致 */
  private setupFlyoutPinControl(attempt = 0): void {
    const ws = this.workspace;
    if (!ws?.getFlyout) return;
    const flyout = ws.getFlyout() as Blockly.IFlyout & { __ailyFlyoutPinAttached?: boolean };
    if (!flyout || flyout.__ailyFlyoutPinAttached) return;

    const flyWs = flyout.getWorkspace?.();
    const svg = flyWs?.getParentSvg?.() ?? null;
    if (!svg) {
      if (attempt < 40) {
        setTimeout(() => this.setupFlyoutPinControl(attempt + 1), 50);
      }
      return;
    }

    flyout.__ailyFlyoutPinAttached = true;

    /** 悬浮角标尺寸；水平：PIN_INSET + 滚动条占位 + gap，垂直：PIN_INSET */
    const PIN_BOX = 20;
    const PIN_INSET = 6;
    const PIN_SCROLL_GAP = 0;

    const flyInjectDiv =
      ((flyWs as Blockly.WorkspaceSvg).getInjectionDiv?.() as HTMLElement | undefined) ?? null;

    const fo = document.createElementNS('http://www.w3.org/2000/svg', 'foreignObject');
    fo.classList.add('aily-flyout-pin-fo');
    fo.style.pointerEvents = 'none';
    fo.style.overflow = 'visible';
    fo.style.setProperty('background', 'transparent', 'important');
    fo.style.setProperty('background-color', 'transparent', 'important');

    const positionPinFo = () => {
      const sw = Math.max(1, svg.clientWidth || 0);
      const extraX = flyoutPinRightExtraX(flyWs as Blockly.WorkspaceSvg, svg, flyInjectDiv, PIN_SCROLL_GAP);
      const xEdge = PIN_INSET + extraX;
      const x = flyout.RTL ? xEdge : Math.max(xEdge, sw - PIN_BOX - xEdge);
      fo.setAttribute('x', String(x));
      fo.setAttribute('y', String(PIN_INSET));
      fo.setAttribute('width', String(PIN_BOX));
      fo.setAttribute('height', String(PIN_BOX));
    };
    positionPinFo();

    // 勿使用 <body>：foreignObject 内 body 常带浏览器默认白底，无法仅靠 background 覆盖
    const xmlns = 'http://www.w3.org/1999/xhtml';
    const root = document.createElementNS(xmlns, 'div');
    root.className = 'aily-flyout-pin-xhtml';
    root.style.setProperty('margin', '0');
    root.style.setProperty('padding', '0');
    root.style.setProperty('border', 'none');
    root.style.setProperty('outline', 'none');
    root.style.setProperty('box-sizing', 'border-box');
    root.style.setProperty('width', '100%');
    root.style.setProperty('height', '100%');
    root.style.setProperty('display', 'flex');
    root.style.setProperty('align-items', 'center');
    root.style.setProperty('justify-content', 'center');
    root.style.setProperty('pointer-events', 'none');
    root.style.setProperty('background', 'transparent', 'important');
    root.style.setProperty('background-color', 'transparent', 'important');

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'aily-flyout-pin';
    btn.style.pointerEvents = 'auto';
    btn.innerHTML =
      '<i class="fa-light fa-thumbtack aily-flyout-pin__icon" aria-hidden="true"></i>';
    root.appendChild(btn);
    fo.appendChild(root);
    svg.appendChild(fo);
    this.flyoutPinForeignObject = fo;
    this.flyoutPinButton = btn;

    this.flyoutPinResizeObserver = new ResizeObserver(() => positionPinFo());
    this.flyoutPinResizeObserver.observe(svg);
    if (flyInjectDiv) {
      this.flyoutPinResizeObserver.observe(flyInjectDiv);
    }

    const onPinClick = (e: MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      const f = this.workspace?.getFlyout() as Blockly.IFlyout | null;
      if (!f) return;
      if (!this.configData.blockly) {
        this.configData.blockly = {};
      }
      const wasPinned = f.autoClose === false;
      const nextPinned = !wasPinned;
      this.configData.blockly.flyoutAutoClose = !nextPinned;
      this.applyFlyoutAutoClose();
      void this.configService.save();
    };
    btn.addEventListener('click', onPinClick);
    btn.addEventListener('mousedown', (e) => e.stopPropagation());

    this.updateFlyoutPinButton();
  }

  private updateFlyoutPinButton(): void {
    const btn = this.flyoutPinButton;
    if (!btn) return;
    const flyout = this.workspace?.getFlyout() as Blockly.IFlyout | undefined;
    const pinned = flyout ? flyout.autoClose === false : false;
    btn.classList.toggle('aily-flyout-pin--active', pinned);
    btn.setAttribute('aria-pressed', String(pinned));
    btn.removeAttribute('title');
    btn.removeAttribute('aria-label');
  }

  private removeFlyoutPinControl(): void {
    this.flyoutPinResizeObserver?.disconnect();
    this.flyoutPinResizeObserver = null;
    if (this.flyoutPinForeignObject?.parentNode) {
      this.flyoutPinForeignObject.remove();
    }
    this.flyoutPinForeignObject = null;
    this.flyoutPinButton = null;
    const flyout = this.workspace?.getFlyout() as { __ailyFlyoutPinAttached?: boolean } | null;
    if (flyout) {
      delete flyout.__ailyFlyoutPinAttached;
    }
  }

  initDevMode() {
    console.log('DEV MODE: ', this.devmode);

    switch (this.devmode) {
      case 'arduino':
        window['Arduino'] = <any>arduinoGenerator;
        this.generator = arduinoGenerator;
        break;
      case 'micropython':
        window['MicropPython'] = <any>micropythonGenerator;
        window['MPY'] = <any>micropythonGenerator;
        this.generator = micropythonGenerator;
        break;
      default:
        break;
    }
  }

  initPrompt() {
    Blockly.dialog.setPrompt((message, defaultValue, callback) => {
      // console.log('对话框初始化，消息:', message, '默认值:', defaultValue);
      this.modal.create({
        nzTitle: null,
        nzFooter: null,
        nzClosable: false,
        nzBodyStyle: {
          padding: '0',
        },
        nzWidth: '300px',
        nzContent: PromptDialogComponent,
        nzOnOk: (e) => {
          callback(e.value);
        },
        nzOnCancel: () => {
          console.log('cancel');
        },
        nzData: {
          title: message
        }
      });
    });
  }

  initLanguage() {
    // 根据当前语言设置 Blockly locale
    const currentLang = this.translateService.currentLang || 'zh_cn';
    this.updateBlocklyLocale(currentLang);
  }

  /**
   * 更新 Blockly 的语言设置
   * @param lang 语言代码，如 'zh_cn', 'en' 等
   */
  updateBlocklyLocale(lang: string) {
    // 获取对应的 Blockly 语言包
    const locale = BLOCKLY_LOCALES[lang] || BLOCKLY_LOCALES['en'] || zhHans;

    // 设置 Blockly locale
    Blockly.setLocale(locale);

    // 设置自定义消息（覆盖或补充）
    Blockly.Msg["CROSS_TAB_COPY"] = this.translateService.instant('BLOCKLY.CROSS_TAB_COPY') || "复制到指定位置";
    Blockly.Msg["CROSS_TAB_PASTE"] = this.translateService.instant('BLOCKLY.CROSS_TAB_PASTE') || "Paste";
    Blockly.Msg["CROSS_TAB_PASTE_X_ELEMENTS"] = this.translateService.instant('BLOCKLY.CROSS_TAB_PASTE_X_ELEMENTS') || "Paste %1 items";
    Blockly.Msg["WORKSPACE_SELECT_ALL"] = this.translateService.instant('BLOCKLY.WORKSPACE_SELECT_ALL') || "Select all blocks";

    // 自定义扩展的多语言消息（switch-case 等）
    Blockly.Msg["CONTROLS_SWITCH_CASE"] = this.translateService.instant('BLOCKLY.CONTROLS_SWITCH_CASE') || (lang.startsWith('zh') ? "情况" : "case");
    Blockly.Msg["CONTROLS_SWITCH_DO"] = this.translateService.instant('BLOCKLY.CONTROLS_SWITCH_DO') || (lang.startsWith('zh') ? "执行" : "do");
    Blockly.Msg["CONTROLS_SWITCH_DEFAULT"] = this.translateService.instant('BLOCKLY.CONTROLS_SWITCH_DEFAULT') || (lang.startsWith('zh') ? "默认执行" : "default");

    // 如果工作区已存在，刷新工具箱以应用新语言
    if (this.workspace) {
      try {
        // 刷新工具箱
        this.workspace.refreshToolboxSelection();

        // 重新渲染所有块以更新显示文本
        const blocks = this.workspace.getAllBlocks(false);
        blocks.forEach((block: any) => {
          if (block.rendered) {
            block.initSvg();
            block.render();
          }
        });
      } catch (e) {
        console.warn('刷新 Blockly 工作区语言时出错:', e);
      }
    }
  }

  setupBlockRegistryInterception(): void {
    const originalGetClass = Blockly.registry.getClass;

    Blockly.registry.getClass = function (type: string, name: string, opt_throwIfMissing?: boolean) {

      // 对于未注册的 block，也可以在这里处理
      try {
        return originalGetClass.call(Blockly.registry, type, name, opt_throwIfMissing);
      } catch (error) {
        if (type === Blockly.registry.Type.name) {
          console.log(`Block 类型 "${name}" 未注册`);
          this.showBlockRestrictionMessage(name);
          return null;
        }
        throw error;
      }
    }.bind(this);
  }


  /**
   * 初始化 Minimap 同步防抖
   * 工作区变更时（含 AI 批量修改）同步更新 Minimap，避免小地图不刷新
   */
  private initMinimapSyncDebounce(): void {
    this.minimapSyncSubject.pipe(
      debounceTime(300),
      takeUntil(this.destroy$)
    ).subscribe(() => this.syncMinimap());
  }

  /**
   * 将主工作区状态全量同步到 Minimap
   * 使用 Xml 路径加载，避免 serialization.load 触发的 BLOCK_MOVE 事件导致 "block could not be found" 错误
   * 同步时禁用事件，避免 custom field 在反序列化时因 "associated block is undefined" 报错
   */
  private syncMinimap(): void {
    const m = this.minimap as any;
    if (!m?.minimapWorkspace || !this.workspace) return;
    const wasEnabled = Blockly.Events.isEnabled();
    try {
      Blockly.Events.disable();
      const xml = Blockly.Xml.workspaceToDom(this.workspace, true);
      m.minimapWorkspace.clear();
      Blockly.Xml.domToWorkspace(xml, m.minimapWorkspace);
      Blockly.renderManagement.finishQueuedRenders().then(() => {
        try {
          if (m?.minimapWorkspace) m.minimapWorkspace.zoomToFit();
        } catch (e) {
          console.warn('[Blockly] Minimap zoomToFit failed:', e);
        }
      }).catch((e) => {
        console.warn('[Blockly] Minimap render failed:', e);
      });
    } catch (e) {
      console.warn('[Blockly] Minimap sync failed:', e);
    } finally {
      if (wasEnabled) Blockly.Events.enable();
    }
  }

  /**
   * 初始化代码生成的防抖订阅
   * 使用 RxJS debounceTime 实现防抖，更优雅且自动管理订阅生命周期
   */
  private initCodeGenerationDebounce(): void {
    this.codeGenerationSubject.pipe(
      debounceTime(500),
      takeUntil(this.destroy$)
    ).subscribe(() => {
      try {
        const code = this.generator.workspaceToCode(this.workspace);
        this.blocklyService.codeSubject.next(code);
        let blockCodeMap = new Map<string, BlockCodeMapping>();

        // 发布 block-to-code 映射
        if (this.generator.blockCodeMap) {
          blockCodeMap = new Map(this.generator.blockCodeMap);
          this.blocklyService.blockCodeMapSubject.next(blockCodeMap);
          // 工作区变更后更新 ABS 行号映射（与用户下次导出 ABS 时的行号一致）
          this.updateAbsBlockLineMap();
        }

        this.codeViewerIpcService.publishCodeState(
          code,
          blockCodeMap,
          this.blocklyService.selectedBlockSubject.value,
        );

        // Extract #include and #define, check for changes
        const currentDependencies = this.extractDependencies(code);
        if (currentDependencies !== this.previousDependencies) {
          // console.log('currentDependencies: ', currentDependencies);
          this.blocklyService.dependencySubject.next(currentDependencies);
          this.previousDependencies = currentDependencies;
        }
      } catch (error) {
        console.error('Code generation error:', error);
        // 当代码生成失败时，输出更多诊断信息帮助定位缺失的生成器
        if (this.workspace && this.generator) {
          try {
            const allBlocks = this.workspace.getAllBlocks(false);
            const missingTypes = allBlocks
              .filter(b => b.isEnabled() && typeof this.generator.forBlock[b.type] !== 'function')
              .map(b => b.type);
            const uniqueMissing = [...new Set(missingTypes)];
            if (uniqueMissing.length > 0) {
              console.warn(
                `[Blockly] 以下块类型缺少代码生成器，可能需要重新加载对应的库：`,
                uniqueMissing
              );
            }
          } catch (_) { /* ignore diagnostic errors */ }
        }
      }
    });
  }

  /**
   * Extract #include and #define from code
   */
  private extractDependencies(code: string): string {
    const lines = code.split('\n');
    const dependencies = lines.filter(line => {
      const trimmed = line.trim();
      return trimmed.startsWith('#include') || trimmed.startsWith('#define');
    });
    return dependencies.join('\n');
  }

  /**
   * 更新 ABS block 行号映射
   * 工作区变更后调用，确保选中块时显示的 ABS 行号与实际导出一致
   */
  private updateAbsBlockLineMap(): void {
    try {
      const workspaceJson = Blockly.serialization.workspaces.save(this.workspace);
      const { blockLineMap } = convertAbiToAbsWithLineMap(workspaceJson, { includeHeader: true });
      this.blocklyService.absBlockLineMap.next(blockLineMap);
    } catch (e) {
      console.warn('[Blockly] Failed to update ABS block line map:', e);
    }
  }
}
