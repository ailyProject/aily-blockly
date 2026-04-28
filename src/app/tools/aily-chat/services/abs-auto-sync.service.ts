/**
 * ABS 自动同步服务 (Aily Block Syntax)
 * 
 * 实现 Blockly 工作区与 ABS 文件的同步：
 * - 会话开始时自动导出
 * - AI 修改时同步到磁盘
 * 
 * 注：版本历史功能已迁移到 EditCheckpointService，
 * 本服务不再维护独立的 .abi_history 目录。
 */

import { Injectable, OnDestroy } from '@angular/core';
import { Subscription } from 'rxjs';
import { AilyHost } from '../core/host';
import { convertAbsToAbi, convertAbiToAbsWithLineMap } from '../tools/abiAbsConverter';
import { loadProjectBlockDefinitions } from '../tools/absParser';
import * as asyncFs from '../core/async-fs';

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
  };
  
  /** 订阅管理 */
  private subscriptions: Subscription[] = [];
  
  /** 是否正在同步（防止循环） */
  private isSyncing = false;
  
  /** 当前项目路径 */
  private currentProjectPath = '';

  /** 通过 AilyHost 透传访问 Blockly 服务 */
  private get blocklyService(): any { return AilyHost.get().blockly; }

  constructor() {
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
      await asyncFs.writeFile(absFilePath, absContent);
      console.log('[AbsAutoSync] Write completed for:', absFilePath);
      
      // 版本历史已迁移到 EditCheckpointService，不再单独保存
      
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
      return await this._doImportFromAbs();
    } catch (error) {
      console.error('[AbsAutoSync] Import failed:', error);
      return false;
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * 强制从 ABS 文件重新导入到工作区——绕过 isSyncing 互斥锁。
   * 仅用于 undo/redo 后需要立即重新加载工作区的场景。
   */
  async forceImportFromAbs(): Promise<boolean> {
    if (!this.currentProjectPath) {
      return false;
    }

    // 重置锁，确保不会被前一次同步阻塞
    this.isSyncing = true;

    try {
      return await this._doImportFromAbs();
    } catch (error) {
      console.error('[AbsAutoSync] Force import failed:', error);
      return false;
    } finally {
      this.isSyncing = false;
    }
  }

  /** 内部实际执行 ABS → 工作区 的导入 */
  private async _doImportFromAbs(): Promise<boolean> {
    const absFilePath = this.getAbsFilePath();

    if (!await asyncFs.exists(absFilePath)) {
      console.warn('[AbsAutoSync] ABS file does not exist:', absFilePath);
      return false;
    }

    // 加载项目块定义（确保库块可正确解析）
    if (this.currentProjectPath) {
      loadProjectBlockDefinitions(this.currentProjectPath);
    }

    // 读取 ABS 文件
    const absContent = await asyncFs.readFile(absFilePath, 'utf-8');

    // 转换为 ABI JSON
    const result = convertAbsToAbi(absContent);

    if (!result.success) {
      console.error('[AbsAutoSync] ABS parse failed:', result.errors);
      return false;
    }

    // 应用到工作区
    await this.applyToWorkspace(result.abiJson);

    return true;
  }

  // ===========================================================================
  // 版本控制（已废弃 — 功能迁移到 EditCheckpointService）
  // ===========================================================================

  /** @deprecated 版本历史功能已迁移到 EditCheckpointService */
  async saveVersion(_absContent: string, _description: string): Promise<AbsVersion | null> {
    return null;
  }

  /** @deprecated 版本历史功能已迁移到 EditCheckpointService */
  getVersionList(): AbsVersion[] {
    return [];
  }

  /** @deprecated 版本历史功能已迁移到 EditCheckpointService */
  async rollbackToVersion(_versionId: string): Promise<boolean> {
    return false;
  }

  /** @deprecated 版本历史功能已迁移到 EditCheckpointService */
  getVersionContent(_versionId: string): string | null {
    return null;
  }

  /** @deprecated 版本历史功能已迁移到 EditCheckpointService */
  compareVersions(_versionId1: string, _versionId2: string): { content1: string | null; content2: string | null } {
    return { content1: null, content2: null };
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
        
        // 清空并加载（中间让出事件循环，减轻 UI 冻结）
        workspace.clear();
        await new Promise<void>(resolve => setTimeout(resolve, 0));
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
   * 清理资源
   */
  private cleanup(): void {
    this.subscriptions.forEach(sub => sub.unsubscribe());
    this.subscriptions = [];
  }
}
