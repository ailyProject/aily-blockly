import { Injectable } from '@angular/core';
import { UAParser } from 'ua-parser-js';

@Injectable({
  providedIn: 'root'
})
export class PlatformService {
  private parser: UAParser;
  private _platformSeparator: string | null = null;

  constructor() {
    this.parser = new UAParser();
  }

  get za7() {
    return this.isWindows() ? '7za.exe' : '7zz';
  }
  
  // 异步获取 7za 完整路径（优先使用环境变量）
  async getZa7Path(): Promise<string> {
    try {
      if ((window as any)?.electronAPI?.env) {
        const envPath = await (window as any).electronAPI.env.get('AILY_7ZA_PATH');
        if (envPath) {
          console.log('从环境变量获取 7za 路径:', envPath);
          return envPath;
        } else {
          console.warn('环境变量 AILY_7ZA_PATH 为空');
        }
      } else {
        console.warn('electronAPI.env 不可用');
      }
    } catch (error) {
      console.warn('无法获取 AILY_7ZA_PATH 环境变量:', error);
    }
    
    // 如果无法获取环境变量，尝试使用相对路径构建
    // 在开发模式下，child 目录在项目根目录下
    try {
      if ((window as any)?.electronAPI?.path) {
        const electronPath = (window as any).electronAPI.path.getElectronPath();
        // electronPath 是 electron 目录，需要回到项目根目录
        const projectRoot = (window as any).electronAPI.path.dirname(electronPath);
        const childPath = (window as any).electronAPI.path.join(projectRoot, 'child');
        
        if (this.isMac()) {
          const macosPath = (window as any).electronAPI.path.join(childPath, 'macos', '7zz');
          if ((window as any).electronAPI.path.isExists(macosPath)) {
            console.log('使用构建的 Mac 路径:', macosPath);
            return macosPath;
          }
        } else if (this.isWindows()) {
          const windowsPath = (window as any).electronAPI.path.join(childPath, 'windows', '7za.exe');
          if ((window as any).electronAPI.path.isExists(windowsPath)) {
            console.log('使用构建的 Windows 路径:', windowsPath);
            return windowsPath;
          }
        }
      }
    } catch (error) {
      console.warn('构建路径失败:', error);
    }
    
    // 最后的备选：返回默认值（假设在 PATH 中）
    console.warn('使用默认 7za 路径（假设在 PATH 中）');
    return this.isWindows() ? '7za.exe' : '7zz';
  }

  /**
   * 获取平台路径分隔符
   * @returns Windows 返回 '\\'，其他平台返回 '/'
   */
  getPlatformSeparator(): string {
    if (this._platformSeparator === null) {
      // 优先使用 Electron API（如果可用）
      try {
        if ((window as any)?.electronAPI?.platform?.pt) {
          this._platformSeparator = (window as any).electronAPI.platform.pt;
          return this._platformSeparator;
        }
      } catch (error) {
        // Electron API 不可用，使用 ua-parser-js 检测
      }

      // 使用 ua-parser-js 检测操作系统
      const os = this.parser.getOS();
      this._platformSeparator = this.isWindowsOS(os.name) ? '\\' : '/';
    }
    
    return this._platformSeparator;
  }

  /**
   * 检查是否为 Windows 操作系统
   */
  isWindows(): boolean {
    const os = this.parser.getOS();
    return this.isWindowsOS(os.name);
  }

  /**
   * 检查是否为 macOS 操作系统
   */
  isMac(): boolean {
    const os = this.parser.getOS();
    return os.name?.toLowerCase().includes('mac') || false;
  }

  /**
   * 检查是否为 Linux 操作系统
   */
  isLinux(): boolean {
    const os = this.parser.getOS();
    return os.name?.toLowerCase().includes('linux') || false;
  }

  /**
   * 获取操作系统信息
   */
  getOSInfo() {
    return this.parser.getOS();
  }

  /**
   * 获取浏览器信息
   */
  getBrowserInfo() {
    return this.parser.getBrowser();
  }

  /**
   * 检查操作系统名称是否为 Windows
   * @param osName 操作系统名称
   */
  private isWindowsOS(osName?: string): boolean {
    if (!osName) return false;
    return osName.toLowerCase().includes('windows');
  }
}