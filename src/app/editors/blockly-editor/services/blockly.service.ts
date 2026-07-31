import { Injectable } from '@angular/core';
import { BehaviorSubject, Subject, debounceTime, filter, firstValueFrom, map, switchMap, take, timer } from 'rxjs';
import * as Blockly from 'blockly';
import { processI18n, processJsonVar, processStaticFilePath, processToolboxI18n, resolveSerialPortValueAfterCdcDisabled } from '../components/blockly/abf';
import { TranslateService } from '@ngx-translate/core';
import { ElectronService } from '../../../services/electron.service';
import { LogService } from '../../../services/log.service';
import { NoticeService } from '../../../services/notice.service';
import { BlocklyLibraryDiagnostics, BlocklyLibraryPackageService, BlocklyLibraryPackageSnapshot } from '../../../services/blockly-library-package.service';
import {
  BlockCodeMapping,
  CodeLineRange,
  normalizeArduinoGeneratedCode,
} from '../components/blockly/generators/arduino/arduino';
import { convertBlockTreeToAbs, convertAbiToAbsWithLineMap } from '../../../tools/aily-chat/public-api';
import { BlockSearcher } from '../components/blockly/plugins/toolbox-search/src/block_searcher';
import { dragSelectionWeakMap } from '../components/blockly/plugins/workspace-multiselect/index.js';
import { exportWorkspaceToSvg } from './workspace-svg-exporter';
import { createProjectDataMarker, isAilyProjectDataMarker } from '../../../services/project-data/project-data.types';
import {
  decorateLibraryBlockDefinitionForProjectData,
  unregisterProjectDataFieldSlots,
} from '../../../services/project-data/blockly-project-data-adapter';
import { BlocklyGeneratorRuntimeService } from './blockly-generator-runtime.service';

export interface BlockContextLabel {
  label: string;
  formatted: string;
  blockId: string;
}

export interface BlocklyWorkspaceViewState {
  scale: number;
  scrollX: number;
  scrollY: number;
}

export interface BlocklySharedModel {
  variables?: any;
  procedureBlocks: any[];
}

export interface BlocklyPageSnapshot {
  id: string;
  title: string;
  content: any;
  viewState?: BlocklyWorkspaceViewState;
}

export interface BlocklyProjectDocument {
  schemaVersion: number;
  activePageId: string;
  openedPageIds: string[];
  pages: BlocklyPageSnapshot[];
  sharedModel: BlocklySharedModel;
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

@Injectable({
  providedIn: 'root'
})
export class BlocklyService {
  private readonly projectDocumentSchemaVersion = 3;
  private readonly sharedProcedureBlockPrefixes = ['procedures_'];
  private readonly toolboxSearchKey = BLOCKLY_TOOLBOX_SEARCH_KEY;

  private _workspace: Blockly.WorkspaceSvg | null = null;
  private workspaceReadySubject = new BehaviorSubject<Blockly.WorkspaceSvg | null>(null);
  private workspaceRenderAfterLoadAnimationFrame: number | null = null;
  private workspaceRenderAfterLoadTimeout: ReturnType<typeof setTimeout> | null = null;

  get workspace(): Blockly.WorkspaceSvg {
    return this._workspace as Blockly.WorkspaceSvg;
  }

  set workspace(workspace: Blockly.WorkspaceSvg | null) {
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
  // 追踪加载的generator脚本和它们注册的函数
  loadedGenerators = new Map<string, Set<string>>(); // filePath -> Set of block types
  // 追踪已加载的库,避免重复加载
  loadedLibraries = new Set<string>(); // libPackagePath
  loadedLibraryInfos = new Map<string, LoadedBlocklyLibraryInfo>(); // libPackagePath -> loaded metadata
  private libraryLoadTasks = new Map<string, Promise<void>>();
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
  /** block → ABS 行号映射（由 abs-auto-sync 生成 ABS 时同步更新，确保与用户看到的 .abs 文件一致） */
  absBlockLineMap = new BehaviorSubject<Map<string, { startLine: number; endLine: number }>>(new Map());
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

  getGeneratedCode(): string {
    return this.latestGeneratedCode || this.codeSubject.value || '';
  }

  getReusableGeneratedCode(): string | null {
    if (this.generatedCodeRevision !== this.workspaceCodeRevision) {
      return null;
    }

    return this.latestGeneratedCode;
  }

  requestCodeViewerRefresh(forceGenerate = false): void {
    this.codeViewerRefreshRequestSubject.next(forceGenerate);
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

  loadProjectDocument(document: BlocklyProjectDocument, cloneState = true) {
    this.applyProjectDocument(document, cloneState);
    this.loadActivePageIntoWorkspace();
  }

  hydrateWorkspaceFromProjectState() {
    this.loadActivePageIntoWorkspace();
  }

  normalizeProjectAbi(jsonData: any): BlocklyProjectDocument {
    return this.normalizeProjectDocument(jsonData);
  }

  normalizeProjectAbiForLoad(jsonData: any): BlocklyProjectDocument {
    if (!isAilyProjectDataMarker(jsonData?.$ailyProjectData)) {
      throw new Error('Unsupported project.abi: missing $ailyProjectData external-only schema marker.');
    }
    return this.normalizeProjectDocument(jsonData, false);
  }

  switchPage(pageId: string): boolean {
    if (!pageId || pageId === this.activePageIdSubject.value) {
      return false;
    }

    this.persistActiveWorkspaceToState();
    this.activePageIdSubject.next(pageId);
    this.loadActivePageIntoWorkspace();
    return true;
  }

  createPage(title?: string): BlocklyPageSnapshot {
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

  getProjectDocument(): BlocklyProjectDocument {
    this.persistActiveWorkspaceToState();

    return {
      schemaVersion: this.projectDocumentSchemaVersion,
      activePageId: this.activePageIdSubject.value,
      openedPageIds: this.cloneJson(this.openedPageIdsSubject.value),
      pages: this.cloneJson(this.pagesSubject.value),
      sharedModel: this.cloneJson(this.sharedModelSubject.value),
    };
  }

  getProjectAbiForSave(document = this.getProjectDocument()): any {
    const payload = document.pages.length === 1
      ? this.composeWorkspacePayload(document.pages[0].content, document.sharedModel)
      : document;
    return {
      ...payload,
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
  loadWorkspaceJson(jsonData: any, clone = true) {
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

    Blockly.serialization.workspaces.load(workspaceJson, this.workspace);
    this.scheduleWorkspaceRenderAfterLoad();
  }

  private scheduleWorkspaceRenderAfterLoad(): void {
    const workspace = this._workspace;
    if (!workspace) {
      return;
    }

    if (this.workspaceRenderAfterLoadAnimationFrame !== null) {
      cancelAnimationFrame(this.workspaceRenderAfterLoadAnimationFrame);
      this.workspaceRenderAfterLoadAnimationFrame = null;
    }
    if (this.workspaceRenderAfterLoadTimeout !== null) {
      clearTimeout(this.workspaceRenderAfterLoadTimeout);
      this.workspaceRenderAfterLoadTimeout = null;
    }

    const renderWorkspace = () => {
      this.workspaceRenderAfterLoadAnimationFrame = null;
      this.workspaceRenderAfterLoadTimeout = null;
      if (this._workspace === workspace) {
        workspace.render();
      }
    };

    if (typeof requestAnimationFrame === 'function') {
      this.workspaceRenderAfterLoadAnimationFrame = requestAnimationFrame(renderWorkspace);
    } else {
      this.workspaceRenderAfterLoadTimeout = setTimeout(renderWorkspace, 0);
    }
  }

  // 通过node_modules加载库
  async loadLibrary(libPackageName, projectPath) {
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

    const loadTask = this.loadLibraryInternal(libPackageName, projectPath, libPackagePath);
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
    const errors = diagnostics.errors.length > 0
      ? diagnostics.errors
      : [`${displayName} 运行时加载失败，请检查 generator.js 是否能正常执行。`];
    const detail = errors.map((error) => `- ${error}`).join('\n');
    this.noticeService.update({
      title: `库加载失败：${displayName}`,
      text: errors[0],
      detail,
      state: 'error',
      showProgress: false,
      setTimeout: 10000,
    });
    return false;
  }

  private async loadLibraryInternal(libPackageName: string, projectPath: string, libPackagePath: string): Promise<void> {
    const librarySnapshot = this.blocklyLibraryPackageService.readLibraryPackage(projectPath, libPackageName);
    const libLocalPath = this.resolveLibraryLocalPath(projectPath, libPackageName);
    // 检查库的完整性
    const integrityCheck = this.checkLibraryIntegrity(librarySnapshot, libPackageName);
    if (!integrityCheck.valid) {
      this.loadFailedLibraryToolbox(librarySnapshot, libPackageName, libPackagePath, !!libLocalPath);
      return;
    }

    let generatorLoadSuccess = true;
    let loadedBlockTypes: string[] = [];
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
          generatorLoadSuccess = await this.loadLibGenerator(generatorFilePath);
          if (!generatorLoadSuccess) {
            throw new Error(`[loadLibrary] generator.js 加载失败: ${libPackageName}`);
          }
        }
        // 替换block中静态图片路径
        const staticFileIsExist = this.electronService.exists(this.electronService.pathJoin(libPackagePath, 'static'));
        this.loadLibBlocks(blocks, staticFileIsExist ? this.electronService.pathJoin(libPackagePath, 'static') : null, libPackageName, libVersion, libLocalPath);
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
      throw error;
    }
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
      Blockly.defineBlocksWithJsonArray([block]);
    }
  }

  loadLibBlocksJS(filePath) {
    return new Promise((resolve, reject) => {
      let script = document.createElement('script');
      script.type = 'text/javascript';
      script.src = filePath;
      script.onload = () => {
        resolve(true);
      };
      script.onerror = (error: any) => resolve(false);
      document.getElementsByTagName('head')[0].appendChild(script);
    });
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
      this.clearLoadedLibraryStateForRuntimeRebuild();

      for (const libraryName of options.libraryNames) {
        await this.loadLibrary(libraryName, options.projectPath);
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

  private clearLoadedLibraryStateForRuntimeRebuild(): void {
    unregisterProjectDataFieldSlots(Array.from(this.blockTypeToLibMap.keys()));
    this.iconsMap.clear();
    this.blockDefinitionsMap.clear();
    this.loadedGenerators.clear();
    this.loadedLibraries.clear();
    this.loadedLibraryInfos.clear();
    this.libraryLoadTasks.clear();
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
    if (this.loadedGenerators.has(filePath)) {
      console.warn(`Generator ${filePath} 已加载,跳过重复加载`);
      return Promise.resolve(true);
    }

    try {
      const source = this.electronService.readFile(filePath);
      const result = this.generatorRuntime.loadGenerator(filePath, source);
      const registered = result.arduinoBlockTypes.length > 0
        ? result.arduinoBlockTypes
        : result.micropythonBlockTypes;
      this.loadedGenerators.set(filePath, new Set(registered));
      return Promise.resolve(true);
    } catch (error) {
      console.error(`Generator loading failed: ${filePath}`, error);
      this.generatorRuntime.destroy();
      return Promise.resolve(false);
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
    console.log('开始重置 BlocklyService...');

    // Workspace dispose may call project-defined callbacks, so it must happen
    // before the iframe and host registry snapshot are released.
    if (this.workspace) {
      this.workspace.dispose();
      this.workspace = null;
    }
    this.generatorRuntime.destroy();

    unregisterProjectDataFieldSlots(Array.from(this.blockTypeToLibMap.keys()));
    this.iconsMap.clear();
    this.blockDefinitionsMap.clear();
    this.loadedGenerators.clear();
    this.loadedLibraries.clear();
    this.loadedLibraryInfos.clear();
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
    this.absBlockLineMap.next(new Map());
    this.closeWorkspaceBlockSearch();
    this.resetDocumentState();
    this.toolboxSearchQuerySubject.next('');
    this.toolboxSelectedKeySubject.next(null);
    this.toolboxSortOrder = [];
    this.rebuildToolboxFacade();

    // console.log('BlocklyService 重置完成');
  }

  getWorkspaceJson() {
    if (this.workspace) {
      return Blockly.serialization.workspaces.save(this.workspace);
    }

    const activePage = this.getActivePage();
    return this.composeWorkspacePayload(activePage?.content, this.sharedModelSubject.value);
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
    const workspaceJson = this.normalizeWorkspaceJson(content);
    const blocks = Array.isArray(workspaceJson.blocks?.blocks) ? workspaceJson.blocks.blocks : [];
    for (const block of blocks) {
      this.collectBlockTypesFromBlock(block, blockTypes);
    }
  }

  private collectBlockTypesFromBlock(block: any, blockTypes: Set<string>) {
    if (!block || typeof block !== 'object') {
      return;
    }

    if (typeof block.type === 'string' && block.type.length > 0) {
      blockTypes.add(block.type);
    }

    const inputs = block.inputs && typeof block.inputs === 'object' ? block.inputs : {};
    for (const input of Object.values(inputs) as any[]) {
      this.collectBlockTypesFromBlock(input?.block, blockTypes);
      this.collectBlockTypesFromBlock(input?.shadow, blockTypes);
    }

    this.collectBlockTypesFromBlock(block.next?.block, blockTypes);
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
      this.workspace.render();
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

  private normalizeProjectDocument(jsonData: any, clone = true): BlocklyProjectDocument {
    if (Array.isArray(jsonData?.pages)) {
      const pages = jsonData.pages.length
        ? jsonData.pages.map((page, index) => this.normalizePageSnapshot(page, index, clone))
        : [this.createEmptyPageSnapshot('page-1', this.buildDefaultPageTitle(1))];
      const activePageId = pages.some((page) => page.id === jsonData.activePageId)
        ? jsonData.activePageId
        : pages[0].id;
      const openedPageIds = this.normalizeOpenedPageIds(jsonData?.openedPageIds, pages, activePageId);

      return {
        schemaVersion: this.projectDocumentSchemaVersion,
        activePageId,
        openedPageIds,
        pages,
        sharedModel: this.normalizeSharedModel(jsonData.sharedModel, clone),
      };
    }

    const legacyWorkspaceJson = this.normalizeWorkspaceJson(jsonData, clone);
    const legacyPage = this.createEmptyPageSnapshot('page-1', this.buildDefaultPageTitle(1));
    const sharedModel = this.extractSharedModel(legacyWorkspaceJson, clone);
    legacyPage.content = this.stripSharedModel(legacyWorkspaceJson, clone);

    return {
      schemaVersion: this.projectDocumentSchemaVersion,
      activePageId: legacyPage.id,
      openedPageIds: [legacyPage.id],
      pages: [legacyPage],
      sharedModel,
    };
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

  private normalizePageSnapshot(page: any, index: number, clone = true): BlocklyPageSnapshot {
    return {
      id: page?.id || this.generatePageId(),
      title: page?.title || this.buildDefaultPageTitle(index + 1),
      content: this.normalizePageContent(page?.content, clone),
      viewState: page?.viewState || this.createDefaultViewState(),
    };
  }

  private normalizePageContent(content: any, clone = true): any {
    const workspaceJson = this.normalizeWorkspaceJson(content, clone);
    delete workspaceJson.variables;
    workspaceJson.blocks.blocks = workspaceJson.blocks.blocks.filter(
      (block) => !this.isSharedProcedureBlock(block),
    );
    return workspaceJson;
  }

  private normalizeWorkspaceJson(workspaceJson: any, clone = true): any {
    const nextJson = (clone ? this.cloneJson(workspaceJson) : workspaceJson) || this.createEmptyWorkspaceContent();

    if (!nextJson.blocks) {
      nextJson.blocks = {
        languageVersion: 0,
        blocks: [],
      };
    }

    if (!Array.isArray(nextJson.blocks.blocks)) {
      nextJson.blocks.blocks = [];
    }

    return nextJson;
  }

  private normalizeSharedModel(sharedModel: any, clone = true): BlocklySharedModel {
    return {
      variables: sharedModel?.variables
        ? clone ? this.cloneJson(sharedModel.variables) : sharedModel.variables
        : undefined,
      procedureBlocks: Array.isArray(sharedModel?.procedureBlocks)
        ? clone ? sharedModel.procedureBlocks.map((block) => this.cloneJson(block)) : sharedModel.procedureBlocks
        : [],
    };
  }

  private applyProjectDocument(document: BlocklyProjectDocument, clone = true) {
    this.pagesSubject.next(clone ? document.pages.map((page) => this.cloneJson(page)) : document.pages);
    this.activePageIdSubject.next(document.activePageId);
    this.openedPageIdsSubject.next(clone ? this.cloneJson(document.openedPageIds) : document.openedPageIds);
    this.sharedModelSubject.next(this.normalizeSharedModel(document.sharedModel, clone));
  }

  private persistActiveWorkspaceToState() {
    if (!this.workspace || !this.activePageIdSubject.value) {
      return;
    }

    const workspaceJson = this.getWorkspaceJson();
    const activePageId = this.activePageIdSubject.value;
    const nextSharedModel = this.extractSharedModel(workspaceJson);
    const nextPages = this.pagesSubject.value.map((page) => {
      if (page.id !== activePageId) {
        return page;
      }

      return {
        ...page,
        content: this.stripSharedModel(workspaceJson),
        viewState: this.captureWorkspaceViewState(),
      };
    });

    this.sharedModelSubject.next(nextSharedModel);
    this.pagesSubject.next(nextPages);
  }

  private captureWorkspaceViewState(): BlocklyWorkspaceViewState {
    if (!this.workspace) {
      return this.createDefaultViewState();
    }

    return {
      scale: this.workspace.scale || 1,
      scrollX: this.workspace.scrollX || 0,
      scrollY: this.workspace.scrollY || 0,
    };
  }

  private loadActivePageIntoWorkspace() {
    const activePage = this.getActivePage();
    if (!activePage || !this.workspace) {
      return;
    }

    const workspaceJson = this.composeWorkspacePayload(activePage.content, this.sharedModelSubject.value);
    const wereEventsEnabled = Blockly.Events.isEnabled();

    try {
      Blockly.Events.disable();
      this.workspace.clear();
      this.loadWorkspaceJson(workspaceJson, false);
    } finally {
      if (wereEventsEnabled) {
        Blockly.Events.enable();
      }
    }

    this.selectedBlockSubject.next(null);
    this.selectedBlockIdsSubject.next([]);
  this.closeWorkspaceBlockSearch();
    this.restoreWorkspaceViewState(activePage.viewState);
    this.mountExternalToolbox();
    this.loadLibraryFinishedLoadingSubject.next();
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

  private composeWorkspacePayload(pageContent: any, sharedModel: BlocklySharedModel): any {
    const workspaceJson = this.normalizeWorkspaceJson(pageContent);
    const pageBlocks = Array.isArray(workspaceJson.blocks?.blocks) ? workspaceJson.blocks.blocks : [];
    const sharedProcedureBlocks = Array.isArray(sharedModel?.procedureBlocks)
      ? sharedModel.procedureBlocks.map((block) => this.cloneJson(block))
      : [];

    workspaceJson.blocks.blocks = [...sharedProcedureBlocks, ...pageBlocks.map((block) => this.cloneJson(block))];

    if (sharedModel?.variables) {
      workspaceJson.variables = this.cloneJson(sharedModel.variables);
    } else {
      delete workspaceJson.variables;
    }

    return workspaceJson;
  }

  private extractSharedModel(workspaceJson: any, clone = true): BlocklySharedModel {
    const normalizedWorkspaceJson = this.normalizeWorkspaceJson(workspaceJson, clone);
    const workspaceBlocks = Array.isArray(normalizedWorkspaceJson.blocks?.blocks)
      ? normalizedWorkspaceJson.blocks.blocks
      : [];

    return {
      variables: normalizedWorkspaceJson.variables
        ? this.cloneJson(normalizedWorkspaceJson.variables)
        : undefined,
      procedureBlocks: workspaceBlocks
        .filter((block) => this.isSharedProcedureBlock(block))
        .map((block) => this.cloneJson(block)),
    };
  }

  private stripSharedModel(workspaceJson: any, clone = true): any {
    const normalizedWorkspaceJson = this.normalizeWorkspaceJson(workspaceJson, clone);
    normalizedWorkspaceJson.blocks.blocks = normalizedWorkspaceJson.blocks.blocks.filter(
      (block) => !this.isSharedProcedureBlock(block),
    );
    delete normalizedWorkspaceJson.variables;
    return normalizedWorkspaceJson;
  }

  private isSharedProcedureBlock(block: any): boolean {
    return this.sharedProcedureBlockPrefixes.some((prefix) => block?.type?.startsWith(prefix));
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
    codeRanges: CodeLineRange[];
    formatted: string;
  } | null {
    if (!blockId || !this.workspace) return null;

    const block = this.workspace.getBlockById(blockId);
    if (!block) return null;

    const mapping = this.getCodeForBlock(blockId);
    const ranges = mapping?.lineRanges || [];
    const cppLineRange = this._formatCppLineRange(ranges);
    const absSnippet = this._getBlockAbsSnippet(block);
    const absLineRange = this._getBlockAbsLineRange(block, absSnippet);
    const formatted = this._formatBlockContextForLLM(block.type, absSnippet, cppLineRange, absLineRange);

    return {
      blockId,
      blockType: block.type,
      absSnippet,
      cppLineRange,
      absLineRange,
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

  /**
   * 获取单个块（含子树）的 ABS 代码片段
   * 通过 Blockly 序列化 API 得到块的 ABI JSON，再用 convertBlockTreeToAbs 转换
   */
  private _getBlockAbsSnippet(block: Blockly.Block): string {
    try {
      // 序列化单个块（含子块、shadow 块）为 ABI JSON
      const blockAbi = (Blockly as any).serialization.blocks.save(block, {
        addCoordinates: false,
        addInputBlocks: true,
        addNextBlocks: false,  // 不包含 next 链中的兄弟块
        doFullSerialization: false
      });

      // 获取工作区变量用于 ID → 名称转换
      const variables = this.workspace!.getAllVariables().map(v => ({
        id: v.getId(),
        name: v.name,
        type: v.type || 'int'
      }));

      return convertBlockTreeToAbs(blockAbi, variables);
    } catch (e) {
      // 序列化失败时返回块类型作为降级
      return block.type;
    }
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
  ): string {
    const lines: string[] = [];
    lines.push(total > 1 ? `[用户选中的积木块 ${index}/${total}]` : '[用户选中的积木块]');
    lines.push(`块类型: ${blockType}`);
    lines.push(`ABS代码:`);
    lines.push(this._truncateAbsSnippet(absSnippet));
    if (absLineRange !== '无') {
      lines.push(`对应ABS代码行数: ${absLineRange}`);
    }
    lines.push(`对应C++代码行数: ${cppLineRange}`);
    return lines.join('\n');
  }

  /**
   * 截断过长的 ABS 代码片段
   * 超过 6 行时保留前 3 行和后 3 行，中间用 ... 省略
   */
  private _truncateAbsSnippet(abs: string): string {
    const lines = abs.split('\n');
    if (lines.length <= 6) return abs;
    const head = lines.slice(0, 3);
    const tail = lines.slice(-3);
    return [...head, `    ... (${lines.length - 6} lines omitted)`, ...tail].join('\n');
  }

  /**
   * 从缓存的 ABS blockLineMap 中查找选中块的行号范围
   * 该 map 由 abs-auto-sync 服务在生成 .abs 文件时同步更新，
   * 确保行号与用户实际看到的 ABS 文件完全一致。
   * 若缓存为空（abs-auto-sync 尚未运行），则即时生成作为降级
   */
  private _getBlockAbsLineRange(block: Blockly.Block, absSnippet: string): string {
    try {
      if (!absSnippet) return '无';

      let blockLineMap = this.absBlockLineMap.value;

      // 缓存为空时即时生成（降级）
      if (!blockLineMap || blockLineMap.size === 0) {
        if (!this.workspace) return '无';
        const workspaceJson = Blockly.serialization.workspaces.save(this.workspace);
        const result = convertAbiToAbsWithLineMap(workspaceJson, { includeHeader: true });
        blockLineMap = result.blockLineMap;
        // 缓存供后续使用
        this.absBlockLineMap.next(blockLineMap);
      }

      // 直接查找选中块的行号范围
      const range = blockLineMap.get(block.id);
      if (range) {
        return range.startLine === range.endLine
          ? `${range.startLine}`
          : `${range.startLine}-${range.endLine}`;
      }

      // 值块被内联到父块参数中，通过父块 ID 查找
      const parentBlock = block.getParent();
      if (parentBlock) {
        const parentRange = blockLineMap.get(parentBlock.id);
        if (parentRange) {
          return `${parentRange.startLine}`;
        }
      }

      return '无';
    } catch (e) {
      return '无';
    }
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
