import { Injectable } from '@angular/core';
import { CmdOutput, CmdService } from '../../../services/cmd.service';
import { CrossPlatformCmdService } from '../../../services/cross-platform-cmd.service';
import { NzMessageService } from 'ng-zorro-antd/message';
import { NoticeService } from '../../../services/notice.service';
import { ProjectService } from '../../../services/project.service';
import { LogService } from '../../../services/log.service';
import { ConfigService } from '../../../services/config.service';
import { ActionState } from '../../../services/ui.service';
import { ActionService } from '../../../services/action.service';
import { arduinoGenerator } from '../components/blockly/generators/arduino/arduino';

import { BlocklyService as BlocklyService } from './blockly.service';

import { PlatformService } from "../../../services/platform.service";
import { ElectronService } from '../../../services/electron.service';
import { WorkflowService, ProcessState } from '../../../services/workflow.service';
import { CompileValidationService } from '../../../services/compile-validation.service';

@Injectable()
export class _BuilderService {

  constructor(
    private cmdService: CmdService,
    private crossPlatformCmdService: CrossPlatformCmdService,
    private message: NzMessageService,
    private noticeService: NoticeService,
    private logService: LogService,
    private workflowService: WorkflowService,
    private configService: ConfigService,
    private actionService: ActionService,
    private projectService: ProjectService,
    private blocklyService: BlocklyService,
    private platformService: PlatformService,
    private electronService: ElectronService,
    private compileValidationService: CompileValidationService
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
  private aiWaitingSubscription: any = null; // 保存 AI 等待状态订阅引用

  currentProjectPath = "";
  lastCode = "";
  passed = false;
  cancelled = false;
  boardJson: any = null;
  isUploading = false;

  private initialized = false; // 防止重复初始化

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
      this.blocklyService.dependencySubject.next(reason);
      return { success: true };
    }, 'builder-preprocess-trigger');

    // 保存订阅引用以便后续取消
    this.dependencySubscription = this.blocklyService.dependencySubject.subscribe(async (data) => {
      // 检查项目加载状态，如果正在加载中则跳过预处理
      if (!data || this.projectService.stateSubject.value === 'loading') {
        console.log('项目正在加载中，跳过依赖预处理');
        return;
      }

      // 互斥条件1：AI操作期间不触发自动预编译，但标记需要延迟执行
      if (this.blocklyService.aiWaiting) {
        console.log('AI操作进行中，标记延迟预编译');
        this.pendingPrecompile = true;
        return;
      }

      // 互斥条件2：编译、上传或依赖安装进行中不触发自动预编译
      const currentState = this.workflowService.currentState;
      if (currentState === ProcessState.BUILDING || currentState === ProcessState.UPLOADING || currentState === ProcessState.INSTALLING) {
        console.log('编译/上传/依赖安装进行中，跳过自动预编译');
        return;
      }

      // 删除temp目录下的preprocess.json文件，并在后台运行预处理
      const tempPath = this.electronService.pathJoin(this.projectService.currentProjectPath, '.temp');
      const preprocessCachePath = this.electronService.pathJoin(tempPath, 'preprocess.json');

      console.log('检测到依赖变化，准备重新预处理');

      // 1. 先终止正在运行的预处理进程（如果有）
      if (this.preprocessProcess || this.preprocessStreamId) {
        console.log('终止正在运行的预处理进程...');
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
        }
      }

      // 2. 删除预编译缓存文件
      if (window['path'].isExists(preprocessCachePath)) {
        try {
          window['fs'].unlinkSync(preprocessCachePath);
          console.log('已删除预编译缓存文件:', preprocessCachePath);
        } catch (error) {
          console.warn('删除预编译缓存文件失败:', error);
          return;
        }
      }

      // 2. 在后台运行预处理脚本
      try {
        // 检查 workspace 是否已初始化
        if (!this.blocklyService.workspace) {
          console.log('Blockly workspace 未初始化，跳过自动预编译');
          return;
        }
        
        const code = arduinoGenerator.workspaceToCode(this.blocklyService.workspace);
        if (!code) {
          return;
        }
        const currentProjectPath = this.projectService.currentProjectPath;
        const ailyBuilderPath = window['path'].getAilyBuilderPath();
        const boardModule = await this.projectService.getBoardModule();
        const appDataPath = window['path'].getAppDataPath();
        const ailyChildPath = window['path'].getAilyChildPath();

        // 参数校验：检查所有必需参数是否存在
        const missingParams: string[] = [];
        if (!currentProjectPath) missingParams.push('currentProjectPath');
        if (!ailyBuilderPath) missingParams.push('ailyBuilderPath');
        if (!boardModule) missingParams.push('boardModule');
        if (!appDataPath) missingParams.push('appDataPath');
        if (!ailyChildPath) missingParams.push('ailyChildPath');

        if (missingParams.length > 0) {
          console.error('[后台预处理] 参数校验失败，缺少以下参数:', missingParams.join(', '));
          console.error('[后台预处理] 参数详情:', {
            currentProjectPath,
            ailyBuilderPath,
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
          ailyBuilderPath,
          devmode: this.configService.data.devmode || false,
          partitionFilePath: this.electronService.pathJoin(currentProjectPath, 'partitions.csv')
        };

        // 写入配置文件
        const configFilePath = this.electronService.pathJoin(tempPath, 'build-config.json');
        if (!window['path'].isExists(tempPath)) {
          await this.crossPlatformCmdService.createDirectory(tempPath, true);
        }
        await window['fs'].writeFileSync(configFilePath, JSON.stringify(buildConfig, null, 2));

        // 运行预处理脚本（后台运行）
        const preprocessScriptPath = this.electronService.pathJoin(window['path'].getAilyChildPath(), 'scripts', 'preprocess.js');
        const preprocessCommand = `node "${preprocessScriptPath}" "${configFilePath}"`;

        console.log('开始后台运行预处理脚本');

        // 重置预编译错误状态
        this.preprocessError = null;
        this.preprocessFullError = '';

        // 使用 cmdService 后台静默运行预处理脚本
        const subscription = this.cmdService.run(preprocessCommand, null, false).subscribe({
          next: (output) => {
            // 捕获 streamId
            if (!this.preprocessStreamId && output.streamId) {
              this.preprocessStreamId = output.streamId;
              console.log('捕获到预处理 streamId:', this.preprocessStreamId);
            }
            
            // 将预编译普通输出发送到日志（错误信息先收集，最后统一发送）
            if (output.data) {
              // 检查输出中是否包含错误信息
              if (output.data.includes('[ERROR]') || output.data.toLowerCase().includes('error:')) {
                this.preprocessFullError += output.data + '\n';
                // 提取关键错误信息
                const errorLine = output.data.split('\n').find((line: string) => 
                  line.includes('[ERROR]') || line.toLowerCase().includes('error:')
                );
                if (errorLine) {
                  this.preprocessError = errorLine.trim();
                }
              } else {
                // 非错误信息正常发送到日志
                this.logService.update({ "detail": output.data, "state": "doing" });
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
            console.warn('后台预处理失败:', errorMsg);
            // 收集错误信息
            this.preprocessError = '后台预处理失败: ' + errorMsg;
            this.preprocessFullError += '后台预处理失败: ' + errorMsg + '\n';
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
            } else {
              console.log('后台预处理完成');
              this.logService.update({ "detail": '后台预处理完成', "state": "done" });
            }
            // 清理引用
            if (this.preprocessProcess === subscription) {
              this.preprocessProcess = null;
              this.preprocessStreamId = null;
            }
          }
        });
        
        // 保存订阅引用以便后续终止
        this.preprocessProcess = subscription;
      } catch (error) {
        console.warn('启动后台预处理失败:', error);
      }
    });

    // 监听 AI 操作状态变化
    this.aiWaitingSubscription = this.blocklyService.aiWaiting$.subscribe(async (waiting) => {
      if (waiting) {
        // AI 操作开始，终止正在运行的预编译（结果会过时）
        if (this.preprocessProcess || this.preprocessStreamId) {
          console.log('AI操作开始，终止正在运行的预编译');
          this.pendingPrecompile = true; // 标记需要重新预编译
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
            console.warn('终止预编译进程失败:', error);
          }
        }
      } else {
        // AI 操作完成，触发延迟的预编译
        if (this.pendingPrecompile) {
          console.log('AI操作已完成，触发延迟的预编译');
          this.pendingPrecompile = false;
          setTimeout(() => {
            if (!this.blocklyService.aiWaiting) {
              this.blocklyService.dependencySubject.next('ai-complete');
            } else {
              this.pendingPrecompile = true;
            }
          }, 100);
        }
      }
    });
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

  /**
   * 运行预编译脚本（同步等待完成）
   */
  private async runPreprocess(): Promise<void> {
    const currentProjectPath = this.projectService.currentProjectPath;
    const ailyBuilderPath = window['path'].getAilyBuilderPath();
    const boardModule = await this.projectService.getBoardModule();
    const appDataPath = window['path'].getAppDataPath();
    const ailyChildPath = window['path'].getAilyChildPath();

    // 参数校验：检查所有必需参数是否存在
    const missingParams: string[] = [];
    if (!currentProjectPath) missingParams.push('currentProjectPath');
    if (!ailyBuilderPath) missingParams.push('ailyBuilderPath');
    if (!boardModule) missingParams.push('boardModule');
    if (!appDataPath) missingParams.push('appDataPath');
    if (!ailyChildPath) missingParams.push('ailyChildPath');

    if (missingParams.length > 0) {
      const errorMsg = `[同步预处理] 参数校验失败，缺少以下参数: ${missingParams.join(', ')}`;
      console.error(errorMsg);
      console.error('[同步预处理] 参数详情:', {
        currentProjectPath,
        ailyBuilderPath,
        boardModule,
        appDataPath,
        ailyChildPath
      });
      throw new Error(errorMsg);
    }

    const tempPath = this.electronService.pathJoin(currentProjectPath, '.temp');
    
    // 生成代码
    const code = arduinoGenerator.workspaceToCode(this.blocklyService.workspace);
    this.lastCode = code; // 保存代码用于后续 hash 计算

    // 构建配置对象
    const buildConfig = {
      currentProjectPath,
      boardModule,
      code,
      appDataPath,
      za7Path: this.platformService.za7,
      ailyBuilderPath,
      devmode: this.configService.data.devmode || false,
      partitionFilePath: this.electronService.pathJoin(currentProjectPath, 'partitions.csv')
    };

    // 写入配置文件
    const configFilePath = this.electronService.pathJoin(tempPath, 'build-config.json');
    if (!window['path'].isExists(tempPath)) {
      await this.crossPlatformCmdService.createDirectory(tempPath, true);
    }
    await window['fs'].writeFileSync(configFilePath, JSON.stringify(buildConfig, null, 2));

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
          } else {
            console.log('同步预处理完成');
            this.logService.update({ "detail": '同步预处理完成', "state": "done" });
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
      title: "编译失败",
      text: `${cleanErrorMessage} (耗时: ${buildDuration}s)`,
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
      let msg = "系统繁忙";
      if (state === ProcessState.BUILDING) msg = "编译正在进行中";
      else if (state === ProcessState.UPLOADING) msg = "上传正在进行中";
      else if (state === ProcessState.INSTALLING) msg = "依赖安装中";
      
      this.message.warning(msg + "，请稍后再试");
      return Promise.reject({ state: 'warn', text: msg + "，请稍后" });
    }

    this.buildCompleted = false;
    this.isErrored = false;
    this.cancelled = false;
    this.buildSubscription = null; // 重置订阅引用
    this.buildPromiseReject = null; // 重置 reject 函数
    this.clearProgressTimer(); // 清理之前的定时器
    this.currentProgress = 0; // 重置进度
    this.hasReceivedRealProgress = false; // 重置进度标记

    return new Promise<ActionState>(async (resolve, reject) => {
      // 保存 reject 函数，以便在 cancel 时使用
      this.buildPromiseReject = reject;
      
      try {
        this.currentProjectPath = this.projectService.currentProjectPath;
        this.streamId = null; // 初始化为 null
        this.buildStartTime = Date.now(); // 记录编译开始时间

        const tempPath = this.electronService.pathJoin(this.currentProjectPath, '.temp');
        const preprocessCachePath = this.electronService.pathJoin(tempPath, 'preprocess.json');

        // 1. 检查是否有预编译程序正在运行，等待其完成
        if (this.preprocessProcess) {
          this.safeUpdateNotice({
            title: "编译准备中",
            text: "预编译正在运行",
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
              reject({ state: 'warn', text: '编译已取消' });
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
            title: "预编译失败",
            text: "依赖分析时发生错误，请查看日志了解详情",
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
          
          reject({ state: 'error', text: '预编译失败，请查看日志了解详情' });
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
            title: "编译准备中",
            text: "依赖分析系统正在运行",
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
                title: "预编译失败",
                text: `${cleanError} (耗时: ${buildDuration}s)`,
                state: 'error',
                detail: cleanError,
                setTimeout: 600000,
                sendToLog: false
              });
              
              this.passed = false;
              this.workflowService.finishBuild(false, 'Preprocessing error');
              
              this.preprocessError = null;
              this.preprocessFullError = '';
              
              reject({ state: 'error', text: '预编译错误: ' + cleanError });
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
              title: "预编译失败",
              text: `${errorMsg} (耗时: ${buildDuration}s)`,
              state: 'error',
              detail: errorMsg,
              setTimeout: 600000,
              sendToLog: false
            });
            
            this.passed = false;
            this.workflowService.finishBuild(false, 'Preprocessing failed');
            reject({ state: 'error', text: '预编译失败: ' + errorMsg });
            return;
          }
        } else {
          console.log('发现预编译缓存，跳过预编译');
          // 即使有缓存，也需要生成代码以保存到 lastCode（用于后续 hash 计算）
          if (!this.lastCode) {
            const code = arduinoGenerator.workspaceToCode(this.blocklyService.workspace);
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
        let completeTitle: string = `编译完成`;

        try {
          // 获取最新代码
          const code = arduinoGenerator.workspaceToCode(this.blocklyService.workspace);
          this.lastCode = code;
          
          const boardModule = await this.projectService.getBoardModule();
          const boardName = boardModule.replace('@aily-project/board-', '');
          const configFilePath = this.electronService.pathJoin(tempPath, 'build-config.json');

          // 更新配置文件中的 code（compile.js 会负责写入 sketch 文件）
          let buildConfig: any = {};
          if (window['path'].isExists(configFilePath)) {
            buildConfig = JSON.parse(window['fs'].readFileSync(configFilePath, 'utf8'));
          }
          buildConfig.code = code;
          window['fs'].writeFileSync(configFilePath, JSON.stringify(buildConfig, null, 2));

          // 运行编译脚本
          const compileScriptPath = this.electronService.pathJoin(window['path'].getAilyChildPath(), 'scripts', 'compile.js');
          compileCommand = `node "${compileScriptPath}" "${configFilePath}"`;

          completeTitle = `编译完成`;

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

          const buildText = isFirstBuild ? "首次编译可能需要较长时间" : "闪电构建系统正在运行";
          
          this.safeUpdateNotice({
            title: `正在编译${boardName}`,
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
                    ? `编译进程被信号终止: ${processSignal}`
                    : `编译进程异常退出，退出码: ${processExitCode}`;
                  lastStdErr = lastStdErr || processErrorMessage;
                  if (!fullStdErr) {
                    fullStdErr = processErrorMessage;
                  }
                }
                return;
              }

              if (output.type === 'error') {
                this.isErrored = true;
                const processErrorMessage = output.error || '编译进程启动失败';
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
                          title: `正在编译${boardName}`,
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
                  ? `编译进程被信号终止: ${processSignal}`
                  : `编译进程异常退出，退出码: ${processExitCode}`;
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
                const displayTextWithTime = `${displayText} (耗时: ${buildDuration}s)`;
                
                // 安全更新UI
                this.safeUpdateNotice({ title: completeTitle, text: displayTextWithTime, state: 'done', setTimeout: 600000 });
                
                this.passed = true;
                
                // 保存编译元数据（不阻塞）
                this.electronService.calculateHash(this.lastCode).then(codeHash => {
                  this.saveBuildInfo('success', buildDuration, codeHash);
                });

                this.compileValidationService.triggerAfterSuccessfulCompile();
                
                this.workflowService.finishBuild(true);
                resolve({ state: 'done', text: `编译完成 (耗时: ${buildDuration}s)` });
              } else if (this.isErrored) {
                console.log(`编译失败，耗时: ${buildDuration} 秒`);

                lastStdErr = lastStdErr.replace(/\[\d+(;\d+)*m/g, '');
                this.handleCompileError(lastStdErr || '编译未完成', false, fullStdErr || lastStdErr || '编译未完成');
                this.logService.update({ detail: fullStdErr, state: 'error' });
                this.passed = false;
                
                // 记录编译失败状态（不阻塞）
                this.electronService.calculateHash(this.lastCode).then(codeHash => {
                  this.saveBuildInfo('failed', buildDuration, codeHash);
                });
                
                this.workflowService.finishBuild(false, 'Compilation failed');
                reject({ state: 'error', text: `编译失败 (耗时: ${buildDuration}s)`, fullStdErr: fullStdErr || lastStdErr });
              } else if (this.cancelled) {
                console.warn("编译中断")
                console.log(`编译已取消，耗时: ${buildDuration} 秒`);

                this.noticeService.update({
                  title: "编译已取消",
                  text: `编译已取消 (耗时: ${buildDuration}s)`,
                  state: 'warn',
                  setTimeout: 55000
                });
                this.passed = false;
                
                // 记录编译取消状态（不阻塞）
                this.electronService.calculateHash(this.lastCode).then(codeHash => {
                  this.saveBuildInfo('cancelled', buildDuration, codeHash);
                });
                
                this.workflowService.finishBuild(false, 'Cancelled');
                reject({ state: 'warn', text: `编译已取消 (耗时: ${buildDuration}s)` });
              } else {
                // 处理未知状态：进程异常结束但没有设置任何标志
                console.error('编译进程异常结束，未知状态，lastProgress:', lastProgress);
                
                this.noticeService.update({
                  title: "编译异常结束",
                  text: `编译进程异常结束 (耗时: ${buildDuration}s)`,
                  state: 'error',
                  setTimeout: 60000
                });
                this.passed = false;
                this.workflowService.finishBuild(false, 'Abnormal termination');
                reject({ state: 'error', text: `编译进程异常结束 (耗时: ${buildDuration}s)` });
              }
              
              // 最后清理订阅和 reject 引用
              this.buildSubscription = null;
              this.buildPromiseReject = null;
            }
          })
        } catch (error) {
          if (error.message === '编译已取消') {
            const buildEndTime = Date.now();
            const buildDuration = ((buildEndTime - this.buildStartTime) / 1000).toFixed(2);

            this.noticeService.update({
              title: "编译已取消",
              text: `编译已取消 (耗时: ${buildDuration}s)`,
              state: 'warn',
              setTimeout: 5000
            });
            this.cancelled = true;
            this.workflowService.finishBuild(false, 'Cancelled');

            reject({ state: 'warn', text: `编译已取消 (耗时: ${buildDuration}s)` });
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

    return "编译完成";
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
          title: `正在编译${boardName}`,
          text: '正在分析依赖...',
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
          title: `正在编译${boardName}`,
          text: '正在处理...',
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
      if (config.state === 'warn' && config.title && config.title.includes('取消')) {
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
          this.noticeService.update({
            title: "编译已取消",
            text: `编译已取消 (耗时: ${buildDuration}s)`,
            state: 'warn',
            setTimeout: 5000
          });
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
    
    // 3. 添加备用终止方案：强制杀死所有相关的 node 进程（compile.js）
    const killBackupCommand = this.platformService.isWindows
      ? `taskkill /F /FI "COMMANDLINE like %compile.js%" /T`
      : `pkill -f "compile.js"`;
    
    killPromises.push(
      this.cmdService.run(killBackupCommand, null, false).toPromise()
        .then(() => {
          console.log('备用终止方案执行成功');
          return true;
        })
        .catch(err => {
          console.log('备用终止方案执行（可能没有匹配的进程）');
          return false;
        })
    );

    // 等待所有终止操作完成
    Promise.all(killPromises).then(() => {
      console.log('所有终止操作已完成');
    });

    // 4. 立即更新 UI 状态
    this.noticeService.update({
      title: "编译已取消",
      text: `编译已取消 (耗时: ${buildDuration}s)`,
      state: 'warn',
      setTimeout: 5000
    });

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
        rejectFunc({ state: 'warn', text: `编译已取消 (耗时: ${buildDuration}s)` });
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
