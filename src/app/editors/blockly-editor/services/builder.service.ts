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
    private electronService: ElectronService
  ) { }

  // buildInProgress = false;
  private streamId: string | null = null;
  private buildCompleted = false;
  private isErrored = false; // 标识是否为错误状态
  private buildStartTime: number = 0; // 编译开始时间

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
  }

  destroy() {
    this.actionService.unlisten('builder-compile-begin');
    this.actionService.unlisten('builder-compile-cancel');
    this.initialized = false; // 重置初始化状态
  }

  // 添加这个错误处理方法
  private handleCompileError(errorMessage: string, sendToLog: boolean = true): void {
    // 计算编译耗时
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

    return new Promise<ActionState>(async (resolve, reject) => {
      try {
        let text = "首次编译可能会等待较长时间";

        // 检测 buildPath 是否存在
        try {
          const buildPath = await this.projectService.getBuildPath();
          if (buildPath && window['path'].isExists(buildPath)) {
            text = "闪电构建系统正在运行";
          }
        } catch (error) {
          console.log('首次编译');
        }

        this.noticeService.update({
          title: "编译准备中",
          text: text,
          state: 'doing',
          progress: 0,
          setTimeout: 0,
          stop: () => {
            this.cancel();
          }
        });

        this.currentProjectPath = this.projectService.currentProjectPath;
        this.streamId = "";
        this.buildStartTime = Date.now(); // 记录编译开始时间

        let compileCommand: string = "";
        let completeTitle: string = `编译完成`;

        try {
          // 生成代码
          const code = arduinoGenerator.workspaceToCode(this.blocklyService.workspace);
          this.lastCode = code;
          const tempPath = this.electronService.pathJoin(this.currentProjectPath, '.temp');
          const ailyBuilderPath = window['path'].getAilyBuilderPath();
          const boardModule = await this.projectService.getBoardModule();
          const boardName = boardModule.replace('@aily-project/board-', '');

          // 构建配置对象
          const buildConfig = {
            currentProjectPath: this.currentProjectPath,
            boardModule,
            code,
            appDataPath: window['path'].getAppDataPath(),
            za7Path: this.platformService.za7,
            ailyBuilderPath,
            devmode: this.configService.data.devmode || false,
            partitionFilePath: this.electronService.pathJoin(this.currentProjectPath, 'partitions.csv')
          };

          // 写入配置文件
          const configFilePath = this.electronService.pathJoin(tempPath, 'build-config.json');
          if (!window['path'].isExists(tempPath)) {
             await this.crossPlatformCmdService.createDirectory(tempPath, true);
          }
          await window['fs'].writeFileSync(configFilePath, JSON.stringify(buildConfig, null, 2));

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

          this.buildStartTime = Date.now();

          this.noticeService.update({
            title: "编译依赖分析中",
            text: lastBuildText,
            state: 'doing',
            progress: 0,
            setTimeout: 0,
            stop: () => {
              this.cancel();
            }
          });

          this.cmdService.run(compileCommand, null, false).subscribe({
            next: (output: CmdOutput) => {
              if (output.type === 'close' && output.code !== 0) {
                this.isErrored = true;
                return;
              }
              if (this.cancelled) {
                return;
              }
              this.streamId = output.streamId;

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
                      this.noticeService.update({
                        title: `正在编译${boardName}`,
                        text: lastBuildText,
                        state: 'doing',
                        progress: lastProgress,
                        setTimeout: 0,
                        stop: () => {
                          this.cancel();
                        }
                      });
                    }

                    if (lastProgress === 100) {
                      this.buildCompleted = true;
                    }

                    if (trimmedLine.includes('Global variables use')) {
                      outputComplete = true;
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
              this.handleCompileError(error.message);
              reject({ state: 'error', text: error.message });
            },
            complete: () => {
              console.log("编译完成： ", this.buildCompleted, this.isErrored, this.cancelled);

              if (this.buildCompleted) {
                console.log('编译命令执行完成');
                const buildEndTime = Date.now();
                const buildDuration = ((buildEndTime - this.buildStartTime) / 1000).toFixed(2);
                console.log(`编译耗时: ${buildDuration} 秒`);

                const displayText = this.extractFirmwareInfo(lastLogLines);
                const displayTextWithTime = `${displayText} (耗时: ${buildDuration}s)`;
                this.noticeService.update({ title: completeTitle, text: displayTextWithTime, state: 'done', setTimeout: 600000 });
                this.passed = true;
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
                this.workflowService.finishBuild(false, 'Cancelled');
                reject({ state: 'warn', text: `编译已取消 (耗时: ${buildDuration}s)` });
              }
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
        this.handleCompileError(error.message);
        this.workflowService.finishBuild(false, error.message);
        reject({ state: 'error', text: error.message });
      }
    });
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
   * 取消当前编译过程
   */
  cancel() {
    this.cancelled = true;
    this.cmdService.kill(this.streamId || '');

    // 输出编译正在取消中
    this.noticeService.update({
      title: "取消中",
      text: `编译取消中，请稍候...`,
      state: 'doing',
      setTimeout: 0
    });
  }

  // /**
  //  * 获取输出文件路径
  //  * @returns 编译生成的输出文件完整路径
  //  */
  // getOutputFilePath(): string {
  //   return this.outputFilePath;
  // }
}
