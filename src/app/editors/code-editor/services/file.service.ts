import { Injectable } from '@angular/core';
import { NzTreeNodeOptions } from 'ng-zorro-antd/tree';
import { NzMessageService } from 'ng-zorro-antd/message';
import { NzModalService } from 'ng-zorro-antd/modal';
import { DeleteDialogComponent } from '../components/delete-dialog/delete-dialog.component';

// 文件节点接口
interface FileNode {
  title: string;
  key: string;
  isLeaf: boolean;
  path: string;
  children?: FileNode[];
}

@Injectable({
  providedIn: 'root'
})
export class FileService {

  currentPath;

  // 剪贴板状态管理
  private clipboard: {
    nodes: FileNode[],
    operation: 'copy' | 'cut' | null
  } = { nodes: [], operation: null };

  constructor(
    private message: NzMessageService,
    private modal: NzModalService
  ) { }


  readDir(path: string): NzTreeNodeOptions[] {
    let entries = window['fs'].readDirSync(path);
    let result = [];
    let dirs = [];
    let files = [];
    for (const entry of entries) {
      let path = entry.path + '\\' + entry.name;
      let isDir = window['path'].isDir(path)
      let item: NzTreeNodeOptions = {
        title: entry.name,
        key: path,
        path,
        isLeaf: !isDir,
        expanded: false,
        selectable: true
      }
      if (isDir) {
        dirs.push(item);
      } else {
        files.push(item);
      }
    }
    result = dirs.concat(files);
    return result;
  }

  readFile(path: string): string {
    this.currentPath = path;
    // 读取文件内容
    return '';
  }

  // ==================== 剪贴板操作 ====================

  /**
   * 复制文件/文件夹到剪贴板
   */
  copyToClipboard(nodes: FileNode[]): void {
    console.log('Copy to clipboard:', nodes.map(n => n.path));
    this.clipboard = {
      nodes: [...nodes],
      operation: 'copy'
    };

    // 使用系统剪贴板API复制路径
    try {
      const paths = nodes.map(n => n.path).join('\n');
      navigator.clipboard.writeText(paths).then(() => {
        this.message.success(`已复制 ${nodes.length} 个项目到剪贴板`);
      }).catch(() => {
        // 降级方案：如果clipboard API不可用，只保存到内部剪贴板
        this.message.success(`已复制 ${nodes.length} 个项目（内部剪贴板）`);
      });
    } catch (error) {
      console.error('复制到剪贴板失败:', error);
      this.message.success(`已复制 ${nodes.length} 个项目（内部剪贴板）`);
    }
  }

  /**
   * 剪切文件/文件夹到剪贴板
   */
  cutToClipboard(nodes: FileNode[]): void {
    console.log('Cut to clipboard:', nodes.map(n => n.path));
    this.clipboard = {
      nodes: [...nodes],
      operation: 'cut'
    };

    // 使用系统剪贴板API复制路径
    try {
      const paths = nodes.map(n => n.path).join('\n');
      navigator.clipboard.writeText(paths).then(() => {
        this.message.success(`已剪切 ${nodes.length} 个项目到剪贴板`);
      }).catch(() => {
        // 降级方案：如果clipboard API不可用，只保存到内部剪贴板
        this.message.success(`已剪切 ${nodes.length} 个项目（内部剪贴板）`);
      });
    } catch (error) {
      console.error('剪切到剪贴板失败:', error);
      this.message.success(`已剪切 ${nodes.length} 个项目（内部剪贴板）`);
    }
  }

  /**
   * 从剪贴板粘贴文件/文件夹
   */
  async pasteFromClipboard(targetNode: FileNode): Promise<{ success: boolean, newFiles?: Array<{ name: string, isLeaf: boolean, path: string }> }> {
    console.log('Paste to:', targetNode.path);

    if (this.clipboard.nodes.length === 0 || !this.clipboard.operation) {
      this.message.warning('剪贴板为空');
      return { success: false };
    }

    // 确保目标是文件夹
    let targetPath = targetNode.path;
    if (targetNode.isLeaf) {
      // 如果是文件，使用其父目录
      targetPath = window['path'].dirname(targetPath);
    }

    const newFiles: Array<{ name: string, isLeaf: boolean, path: string }> = [];

    try {
      const promises = this.clipboard.nodes.map(async (sourceNode) => {
        const sourcePath = sourceNode.path;
        const originalFileName = window['path'].basename(sourcePath);
        let destinationPath: string;
        let finalFileName: string;

        if (this.clipboard.operation === 'copy') {
          // 复制操作：生成唯一文件名
          finalFileName = this.generateUniqueFileName(targetPath, originalFileName, !sourceNode.isLeaf);
          destinationPath = window['path'].join(targetPath, finalFileName);
        } else {
          // 移动操作：检查是否存在同名文件/文件夹
          finalFileName = originalFileName;
          destinationPath = window['path'].join(targetPath, finalFileName);
          if (window['fs'].existsSync(destinationPath)) {
            throw new Error(`目标位置已存在同名项目: ${originalFileName}`);
          }
        }

        if (this.clipboard.operation === 'copy') {
          // 复制操作
          if (sourceNode.isLeaf) {
            // 复制文件
            const content = window['fs'].readFileSync(sourcePath);
            window['fs'].writeFileSync(destinationPath, content);
          } else {
            // 复制文件夹
            window['fs'].copySync(sourcePath, destinationPath);
          }
        } else if (this.clipboard.operation === 'cut') {
          // 移动操作
          window['fs'].renameSync(sourcePath, destinationPath);
        }

        // 记录新创建的文件/文件夹信息
        newFiles.push({
          name: finalFileName,
          isLeaf: sourceNode.isLeaf,
          path: destinationPath
        });
      });

      await Promise.all(promises);

      // 成功后清空剪贴板（如果是剪切操作）
      if (this.clipboard.operation === 'cut') {
        this.clipboard = { nodes: [], operation: null };
      }

      this.message.success(`成功${this.clipboard.operation === 'copy' ? '复制' : '移动'} ${this.clipboard.nodes.length} 个项目`);
      return { success: true, newFiles };

    } catch (error) {
      console.error('粘贴操作失败:', error);
      this.message.error(`粘贴失败: ${error.message}`);
      return { success: false };
    }
  }

  /**
   * 获取剪贴板状态
   */
  getClipboardStatus() {
    return { ...this.clipboard };
  }

  /**
   * 清空剪贴板
   */
  clearClipboard(): void {
    this.clipboard = { nodes: [], operation: null };
  }

  // ==================== 文件系统操作 ====================

  /**
   * 生成唯一的文件名/文件夹名，如果存在同名则添加 -copy 后缀
   */
  private generateUniqueFileName(targetDir: string, originalName: string, isFolder: boolean = false): string {
    if (isFolder) {
      // 文件夹处理
      let newName = originalName;
      let newPath = window['path'].join(targetDir, newName);

      // 如果原文件夹名不存在冲突，直接返回
      if (!window['fs'].existsSync(newPath)) {
        return newName;
      }

      // 尝试 foldername-copy
      newName = `${originalName}-copy`;
      newPath = window['path'].join(targetDir, newName);

      if (!window['fs'].existsSync(newPath)) {
        return newName;
      }

      // 如果 foldername-copy 也存在，则尝试 foldername-copy1, foldername-copy2...
      let counter = 1;
      do {
        newName = `${originalName}-copy${counter}`;
        newPath = window['path'].join(targetDir, newName);
        counter++;
      } while (window['fs'].existsSync(newPath));

      return newName;
    } else {
      // 文件处理
      const ext = window['path'].extname(originalName);
      const nameWithoutExt = window['path'].basename(originalName, ext);

      let newName = originalName;
      let newPath = window['path'].join(targetDir, newName);

      // 如果原文件名不存在冲突，直接返回
      if (!window['fs'].existsSync(newPath)) {
        return newName;
      }

      // 尝试 filename-copy.ext
      newName = `${nameWithoutExt}-copy${ext}`;
      newPath = window['path'].join(targetDir, newName);

      if (!window['fs'].existsSync(newPath)) {
        return newName;
      }

      // 如果 filename-copy.ext 也存在，则尝试 filename-copy1.ext, filename-copy2.ext...
      let counter = 1;
      do {
        newName = `${nameWithoutExt}-copy${counter}${ext}`;
        newPath = window['path'].join(targetDir, newName);
        counter++;
      } while (window['fs'].existsSync(newPath));

      return newName;
    }
  }

  /**
   * 删除文件/文件夹
   */
  deleteNodes(nodes: FileNode[], onSuccess?: (deletedPaths: string[]) => void): void {
    console.log('Delete:', nodes.map(n => n.path));

    const fileCount = nodes.filter(n => n.isLeaf).length;
    const folderCount = nodes.filter(n => !n.isLeaf).length;

    let message = '确定要删除以下项目吗？\n\n';
    if (fileCount > 0) {
      message += `${fileCount} 个文件\n`;
    }
    if (folderCount > 0) {
      message += `${folderCount} 个文件夹\n`;
    }
    
    // 检查是否支持回收站
    const trashAvailable = window['other'] && window['other'].moveToTrash;
    if (trashAvailable) {
      message += '\n文件将被移动到回收站，可以从回收站恢复。';
    } else {
      message += '\n此操作将永久删除文件，不可撤销！';
    }

    const modalRef = this.modal.create({
      nzTitle: null,
      nzFooter: null,
      nzClosable: false,
      nzBodyStyle: {
        padding: '0',
      },
      nzWidth: '380px',
      nzContent: DeleteDialogComponent,
      nzData: {
        title: '确认删除',
        text: message,
        nodes: nodes
      }
    });

    modalRef.afterClose.subscribe(async (result: string) => {
      if (result === 'confirm') {
        await this.performDelete(nodes, onSuccess);
      }
    });
  }

  /**
   * 执行实际的删除操作（移动到回收站）
   */
  private async performDelete(nodes: FileNode[], onSuccess?: (deletedPaths: string[]) => void): Promise<void> {
    const deletedPaths: string[] = [];
    const failedPaths: string[] = [];

    try {
      for (const node of nodes) {
        console.log('Moving to trash:', node.path, 'isLeaf:', node.isLeaf);

        try {
          // 尝试使用 Electron 的回收站 API
          if (window['other'] && window['other'].moveToTrash) {
            const result = await window['other'].moveToTrash(node.path);
            if (result.success) {
              console.log('Successfully moved to trash:', node.path);
              deletedPaths.push(node.path);
            } else {
              console.error('Failed to move to trash:', node.path, result.error);
              failedPaths.push(node.path);
            }
          } else {
            // 降级方案：永久删除（如果回收站 API 不可用）
            console.warn('Trash API not available, falling back to permanent deletion');
            if (node.isLeaf) {
              // 删除文件
              window['fs'].unlinkSync(node.path);
              console.log('File deleted permanently:', node.path);
            } else {
              // 删除文件夹 - 需要递归删除
              this.deleteFolderRecursive(node.path);
              console.log('Folder deleted permanently:', node.path);
            }
            deletedPaths.push(node.path);
          }
        } catch (error) {
          console.error('Failed to delete node:', node.path, error);
          failedPaths.push(node.path);
        }
      }

      console.log('Delete operation completed. Deleted:', deletedPaths, 'Failed:', failedPaths);

      if (deletedPaths.length > 0) {
        const trashAvailable = window['other'] && window['other'].moveToTrash;
        const actionText = trashAvailable ? '移动到回收站' : '永久删除';
        this.message.success(`成功${actionText} ${deletedPaths.length} 个项目${failedPaths.length > 0 ? `，${failedPaths.length} 个项目失败` : ''}`);

        // 清空剪贴板中被删除的项目
        if (this.clipboard.nodes.length > 0) {
          const deletedPathsSet = new Set(deletedPaths);
          this.clipboard.nodes = this.clipboard.nodes.filter(n => !deletedPathsSet.has(n.path));
          if (this.clipboard.nodes.length === 0) {
            this.clipboard.operation = null;
          }
        }

        // 调用成功回调，只传递成功删除的路径列表
        if (onSuccess) {
          console.log('Calling onSuccess callback with successfully deleted paths:', deletedPaths);
          onSuccess(deletedPaths);
        }
      } else {
        this.message.error('所有文件删除失败');
      }

      if (failedPaths.length > 0) {
        console.error('Failed to delete paths:', failedPaths);
      }

    } catch (error) {
      console.error('删除操作出现异常:', error);
      this.message.error(`删除失败: ${error.message}`);
    }
  }

  // ==================== 文件创建操作 ====================

  /**
   * 验证文件/文件夹名称是否有效
   */
  validateFileName(name: string): { valid: boolean, error?: string } {
    if (!name || !name.trim()) {
      return { valid: false, error: '名称不能为空' };
    }

    // 检查是否包含非法字符
    const invalidChars = /[<>:"/\\|?*]/;
    if (invalidChars.test(name)) {
      return { valid: false, error: '名称包含非法字符: < > : " / \\ | ? *' };
    }

    // 检查是否为保留名称（Windows）
    const reservedNames = ['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9', 'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'];
    if (reservedNames.includes(name.toUpperCase())) {
      return { valid: false, error: '不能使用系统保留名称' };
    }

    return { valid: true };
  }

  /**
   * 创建文件（内联编辑版本）
   */
  createFileInline(parentPath: string, fileName: string): { success: boolean, error?: string, filePath?: string } {
    try {
      const validation = this.validateFileName(fileName);
      if (!validation.valid) {
        return { success: false, error: validation.error };
      }

      const filePath = window['path'].join(parentPath, fileName);

      // 检查文件是否已存在
      if (window['fs'].existsSync(filePath)) {
        return { success: false, error: '文件已存在' };
      }

      // 创建空文件
      window['fs'].writeFileSync(filePath, '');
      return { success: true, filePath };
    } catch (error) {
      return { success: false, error: `创建文件失败: ${error.message}` };
    }
  }

  /**
   * 创建文件夹（内联编辑版本）
   */
  createFolderInline(parentPath: string, folderName: string): { success: boolean, error?: string, folderPath?: string } {
    try {
      const validation = this.validateFileName(folderName);
      if (!validation.valid) {
        return { success: false, error: validation.error };
      }

      const folderPath = window['path'].join(parentPath, folderName);

      // 检查文件夹是否已存在
      if (window['fs'].existsSync(folderPath)) {
        return { success: false, error: '文件夹已存在' };
      }

      // 创建文件夹
      window['fs'].mkdirSync(folderPath);
      return { success: true, folderPath };
    } catch (error) {
      return { success: false, error: `创建文件夹失败: ${error.message}` };
    }
  }

  /**
   * 重命名文件/文件夹（内联编辑版本）
   */
  renameNodeInline(oldPath: string, newName: string): { success: boolean, error?: string, newPath?: string } {
    try {
      const validation = this.validateFileName(newName);
      if (!validation.valid) {
        return { success: false, error: validation.error };
      }

      const parentDir = window['path'].dirname(oldPath);
      const newPath = window['path'].join(parentDir, newName);

      // 检查新名称是否已存在
      if (window['fs'].existsSync(newPath)) {
        return { success: false, error: '该名称已存在' };
      }

      // 执行重命名
      window['fs'].renameSync(oldPath, newPath);
      return { success: true, newPath };
    } catch (error) {
      return { success: false, error: `重命名失败: ${error.message}` };
    }
  }

  // ==================== 路径操作 ====================

  /**
   * 复制路径到剪贴板
   */
  copyPathToClipboard(node: FileNode, relative: boolean, rootPath?: string): void {
    const path = relative ? this.getRelativePath(node.path, rootPath) : node.path;
    console.log('Copy path to clipboard:', path);

    try {
      navigator.clipboard.writeText(path).then(() => {
        this.message.success(`已复制${relative ? '相对' : '绝对'}路径到剪贴板`);
      }).catch(() => {
        // 降级方案：创建一个临时的文本域来复制文本
        const textarea = document.createElement('textarea');
        textarea.value = path;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
        this.message.success(`已复制${relative ? '相对' : '绝对'}路径到剪贴板`);
      });
    } catch (error) {
      console.error('复制路径失败:', error);
      this.message.error('复制路径失败');
    }
  }

  /**
   * 计算相对路径
   */
  getRelativePath(absolutePath: string, rootPath?: string): string {
    if (!rootPath || !absolutePath) {
      return absolutePath;
    }

    // 标准化路径，确保使用一致的分隔符
    const normalizedRoot = window['path'].normalize(rootPath);
    const normalizedPath = window['path'].normalize(absolutePath);

    // 检查路径是否在根目录下
    if (!normalizedPath.startsWith(normalizedRoot)) {
      return absolutePath; // 如果不在根目录下，返回绝对路径
    }

    // 计算相对路径
    let relativePath = normalizedPath.substring(normalizedRoot.length);

    // 移除开头的路径分隔符
    relativePath = relativePath.replace(/^[\\\/]+/, '');

    return relativePath || '.'; // 如果为空，返回当前目录
  }

  // ==================== 系统集成操作 ====================

  /**
   * 在资源管理器中显示
   */
  revealInExplorer(node: FileNode): void {
    console.log('Reveal in explorer:', node.path);

    try {
      // 使用Electron API打开文件资源管理器
      if (window['other'] && window['other'].openByExplorer) {
        window['other'].openByExplorer(node.path);
        this.message.success('已在资源管理器中打开');
      } else {
        // 降级方案：尝试使用shell命令
        const platform = window['platform']?.type || 'win32';
        let command = '';

        if (platform === 'win32') {
          // Windows
          if (node.isLeaf) {
            // 如果是文件，选中该文件
            command = `explorer.exe /select,"${node.path}"`;
          } else {
            // 如果是文件夹，打开该文件夹
            command = `explorer.exe "${node.path}"`;
          }
        } else if (platform === 'darwin') {
          // macOS
          if (node.isLeaf) {
            command = `open -R "${node.path}"`;
          } else {
            command = `open "${node.path}"`;
          }
        } else {
          // Linux
          const dir = node.isLeaf ? window['path'].dirname(node.path) : node.path;
          command = `xdg-open "${dir}"`;
        }

        if (command && window['cmd'] && window['cmd'].run) {
          window['cmd'].run({ command });
          this.message.success('已尝试在资源管理器中打开');
        } else {
          this.message.warning('当前环境不支持此功能');
        }
      }
    } catch (error) {
      console.error('在资源管理器中打开失败:', error);
      this.message.error('在资源管理器中打开失败');
    }
  }

  /**
   * 在终端中打开
   */
  openInTerminal(node: FileNode): void {
    console.log('Open in terminal:', node.path);

    // 确定要在终端中打开的目录
    let targetPath = node.path;
    if (node.isLeaf) {
      // 如果是文件，使用其父目录
      targetPath = window['path'].dirname(targetPath);
    }

    try {
      // 尝试使用Electron的终端API
      if (window['terminal'] && window['terminal'].init) {
        const terminalOptions = {
          cwd: targetPath,
          shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/bash'
        };

        window['terminal'].init(terminalOptions).then(() => {
          this.message.success('已在终端中打开');
        }).catch((error) => {
          console.error('终端打开失败:', error);
          this.openTerminalFallback(targetPath);
        });
      } else {
        this.openTerminalFallback(targetPath);
      }
    } catch (error) {
      console.error('在终端中打开失败:', error);
      this.openTerminalFallback(targetPath);
    }
  }

  private openTerminalFallback(targetPath: string): void {
    try {
      // 降级方案：使用系统命令打开终端
      const platform = window['platform']?.type || 'win32';
      let command = '';

      if (platform === 'win32') {
        // Windows - 打开命令提示符
        command = `start cmd /k "cd /d \\"${targetPath}\\""`;
      } else if (platform === 'darwin') {
        // macOS - 打开Terminal.app
        command = `osascript -e 'tell application "Terminal" to do script "cd \\"${targetPath}\\""'`;
      } else {
        // Linux - 尝试打开各种终端
        const terminals = ['gnome-terminal', 'konsole', 'xterm', 'terminator'];
        for (const term of terminals) {
          try {
            if (term === 'gnome-terminal') {
              command = `${term} --working-directory="${targetPath}"`;
            } else if (term === 'konsole') {
              command = `${term} --workdir "${targetPath}"`;
            } else {
              command = `cd "${targetPath}" && ${term}`;
            }
            break;
          } catch (e) {
            continue;
          }
        }
      }

      if (command && window['cmd'] && window['cmd'].run) {
        window['cmd'].run({ command });
        this.message.success('已尝试在终端中打开');
      } else {
        this.message.warning('当前环境不支持此功能');
      }
    } catch (error) {
      console.error('终端打开降级方案失败:', error);
      this.message.error('在终端中打开失败');
    }
  }

  /**
   * 递归删除文件夹
   */
  private deleteFolderRecursive(folderPath: string): void {
    console.log('Recursively deleting folder:', folderPath);

    if (!window['fs'].existsSync(folderPath)) {
      console.log('Folder does not exist:', folderPath);
      return;
    }

    const stats = window['fs'].statSync(folderPath);
    if (!stats.isDirectory()) {
      // 如果不是文件夹，直接删除文件
      window['fs'].unlinkSync(folderPath);
      return;
    }

    // 读取文件夹内容
    const entries = window['fs'].readDirSync(folderPath);

    for (const entry of entries) {
      const fullPath = window['path'].join(folderPath, entry.name);
      const entryStats = window['fs'].statSync(fullPath);

      if (entryStats.isDirectory()) {
        // 递归删除子文件夹
        this.deleteFolderRecursive(fullPath);
      } else {
        // 删除文件
        window['fs'].unlinkSync(fullPath);
      }
    }

    // 删除空文件夹
    window['fs'].rmdirSync(folderPath);
    console.log('Folder deleted:', folderPath);
  }
}