import { Injectable } from '@angular/core';
import { NzMessageService } from 'ng-zorro-antd/message';
import { AilyHost } from '../core/host';
import { getResourcesText as _getResourcesText } from './ui-helpers.service';

export interface ResourceItem {
  type: 'file' | 'folder' | 'url' | 'block';
  path?: string;
  url?: string;
  name: string;
  blockContext?: string;
  blockId?: string;
}

/**
 * 管理 AI 对话的附件资源（文件、文件夹、URL、块上下文）。
 */
@Injectable()
export class ResourceManagerService {
  items: ResourceItem[] = [];
  showAddList = false;

  constructor(private message: NzMessageService) {}

  toggleAddList(): void {
    this.showAddList = !this.showAddList;
  }

  async addFile(): Promise<void> {
    const options = {
      title: '选择文件或文件夹',
      properties: ['multiSelections'],
      filters: [{ name: '所有文件', extensions: ['*'] }]
    };
    const result = await AilyHost.get().dialog.selectFiles(options);
    if (!result.canceled && result.filePaths?.length > 0) {
      result.filePaths.forEach(path => {
        const exists = this.items.some(item => item.type === 'file' && item.path === path);
        if (!exists) {
          const fileName = path.split(/[/\\]/).pop() || path;
          this.items.push({ type: 'file', path, name: fileName });
        }
      });
    }
  }

  async addFolder(): Promise<void> {
    const options = {
      title: '选择文件夹',
      properties: ['openDirectory']
    };
    const result = await AilyHost.get().dialog.selectFiles(options);
    if (!result.canceled && result.filePaths?.length > 0) {
      const selectedPath = result.filePaths[0];
      const exists = this.items.some(item => item.type === 'folder' && item.path === selectedPath);
      if (!exists) {
        const folderName = selectedPath.split(/[/\\]/).pop() || selectedPath;
        this.items.push({ type: 'folder', path: selectedPath, name: folderName });
      }
    }
  }

  addUrl(): void {
    const url = prompt('请输入URL地址:');
    if (url && url.trim()) {
      const trimmed = url.trim();
      const exists = this.items.some(item => item.type === 'url' && item.url === trimmed);
      if (!exists) {
        try {
          const urlObj = new URL(trimmed);
          this.items.push({ type: 'url', url: trimmed, name: urlObj.hostname + urlObj.pathname });
        } catch {
          this.message.error('无效的URL格式');
        }
      } else {
        this.message.warning('该URL已经存在');
      }
    }
  }

  removeResource(index: number): void {
    if (index >= 0 && index < this.items.length) {
      this.items.splice(index, 1);
    }
  }

  /** 根据 Blockly 块选中状态更新 block 上下文资源项 */
  updateBlockContext(blockId: string | null, getContextLabel: () => any): void {
    this.items = this.items.filter(item => item.type !== 'block');
    if (!blockId) return;
    const ctxLabel = getContextLabel();
    if (!ctxLabel) return;
    this.items.push({
      type: 'block',
      name: ctxLabel.label,
      blockContext: ctxLabel.formatted,
      blockId: ctxLabel.blockId
    });
  }

  clearAll(): void {
    this.items = [];
  }

  /** 将资源中的文件/文件夹路径合并到指定的 allowed paths 数组（去重） */
  mergePathsTo(sessionAllowedPaths: string[]): void {
    const newPaths = this.items
      .filter(item => (item.type === 'file' || item.type === 'folder') && item.path)
      .map(item => item.path as string);
    for (const path of newPaths) {
      if (!sessionAllowedPaths.includes(path)) {
        sessionAllowedPaths.push(path);
      }
    }
  }

  /** 获取资源列表的 LLM 文本描述 */
  getResourcesText(): string {
    return _getResourcesText(this.items);
  }
}
