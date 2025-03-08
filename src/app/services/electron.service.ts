import { Injectable } from '@angular/core';

@Injectable({
  providedIn: 'root',
})
export class ElectronService {
  isElectron = false;

  electron = window['electronAPI'];

  // ipcRenderer: typeof ipcRenderer;

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
}
