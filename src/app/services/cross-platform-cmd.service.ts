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
      return await this.cmdService.runAsync(`Copy-Item -Path "${source}" -Destination "${destination}" ${recursiveFlag} ${forceFlag}`);
    } else {
      const recursiveFlag = recursive ? '-r' : '';
      const forceFlag = force ? '-f' : '';
      const escapedSource = this.escapePath(source);
      const escapedDestination = this.escapePath(destination);
      return await this.cmdService.runAsync(`cp ${recursiveFlag} ${forceFlag} ${escapedSource} ${escapedDestination}`);
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

