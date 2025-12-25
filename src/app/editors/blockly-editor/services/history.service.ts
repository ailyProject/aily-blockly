import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

export interface HistoryItem {
  id: string;
  timestamp: number;
  type: 'manual' | 'auto';
  note?: string;
  size: number;
}

export interface HistoryIndex {
  versions: HistoryItem[];
  currentVersionId?: string; // 当前正在使用的版本ID
}

@Injectable({
  providedIn: 'root'
})
export class HistoryService {
  private projectPath: string;
  private historyPath: string;
  private indexPath: string;
  private index: HistoryIndex = { versions: [] };
  private autoSaveTimer: any;
  private autoSaveEnabled = true; // 控制是否启用自动保存
  private pendingAutoSave = false;
  private workspaceListenerAdded = false;
  private blocklyService: any; // 延迟注入以避免循环依赖

  // Observable for UI to subscribe to history changes
  historySubject = new BehaviorSubject<HistoryItem[]>([]);

  constructor() {}

  /**
   * 初始化历史记录服务
   * @param projectPath 项目路径
   * @param blocklyService BlocklyService实例（用于获取工作区内容）
   */
  init(projectPath: string, blocklyService: any) {
    this.projectPath = projectPath;
    this.blocklyService = blocklyService;
    // Use window['path'] for path operations as per existing code style
    this.historyPath = window['path'].join(projectPath, '.history');
    this.indexPath = window['path'].join(this.historyPath, 'index.json');

    this.ensureHistoryDir();
    this.loadIndex();
    this.autoSaveEnabled = true;
    this.setupWorkspaceListener();
  }

  destroy() {
    this.clearAutoSaveTimer();
    this.projectPath = '';
    this.blocklyService = null;
    this.index = { versions: [] };
    this.historySubject.next([]);
    this.autoSaveEnabled = true;
    this.workspaceListenerAdded = false;
  }

  private ensureHistoryDir() {
    if (!window['fs'].existsSync(this.historyPath)) {
      window['fs'].mkdirSync(this.historyPath);
      // Optional: Hide directory on Windows
      if (window['platform'].type === 'win32') {
        try {
           // Using child_process to hide folder is a bit heavy, maybe skip for now
        } catch (e) {}
      }
    }
  }

  private loadIndex() {
    if (window['fs'].existsSync(this.indexPath)) {
      try {
        const data = window['fs'].readFileSync(this.indexPath, 'utf-8');
        this.index = JSON.parse(data);
        // Sort by timestamp desc just in case
        this.index.versions.sort((a, b) => b.timestamp - a.timestamp);
      } catch (e) {
        console.error('Failed to load history index', e);
        this.index = { versions: [] };
      }
    } else {
      this.index = { versions: [] };
    }
    this.historySubject.next(this.index.versions);
  }

  private saveIndex() {
    window['fs'].writeFileSync(this.indexPath, JSON.stringify(this.index, null, 2));
    this.historySubject.next(this.index.versions);
  }

  createVersion(type: 'manual' | 'auto', content: any, note?: string) {
    if (!this.projectPath) return;

    const contentStr = JSON.stringify(content, null, 2);
    
    // Check for duplicates (compare with last version)
    if (this.index.versions.length > 0) {
        const lastVersionId = this.index.versions[0].id;
        const lastVersionPath = window['path'].join(this.historyPath, `${lastVersionId}.json`);
        if (window['fs'].existsSync(lastVersionPath)) {
            const lastContent = window['fs'].readFileSync(lastVersionPath, 'utf-8');
            if (lastContent === contentStr) {
                // Content hasn't changed
                // If it's auto-save, we skip
                if (type === 'auto') return;
                // If it's manual, we skip duplicates to be efficient
                return;
            }
        }
    }

    const timestamp = Date.now();
    const id = timestamp.toString();
    const filePath = window['path'].join(this.historyPath, `${id}.json`);
    
    window['fs'].writeFileSync(filePath, contentStr);

    const item: HistoryItem = {
      id,
      timestamp,
      type,
      note,
      size: contentStr.length
    };

    this.index.versions.unshift(item);
    this.index.currentVersionId = id; // 标记为当前版本
    this.cleanup(); // Cleanup old versions
    this.saveIndex();
  }

  private cleanup() {
    const MAX_AUTO_VERSIONS = 50;
    const autoVersions = this.index.versions.filter(v => v.type === 'auto');
    
    if (autoVersions.length > MAX_AUTO_VERSIONS) {
      // Keep the newest MAX_AUTO_VERSIONS
      // The list is sorted desc, so we keep the first MAX_AUTO_VERSIONS
      
      // Get the IDs of auto versions to keep
      const autoIdsToKeep = new Set(autoVersions.slice(0, MAX_AUTO_VERSIONS).map(v => v.id));
      
      // Identify versions to remove (type auto AND not in keep list)
      const versionsToRemove = this.index.versions.filter(v => v.type === 'auto' && !autoIdsToKeep.has(v.id));
      
      versionsToRemove.forEach(v => {
        const filePath = window['path'].join(this.historyPath, `${v.id}.json`);
        if (window['fs'].existsSync(filePath)) {
          window['fs'].unlinkSync(filePath);
        }
      });

      // Update index
      this.index.versions = this.index.versions.filter(v => !(v.type === 'auto' && !autoIdsToKeep.has(v.id)));
    }
  }

  getVersionContent(id: string): any {
    const filePath = window['path'].join(this.historyPath, `${id}.json`);
    if (window['fs'].existsSync(filePath)) {
      return JSON.parse(window['fs'].readFileSync(filePath, 'utf-8'));
    }
    return null;
  }

  // 工作区变化时触发自动保存（带防抖，3秒后保存）
  onWorkspaceChange(content: any) {
    if (!this.autoSaveEnabled || !this.projectPath) return;

    // 清除之前的定时器
    this.clearAutoSaveTimer();
    this.pendingAutoSave = true;

    // 3秒后执行自动保存
    this.autoSaveTimer = setTimeout(() => {
      if (this.pendingAutoSave && this.autoSaveEnabled) {
        this.createVersion('auto', content);
        this.pendingAutoSave = false;
      }
    }, 3000);
  }

  // 清除自动保存定时器
  private clearAutoSaveTimer() {
    if (this.autoSaveTimer) {
      clearTimeout(this.autoSaveTimer);
      this.autoSaveTimer = null;
    }
    this.pendingAutoSave = false;
  }

  // 临时禁用自动保存（用于还原操作）
  disableAutoSave() {
    this.autoSaveEnabled = false;
    this.clearAutoSaveTimer();
  }

  // 重新启用自动保存
  enableAutoSave() {
    this.autoSaveEnabled = true;
  }

  // 还原到指定版本(只更新currentVersionId,不创建新版本)
  restoreToVersion(id: string) {
    if (!this.projectPath) return;
    
    // 验证版本是否存在
    const version = this.index.versions.find(v => v.id === id);
    if (!version) {
      console.error('Version not found:', id);
      return;
    }

    // 更新当前版本标记
    this.index.currentVersionId = id;
    this.saveIndex();
  }

  // 获取当前版本ID
  getCurrentVersionId(): string | undefined {
    return this.index.currentVersionId;
  }

  /**
   * 设置工作区变化监听，触发自动保存
   */
  private setupWorkspaceListener() {
    if (!this.blocklyService?.workspace) {
      console.warn('工作区尚未初始化');
      return;
    }

    if (this.workspaceListenerAdded) {
      return; // 避免重复添加监听器
    }

    this.blocklyService.workspace.addChangeListener((event: any) => {
      // 只在有意义的变化时触发自动保存
      if (event.type === 'create' || 
          event.type === 'delete' || 
          event.type === 'change' || 
          event.type === 'move') {
        try {
          const content = this.blocklyService.getWorkspaceJson();
          this.onWorkspaceChange(content);
        } catch (e) {
          console.error('自动保存失败', e);
        }
      }
    });

    this.workspaceListenerAdded = true;
  }

  /**
   * 创建手动保存的历史版本
   * @param note 可选的备注信息
   */
  createManualVersion(note?: string) {
    if (!this.projectPath || !this.blocklyService) return;

    try {
      const content = this.blocklyService.getWorkspaceJson();
      this.createVersion('manual', content, note);
    } catch (e) {
      console.error('创建手动版本失败', e);
    }
  }

  /**
   * 还原到指定版本
   * @param versionId 版本ID
   * @param onSave 保存回调函数
   */
  restoreVersion(versionId: string, onSave: (path: string) => void) {
    if (!this.projectPath || !this.blocklyService) {
      console.error('历史服务未初始化');
      return;
    }

    // 禁用自动保存，防止还原操作触发自动备份
    this.disableAutoSave();

    try {
      // 1. 还原前自动备份当前状态(作为手动版本,带备份说明)
      try {
        const currentJson = this.blocklyService.getWorkspaceJson();
        this.createVersion('manual', currentJson, '还原前备份');
      } catch (e) {
        console.warn('还原前备份失败', e);
      }

      // 2. 获取目标版本内容
      const targetContent = this.getVersionContent(versionId);
      if (targetContent) {
        // 3. 禁用 Blockly 事件,防止加载时触发工作区变化监听
        const Blockly = (window as any)['Blockly'];
        if (Blockly && Blockly.Events) {
          Blockly.Events.disable();
        }

        try {
          // 4. 加载到工作区
          this.blocklyService.loadAbiJson(targetContent);
          
          // 5. 保存到文件 (通过回调)
          onSave(this.projectPath);
          
          // 6. 标记当前使用的版本
          this.restoreToVersion(versionId);
        } finally {
          // 重新启用 Blockly 事件
          if (Blockly && Blockly.Events) {
            Blockly.Events.enable();
          }
        }
      }
    } finally {
      // 还原完成后重新启用自动保存，使用 setTimeout 避免立即触发
      setTimeout(() => {
        this.enableAutoSave();
      }, 500); // 确保所有事件都处理完毕
    }
  }
}
