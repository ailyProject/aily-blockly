import { Injectable } from '@angular/core';
import { NzMessageService } from 'ng-zorro-antd/message';
import { AilyHost } from '../core/host';
import type { ResourceItem } from '../core/chat-types';
import { getResourcesText as _getResourcesText } from './ui-helpers.service';
import {
  pickFileOrFolderResources,
  pickFileResources,
  pickFolderResource,
} from '../helpers/chat-resource-picker';
import { ProjectService } from '../../../services/project.service';
import { ProjectRelatedFileStorage } from '../components/memory/project-related-file-storage';

/**
 * 管理 AI 对话的附件资源（文件、文件夹、URL、块上下文）。
 */
@Injectable()
export class ResourceManagerService {
  items: ResourceItem[] = [];

  constructor(
    private message: NzMessageService,
    private projectService: ProjectService,
  ) {}

  async addFileOrFolderResources(): Promise<ResourceItem[]> {
    const host = AilyHost.get();
    const resources = await pickFileOrFolderResources(
      host.dialog,
      (path) => host.fs.isDirectory(path),
    );
    const importedResources = this.importAssetResources(resources);
    this.pushUniqueResources(importedResources);
    return importedResources;
  }

  async addFile(): Promise<void> {
    await this.addFileResources();
  }

  async addFileResources(): Promise<ResourceItem[]> {
    const resources = await pickFileResources(AilyHost.get().dialog);
    const importedResources = this.importAssetResources(resources);
    this.pushUniqueResources(importedResources);
    return importedResources;
  }

  async addFolder(): Promise<void> {
    await this.addFolderResource();
  }

  async addFolderResource(): Promise<ResourceItem | null> {
    const item = await pickFolderResource(AilyHost.get().dialog);
    const importedResources = item ? this.importAssetResources([item]) : [];
    this.pushUniqueResources(importedResources);
    return importedResources[0] ?? null;
  }

  addUrl(): void {
    const url = prompt('请输入URL地址:');
    if (url && url.trim()) {
      const normalizedUrl = normalizeUrl(url.trim());
      if (!normalizedUrl) {
        this.message.error('无效的URL格式');
        return;
      }

      const importedResources = this.importUrlResources([normalizedUrl]);
      if (importedResources.length === 0) {
        this.message.warning('该URL已经存在');
        return;
      }

      this.pushUniqueResources(importedResources);
    }
  }

  removeResource(index: number): void {
    if (index >= 0 && index < this.items.length) {
      this.items.splice(index, 1);
    }
  }

  /** 根据 Blockly 块选中状态更新 block 上下文资源项（支持多选） */
  updateBlockContexts(
    blockIds: string[],
    getContextLabels: () => Array<{ label: string; formatted: string; blockId: string }>,
  ): void {
    this.items = this.items.filter(item => item.type !== 'block');
    if (!blockIds.length) return;

    const labels = getContextLabels();
    for (const ctxLabel of labels) {
      this.items.push({
        type: 'block',
        name: ctxLabel.label,
        blockContext: ctxLabel.formatted,
        blockId: ctxLabel.blockId,
      });
    }
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

  private importAssetResources(resources: readonly ResourceItem[]): ResourceItem[] {
    const projectPath = this.projectService.currentProjectPath?.trim()
      || this.projectService.projectRootPath?.trim();
    if (!projectPath) {
      return resources.filter((item) => item.type === 'file' || item.type === 'folder');
    }

    const sourcePaths = resources
      .filter((item) =>
        (item.type === 'file' || item.type === 'folder')
        && typeof item.path === 'string'
        && item.path.trim().length > 0,
      )
      .map((item) => item.path!.trim());
    if (sourcePaths.length === 0) {
      return [];
    }

    const storage = new ProjectRelatedFileStorage(AilyHost.get());
    const result = storage.importPaths('project', projectPath, sourcePaths);
    return result.addedEntries
      .map((entry) => {
        if (entry.type !== 'file' && entry.type !== 'folder') {
          return null;
        }

        return {
          type: entry.type,
          path: entry.absolutePath,
          name: entry.name,
        } as ResourceItem;
      })
      .filter((item): item is ResourceItem => !!item);
  }

  private importUrlResources(urls: readonly string[]): ResourceItem[] {
    const projectPath = this.projectService.currentProjectPath?.trim()
      || this.projectService.projectRootPath?.trim();
    if (!projectPath) {
      return [];
    }

    try {
      const storage = new ProjectRelatedFileStorage(AilyHost.get());
      const result = storage.importLinks('project', projectPath, urls);
      if (result.invalidOriginalPaths.length > 0) {
        this.message.error('无效的URL格式');
        return [];
      }
      return result.addedEntries.map((entry) => ({
        type: 'url',
        url: entry.absolutePath,
        name: entry.name,
      }));
    } catch {
      this.message.error('无效的URL格式');
      return [];
    }
  }

  private pushUniqueResources(resources: readonly ResourceItem[]): void {
    for (const item of resources) {
      const exists = item.type === 'url'
        ? this.items.some((resource) => resource.type === 'url' && resource.url === item.url)
        : this.items.some((resource) => resource.type === item.type && resource.path === item.path);
      if (!exists) {
        this.items.push(item);
      }
    }
  }
}

function normalizeUrl(value: string): string | undefined {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) {
    return undefined;
  }

  try {
    return new URL(trimmed).toString();
  } catch {
    return undefined;
  }
}
