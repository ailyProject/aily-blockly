import { ChangeDetectorRef, Component, NgZone, OnDestroy, OnInit } from '@angular/core';
import { LibManagerComponent } from './components/lib-manager/lib-manager.component';
import { NotificationComponent } from '../../components/notification/notification.component';
import { UiService } from '../../services/ui.service';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { ActivatedRoute } from '@angular/router';
import { ElectronService } from '../../services/electron.service';
import { NzMessageService } from 'ng-zorro-antd/message';
import { NzModalService } from 'ng-zorro-antd/modal';
import { ConfigService } from '../../services/config.service';
import { NpmService } from '../../services/npm.service';
import { CmdService } from '../../services/cmd.service';
import {
  AILY_BLOCKLY_USED_LIBRARIES_FIELD,
  BlocklyProjectDocument,
  BlocklyService,
  BlocklyUsedLibraryManifest,
  BlocklyUsedLibraryManifestEntry,
} from './services/blockly.service';
import { BlocklyComponent } from './components/blockly/blockly.component';
import { _ProjectService } from './services/project.service';
import { _UploaderService } from './services/uploader.service';
import { _BuilderService } from './services/builder.service';
import { BitmapUploadService } from './services/bitmap-upload.service';
import { ProjectService } from '../../services/project.service';
import { DevToolComponent } from './components/dev-tool/dev-tool.component';
import { OnboardingService } from '../../services/onboarding.service';
import { BLOCKLY_ONBOARDING_CONFIG } from '../../configs/onboarding.config';
import { NoticeService } from '../../services/notice.service';
import { LocalLibrarySyncService } from '../../services/local-library-sync.service';
import { CodeViewerIpcService } from './services/code-viewer-ipc.service';
import { CrossPlatformCmdService } from '../../services/cross-platform-cmd.service';
import { MissingLibInfo, PasteInstallDialogComponent } from './components/paste-install-dialog/paste-install-dialog.component';
import { Subscription } from 'rxjs';
import { BlocklyLibraryPackageService } from '../../services/blockly-library-package.service';
import { projectDataRuntime } from '../../services/project-data/project-data-runtime';
import { BlocklyGeneratorRuntimeService } from './services/blockly-generator-runtime.service';
import { ProjectDataError } from '../../services/project-data/project-data.types';

@Component({
  selector: 'app-blockly-editor',
  imports: [
    BlocklyComponent,
    LibManagerComponent,
    NotificationComponent,
    TranslateModule,
    DevToolComponent,
  ],
  providers: [_BuilderService, _UploaderService, BitmapUploadService],
  templateUrl: './blockly-editor.component.html',
  styleUrl: './blockly-editor.component.scss',
})
export class BlocklyEditorComponent implements OnInit, OnDestroy {
  showLibraryManager = false;

  private readonly packageJsonWatchDebounceMs = 300;
  /** 会话/检查点恢复会短暂改写 package.json，移除告警需等依赖集合稳定后再确认。 */
  private readonly removedLibrarySettleMs = 1200;
  private readonly pendingLibraryLoadRetryMs = 1000;
  private readonly maxPendingLibraryLoadAttempts = 120;
  private readonly pendingBoardReloadRetryMs = 1000;
  private readonly maxPendingBoardReloadAttempts = 120;
  private readonly projectLoadedCodeRefreshDelayMs = 1000;
  private packageJsonWatcherDispose: (() => void) | null = null;
  private packageJsonWatchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private removedLibrarySettleTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingLibraryLoadTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingBoardReloadTimer: ReturnType<typeof setTimeout> | null = null;
  private projectLoadedCodeRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private watchedPackageJsonProjectPath: string | null = null;
  private watchedPackageJsonSignature = '';
  private watchedLibraryDependencies = new Map<string, string>();
  private watchedBoardDependencies = new Map<string, string>();
  private pendingLibraryDependencies = new Set<string>();
  private pendingRemovedLibraryDependencies = new Set<string>();
  private pendingLibraryLoadAttempts = new Map<string, number>();
  private pendingLibraryLoadInProgress = false;
  private pendingBoardDependencyReload: {
    projectPath: string;
    addedBoardNames: string[];
    previousBoardNames: string[];
    attempts: number;
  } | null = null;
  private boardDependencyReloadInProgress = false;
  private boardConfigUpdatedSubscription: Subscription | null = null;
  private runtimeCdcEnabled: boolean | undefined;
  private loadedProjectPath: string | null = null;

  devmode;

  get developerMode(): boolean {
    const devmode = (this.configService.data as any).devmode;
    return typeof devmode === 'boolean' ? devmode : !!devmode?.enabled;
  }

  constructor(
    private cd: ChangeDetectorRef,
    private uiService: UiService,
    private activatedRoute: ActivatedRoute,
    private blocklyService: BlocklyService,
    private electronService: ElectronService,
    private message: NzMessageService,
    private modal: NzModalService,
    private configService: ConfigService,
    private npmService: NpmService,
    private cmdService: CmdService,
    private crossPlatformCmdService: CrossPlatformCmdService,
    private projectService: ProjectService,
    private _projectService: _ProjectService,
    private _builderService: _BuilderService,
    private _uploadService: _UploaderService,
    private onboardingService: OnboardingService,
    private translate: TranslateService,
    private noticeService: NoticeService,
    private ngZone: NgZone,
    private localLibrarySyncService: LocalLibrarySyncService,
    private codeViewerIpcService: CodeViewerIpcService,
    private blocklyLibraryPackageService: BlocklyLibraryPackageService,
    private generatorRuntime: BlocklyGeneratorRuntimeService,
  ) { }

  ngOnInit(): void {
    this.activatedRoute.queryParams.subscribe(async (params) => {
      if (params['path']) {
        const requestedProjectPath = params['path'];
        console.log('project path', requestedProjectPath);
        try {
          if (
            this.loadedProjectPath
            && this.loadedProjectPath !== requestedProjectPath
            && this.generatorRuntime.isActive()
          ) {
            await this.projectService.projectOpen(requestedProjectPath);
            return;
          }
          this._projectService.currentProjectPath = requestedProjectPath;
          this.projectService.currentProjectPath = requestedProjectPath;
          projectDataRuntime.configure(params['path']);
          await this.loadProject(requestedProjectPath);
          this.loadedProjectPath = requestedProjectPath;
        } catch (error) {
          console.error('加载项目失败', error);
          const detail = this.formatProjectLoadError(error);
          this.abortFailedProjectLoad();
          this.projectService.stateSubject.next('error');
          this.message.error(detail);
        }
      } else {
        this.message.error('没有找到项目路径');
      }
    });

    this._projectService.init();
    this._builderService.init();
    this._uploadService.init();
    this.boardConfigUpdatedSubscription = this.projectService.boardConfigUpdatedSubject.subscribe((boardConfig) => {
      this.applyRuntimeBoardConfig(boardConfig);
    });

    // 阻止鼠标按键前进后退
    window.history.replaceState(null, '', window.location.href);
    window.history.pushState(null, '', window.location.href);
  }

  private abortFailedProjectLoad(): void {
    this.loadedProjectPath = null;
    this.clearProjectLoadedCodeRefreshTimer();
    this.stopPackageJsonDependencyWatch();
    this.localLibrarySyncService.stop();
    try {
      // Runtime isolation teardown requires workspace disposal before the host
      // checkpoint and iframe Realm are released. BlocklyService.reset owns
      // that ordering and also unregisters project-owned Data Slots.
      this.blocklyService.reset();
    } finally {
      try {
        // Idempotent safeguard: if a project-defined workspace dispose hook
        // throws inside reset(), the tainted iframe Realm must still be gone.
        this.generatorRuntime.destroy();
      } finally {
        projectDataRuntime.reset();
      }
    }
  }

  private formatProjectLoadError(error: unknown): string {
    if (error instanceof ProjectDataError) {
      const diagnostics = Array.isArray(error.details?.['diagnostics'])
        ? error.details['diagnostics'] as Array<Record<string, unknown>>
        : [];
      const first = diagnostics[0];
      if (first) {
        const owner = [first['blockType'], first['fieldName']].filter(Boolean).join('.');
        const actual = Number(first['canonicalLength']);
        const threshold = Number(first['threshold']);
        const size = Number.isFinite(actual) ? `${actual} bytes` : 'unknown size';
        const limit = Number.isFinite(threshold) ? `${threshold} bytes` : 'the configured limit';
        return `项目数据加载失败：${owner || first['jsonPointer'] || 'unknown field'} 为 ${size}，超过 ${limit}。`;
      }
      return `项目数据加载失败：${error.message}`;
    }
    return `加载项目失败：${error instanceof Error ? error.message : String(error)}`;
  }

  ngOnDestroy(): void {
    this.boardConfigUpdatedSubscription?.unsubscribe();
    this.boardConfigUpdatedSubscription = null;
    this.uiService.closeTool('code-viewer');
    this.clearProjectLoadedCodeRefreshTimer();
    this.localLibrarySyncService.stop();
    this.stopPackageJsonDependencyWatch();
    this._projectService.destroy();
    this._builderService.cancel();
    this._builderService.destroy();
    this._uploadService.cancel();
    this._uploadService.destroy();
    this.codeViewerIpcService.clear();
    this.electronService.setTitle('aily blockly');
    this.blocklyService.reset();
    projectDataRuntime.reset();
  }

  async loadProject(projectPath) {
    this.stopPackageJsonDependencyWatch();
    this.clearProjectLoadedCodeRefreshTimer();
    // 处理 temp 下的 package.json：有则覆盖主项目，无则从主项目复制到 temp
    await this.projectService.syncPackageJsonWithTemp(projectPath);
    // 加载项目package.json
    let packageJson = JSON.parse(
      this.electronService.readFile(`${projectPath}/package.json`),
    );
    // 加载项目开发框架
    this.devmode = packageJson.devmode || 'arduino'; // 可选项: 'arduino', 'micropython'

    this.electronService.setTitle(`aily blockly - ${packageJson.nickname || packageJson.name}`);
    // 添加到最近打开的项目
    this.projectService.addRecentlyProject({
      name: packageJson.name,
      path: projectPath,
      nickname: packageJson.nickname || packageJson.name,
    });
    // 设置当前项目路径和package.json数据
    this.applyProjectPackageJson(packageJson);
    // 与 Aily Code（code-editor-pro）共用：node_modules 不齐则 npm install
    if (!(await this.npmService.ensureProjectDependenciesInstalled(projectPath))) {
      return;
    }

    const missingDeclaredLibraries: string[] = [];
    let dependencyInstallError = '';
    if (!(await this.npmService.installedOk(projectPath))) {
      // 终端进入项目目录，安装项目依赖
      // this.uiService.updateFooterState({ state: 'doing', text: this.translate.instant('BLOCKLY_EDITOR.INSTALLING_DEPS') });
      setTimeout(() => {
        this.noticeService.update({
          title: this.translate.instant('NPM.INSTALLING_TITLE'),
          text: this.translate.instant('BLOCKLY_EDITOR.INSTALLING_DEPS'),
          state: 'doing',
          icon: 'fa-light fa-cubes',
          showProgress: false,
        });
      }, 0);
      try {
        await this.cmdService.runAsyncChecked(`npm install`, projectPath);
      } catch (error) {
        dependencyInstallError = (error as Error)?.message || String(error);
        console.warn('[ProjectLoad] npm install failed:', error);
      }
      if (!(await this.npmService.installedOk(projectPath))) {
        packageJson = this.readProjectPackageJson(projectPath) || packageJson;
        this.applyProjectPackageJson(packageJson);

        const missingDependencies = this.getMissingDeclaredDependencies(projectPath, packageJson);
        const missingLibraries = missingDependencies.filter((name) => this.isBlocklyLibraryPackageName(name));
        const blockingDependencies = missingDependencies.filter((name) => !this.isBlocklyLibraryPackageName(name));

        if (missingLibraries.length === 0 || blockingDependencies.length > 0) {
          const missingDependencyDetail = missingDependencies.length > 0
            ? `缺失依赖：${missingDependencies.join(', ')}`
            : 'npm install 执行完成但依赖检查未通过';
          setTimeout(() => {
            this.noticeService.update({
              title: this.translate.instant('NPM.INSTALL_FAILED_TITLE'),
              text: this.translate.instant('NPM.BOARD_DEPS_INSTALL_FAILED'),
              detail: dependencyInstallError
                ? `${missingDependencyDetail}\n${dependencyInstallError}`
                : missingDependencyDetail,
              state: 'error',
              sendToLog: false,
            });
          }, 1000);
          this.projectService.stateSubject.next('error');
          return;
        }

        missingDeclaredLibraries.push(...missingLibraries);
        console.error('[ProjectLoad] continuing with missing Blockly libraries:', missingLibraries);
      } else {
        setTimeout(() => {
          this.noticeService.update({
            title: this.translate.instant('NPM.INSTALL_COMPLETE_TITLE'),
            text: this.translate.instant('NPM.DEPS_INSTALL_COMPLETE'),
            state: 'done',
            showProgress: false,
            setTimeout: 3000,
          });
        }, 100);
      }
    }
    // 3. 加载开发板module中的board.json
    this.uiService.updateFooterState({
      state: 'doing',
      text: this.translate.instant('BLOCKLY_EDITOR.LOADING_BOARD_CONFIG'),
    });
    const boardJson = await this.projectService.resolveBoardConfigForRuntime();

    this.projectService.currentBoardConfig = boardJson;
    this.blocklyService.boardConfig = boardJson;
    window['boardConfig'] = boardJson;
    await this.projectService.loadBoardMenuConfig();
    this.runtimeCdcEnabled = !!boardJson?._cdcEnabled;
    // 4. 加载blockly library
    this.uiService.updateFooterState({
      state: 'doing',
      text: this.translate.instant('BLOCKLY_EDITOR.LOADING_BLOCKLY_LIB'),
    });
    // 获取项目目录下的所有blockly库
    let libraryModuleList = (
      await this.npmService.getAllInstalledLibraries(projectPath)
    ).map((item) => item.name);

    await this.blocklyService.waitForWorkspace();
    this.generatorRuntime.updateContext({
      projectPath,
      boardConfig: boardJson,
      packageJson,
      projectService: this.projectService,
    });

    for (let index = 0; index < libraryModuleList.length; index++) {
      const libPackageName = libraryModuleList[index];
      this.uiService.updateFooterState({
        state: 'doing',
        text: this.translate.instant('BLOCKLY_EDITOR.LOADING_LIB', {
          name: libPackageName,
        }),
      });
      await this.blocklyService.loadLibrary(libPackageName, projectPath);
    }
    // 5. 加载project.abi数据
    this.uiService.updateFooterState({
      state: 'doing',
      text: this.translate.instant('BLOCKLY_EDITOR.LOADING_BLOCKLY_PROGRAM'),
    });
    const {
      document: projectDocument,
      usedBoardTemplate: usedBoardTemplateAbi,
    } = await this.loadProjectAbiDocument(projectPath);

    const missingProjectLibraries = this.getMissingProjectLibraries(projectPath, packageJson, projectDocument);
    if (missingProjectLibraries.length > 0) {
      const restored = await this.restoreMissingProjectLibraries(projectPath, missingProjectLibraries);
      if (!restored) {
        this.handleMissingProjectLibrariesCancelled(missingProjectLibraries);
        return;
      }

      packageJson = this.readProjectPackageJson(projectPath) || packageJson;
      this.applyProjectPackageJson(packageJson);
      await this.loadInstalledBlocklyLibraries(projectPath);
    }

    await this.waitForNextFrame();
    this.blocklyService.loadProjectDocument(projectDocument, false);
    if (!usedBoardTemplateAbi && this._projectService.syncUsedLibraryManifest(projectPath, projectDocument)) {
      packageJson = this.readProjectPackageJson(projectPath) || packageJson;
      this.applyProjectPackageJson(packageJson);
    }

    // 6. 加载项目目录中project.abi（这是blockly格式的json文本必须要先安装库才能加载这个json，因为其中可能会用到一些库）
    this.uiService.updateFooterState({
      state: 'done',
      text: this.translate.instant('BLOCKLY_EDITOR.PROJECT_LOAD_SUCCESS'),
    });
    this.projectService.stateSubject.next('loaded');
    this.generatorRuntime.markReady(projectPath);
    this.scheduleProjectLoadedCodeRefresh();

    if (missingDeclaredLibraries.length > 0) {
      const libraryNames = missingDeclaredLibraries.join(', ');
      this.noticeService.update({
        title: '项目已加载，部分积木库缺失',
        text: `缺失积木库：${libraryNames}`,
        detail: dependencyInstallError || '请检查 package.json 中的库版本或本地 file: 路径。',
        state: 'error',
        sendToLog: false,
      });
    }

    this.startPackageJsonDependencyWatch(projectPath);
    this.localLibrarySyncService.start(projectPath);
    // 项目加载完成后自动生成 sketch.ino，供 AI 工具和代码预览使用（无需触发完整编译）
    setTimeout(() => {
      this._builderService.generateAndWriteSketchIno().catch(e => {
        console.warn('[loadProject] 自动生成 sketch.ino 失败:', e);
      });
    }, 600); // 等待 Blockly 渲染完成（debounce 500ms + 余量）

    // 检查是否需要显示新手引导
    this.checkBlocklyOnboarding();

    // 7. 后台安装开发板依赖
    this.npmService
      .installBoardDeps()
      .then(() => {
        console.log('install board dependencies success');
      })
      .catch(() => undefined);
  }

  private async loadProjectAbiDocument(projectPath: string): Promise<{
    document: BlocklyProjectDocument;
    usedBoardTemplate: boolean;
  }> {
    const abiPath = this.electronService.pathJoin(projectPath, 'project.abi');
    let abiContent = await this.electronService.readFileAsync(abiPath);
    let projectAbi = await this.parseProjectAbiContent(abiContent);
    projectAbi = await this.projectService.ensureProjectDataSchemaForLoad(
      projectPath,
      projectAbi,
      abiContent,
    );
    abiContent = '';

    let usedBoardTemplate = false;
    if (this.hasEmptyLegacyWorkspace(projectAbi)) {
      const boardTemplateAbi = await this.readCurrentBoardTemplateAbi(projectPath);
      if (boardTemplateAbi && !this.hasEmptyLegacyWorkspace(boardTemplateAbi)) {
        projectAbi = await this.projectService.ensureProjectDataSchemaForLoad(
          projectPath,
          boardTemplateAbi,
        );
        usedBoardTemplate = true;
        console.info('[ProjectAbi] project.abi is empty; using the current board template as temporary data.');
      }
    }

    return {
      document: this.blocklyService.normalizeProjectAbiForLoad(projectAbi),
      usedBoardTemplate,
    };
  }

  private hasEmptyLegacyWorkspace(projectAbi: any): boolean {
    return Array.isArray(projectAbi?.blocks?.blocks) && projectAbi.blocks.blocks.length === 0;
  }

  private async readCurrentBoardTemplateAbi(projectPath: string): Promise<any | null> {
    try {
      const boardModule = await this.projectService.getBoardModule();
      if (!boardModule) {
        console.warn('[ProjectAbi] cannot use board template: no board dependency was found.');
        return null;
      }

      const boardPackagePath = this.getNodeModulePackagePath(projectPath, boardModule);
      const templateAbiPath = this.electronService.pathJoin(boardPackagePath, 'template', 'project.abi');
      if (!this.electronService.exists(templateAbiPath)) {
        console.warn('[ProjectAbi] board template project.abi does not exist:', templateAbiPath);
        return null;
      }

      const templateContent = await this.electronService.readFileAsync(templateAbiPath);
      return await this.parseProjectAbiContent(templateContent);
    } catch (error) {
      console.warn('[ProjectAbi] failed to load board template project.abi:', error);
      return null;
    }
  }

  private async parseProjectAbiContent(content: string): Promise<any> {
    if (typeof Worker === 'undefined') {
      return this.parseProjectAbiContentOnMainThread(content);
    }

    try {
      return await this.parseProjectAbiContentInWorker(content);
    } catch (error) {
      if ((error as Error)?.name === 'ProjectAbiParseError') {
        throw error;
      }

      console.warn('[ProjectAbiParser] worker unavailable, falling back to main thread parse:', error);
      return this.parseProjectAbiContentOnMainThread(content);
    }
  }

  private parseProjectAbiContentInWorker(content: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const requestId = Date.now();
      let worker: Worker;

      try {
        worker = new Worker(
          new URL('./workers/project-abi-parser.worker.ts', import.meta.url),
          { type: 'module' },
        );
      } catch (error) {
        reject(error);
        return;
      }

      const cleanup = () => worker.terminate();

      worker.onmessage = (event: MessageEvent<{ id: number; data?: any; error?: string }>) => {
        const message = event.data;
        if (!message || message.id !== requestId) {
          return;
        }

        cleanup();
        if (message.error) {
          const parseError = new Error(message.error);
          parseError.name = 'ProjectAbiParseError';
          reject(parseError);
          return;
        }

        resolve(message.data);
      };

      worker.onerror = (error) => {
        cleanup();
        reject(new Error(error.message || 'Project ABI parser worker failed'));
      };

      try {
        worker.postMessage({ id: requestId, content });
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  }

  private async parseProjectAbiContentOnMainThread(content: string): Promise<any> {
    await this.waitForNextFrame();
    return JSON.parse(content);
  }

  private waitForNextFrame(): Promise<void> {
    return new Promise((resolve) => {
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => resolve());
        return;
      }

      setTimeout(resolve, 0);
    });
  }

  private scheduleProjectLoadedCodeRefresh(): void {
    this.clearProjectLoadedCodeRefreshTimer();
    this.projectLoadedCodeRefreshTimer = setTimeout(() => {
      this.projectLoadedCodeRefreshTimer = null;
      this.blocklyService.requestCodeViewerRefresh(true);
    }, this.projectLoadedCodeRefreshDelayMs);
  }

  private applyRuntimeBoardConfig(boardConfig: any): void {
    const cdcEnabled = !!boardConfig?._cdcEnabled;
    const shouldRestoreSerialFields = this.runtimeCdcEnabled === true && !cdcEnabled;
    const serialFieldSnapshots = shouldRestoreSerialFields && Array.isArray(boardConfig?.cdcSerialPort)
      ? this.blocklyService.snapshotSerialFieldValues()
      : null;

    this.blocklyService.boardConfig = boardConfig;
    window['boardConfig'] = boardConfig;
    if (this.generatorRuntime.isActive()) {
      this.generatorRuntime.updateBoardConfig(boardConfig);
    }
    this.blocklyService.refreshBoardDependentBlockDefinitions();
    this.blocklyService.syncSerialDynamicToolboxBlocks();
    this.generatorRuntime.invokeGlobal('updateSerialCustomPorts');

    if (serialFieldSnapshots && Array.isArray(boardConfig?.cdcSerialPort)) {
      this.blocklyService.applySerialPortFieldsAfterCdcDisabled(boardConfig.cdcSerialPort, serialFieldSnapshots);
    }

    this.runtimeCdcEnabled = cdcEnabled;
  }

  private clearProjectLoadedCodeRefreshTimer(): void {
    if (this.projectLoadedCodeRefreshTimer) {
      clearTimeout(this.projectLoadedCodeRefreshTimer);
      this.projectLoadedCodeRefreshTimer = null;
    }
  }

  private startPackageJsonDependencyWatch(projectPath: string): void {
    this.stopPackageJsonDependencyWatch();

    const fsApi = window['fs'];
    const watch = fsApi?.watch;
    if (typeof watch !== 'function') {
      console.warn('[PackageJsonWatch] fs.watch is unavailable');
      return;
    }

    if (!this.refreshPackageJsonDependencySnapshot(projectPath)) {
      return;
    }

    this.watchedPackageJsonProjectPath = projectPath;
    this.projectService.isPackageJsonBoardWatcherActive = true;
    this.ngZone.runOutsideAngular(() => {
      try {
        this.packageJsonWatcherDispose = watch(projectPath, (event) => {
          if (event?.eventType === 'error') {
            console.warn('[PackageJsonWatch] watch error:', event.error);
            return;
          }

          if (event?.filename && window['path']?.basename(event.filename) !== 'package.json') {
            return;
          }

          this.schedulePackageJsonDependencyCheck(projectPath);
        });
      } catch (error) {
        console.warn('[PackageJsonWatch] failed to start:', error);
        this.stopPackageJsonDependencyWatch();
      }
    });
  }

  private stopPackageJsonDependencyWatch(): void {
    if (this.packageJsonWatcherDispose) {
      try {
        this.packageJsonWatcherDispose();
      } catch (error) {
        console.warn('[PackageJsonWatch] failed to stop:', error);
      }
      this.packageJsonWatcherDispose = null;
    }

    if (this.packageJsonWatchDebounceTimer) {
      clearTimeout(this.packageJsonWatchDebounceTimer);
      this.packageJsonWatchDebounceTimer = null;
    }

    if (this.removedLibrarySettleTimer) {
      clearTimeout(this.removedLibrarySettleTimer);
      this.removedLibrarySettleTimer = null;
    }

    if (this.pendingLibraryLoadTimer) {
      clearTimeout(this.pendingLibraryLoadTimer);
      this.pendingLibraryLoadTimer = null;
    }

    if (this.pendingBoardReloadTimer) {
      clearTimeout(this.pendingBoardReloadTimer);
      this.pendingBoardReloadTimer = null;
    }

    this.watchedPackageJsonProjectPath = null;
    this.projectService.isPackageJsonBoardWatcherActive = false;
    this.watchedPackageJsonSignature = '';
    this.watchedLibraryDependencies.clear();
    this.watchedBoardDependencies.clear();
    this.pendingLibraryDependencies.clear();
    this.pendingRemovedLibraryDependencies.clear();
    this.pendingLibraryLoadAttempts.clear();
    this.pendingLibraryLoadInProgress = false;
    this.pendingBoardDependencyReload = null;
    this.boardDependencyReloadInProgress = false;
  }

  private schedulePackageJsonDependencyCheck(projectPath: string): void {
    if (this.packageJsonWatchDebounceTimer) {
      clearTimeout(this.packageJsonWatchDebounceTimer);
    }

    this.packageJsonWatchDebounceTimer = setTimeout(() => {
      this.packageJsonWatchDebounceTimer = null;
      void this.handlePackageJsonDependencyChange(projectPath);
    }, this.packageJsonWatchDebounceMs);
  }

  private async handlePackageJsonDependencyChange(projectPath: string): Promise<void> {
    if (this.watchedPackageJsonProjectPath !== projectPath) {
      return;
    }

    let nextPackageJson: any;
    try {
      const packageJsonPath = this.electronService.pathJoin(projectPath, 'package.json');
      const nextContent = this.electronService.readFile(packageJsonPath);
      if (nextContent === this.watchedPackageJsonSignature) {
        return;
      }

      nextPackageJson = JSON.parse(nextContent);
      this.watchedPackageJsonSignature = nextContent;
    } catch (error) {
      console.warn('[PackageJsonWatch] package.json read failed:', error);
      return;
    }

    this.applyProjectPackageJson(nextPackageJson);

    const nextBoardDependencies = this.getDeclaredBoardDependencies(nextPackageJson);
    const nextLibraryDependencies = this.getDeclaredBlocklyLibraryDependencies(nextPackageJson);

    if (this.projectService.isBoardSwitchInProgress) {
      this.watchedBoardDependencies = nextBoardDependencies;
      this.watchedLibraryDependencies = nextLibraryDependencies;
      return;
    }

    const previousBoardDependencies = this.watchedBoardDependencies;
    const addedBoardNames = Array.from(nextBoardDependencies.keys()).filter(
      (name) => !previousBoardDependencies.has(name),
    ).sort((a, b) => a.localeCompare(b));
    this.watchedBoardDependencies = nextBoardDependencies;

    if (addedBoardNames.length > 0) {
      this.handleAddedBoardDependencies(projectPath, addedBoardNames, previousBoardDependencies);
      return;
    }

    // 对比新旧 package.json 中的 blockly library 依赖变化，找出新增和移除的库
    const previousLibraryDependencies = this.watchedLibraryDependencies;
    const addedLibraryNames = Array.from(nextLibraryDependencies.keys()).filter(
      (name) => !previousLibraryDependencies.has(name),
    ).sort((a, b) => this.compareBlocklyLibraryNames(a, b));
    const removedLibraryNames = Array.from(previousLibraryDependencies.keys()).filter(
      (name) => !nextLibraryDependencies.has(name),
    ).sort((a, b) => this.compareBlocklyLibraryNames(a, b));
    this.watchedLibraryDependencies = nextLibraryDependencies;

    if (removedLibraryNames.length > 0) {
      this.handleRemovedLibraryDependencies(projectPath, removedLibraryNames);
    }

    if (addedLibraryNames.length === 0) {
      return;
    }

    for (const libPackageName of addedLibraryNames) {
      this.pendingRemovedLibraryDependencies.delete(libPackageName);
      if (this.isBlocklyLibraryLoaded(projectPath, libPackageName)) {
        continue;
      }
      this.pendingLibraryDependencies.add(libPackageName);
      if (!this.pendingLibraryLoadAttempts.has(libPackageName)) {
        this.pendingLibraryLoadAttempts.set(libPackageName, 0);
      }
    }

    this.schedulePendingLibraryLoad(projectPath, 0);
  }

  private applyProjectPackageJson(packageJson: any): void {
    this._projectService.currentPackageData = packageJson;
    this.projectService.currentPackageData = packageJson;
    window['packageJson'] = packageJson;
    this.blocklyService.setToolboxSortOrder(packageJson?.blocklyToolboxOrder);
  }

  private handleRemovedLibraryDependencies(projectPath: string, removedLibraryNames: string[]): void {
    for (const libPackageName of removedLibraryNames) {
      this.clearPendingLibrary(libPackageName);
      this.pendingRemovedLibraryDependencies.add(libPackageName);
    }
    this.scheduleRemovedLibrarySettle(projectPath);
  }

  private scheduleRemovedLibrarySettle(projectPath: string): void {
    if (this.removedLibrarySettleTimer) {
      clearTimeout(this.removedLibrarySettleTimer);
    }

    this.removedLibrarySettleTimer = setTimeout(() => {
      this.removedLibrarySettleTimer = null;
      void this.flushRemovedLibraryDependencies(projectPath);
    }, this.removedLibrarySettleMs);
  }

  private async flushRemovedLibraryDependencies(projectPath: string): Promise<void> {
    if (this.watchedPackageJsonProjectPath !== projectPath) {
      this.pendingRemovedLibraryDependencies.clear();
      return;
    }

    const candidateNames = Array.from(this.pendingRemovedLibraryDependencies)
      .sort((a, b) => this.compareBlocklyLibraryNames(a, b));
    this.pendingRemovedLibraryDependencies.clear();
    if (candidateNames.length === 0) {
      return;
    }

    // 会话恢复/检查点回放可能先写回旧 package.json 再恢复最终依赖；稳定后再确认是否真的移除。
    const packageJson = this.readProjectPackageJson(projectPath);
    if (!packageJson) {
      return;
    }

    const currentLibraryDependencies = this.getDeclaredBlocklyLibraryDependencies(packageJson);
    this.watchedLibraryDependencies = currentLibraryDependencies;
    const stillRemovedLibraryNames = candidateNames.filter((name) => !currentLibraryDependencies.has(name));
    if (stillRemovedLibraryNames.length === 0) {
      return;
    }

    let shouldRebuildRuntime = false;
    for (const libPackageName of stillRemovedLibraryNames) {
      if (!this.isBlocklyLibraryLoaded(projectPath, libPackageName)) {
        continue;
      }

      if (
        this.blocklyService.isLibraryPackageNameUsedByCurrentProject(libPackageName)
        || this.isProjectLibraryDeclaredAsUsed(projectPath, libPackageName)
      ) {
        console.warn('[PackageJsonWatch] library dependency removed but still used:', libPackageName);
        this.message.warning(`${libPackageName} 已从 package.json 移除，但项目中仍有相关积木`, { nzDuration: 5000 });
        continue;
      }

      shouldRebuildRuntime = true;
    }

    if (shouldRebuildRuntime && this.watchedPackageJsonProjectPath === projectPath) {
      await this.projectService.rebuildBlocklyRuntimeAfterLibraryChange(projectPath);
    }
  }

  private refreshPackageJsonDependencySnapshot(projectPath: string): boolean {
    try {
      const packageJsonPath = this.electronService.pathJoin(projectPath, 'package.json');
      const content = this.electronService.readFile(packageJsonPath);
      const packageJson = JSON.parse(content);
      this.watchedPackageJsonSignature = content;
      this.watchedLibraryDependencies = this.getDeclaredBlocklyLibraryDependencies(packageJson);
      this.watchedBoardDependencies = this.getDeclaredBoardDependencies(packageJson);
      return true;
    } catch (error) {
      console.warn('[PackageJsonWatch] failed to snapshot package.json:', error);
      return false;
    }
  }

  private getDeclaredBlocklyLibraryDependencies(packageJson: any): Map<string, string> {
    const dependencies = {
      ...(packageJson?.dependencies || {}),
      ...(packageJson?.devDependencies || {}),
    };

    const libraryDependencies = new Map<string, string>();
    for (const [name, version] of Object.entries(dependencies)) {
      if (typeof name === 'string' && this.isBlocklyLibraryPackageName(name)) {
        libraryDependencies.set(name, String(version ?? ''));
      }
    }

    return libraryDependencies;
  }

  /** 从项目 dependencies 中提取已声明的开发板包依赖。 */
  private getDeclaredBoardDependencies(packageJson: any): Map<string, string> {
    const dependencies = packageJson?.dependencies || {};

    const boardDependencies = new Map<string, string>();
    for (const [name, version] of Object.entries(dependencies)) {
      if (typeof name === 'string' && this.isBoardPackageName(name)) {
        boardDependencies.set(name, String(version ?? ''));
      }
    }

    return boardDependencies;
  }

  /** 记录新增开发板依赖，并进入等待安装完成后的重载流程。 */
  private handleAddedBoardDependencies(
    projectPath: string,
    addedBoardNames: string[],
    previousBoardDependencies: Map<string, string>,
  ): void {
    const addedBoardNameSet = new Set(addedBoardNames);
    const previousBoardNames = Array.from(previousBoardDependencies.keys())
      .filter((name) => !addedBoardNameSet.has(name))
      .sort((a, b) => a.localeCompare(b));

    this.pendingBoardDependencyReload = {
      projectPath,
      addedBoardNames,
      previousBoardNames,
      attempts: 0,
    };
    this.schedulePendingBoardReload(projectPath, 0);
  }

  /** 安排一次开发板切换重载检查，用于等待 npm install 写完新开发板文件。 */
  private schedulePendingBoardReload(projectPath: string, delayMs: number): void {
    if (this.pendingBoardReloadTimer) {
      clearTimeout(this.pendingBoardReloadTimer);
    }

    this.pendingBoardReloadTimer = setTimeout(() => {
      this.pendingBoardReloadTimer = null;
      void this.reloadProjectAfterBoardDependencyChange(projectPath);
    }, delayMs);
  }

  /** 在新开发板包就绪后，移除旧开发板、同步 temp/package.json，并重新打开项目。 */
  private async reloadProjectAfterBoardDependencyChange(projectPath: string): Promise<void> {
    const pending = this.pendingBoardDependencyReload;
    if (!pending || pending.projectPath !== projectPath || this.boardDependencyReloadInProgress) {
      return;
    }

    if (this.watchedPackageJsonProjectPath !== projectPath) {
      return;
    }

    const notReadyBoardNames = pending.addedBoardNames.filter(
      (boardName) => !this.isBoardPackageReady(projectPath, boardName),
    );
    if (notReadyBoardNames.length > 0 && pending.attempts < this.maxPendingBoardReloadAttempts) {
      pending.attempts += 1;
      this.schedulePendingBoardReload(projectPath, this.pendingBoardReloadRetryMs);
      return;
    }

    if (notReadyBoardNames.length > 0) {
      console.warn('[PackageJsonWatch] board dependency was not ready before reload:', notReadyBoardNames);
    }

    const previousBoardNames = [...pending.previousBoardNames];
    const addedBoardNames = [...pending.addedBoardNames];
    this.stopPackageJsonDependencyWatch();
    this.boardDependencyReloadInProgress = true;

    try {
      if (previousBoardNames.length > 0) {
        this.uiService.updateFooterState({ state: 'doing', text: `正在移除旧开发板: ${previousBoardNames.join(', ')}` });
        await this.cmdService.runAsyncChecked(`npm uninstall ${previousBoardNames.join(' ')}`, projectPath);
      }

      this.copyProjectPackageJsonToTemp(projectPath);
      this.message.success(`开发板已切换为 ${addedBoardNames.join(', ')}，正在重新加载项目`, { nzDuration: 3000 });
      await this.projectService.projectOpen(projectPath, { reason: 'reload' });
      this.projectService.boardChangeSubject.next();
      this.projectService.resolveBoardSwitchReload();
    } catch (error) {
      this.boardDependencyReloadInProgress = false;
      this.projectService.rejectBoardSwitchReload(error);
      console.error('[PackageJsonWatch] reload after board dependency change failed:', error);
      this.message.error(`切换开发板后重新加载项目失败: ${(error as Error)?.message || String(error)}`);
      this.startPackageJsonDependencyWatch(projectPath);
    }
  }

  /** 将主项目 package.json 同步到 .temp，避免重载时被旧 temp 配置覆盖。 */
  private copyProjectPackageJsonToTemp(projectPath: string): void {
    const mainPackagePath = this.electronService.pathJoin(projectPath, 'package.json');
    const tempDir = this.electronService.pathJoin(projectPath, '.temp');
    const tempPackagePath = this.electronService.pathJoin(tempDir, 'package.json');

    if (!this.electronService.exists(mainPackagePath)) {
      return;
    }

    try {
      if (!this.electronService.exists(tempDir)) {
        window['fs'].mkdirSync(tempDir, { recursive: true });
      }
      const mainContent = this.electronService.readFile(mainPackagePath);
      window['fs'].writeFileSync(tempPackagePath, mainContent);
    } catch (error) {
      console.warn('[PackageJsonWatch] failed to sync package.json to temp:', error);
    }
  }

  private schedulePendingLibraryLoad(projectPath: string, delayMs: number): void {
    if (this.pendingLibraryLoadTimer) {
      clearTimeout(this.pendingLibraryLoadTimer);
    }

    this.pendingLibraryLoadTimer = setTimeout(() => {
      this.pendingLibraryLoadTimer = null;
      void this.loadPendingLibraries(projectPath);
    }, delayMs);
  }

  private async loadPendingLibraries(projectPath: string): Promise<void> {
    if (this.pendingLibraryLoadInProgress || this.pendingLibraryDependencies.size === 0) {
      return;
    }

    if (this.watchedPackageJsonProjectPath !== projectPath) {
      return;
    }

    this.pendingLibraryLoadInProgress = true;
    let shouldLoadInstalledLibraries = false;
    try {
      const pendingLibraryNames = Array.from(this.pendingLibraryDependencies).sort((a, b) =>
        this.compareBlocklyLibraryNames(a, b),
      );
      for (const libPackageName of pendingLibraryNames) {
        if (this.watchedPackageJsonProjectPath !== projectPath) {
          return;
        }

        if (this.isBlocklyLibraryLoaded(projectPath, libPackageName)) {
          shouldLoadInstalledLibraries = true;
          this.clearPendingLibrary(libPackageName);
          continue;
        }

        if (this.isBlocklyLibraryPackageReady(projectPath, libPackageName)) {
          await this.blocklyService.loadLibrary(libPackageName, projectPath);
          if (this.isBlocklyLibraryLoaded(projectPath, libPackageName)) {
            shouldLoadInstalledLibraries = true;
            this.clearPendingLibrary(libPackageName);
            continue;
          }
        }

        const attempts = (this.pendingLibraryLoadAttempts.get(libPackageName) || 0) + 1;
        if (attempts >= this.maxPendingLibraryLoadAttempts) {
          console.warn('[PackageJsonWatch] library dependency was not ready:', libPackageName);
          this.clearPendingLibrary(libPackageName);
        } else {
          this.pendingLibraryLoadAttempts.set(libPackageName, attempts);
        }
      }
    } finally {
      this.pendingLibraryLoadInProgress = false;
    }

    if (shouldLoadInstalledLibraries && this.watchedPackageJsonProjectPath === projectPath) {
      await this.loadInstalledBlocklyLibraries(projectPath);
    }

    if (this.pendingLibraryDependencies.size > 0 && this.watchedPackageJsonProjectPath === projectPath) {
      this.schedulePendingLibraryLoad(projectPath, this.pendingLibraryLoadRetryMs);
    }
  }

  private async loadInstalledBlocklyLibraries(projectPath: string): Promise<void> {
    try {
      const installedLibraries = await this.npmService.getAllInstalledLibraries(projectPath);
      for (const lib of installedLibraries) {
        const libPackageName = lib?.name;
        if (typeof libPackageName !== 'string') {
          continue;
        }
        if (this.isBlocklyLibraryLoaded(projectPath, libPackageName)) {
          continue;
        }
        if (!this.isBlocklyLibraryPackageReady(projectPath, libPackageName)) {
          continue;
        }

        await this.blocklyService.loadLibrary(libPackageName, projectPath);
      }
    } catch (error) {
      console.warn('[PackageJsonWatch] failed to load installed Blockly libraries:', error);
    }
  }

  private clearPendingLibrary(libPackageName: string): void {
    this.pendingLibraryDependencies.delete(libPackageName);
    this.pendingLibraryLoadAttempts.delete(libPackageName);
  }

  private compareBlocklyLibraryNames(a: string, b: string): number {
    return this.blocklyLibraryPackageService.compareLibraryNames(a, b);
  }

  private isBlocklyLibraryLoaded(projectPath: string, libPackageName: string): boolean {
    return this.blocklyService.loadedLibraries.has(
      this.blocklyLibraryPackageService.getPackagePath(projectPath, libPackageName),
    );
  }

  private isBlocklyLibraryPackageReady(projectPath: string, libPackageName: string): boolean {
    return this.blocklyLibraryPackageService.isPackageReady(projectPath, libPackageName);
  }

  /** 判断开发板包的核心文件是否已经安装完成。 */
  private isBoardPackageReady(projectPath: string, boardPackageName: string): boolean {
    const boardPackagePath = this.getNodeModulePackagePath(projectPath, boardPackageName);
    return ['package.json', 'board.json'].every((fileName) =>
      this.electronService.exists(this.electronService.pathJoin(boardPackagePath, fileName)),
    );
  }

  /** 生成 node_modules 下包路径，兼容 @scope/name 包名。 */
  private getNodeModulePackagePath(projectPath: string, packageName: string): string {
    return this.electronService.pathJoin(projectPath, 'node_modules', ...packageName.split('/'));
  }

  /** 返回 package.json 已声明但 node_modules 中尚未就绪的顶层依赖。 */
  private getMissingDeclaredDependencies(projectPath: string, packageJson: any): string[] {
    const dependencies = {
      ...(packageJson?.dependencies || {}),
      ...(packageJson?.devDependencies || {}),
    };

    return Object.keys(dependencies)
      .filter((packageName) => {
        const packagePath = this.getNodeModulePackagePath(projectPath, packageName);
        return !this.electronService.exists(this.electronService.pathJoin(packagePath, 'package.json'));
      })
      .sort((a, b) => a.localeCompare(b));
  }

  private getMissingProjectLibraries(
    projectPath: string,
    packageJson: any,
    projectDocument: BlocklyProjectDocument,
  ): MissingLibInfo[] {
    const manifest = this.normalizeUsedLibraryManifest(packageJson?.[AILY_BLOCKLY_USED_LIBRARIES_FIELD]);
    const manifestEntries = Object.entries(manifest);
    if (manifestEntries.length === 0) {
      return [];
    }

    const projectBlockTypes = new Set(this.blocklyService.collectBlockTypesFromProjectDocument(projectDocument));
    const declaredLibraryDependencies = this.getDeclaredBlocklyLibraryDependencies(packageJson);
    const missingLibraries: MissingLibInfo[] = [];

    for (const [packageName, entry] of manifestEntries) {
      if (!this.isBlocklyLibraryPackageName(packageName)) {
        continue;
      }

      const usedBlockType = entry.blockTypes.find((blockType) => projectBlockTypes.has(blockType));
      if (entry.blockTypes.length > 0 && !usedBlockType) {
        continue;
      }

      const declaredVersion = declaredLibraryDependencies.get(packageName) || '';
      if (this.isBlocklyLibraryPackageReady(projectPath, packageName)) {
        continue;
      }

      missingLibraries.push({
        blockType: usedBlockType || entry.blockTypes[0] || '',
        name: packageName,
        version: declaredVersion || entry.version || '',
        localPath: this.resolveManifestLocalPath(projectPath, entry),
      });
    }

    return missingLibraries.sort((a, b) => this.compareBlocklyLibraryNames(a.name, b.name));
  }

  private normalizeUsedLibraryManifest(value: any): BlocklyUsedLibraryManifest {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {};
    }

    const manifest: BlocklyUsedLibraryManifest = {};
    for (const [packageName, rawEntry] of Object.entries(value)) {
      if (!this.isBlocklyLibraryPackageName(packageName) || !rawEntry || typeof rawEntry !== 'object') {
        continue;
      }

      const entry = rawEntry as Partial<BlocklyUsedLibraryManifestEntry>;
      const blockTypes = Array.isArray(entry.blockTypes)
        ? entry.blockTypes.filter((blockType): blockType is string => typeof blockType === 'string' && blockType.length > 0)
        : [];
      const localPath = typeof entry.localPath === 'string' && entry.localPath.length > 0
        ? entry.localPath
        : undefined;

      manifest[packageName] = {
        version: typeof entry.version === 'string' ? entry.version : String(entry.version || ''),
        localPath,
        blockTypes: Array.from(new Set(blockTypes)).sort(),
        updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : 0,
      };
    }

    return manifest;
  }

  private resolveManifestLocalPath(projectPath: string, entry: BlocklyUsedLibraryManifestEntry): string {
    if (entry.localPath) {
      return entry.localPath;
    }

    if (!entry.version?.startsWith('file:')) {
      return '';
    }

    const filePath = entry.version.slice(5);
    if (!filePath) {
      return '';
    }

    if (window['path']?.isAbsolute?.(filePath)) {
      return filePath;
    }

    return this.electronService.pathJoin(projectPath, filePath);
  }

  private async restoreMissingProjectLibraries(projectPath: string, missingLibraries: MissingLibInfo[]): Promise<boolean> {
    try {
      await new Promise<void>((resolve, reject) => {
        const modalRef = this.modal.create({
          nzTitle: null,
          nzFooter: null,
          nzClosable: false,
          nzBodyStyle: { padding: '0' },
          nzContent: PasteInstallDialogComponent,
          nzData: {
            missingLibs: missingLibraries,
            title: '项目缺少积木库',
            message: '项目中仍在使用以下积木库，但 package.json 或 node_modules 中已缺失。需要先恢复库，再加载项目。',
            confirmText: '恢复并加载项目',
            installFn: async (libs: MissingLibInfo[]) => {
              await this.installMissingBlocklyLibraries(projectPath, libs);
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
      return true;
    } catch (error) {
      if ((error as Error)?.message !== 'cancelled') {
        console.error('恢复项目缺失库失败:', error);
      }
      return false;
    }
  }

  private async installMissingBlocklyLibraries(projectPath: string, libraries: MissingLibInfo[]): Promise<void> {
    const localLibraries = libraries.filter((lib) => lib.localPath);
    const npmLibraries = libraries.filter((lib) => !lib.localPath);

    for (const lib of localLibraries) {
      if (!lib.localPath || !this.electronService.exists(lib.localPath)) {
        throw new Error(`${lib.name} 的本地库路径不存在: ${lib.localPath || 'unknown'}`);
      }

      const folderName = lib.localPath.split(/[/\\]/).pop();
      if (!folderName) {
        throw new Error(`${lib.name} 的本地库路径无效: ${lib.localPath}`);
      }

      const destPath = this.electronService.pathJoin(projectPath, folderName);
      if (lib.localPath !== destPath) {
        if (this.electronService.exists(destPath)) {
          await this.crossPlatformCmdService.removeItem(destPath, true, true);
        }
        await this.crossPlatformCmdService.copyItem(lib.localPath, destPath, true, true);
      }

      await this.cmdService.runAsyncChecked(`npm install "${destPath}"`, projectPath);
    }

    if (npmLibraries.length > 0) {
      const packageSpecs = npmLibraries.map((lib) => this.getNpmInstallSpec(lib)).join(' ');
      await this.cmdService.runAsyncChecked(`npm install ${packageSpecs}`, projectPath);
    }

    for (const lib of libraries) {
      await this.blocklyService.loadLibrary(lib.name, projectPath);
    }
  }

  private getNpmInstallSpec(lib: MissingLibInfo): string {
    const version = (lib.version || '').trim();
    if (!version || version.startsWith('file:') || /[\s"'`]/.test(version)) {
      return lib.name;
    }
    return `${lib.name}@${version}`;
  }

  private handleMissingProjectLibrariesCancelled(missingLibraries: MissingLibInfo[]): void {
    const libraryNames = missingLibraries.map((lib) => lib.name).join(', ');
    const text = `项目缺少仍在使用的积木库：${libraryNames}`;
    this.projectService.stateSubject.next('error');
    this.uiService.updateFooterState({ state: 'error', text });
    this.noticeService.update({
      title: '项目加载已暂停',
      text,
      detail: '请恢复缺失库后重新打开项目，避免未知积木在加载后被丢失。',
      state: 'error',
      sendToLog: false,
    });
  }

  private readProjectPackageJson(projectPath: string): any | null {
    try {
      const packageJsonPath = this.electronService.pathJoin(projectPath, 'package.json');
      return JSON.parse(this.electronService.readFile(packageJsonPath));
    } catch (error) {
      console.warn('读取项目 package.json 失败:', error);
      return null;
    }
  }

  private isProjectLibraryDeclaredAsUsed(projectPath: string, packageName: string): boolean {
    const packageJson = this.readProjectPackageJson(projectPath);
    const manifest = this.normalizeUsedLibraryManifest(packageJson?.[AILY_BLOCKLY_USED_LIBRARIES_FIELD]);
    const entry = manifest[packageName];
    if (!entry) {
      return false;
    }

    if (entry.blockTypes.length === 0) {
      return true;
    }

    const currentBlockTypes = new Set(this.blocklyService.collectBlockTypesFromProjectDocument(this.blocklyService.getProjectDocument()));
    return entry.blockTypes.some((blockType) => currentBlockTypes.has(blockType));
  }

  private isBlocklyLibraryPackageName(packageName: string): boolean {
    return /^@aily-project\/lib-[a-zA-Z0-9._-]+$/.test(packageName);
  }

  /** 判断包名是否为 Aily 开发板包。 */
  private isBoardPackageName(packageName: string): boolean {
    return /^@aily-project\/board-[a-zA-Z0-9._-]+$/.test(packageName);
  }

  openProjectManager(event?: MouseEvent) {
    if (this.blocklyService.checkAiWaiting()) {
      return;
    }
    // hideChaff 会关闭所有打开的下拉、输入、WidgetDiv 和 DropDownDiv
    this.blocklyService.workspace.hideChaff();
    // this.uiService.closeToolAll();
    this.showLibraryManager = !this.showLibraryManager;
    this.cd.detectChanges();
  }

  // 检查是否需要显示新手引导
  private checkBlocklyOnboarding() {
    const hasSeenOnboarding =
      this.configService.data.blocklyOnboardingCompleted;
    if (!hasSeenOnboarding) {
      // 延迟显示引导，确保 Blockly 工作区已完全渲染
      setTimeout(() => {
        this.onboardingService.start(BLOCKLY_ONBOARDING_CONFIG, {
          onClosed: () => this.onOnboardingClosed(),
          onCompleted: () => this.onOnboardingClosed(),
        });
      }, 500);
    }
  }

  // 引导关闭或完成时的处理
  private onOnboardingClosed() {
    this.configService.data.blocklyOnboardingCompleted = true;
    this.configService.save();
  }

  // 测试用
  reload() {
    this.projectService.projectOpen();
  }

}
