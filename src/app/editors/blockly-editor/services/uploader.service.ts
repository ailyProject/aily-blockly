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
  private processExitCode: number | null = null; // 记录进程退出码
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
    
    // 监听 softdevice 烧录请求
    this.actionService.listen('flash-softdevice', async (action) => {
      try {
        const { softdeviceName, serialPort } = action.payload;
        const result = await this.flashSoftdevice(softdeviceName, serialPort);
        return { success: result.success, result };
      } catch (error: any) {
        return { success: false, result: { success: false, message: error.message || '烧录失败' } };
      }
    }, 'uploader-flash-softdevice');
  }

  destroy() {
    console.log("_UploaderService destroy");
    this.actionService.unlisten('uploader-upload-begin');
    this.actionService.unlisten('uploader-upload-cancel');
    this.actionService.unlisten('uploader-flash-softdevice');
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
  private handleUploadError(errorMessage: string, title = "上传失败", details?: string) {
    // console.error("handle errror: ", errorMessage);
    const cleanDetailMessage = (details || errorMessage || '').toString().trim();
    this.noticeService.update({
      title: title,
      text: errorMessage,
      detail: cleanDetailMessage,
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
    this.processExitCode = null; // 重置进程退出码
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

        // 提前捕获串口号，避免 build 期间设备重新插拔导致端口变化的竞态条件
        const capturedSerialPort = this.serialService.currentPort;
        const capturedPortInfo = this.serialService.currentPortInfo;
        if (!capturedSerialPort) {
          this.uploadInProgress = false;
          this.handleUploadError('请先选择串口', '未选择串口');
          reject({ state: 'error', text: '请先选择串口' });
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
              const buildErrorDetails = (error?.fullStdErr || error?.text || error?.message || error || '').toString();
              this.handleUploadError('编译失败，请检查代码', "编译失败", buildErrorDetails);
              reject({ state: 'error', text: '编译失败，请检查代码' });
              return;
            }

          }

          // 检查编译是否成功
          if (!this._builderService.passed) {
            this.uploadInProgress = false; // 重置状态
            this.handleUploadError('编译失败，请检查代码', "编译失败", '编译结果未通过，未检测到可用构建产物');
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

          this.uploadInProgress = false; // 重置上传状态
          this._builderService.isUploading = false; // 确保设置为false
          this.message.warning(msg + "，请稍后再试");
          reject({ state: 'warn', text: msg + "，请稍后" });
          return;
        }

        // 设置上传状态（uploadInProgress 已在方法开始时设置）
        this._builderService.isUploading = true;

        const boardJson = await this.projectService.getBoardJson()
        const boardModule = await this.projectService.getBoardModule();

        // 根据烧录方式选择上传参数：调试探针使用 linkUploadParam，串口使用 uploadParam
        const isDebuggerUpload = capturedPortInfo?.type === 'debugger';
        const uploadParam = isDebuggerUpload
          ? (boardJson.linkUploadParam || boardJson.uploadParam)
          : boardJson.uploadParam;
        if (!uploadParam) {
          this.uploadInProgress = false; // 重置上传状态
          const errMsg = isDebuggerUpload ? '缺少调试探针上传参数(linkUploadParam)，请检查板子配置' : '缺少上传参数，请检查板子配置';
          this.handleUploadError(errMsg);
          this.workflowService.finishUpload(false, 'Missing upload parameters');
          reject({ state: 'error', text: errMsg });
          return;
        }

        const { flags, cleanParam } = this.extractFlags(uploadParam);
        const use_1200bps_touch = isDebuggerUpload ? false : !!flags['use_1200bps_touch'];
        // 兼容两种写法(--wait_for_upload_port和--wait_for_upload)，优先使用标准名
        const wait_for_upload = isDebuggerUpload
          ? false
          : !!(flags['wait_for_upload_port'] || flags['wait_for_upload']);

        console.log('提取的上传标志:', flags);
        console.log('清理后的上传参数:', cleanParam);

        let lastUploadText = `正在上传${boardJson.name}`;

        // 准备上传配置
        const currentProjectPath = this.projectService.currentProjectPath;
        const tempPath = window['path'].join(currentProjectPath, '.temp');
        if (!window['fs'].existsSync(tempPath)) {
          window['fs'].mkdirSync(tempPath, { recursive: true });
        }

        // 获取当前选中的 STM32.BOARD (pnum) 选项，用于 probe-rs download 参数
        const pnum = this.projectService.currentStm32Config?.board || null;

        const uploadConfig = {
          currentProjectPath,
          buildPath,
          boardModule,
          appDataPath: window['path'].getAppDataPath(),
          serialPort: capturedSerialPort,
          portType: capturedPortInfo?.type || 'serial',
          portText: capturedPortInfo?.text || '',
          probeSerial: capturedPortInfo?.probeSerial || '',
          probeVidPid: capturedPortInfo?.probeVidPid || '',
          uploadParam: cleanParam, // 传递清理后的上传参数
          use_1200bps_touch,
          wait_for_upload,
          pnum
        };

        const configFilePath = window['path'].join(tempPath, 'upload-config.json');
        try {
          await window['fs'].writeFileSync(configFilePath, JSON.stringify(uploadConfig, null, 2));
        } catch (err) {
          this.uploadInProgress = false; // 重置上传状态
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
        let fullErrorText = '';

        this.uploadInProgress = true;
        this.noticeService.update({ title: title, text: lastUploadText, state: 'doing', progress: 0, setTimeout: 0, stop: () => { this.cancel(); } });

        // probe-rs/调试探针上传: 使用合成进度（因为 probe-rs 在非 TTY 模式下不输出进度条）
        let hasRealProgress = false;
        let syntheticProgressTimer: any = null;
        if (isDebuggerUpload) {
          const syntheticPhases = [
            { delay: 300,  progress: 3,  text: '正在连接设备...' },
            { delay: 800,  progress: 8,  text: '正在擦除...' },
            { delay: 1200, progress: 15, text: '正在擦除...' },
            { delay: 1800, progress: 20, text: '正在上传...' },
            { delay: 2500, progress: 35, text: '正在上传...' },
            { delay: 3500, progress: 50, text: '正在上传...' },
            { delay: 5000, progress: 65, text: '正在上传...' },
            { delay: 6500, progress: 78, text: '正在上传...' },
            { delay: 8000, progress: 88, text: '验证中...' },
            { delay: 9500, progress: 95, text: '验证中...' },
          ];
          const startTime = Date.now();
          syntheticProgressTimer = setInterval(() => {
            if (hasRealProgress || this.cancelled || this.isErrored || this.uploadCompleted) {
              clearInterval(syntheticProgressTimer);
              syntheticProgressTimer = null;
              return;
            }
            const elapsed = Date.now() - startTime;
            // 找到当前时间点应该显示的最新阶段
            let currentPhase = null;
            for (let i = syntheticPhases.length - 1; i >= 0; i--) {
              if (elapsed >= syntheticPhases[i].delay) {
                currentPhase = syntheticPhases[i];
                break;
              }
            }
            if (currentPhase && currentPhase.progress > lastProgress) {
              lastProgress = currentPhase.progress;
              lastUploadText = currentPhase.text;
              this.safeUpdateNotice({
                title: title,
                text: currentPhase.text,
                state: 'doing',
                progress: currentPhase.progress,
                setTimeout: 0,
                stop: () => { this.cancel(); }
              });
            }
          }, 300);
        }

        let bufferData = '';
        this.cmdService.run(uploadCmd, null, false).subscribe({
          next: async (output: CmdOutput) => {
            this.streamId = output.streamId;

            if (output.type === 'close') {
              this.processExitCode = output.code ?? (output.signal ? 1 : 0);

              if (!this.cancelled && this.processExitCode !== 0) {
                errorText = output.signal
                  ? `上传进程被信号终止: ${output.signal}`
                  : `上传进程异常退出，退出码: ${this.processExitCode}`;
                if (!fullErrorText) {
                  fullErrorText = errorText;
                }
                this.isErrored = true;
              }
              return;
            }

            if (output.type === 'error') {
              errorText = output.error || '上传进程启动失败';
              if (!fullErrorText) {
                fullErrorText = errorText;
              }
              this.isErrored = true;
              return;
            }
            
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
                      fullErrorText += trimmedLine + '\n';
                      this.handleUploadError(trimmedLine, '上传失败', fullErrorText);
                    }

                    if (this.isErrored) {
                      this.logService.update({ "detail": line, "state": "error" });
                      return;
                    } else {
                      this.logService.update({ "detail": line });
                    }

                    // probe-rs 进度跟踪 (Erasing/Programming/Verifying 三阶段)
                    // 匹配直接输出格式和 upload.js 中继的 [probe-rs:phase] 标记
                    const probeRsMatch = trimmedLine.match(/^\s*(?:\[probe-rs:phase\]\s*)?(Erasing|Programming|Verifying)\s+.*?(\d+)%/i);
                    // probe-rs 完成标志: "Finished in X.XXs" 或 "[probe-rs:phase] Finished"
                    const probeRsFinished = /(?:^\s*Finished\s+in\s+[\d.]+s|\[probe-rs:phase\]\s*Finished)/i.test(trimmedLine);

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

                    // 优先处理 probe-rs 格式
                    if (probeRsMatch) {
                      hasRealProgress = true; // 检测到真实进度数据，停止合成进度
                      const phase = probeRsMatch[1].toLowerCase();
                      const phaseProgress = parseInt(probeRsMatch[2], 10);
                      // Erasing: 0-15%, Programming: 15-85%, Verifying: 85-99%
                      if (phase === 'erasing') {
                        progressValue = Math.floor(phaseProgress * 0.15);
                        lastUploadText = '正在擦除...';
                      } else if (phase === 'programming') {
                        progressValue = 15 + Math.floor(phaseProgress * 0.70);
                        lastUploadText = '正在上传...';
                      } else if (phase === 'verifying') {
                        progressValue = 85 + Math.floor(phaseProgress * 0.14);
                        lastUploadText = '验证中...';
                      }
                      // 强制刷新显示（probe-rs 阶段切换时进度可能回到0再上升）
                      lastProgress = Math.min(lastProgress, progressValue - 1);
                    } else if (probeRsFinished) {
                      hasRealProgress = true;
                      progressValue = 100;
                      lastUploadText = '上传完成';
                      this.uploadCompleted = true;
                    } else if (isESP32Format) {
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

                    // 检测更多成功标志
                    // avrdude: flash/eeprom verified
                    if (trimmedLine.toLowerCase().includes('verified') && 
                        (trimmedLine.toLowerCase().includes('flash') || 
                         trimmedLine.toLowerCase().includes('bytes') ||
                         trimmedLine.toLowerCase().includes('written'))) {
                      this.uploadCompleted = true;
                    }

                    // esptool: Hard resetting via RTS pin... (ESP32上传完成标志)
                    if (trimmedLine.toLowerCase().includes('hard resetting') ||
                        trimmedLine.toLowerCase().includes('leaving...')) {
                      this.uploadCompleted = true;
                    }

                    // stm32flash: Done. / STM32 上传完成
                    if (trimmedLine.toLowerCase() === 'done.' || 
                        trimmedLine.toLowerCase().includes('starting execution at')) {
                      this.uploadCompleted = true;
                    }

                    // probe-rs: Finished in X.XXs
                    if (/^\s*Finished\s+in\s+[\d.]+s/i.test(trimmedLine)) {
                      this.uploadCompleted = true;
                    }

                    // 记录进程退出码
                    const exitCodeMatch = trimmedLine.match(/^exit code: (\d+)$/i);
                    if (exitCodeMatch) {
                      this.processExitCode = parseInt(exitCodeMatch[1], 10);
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
            if (syntheticProgressTimer) { clearInterval(syntheticProgressTimer); syntheticProgressTimer = null; }
            console.log("上传命令错误:", error);
            this.uploadInProgress = false; // 确保重置上传状态
            this._builderService.isUploading = false;
            const fullErrorMessage = (error?.error || error?.stack || error?.message || String(error)).toString();
            this.handleUploadError(error.message || '上传过程中发生错误', '上传失败', fullErrorMessage);
            this.workflowService.finishUpload(false, error.message || 'Upload error');
            this.uploadPromiseReject = null;
            reject({ state: 'error', text: error.message || '上传失败' });
          },
          complete: () => {
            if (syntheticProgressTimer) { clearInterval(syntheticProgressTimer); syntheticProgressTimer = null; }
            console.log("上传命令完成，cancelled:", this.cancelled, "isErrored:", this.isErrored, "uploadCompleted:", this.uploadCompleted, "processExitCode:", this.processExitCode);
            
            // 确保 uploadInProgress 在所有情况下都被重置
            this.uploadInProgress = false;

            if (!this.cancelled && !this.isErrored && this.processExitCode !== null && this.processExitCode !== 0) {
              this.isErrored = true;
              if (!errorText) {
                errorText = `上传进程异常退出，退出码: ${this.processExitCode}`;
              }
              if (!fullErrorText) {
                fullErrorText = errorText;
              }
            }
            
            // 如果没有检测到完成标志且没有错误，且进程正常退出(code 0)，认为上传成功
            // 这是为了处理某些上传工具没有明确的完成输出但实际已成功的情况
            if (!this.uploadCompleted && !this.isErrored && !this.cancelled && (this.processExitCode === null || this.processExitCode === 0)) {
              // 进程正常退出（Observable complete 表示进程已结束）
              // 如果没有错误标志，则假定成功
              console.log("进程已正常结束，未检测到明确完成标志，假定上传成功");
              this.uploadCompleted = true;
            }
            
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
              this.handleUploadError('上传过程中发生错误', '上传失败', fullErrorText || errorText || '上传过程中发生错误');
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
              // 这个分支理论上不应该被触发，因为上面已经处理了正常结束的情况
              // 但作为兜底逻辑保留
              console.warn("上传状态异常，可能是由于进程异常退出");
              // 安全更新UI
              this.safeUpdateNotice({
                title: errorTitle,
                text: lastUploadText,
                detail: "上传状态异常，请检查日志",
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
        const fullErrorMessage = (error?.error || error?.stack || error?.message || String(error)).toString();
        this.handleUploadError(error.message || '上传失败', '上传失败', fullErrorMessage);
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
      
      // 处理方括号包裹的预处理标志，支持逗号分隔的多个标志
      // 例如: [--use_1200bps_touch] 或 [--use_1200bps_touch,--wait_for_upload_port] 或 [--flag=value]
      const bracketGroupPattern = /\[((?:--?\w+(?:=\S+)?)(?:,--?\w+(?:=\S+)?)*)\]/g;
      let match;
      
      while ((match = bracketGroupPattern.exec(uploadParam)) !== null) {
        const groupContent = match[1]; // 例如: --use_1200bps_touch,--wait_for_upload_port
        const flagItems = groupContent.split(',');
        for (const item of flagItems) {
          const flagMatch = item.trim().match(/--?(\w+)(?:=(\S+))?/);
          if (flagMatch) {
            const flagName = flagMatch[1];
            const flagValue = flagMatch[2];
            flags[flagName] = flagValue !== undefined ? flagValue : true;
          }
        }
      }
      
      // 移除方括号包裹的标志组（含逗号分隔），保留其他所有参数
      cleanParam = cleanParam.replace(/\[(?:--?\w+(?:=\S+)?)(?:,--?\w+(?:=\S+)?)*\]\s*/g, '');
      
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

  /**
   * 烧录 softdevice 到 nRF5 设备
   * 使用 upload.js 脚本进行烧录，与正常上传流程一致
   * @param softdeviceName softdevice 名称，如 "s110" 或 "none"
   * @param serialPort 串口名称
   * @returns Promise 表示烧录结果
   */
  async flashSoftdevice(softdeviceName: string, serialPort: string): Promise<{ success: boolean; message: string }> {
    try {
      // 获取 softdevice hex 文件路径
      const hexPath = await this.projectService.getSoftdeviceHexPath(softdeviceName);
      if (!hexPath) {
        return { success: false, message: `未找到 ${softdeviceName} 的 hex 文件` };
      }

      // 获取 board.json 配置
      const boardJson = await this.projectService.getBoardJson();
      if (!boardJson || !boardJson.uploadParam) {
        return { success: false, message: '未找到上传参数配置' };
      }

      // 获取上传参数模板并替换 hex 文件路径
      let uploadParam = boardJson.uploadParam;
      // 替换 ${'*.hex'} 为实际的 hex 文件路径（不加引号，因为外层可能已有{{}}）
      uploadParam = uploadParam.replace(/\$\{['"]?\*\.hex['"]?\}/g, hexPath);
      uploadParam = uploadParam.replace(/\$\{'\*\.hex'\}/g, hexPath);

      console.log('Softdevice 上传参数:', uploadParam);

      // 准备上传配置 - 使用与 upload.js 相同的配置格式
      const boardModule = await this.projectService.getBoardModule();
      const appDataPath = window['path'].getAppDataPath();
      const currentProjectPath = this.projectService.currentProjectPath;

      // 创建一个临时的 buildPath，用于存放 softdevice hex 文件
      const tempBuildPath = window['path'].join(currentProjectPath, '.temp', 'softdevice');
      if (!window['fs'].existsSync(tempBuildPath)) {
        window['fs'].mkdirSync(tempBuildPath, { recursive: true });
      }

      // 复制 hex 文件到临时目录
      const hexFileName = window['path'].basename(hexPath);
      const tempHexPath = window['path'].join(tempBuildPath, hexFileName);
      window['fs'].copySync(hexPath, tempHexPath);

      const uploadConfig = {
        currentProjectPath,
        buildPath: tempBuildPath,
        boardModule,
        appDataPath,
        serialPort,
        uploadParam,
        use_1200bps_touch: false,
        wait_for_upload: false
      };

      // 写入配置文件
      const tempPath = window['path'].join(currentProjectPath, '.temp');
      if (!window['fs'].existsSync(tempPath)) {
        window['fs'].mkdirSync(tempPath, { recursive: true });
      }
      const configFilePath = window['path'].join(tempPath, 'softdevice-upload-config.json');
      window['fs'].writeFileSync(configFilePath, JSON.stringify(uploadConfig, null, 2));

      // 运行上传脚本
      const uploadScriptPath = window['path'].join(window['path'].getAilyChildPath(), 'scripts', 'upload.js');
      const uploadCmd = `node "${uploadScriptPath}" "${configFilePath}"`;

      console.log('Softdevice 上传命令:', uploadCmd);

      const title = '正在烧录 SoftDevice...';
      const completeTitle = 'SoftDevice 烧录成功';
      const errorTitle = 'SoftDevice 烧录失败';

      // 显示烧录中通知
      this.noticeService.update({
        title: title,
        text: `正在初始化...`,
        state: 'doing',
        progress: 0,
        setTimeout: 0
      });

      // 执行上传命令
      return new Promise((resolve) => {
        let hasError = false;
        let errorMessage = '';
        let uploadCompleted = false;
        let lastProgress = 0;
        let currentStage = '';

        this.cmdService.run(uploadCmd, null, false).subscribe({
          next: (output: CmdOutput) => {
            if (output.type === 'close') {
              if ((output.code ?? 0) !== 0 || output.signal) {
                hasError = true;
                errorMessage = output.signal
                  ? `烧录进程被信号终止: ${output.signal}`
                  : `烧录进程异常退出，退出码: ${output.code}`;
              }
              return;
            }

            if (output.type === 'error') {
              hasError = true;
              errorMessage = output.error || '烧录进程启动失败';
              return;
            }

            if (output.data) {
              console.log('Softdevice 烧录输出:', output.data);
              const data = output.data;

              // 检查是否有错误信息
              if (data.includes('[ERROR]') || data.includes('Error:') || data.includes('error:')) {
                hasError = true;
                errorMessage = data;
              }

              // 解析 OpenOCD 烧录进度
              // 初始化阶段 (0-10%)
              if (data.includes('CMSIS-DAP: Interface ready') || data.includes('clock speed')) {
                lastProgress = 5;
                currentStage = '连接设备...';
              }
              if (data.includes('SWD IDCODE') || data.includes('nrf51.cpu')) {
                lastProgress = 10;
                currentStage = '检测到设备';
              }

              // 编程阶段 (10-60%)
              if (data.includes('** Programming Started **')) {
                lastProgress = 15;
                currentStage = '开始写入...';
              }
              if (data.includes('auto erase enabled')) {
                lastProgress = 20;
                currentStage = '擦除中...';
              }
              if (data.includes('Padding image section')) {
                lastProgress = 25;
                currentStage = '准备数据...';
              }
              if (data.includes('using fast async flash loader')) {
                lastProgress = 30;
                currentStage = '快速写入模式';
              }
              // 写入完成时解析进度
              const writeMatch = data.match(/wrote (\d+) bytes.*in ([\d.]+)s/);
              if (writeMatch) {
                lastProgress = 55;
                currentStage = `已写入 ${Math.round(parseInt(writeMatch[1]) / 1024)} KB`;
              }
              if (data.includes('** Programming Finished **')) {
                lastProgress = 60;
                currentStage = '写入完成';
              }

              // 验证阶段 (60-90%)
              if (data.includes('** Verify Started **')) {
                lastProgress = 65;
                currentStage = '开始验证...';
              }
              const verifyMatch = data.match(/verified (\d+) bytes/);
              if (verifyMatch) {
                lastProgress = 85;
                currentStage = `已验证 ${Math.round(parseInt(verifyMatch[1]) / 1024)} KB`;
              }
              if (data.includes('** Verified OK **')) {
                lastProgress = 90;
                currentStage = '验证成功';
              }

              // 完成阶段 (90-100%)
              if (data.includes('** Resetting Target **')) {
                lastProgress = 95;
                currentStage = '重置设备...';
              }
              if (data.includes('shutdown command invoked')) {
                lastProgress = 100;
                currentStage = '烧录完成';
                uploadCompleted = true;
              }

              // 更新进度显示
              if (lastProgress > 0) {
                this.noticeService.update({
                  title: title,
                  text: currentStage || `正在烧录 ${softdeviceName} SoftDevice...`,
                  state: 'doing',
                  progress: lastProgress,
                  setTimeout: 0
                });
              }
            }
          },
          error: (error: any) => {
            console.error('Softdevice 烧录错误:', error);
            this.noticeService.update({
              title: errorTitle,
              text: `烧录失败: ${error.message || error}`,
              state: 'error',
              setTimeout: 60000
            });
            resolve({ success: false, message: `烧录失败: ${error.message || error}` });
          },
          complete: () => {
            console.log('Softdevice 烧录命令执行完成, hasError:', hasError, 'uploadCompleted:', uploadCompleted);
            if (hasError) {
              this.noticeService.update({
                title: errorTitle,
                text: errorMessage || 'SoftDevice 烧录失败',
                state: 'error',
                setTimeout: 60000
              });
              resolve({ success: false, message: errorMessage || 'Softdevice 烧录失败' });
            } else {
              this.noticeService.update({
                title: completeTitle,
                text: `${softdeviceName} SoftDevice 烧录成功`,
                state: 'done',
                setTimeout: 5000
              });
              resolve({ success: true, message: 'Softdevice 烧录成功' });
            }
          }
        });
      });
    } catch (error: any) {
      console.error('烧录 softdevice 失败:', error);
      this.noticeService.update({
        title: 'SoftDevice 烧录失败',
        text: `烧录失败: ${error.message || error}`,
        state: 'error',
        setTimeout: 60000
      });
      return { success: false, message: `烧录失败: ${error.message || error}` };
    }
  }
}

