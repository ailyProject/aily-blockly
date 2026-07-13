import { Injectable, NgZone } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { CmdOutput, CmdService } from '../../../services/cmd.service';
import { CrossPlatformCmdService } from '../../../services/cross-platform-cmd.service';
import { NzMessageService } from 'ng-zorro-antd/message';
import { NoticeService } from '../../../services/notice.service';
import { ProjectService } from '../../../services/project.service';
import { LogService } from '../../../services/log.service';
import { ConfigService } from '../../../services/config.service';
import { ActionState } from '../../../services/ui.service';
import { ActionService } from '../../../services/action.service';
import {
  arduinoGenerator,
  normalizeArduinoGeneratedCode,
} from '../components/blockly/generators/arduino/arduino';

import { BlocklyService as BlocklyService } from './blockly.service';

import { PlatformService } from "../../../services/platform.service";
import { ElectronService } from '../../../services/electron.service';
import { WorkflowService, ProcessState } from '../../../services/workflow.service';
import { CompileValidationService } from '../../../services/compile-validation.service';
import { AppDataResourceLockService } from '../../../services/appdata-resource-lock.service';
import { NpmService } from '../../../services/npm.service';
import { debounceTime } from 'rxjs/operators';
import { ChatPerformanceTracer } from '../../../tools/aily-chat/services/chat-perf-tracer';
import { appendProjectLog, type ProjectLogLevel } from '../../../utils/project-log.utils';

const AILY_CHAT_LEX_COMPLETION_PENDING_COUNT_KEY = '__AILY_CHAT_LEX_COMPLETION_PENDING_COUNT__';
const AILY_CHAT_AGENT_LOOP_PENDING_COUNT_KEY = '__AILY_CHAT_AGENT_LOOP_PENDING_COUNT__';
const PREPROCESS_IDLE_TIMEOUT_MS = 1800;
const PREPROCESS_PENDING_CHAT_POLL_MS = 500;
const PREPROCESS_PENDING_CHAT_MAX_WAIT_MS = 10_000;
const PREPROCESS_POST_CHAT_QUIET_MS = 1500;
const PREPROCESS_SLOW_PHASE_MS = 32;
const PREPROCESS_ERROR_OUTPUT_LIMIT = 64 * 1024;

@Injectable()
export class _BuilderService {

  constructor(
    private cmdService: CmdService,
    private crossPlatformCmdService: CrossPlatformCmdService,
    private message: NzMessageService,
    private translate: TranslateService,
    private noticeService: NoticeService,
    private logService: LogService,
    private workflowService: WorkflowService,
    private configService: ConfigService,
    private actionService: ActionService,
    private projectService: ProjectService,
    private blocklyService: BlocklyService,
    private platformService: PlatformService,
    private electronService: ElectronService,
    private npmService: NpmService,
    private compileValidationService: CompileValidationService,
    private appDataResourceLock: AppDataResourceLockService,
    private ngZone: NgZone,
  ) { }

  // buildInProgress = false;
  private streamId: string | null = null;
  private buildSubscription: any = null; // 保存订阅引用
  private buildPromiseReject: any = null; // 保存 Promise 的 reject 函数
  private buildCompleted = false;
  private isErrored = false; // 标识是否为错误状态
  private buildStartTime: number = 0; // 编译开始时间
  private progressTimer: any = null; // 进度检查定时器
  private currentProgress: number = 0; // 当前显示的进度
  private hasReceivedRealProgress: boolean = false; // 是否已收到真实进度
  private dependencySubscription: any = null; // 保存依赖变化订阅引用
  private preprocessProcess: any = null; // 保存当前运行的预处理订阅
  private preprocessStreamId: string | null = null; // 保存预处理的 streamId
  private preprocessError: string | null = null; // 保存预编译错误信息
  private preprocessFullError: string = ''; // 保存预编译完整错误日志
  private pendingPrecompile: boolean = false; // 标记是否有待处理的预编译
  private preprocessRunGeneration = 0;
  private aiWaitingSubscription: any = null; // 保存 AI 等待状态订阅引用
  private workflowStateSubscription: any = null; // 保存流程状态订阅引用
  private lastWorkflowState: ProcessState | null = null;

  currentProjectPath = "";
  lastCode = "";
  passed = false;
  cancelled = false;
  boardJson: any = null;
  isUploading = false;

  private initialized = false; // 防止重复初始化

  private t(key: string, params?: Record<string, any>): string {
    return this.translate.instant(`BLOCKLY_EDITOR.BUILD.${key}`, params);
  }

  private buildNoticeTitle(boardName: string): string {
    return this.t('RUNNING_TITLE', { board: boardName });
  }

  private appendCompileLog(message: string, level: ProjectLogLevel = 'INFO'): void {
    appendProjectLog(this.projectService.currentProjectPath, 'compile', level, message);
  }

  private messageWithDuration(message: string, seconds: string): string {
    return this.t('MESSAGE_WITH_DURATION', { message, seconds });
  }

  private updateCancelledNotice(buildDuration: string, setTimeout = 5000): void {
    this.noticeService.update({
      title: this.t('CANCELLED_TITLE'),
      text: this.t('CANCELLED_WITH_TIME', { seconds: buildDuration }),
      state: 'warn',
      setTimeout,
      isCancellationNotice: true
    });
  }

  private isInstallInProgress(): boolean {
    return this.npmService.isInstalling || this.workflowService.currentState === ProcessState.INSTALLING;
  }

  private getPendingChatBackgroundOperationCount(): number {
    const value = (globalThis as Record<string, unknown>)[AILY_CHAT_LEX_COMPLETION_PENDING_COUNT_KEY];
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
  }

  private getPendingChatAgentLoopCount(): number {
    const value = (globalThis as Record<string, unknown>)[AILY_CHAT_AGENT_LOOP_PENDING_COUNT_KEY];
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
  }

  private getPendingChatBlockingOperationCount(): number {
    return this.getPendingChatBackgroundOperationCount() + this.getPendingChatAgentLoopCount();
  }

  private waitForOneIdleBoundary(): Promise<void> {
    return new Promise(resolve => {
      const requestIdle = (globalThis as any).requestIdleCallback as
        | ((callback: () => void, options?: { timeout?: number }) => number)
        | undefined;
      if (typeof requestIdle === 'function') {
        requestIdle(() => resolve(), { timeout: PREPROCESS_IDLE_TIMEOUT_MS });
        return;
      }

      setTimeout(resolve, PREPROCESS_PENDING_CHAT_POLL_MS);
    });
  }

  private waitForDelay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private recordPreprocessDuration(tag: string, startedAt: number, detail?: string): void {
    const durationMs = Date.now() - startedAt;
    ChatPerformanceTracer.recordDuration(
      `builder_preprocess_${tag}`,
      durationMs,
      detail,
      { slowThresholdMs: PREPROCESS_SLOW_PHASE_MS },
    );
    if (durationMs >= PREPROCESS_SLOW_PHASE_MS) {
      console.info('[Builder][PreprocessSchedule] slow phase', {
        tag,
        durationMs,
        detail,
      });
    }
  }

  private async runBuilderPreprocessPhase<T>(
    tag: string,
    operation: () => T | Promise<T>,
    detail?: string,
  ): Promise<T> {
    const startedAt = Date.now();
    try {
      return await ChatPerformanceTracer.runWithSurface(
        'builder_preprocess',
        operation,
        detail ? `${tag}:${detail}` : tag,
      );
    } finally {
      this.recordPreprocessDuration(tag, startedAt, detail);
    }
  }

  private async generateWorkspaceCodeForPreprocess(
    workspace: unknown,
    detail?: string,
  ): Promise<string> {
    await this.waitForOneIdleBoundary();
    return this.runBuilderPreprocessPhase(
      'workspace_to_code',
      () => normalizeArduinoGeneratedCode(arduinoGenerator.workspaceToCode(workspace as any)),
      detail,
    );
  }

  private appendPreprocessErrorOutput(value: unknown): void {
    const text = typeof value === 'string' ? value : String(value ?? '');
    if (!text) {
      return;
    }

    this.preprocessFullError = `${this.preprocessFullError}${text}\n`
      .slice(-PREPROCESS_ERROR_OUTPUT_LIMIT);
  }

  private cancelBackgroundPreprocess(): void {
    const subscription = this.preprocessProcess;
    const streamId = this.preprocessStreamId;
    this.preprocessProcess = null;
    this.preprocessStreamId = null;

    subscription?.unsubscribe?.();
    if (streamId) {
      void this.cmdService.kill(streamId).catch((error) => {
        console.warn('终止预编译进程失败:', error);
      });
    }
  }

  private async unlinkFileIfExists(filePath: string): Promise<boolean> {
    if (!window['path'].isExists(filePath)) {
      return false;
    }

    const fsApi = window['fs'] as {
      unlinkSync?: (path: string) => void;
      promises?: {
        unlink?: (path: string) => Promise<void>;
      };
    };

    if (typeof fsApi.promises?.unlink === 'function') {
      await fsApi.promises.unlink(filePath);
      return true;
    }

    await this.waitForOneIdleBoundary();
    fsApi.unlinkSync?.(filePath);
    return true;
  }

  private async writeTextFile(filePath: string, content: string): Promise<void> {
    const fsApi = window['fs'] as {
      writeFileSync?: (path: string, content: string) => void;
      promises?: {
        writeFile?: (path: string, content: string) => Promise<void>;
      };
    };

    if (typeof fsApi.promises?.writeFile === 'function') {
      await fsApi.promises.writeFile(filePath, content);
      return;
    }

    await this.waitForOneIdleBoundary();
    fsApi.writeFileSync?.(filePath, content);
  }

  private async waitForBackgroundPreprocessIdle(reason: string): Promise<void> {
    const startedAt = Date.now();
    let pendingChatOperations = this.getPendingChatBlockingOperationCount();

    while (pendingChatOperations > 0 && Date.now() - startedAt < PREPROCESS_PENDING_CHAT_MAX_WAIT_MS) {
      console.info('[Builder][PreprocessSchedule] waiting for chat background completion', {
        reason,
        pendingChatOperations,
        pendingAgentLoops: this.getPendingChatAgentLoopCount(),
        pendingCompletions: this.getPendingChatBackgroundOperationCount(),
        waitMs: Date.now() - startedAt,
      });
      await this.waitForDelay(PREPROCESS_PENDING_CHAT_POLL_MS);
      pendingChatOperations = this.getPendingChatBlockingOperationCount();
    }

    if (reason === 'ai-complete') {
      await this.waitForDelay(PREPROCESS_POST_CHAT_QUIET_MS);
    }
    await this.waitForOneIdleBoundary();

    console.info('[Builder][PreprocessSchedule] idle boundary reached', {
      reason,
      waitMs: Date.now() - startedAt,
      pendingChatOperations: this.getPendingChatBlockingOperationCount(),
      pendingAgentLoops: this.getPendingChatAgentLoopCount(),
      pendingCompletions: this.getPendingChatBackgroundOperationCount(),
    });
  }

  private shouldCancelBackgroundPreprocess(runGeneration: number): boolean {
    const shouldCancel = runGeneration !== this.preprocessRunGeneration
      || this.blocklyService.aiWaiting
      || this.getPendingChatBlockingOperationCount() > 0;
    if (shouldCancel) {
      this.pendingPrecompile = true;
    }
    return shouldCancel;
  }

  private triggerPendingPrecompile(reason: string, logMessage: string): void {
    if (!this.pendingPrecompile) {
      return;
    }

    console.log(logMessage);
    this.pendingPrecompile = false;
    setTimeout(() => {
      const pendingChatOperations = this.getPendingChatBlockingOperationCount();
      if (this.blocklyService.aiWaiting || pendingChatOperations > 0) {
        if (pendingChatOperations > 0) {
          console.info('[Builder][PreprocessSchedule] agent loop still active, keep preprocess pending', {
            reason,
            pendingChatOperations,
            pendingAgentLoops: this.getPendingChatAgentLoopCount(),
            pendingCompletions: this.getPendingChatBackgroundOperationCount(),
          });
        }
        this.pendingPrecompile = true;
        setTimeout(() => {
          this.triggerPendingPrecompile(reason, logMessage);
        }, PREPROCESS_PENDING_CHAT_POLL_MS);
        return;
      }

      const currentState = this.workflowService.currentState;
      if (currentState === ProcessState.BUILDING || currentState === ProcessState.UPLOADING || this.isInstallInProgress()) {
        this.pendingPrecompile = true;
        return;
      }

      this.blocklyService.dependencySubject.next(reason);
    }, 800);
  }

  private async getMissingBoardDependencies(): Promise<string[]> {
    const boardPackageJson = await this.projectService.getBoardPackageJson();
    return this.npmService.getMissingBoardDependencies(boardPackageJson);
  }

  private formatMissingBoardDependenciesMessage(missingDependencies: string[]): string {
    return `开发板依赖未安装完成，请先修复依赖安装: ${missingDependencies.join(', ')}`;
  }

  init() {
    if (this.initialized) {
      console.warn('_BuilderService 已经初始化过了，跳过重复初始化');
      return;
    }

    this.initialized = true;
    this.actionService.listen('compile-begin', async (action) => {
      try {
        const result = await this.build();
        return { success: true, result };
      } catch (msg) {
        return { success: false, result: msg };
      }
    }, 'builder-compile-begin');
    this.actionService.listen('compile-cancel', (action) => {
      this.cancel();
    }, 'builder-compile-cancel');
    this.actionService.listen('compile-reset', async (action) => {
      this.passed = false;
      this.lastCode = "";
    }, 'builder-compile-reset');

    this.actionService.listen('preprocess-stop', async (action) => {
      await this.stopPreprocess();
      return { success: true };
    }, 'builder-preprocess-stop');

    this.actionService.listen('preprocess-trigger', async (action) => {
      // 手动触发预编译
      const reason = action.payload?.reason || 'manual';
      console.log(`收到预编译触发请求，原因: ${reason}`);
      // 配置变更时使编译缓存失效，强制下次上传重新编译
      if (reason === 'config-changed') {
        this.passed = false;
      }
      this.blocklyService.dependencySubject.next(reason);
      return { success: true };
    }, 'builder-preprocess-trigger');

    // 保存订阅引用以便后续取消
    this.dependencySubscription = this.ngZone.runOutsideAngular(() => (
      this.blocklyService.dependencySubject.pipe(
        debounceTime(500),
      ).subscribe(async (data) => {
      const runGeneration = ++this.preprocessRunGeneration;
      // 检查项目加载状态，如果正在加载中则跳过预处理
      if (!data || this.projectService.stateSubject.value === 'loading') {
        console.log('项目正在加载中，跳过依赖预处理');
        return;
      }

      // 互斥条件1：AI操作期间不触发自动预编译，但标记需要延迟执行
      if (this.blocklyService.aiWaiting || this.getPendingChatBlockingOperationCount() > 0) {
        console.log('AI操作进行中，标记延迟预编译');
        this.pendingPrecompile = true;
        return;
      }

      // 互斥条件2：依赖安装进行中不触发自动预编译，但保留一次待补执行
      if (this.isInstallInProgress()) {
        console.log('依赖安装进行中，标记延迟预编译');
        this.pendingPrecompile = true;
        return;
      }

      await this.waitForBackgroundPreprocessIdle(String(data || 'dependency'));
      if (this.shouldCancelBackgroundPreprocess(runGeneration)) {
        console.log('AI操作进行中，idle 后继续延迟预编译');
        return;
      }

      if (this.isInstallInProgress()) {
        console.log('依赖安装进行中，idle 后继续延迟预编译');
        this.pendingPrecompile = true;
        return;
      }

      // 互斥条件3：编译或上传进行中不触发自动预编译
      const currentState = this.workflowService.currentState;
      if (currentState === ProcessState.BUILDING || currentState === ProcessState.UPLOADING) {
        console.log('编译/上传进行中，跳过自动预编译');
        return;
      }

      let missingBoardDependencies: string[] = [];
      try {
        missingBoardDependencies = await this.getMissingBoardDependencies();
      } catch (error) {
        console.warn('[后台预处理] 检查开发板依赖失败，跳过自动预编译:', error);
        return;
      }
      if (this.shouldCancelBackgroundPreprocess(runGeneration)) {
        return;
      }
      if (missingBoardDependencies.length > 0) {
        console.warn('[后台预处理] 开发板依赖未安装完成，跳过自动预编译:', missingBoardDependencies);
        this.pendingPrecompile = false;
        return;
      }

      // 删除temp目录下的preprocess.json文件，并在后台运行预处理
      const tempPath = this.electronService.pathJoin(this.projectService.currentProjectPath, '.temp');
      const preprocessCachePath = this.electronService.pathJoin(tempPath, 'preprocess.json');

      console.log('检测到依赖变化，准备重新预处理');

      // 1. 先终止正在运行的预处理进程（如果有）
      if (this.preprocessProcess || this.preprocessStreamId) {
        console.log('终止正在运行的预处理进程...');
        const stopStartedAt = Date.now();
        try {
          // 先取消订阅
          if (this.preprocessProcess) {
            this.preprocessProcess.unsubscribe();
            this.preprocessProcess = null;
          }
          // 再 kill 进程
          if (this.preprocessStreamId) {
            await this.cmdService.kill(this.preprocessStreamId);
            this.preprocessStreamId = null;
          }
        } catch (error) {
          console.warn('终止旧的预处理进程失败:', error);
        } finally {
          this.recordPreprocessDuration('stop_existing_process', stopStartedAt);
        }
      }

      // 2. 删除预编译缓存文件
      try {
        if (this.shouldCancelBackgroundPreprocess(runGeneration)) {
          return;
        }
        const unlinkStartedAt = Date.now();
        if (await this.unlinkFileIfExists(preprocessCachePath)) {
          console.log('已删除预编译缓存文件:', preprocessCachePath);
          this.recordPreprocessDuration('delete_cache', unlinkStartedAt);
        }
      } catch (error) {
        console.warn('删除预编译缓存文件失败:', error);
        return;
      }
      if (this.shouldCancelBackgroundPreprocess(runGeneration)) {
        return;
      }

      // 2. 在后台运行预处理脚本
      try {
        await this.waitForOneIdleBoundary();
        if (this.shouldCancelBackgroundPreprocess(runGeneration)) {
          return;
        }
        // 检查 workspace 是否已初始化
        if (!this.blocklyService.workspace) {
          console.log('Blockly workspace 未初始化，跳过自动预编译');
          return;
        }
        
        const code = await this.generateWorkspaceCodeForPreprocess(this.blocklyService.workspace, 'background_preprocess');
        if (!code) {
          return;
        }
        try {
          await this.waitForAilyBuilderReady();
        } catch (error) {
          console.warn('aily-builder 未准备完成，跳过本次后台预处理:', error);
          return;
        }
        const currentProjectPath = this.projectService.currentProjectPath;
        const boardModule = await this.projectService.getBoardModule();
        if (this.shouldCancelBackgroundPreprocess(runGeneration)) {
          return;
        }
        const appDataPath = window['path'].getAppDataPath();
        const ailyChildPath = window['path'].getAilyChildPath();

        // 参数校验：检查所有必需参数是否存在
        const missingParams: string[] = [];
        if (!currentProjectPath) missingParams.push('currentProjectPath');
        if (!boardModule) missingParams.push('boardModule');
        if (!appDataPath) missingParams.push('appDataPath');
        if (!ailyChildPath) missingParams.push('ailyChildPath');

        if (missingParams.length > 0) {
          console.error('[后台预处理] 参数校验失败，缺少以下参数:', missingParams.join(', '));
          console.error('[后台预处理] 参数详情:', {
            currentProjectPath,
            boardModule,
            appDataPath,
            ailyChildPath
          });
          return;
        }

        // 构建配置对象
        const buildConfig = {
          currentProjectPath,
          boardModule,
          code,
          appDataPath,
          za7Path: this.platformService.za7,
          devmode: this.configService.data.devmode || false,
          partitionFilePath: this.electronService.pathJoin(currentProjectPath, 'partitions.csv')
        };

        // 写入配置文件
        const configFilePath = this.electronService.pathJoin(tempPath, 'build-config.json');
        if (!window['path'].isExists(tempPath)) {
          const mkdirStartedAt = Date.now();
          await this.crossPlatformCmdService.createDirectory(tempPath, true);
          this.recordPreprocessDuration('create_temp_dir', mkdirStartedAt);
        }
        const writeConfigStartedAt = Date.now();
        await this.writeTextFile(configFilePath, JSON.stringify(buildConfig, null, 2));
        this.recordPreprocessDuration('write_config', writeConfigStartedAt);
        await this.waitForOneIdleBoundary();
        if (this.shouldCancelBackgroundPreprocess(runGeneration)) {
          return;
        }

        // 运行预处理脚本（后台运行）
        const preprocessScriptPath = this.electronService.pathJoin(window['path'].getAilyChildPath(), 'scripts', 'preprocess.js');
        console.log('开始后台运行预处理脚本');

        // 重置预编译错误状态
        this.preprocessError = null;
        this.preprocessFullError = '';

        // 使用 cmdService 后台静默运行预处理脚本
        const spawnStartedAt = Date.now();
        const preprocessStreamId = `builder_preprocess_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        this.preprocessStreamId = preprocessStreamId;
        const subscription = this.cmdService.spawn(
          'node',
          [preprocessScriptPath, configFilePath],
          { streamId: preprocessStreamId, forwardStdout: false },
          true,
        ).subscribe({
          next: (output) => {
            // Only stderr/error/close crosses into the renderer for this background operation.
            if (output.data) {
              // 检查输出中是否包含错误信息
              if (output.data.includes('[ERROR]') || output.data.toLowerCase().includes('error:')) {
                this.appendPreprocessErrorOutput(output.data);
                // 提取关键错误信息
                const errorLine = output.data.split('\n').find((line: string) =>
                  line.includes('[ERROR]') || line.toLowerCase().includes('error:')
                );
                if (errorLine) {
                  this.preprocessError = errorLine.trim();
                }
              }
            }
            if (output.type === 'error') {
              const processError = output.error || '预编译进程启动失败';
              this.appendPreprocessErrorOutput(processError);
              if (!this.preprocessError) {
                this.preprocessError = processError;
              }
              return;
            }

            if (output.error) {
              // 收集错误信息，不单独发送
              this.appendPreprocessErrorOutput(output.error);
              if (!this.preprocessError) {
                this.preprocessError = output.error;
              }
            }
            // 检查进程退出码
            if (output.type === 'close' && ((output.code ?? 0) !== 0 || output.signal)) {
              if (!this.preprocessError) {
                this.preprocessError = output.signal
                  ? `预编译进程被信号终止: ${output.signal}`
                  : `预编译进程异常退出，退出码: ${output.code}`;
              }
              if (!this.preprocessFullError) {
                this.appendPreprocessErrorOutput(this.preprocessError);
              }
            }
          },
          error: (error) => {
            const errorMsg = error.error || error.message || error;
            console.warn('后台预处理失败:', errorMsg);
            // 收集错误信息
            this.preprocessError = '后台预处理失败: ' + errorMsg;
            this.appendPreprocessErrorOutput('后台预处理失败: ' + errorMsg);
            // 清理引用
            if (this.preprocessProcess === subscription) {
              this.preprocessProcess = null;
              this.preprocessStreamId = null;
            }
          },
          complete: () => {
            // 检查是否有错误发生，如果有则一次性发送所有错误到日志
            if (this.preprocessError) {
              console.warn('后台预处理完成但有错误:', this.preprocessError);
              // 清理 ANSI 颜色代码并一次性发送所有错误
              const cleanFullError = this.preprocessFullError.replace(/\[\d+(;\d+)*m/g, '');
              this.logService.update({ "detail": cleanFullError, "state": "error" });
              this.appendCompileLog(cleanFullError, 'ERROR');
            } else {
              console.log('后台预处理完成');
              // this.logService.update({ "detail": '后台预处理完成', "state": "done" });
            }
            // 清理引用
            if (this.preprocessProcess === subscription) {
              this.preprocessProcess = null;
              this.preprocessStreamId = null;
            }
          }
        });
        this.recordPreprocessDuration('spawn_command_stream', spawnStartedAt);

        // 保存订阅引用以便后续终止
        this.preprocessProcess = subscription;
      } catch (error) {
        console.warn('启动后台预处理失败:', error);
      }
      })
    ));

    this.lastWorkflowState = this.workflowService.currentState;
    this.workflowStateSubscription = this.ngZone.runOutsideAngular(() => (
      this.workflowService.state$.subscribe(async (state) => {
      const previousState = this.lastWorkflowState;
      this.lastWorkflowState = state;

      if (state === previousState) {
        return;
      }

      if (state === ProcessState.INSTALLING) {
        if (this.preprocessProcess || this.preprocessStreamId) {
          console.log('依赖安装开始，终止正在运行的预编译');
          this.pendingPrecompile = true;
          await this.stopPreprocess();
        }
        return;
      }

      if (previousState === ProcessState.INSTALLING && state === ProcessState.IDLE) {
        this.triggerPendingPrecompile('install-complete', '依赖安装完成，触发延迟的预编译');
      }
      })
    ));

    // 监听 AI 操作状态变化
    this.aiWaitingSubscription = this.ngZone.runOutsideAngular(() => (
      this.blocklyService.aiExecutionActive$.subscribe((waiting) => {
        this.handleAiExecutionActiveChange(waiting);
      })
    ));
  }

  private handleAiExecutionActiveChange(waiting: boolean): void {
    if (waiting) {
      this.preprocessRunGeneration += 1;
      // AI 操作开始，终止正在运行的预编译（结果会过时）
      if (this.preprocessProcess || this.preprocessStreamId) {
        console.log('AI操作开始，终止正在运行的预编译');
        this.pendingPrecompile = true; // 标记需要重新预编译
        this.cancelBackgroundPreprocess();
      }
    } else {
      // AI 操作完成，触发延迟的预编译
      this.triggerPendingPrecompile('ai-complete', 'AI操作已完成，触发延迟的预编译');
    }
  }

  destroy() {
    this.actionService.unlisten('builder-compile-begin');
    this.actionService.unlisten('builder-compile-cancel');
    this.actionService.unlisten('builder-compile-reset');
    this.actionService.unlisten('builder-preprocess-stop');
    this.actionService.unlisten('builder-preprocess-trigger');
    this.clearProgressTimer(); // 清理定时器
    
    // 终止正在运行的预处理进程
    if (this.preprocessProcess || this.preprocessStreamId) {
      try {
        // 先取消订阅
        if (this.preprocessProcess) {
          this.preprocessProcess.unsubscribe();
          this.preprocessProcess = null;
        }
        // 再 kill 进程
        if (this.preprocessStreamId) {
          this.cmdService.kill(this.preprocessStreamId);
          this.preprocessStreamId = null;
        }
        console.log('已终止预处理进程');
      } catch (error) {
        console.warn('终止预处理进程失败:', error);
      }
    }
    
    // 取消依赖变化订阅
    if (this.dependencySubscription) {
      this.dependencySubscription.unsubscribe();
      this.dependencySubscription = null;
      console.log('已取消依赖变化订阅');
    }

    // 取消 AI 等待状态订阅
    if (this.aiWaitingSubscription) {
      this.aiWaitingSubscription.unsubscribe();
      this.aiWaitingSubscription = null;
    }
    if (this.workflowStateSubscription) {
      this.workflowStateSubscription.unsubscribe();
      this.workflowStateSubscription = null;
    }
    this.lastWorkflowState = null;
    this.pendingPrecompile = false;
    
    // 清理预编译错误状态
    this.preprocessError = null;
    this.preprocessFullError = '';
    
    this.initialized = false; // 重置初始化状态
  }

  /**
   * 停止正在运行的预编译进程
   * 供外部调用（例如清除缓存时）
   */
  async stopPreprocess(): Promise<void> {
    if (this.preprocessProcess || this.preprocessStreamId) {
      console.log('停止预编译进程...');
      try {
        // 先取消订阅
        if (this.preprocessProcess) {
          this.preprocessProcess.unsubscribe();
          this.preprocessProcess = null;
        }
        // 再 kill 进程
        if (this.preprocessStreamId) {
          await this.cmdService.kill(this.preprocessStreamId);
          this.preprocessStreamId = null;
        }
        console.log('预编译进程已停止');
      } catch (error) {
        console.warn('停止预编译进程失败:', error);
      }
    }
    // 清理预编译错误状态
    this.preprocessError = null;
    this.preprocessFullError = '';
  }

  /**
   * 检查预编译是否正在进行中
   */
  isPreprocessing(): boolean {
    return !!(this.preprocessProcess || this.preprocessStreamId);
  }

  private async waitForAilyBuilderReady(): Promise<void> {
    if (window['builder']?.waitForReady) {
      await window['builder'].waitForReady();
    }
  }


    /**
     * 从当前工作区生成并写入 sketch.ino 文件（不触发完整预编译）
     * 在项目打开时调用，确保 sketch.ino 文件可供 AI 工具和代码预览读取
     */
    async generateAndWriteSketchIno(): Promise<void> {
        try {
            const workspace = this.blocklyService.workspace;
            if (!workspace) return;

            const code = await this.generateWorkspaceCodeForPreprocess(workspace, 'sketch_ino');
            if (!code) return;

            const currentProjectPath = this.projectService.currentProjectPath;
            if (!currentProjectPath) return;

            const tempPath = this.electronService.pathJoin(currentProjectPath, '.temp');
            const sketchPath = this.electronService.pathJoin(tempPath, 'sketch');
            const sketchFilePath = this.electronService.pathJoin(sketchPath, 'sketch.ino');

            if (!window['path'].isExists(tempPath)) {
                await this.crossPlatformCmdService.createDirectory(tempPath, true);
            }
            if (!window['path'].isExists(sketchPath)) {
                await this.crossPlatformCmdService.createDirectory(sketchPath, true);
            }

            await this.writeTextFile(sketchFilePath, code);
            console.log('[Builder] sketch.ino 已自动生成:', sketchFilePath);
        } catch (error) {
            console.warn('[Builder] 自动生成 sketch.ino 失败:', error);
        }
    }

    private async ensureAilyBuilderReady(): Promise<void> {
        if (window['builder']?.ensure) {
            await window['builder'].ensure();
        }
    }

    private async getAilyBuilderRuntimeConfig(): Promise<{ ailyBuilderPath: string; ailyBuilderCommand: string }> {
        await this.ensureAilyBuilderReady();
        return {
            ailyBuilderPath: window['path'].getAilyBuilderPath(),
            ailyBuilderCommand: window['path'].getAilyBuilderCommand()
        };
    }

    private async invalidateBuildCacheIfBuilderChanged(tempPath: string, buildPath: string): Promise<void> {
        const configFilePath = this.electronService.pathJoin(tempPath, 'build-config.json');
        if (!window['path'].isExists(configFilePath)) {
            return;
        }

        try {
            const buildConfig = JSON.parse(window['fs'].readFileSync(configFilePath, 'utf8'));
            const currentBuilder = await this.getAilyBuilderRuntimeConfig();
            if (
                buildConfig.ailyBuilderPath !== currentBuilder.ailyBuilderPath ||
                buildConfig.ailyBuilderCommand !== currentBuilder.ailyBuilderCommand
            ) {
                this.removeDirIfExists(tempPath);
                this.removeDirIfExists(buildPath);
                console.log('aily-builder 已切换，清除旧构建缓存');
            }
        } catch (error) {
            console.warn('检查 aily-builder 构建缓存状态失败:', error);
        }
    }

    private removeDirIfExists(dirPath: string): void {
        if (!window['path'].isExists(dirPath)) {
            return;
        }

        try {
            window['fs'].rmdirSync(dirPath);
        } catch (error) {
            console.warn('删除目录失败:', dirPath, error);
        }
    }

  /**
   * 运行预编译脚本（同步等待完成）
   */
  private async runPreprocess(): Promise<void> {
    await this.waitForAilyBuilderReady();

    const currentProjectPath = this.projectService.currentProjectPath;
    const boardModule = await this.projectService.getBoardModule();
    const appDataPath = window['path'].getAppDataPath();
    const ailyChildPath = window['path'].getAilyChildPath();
    const missingBoardDependencies = await this.getMissingBoardDependencies();

    if (missingBoardDependencies.length > 0) {
      throw new Error(this.formatMissingBoardDependenciesMessage(missingBoardDependencies));
    }

    // 参数校验：检查所有必需参数是否存在
    const missingParams: string[] = [];
    if (!currentProjectPath) missingParams.push('currentProjectPath');
    if (!boardModule) missingParams.push('boardModule');
    if (!appDataPath) missingParams.push('appDataPath');
    if (!ailyChildPath) missingParams.push('ailyChildPath');

    if (missingParams.length > 0) {
      const errorMsg = `[同步预处理] 参数校验失败，缺少以下参数: ${missingParams.join(', ')}`;
      console.error(errorMsg);
      console.error('[同步预处理] 参数详情:', {
        currentProjectPath,
        boardModule,
        appDataPath,
        ailyChildPath
      });
      throw new Error(errorMsg);
    }

    const tempPath = this.electronService.pathJoin(currentProjectPath, '.temp');
    
    // 生成代码
    const code = await this.generateWorkspaceCodeForPreprocess(this.blocklyService.workspace, 'sync_preprocess');
    this.lastCode = code; // 保存代码用于后续 hash 计算

    // 构建配置对象
    const buildConfig = {
      currentProjectPath,
      boardModule,
      code,
      appDataPath,
      za7Path: this.platformService.za7,
      devmode: this.configService.data.devmode || false,
      partitionFilePath: this.electronService.pathJoin(currentProjectPath, 'partitions.csv')
    };

    // 写入配置文件
    const configFilePath = this.electronService.pathJoin(tempPath, 'build-config.json');
    if (!window['path'].isExists(tempPath)) {
      await this.crossPlatformCmdService.createDirectory(tempPath, true);
    }
    await this.writeTextFile(configFilePath, JSON.stringify(buildConfig, null, 2));

    // 运行预处理脚本（同步等待完成）
    const preprocessScriptPath = this.electronService.pathJoin(window['path'].getAilyChildPath(), 'scripts', 'preprocess.js');
    const preprocessCommand = `node "${preprocessScriptPath}" "${configFilePath}"`;

    console.log('开始同步运行预处理脚本');

    return new Promise((resolve, reject) => {
      // 启动前再次确认并清理旧进程
      if (this.preprocessProcess || this.preprocessStreamId) {
        console.log('启动前发现残留进程，立即清理...');
        try {
          if (this.preprocessProcess) {
            this.preprocessProcess.unsubscribe();
          }
          if (this.preprocessStreamId) {
            this.cmdService.kill(this.preprocessStreamId);
          }
        } catch (error) {
          console.warn('清理残留进程失败:', error);
        }
        this.preprocessProcess = null;
        this.preprocessStreamId = null;
      }

      // 重置预编译错误状态
      this.preprocessError = null;
      this.preprocessFullError = '';

      // 使用 cmdService 运行预处理脚本
      const subscription = this.cmdService.run(preprocessCommand, null, false).subscribe({
        next: (output) => {
          // 捕获 streamId
          if (!this.preprocessStreamId && output.streamId) {
            this.preprocessStreamId = output.streamId;
            console.log('捕获到同步预处理 streamId:', this.preprocessStreamId);
          }
          
          // 将预编译普通输出发送到日志（错误信息先收集，最后统一发送）
          if (output.data) {
            // 检查输出中是否包含错误信息
            if (output.data.includes('[ERROR]') || output.data.toLowerCase().includes('error:')) {
              this.preprocessFullError += output.data + '\n';
              const errorLine = output.data.split('\n').find((line: string) => 
                line.includes('[ERROR]') || line.toLowerCase().includes('error:')
              );
              if (errorLine) {
                this.preprocessError = errorLine.trim();
              }
            } else {
              // 非错误信息正常发送到日志
              this.logService.update({ "detail": output.data, "state": "doing" });
              this.appendCompileLog(output.data, 'DEBUG');
            }
          }
          if (output.type === 'error') {
            const processError = output.error || '预编译进程启动失败';
            this.preprocessFullError += processError + '\n';
            if (!this.preprocessError) {
              this.preprocessError = processError;
            }
            return;
          }

          if (output.error) {
            // 收集错误信息，不单独发送
            this.preprocessFullError += output.error + '\n';
            if (!this.preprocessError) {
              this.preprocessError = output.error;
            }
          }
          // 检查进程退出码
          if (output.type === 'close' && ((output.code ?? 0) !== 0 || output.signal)) {
            if (!this.preprocessError) {
              this.preprocessError = output.signal
                ? `预编译进程被信号终止: ${output.signal}`
                : `预编译进程异常退出，退出码: ${output.code}`;
            }
            if (!this.preprocessFullError) {
              this.preprocessFullError = this.preprocessError + '\n';
            }
          }
        },
        error: (error) => {
          const errorMsg = error.error || error.message || error;
          console.error('同步预处理失败:', errorMsg);
          // 收集错误信息
          this.preprocessError = '同步预处理失败: ' + errorMsg;
          this.preprocessFullError += '同步预处理失败: ' + errorMsg + '\n';
          // 清理引用
          if (this.preprocessProcess === subscription) {
            this.preprocessProcess = null;
            this.preprocessStreamId = null;
          }
          reject(error);
        },
        complete: () => {
          // 检查是否有错误发生，如果有则一次性发送所有错误到日志
          if (this.preprocessError) {
            console.warn('同步预处理完成但有错误:', this.preprocessError);
            // 清理 ANSI 颜色代码并一次性发送所有错误
            const cleanFullError = this.preprocessFullError.replace(/\[\d+(;\d+)*m/g, '');
            this.logService.update({ "detail": cleanFullError, "state": "error" });
            this.appendCompileLog(cleanFullError, 'ERROR');
          } else {
            console.log('同步预处理完成');
            this.logService.update({ "detail": '同步预处理完成', "state": "done" });
            this.appendCompileLog('同步预处理完成', 'INFO');
          }
          // 清理引用
          if (this.preprocessProcess === subscription) {
            this.preprocessProcess = null;
            this.preprocessStreamId = null;
          }
          resolve();
        }
      });
      
      // 保存订阅引用
      this.preprocessProcess = subscription;
    });
  }

  // 添加这个错误处理方法
  private handleCompileError(errorMessage: string, sendToLog: boolean = true, details?: string): void {
    // 计算编译耗时
    const buildEndTime = Date.now();
    const buildDuration = this.buildStartTime > 0 ? ((buildEndTime - this.buildStartTime) / 1000).toFixed(2) : '0.00';
    console.log(`编译错误，耗时: ${buildDuration} 秒`);

    // 去除前后空格，保持排版整洁
    const cleanErrorMessage = errorMessage.trim();
    const cleanDetailMessage = (details || errorMessage).trim();

    this.noticeService.update({
      title: this.t('FAILED_TITLE'),
      text: this.messageWithDuration(cleanErrorMessage, buildDuration),
      state: 'error',
      detail: cleanDetailMessage,
      setTimeout: 600000,
      sendToLog: sendToLog
    });

    this.passed = false;
    this.isErrored = true;
    // this.buildInProgress = false;
  }


  async build(): Promise<ActionState> {
    if (!this.workflowService.startBuild()) {
      const state = this.workflowService.currentState;
      let msg = this.t('BUSY_SYSTEM');
      if (state === ProcessState.BUILDING) msg = this.t('BUSY_BUILDING');
      else if (state === ProcessState.UPLOADING) msg = this.t('BUSY_UPLOADING');
      else if (state === ProcessState.INSTALLING) msg = this.t('BUSY_INSTALLING');
      
      this.message.warning(this.t('BUSY_RETRY_LATER', { message: msg }));
      return Promise.reject({ state: 'warn', text: this.t('BUSY_WAIT', { message: msg }) });
    }

    this.buildCompleted = false;
    this.isErrored = false;
    this.cancelled = false;
    this.buildSubscription = null; // 重置订阅引用
    this.buildPromiseReject = null; // 重置 reject 函数
    this.clearProgressTimer(); // 清理之前的定时器
    this.currentProgress = 0; // 重置进度
    this.hasReceivedRealProgress = false; // 重置进度标记

    return this.appDataResourceLock.runShared('build:preprocess-and-compile', () => {
      if (this.cancelled) {
        return Promise.reject({ state: 'warn', text: this.t('CANCELLED_TITLE') });
      }

      return new Promise<ActionState>(async (resolve, reject) => {
      // 保存 reject 函数，以便在 cancel 时使用
      this.buildPromiseReject = reject;
      
      try {
        this.currentProjectPath = this.projectService.currentProjectPath;
        this.streamId = null; // 初始化为 null
        this.buildStartTime = Date.now(); // 记录编译开始时间

        const tempPath = this.electronService.pathJoin(this.currentProjectPath, '.temp');
        const preprocessCachePath = this.electronService.pathJoin(tempPath, 'preprocess.json');
        const buildPath = this.electronService.pathJoin(this.currentProjectPath, '.build');

        // 1. 检查是否有预编译程序正在运行，等待其完成
        if (this.preprocessProcess) {
          this.safeUpdateNotice({
            title: this.t('PREPARING_TITLE'),
            text: this.t('PRECOMPILE_RUNNING'),
            state: 'doing',
            progress: 0,
            setTimeout: 0,
            stop: () => {
              this.cancel();
            }
          });
          
          console.log('检测到后台预编译正在运行，等待其完成...');
          
          // 等待预编译完成（轮询检查）
          const maxWaitTime = 60000; // 最多等待60秒
          const checkInterval = 500; // 每500ms检查一次
          let waited = 0;
          
          while (this.preprocessProcess && waited < maxWaitTime) {
            await new Promise(resolve => setTimeout(resolve, checkInterval));
            waited += checkInterval;
            
            // 检查是否被取消
            if (this.cancelled) {
              console.log('等待预编译时被取消');
              this.workflowService.finishBuild(false, 'Cancelled while waiting for preprocessing');
              reject({ state: 'warn', text: this.t('CANCELLED_TITLE') });
              return;
            }
          }
          
          // 超时或完成检查
          if (this.preprocessProcess || this.preprocessStreamId) {
            console.warn('等待预编译超时，尝试终止并重新运行');
            try {
              if (this.preprocessProcess) {
                this.preprocessProcess.unsubscribe();
                this.preprocessProcess = null;
              }
              if (this.preprocessStreamId) {
                await this.cmdService.kill(this.preprocessStreamId);
                this.preprocessStreamId = null;
              }
            } catch (error) {
              console.warn('终止超时的预编译进程失败:', error);
            }
          } else {
            console.log('后台预编译已完成，继续编译流程');
          }
        }

        // 2. 检查是否有后台预编译错误
        if (this.preprocessError) {
          // console.error('检测到后台预编译错误:', this.preprocessError);
          
          // 清理 ANSI 颜色代码并去除前后空格
          const cleanError = this.preprocessError.replace(/\[\d+(;\d+)*m/g, '').trim();
          
          // 简短提示，引导用户查看日志详情，添加 detail 字段以显示"查看详情"按钮
          this.noticeService.update({
            title: this.t('PRECOMPILE_FAILED_TITLE'),
            text: this.t('PRECOMPILE_FAILED_DETAIL'),
            state: 'error',
            detail: cleanError,
            setTimeout: 600000,
            sendToLog: false
          });
          
          this.passed = false;
          this.workflowService.finishBuild(false, 'Preprocessing error');
          
          // 清空错误状态，允许用户重试
          this.preprocessError = null;
          this.preprocessFullError = '';
          
          reject({ state: 'error', text: this.t('PRECOMPILE_FAILED_RETRY') });
          return;
        }

        // 3. 如果有待处理的预编译（AI操作期间依赖发生了变更），先清除旧缓存
        if (this.pendingPrecompile) {
          console.log('检测到待处理的预编译（AI操作期间依赖已变更），清除旧缓存并重新预编译');
          this.pendingPrecompile = false;
          if (window['path'].isExists(preprocessCachePath)) {
            try {
              window['fs'].unlinkSync(preprocessCachePath);
              console.log('已清除过期的预编译缓存');
            } catch (error) {
              console.warn('清除预编译缓存失败:', error);
            }
          }
        }

        // 4. 检查是否存在预编译缓存文件，如果不存在则启动预编译
        if (!window['path'].isExists(preprocessCachePath)) {
          this.safeUpdateNotice({
            title: this.t('PREPARING_TITLE'),
            text: this.t('DEPENDENCY_ANALYSIS_RUNNING'),
            state: 'doing',
            progress: 0,
            setTimeout: 0,
            stop: () => {
              this.cancel();
            }
          });

          try {
            // 启动预编译
            await this.runPreprocess();
            console.log('预编译完成，开始正式编译');
            
            // 检查同步预编译是否产生了错误
            if (this.preprocessError) {
              console.error('同步预编译产生错误:', this.preprocessError);
              
              // 计算耗时
              const buildEndTime = Date.now();
              const buildDuration = this.buildStartTime > 0 ? ((buildEndTime - this.buildStartTime) / 1000).toFixed(2) : '0.00';
              
              // 清理错误中的 ANSI 颜色代码并去除前后空格
              const cleanError = this.preprocessError.replace(/\[\d+(;\d+)*m/g, '').trim();
              
              // 使用与编译错误一致的通知方式（错误已在 complete 中发送到日志，不重复发送）
              this.noticeService.update({
                title: this.t('PRECOMPILE_FAILED_TITLE'),
                text: this.messageWithDuration(cleanError, buildDuration),
                state: 'error',
                detail: cleanError,
                setTimeout: 600000,
                sendToLog: false
              });
              
              this.passed = false;
              this.workflowService.finishBuild(false, 'Preprocessing error');
              
              this.preprocessError = null;
              this.preprocessFullError = '';
              
              reject({ state: 'error', text: this.t('PRECOMPILE_ERROR_WITH_MESSAGE', { message: cleanError }) });
              return;
            }
          } catch (error) {
            console.error('预编译失败:', error);
            
            // 计算耗时
            const buildEndTime = Date.now();
            const buildDuration = this.buildStartTime > 0 ? ((buildEndTime - this.buildStartTime) / 1000).toFixed(2) : '0.00';
            
            // 清理错误中的 ANSI 颜色代码并去除前后空格
            const errorMsg = (error.error || error.message || error).toString().replace(/\[\d+(;\d+)*m/g, '').trim();
            
            // 使用与编译错误一致的通知方式（错误已在 complete/error 中发送到日志，不重复发送）
            this.noticeService.update({
              title: this.t('PRECOMPILE_FAILED_TITLE'),
              text: this.messageWithDuration(errorMsg, buildDuration),
              state: 'error',
              detail: errorMsg,
              setTimeout: 600000,
              sendToLog: false
            });
            
            this.passed = false;
            this.workflowService.finishBuild(false, 'Preprocessing failed');
            reject({ state: 'error', text: this.t('PRECOMPILE_FAILED_WITH_MESSAGE', { message: errorMsg }) });
            return;
          }
        } else {
          console.log('发现预编译缓存，跳过预编译');
          // 即使有缓存，也需要生成代码以保存到 lastCode（用于后续 hash 计算）
          if (!this.lastCode) {
            const code = await this.generateWorkspaceCodeForPreprocess(this.blocklyService.workspace, 'cache_hit');
            this.lastCode = code;
          }
        }

        // 检测是否首次编译
        let isFirstBuild = true;
        try {
          const buildPath = await this.projectService.getBuildPath();
          if (buildPath && window['path'].isExists(buildPath)) {
            isFirstBuild = false;
          }
        } catch (error) {
          console.log('首次编译');
        }

        let compileCommand: string = "";
        let completeTitle: string = this.t('COMPLETE_TITLE');

        try {
          // 获取最新代码
          const code = await this.generateWorkspaceCodeForPreprocess(this.blocklyService.workspace, 'compile_config');
          this.lastCode = code;
          
          const boardModule = await this.projectService.getBoardModule();
          const boardName = boardModule.replace('@aily-project/board-', '');
          const configFilePath = this.electronService.pathJoin(tempPath, 'build-config.json');
          await this.waitForAilyBuilderReady();

          // 更新配置文件中的 code（compile.js：Blockly 写入 sketch.ino；Aily Code 写入 project.aci.entry）
          let buildConfig: any = {};
          if (window['path'].isExists(configFilePath)) {
            buildConfig = JSON.parse(window['fs'].readFileSync(configFilePath, 'utf8'));
          }
          buildConfig.code = code;
          delete buildConfig.ailyBuilderPath;
          delete buildConfig.ailyBuilderCommand;
          await this.writeTextFile(configFilePath, JSON.stringify(buildConfig, null, 2));

          // 运行编译脚本
          const compileScriptPath = this.electronService.pathJoin(window['path'].getAilyChildPath(), 'scripts', 'compile.js');
          compileCommand = `node "${compileScriptPath}" "${configFilePath}"`;

          completeTitle = this.t('COMPLETE_TITLE');

          let lastProgress = 0;
          let lastBuildText = '';
          let bufferData = '';
          let lastStdErr = '';
          let fullStdErr = '';
          let outputComplete = false;
          let lastLogLines: string[] = [];
          let processExitCode: number | null = null;
          let processSignal: string | null = null;

          this.buildStartTime = Date.now();

          const buildText = isFirstBuild ? this.t('FIRST_BUILD_HINT') : this.t('FAST_BUILD_HINT');
          
          this.safeUpdateNotice({
            title: this.buildNoticeTitle(boardName),
            text: buildText,
            state: 'doing',
            progress: 0,
            setTimeout: 0,
            stop: () => {
              this.cancel();
            }
          });

          // 启动进度初始化定时器（3秒后如果还没有进度就显示初始进度）
          // this.startProgressInitTimer(boardName);

          this.buildSubscription = this.cmdService.run(compileCommand, null, false).subscribe({
            next: (output: CmdOutput) => {
              // 第一时间检查取消状态
              if (this.cancelled) {
                return;
              }
              
              // 尽早捕获 streamId
              if (!this.streamId && output.streamId) {
                this.streamId = output.streamId;
                console.log('捕获到 streamId:', this.streamId);
              }

              if (output.type === 'close') {
                processExitCode = output.code ?? (output.signal ? 1 : 0);
                processSignal = output.signal || null;

                if (processExitCode !== 0 || processSignal) {
                  this.isErrored = true;
                  const processErrorMessage = processSignal
                    ? this.t('PROCESS_SIGNAL_TERMINATED', { signal: processSignal })
                    : this.t('PROCESS_EXITED_WITH_CODE', { code: processExitCode });
                  lastStdErr = lastStdErr || processErrorMessage;
                  if (!fullStdErr) {
                    fullStdErr = processErrorMessage;
                  }
                }
                return;
              }

              if (output.type === 'error') {
                this.isErrored = true;
                const processErrorMessage = output.error || this.t('PROCESS_START_FAILED');
                lastStdErr = lastStdErr || processErrorMessage;
                if (!fullStdErr) {
                  fullStdErr = processErrorMessage;
                }
                return;
              }
              
              if (output.data) {
                const data = output.data;
                if (data.includes('\r\n') || data.includes('\n') || data.includes('\r')) {
                  const lines = (bufferData + data).split(/\r\n|\n|\r/);
                  bufferData = lines.pop() || '';

                  lines.forEach((line: string) => {
                    let trimmedLine = line.trim();
                    if (!trimmedLine) return;

                    if (trimmedLine.startsWith('BuildText:')) {
                      const lineContent = trimmedLine.replace('BuildText:', '').trim();
                      const buildText = lineContent.split(/[\n\r]/)[0];
                      lastBuildText = buildText;
                    }

                    const progressInfo = trimmedLine.trim();
                    let progressValue = 0;
                    const barProgressMatch = progressInfo.match(/\[.*?\]\s*(\d+)%/);
                    const fractionProgressMatch = progressInfo.match(/\[(\d+)\/(\d+)\]/);

                    if (barProgressMatch) {
                      try {
                        progressValue = parseInt(barProgressMatch[1], 10);
                      } catch (error) {
                        progressValue = 0;
                      }
                    } else if (fractionProgressMatch) {
                      try {
                        const current = parseInt(fractionProgressMatch[1], 10);
                        const total = parseInt(fractionProgressMatch[2], 10);
                        progressValue = Math.floor((current / total) * 100);
                      } catch (error) {
                        progressValue = 0;
                      }
                    }

                    if (progressValue > lastProgress) {
                      lastProgress = progressValue;
                      this.hasReceivedRealProgress = true;
                      
                      // 确保进度不会倒退
                      if (progressValue > this.currentProgress) {
                        this.currentProgress = progressValue;
                        
                        // 安全更新UI
                        this.safeUpdateNotice({
                          title: this.buildNoticeTitle(boardName),
                          text: lastBuildText,
                          state: 'doing',
                          progress: this.currentProgress,
                          setTimeout: 0,
                          stop: () => {
                            this.cancel();
                          }
                        });
                      }
                    }

                    if (lastProgress === 100) {
                      this.buildCompleted = true;
                    }

                    if (trimmedLine.includes('Global variables use')) {
                      outputComplete = true;
                      this.buildCompleted = true;
                      this.logService.update({ "detail": trimmedLine, "state": "done" });
                      this.appendCompileLog(trimmedLine, 'INFO');
                    } else if (
                      // 检测更多编译成功标志
                      // Arduino/ESP32: "Sketch uses xxx bytes"
                      trimmedLine.includes('Sketch uses') && trimmedLine.includes('bytes') ||
                      // 某些编译器: "text data bss dec hex filename"
                      trimmedLine.match(/^\s*text\s+data\s+bss\s+dec\s+hex\s+filename/) ||
                      // GCC: "arm-none-eabi-size" 输出
                      (trimmedLine.includes('Program:') && trimmedLine.includes('bytes')) ||
                      // STM32: "已使用" 或 "used"
                      (trimmedLine.toLowerCase().includes('memory') && trimmedLine.toLowerCase().includes('used')) ||
                      // 通用: 包含固件生成成功的标志
                      trimmedLine.includes('.bin generated') || trimmedLine.includes('.hex generated') ||
                      trimmedLine.includes('Successfully created')
                    ) {
                      outputComplete = true;
                      this.buildCompleted = true;
                      this.logService.update({ "detail": trimmedLine, "state": "done" });
                      this.appendCompileLog(trimmedLine, 'INFO');
                    } else {
                      if (!outputComplete) {
                        if (output.type == 'stderr') {
                          if (trimmedLine.includes('[ERROR]') || trimmedLine.toLowerCase().includes("[error]")) {
                            lastStdErr = trimmedLine;
                            fullStdErr += trimmedLine + '\n';
                            this.isErrored = true;
                          } else {
                            fullStdErr += trimmedLine + '\n';
                          }
                        } else {
                          this.logService.update({ "detail": trimmedLine, "state": "doing" });
                          this.appendCompileLog(trimmedLine, 'DEBUG');
                        }
                      }
                    }

                    lastLogLines.push(trimmedLine);
                    if (lastLogLines.length > 30) {
                      lastLogLines.shift();
                    }
                  });
                } else {
                  bufferData += data;
                }
              } else {
                bufferData += '';
              }
            },
            error: (error: any) => {
              this.isErrored = true;
              this.buildSubscription = null; // 清理订阅引用
              this.buildPromiseReject = null; // 清理 reject 引用
              const fullErrorMessage = (error?.error || error?.stack || error?.message || String(error)).toString();
              this.handleCompileError(error.message, true, fullErrorMessage);
              this.workflowService.finishBuild(false, error.message || 'Build error'); // 确保完成工作流状态
              reject({ state: 'error', text: error.message });
            },
            complete: () => {
              this.clearProgressTimer(); // 清理定时器
              console.log("编译命令完成： buildCompleted=", this.buildCompleted, "isErrored=", this.isErrored, "cancelled=", this.cancelled, "lastProgress=", lastProgress);

              // 计算编译耗时（统一计算，避免重复）
              const buildEndTime = Date.now();
              const buildDuration = ((buildEndTime - this.buildStartTime) / 1000).toFixed(2);

              if (!this.cancelled && !this.isErrored && ((processExitCode !== null && processExitCode !== 0) || processSignal)) {
                this.isErrored = true;
                const processErrorMessage = processSignal
                  ? this.t('PROCESS_SIGNAL_TERMINATED', { signal: processSignal })
                  : this.t('PROCESS_EXITED_WITH_CODE', { code: processExitCode });
                lastStdErr = lastStdErr || processErrorMessage;
                if (!fullStdErr) {
                  fullStdErr = processErrorMessage;
                }
              }

              // 如果进度已达到高值且没有错误，也认为编译成功
              if (!this.buildCompleted && !this.isErrored && !this.cancelled && lastProgress >= 95) {
                console.log("进度已达到", lastProgress, "%，假定编译成功");
                this.buildCompleted = true;
              }

              if (this.buildCompleted) {
                console.log('编译命令执行完成');
                console.log(`编译耗时: ${buildDuration} 秒`);

                const displayText = this.extractFirmwareInfo(lastLogLines);
                const displayTextWithTime = this.messageWithDuration(displayText, buildDuration);
                
                // 安全更新UI
                this.safeUpdateNotice({ title: completeTitle, text: displayTextWithTime, state: 'done', setTimeout: 600000 });
                
                this.passed = true;
                
                // 保存编译元数据（不阻塞）
                this.electronService.calculateHash(this.lastCode).then(codeHash => {
                  this.saveBuildInfo('success', buildDuration, codeHash);
                });

                this.compileValidationService.triggerAfterSuccessfulCompile();
                
                this.workflowService.finishBuild(true);
                resolve({ state: 'done', text: this.t('COMPLETE_WITH_TIME', { seconds: buildDuration }) });
              } else if (this.isErrored) {
                console.log(`编译失败，耗时: ${buildDuration} 秒`);

                lastStdErr = lastStdErr.replace(/\[\d+(;\d+)*m/g, '');
                this.handleCompileError(lastStdErr || this.t('INCOMPLETE'), false, fullStdErr || lastStdErr || this.t('INCOMPLETE'));
                this.logService.update({ detail: fullStdErr, state: 'error' });
                this.appendCompileLog(fullStdErr || lastStdErr || this.t('INCOMPLETE'), 'ERROR');
                this.passed = false;
                
                // 记录编译失败状态（不阻塞）
                this.electronService.calculateHash(this.lastCode).then(codeHash => {
                  this.saveBuildInfo('failed', buildDuration, codeHash);
                });
                
                this.workflowService.finishBuild(false, 'Compilation failed');
                reject({ state: 'error', text: this.t('FAILED_WITH_TIME', { seconds: buildDuration }), fullStdErr: fullStdErr || lastStdErr });
              } else if (this.cancelled) {
                console.warn("编译中断")
                console.log(`编译已取消，耗时: ${buildDuration} 秒`);

                this.updateCancelledNotice(buildDuration, 55000);
                this.passed = false;
                
                // 记录编译取消状态（不阻塞）
                this.electronService.calculateHash(this.lastCode).then(codeHash => {
                  this.saveBuildInfo('cancelled', buildDuration, codeHash);
                });
                
                this.workflowService.finishBuild(false, 'Cancelled');
                reject({ state: 'warn', text: this.t('CANCELLED_WITH_TIME', { seconds: buildDuration }) });
              } else {
                // 处理未知状态：进程异常结束但没有设置任何标志
                console.error('编译进程异常结束，未知状态，lastProgress:', lastProgress);
                
                this.noticeService.update({
                  title: this.t('ABNORMAL_END_TITLE'),
                  text: this.t('ABNORMAL_END_WITH_TIME', { seconds: buildDuration }),
                  state: 'error',
                  setTimeout: 60000
                });
                this.passed = false;
                this.workflowService.finishBuild(false, 'Abnormal termination');
                reject({ state: 'error', text: this.t('ABNORMAL_END_WITH_TIME', { seconds: buildDuration }) });
              }
              
              // 最后清理订阅和 reject 引用
              this.buildSubscription = null;
              this.buildPromiseReject = null;
            }
          })
        } catch (error) {
          if (error.message === '编译已取消' || error.message === this.t('CANCELLED_TITLE')) {
            const buildEndTime = Date.now();
            const buildDuration = ((buildEndTime - this.buildStartTime) / 1000).toFixed(2);

            this.updateCancelledNotice(buildDuration);
            this.cancelled = true;
            this.workflowService.finishBuild(false, 'Cancelled');

            reject({ state: 'warn', text: this.t('CANCELLED_WITH_TIME', { seconds: buildDuration }) });
            return;
          }
          throw error;
        }
      } catch (error) {
        const fullErrorMessage = (error?.error || error?.stack || error?.message || String(error)).toString();
        this.handleCompileError(error.message, true, fullErrorMessage);
        this.workflowService.finishBuild(false, error.message);
        reject({ state: 'error', text: error.message });
      }
      });
    });
  }

  /**
   * 保存编译元数据到 package.json
   * @param status 编译状态：success | failed | cancelled
   * @param duration 编译耗时（秒）
   * @param codeHash 代码SHA256哈希值
   */
  private async saveBuildInfo(
    status: 'success' | 'failed' | 'cancelled',
    duration: string,
    codeHash: string
  ): Promise<void> {
    try {
      const currentPackageJson = await this.projectService.getPackageJson();
      if (!currentPackageJson) return;

      // 初始化 buildInfo 对象
      if (!currentPackageJson.buildInfo) {
        currentPackageJson.buildInfo = {};
      }

      currentPackageJson.buildInfo = {
        lastBuildTime: new Date().toISOString(),
        lastBuildCode: codeHash,
        lastBuildStatus: status,
        lastBuildDuration: parseFloat(duration)
      };

      // 仅在编译成功时更新 codeHash（表示当前代码已通过编译）
      if (status === 'success') {
        currentPackageJson.codeHash = codeHash;
      }

      await this.projectService.setPackageJson(currentPackageJson);
      console.log('✅ 编译元数据已保存:', currentPackageJson.buildInfo);
    } catch (error) {
      console.error('❌ 保存编译元数据失败:', error);
    }
  }

  /**
   * 从编译日志中提取固件信息
   * @param logLines 编译日志行数组
   * @returns 格式化的固件使用情况文本
   */
  private extractFirmwareInfo(logLines: string[]): string {
    // console.log("logLines: ", logLines);
    const logText = logLines.join(' ');
    // 提取flash信息：Sketch uses 2706878 bytes (86%) of program storage space. Maximum is 3145728 bytes.
    const flashMatch = logText.match(/Sketch uses (\d+) bytes \((\d+)%\) of program storage space\.\s*Maximum is (\d+) bytes/);
    // 提取ram信息：Global variables use 47628 bytes (14%) of dynamic memory, leaving 280052 bytes for local variables. Maximum is 327680 bytes.
    const ramMatch = logText.match(/Global variables use (\d+) bytes \((\d+)%\) of dynamic memory.*?Maximum is (\d+) bytes/);

    if (flashMatch && ramMatch) {
      const flashUsed = flashMatch[1];
      const flashPercent = flashMatch[2];
      const flashMax = flashMatch[3];

      const ramUsed = ramMatch[1];
      const ramPercent = ramMatch[2];
      const ramMax = ramMatch[3];

      return `Flash use ${flashPercent}%   Ram use ${ramPercent}%`;
    }

    return this.t('FIRMWARE_INFO_FALLBACK');
  }



  /**
   * 启动进度初始化定时器
   * 如果3秒后还没有收到真实进度，显示一个初始进度让用户知道程序在运行
   */
  private startProgressInitTimer(boardName: string) {
    let checkCount = 0;
    
    this.progressTimer = setInterval(() => {
      // 第一时间检查是否已取消
      if (this.cancelled) {
        this.clearProgressTimer();
        return;
      }
      
      checkCount++;
      
      // 如果已经收到真实进度，停止检查
      if (this.hasReceivedRealProgress) {
        this.clearProgressTimer();
        return;
      }
      
      const elapsedSeconds = (Date.now() - this.buildStartTime) / 1000;
      
      // 3秒后如果还没进度，显示初始进度
      if (elapsedSeconds >= 3 && this.currentProgress === 0) {
        // 再次检查是否已取消
        if (this.cancelled) {
          this.clearProgressTimer();
          return;
        }
        
        this.currentProgress = 3;
        
        // 安全更新UI
        this.safeUpdateNotice({
          title: this.buildNoticeTitle(boardName),
          text: this.t('ANALYZING_DEPS'),
          state: 'doing',
          progress: this.currentProgress,
          setTimeout: 0,
          stop: () => {
            this.cancel();
          }
        });
      }
      // 之后每10秒缓慢增加1%，最多到15%
      else if (this.currentProgress > 0 && this.currentProgress < 15 && checkCount % 10 === 0) {
        // 再次检查是否已取消
        if (this.cancelled) {
          this.clearProgressTimer();
          return;
        }
        
        this.currentProgress++;
        
        // 安全更新UI
        this.safeUpdateNotice({
          title: this.buildNoticeTitle(boardName),
          text: this.t('PROCESSING'),
          state: 'doing',
          progress: this.currentProgress,
          setTimeout: 0,
          stop: () => {
            this.cancel();
          }
        });
      }
    }, 1000); // 每1秒检查一次
  }

  /**
   * 清理进度模拟定时器
   */
  private clearProgressTimer() {
    if (this.progressTimer) {
      clearInterval(this.progressTimer);
      this.progressTimer = null;
    }
  }

  /**
   * 安全的通知更新方法
   * 在取消状态下阻止所有非取消相关的UI更新
   */
  private safeUpdateNotice(config: any) {
    // 如果已取消，只允许更新为取消状态
    if (this.cancelled) {
      // 只允许显示取消相关的通知
      if (config.state === 'warn' && config.isCancellationNotice) {
        this.noticeService.update(config);
      }
      // 其他所有更新都被忽略
      return;
    }
    
    // 正常状态下直接更新
    this.noticeService.update(config);
  }

  /**
   * 确保取消状态的最终显示
   * 使用延迟确保所有异步回调执行完后，最终状态仍然是"已取消"
   */
  private ensureCancelState(buildDuration: string) {
    // 多次检查确保状态正确
    const checkTimes = [100, 300, 500];
    checkTimes.forEach(delay => {
      setTimeout(() => {
        // 再次检查是否仍处于取消状态
        if (this.cancelled && !this.buildCompleted && !this.isErrored) {
          this.updateCancelledNotice(buildDuration);
        }
      }, delay);
    });
  }

  /**
   * 取消当前编译过程
   */
  cancel() {
    if (this.cancelled) {
      console.log('已经处于取消状态，跳过');
      return; // 避免重复取消
    }

    // 如果当前没有进行中的编译流程，直接返回，避免初始化时误报“编译已取消”
    const isBuilding = this.workflowService.currentState === ProcessState.BUILDING;
    const hasActiveProcess = !!this.buildSubscription || !!this.streamId;
    if (!isBuilding && !hasActiveProcess) {
      console.log('没有进行中的编译，忽略取消请求');
      return;
    }
    
    console.log('开始取消编译流程...');
    
    // 立即设置取消标志，防止任何后续处理
    this.cancelled = true;
    this.clearProgressTimer(); // 清理定时器
    
    // 计算已经花费的时间
    const buildEndTime = Date.now();
    const buildDuration = this.buildStartTime > 0 ? ((buildEndTime - this.buildStartTime) / 1000).toFixed(2) : '0.00';

    // 1. 先 unsubscribe 订阅（立即停止接收数据）
    if (this.buildSubscription) {
      try {
        this.buildSubscription.unsubscribe();
        console.log('已取消订阅');
      } catch (err) {
        console.error('取消订阅失败:', err);
      }
    }

    // 2. 尝试 kill streamId（如果已经获取到）
    const killPromises: Promise<any>[] = [];
    
    if (this.streamId) {
      console.log('通过 streamId 终止进程:', this.streamId);
      killPromises.push(
        this.cmdService.kill(this.streamId)
          .then(success => {
            console.log('通过 streamId 终止成功:', success);
            return success;
          })
          .catch(err => {
            console.error('通过 streamId 终止失败:', err);
            return false;
          })
      );
    }
    
    // 等待已登记的终止操作完成
    Promise.all(killPromises).then(() => {
      console.log('所有终止操作已完成');
    });

    // 4. 立即更新 UI 状态
    this.updateCancelledNotice(buildDuration);

    // 5. 完成 workflow 状态
    this.workflowService.finishBuild(false, 'Cancelled');
    
    // 6. 处理 Promise（如果还有效）
    if (this.buildPromiseReject) {
      console.log('执行 Promise reject');
      const rejectFunc = this.buildPromiseReject;
      this.buildPromiseReject = null; // 先清空，避免重复调用
      this.buildSubscription = null; // 同时清空订阅引用
      
      // 使用 setTimeout 确保同步操作完成后再 reject
      setTimeout(() => {
        rejectFunc({ state: 'warn', text: this.t('CANCELLED_WITH_TIME', { seconds: buildDuration }) });
      }, 0);
    } else {
      console.log('Promise 已完成，仅清理资源');
      this.buildSubscription = null;
    }

    // 7. 确保最终状态显示正确（防止异步回调覆盖）
    this.ensureCancelState(buildDuration);

    console.log('取消编译流程完成');
  }

  // /**
  //  * 获取输出文件路径
  //  * @returns 编译生成的输出文件完整路径
  //  */
  // getOutputFilePath(): string {
  //   return this.outputFilePath;
  // }
}
