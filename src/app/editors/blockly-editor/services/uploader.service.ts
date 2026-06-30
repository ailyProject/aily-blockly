import { Injectable, inject } from "@angular/core";
import { TranslateService } from '@ngx-translate/core';
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
import { BleOtaProgress, UploaderBleService } from '../../../services/uploader-ble.service';
import { AppDataResourceLockService } from '../../../services/appdata-resource-lock.service';
import { appendProjectLog, type ProjectLogLevel } from '../../../utils/project-log.utils';

interface NetworkOtaUploadTarget {
  id?: string;
  name?: string;
  host: string;
  port: number;
  username: string;
  password: string;
  uploadPath: string;
  ssl?: boolean;
  timeoutMs?: number;
}

function mapLogStateToLevel(state?: string): ProjectLogLevel {
  switch ((state || '').toLowerCase()) {
    case 'error':
      return 'ERROR';
    case 'doing':
      return 'DEBUG';
    default:
      return 'INFO';
  }
}

@Injectable()
export class _UploaderService {
  private translate = inject(TranslateService);

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
    private workflowService: WorkflowService,
    private uploaderBleService: UploaderBleService,
    private appDataResourceLock: AppDataResourceLockService
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
        return { success: false, result: { success: false, message: error.message || this.uploadT('SOFTDEVICE_FLASH_FAILED_SHORT') } };
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
      if (config.state === 'warn' && config.isCancellationNotice) {
        this.noticeService.update(config);
      }
      // 其他所有更新都被忽略
      return;
    }
    
    // 正常状态下直接更新
    this.noticeService.update(config);
  }

  private appendUploadLog(message: string, level: ProjectLogLevel = 'INFO'): void {
    appendProjectLog(this.projectService.currentProjectPath, 'upload', level, message);
  }

  // 添加这个错误处理方法
  private handleUploadError(errorMessage: string, title = this.uploadT('FAILED_TITLE'), details?: string) {
    // console.error("handle errror: ", errorMessage);
    const cleanDetailMessage = (details || errorMessage || '').toString().trim();
    this.appendUploadLog(cleanDetailMessage || errorMessage, 'ERROR');
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
          const message = this.uploadT('BUILDING_RETRY_LATER');
          this.message.warning(message);
          reject({ state: 'warn', text: message });
          return;
        }

        // 提前捕获串口号，避免 build 期间设备重新插拔导致端口变化的竞态条件
        const capturedSerialPort = this.serialService.currentPort;
        const capturedPortInfo = this.serialService.currentPortInfo;
        if (!capturedSerialPort) {
          this.uploadInProgress = false;
          const message = this.uploadT('SELECT_PORT_MESSAGE');
          this.handleUploadError(message, this.uploadT('SELECT_PORT_TITLE'));
          reject({ state: 'error', text: message });
          return;
        }

        if (capturedPortInfo?.type === 'network-ota' && !await this.canUseWifiOta()) {
          this.uploadInProgress = false;
          this._builderService.isUploading = false;
          const message = this.networkT('MISSING_DEPENDENCY');
          this.handleUploadError(message, this.networkT('UPLOAD_FAILED_TITLE'), message);
          reject({ state: 'error', text: message });
          return;
        }

        if (capturedPortInfo?.type === 'ble') {
          try {
            await this.uploaderBleService.authorizeDevice(capturedSerialPort, progress => {
              if (this.cancelled) return;
              this.noticeService.update({
                title: this.t('UPLOADING_TITLE'),
                text: progress.text || this.t('CONFIRMING_DEVICE'),
                state: 'doing',
                progress: Math.max(0, Math.min(100, Math.floor(progress.progress || 0))),
                setTimeout: 0,
                stop: () => { this.cancel(); }
              });
            }, capturedPortInfo?.text || capturedPortInfo?.name);
          } catch (error) {
            this.uploadInProgress = false;
            this._builderService.isUploading = false;
            const message = error?.message || error?.text || this.t('UPLOAD_FAILED_FALLBACK');
            this.handleUploadError(message, this.t('UPLOAD_FAILED_TITLE'), message);
            reject({ state: 'error', text: message });
            return;
          }
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
                title: this.uploadT('BUILD_CANCELLED'),
                text: this.uploadT('BUILD_CANCELLED'),
                state: 'warn',
                setTimeout: 55000,
                isCancellationNotice: true
              });
              reject({ state: 'warn', text: this.uploadT('BUILD_CANCELLED') });
              return;
            } else {
              const buildErrorDetails = (error?.fullStdErr || error?.text || error?.message || error || '').toString();
              const message = this.uploadT('BUILD_FAILED_CHECK_CODE');
              this.handleUploadError(message, this.uploadT('BUILD_FAILED_TITLE'), buildErrorDetails);
              reject({ state: 'error', text: message });
              return;
            }

          }

          // 检查编译是否成功
          if (!this._builderService.passed) {
            this.uploadInProgress = false; // 重置状态
            const message = this.uploadT('BUILD_FAILED_CHECK_CODE');
            this.handleUploadError(message, this.uploadT('BUILD_FAILED_TITLE'), this.uploadT('BUILD_FAILED_NO_ARTIFACT'));
            reject({ state: 'error', text: message });
            return;
          }
        }
        
        // 检查是否在编译期间被取消
        if (this.cancelled) {
          this.uploadInProgress = false;
          this.noticeService.update({
            title: this.uploadT('CANCELLED'),
            text: this.uploadT('CANCELLED'),
            state: 'warn',
            setTimeout: 55000,
            isCancellationNotice: true
          });
          this.workflowService.finishUpload(false, 'Cancelled during build');
          reject({ state: 'warn', text: this.uploadT('CANCELLED') });
          return;
        }

        // 第二步：编译完成或不需要编译，现在进入上传状态
        if (!this.workflowService.startUpload()) {
          const state = this.workflowService.currentState;
          let msg = this.uploadT('BUSY_SYSTEM');
          if (state === ProcessState.UPLOADING) msg = this.uploadT('BUSY_UPLOADING');
          else if (state === ProcessState.INSTALLING) msg = this.uploadT('BUSY_INSTALLING');

          this.uploadInProgress = false; // 重置上传状态
          this._builderService.isUploading = false; // 确保设置为false
          this.message.warning(this.uploadT('BUSY_RETRY_LATER', { message: msg }));
          reject({ state: 'warn', text: this.uploadT('BUSY_WAIT', { message: msg }) });
          return;
        }

        // 设置上传状态（uploadInProgress 已在方法开始时设置）
        this._builderService.isUploading = true;

        const boardJson = await this.projectService.getBoardJson()

        if (capturedPortInfo?.type === 'ble') {
          try {
            const result = await this.uploadByBle(buildPath, capturedPortInfo, boardJson?.name);
            this.uploadPromiseReject = null;
            resolve(result);
          } catch (error) {
            this.uploadPromiseReject = null;
            reject(error);
          }
          return;
        }

        if (capturedPortInfo?.type === 'network-ota') {
          try {
            const result = await this.uploadByNetworkOta(buildPath, capturedPortInfo, boardJson?.name);
            this.uploadPromiseReject = null;
            resolve(result);
          } catch (error) {
            this.uploadPromiseReject = null;
            reject(error);
          }
          return;
        }

        const boardModule = await this.projectService.getBoardModule();

        // 根据烧录方式选择上传参数：调试探针使用 linkUploadParam，串口使用 uploadParam
        const isDebuggerUpload = capturedPortInfo?.type === 'debugger';
        const uploadParam = isDebuggerUpload
          ? (boardJson.linkUploadParam || boardJson.uploadParam)
          : boardJson.uploadParam;
        if (!uploadParam) {
          this.uploadInProgress = false; // 重置上传状态
          const errMsg = isDebuggerUpload ? this.uploadT('MISSING_DEBUGGER_UPLOAD_PARAM') : this.uploadT('MISSING_UPLOAD_PARAM');
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

        let lastUploadText = this.uploadT('UPLOADING_BOARD', { board: boardJson.name });

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
          const message = this.uploadT('CONFIG_WRITE_FAILED_WITH_MESSAGE', { message: err.message || err });
          this.handleUploadError(message);
          this.workflowService.finishUpload(false, 'Config write failed');
          reject({ state: 'error', text: this.uploadT('CONFIG_WRITE_FAILED') });
          return;
        }

        // 运行上传脚本（1200bps_touch 和 wait_for_upload 预处理已移至 upload.js）
        const uploadScriptPath = window['path'].join(window['path'].getAilyChildPath(), 'scripts', 'upload.js');
        const uploadCmd = `node "${uploadScriptPath}" "${configFilePath}"`;

        console.log("Final upload cmd: ", uploadCmd);

        const title = this.uploadT('UPLOADING_TITLE');
        const completeTitle = this.uploadT('COMPLETE_TITLE');
        const errorTitle = this.uploadT('FAILED_TITLE');
        const completeText = this.uploadT('COMPLETE_TEXT');
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
            { delay: 300,  progress: 3,  text: this.uploadT('CONNECTING_DEVICE') },
            { delay: 800,  progress: 8,  text: this.uploadT('ERASING') },
            { delay: 1200, progress: 15, text: this.uploadT('ERASING') },
            { delay: 1800, progress: 20, text: this.uploadT('UPLOADING') },
            { delay: 2500, progress: 35, text: this.uploadT('UPLOADING') },
            { delay: 3500, progress: 50, text: this.uploadT('UPLOADING') },
            { delay: 5000, progress: 65, text: this.uploadT('UPLOADING') },
            { delay: 6500, progress: 78, text: this.uploadT('UPLOADING') },
            { delay: 8000, progress: 88, text: this.uploadT('VERIFYING') },
            { delay: 9500, progress: 95, text: this.uploadT('VERIFYING') },
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
        void this.appDataResourceLock.runShared('upload:run', () => new Promise<void>((releaseUploadLock) => {
        if (this.cancelled) {
          releaseUploadLock();
          return;
        }

        this.cmdService.run(uploadCmd, null, false).subscribe({
          next: async (output: CmdOutput) => {
            this.streamId = output.streamId;

            if (output.type === 'close') {
              this.processExitCode = output.code ?? (output.signal ? 1 : 0);

              if (!this.cancelled && this.processExitCode !== 0) {
                errorText = output.signal
                  ? this.uploadT('PROCESS_SIGNAL_TERMINATED', { signal: output.signal })
                  : this.uploadT('PROCESS_EXITED_WITH_CODE', { code: this.processExitCode });
                if (!fullErrorText) {
                  fullErrorText = errorText;
                }
                this.isErrored = true;
              }
              return;
            }

            if (output.type === 'error') {
              errorText = output.error || this.uploadT('PROCESS_START_FAILED');
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
                      this.handleUploadError(trimmedLine, this.uploadT('FAILED_TITLE'), fullErrorText);
                    }

                    if (this.isErrored) {
                      this.logService.update({ "detail": line, "state": "error" });
                      this.appendUploadLog(line, 'ERROR');
                      return;
                    } else {
                      this.logService.update({ "detail": line });
                      this.appendUploadLog(line, 'DEBUG');
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
                        lastUploadText = this.uploadT('ERASING');
                      } else if (phase === 'programming') {
                        progressValue = 15 + Math.floor(phaseProgress * 0.70);
                        lastUploadText = this.uploadT('UPLOADING');
                      } else if (phase === 'verifying') {
                        progressValue = 85 + Math.floor(phaseProgress * 0.14);
                        lastUploadText = this.uploadT('VERIFYING');
                      }
                      // 强制刷新显示（probe-rs 阶段切换时进度可能回到0再上升）
                      lastProgress = Math.min(lastProgress, progressValue - 1);
                    } else if (probeRsFinished) {
                      hasRealProgress = true;
                      progressValue = 100;
                      lastUploadText = this.uploadT('COMPLETE_TEXT');
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
            releaseUploadLock();
            console.log("上传命令错误:", error);
            this.uploadInProgress = false; // 确保重置上传状态
            this._builderService.isUploading = false;
            const fullErrorMessage = (error?.error || error?.stack || error?.message || String(error)).toString();
            this.handleUploadError(error.message || this.uploadT('PROCESS_ERROR'), this.uploadT('FAILED_TITLE'), fullErrorMessage);
            this.workflowService.finishUpload(false, error.message || 'Upload error');
            this.uploadPromiseReject = null;
            reject({ state: 'error', text: error.message || this.uploadT('FAILED_TITLE') });
          },
          complete: () => {
            if (syntheticProgressTimer) { clearInterval(syntheticProgressTimer); syntheticProgressTimer = null; }
            releaseUploadLock();
            console.log("上传命令完成，cancelled:", this.cancelled, "isErrored:", this.isErrored, "uploadCompleted:", this.uploadCompleted, "processExitCode:", this.processExitCode);
            
            // 确保 uploadInProgress 在所有情况下都被重置
            this.uploadInProgress = false;

            if (!this.cancelled && !this.isErrored && this.processExitCode !== null && this.processExitCode !== 0) {
              this.isErrored = true;
              if (!errorText) {
                errorText = this.uploadT('PROCESS_EXITED_WITH_CODE', { code: this.processExitCode });
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
                title: this.uploadT('CANCELLED'),
                text: this.uploadT('CANCELLED'),
                state: 'warn',
                setTimeout: 55000,
                isCancellationNotice: true
              });
              this._builderService.isUploading = false;
              this.workflowService.finishUpload(false, 'Cancelled');
              this.uploadPromiseReject = null;
              reject({ state: 'warn', text: this.uploadT('CANCELLED') });
            } else if (this.isErrored) {
              console.log("上传命令完成 - 发生错误");
              console.log("[Uploader][DIAG] errorText =", errorText);
              console.log("[Uploader][DIAG] fullErrorText =", fullErrorText);
              this._builderService.isUploading = false;
              this.handleUploadError(this.uploadT('PROCESS_ERROR'), this.uploadT('FAILED_TITLE'), fullErrorText || errorText || this.uploadT('PROCESS_ERROR'));
              this.workflowService.finishUpload(false, errorText);
              this.uploadPromiseReject = null;
              reject({ state: 'error', text: errorText || this.uploadT('PROCESS_ERROR') });
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
              resolve({ state: 'done', text: this.uploadT('COMPLETE_TEXT') });
            } else {
              // 这个分支理论上不应该被触发，因为上面已经处理了正常结束的情况
              // 但作为兜底逻辑保留
              console.warn("上传状态异常，可能是由于进程异常退出");
              // 安全更新UI
              this.safeUpdateNotice({
                title: errorTitle,
                text: lastUploadText,
                detail: this.uploadT('ABNORMAL_STATUS_DETAIL'),
                state: 'error',
                setTimeout: 600000
              });
              this._builderService.isUploading = false;
              this.workflowService.finishUpload(false, 'Upload incomplete');
              this.uploadPromiseReject = null;
              reject({ state: 'error', text: this.uploadT('INCOMPLETE_CHECK_LOG') });
            }
          }
        });
        }));
      } catch (error) {
        this._builderService.isUploading = false; // 确保在异常情况下设置为false
        const fullErrorMessage = (error?.error || error?.stack || error?.message || String(error)).toString();
        this.handleUploadError(error.message || this.uploadT('FAILED_TITLE'), this.uploadT('FAILED_TITLE'), fullErrorMessage);
        this.workflowService.finishUpload(false, error.message || 'Upload failed');
        this.uploadPromiseReject = null;
        reject({ state: 'error', text: error.message || this.uploadT('FAILED_TITLE') });
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

  private async uploadByNetworkOta(buildPath: string, portInfo: any, boardName = ''): Promise<ActionState> {
    let target: NetworkOtaUploadTarget;
    try {
      target = this.getNetworkOtaTarget(portInfo);
    } catch (error) {
      const message = error?.message || this.networkT('UPLOAD_FAILED_FALLBACK');
      this.uploadInProgress = false;
      this._builderService.isUploading = false;
      this.handleUploadError(message, this.networkT('UPLOAD_FAILED_TITLE'), message);
      this.workflowService.finishUpload(false, message);
      throw { state: 'error', text: message };
    }

    const firmwarePath = this.uploaderBleService.findFirmwareFile(buildPath);
    if (!firmwarePath) {
      const message = this.networkT('NO_FIRMWARE');
      this.logNetworkOtaUpload(this.networkT('LOG_ERROR', { message }), 'error');
      this.logNetworkOtaUpload(this.networkT('LOG_BUILD_PATH', { path: buildPath }), 'error');
      this.uploadInProgress = false;
      this._builderService.isUploading = false;
      this.handleUploadError(message, this.networkT('UPLOAD_FAILED_TITLE'), this.networkT('LOG_BUILD_PATH', { path: buildPath }));
      this.workflowService.finishUpload(false, 'WiFi OTA firmware not found');
      throw { state: 'error', text: message };
    }

    const firmwareStats = window['fs'].statSync(firmwarePath);
    const firmwareSize = Number(firmwareStats?.size || 0);
    const firmwareName = window['path'].basename(firmwarePath);
    const targetName = target.name || boardName || `${target.host}:${target.port}`;

    this.logNetworkOtaUpload(this.networkT('LOG_PREPARE_UPLOAD', { target: targetName }));
    this.logNetworkOtaUpload(this.networkT('LOG_FIRMWARE_FILE', { path: firmwarePath }));
    this.logNetworkOtaUpload(this.networkT('LOG_FIRMWARE_SIZE', { size: this.formatBytes(firmwareSize) }));

    const currentProjectPath = this.projectService.currentProjectPath;
    const tempPath = window['path'].join(currentProjectPath, '.temp');
    if (!window['fs'].existsSync(tempPath)) {
      window['fs'].mkdirSync(tempPath, { recursive: true });
    }

    const uploadConfig = {
      firmwarePath,
      host: target.host,
      port: target.port,
      username: target.username,
      password: target.password,
      uploadPath: target.uploadPath,
      ssl: !!target.ssl,
      timeoutMs: target.timeoutMs || 60000,
    };

    const configFilePath = window['path'].join(tempPath, 'network-ota-upload-config.json');
    try {
      await window['fs'].writeFileSync(configFilePath, JSON.stringify(uploadConfig, null, 2));
    } catch (err) {
      this.uploadInProgress = false;
      this._builderService.isUploading = false;
      const message = this.uploadT('CONFIG_WRITE_FAILED_WITH_MESSAGE', { message: err.message || err });
      this.handleUploadError(message);
      this.workflowService.finishUpload(false, 'WiFi OTA config write failed');
      throw { state: 'error', text: this.uploadT('CONFIG_WRITE_FAILED') };
    }

    const uploadScriptPath = window['path'].join(window['path'].getAilyChildPath(), 'scripts', 'network-ota-upload.js');
    const uploadCmd = `node "${uploadScriptPath}" "${configFilePath}"`;
    const title = this.networkT('UPLOADING_TITLE');
    let lastProgress = 0;
    let errorText = '';
    let fullErrorText = '';
    let completed = false;
    let processExitCode: number | null = null;
    let bufferData = '';

    this.uploadInProgress = true;
    this.uploadCompleted = false;
    this.noticeService.update({
      title,
      text: this.networkT('PREPARING', { target: targetName || firmwareName }),
      state: 'doing',
      progress: 0,
      setTimeout: 0,
      stop: () => { this.cancel(); }
    });

    return new Promise<ActionState>((resolve, reject) => {
      const handleLine = (line: string) => {
        const trimmedLine = line.trim();
        if (!trimmedLine || this.cancelled) return;

        const progressMatch = trimmedLine.match(/^\[network-ota:progress\]\s+(\d+)(?:\s+(.*))?$/);
        if (progressMatch) {
          const progressValue = Math.max(0, Math.min(100, Number(progressMatch[1] || 0)));
          const progressText = progressMatch[2] || this.networkT('UPLOADING_FALLBACK');
          if (progressValue >= lastProgress || progressValue === 100) {
            lastProgress = progressValue;
            this.safeUpdateNotice({
              title,
              text: progressText,
              state: 'doing',
              progress: progressValue,
              setTimeout: 0,
              stop: () => { this.cancel(); },
            });
          }
          this.logNetworkOtaUpload(`${progressText} ${progressValue}%`);
          return;
        }

        if (trimmedLine === '[network-ota:done]') {
          completed = true;
          this.uploadCompleted = true;
          return;
        }

        const errorMatch = trimmedLine.match(/^\[network-ota:error\]\s*(.*)$/);
        if (errorMatch) {
          errorText = errorMatch[1] || this.networkT('UPLOAD_FAILED_FALLBACK');
          fullErrorText += `${errorText}\n`;
          this.isErrored = true;
          this.logNetworkOtaUpload(errorText, 'error');
          return;
        }

        if (/error|failed|timed out|http\s+[45]\d\d/i.test(trimmedLine)) {
          errorText = trimmedLine;
          fullErrorText += `${trimmedLine}\n`;
          this.isErrored = true;
          this.logNetworkOtaUpload(trimmedLine, 'error');
          return;
        }

        this.logNetworkOtaUpload(trimmedLine);
      };

      void this.appDataResourceLock.runShared('upload:network-ota', () => new Promise<void>((releaseUploadLock) => {
        if (this.cancelled) {
          releaseUploadLock();
          return;
        }

        this.cmdService.run(uploadCmd, null, false).subscribe({
          next: (output: CmdOutput) => {
            this.streamId = output.streamId;

            if (output.type === 'close') {
              processExitCode = output.code ?? (output.signal ? 1 : 0);
              if (!this.cancelled && processExitCode !== 0) {
                errorText = output.signal
                  ? this.uploadT('PROCESS_SIGNAL_TERMINATED', { signal: output.signal })
                  : this.uploadT('PROCESS_EXITED_WITH_CODE', { code: processExitCode });
                if (!fullErrorText) {
                  fullErrorText = output.stderr || output.stdout || errorText;
                }
                this.isErrored = true;
              }
              return;
            }

            if (output.type === 'error') {
              errorText = output.error || this.uploadT('PROCESS_START_FAILED');
              if (!fullErrorText) {
                fullErrorText = errorText;
              }
              this.isErrored = true;
              return;
            }

            if (this.cancelled && this['shouldKillImmediately'] && this.streamId) {
              this.cmdService.kill(this.streamId);
              this['shouldKillImmediately'] = false;
              return;
            }

            if (this.cancelled) return;

            if (output.data) {
              const lines = (bufferData + output.data).split(/\r\n|\n|\r/);
              bufferData = lines.pop() || '';
              lines.forEach(handleLine);
            }
          },
          error: (error: any) => {
            releaseUploadLock();
            this.uploadInProgress = false;
            this._builderService.isUploading = false;
            const fullErrorMessage = (error?.error || error?.stack || error?.message || String(error)).toString();
            this.handleUploadError(error.message || this.networkT('UPLOAD_FAILED_FALLBACK'), this.networkT('UPLOAD_FAILED_TITLE'), fullErrorMessage);
            this.workflowService.finishUpload(false, error.message || 'WiFi OTA upload error');
            reject({ state: 'error', text: error.message || this.networkT('UPLOAD_FAILED_FALLBACK') });
          },
          complete: () => {
            releaseUploadLock();
            if (bufferData.trim()) {
              handleLine(bufferData);
              bufferData = '';
            }

            this.uploadInProgress = false;

            if (this.cancelled) {
              this.logNetworkOtaUpload(this.networkT('LOG_UPLOAD_CANCELLED'), 'warn');
              this.safeUpdateNotice({
                title: this.networkT('CANCELLED'),
                text: this.networkT('CANCELLED'),
                state: 'warn',
                setTimeout: 55000,
                isCancellationNotice: true,
              });
              this._builderService.isUploading = false;
              this.workflowService.finishUpload(false, 'WiFi OTA cancelled');
              reject({ state: 'warn', text: this.networkT('CANCELLED') });
              return;
            }

            if (!completed && !this.isErrored && (processExitCode === null || processExitCode === 0)) {
              completed = true;
            }

            if (this.isErrored) {
              const message = errorText || this.networkT('UPLOAD_FAILED_FALLBACK');
              this._builderService.isUploading = false;
              this.handleUploadError(message, this.networkT('UPLOAD_FAILED_TITLE'), fullErrorText || message);
              this.workflowService.finishUpload(false, message);
              reject({ state: 'error', text: message });
              return;
            }

            if (completed) {
              this.uploadCompleted = true;
              this._builderService.isUploading = false;
              this.workflowService.finishUpload(true);
              this.logNetworkOtaUpload(this.networkT('LOG_UPLOAD_DONE', { size: this.formatBytes(firmwareSize) }), 'done');
              this.safeUpdateNotice({
                title: this.networkT('UPLOAD_DONE_TITLE'),
                text: this.networkT('UPLOAD_DONE_TEXT', { size: this.formatBytes(firmwareSize) }),
                state: 'done',
                setTimeout: 55000,
              });
              resolve({ state: 'done', text: this.networkT('UPLOAD_DONE_SHORT') });
              return;
            }

            const message = this.networkT('UPLOAD_FAILED_FALLBACK');
            this._builderService.isUploading = false;
            this.handleUploadError(message, this.networkT('UPLOAD_FAILED_TITLE'), fullErrorText || message);
            this.workflowService.finishUpload(false, message);
            reject({ state: 'error', text: message });
          }
        });
      }));
    });
  }

  private async uploadByBle(buildPath: string, portInfo: any, boardName = ''): Promise<ActionState> {
    const firmwarePath = this.uploaderBleService.findFirmwareFile(buildPath);
    if (!firmwarePath) {
      const message = this.t('NO_FIRMWARE');
      this.logBleUpload(this.t('LOG_ERROR', { message }), 'error');
      this.logBleUpload(this.t('LOG_BUILD_PATH', { path: buildPath }), 'error');
      this.uploadInProgress = false;
      this._builderService.isUploading = false;
      this.handleUploadError(message, this.t('UPLOAD_FAILED_TITLE'), this.t('LOG_BUILD_PATH', { path: buildPath }));
      this.workflowService.finishUpload(false, 'BLE OTA firmware not found');
      throw { state: 'error', text: message };
    }

    const firmware = this.uploaderBleService.readFirmwareFile(firmwarePath);
    const firmwareName = window['path'].basename(firmwarePath);
    let lastProgress = -1;
    let lastLoggedProgress = -1;
    let lastLoggedState = '';
    let lastLoggedText = '';
    const targetName = boardName || portInfo?.text || portInfo?.name || this.t('DEFAULT_TARGET_NAME');

    this.logBleUpload(this.t('LOG_PREPARE_UPLOAD', { target: targetName }));
    this.logBleUpload(this.t('LOG_FIRMWARE_FILE', { path: firmwarePath }));
    this.logBleUpload(this.t('LOG_FIRMWARE_SIZE', { size: this.formatBytes(firmware.byteLength) }));

    this.uploadInProgress = true;
    this.uploadCompleted = false;
    this.noticeService.update({
      title: this.t('UPLOADING_TITLE'),
      text: this.t('PREPARING', { target: boardName || portInfo?.text || firmwareName }),
      state: 'doing',
      progress: 0,
      setTimeout: 0,
      stop: () => { this.cancel(); }
    });

    const updateProgress = (progress: BleOtaProgress) => {
      if (this.cancelled) return;
      const progressValue = Math.max(0, Math.min(100, Math.floor(progress.progress || 0)));
      const progressText = progress.text || this.t('UPLOADING_FALLBACK');
      const shouldLogState = progress.state !== lastLoggedState;
      const shouldLogText = progress.state !== 'sending' && progressText !== lastLoggedText;
      const shouldLogProgress = progress.state === 'sending'
        && progressValue > lastLoggedProgress
        && (progressValue === 100 || progressValue - lastLoggedProgress >= 5);

      if (shouldLogState || shouldLogText || shouldLogProgress) {
        const bytesText = typeof progress.bytesSent === 'number' && typeof progress.totalBytes === 'number'
          ? ` (${this.formatBytes(progress.bytesSent)} / ${this.formatBytes(progress.totalBytes)})`
          : '';
        const sectorText = typeof progress.sectorIndex === 'number' && typeof progress.sectorCount === 'number'
          ? ` ${this.t('SECTOR_PROGRESS', { current: progress.sectorIndex + 1, total: progress.sectorCount })}`
          : '';
        const speedText = progress.speed ? `, ${this.formatBytes(progress.speed)}/s` : '';
        this.logBleUpload(`${progressText} ${progressValue}%${bytesText}${sectorText}${speedText}`.trim());
        lastLoggedState = progress.state;
        lastLoggedText = progressText;
        if (progress.state === 'sending') {
          lastLoggedProgress = progressValue;
        }
      }

      if (progressValue === lastProgress && progress.state === 'sending') return;
      lastProgress = progressValue;
      const isVerifyingFirmware = progress.state === 'stopping';
      this.safeUpdateNotice({
        title: isVerifyingFirmware ? progressText : this.t('UPLOADING_TITLE'),
        text: isVerifyingFirmware ? this.uploadT('PLEASE_WAIT') : (progress.text || this.t('UPLOADING_TITLE')),
        state: 'doing',
        progress: progressValue,
        setTimeout: 0,
        stop: () => { this.cancel(); },
      });
    };

    try {
      const result = await this.uploaderBleService.uploadFirmware(firmware, {
        updateType: 'flash',
        progress: updateProgress,
      });

      if (this.cancelled) {
        throw { state: 'warn', text: this.t('CANCELLED') };
      }

      this.uploadCompleted = true;
      this.uploadInProgress = false;
      this._builderService.isUploading = false;
      this.workflowService.finishUpload(true);
      this.logBleUpload(this.t('LOG_UPLOAD_DONE', { size: this.formatBytes(result.bytes), elapsed: (result.elapsedMs / 1000).toFixed(1) }), 'done');
      this.safeUpdateNotice({
        title: this.t('UPLOAD_DONE_TITLE'),
        text: this.t('UPLOAD_DONE_TEXT', { size: this.formatBytes(result.bytes) }),
        state: 'done',
        setTimeout: 55000,
      });
      return { state: 'done', text: this.t('UPLOAD_DONE_SHORT') };
    } catch (error) {
      this.uploadInProgress = false;
      this._builderService.isUploading = false;

      if (this.cancelled || error?.state === 'warn') {
        this.logBleUpload(this.t('LOG_UPLOAD_CANCELLED'), 'warn');
        this.safeUpdateNotice({
          title: this.t('CANCELLED'),
          text: this.t('CANCELLED'),
          state: 'warn',
          setTimeout: 55000,
          isCancellationNotice: true,
        });
        this.workflowService.finishUpload(false, 'BLE OTA cancelled');
        throw { state: 'warn', text: this.t('CANCELLED') };
      }

      const message = error?.message || error?.text || this.t('UPLOAD_FAILED_FALLBACK');
      this.logBleUpload(this.t('LOG_UPLOAD_FAILED', { message }), 'error');
      this.handleUploadError(message, this.t('UPLOAD_FAILED_TITLE'), message);
      this.workflowService.finishUpload(false, message);
      throw { state: 'error', text: message };
    } finally {
      await this.uploaderBleService.disconnect().catch(() => undefined);
    }
  }

  private formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  }

  private getNetworkOtaTarget(portInfo: any): NetworkOtaUploadTarget {
    const source = portInfo?.extra?.target || portInfo?.extra || {};
    const host = (source.host || portInfo?.name || '').toString().trim();
    const port = Number(source.port || 65280);
    const uploadPath = (source.uploadPath || '/sketch').toString().trim();

    if (!host) {
      throw new Error(this.networkT('INVALID_HOST'));
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(this.networkT('INVALID_PORT'));
    }

    return {
      id: source.id || portInfo?.name,
      name: source.name || portInfo?.text || '',
      host,
      port,
      username: (source.username || 'arduino').toString(),
      password: (source.password || 'password').toString(),
      uploadPath: uploadPath.startsWith('/') ? uploadPath : `/${uploadPath}`,
      ssl: !!source.ssl,
      timeoutMs: Math.max(1000, Number(source.timeoutMs || 60000)),
    };
  }

  private async hasProjectDependency(dependencyName: string): Promise<boolean> {
    try {
      const packageJson = await this.projectService.getPackageJson();
      const dependencies = {
        ...(packageJson?.dependencies || {}),
        ...(packageJson?.devDependencies || {}),
        ...(packageJson?.optionalDependencies || {}),
        ...(packageJson?.peerDependencies || {}),
      };

      return Object.prototype.hasOwnProperty.call(dependencies, dependencyName);
    } catch (error) {
      console.warn('读取项目依赖失败:', error);
      return false;
    }
  }

  private async canUseWifiOta(): Promise<boolean> {
    const core = (this.projectService.currentBoardConfig?.['core'] || '').toLowerCase();
    return this.isEsp32Core(core) && await this.hasProjectDependency('@aily-project/lib-wifiota');
  }

  private isEsp32Core(core: string): boolean {
    return core === 'esp32' || core.startsWith('esp32:');
  }

  private logNetworkOtaUpload(detail: string, state?: string) {
    this.logService.update({
      detail: `[WiFi OTA] ${detail}`,
      state,
    });
    this.appendUploadLog(`[WiFi OTA] ${detail}`, mapLogStateToLevel(state));
  }

  private logBleUpload(detail: string, state?: string) {
    this.logService.update({
      detail: `[BLE OTA] ${detail}`,
      state,
    });
    this.appendUploadLog(`[BLE OTA] ${detail}`, mapLogStateToLevel(state));
  }

  private uploadT(key: string, params?: Record<string, any>): string {
    return this.translate.instant(`BLOCKLY_EDITOR.UPLOAD.${key}`, params);
  }

  private t(key: string, params?: Record<string, any>): string {
    return this.translate.instant(`BLE_OTA.${key}`, params);
  }

  private networkT(key: string, params?: Record<string, any>): string {
    return this.translate.instant(`NETWORK_OTA.${key}`, params);
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
    this.uploaderBleService.cancel();
    
    // 立即更新通知状态为已取消
    this.noticeService.update({
      title: this.uploadT('CANCELLED'),
      text: this.uploadT('CANCELLED'),
      state: 'warn',
      setTimeout: 55000,
      isCancellationNotice: true
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
    } else if (this.serialService.currentPortInfo?.type === 'ble') {
      console.log("BLE OTA 上传已请求取消");
    } else {
      console.log("streamId尚未设置，将在获取后立即杀死");
      // 标记为需要立即杀死，当streamId被设置后会立即杀死
      this['shouldKillImmediately'] = true;
    }
    
    // 完成工作流状态
    this.workflowService.finishUpload(false, 'Cancelled by user');
    
    // 立即 reject Promise，使按钮状态快速更新
    if (this.uploadPromiseReject) {
      this.uploadPromiseReject({ state: 'warn', text: this.uploadT('CANCELLED') });
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
        return { success: false, message: this.uploadT('SOFTDEVICE_HEX_NOT_FOUND', { name: softdeviceName }) };
      }

      // 获取 board.json 配置
      const boardJson = await this.projectService.getBoardJson();
      if (!boardJson || !boardJson.uploadParam) {
        return { success: false, message: this.uploadT('UPLOAD_PARAM_CONFIG_NOT_FOUND') };
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

      const title = this.uploadT('SOFTDEVICE_FLASHING_TITLE');
      const completeTitle = this.uploadT('SOFTDEVICE_FLASH_SUCCESS_TITLE');
      const errorTitle = this.uploadT('SOFTDEVICE_FLASH_FAILED_TITLE');

      // 显示烧录中通知
      this.noticeService.update({
        title: title,
        text: this.uploadT('INITIALIZING'),
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

        void this.appDataResourceLock.runShared('upload:softdevice', () => new Promise<void>((releaseUploadLock) => {
        this.cmdService.run(uploadCmd, null, false).subscribe({
          next: (output: CmdOutput) => {
            if (output.type === 'close') {
              if ((output.code ?? 0) !== 0 || output.signal) {
                hasError = true;
                errorMessage = output.signal
                  ? this.uploadT('SOFTDEVICE_PROCESS_SIGNAL_TERMINATED', { signal: output.signal })
                  : this.uploadT('SOFTDEVICE_PROCESS_EXITED_WITH_CODE', { code: output.code });
              }
              return;
            }

            if (output.type === 'error') {
              hasError = true;
              errorMessage = output.error || this.uploadT('SOFTDEVICE_PROCESS_START_FAILED');
              return;
            }

            if (output.data) {
              console.log('Softdevice 烧录输出:', output.data);
              this.appendUploadLog(output.data, 'DEBUG');
              const data = output.data;

              // 检查是否有错误信息
              if (data.includes('[ERROR]') || data.includes('Error:') || data.includes('error:')) {
                hasError = true;
                errorMessage = data;
                this.appendUploadLog(data, 'ERROR');
              }

              // 解析 OpenOCD 烧录进度
              // 初始化阶段 (0-10%)
              if (data.includes('CMSIS-DAP: Interface ready') || data.includes('clock speed')) {
                lastProgress = 5;
                currentStage = this.uploadT('CONNECTING_DEVICE');
              }
              if (data.includes('SWD IDCODE') || data.includes('nrf51.cpu')) {
                lastProgress = 10;
                currentStage = this.uploadT('DEVICE_DETECTED');
              }

              // 编程阶段 (10-60%)
              if (data.includes('** Programming Started **')) {
                lastProgress = 15;
                currentStage = this.uploadT('START_WRITING');
              }
              if (data.includes('auto erase enabled')) {
                lastProgress = 20;
                currentStage = this.uploadT('ERASING');
              }
              if (data.includes('Padding image section')) {
                lastProgress = 25;
                currentStage = this.uploadT('PREPARING_DATA');
              }
              if (data.includes('using fast async flash loader')) {
                lastProgress = 30;
                currentStage = this.uploadT('FAST_WRITE_MODE');
              }
              // 写入完成时解析进度
              const writeMatch = data.match(/wrote (\d+) bytes.*in ([\d.]+)s/);
              if (writeMatch) {
                lastProgress = 55;
                currentStage = this.uploadT('WRITTEN_KB', { size: Math.round(parseInt(writeMatch[1]) / 1024) });
              }
              if (data.includes('** Programming Finished **')) {
                lastProgress = 60;
                currentStage = this.uploadT('WRITE_COMPLETE');
              }

              // 验证阶段 (60-90%)
              if (data.includes('** Verify Started **')) {
                lastProgress = 65;
                currentStage = this.uploadT('START_VERIFYING');
              }
              const verifyMatch = data.match(/verified (\d+) bytes/);
              if (verifyMatch) {
                lastProgress = 85;
                currentStage = this.uploadT('VERIFIED_KB', { size: Math.round(parseInt(verifyMatch[1]) / 1024) });
              }
              if (data.includes('** Verified OK **')) {
                lastProgress = 90;
                currentStage = this.uploadT('VERIFY_SUCCESS');
              }

              // 完成阶段 (90-100%)
              if (data.includes('** Resetting Target **')) {
                lastProgress = 95;
                currentStage = this.uploadT('RESETTING_DEVICE');
              }
              if (data.includes('shutdown command invoked')) {
                lastProgress = 100;
                currentStage = this.uploadT('SOFTDEVICE_FLASH_COMPLETE');
                uploadCompleted = true;
              }

              // 更新进度显示
              if (lastProgress > 0) {
                this.noticeService.update({
                  title: title,
                  text: currentStage || this.uploadT('SOFTDEVICE_FLASHING_TEXT', { name: softdeviceName }),
                  state: 'doing',
                  progress: lastProgress,
                  setTimeout: 0
                });
              }
            }
          },
          error: (error: any) => {
            console.error('Softdevice 烧录错误:', error);
            releaseUploadLock();
            this.noticeService.update({
              title: errorTitle,
              text: this.uploadT('SOFTDEVICE_FLASH_FAILED_WITH_MESSAGE', { message: error.message || error }),
              state: 'error',
              setTimeout: 60000
            });
            resolve({ success: false, message: this.uploadT('SOFTDEVICE_FLASH_FAILED_WITH_MESSAGE', { message: error.message || error }) });
          },
          complete: () => {
            console.log('Softdevice 烧录命令执行完成, hasError:', hasError, 'uploadCompleted:', uploadCompleted);
            releaseUploadLock();
            if (hasError) {
              this.noticeService.update({
                title: errorTitle,
                text: errorMessage || this.uploadT('SOFTDEVICE_FLASH_FAILED_TITLE'),
                state: 'error',
                setTimeout: 60000
              });
              resolve({ success: false, message: errorMessage || this.uploadT('SOFTDEVICE_FLASH_FAILED_TITLE') });
            } else {
              this.noticeService.update({
                title: completeTitle,
                text: this.uploadT('SOFTDEVICE_FLASH_SUCCESS_TEXT', { name: softdeviceName }),
                state: 'done',
                setTimeout: 5000
              });
              resolve({ success: true, message: this.uploadT('SOFTDEVICE_FLASH_SUCCESS_SHORT') });
            }
          }
        });
        }));
      });
    } catch (error: any) {
      console.error('烧录 softdevice 失败:', error);
      this.noticeService.update({
        title: this.uploadT('SOFTDEVICE_FLASH_FAILED_TITLE'),
        text: this.uploadT('SOFTDEVICE_FLASH_FAILED_WITH_MESSAGE', { message: error.message || error }),
        state: 'error',
        setTimeout: 60000
      });
      return { success: false, message: this.uploadT('SOFTDEVICE_FLASH_FAILED_WITH_MESSAGE', { message: error.message || error }) };
    }
  }
}
