import { Injectable } from '@angular/core';
import { BehaviorSubject, Subject, debounceTime, filter, firstValueFrom, map, switchMap, take, timer } from 'rxjs';
import * as Blockly from 'blockly';
import { installBlocklyVariableComparator, loadBlocklyWorkspace } from '../utils/blockly-performance';
import { processI18n, processJsonVar, processStaticFilePath, processToolboxI18n, resolveSerialPortValueAfterCdcDisabled } from '../components/blockly/abf';
import { TranslateService } from '@ngx-translate/core';
import { ElectronService, LogService } from '@core/platform/public-api';
import { NoticeService } from '@core/app-shell/public-api';
import { BlocklyLibraryDiagnostics, BlocklyLibraryPackageService, BlocklyLibraryPackageSnapshot } from '@domain/dependencies/public-api';
import {
  BlockCodeMapping,
  CodeLineRange,
  normalizeArduinoGeneratedCode,
} from '../components/blockly/generators/arduino/arduino';
import { AbsBlockContextIndex, truncateAbsContext } from '../../../integrations/blockly/abs/abs-block-context';
import type { AbsProjection } from '../../../integrations/blockly/abs/abs-state';
import { nativeFieldOrder } from '../../../integrations/blockly/abs/abs-native-field-order';
import { withNativeStateLoading } from './blockly-native-state-loading';
import { BlockSearcher } from '../components/blockly/plugins/toolbox-search/src/block_searcher';
import {
  dragSelectionWeakMap,
  registerFieldInputIncrementPolicy,
} from '../components/blockly/plugins/workspace-multiselect/index.js';
import { exportWorkspaceToSvg } from './workspace-svg-exporter';
import {
  createProjectDataMarker,
  isAilyProjectDataMarker,
  decorateLibraryBlockDefinitionForProjectData,
  unregisterProjectDataFieldSlots,
  projectDataRuntime,
} from '@domain/project/public-api';
import { BlocklyGeneratorRuntimeService, getActiveProjectGenerator, getActiveProjectGeneratorRevision } from './blockly-generator-runtime.service';
import { SerialOperationQueue } from '@shared/public-api';
import {
  BlocklyWorkspaceViewState, BlocklySharedModel, BlocklyPageSnapshot, BlocklyProjectDocument,
  composeBlocklyPage, normalizeBlocklyOwnership, normalizeBlocklyWorkspace, normalizeBlocklyViewState, replaceBlocklyPageWorkspace,
} from './blockly-project-model';
import { captureBlocklyRootClassifier } from './blockly-root-role';
import { captureCustomFunctionRegistration } from './blockly-custom-function-contract';
import { BlocklyProjectRevision } from './blockly-project-revision';
import { BlocklyCodePreparationInvalidatedError, BlocklyProjectCodePreparation, type PreparedBlocklyCode } from './prepared-project-code';
import { BlocklyWorkspaceEditGate, BlocklyWorkspaceEditLease, fenceBlocklyWorkspaceInput } from './blockly-workspace-edit-lease';
import { assertAbsProjectSharedChange } from '../../../integrations/blockly/abs/abs-project-references';
import { AbsReferenceContractCache } from '../../../integrations/blockly/abs/abs-reference-contract-cache';
import { BlocklyDeclarativeBlockCatalog } from './blockly-declarative-block-catalog';
import { captureAbsPageReferenceContract } from '../../../integrations/blockly/abs/abs-runtime-references';
import {
  changedRuntimeBlockTypes,
  RuntimeBlockMetadata,
  serializeRuntimeBlockMetadata,
} from './blockly-runtime-block-metadata';

export type { BlocklyWorkspaceViewState, BlocklySharedModel, BlocklyPageSnapshot, BlocklyProjectDocument } from './blockly-project-model';

export interface BlockContextLabel {
  label: string;
  formatted: string;
  blockId: string;
}

export interface BlocklyToolboxFacadeItem {
  key: string;
  sortKey: string;
  name: string;
  kind: string;
  iconClass: string;
  selectable: boolean;
  toolboxItemId: string;
  libraryName?: string | null;
  libraryPath?: string | null;
  isLocalLibrary?: boolean;
  libraryLoadFailed?: boolean;
  parentKey: string | null;
  level: number;
  expanded: boolean;
  isCollapsible: boolean;
  children: BlocklyToolboxFacadeItem[];
}

interface LoadedBlocklyLibraryInfo {
  packageName: string;
  blockTypes: string[];
  generatorPath: string;
}

export interface BlocklyLibraryRuntimeRebuildOptions {
  projectPath: string;
  packageJson: any;
  libraryNames: string[];
  projectService: unknown;
}

export const AILY_BLOCKLY_USED_LIBRARIES_FIELD = 'ailyBlocklyUsedLibraries';

export interface BlocklyUsedLibraryManifestEntry {
  version: string;
  localPath?: string;
  blockTypes: string[];
  updatedAt: number;
}

export type BlocklyUsedLibraryManifest = Record<string, BlocklyUsedLibraryManifestEntry>;

export const BLOCKLY_TOOLBOX_SEARCH_KEY = '__toolbox_search__';

export type WorkspaceBlockSearchMatchSource = 'field' | 'type' | 'code';

export interface WorkspaceBlockSearchResult {
  blockId: string;
  blockType: string;
  displayText: string;
  matchedBy: WorkspaceBlockSearchMatchSource[];
  codeSnippet: string;
}

export interface WorkspaceBlockSearchState {
  isOpen: boolean;
  query: string;
  results: WorkspaceBlockSearchResult[];
  currentIndex: number;
}

export interface BlocklyDebugExecutionMarkerState {
  projectPath: string;
  blockId: string;
}

interface CodeViewerPublisher {
  publishCodeState(
    code: string,
    blockCodeMap: Map<string, BlockCodeMapping>,
    selectedBlockId: string | null,
    selectedBlockIds: readonly string[],
  ): void;
}

@Injectable({
  providedIn: 'root'
})
export class BlocklyService {
  private readonly projectDocumentSchemaVersion = 3;
  private readonly projectOperations = new SerialOperationQueue();
  private readonly projectRevision = new BlocklyProjectRevision();
  private readonly projectCodePreparation = new BlocklyProjectCodePreparation();
  private readonly workspaceEditGate = new BlocklyWorkspaceEditGate();
  private readonly pageReferenceContracts = new AbsReferenceContractCache();
  private releaseWorkspaceInputFence?: () => void;
  private documentMetadata: Record<string, unknown> = {};
  private readonly toolboxSearchKey = BLOCKLY_TOOLBOX_SEARCH_KEY;

  private _workspace: Blockly.WorkspaceSvg | null = null;
  private workspaceReadySubject = new BehaviorSubject<Blockly.WorkspaceSvg | null>(null);

  get workspace(): Blockly.WorkspaceSvg {
    return this._workspace as Blockly.WorkspaceSvg;
  }

  set workspace(workspace: Blockly.WorkspaceSvg | null) {
    if (workspace !== this._workspace) {
      this.releaseWorkspaceInputFence?.();
      this.workspaceEditGate.reset();
      this.projectRevision.invalidate();
      this.projectCodePreparation.clear();
      this.pageReferenceContracts.clear();
    }
    this._workspace = workspace;
    this.workspaceReadySubject.next(workspace);
    if (workspace) {
      this.syncSerialDynamicToolboxBlocks(workspace);
    }
  }

  toolbox = {
    kind: 'categoryToolbox',
    contents: [
      {
        'kind': 'search',
        'name': 'Search',
        'contents': [],
      }
    ],
  };

  iconsMap = new Map();
  blockDefinitionsMap = new Map<string, any>();
  private readonly declarativeBlocks = new BlocklyDeclarativeBlockCatalog();

  captureDeclarativeBlockDefinitions() { return this.declarativeBlocks.capture(Blockly.Blocks); }

  /** Host transaction only; keeps replay provenance/session ownership in the runtime. */
  captureNativeReplay() { return this.generatorRuntime.captureNativeReplay(); }
  recordRuntimeBlockDefinition(source: Record<string, any>, definition: object) { this.declarativeBlocks.record(source, definition); }
  // 追踪加载的generator脚本和它们注册的函数
  loadedGenerators = new Map<string, Set<string>>(); // filePath -> Set of block types
  // 追踪已加载的库,避免重复加载
  loadedLibraries = new Set<string>(); // libPackagePath
  loadedLibraryInfos = new Map<string, LoadedBlocklyLibraryInfo>(); // libPackagePath -> loaded metadata
  private runtimeDefinedLibraryBlockTypes = new Set<string>();
  private libraryLoadTasks = new Map<string, Promise<void>>();
  private libraryLoadQueue: Promise<void> = Promise.resolve();
  private libraryLoadEpoch = 0;
  private failedLibraryLoads = new Map<string, {
    snapshot: BlocklyLibraryPackageSnapshot;
    localPath?: string;
    errors: string[];
  }>();
  private libraryIntegrityFailureLogSignatures = new Map<string, string>();
  private libraryIntegrityWarningLogSignatures = new Map<string, string>();
  private rebuildingLibraryRuntime = false;
  // blockType → 库信息映射（用于跨实例复制粘贴时携带库元信息）
  blockTypeToLibMap = new Map<string, { name: string; version: string; localPath?: string }>();

  codeSubject = new BehaviorSubject<string>('');
  dependencySubject = new BehaviorSubject<string>('');
  private workspaceCodeRevision = 0;
  private generatedCodeRevision = -1;
  private latestGeneratedCode = '';
  private codeViewerRefreshRequestSubject = new Subject<boolean>();
  private workspaceVisualRefreshRequestSubject = new Subject<Blockly.WorkspaceSvg>();
  /** Bulk imports suppress Blockly events; visual consumers still need the final workspace. */
  readonly workspaceVisualRefreshRequested$ = this.workspaceVisualRefreshRequestSubject.asObservable();

  // ==================== Block-to-Code 映射系统 ====================
  /** 当前选中的 block id（主选中块，供代码查看器等使用） */
  selectedBlockSubject = new BehaviorSubject<string | null>(null);
  /** 当前选中的 block id 列表（支持多选） */
  selectedBlockIdsSubject = new BehaviorSubject<string[]>([]);
  /** block → 代码行号映射（每次代码生成后更新） */
  blockCodeMapSubject = new BehaviorSubject<Map<string, BlockCodeMapping>>(new Map());
  /** GDB 当前执行块；与 Blockly 用户 selection 完全独立。 */
  debugExecutionMarkerSubject =
    new BehaviorSubject<BlocklyDebugExecutionMarkerState | null>(null);
  private absContext?: { index: AbsBlockContextIndex; revision: number; assertCurrent: () => void };
  codeViewerRefreshRequested$ = this.codeViewerRefreshRequestSubject.asObservable();
  pagesSubject = new BehaviorSubject<BlocklyPageSnapshot[]>([]);
  activePageIdSubject = new BehaviorSubject<string>('');
  openedPageIdsSubject = new BehaviorSubject<string[]>([]);
  sharedModelSubject = new BehaviorSubject<BlocklySharedModel>({ procedureBlocks: [] });
  toolboxFacadeItemsSubject = new BehaviorSubject<BlocklyToolboxFacadeItem[]>([]);
  toolboxSelectedKeySubject = new BehaviorSubject<string | null>(null);
  toolboxSearchQuerySubject = new BehaviorSubject<string>('');
  workspaceBlockSearchSubject = new BehaviorSubject<WorkspaceBlockSearchState>(this.createWorkspaceBlockSearchState());

  setDebugExecutionMarker(projectPath: string, blockId: string): void {
    const normalizedProjectPath = String(projectPath || '').trim();
    const normalizedBlockId = String(blockId || '').trim();
    const next = normalizedProjectPath && normalizedBlockId
      ? {
          projectPath: normalizedProjectPath,
          blockId: normalizedBlockId.slice(0, 256),
        }
      : null;
    const current = this.debugExecutionMarkerSubject.value;
    if (
      current?.projectPath === next?.projectPath
      && current?.blockId === next?.blockId
    ) {
      return;
    }
    this.debugExecutionMarkerSubject.next(next);
  }

  clearDebugExecutionMarker(projectPath?: string): void {
    const current = this.debugExecutionMarkerSubject.value;
    if (!current || (projectPath && current.projectPath !== projectPath)) return;
    this.debugExecutionMarkerSubject.next(null);
  }

  boardConfig;

  draggingBlock: any;
  offsetX: number = 0;
  offsetY: number = 0;
  private externalToolboxHost: HTMLElement | null = null;
  private nativeToolboxElement: HTMLElement | null = null;
  private blockSearcher = new BlockSearcher();
  private toolboxSortOrder: string[] = [];
  private loadLibraryFinishedLoadingSubject = new Subject<void>();

  private _aiWriting = new BehaviorSubject<boolean>(false);
  aiWriting$ = this._aiWriting.asObservable();
  private readonly aiWritingSources = new Set<string>();
  private _aiExecutionActive = new BehaviorSubject<boolean>(false);
  /** AI 回合 / 子应用操作进行中。与 `aiWaiting` getter/setter 同源。 */
  aiExecutionActive$ = this._aiExecutionActive.asObservable();
  private readonly aiExecutionActiveSources = new Set<string>();
  private _aiWaitWriting = new BehaviorSubject<boolean>(false);
  /** 短暂的“等待写入”提示态，不等于 AI 执行中。 */
  aiWaitWriting$ = this._aiWaitWriting.asObservable();
  /**
   * 兼容旧订阅：必须与 `aiWaiting` getter 一致，指向 `_aiExecutionActive`。
   * 历史上误绑到 `_aiWaitWriting`，会导致遮罩亮起但「AI正在操作」通知不出现。
   */
  aiWaiting$ = this._aiExecutionActive.asObservable();

  get aiWaiting() {
    return this._aiExecutionActive.value;
  }

  set aiWaiting(value: boolean) {
    this.setAiExecutionActive('legacy-aily-chat', value);
  }

  setAiExecutionActive(source: string, value: boolean): void {
    const normalizedSource = String(source || '').trim();
    if (!normalizedSource) {
      return;
    }

    if (value) {
      this.aiExecutionActiveSources.add(normalizedSource);
    } else {
      this.aiExecutionActiveSources.delete(normalizedSource);
    }

    const active = this.aiExecutionActiveSources.size > 0;
    if (this._aiExecutionActive.value !== active) {
      this._aiExecutionActive.next(active);
    }
  }

  get aiWaitWriting() {
    return this._aiWaitWriting.value;
  }

  set aiWaitWriting(value: boolean) {
    if (this._aiWaitWriting.value !== value) {
      this._aiWaitWriting.next(value);
    }
  }

  get aiWriting(): boolean {
    return this._aiWriting.value;
  }

  set aiWriting(value: boolean) {
    this.setAiWritingActive('legacy-aily-chat', value);
  }

  /** 积木写入态多源合并，供遮罩 / 「AI正在操作」通知使用。 */
  setAiWritingActive(source: string, value: boolean): void {
    const normalizedSource = String(source || '').trim();
    if (!normalizedSource) {
      return;
    }

    if (value) {
      this.aiWritingSources.add(normalizedSource);
    } else {
      this.aiWritingSources.delete(normalizedSource);
    }

    const active = this.aiWritingSources.size > 0;
    if (this._aiWriting.value !== active) {
      this._aiWriting.next(active);
    }
  }

  markWorkspaceCodeDirty(): void {
    this.workspaceCodeRevision++;
  }

  getWorkspaceContentRevision(): number {
    return this.workspaceCodeRevision;
  }

  publishGeneratedCode(code: unknown): void {
    const normalizedCode = normalizeArduinoGeneratedCode(code);
    this.latestGeneratedCode = normalizedCode;
    this.generatedCodeRevision = this.workspaceCodeRevision;
    this.codeSubject.next(normalizedCode);
  }

  /**
   * Publish the live code view from an already prepared snapshot.
   * Disk publication is separate: a busy build lease must not hide this code.
   */
  registerCodeViewerPublisher(publisher: CodeViewerPublisher): () => void {
    this.codeViewerPublisher = publisher;
    this.flushCodeViewer();
    return () => {
      if (this.codeViewerPublisher === publisher) this.codeViewerPublisher = null;
    };
  }

  publishPreparedCodeView(code: string, blockCodeMapText: string | null): void {
    this.publishGeneratedCode(code);
    if (blockCodeMapText !== null) {
      this.blockCodeMapSubject.next(new Map<string, BlockCodeMapping>(JSON.parse(blockCodeMapText)));
    }
    this.flushCodeViewer();
  }

  getGeneratedCode(): string {
    return this.latestGeneratedCode || this.codeSubject.value || '';
  }

  getReusableGeneratedCode(): string | null {
    if (this.workspaceEditGate.blocked || this.generatedCodeRevision !== this.workspaceCodeRevision) {
      return null;
    }

    return this.latestGeneratedCode;
  }

  requestCodeViewerRefresh(forceGenerate = false): void {
    this.codeViewerRefreshRequestSubject.next(forceGenerate);
  }

  requestWorkspaceVisualRefresh(): void {
    if (this.workspace) this.workspaceVisualRefreshRequestSubject.next(this.workspace);
  }

  private codeViewerPublisher: CodeViewerPublisher | null = null;

  private flushCodeViewer(): void {
    if (!this.codeViewerPublisher || this.generatedCodeRevision !== this.workspaceCodeRevision) return;
    this.codeViewerPublisher.publishCodeState(
      this.latestGeneratedCode,
      this.blockCodeMapSubject.value,
      this.selectedBlockSubject.value,
      this.selectedBlockIdsSubject.value,
    );
  }

  private overlayChaffObserver: MutationObserver | null = null;
  private documentPointerDownHandler: ((event: PointerEvent) => void) | null = null;

  /** Blockly 内联编辑器浮层（文本框、下拉等）的 DOM 根节点，点击其内部时不 dismiss。 */
  private static readonly BLOCKLY_POPUP_SELECTOR =
    '.blocklyWidgetDiv, .blocklyDropDownDiv, .blocklyTextInputBubble';

  constructor(
    private translateService: TranslateService,
    private electronService: ElectronService,
    private logService: LogService,
    private noticeService: NoticeService,
    private blocklyLibraryPackageService: BlocklyLibraryPackageService,
    private generatorRuntime: BlocklyGeneratorRuntimeService,
  ) {
    (window as any).__ailyBlockDefinitionsMap = this.blockDefinitionsMap;
    (window as any).__ailyBlockTypeToLibMap = this.blockTypeToLibMap;
    this.loadLibraryFinishedLoadingSubject.pipe(
      debounceTime(500),
      switchMap(() => timer(0, 50).pipe(
        map(() => this.workspace || Blockly.getMainWorkspace()),
        filter((workspace): workspace is Blockly.WorkspaceSvg => !!workspace && Blockly.Events.isEnabled()),
        take(1),
      )),
    ).subscribe((workspace) => {
      Blockly.Events.fire(new Blockly.Events.FinishedLoading(workspace));
    });
    this.resetDocumentState();
    this.rebuildToolboxFacade();
    this.initDocumentPopupDismiss();
    this.initOverlayChaffHider();
  }

  /** 点击 Blockly 浮层外部时关闭文本框/下拉（capture 阶段，早于菜单/弹窗打开）。 */
  private initDocumentPopupDismiss(): void {
    if (typeof document === 'undefined' || this.documentPointerDownHandler) {
      return;
    }

    this.documentPointerDownHandler = (event: PointerEvent) => {
      if (!this._workspace) {
        return;
      }

      const target = event.target as Element | null;
      if (!target || target.closest(BlocklyService.BLOCKLY_POPUP_SELECTOR)) {
        return;
      }

      if (!this.isBlocklyPopupVisible()) {
        return;
      }

      this.hideChaff(true);
    };

    document.addEventListener('pointerdown', this.documentPointerDownHandler, true);
  }

  private isBlocklyPopupVisible(): boolean {
    if (Blockly.WidgetDiv.isVisible()) {
      return true;
    }
    return Blockly.DropDownDiv.getOwner() !== null;
  }

  /** 关闭 Blockly 内联文本输入、下拉等浮层；默认仅关 popup，不影响 flyout 折叠状态。 */
  hideChaff(onlyClosePopups = true): void {
    const workspace = this._workspace ?? Blockly.getMainWorkspace() as Blockly.WorkspaceSvg | null;
    if (workspace) {
      workspace.hideChaff(onlyClosePopups);
    } else {
      Blockly.WidgetDiv.hide();
      Blockly.DropDownDiv.hide();
    }
  }

  /** 弹窗打开时自动关闭 Blockly 浮层。 */
  private initOverlayChaffHider(): void {
    if (typeof document === 'undefined' || this.overlayChaffObserver) {
      return;
    }

    const bindObserver = () => {
      const container = document.querySelector('.cdk-overlay-container');
      if (!container || this.overlayChaffObserver) {
        return;
      }

      this.overlayChaffObserver = new MutationObserver(() => {
        if (container.querySelector('.ant-modal-wrap, .cdk-overlay-backdrop')) {
          this.hideChaff();
        }
      });
      this.overlayChaffObserver.observe(container, { childList: true, subtree: true });
    };

    if (document.querySelector('.cdk-overlay-container')) {
      bindObserver();
      return;
    }

    setTimeout(bindObserver, 0);
  }

  waitForWorkspace(): Promise<Blockly.WorkspaceSvg> {
    if (this._workspace) {
      return Promise.resolve(this._workspace);
    }

    return firstValueFrom(this.workspaceReadySubject.pipe(
      filter((workspace): workspace is Blockly.WorkspaceSvg => !!workspace),
      take(1),
    ));
  }

  /** 生成当前工作区的独立 SVG；具体导出细节由 workspace-svg-exporter 负责。 */
  async createWorkspaceImageExportSvg(): Promise<string | null> {
    const workspace = await this.waitForWorkspace();
    this.hideChaff(true);
    return exportWorkspaceToSvg(workspace);
  }

  registerExternalToolboxHost(host: HTMLElement | null) {
    this.externalToolboxHost = host;
    this.mountExternalToolbox();
  }

  registerNativeToolboxElement(element: HTMLElement | null) {
    this.nativeToolboxElement = element;
    this.mountExternalToolbox();
  }

  isExternalToolboxEnabled(): boolean {
    return !!this.externalToolboxHost;
  }

  getPages(): BlocklyPageSnapshot[] {
    return this.getOpenPages();
  }

  getAllPages(): BlocklyPageSnapshot[] {
    return this.pagesSubject.value;
  }

  getOpenPages(): BlocklyPageSnapshot[] {
    const openedPageIds = new Set(this.openedPageIdsSubject.value);
    return this.pagesSubject.value.filter((page) => openedPageIds.has(page.id));
  }

  getClosedPages(): BlocklyPageSnapshot[] {
    const openedPageIds = new Set(this.openedPageIdsSubject.value);
    return this.pagesSubject.value.filter((page) => !openedPageIds.has(page.id));
  }

  getOpenedPageIds(): string[] {
    return [...this.openedPageIdsSubject.value];
  }

  getToolboxFacadeItems(): BlocklyToolboxFacadeItem[] {
    return this.toolboxFacadeItemsSubject.value;
  }

  getLibraryRuntimeSnapshot(): {
    active: boolean;
    loadedLibraries: string[];
    toolboxLibraries: string[];
    failedLibraries: string[];
  } {
    const toolboxLibraries = new Set<string>();
    const failedLibraries = new Set<string>();
    const items = [...this.getToolboxFacadeItems()];

    for (const item of items) {
      items.push(...item.children);
      if (!item.libraryName) continue;

      if (item.libraryLoadFailed) failedLibraries.add(item.libraryName);
      else toolboxLibraries.add(item.libraryName);
    }

    return {
      active: !!this.workspace && this.generatorRuntime.isActive() && !this.rebuildingLibraryRuntime,
      loadedLibraries: [...new Set(
        Array.from(this.loadedLibraryInfos.values(), (library) => library.packageName),
      )],
      toolboxLibraries: [...toolboxLibraries],
      failedLibraries: [...failedLibraries],
    };
  }

  getToolboxSearchQuery(): string {
    return this.toolboxSearchQuerySubject.value;
  }

  getSelectedToolboxKey(): string | null {
    return this.toolboxSelectedKeySubject.value;
  }

  setToolboxSortOrder(order: unknown) {
    this.toolboxSortOrder = Array.isArray(order)
      ? order
        .filter((key): key is string => typeof key === 'string' && key.length > 0)
      : [];

    this.applyToolboxSortOrderToContents(this.toolbox.contents);
    if (this.hasToolboxCategories(this.toolbox.contents)) {
      this.refreshToolboxFromContents();
    } else {
      this.rebuildToolboxFacade();
    }
  }

  getToolboxSortOrder(): string[] {
    return this.toolbox.contents
      .filter((item) => this.isSortableToolboxCategory(item))
      .map((item) => this.getToolboxItemSortKey(item));
  }

  moveToolboxFacadeItem(itemKey: string, categoryIndex: number): boolean {
    this.ensureToolboxItemIds(this.toolbox.contents);

    const currentIndex = this.toolbox.contents.findIndex((item: any) => item?.kind === 'category' && item.toolboxitemid === itemKey);
    if (currentIndex === -1) {
      return false;
    }

    const nextCategoryIndex = Math.max(0, categoryIndex);
    const [movedItem] = this.toolbox.contents.splice(currentIndex, 1);
    const categoryIndexes = this.toolbox.contents
      .map((item: any, index: number) => this.isSortableToolboxCategory(item) ? index : -1)
      .filter((index: number) => index !== -1);
    const insertIndex = nextCategoryIndex >= categoryIndexes.length
      ? this.toolbox.contents.length
      : categoryIndexes[nextCategoryIndex];

    this.toolbox.contents.splice(insertIndex, 0, movedItem);
    this.toolboxSortOrder = this.getToolboxSortOrder();
    this.refreshToolboxFromContents();
    return true;
  }

  setToolboxSearchQuery(query: string) {
    const nextQuery = query ?? '';
    this.toolboxSearchQuerySubject.next(nextQuery);
    this.showSearchFlyout(true);
  }

  activateToolboxSearch() {
    this.showSearchFlyout(true);
  }

  clearToolboxSearch() {
    this.toolboxSearchQuerySubject.next('');
    if (this.toolboxSelectedKeySubject.value === this.toolboxSearchKey) {
      this.clearToolboxSelection();
    }
  }

  clearToolboxSelection() {
    this.workspace?.getToolbox()?.clearSelection();
    this.workspace?.getFlyout()?.hide();
    this.toolboxSelectedKeySubject.next(null);
  }

  openWorkspaceBlockSearch(query = this.workspaceBlockSearchSubject.value.query) {
    const nextQuery = query ?? '';
    const currentState = this.workspaceBlockSearchSubject.value;
    const results = this.searchWorkspaceBlocks(nextQuery);
    const currentIndex = results.length && currentState.currentIndex >= 0
      ? Math.min(currentState.currentIndex, results.length - 1)
      : -1;
    this.workspaceBlockSearchSubject.next({
      isOpen: true,
      query: nextQuery,
      results,
      currentIndex,
    });
  }

  closeWorkspaceBlockSearch() {
    this.workspaceBlockSearchSubject.next(this.createWorkspaceBlockSearchState());
  }

  setWorkspaceBlockSearchQuery(query: string) {
    const nextQuery = query ?? '';
    const results = this.searchWorkspaceBlocks(nextQuery);
    this.workspaceBlockSearchSubject.next({
      isOpen: true,
      query: nextQuery,
      results,
      currentIndex: -1,
    });
  }

  refreshWorkspaceBlockSearch() {
    const state = this.workspaceBlockSearchSubject.value;
    if (!state.isOpen) {
      return;
    }

    const previousBlockId = state.results[state.currentIndex]?.blockId ?? null;
    const results = this.searchWorkspaceBlocks(state.query);
    let currentIndex = -1;
    if (results.length) {
      const preservedIndex = previousBlockId ? results.findIndex((item) => item.blockId === previousBlockId) : -1;
      currentIndex = preservedIndex >= 0
        ? preservedIndex
        : state.currentIndex >= 0
          ? Math.min(state.currentIndex, results.length - 1)
          : -1;
    }

    this.workspaceBlockSearchSubject.next({
      ...state,
      results,
      currentIndex,
    });
  }

  selectWorkspaceBlockSearchResult(index: number): boolean {
    const state = this.workspaceBlockSearchSubject.value;
    if (!state.results.length) {
      return false;
    }

    const nextIndex = ((index % state.results.length) + state.results.length) % state.results.length;
    const result = state.results[nextIndex];
    const block = this.workspace?.getBlockById(result.blockId);
    if (!block) {
      this.refreshWorkspaceBlockSearch();
      return false;
    }

    block.select();
    this.workspace.centerOnBlock(result.blockId, true);
    this.workspaceBlockSearchSubject.next({
      ...state,
      currentIndex: nextIndex,
    });
    this.selectedBlockSubject.next(result.blockId);
    this.selectedBlockIdsSubject.next([result.blockId]);
    return true;
  }

  selectNextWorkspaceBlockSearchResult(): boolean {
    const state = this.workspaceBlockSearchSubject.value;
    return this.selectWorkspaceBlockSearchResult(state.currentIndex + 1);
  }

  selectPreviousWorkspaceBlockSearchResult(): boolean {
    const state = this.workspaceBlockSearchSubject.value;
    return this.selectWorkspaceBlockSearchResult(state.currentIndex - 1);
  }

  closeToolboxSearchFlyout(): boolean {
    if (this.toolboxSelectedKeySubject.value !== this.toolboxSearchKey) {
      return false;
    }

    const flyout = this.workspace?.getFlyout();
    if ((flyout as any)?.autoClose === false) {
      return false;
    }

    flyout?.hide();
    this.toolboxSelectedKeySubject.next(null);
    return true;
  }

  clickToolboxFacadeItem(itemKey: string): boolean {
    const item = this.findToolboxFacadeItemByKey(itemKey);
    if (!item) {
      return itemKey === this.toolboxSearchKey ? this.selectToolboxFacadeItem(itemKey) : false;
    }

    if (item.isCollapsible) {
      return this.toggleToolboxFacadeItem(itemKey, true);
    }

    return this.selectToolboxFacadeItem(itemKey);
  }

  selectToolboxFacadeItem(itemKey: string): boolean {
    if (itemKey === this.toolboxSearchKey) {
      this.activateToolboxSearch();
      return true;
    }

    const item = this.findToolboxFacadeItemByKey(itemKey);
    if (!item) {
      return false;
    }

    this.toolboxSearchQuerySubject.next('');
    this.expandToolboxAncestors(item.key);

    const toolbox = this.getNativeToolbox();
    const nativeItem = this.getNativeToolboxItem(item.toolboxItemId);
    if (toolbox && nativeItem) {
      this.expandNativeToolboxAncestors(nativeItem);
      toolbox.setSelectedItem(nativeItem);
    }

    this.toolboxSelectedKeySubject.next(item.key);
    return true;
  }

  toggleToolboxFacadeItem(itemKey: string, selectItem = false): boolean {
    const item = this.findToolboxFacadeItemByKey(itemKey);
    if (!item || !item.isCollapsible) {
      return false;
    }

    this.toolboxSearchQuerySubject.next('');
    this.expandToolboxAncestors(item.key);

    const toolbox = this.getNativeToolbox();
    const nativeItem = this.getNativeToolboxItem(item.toolboxItemId);

    if (toolbox && nativeItem) {
      this.expandNativeToolboxAncestors(nativeItem);
      if (selectItem) {
        toolbox.setSelectedItem(nativeItem);
      }
    }

    const nextExpanded = nativeItem?.isExpanded?.() !== undefined
      ? !nativeItem.isExpanded()
      : !item.expanded;
    const hasChanged = this.updateToolboxCategoryExpandedState(item.toolboxItemId, nextExpanded);

    if (nativeItem?.setExpanded) {
      nativeItem.setExpanded(nextExpanded);
    } else if (nativeItem?.toggleExpanded) {
      nativeItem.toggleExpanded();
    }

    if (hasChanged) {
      this.rebuildToolboxFacade();
    }

    this.syncToolboxFacadeWithWorkspace();
    return true;
  }

  collapseToolboxFacadeItem(itemKey: string): boolean {
    const item = this.findToolboxFacadeItemByKey(itemKey);
    if (!item || !item.isCollapsible) {
      return false;
    }

    const hasChanged = this.updateToolboxCategoryExpandedState(item.toolboxItemId, false);
    const nativeItem = this.getNativeToolboxItem(item.toolboxItemId);
    const nativeExpanded = nativeItem?.isExpanded?.();

    if (nativeItem?.setExpanded) {
      nativeItem.setExpanded(false);
    } else if (nativeItem?.toggleExpanded && nativeExpanded === true) {
      nativeItem.toggleExpanded();
    }

    if (hasChanged) {
      this.rebuildToolboxFacade();
    }

    this.syncToolboxFacadeWithWorkspace();
    return hasChanged || nativeExpanded === true;
  }

  syncToolboxSelectionFromNativeItem(selectedItemId?: string | null, selectedItemName?: string | null) {
    if (!selectedItemId && !selectedItemName) {
      if (this.toolboxSelectedKeySubject.value !== this.toolboxSearchKey) {
        this.toolboxSelectedKeySubject.next(null);
      }
      return;
    }

    const item = this.findToolboxFacadeItemByToolboxItemId(selectedItemId || '')
      || this.findToolboxFacadeItemByName(selectedItemName || '');

    if (item) {
      this.expandToolboxAncestors(item.key);
    }

    this.toolboxSelectedKeySubject.next(item?.key || null);
  }

  syncToolboxFacadeWithWorkspace() {
    const selectedItem = this.getNativeToolbox()?.getSelectedItem() as any;
    const selectedItemId = selectedItem?.getId?.() || null;
    const selectedItemName = selectedItem?.getName?.() || null;
    this.syncToolboxSelectionFromNativeItem(selectedItemId, selectedItemName);

    if (this.toolboxSelectedKeySubject.value === this.toolboxSearchKey) {
      this.showSearchFlyout(false);
    }
  }

  getActivePageId(): string {
    return this.activePageIdSubject.value;
  }

  getActivePage(): BlocklyPageSnapshot | undefined {
    return this.pagesSubject.value.find((page) => page.id === this.activePageIdSubject.value);
  }

  loadAbiJson(jsonData) {
    const document = this.normalizeProjectAbiForLoad(jsonData);
    this.loadProjectDocument(document, false);
  }

  loadProjectDocument(document: BlocklyProjectDocument, cloneState = true, owner?: BlocklyWorkspaceEditLease) {
    this.assertWorkspaceEditAvailable(owner);
    // Validate ownership before changing the published model or clearing the workspace.
    this.applyProjectDocument(normalizeBlocklyOwnership(document, captureBlocklyRootClassifier(null, Blockly.Blocks)), cloneState);
    this.loadActivePageIntoWorkspace(owner);
  }

  /** ABS mutates the composed active workspace, not titles/tabs or another page's content. */
  restoreProjectWorkspaceSnapshot(snapshot: BlocklyProjectDocument, owner?: BlocklyWorkspaceEditLease, rootOrder?: readonly string[]): void {
    this.assertWorkspaceEditAvailable(owner);
    const current = this.getStoredProjectDocument();
    if (snapshot.activePageId !== current.activePageId) {
      throw new Error('Cannot restore a workspace snapshot onto a different page.');
    }
    const restored = replaceBlocklyPageWorkspace(
      current, current.activePageId, composeBlocklyPage(snapshot, current.activePageId),
      captureBlocklyRootClassifier(null, Blockly.Blocks),
    );
    this.applyProjectDocument(restored, false);
    this.loadActivePageIntoWorkspace(owner, rootOrder);
  }

  assertWorkspaceSharedChange(snapshot: BlocklyProjectDocument, workspace: any, owner?: BlocklyWorkspaceEditLease): void {
    this.assertWorkspaceEditAvailable(owner);
    const candidate = replaceBlocklyPageWorkspace(snapshot, snapshot.activePageId, workspace,
      captureBlocklyRootClassifier(this.workspace, Blockly.Blocks));
    this.synchronizeReferenceContractScope();
    assertAbsProjectSharedChange(snapshot, candidate, snapshot.activePageId, this.pageReferenceContracts.matching(snapshot));
  }

  hydrateWorkspaceFromProjectState() {
    this.assertWorkspaceEditAvailable();
    this.loadActivePageIntoWorkspace();
  }

  normalizeProjectAbi(jsonData: any): BlocklyProjectDocument {
    return this.normalizeProjectDocument(jsonData);
  }

  normalizeProjectAbiForLoad(jsonData: any): BlocklyProjectDocument {
    if (!isAilyProjectDataMarker(jsonData?.$ailyProjectData)) {
      throw new Error('Unsupported project.abi: missing $ailyProjectData external-only schema marker.');
    }
    return this.normalizeProjectDocument(jsonData);
  }

  switchPage(pageId: string): boolean {
    this.assertWorkspaceEditAvailable();
    if (!pageId || pageId === this.activePageIdSubject.value || !this.pagesSubject.value.some(page => page.id === pageId)) {
      return false;
    }

    this.persistActiveWorkspaceToState();
    this.activePageIdSubject.next(pageId);
    this.loadActivePageIntoWorkspace();
    return true;
  }

  createPage(title?: string): BlocklyPageSnapshot {
    this.assertWorkspaceEditAvailable();
    this.persistActiveWorkspaceToState();

    const pages = [...this.pagesSubject.value];
    const openedPageIds = [...this.openedPageIdsSubject.value];
    const page = this.createEmptyPageSnapshot(
      this.generatePageId(),
      title || this.buildDefaultPageTitle(pages.length + 1),
    );

    pages.push(page);
    this.pagesSubject.next(pages);
    this.openedPageIdsSubject.next([...openedPageIds, page.id]);
    this.activePageIdSubject.next(page.id);
    this.loadActivePageIntoWorkspace();
    return page;
  }

  openPage(pageId: string, activate = true): boolean {
    this.assertWorkspaceEditAvailable();
    const page = this.pagesSubject.value.find((item) => item.id === pageId);
    if (!page) {
      return false;
    }

    const currentActivePageId = this.activePageIdSubject.value;
    const isAlreadyOpened = this.openedPageIdsSubject.value.includes(pageId);

    if (isAlreadyOpened && (!activate || currentActivePageId === pageId)) {
      return false;
    }

    this.persistActiveWorkspaceToState();

    if (!isAlreadyOpened) {
      const nextOpenedPageIds = this.pagesSubject.value
        .map((item) => item.id)
        .filter((id) => id === pageId || this.openedPageIdsSubject.value.includes(id));
      this.openedPageIdsSubject.next(nextOpenedPageIds);
    }

    if (activate) {
      this.activePageIdSubject.next(pageId);
      this.loadActivePageIntoWorkspace();
    }

    return true;
  }

  closePage(pageId: string): string {
    this.assertWorkspaceEditAvailable();
    const currentOpenedPageIds = this.openedPageIdsSubject.value;
    if (currentOpenedPageIds.length <= 1) {
      return this.activePageIdSubject.value;
    }

    if (!currentOpenedPageIds.includes(pageId)) {
      return this.activePageIdSubject.value;
    }

    this.persistActiveWorkspaceToState();

    const closeIndex = currentOpenedPageIds.findIndex((openedPageId) => openedPageId === pageId);
    if (closeIndex === -1) {
      return this.activePageIdSubject.value;
    }

    const nextOpenedPageIds = currentOpenedPageIds.filter((openedPageId) => openedPageId !== pageId);
    const currentActivePageId = this.activePageIdSubject.value;
    let nextActivePageId = currentActivePageId;

    if (pageId === currentActivePageId) {
      const fallbackIndex = closeIndex >= nextOpenedPageIds.length ? nextOpenedPageIds.length - 1 : closeIndex;
      nextActivePageId = nextOpenedPageIds[Math.max(fallbackIndex, 0)] || nextOpenedPageIds[0];
    }

    this.openedPageIdsSubject.next(nextOpenedPageIds);
    this.activePageIdSubject.next(nextActivePageId);

    if (pageId === currentActivePageId) {
      this.loadActivePageIntoWorkspace();
    }

    return nextActivePageId;
  }

  renamePage(pageId: string, title: string) {
    this.assertWorkspaceEditAvailable();
    const nextTitle = (title || '').trim();
    if (!nextTitle) {
      return;
    }

    this.pagesSubject.next(
      this.pagesSubject.value.map((page) =>
        page.id === pageId ? { ...page, title: nextTitle } : page,
      ),
    );
  }

  getProjectDocument(owner?: BlocklyWorkspaceEditLease): BlocklyProjectDocument {
    this.assertWorkspaceEditAvailable(owner);
    const document = this.getStoredProjectDocument();
    return this.workspace ? replaceBlocklyPageWorkspace(
      document, document.activePageId, this.getWorkspaceJson(),
      captureBlocklyRootClassifier(this.workspace, Blockly.Blocks), this.captureWorkspaceViewState(),
    ) : document;
  }

  /** One renderer queue for ABS import/export and prepared saves; not a host file/edit lock. */
  runProjectOperation<T>(operation: () => Promise<T>): Promise<T> {
    return this.projectOperations.run(() => { this.assertWorkspaceEditAvailable(); return operation(); });
  }

  captureProjectSnapshot(owner?: BlocklyWorkspaceEditLease) {
    const document = this.getProjectDocument(owner);
    return { document, revision: this.projectRevision.observe(document) };
  }

  /** Call inside the existing operation queue with explicit edit ownership. */
  prepareProjectCode(assertCurrent: () => void, owner: BlocklyWorkspaceEditLease, force = false) {
    return this.projectCodePreparation.prepare(() => {
      assertCurrent(); owner.assertCurrent();
      return { ...this.captureProjectSnapshot(owner), workspace: this.workspace,
        generator: getActiveProjectGenerator(), dataSession: projectDataRuntime.getSessionToken(),
        runtimeRevision: getActiveProjectGeneratorRevision(), pageId: this.getActivePageId() };
    }, force);
  }

  /** Explicit build/save consumers own edits and may only publish the prepared revision. */
  runWithPreparedProjectCode<T>(
    operation: (prepared: PreparedBlocklyCode & { code: string }, assertCurrent: () => void) => Promise<T> | T,
    force = false,
  ): Promise<T> {
    const workspace = this.workspace, pageId = this.getActivePageId();
    const generator = getActiveProjectGenerator(), session = projectDataRuntime.getSessionToken();
    const runtimeRevision = getActiveProjectGeneratorRevision();
    const assertContext = () => {
      if (workspace !== this.workspace || pageId !== this.getActivePageId()
        || generator !== getActiveProjectGenerator() || session !== projectDataRuntime.getSessionToken()
        || runtimeRevision !== getActiveProjectGeneratorRevision()) {
        throw new Error('Project context changed before code publication.');
      }
    };
    return this.runProjectOperation(async () => {
      assertContext();
      const lease = this.acquireWorkspaceEditLease();
      try {
        const prepared = await this.prepareProjectCode(assertContext, lease, force);
        if (!prepared || prepared.code === null) throw new Error(prepared?.error ?? 'Blockly generator runtime is not active');
        const revision = prepared.revision;
        const assertCurrent = () => {
          assertContext(); lease.assertCurrent();
          if (revision !== this.captureProjectSnapshot(lease).revision) throw new Error('Project changed before code publication.');
        };
        assertCurrent();
        const result = await operation(prepared as PreparedBlocklyCode & { code: string }, assertCurrent);
        assertCurrent();
        return result;
      } finally { lease.release(); }
    });
  }

  /**
   * Background preview is an optimistic reader, not an exclusive workspace edit.
   * Keep it in the project queue to serialize against saves/ABS, but leave input,
   * gestures and popups alone during resource preparation and artifact IO.
   * Recheck interaction and revision after every asynchronous boundary; the
   * caller reschedules false results. Generator model registration is synchronous.
   */
  runWithBackgroundProjectCode(
    operation: (prepared: PreparedBlocklyCode & { code: string }, assertCurrent: () => void) => Promise<void> | void,
    isInteracting: () => boolean,
    force = false,
  ): Promise<boolean> {
    const workspace = this.workspace, pageId = this.getActivePageId();
    const generator = getActiveProjectGenerator(), session = projectDataRuntime.getSessionToken();
    const runtimeRevision = getActiveProjectGeneratorRevision();
    const assertContext = () => {
      if (workspace !== this.workspace || pageId !== this.getActivePageId()
        || generator !== getActiveProjectGenerator() || session !== projectDataRuntime.getSessionToken()
        || runtimeRevision !== getActiveProjectGeneratorRevision() || isInteracting()) {
        throw new BlocklyCodePreparationInvalidatedError('Background code refresh was superseded by an interaction or context change.');
      }
    };
    return this.runProjectOperation(async () => {
      try {
        const capture = () => {
          assertContext();
          return { ...this.captureProjectSnapshot(), workspace, generator, dataSession: session,
            runtimeRevision, pageId };
        };
        const prepared = await this.projectCodePreparation.prepare(capture, force);
        if (!prepared || prepared.code === null) throw new Error(prepared?.error ?? 'Blockly generator runtime is not active');
        const assertCurrent = () => {
          assertContext();
          if (prepared.revision !== this.captureProjectSnapshot().revision) {
            throw new BlocklyCodePreparationInvalidatedError('Project changed before background code publication.');
          }
        };
        assertCurrent();
        await operation(prepared as PreparedBlocklyCode & { code: string }, assertCurrent);
        assertCurrent();
        return true;
      } catch (error) {
        if (error instanceof BlocklyCodePreparationInvalidatedError) return false;
        // The generator realm can be replaced during resource preparation,
        // before our next capture callback gets a chance to check its identity.
        try { assertContext(); } catch (contextError) {
          if (contextError instanceof BlocklyCodePreparationInvalidatedError) return false;
          throw contextError;
        }
        throw error;
      }
    });
  }

  getProjectPersistenceRevision(): number {
    return this.workspaceEditGate.blocked ? this.projectRevision.current : this.captureProjectSnapshot().revision;
  }

  assertWorkspaceEditAvailable(owner?: BlocklyWorkspaceEditLease): void {
    this.workspaceEditGate.assertAvailable(owner);
  }

  isWorkspaceEditBlocked(): boolean { return this.workspaceEditGate.blocked; }
  isWorkspaceEditInProgress(): boolean { return this.workspaceEditGate.busy; }

  acquireWorkspaceEditLease(): BlocklyWorkspaceEditLease {
    const lease = this.workspaceEditGate.acquire();
    const workspace = this.workspace;
    let quarantined = false;
    let cleanup = () => undefined;
    const release = lease.release;
    const quarantine = lease.quarantine;
    try {
      cleanup = fenceBlocklyWorkspaceInput(workspace?.getParentSvg?.()?.parentElement ?? undefined);
      workspace?.cancelCurrentGesture?.();
      workspace?.hideChaff?.();
      this.setAiWritingActive('workspace-edit-lease', true);
    } catch (error) { cleanup(); release(); throw error; }
    let releasedInput = false;
    const releaseInput = () => {
      if (releasedInput) return;
      releasedInput = true;
      cleanup();
      this.setAiWritingActive('workspace-edit-lease', false);
      if (this.releaseWorkspaceInputFence === releaseInput) this.releaseWorkspaceInputFence = undefined;
    };
    this.releaseWorkspaceInputFence = releaseInput;
    lease.release = () => { try { if (!quarantined) releaseInput(); } finally { release(); } };
    lease.quarantine = reason => {
      try { lease.assertCurrent(); } catch { return; } // Never quarantine a replacement workspace.
      quarantined = true;
      quarantine(reason);
    };
    return lease;
  }

  private getStoredProjectDocument(): BlocklyProjectDocument {
    return {
      ...this.cloneJson(this.documentMetadata),
      schemaVersion: this.projectDocumentSchemaVersion,
      activePageId: this.activePageIdSubject.value,
      openedPageIds: this.cloneJson(this.openedPageIdsSubject.value),
      pages: this.cloneJson(this.pagesSubject.value),
      sharedModel: this.cloneJson(this.sharedModelSubject.value),
    };
  }

  getProjectAbiForSave(document = this.getProjectDocument()): any {
    return {
      ...this.cloneJson(document),
      $ailyProjectData: createProjectDataMarker(),
    };
  }

  getProjectUsedLibraryManifest(packageJson?: any, document = this.getProjectDocument()): BlocklyUsedLibraryManifest {
    const usedBlockTypes = this.collectBlockTypesFromProjectDocument(document);
    const previousManifest = packageJson?.[AILY_BLOCKLY_USED_LIBRARIES_FIELD] || {};
    const manifest: BlocklyUsedLibraryManifest = {};
    const updatedAt = Date.now();

    for (const blockType of usedBlockTypes) {
      const libInfo = this.blockTypeToLibMap.get(blockType);
      if (!libInfo?.name) {
        continue;
      }

      const dependencySpec = this.getPackageDependencySpec(packageJson, libInfo.name);
      const entry = manifest[libInfo.name] || {
        version: dependencySpec || libInfo.version || '',
        localPath: libInfo.localPath,
        blockTypes: [],
        updatedAt,
      };

      if (!entry.version && (dependencySpec || libInfo.version)) {
        entry.version = dependencySpec || libInfo.version || '';
      }
      if (!entry.localPath && libInfo.localPath) {
        entry.localPath = libInfo.localPath;
      }

      entry.blockTypes.push(blockType);
      entry.updatedAt = updatedAt;
      manifest[libInfo.name] = entry;
    }

    return Object.keys(manifest)
      .sort((a, b) => a.localeCompare(b))
      .reduce<BlocklyUsedLibraryManifest>((result, packageName) => {
        const entry = manifest[packageName];
        const nextEntry = {
          ...entry,
          blockTypes: Array.from(new Set(entry.blockTypes)).sort(),
        };
        const previousEntry = previousManifest?.[packageName];
        if (this.isSameUsedLibraryManifestEntry(previousEntry, nextEntry)) {
          nextEntry.updatedAt = typeof previousEntry.updatedAt === 'number' ? previousEntry.updatedAt : updatedAt;
        }
        result[packageName] = {
          ...nextEntry,
        };
        return result;
      }, {});
  }

  collectBlockTypesFromProjectAbi(jsonData: any): string[] {
    const document = this.normalizeProjectDocument(jsonData);
    return this.collectBlockTypesFromProjectDocument(document);
  }

  // 加载 blockly 当前工作区的 JSON 数据
  loadWorkspaceJson(jsonData: any, clone = true, owner?: BlocklyWorkspaceEditLease) {
    this.assertWorkspaceEditAvailable(owner);
    if (!this.workspace) {
      return;
    }

    const workspaceJson = (clone ? this.cloneJson(jsonData) : jsonData) || this.createEmptyWorkspaceContent();
    workspaceJson.blocks?.blocks?.forEach((block) => {
      const ailyIcons = this.iconsMap.get(block.type);
      if (ailyIcons) {
        block.icons = ailyIcons;
      }
    });

    installBlocklyVariableComparator();
    const definitions = this.captureDeclarativeBlockDefinitions();
    definitions.assertCurrent();
    withNativeStateLoading(Blockly, this.workspace, workspaceJson,
      () => loadBlocklyWorkspace(this.workspace, workspaceJson),
      block => nativeFieldOrder(block, definitions));
    captureCustomFunctionRegistration(Blockly.Blocks)?.prepareSerialization(this.workspace, true);
  }

  // 通过node_modules加载库
  async loadLibrary(libPackageName, projectPath) {
    this.assertWorkspaceEditAvailable();
    // 统一路径分隔符，确保在Windows上使用反斜杠
    // const normalizedProjectPath = projectPath.replace(/\//g, '\\');
    // const libPackagePath = normalizedProjectPath + '\\node_modules\\' + libPackageName.replace(/\//g, '\\');

    const libPackagePath = this.blocklyLibraryPackageService.getPackagePath(projectPath, libPackageName);

    // 防止重复加载
    if (this.loadedLibraries.has(libPackagePath)) {
      return;
    }

    const existingLoadTask = this.libraryLoadTasks.get(libPackagePath);
    if (existingLoadTask) {
      await existingLoadTask;
      return;
    }

    // Recovery swaps the shared realm. Serialize different library loads too,
    // so a concurrent lib_add cannot register into a realm being replaced.
    const epoch = this.libraryLoadEpoch;
    const loadTask = this.libraryLoadQueue.then(async () => {
      if (epoch !== this.libraryLoadEpoch || this.loadedLibraries.has(libPackagePath)) return;
      await this.loadLibraryInternal(libPackageName, projectPath, libPackagePath);
    });
    this.libraryLoadQueue = loadTask.catch(() => undefined);
    this.libraryLoadTasks.set(libPackagePath, loadTask);
    try {
      await loadTask;
    } finally {
      if (this.libraryLoadTasks.get(libPackagePath) === loadTask) {
        this.libraryLoadTasks.delete(libPackagePath);
      }
    }
  }

  async retryLibrary(libPackageName: string, projectPath: string): Promise<boolean> {
    const libPackagePath = this.blocklyLibraryPackageService.getPackagePath(projectPath, libPackageName);
    const projectDocument = this.getProjectDocument();
    try {
      await this.loadLibrary(libPackageName, projectPath);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error || '未知错误');
      this.noticeService.update({
        title: `库加载失败：${libPackageName}`,
        text: errorMessage,
        detail: errorMessage,
        state: 'error',
        showProgress: false,
        setTimeout: 10000,
      });
      return false;
    }

    const librarySnapshot = this.blocklyLibraryPackageService.readLibraryPackage(projectPath, libPackageName);
    const displayName = this.getLibraryToolboxDisplayName(librarySnapshot, libPackageName);
    if (this.loadedLibraries.has(libPackagePath)) {
      // Replace instances created from the failed library's display definitions.
      this.loadProjectDocument(projectDocument, false);
      this.requestCodeViewerRefresh(true);
      this.noticeService.update({
        title: '库加载成功',
        text: displayName,
        state: 'done',
        showProgress: false,
        setTimeout: 3000,
      });
      return true;
    }

    const diagnostics = this.blocklyLibraryPackageService.validateLibraryPackage(librarySnapshot, libPackageName);
    const errors = this.failedLibraryLoads.get(libPackagePath)?.errors
      || (diagnostics.errors.length > 0
        ? diagnostics.errors
        : [`${displayName} 运行时加载失败，请检查 generator.js 是否能正常执行。`]);
    const localPath = this.resolveLibraryLocalPath(projectPath, libPackageName);
    const detail = [
      `积木库：${libPackageName}`,
      `项目：${projectPath}`,
      `安装目录：${libPackagePath}`,
      ...(localPath ? [`本地源目录：${localPath}（请在源目录修复）`] : []),
      ...errors,
      '修复后点击异常库或通知中的重试，重新加载该库。',
    ].join('\n');
    this.noticeService.update({
      title: `库加载失败：${displayName}`,
      text: errors[0],
      detail,
      state: 'error',
      showProgress: false,
      setTimeout: 10000,
      onRetry: () => {
        // An old notification may outlive a project switch or a successful repair.
        if (this.failedLibraryLoads.has(libPackagePath)) void this.retryLibrary(libPackageName, projectPath);
      },
    });
    return false;
  }

  private async loadLibraryInternal(libPackageName: string, projectPath: string, libPackagePath: string): Promise<void> {
    const librarySnapshot = this.blocklyLibraryPackageService.readLibraryPackage(projectPath, libPackageName);
    const libLocalPath = this.resolveLibraryLocalPath(projectPath, libPackageName);
    // 检查库的完整性
    const integrityCheck = this.checkLibraryIntegrity(librarySnapshot, libPackageName);
    if (!integrityCheck.valid) {
      this.failedLibraryLoads.set(libPackagePath, {
        snapshot: librarySnapshot, localPath: libLocalPath, errors: integrityCheck.errors,
      });
      this.restoreFailedLibraryDisplay(libPackagePath);
      return;
    }

    let generatorLoadSuccess = true;
    let loadedBlockTypes: string[] = [];
    let runtimeDefinedBlockTypes: string[] = [];
    const generatorFilePath = librarySnapshot.paths.generatorJs;
    try {
      // 加载block
      if (Array.isArray(librarySnapshot.blockJson)) {
        // 加载blocks
        let blocks = this.cloneJson(librarySnapshot.blockJson);
        loadedBlockTypes = blocks
          .map((block: any) => block?.type)
          .filter((type: any): type is string => typeof type === 'string' && type.length > 0);
        // 读取库版本号（用于跨实例复制粘贴时携带库元信息）
        const libVersion = librarySnapshot.packageJson?.version || '';
        let i18nData = null;
        // 检查多语言文件是否存在（先于 generator.js 加载，确保动态扩展能读取到 i18n 数据）
        const i18nFilePath = this.electronService.pathJoin(libPackagePath, 'i18n', this.translateService.currentLang + '.json');
        if (this.electronService.exists(i18nFilePath)) {
          i18nData = JSON.parse(this.electronService.readFile(i18nFilePath));
          this.generatorRuntime.setLibraryI18n(libPackageName, i18nData);
          blocks = processI18n(blocks, i18nData);
        }
        // 加载generator（必须在 i18n 数据存储后，这样动态定义的块才能读取到正确的多语言）
        const generatorFileIsExist = this.electronService.exists(generatorFilePath);
        if (generatorFileIsExist) {
          const blockDefinitionsBeforeGenerator = new Map<string, unknown>(
            Object.entries(Blockly.Blocks || {}),
          );
          generatorLoadSuccess = await this.loadLibGenerator(generatorFilePath);
          if (!generatorLoadSuccess) {
            throw new Error(`[loadLibrary] generator.js 加载失败: ${libPackageName}`);
          }
          runtimeDefinedBlockTypes = changedRuntimeBlockTypes(
            blockDefinitionsBeforeGenerator,
            Blockly.Blocks || {},
          );
        }
        // 替换block中静态图片路径
        const staticFileIsExist = this.electronService.exists(this.electronService.pathJoin(libPackagePath, 'static'));
        this.loadLibBlocks(blocks, staticFileIsExist ? this.electronService.pathJoin(libPackagePath, 'static') : null, libPackageName, libVersion, libLocalPath);
        for (const blockType of runtimeDefinedBlockTypes) {
          this.runtimeDefinedLibraryBlockTypes.add(blockType);
          this.blockTypeToLibMap.set(blockType, {
            name: libPackageName,
            version: libVersion,
            localPath: libLocalPath,
          });
        }
        loadedBlockTypes = Array.from(new Set([...loadedBlockTypes, ...runtimeDefinedBlockTypes]));
        // 加载toolbox
        if (librarySnapshot.toolboxRoot) {
          let toolbox = this.cloneJson(librarySnapshot.toolboxRoot);
          // 处理 toolbox 多语言（包括 name 和 labels）
          if (i18nData) {
            toolbox = processToolboxI18n(toolbox, i18nData);
          }
          this.normalizeLibraryToolboxJson(toolbox);
          this.attachLibraryMetadataToToolbox(toolbox, libPackageName, libPackagePath, !!libLocalPath);
          this.loadLibToolbox(toolbox);
        }
      } else {
        // block.json 不存在时，不标记为已加载
        return;
      }

      // 仅在 generator 加载成功时才标记为已加载（失败时允许后续重试）
      if (generatorLoadSuccess) {
        this.failedLibraryLoads.delete(libPackagePath);
        this.loadedLibraries.add(libPackagePath);
        this.loadedLibraryInfos.set(libPackagePath, {
          packageName: libPackageName,
          blockTypes: loadedBlockTypes,
          generatorPath: generatorFilePath,
        });
      }
      // 补发Blockly.Events.FINISHED_LOADING
      this.loadLibraryFinishedLoadingSubject.next();
    } catch (error) {
      console.error('加载库失败:', libPackageName, error);
      this.failedLibraryLoads.set(libPackagePath, {
        snapshot: librarySnapshot,
        localPath: libLocalPath,
        errors: [String((error as Error)?.stack || (error as Error)?.message || error)],
      });
      await this.recoverLibraryRuntime(projectPath);
    }
  }

  /** Rebuild only successful libraries in a fresh realm: a failed classic script
   * may already have registered helpers, extensions, listeners or const bindings. */
  private async recoverLibraryRuntime(projectPath: string): Promise<void> {
    const projectDocument = this.getProjectDocument();
    const libraryNames = Array.from(this.loadedLibraryInfos.values(), info => info.packageName);
    const wasRebuilding = this.rebuildingLibraryRuntime;
    const wasReady = this.generatorRuntime.isReady();
    this.rebuildingLibraryRuntime = true;
    try {
      this.generatorRuntime.rebuild({ projectPath });
      this.clearLoadedLibraryStateForRuntimeRebuild(true);
      for (const libraryName of libraryNames) {
        await this.loadLibraryInternal(libraryName, projectPath,
          this.blocklyLibraryPackageService.getPackagePath(projectPath, libraryName));
      }
      for (const libraryPath of this.failedLibraryLoads.keys()) {
        this.restoreFailedLibraryDisplay(libraryPath);
      }
      if (!wasRebuilding) {
        this.refreshToolboxFromContents();
        this.loadProjectDocument(projectDocument, false);
        if (wasReady) this.generatorRuntime.markReady(projectPath);
      }
    } finally {
      this.rebuildingLibraryRuntime = wasRebuilding;
    }
  }

  private restoreFailedLibraryDisplay(libraryPath: string): void {
    const failure = this.failedLibraryLoads.get(libraryPath);
    if (!failure) return;
    const { snapshot, localPath } = failure;
    // Retain readable block shapes so existing project blocks are not discarded.
    // Explicitly reject code generation instead of silently skipping failed blocks.
    if (Array.isArray(snapshot.blockJson)) {
      for (const definition of snapshot.blockJson) {
        if (!definition?.type || Blockly.Blocks[definition.type]) continue;
        try {
          const block = this.cloneJson(definition);
          if (Array.isArray(block.extensions)) {
            block.extensions = block.extensions.filter(name => Blockly.Extensions.isRegistered(name));
          }
          if (block.mutator && !Blockly.Extensions.isRegistered(block.mutator)) delete block.mutator;
          this.loadLibBlocks([block], this.electronService.pathJoin(snapshot.ref.path, 'static'), snapshot.ref.name,
            snapshot.packageJson?.version || '', localPath);
          const generator = this.generatorRuntime.getActiveGenerator();
          if (generator) {
            generator.forBlock[block.type] = () => {
              throw new Error(`库 ${snapshot.ref.name} 加载失败，修复并重新加载后才能生成代码。\n${failure.errors.join('\n')}`);
            };
          }
        } catch (error) {
          console.warn('无法恢复异常库的积木外观:', definition.type, error);
        }
      }
    }
    this.loadFailedLibraryToolbox(snapshot, snapshot.ref.name, libraryPath, !!localPath);
  }

  private checkLibraryIntegrity(
    snapshot: BlocklyLibraryPackageSnapshot,
    expectedPackageName?: string,
  ): BlocklyLibraryDiagnostics {
    const diagnostics = this.blocklyLibraryPackageService.validateLibraryPackage(snapshot, expectedPackageName);

    if (diagnostics.errors.length > 0) {
      this.logLibraryIntegrityErrors(snapshot.ref.path, diagnostics.errors);
    } else {
      this.libraryIntegrityFailureLogSignatures.delete(snapshot.ref.path);
    }
    if (diagnostics.warnings.length > 0) {
      this.logLibraryIntegrityWarnings(snapshot.ref.path, diagnostics.warnings);
    } else {
      this.libraryIntegrityWarningLogSignatures.delete(snapshot.ref.path);
    }

    return diagnostics;
  }

  private logLibraryIntegrityErrors(libPackagePath: string, errors: string[]): void {
    const signature = this.buildLibraryIntegrityLogSignature(libPackagePath, errors);
    if (this.libraryIntegrityFailureLogSignatures.get(libPackagePath) === signature) {
      return;
    }

    this.libraryIntegrityFailureLogSignatures.set(libPackagePath, signature);
    console.error([
      `[checkLibraryIntegrity] 库完整性检查失败`,
      ...errors.map((error) => `- ${error}`),
    ].join('\n'));
  }

  private logLibraryIntegrityWarnings(libPackagePath: string, warnings: string[]): void {
    const signature = this.buildLibraryIntegrityLogSignature(libPackagePath, warnings);
    if (this.libraryIntegrityWarningLogSignatures.get(libPackagePath) === signature) {
      return;
    }

    this.libraryIntegrityWarningLogSignatures.set(libPackagePath, signature);
    const warningMessage = warnings.map((warning) => `- ${warning}`).join('\n');
    console.warn([
      `[checkLibraryIntegrity] 库完整性检查警告`,
      warningMessage,
    ].join('\n'));
    this.logService.update({
      title: '库完整性检查警告',
      detail: warningMessage,
      state: 'warn',
    });
    this.noticeService.update({
      title: '库完整性检查警告',
      text: warnings[0],
      detail: warningMessage,
      state: 'warn',
      showProgress: false,
      setTimeout: 10000,
      sendToLog: false,
    });
  }

  private buildLibraryIntegrityLogSignature(libPackagePath: string, messages: string[]): string {
    const paths = this.blocklyLibraryPackageService.getPackagePaths(libPackagePath);
    const fileSignatures = Object.values(paths)
      .map((filePath) => this.blocklyLibraryPackageService.getIntegrityFileSignature(filePath));

    return JSON.stringify({
      messages,
      files: fileSignatures,
    });
  }

  private normalizeLibraryToolboxJson(item: any) {
    if (!item || typeof item !== 'object') {
      return;
    }

    if (typeof item['kind'] === 'string' && item['kind'].trim().toLowerCase() === 'separator') {
      item['kind'] = 'sep';
    }

    if (Array.isArray(item['contents'])) {
      item['contents'].forEach((child: any) => this.normalizeLibraryToolboxJson(child));
    }
  }

  private loadFailedLibraryToolbox(
    snapshot: BlocklyLibraryPackageSnapshot,
    libraryName: string,
    libraryPath: string,
    isLocalLibrary: boolean,
  ): void {
    const toolboxIcon = typeof snapshot.toolboxRoot?.icon === 'string' && snapshot.toolboxRoot.icon.trim()
      ? snapshot.toolboxRoot.icon
      : 'fa-light fa-cube';
    const placeholder = {
      kind: 'category',
      name: this.getLibraryToolboxDisplayName(snapshot, libraryName),
      icon: toolboxIcon,
      contents: [],
    };

    this.attachLibraryMetadataToToolbox(placeholder, libraryName, libraryPath, isLocalLibrary, true);
    this.loadLibToolbox(placeholder);
  }

  private getLibraryToolboxDisplayName(snapshot: BlocklyLibraryPackageSnapshot, libraryName: string): string {
    const toolboxName = typeof snapshot.toolboxRoot?.name === 'string'
      ? snapshot.toolboxRoot.name.trim()
      : '';
    const packageNickname = typeof snapshot.packageJson?.nickname === 'string'
      ? snapshot.packageJson.nickname.trim()
      : '';
    const packageName = typeof snapshot.packageJson?.name === 'string'
      ? snapshot.packageJson.name.trim()
      : '';
    return toolboxName || packageNickname || packageName || libraryName;
  }

  private resolveLibraryLocalPath(projectPath: string, libraryName: string): string | undefined {
    try {
      const projectPackageJsonPath = this.electronService.pathJoin(projectPath, 'package.json');
      if (!this.electronService.exists(projectPackageJsonPath)) {
        return undefined;
      }

      const projectPackageJson = JSON.parse(this.electronService.readFile(projectPackageJsonPath));
      const dependencySpec = this.getPackageDependencySpec(projectPackageJson, libraryName);
      return this.resolveFileDependencyPath(projectPath, dependencySpec);
    } catch {
      return undefined;
    }
  }

  loadLibBlocks(blocks, libStaticPath, libPackageName = '', libVersion = '', libLocalPath?: string) {
    this.assertWorkspaceEditAvailable();
    this.projectCodePreparation.clear();
    this.pageReferenceContracts.clear();
    for (let index = 0; index < blocks.length; index++) {
      let block = blocks[index];
      if (block?.type && block?.icon) {
        this.blockDefinitionsMap.set(
          block.type,
          JSON.parse(JSON.stringify(block.icon))
        );
      }
      // 记录 blockType → 库信息映射
      if (block?.type && libPackageName) {
        this.blockTypeToLibMap.set(block.type, { name: libPackageName, version: libVersion, localPath: libLocalPath });
      }
      block = processJsonVar(block, this.boardConfig); // 替换开发板相关变量
      if (libStaticPath) {
        block = processStaticFilePath(block, libStaticPath);
      }
      block = decorateLibraryBlockDefinitionForProjectData(
        block,
        libPackageName,
        (key) => this.translateService.instant(key),
      );
      this.registerBlockFieldInputIncrementPolicy(block);
      Blockly.defineBlocksWithJsonArray([block]);
      this.declarativeBlocks.record(block, Blockly.Blocks[block.type]);
      this.generatorRuntime.recordNativeBlockDefinitions([block], libPackageName);
    }
  }

  private registerBlockFieldInputIncrementPolicy(block: any): void {
    const blockType = typeof block?.type === 'string' ? block.type : '';
    if (!blockType) {
      return;
    }

    let hasExplicitPolicy = false;
    const incrementableFields: string[] = [];
    Object.keys(block)
      .filter((key) => /^args\d+$/.test(key) && Array.isArray(block[key]))
      .forEach((key) => {
        block[key].forEach((arg: any) => {
          if (arg?.type !== 'field_input' || typeof arg.autoIncrement !== 'boolean') {
            return;
          }
          hasExplicitPolicy = true;
          if (arg.autoIncrement && typeof arg.name === 'string') {
            incrementableFields.push(arg.name);
          }
          // autoIncrement belongs to Aily's library schema, not Blockly's
          // FieldTextInput JSON contract.
          delete arg.autoIncrement;
        });
      });

    registerFieldInputIncrementPolicy(
      blockType,
      hasExplicitPolicy ? incrementableFields : null,
    );
  }

  loadLibToolbox(toolboxItem) {
    // 检查是否已存在相同的toolboxItem
    const existingIndex = this.findToolboxItemIndex(toolboxItem);
    if (existingIndex !== -1) {
      const existingItem = this.toolbox.contents[existingIndex];
      if ((existingItem as any)?.ailyLibraryLoadFailed !== true) {
        return;
      }
      this.toolbox.contents.splice(existingIndex, 1, toolboxItem);
    } else {
      this.toolbox.contents.push(toolboxItem);
    }

    this.ensureToolboxItemIds(this.toolbox.contents);
    this.applyToolboxSortOrderToContents(this.toolbox.contents);
    if (!this.rebuildingLibraryRuntime) {
      this.refreshToolboxFromContents();
    }
  }

  async rebuildLibraryRuntimeInPlace(options: BlocklyLibraryRuntimeRebuildOptions): Promise<void> {
    this.assertWorkspaceEditAvailable();
    if (this.rebuildingLibraryRuntime) {
      throw new Error('Blockly library runtime rebuild is already in progress');
    }

    const projectDocument = this.getProjectDocument();
    this.hideChaff(true);
    this.rebuildingLibraryRuntime = true;

    try {
      // Replacing the iframe restores the host Blockly checkpoint first. The
      // workspace DOM stays mounted; only the project-owned library layer is
      // registered again from the dependencies that still exist on disk.
      this.generatorRuntime.rebuild({
        projectPath: options.projectPath,
        packageJson: options.packageJson,
        boardConfig: this.boardConfig,
        projectService: options.projectService,
      });
      this.failedLibraryLoads.clear();
      this.clearLoadedLibraryStateForRuntimeRebuild();

      for (const libraryName of options.libraryNames) {
        await this.loadLibrary(libraryName, options.projectPath);
      }

      const missingBlockTypes = this.collectBlockTypesFromProjectDocument(projectDocument)
        .filter((blockType) => typeof Blockly.Blocks[blockType]?.init !== 'function');
      if (missingBlockTypes.length > 0) {
        throw new Error(
          '[BlocklyLibraryRuntime] project block definitions are not ready: '
          + missingBlockTypes.join(', '),
        );
      }

      this.refreshToolboxFromContents();
      // Recreate block instances so extensions/callbacks owned by the old
      // iframe Realm cannot survive through the in-place runtime swap.
      this.loadProjectDocument(projectDocument, false);
      this.generatorRuntime.markReady(options.projectPath);
      this.requestCodeViewerRefresh(true);
    } finally {
      this.rebuildingLibraryRuntime = false;
    }
  }

  private clearLoadedLibraryStateForRuntimeRebuild(preserveLoadTasks = false): void {
    this.declarativeBlocks.clear();
    unregisterProjectDataFieldSlots(Array.from(this.blockTypeToLibMap.keys()));
    this.iconsMap.clear();
    this.blockDefinitionsMap.clear();
    this.loadedGenerators.clear();
    this.loadedLibraries.clear();
    this.loadedLibraryInfos.clear();
    this.runtimeDefinedLibraryBlockTypes.clear();
    if (!preserveLoadTasks) this.libraryLoadTasks.clear();
    this.libraryIntegrityFailureLogSignatures.clear();
    this.libraryIntegrityWarningLogSignatures.clear();
    this.blockTypeToLibMap.clear();
    this.toolbox = {
      kind: 'categoryToolbox',
      contents: [{
        kind: 'search',
        name: 'Search',
        contents: [],
      }],
    };
  }

  syncSerialDynamicToolboxBlocks(workspace: Blockly.WorkspaceSvg | null = this._workspace): void {
    if (!workspace) {
      return;
    }

    this.generatorRuntime.invokeGlobal('ensureSerialToolboxListener', workspace);
    this.generatorRuntime.invokeGlobal('loadExistingSerialBlockToToolbox', workspace);
  }

  snapshotSerialFieldValues(): Map<string, string> {
    const snapshots = new Map<string, string>();
    const workspace = this._workspace;
    if (!workspace) {
      return snapshots;
    }

    workspace.getAllBlocks(false).forEach((block) => {
      const field = block.getField?.('SERIAL');
      if (field) {
        snapshots.set(block.id, String(field.getValue() ?? ''));
      }
    });
    return snapshots;
  }

  applySerialPortFieldsAfterCdcDisabled(
    cdcSerialPort: Array<[string, string]>,
    snapshots: Map<string, string>,
  ): void {
    const workspace = this._workspace;
    if (!workspace || snapshots.size === 0) {
      return;
    }

    const apply = () => {
      snapshots.forEach((snapshotValue, blockId) => {
        const block = workspace.getBlockById(blockId);
        if (!block) {
          return;
        }

        const field = block.getField?.('SERIAL');
        if (!field) {
          return;
        }

        const targetValue = resolveSerialPortValueAfterCdcDisabled(snapshotValue, cdcSerialPort);
        if (!targetValue) {
          return;
        }

        try {
          field.setValue(targetValue);
          block.render();
        } catch {
          // ignore invalid dropdown value
        }
      });
    };

    apply();
    setTimeout(apply, 150);
  }

  refreshBoardDependentBlockDefinitions(): void {
    for (const [libPackagePath, libraryInfo] of this.loadedLibraryInfos.entries()) {
      const blockJsonPath = this.electronService.pathJoin(libPackagePath, 'block.json');
      if (!this.electronService.exists(blockJsonPath)) {
        continue;
      }

      try {
        let blocks = JSON.parse(this.electronService.readFile(blockJsonPath));
        const i18nFilePath = this.electronService.pathJoin(
          libPackagePath,
          'i18n',
          `${this.translateService.currentLang}.json`,
        );
        if (this.electronService.exists(i18nFilePath)) {
          const i18nData = JSON.parse(this.electronService.readFile(i18nFilePath));
          blocks = processI18n(blocks, i18nData);
        }

        const staticPath = this.electronService.exists(this.electronService.pathJoin(libPackagePath, 'static'))
          ? this.electronService.pathJoin(libPackagePath, 'static')
          : null;
        const libVersion = libraryInfo.packageName
          ? (() => {
            try {
              const pkg = JSON.parse(this.electronService.readFile(this.electronService.pathJoin(libPackagePath, 'package.json')));
              return pkg.version || '';
            } catch {
              return '';
            }
          })()
          : '';

        this.loadLibBlocks(blocks, staticPath, libraryInfo.packageName, libVersion);
      } catch (error) {
        console.warn('[BlocklyService] failed to refresh board-dependent blocks:', libPackagePath, error);
      }
    }
  }

  private attachLibraryMetadataToToolbox(
    toolboxItem: any,
    libraryName: string,
    libraryPath: string,
    isLocalLibrary: boolean,
    libraryLoadFailed = false,
  ) {
    if (!toolboxItem || typeof toolboxItem !== 'object') {
      return;
    }

    if (toolboxItem.kind === 'category') {
      toolboxItem.ailyLibraryName = libraryName;
      toolboxItem.ailyLibraryPath = libraryPath;
      toolboxItem.ailyIsLocalLibrary = isLocalLibrary;
      toolboxItem.ailyLibraryLoadFailed = libraryLoadFailed;
    }

    if (Array.isArray(toolboxItem.contents)) {
      toolboxItem.contents.forEach((child: any) => this.attachLibraryMetadataToToolbox(
        child,
        libraryName,
        libraryPath,
        isLocalLibrary,
        libraryLoadFailed,
      ));
    }
  }

  // 通过库路径检查库是否被当前项目使用（适用于常规加载库的场景）
  isLibraryUsedByCurrentProject(libPackagePath: string): boolean {
    if (!libPackagePath) {
      return false;
    }

    const libBlockPath = this.electronService.pathJoin(libPackagePath, 'block.json');
    if (!this.electronService.exists(libBlockPath)) {
      return false;
    }

    try {
      const blocksData = JSON.parse(this.electronService.readFile(libBlockPath));
      const libraryBlockTypes = Array.isArray(blocksData)
        ? blocksData
          .map((block: any) => block?.type)
          .filter((blockType): blockType is string => typeof blockType === 'string' && blockType.length > 0)
        : [];
      if (libraryBlockTypes.length === 0) {
        return false;
      }

      const usedBlockTypes = new Set(this.collectBlockTypesFromProjectDocument(this.getProjectDocument()));
      return libraryBlockTypes.some((blockType) => usedBlockTypes.has(blockType));
    } catch (error) {
      console.error('检查库使用情况失败:', libPackagePath, error);
      return false;
    }
  }

  // 通过包名检查库是否被当前项目使用（适用于跨实例复制粘贴时携带库元信息的场景）
  isLibraryPackageNameUsedByCurrentProject(packageName: string): boolean {
    if (!packageName) {
      return false;
    }

    const blockTypes = Array.from(this.blockTypeToLibMap.entries())
      .filter(([, lib]) => lib?.name === packageName)
      .map(([blockType]) => blockType);

    if (blockTypes.length === 0) {
      return false;
    }

    const usedBlockTypes = new Set(this.collectBlockTypesFromProjectDocument(this.getProjectDocument()));
    return blockTypes.some((blockType) => usedBlockTypes.has(blockType));
  }

  loadLibGenerator(filePath): Promise<boolean> {
    this.assertWorkspaceEditAvailable();
    if (this.loadedGenerators.has(filePath)) {
      console.warn(`Generator ${filePath} 已加载,跳过重复加载`);
      return Promise.resolve(true);
    }

    this.pageReferenceContracts.clear();
    return this.loadGeneratorWithContracts(filePath);
  }

  private async loadGeneratorWithContracts(filePath: string): Promise<boolean> {
    const owner = this.generatorRuntime.getActiveGenerator();
    try {
      const source = this.electronService.readFile(filePath);
      this.projectCodePreparation.clear();
      // Runtime 已按项目模式隔离全局；这里统一登记当前 Python 或 Arduino 脚本实际注册的块。
      const result = this.generatorRuntime.loadGenerator(filePath, source);
      await result.contractsReady;
      if (this.generatorRuntime.getActiveGenerator() !== owner) return false;
      const registered = Array.from(new Set([
        ...result.arduinoBlockTypes,
        ...result.micropythonBlockTypes,
        ...result.pythonBlockTypes,
      ]));
      this.loadedGenerators.set(filePath, new Set(registered));
      return true;
    } catch (error) {
      console.error(`Generator loading failed: ${filePath}`, error);
      // Keep the failed session context for recoverLibraryRuntime, which
      // replaces the tainted realm and reloads the other libraries.
      throw error;
    }
  }

  // 查找toolbox项在contents数组中的索引
  findToolboxItemIndex(toolboxItem) {
    if (toolboxItem?.ailyLibraryPath) {
      return this.toolbox.contents.findIndex((item) =>
        (item as any)?.ailyLibraryPath === toolboxItem.ailyLibraryPath,
      );
    }

    for (let i = 0; i < this.toolbox.contents.length; i++) {
      const item = this.toolbox.contents[i];
      // 使用name、categoryId等属性进行匹配
      if (item.name === toolboxItem.name && item.kind == toolboxItem.kind) {
        return i;
      }
    }
    return -1;
  }

  reset() {
    this.declarativeBlocks.clear();
    console.log('开始重置 BlocklyService...');

    // Workspace dispose may call project-defined callbacks, so it must happen
    // before the iframe and host registry snapshot are released.
    if (this.workspace) {
      this.workspace.dispose();
      this.workspace = null;
    }
    this.generatorRuntime.destroy();
    this.failedLibraryLoads.clear();
    this.libraryLoadEpoch += 1;
    this.libraryLoadQueue = Promise.resolve();

    unregisterProjectDataFieldSlots(Array.from(this.blockTypeToLibMap.keys()));
    this.iconsMap.clear();
    this.blockDefinitionsMap.clear();
    this.loadedGenerators.clear();
    this.loadedLibraries.clear();
    this.loadedLibraryInfos.clear();
    this.runtimeDefinedLibraryBlockTypes.clear();
    this.libraryLoadTasks.clear();
    this.libraryIntegrityFailureLogSignatures.clear();
    this.libraryIntegrityWarningLogSignatures.clear();
    this.blockTypeToLibMap.clear();
    this.nativeToolboxElement = null;
    this.externalToolboxHost = null;

    // 移除所有加载的脚本标签（block.js 和 generator.js）
    const scripts = document.getElementsByTagName('script');
    const scriptSrcsToRemove = [];

    for (let i = 0; i < scripts.length; i++) {
      const scriptSrc = scripts[i].src;
      const dataPath = scripts[i].getAttribute('data-generator-path');
      // 检查脚本是否是库相关的
      if (scriptSrc.includes('/block.js') || scriptSrc.includes('/generator.js') || dataPath) {
        scriptSrcsToRemove.push(scripts[i]);
      }
    }

    // 移除已标记的脚本标签
    scriptSrcsToRemove.forEach(script => {
      if (script.parentNode) {
        script.parentNode.removeChild(script);
      }
    });
    console.log(`移除了 ${scriptSrcsToRemove.length} 个脚本标签`);

    // 清理生成器函数
    const generatorTypes = ['Arduino', 'Python', 'JavaScript', 'Dart', 'Lua', 'PHP'];
    generatorTypes.forEach(type => {
      if ((Blockly as any)[type]) {
        const keysToDelete = Object.keys((Blockly as any)[type]).filter(key =>
          typeof (Blockly as any)[type][key] === 'function' &&
          !key.startsWith('init') && // 保留init等系统方法
          !key.startsWith('finish')
        );
        keysToDelete.forEach(key => {
          delete (Blockly as any)[type][key];
        });
        console.log(`清理了 ${type} 的 ${keysToDelete.length} 个generator函数`);
      }
    });

    // 重置工具箱
    this.toolbox = {
      kind: 'categoryToolbox',
      contents: [{
        'kind': 'search',
        'name': 'Search',
        'contents': [],
      }],
    };

    // 重置其他可能的状态
    this.generatedCodeRevision = -1;
    this.latestGeneratedCode = '';
    this.codeSubject.next('');
    this.selectedBlockSubject.next(null);
    this.selectedBlockIdsSubject.next([]);
    this.debugExecutionMarkerSubject.next(null);
    this.blockCodeMapSubject.next(new Map());
    this.absContext = undefined;
    this.closeWorkspaceBlockSearch();
    this.resetDocumentState();
    this.toolboxSearchQuerySubject.next('');
    this.toolboxSelectedKeySubject.next(null);
    this.toolboxSortOrder = [];
    this.rebuildToolboxFacade();

    // console.log('BlocklyService 重置完成');
  }

  getRuntimeBlockMetadataSnapshot(): { blocks: RuntimeBlockMetadata[]; failures: string[] } {
    const workspace = new Blockly.Workspace();
    const blocks: RuntimeBlockMetadata[] = [];
    const failures: string[] = [];

    try {
      for (const type of Array.from(this.runtimeDefinedLibraryBlockTypes).sort()) {
        const library = this.blockTypeToLibMap.get(type)?.name;
        if (!library || typeof Blockly.Blocks?.[type]?.init !== 'function') {
          continue;
        }
        try {
          const block = workspace.newBlock(type);
          try {
            blocks.push(serializeRuntimeBlockMetadata(type, library, block));
          } finally {
            block.dispose(false);
          }
        } catch (error) {
          failures.push(`${type}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } finally {
      workspace.dispose();
    }

    return { blocks, failures };
  }

  getWorkspaceJson() {
    if (this.workspace) {
      captureCustomFunctionRegistration(Blockly.Blocks)?.prepareSerialization(this.workspace);
      return Blockly.serialization.workspaces.save(this.workspace);
    }

    return composeBlocklyPage(this.getStoredProjectDocument(), this.activePageIdSubject.value);
  }

  collectBlockTypesFromProjectDocument(document: BlocklyProjectDocument): string[] {
    const blockTypes = new Set<string>();

    for (const page of document.pages || []) {
      this.collectBlockTypesFromWorkspaceContent(page?.content, blockTypes);
    }

    for (const block of document.sharedModel?.procedureBlocks || []) {
      this.collectBlockTypesFromBlock(block, blockTypes);
    }

    return Array.from(blockTypes).sort();
  }

  private collectBlockTypesFromWorkspaceContent(content: any, blockTypes: Set<string>) {
    const workspaceJson = normalizeBlocklyWorkspace(content);
    const blocks = Array.isArray(workspaceJson.blocks?.blocks) ? workspaceJson.blocks.blocks : [];
    for (const block of blocks) {
      this.collectBlockTypesFromBlock(block, blockTypes);
    }
  }

  private collectBlockTypesFromBlock(block: any, blockTypes: Set<string>) {
    const pending = [block];
    while (pending.length) {
      const current = pending.pop();
      if (!current || typeof current !== 'object') continue;
      if (typeof current.type === 'string' && current.type.length > 0) {
        blockTypes.add(current.type);
      }
      pending.push(current.next?.block);
      for (const input of Object.values(current.inputs || {}) as any[]) {
        pending.push(input?.block, input?.shadow);
      }
    }
  }

  private getPackageDependencySpec(packageJson: any, packageName: string): string {
    const dependencySpec = packageJson?.dependencies?.[packageName]
      ?? packageJson?.devDependencies?.[packageName]
      ?? '';
    return typeof dependencySpec === 'string' ? dependencySpec : String(dependencySpec || '');
  }

  private resolveFileDependencyPath(projectPath: string, dependencySpec: string): string | undefined {
    if (!dependencySpec.startsWith('file:')) {
      return undefined;
    }

    const filePath = dependencySpec.slice(5);
    if (!filePath) {
      return undefined;
    }

    if (window['path']?.isAbsolute?.(filePath)) {
      return filePath;
    }

    return this.electronService.pathJoin(projectPath, filePath);
  }

  private isSameUsedLibraryManifestEntry(previousEntry: any, nextEntry: BlocklyUsedLibraryManifestEntry): boolean {
    if (!previousEntry || typeof previousEntry !== 'object') {
      return false;
    }

    const previousBlockTypes = Array.isArray(previousEntry.blockTypes)
      ? previousEntry.blockTypes.filter((blockType: any): blockType is string => typeof blockType === 'string').sort()
      : [];

    return String(previousEntry.version || '') === nextEntry.version
      && String(previousEntry.localPath || '') === String(nextEntry.localPath || '')
      && JSON.stringify(previousBlockTypes) === JSON.stringify(nextEntry.blockTypes);
  }

  private mountExternalToolbox() {
    if (!this.nativeToolboxElement && this.workspace) {
      const injectionDiv = (this.workspace as any).getInjectionDiv?.() as HTMLElement | undefined;
      const currentNativeToolbox = injectionDiv?.querySelector<HTMLElement>('.blocklyToolboxDiv') || null;
      if (currentNativeToolbox) {
        this.nativeToolboxElement = currentNativeToolbox;
      }
    }

    if (!this.externalToolboxHost || !this.nativeToolboxElement) {
      return;
    }

    if (this.externalToolboxHost.firstElementChild !== this.nativeToolboxElement) {
      this.externalToolboxHost.replaceChildren(this.nativeToolboxElement);
    }
  }

  private resetDocumentState() {
    this.projectCodePreparation.clear();
    this.documentMetadata = {};
    const initialPage = this.createEmptyPageSnapshot('page-1', this.buildDefaultPageTitle(1));
    this.pagesSubject.next([initialPage]);
    this.activePageIdSubject.next(initialPage.id);
    this.openedPageIdsSubject.next([initialPage.id]);
    this.sharedModelSubject.next({ procedureBlocks: [] });
  }

  private buildDefaultPageTitle(index: number): string {
    return `页面 ${index}`;
  }

  private rebuildToolboxFacade() {
    this.ensureToolboxItemIds(this.toolbox.contents);

    const facadeItems = this.toolbox.contents
      .map((item: any, position: number) => this.mapToolboxItemToFacade(item, position, 0, null))
      .filter((item): item is BlocklyToolboxFacadeItem => !!item);

    this.toolboxFacadeItemsSubject.next(facadeItems);
    this.rebuildToolboxSearchIndex();
  }

  private mapToolboxItemToFacade(
    item: any,
    position: number,
    level: number,
    parentKey: string | null,
  ): BlocklyToolboxFacadeItem | null {
    if (!item?.kind || item.kind === 'search') {
      return null;
    }

    if (item.kind !== 'category') {
      return null;
    }

    const childCategories = Array.isArray(item.contents)
      ? item.contents
        .map((child: any, childIndex: number) => this.mapToolboxItemToFacade(child, childIndex, level + 1, item.toolboxitemid || null))
        .filter((child): child is BlocklyToolboxFacadeItem => !!child)
      : [];
    const isCollapsible = childCategories.length > 0;

    return {
      key: item.toolboxitemid || item.categoryId || `${item.kind}:${item.name}`,
      sortKey: this.getToolboxItemSortKey(item),
      name: item.name || '',
      kind: item.kind,
      iconClass: item.icon || 'fa-light fa-cube',
      selectable: true,
      toolboxItemId: item.toolboxitemid || item.categoryId || `${item.kind}:${item.name}`,
      libraryName: item.ailyLibraryName || null,
      libraryPath: item.ailyLibraryPath || null,
      isLocalLibrary: item.ailyIsLocalLibrary === true,
      libraryLoadFailed: item.ailyLibraryLoadFailed === true,
      parentKey,
      level,
      expanded: this.normalizeToolboxExpandedState(item.expanded, false),
      isCollapsible,
      children: childCategories,
    };
  }

  private normalizeToolboxExpandedState(expanded: any, fallback = false): boolean {
    if (typeof expanded === 'boolean') {
      return expanded;
    }

    if (typeof expanded === 'string') {
      return expanded === 'true';
    }

    return fallback;
  }

  private ensureToolboxItemIds(items: any[], path: number[] = []) {
    items.forEach((item: any, index: number) => {
      if (!item || item.kind !== 'category') {
        return;
      }

      if (!item.toolboxitemid) {
        item.toolboxitemid = this.buildToolboxItemId([...path, index], item.name);
      }

      if (Array.isArray(item.contents)) {
        this.ensureToolboxItemIds(item.contents, [...path, index]);
      }
    });
  }

  private buildToolboxItemId(path: number[], name?: string): string {
    const safeName = (name || 'category')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'category';
    return `toolbox-item-${path.join('-')}-${safeName}`;
  }

  private refreshToolboxFromContents() {
    this.ensureToolboxItemIds(this.toolbox.contents);
    if (this.workspace) {
      this.workspace.updateToolbox(this.toolbox);
    }
    this.rebuildToolboxFacade();
    this.syncToolboxFacadeWithWorkspace();
  }

  private isSortableToolboxCategory(item: any): boolean {
    return !!item && item.kind === 'category';
  }

  private hasToolboxCategories(items: any[]): boolean {
    return Array.isArray(items) && items.some((item) => this.isSortableToolboxCategory(item));
  }

  private getToolboxItemSortKey(item: any): string {
    if (typeof item?.ailyLibraryName === 'string' && item.ailyLibraryName) {
      return item.ailyLibraryName;
    }

    if (typeof item?.categoryId === 'string' && item.categoryId) {
      return `category:${item.categoryId}`;
    }

    if (typeof item?.toolboxitemid === 'string' && item.toolboxitemid) {
      return `toolboxitemid:${item.toolboxitemid}`;
    }

    return `category-name:${item?.name || ''}`;
  }

  private applyToolboxSortOrderToContents(items: any[]) {
    if (!Array.isArray(items) || !this.toolboxSortOrder.length) {
      return;
    }

    const orderIndex = new Map(this.toolboxSortOrder.map((key, index) => [key, index]));
    const sortedCategories = items
      .filter((item) => this.isSortableToolboxCategory(item))
      .sort((a, b) => {
        const aIndex = orderIndex.has(this.getToolboxItemSortKey(a)) ? orderIndex.get(this.getToolboxItemSortKey(a))! : Number.MAX_SAFE_INTEGER;
        const bIndex = orderIndex.has(this.getToolboxItemSortKey(b)) ? orderIndex.get(this.getToolboxItemSortKey(b))! : Number.MAX_SAFE_INTEGER;
        return aIndex - bIndex;
      });

    let categoryIndex = 0;
    items.forEach((item, index) => {
      if (this.isSortableToolboxCategory(item)) {
        items[index] = sortedCategories[categoryIndex++];
      }
    });

  }

  private findToolboxFacadeItemByKey(itemKey: string, items = this.toolboxFacadeItemsSubject.value): BlocklyToolboxFacadeItem | null {
    for (const item of items) {
      if (item.key === itemKey) {
        return item;
      }

      const childMatch = this.findToolboxFacadeItemByKey(itemKey, item.children);
      if (childMatch) {
        return childMatch;
      }
    }

    return null;
  }

  private findToolboxFacadeItemByToolboxItemId(toolboxItemId: string, items = this.toolboxFacadeItemsSubject.value): BlocklyToolboxFacadeItem | null {
    if (!toolboxItemId) {
      return null;
    }

    for (const item of items) {
      if (item.toolboxItemId === toolboxItemId) {
        return item;
      }

      const childMatch = this.findToolboxFacadeItemByToolboxItemId(toolboxItemId, item.children);
      if (childMatch) {
        return childMatch;
      }
    }

    return null;
  }

  private findToolboxFacadeItemByName(name: string, items = this.toolboxFacadeItemsSubject.value): BlocklyToolboxFacadeItem | null {
    if (!name) {
      return null;
    }

    for (const item of items) {
      if (item.name === name) {
        return item;
      }

      const childMatch = this.findToolboxFacadeItemByName(name, item.children);
      if (childMatch) {
        return childMatch;
      }
    }

    return null;
  }

  private updateToolboxCategoryExpandedState(toolboxItemId: string, expanded: boolean): boolean {
    let hasChanged = false;

    const visit = (items: any[]) => {
      items.forEach((item) => {
        if (!item || item.kind !== 'category') {
          return;
        }

        if (item.toolboxitemid === toolboxItemId) {
          const currentExpanded = this.normalizeToolboxExpandedState(item.expanded, false);
          if (currentExpanded !== expanded) {
            item.expanded = expanded;
            hasChanged = true;
          }
          return;
        }

        if (Array.isArray(item.contents)) {
          visit(item.contents);
        }
      });
    };

    visit(this.toolbox.contents);
    return hasChanged;
  }

  private expandToolboxAncestors(itemKey: string) {
    let currentItem = this.findToolboxFacadeItemByKey(itemKey);
    let hasChanged = false;

    while (currentItem?.parentKey) {
      const parentItem = this.findToolboxFacadeItemByKey(currentItem.parentKey);
      if (!parentItem) {
        break;
      }

      hasChanged = this.updateToolboxCategoryExpandedState(parentItem.toolboxItemId, true) || hasChanged;
      currentItem = parentItem;
    }

    if (hasChanged) {
      this.rebuildToolboxFacade();
    }
  }

  private getNativeToolbox(): Blockly.Toolbox | null {
    return (this.workspace?.getToolbox() as Blockly.Toolbox | undefined) || null;
  }

  private getNativeToolboxItem(toolboxItemId: string) {
    return (this.getNativeToolbox() as any)?.getToolboxItemById?.(toolboxItemId) || null;
  }

  private expandNativeToolboxAncestors(toolboxItem: any) {
    let currentParent = toolboxItem?.getParent?.();
    while (currentParent) {
      if (currentParent.isCollapsible?.() && !currentParent.isExpanded?.()) {
        currentParent.setExpanded?.(true);
      }
      currentParent = currentParent.getParent?.();
    }
  }

  private rebuildToolboxSearchIndex() {
    this.blockSearcher = new BlockSearcher();
    const availableBlocks = new Set<string>();

    this.toolbox.contents.forEach((item: any) => {
      this.collectToolboxBlocks(item, availableBlocks);
    });

    this.blockSearcher.indexBlocks([...availableBlocks]);
  }

  private collectToolboxBlocks(schema: any, availableBlocks: Set<string>) {
    if (!schema) {
      return;
    }

    if (Array.isArray(schema.contents)) {
      schema.contents.forEach((item: any) => this.collectToolboxBlocks(item, availableBlocks));
      return;
    }

    if (typeof schema.kind === 'string' && schema.kind.toLowerCase() === 'block' && schema.type) {
      availableBlocks.add(schema.type);
    }
  }

  private showSearchFlyout(markSelected = true) {
    const flyout = this.workspace?.getFlyout();
    if (!flyout) {
      return;
    }

    const query = this.toolboxSearchQuerySubject.value.trim();
    if (!query) {
      this.clearToolboxSelection();
      return;
    }

    const toolbox = this.workspace?.getToolbox();
    toolbox?.clearSelection();

    const blockTypes = this.blockSearcher.blockTypesMatching(query);
    const flyoutDef = blockTypes.length
      ? blockTypes.map((blockType) => ({
        kind: 'block',
        type: blockType,
      }))
      : [{
        kind: 'label',
        text: 'No matching blocks found',
      }];

    flyout.show(flyoutDef as any);
    if (markSelected) {
      this.toolboxSelectedKeySubject.next(this.toolboxSearchKey);
    }
  }

  private createEmptyPageSnapshot(id = this.generatePageId(), title = this.buildDefaultPageTitle(1)): BlocklyPageSnapshot {
    return {
      id,
      title,
      content: this.createEmptyWorkspaceContent(),
      viewState: this.createDefaultViewState(),
    };
  }

  private createEmptyWorkspaceContent(): any {
    return {
      blocks: {
        languageVersion: 0,
        blocks: [],
      },
    };
  }

  private createDefaultViewState(): BlocklyWorkspaceViewState {
    return {
      scale: 1,
      scrollX: 0,
      scrollY: 0,
    };
  }

  private generatePageId(): string {
    return `page-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  private normalizeProjectDocument(jsonData: any): BlocklyProjectDocument {
    const role = captureBlocklyRootClassifier(null, Blockly.Blocks);
    if (Array.isArray(jsonData?.pages)) {
      const pages = jsonData.pages.length
        ? jsonData.pages.map((page, index) => this.normalizePageSnapshot(page, index))
        : [this.createEmptyPageSnapshot('page-1', this.buildDefaultPageTitle(1))];
      const activePageId = pages.some(page => page.id === jsonData.activePageId) ? jsonData.activePageId : pages[0].id;
      return normalizeBlocklyOwnership({
        ...jsonData,
        schemaVersion: this.projectDocumentSchemaVersion,
        activePageId,
        openedPageIds: this.normalizeOpenedPageIds(jsonData.openedPageIds, pages, activePageId),
        pages,
        sharedModel: { ...jsonData.sharedModel, procedureBlocks: jsonData.sharedModel?.procedureBlocks ?? [] },
      }, role);
    }
    const page = this.createEmptyPageSnapshot('page-1', this.buildDefaultPageTitle(1));
    page.content = normalizeBlocklyWorkspace(jsonData);
    // The schema marker belongs to the document, not a workspace serializer.
    delete page.content.$ailyProjectData;
    return normalizeBlocklyOwnership({
      schemaVersion: this.projectDocumentSchemaVersion,
      activePageId: page.id, openedPageIds: [page.id], pages: [page],
      sharedModel: { procedureBlocks: [] },
    }, role);
  }

  private normalizeOpenedPageIds(openedPageIds: any, pages: BlocklyPageSnapshot[], activePageId: string): string[] {
    const normalizedOpenedIds = new Set(Array.isArray(openedPageIds) ? openedPageIds : []);
    normalizedOpenedIds.add(activePageId);

    const pageIds = new Set(pages.map((page) => page.id));
    const nextOpenedPageIds = pages
      .map((page) => page.id)
      .filter((pageId) => pageIds.has(pageId) && normalizedOpenedIds.has(pageId));

    return nextOpenedPageIds.length ? nextOpenedPageIds : [activePageId];
  }

  private normalizePageSnapshot(page: any, index: number): BlocklyPageSnapshot {
    return {
      ...page,
      id: page?.id || this.generatePageId(),
      title: page?.title || this.buildDefaultPageTitle(index + 1),
      content: normalizeBlocklyWorkspace(page?.content),
      viewState: page?.viewState || this.createDefaultViewState(),
    };
  }

  private applyProjectDocument(document: BlocklyProjectDocument, clone = true) {
    const { pages, activePageId, openedPageIds, sharedModel, schemaVersion, ...metadata } = document;
    this.documentMetadata = this.cloneJson(metadata);
    this.pagesSubject.next(clone ? this.cloneJson(pages) : pages);
    this.activePageIdSubject.next(activePageId);
    this.openedPageIdsSubject.next(clone ? this.cloneJson(openedPageIds) : openedPageIds);
    this.sharedModelSubject.next(clone ? this.cloneJson(sharedModel) : sharedModel);
  }

  private persistActiveWorkspaceToState(owner?: BlocklyWorkspaceEditLease) {
    if (this.workspace && this.activePageIdSubject.value) {
      const document = this.getProjectDocument(owner);
      this.capturePageReferenceContract(document, owner);
      this.applyProjectDocument(document, false);
    }
  }

  private synchronizeReferenceContractScope(): void {
    this.pageReferenceContracts.setScope(this.workspace, getActiveProjectGenerator(), projectDataRuntime.getSessionToken());
  }

  private capturePageReferenceContract(document: BlocklyProjectDocument, owner?: BlocklyWorkspaceEditLease): void {
    this.synchronizeReferenceContractScope();
    const workspace = this.workspace;
    const generator = getActiveProjectGenerator();
    const dataSession = projectDataRuntime.getSessionToken();
    const pageId = document.activePageId;
    const contractRevision = this.pageReferenceContracts.revision;
    const storedState = JSON.stringify(this.getStoredProjectDocument());
    this.pageReferenceContracts.forget(pageId);
    const assertCurrent = () => {
      this.assertWorkspaceEditAvailable(owner);
      if (workspace !== this.workspace || generator !== getActiveProjectGenerator()
        || dataSession !== projectDataRuntime.getSessionToken() || pageId !== this.getActivePageId()
        || contractRevision !== this.pageReferenceContracts.revision) {
        throw new Error('Reference contract capture belongs to a stale project/page/runtime.');
      }
    };
    try {
      const contract = captureAbsPageReferenceContract(workspace, composeBlocklyPage(document, pageId), assertCurrent, this.captureDeclarativeBlockDefinitions());
      assertCurrent();
      this.pageReferenceContracts.remember(document, pageId, contract);
    } catch (error) {
      // Unknown library protocols must not block ordinary page editing/opening.
      // No evidence is retained; shared-model ABS edits will still fail closed.
      assertCurrent();
      if ((error as any)?.code === 'ABS_REFERENCE_CAPTURE_CHANGED') throw error;
    } finally {
      if (storedState !== JSON.stringify(this.getStoredProjectDocument())) {
        if (contractRevision === this.pageReferenceContracts.revision) this.pageReferenceContracts.forget(pageId);
        throw new Error('Project metadata changed during reference capture; stopped publishing the older snapshot.');
      }
    }
  }

  private captureWorkspaceViewState(): BlocklyWorkspaceViewState {
    if (!this.workspace) {
      return this.createDefaultViewState();
    }

    return normalizeBlocklyViewState({
      scale: this.workspace.scale || 1,
      scrollX: this.workspace.scrollX || 0,
      scrollY: this.workspace.scrollY || 0,
    });
  }

  private loadActivePageIntoWorkspace(owner?: BlocklyWorkspaceEditLease, rootOrder?: readonly string[]) {
    const activePage = this.getActivePage();
    if (!activePage || !this.workspace) {
      return;
    }

    const workspaceJson = composeBlocklyPage(this.getStoredProjectDocument(), activePage.id);
    if (rootOrder) {
      // Document ownership groups shared definitions first. A transaction rollback
      // must instead reproduce the captured live root order, without dropping roots.
      const roots = new Map(workspaceJson.blocks.blocks.map(block => [block.id, block]));
      if (rootOrder.length !== roots.size || new Set(rootOrder).size !== roots.size || rootOrder.some(id => !roots.has(id))) {
        throw new Error('Workspace snapshot root identities do not match the restore order.');
      }
      workspaceJson.blocks.blocks = rootOrder.map(id => roots.get(id));
    }
    try {
      Blockly.Events.disable();
      this.workspace.clear();
      this.loadWorkspaceJson(workspaceJson, false, owner);
    } finally {
      // Blockly uses a nesting counter: always release exactly our own disable.
      Blockly.Events.enable();
    }

    this.selectedBlockSubject.next(null);
    this.selectedBlockIdsSubject.next([]);
    this.closeWorkspaceBlockSearch();
    this.restoreWorkspaceViewState(activePage.viewState);
    this.persistActiveWorkspaceToState(owner);
    this.mountExternalToolbox();
    this.loadLibraryFinishedLoadingSubject.next();
    this.requestWorkspaceVisualRefresh();
  }

  private restoreWorkspaceViewState(viewState?: BlocklyWorkspaceViewState) {
    if (!this.workspace || !viewState) {
      return;
    }

    const workspace = this.workspace as any;

    if (typeof workspace.setScale === 'function') {
      workspace.setScale(viewState.scale || 1);
    }

    if (typeof workspace.scroll === 'function') {
      workspace.scroll(viewState.scrollX || 0, viewState.scrollY || 0);
      return;
    }

    workspace.scrollX = viewState.scrollX || 0;
    workspace.scrollY = viewState.scrollY || 0;
  }

  private cloneJson<T>(value: T): T {
    if (value === undefined || value === null) {
      return value;
    }

    return JSON.parse(JSON.stringify(value));
  }

  // 创建变量用
  prompt(message: string, defaultValue: string = '') {
    // const dialogRef = this.dialog.open(PromptDialogComponent, {
    //   width: '300px',
    //   data: { message, defaultValue }
    // });

    // return dialogRef.afterClosed();
  }

  // 检查ai是否在执行会话非block操作
  checkAiWaiting() {
    if (this.aiWriting) {
      return true;
    }
    if (this.aiWaiting) {
      this.aiWaitWriting = true;
      setTimeout(() => {
        if (!this.aiWriting) {
          this.aiWaitWriting = false;
        }
      }, 2000);
    }
    return this.aiWaiting;
  }

  // ==================== Block-to-Code 查询 API ====================

  /**
   * 获取指定 block 对应的代码映射信息
   * @param blockId 块 ID
   * @returns BlockCodeMapping 或 null
   */
  getCodeForBlock(blockId: string): BlockCodeMapping | null {
    const map = this.blockCodeMapSubject.value;
    return map.get(blockId) || null;
  }

  /**
   * 获取指定 block 对应的 C++ 代码片段文本
   * @param blockId 块 ID
   * @returns 代码文本或空字符串
   */
  getCodeSnippetForBlock(blockId: string): string {
    const mapping = this.getCodeForBlock(blockId);
    return mapping?.codeSnippet || '';
  }

  /**
   * 获取指定 block 在代码中的行号范围
   * @param blockId 块 ID
   * @returns 行号范围数组
   */
  getCodeLinesForBlock(blockId: string): CodeLineRange[] {
    const mapping = this.getCodeForBlock(blockId);
    return mapping?.lineRanges || [];
  }

  /**
   * Resolve the most specific Blockly block for a generated source line
   * without changing the user's current Blockly selection.
   */
  getBlockIdByGeneratedLine(line: number): string | null {
    if (!Number.isSafeInteger(line) || line < 1) return null;
    const candidates = [...this.blockCodeMapSubject.value.values()]
      .filter((mapping) => mapping.lineRanges.some(
        (range) => line >= range.startLine && line <= range.endLine,
      ))
      .sort((left, right) => {
        const leftSpan = Math.min(...left.lineRanges.map(
          (range) => range.endLine - range.startLine,
        ));
        const rightSpan = Math.min(...right.lineRanges.map(
          (range) => range.endLine - range.startLine,
        ));
        return leftSpan - rightSpan;
      });
    const blockId = candidates[0]?.blockId;
    return blockId || null;
  }

  private createWorkspaceBlockSearchState(): WorkspaceBlockSearchState {
    return {
      isOpen: false,
      query: '',
      results: [],
      currentIndex: -1,
    };
  }

  private searchWorkspaceBlocks(query: string): WorkspaceBlockSearchResult[] {
    const normalizedQuery = this.normalizeWorkspaceBlockSearchText(query);
    if (!this.workspace || !normalizedQuery) {
      return [];
    }

    return this.workspace.getAllBlocks(false)
      .filter((block) => !block.isInsertionMarker())
      .map((block) => this.buildWorkspaceBlockSearchResult(block, normalizedQuery))
      .filter((result): result is WorkspaceBlockSearchResult => !!result)
      .sort((left, right) => this.workspaceBlockSearchRank(left) - this.workspaceBlockSearchRank(right));
  }

  private buildWorkspaceBlockSearchResult(block: Blockly.Block, normalizedQuery: string): WorkspaceBlockSearchResult | null {
    const codeMapping = this.blockCodeMapSubject.value.get(block.id);
    const fieldsText = this.getWorkspaceBlockFieldsText(block);
    const ownCodeText = this.getWorkspaceBlockOwnCodeSearchText(block, codeMapping);
    const searchableParts: Array<[WorkspaceBlockSearchMatchSource, string]> = [
      ['field', fieldsText],
      ['type', block.type],
      ['code', ownCodeText],
    ];
    const matchedBy = searchableParts
      .filter(([, value]) => this.normalizeWorkspaceBlockSearchText(value).includes(normalizedQuery))
      .map(([source]) => source);

    if (!matchedBy.length) {
      return null;
    }

    return {
      blockId: block.id,
      blockType: block.type,
      displayText: fieldsText || block.type,
      matchedBy,
      codeSnippet: ownCodeText,
    };
  }

  private getWorkspaceBlockOwnCodeSearchText(block: Blockly.Block, codeMapping?: BlockCodeMapping): string {
    if (!codeMapping || this.hasConnectedWorkspaceBlockInput(block)) {
      return '';
    }

    return (codeMapping.fragments || [])
      .map((fragment) => fragment.code || '')
      .map((code) => code.trim())
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  private hasConnectedWorkspaceBlockInput(block: Blockly.Block): boolean {
    return (block.inputList || []).some((input) => !!input.connection?.targetBlock());
  }

  private getWorkspaceBlockFieldsText(block: Blockly.Block): string {
    const values: string[] = [];
    for (const input of block.inputList || []) {
      for (const field of input.fieldRow || []) {
        const getText = (field as { getText?: () => unknown }).getText;
        const getValue = (field as { getValue?: () => unknown }).getValue;
        const text = typeof getText === 'function' ? getText.call(field) : '';
        const value = typeof getValue === 'function' ? getValue.call(field) : '';
        if (text !== null && text !== undefined && text !== '') values.push(String(text));
        if (value !== null && value !== undefined && value !== '' && value !== text) values.push(String(value));
      }
    }
    return values.join(' ');
  }

  private normalizeWorkspaceBlockSearchText(value: unknown): string {
    return String(value ?? '').toLowerCase().trim();
  }

  private workspaceBlockSearchRank(result: WorkspaceBlockSearchResult): number {
    const order: WorkspaceBlockSearchMatchSource[] = ['field', 'type', 'code'];
    return Math.min(...result.matchedBy.map((source) => order.indexOf(source)));
  }

  /**
   * 从工作区同步当前选中的 block 列表（含多选模式）
   */
  syncSelectedBlocksFromWorkspace(): void {
    if (!this.workspace) {
      this.selectedBlockIdsSubject.next([]);
      return;
    }

    const dragSelection = dragSelectionWeakMap.get(this.workspace);
    if (dragSelection?.size) {
      const blockIds = Array.from(dragSelection as Set<string>).filter((id) => {
        const block = this.workspace!.getBlockById(id);
        return block && !block.isInFlyout && !block.isInsertionMarker();
      });
      this.selectedBlockIdsSubject.next(blockIds);
      this.selectedBlockSubject.next(blockIds[0] ?? null);
      return;
    }

    const candidateId = this.selectedBlockSubject.value;
    if (candidateId) {
      const block = this.workspace.getBlockById(candidateId);
      if (block && !block.isInFlyout && !block.isInsertionMarker()) {
        this.selectedBlockIdsSubject.next([candidateId]);
        return;
      }
    }

    const selected = Blockly.common.getSelected();
    if (
      selected &&
      selected instanceof Blockly.BlockSvg &&
      !selected.isInFlyout &&
      !selected.isInsertionMarker()
    ) {
      this.selectedBlockIdsSubject.next([selected.id]);
      this.selectedBlockSubject.next(selected.id);
      return;
    }

    this.selectedBlockIdsSubject.next([]);
    this.selectedBlockSubject.next(null);
  }

  /**
   * 获取指定 block 的上下文信息（供 agent/LLM 使用）
   * 精简格式：块类型 + ABS 代码片段 + C++ 对应行号
   */
  getBlockContext(blockId: string): {
    blockId: string;
    blockType: string;
    absSnippet: string;
    cppLineRange: string;
    absLineRange: string;
    absGeneration?: string;
    codeRanges: CodeLineRange[];
    formatted: string;
  } | null {
    if (!blockId || !this.workspace) return null;

    const block = this.workspace.getBlockById(blockId);
    if (!block) return null;

    const mapping = this.getCodeForBlock(blockId);
    const ranges = mapping?.lineRanges || [];
    const cppLineRange = this._formatCppLineRange(ranges);
    const abs = this.readCommittedAbsContext(block.id);
    const absSnippet = abs?.snippet ?? '当前工作区尚无有效 ABS 映射；请先 abs_export 后按返回的 generation 读取。';
    const absLineRange = abs?.lineRange ?? '无';
    const formatted = this._formatBlockContextForLLM(block.type, absSnippet, cppLineRange, absLineRange, 1, 1, abs?.generation);

    return {
      blockId,
      blockType: block.type,
      absSnippet,
      cppLineRange,
      absLineRange,
      absGeneration: abs?.generation,
      codeRanges: ranges,
      formatted,
    };
  }

  /**
   * 获取当前选中 block 的上下文信息（供 agent/LLM 使用）
   * 精简格式：块类型 + ABS 代码片段 + C++ 对应行号
   */
  getSelectedBlockContext(): {
    blockId: string;
    blockType: string;
    absSnippet: string;
    cppLineRange: string;
    absLineRange: string;
    codeRanges: CodeLineRange[];
    formatted: string;
  } | null {
    const blockId = this.selectedBlockIdsSubject.value[0] ?? this.selectedBlockSubject.value;
    if (!blockId) return null;
    return this.getBlockContext(blockId);
  }

  /**
   * 将 CodeLineRange 数组格式化为简洁的行号范围字符串
   * 例："22-38" / "15" / "无"
   */
  private _formatCppLineRange(ranges: CodeLineRange[]): string {
    if (!ranges || ranges.length === 0) return '无';
    let minLine = Infinity;
    let maxLine = -Infinity;
    for (const r of ranges) {
      if (r.startLine < minLine) minLine = r.startLine;
      if (r.endLine > maxLine) maxLine = r.endLine;
    }
    return minLine === maxLine ? `${minLine}` : `${minLine}-${maxLine}`;
  }

  /** Published only by the canonical coordinator after a complete commit. */
  publishAbsContext(projection: AbsProjection, revision: number, assertCurrent: () => void): void {
    assertCurrent();
    this.absContext = { index: new AbsBlockContextIndex(projection), revision, assertCurrent };
  }

  private readCommittedAbsContext(blockId: string) {
    return this.readCommittedAbsIndex()?.get(blockId);
  }

  /** Advice only, from the same current committed snapshot used by selection context. */
  describeCommittedAbsSyntax(types: readonly string[]) {
    return this.readCommittedAbsIndex()?.describeSyntax(types);
  }

  private readCommittedAbsIndex() {
    const context = this.absContext;
    if (!context || this.isWorkspaceEditBlocked()) return undefined;
    try {
      context.assertCurrent();
      if (context.revision === this.getProjectPersistenceRevision()) return context.index;
    } catch { /* A previous project/page/runtime must never supply selection context. */ }
    this.absContext = undefined;
    return undefined;
  }

  /**
   * 格式化块上下文为 LLM 友好的精简文本
   */
  private _formatBlockContextForLLM(
    blockType: string,
    absSnippet: string,
    cppLineRange: string,
    absLineRange: string,
    index = 1,
    total = 1,
    generation?: string,
  ): string {
    const lines: string[] = [];
    lines.push(total > 1 ? `[用户选中的积木块 ${index}/${total}]` : '[用户选中的积木块]');
    lines.push(`块类型: ${blockType}`);
    lines.push(`ABS代码:`);
    lines.push(truncateAbsContext(absSnippet));
    if (absLineRange !== '无') {
      lines.push(`ABS 基线代次: ${generation}；对应行数: ${absLineRange}（编辑前请核对当前 generation）`);
    }
    lines.push(`对应C++代码行数: ${cppLineRange}`);
    return lines.join('\n');
  }

  getBlockContextLabel(blockId: string, index = 1, total = 1): BlockContextLabel | null {
    const ctx = this.getBlockContext(blockId);
    if (!ctx) return null;

    const parts: string[] = [];
    if (ctx.absLineRange !== '无') parts.push(`A${ctx.absLineRange}`);
    if (ctx.cppLineRange !== '无') parts.push(`C${ctx.cppLineRange}`);

    const suffix = total > 1 ? ` (${index}/${total})` : '';
    const label = parts.length > 0
      ? `blockly:${parts.join('/')}${suffix}`
      : `blockly:${ctx.blockType}${suffix}`;

    const formatted = this._formatBlockContextForLLM(
      ctx.blockType,
      ctx.absSnippet,
      ctx.cppLineRange,
      ctx.absLineRange,
      index,
      total,
      ctx.absGeneration,
    );

    return {
      label,
      formatted,
      blockId: ctx.blockId,
    };
  }

  /**
   * 获取当前所有选中 block 的上下文标签（用于 AI 助手上下文列表展示）
   */
  getSelectedBlockContextLabels(): BlockContextLabel[] {
    const blockIds = this.selectedBlockIdsSubject.value;
    if (!blockIds.length) return [];

    const total = blockIds.length;
    return blockIds
      .map((blockId, index) => this.getBlockContextLabel(blockId, index + 1, total))
      .filter((item): item is BlockContextLabel => !!item);
  }

  /**
   * 获取当前选中block的简短上下文标签（用于AI助手上下文列表展示）
   * 格式：blockly:C10-20（C++行号）或 blockly:A5-12（ABS行号）
   * @returns { label, formatted, blockId } 或 null
   */
  getSelectedBlockContextLabel(): BlockContextLabel | null {
    return this.getSelectedBlockContextLabels()[0] ?? null;
  }
}

export interface LibData {
  name: string;
  blocks?: string;
  generator?: string;
  toolbox?: string;
  json?: any;
  show?: boolean;
}

export interface LibDataBlock {
  inputsInline: boolean;
  message0?: string;
  type?: string;
  args0?: any;
  previousStatement?: any;
  nextStatement?: any;
  colour?: number;
  tooltip?: string;
  helpUrl?: string;
  generator: string;
}

export interface LibDataGenerator {
  code: string;
  macros?: string;
  libraries?: string;
  variables?: string;
  objects?: string;
  functions?: string;
  setups?: string;
  userSetups?: string;
  loop?: string;
  userLoop?: string;
}
