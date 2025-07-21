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
        console.log('load ' + key);
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

}
