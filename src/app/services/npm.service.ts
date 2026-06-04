import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { ElectronService } from './electron.service';
import { ConfigService } from './config.service';
import { UiService } from './ui.service';
import { API } from '../configs/api.config';
import { ProjectService } from './project.service';
import { CmdService } from './cmd.service';
import { WorkflowService, ProcessState } from './workflow.service';
import { TranslateService } from '@ngx-translate/core';
import { NoticeService } from './notice.service';
import { LogOptions, LogService } from './log.service';
import { satisfies, valid, gt, minVersion, coerce } from 'semver';
import {
  resolvePlatformPackageDirOnDisk,
  resolvePlatformPackageEntries,
} from '../utils/platform-packages.utils';
import {
  PlatformPackageRef,
  readPlatformManifestFromAppData,
  readPlatformRefFromProjectAci,
  runtimeDependenciesToBoardDependencies,
} from '../utils/platform-runtime.utils';
import { AppDataResourceLockService } from './appdata-resource-lock.service';

@Injectable({
  providedIn: 'root'
})
export class NpmService {
  constructor(
    private http: HttpClient,
    private electronService: ElectronService,
    private configService: ConfigService,
    private uiService: UiService,
    private prjService: ProjectService,
    private cmdService: CmdService,
    private workflowService: WorkflowService,
    private translate: TranslateService,
    private noticeService: NoticeService,
    private logService: LogService,
    private appDataResourceLock: AppDataResourceLockService
  ) {
    this.logService.stateSubject.subscribe((log) => {
      this.handleBoardDependencyProgressLog(log);
    });
  }

  isInstalling = false;
  private boardDependencyInstallProgress?: BoardDependencyInstallProgress;

  private getNpmErrorMessage(error: any): string {
    return (error?.message || String(error)).replace(/^Error invoking remote method 'npm-run': Error:\s*/i, '');
  }

  private traceToAppLog(event: string, data: any = {}): void {
    try {
      if (window['ipcRenderer']?.invoke) {
        void window['ipcRenderer']
          .invoke('log-info', `[PROC_TRACE][NPM_SERVICE_${event}] ${JSON.stringify(data)}`)
          .catch(() => {});
      }
    } catch {
      // 诊断日志不能影响安装流程
    }
  }

  private clampProgress(value: number): number {
    return Math.max(0, Math.min(100, Math.floor(value)));
  }

  private updateBoardDependencyNotice(progress: BoardDependencyInstallProgress, value: number) {
    const nextProgress = Math.max(progress.lastProgress, this.clampProgress(value));
    progress.lastProgress = nextProgress;

    this.noticeService.update({
      title: this.translate.instant('NPM.DEPENDENCY_INSTALLING_TITLE'),
      text: this.translate.instant('NPM.INSTALLING_DEPENDENCY', { name: progress.name }),
      state: 'doing',
      progress: nextProgress
    });
  }

  private parseDependencyProgressLog(log: LogOptions): { phase: 'download' | 'extract', percent: number } | null {
    const text = String(log?.detail || log?.title || '').trim();
    if (!text) {
      return null;
    }

    if (/^下载完成[:：]/i.test(text)) {
      return { phase: 'download', percent: 100 };
    }

    const match = text.match(/^(下载进度|解压进度)[:：]\s*(\d+(?:\.\d+)?)/i);
    if (!match) {
      return null;
    }

    const percent = Math.max(0, Math.min(100, Number(match[2])));
    return {
      phase: match[1].startsWith('下载') ? 'download' : 'extract',
      percent
    };
  }

  private handleBoardDependencyProgressLog(log: LogOptions) {
    const progress = this.boardDependencyInstallProgress;
    if (!progress) {
      return;
    }

    const parsed = this.parseDependencyProgressLog(log);
    if (!parsed) {
      return;
    }

    if (parsed.phase === 'download') {
      progress.downloadProgress = Math.max(progress.downloadProgress, parsed.percent);
    } else {
      progress.extractProgress = Math.max(progress.extractProgress, parsed.percent);
    }

    const singleDependencyProgress = progress.downloadProgress * 0.5 + progress.extractProgress * 0.5;
    const overallProgress = ((progress.index + singleDependencyProgress / 100) / progress.total) * 100;
    this.updateBoardDependencyNotice(progress, overallProgress);
  }

  async init() {
    if (this.electronService.isElectron) {
      window['ipcRenderer'].on('window-receive', async (event, message) => {
        // console.log("npm-exec: ", message);
        const action = message.data.action;
        // console.log("action: ", action);
        if (action !== "npm-exec") {
          return;
        }

        const subAction = message.data.detail.action;
        const subData = message.data.detail.data;

        if (subAction === 'install-board-dependencies') {
          const packageJson = JSON.parse(window['fs'].readFileSync(subData));
          await this.installBoardDependencies(packageJson)
        } else if (subAction === 'install-board') {
          const packagePath = await this.installBoard(subData)
          console.log("packagePath: ", packagePath);
          const packageJson = JSON.parse(window['fs'].readFileSync(packagePath));
          await this.installBoardDependencies(packageJson)
        } else if (subAction === 'install-tool') {
          let tool = subData;
          if (typeof (tool) === 'string') {
            tool = JSON.parse(tool);
          }
          await this.installTool(tool);
        } else if (subAction === 'install-sdk') {
          let sdk = subData;
          if (typeof (sdk) === 'string') {
            sdk = JSON.parse(sdk);
          }
          await this.installSDK(sdk);
        } else if (subAction === 'install-compiler') {
          let compiler = subData;
          if (typeof (compiler) === 'string') {
            compiler = JSON.parse(compiler);
          }
          await this.installCompiler(compiler);
        } else if (subAction === 'uninstall-board') {
          let board = subData;
          if (typeof (board) === 'string') {
            board = JSON.parse(board);
          }
          await this.uninstallBoard(board);
        } else if (subAction === 'uninstall-tool') {
          let tool = subData;
          if (typeof (tool) === 'string') {
            tool = JSON.parse(tool);
          }

          await this.uninstallTool(tool);
        } else if (subAction === 'uninstall-sdk') {
          let sdk = subData;
          if (typeof (sdk) === 'string') {
            sdk = JSON.parse(sdk);
          }
          await this.uninstallSDK(sdk);
        } else if (subAction === 'uninstall-compiler') {
          let compiler = subData;
          if (typeof (compiler) === 'string') {
            compiler = JSON.parse(compiler);
          }
          await this.uninstallCompiler(compiler);
        }

        console.log("messageId: ", message.messageId);
        if (message.messageId) {
          console.log("发送消息: ", message.messageId);
          window['ipcRenderer'].send('main-window-response', {
            messageId: message.messageId,
            result: 'success'
          })
        }
      });
    }
  }

  // 安装开发板
  async installBoard(board: any) {
    if (typeof (board) === 'string') {
      board = JSON.parse(board);
    }
    this.isInstalling = true;
    this.workflowService.startInstall();
    // const appDataPath = this.configService.data.appdata_path[this.configService.data.platform].replace('%HOMEPATH%', window['path'].getUserHome());
    const appDataPath = window['path'].getAppDataPath();
    const cmd = `npm install ${board.name}@${board.version} --prefix "${appDataPath}"`;
    // this.uiService.updateFooterState({ state: 'doing', text: this.translate.instant('NPM.INSTALLING', { name: board.name }), timeout: 300000 });
    this.noticeService.update({ 
      title: this.translate.instant('NPM.INSTALLING_TITLE'), 
      text: this.translate.instant('NPM.INSTALLING', { name: board.name }), 
      state: 'doing',
      showProgress: false,
      setTimeout: 300000
    });
    try {
      await this.appDataResourceLock.runExclusive(`npm:install-board:${board.name}`, () => window['npm'].run({ cmd: cmd }));
    } catch (error) {
      const errorMessage = this.getNpmErrorMessage(error);
      console.error(`安装开发板 ${board.name} 失败:`, error);
      this.noticeService.update({
        title: this.translate.instant('NPM.INSTALL_FAILED_TITLE'),
        text: this.translate.instant('NPM.INSTALLING', { name: board.name }),
        detail: errorMessage,
        state: 'error'
      });
      this.isInstalling = false;
      this.workflowService.finishInstall(false, errorMessage);
      throw error;
    }

    // this.uiService.updateFooterState({ state: 'done', text: this.translate.instant('NPM.BOARD_INSTALL_COMPLETE') });
    this.noticeService.update({ 
      title: this.translate.instant('NPM.INSTALL_COMPLETE_TITLE'), 
      text: this.translate.instant('NPM.BOARD_INSTALL_COMPLETE'), 
      state: 'done',
      setTimeout: 3000
    });
    this.isInstalling = false;
    this.workflowService.finishInstall(true);
    // return template/package.json
    return `${appDataPath}/node_modules/${board.name}/template/package.json`;
  }

  /**
   * 若主板包仅在 project.aci 中声明、工程 node_modules 未安装，则补写 package.json 并 npm install 主板包。
   */
  private async ensureAilyCodeBoardPackageInProjectNodeModules(projectPath: string): Promise<void> {
    if (!this.isAilyCodeProjectRoot(projectPath)) {
      return;
    }
    const boardModule = await this.prjService.getBoardModule();
    if (!boardModule) {
      return;
    }
    const boardPkgJsonPath = window['path'].join(projectPath, 'node_modules', boardModule, 'package.json');
    if (window['path'].isExists(boardPkgJsonPath)) {
      return;
    }

    const packageJsonPath = window['path'].join(projectPath, 'package.json');
    const pkg = JSON.parse(window['fs'].readFileSync(packageJsonPath, 'utf8'));
    let boardRange = String(pkg.dependencies?.[boardModule] ?? pkg.boardDependencies?.[boardModule] ?? '').trim();
    if (!boardRange) {
      try {
        const aci = JSON.parse(window['fs'].readFileSync(window['path'].join(projectPath, 'project.aci'), 'utf8'));
        const ver = String(aci?.target?.boardPackageVersion ?? '').trim();
        if (!ver) {
          boardRange = '*';
        } else if (/^[\^~]|^>=|^<=|^>|^</.test(ver) || ver === '*' || ver === 'latest') {
          boardRange = ver;
        } else {
          boardRange = `^${ver}`;
        }
      } catch {
        boardRange = '*';
      }
      pkg.dependencies = { ...(pkg.dependencies || {}), [boardModule]: boardRange };
      pkg.boardDependencies = { ...(pkg.boardDependencies || {}), [boardModule]: boardRange };
      window['fs'].writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 2));
    }

    await this.cmdService.runAsyncChecked(`npm install ${boardModule}@${boardRange}`, projectPath);
  }

  /**
   * Aily Code 切换开发板或硬件平台后：与打开新 Coder 工程一致，
   * 执行工程目录 npm install，并安装主板 boardDependencies + platform runtimeDependencies。
   */
  async reinstallDepsForAilyCodeBoardSwitch(projectPath: string): Promise<boolean> {
    if (!this.isAilyCodeProjectRoot(projectPath)) {
      return true;
    }

    const installStateStarted = this.workflowService.startInstall();
    this.isInstalling = true;
    try {
      setTimeout(() => {
        this.noticeService.update({
          title: this.translate.instant('NPM.INSTALLING_TITLE'),
          text: this.translate.instant('BLOCKLY_EDITOR.INSTALLING_DEPS'),
          state: 'doing',
          icon: 'fa-light fa-cubes',
          showProgress: false,
        });
      }, 0);

      this.uiService.updateFooterState({
        state: 'doing',
        text: this.translate.instant('BLOCKLY_EDITOR.INSTALLING_DEPS'),
      });

      await this.cmdService.runAsyncChecked(`npm install`, projectPath);
      await this.ensureAilyCodeBoardPackageInProjectNodeModules(projectPath);

      const installed = await this.installedOk(projectPath);
      if (!installed) {
        const detail = 'npm install 执行完成但工程依赖检查未通过';
        setTimeout(() => {
          this.noticeService.update({
            title: this.translate.instant('NPM.INSTALL_FAILED_TITLE'),
            text: this.translate.instant('NPM.BOARD_DEPS_INSTALL_FAILED'),
            detail,
            state: 'error',
            sendToLog: false,
          });
        }, 1000);
        if (installStateStarted && this.workflowService.currentState === ProcessState.INSTALLING) {
          this.workflowService.finishInstall(false, detail);
        }
        return false;
      }

      const boardModule = await this.prjService.getBoardModule();
      if (boardModule) {
        const boardPackageJson = (await this.prjService.getBoardPackageJson()) || {};
        const boardDependencies = boardPackageJson.boardDependencies || {};
        if (Object.keys(boardDependencies).length > 0) {
          await this.installBoardDependencies(boardPackageJson, false, true);
        }
      }
      await this.installPlatformPackageForAilyCodeProject({ force: true });

      if (installStateStarted && this.workflowService.currentState === ProcessState.INSTALLING) {
        this.workflowService.finishInstall(true);
      }
      setTimeout(() => {
        this.noticeService.update({
          title: this.translate.instant('NPM.INSTALL_COMPLETE_TITLE'),
          text: this.translate.instant('NPM.DEPS_INSTALL_COMPLETE'),
          state: 'done',
          showProgress: false,
          setTimeout: 3000,
        });
      }, 100);
      return true;
    } catch (error) {
      const errorMessage = this.getNpmErrorMessage(error);
      if (installStateStarted && this.workflowService.currentState === ProcessState.INSTALLING) {
        this.workflowService.finishInstall(false, errorMessage);
      }
      setTimeout(() => {
        this.noticeService.update({
          title: this.translate.instant('NPM.INSTALL_FAILED_TITLE'),
          text: this.translate.instant('NPM.BOARD_DEPS_INSTALL_FAILED'),
          detail: errorMessage,
          state: 'error',
          sendToLog: false,
        });
      }, 1000);
      console.error('[reinstallDepsForAilyCodeBoardSwitch]', error);
      return false;
    } finally {
      this.isInstalling = false;
      this.boardDependencyInstallProgress = undefined;
    }
  }

  /** Blockly / Aily Code 共用：工程 npm 就绪后后台检查主板平台依赖（与 blockly-editor loadProject 一致） */
  ensureProjectAndBoardDeps(
    projectPath: string,
    options?: { onRetryInstall?: () => void; onBoardDepsSettled?: () => void },
  ): Promise<boolean> {
    return this.ensureProjectDependenciesInstalled(projectPath, options).then((ok) => {
      if (!ok) {
        return false;
      }
      void this.installBoardDeps()
        .then(() => options?.onBoardDepsSettled?.())
        .catch((err) => console.error('install board dependencies error', err));
      return true;
    });
  }

  async installBoardDeps() {
    this.isInstalling = true;
    const installStateStarted = this.workflowService.startInstall();

    try {
      const boardModule = await this.prjService.getBoardModule();
      if (boardModule) {
        const boardPackageJson = (await this.prjService.getBoardPackageJson()) || {};
        const boardDependencies = boardPackageJson.boardDependencies || {};
        if (Object.keys(boardDependencies).length > 0) {
          await this.installBoardDependencies(boardPackageJson, false);
        }
      }
      await this.installPlatformPackageForAilyCodeProject();
      if (installStateStarted && this.workflowService.currentState === ProcessState.INSTALLING) {
        this.workflowService.finishInstall(true);
      }
    } catch (error) {
      const errorMessage = this.getNpmErrorMessage(error);
      if (installStateStarted && this.workflowService.currentState === ProcessState.INSTALLING) {
        this.workflowService.finishInstall(false, errorMessage);
      }
      console.error('[installBoardDeps]', error);
    } finally {
      this.isInstalling = false;
      this.boardDependencyInstallProgress = undefined;
    }
  }

  private isAilyCodeProjectRoot(projectPath: string): boolean {
    return window['path'].isExists(window['path'].join(projectPath, 'project.aci'));
  }

  /**
   * Aily Code：将 frameworkPlatforms.platform 对应 npm 包安装到 AppData，
   * 再按 platform.json 的 runtimeDependencies 安装 sdk / compiler / tool（与 Blockly 一致）。
   */
  async installPlatformPackageForAilyCodeProject(options?: { force?: boolean }): Promise<void> {
    const projectPath = this.prjService.currentProjectPath;
    if (!projectPath || !this.isAilyCodeProjectRoot(projectPath)) {
      return;
    }

    const platformRef = readPlatformRefFromProjectAci(projectPath);
    if (!platformRef?.packageName) {
      console.log('[installPlatformPackageForAilyCodeProject] 未配置 platform，跳过');
      return;
    }

    await this.ensurePlatformNpmPackageInstalled(platformRef);

    const manifest = readPlatformManifestFromAppData(platformRef.packageName);
    if (!manifest?.runtimeDependencies?.length) {
      console.log('[installPlatformPackageForAilyCodeProject] platform.json 无 runtimeDependencies，跳过');
      return;
    }

    const boardDependencies = runtimeDependenciesToBoardDependencies(manifest.runtimeDependencies);
    if (Object.keys(boardDependencies).length === 0) {
      return;
    }

    await this.installBoardDependencies({
      name: manifest.id || platformRef.packageName,
      version: manifest.version || platformRef.version || '',
      boardDependencies,
    }, false, options?.force === true);
  }

  /** 安装 platform npm 包到 AppData（与 boardDependencies 包相同 prefix） */
  private async ensurePlatformNpmPackageInstalled(platformRef: PlatformPackageRef): Promise<void> {
    const appDataPath = window['path'].getAppDataPath();
    const packageName = String(platformRef.packageName ?? '').trim();
    if (!packageName) {
      return;
    }

    const declaredVersion = String(platformRef.version ?? '').trim();
    const depPath = `${appDataPath}/node_modules/${packageName}`;
    const depPathPackageJson = `${depPath}/package.json`;

    if (window['path'].isExists(depPathPackageJson)) {
      try {
        const installed = JSON.parse(window['fs'].readFileSync(depPathPackageJson, 'utf8'));
        if (!declaredVersion || this.depVersionSatisfiesDecl(installed.version, declaredVersion)) {
          if (window['path'].isExists(`${depPath}/platform.json`)) {
            console.log(`[ensurePlatformNpmPackageInstalled] ${packageName} 已安装，跳过`);
            return;
          }
        }
      } catch {
        /* 继续安装 */
      }
    }

    this.noticeService.update({
      title: this.translate.instant('NPM.INSTALLING_TITLE'),
      text: this.translate.instant('NPM.INSTALLING', { name: packageName }),
      state: 'doing',
      showProgress: false,
      setTimeout: 300000,
    });

    const installSpec = declaredVersion ? `${packageName}@${declaredVersion}` : packageName;
    const npmCmd = `npm install ${installSpec} --save-exact --prefix "${appDataPath}"`;
    await this.appDataResourceLock.runExclusive(`npm:install-platform:${packageName}`, () =>
      window['npm'].run({ cmd: npmCmd }),
    );
  }

  boardDependenciesChanged = false;

  /** 已安装版本是否满足 boardDependencies 中的声明（支持 ^ / ~ 等，与 npm 行为一致） */
  private depVersionSatisfiesDecl(installedVersion: string, declared: string): boolean {
    const ins = String(installedVersion ?? '').trim();
    const dec = String(declared ?? '').trim();
    if (!ins || !dec) {
      return false;
    }
    if (ins === dec) {
      return true;
    }
    if (!valid(ins)) {
      return false;
    }
    try {
      return satisfies(ins, dec, { includePrerelease: true });
    } catch {
      return false;
    }
  }

  /**
   * 已安装版本是否高于声明所允许的最低基线（用于判断是否需先卸载再降级；升级场景不卸载）
   */
  private installedIsNewerThanDeclared(installedVersion: string, declared: string): boolean {
    const ins = String(installedVersion ?? '').trim();
    const dec = String(declared ?? '').trim();
    if (!ins || !dec || !valid(ins)) {
      return false;
    }
    let baseline: string | null = null;
    try {
      const m = minVersion(dec);
      baseline = m ? m.version : null;
    } catch {
      baseline = null;
    }
    if (!baseline || !valid(baseline)) {
      const c = coerce(dec);
      baseline = c ? c.version : null;
    }
    if (!baseline || !valid(baseline)) {
      return false;
    }
    try {
      return gt(ins, baseline);
    } catch {
      return false;
    }
  }

  /** 与 preprocess / Platform Packages 树一致：sdk、tools 下的解压目录 */
  private async getPlatformPathBases(): Promise<{
    sdkBase: string;
    compilersBase: string;
    toolsBase: string;
  }> {
    const [sdkBase, compilersBase, toolsBase] = await Promise.all([
      window['env'].get('AILY_SDK_PATH') as Promise<string>,
      window['env'].get('AILY_COMPILERS_PATH') as Promise<string>,
      window['env'].get('AILY_TOOLS_PATH') as Promise<string>,
    ]);
    return { sdkBase, compilersBase, toolsBase };
  }

  private isPlatformPackageOnDisk(
    packageName: string,
    version: string,
    bases: { sdkBase: string; compilersBase: string; toolsBase: string },
  ): boolean {
    return !!resolvePlatformPackageDirOnDisk(packageName, version, bases);
  }

  /**
   * npm 版本 + sdk/tools 解压目录均满足主板 boardDependencies 声明时返回 true（与 Blockly 跳过已安装逻辑一致）。
   */
  private async areBoardPlatformDepsReady(
    boardDependencies: Record<string, string>,
  ): Promise<boolean> {
    const keys = Object.keys(boardDependencies);
    if (keys.length === 0) {
      return true;
    }
    const appDataPath = window['path'].getAppDataPath();
    const platformBases = await this.getPlatformPathBases();
    for (const key of keys) {
      const versionStr = String(boardDependencies[key] ?? '').trim();
      if (!versionStr) {
        return false;
      }
      const depPathPackageJson = `${appDataPath}/node_modules/${key}/package.json`;
      if (!window['path'].isExists(depPathPackageJson)) {
        return false;
      }
      try {
        const depPackageJson = JSON.parse(window['fs'].readFileSync(depPathPackageJson));
        if (!this.depVersionSatisfiesDecl(depPackageJson.version, versionStr)) {
          return false;
        }
      } catch {
        return false;
      }
      if (!this.isPlatformPackageOnDisk(key, versionStr, platformBases)) {
        return false;
      }
    }
    return true;
  }

  // 安装开发板依赖
  async installBoardDependencies(packageJson: any, manageInstallState: boolean = true, force = false) {
    const boardDependencies: Record<string, string> = packageJson.boardDependencies || {};
    if (!force && await this.areBoardPlatformDepsReady(boardDependencies)) {
      console.log('[installBoardDependencies] 平台依赖已就绪，跳过');
      return;
    }

    try {
      if (manageInstallState) {
        this.isInstalling = true;
        this.workflowService.startInstall();
      }
      this.boardDependenciesChanged = false;
      this.boardDependencyInstallProgress = undefined;
      console.log('开始安装开发板依赖...');
      const appDataPath = window['path'].getAppDataPath();
      const platformBases = await this.getPlatformPathBases();
      const dependenciesToInstall: BoardDependencyToInstall[] = [];
      this.traceToAppLog('DEPS_START', {
        packageName: packageJson?.name || '',
        packageVersion: packageJson?.version || '',
        dependencyCount: Object.keys(boardDependencies).length
      });

      for (const [key, version] of Object.entries(boardDependencies)) {
        const declaredVersion = String(version);
        const depPath = `${appDataPath}/node_modules/${key}`;
        const depPathPackageJson = `${depPath}/package.json`;
        let installedVersionWhenMismatch: string | undefined;
        const versionStr = String(version);

        // npm 包版本满足声明时，仍须检查 sdk/tools 解压目录（postinstall 可能未跑）
        if (window['path'].isExists(depPathPackageJson)) {
          const depPackageJson = JSON.parse(window['fs'].readFileSync(depPathPackageJson));
          if (this.depVersionSatisfiesDecl(depPackageJson.version, versionStr)) {
            const platformOnDisk = this.isPlatformPackageOnDisk(key, versionStr, platformBases);
            if (platformOnDisk) {
              console.log(`依赖 ${key} 已安装且平台目录存在`);
              this.traceToAppLog('DEP_SKIP', { name: key, declaredVersion: versionStr, installedVersion: depPackageJson.version, platformReady: true });
              continue;
            }
            const platformPath = resolvePlatformPackageEntries({ [key]: versionStr }, platformBases)[0]
              ?.absolutePath;
            console.log(`依赖 ${key} npm 已满足但平台目录缺失，尝试 postinstall: ${platformPath}`);
            this.boardDependenciesChanged = true;
            this.noticeService.update({
              title: this.translate.instant('NPM.INSTALLING_TITLE'),
              text: this.translate.instant('NPM.INSTALLING_DEPENDENCY', { name: key }),
              state: 'doing',
              showProgress: false,
              setTimeout: 300000
            });
            try {
              await this.cmdService.runAsync('npm run postinstall', depPath);
              if (this.isPlatformPackageOnDisk(key, versionStr, platformBases)) {
                this.traceToAppLog('DEP_SKIP', { name: key, declaredVersion: versionStr, installedVersion: depPackageJson.version, platformReady: true, afterPostinstall: true });
                continue;
              }
            } catch (error) {
              console.warn(`依赖 ${key} postinstall 失败，将重新 npm install:`, error);
            }
          } else {
            installedVersionWhenMismatch = depPackageJson.version;
          }
        }

        const needUninstallForDowngrade =
          window['path'].isExists(depPath) &&
          installedVersionWhenMismatch !== undefined &&
          this.installedIsNewerThanDeclared(installedVersionWhenMismatch, declaredVersion);

        dependenciesToInstall.push({
          name: key,
          version: declaredVersion,
          needUninstallForDowngrade
        });
        this.traceToAppLog('DEP_PLAN', { name: key, declaredVersion, installedVersionWhenMismatch, needUninstallForDowngrade });
      }

      if (dependenciesToInstall.length === 0) {
        if (manageInstallState && this.workflowService.currentState === ProcessState.INSTALLING) {
          this.workflowService.finishInstall(true);
        }
        return;
      }

      this.boardDependenciesChanged = true;

      await this.appDataResourceLock.runExclusive(`npm:board-dependencies:${packageJson?.name || ''}`, async () => {
        for (let index = 0; index < dependenciesToInstall.length; index++) {
          const dependency = dependenciesToInstall[index];
          const progress: BoardDependencyInstallProgress = {
            total: dependenciesToInstall.length,
            index,
            name: dependency.name,
            downloadProgress: 0,
            extractProgress: 0,
            lastProgress: this.clampProgress((index / dependenciesToInstall.length) * 100)
          };
          this.boardDependencyInstallProgress = progress;

          // this.uiService.updateFooterState({ state: 'doing', text: this.translate.instant('NPM.INSTALLING_DEPENDENCY', { name: key }), timeout: 300000 });
          this.updateBoardDependencyNotice(progress, progress.lastProgress);

          // 仅当当前安装版本高于声明基线（需降级）时先卸载；升级或未读到版本时直接 install，避免无谓卸载
          if (dependency.needUninstallForDowngrade) {
            const uninstallCmd = `npm uninstall ${dependency.name} --prefix "${appDataPath}"`;
            console.log(`执行命令: ${uninstallCmd}, 时间: ${new Date().toISOString()}`);
            this.traceToAppLog('DEP_UNINSTALL_START', { name: dependency.name, version: dependency.version });
            await window['npm'].run({ cmd: uninstallCmd });
          }

          // --save-exact：与开发板声明版本一致写入 prefix 下 package.json，避免 ^ 导致再次解析到更高版
          const npmCmd = `npm install ${dependency.name}@${dependency.version} --save-exact --prefix "${appDataPath}"`;
          console.log(`执行命令: ${npmCmd}, 时间: ${new Date().toISOString()}`);
          this.traceToAppLog('DEP_INSTALL_START', { name: dependency.name, version: dependency.version });

          await window['npm'].run({ cmd: npmCmd });

          this.updateBoardDependencyNotice(progress, ((index + 1) / dependenciesToInstall.length) * 100);
          console.log(`依赖 ${dependency.name} 安装成功, 时间: ${new Date().toISOString()}`);
          this.traceToAppLog('DEP_INSTALL_DONE', { name: dependency.name, version: dependency.version });
        }
      });

      // this.uiService.updateFooterState({ state: 'done', text: this.translate.instant('NPM.BOARD_DEPS_INSTALL_COMPLETE') });
      this.noticeService.update({
        title: this.translate.instant('NPM.INSTALL_COMPLETE_TITLE'),
        text: this.translate.instant('NPM.BOARD_DEPS_INSTALL_COMPLETE'),
        state: 'done',
        progress: 100,
        setTimeout: 3000
      });
      if (manageInstallState && this.workflowService.currentState === ProcessState.INSTALLING) {
        this.workflowService.finishInstall(true);
      }
    } catch (error) {
      const errorMessage = this.getNpmErrorMessage(error);
      console.error('安装开发板依赖时出错:', error);
      this.traceToAppLog('DEPS_ERROR', { error: errorMessage });
      // this.uiService.updateFooterState({ state: 'error', text: this.translate.instant('NPM.BOARD_DEPS_INSTALL_FAILED') });
      this.noticeService.update({ 
        title: this.translate.instant('NPM.DEPENDENCY_INSTALL_FAILED_TITLE'), 
        text: this.translate.instant('NPM.BOARD_DEPS_INSTALL_FAILED'), 
        detail: errorMessage,
        state: 'error'
      });
      if (manageInstallState && this.workflowService.currentState === ProcessState.INSTALLING) {
        this.workflowService.finishInstall(false, errorMessage);
      }
      throw error;
    } finally {
      this.boardDependencyInstallProgress = undefined;
      if (manageInstallState) {
        this.isInstalling = false;
      }
    }
  }

  // 卸载开发板依赖
  async uninstallBoardDependencies(depName, packageJson: any) {
    try {
      // const appDataPath = this.configService.data.appdata_path[this.configService.data.platform].replace('%HOMEPATH%', window['path'].getUserHome());
      const appDataPath = window['path'].getAppDataPath();
      const boardDependenciesToUninstall = packageJson.boardDependencies || {};

      // 获取所有已安装的包
      const installedPackagesList = await this.getInstalledPackageList(appDataPath);
      const installedBoards = [];

      // 从已安装的包中找出开发板（具有template/package.json的包且包名以@aily-project/board-开头）
      for (const packageItem of installedPackagesList) {
        const packageName = '@' + packageItem.split('@')[1];

        // 排除掉被卸载包本身
        if (packageName === depName) {
          continue;
        }

        // 检查包名是否以board-开头
        if (packageName.startsWith('@aily-project/board-')) {
          const boardPath = `${appDataPath}/node_modules/${packageName}`;
          const packageJsonPath = `${boardPath}/template/package.json`;

          if (window['path'].isExists(packageJsonPath)) {
            try {
              const boardPackageJson = JSON.parse(window['fs'].readFileSync(packageJsonPath));
              // 排除当前正在卸载的开发板
              if (packageName !== packageJson.name) {
                installedBoards.push({
                  name: packageName,
                  dependencies: boardPackageJson.boardDependencies || {}
                });
              }
            } catch (error) {
              console.error(`无法读取开发板 ${packageName} 的package.json:`, error);
            }
          }
        }
      }

      // this.uiService.updateFooterState({ state: 'doing', text: this.translate.instant('NPM.UNINSTALLING_UNUSED_DEPS'), timeout: 300000 });
      this.noticeService.update({ 
        title: this.translate.instant('NPM.UNINSTALLING_TITLE'), 
        text: this.translate.instant('NPM.UNINSTALLING_UNUSED_DEPS'), 
        state: 'doing',
        showProgress: false,
        setTimeout: 300000
      });

      // 检查每个依赖是否被其他开发板使用
      console.log("installedBoards: ", installedBoards);
      await this.appDataResourceLock.runExclusive(`npm:uninstall-board-dependencies:${depName}`, async () => {
        for (const [depName, depVersion] of Object.entries(boardDependenciesToUninstall)) {
          const isUsedByOtherBoards = installedBoards.some(board =>
            board.dependencies && board.dependencies[depName] !== undefined
          );

          if (!isUsedByOtherBoards) {
            // 如果不被其他开发板使用，则卸载它
            try {
              const depPath = `${appDataPath}/node_modules/${depName}`;
              if (!window['path'].isExists(depPath)) {
                console.log(`依赖 ${depName} 未安装，跳过卸载`);
                continue;
              }

              const npmCmd = `npm uninstall ${depName} --prefix "${appDataPath}"`;
              console.log(`执行命令: ${npmCmd}, 时间: ${new Date().toISOString()}`);

              await window['npm'].run({ cmd: npmCmd });

              console.log(`依赖 ${depName} 卸载成功, 时间: ${new Date().toISOString()}`);
            } catch (error) {
              console.error(`依赖 ${depName} 卸载失败:`, error);
            }
          } else {
            console.log(`依赖 ${depName} 被其他开发板使用，跳过卸载`);
          }
        }
      });

      // this.uiService.updateFooterState({ state: 'done', text: this.translate.instant('NPM.DEPS_UNINSTALL_COMPLETE') });
      this.noticeService.update({ 
        title: this.translate.instant('NPM.UNINSTALL_COMPLETE_TITLE'), 
        text: this.translate.instant('NPM.DEPS_UNINSTALL_COMPLETE'), 
        state: 'done',
        setTimeout: 3000
      });
    } catch (error) {
      console.error('卸载开发板依赖时出错:', error);
      // this.uiService.updateFooterState({ state: 'error', text: this.translate.instant('NPM.DEPS_UNINSTALL_FAILED') });
      this.noticeService.update({ 
        title: this.translate.instant('NPM.UNINSTALL_FAILED_TITLE'), 
        text: this.translate.instant('NPM.DEPS_UNINSTALL_FAILED'), 
        state: 'error'
      });
    }
  }

  // 卸载开发板
  async uninstallBoard(board: any) {
    // const appDataPath = this.configService.data.appdata_path[this.configService.data.platform].replace('%HOMEPATH%', window['path'].getUserHome());
    const appDataPath = window['path'].getAppDataPath();
    const packageJson = JSON.parse(window['fs'].readFileSync(`${appDataPath}/node_modules/${board.name}/template/package.json`));
    // 卸载开发板
    const cmd = `npm uninstall ${board.name} --prefix "${appDataPath}"`;
    // this.uiService.updateFooterState({ state: 'doing', text: this.translate.instant('NPM.UNINSTALLING', { name: board.name }), timeout: 300000 });
    this.noticeService.update({ 
      title: this.translate.instant('NPM.UNINSTALLING_TITLE'), 
      text: this.translate.instant('NPM.UNINSTALLING', { name: board.name }), 
      state: 'doing',
      showProgress: false,
      setTimeout: 300000
    });
    // 添加超时保护和正确的参数名
    await this.appDataResourceLock.runExclusive(`npm:uninstall-board:${board.name}`, () => window['npm'].run({ cmd: cmd }));
    // this.uiService.updateFooterState({ state: 'done', text: this.translate.instant('NPM.BOARD_UNINSTALL_COMPLETE') });
    this.noticeService.update({ 
      title: this.translate.instant('NPM.UNINSTALL_COMPLETE_TITLE'), 
      text: this.translate.instant('NPM.BOARD_UNINSTALL_COMPLETE'), 
      state: 'done',
      setTimeout: 3000
    });

    return packageJson;
  }

  // 通用安装方法
  private async installPackage(packageInfo: any, type: string, version?: string) {
    // const appDataPath = this.configService.data.appdata_path[this.configService.data.platform].replace('%HOMEPATH%', window['path'].getUserHome());
    const appDataPath = window['path'].getAppDataPath();

    if (!packageInfo || !packageInfo.name) {
      throw new Error(this.translate.instant('NPM.NAME_REQUIRED', { type: type }));
    }

    try {
      await this.appDataResourceLock.runExclusive(`npm:install-package:${packageInfo.name}`, async () => {
        if (version) {
          const nmPath = `${appDataPath}/node_modules/${packageInfo.name}`;
          const pjPath = `${nmPath}/package.json`;
          let installedVer: string | undefined;
          if (window['path'].isExists(pjPath)) {
            try {
              const pj = JSON.parse(window['fs'].readFileSync(pjPath, 'utf8'));
              if (this.depVersionSatisfiesDecl(pj.version, String(version))) {
                console.log(`${type} ${packageInfo.name} 已安装且满足版本声明，跳过 npm install`);
                return;
              }
              installedVer = pj.version;
            } catch {
              /* 无法读取版本时不按「更高版」卸载 */
            }
          }
          if (
            window['path'].isExists(nmPath) &&
            installedVer !== undefined &&
            this.installedIsNewerThanDeclared(installedVer, String(version))
          ) {
            await this.cmdService.runAsyncChecked(
              `npm uninstall ${packageInfo.name} --prefix "${appDataPath}"`,
              appDataPath
            );
          }
        }

        const packageName = version ? `${packageInfo.name}@${version}` : packageInfo.name;
        const cmd = `npm install ${packageName} --save-exact --prefix "${appDataPath}"`;

        // this.uiService.updateFooterState({ state: 'doing', text: this.translate.instant('NPM.INSTALLING', { name: packageInfo.name }), timeout: 300000 });
        this.noticeService.update({ 
          title: this.translate.instant('NPM.INSTALLING_TITLE'), 
          text: this.translate.instant('NPM.INSTALLING', { name: packageInfo.name }), 
          state: 'doing',
          showProgress: false,
          setTimeout: 300000
        });

        await this.cmdService.runAsyncChecked(cmd, appDataPath);
      });

      // this.uiService.updateFooterState({ state: 'done', text: this.translate.instant('NPM.INSTALL_COMPLETE', { name: packageInfo.name }) });
      this.noticeService.update({ 
        title: this.translate.instant('NPM.INSTALL_COMPLETE_TITLE'), 
        text: this.translate.instant('NPM.INSTALL_COMPLETE', { name: packageInfo.name }), 
        state: 'done',
        setTimeout: 3000
      });
    } catch (error) {
      // this.uiService.updateFooterState({ state: 'error', text: this.translate.instant('NPM.INSTALL_FAILED', { name: packageInfo.name }) });
      this.noticeService.update({ 
        title: this.translate.instant('NPM.INSTALL_FAILED_TITLE'), 
        text: this.translate.instant('NPM.INSTALL_FAILED', { name: packageInfo.name }), 
        state: 'error'
      });
      throw error;
    }
  }

  // 安装工具
  async installTool(tool: any) {
    await this.installPackage(tool, this.translate.instant('NPM.TYPE_TOOL'), tool?.version);
  }

  // 安装SDK
  async installSDK(sdk: any) {
    await this.installPackage(sdk, this.translate.instant('NPM.TYPE_SDK'));
  }

  // 安装编译器
  async installCompiler(compiler: any) {
    await this.installPackage(compiler, this.translate.instant('NPM.TYPE_COMPILER'), compiler?.version);
  }

  // 通用卸载方法
  private async uninstallPackage(packageInfo: any, type: string) {
    // const appDataPath = this.configService.data.appdata_path[this.configService.data.platform].replace('%HOMEPATH%', window['path'].getUserHome());
    const appDataPath = window['path'].getAppDataPath();

    if (!packageInfo || !packageInfo.name) {
      throw new Error(this.translate.instant('NPM.NAME_REQUIRED', { type: type }));
    }

    const packageNodeModulesPath = `${appDataPath}/node_modules/${packageInfo.name}`;
    if (!window['path'].isExists(packageNodeModulesPath)) {
      console.log(`${type} ${packageInfo.name} 未安装，跳过卸载`);
      return;
    }

    // 尝试执行包的清理脚本
    // let cmd = `cd /d "${packageNodeModulesPath}" && npm run uninstall`;
    // try {
    //   await window['npm'].run({ cmd: cmd });
    // } catch (error) {
    //   console.log(`${type}执行清理失败:`, error);
    // }

    // this.uiService.updateFooterState({ state: 'doing', text: this.translate.instant('NPM.UNINSTALLING', { name: packageInfo.name }), timeout: 300000 });
    this.noticeService.update({ 
      title: this.translate.instant('NPM.UNINSTALLING_TITLE'), 
      text: this.translate.instant('NPM.UNINSTALLING', { name: packageInfo.name }), 
      state: 'doing',
      showProgress: false,
      setTimeout: 300000
    });

    let cmd = `npm run uninstall`
    console.log("PackageNodeModulesPath: ", packageNodeModulesPath);
    await this.appDataResourceLock.runExclusive(`npm:run-uninstall-script:${packageInfo.name}`, () => this.cmdService.runAsyncChecked(cmd, packageNodeModulesPath));

    // 卸载包
    cmd = `npm uninstall ${packageInfo.name} --prefix "${appDataPath}"`;
    // await window['npm'].run({ cmd: cmd });
    await this.appDataResourceLock.runExclusive(`npm:uninstall-package:${packageInfo.name}`, () => this.cmdService.runAsyncChecked(cmd, appDataPath));
    // this.uiService.updateFooterState({ state: 'done', text: this.translate.instant('NPM.UNINSTALL_COMPLETE', { name: packageInfo.name }) });
    this.noticeService.update({ 
      title: this.translate.instant('NPM.UNINSTALL_COMPLETE_TITLE'), 
      text: this.translate.instant('NPM.UNINSTALL_COMPLETE', { name: packageInfo.name }), 
      state: 'done',
      setTimeout: 3000
    });
  }

  // 卸载SDK
  async uninstallSDK(sdk: any) {
    await this.uninstallPackage(sdk, this.translate.instant('NPM.TYPE_SDK'));
  }

  // 卸载工具
  async uninstallTool(tool: any) {
    await this.uninstallPackage(tool, this.translate.instant('NPM.TYPE_TOOL'));
  }

  // 卸载编译器
  async uninstallCompiler(compiler: any) {
    await this.uninstallPackage(compiler, this.translate.instant('NPM.TYPE_COMPILER'));
  }

  // 指定获取packageName的可用版本列表
  async getPackageVersionList(packageName: string): Promise<string[]> {
    let data = JSON.parse(await window['npm'].run({ cmd: `npm view ${packageName} versions --json` }))
    let packageVersionList = [];
    if (typeof data === 'string') {
      packageVersionList.push(data);
    } else {
      packageVersionList = data;
    }
    return packageVersionList;
  }

  async getInstalledPackageList(path) {
    let data = JSON.parse(await window['npm'].run({ cmd: `npm list --depth=0 --json --prefix "${path}"` }));
    let installedPackageList = [];
    for (let key in data.dependencies) {
      const item = data.dependencies[key];
      installedPackageList.push(key + '@' + item.version);
    }
    return installedPackageList;
  }

  /**
   * 检查 npm 依赖是否安装完整（仅检查第一层）
   * 通过读取 package.json 的依赖声明，再扫描 node_modules 下对应包的 package.json 做对比
   */
  async installedOk(path) {
    const startTime = performance.now();
    console.log('[installedOk] 开始检查依赖状态...');
    try {
      const packageJsonPath = window['path'].join(path, 'package.json');
      const nodeModulesPath = window['path'].join(path, 'node_modules');

      if (!window['path'].isExists(packageJsonPath)) {
        const elapsed = (performance.now() - startTime).toFixed(1);
        console.log(`[installedOk] package.json 不存在，耗时: ${elapsed}ms`);
        return false;
      }

      const packageJson = JSON.parse(window['fs'].readFileSync(packageJsonPath, 'utf8'));
      const deps = { ...(packageJson.dependencies || {}), ...(packageJson.devDependencies || {}) };
      const depNames = Object.keys(deps);

      if (depNames.length === 0) {
        const elapsed = (performance.now() - startTime).toFixed(1);
        console.log(`[installedOk] 无依赖声明，检查通过，耗时: ${elapsed}ms`);
        return true;
      }

      if (!window['path'].isExists(nodeModulesPath)) {
        const elapsed = (performance.now() - startTime).toFixed(1);
        console.log(`[installedOk] node_modules 不存在，依赖未安装，耗时: ${elapsed}ms`);
        return false;
      }

      for (const name of depNames) {
        const depPackageJsonPath = window['path'].join(nodeModulesPath, name, 'package.json');
        if (!window['path'].isExists(depPackageJsonPath)) {
          const elapsed = (performance.now() - startTime).toFixed(1);
          console.log(`[installedOk] 缺少依赖: ${name}，耗时: ${elapsed}ms`);
          return false;
        }
      }

      const elapsed = (performance.now() - startTime).toFixed(1);
      console.log(`[installedOk] 检查完成，依赖已完整，耗时: ${elapsed}ms`);
      return true;
    } catch (err) {
      const elapsed = (performance.now() - startTime).toFixed(1);
      console.log(`[installedOk] 检查异常，耗时: ${elapsed}ms`, err);
      return false;
    }
  }

  /**
   * Blockly / Aily Code 打开工程共用：package.json 声明的依赖与 node_modules 不一致时在项目目录执行 npm install，并用通知反馈进度。
   * @param projectPath 项目根路径
   * @param options.onRetryInstall 若设置，安装失败时通知条展示「重试」并调用此回调（由调用方再次传入本方法以复跑安装）
   * @returns 依赖已就绪 true；安装失败 false
   */
  async ensureProjectDependenciesInstalled(
    projectPath: string,
    options?: { onRetryInstall?: () => void },
  ): Promise<boolean> {
    // 已完整安装则不再跑 npm install，缩短冷启动
    if (await this.installedOk(projectPath)) {
      return true;
    }

    // 与 Blockly 一致：下一帧再挂通知，避免变更检测/弹层偶发不同步
    setTimeout(() => {
      this.noticeService.update({
        title: this.translate.instant('NPM.INSTALLING_TITLE'),
        text: this.translate.instant('BLOCKLY_EDITOR.INSTALLING_DEPS'),
        state: 'doing',
        icon: 'fa-light fa-cubes',
        showProgress: false,
      });
    }, 0);

    const npmResult = await this.cmdService.runAsync(`npm install`, projectPath);

    if (!(await this.installedOk(projectPath))) {
      setTimeout(() => {
        this.noticeService.update({
          title: this.translate.instant('NPM.INSTALL_FAILED_TITLE'),
          text: this.translate.instant('NPM.BOARD_DEPS_INSTALL_FAILED'),
          detail: npmResult?.stderr || 'npm install 执行完成但依赖检查未通过',
          state: 'error',
          sendToLog: false,
          ...(options?.onRetryInstall ? { onRetry: options.onRetryInstall } : {}),
        });
      }, 1000);
      return false;
    }

    setTimeout(() => {
      this.noticeService.update({
        title: this.translate.instant('NPM.INSTALL_COMPLETE_TITLE'),
        text: this.translate.instant('NPM.DEPS_INSTALL_COMPLETE'),
        state: 'done',
        showProgress: false,
        setTimeout: 3000,
      });
    }, 100);
    return true;
  }

  /**
   * 库列表
   * @param data
   */
  list(data: any) {
    return this.http.get<ResponseModel>(API.projectList, {
      params: data,
    });
  }

  /**
   * 库搜索
   * @param data
   * @param data.text 搜索关键字
   * @param data.size
   * @param data.from
   * @param data.quality
   * @param data.popularity
   * @param data.maintenance
   */
  search(data: any) {
    return this.http.get<SearchResponseModel>(API.projectSearch, {
      params: data,
    });
  }

  async getAllInstalledLibraries(path: string) {
    // let data = JSON.parse(await window['npm'].run({ cmd: `npm ls --all --json --prefix "${path}"` }));
    let data = await getInstalledPackagesByFileRead(path);
    // console.log("getInstalledPackagesByFileRead:", data);
    // 提取所有依赖项到对象数组
    const allDependencies = this.extractAllDependencies(data.dependencies || {});

    // 过滤出以 @aily-project/lib- 开头的库
    const libraryModules = allDependencies.filter(dep => dep.name.startsWith('@aily-project/lib-'));

    // 让包含@aily-project/lib-core-的模块在最前面
    libraryModules.sort((a, b) => {
      if (a.name.startsWith('@aily-project/lib-core-') && !b.name.startsWith('@aily-project/lib-core-')) {
        return -1;
      } else if (!a.name.startsWith('@aily-project/lib-core-') && b.name.startsWith('@aily-project/lib-core-')) {
        return 1;
      } else {
        return a.name.localeCompare(b.name);
      }
    });

    // console.log('libraryModules:', libraryModules);
    
    return libraryModules;
  }

  /**
   * 递归提取所有依赖项（包括子依赖）到对象数组
   * @param dependencies 依赖对象
   * @returns 包含所有依赖项完整信息的对象数组
   */
  private extractAllDependencies(dependencies: any): Array<any> {
    const dependencyMap = new Map<string, any>();

    const extractRecursively = (deps: any) => {
      if (!deps || typeof deps !== 'object') {
        return;
      }

      for (const [packageName, packageInfo] of Object.entries(deps)) {
        // 保留packageInfo的所有信息，并添加name属性
        if (packageInfo && typeof packageInfo === 'object') {
          const fullPackageInfo = {
            name: packageName,
            ...packageInfo
          };
          
          // 添加当前包的完整信息到Map中（避免重复）
          dependencyMap.set(packageName, fullPackageInfo);

          // 如果有子依赖，递归处理
          if (packageInfo['dependencies']) {
            extractRecursively(packageInfo['dependencies']);
          }
        } else {
          // 如果packageInfo不是对象，创建基本信息对象
          dependencyMap.set(packageName, {
            name: packageName,
            version: packageInfo || 'unknown'
          });
        }
      }
    };

    extractRecursively(dependencies);

    // 转换为对象数组并排序
    return Array.from(dependencyMap.values())
      .sort((a, b) => a.name.localeCompare(b.name));
  }
}

interface BoardDependencyToInstall {
  name: string;
  version: string;
  needUninstallForDowngrade: boolean;
}

interface BoardDependencyInstallProgress {
  total: number;
  index: number;
  name: string;
  downloadProgress: number;
  extractProgress: number;
  lastProgress: number;
}

export interface SearchResponseModel {
  objects: any[],
  time: string,
  total: number
}

export interface ResponseModel {
  status: number;
  messages: string;
  data: any;
}

/**
 * 通过读取文件的方式获取已安装的包信息，模拟 npm ls --all --json 的效果
 * @param projectPath 项目路径
 * @returns 类似 npm ls 的数据结构
 */
export async function getInstalledPackagesByFileRead(projectPath: string): Promise<any> {
  const nodeModulesPath = `${projectPath}/node_modules`;

  // 检查 node_modules 目录是否存在
  if (!window['path'].isExists(nodeModulesPath)) {
    return { dependencies: {} };
  }

  const dependencies = {};

  // 递归扫描 node_modules 目录
  await scanNodeModulesDirectory(nodeModulesPath, dependencies);

  return {
    name: 'project',
    version: '1.0.0',
    dependencies: dependencies
  };
}

/**
 * 递归扫描 node_modules 目录
 * @param nodeModulesPath node_modules 目录路径
 * @param dependencies 依赖对象
 */
export async function scanNodeModulesDirectory(nodeModulesPath: string, dependencies: any): Promise<void> {
  try {
    const dirs = window['fs'].readDirSync(nodeModulesPath);

    for (const dir of dirs) {
      // 跳过 .bin 等特殊目录
      if (dir.name && dir.name.startsWith('.')) {
        continue;
      }

      const dirName = dir.name || dir; // 兼容不同的 readDirSync 返回格式
      const packagePath = `${nodeModulesPath}/${dirName}`;

      // 检查是否是目录
      if (!window['fs'].isDirectory(packagePath)) {
        continue;
      }

      if (dirName.startsWith('@')) {
        // 处理 scoped packages (如 @aily-project/lib-xxx)
        await scanScopedPackages(packagePath, dependencies);
      } else {
        // 处理普通包
        await scanSinglePackage(packagePath, dirName, dependencies);
      }
    }
  } catch (error) {
    console.error('扫描 node_modules 目录失败:', error);
  }
}

/**
 * 扫描 scoped packages
 * @param scopePath scope 目录路径
 * @param dependencies 依赖对象
 */
export async function scanScopedPackages(scopePath: string, dependencies: any): Promise<void> {
  try {
    const scopeDirs = window['fs'].readDirSync(scopePath);
    const scopeName = window['path'].basename(scopePath);

    for (const dir of scopeDirs) {
      const dirName = dir.name || dir;
      const packageName = `${scopeName}/${dirName}`;
      const packagePath = `${scopePath}/${dirName}`;

      if (window['fs'].isDirectory(packagePath)) {
        await scanSinglePackage(packagePath, packageName, dependencies);
      }
    }
  } catch (error) {
    console.error('扫描 scoped packages 失败:', error);
  }
}

/**
 * 扫描单个包
 * @param packagePath 包路径
 * @param packageName 包名
 * @param dependencies 依赖对象
 */
export async function scanSinglePackage(packagePath: string, packageName: string, dependencies: any): Promise<void> {
  try {
    const packageJsonPath = `${packagePath}/package.json`;
    const toolboxJsonPath = `${packagePath}/toolbox.json`;
    // 检查 package.json 和 toolbox.json 是否存在
    if (!window['fs'].existsSync(packageJsonPath) || !window['fs'].existsSync(toolboxJsonPath)) {
      return;
    }

    // 读取 package.json
    const packageJson = readJsonFileForPackageScan(packageJsonPath, 'package.json');
    // 读取 toolbox.json
    const toolboxJson = readJsonFileForPackageScan(toolboxJsonPath, 'toolbox.json');
    // 构建包信息
    const packageInfo: any = {
      version: packageJson.version || '1.0.0',
      description: packageJson.description || '',
      author: packageJson.author || 'unknown',
      nickname: packageJson.nickname || packageJson.name,
      icon: toolboxJson.icon || 'fa-light fa-cube',
      keywords: packageJson.keywords || [],
    };

    // 检查是否有子依赖
    const subNodeModulesPath = `${packagePath}/node_modules`;
    if (window['fs'].existsSync(subNodeModulesPath)) {
      packageInfo.dependencies = {};
      await scanNodeModulesDirectory(subNodeModulesPath, packageInfo.dependencies);
    }

    dependencies[packageName] = packageInfo;
  } catch (error) {
    console.error(`扫描包 ${packageName} 失败:`, error);
  }
}

function readJsonFileForPackageScan(filePath: string, fileName: string): any {
  let content: string;
  try {
    content = window['fs'].readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new Error(`${fileName} 读取失败 (${filePath}): ${formatPackageScanError(error)}`);
  }

  try {
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`${fileName} 格式错误 (${filePath}): ${formatPackageScanError(error)}`);
  }
}

function formatPackageScanError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

