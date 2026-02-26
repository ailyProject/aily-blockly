import { Injectable } from '@angular/core';
import { ActionService } from './action.service';
import { ElectronService } from './electron.service';
import { UiService } from './ui.service';

@Injectable({
  providedIn: 'root'
})
export class UploaderService {

  constructor(
    private actionService: ActionService,
    private electronService: ElectronService,
    private uiService: UiService
  ) { }

  async upload() {
    try {
      this.uiService.sendToolSignal('serial-monitor:disconnect');
      const result = await this.actionService.dispatchWithFeedback('upload-begin', {}, 300000).toPromise();
      if (!this.electronService.isWindowFocused()) {
        this.electronService.notify('上传', result.data?.result?.text || '');
      }
      this.uiService.sendToolSignal('serial-monitor:connect');
      return result.data?.result;
    } catch (error) {
      if (!this.electronService.isWindowFocused()) {
        this.electronService.notify('上传', '上传失败');
      }
      this.uiService.sendToolSignal('serial-monitor:connect');
      throw error;
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
    try {
      this.uiService.sendToolSignal('serial-monitor:disconnect');
      const result = await this.actionService.dispatchWithFeedback('flash-softdevice', {
        softdeviceName,
        serialPort
      }, 300000).toPromise();
      
      if (!this.electronService.isWindowFocused()) {
        const message = result.data?.result?.success ? 'SoftDevice 烧录成功' : 'SoftDevice 烧录失败';
        this.electronService.notify('烧录', message);
      }
      this.uiService.sendToolSignal('serial-monitor:connect');
      return result.data?.result || { success: false, message: '烧录失败' };
    } catch (error: any) {
      if (!this.electronService.isWindowFocused()) {
        this.electronService.notify('烧录', 'SoftDevice 烧录失败');
      }
      this.uiService.sendToolSignal('serial-monitor:connect');
      return { success: false, message: error.message || '烧录失败' };
    }
  }
}

