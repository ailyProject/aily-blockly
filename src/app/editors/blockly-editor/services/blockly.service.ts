import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import * as Blockly from 'blockly';
import { processI18n, processJsonVar, processStaticFilePath, processToolboxI18n } from '../components/blockly/abf';
import { TranslateService } from '@ngx-translate/core';
import { ElectronService } from '../../../services/electron.service';
import { BlockCodeMapping, CodeLineRange } from '../components/blockly/generators/arduino/arduino';
import { convertBlockTreeToAbs, convertAbiToAbsWithLineMap } from '../../../tools/aily-chat/public-api';
import { BlockSearcher } from '../components/blockly/plugins/toolbox-search/src/block_searcher';

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
  name: string;
  kind: string;
  iconClass: string;
  selectable: boolean;
  toolboxItemId: string;
  libraryName?: string | null;
  libraryPath?: string | null;
  parentKey: string | null;
  level: number;
  expanded: boolean;
  isCollapsible: boolean;
  children: BlocklyToolboxFacadeItem[];
}

export const BLOCKLY_TOOLBOX_SEARCH_KEY = '__toolbox_search__';

@Injectable({
  providedIn: 'root'
})
export class BlocklyService {
  private readonly projectDocumentSchemaVersion = 3;
  private readonly sharedProcedureBlockPrefixes = ['procedures_'];
  private readonly toolboxSearchKey = BLOCKLY_TOOLBOX_SEARCH_KEY;

  workspace: Blockly.WorkspaceSvg;

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
  // blockType → 库信息映射（用于跨实例复制粘贴时携带库元信息）
  blockTypeToLibMap = new Map<string, { name: string; version: string; localPath?: string }>();

  codeSubject = new BehaviorSubject<string>('');
  dependencySubject = new BehaviorSubject<string>('');

  // ==================== Block-to-Code 映射系统 ====================
  /** 当前选中的 block id */
  selectedBlockSubject = new BehaviorSubject<string | null>(null);
  /** block → 代码行号映射（每次代码生成后更新） */
  blockCodeMapSubject = new BehaviorSubject<Map<string, BlockCodeMapping>>(new Map());
  /** block → ABS 行号映射（由 abs-auto-sync 生成 ABS 时同步更新，确保与用户看到的 .abs 文件一致） */
  absBlockLineMap = new BehaviorSubject<Map<string, { startLine: number; endLine: number }>>(new Map());
  pagesSubject = new BehaviorSubject<BlocklyPageSnapshot[]>([]);
  activePageIdSubject = new BehaviorSubject<string>('');
  openedPageIdsSubject = new BehaviorSubject<string[]>([]);
  sharedModelSubject = new BehaviorSubject<BlocklySharedModel>({ procedureBlocks: [] });
  toolboxFacadeItemsSubject = new BehaviorSubject<BlocklyToolboxFacadeItem[]>([]);
  toolboxSelectedKeySubject = new BehaviorSubject<string | null>(null);
  toolboxSearchQuerySubject = new BehaviorSubject<string>('');

  boardConfig;

  draggingBlock: any;
  offsetX: number = 0;
  offsetY: number = 0;
  private externalToolboxHost: HTMLElement | null = null;
  private nativeToolboxElement: HTMLElement | null = null;
  private blockSearcher = new BlockSearcher();

  aiWaiting = false;
  private _aiWriting = new BehaviorSubject<boolean>(false);
  aiWriting$ = this._aiWriting.asObservable();
  private _aiWaiting = new BehaviorSubject<boolean>(false);
  aiWaiting$ = this._aiWaiting.asObservable();

  get aiWaitWriting() {
    return this._aiWaiting.value;
  }

  set aiWaitWriting(value: boolean) {
    this._aiWaiting.next(value);
  }

  get aiWriting(): boolean {
    return this._aiWriting.value;
  }

  set aiWriting(value: boolean) {
    this._aiWriting.next(value);
  }

  constructor(
    private translateService: TranslateService,
    private electronService: ElectronService
  ) {
    (window as any).__ailyBlockDefinitionsMap = this.blockDefinitionsMap;
    (window as any).__ailyBlockTypeToLibMap = this.blockTypeToLibMap;
    this.resetDocumentState();
    this.rebuildToolboxFacade();
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
    const document = this.normalizeProjectDocument(jsonData);
    this.applyProjectDocument(document);
    this.loadActivePageIntoWorkspace();
  }

  hydrateWorkspaceFromProjectState() {
    this.loadActivePageIntoWorkspace();
  }

  normalizeProjectAbi(jsonData: any): BlocklyProjectDocument {
    return this.normalizeProjectDocument(jsonData);
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

  getProjectAbiForSave(): any {
    const document = this.getProjectDocument();
    if (document.pages.length === 1) {
      return this.composeWorkspacePayload(document.pages[0].content, document.sharedModel);
    }

    return document;
  }

  // 加载 blockly 当前工作区的 JSON 数据
  loadWorkspaceJson(jsonData: any) {
    if (!this.workspace) {
      return;
    }

    const workspaceJson = this.cloneJson(jsonData) || this.createEmptyWorkspaceContent();
    workspaceJson.blocks?.blocks?.forEach((block) => {
      const ailyIcons = this.iconsMap.get(block.type);
      if (ailyIcons) {
        block.icons = ailyIcons;
      }
    });

    Blockly.serialization.workspaces.load(workspaceJson, this.workspace);
  }

  // 通过node_modules加载库
  async loadLibrary(libPackageName, projectPath) {
    // 统一路径分隔符，确保在Windows上使用反斜杠
    // const normalizedProjectPath = projectPath.replace(/\//g, '\\');
    // const libPackagePath = normalizedProjectPath + '\\node_modules\\' + libPackageName.replace(/\//g, '\\');

    const libPackagePath = this.electronService.pathJoin(
      projectPath,
      'node_modules',
      ...libPackageName.split('/')
    );

    // 防止重复加载
    if (this.loadedLibraries.has(libPackagePath)) {
      return;
    }

    let generatorLoadSuccess = true;
    try {
      // 加载block
      // const blockFileIsExist = this.electronService.exists(libPackagePath + '\\block.json');
      const blockFileIsExist = this.electronService.exists(this.electronService.pathJoin(libPackagePath, 'block.json'));

      if (blockFileIsExist) {
        // 加载blocks
        let blocks = JSON.parse(this.electronService.readFile(this.electronService.pathJoin(libPackagePath, 'block.json')));
        // 读取库版本号（用于跨实例复制粘贴时携带库元信息）
        let libVersion = '';
        const libPkgJsonPath = this.electronService.pathJoin(libPackagePath, 'package.json');
        if (this.electronService.exists(libPkgJsonPath)) {
          try { libVersion = JSON.parse(this.electronService.readFile(libPkgJsonPath)).version || ''; } catch (e) {}
        }
        let i18nData = null;
        // 检查多语言文件是否存在（先于 generator.js 加载，确保动态扩展能读取到 i18n 数据）
        const i18nFilePath = this.electronService.pathJoin(libPackagePath, 'i18n', this.translateService.currentLang + '.json');
        if (this.electronService.exists(i18nFilePath)) {
          i18nData = JSON.parse(this.electronService.readFile(i18nFilePath));
          // 将 i18n 数据按库名存储到全局，供动态扩展使用
          (window as any).__BLOCKLY_LIB_I18N__ = (window as any).__BLOCKLY_LIB_I18N__ || {};
          (window as any).__BLOCKLY_LIB_I18N__[libPackageName] = i18nData;
          blocks = processI18n(blocks, i18nData);
        }
        // 加载generator（必须在 i18n 数据存储后，这样动态定义的块才能读取到正确的多语言）
        const generatorFilePath = this.electronService.pathJoin(libPackagePath, 'generator.js');
        const generatorFileIsExist = this.electronService.exists(generatorFilePath);
        if (generatorFileIsExist) {
          generatorLoadSuccess = await this.loadLibGenerator(generatorFilePath);
          if (!generatorLoadSuccess) {
            console.error(`[loadLibrary] generator.js 加载失败: ${libPackageName}，库将不会标记为已加载，下次可重试`);
          }
        }
        // 检测是否为本地库（项目 package.json 中 dependencies 版本以 "file:" 开头）
        let libLocalPath: string | undefined;
        try {
          const projPkgJsonPath = this.electronService.pathJoin(projectPath, 'package.json');
          if (this.electronService.exists(projPkgJsonPath)) {
            const projPkgJson = JSON.parse(this.electronService.readFile(projPkgJsonPath));
            const depVersion = projPkgJson?.dependencies?.[libPackageName] || '';
            if (typeof depVersion === 'string' && depVersion.startsWith('file:')) {
              const relativePath = depVersion.substring(5); // 去掉 "file:" 前缀
              libLocalPath = this.electronService.pathJoin(projectPath, relativePath);
            }
          }
        } catch (e) {}
        // 替换block中静态图片路径
        const staticFileIsExist = this.electronService.exists(this.electronService.pathJoin(libPackagePath, 'static'));
        this.loadLibBlocks(blocks, staticFileIsExist ? this.electronService.pathJoin(libPackagePath, 'static') : null, libPackageName, libVersion, libLocalPath);
        // 加载toolbox
        const toolboxFileIsExist = this.electronService.exists(this.electronService.pathJoin(libPackagePath, 'toolbox.json'));
        if (toolboxFileIsExist) {
          let toolbox = JSON.parse(this.electronService.readFile(this.electronService.pathJoin(libPackagePath, 'toolbox.json')));
          // 处理 toolbox 多语言（包括 name 和 labels）
          if (i18nData) {
            toolbox = processToolboxI18n(toolbox, i18nData);
          }
          this.attachLibraryMetadataToToolbox(toolbox, libPackageName, libPackagePath);
          this.loadLibToolbox(toolbox);
        }
      } else {
        // block.json 不存在时，不标记为已加载
        return;
      }

      // 仅在 generator 加载成功时才标记为已加载（失败时允许后续重试）
      if (generatorLoadSuccess) {
        this.loadedLibraries.add(libPackagePath);
      }
    } catch (error) {
      console.error('加载库失败:', libPackageName, error);
    }
  }

  // 卸载库（通过包名和项目路径）
  async unloadLibrary(libPackageName, projectPath) {
    // 统一路径分隔符，使用electronService.pathJoin处理跨平台路径
    const libPackagePath = this.electronService.pathJoin(
      projectPath,
      'node_modules',
      ...libPackageName.split('/')
    );

    // 直接调用 removeLibrary 函数
    this.removeLibrary(libPackagePath);
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
      return;
    }

    this.toolbox.contents.push(toolboxItem);
    this.ensureToolboxItemIds(this.toolbox.contents);
    if (this.workspace) {
      this.workspace.updateToolbox(this.toolbox);
      this.workspace.render();
    }
    this.rebuildToolboxFacade();
    this.syncToolboxFacadeWithWorkspace();
  }

  private attachLibraryMetadataToToolbox(toolboxItem: any, libraryName: string, libraryPath: string) {
    if (!toolboxItem || typeof toolboxItem !== 'object') {
      return;
    }

    if (toolboxItem.kind === 'category') {
      toolboxItem.ailyLibraryName = libraryName;
      toolboxItem.ailyLibraryPath = libraryPath;
    }

    if (Array.isArray(toolboxItem.contents)) {
      toolboxItem.contents.forEach((child: any) => this.attachLibraryMetadataToToolbox(child, libraryName, libraryPath));
    }
  }

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
      const abiJson = JSON.stringify(this.getProjectDocument());
      return blocksData.some((block: any) => block?.type && abiJson.includes(block.type));
    } catch (error) {
      console.error('检查库使用情况失败:', libPackagePath, error);
      return false;
    }
  }

  loadLibGenerator(filePath): Promise<boolean> {
    return new Promise((resolve, reject) => {
      // 检查是否已加载
      if (this.loadedGenerators.has(filePath)) {
        console.warn(`Generator ${filePath} 已加载,跳过重复加载`);
        resolve(true);
        return;
      }

      // 在加载前记录当前已有的generator函数
      const blockTypesBefore = this.getRegisteredGenerators();

      let script = document.createElement('script');
      script.type = 'text/javascript';
      script.src = 'file:///' + filePath;
      script.setAttribute('data-generator-path', filePath); // 标记script来源

      script.onload = () => {
        // 加载后检测新增的generator函数
        const blockTypesAfter = this.getRegisteredGenerators();
        const newBlockTypes = blockTypesAfter.filter(type => !blockTypesBefore.includes(type));
        this.loadedGenerators.set(filePath, new Set(newBlockTypes));
        console.log(`Generator loaded from ${filePath}, registered blocks:`, newBlockTypes);
        resolve(true);
      };

      script.onerror = (error: any) => {
        console.error(`Generator loading failed: ${filePath}`, error);
        resolve(false);
      };

      document.getElementsByTagName('head')[0].appendChild(script);
    });
  }

  // 获取当前已注册的所有generator函数对应的block类型
  private getRegisteredGenerators(): string[] {
    const generators = [];
    // generator 脚本通过 window.Arduino.forBlock / window.MPY.forBlock 注册
    const arduinoGen = (window as any).Arduino;
    if (arduinoGen?.forBlock) {
      generators.push(...Object.keys(arduinoGen.forBlock).filter(key =>
        typeof arduinoGen.forBlock[key] === 'function'
      ));
    }
    const mpyGen = (window as any).MPY || (window as any).MicropPython;
    if (mpyGen?.forBlock) {
      generators.push(...Object.keys(mpyGen.forBlock).filter(key =>
        typeof mpyGen.forBlock[key] === 'function'
      ));
    }
    return generators;
  }

  removeLibrary(libPackagePath) {
    // 路径已经是标准格式，无需再次分割
    // electronService.pathJoin已经处理了路径分隔符

    // 检查是否已加载
    if (!this.loadedLibraries.has(libPackagePath)) {
      console.warn(`库 ${libPackagePath} 未加载,无需移除`);
      return;
    }

    console.log(`开始移除库: ${libPackagePath}`);

    // 读取要移除的库的信息
    // 移除block定义
    const blockFileIsExist = this.electronService.exists(this.electronService.pathJoin(libPackagePath, 'block.json'));
    if (blockFileIsExist) {
      let blocks = JSON.parse(this.electronService.readFile(this.electronService.pathJoin(libPackagePath, 'block.json')));
      this.removeLibBlocks(blocks);
    } else {
      // 对于JS形式加载的block，需要使用block文件名作为标识
      const blockJsPath = this.electronService.pathJoin(libPackagePath, 'block.js');
      this.removeLibBlocksJS(blockJsPath);
    }

    // 移除toolbox项
    const toolboxFileIsExist = this.electronService.exists(this.electronService.pathJoin(libPackagePath, 'toolbox.json'));
    if (toolboxFileIsExist) {
      let toolbox = JSON.parse(this.electronService.readFile(this.electronService.pathJoin(libPackagePath, 'toolbox.json')));
      // 检查多语言文件是否存在，（2025.5.29 修复因为多语言造成的移除不了toolbox的问题）
      let i18nData = null;
      const i18nFilePath = this.electronService.pathJoin(libPackagePath, 'i18n', this.translateService.currentLang + '.json');
      if (this.electronService.exists(i18nFilePath)) {
        i18nData = JSON.parse(this.electronService.readFile(i18nFilePath));
        if (i18nData) toolbox.name = i18nData.toolbox_name;
      }
      this.removeLibToolbox(toolbox);
    }

    // 移除generator相关引用
    const generatorFileIsExist = this.electronService.exists(this.electronService.pathJoin(libPackagePath, 'generator.js'));
    if (generatorFileIsExist) {
      this.removeLibGenerator(this.electronService.pathJoin(libPackagePath, 'generator.js'));
    }

    // 从已加载库列表中移除
    this.loadedLibraries.delete(libPackagePath);
    console.log(`库 ${libPackagePath} 移除完成`);
  }

  // 移除已加载的block定义
  removeLibBlocks(blocks) {
    for (let index = 0; index < blocks.length; index++) {
      const block = blocks[index];
      // 从Blockly中删除block定义
      if (block.type && Blockly.Blocks[block.type]) {
        console.log(`- delete ${block.type}`);
        delete Blockly.Blocks[block.type];
        if ((window as any).Arduino.forBlock[block.type]) {
          delete (window as any).Arduino.forBlock[block.type];
        }
        // 移除 blockType → 库信息映射
        this.blockTypeToLibMap.delete(block.type);
      }
    }
  }

  // 移除通过JS加载的block定义
  removeLibBlocksJS(scriptSrc) {
    // 查找并移除相关脚本标签
    const scripts = document.getElementsByTagName('script');
    for (let i = 0; i < scripts.length; i++) {
      if (scripts[i].src.includes(scriptSrc)) {
        scripts[i].parentNode.removeChild(scripts[i]);
        break;
      }
    }
    // 注意：已执行的JS代码效果无法直接撤销，这里只是移除了脚本标签
  }

  // 从toolbox中移除项
  removeLibToolbox(toolboxItem) {
    // 通过比较找到要移除的toolbox项
    console.log(`即将移除：`, toolboxItem);
    const index = this.findToolboxItemIndex(toolboxItem);
    if (index !== -1) {
      this.toolbox.contents.splice(index, 1);
      if (this.workspace) {
        this.workspace.updateToolbox(this.toolbox);
      }
      this.rebuildToolboxFacade();
      this.syncToolboxFacadeWithWorkspace();
    }
  }

  // 查找toolbox项在contents数组中的索引
  findToolboxItemIndex(toolboxItem) {
    for (let i = 0; i < this.toolbox.contents.length; i++) {
      const item = this.toolbox.contents[i];
      // 使用name、categoryId等属性进行匹配
      if (item.name === toolboxItem.name && item.kind == toolboxItem.kind) {
        return i;
      }
    }
    return -1;
  }

  // 移除generator相关引用
  removeLibGenerator(scriptSrc) {
    // 移除注册的generator函数
    const registeredBlocks = this.loadedGenerators.get(scriptSrc);
    if (registeredBlocks && registeredBlocks.size > 0) {
      registeredBlocks.forEach(blockType => {
        // 清理各种语言的generator（使用与脚本注册相同的全局对象）
        const arduinoGen = (window as any).Arduino;
        if (arduinoGen?.forBlock?.[blockType]) {
          console.log(`- delete Arduino generator for ${blockType}`);
          delete arduinoGen.forBlock[blockType];
        }
        const mpyGen = (window as any).MPY || (window as any).MicropPython;
        if (mpyGen?.forBlock?.[blockType]) {
          console.log(`- delete Python generator for ${blockType}`);
          delete mpyGen.forBlock[blockType];
        }
        if ((Blockly as any).JavaScript?.forBlock?.[blockType]) {
          delete (Blockly as any).JavaScript.forBlock[blockType];
        }
      });
    }
    this.loadedGenerators.delete(scriptSrc);

    // 查找并移除相关脚本标签
    const scripts = document.getElementsByTagName('script');
    for (let i = scripts.length - 1; i >= 0; i--) { // 倒序遍历避免索引问题
      const script = scripts[i];
      const dataPath = script.getAttribute('data-generator-path');
      if (script.src.includes(scriptSrc) || dataPath === scriptSrc) {
        script.parentNode?.removeChild(script);
        console.log(`- removed script tag for ${scriptSrc}`);
        break;
      }
    }
  }

  reset() {
    console.log('开始重置 BlocklyService...');

    this.iconsMap.clear();
    this.blockDefinitionsMap.clear();
    this.loadedGenerators.clear();
    this.loadedLibraries.clear();
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

    // 处理工作区
    if (this.workspace) {
      this.workspace.dispose();
      // console.log('工作区已销毁');
    }

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
    this.codeSubject.next('');
    this.selectedBlockSubject.next(null);
    this.blockCodeMapSubject.next(new Map());
    this.absBlockLineMap.next(new Map());
    this.resetDocumentState();
    this.toolboxSearchQuerySubject.next('');
    this.toolboxSelectedKeySubject.next(null);
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
      name: item.name || '',
      kind: item.kind,
      iconClass: item.icon || 'fa-light fa-cube',
      selectable: true,
      toolboxItemId: item.toolboxitemid || item.categoryId || `${item.kind}:${item.name}`,
      libraryName: item.ailyLibraryName || null,
      libraryPath: item.ailyLibraryPath || null,
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
    if (Array.isArray(jsonData?.pages)) {
      const pages = jsonData.pages.length
        ? jsonData.pages.map((page, index) => this.normalizePageSnapshot(page, index))
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
        sharedModel: this.normalizeSharedModel(jsonData.sharedModel),
      };
    }

    const legacyWorkspaceJson = this.normalizeWorkspaceJson(jsonData);
    const legacyPage = this.createEmptyPageSnapshot('page-1', this.buildDefaultPageTitle(1));
    legacyPage.content = this.stripSharedModel(legacyWorkspaceJson);

    return {
      schemaVersion: this.projectDocumentSchemaVersion,
      activePageId: legacyPage.id,
      openedPageIds: [legacyPage.id],
      pages: [legacyPage],
      sharedModel: this.extractSharedModel(legacyWorkspaceJson),
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

  private normalizePageSnapshot(page: any, index: number): BlocklyPageSnapshot {
    return {
      id: page?.id || this.generatePageId(),
      title: page?.title || this.buildDefaultPageTitle(index + 1),
      content: this.normalizePageContent(page?.content),
      viewState: page?.viewState || this.createDefaultViewState(),
    };
  }

  private normalizePageContent(content: any): any {
    const workspaceJson = this.normalizeWorkspaceJson(content);
    delete workspaceJson.variables;
    workspaceJson.blocks.blocks = workspaceJson.blocks.blocks.filter(
      (block) => !this.isSharedProcedureBlock(block),
    );
    return workspaceJson;
  }

  private normalizeWorkspaceJson(workspaceJson: any): any {
    const nextJson = this.cloneJson(workspaceJson) || this.createEmptyWorkspaceContent();

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

  private normalizeSharedModel(sharedModel: any): BlocklySharedModel {
    return {
      variables: sharedModel?.variables ? this.cloneJson(sharedModel.variables) : undefined,
      procedureBlocks: Array.isArray(sharedModel?.procedureBlocks)
        ? sharedModel.procedureBlocks.map((block) => this.cloneJson(block))
        : [],
    };
  }

  private applyProjectDocument(document: BlocklyProjectDocument) {
    this.pagesSubject.next(document.pages.map((page) => this.cloneJson(page)));
    this.activePageIdSubject.next(document.activePageId);
    this.openedPageIdsSubject.next(this.cloneJson(document.openedPageIds));
    this.sharedModelSubject.next(this.normalizeSharedModel(document.sharedModel));
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
      this.loadWorkspaceJson(workspaceJson);
    } finally {
      if (wereEventsEnabled) {
        Blockly.Events.enable();
      }
    }

    this.selectedBlockSubject.next(null);
    this.restoreWorkspaceViewState(activePage.viewState);
    this.mountExternalToolbox();
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

  private extractSharedModel(workspaceJson: any): BlocklySharedModel {
    const normalizedWorkspaceJson = this.normalizeWorkspaceJson(workspaceJson);
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

  private stripSharedModel(workspaceJson: any): any {
    const normalizedWorkspaceJson = this.normalizeWorkspaceJson(workspaceJson);
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
    const blockId = this.selectedBlockSubject.value;
    if (!blockId || !this.workspace) return null;

    const block = this.workspace.getBlockById(blockId);
    if (!block) return null;

    // 获取该块的代码映射
    const mapping = this.getCodeForBlock(blockId);
    const ranges = mapping?.lineRanges || [];

    // 生成 C++ 行号范围（简洁格式）
    const cppLineRange = this._formatCppLineRange(ranges);

    // 生成该块子树的 ABS 代码片段
    const absSnippet = this._getBlockAbsSnippet(block);

    // 生成 ABS 行号范围
    const absLineRange = this._getBlockAbsLineRange(block, absSnippet);

    // 格式化 LLM 友好文本
    const formatted = this._formatBlockContextForLLM(block.type, absSnippet, cppLineRange, absLineRange);

    return {
      blockId,
      blockType: block.type,
      absSnippet,
      cppLineRange,
      absLineRange,
      codeRanges: ranges,
      formatted
    };
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
  private _formatBlockContextForLLM(blockType: string, absSnippet: string, cppLineRange: string, absLineRange: string): string {
    const lines: string[] = [];
    lines.push('[用户选中的积木块]');
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

  /**
   * 获取当前选中block的简短上下文标签（用于AI助手上下文列表展示）
   * 格式：blockly:C10-20（C++行号）或 blockly:A5-12（ABS行号）
   * @returns { label, formatted, blockId } 或 null
   */
  getSelectedBlockContextLabel(): { label: string; formatted: string; blockId: string } | null {
    const ctx = this.getSelectedBlockContext();
    if (!ctx) return null;

    // 构建标签：优先显示 C++ 行号和 ABS 行号
    const parts: string[] = [];
    if (ctx.absLineRange !== '无') parts.push(`A${ctx.absLineRange}`);
    if (ctx.cppLineRange !== '无') parts.push(`C${ctx.cppLineRange}`);

    const label = parts.length > 0
      ? `blockly:${parts.join('/')}`
      : `blockly:${ctx.blockType}`;

    return {
      label,
      formatted: ctx.formatted,
      blockId: ctx.blockId
    };
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
