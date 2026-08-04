import { AfterViewInit, ChangeDetectorRef, Component, ElementRef, EventEmitter, Input, OnDestroy, OnInit, Output, ViewChild, effect } from '@angular/core';
import * as Blockly from 'blockly';
import { Subject, combineLatest } from 'rxjs';

import { debounceTime, takeUntil, map, distinctUntilChanged, pairwise, startWith } from 'rxjs/operators';
import { TranslateService } from '@ngx-translate/core';
import { UiService } from '../../../../services/ui.service';
import { AuthService } from '../../../../services/auth.service';
import { NzMessageService } from 'ng-zorro-antd/message';

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
import {
  normalizeArduinoGeneratedCode,
  type BlockCodeMapping,
} from './generators/arduino/arduino';
import { BlocklyService, WorkspaceBlockSearchState } from '../../services/blockly.service';
import {
  BlocklyGeneratorRuntimeService,
  runWithPreparedActiveProjectGenerator,
} from '../../services/blockly-generator-runtime.service';
import { BitmapUploadResponse, GlobalServiceManager } from '../../services/bitmap-upload.service';
import { projectDataRuntime } from '../../../../services/project-data/project-data-runtime';

import './renderer/aily-icon';
import './renderer/aily-thrasos/thrasos';
import './renderer/aily-zelos/zelos';
import './custom-category';
import './custom-field/field-bitmap';
import './custom-field/field-u8g2-bitmap';
import { setU8g2AnimationFieldTranslator } from './custom-field/field-u8g2-animation';
import { setTftEsPiAnimationFieldTranslator } from './custom-field/field-tftespi-animation';
import { setTftEsPiImageFieldTranslator } from './custom-field/field-tftespi-image';
import { registerMediaFieldEditorStyles } from './custom-field/field-media-editor-style';
import './custom-field/field-image';
import './custom-field/field-image-preview';
import './custom-field/field-led-matrix';
import './custom-field/field-led-matrix-image';
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
import { BlocklyConfirmDialogComponent } from './components/confirm-dialog/confirm-dialog.component';
import { CodeViewerIpcService } from '../../services/code-viewer-ipc.service';
import { writeArduinoGeneratedArtifacts } from '../../services/generated-code-artifacts';
import {
  createEmptyProjectDebugConfigurationState,
  getProjectBreakpointMarkerState,
  ProjectBlockBreakpointIntent,
  ProjectDebugConfigurationService,
  ProjectDebugConfigurationState,
} from '../../../../services/project-debug-configuration.service';

type BlocklyWorkspaceEvent = { type?: string } | null | undefined;

const PROJECT_BREAKPOINT_CONTEXT_MENU_IDS = [
  'ailyProjectBreakpointAddOrRebind',
  'ailyProjectBreakpointToggle',
  'ailyProjectBreakpointRemove',
] as const;
const PROJECT_DEBUG_CONFIGURATION_MUTATION_EVENT =
  'aily_project_debug_configuration_mutation';
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

class ProjectDebugConfigurationMutationEvent
  extends Blockly.Events.Abstract {
  override isBlank = false;
  override type = PROJECT_DEBUG_CONFIGURATION_MUTATION_EVENT;

  constructor(
    workspaceId: string,
    private readonly applyMutation: () => void,
    private readonly revertMutation: () => void,
  ) {
    super();
    this.workspaceId = workspaceId;
    this.recordUndo = true;
  }

  override run(forward: boolean): void {
    try {
      (forward ? this.applyMutation : this.revertMutation)();
    } catch (error) {
      console.warn(
        '[Blockly] Failed to replay project breakpoint mutation:',
        error,
      );
    }
  }
}

// 全局关闭 Blockly 文本输入字段的拼写检查，避免 block 内 input 出现红色波浪线
(Blockly.FieldTextInput.prototype as unknown as { spellcheck_: boolean }).spellcheck_ = false;
registerMediaFieldEditorStyles();

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
  @ViewChild('workspaceSearchInput') private workspaceSearchInputRef?: ElementRef<HTMLInputElement>;
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
  get generator(): any {
    return this.generatorRuntime.getActiveGenerator();
  }

  // RxJS debounce optimization
  private codeGenerationSubject = new Subject<void>();
  private minimapSyncSubject = new Subject<void>();
  private destroy$ = new Subject<void>();
  private resizeObserver: ResizeObserver | null = null;
  private minimap: Minimap | null = null;
  private minimapDirtyVersion = 0;
  private minimapSyncedVersion = 0;
  private minimapSyncInProgress = false;
  private minimapSyncQueued = false;
  private readonly codeGenerationEventTypes = new Set([
    'create',
    'delete',
    'change',
    'move',
    'var_create',
    'var_delete',
    'var_rename',
  ]);
  private readonly minimapSyncEventTypes = new Set([
    'finished_loading',
    'create',
    'delete',
    'change',
    'move',
    'comment_create',
    'comment_delete',
    'comment_change',
    'comment_move',
  ]);
  /** Flyout 右上角固钉控件（foreignObject 根节点，便于挂在嵌套 SVG 内） */
  private flyoutPinForeignObject: SVGForeignObjectElement | null = null;
  private flyoutPinResizeObserver: ResizeObserver | null = null;
  private flyoutPinPositionAnimationFrame: number | null = null;
  private flyoutPinButton: HTMLButtonElement | null = null;
  private externalToolboxDeleteArea: ExternalToolboxDeleteArea | null = null;
  private readonly onWorkspacePointerDownBound = (event: PointerEvent) => this.onWorkspacePointerDown(event);
  private readonly onDocumentKeyDownBound = (event: KeyboardEvent) => this.onDocumentKeyDown(event);
  private workspaceSearchHighlightedPaths = new Set<SVGElement>();
  private projectDebugState: ProjectDebugConfigurationState =
    createEmptyProjectDebugConfigurationState();
  private projectBreakpointMarkerSyncQueued = false;
  private readonly projectBreakpointMarkers =
    new Map<string, SVGGElement>();
  private debugExecutionMarkerSyncQueued = false;
  private debugExecutionMarkerRoot: SVGElement | null = null;
  private lastCenteredDebugExecutionBlockId = '';
  // Track previous #include and #define for dependency change detection
  private previousDependencies = '';
  // Control bitmap upload handler visibility
  showBitmapUploadHandler = true;

  aiWriting = false;
  showSpinOverlay = false;
  isFadingOut = false;
  workspaceSearchState: WorkspaceBlockSearchState = {
    isOpen: false,
    query: '',
    results: [],
    currentIndex: -1,
  };
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

  get workspaceSearchHasResults(): boolean {
    return this.workspaceSearchState.results.length > 0;
  }

  get workspaceSearchResultLabel(): string {
    if (!this.workspaceSearchHasResults) {
      return '0/0';
    }

    return `${this.workspaceSearchState.currentIndex + 1}/${this.workspaceSearchState.results.length}`;
  }

  options = {
    externalToolboxHost: true,
    flyout: 'overlay',
    toolbox: {
      kind: 'categoryToolbox',
      contents: [],
    },
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
    private uiService: UiService,
    private authService: AuthService,
    private message: NzMessageService,
    private generatorRuntime: BlocklyGeneratorRuntimeService,
    private projectDebugConfigurationService:
      ProjectDebugConfigurationService,
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
        this.workspace.setTheme(this.blocklyThemeForMode(mode));
        this.applyBlocklyGridColour(mode);
      }
      this.applyMinimapTheme(mode);
    });
  }

  ngOnInit(): void {
    this.initAiWritingSubscription();
    this.initDevMode();
    this.initBlocklyDialogs();
    this.initCodeGenerationDebounce();
    this.initMinimapSyncDebounce();
    this.initCodeViewerRefreshRequests();
    this.initWorkspaceBlockSearchSubscription();
    this.initProjectDebugConfigurationSubscription();
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
    document.removeEventListener('keydown', this.onDocumentKeyDownBound, true);
    this.closeWorkspaceBlockSearch();
    this.removeFlyoutPinControl();
    this.unregisterExternalToolboxDeleteArea();
    this.unregisterProjectBreakpointContextMenus();
    this.clearProjectBreakpointMarkers();
    this.clearDebugExecutionMarker();
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
    // 与旧版 Angular 一致：遮罩只在 aiWriting（积木工具执行）或短暂 aiWaitWriting 时显示，
    // 不随整轮 request/aiWaiting 常亮。
    combineLatest([
      this.blocklyService.aiWriting$,
      this.blocklyService.aiWaitWriting$
    ]).pipe(
      map(([writing, waitWriting]) => writing || waitWriting),
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
    document.addEventListener('keydown', this.onDocumentKeyDownBound, true);
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
      this.updateBlocklyLocale(currentLang);

      // 在工作区创建前设置 block registry 拦截
      this.setupBlockRegistryInterception();
      // 获取当前blockly渲染器
      this.options.renderer = this.configData.blockly.renderer ? ('aily-' + this.configData.blockly.renderer) : 'thrasos';

      // 根据当前主题设置 Blockly 主题与网格颜色（浅色 #ddd / 深色 #393939，见 theme.config）
      const currentTheme = this.themeService.theme();
      this.options.theme = this.blocklyThemeForMode(currentTheme);
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
      this.registerBlockExplainContextMenu();
      this.registerProjectBreakpointContextMenus();

      // 初始化跨实例复制粘贴的全局桥接
      (window as any).__ailyClipboard = window['clipboard'] || null;
      (window as any).__ailyProjectDataClipboard = {
        export: (value: unknown) => projectDataRuntime.exportClipboardBundle(value),
        import: (bundle: unknown, requiredValue: unknown) => (
          projectDataRuntime.importClipboardBundle(bundle, requiredValue)
        ),
      };
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
        this.applyMinimapTheme(currentTheme);
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
        this.handleProjectBreakpointWorkspaceEvent(event);
        this.requestCodeGeneration(event);
        // 工作区变更时同步 Minimap（含 AI 批量修改 blocks 的场景）
        this.requestMinimapSync(event);
        this.refreshWorkspaceBlockSearchForEvent(event);

        if (event.type === Blockly.Events.TOOLBOX_ITEM_SELECT) {
          this.blocklyService.syncToolboxFacadeWithWorkspace();
        }

        // 监听 block 选中事件，更新 selectedBlockSubject / selectedBlockIdsSubject
        if (event.type === Blockly.Events.SELECTED) {
          const selectedBlockId = event.newElementId || null;
          if (selectedBlockId) {
            this.projectDebugConfigurationService.rememberSelectedDebugTarget(
              this.projectService.currentProjectPath,
              selectedBlockId,
            );
          }
          this.blocklyService.selectedBlockSubject.next(selectedBlockId);
          queueMicrotask(() => {
            this.blocklyService.syncSelectedBlocksFromWorkspace();
            this.codeViewerIpcService.publishSelection(this.blocklyService.selectedBlockSubject.value);
          });
        }
      });
      if (this.configData.blockly.minimap && this.minimap) {
        queueMicrotask(() => this.requestMinimapSync());
      }
      this.queueProjectBreakpointMarkerSync();
      this.queueDebugExecutionMarkerSync();
      this.initLanguage();
    }, 100);
  }

  private syncWorkspaceAfterPageChange() {
    if (!this.workspace) {
      return;
    }

    this.closeWorkspaceBlockSearch();

    setTimeout(() => {
      Blockly.svgResize(this.workspace);
      this.workspace.render();
      this.queueProjectBreakpointMarkerSync();
      this.queueDebugExecutionMarkerSync();
      this.blocklyService.syncToolboxFacadeWithWorkspace();
      this.requestMinimapSync();
      this.requestCodeGeneration();
    }, 0);
  }

  onWorkspaceSearchQueryChange(query: string): void {
    this.blocklyService.setWorkspaceBlockSearchQuery(query);
  }

  onWorkspaceSearchNext(): void {
    this.blocklyService.selectNextWorkspaceBlockSearchResult();
  }

  onWorkspaceSearchPrevious(): void {
    this.blocklyService.selectPreviousWorkspaceBlockSearchResult();
  }

  closeWorkspaceBlockSearch(): void {
    this.clearWorkspaceSearchHighlight();
    this.blocklyService.closeWorkspaceBlockSearch();
  }

  private initWorkspaceBlockSearchSubscription(): void {
    this.workspaceSearchState = this.blocklyService.workspaceBlockSearchSubject.value;

    this.blocklyService.workspaceBlockSearchSubject
      .pipe(takeUntil(this.destroy$))
      .subscribe((state) => {
        const wasOpen = this.workspaceSearchState.isOpen;
        this.workspaceSearchState = state;
        if (!state.isOpen) {
          this.clearWorkspaceSearchHighlight();
        } else {
          this.updateWorkspaceSearchHighlights(state);
        }
        this.cdr.markForCheck();
        if (!wasOpen && state.isOpen) {
          setTimeout(() => this.focusWorkspaceSearchInput(true), 0);
        }
      });

    this.blocklyService.blockCodeMapSubject
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => {
        const state = this.blocklyService.workspaceBlockSearchSubject.value;
        if (state.isOpen && state.query.trim()) {
          this.blocklyService.refreshWorkspaceBlockSearch();
        }
      });
  }

  private onDocumentKeyDown(event: KeyboardEvent): void {
    if (!this.isWorkspaceSearchShortcut(event) || this.shouldIgnoreWorkspaceSearchShortcut(event)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    this.openWorkspaceBlockSearch();
  }

  private isWorkspaceSearchShortcut(event: KeyboardEvent): boolean {
    return (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'f';
  }

  private shouldIgnoreWorkspaceSearchShortcut(event: KeyboardEvent): boolean {
    const target = event.target as Element | null;
    if (!target) {
      return false;
    }

    if (target.closest('.workspace-search')) {
      return false;
    }

    if (target.closest('.ant-modal, .ant-modal-wrap, .cdk-overlay-pane, .monaco-editor, .blocklyWidgetDiv, .blocklyDropDownDiv')) {
      return true;
    }

    if (target.closest('input, textarea, select, [contenteditable="true"]')) {
      return true;
    }

    if (this.layoutElementRef.nativeElement.contains(target)) {
      return false;
    }

    return target !== document.body && target !== document.documentElement;
  }

  private openWorkspaceBlockSearch(): void {
    this.requestCodeGeneration();
    this.blocklyService.openWorkspaceBlockSearch();
    setTimeout(() => this.focusWorkspaceSearchInput(true), 0);
  }

  onWorkspaceSearchKeydown(event: KeyboardEvent): void {
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && key === 'f') {
      event.preventDefault();
      this.focusWorkspaceSearchInput(true);
      return;
    }

    if (key === 'enter') {
      event.preventDefault();
      if (event.shiftKey) {
        this.onWorkspaceSearchPrevious();
      } else {
        this.onWorkspaceSearchNext();
      }
      return;
    }

    if (key === 'escape') {
      event.preventDefault();
      this.closeWorkspaceBlockSearch();
    }
  }

  private focusWorkspaceSearchInput(selectText = false): void {
    const input = this.workspaceSearchInputRef?.nativeElement;
    if (!input) {
      return;
    }

    input.focus();
    if (selectText) {
      input.select();
    }
  }

  private refreshWorkspaceBlockSearchForEvent(event: BlocklyWorkspaceEvent): void {
    const state = this.blocklyService.workspaceBlockSearchSubject.value;
    if (!state.isOpen || !event?.type || !this.codeGenerationEventTypes.has(event.type)) {
      return;
    }

    this.blocklyService.refreshWorkspaceBlockSearch();
  }

  private updateWorkspaceSearchHighlights(state: WorkspaceBlockSearchState): void {
    this.clearWorkspaceSearchHighlight();
    if (!state.isOpen || !state.query.trim() || !this.workspace) {
      return;
    }

    for (const result of state.results) {
      const block = this.workspace.getBlockById(result.blockId);
      const path = block ? this.getWorkspaceSearchHighlightPath(block) : null;
      if (!path) {
        continue;
      }

      path.classList.add('aily-workspace-search-match-path');
      this.workspaceSearchHighlightedPaths.add(path);
    }

    const currentBlockId = state.results[state.currentIndex]?.blockId;
    if (!currentBlockId) {
      return;
    }

    const currentBlock = this.workspace.getBlockById(currentBlockId);
    const currentPath = currentBlock ? this.getWorkspaceSearchHighlightPath(currentBlock) : null;
    if (!currentPath) {
      return;
    }

    currentPath.classList.add('aily-workspace-search-current-path');
    this.workspaceSearchHighlightedPaths.add(currentPath);
  }

  private getWorkspaceSearchHighlightPath(block: Blockly.Block): SVGElement | null {
    const pathObjectPath = (block as unknown as { pathObject?: { svgPath?: SVGElement } }).pathObject?.svgPath;
    if (pathObjectPath) {
      return pathObjectPath;
    }

    const root = (block as unknown as { getSvgRoot?: () => SVGElement }).getSvgRoot?.();
    if (!root) {
      return null;
    }

    return Array.from(root.children)
      .find((child): child is SVGElement => child instanceof SVGElement && child.classList.contains('blocklyPath')) ?? null;
  }

  private clearWorkspaceSearchHighlight(): void {
    for (const path of this.workspaceSearchHighlightedPaths) {
      path.classList.remove('aily-workspace-search-match-path', 'aily-workspace-search-current-path');
    }
    this.workspaceSearchHighlightedPaths.clear();
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

  private blocklyThemeForMode(mode: ThemeMode) {
    return mode === 'light' ? LightTheme : DarkTheme;
  }

  private applyMinimapTheme(mode: ThemeMode): void {
    const minimapWorkspace = (this.minimap as any)?.minimapWorkspace as Blockly.WorkspaceSvg | undefined;
    minimapWorkspace?.setTheme(this.blocklyThemeForMode(mode));
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

    this.flyoutPinResizeObserver = new ResizeObserver(() => {
      if (this.flyoutPinPositionAnimationFrame !== null) {
        cancelAnimationFrame(this.flyoutPinPositionAnimationFrame);
      }

      this.flyoutPinPositionAnimationFrame = requestAnimationFrame(() => {
        this.flyoutPinPositionAnimationFrame = null;
        positionPinFo();
      });
    });
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
    if (this.flyoutPinPositionAnimationFrame !== null) {
      cancelAnimationFrame(this.flyoutPinPositionAnimationFrame);
      this.flyoutPinPositionAnimationFrame = null;
    }
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
    const mode = this.devmode === 'micropython' ? 'micropython' : 'arduino';
    this.generatorRuntime.activate({
      mode,
      boardConfig: this.blocklyService.boardConfig,
      getWorkspace: () => this.blocklyService.workspace || null,
    });
  }

  initBlocklyDialogs() {
    Blockly.dialog.setConfirm((message, callback) => {
      const modalRef = this.modal.create({
        nzTitle: null,
        nzFooter: null,
        nzClosable: false,
        nzMaskClosable: false,
        nzBodyStyle: { padding: '0' },
        nzWidth: '340px',
        nzContent: BlocklyConfirmDialogComponent,
        nzData: {
          message,
          okText: Blockly.Msg['DIALOG_OK'],
          cancelText: Blockly.Msg['DIALOG_CANCEL'],
        },
      });

      modalRef.afterClose.subscribe(result => callback(result === true));
    });

    Blockly.dialog.setPrompt((message, defaultValue, callback) => {
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
  private registerBlockExplainContextMenu(): void {
    const id = 'blockExplainWithAi';
    if (Blockly.ContextMenuRegistry.registry.getItem(id)) {
      Blockly.ContextMenuRegistry.registry.unregister(id);
    }

    Blockly.ContextMenuRegistry.registry.register({
      displayText: () => Blockly.Msg['EXPLAIN_BLOCK'] || 'Explain with AI',
      preconditionFn: (scope) => {
        const block = scope.block;
        if (!block || block.isInFlyout || block.isInsertionMarker()) {
          return 'hidden';
        }
        return 'enabled';
      },
      callback: (scope) => {
        this.explainBlockWithAi(scope.block);
        return true;
      },
      scopeType: Blockly.ContextMenuRegistry.ScopeType.BLOCK,
      id,
      weight: -5,
    });
  }

  private registerProjectBreakpointContextMenus(): void {
    this.unregisterProjectBreakpointContextMenus();

    Blockly.ContextMenuRegistry.registry.register({
      displayText: (scope) => {
        const blockId = scope.block?.id || '';
        const label = this.getProjectBreakpoint(blockId)
          ? this.projectBreakpointText(
              '重新绑定仿真断点到最近构建',
              'Rebind simulation breakpoint to latest build',
            )
          : this.projectBreakpointText(
              '添加仿真断点',
              'Add simulation breakpoint',
            );
        return `${label}${this.projectBreakpointBuildBindingSuffix()}`;
      },
      preconditionFn: (scope) => {
        if (!this.isProjectBreakpointScopeAvailable(scope.block)) {
          return 'hidden';
        }
        const breakpoint = this.getProjectBreakpoint(scope.block!.id);
        const revision = this.projectDebugState.sourceMapRevision;
        if (
          breakpoint
          && revision
          && breakpoint.sourceMapRevision === revision
          && this.projectDebugState.buildConsistency === 'current'
        ) {
          return 'hidden';
        }
        return (
          revision
          && this.projectDebugState.buildConsistency === 'current'
        )
          ? 'enabled'
          : 'disabled';
      },
      callback: (scope) => {
        if (scope.block) this.addOrRebindProjectBreakpoint(scope.block);
      },
      scopeType: Blockly.ContextMenuRegistry.ScopeType.BLOCK,
      id: PROJECT_BREAKPOINT_CONTEXT_MENU_IDS[0],
      weight: -8,
    });

    Blockly.ContextMenuRegistry.registry.register({
      displayText: (scope) => {
        const breakpoint = this.getProjectBreakpoint(scope.block?.id || '');
        return breakpoint?.enabled
          ? this.projectBreakpointText(
              '禁用仿真断点',
              'Disable simulation breakpoint',
            )
          : this.projectBreakpointText(
              '启用仿真断点',
              'Enable simulation breakpoint',
            );
      },
      preconditionFn: (scope) => (
        this.isProjectBreakpointScopeAvailable(scope.block)
        && !!this.getProjectBreakpoint(scope.block!.id)
          ? 'enabled'
          : 'hidden'
      ),
      callback: (scope) => {
        if (scope.block) this.toggleProjectBreakpoint(scope.block);
      },
      scopeType: Blockly.ContextMenuRegistry.ScopeType.BLOCK,
      id: PROJECT_BREAKPOINT_CONTEXT_MENU_IDS[1],
      weight: -7,
    });

    Blockly.ContextMenuRegistry.registry.register({
      displayText: () => this.projectBreakpointText(
        '删除仿真断点',
        'Remove simulation breakpoint',
      ),
      preconditionFn: (scope) => (
        this.isProjectBreakpointScopeAvailable(scope.block)
        && !!this.getProjectBreakpoint(scope.block!.id)
          ? 'enabled'
          : 'hidden'
      ),
      callback: (scope) => {
        if (scope.block) this.removeProjectBreakpoint(scope.block);
      },
      scopeType: Blockly.ContextMenuRegistry.ScopeType.BLOCK,
      id: PROJECT_BREAKPOINT_CONTEXT_MENU_IDS[2],
      weight: -6,
    });
  }

  private unregisterProjectBreakpointContextMenus(): void {
    for (const id of PROJECT_BREAKPOINT_CONTEXT_MENU_IDS) {
      if (Blockly.ContextMenuRegistry.registry.getItem(id)) {
        Blockly.ContextMenuRegistry.registry.unregister(id);
      }
    }
  }

  private initProjectDebugConfigurationSubscription(): void {
    this.projectDebugConfigurationService.state$
      .pipe(takeUntil(this.destroy$))
      .subscribe((state) => {
        if (state.projectPath !== this.projectService.currentProjectPath) {
          return;
        }
        this.projectDebugState = state;
        this.queueProjectBreakpointMarkerSync();
      });

    this.blocklyService.debugExecutionMarkerSubject
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => this.queueDebugExecutionMarkerSync());

    this.projectService.currentProjectPath$
      .pipe(distinctUntilChanged(), takeUntil(this.destroy$))
      .subscribe((projectPath) => {
        this.projectDebugState =
          this.projectDebugConfigurationService.refresh(projectPath);
        this.queueProjectBreakpointMarkerSync();
        this.queueDebugExecutionMarkerSync();
      });
  }

  private isProjectBreakpointScopeAvailable(
    block: Blockly.BlockSvg | undefined,
  ): boolean {
    return !!block
      && !block.isInFlyout
      && !block.isInsertionMarker()
      && !!this.projectService.currentProjectPath;
  }

  private getProjectBreakpoint(
    blockId: string,
  ): ProjectBlockBreakpointIntent | undefined {
    if (
      !blockId
      || this.projectDebugState.projectPath
        !== this.projectService.currentProjectPath
    ) {
      return undefined;
    }
    return this.projectDebugState.configuration.breakpoints.find(
      (breakpoint) => breakpoint.blockId === blockId,
    );
  }

  private addOrRebindProjectBreakpoint(block: Blockly.Block): void {
    try {
      const projectPath = this.requireProjectDebugPath();
      const sourceMapRevision =
        this.projectDebugConfigurationService
          .requireBindableSourceMapRevision(projectPath);
      const previous = this.getProjectBreakpoint(block.id);
      const next: ProjectBlockBreakpointIntent = {
        blockId: block.id,
        sourceMapRevision,
        enabled: previous?.enabled ?? true,
      };
      this.projectDebugConfigurationService.upsertBreakpoint(
        projectPath,
        next,
      );
      this.fireProjectDebugConfigurationMutation(
        () => this.projectDebugConfigurationService.upsertBreakpoint(
          projectPath,
          next,
        ),
        () => {
          if (previous) {
            this.projectDebugConfigurationService.upsertBreakpoint(
              projectPath,
              previous,
            );
          } else {
            this.projectDebugConfigurationService.removeBreakpoint(
              projectPath,
              block.id,
            );
          }
        },
      );
    } catch (error) {
      this.message.warning(normalizeBlocklyProjectDebugError(error));
    }
  }

  private toggleProjectBreakpoint(block: Blockly.Block): void {
    const breakpoint = this.getProjectBreakpoint(block.id);
    if (!breakpoint) return;
    try {
      const projectPath = this.requireProjectDebugPath();
      const enabled = !breakpoint.enabled;
      this.projectDebugConfigurationService.setBreakpointEnabled(
        projectPath,
        block.id,
        enabled,
      );
      this.fireProjectDebugConfigurationMutation(
        () => this.projectDebugConfigurationService.setBreakpointEnabled(
          projectPath,
          block.id,
          enabled,
        ),
        () => this.projectDebugConfigurationService.setBreakpointEnabled(
          projectPath,
          block.id,
          breakpoint.enabled,
        ),
      );
    } catch (error) {
      this.message.warning(normalizeBlocklyProjectDebugError(error));
    }
  }

  private removeProjectBreakpoint(block: Blockly.Block): void {
    const breakpoint = this.getProjectBreakpoint(block.id);
    if (!breakpoint) return;
    try {
      const projectPath = this.requireProjectDebugPath();
      this.projectDebugConfigurationService.removeBreakpoint(
        projectPath,
        block.id,
      );
      this.fireProjectDebugConfigurationMutation(
        () => this.projectDebugConfigurationService.removeBreakpoint(
          projectPath,
          block.id,
        ),
        () => this.projectDebugConfigurationService.upsertBreakpoint(
          projectPath,
          breakpoint,
        ),
      );
    } catch (error) {
      this.message.warning(normalizeBlocklyProjectDebugError(error));
    }
  }

  private handleProjectBreakpointWorkspaceEvent(event: any): void {
    if (event?.type === Blockly.Events.BLOCK_DELETE) {
      this.removeDeletedBlockBreakpoints(event);
    }
    if (
      event?.type === Blockly.Events.BLOCK_CREATE
      || event?.type === Blockly.Events.BLOCK_DELETE
      || event?.type === Blockly.Events.FINISHED_LOADING
      || event?.type === Blockly.Events.BLOCK_CHANGE
      || event?.type === Blockly.Events.BLOCK_MOVE
    ) {
      this.queueProjectBreakpointMarkerSync();
      this.queueDebugExecutionMarkerSync();
    }
  }

  private removeDeletedBlockBreakpoints(
    event: Blockly.Events.BlockDelete,
  ): void {
    const deletedIds = new Set(event.ids || []);
    if (!deletedIds.size) return;
    const removed = this.projectDebugState.configuration.breakpoints.filter(
      (breakpoint) => deletedIds.has(breakpoint.blockId),
    );
    if (!removed.length) return;

    try {
      const projectPath = this.requireProjectDebugPath();
      this.projectDebugConfigurationService.removeBreakpoints(
        projectPath,
        deletedIds,
      );
      if (event.recordUndo !== false) {
        if (!event.group) {
          event.group = Blockly.utils.idGenerator.genUid();
        }
        this.fireProjectDebugConfigurationMutation(
          () => this.projectDebugConfigurationService.removeBreakpoints(
            projectPath,
            deletedIds,
          ),
          () => this.projectDebugConfigurationService.upsertBreakpoints(
            projectPath,
            removed,
          ),
          event.group,
        );
      }
    } catch (error) {
      console.warn(
        '[Blockly] Failed to remove breakpoints for deleted blocks:',
        error,
      );
    }
  }

  private fireProjectDebugConfigurationMutation(
    applyMutation: () => void,
    revertMutation: () => void,
    group = Blockly.Events.getGroup(),
  ): void {
    if (!this.workspace || !Blockly.Events.isEnabled()) return;
    const event = new ProjectDebugConfigurationMutationEvent(
      this.workspace.id,
      applyMutation,
      revertMutation,
    );
    event.group = group;
    Blockly.Events.fire(event);
  }

  private requireProjectDebugPath(): string {
    const projectPath = this.projectService.currentProjectPath;
    if (!projectPath) throw new Error('请先打开一个 Blockly 项目。');
    return projectPath;
  }

  private projectBreakpointBuildBindingSuffix(): string {
    switch (this.projectDebugState.buildConsistency) {
      case 'current':
        return '';
      case 'dirty':
        return this.projectBreakpointText(
          '（工作区未编译）',
          ' (workspace not built)',
        );
      case 'checking':
      case 'workspace-unknown':
        return this.projectBreakpointText(
          '（正在核对构建）',
          ' (checking build)',
        );
      default:
        return this.projectBreakpointText(
          '（请先编译）',
          ' (build required)',
        );
    }
  }

  private queueProjectBreakpointMarkerSync(): void {
    if (this.projectBreakpointMarkerSyncQueued) return;
    this.projectBreakpointMarkerSyncQueued = true;
    queueMicrotask(() => {
      this.projectBreakpointMarkerSyncQueued = false;
      this.syncProjectBreakpointMarkers();
    });
  }

  private syncProjectBreakpointMarkers(): void {
    if (!this.workspace) {
      this.clearProjectBreakpointMarkers();
      return;
    }
    const breakpoints = new Map(
      this.projectDebugState.projectPath
        === this.projectService.currentProjectPath
        ? this.projectDebugState.configuration.breakpoints.map(
            (breakpoint) => [breakpoint.blockId, breakpoint],
          )
        : [],
    );
    const visibleBlockIds = new Set(
      this.workspace.getAllBlocks(false).map((block) => block.id),
    );

    for (const [blockId, marker] of this.projectBreakpointMarkers) {
      if (!breakpoints.has(blockId) || !visibleBlockIds.has(blockId)) {
        marker.remove();
        this.projectBreakpointMarkers.delete(blockId);
      }
    }

    for (const [blockId, breakpoint] of breakpoints) {
      const block = this.workspace.getBlockById(blockId);
      const root = block?.getSvgRoot();
      if (!block || !root || block.isInFlyout) continue;

      let marker = this.projectBreakpointMarkers.get(blockId);
      if (!marker || !root.contains(marker)) {
        marker?.remove();
        marker = document.createElementNS(
          SVG_NAMESPACE,
          'g',
        ) as SVGGElement;
        marker.classList.add('aily-project-breakpoint-marker');
        marker.setAttribute('transform', 'translate(8 8)');
        marker.setAttribute('aria-hidden', 'true');
        const circle = document.createElementNS(SVG_NAMESPACE, 'circle');
        circle.setAttribute('r', '5');
        const title = document.createElementNS(SVG_NAMESPACE, 'title');
        marker.append(circle, title);
        root.appendChild(marker);
        this.projectBreakpointMarkers.set(blockId, marker);
      }

      const markerState = getProjectBreakpointMarkerState(
        breakpoint,
        this.projectDebugState.sourceMapRevision,
        this.projectDebugState.buildConsistency,
      );
      marker.setAttribute('data-state', markerState);
      const title = marker.querySelector('title');
      if (title) {
        title.textContent = this.projectBreakpointMarkerTitle(
          breakpoint,
          markerState,
        );
      }
    }
  }

  private clearProjectBreakpointMarkers(): void {
    for (const marker of this.projectBreakpointMarkers.values()) {
      marker.remove();
    }
    this.projectBreakpointMarkers.clear();
  }

  private queueDebugExecutionMarkerSync(): void {
    if (this.debugExecutionMarkerSyncQueued) return;
    this.debugExecutionMarkerSyncQueued = true;
    queueMicrotask(() => {
      this.debugExecutionMarkerSyncQueued = false;
      this.syncDebugExecutionMarker();
    });
  }

  private syncDebugExecutionMarker(): void {
    this.clearDebugExecutionMarker(false);
    if (!this.workspace) {
      this.lastCenteredDebugExecutionBlockId = '';
      return;
    }
    const marker = this.blocklyService.debugExecutionMarkerSubject.value;
    if (
      !marker
      || marker.projectPath !== this.projectService.currentProjectPath
    ) {
      this.lastCenteredDebugExecutionBlockId = '';
      return;
    }
    const block = this.workspace.getBlockById(marker.blockId);
    const root = block?.getSvgRoot();
    if (!block || !root || block.isInFlyout || block.isInsertionMarker()) {
      this.lastCenteredDebugExecutionBlockId = '';
      return;
    }
    root.classList.add('aily-debug-execution-block');
    root.setAttribute('data-debug-execution-marker', 'true');
    this.debugExecutionMarkerRoot = root;
    if (
      marker.focus
      && this.lastCenteredDebugExecutionBlockId !== marker.blockId
    ) {
      this.lastCenteredDebugExecutionBlockId = marker.blockId;
      queueMicrotask(() => {
        const current = this.blocklyService.debugExecutionMarkerSubject.value;
        if (
          current?.projectPath === this.projectService.currentProjectPath
          && current.blockId === marker.blockId
          && this.workspace?.getBlockById(marker.blockId)
        ) {
          this.workspace.centerOnBlock(marker.blockId, true);
        }
      });
    } else if (!marker.focus) {
      this.lastCenteredDebugExecutionBlockId = '';
    }
  }

  private clearDebugExecutionMarker(resetCentered = true): void {
    this.debugExecutionMarkerRoot?.classList.remove(
      'aily-debug-execution-block',
    );
    this.debugExecutionMarkerRoot?.removeAttribute(
      'data-debug-execution-marker',
    );
    this.debugExecutionMarkerRoot = null;
    if (resetCentered) this.lastCenteredDebugExecutionBlockId = '';
  }

  private projectBreakpointMarkerTitle(
    breakpoint: ProjectBlockBreakpointIntent,
    state: ReturnType<typeof getProjectBreakpointMarkerState>,
  ): string {
    const revision = breakpoint.sourceMapRevision.slice(0, 12);
    switch (state) {
      case 'enabled':
        return this.projectBreakpointText(
          `仿真断点已启用 · ${revision}`,
          `Simulation breakpoint enabled · ${revision}`,
        );
      case 'disabled':
        return this.projectBreakpointText(
          `仿真断点已禁用 · ${revision}`,
          `Simulation breakpoint disabled · ${revision}`,
        );
      case 'stale-enabled':
      case 'stale-disabled':
        return this.projectBreakpointText(
          `仿真断点绑定的构建已过期 · ${revision}`,
          `Simulation breakpoint build is stale · ${revision}`,
        );
      case 'workspace-dirty-enabled':
      case 'workspace-dirty-disabled':
        return this.projectBreakpointText(
          `工作区已有未编译修改 · ${revision}`,
          `Workspace has unbuilt changes · ${revision}`,
        );
      case 'workspace-unknown-enabled':
      case 'workspace-unknown-disabled':
        return this.projectBreakpointText(
          `正在核对工作区与构建 · ${revision}`,
          `Checking workspace against build · ${revision}`,
        );
      default:
        return this.projectBreakpointText(
          `仿真断点 · 当前构建未知 · ${revision}`,
          `Simulation breakpoint · current build unknown · ${revision}`,
        );
    }
  }

  private projectBreakpointText(
    chinese: string,
    english: string,
  ): string {
    const language = this.translateService.currentLang || 'zh_cn';
    return language.startsWith('zh') ? chinese : english;
  }

  private explainBlockWithAi(block: Blockly.Block): void {
    if (!block) {
      return;
    }

    if (!this.authService.isLoggedIn) {
      this.message.warning(this.translateService.instant('FLOAT_SIDER.LOGIN_REQUIRED'));
      this.uiService.openTool('aily-chat');
      return;
    }

    this.blocklyService.syncSelectedBlocksFromWorkspace();
    if (!this.blocklyService.selectedBlockIdsSubject.value.includes(block.id)) {
      this.blocklyService.selectedBlockIdsSubject.next([block.id]);
      this.blocklyService.selectedBlockSubject.next(block.id);
    }
    this.codeViewerIpcService.publishSelection(this.blocklyService.selectedBlockSubject.value);

    const prompt = this.translateService.instant('BLOCKLY_EDITOR.EXPLAIN_BLOCK_PROMPT');
    this.uiService.openAndSendToChat(prompt, {
      sender: 'BlocklyComponent',
      type: 'block-explain',
      autoSend: true,
      resources: this.blocklyService.getSelectedBlockContextLabels().map(item => ({
        type: 'block',
        name: item.label,
        blockId: item.blockId,
        blockContext: item.formatted,
      })),
    });
  }

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
    Blockly.Msg["EXPLAIN_BLOCK"] = this.translateService.instant('BLOCKLY.EXPLAIN_BLOCK') || "Explain with AI";

    // 自定义扩展的多语言消息（switch-case 等）
    Blockly.Msg["CONTROLS_SWITCH_CASE"] = this.translateService.instant('BLOCKLY.CONTROLS_SWITCH_CASE') || (lang.startsWith('zh') ? "情况" : "case");
    Blockly.Msg["CONTROLS_SWITCH_DO"] = this.translateService.instant('BLOCKLY.CONTROLS_SWITCH_DO') || (lang.startsWith('zh') ? "执行" : "do");
    Blockly.Msg["CONTROLS_SWITCH_DEFAULT"] = this.translateService.instant('BLOCKLY.CONTROLS_SWITCH_DEFAULT') || (lang.startsWith('zh') ? "默认执行" : "default");
    setU8g2AnimationFieldTranslator((key, params) => this.translateService.instant(key, params));
    setTftEsPiAnimationFieldTranslator((key, params) => this.translateService.instant(key, params));
    setTftEsPiImageFieldTranslator((key, params) => this.translateService.instant(key, params));
    this.queueProjectBreakpointMarkerSync();

    // 如果工作区已存在，刷新工具箱以应用新语言
    if (this.workspace) {
      try {
        // 刷新工具箱
        this.workspace.refreshToolboxSelection();

        const wasEnabled = Blockly.Events.isEnabled();
        try {
          Blockly.Events.disable();
          const blocks = this.workspace.getAllBlocks(false);
          blocks.forEach((block: any) => {
            if (block.rendered) {
              block.initSvg();
            }
          });
        } finally {
          if (wasEnabled) Blockly.Events.enable();
        }

        this.workspace.render();
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
      debounceTime(500),
      takeUntil(this.destroy$)
    ).subscribe(() => this.syncMinimap());
  }

  private initCodeViewerRefreshRequests(): void {
    this.blocklyService.codeViewerRefreshRequested$
      .pipe(takeUntil(this.destroy$))
      .subscribe((forceGenerate) => this.refreshCodeViewerCode(forceGenerate));
  }

  private refreshCodeViewerCode(forceGenerate = false): void {
    if (!this.workspace || !this.generator) {
      return;
    }

    const reusableCode = forceGenerate ? null : this.blocklyService.getReusableGeneratedCode();
    if (reusableCode !== null) {
      this.codeViewerIpcService.publishCodeState(
        reusableCode,
        this.blocklyService.blockCodeMapSubject.value,
        this.blocklyService.selectedBlockSubject.value,
      );
      return;
    }

    this.requestCodeGeneration();
  }

  private requestCodeGeneration(event?: BlocklyWorkspaceEvent): void {
    if (this.shouldGenerateCodeForEvent(event)) {
      this.blocklyService.markWorkspaceCodeDirty();
      this.projectDebugConfigurationService.markWorkspaceDirty(
        this.projectService.currentProjectPath,
      );
      this.codeGenerationSubject.next();
    }
  }

  private shouldGenerateCodeForEvent(event?: BlocklyWorkspaceEvent): boolean {
    if (!event?.type) {
      return true;
    }

    return this.codeGenerationEventTypes.has(event.type);
  }

  private requestMinimapSync(event?: BlocklyWorkspaceEvent): void {
    if (!this.shouldSyncMinimapForEvent(event)) {
      return;
    }

    this.minimapDirtyVersion++;
    this.minimapSyncSubject.next();
  }

  private shouldSyncMinimapForEvent(event?: BlocklyWorkspaceEvent): boolean {
    if (!event?.type) {
      return true;
    }

    return this.minimapSyncEventTypes.has(event.type);
  }

  /**
   * 将主工作区状态全量同步到 Minimap
   * 使用 Xml 路径加载，避免 serialization.load 触发的 BLOCK_MOVE 事件导致 "block could not be found" 错误
   * 同步时禁用事件，避免 custom field 在反序列化时因 "associated block is undefined" 报错
   */
  private syncMinimap(): void {
    const m = this.minimap as any;
    if (!m?.minimapWorkspace || !this.workspace) return;

    const syncVersion = this.minimapDirtyVersion;
    if (syncVersion === this.minimapSyncedVersion) {
      return;
    }

    if (this.minimapSyncInProgress) {
      this.minimapSyncQueued = true;
      return;
    }

    this.minimapSyncInProgress = true;
    const wasEnabled = Blockly.Events.isEnabled();
    let renderPromise: Promise<unknown> | null = null;
    try {
      Blockly.Events.disable();
      const xml = Blockly.Xml.workspaceToDom(this.workspace, true);
      m.minimapWorkspace.clear();
      Blockly.Xml.domToWorkspace(xml, m.minimapWorkspace);
      renderPromise = Blockly.renderManagement.finishQueuedRenders().then(() => {
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

    if (renderPromise) {
      renderPromise.finally(() => this.completeMinimapSync(syncVersion));
    } else {
      this.completeMinimapSync(syncVersion);
    }
  }

  private completeMinimapSync(syncVersion: number): void {
    this.minimapSyncedVersion = syncVersion;
    this.minimapSyncInProgress = false;

    if (this.minimapSyncQueued || this.minimapDirtyVersion !== syncVersion) {
      this.minimapSyncQueued = false;
      this.minimapSyncSubject.next();
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
    ).subscribe(async () => {
      try {
        const projectPath = this.projectService.currentProjectPath;
        const projectDocument = this.blocklyService.getProjectDocument();
        const generated = await runWithPreparedActiveProjectGenerator(
          this.workspace,
          (generator) => {
            const activeBlockCodeMap = (
              generator as { blockCodeMap?: Map<string, BlockCodeMapping> }
            ).blockCodeMap;
            return {
              code: normalizeArduinoGeneratedCode(generator.workspaceToCode(this.workspace)),
              generator,
              blockCodeMap: activeBlockCodeMap ? new Map(activeBlockCodeMap) : null,
            };
          },
          projectDocument,
        );
        const { code, generator } = generated;
        const blockCodeMap = generated.blockCodeMap ?? new Map<string, BlockCodeMapping>();
        await writeArduinoGeneratedArtifacts(projectPath, generator);
        this.blocklyService.publishGeneratedCode(code);
        void this.projectDebugConfigurationService.updateWorkspaceGeneratedCode(
          projectPath,
          code,
        );
        // 发布 block-to-code 映射
        if (generated.blockCodeMap) {
          this.blocklyService.blockCodeMapSubject.next(blockCodeMap);
          this.blocklyService.absBlockLineMap.next(new Map());
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

}

function normalizeBlocklyProjectDebugError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
