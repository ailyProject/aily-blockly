import { Inject, Injectable } from '@angular/core';
import { ElectronService } from '@core/platform/public-api';
import { BuilderService } from '@domain/build/public-api';
import { SerialService } from './serial.service';
import type { UploadRecoveryPolicy } from './policies/upload-recovery-policy';
import { ProjectService } from '@domain/project/public-api';
import { resolveUploadDispatchMode } from './policies/upload-dispatch-policy';
import {
  DEVICE_APPLICATION_PORT,
  type DeviceApplicationPort,
} from './ports/device-application.port';
import {
  type LinuxBoardConnector,
  type LinuxBoardExecutionRoute,
  normalizeProjectMode,
  resolveLinuxBoardConnectorSelection,
  resolveLinuxBoardExecutionRoute,
} from '@shared/public-api';

@Injectable({
  providedIn: 'root'
})
export class UploaderService {

  private uploadOperationSequence = 0;
  private directUploaderActive = false;

  constructor(
    @Inject(DEVICE_APPLICATION_PORT)
    private application: DeviceApplicationPort,
    private electronService: ElectronService,
    private serialService: SerialService,
    private projectService: ProjectService,
    private builderService: BuilderService,
  ) { }

  requiresLocalPort(): boolean {
    // Arduino 始终使用本地端口；Python 仅在所选 Linux 连接方式为 serial 时需要端口。
    if (!this.isPythonProject()) return true;
    const route = this.currentLinuxBoardRoute();
    return route ? this.currentLinuxBoardTransport(route) === 'serial' : false;
  }

  private isPythonProject(): boolean {
    // 上传模式与生成器保持同源，只由项目 package.json.devmode 决定。
    return normalizeProjectMode(this.projectService.currentPackageData) === 'python';
  }

  private currentLinuxBoardRoute(): LinuxBoardExecutionRoute | null {
    // Python 项目还必须匹配 board.json.mode/connector 才能进入 Linux 执行路径。
    return resolveLinuxBoardExecutionRoute(
      this.projectService.currentPackageData,
      this.projectService.currentBoardConfig,
    );
  }

  private currentLinuxBoardTransport(
    route: LinuxBoardExecutionRoute,
  ): LinuxBoardConnector | null {
    return resolveLinuxBoardConnectorSelection(
      route.connectors,
      this.application.getLinuxBoardSelectedTransport(),
    );
  }

  private async uploadPythonProject(route: LinuxBoardExecutionRoute): Promise<any> {
    const transport = this.currentLinuxBoardTransport(route);
    if (!transport) throw new Error('Select an SSH or serial connection before running');
    const prepared = await this.preparePythonProject(route);
    return this.application.syncAndRunLinuxBoardSource(
      prepared.source,
      prepared.projectPath,
      transport,
      prepared.entry,
    );
  }

  stopPythonProject(): Promise<Record<string, unknown>> {
    return this.application.stopLinuxBoardProject();
  }

  private async preparePythonProject(route: LinuxBoardExecutionRoute): Promise<{
    source: string;
    projectPath: string;
    entry: string;
  }> {
    const projectPath = this.projectService.currentProjectPath;
    if (!projectPath) throw new Error('当前项目路径无效');
    await this.builderService.build();
    const currentRoute = this.currentLinuxBoardRoute();
    if (
      this.projectService.currentProjectPath !== projectPath
      || currentRoute?.entry !== route.entry
      || currentRoute?.connectors.join(',') !== route.connectors.join(',')
    ) {
      throw new Error('Project changed while Python code was being prepared');
    }
    const entryPath = this.electronService.pathJoin(projectPath, ...route.entry.split('/'));
    const source = window['fs'].readFileSync(entryPath, 'utf8');
    return { source, projectPath, entry: route.entry };
  }

  /** 未标记类型的历史端口按串口处理。 */
  private isSerialPortType(type: string | null | undefined): boolean {
    return !type || type === 'serial';
  }

  private createUploadOperationId(kind: string, port: any): string {
    this.uploadOperationSequence += 1;
    const normalizedKind = String(kind || 'firmware-upload').replace(/[^a-z0-9_.-]+/gi, '-');
    const normalizedPort = String(port || 'unknown').replace(/[^a-z0-9_.-]+/gi, '-');
    return `${normalizedKind}-${normalizedPort}-${Date.now()}-${this.uploadOperationSequence}`;
  }

  private resumeLifecycleFromPolicy(
    recovery: UploadRecoveryPolicy | null | undefined,
  ): Record<string, unknown> {
    if (!recovery || typeof recovery !== 'object') return {};
    return {
      recovery,
      maxWaitMs: recovery.maxWaitMs,
      retryIntervalMs: recovery.retryIntervalMs,
      settleMs: recovery.settleMs,
    };
  }

  private async sendSerialMonitorUploadSignal(
    signal: string,
    port: any,
    portType = this.serialService.currentPortInfo?.type,
    lifecycle: Record<string, unknown> = {},
  ): Promise<void> {
    const resolvedPortType = portType || 'serial';
    if (!port || !this.isSerialPortType(resolvedPortType)) {
      console.log(`[Uploader] 跳过 ${signal}：非串口设备（port=${port}, portType=${resolvedPortType}）`);
      return;
    }

    // 让订阅方（serial-monitor / ffs-manager 等）把"释放串口"的
    // Promise 推进 waitFor，这里等它们全部完成后再开始处理后续动作。
    const waitFor: Promise<void>[] = [];
    const payload: Record<string, unknown> = {
      port,
      portType: resolvedPortType,
      waitFor,
      reason: 'firmware-upload',
      restore: true,
      ...lifecycle,
    };
    const subappLifecycleTask = this.application.handleSubappSignal(signal, payload);
    if (subappLifecycleTask) waitFor.push(subappLifecycleTask);
    this.application.sendToolSignal(signal, payload);
    console.log(`[Uploader] ${signal} 发出，收到 ${waitFor.length} 个 waitFor Promise（port=${port}）`);
    if (waitFor.length > 0) {
      try {
        await Promise.all(waitFor);
        console.log(`[Uploader] ${signal} 所有订阅方已完成释放`);
      } catch (err) {
        if (signal === 'serial-monitor:disconnect') throw err;
        console.warn(`[Uploader] ${signal} 等待订阅方完成时报错:`, err);
      }
    }
    // node-serialport 的 close 回调返回后，Windows 还要短暂窗口才会真正放开
    // 独占句柄；这里给外部 esptool.exe 等 child_process 一点缓冲，避免
    // "Could not open COMx, the port is busy" 报错。即使本次没有订阅方释放
    // 串口（waitFor=0），上一次 ffs-manager / serial-monitor 的关闭也可能
    // 刚发生不久，仍然需要这个缓冲。
    if (signal === 'serial-monitor:disconnect') {
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }

  async upload() {
    // Python 将 main.py 交给 Linux connector 同步并运行；其余项目保留原 Arduino 固件上传流程。
    if (this.isPythonProject()) {
      const pythonRoute = this.currentLinuxBoardRoute();
      if (!pythonRoute) {
        throw new Error('Python board.json 必须配置 mode: ["python"]，connector 必须是 ["ssh"]、["serial"] 或两者');
      }
      return this.uploadPythonProject(pythonRoute);
    }
    const uploadPort = this.serialService.currentPort;
    const uploadPortType = this.serialService.currentPortInfo?.type;
    const operationId = this.createUploadOperationId('firmware-upload', uploadPort);
    let uploadOutcome = 'failed';
    let resourceRecovery: UploadRecoveryPolicy | undefined;
    try {
      await this.sendSerialMonitorUploadSignal(
        'serial-monitor:disconnect',
        uploadPort,
        uploadPortType,
        { operationId },
      );
      const hasBlocklyUploader = this.application.hasActionListener('uploader-upload-begin');
      const isAilyCodeProject = this.projectService.isAilyCodeProject();
      const uploadDispatchMode = resolveUploadDispatchMode({ isAilyCodeProject, hasBlocklyUploader });
      let uploadResult: any;
      let uploadFeedbackError = '';
      let uploadFeedbackSuccess = true;

      if (uploadDispatchMode === 'coder-direct') {
        // Coder 路由不挂载 BlocklyEditorComponent，因此没有 upload-begin 监听器。
        // 直接进入共享上传器，避免等待五分钟超时；共享上传器只在构建入口和
        // buildPath 上区分 Coder，串口、板卡命令、进度与恢复语义保持一致。
        this.directUploaderActive = true;
        try {
          uploadResult = await this.application.uploadFromBlocklyEditor();
        } finally {
          this.directUploaderActive = false;
        }
      } else if (uploadDispatchMode === 'blockly-action') {
        const timeout = uploadPortType === 'ble' ? 900000 : 300000;
        const feedback = await this.application.dispatchActionWithFeedback('upload-begin', {}, timeout);
        uploadResult = feedback?.data?.result;
        uploadFeedbackError = feedback?.error || '';
        uploadFeedbackSuccess = feedback?.success !== false && feedback?.data?.success !== false;
      } else {
        throw new Error('当前上传编辑器尚未就绪，请等待项目完成加载后重试。');
      }

      resourceRecovery = uploadResult?.resourceRecovery;
      const uploadSuccess = uploadFeedbackSuccess
        && !!uploadResult
        && uploadResult?.state !== 'error';

      if (!uploadSuccess) {
        const error: any = new Error(uploadResult?.text || uploadFeedbackError || '上传失败');
        error.state = uploadResult?.state || 'error';
        error.text = uploadResult?.text || uploadFeedbackError || '上传失败';
        error.result = uploadResult;
        throw error;
      }

      if (!this.electronService.isWindowFocused()) {
        this.electronService.notify('上传', uploadResult?.text || '');
      }
      uploadOutcome = 'success';
      return uploadResult;
    } catch (error: any) {
      if (!this.electronService.isWindowFocused()) {
        this.electronService.notify('上传', error?.text || error?.message || '上传失败');
      }
      throw error;
    } finally {
      await this.sendSerialMonitorUploadSignal(
        'serial-monitor:connect',
        uploadPort,
        uploadPortType,
        {
          operationId,
          outcome: uploadOutcome,
          ...this.resumeLifecycleFromPolicy(resourceRecovery),
        },
      );
    }
  }

  /**
  * 取消当前编译过程
  */
  cancel() {
    if (this.directUploaderActive) {
      this.application.cancelBlocklyEditorUpload();
      return;
    }
    this.application.dispatchAction('upload-cancel', {}, result => {
      if (result.success) {
      } else {
      }
    });
  }

  /**
   * 烧录 softdevice 到 nRF5 设备
   * @param softdeviceName softdevice 名称，如 "s110" 或 "none"
   * @param serialPort 串口名称
   * @returns Promise 表示烧录结果
   */
  async flashSoftdevice(softdeviceName: string, serialPort: string): Promise<{ success: boolean; message: string }> {
    const uploadPort = serialPort || this.serialService.currentPort;
    const uploadPortType = this.serialService.currentPortInfo?.type;
    const operationId = this.createUploadOperationId('flash-softdevice', uploadPort);
    let uploadOutcome = 'failed';
    try {
      await this.sendSerialMonitorUploadSignal(
        'serial-monitor:disconnect',
        uploadPort,
        uploadPortType,
        { operationId },
      );
      const result = await this.application.dispatchActionWithFeedback('flash-softdevice', {
        softdeviceName,
        serialPort
      }, 300000);
      uploadOutcome = result.data?.result?.success ? 'success' : 'failed';
      
      if (!this.electronService.isWindowFocused()) {
        const message = result.data?.result?.success ? 'SoftDevice 烧录成功' : 'SoftDevice 烧录失败';
        this.electronService.notify('烧录', message);
      }
      return result.data?.result || { success: false, message: '烧录失败' };
    } catch (error: any) {
      if (!this.electronService.isWindowFocused()) {
        this.electronService.notify('烧录', 'SoftDevice 烧录失败');
      }
      return { success: false, message: error.message || '烧录失败' };
    } finally {
      await this.sendSerialMonitorUploadSignal(
        'serial-monitor:connect',
        uploadPort,
        uploadPortType,
        { operationId, outcome: uploadOutcome },
      );
    }
  }
}
