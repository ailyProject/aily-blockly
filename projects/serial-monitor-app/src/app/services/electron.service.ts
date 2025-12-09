import { Injectable } from '@angular/core';

/**
 * Electron 服务 - 子应用适配版本
 */
@Injectable({
  providedIn: 'root'
})
export class ElectronService {
  isElectron = false;
  
  constructor() {
    this.isElectron = !!(window as any).electronAPI;
  }
}
