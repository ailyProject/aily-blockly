import { Injectable } from '@angular/core';

@Injectable({
  providedIn: 'root',
})
export class ElectronService {
  isElectron = false;
  electron: any = window['electronAPI'];

  constructor() { }

  async init() {
    if (this.electron && typeof this.electron.versions() == 'object') {
      console.log('Running in electron', this.electron.versions());
      this.isElectron = true;
      // 在这里把 相关nodejs内容 挂载到 window 上
      // 调用前先判断isElectron
      for (let key in this.electron) {
        // console.log('load ' + key);
        window[key] = this.electron[key];
      }
    } else {
      console.log('Running in browser');
    }
  }

  /**
  * 读取文件内容
  */
  readFile(filePath: string) {
    return window['fs'].readFileSync(filePath, 'utf8');
  }

  /**
   * 读取目录内容
   */
  readDir(dirPath: string) {
    return window['fs'].readDirSync(dirPath);
  }

  /**
   * 写文件
   */
  writeFile(filePath: string, content: string) {
    window['fs'].writeFileSync(filePath, content);
  }

  /**
 * 判断路径是否存在
 */
  exists(path: string): boolean {
    return window['fs'].existsSync(path)
  }

  /**
   * 判断是否为目录
   */
  isDirectory(path: string) {
    return window['fs'].isDirectory(path);
  }

  isFile(path: string) {
    return window['fs'].isFile(path);
  }

  // 调用浏览器打开url
  openUrl(url) {
    window['other'].openByBrowser(url);
  }

  // 改变窗口title
  setTitle(title: string) {
    document.title = title;
  }

  // 打开一个新的实例窗口
  openNewInStance(route, queryParams = null) {
    let target = {
      route
    }
    if (queryParams) {
      target['queryParams'] = queryParams
    }
    window['ipcRenderer'].invoke('open-new-instance', target);
    // 基本用法 - 只传递路由
    // await window.electronAPI.ipcRenderer.invoke('open-new-instance', {
    //   route: 'main/blockly-editor'
    // });

    // // 高级用法 - 传递路由和查询参数
    // await window.electronAPI.ipcRenderer.invoke('open-new-instance', {
    //   route: 'main/blockly-editor',
    //   queryParams: {
    //     path: '/path/to/project',
    //     mode: 'edit',
    //     theme: 'dark'
    //   }
    // });

    // // 处理返回结果
    // const result = await window.electronAPI.ipcRenderer.invoke('open-new-instance', {
    //   route: 'main/settings',
    //   queryParams: { tab: 'general' }
    // });

    // if (result.success) {
    //   console.log('新实例已启动，PID:', result.pid);
    // } else {
    //   console.error('启动失败:', result.error);
    // }
  }

  /**
   * 显示系统通知
   * @param title 通知标题
   * @param body 通知内容
   * @param options 可选配置
   * @returns Promise<{success: boolean, result?: any, error?: string}>
   */
  async notify(title: string, body: string, options?: {
    icon?: string;
    silent?: boolean;
    timeoutType?: 'default' | 'never';
    urgency?: 'normal' | 'critical' | 'low';
  }) {
    if (!this.isElectron) {
      console.warn('Not in Electron environment, notification not supported');
      return { success: false, error: 'Not in Electron environment' };
    }

    try {
      const notificationOptions = {
        title,
        body,
        ...options
      };

      const result = await window['notification'].show(notificationOptions);
      return result;
    } catch (error) {
      console.error('Show notification error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 检查是否支持通知
   * @returns Promise<boolean>
   */
  async isNotificationSupported(): Promise<boolean> {
    if (!this.isElectron) {
      return false;
    }

    try {
      return await window['notification'].isSupported();
    } catch (error) {
      console.error('Check notification support error:', error);
      return false;
    }
  }

  /**
   * 检查当前窗口是否为活动窗口（是否获得焦点）
   * @returns boolean
   */
  isWindowFocused(): boolean {
    if (!this.isElectron) {
      // 在浏览器环境中使用 document.hasFocus()
      return document.hasFocus();
    }

    try {
      return window['iWindow'].isFocused();
    } catch (error) {
      console.error('Check window focus error:', error);
      return false;
    }
  }

  /**
   * 监听窗口获得焦点事件
   * @param callback 回调函数
   * @returns 取消监听的函数
   */
  onWindowFocus(callback: () => void): () => void {
    if (!this.isElectron) {
      // 在浏览器环境中使用原生事件
      const handler = () => callback();
      window.addEventListener('focus', handler);
      return () => window.removeEventListener('focus', handler);
    }

    try {
      return window['iWindow'].onFocus(callback);
    } catch (error) {
      console.error('Listen window focus error:', error);
      return () => {};
    }
  }

  /**
   * 监听窗口失去焦点事件
   * @param callback 回调函数
   * @returns 取消监听的函数
   */
  onWindowBlur(callback: () => void): () => void {
    if (!this.isElectron) {
      // 在浏览器环境中使用原生事件
      const handler = () => callback();
      window.addEventListener('blur', handler);
      return () => window.removeEventListener('blur', handler);
    }

    try {
      return window['iWindow'].onBlur(callback);
    } catch (error) {
      console.error('Listen window blur error:', error);
      return () => {};
    }
  }

}
