import { Inject, Injectable } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { NzMessageService } from 'ng-zorro-antd/message';
import { Subscription } from 'rxjs';
import {
  CmdOutput,
  CmdService,
  CrossPlatformCmdService,
  ElectronService,
  LogService,
  PlatformService,
} from '@core/platform/public-api';
import { ProjectService, coderSourceDirectory } from '@domain/project/public-api';
import { NpmService } from '@domain/dependencies/public-api';
import { ConfigService } from '@core/preferences/public-api';
import { CompileValidationService } from './compile-validation.service';
import { CoderBuildInfoService } from './coder-build-info.service';
import { writeBuildRequest, captureBuildRequestGuard } from '../../../utils/build-request.utils';
import { captureBuildSource } from '../../../utils/build-publication.utils';
import { runCloudBuildWithProgress, cloudBuildProgressPresentation } from '../../../utils/cloud-build-progress.utils';
import {
  BUILD_APPLICATION_PORT,
  type BuildActionState,
  type BuildApplicationPort,
} from './ports/build-application.port';
import {
  AilyBuilderOutputLine,
  AilyBuilderOutputLineBuffer,
  AilyBuilderProgressEvent,
  isAilyBuilderProgressLine,
  parseAilyBuilderProgressLine,
  parseLegacyAilyBuilderProgressLine,
} from '../../../utils/aily-builder-progress.utils';
import {
  appendProjectLog,
  ProjectLogLevel,
} from '../../../utils/project-log.utils';

interface DiskCompileOptions {
  preprocessOnly?: boolean;
  projectPath?: string;
  code?: string;
  recordProjectDelivery?: boolean;
  graphSemanticRevision?: string;
}

interface DiskCompileProgressState {
  percent: number;
  text: string;
  hasStructuredProgress: boolean;
}

interface OneShotCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  combined: string;
  signal: string | null;
}

/** 固定本次 Coder 构建的后端和配置身份，设置切换后拒绝继续发布旧任务结果。 */
interface DiskCompileContext {
  cloud: boolean;
  settingsKey?: string;
  settings?: ReturnType<ConfigService['getCloudBuildSettings']>;
}

@Injectable({ providedIn: 'root' })
export class CompileService {
  private cancelled = false;
  private activeSub: Subscription | null = null;
  private activeStreamId: string | null = null;
  private activeCommandCancel: (() => void) | null = null;
  // 云请求独立于本地子进程；取消时等待主进程撤销远程任务后再释放构建锁。
  private activeCloudRequestId: string | null = null;
  private stopPending: Promise<unknown> = Promise.resolve();

  constructor(
    private projectService: ProjectService,
    private cmdService: CmdService,
    private crossPlatformCmdService: CrossPlatformCmdService,
    private electronService: ElectronService,
    @Inject(BUILD_APPLICATION_PORT)
    private application: BuildApplicationPort,
    private platformService: PlatformService,
    private configService: ConfigService,
    private message: NzMessageService,
    private compileValidationService: CompileValidationService,
    private logService: LogService,
    private translate: TranslateService,
    private coderBuildInfo: CoderBuildInfoService,
    private npmService: NpmService,
  ) { }

  cancel(): void {
    this.cancelled = true;
    const streamId = this.activeStreamId;
    if (streamId) {
      this.stopPending = this.cmdService.kill(streamId).catch((error) => {
        console.warn('Failed to stop the active build process:', error);
      });
      this.activeStreamId = null;
    }
    // Resolve the current command immediately as cancelled. Merely
    // unsubscribing leaves runCompileFromDisk awaiting a Promise forever.
    this.activeCommandCancel?.();
    const requestId = this.activeCloudRequestId;
    if (requestId) {
      this.stopPending = Promise.all([this.stopPending, Promise.resolve().then(() => window['cloudBuild'].cancel({ requestId }))]).catch(() => {
        // 主进程负责重试远程取消并使该请求失效，界面无需重复提交取消请求。
      });
    }
  }

  async runCompileFromDisk(options: DiskCompileOptions = {}): Promise<{ success: boolean; result: BuildActionState & { fullStdErr?: string } }> {
    const root = (options.projectPath || this.projectService.currentProjectPath || '').trim();
    const context: DiskCompileContext = {
      cloud: this.configService.getCompileBackend() === 'cloud',
      settingsKey: this.configService.getCompileSettingsKey(),
    };
    if (context.cloud) context.settings = { ...this.configService.getCloudBuildSettings() };

    if (context.cloud && ((options.recordProjectDelivery !== undefined && options.recordProjectDelivery !== false)
      || (options.graphSemanticRevision !== undefined && options.graphSemanticRevision !== ''))) {
      return { success: false, result: { state: 'error', text: 'PROTOCOL_UNSUPPORTED: Cloud compilation does not support simulator or delivery builds.' } };
    }

    if (!root) {
      this.message.warning('No project is currently open.');
      return {
        success: false,
        result: { state: 'warn', text: 'No project is currently open; build cannot start.' },
      };
    }

    const dependencyBlock = this.projectService.getProjectDependencyBlockMessage(root);
    if (dependencyBlock) {
      this.message.warning(dependencyBlock);
      return { success: false, result: { state: 'warn', text: dependencyBlock } };
    }

    if (this.configService.isCoderProduct()) {
      try {
        await this.npmService.assertCoderDependenciesReady(root);
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        this.message.warning(text);
        return { success: false, result: { state: 'warn', text } };
      }
    }

    if (!this.application.startBuild()) {
      const state = this.application.currentProcessState;
      let msg = 'System is busy';
      if (state === 'BUILDING') {
        msg = 'Build is already running';
      } else if (state === 'UPLOADING') {
        msg = 'Upload is already running';
      } else if (state === 'INSTALLING') {
        msg = 'Dependency installation is already running';
      }
      this.message.warning(`${msg}; please try again later.`);
      return { success: false, result: { state: 'warn', text: msg } };
    }

    this.cancelled = false;
    this.stopPending = Promise.resolve();
    this.application.updateNotice({ title: this.t('PREPARING_TITLE'), text: this.t('DEPENDENCY_ANALYSIS_RUNNING'),
      state: 'doing', progress: 0, setTimeout: 0, stop: () => this.cancel() });
    try {
      // Keep the root captured at submission, even if the UI switches projects.
      return await this.runCompile(root, options, context);
    } catch (error: any) {
      const text = this.cancelled ? this.t('CANCELLED_TITLE') : error?.message || String(error);
      this.application.finishBuild(false, text);
      if (this.cancelled) this.updateCancelledNotice(text);
      else this.handleFailNotice(root, this.t('FAILED_TITLE'), text, text);
      return { success: false, result: { state: this.cancelled ? 'warn' : 'error', text } };
    }
  }

  private async runCompile(root: string, options: DiskCompileOptions, context: DiskCompileContext): Promise<{ success: boolean; result: BuildActionState & { fullStdErr?: string } }> {
    const packagePath = this.electronService.pathJoin(root, 'package.json');
    const isAilyCodeProject = this.projectService.isAilyCodeProject(root);
    const source = this.readCompileSource(root, packagePath, isAilyCodeProject, options.code);
    if (source.success === false) {
      this.handleFailNotice(root, this.t('FAILED_TITLE'), source.error, source.error);
      this.application.finishBuild(false, source.error);
      return { success: false, result: { state: 'error', text: source.error } };
    }
    const started = Date.now();
    let compiledHash: string | undefined;
    let buildStatus: 'success' | 'failed' = 'failed';
    let finishReason: string | undefined;

    try {
      const assertCloudContext = () => {
        if (!context.cloud) return;
        if (this.configService.getCompileSettingsKey() !== context.settingsKey
          || this.projectService.currentProjectPath !== root) {
          throw new Error('BUILD_SOURCE_STALE: Cloud build settings or the active project changed; build again.');
        }
      };
      assertCloudContext();
      if (!context.cloud) await window['cloudBuild']?.invalidate?.({ projectPath: root });
      // Ignore only publisher-owned result metadata, which updateCodeHash writes.
      const assertManifest = captureBuildRequestGuard(() => {
        const { codeHash: _hash, buildInfo: _info, ...manifest } = JSON.parse(window['fs'].readFileSync(packagePath, 'utf8'));
        return manifest;
      });
      if (isAilyCodeProject) {
        compiledHash = await this.coderBuildInfo.updateCodeHash(root);
      }
      const boardModule = await this.resolveBoardModule(root);
      assertManifest();
      assertCloudContext();
      if (!boardModule) {
        finishReason = 'Missing board module';
        const text = isAilyCodeProject ? '请先在顶部选择开发板，再编译或上传 Arduino 工程。' : 'Cannot resolve board module from the active project.';
        this.handleFailNotice(root, this.t('FAILED_TITLE'), text, text);
        return { success: false, result: { state: 'error', text } };
      }

      const boardName = boardModule.replace('@aily-project/board-', '').replace('@aily-project/coder-', '');
      let cloudProfile: Awaited<ReturnType<ProjectService['getCloudBoardProfile']>> | undefined;
      // 云模式按目标能力准备源码和元数据，不检查或安装本机编译器路径。
      if (context.cloud) {
        await this.npmService.ensureCloudLibrarySources(root);
        assertManifest(); assertCloudContext();
        cloudProfile = await this.projectService.getCloudBoardProfile({ refresh: true });
        assertManifest(); assertCloudContext();
        if (cloudProfile.boardModule !== boardModule) throw new Error('BUILD_SOURCE_STALE: The selected cloud board changed.');
        const action = options.preprocessOnly ? 'analysis' : 'compile';
        if (cloudProfile['capabilities']?.[action] !== true) {
          throw new Error(options.preprocessOnly
            ? '当前云编译节点不支持预处理/代码分析，请选择支持 analysis 的节点。'
            : '当前云编译节点不支持 compile。');
        }
      }
      const ailyBuilderPath = context.cloud ? undefined : window['path'].getAilyBuilderPath();
      const ailyChildPath = context.cloud ? undefined : window['path'].getAilyChildPath();

      if (!context.cloud && (!ailyBuilderPath || !ailyChildPath)) {
        finishReason = 'Missing builder paths';
        const text = 'aily-builder path is unavailable.';
        this.handleFailNotice(root, this.t('FAILED_TITLE'), text, text);
        return { success: false, result: { state: 'error', text } };
      }

      const buildTitle = this.buildNoticeTitle(boardName);
      const preparingText = this.t('DEPENDENCY_ANALYSIS_RUNNING');
      this.application.updateNotice({
        title: this.t('PREPARING_TITLE'),
        text: preparingText,
        state: 'doing',
        progress: 0,
        setTimeout: 0,
        stop: () => this.cancel(),
      });
      this.publishBuildLog(root, preparingText, 'stdout', 'doing', buildTitle);

      const buildConfig = this.createBuildConfig(root, boardModule, source.code, isAilyCodeProject, context, options);
      const sourceCapture = captureBuildSource(buildConfig);
      assertManifest();
      assertCloudContext();
      if (this.cancelled) throw new Error('Build cancelled before launch.');

      // 云端分析/编译和本地执行共用源码捕获，后续由主进程校验并保存可烧录产物。
      if (context.cloud) {
        const result = await this.runCloudCompile(root, { ...buildConfig, sourceCapture }, context.settings!,
          cloudProfile!.profileDigest, options.preprocessOnly ? 'analysis' : 'compile', boardName, context.settingsKey);
        assertCloudContext(); assertManifest();
        if (this.cancelled) throw new Error('Cloud build cancelled.');
        if (result?.success !== true) throw new Error(result?.text || 'Cloud compilation failed.');
        buildStatus = 'success';
        if (!options.preprocessOnly) this.compileValidationService.triggerAfterSuccessfulCompile();
        const seconds = ((Date.now() - started) / 1000).toFixed(2);
        const completeText = options.preprocessOnly ? '云端预处理完成'
          : result.reused === true ? this.translate.instant('CLOUD_BUILD.REUSED_RESULT', { seconds })
          : this.translate.instant('CLOUD_BUILD.COMPLETE_WITH_TIME', { seconds });
        this.application.updateNotice({ title: this.t('COMPLETE_TITLE'), text: completeText, state: 'done', setTimeout: 600000 });
        this.publishBuildLog(root, completeText, 'stdout', 'done', this.t('COMPLETE_TITLE'));
        return { success: true, result: { state: 'done', text: completeText } };
      }

      const configFilePath = await writeBuildRequest(root, { ...buildConfig, sourceCapture }, {
        join: (...parts) => this.electronService.pathJoin(...parts),
        exists: filename => window['path'].isExists(filename),
        mkdir: directory => this.crossPlatformCmdService.createDirectory(directory, true),
        write: (filename, text) => window['fs'].writeFileSync(filename, text),
      });
      assertManifest();
      if (this.cancelled) throw new Error('Build cancelled before launch.');

      // Normal compile.js owns its preprocessing transaction; do not perform
      // the same mutable preparation twice with an unlocked gap in between.
      if (options.preprocessOnly) {
        const preprocessScriptPath = this.electronService.pathJoin(ailyChildPath, 'scripts', 'preprocess.js');
        const pre = await this.runOneShotCommand({ scriptPath: preprocessScriptPath, configFilePath }, (line) => {
          this.publishBuildLog(root, line.line, line.type);
        }, root);
        if (this.cancelled) {
          finishReason = 'Cancelled';
          const sec = ((Date.now() - started) / 1000).toFixed(2);
          const text = this.t('CANCELLED_WITH_TIME', { seconds: sec });
          this.publishBuildLog(root, text, 'stdout', 'warn', this.t('CANCELLED_TITLE'));
          this.updateCancelledNotice(text);
          return { success: false, result: { state: 'warn', text } };
        }
        if (pre.exitCode !== 0) {
          const detail = pre.combined || pre.stderr + pre.stdout;
          finishReason = 'Preprocess failed';
          this.handleFailNotice(
            root,
            this.t('PRECOMPILE_FAILED_TITLE'),
            this.t('PRECOMPILE_FAILED_DETAIL'),
            detail,
          );
          return {
            success: false,
            result: {
              state: 'error',
              text: this.t('MESSAGE_WITH_DURATION', {
                message: this.t('PRECOMPILE_FAILED_TITLE'),
                seconds: ((Date.now() - started) / 1000).toFixed(2),
              }),
              fullStdErr: detail,
            },
          };
        }

        buildStatus = 'success';
        const completeText = this.t('PRECOMPILE_COMPLETE_TITLE');
        this.application.updateNotice({ title: completeText, text: completeText,
          state: 'done', progress: 100, setTimeout: 3000 });
        return { success: true, result: { state: 'done', text: completeText } };
      }

      const compileScriptPath = this.electronService.pathJoin(ailyChildPath, 'scripts', 'compile.js');
      const progressState: DiskCompileProgressState = {
        percent: 0,
        text: this.t('FAST_BUILD_HINT'),
        hasStructuredProgress: false,
      };
      this.application.updateNotice({
        title: buildTitle,
        text: progressState.text,
        state: 'doing',
        progress: 0,
        setTimeout: 0,
        stop: () => this.cancel(),
      });
      const cmp = await this.runOneShotCommand({ scriptPath: compileScriptPath, configFilePath,
        ...(options.recordProjectDelivery === true ? { buildDeliveryRequest: configFilePath } : {}) }, (line) => {
        if (this.consumeBuildProgressLine(line.line, boardName, progressState)) {
          return;
        }
        this.publishBuildLog(root, line.line, line.type);
      }, root);
      const buildDuration = ((Date.now() - started) / 1000).toFixed(2);

      if (this.cancelled) {
        finishReason = 'Cancelled';
        const text = this.t('CANCELLED_WITH_TIME', { seconds: buildDuration });
        this.publishBuildLog(root, text, 'stdout', 'warn', this.t('CANCELLED_TITLE'));
        this.updateCancelledNotice(text);
        return { success: false, result: { state: 'warn', text } };
      }

      if (cmp.exitCode !== 0) {
        const detail = cmp.combined || cmp.stderr + cmp.stdout;
        finishReason = 'Compile failed';
        const text = this.t('FAILED_WITH_TIME', { seconds: buildDuration });
        this.handleFailNotice(root, this.t('FAILED_TITLE'), text, detail);
        return {
          success: false,
          result: { state: 'error', text, fullStdErr: detail },
        };
      }

      buildStatus = 'success';
      this.compileValidationService.triggerAfterSuccessfulCompile();
      const completeText = this.t('COMPLETE_WITH_TIME', { seconds: buildDuration });
      this.application.updateNotice({
        title: this.t('COMPLETE_TITLE'),
        text: completeText,
        state: 'done',
        setTimeout: 600000,
      });
      this.publishBuildLog(root, completeText, 'stdout', 'done', this.t('COMPLETE_TITLE'));

      return { success: true, result: { state: 'done', text: completeText } };
    } catch (e: any) {
      const msg = e?.message || String(e);
      buildStatus = 'failed';
      finishReason = this.cancelled ? 'Cancelled' : msg;
      if (this.cancelled) {
        const text = this.t('CANCELLED_WITH_TIME', { seconds: ((Date.now() - started) / 1000).toFixed(2) });
        this.publishBuildLog(root, text, 'stdout', 'warn', this.t('CANCELLED_TITLE'));
        this.updateCancelledNotice(text);
        return { success: false, result: { state: 'warn', text } };
      }
      this.message.error(msg);
      const detail = typeof e?.fullStdErr === 'string' && e.fullStdErr ? e.fullStdErr : msg;
      this.handleFailNotice(root, this.t('FAILED_TITLE'), msg, detail);
      return { success: false, result: { state: 'error', text: msg, fullStdErr: detail } };
    } finally {
      // Cancellation resolves the UI command promptly, but metadata is another
      // workspace writer: wait for supervised process-tree cleanup first.
      await this.stopPending;
      let metadataError: string | undefined;
      if (compiledHash) {
        try {
          await this.coderBuildInfo.saveBuildInfo(
            root,
            compiledHash,
            this.cancelled ? 'cancelled' : buildStatus,
            Number(((Date.now() - started) / 1000).toFixed(2)),
          );
        } catch (error: any) {
          metadataError = error?.message || 'Failed to save Coder build metadata.';
          buildStatus = 'failed';
          finishReason = metadataError;
        }
      }
      // Keep the build lock until metadata is persisted; a second build must
      // not reset cancellation state or overwrite this build's result midway.
      this.application.finishBuild(buildStatus === 'success', finishReason);
      if (metadataError) {
        this.handleFailNotice(root, this.t('FAILED_TITLE'), metadataError, metadataError);
        return { success: false, result: { state: 'error', text: metadataError } };
      }
    }
  }

  /** 首次编译和烧录前的复用检查共用输入组装，避免遗漏分区等影响固件的参数。 */
  private createBuildConfig(root: string, boardModule: string, code: string, isCoder: boolean,
    context: DiskCompileContext, options: DiskCompileOptions = {}) {
    return {
      currentProjectPath: root, boardModule, code,
      appDataPath: window['path'].getAppDataPath(), za7Path: this.platformService.za7,
      ailyBuilderPath: context.cloud ? undefined : window['path'].getAilyBuilderPath(),
      devmode: this.configService.data.devmode || false,
      ...(options.recordProjectDelivery === true ? { recordProjectDelivery: true } : {}),
      partitionFilePath: isCoder ? this.electronService.pathJoin(root, 'sketch', 'src', 'partitions.csv')
        : this.electronService.pathJoin(root, 'partitions.csv'),
    };
  }

  /** 调用方先保存编辑器，主进程再核对整个项目和库内容；一致时直接复用已校验的云产物。 */
  async canReuseCloudBuildForUpload(root: string, isCancelled: () => boolean = () => false): Promise<boolean> {
    if (this.configService.getCompileBackend() !== 'cloud' || !window['cloudBuild']?.reusable) return false;
    const settingsKey = this.configService.getCompileSettingsKey();
    const isCurrent = () => !isCancelled() && this.projectService.currentProjectPath === root
      && this.configService.getCompileSettingsKey() === settingsKey && this.configService.getCompileBackend() === 'cloud';
    try {
      if (!isCurrent() || this.projectService.getProjectDependencyBlockMessage(root)) return false;
      await this.npmService.assertCoderDependenciesReady(root);
      if (!isCurrent()) return false;
      await this.npmService.ensureCloudLibrarySources(root);
      if (!isCurrent()) return false;
      const manifestPath = this.electronService.pathJoin(root, 'package.json');
      const assertManifest = captureBuildRequestGuard(() => {
        const { codeHash: _hash, buildInfo: _info, ...manifest } = JSON.parse(window['fs'].readFileSync(manifestPath, 'utf8'));
        return manifest;
      });
      const boardModule = await this.resolveBoardModule(root);
      if (!boardModule || !isCurrent()) return false;
      const source = this.readCompileSource(root, manifestPath, true);
      if (source.success === false) return false;
      const config = this.createBuildConfig(root, boardModule, source.code, true, { cloud: true });
      const sourceCapture = captureBuildSource(config);
      // 复用已经签名且输入完全一致的产物无需重新调度目标；节点忙闲和离线不影响本地烧录。
      // 主进程仍校验原任务的完整输入、签名及逐文件哈希，新编译才刷新并锁定精确目标。
      const reusable = await window['cloudBuild'].reusable({ config: { ...config, sourceCapture } });
      assertManifest();
      return reusable === true && isCurrent();
    } catch { return false; }
  }

  /** Coder 与 Blockly 共用进度合并工具，状态立即刷新、日志批量显示，完成仍以主进程结果为准。 */
  private async runCloudCompile(
    root: string, config: unknown, settings: NonNullable<DiskCompileContext['settings']>,
    profileDigest: string, action: 'compile' | 'analysis', boardName: string, settingsKey?: string,
  ): Promise<any> {
    const gateway = window['cloudBuild'];
    const requestId = `coder_${crypto.randomUUID()}`;
    this.activeCloudRequestId = requestId;
    try {
      return await runCloudBuildWithProgress({ requestId, config, settings, profileDigest, action }, gateway, {
        isCurrent: () => this.activeCloudRequestId === requestId && !this.cancelled
          && this.projectService.currentProjectPath === root && this.configService.getCompileSettingsKey() === settingsKey,
        log: (text, stream) => this.publishBuildLog(root, text, stream),
        progress: event => {
          const presentation = cloudBuildProgressPresentation(event, key => this.translate.instant(key));
          this.application.updateNotice({ title: this.buildNoticeTitle(boardName), ...presentation,
            state: 'doing', setTimeout: 0, stop: () => this.cancel() });
        },
      });
    } finally {
      if (this.activeCloudRequestId === requestId) this.activeCloudRequestId = null;
    }
  }

  private readCompileSource(
    projectPath: string,
    packagePath: string,
    isAilyCodeProject: boolean,
    explicitCode?: string,
  ): { success: true; code: string } | { success: false; error: string } {
    if (explicitCode) {
      return { success: true, code: explicitCode };
    }

    try {
      if (isAilyCodeProject) {
        const manifest = JSON.parse(window['fs'].readFileSync(packagePath, 'utf8'));
        const entryRel = typeof manifest.entry === 'string' && manifest.entry.trim()
          ? manifest.entry.replace(/\\/g, '/')
          : 'src/main.cpp';
        const segments = entryRel.split('/').filter(Boolean);
        if (
          entryRel.startsWith('/')
          || /^[A-Za-z]:\//.test(entryRel)
          || segments.some(segment => segment === '..')
        ) {
          return { success: false, error: `Invalid Coder entry outside sketch workspace: ${entryRel}` };
        }
        const sourcePath = this.electronService.pathJoin(projectPath, coderSourceDirectory(manifest), ...segments);
        if (!window['path'].isExists(sourcePath)) {
          return { success: false, error: `Entry file does not exist: ${entryRel}` };
        }
        return { success: true, code: window['fs'].readFileSync(sourcePath, 'utf8') };
      }

      const sketchPath = this.electronService.pathJoin(projectPath, '.temp', 'sketch', 'sketch.ino');
      if (!window['path'].isExists(sketchPath)) {
        return {
          success: false,
          error: 'Missing Blockly generated file .temp/sketch/sketch.ino; sync or generate Blockly code before building.',
        };
      }
      return { success: true, code: window['fs'].readFileSync(sketchPath, 'utf8') };
    } catch (error: any) {
      return { success: false, error: error?.message || 'Failed to read project compile source.' };
    }
  }

  private async resolveBoardModule(projectPath: string): Promise<string | null> {
    if (!projectPath) {
      return null;
    }

    try {
      const packageJsonPath = this.electronService.pathJoin(projectPath, 'package.json');
      if (window['path'].isExists(packageJsonPath)) {
        const packageJson = JSON.parse(window['fs'].readFileSync(packageJsonPath, 'utf8'));
        const dependencyNames = [
          ...Object.keys(packageJson.dependencies || {}),
          ...Object.keys(packageJson.devDependencies || {}),
          ...Object.keys(packageJson.boardDependencies || {}),
        ];
        const boardModule = dependencyNames.find(dep => dep.startsWith('@aily-project/board-'))
          ?? dependencyNames.find(dep => dep.startsWith('@aily-project/coder-'));
        if (boardModule) {
          return boardModule;
        }
      }
    } catch {
      /* fall through to Aily Code project metadata/current project service */
    }

    return projectPath === this.projectService.currentProjectPath
      ? this.projectService.getBoardModule()
      : null;
  }

  private t(key: string, params?: Record<string, unknown>): string {
    return this.translate.instant(`BLOCKLY_EDITOR.BUILD.${key}`, params);
  }

  private buildNoticeTitle(boardName: string): string {
    return this.t('RUNNING_TITLE', { board: boardName });
  }

  private buildProgressText(progress: AilyBuilderProgressEvent): string {
    const translationKey = `BLOCKLY_EDITOR.BUILD.PROGRESS_${progress.stage.toUpperCase()}`;
    const translated = this.translate.instant(translationKey);
    return translated === translationKey ? progress.message : translated;
  }

  /**
   * Consume the same aily-builder progress contract used by Blockly builds.
   * Structured protocol lines are UI events and must not leak into the log.
   */
  private consumeBuildProgressLine(
    line: string,
    boardName: string,
    state: DiskCompileProgressState,
  ): boolean {
    const trimmedLine = line.trim();
    if (!trimmedLine) {
      return true;
    }

    if (isAilyBuilderProgressLine(trimmedLine)) {
      const progress = parseAilyBuilderProgressLine(trimmedLine);
      if (!progress) {
        return false;
      }
      state.hasStructuredProgress = true;
      state.percent = Math.max(state.percent, progress.percent);
      state.text = this.buildProgressText(progress);
      this.updateBuildProgress(boardName, state);
      return true;
    }

    if (trimmedLine.startsWith('BuildText:')) {
      state.text = trimmedLine.slice('BuildText:'.length).trim() || state.text;
    }

    // Compatibility with aily-builder <= 1.2.10. Once a structured event is
    // observed, raw Ninja counters are stage-local and no longer drive global
    // progress.
    if (!state.hasStructuredProgress) {
      const legacyPercent = parseLegacyAilyBuilderProgressLine(trimmedLine);
      if (legacyPercent !== null && legacyPercent > state.percent) {
        state.percent = legacyPercent;
        this.updateBuildProgress(boardName, state);
      }
    }

    return false;
  }

  private updateBuildProgress(
    boardName: string,
    state: DiskCompileProgressState,
  ): void {
    if (this.cancelled) {
      return;
    }
    this.application.updateNotice({
      title: this.buildNoticeTitle(boardName),
      text: state.text,
      state: 'doing',
      progress: state.percent,
      setTimeout: 0,
      stop: () => this.cancel(),
    });
  }

  private publishBuildLog(
    projectPath: string,
    line: string,
    outputType: 'stdout' | 'stderr',
    state = 'doing',
    title?: string,
  ): void {
    const detail = String(line || '').trim();
    if (!detail) {
      return;
    }
    const isError = outputType === 'stderr' && /(?:\[ERROR\]|\berror:|\bfatal:)/i.test(detail);
    const logState = isError ? 'error' : state;
    this.logService.update({ title, detail, state: logState });
    const level: ProjectLogLevel = isError
      ? 'ERROR'
      : logState === 'done' || logState === 'warn'
        ? 'INFO'
        : 'DEBUG';
    appendProjectLog(projectPath, 'compile', level, detail);
  }

  private updateCancelledNotice(text: string): void {
    this.application.updateNotice({
      title: this.t('CANCELLED_TITLE'),
      text,
      state: 'warn',
      setTimeout: 55000,
      isCancellationNotice: true,
    });
  }

  private handleFailNotice(
    projectPath: string,
    title: string,
    text: string,
    detail: string,
  ): void {
    const clean = (detail || '').replace(/\[\d+(;\d+)*m/g, '').trim().slice(0, 8000);
    appendProjectLog(projectPath, 'compile', 'ERROR', text || clean || '(no logs)');
    this.application.updateNotice({
      title,
      text,
      state: 'error',
      detail: clean || '(no logs)',
      setTimeout: 600000,
      sendToLog: true,
    });
  }

  private runOneShotCommand(
    request: { scriptPath: string; configFilePath: string; buildDeliveryRequest?: string },
    onLine?: (line: AilyBuilderOutputLine) => void,
    buildWorkspace?: string,
  ): Promise<OneShotCommandResult> {
    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let combined = '';
      let exitCode = 0;
      let signal: string | null = null;
      let settled = false;
      let sub: Subscription | null = null;
      const lineBuffer = new AilyBuilderOutputLineBuffer();

      const emitLines = (lines: AilyBuilderOutputLine[]) => {
        lines.forEach(line => onLine?.(line));
      };

      const cleanup = (cancelCommand: () => void) => {
        if (this.activeSub === sub) {
          this.activeSub = null;
        }
        if (this.activeCommandCancel === cancelCommand) {
          this.activeCommandCancel = null;
        }
        this.activeStreamId = null;
      };

      const settle = (cancelCommand: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        emitLines(lineBuffer.flush());
        sub?.unsubscribe();
        cleanup(cancelCommand);
        resolve({ exitCode, stdout, stderr, combined, signal });
      };

      const cancelCommand = () => {
        exitCode = 1;
        signal = 'cancelled';
        settle(cancelCommand);
      };

      this.activeCommandCancel = cancelCommand;
      const streamId = `disk_build_${crypto.randomUUID()}`;
      this.activeStreamId = streamId;
      sub = this.cmdService.spawn('node', [request.scriptPath, request.configFilePath], {
        cwd: buildWorkspace, shellProfile: false, buildWorkspace, streamId,
        ...(request.buildDeliveryRequest ? { buildDeliveryRequest: request.buildDeliveryRequest } : {}),
      }).subscribe({
        next: (o: CmdOutput) => {
          if (!this.activeStreamId && o.streamId) {
            this.activeStreamId = o.streamId;
          }
          if (o.type === 'close') {
            exitCode = o.code ?? (o.signal ? 1 : 0);
            signal = o.signal || null;
          }
          if (o.type === 'error') {
            const errorText = String(o.error || '');
            exitCode = 1;
            stderr += errorText;
            combined += errorText;
            if (errorText) {
              emitLines(lineBuffer.append('stderr', `${errorText}\n`));
            }
          }
          if (o.data) {
            if (o.type === 'stderr') {
              stderr += o.data;
              combined += o.data;
              emitLines(lineBuffer.append('stderr', o.data));
            } else {
              stdout += o.data;
              combined += o.data;
              emitLines(lineBuffer.append('stdout', o.data));
            }
          }
        },
        error: (err) => {
          if (settled) {
            return;
          }
          settled = true;
          emitLines(lineBuffer.flush());
          cleanup(cancelCommand);
          reject(err);
        },
        complete: () => {
          settle(cancelCommand);
        },
      });
      this.activeSub = sub;
    });
  }
}
