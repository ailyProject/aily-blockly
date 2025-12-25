import { Injectable } from '@angular/core';
import { CmdService } from './cmd.service';
import { PlatformService } from './platform.service';

@Injectable({
  providedIn: 'root'
})
export class CrossPlatformCmdService {

  constructor(
    private cmdService: CmdService,
    private platformService: PlatformService
  ) { }

  /**
   * 转义路径中的特殊字符（用于Mac/Linux）
   * @param path 路径
   * @returns 转义后的路径
   */
  private escapePath(path: string): string {
    // 在Mac/Linux下，使用反斜杠转义空格和特殊字符
    return path.replace(/(\s|[()&|;<>`$\\])/g, '\\$1');
  }

  /**
   * 创建目录（跨平台）
   * @param path 目录路径
   * @param recursive 是否递归创建
   */
  async createDirectory(path: string, recursive: boolean = true): Promise<any> {
    if (this.platformService.isWindows()) {
      const forceFlag = recursive ? '-Force' : '';
      return await this.cmdService.runAsync(`New-Item -Path "${path}" -ItemType Directory ${forceFlag}`);
    } else {
      const recursiveFlag = recursive ? '-p' : '';
      const escapedPath = this.escapePath(path);
      return await this.cmdService.runAsync(`mkdir ${recursiveFlag} "${escapedPath}"`);
    }
  }

  /**
   * 复制文件或目录（跨平台）
   * @param source 源路径
   * @param destination 目标路径
   * @param recursive 是否递归复制
   * @param force 是否强制覆盖
   */
  async copyItem(source: string, destination: string, recursive: boolean = true, force: boolean = true): Promise<any> {
    if (this.platformService.isWindows()) {
      const recursiveFlag = recursive ? '-Recurse' : '';
      const forceFlag = force ? '-Force' : '';
      const result = await this.cmdService.runAsync(`Copy-Item -Path "${source}" -Destination "${destination}" ${recursiveFlag} ${forceFlag}`);

      // 验证复制结果
      if (result.type === 'error' || (result.code && result.code !== 0)) {
        throw new Error(`复制失败: ${result.error || result.data || '未知错误'}`);
      }

      // 验证目标路径是否存在
      if (!window['fs'].existsSync(destination)) {
        throw new Error(`复制后目标路径不存在: ${destination}`);
      }

      return result;
    } else {
      const recursiveFlag = recursive ? '-r' : '';
      const forceFlag = force ? '-f' : '';
      const escapedSource = this.escapePath(source);
      const escapedDestination = this.escapePath(destination);
      const result = await this.cmdService.runAsync(`cp ${recursiveFlag} ${forceFlag} ${escapedSource} ${escapedDestination}`);

      if (result.type === 'error' || (result.code && result.code !== 0)) {
        throw new Error(`复制失败: ${result.error || result.data || '未知错误'}`);
      }

      // 验证目标路径是否存在
      if (!window['fs'].existsSync(destination)) {
        throw new Error(`复制后目标路径不存在: ${destination}`);
      }

      return result;
    }
  }

  /**
   * 复制目录（优先使用硬链接，失败时回退到复制）
   */
  async linkItem(source: string, destination: string): Promise<any> {
    try {
      if (!window['fs'].existsSync(source)) {
        throw new Error(`Source directory does not exist: ${source}`);
      }

      // 处理源是文件的情况
      if (!window['fs'].isDirectory(source)) {
        let destPath = destination;
        // 如果目标存在且是目录，则将文件链接到该目录下
        if (window['fs'].existsSync(destination) && window['fs'].statSync(destination).isDirectory()) {
          destPath = window['path'].join(destination, window['path'].basename(source));
        }

        if (window['fs'].existsSync(destPath)) {
          window['fs'].unlinkSync(destPath, null);
        }

        try {
          window['fs'].linkSync(source, destPath);
        } catch (linkError: any) {
          // 如果是跨设备错误(EXDEV)或权限错误，回退到复制
          const errorMsg = linkError.message || String(linkError);
          const isExdevError = linkError.code === 'EXDEV' || linkError.code === 'EPERM' || errorMsg.includes('EXDEV') || errorMsg.includes('cross-device');
          if (isExdevError) {
            console.log(`[单文件]硬链接失败，使用复制: ${source} -> ${destPath}`);
            const content = window['fs'].readFileSync(source);
            window['fs'].writeFileSync(destPath, content);
          } else {
            console.error(`[单文件]硬链接失败(未知错误):`, linkError);
            throw linkError;
          }
        }
        return true;
      }

      if (!window['fs'].existsSync(destination)) {
        window['fs'].mkdirSync(destination);
      }

      const items = window['fs'].readDirSync(source, { withFileTypes: true });

      for (const item of items) {
        const srcPath = window['path'].join(source, item.name);
        const destPath = window['path'].join(destination, item.name);

        if (window['fs'].isDirectory(srcPath)) {
          await this.linkItem(srcPath, destPath);
        } else {
          if (window['fs'].existsSync(destPath)) {
            window['fs'].unlinkSync(destPath, null);
          }

          try {
            window['fs'].linkSync(srcPath, destPath);
          } catch (linkError: any) {
            // 如果是跨设备错误(EXDEV)或权限错误，回退到复制
            const errorMsg = linkError.message || String(linkError);
            const isExdevError = linkError.code === 'EXDEV' || linkError.code === 'EPERM' || errorMsg.includes('EXDEV') || errorMsg.includes('cross-device');
            if (isExdevError) {
              console.log(`[目录文件]硬链接失败，使用复制: ${srcPath} -> ${destPath}`);
              const content = window['fs'].readFileSync(srcPath);
              window['fs'].writeFileSync(destPath, content);
            } else {
              console.error(`[目录文件]硬链接失败(未知错误):`, linkError);
              throw linkError;
            }
          }
        }
      }
      return true;
    } catch (error: any) {
      console.error('linkItem外层捕获错误:', error.message, 'code:', error.code);
      // 如果是EXDEV错误但没有被上面捕获，说明是目录级别的问题，使用copySync回退
      const errorMsg = error.message || String(error);
      const isExdevError = error.code === 'EXDEV' || errorMsg.includes('EXDEV') || errorMsg.includes('cross-device');
      if (isExdevError) {
        console.warn('外层EXDEV错误，使用copySync:', source, '->', destination);
        window['fs'].copySync(source, destination);
        return true;
      }
      console.error('linkDirectory error:', error);
      throw error;
    }
  }

  /**
   * 删除文件或目录（直接调用node的api)
   */
  async deleteItem(path: string): Promise<any> {
    try {
      if (window['fs'].existsSync(path)) {
        if (window['fs'].isDirectory(path)) {
          window['fs'].rmdirSync(path, { recursive: true, force: true });
        } else {
          window['fs'].unlinkSync(path);
        }
      }
      return true;
    } catch (error) {
      console.error('unlinkDirectory error:', error);
      throw error;
    }
  }


  /**
   * 删除文件或目录（跨平台）
   * @param path 路径
   * @param recursive 是否递归删除
   * @param force 是否强制删除
   */
  async removeItem(path: string, recursive: boolean = true, force: boolean = true): Promise<any> {
    if (this.platformService.isWindows()) {
      const recursiveFlag = recursive ? '-Recurse' : '';
      const forceFlag = force ? '-Force' : '';
      return await this.cmdService.runAsync(`Remove-Item -Path "${path}" ${recursiveFlag} ${forceFlag}`);
    } else {
      const recursiveFlag = recursive ? '-r' : '';
      const forceFlag = force ? '-f' : '';
      const escapedPath = this.escapePath(path);
      return await this.cmdService.runAsync(`rm ${recursiveFlag} ${forceFlag} ${escapedPath}`);
    }
  }

  /**
   * 移动文件或目录（跨平台）
   * @param source 源路径
   * @param destination 目标路径
   * @param force 是否强制覆盖
   */
  async moveItem(source: string, destination: string, force: boolean = true): Promise<any> {
    if (this.platformService.isWindows()) {
      const forceFlag = force ? '-Force' : '';
      return await this.cmdService.runAsync(`Move-Item -Path "${source}" -Destination "${destination}" ${forceFlag}`);
    } else {
      const forceFlag = force ? '-f' : '';
      const escapedSource = this.escapePath(source);
      const escapedDestination = this.escapePath(destination);
      return await this.cmdService.runAsync(`mv ${forceFlag} ${escapedSource} ${escapedDestination}`);
    }
  }

  /**
   * 检查文件或目录是否存在（跨平台）
   * @param path 路径
   */
  async testPath(path: string): Promise<any> {
    if (this.platformService.isWindows()) {
      return await this.cmdService.runAsync(`Test-Path "${path}"`);
    } else {
      const escapedPath = this.escapePath(path);
      return await this.cmdService.runAsync(`test -e ${escapedPath}`);
    }
  }

  /**
   * 获取文件列表（跨平台）
   * @param path 目录路径
   * @param recursive 是否递归
   */
  async getChildItems(path: string, recursive: boolean = false): Promise<any> {
    if (this.platformService.isWindows()) {
      const recursiveFlag = recursive ? '-Recurse' : '';
      return await this.cmdService.runAsync(`Get-ChildItem -Path "${path}" ${recursiveFlag}`);
    } else {
      const recursiveFlag = recursive ? '-R' : '';
      const escapedPath = this.escapePath(path);
      return await this.cmdService.runAsync(`ls ${recursiveFlag} ${escapedPath}`);
    }
  }
}

