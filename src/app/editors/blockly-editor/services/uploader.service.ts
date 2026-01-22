import { Injectable } from "@angular/core";
import { ProjectService } from "../../../services/project.service";
import { SerialService } from "../../../services/serial.service";
import { NzMessageService } from "ng-zorro-antd/message";
import { _BuilderService } from "./builder.service";
import { NoticeService } from "../../../services/notice.service";
import { NzModalService } from "ng-zorro-antd/modal";
import { CmdOutput, CmdService } from "../../../services/cmd.service";
import { LogService } from "../../../services/log.service";
import { NpmService } from "../../../services/npm.service";
import { SerialMonitorService } from "../../../tools/serial-monitor/serial-monitor.service";
import { ActionState } from "../../../services/ui.service";
import { ActionService } from "../../../services/action.service";
import { arduinoGenerator } from "../components/blockly/generators/arduino/arduino";
import { BlocklyService } from "./blockly.service";
import { WorkflowService, ProcessState } from '../../../services/workflow.service';

@Injectable()
export class _UploaderService {

  constructor(
    private projectService: ProjectService,
    private serialService: SerialService,
    private message: NzMessageService,
    private _builderService: _BuilderService,
    private noticeService: NoticeService,
    private modal: NzModalService,
    private cmdService: CmdService,
    private logService: LogService,
    private npmService: NpmService,
    private serialMonitorService: SerialMonitorService,
    private actionService: ActionService,
    private blocklyService: BlocklyService,
    private workflowService: WorkflowService
  ) { }

  uploadInProgress = false;
  private streamId: string | null = null;
  private uploadCompleted = false;
  private isErrored = false;
  cancelled = false;
  private uploadPromiseReject: any = null; // 保存 Promise 的 reject 函数

  private initialized = false; // 防止重复初始化

  // 定义正则表达式，匹配常见的进度格式
  progressRegexPatterns = [
    // Writing | ################################################## | 78% 0.12s
    /\|\s*#+\s*\|\s*\d+%.*$/,
    // [==============================] 84% (11/13 pages)
    /\[\s*={1,}>*\s*\]\s*\d+%.*$/,
    // Writing | ████████████████████████████████████████████████▉  | 98% 
    /\|\s*\d+%\s*$/,
    // Writing at 0x00a2b8d7 [============================> ]  97.1% 196608/202563 bytes...
    /Writing\s+at\s+0x[0-9a-f]+\s+\[.*?\]\s+(\d+(?:\.\d+)?)%/i,
    // Writing at 0x0005446e... (18 %)
    // Writing at 0x0002d89e... (40 %)
    // Writing at 0x0003356b... (50 %)
    /Writing\s+at\s+0x[0-9a-f]+\.\.\.\s+\(\d+\s*%\)/i,
    // Wrote and verified address 0x08001700 (79.31%)
    /Wrote\s+and\s+verified\s+address\s+0x[0-9a-f]+\s+\((\d+(?:\.\d+)?)%\)/i,
    // 或者只是数字+百分号（例如：[====>    ] 70%）
    /\b(\d+(?:\.\d+)?)%\b/,
    // 70% 13/18
    /^(\d+)%\s+\d+\/\d+/,
    // 标准格式：数字%（例如：70%）
    /(?:进度|Progress)[^\d]*?(\d+)%/i,
    // 带空格的格式（例如：70 %）
    /(?:进度|Progress)[^\d]*?(\d+)\s*%/i,
  ];

  init() {
    if (this.initialized) {
      console.warn('_UploaderService 已经初始化过了，跳过重复初始化');
      return;
    }

    this.initialized = true;
    this.actionService.listen('upload-begin', async (action) => {
      try {
        const result = await this.upload();
        return { success: true, result };
      } catch (msg) {
        return { success: false, result: msg };
      }
    }, 'uploader-upload-begin');
    this.actionService.listen('upload-cancel', (action) => {
      this.cancel();
    }, 'uploader-upload-cancel');
  }

  destroy() {
    console.log("_UploaderService destroy");
    this.actionService.unlisten('uploader-upload-begin');
    this.actionService.unlisten('uploader-upload-cancel');
    this.initialized = false; // 重置初始化状态
  }

  /**
   * 安全的通知更新方法
   * 在取消状态下阻止所有非取消相关的UI更新
   */
  private safeUpdateNotice(config: any) {
    // 如果已取消，只允许更新为取消状态
    if (this.cancelled) {
      if (config.state === 'warn' && config.title && config.title.includes('取消')) {
        this.noticeService.update(config);
      }
      // 其他所有更新都被忽略
      return;
    }
    
    // 正常状态下直接更新
    this.noticeService.update(config);
  }

  // 添加这个错误处理方法
  private handleUploadError(errorMessage: string, title = "上传失败") {
    // console.error("handle errror: ", errorMessage);
    this.noticeService.update({
      title: title,
      text: errorMessage,
      detail: errorMessage,
      state: 'error',
      setTimeout: 600000
    });

    this.cmdService.kill(this.streamId || '');
    this.isErrored = true;
    this._builderService.isUploading = false;
  }

  async upload(): Promise<ActionState> {
    this.isErrored = false;
    this.cancelled = false;
    this.uploadCompleted = false;
    this.uploadInProgress = true; // 立即设置为true，使取消功能生效
  
    return new Promise<ActionState>(async (resolve, reject) => {
      // 保存 reject 函数，以便 cancel() 方法可以立即中断
      this.uploadPromiseReject = reject;
      
      try {
        // 重置ESP32上传状态，防止进度累加
        this['esp32UploadState'] = {
          currentRegion: 0,
          totalRegions: 0,
          detectedRegions: false,
          completedRegions: 0
        };

        // 先判断当前是否处于编译状态
        if (this.workflowService.currentState === ProcessState.BUILDING) {
          this.message.warning('当前正在编译中，请稍后再试');
          reject({ state: 'warn', text: '当前正在编译中，请稍后再试' });
          return;
        }

        // 第一步：检查是否需要编译
        const code = arduinoGenerator.workspaceToCode(this.blocklyService.workspace);
        const buildPath = await this.projectService.getBuildPath();
        const needsBuild = !this._builderService.passed || 
                          code !== this._builderService.lastCode || 
                          this.projectService.currentProjectPath !== this._builderService.currentProjectPath || 
                          window['fs'].existsSync(buildPath) === false;

        // 如果需要编译，先执行编译
        if (needsBuild) {
          try {
            const buildResult = await this._builderService.build();
            console.log("build result:", buildResult);
            // 编译成功，继续上传流程
          } catch (error) {
            this.uploadInProgress = false; // 重置状态
            // 检查编译是否被取消
            if (this._builderService.cancelled || this.cancelled) {
              this.noticeService.update({
                title: "编译已取消",
                text: '编译已取消',
                state: 'warn',
                setTimeout: 55000
              });
              reject({ state: 'warn', text: '编译已取消' });
              return;
            } else {
              this.handleUploadError('编译失败，请检查代码', "编译失败");
              reject({ state: 'error', text: '编译失败，请检查代码' });
              return;
            }

          }

          // 检查编译是否成功
          if (!this._builderService.passed) {
            this.uploadInProgress = false; // 重置状态
            this.handleUploadError('编译失败，请检查代码', "编译失败");
            reject({ state: 'error', text: '编译失败，请检查代码' });
            return;
          }
        }
        
        // 检查是否在编译期间被取消
        if (this.cancelled) {
          this.uploadInProgress = false;
          this.noticeService.update({
            title: "上传已取消",
            text: '上传已取消',
            state: 'warn',
            setTimeout: 55000
          });
          this.workflowService.finishUpload(false, 'Cancelled during build');
          reject({ state: 'warn', text: '上传已取消' });
          return;
        }

        // 第二步：编译完成或不需要编译，现在进入上传状态
        if (!this.workflowService.startUpload()) {
          const state = this.workflowService.currentState;
          let msg = "系统繁忙";
          if (state === ProcessState.UPLOADING) msg = "上传正在进行中";
          else if (state === ProcessState.INSTALLING) msg = "依赖安装中";

          this._builderService.isUploading = false; // 确保设置为false
          this.message.warning(msg + "，请稍后再试");
          reject({ state: 'warn', text: msg + "，请稍后" });
          return;
        }

        // 设置上传状态（uploadInProgress 已在方法开始时设置）
        this._builderService.isUploading = true;

        const boardJson = await this.projectService.getBoardJson()
        const boardModule = await this.projectService.getBoardModule();

        // 获取上传参数并提取标志
        const uploadParam = boardJson.uploadParam;
        if (!uploadParam) {
          this.handleUploadError('缺少上传参数，请检查板子配置');
          this.workflowService.finishUpload(false, 'Missing upload parameters');
          reject({ state: 'error', text: '缺少上传参数' });
          return;
        }

        const { flags, cleanParam } = this.extractFlags(uploadParam);
        const use_1200bps_touch = flags['use_1200bps_touch'];
        const wait_for_upload = flags['wait_for_upload'];

        console.log('提取的上传标志:', flags);
        console.log('清理后的上传参数:', cleanParam);

        let lastUploadText = `正在上传${boardJson.name}`;

        // 准备上传配置
        const currentProjectPath = this.projectService.currentProjectPath;
        const tempPath = window['path'].join(currentProjectPath, '.temp');
        if (!window['fs'].existsSync(tempPath)) {
          window['fs'].mkdirSync(tempPath, { recursive: true });
        }

        const uploadConfig = {
          currentProjectPath,
          buildPath,
          boardModule,
          appDataPath: window['path'].getAppDataPath(),
          serialPort: this.serialService.currentPort,
          uploadParam: cleanParam, // 传递清理后的上传参数
          use_1200bps_touch,
          wait_for_upload
        };

        const configFilePath = window['path'].join(tempPath, 'upload-config.json');
        try {
          await window['fs'].writeFileSync(configFilePath, JSON.stringify(uploadConfig, null, 2));
        } catch (err) {
          this._builderService.isUploading = false;
          this.handleUploadError('配置文件写入失败: ' + err.message);
          this.workflowService.finishUpload(false, 'Config write failed');
          reject({ state: 'error', text: '配置文件写入失败' });
          return;
        }

        // 运行上传脚本（1200bps_touch 和 wait_for_upload 预处理已移至 upload.js）
        const uploadScriptPath = window['path'].join(window['path'].getAilyChildPath(), 'scripts', 'upload.js');
        const uploadCmd = `node "${uploadScriptPath}" "${configFilePath}"`;

        console.log("Final upload cmd: ", uploadCmd);

        const title = '上传中';
        const completeTitle = '上传完成';
        const errorTitle = '上传失败';
        const completeText = '上传完成';
        let lastProgress = 0;

        let errorText = '';

        this.uploadInProgress = true;
        this.noticeService.update({ title: title, text: lastUploadText, state: 'doing', progress: 0, setTimeout: 0, stop: () => { this.cancel(); } });

        let bufferData = '';
        this.cmdService.run(uploadCmd, null, false).subscribe({
          next: async (output: CmdOutput) => {
            this.streamId = output.streamId;
            
            // 如果已被取消且需要立即杀死，现在立即杀死进程
            if (this.cancelled && this['shouldKillImmediately'] && this.streamId) {
              console.log("取消标志已设置，立即杀死上传进程:", this.streamId);
              this.cmdService.kill(this.streamId);
              this['shouldKillImmediately'] = false;
              return; // 不再处理任何数据
            }
            
            // 如果已被取消，不处理任何上传数据，直接返回
            if (this.cancelled) {
              console.log("上传已被取消，跳过数据处理");
              return;
            }

            if (output.data) {
              const data = output.data;
              if (data.includes('\r\n') || data.includes('\n') || data.includes('\r')) {
                // 分割成行，同时处理所有三种换行符情况
                const lines = (bufferData + data).split(/\r\n|\n|\r/);
                // 最后一个可能不完整的行保留为新的bufferData
                bufferData = lines.pop() || '';

                lines.forEach((line: string) => {
                  // 如果已取消，不再处理任何行
                  if (this.cancelled) {
                    return;
                  }
                  
                  const trimmedLine = line.trim();
                  if (trimmedLine) {
                    errorText = trimmedLine;

                    // 检查是否有错误信息
                    if (trimmedLine.toLowerCase().includes('error:') ||
                      trimmedLine.toLowerCase().includes('failed') ||
                      trimmedLine.toLowerCase().includes('a fatal error occurred') ||
                      trimmedLine.toLowerCase().includes("can't open device")) {

                      this.handleUploadError(trimmedLine);
                    }

                    if (this.isErrored) {
                      this.logService.update({ "detail": line, "state": "error" });
                      return;
                    } else {
                      this.logService.update({ "detail": line });
                    }

                    // ESP32特定进度跟踪
                    let isESP32Format = /Writing\s+at\s+0x[0-9a-f]+\s+\[[^\]]*\]\s+\d+\.\d+%\s+\d+\/\d+\s+bytes\.\.\./i.test(trimmedLine);
                    
                    // 使用静态变量跟踪ESP32上传状态
                    if (!this['esp32UploadState']) {
                      this['esp32UploadState'] = {
                        currentRegion: 0,
                        totalRegions: 0,
                        detectedRegions: false,
                        completedRegions: 0
                      };
                    }

                    // 检测擦除区域的数量来确定总区域
                    if (!this['esp32UploadState'].detectedRegions &&
                      trimmedLine.includes('Flash will be erased from')) {
                      this['esp32UploadState'].totalRegions++;
                    }

                    // 检测到"Compressed"字样表示开始新区域
                    if (trimmedLine.includes('Compressed') &&
                      trimmedLine.includes('bytes to')) {
                      this['esp32UploadState'].detectedRegions = true;
                      this['esp32UploadState'].currentRegion++;
                    }

                    // 检测到"Hash of data verified"表示一个区域完成
                    if (trimmedLine.includes('Hash of data verified')) {
                      this['esp32UploadState'].completedRegions++;
                    }

                    let progressValue = 0;

                    // 优先处理ESP32格式
                    if (isESP32Format) {
                      const numericMatch = trimmedLine.match(/(\d+\.\d+)%/);
                      if (numericMatch) {
                        const regionProgress = parseInt(numericMatch[1], 10);

                        // 计算整体进度
                        if (this['esp32UploadState'].totalRegions > 0) {
                          // 已完成区域贡献100%，当前区域贡献按比例
                          const completedPortion = this['esp32UploadState'].completedRegions /
                            this['esp32UploadState'].totalRegions * 100;
                          const currentPortion = regionProgress /
                            this['esp32UploadState'].totalRegions;

                          progressValue = Math.floor(completedPortion + currentPortion);

                          // 进度强制显示，无论是否增加
                          lastProgress = progressValue - 1; // 确保更新
                        } else {
                          progressValue = regionProgress;
                        }
                      }
                    } else {
                      for (const regex of this.progressRegexPatterns) {
                        const match = trimmedLine.match(regex);
                        if (match) {
                          let numericMatch = trimmedLine.match(/(\d+(?:\.\d+)?)%/);
                          if (!numericMatch) {
                            numericMatch = trimmedLine.match(/(\d+(?:\.\d+)?)\s*%/);
                          }
                          if (numericMatch) {
                            progressValue = parseFloat(numericMatch[1]);
                            progressValue = Math.floor(progressValue);
                            if (lastProgress == 0 && progressValue > 100) {
                              progressValue = 0;
                            }
                            break;
                          }
                        }
                      }
                    }

                    if (progressValue && progressValue > lastProgress) {
                      lastProgress = progressValue;
                      // 更新UI前检查是否已取消
                      if (!this.cancelled) {
                        this.safeUpdateNotice({
                          title: title,
                          text: lastUploadText,
                          state: 'doing',
                          progress: lastProgress,
                          setTimeout: 0,
                          stop: () => {
                            this.cancel()
                          }
                        });
                      }
                    }

                    // 进度为100%时标记完成
                    if (lastProgress >= 100) {
                      this.uploadCompleted = true;
                    }

                    // 处理特定的完成标志: Wrote 198144 bytes to E:/NEW.UF2
                    if (trimmedLine.includes('Wrote') && trimmedLine.includes('bytes to')) {
                      this.uploadCompleted = true;
                    }
                  }
                });
              } else {
                // 没有换行符，直接追加
                bufferData += data;
              }
            } else {
              bufferData += '';
            }
          },
          error: (error: any) => {
            console.log("上传命令错误:", error);
            this._builderService.isUploading = false;
            this.handleUploadError(error.message || '上传过程中发生错误');
            this.workflowService.finishUpload(false, error.message || 'Upload error');
            this.uploadPromiseReject = null;
            reject({ state: 'error', text: error.message || '上传失败' });
          },
          complete: () => {
            console.log("上传命令完成，cancelled:", this.cancelled, "isErrored:", this.isErrored, "uploadCompleted:", this.uploadCompleted);
            
            // 第一优先级：检查是否已取消
            if (this.cancelled) {
              console.warn("上传中断 - 用户取消");
              // 安全更新UI
              this.safeUpdateNotice({
                title: "上传已取消",
                text: '上传已取消',
                state: 'warn',
                setTimeout: 55000
              });
              this._builderService.isUploading = false;
              this.workflowService.finishUpload(false, 'Cancelled');
              this.uploadPromiseReject = null;
              reject({ state: 'warn', text: '上传已取消' });
            } else if (this.isErrored) {
              console.log("上传命令完成 - 发生错误");
              this._builderService.isUploading = false;
              this.handleUploadError('上传过程中发生错误');
              this.workflowService.finishUpload(false, errorText);
              this.uploadPromiseReject = null;
              reject({ state: 'error', text: errorText });
            } else if (this.uploadCompleted) {
              console.log("上传完成");
              // 安全更新UI
              if (!this.cancelled) {
                this.safeUpdateNotice({
                  title: completeTitle,
                  text: completeText,
                  state: 'done',
                  setTimeout: 55000
                });
              }
              this._builderService.isUploading = false;
              this.workflowService.finishUpload(true);
              this.uploadPromiseReject = null;
              resolve({ state: 'done', text: '上传完成' });
            } else {
              console.warn("上传未完成，可能是由于超时或其他原因");
              // 安全更新UI
              this.safeUpdateNotice({
                title: errorTitle,
                text: lastUploadText,
                detail: "超时或其他原因",
                state: 'error',
                setTimeout: 600000
              });
              this._builderService.isUploading = false;
              this.workflowService.finishUpload(false, 'Upload incomplete');
              this.uploadPromiseReject = null;
              reject({ state: 'error', text: '上传未完成，请检查日志' });
            }
          }
        })
      } catch (error) {
        this._builderService.isUploading = false; // 确保在异常情况下设置为false
        this.handleUploadError(error.message || '上传失败');
        this.workflowService.finishUpload(false, error.message || 'Upload failed');
        this.uploadPromiseReject = null;
        reject({ state: 'error', text: error.message || '上传失败' });
      }
    });
  }

  /**
   * 从上传参数中提取标志
   * @param uploadParam 上传参数字符串或对象
   * @returns 包含提取的标志和清理后的参数
   */
  private extractFlags(uploadParam: string | any): { flags: { [key: string]: boolean | string }, cleanParam: string } {
    const flags: { [key: string]: boolean | string } = {};
    let cleanParam = '';

    if (typeof uploadParam === 'string') {
      cleanParam = uploadParam;
      
      // 只处理方括号包裹的预处理标志 [--flag] 或 [-flag] 或 [--flag=value]
      const bracketFlagPattern = /\[(--?\w+(?:=\S+)?)\]/g;
      let match;
      
      while ((match = bracketFlagPattern.exec(uploadParam)) !== null) {
        const fullFlag = match[1]; // 例如: --use_1200bps_touch
        const flagMatch = fullFlag.match(/--?(\w+)(?:=(\S+))?/);
        if (flagMatch) {
          const flagName = flagMatch[1];
          const flagValue = flagMatch[2];
          flags[flagName] = flagValue !== undefined ? flagValue : true;
        }
      }
      
      // 只移除方括号包裹的标志，保留其他所有参数（如 -a -U -e 等）
      cleanParam = cleanParam.replace(/\[--?\w+(?:=\S+)?\]\s*/g, '');
      
      // 清理多余的空格
      cleanParam = cleanParam.trim().replace(/\s+/g, ' ');
    } else if (typeof uploadParam === 'object' && uploadParam !== null) {
      // 如果是对象，直接提取 flags 属性
      if (uploadParam.flags) {
        Object.assign(flags, uploadParam.flags);
      }
      
      // 提取其他参数
      cleanParam = uploadParam.param || uploadParam.command || '';
    }

    return { flags, cleanParam };
  }

  /**
* 取消当前上传过程
*/
  cancel() {
    if (!this.uploadInProgress) {
      return;
    }
    
    console.log("取消上传，当前streamId:", this.streamId);
    
    // 立即设置取消标志，阻止所有后续处理
    this.cancelled = true;
    this.uploadInProgress = false;
    this._builderService.isUploading = false;
    
    // 立即更新通知状态为已取消
    this.noticeService.update({
      title: "上传已取消",
      text: '上传已取消',
      state: 'warn',
      setTimeout: 55000
    });
    
    // 如果正在编译，取消编译
    if (this.workflowService.currentState === ProcessState.BUILDING) {
      this._builderService.cancel();
    }
    
    // 立即杀死进程（无论streamId是否存在）
    // 如果streamId存在，杀死它；如果不存在，可能需要等待它被设置后再杀死
    if (this.streamId) {
      console.log("杀死上传进程:", this.streamId);
      this.cmdService.kill(this.streamId);
    } else {
      console.log("streamId尚未设置，将在获取后立即杀死");
      // 标记为需要立即杀死，当streamId被设置后会立即杀死
      this['shouldKillImmediately'] = true;
    }
    
    // 完成工作流状态
    this.workflowService.finishUpload(false, 'Cancelled by user');
    
    // 立即 reject Promise，使按钮状态快速更新
    if (this.uploadPromiseReject) {
      this.uploadPromiseReject({ state: 'warn', text: '上传已取消' });
      this.uploadPromiseReject = null;
    }
  }
}

