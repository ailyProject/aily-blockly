import { Injectable, Injector } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';
import { UiService } from './ui.service';
import { ElectronService } from './electron.service';
import { NzMessageService } from 'ng-zorro-antd/message';
import { pinyin } from "pinyin-pro";
import { Router } from '@angular/router';
import { CmdService } from './cmd.service';
import { CrossPlatformCmdService } from './cross-platform-cmd.service';
import { generateDateString } from '../func/func';
import { ConfigService } from './config.service';
import { ESP32_CONFIG_MENU } from '../configs/esp32.config';
import { STM32_CONFIG_MENU } from '../configs/stm32.config';
import { NRF5_CONFIG_MENU } from '../configs/nrf5.config';
import { ActionService } from './action.service';
import { PlatformService } from './platform.service';
import type { NewProjectData } from '../types/project-new';
import { WorkflowService } from './workflow.service';
import { TranslateService } from '@ngx-translate/core';
import { NoticeService } from './notice.service';
import { NzModalRef, NzModalService } from 'ng-zorro-antd/modal';
import { AppDataResourceLockService } from './appdata-resource-lock.service';
import { ChatService } from '../tools/aily-chat/services/chat.service';
import {
  readPlatformRefFromProjectAci,
  resolveEffectiveBoardDependencies,
} from '../utils/platform-runtime.utils';
import {
  resolveCoderFrameworkOption,
  resolveDefaultCoderFramework,
} from '../utils/coder-board.mapper';
import { applyCdcSerialPortOverrides } from '../editors/blockly-editor/components/blockly/abf';

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

export type ProjectActivationReason = 'new' | 'open' | 'reload' | 'chat-tool-create';

export interface ProjectActivationEvent {
  path: string;
  previousPath: string;
  reason: ProjectActivationReason;
}

interface ProjectOpenOptions {
  reason?: ProjectActivationReason;
}

interface ProjectCreationOptions {
  activationReason?: ProjectActivationReason;
}

interface ProjectCloseOptions {
  activationReason?: ProjectActivationReason;
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
  private projectOpenTask: { path: string; promise: Promise<void> } | null = null;

  currentPackageData: ProjectPackageData = {
    name: 'aily blockly',
  };

  projectRootPath: string;
  private projectRootPathInitPromise: Promise<void> | null = null;

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


  /** 当前工程是否为 Aily Code（根目录含 project.aci） */
  isAilyCodeProject(projectPath = this.currentProjectPath): boolean {
    if (!projectPath) {
      return false;
    }
    return window['path'].isExists(window['path'].join(projectPath, 'project.aci'));
  }

  /** 与 AilyCodeProjectService.normalizeNpmDepRange 一致 */
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
        if (key.startsWith('@aily-project/board-') || key.startsWith('@aily-project/coder-')) {
          return false;
        }
        if (key.startsWith('@aily-project/lib-core-')) {
          return false;
        }
        return true;
      }),
    );
  }

  /**
   * Aily Code 切换开发板：dependencies / boardDependencies 仅声明主板 npm 包（+ 用户自装非 core 库），
   * 不合并 Blockly 模板里的 lib-core-*，避免偶发多装基础库。
   */
  private applyAilyCodeBoardToPackageManifest(
    packageJson: Record<string, unknown>,
    boardInfo: { name: string; version: string },
    currentPackageJson?: { dependencies?: Record<string, string> },
  ): void {
    const boardRange = this.normalizeAilyCodeBoardDepRange(boardInfo.version);
    const preserved = this.filterAilyCodeUserPreservedDeps(currentPackageJson?.dependencies);

    packageJson['dependencies'] = {
      ...preserved,
      [boardInfo.name]: boardRange,
    };
    packageJson['boardDependencies'] = {
      [boardInfo.name]: boardRange,
    };
  }

  currentBoardConfig: any;
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
  // STM32选择开发板时定义引脚使用
  currentStm32Config: { board: any, variant: any, variant_h: any } = { board: null, variant: null, variant_h: null };

  constructor(
    private uiService: UiService,
    private electronService: ElectronService,
    private cmdService: CmdService,
    private crossPlatformCmdService: CrossPlatformCmdService,
    private configService: ConfigService,
    private actionService: ActionService,
    private platformService: PlatformService,
    private workflowService: WorkflowService,
    private translate: TranslateService,
    private noticeService: NoticeService,
    private appDataResourceLock: AppDataResourceLockService,
    private chatService: ChatService,
    private injector: Injector,
  ) {
  }

  private hasBlockingChatRequest(): boolean {
    return this.chatService?.isWaiting === true;
  }

  private shouldBlockForChatRequest(reason?: ProjectActivationReason): boolean {
    return reason !== 'chat-tool-create' && this.hasBlockingChatRequest();
  }

  private warnBlockingChatRequest(): void {
    this.message.warning('AI 对话正在处理中，请先停止当前请求后再切换或关闭项目。');
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
      window['ipcRenderer'].on('window-receive', async (event, message) => {
        // console.log('window-receive', message);
        if (message.data.action == 'open-project') {
          this.projectOpen(message.data.path, { reason: this.parseProjectActivationReason(message.data.reason) });
        } else {
          return;
        }
        // 反馈完成结果
        if (message.messageId) {
          window['ipcRenderer'].send('main-window-response', {
            messageId: message.messageId,
            result: "success"
          });
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
    this.projectRootPath = rawAilyProjectPath.replace('%HOMEPATH%\\Documents\\', window['path'].getUserDocuments() + this.platformService.getPlatformSeparator());
  }

  // 检测字符串是否包含中文字符
  containsChineseCharacters(str: string): boolean {
    const chineseRegex = /[\u4e00-\u9fa5]/;
    return chineseRegex.test(str);
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
    return reason === 'new' || reason === 'open' || reason === 'reload' || reason === 'chat-tool-create'
      ? reason
      : undefined;
  }

  private updateNewProjectPackageJson(
    projectPath: string,
    newProjectData: NewProjectData,
    options?: { removeCloudId?: boolean }
  ) {
    const inputName = String(newProjectData.name ?? '').trim();
    const packageJson = JSON.parse(window['fs'].readFileSync(`${projectPath}/package.json`));
      if (this.containsChineseCharacters(inputName)) {
        packageJson.name = pinyin(inputName, {
          toneType: "none",
          separator: ""
        }).replace(/\s/g, '_');
        packageJson.nickname = inputName;
      } else {
        packageJson.name = inputName;
        packageJson.nickname = packageJson.name;
      }
      // 设置开发框架
      packageJson.devmode = newProjectData.devmode;

      window['fs'].writeFileSync(`${projectPath}/package.json`, JSON.stringify(packageJson, null, 2));
  }

  private async finishProjectCreation(projectPath: string, options: ProjectCreationOptions = {}): Promise<boolean> {
    this.uiService.updateFooterState({ state: 'done', text: this.translate.instant('PROJECT.PROJECT_CREATED') });
    await window['iWindow'].send({
      to: 'main',
      data: { action: 'open-project', path: projectPath, reason: options.activationReason || 'new' }
    });
    return true;
  }

  // 新建项目
  async projectNew(newProjectData: NewProjectData, options: ProjectCreationOptions = {}): Promise<boolean> {
    try {
      const separator = this.platformService.getPlatformSeparator();
      // console.log('newProjectData: ', newProjectData);
      const appDataPath = window['path'].getAppDataPath();
      const projectPath = this.buildProjectPath(newProjectData);
      const boardPackage = newProjectData.board.name + '@' + newProjectData.board.version;

      this.uiService.updateFooterState({ state: 'doing', text: this.translate.instant('PROJECT.CREATING_PROJECT') });
      const npmInstallResult = await this.appDataResourceLock.runExclusive(`project:new:install-board:${boardPackage}`, () =>
        this.cmdService.runAsync(`npm install ${boardPackage} --prefix "${appDataPath}"`)
      );
      if (npmInstallResult.code !== 0) {
        throw new Error(npmInstallResult.stderr || npmInstallResult.stdout || `npm install failed with exit code ${npmInstallResult.code}`);
      }
      // const templatePath = `${appDataPath}${separator}node_modules${separator}${newProjectData.board.name}${separator}template`;
      const templatePath = window['path'].join(appDataPath, 'node_modules', newProjectData.board.name, 'template');
      if (!window['fs'].existsSync(templatePath)) {
        throw new Error(`板卡模板目录不存在，可能是板卡包安装失败或模板缺失: ${templatePath}`);
      }
      // 创建项目目录
      await this.crossPlatformCmdService.createDirectory(projectPath, true);
      // 复制模板文件到项目目录
      await this.crossPlatformCmdService.copyItem(`${templatePath}${separator}*`, projectPath, true, true);

      this.updateNewProjectPackageJson(projectPath, newProjectData);
      return await this.finishProjectCreation(projectPath, options);

      // if (closeWindow) {
      //   this.uiService.closeWindow();
      // }
    } catch (error) {
      this.message.error(this.translate.instant('PROJECT.CREATE_FAILED') + ": " + error.message);
      this.uiService.updateFooterState({ state: 'error', text: this.translate.instant('PROJECT.CREATE_FAILED') });
      return false;
    }
  }

  async projectNewFromTemplate(newProjectData: NewProjectData, templatePath: string, options: ProjectCreationOptions = {}): Promise<boolean> {
    try {
      const separator = this.platformService.getPlatformSeparator();
      const projectPath = this.buildProjectPath(newProjectData);

      this.uiService.updateFooterState({ state: 'doing', text: this.translate.instant('PROJECT.CREATING_PROJECT') });
      await this.crossPlatformCmdService.createDirectory(projectPath, true);
      await this.crossPlatformCmdService.copyItem(`${templatePath}${separator}*`, projectPath, true, true);

      this.updateNewProjectPackageJson(projectPath, newProjectData, { removeCloudId: true });
      return await this.finishProjectCreation(projectPath, options);
    } catch (error) {
      this.message.error(this.translate.instant('PROJECT.CREATE_FAILED') + ": " + error.message);
      this.uiService.updateFooterState({ state: 'error', text: this.translate.instant('PROJECT.CREATE_FAILED') });
      return false;
    }
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
      await promise;
    } finally {
      if (this.projectOpenTask?.promise === promise) {
        this.projectOpenTask = null;
      }
    }
  }

  private async projectOpenInternal(projectPath = this.currentProjectPath, options: ProjectOpenOptions = {}): Promise<any> {
    const previousProjectPath = this.currentProjectPath;
    const activationReason = options.reason || (this.isSameProjectPath(previousProjectPath, projectPath) ? 'reload' : 'open');

    if (this.shouldBlockForChatRequest(activationReason)) {
      this.warnBlockingChatRequest();
      return false;
    }

    const closeResult = await this.close({ activationReason });
    if (closeResult === false) {
      return false;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
    // 判断路径是否存在
    if (!this.electronService.exists(projectPath)) {
      this.removeRecentlyProject({ path: projectPath })
      this.message.error(this.translate.instant('PROJECT.PATH_NOT_EXIST'));
      return;
    }

    if (this.electronService.isElectron && window['projectLock']) {
      let r = await window['projectLock'].tryAcquire(projectPath);
      if (!r.ok && r.conflict && r.holder) {
        const action = await this.promptProjectLockConflict(r.holder);
        if (action === 'cancel') {
          this.stateSubject.next('default');
          return;
        }
        if (action === 'focus') {
          await window['projectLock'].focusProcess(r.holder.pid);
          this.stateSubject.next('default');
          return;
        }
        r = await window['projectLock'].tryAcquire(projectPath, { force: true });
        if (!r.ok) {
          this.message.error(this.translate.instant('PROJECT.LOCK_ACQUIRE_FAILED'));
          this.stateSubject.next('default');
          return;
        }
      } else if (!r.ok) {
        this.message.error(this.translate.instant('PROJECT.LOCK_ACQUIRE_FAILED'));
        this.stateSubject.next('default');
        return;
      }
    }

    this.stateSubject.next('loading');

    // 更新当前项目路径和包数据
    this.currentProjectPath = projectPath;
    void window['ipcRenderer']?.invoke?.('logger-set-project-path', projectPath).catch(() => undefined);
    this.projectActivationSubject.next({
      path: projectPath,
      previousPath: previousProjectPath,
      reason: activationReason,
    });

    const abiIsExist = window['path'].isExists(projectPath + '/project.abi');
    if (abiIsExist) {
      // 打开blockly编辑器
      await this.router.navigate(['/main/blockly-editor'], {
        queryParams: {
          path: projectPath
        },
        replaceUrl: true
      });
    } else {
      // 打开代码编辑器
      await this.router.navigate(['/main/code-editor-pro'], {
        queryParams: {
          path: projectPath
        },
        replaceUrl: true
      });
    }

    await this.waitForProjectOpenCompletion(projectPath);
  }

  private waitForProjectOpenCompletion(projectPath: string): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      let subscription: { unsubscribe: () => void } | null = null;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutId);
        subscription?.unsubscribe();
        resolve();
      };
      const timeoutId = setTimeout(() => {
        finish();
        console.warn('[ProjectService] project open completion timed out:', projectPath);
      }, 60000);

      subscription = this.stateSubject.subscribe((state) => {
        if (state !== 'loaded' && state !== 'error') {
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
  save(path = this.currentProjectPath) {
    if (this.isProjectOpening) {
      return Promise.resolve({
        success: false,
        error: 'project is loading',
        path,
      });
    }

    return new Promise<{ success: boolean; error?: string; path?: string }>((resolve) => {
      this.stateSubject.next('saving');
      this.actionService.dispatch('project-save', { path }, async result => {
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


  saveAs(path) {
    //在当前路径下创建一个新的目录
    path = path.replace(/\s/g, '_');
    window['fs'].mkdirSync(path);
    // 复制项目目录到新路径
    window['fs'].copySync(this.currentProjectPath, path);
    // 修改package.json文件
    this.save(path);
    // 修改package.json文件
    const packageJson = JSON.parse(window['fs'].readFileSync(`${path}/package.json`));
    // 另存为时去掉cloudId
    if (packageJson.cloudId) {
      delete packageJson.cloudId;
    }
    // 获取新的项目名称（文件夹名）
    let name = window['path'].basename(path);
    if (this.containsChineseCharacters(name)) {
      packageJson.name = pinyin(name, {
        toneType: "none",
        separator: ""
      }).replace(/\s/g, '_');
      packageJson.nickname = name;
    } else {
      packageJson.name = name;
      packageJson.nickname = name;
    }
    window['fs'].writeFileSync(`${path}/package.json`, JSON.stringify(packageJson, null, 2));
    // 修改当前项目路径
    this.currentProjectPath = path;
    this.currentPackageData = packageJson;
    this.addRecentlyProject({ name: this.currentPackageData.name, path: path, nickname: this.currentPackageData.nickname || this.currentPackageData.name });
  }

  async close(options: ProjectCloseOptions = {}) {
    if (this.shouldBlockForChatRequest(options.activationReason)) {
      this.warnBlockingChatRequest();
      return false;
    }

    if (this.electronService.isElectron && this.currentProjectPath && window['projectLock']) {
      try {
        await window['projectLock'].release(this.currentProjectPath);
      } catch (e) {
        console.warn('project-lock release:', e);
      }
    }
    this.currentProjectPath = '';
    void window['ipcRenderer']?.invoke?.('logger-set-project-path', '').catch(() => undefined);
    this.currentPackageData = {
      name: 'aily blockly',
    };
    this.stateSubject.next('default');
    this.uiService.closeTerminal();
    // this.currentProjectPath = (await window['env'].get("AILY_PROJECT_PATH")).replace('%HOMEPATH%\\Documents', window['path'].getUserDocuments());
    this.router.navigate(['/main/guide'], { replaceUrl: true });
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

  // 通过ConfigService存储最近打开的项目
  get recentlyProjects(): any[] {
    return this.configService.data?.recentlyProjects || [];
  }

  set recentlyProjects(data) {
    this.configService.data.recentlyProjects = data;
    this.configService.save();
  }

  addRecentlyProject(data: { name: string, path: string, nickname?: string }) {
    let temp: any[] = this.recentlyProjects
    temp.unshift(data);
    temp = temp.filter((item, index) => {
      return temp.findIndex((item2) => item2.path === item.path) === index;
    });
    if (temp.length > 6) {
      temp.pop();
    }
    this.recentlyProjects = temp;
  }

  removeRecentlyProject(data: { path: string }) {
    let temp: any[] = this.recentlyProjects
    temp = temp.filter((item) => {
      return item.path !== data.path;
    });
    this.recentlyProjects = temp;
  }

  // 检查项目是否未保存
  async hasUnsavedChanges(): Promise<boolean> {
    // 如果项目尚未加载，则没有未保存的更改
    if (this.stateSubject.value === 'default' || !this.currentProjectPath) {
      return false;
    }

    return new Promise((resolve) => {
      this.actionService.dispatch('project-check-unsaved', {}, (result) => {
        console.log(result);
        resolve(result.data.hasUnsavedChanges);
      });
    });
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
   */
  async syncPackageJsonWithTemp(projectPath: string): Promise<void> {
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
      // 覆盖后扫描 node_modules 删除未声明的依赖包（避免 npm prune 冷启动慢）
      this.pruneUndeclaredDeps(projectPath);
    } else {
      // temp 下无 package.json，从主项目复制到 temp
      await this.copyPackageJsonToTemp(projectPath);
    }
  }

  /**
   * 项目保存时复制主项目 package.json 到 temp 下（Blockly / Aily Code 共用）
   */
  async copyPackageJsonToTemp(projectPath: string): Promise<void> {
    const mainPackagePath = window['path'].join(projectPath, 'package.json');
    const tempDir = window['path'].join(projectPath, '.temp');
    const tempPackagePath = window['path'].join(tempDir, 'package.json');
    if (!window['fs'].existsSync(mainPackagePath)) {
      return;
    }
    try {
      if (!window['fs'].existsSync(tempDir)) {
        window['fs'].mkdirSync(tempDir, { recursive: true });
      }
      const mainContent = window['fs'].readFileSync(mainPackagePath, 'utf8');
      window['fs'].writeFileSync(tempPackagePath, mainContent);
    } catch (error) {
      console.warn('复制 package.json 到 temp 失败:', error);
    }
  }

  /**
   * 扫描 node_modules 删除未在 package.json 中声明的依赖包（仅第一层）
   * 参考 NpmService.installedOk 实现，避免 npm prune 冷启动慢
   */
  private pruneUndeclaredDeps(projectPath: string): void {
    try {
      const packageJsonPath = window['path'].join(projectPath, 'package.json');
      const nodeModulesPath = window['path'].join(projectPath, 'node_modules');

      if (!window['path'].isExists(packageJsonPath) || !window['path'].isExists(nodeModulesPath)) {
        return;
      }

      const packageJson = JSON.parse(window['fs'].readFileSync(packageJsonPath, 'utf8'));
      const deps = { ...(packageJson.dependencies || {}), ...(packageJson.devDependencies || {}) };
      const declaredNames = new Set(Object.keys(deps));

      const dirs = window['fs'].readDirSync(nodeModulesPath);
      const toRemove: string[] = [];

      for (const dir of dirs) {
        const dirName = dir.name ?? dir;
        if (typeof dirName !== 'string' || dirName.startsWith('.')) {
          continue;
        }

        const dirPath = window['path'].join(nodeModulesPath, dirName);
        if (!window['fs'].isDirectory(dirPath)) {
          continue;
        }

        if (dirName.startsWith('@')) {
          const scopeDirs = window['fs'].readDirSync(dirPath);
          for (const scopeDir of scopeDirs) {
            const scopeDirName = scopeDir.name ?? scopeDir;
            if (typeof scopeDirName !== 'string' || scopeDirName.startsWith('.')) {
              continue;
            }
            const packageName = `${dirName}/${scopeDirName}`;
            if (!declaredNames.has(packageName)) {
              toRemove.push(window['path'].join(dirPath, scopeDirName));
            }
          }
        } else {
          if (!declaredNames.has(dirName)) {
            toRemove.push(dirPath);
          }
        }
      }

      for (const removePath of toRemove) {
        try {
          window['fs'].rmSync(removePath, { recursive: true, force: true });
          console.log('[pruneUndeclaredDeps] 已删除未声明依赖:', window['path'].basename(removePath));
        } catch (err) {
          console.warn('[pruneUndeclaredDeps] 删除失败:', removePath, err);
        }
      }
    } catch (err) {
      console.warn('[pruneUndeclaredDeps] 执行异常:', err);
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
      deps.find((dep) => dep.startsWith('@aily-project/board-'))
      ?? deps.find((dep) => dep.startsWith('@aily-project/coder-'));
    if (fromDeps) {
      return fromDeps;
    }
    const boardDeps = Object.keys(prjPackageJson.boardDependencies || {});
    const fromBoardDeps =
      boardDeps.find((dep) => dep.startsWith('@aily-project/board-'))
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
          if (board.startsWith('@aily-project/')) {
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
      const platformRef = readPlatformRefFromProjectAci(this.currentProjectPath);
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
    applyCdcSerialPortOverrides(resolvedBoardJson, cdcEnabled);
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
    this.uiService.updateFooterState({ state: 'done', text: this.translate.instant('PROJECT.BOARD_SWITCH_COMPLETE') });
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

  // // 解析boards.txt并获取配置信息
  // async getBoardConfig(boardName: string, boardType: string) {

  // 解析boards.txt并获取ESP32配置信息
  async getEsp32BoardConfig(boardName: string) {
    try {
      const sdkPath = await this.getSdkPath();
      if (!sdkPath) {
        throw new Error('未找到 SDK 路径');
      }

      const boardsFilePath = `${sdkPath}/boards.txt`;
      if (!window['fs'].existsSync(boardsFilePath)) {
        throw new Error('boards.txt 文件不存在: ' + boardsFilePath);
      }

      const boardsContent = window['fs'].readFileSync(boardsFilePath, 'utf8');
      const lines = boardsContent.split('\n');

      // 查找指定开发板的配置
      const boardConfig = this.parseBoardsConfig(lines, boardName);

      if (!boardConfig) {
        throw new Error(`未找到开发板 "${boardName}" 的配置`);
      }

      // 提取需要的配置项
      const esp32Config = {
        uploadSpeed: this.extractMenuOptions(boardConfig, 'UploadSpeed'),
        uploadMode: this.extractMenuOptions(boardConfig, 'UploadMode'),
        flashMode: this.extractMenuOptions(boardConfig, 'FlashMode'),
        flashSize: this.extractMenuOptions(boardConfig, 'FlashSize'),
        partitionScheme: this.extractMenuOptions(boardConfig, 'PartitionScheme'),
        cdcOnBoot: this.extractMenuOptions(boardConfig, 'CDCOnBoot'),
        psram: this.extractMenuOptions(boardConfig, 'PSRAM')
      };

      return esp32Config;
    } catch (error) {
      console.error('获取ESP32开发板配置失败:', error);
      return null;
    }
  }

  // 解析boards.txt并获取STM32配置信息
  async getStm32BoardConfig(boardName: string) {
    try {
      const sdkPath = await this.getSdkPath();
      if (!sdkPath) {
        throw new Error('未找到 SDK 路径');
      }

      const boardsFilePath = `${sdkPath}/boards.txt`;
      if (!window['fs'].existsSync(boardsFilePath)) {
        throw new Error('boards.txt 文件不存在: ' + boardsFilePath);
      }

      const boardsContent = window['fs'].readFileSync(boardsFilePath, 'utf8');
      const lines = boardsContent.split('\n');

      // 查找指定开发板的配置
      const boardConfig = this.parseBoardsConfig(lines, boardName);

      // console.log('====boardConfig:', boardConfig);

      if (!boardConfig) {
        throw new Error(`未找到开发板 "${boardName}" 的配置`);
      }

      const stm32Config = {
        board: this.extractMenuOptions(boardConfig, 'pnum'),
        usb: this.extractMenuOptions(boardConfig, 'usb'),
        // upload_method: this.extractMenuOptions(boardConfig, 'upload_method'),
      };

      // 只保留 name 字段中包含 "Generic" 的选项，其它全部去掉
      if (stm32Config.board && Array.isArray(stm32Config.board)) {
        stm32Config.board = stm32Config.board.filter(item => item.name && item.name.includes('Generic'));
      }

      return stm32Config;
    } catch (error) {
      console.error('获取STM32开发板配置失败:', error);
      return null;
    }
  }

  // 解析boards.txt文件内容，提取指定开发板的配置
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

  // 比较FlashMode配置是否完全匹配
  private compareFlashModeConfig(childBuild: any, currentBuild: any): boolean {
    // FlashMode相关的配置项
    const flashModeKeys = ['flash_mode', 'boot', 'boot_freq', 'flash_freq'];

    for (const key of flashModeKeys) {
      // 如果子配置中有这个键，那么必须与当前配置匹配
      if (childBuild.hasOwnProperty(key)) {
        if (childBuild[key] !== currentBuild[key]) {
          return false;
        }
      }
    }

    return true;
  }

  // 通用的配置比较方法
  private compareConfigs(childData: any, currentData: any): boolean {
    if (!childData || !currentData) {
      return false;
    }

    if (childData && currentData) {
      if (childData !== currentData) {
        return false;
      }
    }
    // // 检查build配置
    // if (childData.build && currentData.build) {
    //   for (const key of configKeys) {
    //     if (childData.build.hasOwnProperty(key)) {
    //       if (childData.build[key] !== currentData.build[key]) {
    //         return false;
    //       }
    //     }
    //   }
    // }

    // // 检查upload配置
    // if (childData.upload && currentData.upload) {
    //   const uploadKeys = Object.keys(childData.upload);
    //   for (const key of uploadKeys) {
    //     if (childData.upload[key] !== currentData.upload[key]) {
    //       return false;
    //     }
    //   }
    // }

    return true;
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

      // 清理空的配置对象
      if (Object.keys(option.data).length === 0) {
        delete option.data;
      }

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

  // 更新ESP32配置菜单项
  async updateEsp32ConfigMenu(boardName: string) {
    try {
      const boardConfig = await this.getEsp32BoardConfig(boardName);
      // console.log('获取到的ESP32开发板配置:', boardConfig);

      if (!boardConfig) {
        console.warn(`无法获取开发板 "${boardName}" 的配置`);
        return null;
      }

      // 读取当前项目的package.json配置
      let currentProjectConfig: any = {};
      try {
        const packageJson = await this.getPackageJson();
        currentProjectConfig = packageJson.projectConfig || {};
      } catch (error) {
        console.warn('无法读取项目配置:', error);
      }

      // 导入ESP32_CONFIG_MENU，需要动态导入以避免循环依赖
      // const { ESP32_CONFIG_MENU } = await import('../configs/esp32.config');
      let ESP32_CONFIG_MENU_TEMP = JSON.parse(JSON.stringify(ESP32_CONFIG_MENU));

      // 更新菜单项
      ESP32_CONFIG_MENU_TEMP.forEach(menuItem => {
        if (menuItem.name === 'ESP32.UPLOAD_SPEED' && boardConfig.uploadSpeed) {
          menuItem.children = boardConfig.uploadSpeed;
          // 根据当前项目配置设置check状态
          if (currentProjectConfig.UploadSpeed) {
            menuItem.children.forEach((child: any) => {
              child.check = false; // 先清空所有选中状态
              // 使用通用比较方法检查当前配置是否匹配
              if (this.compareConfigs(child.data, currentProjectConfig.UploadSpeed)) {
                child.check = true;
              }
            });
          }
        } else if (menuItem.name === 'ESP32.UPLOAD_MODE' && boardConfig.uploadMode) {
          menuItem.children = boardConfig.uploadMode;
          // 根据当前项目配置设置check状态
          if (currentProjectConfig.UploadMode) {
            menuItem.children.forEach((child: any) => {
              child.check = false;
              if (this.compareConfigs(child.data, currentProjectConfig.UploadMode)) {
                child.check = true;
              }
            });
          }
        } else if (menuItem.name === 'ESP32.FLASH_MODE' && boardConfig.flashMode) {
          // console.log('boardConfig.flashMode:', boardConfig.flashMode);
          menuItem.children = boardConfig.flashMode;
          // 根据当前项目配置设置check状态
          if (currentProjectConfig.FlashMode) {
            menuItem.children.forEach((child: any) => {
              child.check = false;
              if (this.compareConfigs(child.data, currentProjectConfig.FlashMode)) {
                child.check = true;
              }
            });
          }
        } else if (menuItem.name === 'ESP32.FLASH_SIZE' && boardConfig.flashSize) {
          menuItem.children = boardConfig.flashSize;
          // 根据当前项目配置设置check状态
          if (currentProjectConfig.FlashSize) {
            menuItem.children.forEach((child: any) => {
              child.check = false;
              if (this.compareConfigs(child.data, currentProjectConfig.FlashSize)) {
                child.check = true;
              }
            });
          }
        } else if (menuItem.name === 'ESP32.PARTITION_SCHEME' && boardConfig.partitionScheme) {
          menuItem.children = boardConfig.partitionScheme;
          // 根据当前项目配置设置check状态
          if (currentProjectConfig.PartitionScheme) {
            menuItem.children.forEach((child: any) => {
              child.check = false;
              if (this.compareConfigs(child.data, currentProjectConfig.PartitionScheme)) {
                child.check = true;
              }
            });
          }
        } else if (menuItem.name === 'ESP32.CDC_ON_BOOT' && boardConfig.cdcOnBoot) {
          menuItem.children = boardConfig.cdcOnBoot;
          // 根据当前项目配置设置check状态
          if (currentProjectConfig.CDCOnBoot) {
            menuItem.children.forEach((child: any) => {
              child.check = false;
              if (this.compareConfigs(child.data, currentProjectConfig.CDCOnBoot)) {
                child.check = true;
              }
            });
          }
        } else if (menuItem.name === 'ESP32.PSRAM' && boardConfig.psram) {
          menuItem.children = boardConfig.psram;
          // 根据当前项目配置设置check状态
          if (currentProjectConfig.PSRAM) {
            menuItem.children.forEach((child: any) => {
              child.check = false;
              if (this.compareConfigs(child.data, currentProjectConfig.PSRAM)) {
                child.check = true;
              }
            });
          }
        }
      });
      return ESP32_CONFIG_MENU_TEMP;
    } catch (error) {
      console.error('更新ESP32配置菜单失败:', error);
      return null;
    }
  }

  // 更新STM32配置菜单项
  async updateStm32ConfigMenu(boardName: string) {
    try {
      console.log("updateStm32ConfigMenu: " + boardName);
      const boardConfig = await this.getStm32BoardConfig(boardName);
      console.log(boardConfig);

      if (!boardConfig) {
        console.warn(`无法获取开发板 "${boardName}" 的配置`);
        return null;
      }

      // 读取当前项目的package.json配置
      let currentProjectConfig: any = {};
      let packageJson: any = {};
      try {
        packageJson = await this.getPackageJson();
        currentProjectConfig = packageJson.projectConfig || {};
      } catch (error) {
        console.warn('无法读取项目配置:', error);
      }

      let STM32_CONFIG_MENU_TEMP = JSON.parse(JSON.stringify(STM32_CONFIG_MENU));

      // 更新菜单项
      STM32_CONFIG_MENU_TEMP.forEach(menuItem => {
        if (menuItem.name === 'STM32.BOARD' && boardConfig.board) {
          menuItem.children = boardConfig.board;
          // 根据当前项目配置设置check状态
          // console.log('menuItem.children:', menuItem.children);
          if (currentProjectConfig.pnum) {
            menuItem.children.forEach((child: any) => {
              child.check = false; // 先清空所有选中状态
              if (this.compareConfigs(child.data, currentProjectConfig.pnum)) {
                child.check = true;
                // console.log('=============================================');
                // console.log('child:', child);
                this.currentStm32Config.board = child.data;
                this.currentStm32Config.variant = child.extra?.build.variant || null;
                this.currentStm32Config.variant_h = child.extra?.build.variant_h || null;
                // console.log('Selected STM32 pin config:', this.currentStm32Config);
                // console.log('=============================================');
              }
            });
          } else {
            // 如果项目配置中没有pnum，则默认选中第一个
            if (menuItem.children.length > 0) {
              menuItem.children[0].check = true;
              packageJson['projectConfig'] = packageJson['projectConfig'] || {};
              packageJson['projectConfig']['pnum'] = menuItem.children[0].data;
              // 更新项目配置
              this.setPackageJson(packageJson);
              this.compareStm32PinConfig(menuItem.children[0]);
            }
          }
        } else if (menuItem.name === 'STM32.USB' && boardConfig.usb) {
          menuItem.children = boardConfig.usb;
          // 根据当前项目配置设置check状态
          if (currentProjectConfig.usb) {
            menuItem.children.forEach((child: any) => {
              child.check = false;
              if (this.compareConfigs(child.data, currentProjectConfig.usb)) {
                child.check = true;
              }
            });
          }
          // } else if (menuItem.name === 'STM32.UPLOAD_METHOD' && boardConfig.upload_method) {
          //   menuItem.children = boardConfig.upload_method;
          //   // 根据当前项目配置设置check状态
          //   if (currentProjectConfig.upload_method) {
          //     menuItem.children.forEach((child: any) => {
          //       child.check = false;
          //       if (this.compareConfigs(child.data, currentProjectConfig.upload_method)) {
          //         child.check = true;
          //       }
          //     });
          //   }
        }
      });
      return STM32_CONFIG_MENU_TEMP;
    } catch (error) {
      console.error('更新STM32配置菜单失败:', error);
      return null;
    }
  }

  // 解析boards.txt并获取nRF5配置信息
  async getNrf5BoardConfig(boardName: string) {
    try {
      const sdkPath = await this.getSdkPath();
      if (!sdkPath) {
        throw new Error('未找到 SDK 路径');
      }

      const boardsFilePath = `${sdkPath}/boards.txt`;
      if (!window['fs'].existsSync(boardsFilePath)) {
        throw new Error('boards.txt 文件不存在: ' + boardsFilePath);
      }

      const boardsContent = window['fs'].readFileSync(boardsFilePath, 'utf8');
      const lines = boardsContent.split('\n');

      // 查找指定开发板的配置
      const boardConfig = this.parseBoardsConfig(lines, boardName);

      if (!boardConfig) {
        throw new Error(`未找到开发板 "${boardName}" 的配置`);
      }

      // 提取nRF5需要的配置项
      const nrf5Config = {
        softdevice: this.extractMenuOptions(boardConfig, 'softdevice'),
      };

      return nrf5Config;
    } catch (error) {
      console.error('获取nRF5开发板配置失败:', error);
      return null;
    }
  }

  // 更新nRF5配置菜单项
  async updateNrf5ConfigMenu(boardName: string) {
    try {
      const boardConfig = await this.getNrf5BoardConfig(boardName);

      if (!boardConfig) {
        console.warn(`无法获取开发板 "${boardName}" 的配置`);
        return null;
      }

      // 读取当前项目的package.json配置
      let currentProjectConfig: any = {};
      try {
        const packageJson = await this.getPackageJson();
        currentProjectConfig = packageJson.projectConfig || {};
      } catch (error) {
        console.warn('无法读取项目配置:', error);
      }

      let NRF5_CONFIG_MENU_TEMP = JSON.parse(JSON.stringify(NRF5_CONFIG_MENU));

      // 更新菜单项
      NRF5_CONFIG_MENU_TEMP.forEach(menuItem => {
        if (menuItem.name === 'NRF5.SOFTDEVICE' && boardConfig.softdevice) {
          menuItem.children = boardConfig.softdevice;
          // 根据当前项目配置设置check状态
          if (currentProjectConfig.softdevice) {
            menuItem.children.forEach((child: any) => {
              child.check = false;
              if (this.compareConfigs(child.data, currentProjectConfig.softdevice)) {
                child.check = true;
              }
            });
          }
        }
      });

      return NRF5_CONFIG_MENU_TEMP;
    } catch (error) {
      console.error('更新nRF5配置菜单失败:', error);
      return null;
    }
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

  // 比较stm32引脚配置
  async compareStm32PinConfig(pinConfig: any): Promise<boolean> {
    // console.log('=============================================');
    // console.log('Comparing STM32 pin config:', pinConfig, "||", this.currentStm32Config);
    if (pinConfig.data == this.currentStm32Config.board) {
      return true;
    } else if (pinConfig.extra?.build.variant == this.currentStm32Config.variant) {
      this.currentStm32Config.board = pinConfig.data;
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
      this.currentStm32Config.board = pinConfig.data;
      this.currentStm32Config.variant = variant;
      this.currentStm32Config.variant_h = variant_h;

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

  async changeBoard(boardInfo: { "name": string, "version": string }) {
    this.isBoardSwitchInProgress = true;
    let reloadPromise: Promise<void> | null = null;
    try {
      const separator = this.platformService.getPlatformSeparator();
      if (!this.currentProjectPath) {
        throw new Error('当前项目路径未设置');
      }
      // 0. 保存当前项目
      await this.save();
      this.message.loading(this.translate.instant('PROJECT.SWITCHING_BOARD'), { nzDuration: 5000 });

      // 记录开发板使用次数
      this.configService.recordBoardUsage(boardInfo.name);
      const currentBoardModule = await this.getBoardModule();

      // 1. npm install 安装boardInfo.name@boardInfo.version 到 appDataPath（与 projectNew 一致）
      const appDataPath = window['path'].getAppDataPath();
      const newBoardPackage = `${boardInfo.name}@${boardInfo.version}`;
      console.log('安装新开发板模块:', newBoardPackage);
      this.uiService.updateFooterState({ state: 'doing', text: this.translate.instant('PROJECT.INSTALLING_NEW_BOARD') });
      await this.appDataResourceLock.runExclusive(`project:switch-board:install-appdata:${newBoardPackage}`, () =>
        this.cmdService.runAsyncChecked(`npm install ${newBoardPackage} --prefix "${appDataPath}"`)
      );

      // 2. 预安装到当前项目的 node_modules，但不写 package.json；最终 package.json 变更交给 watcher 处理。
      await this.cmdService.runAsyncChecked(`npm install ${newBoardPackage} --no-save`, this.currentProjectPath);

      // 3. 获取新开发板的模板并更新package.json
      console.log('更新项目配置文件...');
      this.uiService.updateFooterState({ state: 'doing', text: this.translate.instant('PROJECT.UPDATING_PROJECT_CONFIG') });

      // 读取当前package.json保留项目基本信息
      const currentPackageJson = await this.getPackageJson();

      // 获取新开发板的模板package.json（从 appDataPath 读取）
      const templatePath = `${appDataPath}${separator}node_modules${separator}${boardInfo.name}${separator}template`;
      const templatePackageJsonPath = `${templatePath}${separator}package.json`;

      if (window['fs'].existsSync(templatePackageJsonPath)) {
        // 读取模板package.json
        const templatePackageJson = JSON.parse(window['fs'].readFileSync(templatePackageJsonPath, 'utf8'));

        const selectedFramework = String((boardInfo as { selectedFramework?: string }).selectedFramework ?? '').trim();
        const isAilyCode = this.isAilyCodeProject();

        // 合并配置：保留当前项目的基本信息，使用新开发板的依赖和配置
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
          // 与新建 Coder 工程一致：不合并模板 dependencies 中的 lib-core-*，仅主板 + 用户自装库
          this.applyAilyCodeBoardToPackageManifest(newPackageJson, boardInfo, currentPackageJson);
          if (selectedFramework) {
            newPackageJson['devmode'] = selectedFramework;
          }
        } else {
          newPackageJson['dependencies'] = {
            // 从模板获取新的开发板依赖和基础库
            ...templatePackageJson.dependencies,
            ...Object.fromEntries(
              Object.entries(currentPackageJson.dependencies || {})
                .filter(([key]) => !key.startsWith('@aily-project/board-')),
            ),
          };
        }

        // 写入新的package.json
        const shouldUsePackageJsonWatcher = this.isPackageJsonBoardWatcherActive;
        reloadPromise = shouldUsePackageJsonWatcher ? this.waitForBoardSwitchReload() : null;
        this.isBoardSwitchInProgress = false;
        window['fs'].writeFileSync(`${this.currentProjectPath}/package.json`, JSON.stringify(newPackageJson, null, 2));
        console.log('package.json 更新完成');

        if (this.isAilyCodeProject()) {
          this.syncAilyCodeProjectAciAfterBoardSwitch(newPackageJson, boardInfo);
        }

        if (!shouldUsePackageJsonWatcher) {
          await this.finishBoardSwitchWithoutPackageWatcher(currentBoardModule, boardInfo.name);
        }
      } else {
        throw new Error('未找到新开发板的模板package.json，无法更新项目配置');
      }

      if (reloadPromise) {
        await reloadPromise;
      }

      this.uiService.updateFooterState({ state: 'done', text: this.translate.instant('PROJECT.BOARD_SWITCH_COMPLETE') });
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
   * Aily Code 切换开发板后，将 package.json 与 coder_board_index 选中项同步到 project.aci。
   */
  private syncAilyCodeProjectAciAfterBoardSwitch(
    packageJson: Record<string, unknown>,
    boardInfo: {
      name: string;
      version: string;
      boardId?: string;
      nickname?: string;
      defaultFramework?: string;
      defaultPlatform?: string;
      frameworkPlatforms?: unknown[];
      mode?: string[];
      selectedFramework?: string;
    },
  ): void {
    const aciPath = `${this.currentProjectPath}/project.aci`;
    if (!window['fs'].existsSync(aciPath)) {
      return;
    }
    try {
      const aci = JSON.parse(this.electronService.readFile(aciPath));
      const framework = String(boardInfo.selectedFramework ?? '').trim()
        || resolveDefaultCoderFramework(boardInfo);
      const platformOption = resolveCoderFrameworkOption(boardInfo, framework);
      const targetBoardId = platformOption?.boardId || boardInfo.boardId || boardInfo.name;

      aci.name = packageJson['name'] ?? aci.name;
      aci.nickname = packageJson['nickname'] ?? aci.nickname;
      aci.version = packageJson['version'] ?? aci.version;
      aci.description = packageJson['description'] ?? aci.description;
      if (packageJson['devmode'] != null && packageJson['devmode'] !== '') {
        aci.devmode = packageJson['devmode'];
      }
      aci.dependencies = packageJson['dependencies'] ?? aci.dependencies;
      aci.boardDependencies = packageJson['boardDependencies'] ?? aci.boardDependencies;

      aci.target = {
        ...(aci.target || {}),
        board: targetBoardId,
        boardPackage: boardInfo.name,
        boardPackageVersion: boardInfo.version,
        framework,
        ...(platformOption?.platform || boardInfo.defaultPlatform
          ? { platform: platformOption?.platform || boardInfo.defaultPlatform }
          : {}),
      };

      window['fs'].writeFileSync(aciPath, JSON.stringify(aci, null, 2));
      console.log('[changeBoard] project.aci 已同步');
    } catch (e) {
      console.warn('[changeBoard] 同步 project.aci 失败:', e);
    }
  }

  /**
   * Aily Code：切换开发板/硬件平台后重装工程与平台依赖（与打开新 Coder 工程一致）。
   */
  private async reinstallAilyCodeDepsAfterBoardSwitch(): Promise<void> {
    const projectPath = this.currentProjectPath;
    if (!projectPath || !this.isAilyCodeProject()) {
      return;
    }
    const { NpmService } = await import('./npm.service');
    const npmService = this.injector.get(NpmService);
    const ok = await npmService.reinstallDepsForAilyCodeBoardSwitch(projectPath);
    if (!ok) {
      throw new Error(this.translate.instant('NPM.BOARD_DEPS_INSTALL_FAILED'));
    }
  }

  /** package.json watcher 不活跃时，使用原流程完成旧开发板卸载、temp 同步和项目重载。 */
  private async finishBoardSwitchWithoutPackageWatcher(currentBoardModule: string | undefined, nextBoardModule: string): Promise<void> {
    if (currentBoardModule && currentBoardModule !== nextBoardModule) {
      console.log('卸载当前开发板模块:', currentBoardModule);
      this.uiService.updateFooterState({ state: 'doing', text: this.translate.instant('PROJECT.UNINSTALLING_CURRENT_BOARD') });
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

  /**
   * 获取当前项目的构建路径
   * Aily Code（存在 project.aci）：固件落在 `.aily/build/<framework>/`，与 compile.js `--output-dir` 一致。
   * 纯 Blockly：`AILY_BUILDER_BUILD_PATH`/sketch 哈希目录（沿用原逻辑）。
   * @returns 返回构建路径
   */
  async getBuildPath(): Promise<string> {
    const root = this.currentProjectPath;
    const aciPath = window['path'].join(root, 'project.aci');
    // 与 child/scripts/aily-code-project.js 中分段规则保持一致
    if (window['path'].isExists(aciPath)) {
      try {
        const raw = window['fs'].readFileSync(aciPath, 'utf8');
        const aci = JSON.parse(raw);
        const frameworkRaw = aci?.target?.framework ?? aci?.devmode ?? 'arduino';
        const fw = String(frameworkRaw || 'arduino').trim() || 'arduino';
        const seg = fw.toLowerCase().replace(/[^a-z0-9_-]+/g, '_') || 'arduino';
        const outDir = window['path'].join(root, '.aily', 'build', seg);
        return outDir;
      } catch (e) {
        console.warn('[getBuildPath] 解析 project.aci 失败，回退 Blockly 缓存路径:', e);
      }
    }

    const sketchPath = window['path'].join(root, '.temp', 'sketch', 'sketch.ino');
    const sketchName = window['path'].basename(sketchPath, '.ino');

    // 为了避免不同项目的同名sketch冲突,使用项目路径的MD5哈希值
    const projectPathMD5 = (await window['tools'].calculateMD5(sketchPath)).substring(0, 8); // 只取前8位MD5值
    const uniqueSketchName = `${sketchName}_${projectPathMD5}`;

    // 使用统一的构建路径获取方法
    return window['path'].join(
      window['path'].getAilyBuilderBuildPath(),
      uniqueSketchName
    );
  }
}
