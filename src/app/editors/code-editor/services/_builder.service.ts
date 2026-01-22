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
import { PlatformService } from "../../../services/platform.service";
import { ElectronService } from '../../../services/electron.service';
import { WorkflowService, ProcessState } from '../../../services/workflow.service';

/**
 * Code Editor 的本地编译服务
 * 参考 blockly-editor 的 _BuilderService 实现
 */
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
    private platformService: PlatformService,
    private electronService: ElectronService
  ) { }

  private streamId: string | null = null;
  private buildSubscription: any = null;
  private buildPromiseReject: any = null;
  private buildCompleted = false;
  private isErrored = false;
  private buildStartTime: number = 0;
  private progressTimer: any = null;
  private currentProgress: number = 0;
  private hasReceivedRealProgress: boolean = false;

  currentProjectPath = "";
  lastCodeHash = "";
  passed = false;
  cancelled = false;
  boardJson: any = null;
  isUploading = false;

  private initialized = false;

  init() {
    if (this.initialized) {
      console.warn('Code Editor _BuilderService 已经初始化过了，跳过重复初始化');
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
    }, 'code-editor-compile-begin');
    
    this.actionService.listen('compile-cancel', (action) => {
      this.cancel();
    }, 'code-editor-compile-cancel');
    
    this.actionService.listen('compile-reset', async (action) => {
      this.passed = false;
      this.lastCodeHash = "";
    }, 'code-editor-compile-reset');
  }

  destroy() {
    this.actionService.unlisten('code-editor-compile-begin');
    this.actionService.unlisten('code-editor-compile-cancel');
    this.actionService.unlisten('code-editor-compile-reset');
    this.clearProgressTimer();
    this.initialized = false;
  }

  /**
   * 错误处理方法
   */
  private handleCompileError(errorMessage: string, sendToLog: boolean = true): void {
    const buildEndTime = Date.now();
    const buildDuration = this.buildStartTime > 0 ? ((buildEndTime - this.buildStartTime) / 1000).toFixed(2) : '0.00';
    console.log(`编译错误，耗时: ${buildDuration} 秒`);

    this.noticeService.update({
      title: "编译失败",
      text: `${errorMessage} (耗时: ${buildDuration}s)`,
      state: 'error',
      detail: errorMessage,
      setTimeout: 600000,
      sendToLog: sendToLog
    });

    this.passed = false;
    this.isErrored = true;
  }

  /**
   * 编译项目
   */
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
    this.buildSubscription = null;
    this.buildPromiseReject = null;
    this.clearProgressTimer();
    this.currentProgress = 0;
    this.hasReceivedRealProgress = false;

    return new Promise<ActionState>(async (resolve, reject) => {
      this.buildPromiseReject = reject;
      
      try {
        this.currentProjectPath = this.projectService.currentProjectPath;
        this.streamId = null;
        this.buildStartTime = Date.now();

        const tempPath = this.electronService.pathJoin(this.currentProjectPath, '.temp');

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

        // 获取板子信息
        const boardModule = await this.projectService.getBoardModule();
        const boardName = boardModule.replace('@aily-project/board-', '');
        const boardJson = await this.projectService.getBoardJson();

        if (!boardJson) {
          this.handleCompileError('未找到板子信息(board.json)');
          this.workflowService.finishBuild(false, 'Board not found');
          reject({ state: 'error', text: '未找到板子信息' });
          return;
        }

        this.boardJson = boardJson;

        // 准备编译配置
        const ailyBuilderPath = window['path'].getAilyBuilderPath();
        
        // 读取项目代码（用于计算哈希）
        const mainFilePath = await this.findMainFile();
        let code = '';
        if (mainFilePath && window['path'].isExists(mainFilePath)) {
          code = window['fs'].readFileSync(mainFilePath, 'utf8');
        }

        // 构建配置对象
        const buildConfig = {
          currentProjectPath: this.currentProjectPath,
          boardModule,
          code,
          appDataPath: window['path'].getAppDataPath(),
          za7Path: this.platformService.za7,
          ailyBuilderPath,
          devmode: this.configService.data.devmode || false,
          partitionFilePath: this.electronService.pathJoin(this.currentProjectPath, 'partitions.csv'),
          isCodeEditor: true  // 标记为代码编辑器模式
        };

        // 写入配置文件
        const configFilePath = this.electronService.pathJoin(tempPath, 'build-config.json');
        if (!window['path'].isExists(tempPath)) {
          await this.crossPlatformCmdService.createDirectory(tempPath, true);
        }
        await window['fs'].writeFileSync(configFilePath, JSON.stringify(buildConfig, null, 2));

        // 运行编译脚本
        const compileScriptPath = this.electronService.pathJoin(window['path'].getAilyChildPath(), 'scripts', 'compile.js');
        const compileCommand = `node "${compileScriptPath}" "${configFilePath}"`;

        const completeTitle = `编译完成`;

        let lastProgress = 0;
        let lastBuildText = '';
        let bufferData = '';
        let lastStdErr = '';
        let fullStdErr = '';
        let outputComplete = false;
        let lastLogLines: string[] = [];

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

        this.buildSubscription = this.cmdService.run(compileCommand, null, false).subscribe({
          next: (output: CmdOutput) => {
            if (this.cancelled) {
              return;
            }
            
            if (!this.streamId && output.streamId) {
              this.streamId = output.streamId;
              console.log('捕获到 streamId:', this.streamId);
            }
            
            if (output.type === 'close' && output.code !== 0) {
              this.isErrored = true;
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
                    
                    if (progressValue > this.currentProgress) {
                      this.currentProgress = progressValue;
                      
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
            this.buildSubscription = null;
            this.buildPromiseReject = null;
            this.handleCompileError(error.message);
            this.workflowService.finishBuild(false, error.message);
            reject({ state: 'error', text: error.message });
          },
          complete: () => {
            this.clearProgressTimer();
            console.log("编译完成： ", this.buildCompleted, this.isErrored, this.cancelled);

            if (this.buildCompleted) {
              console.log('编译命令执行完成');
              const buildEndTime = Date.now();
              const buildDuration = ((buildEndTime - this.buildStartTime) / 1000).toFixed(2);
              console.log(`编译耗时: ${buildDuration} 秒`);

              const displayText = this.extractFirmwareInfo(lastLogLines);
              const displayTextWithTime = `${displayText} (耗时: ${buildDuration}s)`;
              
              this.safeUpdateNotice({ title: completeTitle, text: displayTextWithTime, state: 'done', setTimeout: 600000 });
              
              this.passed = true;
              
              // 保存编译元数据
              this.saveBuildInfo('success', buildDuration);
              
              this.workflowService.finishBuild(true);
              resolve({ state: 'done', text: `编译完成 (耗时: ${buildDuration}s)` });
            } else if (this.isErrored) {
              const buildEndTime = Date.now();
              const buildDuration = ((buildEndTime - this.buildStartTime) / 1000).toFixed(2);
              console.log(`编译失败，耗时: ${buildDuration} 秒`);

              lastStdErr = lastStdErr.replace(/\[\d+(;\d+)*m/g, '');
              this.handleCompileError(lastStdErr || '编译未完成', false);
              this.logService.update({ detail: fullStdErr, state: 'error' });
              this.passed = false;
              
              this.saveBuildInfo('failed', buildDuration);
              
              this.workflowService.finishBuild(false, 'Compilation failed');
              reject({ state: 'error', text: `编译失败 (耗时: ${buildDuration}s)` });
            } else if (this.cancelled) {
              console.warn("编译中断")
              const buildEndTime = Date.now();
              const buildDuration = ((buildEndTime - this.buildStartTime) / 1000).toFixed(2);
              console.log(`编译已取消，耗时: ${buildDuration} 秒`);

              this.noticeService.update({
                title: "编译已取消",
                text: `编译已取消 (耗时: ${buildDuration}s)`,
                state: 'warn',
                setTimeout: 55000
              });
              this.passed = false;
              
              this.saveBuildInfo('cancelled', buildDuration);
              
              this.workflowService.finishBuild(false, 'Cancelled');
              reject({ state: 'warn', text: `编译已取消 (耗时: ${buildDuration}s)` });
            } else {
              console.error('编译进程异常结束，未知状态');
              const buildEndTime = Date.now();
              const buildDuration = ((buildEndTime - this.buildStartTime) / 1000).toFixed(2);
              
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
            
            this.buildSubscription = null;
            this.buildPromiseReject = null;
          }
        });
      } catch (error) {
        this.handleCompileError(error.message);
        this.workflowService.finishBuild(false, error.message);
        reject({ state: 'error', text: error.message });
      }
    });
  }

  /**
   * 查找项目主文件
   */
  private async findMainFile(): Promise<string | null> {
    const projectPath = this.projectService.currentProjectPath;
    
    // 尝试查找 .ino 文件
    const files = window['fs'].readDirSync(projectPath);
    for (const file of files) {
      const name = typeof file === 'object' ? file.name : file;
      if (name.endsWith('.ino')) {
        return this.electronService.pathJoin(projectPath, name);
      }
    }
    
    // 尝试查找 src 目录下的 main.cpp
    const srcMainCpp = this.electronService.pathJoin(projectPath, 'src', 'main.cpp');
    if (window['path'].isExists(srcMainCpp)) {
      return srcMainCpp;
    }
    
    // 尝试查找根目录下的 main.cpp
    const mainCpp = this.electronService.pathJoin(projectPath, 'main.cpp');
    if (window['path'].isExists(mainCpp)) {
      return mainCpp;
    }
    
    return null;
  }

  /**
   * 保存编译元数据到 package.json
   */
  private async saveBuildInfo(
    status: 'success' | 'failed' | 'cancelled',
    duration: string
  ): Promise<void> {
    try {
      const currentPackageJson = await this.projectService.getPackageJson();
      if (!currentPackageJson) return;

      if (!currentPackageJson.buildInfo) {
        currentPackageJson.buildInfo = {};
      }

      currentPackageJson.buildInfo = {
        lastBuildTime: new Date().toISOString(),
        lastBuildStatus: status,
        lastBuildDuration: parseFloat(duration)
      };

      await this.projectService.setPackageJson(currentPackageJson);
      console.log('✅ 编译元数据已保存:', currentPackageJson.buildInfo);
    } catch (error) {
      console.error('❌ 保存编译元数据失败:', error);
    }
  }

  /**
   * 从编译日志中提取固件信息
   */
  private extractFirmwareInfo(logLines: string[]): string {
    const logText = logLines.join(' ');
    const flashMatch = logText.match(/Sketch uses (\d+) bytes \((\d+)%\) of program storage space\.\s*Maximum is (\d+) bytes/);
    const ramMatch = logText.match(/Global variables use (\d+) bytes \((\d+)%\) of dynamic memory.*?Maximum is (\d+) bytes/);

    if (flashMatch && ramMatch) {
      const flashPercent = flashMatch[2];
      const ramPercent = ramMatch[2];
      return `Flash use ${flashPercent}%   Ram use ${ramPercent}%`;
    }

    return "编译完成";
  }

  /**
   * 清理进度定时器
   */
  private clearProgressTimer() {
    if (this.progressTimer) {
      clearInterval(this.progressTimer);
      this.progressTimer = null;
    }
  }

  /**
   * 安全的通知更新方法
   */
  private safeUpdateNotice(config: any) {
    if (this.cancelled) {
      if (config.state === 'warn' && config.title && config.title.includes('取消')) {
        this.noticeService.update(config);
      }
      return;
    }
    this.noticeService.update(config);
  }

  /**
   * 确保取消状态的最终显示
   */
  private ensureCancelState(buildDuration: string) {
    const checkTimes = [100, 300, 500];
    checkTimes.forEach(delay => {
      setTimeout(() => {
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
      return;
    }

    const isBuilding = this.workflowService.currentState === ProcessState.BUILDING;
    const hasActiveProcess = !!this.buildSubscription || !!this.streamId;
    if (!isBuilding && !hasActiveProcess) {
      console.log('没有进行中的编译，忽略取消请求');
      return;
    }
    
    console.log('开始取消编译流程...');
    
    this.cancelled = true;
    this.clearProgressTimer();
    
    const buildEndTime = Date.now();
    const buildDuration = this.buildStartTime > 0 ? ((buildEndTime - this.buildStartTime) / 1000).toFixed(2) : '0.00';

    if (this.buildSubscription) {
      try {
        this.buildSubscription.unsubscribe();
        console.log('已取消订阅');
      } catch (err) {
        console.error('取消订阅失败:', err);
      }
    }

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

    Promise.all(killPromises).then(() => {
      console.log('所有终止操作已完成');
    });

    this.noticeService.update({
      title: "编译已取消",
      text: `编译已取消 (耗时: ${buildDuration}s)`,
      state: 'warn',
      setTimeout: 5000
    });

    this.workflowService.finishBuild(false, 'Cancelled');
    
    if (this.buildPromiseReject) {
      console.log('执行 Promise reject');
      const rejectFunc = this.buildPromiseReject;
      this.buildPromiseReject = null;
      this.buildSubscription = null;
      
      setTimeout(() => {
        rejectFunc({ state: 'warn', text: `编译已取消 (耗时: ${buildDuration}s)` });
      }, 0);
    } else {
      console.log('Promise 已完成，仅清理资源');
      this.buildSubscription = null;
    }

    this.ensureCancelState(buildDuration);

    console.log('取消编译流程完成');
  }
}
