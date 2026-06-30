import { Injectable } from '@angular/core';
import { ActionService } from './action.service';
import { ElectronService } from './electron.service';
import { SerialService } from './serial.service';
import { UiService } from './ui.service';

@Injectable({
  providedIn: 'root'
})
export class UploaderService {

  constructor(
    private actionService: ActionService,
    private electronService: ElectronService,
    private serialService: SerialService,
    private uiService: UiService
  ) { }

  /** 未标记类型的历史端口按串口处理。 */
  private isSerialPortType(type: string | null | undefined): boolean {
    return !type || type === 'serial';
  }

  private async sendSerialMonitorUploadSignal(signal: string, port: any, portType = this.serialService.currentPortInfo?.type): Promise<void> {
    const resolvedPortType = portType || 'serial';
    if (!port || !this.isSerialPortType(resolvedPortType)) {
      console.log(`[Uploader] 跳过 ${signal}：非串口设备（port=${port}, portType=${resolvedPortType}）`);
      return;
    }

    // 让订阅方（serial-monitor / ffs-manager 等）把"释放串口"的
    // Promise 推进 waitFor，这里等它们全部完成后再开始处理后续动作。
    const waitFor: Promise<void>[] = [];
    this.uiService.sendToolSignal(signal, { port, portType: resolvedPortType, waitFor });
    console.log(`[Uploader] ${signal} 发出，收到 ${waitFor.length} 个 waitFor Promise（port=${port}）`);
    if (waitFor.length > 0) {
      try {
        await Promise.all(waitFor);
        console.log(`[Uploader] ${signal} 所有订阅方已完成释放`);
      } catch (err) {
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
    const uploadPort = this.serialService.currentPort;
    const uploadPortType = this.serialService.currentPortInfo?.type;
    try {
      await this.sendSerialMonitorUploadSignal('serial-monitor:disconnect', uploadPort, uploadPortType);
      const timeout = uploadPortType === 'ble' ? 900000 : 300000;
      const feedback = await this.actionService.dispatchWithFeedback('upload-begin', {}, timeout).toPromise();

      const uploadResult = feedback?.data?.result;
      const uploadSuccess = feedback?.success !== false
        && feedback?.data?.success !== false
        && !!uploadResult
        && uploadResult?.state !== 'error';

      if (!uploadSuccess) {
        const error: any = new Error(uploadResult?.text || feedback?.error || '上传失败');
        error.state = uploadResult?.state || 'error';
        error.text = uploadResult?.text || feedback?.error || '上传失败';
        error.result = uploadResult;
        throw error;
      }

      if (!this.electronService.isWindowFocused()) {
        this.electronService.notify('上传', uploadResult?.text || '');
      }
      return uploadResult;
    } catch (error: any) {
      if (!this.electronService.isWindowFocused()) {
        this.electronService.notify('上传', error?.text || error?.message || '上传失败');
      }
      throw error;
    } finally {
      await this.sendSerialMonitorUploadSignal('serial-monitor:connect', uploadPort, uploadPortType);
    }
  }

  /**
  * 取消当前编译过程
  */
  cancel() {
    this.actionService.dispatch('upload-cancel', {}, result => {
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
    try {
      await this.sendSerialMonitorUploadSignal('serial-monitor:disconnect', uploadPort, uploadPortType);
      const result = await this.actionService.dispatchWithFeedback('flash-softdevice', {
        softdeviceName,
        serialPort
      }, 300000).toPromise();
      
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
      await this.sendSerialMonitorUploadSignal('serial-monitor:connect', uploadPort, uploadPortType);
    }
  }
}

