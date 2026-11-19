import { AfterViewInit, ChangeDetectorRef, Component, computed, ElementRef, EventEmitter, Input, NgZone, OnDestroy, Output, signal, viewChild } from '@angular/core';
import { injectVirtualizer } from '@tanstack/angular-virtual';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzToolTipModule } from 'ng-zorro-antd/tooltip';
import { NzSelectModule } from 'ng-zorro-antd/select';
import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { NzMessageService } from 'ng-zorro-antd/message';
import { NzTagModule } from 'ng-zorro-antd/tag';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { Subject } from 'rxjs';
import { debounceTime, takeUntil } from 'rxjs/operators';
import { NpmService, LocalLibrarySyncService } from '@domain/dependencies/public-api';
import { ConfigService } from '@core/preferences/public-api';
import { ProjectService } from '@domain/project/public-api';
import { NzModalService } from 'ng-zorro-antd/modal';
import { CompatibleDialogComponent } from '../compatible-dialog/compatible-dialog.component';
import { ElectronService, CrossPlatformCmdService } from '@core/platform/public-api';
import { BlocklyService } from '../../services/blockly.service';
import { WorkflowService } from '@core/app-shell/public-api';
import { LibManagerService, type PackageInfo } from './lib-manager.service';

@Component({
  selector: 'app-lib-manager',
  host: { '[class.lib-manager-host--panel]': 'embedInPanel' },
  imports: [
    FormsModule,
    CommonModule,
    NzInputModule,
    NzButtonModule,
    NzToolTipModule,
    NzSelectModule,
    NzTagModule,
    TranslateModule
  ],
  templateUrl: './lib-manager.component.html',
  styleUrl: './lib-manager.component.scss'
})
export class LibManagerComponent implements AfterViewInit, OnDestroy {

  /** 嵌入主窗口右侧工具栏时为 true（非 Blockly 全屏遮罩） */
  private readonly panelMode = signal(false);
  @Input() set embedInPanel(value: boolean) { this.panelMode.set(value); }
  get embedInPanel(): boolean { return this.panelMode(); }

  readonly scrollElement = viewChild<ElementRef<HTMLDivElement>>('scrollElement');
  private readonly viewportWidth = signal(0);
  private readonly libraries = signal<PackageInfo[]>([]);
  readonly columnCount = computed(() => this.panelMode() ? 1
    : Math.max(1, Math.floor((this.viewportWidth() - 30 + 15) / (365 + 15))));
  readonly rowSize = computed(() => 165 + (this.panelMode() ? 10 : 15));
  readonly libraryRows = computed(() => {
    const libraries = this.libraries();
    const columns = this.columnCount();
    const rows: PackageInfo[][] = [];
    for (let index = 0; index < libraries.length; index += columns) {
      rows.push(libraries.slice(index, index + columns));
    }
    return rows;
  });
  readonly virtualizer = injectVirtualizer(() => ({
    scrollElement: this.scrollElement(),
    count: this.libraryRows().length,
    estimateSize: () => this.rowSize(),
    overscan: 2,
  }));
  private resizeObserver?: ResizeObserver;
  private resizeFrame?: number;

  ngAfterViewInit(): void {
    const element = this.scrollElement()?.nativeElement;
    if (!element) return;
    const resize = () => {
      if (this.isDestroyed || element.clientWidth === this.viewportWidth()) return;
      const previousColumns = this.columnCount();
      const firstLibrary = Math.floor(element.scrollTop / this.rowSize()) * previousColumns;
      this.zone.run(() => {
        this.viewportWidth.set(element.clientWidth);
        this.cd.detectChanges();
        // Keep the first visible library in view when the grid changes columns.
        if (this.resizeFrame !== undefined) cancelAnimationFrame(this.resizeFrame);
        if (previousColumns !== this.columnCount() && firstLibrary > 0) {
          this.resizeFrame = requestAnimationFrame(() => {
            if (!this.isDestroyed && this.libraryRows().length) this.virtualizer.scrollToIndex(
              Math.min(this.libraryRows().length - 1, Math.floor(firstLibrary / this.columnCount())),
              { align: 'start' });
          });
        }
      });
    };
    resize();
    this.resizeObserver = new ResizeObserver(resize);
    this.resizeObserver.observe(element);
  }

  private resetListScroll(): void {
    if (this.resizeFrame !== undefined) cancelAnimationFrame(this.resizeFrame);
    this.scrollElement()?.nativeElement.scrollTo({ top: 0 });
    this.virtualizer.scrollToOffset(0);
  }

  @Output() close = new EventEmitter();

  keyword: string = '';
  tagList: { key: string; label: string }[] = [];
  displayTagList: { key: string; label: string }[] = [];
  get libraryList(): PackageInfo[] { return this.libraries(); }
  set libraryList(value: PackageInfo[]) { this.libraries.set(value); }
  _libraryList: PackageInfo[] = [];
  installedPackageList: string[] = [];

  loading = false;

  private searchSubject = new Subject<string>();
  private destroy$ = new Subject<void>();
  private installedStateRefreshToken = 0;
  private initialDataLoadToken = 0;
  private searchRequestToken = 0;
  private isDestroyed = false;

  constructor(
    private zone: NgZone,
    private npmService: NpmService,
    private configService: ConfigService,
    private projectService: ProjectService,
    private blocklyService: BlocklyService,
    private message: NzMessageService,
    private cd: ChangeDetectorRef,
    private translate: TranslateService,
    private modal: NzModalService,
    private crossPlatformCmdService: CrossPlatformCmdService,
    private electronService: ElectronService,
    private workflowService: WorkflowService,
    private localLibrarySyncService: LocalLibrarySyncService,
    private libManagerService: LibManagerService,
  ) {}

  ngOnDestroy() {
    this.isDestroyed = true;
    this.resizeObserver?.disconnect();
    if (this.resizeFrame !== undefined) cancelAnimationFrame(this.resizeFrame);
    this.initialDataLoadToken++;
    this.searchRequestToken++;
    this.installedStateRefreshToken++;
    this.destroy$.next();
    this.destroy$.complete();
  }

  ngOnInit() {
    this.searchSubject.pipe(
      debounceTime(200),
      takeUntil(this.destroy$)
    ).subscribe(keyword => this.doSearch(keyword));

    // Defer list preparation so the panel can render first.
    this.applyCachedInitialState();
    void this.initializeLibraryData();
  }

  private applyCachedInitialState() {
    const availableLibraryList = this.getAvailableLibraryList();
    const cachedState = this.libManagerService.getCachedInitialState(
      availableLibraryList,
      this.configService.tagList,
      this.translate.currentLang || 'en',
      10,
      this.getCurrentBoardType(),
    );

    if (!cachedState) {
      return;
    }

    this.tagList = cachedState.tagList;
    this.displayTagList = cachedState.displayTagList;
    this._libraryList = cachedState.baseLibraryList;
    this.libraryList = this.applyLibraryOperationStates(cachedState.libraryList);
    this.cd.detectChanges();
  }

  private async initializeLibraryData() {
    const loadToken = ++this.initialDataLoadToken;
    let loadedAnyChunk = false;

    try {
      // Python 项目先加载独立 libraries-linux.json；Arduino 项目复用已加载的默认目录。
      await this.configService.ensureLibraryListForProject(this.projectService.currentPackageData);
      const availableLibraryList = this.getAvailableLibraryList();
      for await (const state of this.libManagerService.buildInitialStateChunks(
        availableLibraryList,
        this.configService.tagList,
        this.translate.currentLang || 'en',
        10,
        this.getCurrentBoardType(),
      )) {
        if (this.isDestroyed || loadToken !== this.initialDataLoadToken) {
          return;
        }

        loadedAnyChunk = true;
        this.tagList = state.tagList;
        this.displayTagList = state.displayTagList;
        this._libraryList = state.baseLibraryList;

        if (!this.keyword) {
          this.libraryList = this.applyLibraryOperationStates(state.libraryList);
          this.cd.detectChanges();
        }
      }

      if (this.keyword) {
        void this.doSearch(this.keyword);
        return;
      }

      if (loadedAnyChunk) {
        this.scheduleInstalledStateRefresh();
      }
    } catch (error) {
      console.warn('[LibManager] failed to initialize library data:', error);
    }
  }

  async checkInstalled(libraryList: PackageInfo[] | null = null) {
    const includeInstalledOnlyLibraries = libraryList === null;
    const targetLibraryList = libraryList === null
      ? this.libManagerService.cloneLibraryList<PackageInfo>(this._libraryList)
      : libraryList;
    const installedLibraryList = await this.npmService.getAllInstalledLibraries(this.projectService.currentProjectPath);

    return this.applyLibraryOperationStates(
      this.libManagerService.filterByBoardType(
        this.libManagerService.mergeInstalledLibraries(
          targetLibraryList,
          installedLibraryList,
          includeInstalledOnlyLibraries,
        ),
        this.getCurrentBoardType(),
      ),
    );
  }

  private getAvailableLibraryList(): PackageInfo[] {
    // 目录选择以 package.json.devmode 为准，再按当前板型过滤兼容库。
    return this.libManagerService.filterByBoardType(
      this.configService.getLibraryListForProject(this.projectService.currentPackageData),
      this.getCurrentBoardType(),
    );
  }

  private getCurrentBoardType(): string {
    return typeof this.projectService.currentBoardConfig?.type === 'string'
      ? this.projectService.currentBoardConfig.type.trim()
      : '';
  }

  private scheduleInstalledStateRefresh() {
    const refreshToken = ++this.installedStateRefreshToken;
    const keywordAtSchedule = this.keyword;
    const runRefresh = () => {
      if (refreshToken !== this.installedStateRefreshToken) {
        return;
      }
      void this.refreshInstalledState(refreshToken, keywordAtSchedule);
    };

    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(() => window.setTimeout(runRefresh, 0));
      return;
    }

    setTimeout(runRefresh, 0);
  }

  private async refreshInstalledState(refreshToken: number, keywordAtSchedule: string) {
    try {
      const libraryList = this.libManagerService.applyLocalization(
        await this.checkInstalled(),
        this.translate.currentLang,
      );
      if (
        refreshToken !== this.installedStateRefreshToken ||
        keywordAtSchedule !== this.keyword
      ) {
        return;
      }

      this.libraryList = libraryList;
      this.cd.detectChanges();
    } catch (error) {
      console.warn('[LibManager] failed to refresh installed library state:', error);
    }
  }

  async search(keyword = this.keyword) {
    this.keyword = keyword;
    // Invalidate in-flight searches immediately, before the debounce elapses.
    this.searchRequestToken++;
    this.searchSubject.next(keyword);
  }

  private async doSearch(keyword: string) {
    const searchToken = ++this.searchRequestToken;
    const isCurrentSearch = () => (
      !this.isDestroyed &&
      searchToken === this.searchRequestToken &&
      keyword === this.keyword
    );

    if (!keyword) {
      const libraryList = this.libManagerService.applyLocalization(
        await this.checkInstalled(),
        this.translate.currentLang,
      );

      if (!isCurrentSearch()) {
        return;
      }

      this.libraryList = libraryList;
      this.resetListScroll();
      this.cd.detectChanges();
      return;
    }

    const keywordLower = keyword.toLowerCase();
    const libraryList = await this.checkInstalled();

    if (!isCurrentSearch()) {
      return;
    }

    if (keywordLower === 'installed' || keywordLower === 'lib-core') {
      const matchedItems = this.libManagerService.filterByFulltext(libraryList, keywordLower);
      this.libraryList = this.libManagerService.applyLocalization(matchedItems, this.translate.currentLang);
      this.resetListScroll();
      this.cd.detectChanges();
      return;
    }

    const results = await this.libManagerService.searchLibraryList(
      libraryList,
      keyword,
      this.translate.currentLang,
    );

    if (!isCurrentSearch()) {
      return;
    }

    this.libraryList = results;
    this.resetListScroll();
    this.cd.detectChanges();
  }

  back() {
    this.close.emit();
  }

  async getVerisons(lib) {
    this.loading = true;
    // Python 库版本从 Linux npm 仓库查询；Arduino 沿用默认 npm 配置。
    lib.versionList = this.npmService.getPackageVersionList(
      lib.name,
      this.configService.getNpmRegistryForProject(this.projectService.currentPackageData),
    );
    this.loading = false;
  }

  output = '';
  private libraryOperationQueue: LibraryOperation[] = [];
  private isProcessingLibraryOperationQueue = false;
  private libraryOperationRequiresRuntimeRebuild = false;
  private libraryOperationStates = new Map<string, LibraryOperationState>();

  async installLib(lib: PackageInfo) {
    if (this.isLibraryOperationPending(lib.name)) {
      return;
    }

    if (!await this.checkCompatibility(lib.compatibility, this.projectService.currentBoardConfig)) {
      return;
    }

    if (this.isLibraryOperationPending(lib.name)) {
      return;
    }

    this.enqueueLibraryOperation('install', lib);
  }

  async removeLib(lib: PackageInfo) {
    if (this.isLibraryOperationPending(lib.name)) {
      return;
    }

    // 移除库前，应先检查项目代码是否使用了该库，如果使用了，应提示用户
    if (this.checkLibUsage(lib)) {
      this.message.warning(this.translate.instant('LIB_MANAGER.LIB_IN_USE'), { nzDuration: 5000 });
      return;
    }

    this.enqueueLibraryOperation('uninstall', lib);
  }

  private enqueueLibraryOperation(type: LibraryOperationType, lib: PackageInfo) {
    const queuedLib = { ...lib };
    const state = type === 'install' ? 'installing' : 'uninstalling';

    this.setLibraryOperationState(lib.name, state);
    this.libraryOperationQueue.push({ type, lib: queuedLib });
    void this.processLibraryOperationQueue();
  }

  private async processLibraryOperationQueue() {
    if (this.isProcessingLibraryOperationQueue) {
      return;
    }

    this.isProcessingLibraryOperationQueue = true;
    const projectPath = this.projectService.currentProjectPath;
    const workflowStarted = this.workflowService.startInstall();
    const errors: string[] = [];

    try {
      while (this.libraryOperationQueue.length > 0 && this.projectService.currentProjectPath === projectPath) {
        const operation = this.libraryOperationQueue.shift();
        if (!operation) {
          continue;
        }

        const result = operation.type === 'install'
          ? await this.runInstallOperation(operation.lib)
          : await this.runUninstallOperation(operation.lib);

        if (!result.success) {
          const detail = result.error ? `: ${result.error}` : '';
          errors.push(`${this.getLibraryDisplayName(result.lib)}${detail}`);
        }
      }
    } finally {
      try {
        if (this.libraryOperationRequiresRuntimeRebuild && this.projectService.currentProjectPath === projectPath) {
          this.libraryOperationRequiresRuntimeRebuild = false;
          await this.projectService.rebuildBlocklyRuntimeAfterLibraryChange(projectPath);
        }
      } catch (error) {
        errors.push(this.getErrorMessage(error, 'Library runtime refresh failed'));
        this.message.error(errors[errors.length - 1]);
      } finally {
        this.isProcessingLibraryOperationQueue = false;
        if (workflowStarted) this.workflowService.finishInstall(errors.length === 0, errors.join('\n'));
        if (this.libraryOperationQueue.length && this.projectService.currentProjectPath === projectPath) void this.processLibraryOperationQueue();
      }
    }
  }

  private async runInstallOperation(lib: PackageInfo): Promise<LibraryOperationResult> {
    // console.log('当前项目路径：', this.projectService.currentProjectPath);

    this.setLibraryOperationState(lib.name, 'installing');
    this.message.loading(`${this.getLibraryDisplayName(lib)} ${this.translate.instant('LIB_MANAGER.INSTALLING')}...`);
    this.output = '';
    try {
      const packageSpec = lib.version ? `${lib.name}@${lib.version}` : lib.name;
      await this.projectService.changeLibraries('install', [packageSpec]);
      this.libraryOperationRequiresRuntimeRebuild = true;

      this.clearLibraryOperationState(lib.name);
      await this.refreshCurrentLibraryList();
      // lib.state = 'default';
      this.message.success(`${this.getLibraryDisplayName(lib)} ${this.translate.instant('LIB_MANAGER.INSTALLED')}`);

      return { type: 'install', lib, success: true };
    } catch (error) {
      const errorMessage = this.getErrorMessage(error, 'Install failed');
      this.clearLibraryOperationState(lib.name);
      await this.refreshCurrentLibraryList();
      this.setDisplayedLibraryState(lib.name, 'error');
      this.message.error(`${this.getLibraryDisplayName(lib)} ${this.translate.instant('LIB_MANAGER.INSTALL_FAILED')}: ${errorMessage}`);
      return { type: 'install', lib, success: false, error: errorMessage };
    }
  }

  private async runUninstallOperation(lib: PackageInfo): Promise<LibraryOperationResult> {
    this.setLibraryOperationState(lib.name, 'uninstalling');
    this.message.loading(`${this.getLibraryDisplayName(lib)} ${this.translate.instant('LIB_MANAGER.UNINSTALLING')}...`);
    this.output = '';

    try {
      if (this.checkLibUsage(lib)) {
        const message = this.translate.instant('LIB_MANAGER.LIB_IN_USE');
        this.message.warning(message, { nzDuration: 5000 });
        throw new Error(message);
      }

      await this.projectService.changeLibraries('remove', [lib.name]);

      this.clearLibraryOperationState(lib.name);
      await this.refreshCurrentLibraryList();
      // lib.state = 'default';
      this.message.success(`${this.getLibraryDisplayName(lib)} ${this.translate.instant('LIB_MANAGER.UNINSTALLED')}`);
      this.libraryOperationRequiresRuntimeRebuild = true;
      return { type: 'uninstall', lib, success: true };
    } catch (error) {
      const errorMessage = this.getErrorMessage(error, 'Uninstall failed');
      this.clearLibraryOperationState(lib.name);
      await this.refreshCurrentLibraryList();

      this.message.error(`${this.getLibraryDisplayName(lib)} ${this.translate.instant('NPM.UNINSTALL_FAILED_TITLE')}: ${errorMessage}`);
      return { type: 'uninstall', lib, success: false, error: errorMessage };
    }
  }

  private async refreshCurrentLibraryList() {
    this.libraryList = this.libManagerService.applyLocalization(
      await this.checkInstalled(this.libraryList),
      this.translate.currentLang,
    );
    this.cd.detectChanges();
  }

  private isLibraryOperationPending(packageName: string): boolean {
    return this.libraryOperationStates.has(packageName);
  }

  private setLibraryOperationState(packageName: string, state: LibraryOperationState) {
    this.libraryOperationStates.set(packageName, state);
    this.setDisplayedLibraryState(packageName, state);
  }

  private clearLibraryOperationState(packageName: string) {
    this.libraryOperationStates.delete(packageName);
  }

  private applyLibraryOperationStates(libraryList: PackageInfo[]) {
    for (const lib of libraryList) {
      const state = this.libraryOperationStates.get(lib.name);
      if (state) {
        lib.state = state;
      }
    }
    return libraryList;
  }

  private setDisplayedLibraryState(packageName: string, state: PackageInfo['state']) {
    for (const lib of this.libraryList) {
      if (lib.name === packageName) {
        lib.state = state;
      }
    }
    this.cd.detectChanges();
  }

  private getLibraryDisplayName(lib: PackageInfo): string {
    return lib._nickname || lib.nickname || lib.name;
  }

  private getErrorMessage(error: unknown, fallback: string): string {
    let message = fallback;
    if (error instanceof Error && error.message) {
      message = error.message;
    } else if (typeof error === 'string' && error) {
      message = error;
    }

    return message.length > 240 ? `${message.slice(0, 240)}...` : message;
  }


  checkLibUsage(lib) {
    if (!lib?.name) {
      return false;
    }

    const libPackagePath = this.electronService.pathJoin(
      this.projectService.currentProjectPath,
      'node_modules',
      ...lib.name.split('/'),
    );
    return this.blocklyService.isLibraryUsedByCurrentProject(libPackagePath)
      || this.blocklyService.isLibraryPackageNameUsedByCurrentProject(lib.name);
  }

  async checkCompatibility(
    compatibility: PackageInfo['compatibility'],
    board: { type?: string; core?: string } | null | undefined,
  ): Promise<boolean> {
    const libCompatibility = Array.isArray(compatibility?.type)
      ? compatibility.type
      : compatibility?.core;
    // Unconstrained packages remain installable. Declared constraints use the
    // same matching rule as visibility, without shortening the board identity.
    if (!Array.isArray(libCompatibility) || libCompatibility.length === 0
        || this.libManagerService.matchesBoardCompatibility(compatibility, board?.type, board?.core)) {
      return true;
    }

    const boardCore = board?.type || board?.core || '';

    return new Promise<boolean>((resolve) => {
      const modalRef = this.modal.create({
        nzTitle: null,
        nzFooter: null,
        nzClosable: false,
        nzBodyStyle: {
          padding: '0',
        },
        nzWidth: '360px',
        nzContent: CompatibleDialogComponent,
        nzData: { libCompatibility, boardCore },
        // nzDraggable: true,
      });

      modalRef.afterClose.subscribe(async result => {
        if (!result) {
          // 用户直接关闭对话框，视为取消操作
          resolve(false);
          return;
        }
        switch (result.result) {
          case 'continue':
            resolve(true);
            break;
          case 'cancel':
            resolve(false);
            break;
          default:
            resolve(false);
            break;
        }
      });
    });
  }

  openExample(packageName) {
    this.electronService.openNewInStance('/main/playground/s/' + packageName.replace(/^@aily-project(?:-linux)?\//, ''))
  }

  private getImportedLibraryBasePath() {
    return this.electronService.pathJoin(this.projectService.currentProjectPath, 'local-libraries');
  }

  private resolveImportedLibraryPath(packageName: string) {
    return this.electronService.pathJoin(this.getImportedLibraryBasePath(), ...packageName.split('/'));
  }

  private async copyLibraryToProject(folderPath: string): Promise<{ importedLibraryPath: string; packageName: string }> {
    const packageJsonPath = this.electronService.pathJoin(folderPath, 'package.json');
    const packageJson = JSON.parse(this.electronService.readFile(packageJsonPath));
    const packageName = packageJson?.name;

    if (!packageName) {
      throw new Error('package.json 缺少 name 字段');
    }

    const importedLibraryPath = this.resolveImportedLibraryPath(packageName);
    const importedLibraryParentPath = this.electronService.pathJoin(importedLibraryPath, '..');

    await this.crossPlatformCmdService.createDirectory(importedLibraryParentPath, true);

    if (folderPath !== importedLibraryPath && this.electronService.exists(importedLibraryPath)) {
      await this.crossPlatformCmdService.removeItem(importedLibraryPath, true, true);
    }

    if (folderPath !== importedLibraryPath) {
      await this.crossPlatformCmdService.copyItem(folderPath, importedLibraryPath, true, true);
    }

    return { importedLibraryPath, packageName };
  }

  /** 将绝对路径转为 npm file: 用的 POSIX 相对路径（相对项目根） */
  private fileDependencyFromProject(importedLibraryPath: string): string {
    const projectPath = this.projectService.currentProjectPath;
    const rel = window['path'].relative(projectPath, importedLibraryPath);
    const normalized = rel.split(/[/\\]/).join('/');
    return normalized.startsWith('.') ? normalized : `./${normalized}`;
  }

  async importLib() {
    try {
      // 弹出文件夹选择对话框
      const folderPath = await window['ipcRenderer'].invoke('select-folder', {
        path: this.projectService.currentProjectPath,
      });

      // 如果用户取消选择，返回
      if (!folderPath || folderPath === this.projectService.currentProjectPath) {
        return;
      }

      // console.log('选择的文件夹路径：', folderPath);

      // 检查选择的路径下是否有package.json、block.json、generator.js文件
      const hasPackageJson = await this.electronService.exists(this.electronService.pathJoin(folderPath, 'package.json'));
      const hasBlockJson = await this.electronService.exists(this.electronService.pathJoin(folderPath, 'block.json'));
      const hasGeneratorJs = await this.electronService.exists(this.electronService.pathJoin(folderPath, 'generator.js'));

      if (!hasPackageJson || !hasBlockJson || !hasGeneratorJs) {
        this.message.error(`${this.translate.instant('LIB_MANAGER.IMPORT_FAILED')}: 该路径下不是aily blockly库`);
        return;
      }

      this.message.loading(`${this.translate.instant('LIB_MANAGER.IMPORTING')}...`);

      // 先复制库到当前项目目录下，再从项目内的副本执行安装（file: 相对路径，便于整项目拷贝/压缩）
      const { importedLibraryPath, packageName } = await this.copyLibraryToProject(folderPath);

      const fileDep = this.fileDependencyFromProject(importedLibraryPath);
      const installSpec = `${packageName}@file:${fileDep}`;
      await this.projectService.changeLibraries('install', [installSpec], { [packageName]: folderPath });
      await this.projectService.rebuildBlocklyRuntimeAfterLibraryChange();

      this.localLibrarySyncService.stop();
      this.localLibrarySyncService.start(this.projectService.currentProjectPath, await this.projectService.getPackageJson());

      // 重新检查已安装的库
      this.libraryList = this.libManagerService.applyLocalization(
        await this.checkInstalled(),
        this.translate.currentLang,
      );

      this.message.success(`${this.translate.instant('LIB_MANAGER.IMPORTED')}`);
    } catch (error) {
      console.error('导入库失败：', error);
      this.message.error(`${this.translate.instant('LIB_MANAGER.IMPORT_FAILED')}: ${error.message || error}`);
    }
  }

  help() {
    this.electronService.openUrl('https://github.com/ailyProject/aily-blockly-libraries/blob/main/readme.md');
  }

  report() {
    this.electronService.openUrl('https://github.com/ailyProject/aily-blockly-libraries/issues');
  }

  openUrl(url: string) {
    this.electronService.openUrl(url);
  }
}

type LibraryOperationType = 'install' | 'uninstall';
type LibraryOperationState = 'installing' | 'uninstalling';

interface LibraryOperation {
  type: LibraryOperationType;
  lib: PackageInfo;
}

interface LibraryOperationResult extends LibraryOperation {
  success: boolean;
  error?: string;
}
