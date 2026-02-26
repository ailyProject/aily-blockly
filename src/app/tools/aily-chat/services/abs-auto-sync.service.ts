/**
 * ABS 自动同步服务 (Aily Block Syntax)
 * 
 * 实现 Blockly 工作区与 ABS 文件的同步：
 * - 会话开始时自动导出
 * - AI 修改时保存版本历史
 */

import { Injectable, OnDestroy } from '@angular/core';
import { Subscription } from 'rxjs';
import { ElectronService } from '../../../services/electron.service';
import { ProjectService } from '../../../services/project.service';
import { BlocklyService } from '../../../editors/blockly-editor/services/blockly.service';
import { convertAbsToAbi, convertAbiToAbsWithLineMap } from '../tools/abiAbsConverter';

// =============================================================================
// 类型定义
// =============================================================================

export interface AbsVersion {
  /** 版本 ID (时间戳) */
  id: string;
  /** 创建时间 */
  timestamp: Date;
  /** 版本描述 */
  description: string;
  /** 文件名 */
  filename: string;
  /** 块数量 */
  blockCount: number;
  /** 变量数量 */
  variableCount: number;
}

export interface VersionManifest {
  /** 当前版本 ID */
  currentVersion: string;
  /** 版本列表 */
  versions: AbsVersion[];
  /** 最大保留版本数 */
  maxVersions: number;
}

export interface AutoSyncConfig {
  /** 是否启用自动同步 */
  enabled: boolean;
  /** 是否在会话开始时自动导出 */
  exportOnSessionStart: boolean;
  /** 是否启用版本历史 */
  enableVersionHistory: boolean;
  /** 最大保留版本数 */
  maxVersions: number;
}

// =============================================================================
// 服务实现
// =============================================================================

@Injectable({
  providedIn: 'root'
})
export class AbsAutoSyncService implements OnDestroy {
  
  /** 配置 */
  private config: AutoSyncConfig = {
    enabled: true,
    exportOnSessionStart: true,
    enableVersionHistory: true,
    maxVersions: 50
  };
  
  /** 订阅管理 */
  private subscriptions: Subscription[] = [];
  
  /** 是否正在同步（防止循环） */
  private isSyncing = false;
  
  /** 当前项目路径 */
  private currentProjectPath = '';

  constructor(
    private electronService: ElectronService,
    private projectService: ProjectService,
    private blocklyService: BlocklyService
  ) {
    // 简化：不再自动监听工作区变化，只在 AI 修改时保存版本
  }

  ngOnDestroy(): void {
    this.cleanup();
  }

  // ===========================================================================
  // 公共 API
  // ===========================================================================

  /**
   * 初始化服务（在项目打开时调用）
   */
  initialize(projectPath: string): void {
    this.currentProjectPath = projectPath;
    console.log('[AbsAutoSync] Initialized for project:', projectPath);
  }

  /**
   * 会话开始时调用
   * 自动导出当前工作区到 ABS 文件
   */
  async onSessionStart(): Promise<string | null> {
    if (!this.config.exportOnSessionStart || !this.currentProjectPath) {
      return null;
    }
    
    try {
      const dslContent = await this.exportToAbs();
      if (dslContent) {
        console.log('[AbsAutoSync] Auto-exported ABS on session start');
      }
      return dslContent;
    } catch (error) {
      console.error('[AbsAutoSync] Failed to auto-export on session start:', error);
      return null;
    }
  }

  /**
   * 获取工作区的 ABS 内容（不写入文件）
   * 用于版本保存等场景，避免覆盖用户编辑的文件
   */
  getWorkspaceAbsContent(): string | null {
    try {
      const abiJson = this.getWorkspaceAbiJson();
      if (!abiJson) {
        return null;
      }
      const { abs, blockLineMap } = convertAbiToAbsWithLineMap(abiJson, { includeHeader: true });
      // 同步更新 blockLineMap，确保与生成的 ABS 文件行号一致
      this.blocklyService.absBlockLineMap.next(blockLineMap);
      return abs;
    } catch (error) {
      console.error('[AbsAutoSync] getWorkspaceAbsContent failed:', error);
      return null;
    }
  }

  /**
   * 导出当前工作区到 ABS 文件
   */
  async exportToAbs(saveVersion = false): Promise<string | null> {
    if (!this.currentProjectPath || this.isSyncing) {
      return null;
    }
    
    this.isSyncing = true;
    
    try {
      // 获取 ABI JSON
      const abiJson = this.getWorkspaceAbiJson();
      if (!abiJson) {
        console.warn('[AbsAutoSync] No ABI JSON available');
        return null;
      }
      
      // 转换为 ABS（并获取 blockLineMap）
      const { abs: absContent, blockLineMap } = convertAbiToAbsWithLineMap(abiJson, { includeHeader: true });
      // 同步更新 blockLineMap
      this.blocklyService.absBlockLineMap.next(blockLineMap);
      
      // 写入 ABS 文件
      const absFilePath = this.getAbsFilePath();
      console.log('[AbsAutoSync] Writing ABS file to:', absFilePath);
      console.log('[AbsAutoSync] Content length:', absContent?.length || 0);
      this.electronService.writeFile(absFilePath, absContent);
      console.log('[AbsAutoSync] Write completed for:', absFilePath);
      
      // 保存版本历史
      if (saveVersion && this.config.enableVersionHistory) {
        await this.saveVersion(absContent, '自动保存');
      }
      
      return absContent;
    } catch (error) {
      console.error('[AbsAutoSync] Export failed:', error);
      return null;
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * 从 ABS 文件导入到工作区
   */
  async importFromAbs(): Promise<boolean> {
    if (!this.currentProjectPath || this.isSyncing) {
      return false;
    }
    
    this.isSyncing = true;
    
    try {
      const absFilePath = this.getAbsFilePath();
      
      if (!this.electronService.exists(absFilePath)) {
        console.warn('[AbsAutoSync] ABS file does not exist');
        return false;
      }
      
      // 读取 ABS 文件
      const absContent = this.electronService.readFile(absFilePath);
      
      // 转换为 ABI JSON
      const result = convertAbsToAbi(absContent);
      
      if (!result.success) {
        console.error('[AbsAutoSync] ABS parse failed:', result.errors);
        return false;
      }
      
      // 应用到工作区
      await this.applyToWorkspace(result.abiJson);
      
      return true;
    } catch (error) {
      console.error('[AbsAutoSync] Import failed:', error);
      return false;
    } finally {
      this.isSyncing = false;
    }
  }

  // ===========================================================================
  // 版本控制
  // ===========================================================================

  /**
   * 保存版本
   */
  async saveVersion(absContent: string, description: string): Promise<AbsVersion | null> {
    if (!this.config.enableVersionHistory || !this.currentProjectPath) {
      return null;
    }
    
    try {
      const historyDir = this.getHistoryDir();
      
      // 确保历史目录存在
      if (!this.electronService.exists(historyDir)) {
        window['fs'].mkdirSync(historyDir, { recursive: true });
      }
      
      // 生成版本信息
      const timestamp = new Date();
      const id = this.formatTimestamp(timestamp);
      const filename = `${id}.abs`;
      
      // 统计信息
      const stats = this.getAbsStats(absContent);
      
      const version: AbsVersion = {
        id,
        timestamp,
        description,
        filename,
        blockCount: stats.blockCount,
        variableCount: stats.variableCount
      };
      
      // 保存版本文件
      const versionFilePath = `${historyDir}/${filename}`;
      this.electronService.writeFile(versionFilePath, absContent);
      
      // 更新 manifest
      await this.updateManifest(version);
      
      console.log('[AbsAutoSync] Saved version:', id);
      
      return version;
    } catch (error) {
      console.error('[AbsAutoSync] Failed to save version:', error);
      return null;
    }
  }

  /**
   * 获取版本列表
   */
  getVersionList(): AbsVersion[] {
    try {
      const manifest = this.loadManifest();
      return manifest?.versions || [];
    } catch (error) {
      console.error('[AbsAutoSync] Failed to get version list:', error);
      return [];
    }
  }

  /**
   * 回滚到指定版本
   */
  async rollbackToVersion(versionId: string): Promise<boolean> {
    try {
      const historyDir = this.getHistoryDir();
      const versionFilePath = `${historyDir}/${versionId}.abs`;
      
      if (!this.electronService.exists(versionFilePath)) {
        console.error('[AbsAutoSync] Version file not found:', versionId);
        return false;
      }
      
      // 保存当前版本（回滚前的状态）
      const currentAbs = await this.exportToAbs(false);
      if (currentAbs) {
        await this.saveVersion(currentAbs, `回滚前备份 (回滚到 ${versionId})`);
      }
      
      // 读取目标版本
      const absContent = this.electronService.readFile(versionFilePath);
      
      // 写入 ABS 文件
      const absFilePath = this.getAbsFilePath();
      this.electronService.writeFile(absFilePath, absContent);
      
      // 导入到工作区
      return await this.importFromAbs();
    } catch (error) {
      console.error('[AbsAutoSync] Rollback failed:', error);
      return false;
    }
  }

  /**
   * 获取指定版本的内容
   */
  getVersionContent(versionId: string): string | null {
    try {
      const historyDir = this.getHistoryDir();
      const versionFilePath = `${historyDir}/${versionId}.abs`;
      
      if (!this.electronService.exists(versionFilePath)) {
        return null;
      }
      
      return this.electronService.readFile(versionFilePath);
    } catch (error) {
      console.error('[AbsAutoSync] Failed to get version content:', error);
      return null;
    }
  }

  /**
   * 比较两个版本
   */
  compareVersions(versionId1: string, versionId2: string): { 
    content1: string | null; 
    content2: string | null;
  } {
    return {
      content1: this.getVersionContent(versionId1),
      content2: this.getVersionContent(versionId2)
    };
  }

  // ===========================================================================
  // 配置
  // ===========================================================================

  /**
   * 更新配置
   */
  setConfig(config: Partial<AutoSyncConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * 获取当前配置
   */
  getConfig(): AutoSyncConfig {
    return { ...this.config };
  }

  /**
   * 启用/禁用自动同步
   */
  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
  }

  // ===========================================================================
  // 私有方法
  // ===========================================================================

  /**
   * 获取工作区 ABI JSON
   */
  private getWorkspaceAbiJson(): any {
    try {
      const workspace = this.blocklyService.workspace;
      if (!workspace) return null;
      
      // 使用 Blockly 序列化
      const Blockly = (window as any).Blockly;
      if (Blockly?.serialization?.workspaces) {
        return Blockly.serialization.workspaces.save(workspace);
      }
      
      return null;
    } catch (error) {
      console.error('[AbsAutoSync] Failed to get workspace ABI:', error);
      return null;
    }
  }

  /**
   * 应用 ABI JSON 到工作区
   */
  private async applyToWorkspace(abiJson: any): Promise<void> {
    try {
      const workspace = this.blocklyService.workspace;
      if (!workspace) {
        throw new Error('Workspace not available');
      }
      
      const Blockly = (window as any).Blockly;
      if (Blockly?.serialization?.workspaces) {
        // 暂时禁用自动同步，避免循环
        const wasEnabled = this.config.enabled;
        this.config.enabled = false;
        
        // 清空并加载
        workspace.clear();
        Blockly.serialization.workspaces.load(abiJson, workspace);
        
        // 恢复自动同步
        this.config.enabled = wasEnabled;
      }
    } catch (error) {
      console.error('[AbsAutoSync] Failed to apply to workspace:', error);
      throw error;
    }
  }

  /**
   * 获取 ABS 文件路径
   */
  private getAbsFilePath(): string {
    return `${this.currentProjectPath}/project.abs`;
  }

  /**
   * 获取历史目录路径
   */
  private getHistoryDir(): string {
    return `${this.currentProjectPath}/.abi_history`;
  }

  /**
   * 获取 manifest 文件路径
   */
  private getManifestPath(): string {
    return `${this.getHistoryDir()}/manifest.json`;
  }

  /**
   * 加载 manifest
   */
  private loadManifest(): VersionManifest | null {
    try {
      const manifestPath = this.getManifestPath();
      if (!this.electronService.exists(manifestPath)) {
        return null;
      }
      
      const content = this.electronService.readFile(manifestPath);
      return JSON.parse(content);
    } catch (error) {
      console.error('[AbsAutoSync] Failed to load manifest:', error);
      return null;
    }
  }

  /**
   * 更新 manifest
   */
  private async updateManifest(newVersion: AbsVersion): Promise<void> {
    let manifest = this.loadManifest() || {
      currentVersion: '',
      versions: [],
      maxVersions: this.config.maxVersions
    };
    
    // 添加新版本
    manifest.versions.unshift(newVersion);
    manifest.currentVersion = newVersion.id;
    
    // 清理旧版本
    if (manifest.versions.length > manifest.maxVersions) {
      const toRemove = manifest.versions.splice(manifest.maxVersions);
      
      // 删除旧版本文件
      for (const version of toRemove) {
        try {
          const filePath = `${this.getHistoryDir()}/${version.filename}`;
          if (this.electronService.exists(filePath)) {
            this.electronService.deleteFile(filePath);
          }
        } catch (e) {
          // 忽略删除失败
        }
      }
    }
    
    // 保存 manifest
    const manifestPath = this.getManifestPath();
    this.electronService.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  }

  /**
   * 格式化时间戳
   */
  private formatTimestamp(date: Date): string {
    return date.toISOString()
      .replace(/[:.]/g, '-')
      .replace('T', '_')
      .slice(0, 19);
  }

  /**
   * 获取 ABS 统计信息
   */
  private getAbsStats(absContent: string): { blockCount: number; variableCount: number } {
    const lines = absContent.split('\n');
    let blockCount = 0;
    let variableCount = 0;
    
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('@var ')) {
        variableCount++;
      } else if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('@')) {
        // 简单统计块调用（非注释、非指令的行）
        if (trimmed.match(/^[a-z_][a-z0-9_]*(\(|$)/i)) {
          blockCount++;
        }
      }
    }
    
    return { blockCount, variableCount };
  }

  /**
   * 清理资源
   */
  private cleanup(): void {
    this.subscriptions.forEach(sub => sub.unsubscribe());
    this.subscriptions = [];
  }
}
