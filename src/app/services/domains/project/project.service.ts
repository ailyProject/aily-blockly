import { Injectable, Injector } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';
import {
  AppDataResourceLockService,
  CmdService,
  CrossPlatformCmdService,
  ElectronService,
  PlatformService,
} from '@core/platform/public-api';
import { NzMessageService } from 'ng-zorro-antd/message';
import { Router } from '@angular/router';
import { generateDateString } from '../../../func/func';
import { ConfigService } from '@core/preferences/public-api';
import type { IMenuItem } from '../../../configs/menu.config';
import type { NewProjectData } from '../../../types/project-new';
import { TranslateService } from '@ngx-translate/core';
import { NzModalRef, NzModalService } from 'ng-zorro-antd/modal';
import {
  readPlatformRefFromProjectPackage,
  resolveEffectiveBoardDependencies,
} from '../../../utils/platform-runtime.utils';
import {
  PROJECT_APPLICATION_PORT,
  type ProjectApplicationPort,
} from './ports/project-application.port';
import { projectDataRuntime } from './project-data/project-data-runtime';
import { assertNoOversizedInlineValues } from './project-data/project-data-policy';
import { ProjectDataStore } from './project-data/project-data-store';
import {
  ensureExternalProjectDataDocument,
  ExternalProjectDataImportResult,
} from './project-data/project-data-legacy-import';
import { materializeGenericProjectDataValues } from './project-data/project-data-generic-values';
import {
  isBoardCompatibleWithProjectMode,
  normalizeProjectMode,
  AILY_LINUX_NPM_SCOPE,
  AILY_NPM_SCOPE,
  AILY_PACKAGE_SCOPES,
  isAilyBoardPackageName,
  isAilyCoreLibraryPackageName,
  isAilyLibraryPackageName,
  isAilyScopedPackageName,
} from '@shared/public-api';
import {
  CODER_TEMPLATE_DIRECTORY,
  applyCoderProjectPackageConfig,
  copyCoderArduinoTemplate,
  isCoderProjectPackage,
  resolveCoderProjectCreationTemplate,
  resolveCoderTemplatePath,
} from './coder/coder-project-template';
import {
  RecentProject,
  addRecentProject,
  removeRecentProject,
} from './recent-projects';
import {
  PROJECT_ROOT_PATH_SETTING_CHANGED_ACTION,
  resolveConfiguredProjectRootPath,
} from './project-root-path';
import { detectProjectMode, getProjectApplicationName, type ProjectMode } from './project-mode';
import { deriveProjectPackageName } from './project-package-name';

interface ProjectPackageData {
  name: string;
  nickname?: string;
  version?: string;
  author?: string;
  description?: string;
  path?: string;
  board?: string;
  type?: string;
  framework?: string;
  cloudId?: string; // 云端项目ID
  blocklyToolboxOrder?: string[];
}

export type ProjectActivationReason =
  | 'new'
  | 'open'
  | 'reload'
  | 'chat-tool-create'
  | 'chat-tool-open'
  | 'chat-tool-reload';

export interface ProjectActivationEvent {
  path: string;
  previousPath: string;
  reason: ProjectActivationReason;
  sessionResource?: string | null;
}

interface ProjectOpenOptions {
  reason?: ProjectActivationReason;
  sessionResource?: string | null;
}

interface ProjectCreationOptions {
  activationReason?: ProjectActivationReason;
  sessionResource?: string | null;
  deferActivation?: boolean;
  /** Board package template directory. Blockly uses `template`; Coder uses `template_arduino`. */
  templateDirectory?: 'template' | typeof CODER_TEMPLATE_DIRECTORY;
}

export interface BlocklyProjectLoadStatus {
  project: string;
  state: 'default' | 'loading' | 'loaded' | 'saving' | 'saved' | 'error';
  ready: boolean;
  error?: string;
}

@Injectable({
  providedIn: 'root',
})
export class ProjectService {

  stateSubject = new BehaviorSubject<'default' | 'loading' | 'loaded' | 'saving' | 'saved' | 'error'>('default');

  // 开发板变更事件通知，只在变更时发出
  boardChangeSubject = new Subject<void>();
  boardConfigUpdatedSubject = new Subject<any>();

  // 当前项目路径的订阅源
  private currentProjectPathSubject = new BehaviorSubject<string>('');
  currentProjectPath$ = this.currentProjectPathSubject.asObservable();

  private projectActivationSubject = new Subject<ProjectActivationEvent>();
  projectActivation$ = this.projectActivationSubject.asObservable();
  private projectOpenTask: { path: string; promise: Promise<boolean> } | null = null;
  private loadingBlocklyProjectPath = '';
  private loadedBlocklyProjectPath = '';
  private blocklyProjectLoadFailure: { path: string; error: string } | null = null;
  private blocklyLibraryRuntimeRebuildTask: {
    path: string;
    runtimeSignature: string;
    promise: Promise<boolean>;
  } | null = null;
  private blocklyLibraryRuntimeSignatures = new Map<string, string>();
  private recentProjectsCache: { source: RecentProject[]; mode: ProjectMode; time: number; projects: RecentProject[] } | null = null;

  currentPackageData: ProjectPackageData = {
    // 产品名称由界面显示，不作为空项目的项目名。
    name: '',
  };

  projectRootPath: string;
  private projectRootPathInitPromise: Promise<void> | null = null;
  private projectRootPathSettingListenerRegistered = false;

  // 当前项目路径的 getter 和 setter
  get currentProjectPath(): string {
    return this.currentProjectPathSubject.value;
  }

  set currentProjectPath(path: string) {
    this.currentProjectPathSubject.next(path);
  }

  get isProjectOpening(): boolean {
    return !!this.projectOpenTask || this.stateSubject.value === 'loading';
  }

  beginBlocklyProjectLoad(projectPath: string): void {
    if (
      this.stateSubject.value === 'loading'
      && this.isSameProjectPath(projectPath, this.loadingBlocklyProjectPath)
    ) {
      return;
    }
    this.loadingBlocklyProjectPath = projectPath;
    this.loadedBlocklyProjectPath = '';
    this.blocklyProjectLoadFailure = null;
    this.stateSubject.next('loading');
  }

  markBlocklyProjectLoaded(projectPath: string): void {
    if (!this.isSameProjectPath(projectPath, this.currentProjectPath)) {
      return;
    }
    this.loadingBlocklyProjectPath = '';
    this.loadedBlocklyProjectPath = projectPath;
    this.blocklyProjectLoadFailure = null;
    this.stateSubject.next('loaded');
  }

  markBlocklyProjectLoadFailed(projectPath: string, error: string): void {
    if (this.isSameProjectPath(projectPath, this.loadingBlocklyProjectPath)) {
      this.loadingBlocklyProjectPath = '';
    }
    this.loadedBlocklyProjectPath = '';
    this.blocklyProjectLoadFailure = {
      path: projectPath,
      error: String(error || '未知项目加载错误'),
    };
    this.stateSubject.next('error');
  }

  getBlocklyProjectLoadStatus(projectPath = this.currentProjectPath): BlocklyProjectLoadStatus {
    const failure = this.blocklyProjectLoadFailure;
    const sameCurrentProject = this.isSameProjectPath(projectPath, this.currentProjectPath);
    const ready = sameCurrentProject
      && this.isSameProjectPath(projectPath, this.loadedBlocklyProjectPath)
      && !failure
      && projectDataRuntime.isConfigured();
    const error = failure && this.isSameProjectPath(projectPath, failure.path)
      ? failure.error
      : undefined;
    return {
      project: projectPath,
      state: this.stateSubject.value,
      ready,
      ...(error ? { error } : {}),
    };
  }


  /** 当前工程是否为 Coder（package.json.type === "coder"）。 */
  isAilyCodeProject(projectPath = this.currentProjectPath): boolean {
    if (!projectPath) {
      return false;
    }
    const packagePath = window['path'].join(projectPath, 'package.json');
    if (!window['path'].isExists(packagePath)) {
      return false;
    }
    try {
      return isCoderProjectPackage(JSON.parse(window['fs'].readFileSync(packagePath, 'utf8')));
    } catch {
      return false;
    }
  }

  /** 将主板版本规范化为 package.json 可用的依赖范围。 */
  private normalizeAilyCodeBoardDepRange(versionSpec: string): string {
    const v = String(versionSpec ?? '').trim();
    if (!v) {
      return '*';
    }
    if (/^[\^~]|^>=|^<=|^>|^</.test(v) || v === '*' || v === 'latest') {
      return v;
    }
    return `^${v}`;
  }

  /**
   * 切换后保留的用户库：排除主板/模板自带的 lib-core-*（与新建 Coder 仅声明主板一致）。
   */
  private filterAilyCodeUserPreservedDeps(
    deps: Record<string, string> | undefined,
  ): Record<string, string> {
    return Object.fromEntries(
      Object.entries(deps || {}).filter(([key]) => {
        if (isAilyBoardPackageName(key) || key.startsWith('@aily-project/coder-')) {
          return false;
        }
        if (isAilyCoreLibraryPackageName(key)) {
          return false;
        }
        return true;
      }),
    );
  }

  /** Aily Code 切换开发板：保留 template_arduino 的板卡/库依赖，再合并用户自装库。 */
  private applyAilyCodeBoardToPackageManifest(
    packageJson: Record<string, unknown>,
    boardInfo: { name: string; version: string },
    currentPackageJson?: { dependencies?: Record<string, string> },
  ): void {
    const boardRange = this.normalizeAilyCodeBoardDepRange(boardInfo.version);
    const preserved = this.filterAilyCodeUserPreservedDeps(currentPackageJson?.dependencies);

    packageJson['dependencies'] = {
      ...((packageJson['dependencies'] as Record<string, string> | undefined) || {}),
      ...preserved,
      [boardInfo.name]: boardRange,
    };
    packageJson['boardDependencies'] = {
      ...((packageJson['boardDependencies'] as Record<string, string> | undefined) || {}),
      [boardInfo.name]: boardRange,
    };
  }

  currentBoardConfig: any;
  private currentBoardMenuConfig: IMenuItem[] = [];
  private currentBoardMenuI18nDir = '';
  isBoardSwitchInProgress = false;
  isPackageJsonBoardWatcherActive = false;
  private boardSwitchReloadWaiter: {
    resolve: () => void;
    reject: (error: any) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  private messageService: NzMessageService | null = null;
  private modalService: NzModalService | null = null;
  private routerService: Router | null = null;
  // 当前由 menu.json 声明需要同步的引脚配置。
  currentBoardPinConfig: { board: any, variant: any, variant_h: any } = { board: null, variant: null, variant_h: null };

  constructor(
    private electronService: ElectronService,
    private cmdService: CmdService,
    private crossPlatformCmdService: CrossPlatformCmdService,
    private configService: ConfigService,
    private platformService: PlatformService,
    private translate: TranslateService,
    private appDataResourceLock: AppDataResourceLockService,
    private injector: Injector,
  ) {
    this.translate.onLangChange.subscribe((event) => {
      void this.loadCurrentBoardMenuTranslations(event.lang);
    });
  }

  private get application(): ProjectApplicationPort {
    return this.injector.get(PROJECT_APPLICATION_PORT);
  }

  private hasBlockingAiOperation(): boolean {
    return this.application.hasActiveAiOperation(this.currentProjectPath);
  }

  private shouldBlockForAiOperation(reason?: ProjectActivationReason): boolean {
    return !reason?.startsWith('chat-tool-') && this.hasBlockingAiOperation();
  }

  private warnBlockingAiOperation(): void {
    this.message.warning('AI 对话正在处理中，请先停止当前请求后再切换或关闭项目。');
  }

  private warnConnectionGraphWindowCloseFailure(): void {
    this.message.warning('连线图窗口未能关闭，请手动关闭窗口后重试。');
  }

  private get message(): NzMessageService {
    if (!this.messageService) {
      this.messageService = this.injector.get(NzMessageService);
    }
    return this.messageService;
  }

  private get modal(): NzModalService {
    if (!this.modalService) {
      this.modalService = this.injector.get(NzModalService);
    }
    return this.modalService;
  }

  private get router(): Router {
    if (!this.routerService) {
      this.routerService = this.injector.get(Router);
    }
    return this.routerService;
  }

  // 初始化UI服务，这个init函数仅供main-window使用
  async init() {
    if (this.electronService.isElectron) {
      this.registerProjectRootPathSettingListener();
      window['ipcRenderer'].on('window-receive', async (event, message) => {
        // console.log('window-receive', message);
        if (message.data.action == 'open-project') {
          let opened = false;
          try {
            opened = await this.projectOpen(message.data.path, {
              reason: this.parseProjectActivationReason(message.data.reason),
              sessionResource: typeof message.data.sessionResource === 'string' ? message.data.sessionResource : null,
            });
          } catch (error) {
            console.error('Project activation failed:', error);
          }
          if (message.messageId) {
            window['ipcRenderer'].send('main-window-response', {
              messageId: message.messageId,
              data: opened ? 'success' : 'failed',
            });
          }
        } else {
          return;
        }
      });

      // 监听来自文件关联的打开请求
      window['ipcRenderer'].on('open-project-from-file', async (event, projectPath) => {
        console.log('Received open-project-from-file event:', projectPath);
        try {
          await this.projectOpen(projectPath);
          console.log('Successfully opened project from file association');
        } catch (error) {
          console.error('Error opening project from file association:', error);
          this.message.error(this.translate.instant('PROJECT.CANNOT_OPEN_PROJECT') + error.message);
        }
      });
      window['ipcRenderer'].send('project-open-ready');

      await this.ensureProjectRootPath();
      // if (!this.currentProjectPath) {
      //   this.currentProjectPath = this.projectRootPath;
      // }
    }
  }

  /** 解析 AILY_PROJECT_PATH，供主窗口与 chat execution-worker 等独立 renderer 复用。 */
  async ensureProjectRootPath(): Promise<void> {
    if (typeof this.projectRootPath === 'string' && this.projectRootPath.trim().length > 0) {
      return;
    }
    if (this.projectRootPathInitPromise) {
      return this.projectRootPathInitPromise;
    }

    this.projectRootPathInitPromise = this.loadProjectRootPathFromEnv();
    try {
      await this.projectRootPathInitPromise;
    } finally {
      this.projectRootPathInitPromise = null;
    }
  }

  private async loadProjectRootPathFromEnv(): Promise<void> {
    if (!this.electronService.isElectron) {
      return;
    }

    const rawAilyProjectPath = await window['env'].get("AILY_PROJECT_PATH");
    this.setProjectRootPath(rawAilyProjectPath);
  }

  setProjectRootPath(rawPath: unknown): void {
    const pathApi = window['path'];
    const separator = this.platformService.getPlatformSeparator();
    const projectRootPath = resolveConfiguredProjectRootPath(rawPath, {
      userDocuments: pathApi?.getUserDocuments?.() || '',
      userHome: pathApi?.getUserHome?.() || '',
      separator,
    });
    this.projectRootPath = projectRootPath
      || (pathApi?.getUserDocuments?.() ? pathApi.join(pathApi.getUserDocuments(), 'aily-project') : `.${separator}`);
  }

  private registerProjectRootPathSettingListener(): void {
    if (this.projectRootPathSettingListenerRegistered || !window['ipcRenderer']?.on) {
      return;
    }

    window['ipcRenderer'].on('setting-changed', (_event, message) => {
      if (message?.action !== PROJECT_ROOT_PATH_SETTING_CHANGED_ACTION) {
        return;
      }
      this.setProjectRootPath(message.data?.path ?? message.data);
    });
    this.projectRootPathSettingListenerRegistered = true;
  }

  async getDefaultProjectParentPath(): Promise<string> {
    const separator = this.platformService.getPlatformSeparator();
    await this.ensureProjectRootPath();
    const configuredPath = String(this.projectRootPath || '').trim();
    if (configuredPath) {
      return configuredPath.endsWith(separator) ? configuredPath : configuredPath + separator;
    }
    if (this.electronService.isElectron && window['path']?.getUserDocuments) {
      return window['path'].getUserDocuments() + `${separator}aily-project${separator}`;
    }
    return `.${separator}`;
  }

  async createDefaultNewProjectData(
    board: NewProjectData['board'],
    options: { name?: string; path?: string; prefix?: string; devmode?: string } = {}
  ): Promise<NewProjectData> {
    const path = String(options.path || '').trim() || await this.getDefaultProjectParentPath();
    const prefix = options.prefix || 'project_';
    const requestedName = String(options.name || '').trim();
    return {
      name: requestedName || this.generateUniqueProjectName(path, prefix),
      path,
      board,
      devmode: options.devmode,
    };
  }

  private normalizeAilyBoardPackageName(boardName: string): string {
    const normalized = String(boardName || '').trim();
    if (!normalized) {
      return normalized;
    }
    if (isAilyScopedPackageName(normalized)) {
      return normalized;
    }
    if (normalized.startsWith('board-')) {
      return `@aily-project/${normalized}`;
    }
    return `@aily-project/board-${normalized}`;
  }

  private buildNpmPackageSpec(packageName: string, version?: string): string {
    const normalizedName = String(packageName || '').trim();
    const normalizedVersion = String(version || '').trim();
    if (!normalizedVersion || /@[^/]+$/.test(normalizedName)) {
      return normalizedName;
    }
    return `${normalizedName}@${normalizedVersion}`;
  }

  private async buildNpmInstallCommand(
    packageSpec: string,
    options: string | { prefixPath?: string; noSave?: boolean; registry?: string } = {}
  ): Promise<string> {
    const installOptions = typeof options === 'string' ? { prefixPath: options } : options;
    const args = [`npm install ${packageSpec}`];
    if (installOptions.prefixPath) {
      args.push(`--prefix "${installOptions.prefixPath}"`);
    }
    if (installOptions.noSave) {
      args.push('--no-save');
    }
    const userConfig = this.electronService.isElectron && window['env']?.get
      ? String(await window['env'].get('NPM_CONFIG_USERCONFIG') || '').trim()
      : '';
    // 调用方为 Python/Linux 显式传专用仓库；Arduino 未传时保持原 AILY_NPM_REGISTRY 行为。
    const isLinuxPackage = packageSpec.startsWith(`${AILY_LINUX_NPM_SCOPE}/`);
    const registryEnvName = isLinuxPackage ? 'AILY_NPM_REGISTRY_LINUX' : 'AILY_NPM_REGISTRY';
    const registry = String(installOptions.registry || '').trim() || (
      this.electronService.isElectron && window['env']?.get
        ? String(await window['env'].get(registryEnvName) || '').trim()
        : ''
    );
    if (userConfig) {
      args.push(`--userconfig "${userConfig}"`);
    }
    if (registry) {
      const registryScope = isLinuxPackage
        ? AILY_LINUX_NPM_SCOPE
        : AILY_NPM_SCOPE;
      args.push(`--${registryScope}:registry="${registry}"`);
    }
    return args.join(' ');
  }

  private buildProjectPath(newProjectData: NewProjectData): string {
    const inputName = String(newProjectData.name ?? '').trim();
    const projectPath = window['path'].join(newProjectData.path, inputName.replace(/\s/g, '_'));
    return projectPath;
  }

  private normalizeProjectPath(projectPath: string | null | undefined): string {
    return String(projectPath || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  }

  private isSameProjectPath(leftPath: string | null | undefined, rightPath: string | null | undefined): boolean {
    return this.normalizeProjectPath(leftPath) === this.normalizeProjectPath(rightPath);
  }

  private parseProjectActivationReason(reason: unknown): ProjectActivationReason | undefined {
    return reason === 'new'
      || reason === 'open'
      || reason === 'reload'
      || reason === 'chat-tool-create'
      || reason === 'chat-tool-open'
      || reason === 'chat-tool-reload'
      ? reason
      : undefined;
  }

  private updateNewProjectPackageJson(
    projectPath: string,
    newProjectData: NewProjectData,
    options?: { removeCloudId?: boolean; coderTemplate?: boolean }
  ) {
    const inputName = String(newProjectData.name ?? '').trim();
    const packageJson = JSON.parse(window['fs'].readFileSync(`${projectPath}/package.json`));
    packageJson.name = deriveProjectPackageName(inputName);
    packageJson.nickname = inputName;
    // Coder 使用 Arduino 模板；框架固定为 arduino，不沿用 Blockly 表单中的其他 devmode。
    if (!options?.coderTemplate && newProjectData.devmode) {
      packageJson.devmode = newProjectData.devmode;
    }

    if (options?.coderTemplate) {
      const boardPackageName = this.normalizeAilyBoardPackageName(newProjectData.board.name);
      const boardRange = this.normalizeAilyCodeBoardDepRange(newProjectData.board.version);
      applyCoderProjectPackageConfig(packageJson, boardPackageName, boardRange);
    }

    window['fs'].writeFileSync(`${projectPath}/package.json`, JSON.stringify(packageJson, null, 2));
  }

  private async finishProjectCreation(projectPath: string, options: ProjectCreationOptions = {}): Promise<boolean> {
    this.application.updateFooterState({ state: 'done', text: this.translate.instant('PROJECT.PROJECT_CREATED') });
    const result = await window['iWindow'].send({
      to: 'main',
      timeout: 130000,
      data: {
        action: 'open-project',
        path: projectPath,
        reason: options.activationReason || 'new',
        sessionResource: options.sessionResource ?? null,
      }
    });
    return result === 'success';
  }

  // 新建项目
  async projectNew(newProjectData: NewProjectData, options: ProjectCreationOptions = {}): Promise<boolean> {
    try {
      await this.assertProjectCreationMode(options.templateDirectory === CODER_TEMPLATE_DIRECTORY ? 'coder' : 'blockly');
      const separator = this.platformService.getPlatformSeparator();
      // console.log('newProjectData: ', newProjectData);
      const appDataPath = window['path'].getAppDataPath();
      const projectPath = this.buildProjectPath(newProjectData);
      const boardPackageName = this.normalizeAilyBoardPackageName(newProjectData.board.name);
      const boardPackage = this.buildNpmPackageSpec(boardPackageName, newProjectData.board.version);
      // 创建前还没有 package.json，用向导选定的 devmode 决定板包仓库。
      const installCommand = await this.buildNpmInstallCommand(boardPackage, {
        prefixPath: appDataPath,
        registry: this.configService.getNpmRegistryForProject({ devmode: newProjectData.devmode }),
      });

      this.application.updateFooterState({ state: 'doing', text: this.translate.instant('PROJECT.CREATING_PROJECT') });
      const npmInstallResult = await this.appDataResourceLock.runExclusive(`project:new:install-board:${boardPackage}`, () =>
        this.cmdService.runAsync(installCommand)
      );
      if (npmInstallResult.code !== 0) {
        throw new Error(npmInstallResult.stderr || npmInstallResult.stdout || `npm install failed with exit code ${npmInstallResult.code}`);
      }
      const templateDirectory = options.templateDirectory || 'template';
      const boardPackagePath = window['path'].join(
        appDataPath,
        'node_modules',
        boardPackageName,
      );
      const isCoderTemplate = templateDirectory === CODER_TEMPLATE_DIRECTORY;
      const coderTemplate = isCoderTemplate
        ? resolveCoderProjectCreationTemplate(boardPackagePath, window['path'])
        : null;
      const templatePath = coderTemplate?.templatePath
        ?? window['path'].join(boardPackagePath, templateDirectory);
      if (!window['fs'].existsSync(templatePath)) {
        throw new Error(`板卡模板目录不存在，可能是板卡包安装失败或模板缺失: ${templatePath}`);
      }
      // 创建项目目录
      await this.crossPlatformCmdService.createDirectory(projectPath, true);
      if (isCoderTemplate) {
        copyCoderArduinoTemplate(templatePath, projectPath, window['path'], window['fs'], {
          useDefaultSource: coderTemplate?.useDefaultSource === true,
        });
      } else {
        // 复制 Blockly 模板文件到项目目录
        await this.crossPlatformCmdService.copyItem(`${templatePath}${separator}*`, projectPath, true, true);
      }

      if (templateDirectory === 'template') {
        await this.initializeProjectDataSchema(projectPath);
      }
      this.updateNewProjectPackageJson(projectPath, newProjectData, {
        coderTemplate: isCoderTemplate,
      });
      if (options.deferActivation) {
        this.application.updateFooterState({ state: 'done', text: this.translate.instant('PROJECT.PROJECT_CREATED') });
        return true;
      }
      return await this.finishProjectCreation(projectPath, options);

      // if (closeWindow) {
      //   this.uiService.closeWindow();
      // }
    } catch (error) {
      this.message.error(this.translate.instant('PROJECT.CREATE_FAILED') + ": " + error.message);
      this.application.updateFooterState({ state: 'error', text: this.translate.instant('PROJECT.CREATE_FAILED') });
      return false;
    }
  }

  async projectNewFromTemplate(newProjectData: NewProjectData, templatePath: string, options: ProjectCreationOptions = {}): Promise<boolean> {
    try {
      const mode = this.getProjectMode(templatePath);
      if (!mode) throw new Error(this.translate.instant('PROJECT.MODE_UNKNOWN'));
      await this.assertProjectCreationMode(mode);
      const separator = this.platformService.getPlatformSeparator();
      const projectPath = this.buildProjectPath(newProjectData);

      this.application.updateFooterState({ state: 'doing', text: this.translate.instant('PROJECT.CREATING_PROJECT') });
      await this.crossPlatformCmdService.createDirectory(projectPath, true);
      await this.crossPlatformCmdService.copyItem(`${templatePath}${separator}*`, projectPath, true, true);

      await this.initializeProjectDataSchema(projectPath);
      this.updateNewProjectPackageJson(projectPath, newProjectData, { removeCloudId: true });
      return await this.finishProjectCreation(projectPath, options);
    } catch (error) {
      this.message.error(this.translate.instant('PROJECT.CREATE_FAILED') + ": " + error.message);
      this.application.updateFooterState({ state: 'error', text: this.translate.instant('PROJECT.CREATE_FAILED') });
      return false;
    }
  }

  /**
   * Board, example, and cloud templates are source material for a new local
   * project. Known legacy inline payloads are migrated once at this copy
   * boundary.
   */
  async initializeProjectDataSchema(projectPath: string): Promise<void> {
    const abiPath = window['path'].join(projectPath, 'project.abi');
    if (!window['fs'].existsSync(abiPath)) return;
    const originalContent = window['fs'].readFileSync(abiPath, 'utf8');
    const abi = JSON.parse(originalContent);

    const store = new ProjectDataStore();
    store.configure(projectPath);
    const result = await ensureExternalProjectDataDocument(abi, store);
    if (result.documentChanged) {
      this.writeProjectAbiAtomically(abiPath, result.document);
      this.logProjectDataMigration(projectPath, result);
    }
  }

  /**
   * Normalizes Project Data on open. Markerless internal-test projects gain the
   * schema marker, while marked documents may externalize a remaining generic
   * oversized value. Every referenced resource is still strictly validated.
   */
  async ensureProjectDataSchemaForLoad(
    projectPath: string,
    document: unknown,
    originalContent?: string,
  ): Promise<Record<string, unknown>> {
    const store = projectDataRuntime.isConfigured()
      && projectDataRuntime.getStore().getProjectPath() === projectPath
      ? projectDataRuntime.getStore()
      : this.createProjectDataStore(projectPath);
    const result = await ensureExternalProjectDataDocument(document, store);
    if (result.documentChanged && originalContent !== undefined) {
      const abiPath = window['path'].join(projectPath, 'project.abi');
      const backupPath = `${abiPath}.pre-project-data.bak`;
      if (!window['fs'].existsSync(backupPath)) {
        window['fs'].writeFileSync(backupPath, originalContent);
      }
      this.writeProjectAbiAtomically(abiPath, result.document);
      this.logProjectDataMigration(projectPath, result);
    }

    const reader = projectDataRuntime.isConfigured()
      && projectDataRuntime.getStore().getProjectPath() === projectPath
      ? projectDataRuntime
      : store;
    return materializeGenericProjectDataValues(result.document, reader);
  }

  private createProjectDataStore(projectPath: string): ProjectDataStore {
    const store = new ProjectDataStore();
    store.configure(projectPath);
    return store;
  }

  private writeProjectAbiAtomically(
    abiPath: string,
    document: Record<string, unknown>,
  ): void {
    const tempPath = `${abiPath}.tmp`;
    try {
      window['fs'].writeFileSync(tempPath, JSON.stringify(document));
      window['fs'].renameSync(tempPath, abiPath);
    } finally {
      if (window['fs'].existsSync(tempPath) && typeof window['fs'].unlinkSync === 'function') {
        window['fs'].unlinkSync(tempPath);
      }
    }
  }

  private logProjectDataMigration(
    projectPath: string,
    result: ExternalProjectDataImportResult,
  ): void {
    console.info(
      `[ProjectData] Normalized project.abi for ${projectPath}; `
      + `migrated ${result.migration.migrated.length} specialized payload(s) and `
      + `${result.genericExternalized.length} generic oversized value(s).`,
    );
  }

  // 打开项目
  async projectOpen(projectPath = this.currentProjectPath, options: ProjectOpenOptions = {}) {
    if (this.projectOpenTask) {
      if (this.isSameProjectPath(this.projectOpenTask.path, projectPath)) {
        return this.projectOpenTask.promise;
      }
      await this.projectOpenTask.promise;
    }

    const promise = this.projectOpenInternal(projectPath, options);
    this.projectOpenTask = { path: projectPath, promise };
    try {
      return await promise;
    } finally {
      if (this.projectOpenTask?.promise === promise) {
        this.projectOpenTask = null;
      }
    }
  }

  async rebuildBlocklyRuntimeAfterLibraryChange(projectPath = this.currentProjectPath): Promise<void> {
    if (!projectPath) {
      return;
    }
    const packageSnapshotUpdated = await this.copyPackageJsonToTemp(projectPath);
    if (!packageSnapshotUpdated) {
      throw new Error(`无法同步项目依赖快照: ${projectPath}`);
    }

    const packageJsonPath = window['path'].join(projectPath, 'package.json');
    const packageContent = window['fs'].readFileSync(packageJsonPath, 'utf8');
    const runtimeSignature = this.getBlocklyLibraryRuntimeSignature(projectPath, packageContent);
    const activeTask = this.blocklyLibraryRuntimeRebuildTask;
    if (activeTask?.path === projectPath && activeTask.runtimeSignature === runtimeSignature) {
      await activeTask.promise;
      return;
    }

    // This is deliberately an in-place library-layer rebuild. It must not call
    // projectOpen(), Router navigation, location.reload(), or webContents.reload().
    const promise = this.rebuildActiveBlocklyLibraryRuntime(projectPath, packageContent, runtimeSignature);
    this.blocklyLibraryRuntimeRebuildTask = {
      path: projectPath,
      runtimeSignature,
      promise,
    };
    try {
      if (await promise) {
        this.blocklyLibraryRuntimeSignatures.set(projectPath, runtimeSignature);
      }
    } finally {
      if (this.blocklyLibraryRuntimeRebuildTask?.promise === promise) {
        this.blocklyLibraryRuntimeRebuildTask = null;
      }
    }
  }

  /** Record the installed library files represented by the loaded Blockly runtime. */
  markBlocklyLibraryRuntimeReady(projectPath = this.currentProjectPath): void {
    if (!projectPath || !this.isSameProjectPath(projectPath, this.currentProjectPath)) {
      return;
    }

    try {
      const packageJsonPath = window['path'].join(projectPath, 'package.json');
      const packageContent = window['fs'].readFileSync(packageJsonPath, 'utf8');
      this.blocklyLibraryRuntimeSignatures.set(
        projectPath,
        this.getBlocklyLibraryRuntimeSignature(projectPath, packageContent),
      );
    } catch (error) {
      console.warn('[ProjectService] failed to snapshot the Blockly library runtime:', error);
    }
  }

  /** Keep Agent save/build/tidy/upload away from a partially rebuilt workspace. */
  async ensureBlocklyLibraryRuntimeReady(projectPath = this.currentProjectPath): Promise<void> {
    if (!projectPath || !this.isSameProjectPath(projectPath, this.currentProjectPath)) {
      return;
    }

    const packageJsonPath = window['path'].join(projectPath, 'package.json');
    const packageContent = window['fs'].readFileSync(packageJsonPath, 'utf8');
    const runtimeSignature = this.getBlocklyLibraryRuntimeSignature(projectPath, packageContent);
    const activeTask = this.blocklyLibraryRuntimeRebuildTask;
    if (activeTask?.path === projectPath && activeTask.runtimeSignature === runtimeSignature) {
      await activeTask.promise;
      return;
    }

    if (this.blocklyLibraryRuntimeSignatures.get(projectPath) === runtimeSignature) {
      return;
    }

    await this.rebuildBlocklyRuntimeAfterLibraryChange(projectPath);
  }

  private async rebuildActiveBlocklyLibraryRuntime(
    projectPath: string,
    packageContent: string,
    runtimeSignature: string,
  ): Promise<boolean> {
    return this.application.rebuildActiveBlocklyLibraryRuntime({
      projectPath,
      packageContent,
      runtimeSignature,
      previousRuntimeSignature: this.blocklyLibraryRuntimeSignatures.get(projectPath),
    });
  }

  // A file: dependency can keep the same spec and version while its Blockly
  // runtime files change, so dependency metadata alone is not a valid identity.
  private getBlocklyLibraryRuntimeSignature(projectPath: string, packageContent: string): string {
    const packageJson = JSON.parse(packageContent);
    const dependencyEntries = Object.entries({
      ...(packageJson?.dependencies || {}),
      ...(packageJson?.devDependencies || {}),
      ...(packageJson?.optionalDependencies || {}),
    })
      .filter(([name]) => isAilyLibraryPackageName(name))
      .map(([name, version]) => [name, String(version ?? '')] as const)
      .sort(([a], [b]) => a.localeCompare(b));
    const language = this.translate.currentLang || this.translate.defaultLang || 'en';
    const runtimeFileNames = [
      'package.json',
      'block.json',
      'toolbox.json',
      'generator.js',
      window['path'].join('i18n', `${language}.json`),
    ];
    const libraryFileSignatures: Array<[string, string, string]> = [];

    for (const scope of AILY_PACKAGE_SCOPES) {
      const scopePath = window['path'].join(projectPath, 'node_modules', scope);
      if (window['fs'].existsSync(scopePath)) {
        const libraryDirectoryNames = window['fs'].readdirSync(scopePath)
          .filter((name: string) => name.startsWith('lib-'))
          .sort((a: string, b: string) => a.localeCompare(b));

        for (const directoryName of libraryDirectoryNames) {
          for (const fileName of runtimeFileNames) {
            const filePath = window['path'].join(scopePath, directoryName, fileName);
            const fileSignature = window['fs'].existsSync(filePath)
              ? window['fs'].md5Buffer(window['fs'].readFileSync(filePath))
              : 'missing';
            libraryFileSignatures.push([`${scope}/${directoryName}`, fileName, fileSignature]);
          }
        }
      }
    }

    return JSON.stringify({
      dependencyEntries,
      toolboxOrder: packageJson?.blocklyToolboxOrder || [],
      language,
      libraryFileSignatures,
    });
  }

  private async projectOpenInternal(projectPath = this.currentProjectPath, options: ProjectOpenOptions = {}): Promise<boolean> {
    const previousProjectPath = this.currentProjectPath;
    const activationReason = options.reason || (this.isSameProjectPath(previousProjectPath, projectPath) ? 'reload' : 'open');
    const isSwitchingProject = !!previousProjectPath
      && !this.isSameProjectPath(previousProjectPath, projectPath);

    // 判断路径是否存在
    if (!this.electronService.exists(projectPath)) {
      this.removeRecentlyProject({ path: projectPath })
      this.message.error(this.translate.instant('PROJECT.PATH_NOT_EXIST'));
      return false;
    }

    // Reject before acquiring locks, closing windows, changing routes or publishing activation.
    if (!(await this.ensureProjectModeAllowed(projectPath))) return false;

    if (this.shouldBlockForAiOperation(activationReason)) {
      this.warnBlockingAiOperation();
      return false;
    }

    if (this.electronService.isElectron && window['projectLock']) {
      let r = await window['projectLock'].tryAcquire(projectPath);
      if (!r.ok && r.conflict && r.holder) {
        const action = await this.promptProjectLockConflict(r.holder);
        if (action === 'cancel') {
          this.stateSubject.next('default');
          return false;
        }
        if (action === 'focus') {
          await window['projectLock'].focusProcess(r.holder.pid);
          this.stateSubject.next('default');
          return false;
        }
        r = await window['projectLock'].tryAcquire(projectPath, { force: true });
        if (!r.ok) {
          this.message.error(this.translate.instant('PROJECT.LOCK_ACQUIRE_FAILED'));
          this.stateSubject.next('default');
          return false;
        }
      } else if (!r.ok) {
        this.message.error(this.translate.instant('PROJECT.LOCK_ACQUIRE_FAILED'));
        this.stateSubject.next('default');
        return false;
      }
    }

    if (isSwitchingProject && !(await this.application.closeConnectionGraphWindows())) {
      if (this.electronService.isElectron && window['projectLock']) {
        try {
          await window['projectLock'].release(projectPath);
        } catch (e) {
          console.warn('project-lock release after window close failure:', e);
        }
      }
      this.warnConnectionGraphWindowCloseFailure();
      this.stateSubject.next('default');
      return false;
    }

    if (this.electronService.isElectron
      && previousProjectPath
      && !this.isSameProjectPath(previousProjectPath, projectPath)
      && window['projectLock']) {
      try {
        await window['projectLock'].release(previousProjectPath);
      } catch (e) {
        console.warn('project-lock release:', e);
      }
    }

    this.beginBlocklyProjectLoad(projectPath);

    const abiIsExist = this.getProjectMode(projectPath) === 'blockly';
    const blocklyRouteIsBeingReused = abiIsExist && this.router.url.startsWith('/main/blockly-editor');
    if (blocklyRouteIsBeingReused) {
      // Angular reuses the component when only query params change. Take an
      // awaited SPA hop so ngOnDestroy can dispose the old workspace/runtime
      // before currentProjectPath starts pointing at the next project.
      await this.router.navigate(['/main/guide'], { replaceUrl: true });
    }

    // 更新当前项目路径和包数据
    this.currentProjectPath = projectPath;
    void window['ipcRenderer']?.invoke?.('logger-set-project-path', projectPath).catch(() => undefined);
    this.projectActivationSubject.next({
      path: projectPath,
      previousPath: previousProjectPath,
      reason: activationReason,
      sessionResource: options.sessionResource ?? null,
    });

    if (activationReason === 'reload' || activationReason === 'chat-tool-reload') {
      // Angular ignores navigation to the exact same route and query params. Move off the
      // editor first so its services/workspace are destroyed and the project is really
      // rebuilt from disk instead of remaining in the loading state until the timeout.
      await this.router.navigate(['/main/guide'], { skipLocationChange: true });
    }

    let navigationCompleted: boolean;
    if (abiIsExist) {
      // 打开blockly编辑器
      navigationCompleted = await this.router.navigate(['/main/blockly-editor'], {
        queryParams: {
          path: projectPath
        },
        replaceUrl: true
      });
    } else {
      // 打开代码编辑器
      navigationCompleted = await this.router.navigate(['/main/code-editor-pro'], {
        queryParams: {
          path: projectPath
        },
        replaceUrl: true
      });
    }

    if (!navigationCompleted) {
      this.stateSubject.next('error');
      throw new Error(`Project editor navigation was not completed: ${projectPath}`);
    }

    await this.waitForProjectOpenCompletion(projectPath);
    return true;
  }

  private waitForProjectOpenCompletion(projectPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let subscription: { unsubscribe: () => void } | null = null;
      const finish = (error?: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutId);
        subscription?.unsubscribe();
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };
      const timeoutId = setTimeout(() => {
        const error = new Error(`项目加载超时: ${projectPath}`);
        this.markBlocklyProjectLoadFailed(projectPath, error.message);
        finish(error);
        console.warn('[ProjectService] project open completion timed out:', projectPath);
      }, 120000);

      subscription = this.stateSubject.subscribe((state) => {
        const isBlocklyProject = this.getProjectMode(projectPath) === 'blockly';
        if (!isBlocklyProject && state === 'loaded') {
          finish();
          return;
        }
        const status = this.getBlocklyProjectLoadStatus(projectPath);
        if (state === 'error' && status.error) {
          finish(new Error(status.error));
          return;
        }
        if (!status.ready) {
          return;
        }
        finish();
      });

      if (settled) {
        subscription.unsubscribe();
      }
    });
  }

  // 保存项目
  save(path = this.currentProjectPath, feedbackTimeoutMs = 5000) {
    if (this.isProjectOpening) {
      return Promise.resolve({
        success: false,
        error: 'project is loading',
        path,
      });
    }

    if (window['path']?.isExists?.(window['path'].join(path, 'project.abi'))) {
      const loadStatus = this.getBlocklyProjectLoadStatus(path);
      if (!loadStatus.ready) {
        return Promise.resolve({
          success: false,
          error: loadStatus.error
            ? `project load failed: ${loadStatus.error}`
            : `project is not ready for save (state=${loadStatus.state})`,
          path,
        });
      }
    }

    return new Promise<{ success: boolean; error?: string; path?: string }>((resolve) => {
      this.stateSubject.next('saving');
      void this.application.dispatchProjectSave(path, feedbackTimeoutMs).then(async result => {
        if (result.success) {
          await this.copyPackageJsonToTemp(path);
          this.currentPackageData = await this.getPackageJson();
          this.stateSubject.next('saved');
          resolve({ success: true, path });
        } else {
          console.warn('项目保存失败:', result.error);
          this.stateSubject.next('error');
          resolve({ success: false, error: result.error, path });
        }
      });
    });
  }


  async saveAs(path: string): Promise<void> {
    const sourceProjectPath = this.currentProjectPath;
    const saveResult = await this.save(sourceProjectPath);
    if (!saveResult.success) {
      throw new Error(saveResult.error || '保存当前项目失败，无法另存为');
    }
    await projectDataRuntime.flushPending();
    const sourceAbi = JSON.parse(window['fs'].readFileSync(`${sourceProjectPath}/project.abi`, 'utf8'));
    assertNoOversizedInlineValues(sourceAbi);
    const validation = await projectDataRuntime.getStore().validateReferences(
      projectDataRuntime.getStore().collectReferences(sourceAbi),
    );
    if (!validation.valid) {
      throw new Error(`项目数据资源不完整，无法另存为: ${validation.issues.map((issue) => issue.error).join('; ')}`);
    }
    //在当前路径下创建一个新的目录
    path = path.replace(/\s/g, '_');
    window['fs'].mkdirSync(path);
    // 复制项目目录到新路径
    window['fs'].copySync(sourceProjectPath, path);
    // 修改package.json文件
    const packageJson = JSON.parse(window['fs'].readFileSync(`${path}/package.json`));
    // 另存为时去掉cloudId
    if (packageJson.cloudId) {
      delete packageJson.cloudId;
    }
    // 获取新的项目名称（文件夹名）
    const name = window['path'].basename(path);
    packageJson.name = deriveProjectPackageName(name);
    packageJson.nickname = name;
    window['fs'].writeFileSync(`${path}/package.json`, JSON.stringify(packageJson, null, 2));
    // 修改当前项目路径
    this.currentProjectPath = path;
    projectDataRuntime.configure(path);
    this.currentPackageData = packageJson;
    this.addRecentlyProject({ name: this.currentPackageData.name, path: path, nickname: this.currentPackageData.nickname || this.currentPackageData.name });
  }

  async close(options: { allowDuringChatTool?: boolean } = {}) {
    if (!options.allowDuringChatTool && this.shouldBlockForAiOperation()) {
      this.warnBlockingAiOperation();
      return false;
    }

    if (this.currentProjectPath && !(await this.application.closeConnectionGraphWindows())) {
      this.warnConnectionGraphWindowCloseFailure();
      return false;
    }

    if (this.electronService.isElectron && this.currentProjectPath && window['projectLock']) {
      try {
        await window['projectLock'].release(this.currentProjectPath);
      } catch (e) {
        console.warn('project-lock release:', e);
      }
    }
    this.application.closeTerminal();
    this.currentProjectPath = '';
    this.loadingBlocklyProjectPath = '';
    this.loadedBlocklyProjectPath = '';
    this.blocklyProjectLoadFailure = null;
    void window['ipcRenderer']?.invoke?.('logger-set-project-path', '').catch(() => undefined);
    this.currentPackageData = {
      name: '',
    };
    this.stateSubject.next('default');
    // this.currentProjectPath = (await window['env'].get("AILY_PROJECT_PATH")).replace('%HOMEPATH%\\Documents', window['path'].getUserDocuments());
    await this.router.navigate(['/main/guide'], { replaceUrl: true });
    return true;
  }

  async activateCreatedProject(projectPath: string, options: ProjectCreationOptions = {}): Promise<boolean> {
    if (!projectPath || !window['fs'].existsSync(projectPath)) {
      return false;
    }
    return this.finishProjectCreation(projectPath, options);
  }

  /** 项目已被其他实例占用时的操作：取消 / 前置其他进程 / 强制打开 */
  private promptProjectLockConflict(holder: {
    pid: number;
    execPath?: string;
    appVersion?: string;
  }): Promise<'cancel' | 'focus' | 'force'> {
    let modalRef: NzModalRef;
    modalRef = this.modal.create({
      nzTitle: this.translate.instant('PROJECT.LOCK_CONFLICT_TITLE'),
      nzContent: this.translate.instant('PROJECT.LOCK_CONFLICT_CONTENT', {
        version: holder.appVersion || '-',
        pid: String(holder.pid),
      }),
      nzMaskClosable: false,
      nzClosable: true,
      nzClassName: 'project-lock-conflict-modal',
      nzWidth: 480,
      nzStyle: {
        paddingBottom: '0',
      },
      nzFooter: [
        {
          label: this.translate.instant('PROJECT.LOCK_CANCEL'),
          onClick: () => modalRef.close('cancel'),
        },
        {
          label: this.translate.instant('PROJECT.LOCK_FOCUS_OTHER'),
          type: 'primary',
          onClick: () => modalRef.close('focus'),
        },
        // 不需要强制打开选项
        // {
        //   label: this.translate.instant('PROJECT.LOCK_FORCE_OPEN'),
        //   type: 'primary',
        //   danger: true,
        //   onClick: () => modalRef.close('force'),
        // },
      ],
    });
    return new Promise((resolve) => {
      modalRef.afterClose.subscribe((result) => {
        resolve((result as 'cancel' | 'focus' | 'force') || 'cancel');
      });
    });
  }

  getProjectMode(projectPath: string): ProjectMode | null {
    if (!projectPath || !this.electronService.isElectron) return null;
    try {
      const packagePath = window['path'].join(projectPath, 'package.json');
      const manifest = window['fs'].existsSync(packagePath)
        ? JSON.parse(window['fs'].readFileSync(packagePath, 'utf8')) : undefined;
      return detectProjectMode({
        manifest,
        hasAbi: window['fs'].existsSync(window['path'].join(projectPath, 'project.abi')),
        hasAci: window['fs'].existsSync(window['path'].join(projectPath, 'project.aci')),
      });
    } catch {
      return null;
    }
  }

  private async assertProjectCreationMode(mode: ProjectMode): Promise<void> {
    await this.configService.init();
    if (mode !== this.configService.getPreferredChatAgentRuntimeMode()) {
      throw new Error(this.translate.instant('PROJECT.MODE_CREATE_RESTRICTED', {
        application: getProjectApplicationName(this.configService.getPreferredChatAgentRuntimeMode()),
        targetApplication: getProjectApplicationName(mode),
      }));
    }
  }

  async ensureProjectModeAllowed(projectPath: string): Promise<boolean> {
    await this.configService.init();
    const mode = this.getProjectMode(projectPath);
    if (!mode) {
      this.message.error(this.translate.instant('PROJECT.MODE_UNKNOWN'));
      return false;
    }
    if (mode === this.configService.getPreferredChatAgentRuntimeMode()) return true;

    const application = getProjectApplicationName(mode);
    let installed = false;
    try {
      const status = await window['ipcRenderer'].invoke('project-companion-status', { mode });
      installed = status?.installed === true;
    } catch (error) {
      console.warn('Companion application lookup failed:', error);
    }
    this.modal.confirm({
      nzClassName: 'project-mode-mismatch-modal',
      nzCentered: true,
      nzWidth: 480,
      nzMaskClosable: false,
      nzTitle: this.translate.instant('PROJECT.MODE_MISMATCH_TITLE'),
      nzContent: this.translate.instant(installed ? 'PROJECT.MODE_OPEN_OTHER' : 'PROJECT.MODE_DOWNLOAD_OTHER', { application }),
      nzOkText: this.translate.instant(installed ? 'PROJECT.MODE_OPEN_BUTTON' : 'PROJECT.MODE_DOWNLOAD_BUTTON', { application }),
      nzCancelText: this.translate.instant('PROJECT.LOCK_CANCEL'),
      nzOnOk: async () => {
        try {
          const result = await window['ipcRenderer'].invoke(
            installed ? 'project-companion-open' : 'project-companion-download',
            { mode, projectPath },
          );
          if (result?.ok !== true) throw new Error(result?.error || 'Application launch failed');
          return true;
        } catch (error) {
          console.warn('Companion application action failed:', error);
          this.message.error(this.translate.instant('PROJECT.MODE_LAUNCH_FAILED', { application }));
          return false;
        }
      },
    });
    return false;
  }

  // Filtering is a view: add/remove must always preserve the other mode's stored history.
  get recentlyProjects(): RecentProject[] {
    const source: RecentProject[] = this.configService.data?.recentlyProjects || [];
    const mode = this.configService.getPreferredChatAgentRuntimeMode();
    const cache = this.recentProjectsCache;
    if (cache?.source === source && cache.mode === mode && Date.now() - cache.time < 1000) return cache.projects;
    const projects = source.filter((project) => this.getProjectMode(project.path) === mode);
    this.recentProjectsCache = { source, mode, time: Date.now(), projects };
    return projects;
  }

  set recentlyProjects(data: RecentProject[]) {
    this.configService.data.recentlyProjects = data;
    this.recentProjectsCache = null;
    this.configService.save();
  }

  addRecentlyProject(data: RecentProject) {
    this.recentlyProjects = addRecentProject(this.configService.data?.recentlyProjects || [], data);
  }

  removeRecentlyProject(data: { path: string }) {
    this.recentlyProjects = removeRecentProject(this.configService.data?.recentlyProjects || [], data.path);
  }

  // 检查项目是否未保存
  async hasUnsavedChanges(): Promise<boolean> {
    // 如果项目尚未加载，则没有未保存的更改
    if (this.stateSubject.value === 'default' || !this.currentProjectPath) {
      return false;
    }

    return this.application.hasUnsavedBlocklyChanges();
  }

  // 获取当前项目的package.json
  async getPackageJson() {
    if (!this.currentProjectPath) {
      return null;
    }
    const packageJsonPath = `${this.currentProjectPath}/package.json`;
    return JSON.parse(window['fs'].readFileSync(packageJsonPath, 'utf8'));
  }

  /**
   * 同步 package.json 与 temp 文件夹：
   * - 若 temp/package.json 存在，则用它覆盖主项目的 package.json
   * - 若不存在，则将主项目的 package.json 复制到 temp 文件夹
   * node_modules 由 npm 维护；这里不能按顶层声明清理，否则会误删提升到根目录的间接依赖。
   */
  async syncPackageJsonWithTemp(projectPath: string): Promise<void> {
    if (this.isAilyCodeProject(projectPath)) {
      return;
    }
    const mainPackagePath = window['path'].join(projectPath, 'package.json');
    const tempDir = window['path'].join(projectPath, '.temp');
    const tempPackagePath = window['path'].join(tempDir, 'package.json');

    if (!window['fs'].existsSync(mainPackagePath)) {
      return;
    }

    if (window['fs'].existsSync(tempPackagePath)) {
      // temp 下有 package.json，覆盖主项目
      const tempContent = window['fs'].readFileSync(tempPackagePath, 'utf8');
      window['fs'].writeFileSync(mainPackagePath, tempContent);
    } else {
      // temp 下无 package.json，从主项目复制到 temp
      await this.copyPackageJsonToTemp(projectPath);
    }
  }

  /** 项目保存时同步 Blockly 的 package.json 快照；Coder 不创建 .temp。 */
  async copyPackageJsonToTemp(projectPath: string): Promise<boolean> {
    if (this.isAilyCodeProject(projectPath)) {
      return true;
    }
    const mainPackagePath = window['path'].join(projectPath, 'package.json');
    const tempDir = window['path'].join(projectPath, '.temp');
    const tempPackagePath = window['path'].join(tempDir, 'package.json');
    if (!window['fs'].existsSync(mainPackagePath)) {
      return false;
    }
    try {
      if (!window['fs'].existsSync(tempDir)) {
        window['fs'].mkdirSync(tempDir, { recursive: true });
      }
      const mainContent = window['fs'].readFileSync(mainPackagePath, 'utf8');
      window['fs'].writeFileSync(tempPackagePath, mainContent);
      return true;
    } catch (error) {
      console.warn('复制 package.json 到 temp 失败:', error);
      return false;
    }
  }

  async setPackageJson(data: any) {
    if (!this.currentProjectPath) {
      throw new Error('当前项目路径未设置');
    }

    // set之前重新获取最新的package.json内容，然后进行合并
    const currentPackageJson = await this.getPackageJson();
    // 对比写入内容和当前内容是否相同，如果相同则不写入
    if (JSON.stringify(currentPackageJson) === JSON.stringify(data)) {
      // console.log('package.json内容未更改，跳过写入');
      return;
    }

    if (currentPackageJson) {
      data = { ...currentPackageJson, ...data };
    }

    const packageJsonPath = `${this.currentProjectPath}/package.json`;

    try {
      this.writePackageJsonFile(packageJsonPath, data);
    } catch (error) {
      console.error('写入package.json失败:', error);
      throw error;
    }

    if (!this.isAilyCodeProject(this.currentProjectPath)) {
      const tempPackageJsonPath = window['path'].join(this.currentProjectPath, '.temp', 'package.json');
      try {
        const tempDir = window['path'].dirname(tempPackageJsonPath);
        if (!window['fs'].existsSync(tempDir)) {
          window['fs'].mkdirSync(tempDir, { recursive: true });
        }
        this.writePackageJsonFile(tempPackageJsonPath, data);
      } catch (error) {
        console.warn('同步 package.json 到 temp 失败:', error);
      }
    }

    // 更新当前packageData
    this.currentPackageData = data;
  }

  private writePackageJsonFile(packageJsonPath: string, data: any) {
    try {
      window['fs'].writeFileSync(packageJsonPath, JSON.stringify(data, null, 2));
    } catch (error) {
      console.warn('写入package.json失败，尝试修改权限后重试:', error);
      if (window['fs'].existsSync(packageJsonPath)) {
        window['fs'].chmodSync(packageJsonPath, 0o666);
        window['fs'].writeFileSync(packageJsonPath, JSON.stringify(data, null, 2));
        return;
      }

      throw error;
    }
  }

  /**
   * 添加或更新宏定义
   * @param macro 宏定义字符串，如 "BOARD_SCREEN_COMBO=501"
   */
  async addMacro(macro: string) {
    const pkg = await this.getPackageJson();
    if (!pkg.MACROS) {
      pkg.MACROS = [];
    }

    // 规范化为字符串数组（如果存储为 [[...], [...]] 则取首元素）
    const normalized: string[] = (pkg.MACROS || []).map((m: any) => {
      if (Array.isArray(m)) return String(m[0] || '').trim();
      return String(m || '').trim();
    }).filter((s: string) => s.length > 0);

    // 提取宏名称（等号前的部分），并支持无等号的宏定义
    const macroName = macro.split('=')[0];

    // 查找已有的同名项（以名称为准，不区分是否带赋值）
    const existingIndex = normalized.findIndex((entry) => {
      const entryName = entry.split('=')[0];
      return entryName === macroName;
    });

    if (existingIndex !== -1) {
      // 替换同名项
      normalized[existingIndex] = macro;
    } else {
      // 追加新宏
      normalized.push(macro);
    }

    // 在写入前再次读取最新的 package.json，防止并发写入覆盖
    const latestPkg = await this.getPackageJson();
    if (!latestPkg.MACROS) latestPkg.MACROS = [];

    // 规范化并写回到最新 pkg
    latestPkg.MACROS = normalized.map(s => [s]);

    console.log('addMacro -> normalized macros to write:', latestPkg.MACROS);
    await this.setPackageJson(latestPkg);
    console.log('✅ 添加宏定义:', macro, '当前宏列表:', latestPkg.MACROS);
  }

  /**
   * 删除宏定义
   * @param macroName 宏名称，如 "BOARD_SCREEN_COMBO"
   */
  async removeMacro(macroName: string) {
    const pkg = await this.getPackageJson();
    if (!pkg.MACROS || pkg.MACROS.length === 0) {
      return;
    }

    // 规范化为字符串数组（兼容 ['A'] 或 [['A=1']] 等存储形式）
    const normalized: string[] = (pkg.MACROS || []).map((m: any) => {
      if (Array.isArray(m)) return String(m[0] || '').trim();
      return String(m || '').trim();
    }).filter((s: string) => s.length > 0);

    // 过滤掉名称匹配的宏（既匹配 "NAME" 又匹配 "NAME=..."）
    const filtered = normalized.filter(entry => {
      const name = entry.split('=')[0];
      return name !== macroName;
    });

    // 在写入前再次读取最新的 package.json，防止并发写入覆盖
    const latestPkg = await this.getPackageJson();
    if (!latestPkg.MACROS) latestPkg.MACROS = [];

    latestPkg.MACROS = filtered.map(s => [s]);
    console.log('removeMacro -> normalized macros to write:', latestPkg.MACROS);
    await this.setPackageJson(latestPkg);
    console.log('🗑️ 删除宏定义:', macroName, '当前宏列表:', latestPkg.MACROS);
  }

  /**
   * 获取所有宏定义
   * @returns 宏定义数组，如 ["BOARD_SCREEN_COMBO=501", "BBXX"]
   */
  async getMacros(): Promise<string[]> {
    const pkg = await this.getPackageJson();
    if (!pkg.MACROS || pkg.MACROS.length === 0) {
      return [];
    }
    return (pkg.MACROS || []).map((m: any) => {
      if (Array.isArray(m)) return String(m[0] || '');
      return String(m || '');
    }).filter((s: string) => s.length > 0);
  }

  /**
   * 获取编译时的宏定义参数
   * @returns 如 "BOARD_SCREEN_COMBO=501,BBXX"
   */
  async getBuildMacrosString(): Promise<string> {
    const macros = await this.getMacros();
    return macros.join(',');
  }

  // 获取开发板名称（Blockly: @aily-project/board-*；Aily Code: @aily-project/coder-*）
  async getBoardModule() {
    const prjPackageJson = await this.getPackageJson();
    const deps = Object.keys(prjPackageJson.dependencies || {});
    const fromDeps =
      deps.find((dep) => isAilyBoardPackageName(dep))
      ?? deps.find((dep) => dep.startsWith('@aily-project/coder-'));
    if (fromDeps) {
      return fromDeps;
    }
    const boardDeps = Object.keys(prjPackageJson.boardDependencies || {});
    const fromBoardDeps =
      boardDeps.find((dep) => isAilyBoardPackageName(dep))
      ?? boardDeps.find((dep) => dep.startsWith('@aily-project/coder-'));
    if (fromBoardDeps) {
      return fromBoardDeps;
    }
    if (this.currentProjectPath) {
      const aciPath = `${this.currentProjectPath}/project.aci`;
      if (window['fs'].existsSync(aciPath)) {
        try {
          const aci = JSON.parse(this.electronService.readFile(aciPath));
          const boardPackage = String(aci?.target?.boardPackage ?? '').trim();
          if (boardPackage) {
            return boardPackage;
          }
          const board = String(aci?.target?.board ?? '').trim();
          if (isAilyScopedPackageName(board)) {
            return board;
          }
        } catch {
          /* ignore */
        }
      }
    }
    return undefined;
  }

  // 获取开发板模块的package.json
  async getBoardPackageJson() {
    const boardModule = await this.getBoardModule();
    const boardPackageJsonPath = `${this.currentProjectPath}/node_modules/${boardModule}/package.json`;
    return JSON.parse(this.electronService.readFile(boardPackageJsonPath));
  }

  /**
   * Aily Code：合并主板 boardDependencies 与 platform.json runtimeDependencies，
   * 供 SDK 路径解析、Platform Packages 树与编译链使用。
   */
  async getEffectiveBoardDependencies(): Promise<Record<string, string>> {
    try {
      const boardPackageJson = await this.getBoardPackageJson();
      const platformRef = readPlatformRefFromProjectPackage(this.currentProjectPath);
      return resolveEffectiveBoardDependencies(
        boardPackageJson?.boardDependencies,
        platformRef?.packageName,
      );
    } catch {
      return {};
    }
  }

  // 获取开发板配置文件board.json
  async getBoardJson() {
    const boardModule = await this.getBoardModule();
    if (!boardModule) {
      throw new Error('未找到开发板模块');
    }
    const boardJsonPath = `${this.currentProjectPath}/node_modules/${boardModule}/board.json`;
    if (!window['fs'].existsSync(boardJsonPath)) {
      throw new Error('开发板配置文件不存在: ' + boardJsonPath);
    }
    return JSON.parse(this.electronService.readFile(boardJsonPath));
  }

  /**
   * 从工程 node_modules 主板包同步 board.json 到 currentBoardConfig。
   * Blockly 在 loadProject 内设置；Aily Code（code-editor-pro）在依赖就绪后调用。
   */
  async syncCurrentBoardConfig(): Promise<boolean> {
    try {
      const boardJson = await this.getBoardJson();
      this.currentBoardConfig = boardJson;
      window['boardConfig'] = boardJson;
      this.boardConfigUpdatedSubject.next(boardJson);
      return true;
    } catch (e) {
      console.warn('同步开发板配置失败:', e);
      return false;
    }
  }

  async resolveBoardConfigForRuntime(rawBoardJson?: any): Promise<any> {
    const boardJson = rawBoardJson ?? await this.getBoardJson();
    const resolvedBoardJson = JSON.parse(JSON.stringify(boardJson));
    const cdcEnabled = await this.isCdcOnBootEnabledForProject(resolvedBoardJson);
    this.application.applyCdcSerialPortOverrides(resolvedBoardJson, cdcEnabled);
    return resolvedBoardJson;
  }

  async refreshRuntimeBoardConfig(): Promise<any> {
    const resolvedBoardJson = await this.resolveBoardConfigForRuntime();
    this.currentBoardConfig = resolvedBoardJson;
    window['boardConfig'] = resolvedBoardJson;
    this.boardConfigUpdatedSubject.next(resolvedBoardJson);
    return resolvedBoardJson;
  }

  async isCdcOnBootEnabledForProject(
    rawBoardJson?: any,
    cdcOnBootOption?: string,
  ): Promise<boolean> {
    try {
      const boardJson = rawBoardJson ?? await this.getBoardJson();
      if (!Array.isArray(boardJson?.cdcSerialPort) || boardJson.cdcSerialPort.length === 0) {
        return false;
      }

      const core = String(boardJson?.core || '');
      if (!core.includes('esp32')) {
        return false;
      }

      const boardName = this.getBoardNameFromBoardJson(boardJson);
      if (!boardName) {
        return false;
      }

      const packageJson = await this.getPackageJson();
      const option = cdcOnBootOption ?? packageJson?.projectConfig?.CDCOnBoot;
      if (!option) {
        return false;
      }

      const rawBoardConfig = await this.getRawBoardsTxtConfig(boardName);
      if (!rawBoardConfig) {
        return false;
      }

      const cdcOnBootKey = `${boardName}.menu.CDCOnBoot.${option}.build.cdc_on_boot`;
      return rawBoardConfig[cdcOnBootKey] === '1';
    } catch (error) {
      console.warn('[ProjectService] failed to resolve CDCOnBoot state:', error);
      return false;
    }
  }

  private getBoardNameFromBoardJson(boardJson: any): string | null {
    const type = boardJson?.type;
    if (typeof type !== 'string' || !type) {
      return null;
    }

    const parts = type.split(':');
    return parts[parts.length - 1] || null;
  }

  private async getRawBoardsTxtConfig(boardName: string): Promise<Record<string, string> | null> {
    try {
      const sdkPath = await this.getSdkPath();
      if (!sdkPath) {
        return null;
      }

      const boardsFilePath = `${sdkPath}/boards.txt`;
      if (!window['fs'].existsSync(boardsFilePath)) {
        return null;
      }

      const boardsContent = window['fs'].readFileSync(boardsFilePath, 'utf8');
      const lines = boardsContent.split('\n');
      return this.parseBoardsConfig(lines, boardName);
    } catch (error) {
      console.warn('[ProjectService] failed to read raw boards.txt config:', error);
      return null;
    }
  }

  // 获取开发板根目录路下得特殊配置文件，如 ESP32 需要的 partitions.csv
  async getBoardFile(fileName: string) {
    const boardModule = await this.getBoardModule();
    if (!boardModule) {
      throw new Error('未找到开发板模块');
    }
    const filePath = `${this.currentProjectPath}/node_modules/${boardModule}/${fileName}`;
    if (!window['fs'].existsSync(filePath)) {
      return null;
    }
    return filePath;
  }


  // 获取开发板特殊配置文件，如 STM32 需要的特殊配置
  async getJsonConfig(fileName: string) {
    const boardModule = await this.getBoardModule();
    if (!boardModule) {
      throw new Error('未找到开发板模块');
    }
    const configPath = `${this.currentProjectPath}/node_modules/${boardModule}/${fileName}`;
    if (!window['fs'].existsSync(configPath)) {
      throw new Error('配置文件不存在: ' + configPath);
    }
    return JSON.parse(this.electronService.readFile(configPath));
  }

  // 修改开发板配置文件board.json， 如 STM32需要，传入新的data
  async setBoardJson(data: any) {
    const boardModule = await this.getBoardModule();
    if (!boardModule) {
      throw new Error('未找到开发板模块');
    }
    const boardJsonPath = `${this.currentProjectPath}/node_modules/${boardModule}/board.json`;
    if (!window['fs'].existsSync(boardJsonPath)) {
      throw new Error('开发板配置文件不存在: ' + boardJsonPath);
    }

    // 保存当前项目
    this.save();
    this.message.loading(this.translate.instant('PROJECT.SWITCHING_BOARD_CONFIG'), { nzDuration: 5000 });

    const boardJson = JSON.parse(this.electronService.readFile(boardJsonPath));
    Object.assign(boardJson, data);
    window['fs'].writeFileSync(boardJsonPath, JSON.stringify(boardJson, null, 2));

    // 重新加载项目
    console.log('重新加载项目...');
    await this.projectOpen(this.currentProjectPath);

    // 通知开发板变更
    this.boardChangeSubject.next();
    this.application.updateFooterState({ state: 'done', text: this.translate.instant('PROJECT.BOARD_SWITCH_COMPLETE') });
    this.message.success(this.translate.instant('PROJECT.BOARD_SWITCH_SUCCESS'), { nzDuration: 3000 });
  }

  // 获取开发板package路径
  async getBoardPackagePath() {
    const boardModule = await this.getBoardModule();
    if (!boardModule) {
      throw new Error('未找到开发板模块');
    }
    const boardPackagePath = `${this.currentProjectPath}/node_modules/${boardModule}`;
    return boardPackagePath;
  }

  /** Load the optional menu and translations shipped by the current board package. */
  async loadBoardMenuConfig(): Promise<IMenuItem[]> {
    this.currentBoardMenuConfig = [];
    this.currentBoardMenuI18nDir = '';

    try {
      const boardPackagePath = await this.getBoardPackagePath();
      const menuPath = this.electronService.pathJoin(boardPackagePath, 'menu.json');
      if (!this.electronService.exists(menuPath)) {
        return [];
      }

      const menuConfig = JSON.parse(this.electronService.readFile(menuPath));
      if (!Array.isArray(menuConfig)) {
        throw new Error('menu.json must contain an array');
      }

      this.currentBoardMenuConfig = menuConfig as IMenuItem[];
      this.currentBoardMenuI18nDir = this.electronService.pathJoin(boardPackagePath, 'i18n');
      await this.loadCurrentBoardMenuTranslations();
      return this.cloneCurrentBoardMenuConfig();
    } catch (error) {
      console.warn('[ProjectService] failed to load board menu config:', error);
      this.currentBoardMenuConfig = [];
      this.currentBoardMenuI18nDir = '';
      return [];
    }
  }

  private cloneCurrentBoardMenuConfig(): IMenuItem[] {
    return JSON.parse(JSON.stringify(this.currentBoardMenuConfig)) as IMenuItem[];
  }

  private async loadCurrentBoardMenuTranslations(
    requestedLang = this.translate.currentLang || this.translate.defaultLang || 'en',
  ): Promise<void> {
    if (!this.currentBoardMenuI18nDir || !requestedLang) {
      return;
    }

    const candidates = requestedLang === 'en' ? ['en'] : [requestedLang, 'en'];
    for (const lang of candidates) {
      const i18nPath = this.electronService.pathJoin(this.currentBoardMenuI18nDir, `${lang}.json`);
      if (!this.electronService.exists(i18nPath)) {
        continue;
      }

      try {
        const translations = JSON.parse(this.electronService.readFile(i18nPath));
        if (!translations || typeof translations !== 'object' || Array.isArray(translations)) {
          throw new Error(`i18n/${lang}.json must contain an object`);
        }
        this.translate.setTranslation(requestedLang, translations, true);
        return;
      } catch (error) {
        console.warn(`[ProjectService] failed to load board menu translations (${lang}):`, error);
      }
    }
  }

  // 获取开发板 SDK 路径
  async getSdkPath() {
    try {
      const boardDependencies = await this.getEffectiveBoardDependencies();
      if (!boardDependencies || Object.keys(boardDependencies).length === 0) {
        throw new Error('未找到开发板 SDK 路径');
      }

      const sdkModule = Object.keys(boardDependencies).find(dep => dep.startsWith('@aily-project/sdk-'));
      if (!sdkModule) {
        throw new Error('未找到开发板 SDK 模块');
      }

      const sdkVersion = boardDependencies[sdkModule];
      const sdkFileName = sdkModule.replace('@aily-project/sdk-', '') + '_' + sdkVersion;
      const appDataPath = window['path'].getAppDataPath()
      const sdkLibPath = this.electronService.pathJoin(appDataPath, 'sdk', `${sdkFileName}`);
      if (!window['fs'].existsSync(sdkLibPath)) {
        throw new Error('SDK 库路径不存在: ' + sdkLibPath);
      }

      // // Get all files in the SDK library path
      // const sdkFiles = window['fs'].readDirSync(sdkLibPath);

      // // Filter for .7z files
      // const sdkZipFiles = sdkFiles.filter(file => file.name.endsWith('.7z'));

      // // If there are no .7z files, throw an error
      // if (sdkZipFiles.length === 0) {
      //   throw new Error('未找到 SDK 压缩包文件');
      // }

      // // Replace '@' with '_' in the filename
      // const sdkZipFileName = sdkZipFiles[0].name;
      // const formattedSdkZipFileName = sdkZipFileName.replace(/@/g, '_').replace(/\.7z$/i, '');

      // sdk path
      // return `${await window["env"].get('AILY_SDK_PATH')}/${formattedSdkZipFileName}`;
      return `${await window["env"].get('AILY_SDK_PATH')}/${sdkFileName}`;
    } catch (error) {
      console.error('获取 SDK 路径失败:', error);
      return "";
    }
  }


  private parseBoardsConfig(lines: string[], boardName: string): { [key: string]: string } | null {
    const config: { [key: string]: string } = {};
    let foundBoard = false;
    let currentBoard = '';

    for (const line of lines) {
      const trimmedLine = line.trim();

      // 跳过空行和注释
      if (!trimmedLine || trimmedLine.startsWith('#')) {
        continue;
      }

      // 检查是否是开发板名称定义
      const nameMatch = trimmedLine.match(/^(\w+)\.name=(.+)$/);
      if (nameMatch) {
        currentBoard = nameMatch[1];
        foundBoard = (currentBoard === boardName);
        if (foundBoard) {
          config[`${currentBoard}.name`] = nameMatch[2];
        }
        continue;
      }

      // 以boardName.开头的行表示当前开发板的配置
      if (!foundBoard) {
        if (trimmedLine.startsWith(`${boardName}.`)) {
          foundBoard = true;
          currentBoard = boardName;
        }
      }

      // 如果找到了目标开发板，继续收集配置
      if (foundBoard && trimmedLine.startsWith(`${boardName}.`)) {
        const configMatch = trimmedLine.match(/^([^=]+)=(.*)$/);
        if (configMatch) {
          config[configMatch[1]] = configMatch[2];
        }
      }

      // 如果遇到了新的开发板定义且不是目标开发板，停止收集
      if (foundBoard && nameMatch && nameMatch[1] !== boardName) {
        break;
      }
    }

    return Object.keys(config).length > 0 ? config : null;
  }

  // 通用配置值比较。
  private compareConfigs(childData: any, currentData: any): boolean {
    return childData === currentData;
  }

  // 提取菜单选项
  private extractMenuOptions(boardConfig: { [key: string]: string }, menuType: string): any[] {
    const options: any[] = [];
    const boardName = Object.keys(boardConfig)[0].split('.')[0];
    const menuPrefix = `${boardName}.menu.${menuType}.`;

    // 首先收集所有选项的基本信息
    const optionDatas = new Set<string>();

    for (const key in boardConfig) {
      if (key.startsWith(menuPrefix)) {
        const remainingPath = key.replace(menuPrefix, '');
        const optionData = remainingPath.split('.')[0];

        // 只处理主选项，不处理子属性
        if (!remainingPath.includes('.') || remainingPath.split('.').length === 2) {
          optionDatas.add(optionData);
          // console.log('Found option data:', optionData);
        }
      }
    }

    // 构建选项列表，只包含key和data，key为menuType，data为optionData
    optionDatas.forEach(optionData => {
      const option = {
        name: boardConfig[`${menuPrefix}${optionData}`] || optionData,
        key: menuType,
        data: optionData,
        check: false,
        // // 其他属性 如 build.variant
        extra: {
          build: {
            variant: boardConfig[`${menuPrefix}${optionData}.build.variant`] || '',
            variant_h: boardConfig[`${menuPrefix}${optionData}.build.variant_h`] || ''
          }
        }
      }

      // console.log(`==========>>>${menuPrefix}${optionData}:`, boardConfig[`${menuPrefix}${optionData}.build.variant`] || '');
      // console.log('option:', option);

      options.push(option);
    });

    // // 为每个选项构建完整的配置对象
    // optionKeys.forEach(optionKey => {
    //   const mainKey = `${menuPrefix}${optionKey}`;
    //   const optionName = boardConfig[mainKey];

    //   if (optionName) {
    //     const option = {
    //       name: optionName,
    //       key: menuType,
    //       data: {
    //         build: {},
    //         upload: {}
    //       },
    //       check: false
    //     };

    //     // 收集该选项的所有相关配置
    //     for (const key in boardConfig) {
    //       if (key.startsWith(`${menuPrefix}${optionKey}.`)) {
    //         const configPath = key.replace(`${menuPrefix}${optionKey}.`, '');
    //         const pathParts = configPath.split('.');

    //         if (pathParts.length === 2) {
    //           const category = pathParts[0]; // build 或 upload
    //           const property = pathParts[1]; // partitions, maximum_size 等

    //           if (category === 'build' || category === 'upload') {
    //             option.data[category][property] = boardConfig[key];
    //           }
    //         }
    //       }
    //     }

    //     // 清理空的配置对象
    //     if (Object.keys(option.data.build).length === 0) {
    //       delete option.data.build;
    //     }
    //     if (Object.keys(option.data.upload).length === 0) {
    //       delete option.data.upload;
    //     }
    //     if (Object.keys(option.data).length === 0) {
    //       delete option.data;
    //     }

    //     options.push(option);
    //   }
    // });
    return options;
  }

  /** Build the current board's configuration menu from its root menu.json. */
  async getBoardConfigMenu(): Promise<IMenuItem[]> {
    const menu = this.cloneCurrentBoardMenuConfig();
    if (menu.length === 0) {
      return [];
    }

    let packageJson: any = {};
    let currentProjectConfig: Record<string, any> = {};
    try {
      packageJson = await this.getPackageJson();
      currentProjectConfig = packageJson?.projectConfig || {};
    } catch (error) {
      console.warn('[ProjectService] failed to read current project config:', error);
    }

    const boardName = this.getBoardNameFromBoardJson(this.currentBoardConfig);
    const boardConfig = boardName ? await this.getRawBoardsTxtConfig(boardName) : null;
    const pinConfigDefaults: IMenuItem[] = [];
    let packageJsonChanged = false;

    for (const menuItem of menu) {
      if (!menuItem.key) {
        continue;
      }

      let children = Array.isArray(menuItem.children) ? menuItem.children : [];
      if (boardConfig) {
        const extractedOptions = this.extractMenuOptions(boardConfig, menuItem.key);
        if (extractedOptions.length > 0) {
          children = extractedOptions;
        }
      }

      const optionNameIncludes = menuItem.extra?.optionNameIncludes;
      if (optionNameIncludes) {
        children = children.filter(child => String(child.name || '').includes(optionNameIncludes));
      }

      const currentValue = currentProjectConfig[menuItem.key];
      let hasSelectedChild = false;
      for (const child of children) {
        child.key = child.key || menuItem.key;
        child.extra = {
          ...(menuItem.extra || {}),
          ...(child.extra || {}),
        };
        child.check = currentValue !== undefined && this.compareConfigs(child.data, currentValue);
        hasSelectedChild ||= child.check;

        if (child.check && child.extra?.syncPinConfig) {
          this.currentBoardPinConfig.board = child.data;
          this.currentBoardPinConfig.variant = child.extra?.build?.variant || null;
          this.currentBoardPinConfig.variant_h = child.extra?.build?.variant_h || null;
        }
      }

      // boards.txt treats the first option as the effective default. Keep the
      // menu aligned with that behavior when the project has no matching value.
      if (!hasSelectedChild && children.length > 0) {
        children[0].check = true;
      }

      if (
        currentValue === undefined &&
        menuItem.extra?.selectFirstByDefault &&
        children.length > 0 &&
        packageJson
      ) {
        const firstChild = children[0];
        firstChild.check = true;
        packageJson.projectConfig = packageJson.projectConfig || {};
        packageJson.projectConfig[menuItem.key] = firstChild.data;
        currentProjectConfig[menuItem.key] = firstChild.data;
        packageJsonChanged = true;
        if (firstChild.extra?.syncPinConfig) {
          pinConfigDefaults.push(firstChild);
        }
      }

      menuItem.children = children;
    }

    if (packageJsonChanged) {
      await this.setPackageJson(packageJson);
      for (const pinConfig of pinConfigDefaults) {
        await this.syncBoardPinConfig(pinConfig);
      }
    }

    return menu;
  }

  /**
   * 获取 softdevice hex 文件路径
   * 路径格式: {appDataPath}/sdk/nrf5_{version}/cores/nRF5/SDK/components/softdevice/{softdevice}/hex/{softdevice}_nrf51_2.0.0_softdevice.hex
   * @param softdeviceName softdevice 名称，如 "s110" 或 "none"
   * @returns softdevice hex 文件路径，如果不存在则返回 null
   */
  async getSoftdeviceHexPath(softdeviceName: string): Promise<string | null> {
    try {
      // 获取 SDK 路径
      const sdkPath = await this.getSdkPath();
      if (!sdkPath) {
        console.error('未找到 SDK 路径');
        return null;
      }

      // 构建 softdevice 目录路径
      // 路径: sdk/nrf5_x.x.x/cores/nRF5/SDK/components/softdevice/{softdevice}/hex/
      const softdeviceDir = window['path'].join(
        sdkPath,
        'cores',
        'nRF5',
        'SDK',
        'components',
        'softdevice',
        softdeviceName,
        'hex'
      );

      console.log('Softdevice 目录路径:', softdeviceDir);

      if (!window['fs'].existsSync(softdeviceDir)) {
        console.error('Softdevice 目录不存在:', softdeviceDir);
        return null;
      }

      // 查找 hex 文件
      const files = window['fs'].readdirSync(softdeviceDir);
      const hexFile = files.find((file: string) => file.endsWith('.hex'));

      if (!hexFile) {
        console.error('未找到 hex 文件:', softdeviceDir);
        return null;
      }

      const hexPath = window['path'].join(softdeviceDir, hexFile);
      console.log('Softdevice hex 文件路径:', hexPath);
      return hexPath;
    } catch (error) {
      console.error('获取 softdevice hex 路径失败:', error);
      return null;
    }
  }

  // 同步 menu.json 选项声明的开发板引脚配置。
  async syncBoardPinConfig(pinConfig: any): Promise<boolean> {
    // console.log('=============================================');
    // console.log('Comparing board pin config:', pinConfig, "||", this.currentBoardPinConfig);
    if (pinConfig.data == this.currentBoardPinConfig.board) {
      return true;
    } else if (pinConfig.extra?.build.variant == this.currentBoardPinConfig.variant) {
      this.currentBoardPinConfig.board = pinConfig.data;
      return true;
    } else {
      let newPinConfig = pinConfig;

      // newPinConfig = this.parseGenericConfig(newPinConfig);
      // console.log('=============================================');
      // console.log('newPinConfig:', newPinConfig);

      let variant = newPinConfig.extra?.build.variant || null;
      let variant_h = newPinConfig.extra?.build.variant_h || 'variant_generic.h';

      const setPinConfig = await this.getVariantConfig(variant, variant_h);
      const currentBoardJson = await this.getBoardJson();

      let isChanged = false;

      if (typeof setPinConfig === 'object' && setPinConfig !== null) {
        Object.keys(setPinConfig).forEach(key => {
          if (Array.isArray(setPinConfig[key])) {
            if (JSON.stringify(currentBoardJson[key]) !== JSON.stringify(setPinConfig[key])) {
              currentBoardJson[key] = setPinConfig[key];
              isChanged = true;
            }
          }
        });
      }

      // 保存更新后的board.json
      if (isChanged) {
        await this.setBoardJson(currentBoardJson);
      }
      this.currentBoardPinConfig.board = pinConfig.data;
      this.currentBoardPinConfig.variant = variant;
      this.currentBoardPinConfig.variant_h = variant_h;

      // // // 获取到的config格式为“STM32F1xx/F100C(4-6)T”
      // // // 我们需要转换为“F1XXC”
      // // // 支持 STM32F1xx/F103C、STM32F4xx/F407V、STM32H7xx/H767Z、STM32C0xx/C030F 等
      // // const match = newPinConfig.match(/STM32([A-Z]\d?)xx\/[A-Z]\d{3}([A-Z])/i);
      // // if (match) {
      // //   // match[1] 可能是 F1、F4、H7、C0 等，match[2] 是主型号字母
      // //   newPinConfig = match[1].toUpperCase() + 'XX' + match[2].toUpperCase();
      // // }
      // // console.log('newPinConfig:', newPinConfig);
      // // 读取特殊配置文件
      // const newPinJson = await this.getJsonConfig(newPinConfig + '.pins.json');
      // // console.log('newPinJson:', newPinJson);
      // const currentBoardJson = await this.getBoardJson();
      // // console.log('currentBoardJson:', currentBoardJson);
      // let isChanged = false;
      // // 遍历newPinJson中的每一项，更新currentBoardJson中的对应项
      // if (typeof newPinJson === 'object' && newPinJson !== null) {
      //   // 如果 newPinJson 结构为 {analog: [...], digital: [...]}，则直接整体替换 currentBoardJson 的同名属性
      //   Object.keys(newPinJson).forEach(key => {
      //     // console.log(`Comparing key: ${key}`);
      //     if (Array.isArray(newPinJson[key])) {
      //       if (JSON.stringify(currentBoardJson[key]) !== JSON.stringify(newPinJson[key])) {
      //         currentBoardJson[key] = newPinJson[key];
      //         isChanged = true;
      //       }
      //     }
      //   });
      // } else {
      //   console.error('newPinJson 不是对象:', newPinJson);
      // }
      // // 保存更新后的board.json
      // if (isChanged) {
      //   await this.setBoardJson(currentBoardJson);
      //   this.currentStm32pinConfig = pinConfig;
      // }
      return false;
    }
  }

  // 根据传入的引脚信息解析引脚配置 如STM32F1xx/F100C(4-6)T
  async getVariantConfig(variant: string, variant_h: string) {
    try {
      const sdkPath = await this.getSdkPath();
      if (!sdkPath) {
        throw new Error('未找到 SDK 路径');
      }

      const variantFilePath = `${sdkPath}/variants/${variant}/${variant_h}`;
      // console.log('variantFilePath:', variantFilePath);
      if (!window['fs'].existsSync(variantFilePath)) {
        throw new Error('引脚配置文件不存在: ' + variantFilePath);
      }

      const variantContent = window['fs'].readFileSync(variantFilePath, 'utf8');

      return this.parseVariantConfig(variantContent);
    } catch (error) {
      console.error('解析STM32引脚配置失败:', error);
    }
  }

  private parseVariantConfig(content: string): any {
    const analogPins: any[] = [];
    const digitalPins: any[] = [];
    const i2cPins: any = { Wire: [] };
    const spiPins: any = { SPI: [] };

    const lines = content.split(/\r?\n/);
    const digitalSet = new Set<string>();
    const i2cMap: any = {};
    const spiMap: any = {};

    // 宽松匹配多种 define 写法：PA0 PIN_A0 或 PIN_A0 PA0 等
    const analogRe1 = /^\s*#\s*define\s+([A-Z]{1,3}\d{1,3})\s+(PIN_A\d+)\b/; // PA0  PIN_A0
    const analogRe2 = /^\s*#\s*define\s+(PIN_A\d+)\s+([A-Z]{1,3}\d{1,3})\b/; // PIN_A0 PA0

    const digitalRe1 = /^\s*#\s*define\s+([A-Z]{1,3}\d{1,3})\s+(\d+|PIN_A\d+)\b/; // PA1  1  或 PA1 PIN_A0
    const digitalRe2 = /^\s*#\s*define\s+(PIN_[A-Z0-9_]+)\s+(\d+|[A-Z]{1,3}\d{1,3})\b/; // PIN_LED 13 或 PIN_A0 PA0

    const i2cRe = /^\s*#\s*define\s+PIN_WIRE_(SDA|SCL)\s+([A-Z]{1,3}\d{1,3})\b/;
    const i2cReAlt = /^\s*#\s*define\s+([A-Z]{1,3}\d{1,3})\s+PIN_WIRE_(SDA|SCL)\b/;

    const spiRe = /^\s*#\s*define\s+PIN_SPI_(SS\d*|MOSI|MISO|SCK)\s+([A-Z]{1,3}\d{1,3})\b/;
    const spiReAlt = /^\s*#\s*define\s+([A-Z]{1,3}\d{1,3})\s+PIN_SPI_(SS\d*|MOSI|MISO|SCK)\b/;

    for (const line of lines) {
      // 去掉行尾注释
      const pureLine = line.replace(/\/\/.*$/, '').replace(/\/\*.*\*\/\s*$/, '');

      // analog
      let m = analogRe1.exec(pureLine) || analogRe2.exec(pureLine);
      if (m) {
        // 统一为 [pinMacro, port]，优先保留 PIN_Ax 做第一个元素以兼容 gen_boards 输出
        if (m[1].startsWith('PIN_A')) {
          analogPins.push([m[1], m[2]]);
        } else {
          analogPins.push([m[2], m[1]]);
        }
      }

      // digital
      m = digitalRe1.exec(pureLine) || digitalRe2.exec(pureLine);
      if (m) {
        // m[1] 是名字或 PIN_ 前缀，根据捕获组位置不同处理
        let name = m[1];
        let val = m[2];
        // 如果捕获到 PIN_* 在第一位（digitalRe2），将 name 与 val 调换以保持一致
        if (name.startsWith('PIN_')) {
          // 如果包含SPI WIRE SERIAL等关键字，则跳过
          if (name.includes('PIN_SPI_') || name.includes('PIN_WIRE_') || name.includes('PIN_SERIAL_')) {
            continue;
          }
          // 保证唯一性，使用宏名或引脚名作为标识
          const display = name;
          if (!digitalSet.has(display)) {
            digitalSet.add(display);
            digitalPins.push([display, display]);
          }
        } else {
          const display = name;
          if (!digitalSet.has(display)) {
            digitalSet.add(display);
            digitalPins.push([display, display]);
          }
        }
      }

      // i2c
      m = i2cRe.exec(pureLine);
      if (m) {
        i2cMap[m[1]] = m[2];
      } else {
        m = i2cReAlt.exec(pureLine);
        if (m) {
          i2cMap[m[2]] = m[1]; // alt captures port then PIN_WIRE_x
        }
      }

      // spi
      m = spiRe.exec(pureLine);
      if (m) {
        let key = m[1];
        if (key.startsWith('SS')) key = 'SS';
        spiMap[key] = m[2];
      } else {
        m = spiReAlt.exec(pureLine);
        if (m) {
          let key = m[2];
          if (key.startsWith('SS')) key = 'SS';
          spiMap[key] = m[1];
        }
      }
    }

    // i2c 输出顺序 SDA, SCL
    if (i2cMap['SDA']) i2cPins.Wire.push(['SDA', i2cMap['SDA']]);
    if (i2cMap['SCL']) i2cPins.Wire.push(['SCL', i2cMap['SCL']]);

    // SPI 输出固定顺序 MOSI, MISO, SCK, SS
    const spiOrder = ['MOSI', 'MISO', 'SCK', 'SS'];
    for (const k of spiOrder) {
      if (spiMap[k]) spiPins.SPI.push([k, spiMap[k]]);
    }

    // 结果格式与 gen_boards.js 相同
    return {
      analogPins,
      digitalPins,
      pwmPins: digitalPins,
      servoPins: digitalPins,
      interruptPins: digitalPins,
      i2cPins,
      spiPins
    };
  }

  private parseGenericConfig(config: string): string {
    // 匹配 GENERIC_F100C4TX、GENERIC_F103CB、GENERIC_F407VG 等格式
    // 识别后 输出F1XXC、F4XXV等格式
    // const match = config.match(/GENERIC_([A-Z])(\d{1,2})\d*[A-Z]?([A-Z])/i);
    // const match = config.match(/GENERIC_([A-Z])(\d?)\d*[A-Z]?([A-Z])/i);
    const match = config.match(/GENERIC_([A-Z])(\d)\d*([A-Z])/i);
    if (match) {
      // match[1] 提取主系列（如 F）
      // match[2] 提取数字部分（如 1、4、7、0）
      // match[3] 提取主型号字母（如 C、V、Z、F）
      return `${match[1]}${match[2]}XX${match[3]}`.toUpperCase();
    }
    console.warn('无法解析 GENERIC 配置:', config);
    return config; // 如果无法解析，返回原始字符串
  }

  // 获取项目配置
  async getProjectConfig() {
    try {
      const packageJson = await this.getPackageJson();
      if (!packageJson || !packageJson.projectConfig) {
        return {};
      }

      return packageJson.projectConfig;
    } catch (error) {
      console.info('获取项目配置失败:', error);
      return {}
    }
  }

  async changeBoard(boardInfo: {
    name: string;
    version: string;
    mode?: string[];
    selectedFramework?: string;
  }) {
    this.isBoardSwitchInProgress = true;
    let reloadPromise: Promise<void> | null = null;
    try {
      const separator = this.platformService.getPlatformSeparator();
      if (!this.currentProjectPath) {
        throw new Error('当前项目路径未设置');
      }
      const currentPackageJson = await this.getPackageJson();
      const currentProjectMode = normalizeProjectMode(currentPackageJson) || 'arduino';
      const isAilyCode = this.isAilyCodeProject();
      const requestedBoardInfo = {
        ...boardInfo,
        name: this.normalizeAilyBoardPackageName(boardInfo.name),
      };
      let normalizedBoardInfo = requestedBoardInfo;
      if (!isAilyCode) {
        const catalogBoard = this.configService.boardDict[requestedBoardInfo.name];
        if (!catalogBoard) {
          throw new Error(`开发板 ${requestedBoardInfo.name} 不在当前开发板目录中`);
        }
        normalizedBoardInfo = { ...catalogBoard, ...requestedBoardInfo };
        if (!isBoardCompatibleWithProjectMode(normalizedBoardInfo, currentPackageJson)) {
          throw new Error(
            `当前 ${currentProjectMode} 项目不能切换到其他开发模式的开发板`,
          );
        }
      }
      // 0. 保存当前项目
      await this.save();
      this.message.loading(this.translate.instant('PROJECT.SWITCHING_BOARD'), { nzDuration: 5000 });

      // 记录开发板使用次数
      this.configService.recordBoardUsage(normalizedBoardInfo.name);
      const currentBoardModule = await this.getBoardModule();

      // 1. npm install 安装boardInfo.name@boardInfo.version 到 appDataPath（与 projectNew 一致）
      const appDataPath = window['path'].getAppDataPath();
      const newBoardPackage = this.buildNpmPackageSpec(normalizedBoardInfo.name, normalizedBoardInfo.version);
      // 切板先按目标 boards.json.mode 选择仓库，不能继续沿用旧项目的 devmode。
      const boardRegistry = this.configService.getNpmRegistryForBoard(normalizedBoardInfo);
      console.log('安装新开发板模块:', newBoardPackage);
      this.application.updateFooterState({ state: 'doing', text: this.translate.instant('PROJECT.INSTALLING_NEW_BOARD') });
      const appDataInstallCommand = await this.buildNpmInstallCommand(newBoardPackage, {
        prefixPath: appDataPath,
        registry: boardRegistry,
      });
      await this.appDataResourceLock.runExclusive(`project:switch-board:install-appdata:${newBoardPackage}`, () =>
        this.cmdService.runAsyncChecked(appDataInstallCommand)
      );

      // 2. 预安装到当前项目的 node_modules，但不写 package.json；最终 package.json 变更交给 watcher 处理。
      await this.cmdService.runAsyncChecked(
        await this.buildNpmInstallCommand(newBoardPackage, { noSave: true, registry: boardRegistry }),
        this.currentProjectPath,
      );

      // 3. 获取新开发板的模板并更新package.json
      console.log('更新项目配置文件...');
      this.application.updateFooterState({ state: 'doing', text: this.translate.instant('PROJECT.UPDATING_PROJECT_CONFIG') });

      // 读取当前package.json保留项目基本信息
      // 两种工程共用主板源，仅模板目录不同。
      const boardPackagePath = window['path'].join(
        appDataPath,
        'node_modules',
        normalizedBoardInfo.name,
      );
      const templatePath = isAilyCode
        ? resolveCoderTemplatePath(boardPackagePath, window['path'])
        : window['path'].join(boardPackagePath, 'template');
      const templatePackageJsonPath = `${templatePath}${separator}package.json`;
      const templateSourcePath = `${templatePath}${separator}project.aci`;

      if (window['fs'].existsSync(templatePackageJsonPath)
        && (!isAilyCode || window['fs'].existsSync(templateSourcePath))) {
        // 读取模板package.json
        const templatePackageJson = JSON.parse(window['fs'].readFileSync(templatePackageJsonPath, 'utf8'));

        // 合并配置：保留当前项目的基本信息，使用新开发板的依赖和配置
        // Blockly 切板保留当前 devmode；Aily Code 继续使用 Arduino 模板语义。
        const newPackageJson: Record<string, unknown> = {
          ...templatePackageJson,
          name: currentPackageJson.name, // 保留项目名称
          nickname: currentPackageJson.nickname, // 保留昵称
          author: currentPackageJson.author, // 保留作者
          description: currentPackageJson.description, // 保留描述
          ...(currentPackageJson.cloudId && { cloudId: currentPackageJson.cloudId }), // 保留云端项目ID
          // 不保留其他自定义配置
          // ...(currentPackageJson.projectConfig && { projectConfig: currentPackageJson.projectConfig }),
        };

        if (isAilyCode) {
          // template_arduino 决定基础库；用户自装库继续保留，源码不随开发板切换被覆盖。
          this.applyAilyCodeBoardToPackageManifest(newPackageJson, normalizedBoardInfo, currentPackageJson);
          applyCoderProjectPackageConfig(
            newPackageJson,
            normalizedBoardInfo.name,
            this.normalizeAilyCodeBoardDepRange(normalizedBoardInfo.version),
            currentPackageJson,
          );
        } else {
          // 同模式切板只替换板包和模板配置，不改变当前项目的开发模式。
          newPackageJson['devmode'] = currentProjectMode;
          newPackageJson['dependencies'] = {
            // 从模板获取新的开发板依赖和基础库
            ...templatePackageJson.dependencies,
            ...Object.fromEntries(
              Object.entries(currentPackageJson.dependencies || {})
                .filter(([key]) => !isAilyBoardPackageName(key)),
            ),
          };
        }

        // 写入新的package.json
        const shouldUsePackageJsonWatcher = this.isPackageJsonBoardWatcherActive;
        reloadPromise = shouldUsePackageJsonWatcher ? this.waitForBoardSwitchReload() : null;
        this.isBoardSwitchInProgress = false;
        window['fs'].writeFileSync(`${this.currentProjectPath}/package.json`, JSON.stringify(newPackageJson, null, 2));
        console.log('package.json 更新完成');

        if (!shouldUsePackageJsonWatcher) {
          await this.finishBoardSwitchWithoutPackageWatcher(currentBoardModule, normalizedBoardInfo.name);
        }
      } else {
        throw new Error(isAilyCode
          ? '未找到新开发板的 template_arduino/package.json 或 project.aci，无法更新 Coder 项目配置'
          : '未找到新开发板的 template/package.json，无法更新项目配置');
      }

      if (reloadPromise) {
        await reloadPromise;
      }

      this.application.updateFooterState({ state: 'done', text: this.translate.instant('PROJECT.BOARD_SWITCH_COMPLETE') });
      this.message.success(this.translate.instant('PROJECT.BOARD_SWITCH_SUCCESS'), { nzDuration: 3000 });
    } catch (error) {
      this.rejectBoardSwitchReload(error);
      console.error('切换开发板失败:', error);
      this.message.error(this.translate.instant('PROJECT.BOARD_SWITCH_FAILED') + error.message);
      throw error;
    } finally {
      this.isBoardSwitchInProgress = false;
    }
  }

  /** 等待 Blockly 编辑器的 package.json watcher 完成开发板切换后的项目重载。 */
  waitForBoardSwitchReload(timeoutMs = 180000): Promise<void> {
    this.rejectBoardSwitchReload(new Error('新的开发板切换请求已开始'));

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.rejectBoardSwitchReload(new Error('等待开发板切换重载超时'));
      }, timeoutMs);

      this.boardSwitchReloadWaiter = { resolve, reject, timer };
    });
  }

  /** 通知等待中的 changeBoard：watcher 驱动的项目重载已完成。 */
  resolveBoardSwitchReload(): void {
    const waiter = this.boardSwitchReloadWaiter;
    if (!waiter) {
      return;
    }

    clearTimeout(waiter.timer);
    this.boardSwitchReloadWaiter = null;
    waiter.resolve();
  }

  /** 通知等待中的 changeBoard：watcher 驱动的项目重载失败或被新的切换请求取代。 */
  rejectBoardSwitchReload(error: any): void {
    const waiter = this.boardSwitchReloadWaiter;
    if (!waiter) {
      return;
    }

    clearTimeout(waiter.timer);
    this.boardSwitchReloadWaiter = null;
    waiter.reject(error);
  }

  /**
   * Aily Code：切换开发板后重装工程与模板声明的依赖（与打开新 Coder 工程一致）。
   */
  private async reinstallAilyCodeDepsAfterBoardSwitch(): Promise<void> {
    const projectPath = this.currentProjectPath;
    if (!projectPath || !this.isAilyCodeProject()) {
      return;
    }
    const ok = await this.application.reinstallAilyCodeDependencies(projectPath);
    if (!ok) {
      throw new Error(this.translate.instant('NPM.BOARD_DEPS_INSTALL_FAILED'));
    }
  }

  /** package.json watcher 不活跃时，使用原流程完成旧开发板卸载、temp 同步和项目重载。 */
  private async finishBoardSwitchWithoutPackageWatcher(currentBoardModule: string | undefined, nextBoardModule: string): Promise<void> {
    if (currentBoardModule && currentBoardModule !== nextBoardModule) {
      console.log('卸载当前开发板模块:', currentBoardModule);
      this.application.updateFooterState({ state: 'doing', text: this.translate.instant('PROJECT.UNINSTALLING_CURRENT_BOARD') });
      await this.cmdService.runAsyncChecked(`npm uninstall ${currentBoardModule}`, this.currentProjectPath);
    }

    await this.copyPackageJsonToTemp(this.currentProjectPath);

    if (this.isAilyCodeProject()) {
      await this.reinstallAilyCodeDepsAfterBoardSwitch();
    }

    console.log('重新加载项目...');
    await this.projectOpen(this.currentProjectPath);
    this.boardChangeSubject.next();
  }

  generateUniqueProjectName(prjPath, prefix = 'project_'): string {
    const baseDateStr = generateDateString();
    prefix = prefix + baseDateStr;
    const pt = this.platformService.getPlatformSeparator();

    // 尝试使用字母后缀 a-z
    for (let charCode = 97; charCode <= 122; charCode++) {
      const suffix = String.fromCharCode(charCode);
      const projectName: string = prefix + suffix;
      const projectPath = prjPath + pt + projectName;

      if (!window['path'].isExists(projectPath)) {
        return projectName;
      }
    }

    // 如果所有字母都已使用，则使用数字后缀
    let numberSuffix = 0;
    while (true) {
      const projectName = prefix + 'a' + numberSuffix;
      const projectPath = prjPath + pt + projectName;

      if (!window['path'].isExists(projectPath)) {
        return projectName;
      }

      numberSuffix++;

      // 安全检查，防止无限循环
      if (numberSuffix > 1000) {
        return prefix + 'a' + Date.now(); // 极端情况下使用时间戳
      }
    }
  }

  /** 获取当前项目的构建路径。 */
  async getBuildPath(): Promise<string> {
    if (this.currentProjectPath) {
      return window['path'].join(this.currentProjectPath, '.build');
    }
    return '';
  }
}
