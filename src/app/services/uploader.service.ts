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
    const isSerialMonitorOpen = this.uiService.isToolOpen('serial-monitor');
    try {
      if (isSerialMonitorOpen) {
        this.uiService.closeTool('serial-monitor');
      }
      const result = await this.actionService.dispatchWithFeedback('upload-begin', {}, 300000).toPromise();
      if (!this.electronService.isWindowFocused()) {
        this.electronService.notify('上传', result.data?.result?.text || '');
      }
      if (isSerialMonitorOpen) this.uiService.openTool('serial-monitor');
      return result.data?.result;
    } catch (error) {
      if (!this.electronService.isWindowFocused()) {
        this.electronService.notify('上传', '上传失败');
      }
      if (isSerialMonitorOpen) this.uiService.openTool('serial-monitor');
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
}

