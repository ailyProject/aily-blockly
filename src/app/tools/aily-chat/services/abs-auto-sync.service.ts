/**
 * ABS 自动同步服务 (Aily Block Syntax)
 * 
 * 实现 Blockly working copy 与 ABS 文件的 revision-safe 镜像：
 * - 仅在 Blockly revision 变更时导出
 * - 并发请求共享同一个写入，旧 revision 不会覆盖新 revision
 * - agent 启动前由 runtime lifecycle 显式等待镜像 barrier
 * 
 * 注：版本历史功能已迁移到 EditCheckpointService，
 * 本服务不再维护独立的 .abi_history 目录。
 */

import { Injectable } from '@angular/core';
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

// =============================================================================
// 服务实现
// =============================================================================

@Injectable({
  providedIn: 'root'
})
export class AbsAutoSyncService {
  /** 是否正在同步（防止循环） */
  private isSyncing = false;

  /** 当前项目路径 */
  private currentProjectPath = '';

  /** Last Blockly workspace revision durably mirrored to project.abs. */
  private exportedWorkspaceRevision = -1;

  /** Serializes workspace snapshots so an older write cannot overtake a newer one. */
  private exportInFlight: Promise<string | null> | null = null;

  /** 通过 AilyHost 透传访问 Blockly 服务 */
  private get blocklyService(): any { return AilyHost.get().blockly; }

  // ===========================================================================
  // 公共 API
  // ===========================================================================

  /**
   * 初始化服务（在项目打开时调用）
   */
  initialize(projectPath: string): void {
    const normalizedProjectPath = typeof projectPath === 'string' ? projectPath.trim() : '';
    if (normalizedProjectPath !== this.currentProjectPath) {
      this.currentProjectPath = normalizedProjectPath;
      this.exportedWorkspaceRevision = -1;
    }
    this.trace('Initialized for project', { projectPath });
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
    void saveVersion;
    return this.exportWorkspaceRevision(this.readWorkspaceRevision(), true);
  }

  /**
   * Ensures project.abs represents the current Blockly working-copy revision.
   * Clean revisions are a no-op; concurrent callers share the same write.
   */
  async ensureWorkspaceExport(): Promise<string | null> {
    if (!this.currentProjectPath) {
      return null;
    }

    return this.exportWorkspaceRevision(this.readWorkspaceRevision(), false);
  }

  getWorkspaceMirrorState(): {
    readonly workspaceRevision: number;
    readonly exportedRevision: number;
    readonly dirty: boolean;
    readonly exporting: boolean;
  } {
    const workspaceRevision = this.readWorkspaceRevision();
    return {
      workspaceRevision,
      exportedRevision: this.exportedWorkspaceRevision,
      dirty: workspaceRevision !== this.exportedWorkspaceRevision,
      exporting: this.exportInFlight !== null,
    };
  }

  private async exportWorkspaceRevision(targetRevision: number, force: boolean): Promise<string | null> {
    if (!this.currentProjectPath) {
      return null;
    }

    if (this.exportInFlight) {
      await this.exportInFlight;
    }

    const requiredRevision = Math.max(targetRevision, this.readWorkspaceRevision());
    if (!force && this.exportedWorkspaceRevision >= requiredRevision) {
      return null;
    }

    const projectPath = this.currentProjectPath;
    const capturedRevision = this.readWorkspaceRevision();
    const exportPromise = this.performExport(projectPath, capturedRevision);
    this.exportInFlight = exportPromise;
    try {
      return await exportPromise;
    } finally {
      if (this.exportInFlight === exportPromise) {
        this.exportInFlight = null;
      }
    }
  }

  private async performExport(projectPath: string, capturedRevision: number): Promise<string | null> {
    if (!projectPath) {
      throw new Error('[AbsAutoSync] Cannot export without an active project path.');
    }
    if (this.isSyncing) {
      throw new Error('[AbsAutoSync] Cannot export while an ABS import is active.');
    }

    this.isSyncing = true;

    try {
      // 获取 ABI JSON
      const abiJson = this.getWorkspaceAbiJson();
      if (!abiJson) {
        throw new Error('[AbsAutoSync] Blockly workspace serialization is unavailable.');
      }
      
      // 转换为 ABS（并获取 blockLineMap）
      const { abs: absContent, blockLineMap } = convertAbiToAbsWithLineMap(abiJson, { includeHeader: true });
      // 同步更新 blockLineMap
      this.blocklyService.absBlockLineMap.next(blockLineMap);
      
      // 写入 ABS 文件
      const absFilePath = this.getAbsFilePath(projectPath);
      this.trace('Writing ABS file', { absFilePath, contentLength: absContent?.length || 0 });
      await asyncFs.writeFile(absFilePath, absContent);
      this.trace('Write completed', { absFilePath });

      if (projectPath === this.currentProjectPath) {
        this.exportedWorkspaceRevision = Math.max(this.exportedWorkspaceRevision, capturedRevision);
      }

      return absContent;
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
    this.exportedWorkspaceRevision = this.readWorkspaceRevision();

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
        // 清空并加载（中间让出事件循环，减轻 UI 冻结）
        workspace.clear();
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        Blockly.serialization.workspaces.load(abiJson, workspace);
      }
    } catch (error) {
      console.error('[AbsAutoSync] Failed to apply to workspace:', error);
      throw error;
    }
  }

  /**
   * 获取 ABS 文件路径
   */
  private readWorkspaceRevision(): number {
    const revision = this.blocklyService?.getWorkspaceContentRevision?.();
    return typeof revision === 'number' && Number.isFinite(revision) && revision >= 0
      ? revision
      : 0;
  }

  private getAbsFilePath(projectPath = this.currentProjectPath): string {
    return `${projectPath}/project.abs`;
  }

  private trace(message: string, details?: Record<string, unknown>): void {
    try {
      const enabled = globalThis.localStorage?.getItem?.('aily.absAutoSync.trace') === '1'
        || (globalThis as Record<string, unknown>)['__AILY_ABS_AUTO_SYNC_TRACE__'] === true;
      if (!enabled) {
        return;
      }
      console.info(`[AbsAutoSync] ${message}`, details ?? {});
    } catch {
      // Debug tracing must never affect the chat submit hot path.
    }
  }
}
