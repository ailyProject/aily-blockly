import { Injectable } from '@angular/core';
import { NzMessageService } from 'ng-zorro-antd/message';
import { AilyHost } from '../core/host';
import type { ResourceItem } from '../core/chat-types';
import { getResourcesText as _getResourcesText } from './ui-helpers.service';
import {
  pickFileResources,
  pickFolderResource,
} from '../helpers/chat-resource-picker';
import { ProjectService } from '../../../services/project.service';
import { ProjectRelatedFileStorage } from '../components/memory/project-related-file-storage';
import {
  getSupportedImageMimeTypeFromPath,
} from '../core/chat-image-attachment';

/**
 * 管理 AI 对话的附件资源（文件、文件夹、URL、块上下文）。
 */
@Injectable()
export class ResourceManagerService {
  items: ResourceItem[] = [];
  private readonly imagePreviewUrls = new WeakMap<ResourceItem, string>();

  constructor(
    private message: NzMessageService,
    private projectService: ProjectService,
  ) {}

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

  async addClipboardImages(
    files: readonly File[],
    options?: { maxInputImages?: number },
  ): Promise<ResourceItem[]> {
    const supportedFiles = files.filter(file => /^image\/(png|jpeg|gif|webp)$/i.test(file.type));
    if (supportedFiles.length === 0) {
      return [];
    }
    const maxInputImages = typeof options?.maxInputImages === 'number'
      && Number.isFinite(options.maxInputImages)
      ? Math.max(0, Math.floor(options.maxInputImages))
      : 10;
    if (this.items.filter(item => item.type === 'image').length + supportedFiles.length > maxInputImages) {
      this.message.error(`每次最多添加 ${maxInputImages} 张图片`);
      return [];
    }

    const host = AilyHost.get();
    const appDataPath = host.path.getAppDataPath();
    if (!appDataPath || !host.fs.writeFileBufferAsync) {
      this.message.error('当前运行环境不支持粘贴图片');
      return [];
    }

    const draftRoot = host.path.join(appDataPath, 'runtime-host', 'chat-media', 'drafts');
    if (!host.fs.existsSync(draftRoot)) {
      host.fs.mkdirSync(draftRoot, { recursive: true });
    }
    const added: ResourceItem[] = [];
    for (const file of supportedFiles) {
      if (file.size <= 0 || file.size > 30 * 1024 * 1024) {
        this.message.error(`图片 ${file.name || ''} 超过 30 MB 限制`);
        continue;
      }
      const mimeType = file.type.toLowerCase() as ResourceItem['mimeType'];
      const extension = mimeType === 'image/jpeg' ? 'jpg' : mimeType?.slice('image/'.length) || 'bin';
      const id = globalThis.crypto?.randomUUID?.()
        ?? `image-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      const draftPath = host.path.join(draftRoot, `${id}.${extension}`);
      const previewUrl = await readPreviewDataUrl(file);
      try {
        await host.fs.writeFileBufferAsync(draftPath, await file.arrayBuffer());
      } catch {
        this.message.error(`无法保存粘贴的图片 ${file.name || ''}`);
        continue;
      }
      const name = file.name?.trim() || `clipboard-image.${extension}`;
      const item: ResourceItem = {
        type: 'image',
        path: draftPath,
        name,
        mimeType,
        imageAttachment: {
          id,
          type: 'image',
          name,
          origin: 'clipboard',
          source: { kind: 'local-file', uri: draftPath },
          ...(mimeType ? { mimeType } : {}),
          detail: 'auto',
        },
      };
      if (previewUrl) {
        this.imagePreviewUrls.set(item, previewUrl);
      }
      added.push(item);
    }
    this.pushUniqueResources(added);
    return added;
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

  getImagePreviewUrl(item: ResourceItem): string | undefined {
    return this.imagePreviewUrls.get(item);
  }

  clearImagePreview(item: ResourceItem): void {
    this.imagePreviewUrls.delete(item);
  }

  /** 将资源中的文件/文件夹路径合并到指定的 allowed paths 数组（去重） */
  mergePathsTo(sessionAllowedPaths: string[]): void {
    const newPaths = this.items
      .filter(item => (item.type === 'file' || item.type === 'folder' || item.type === 'image') && item.path)
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
      return resources
        .filter((item) => item.type === 'file' || item.type === 'folder' || item.type === 'image')
        .map((item) => {
          if (item.type !== 'image') {
            return item;
          }
          if (item.path && item.mimeType) {
            const previewUrl = this.createLocalImagePreview(item.path, item.mimeType);
            if (previewUrl) {
              this.imagePreviewUrls.set(item, previewUrl);
            }
          }
          return item;
        });
    }

    const sourcePaths = resources
      .filter((item) =>
        (item.type === 'file' || item.type === 'folder' || item.type === 'image')
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

        const mimeType = entry.type === 'file'
          ? getSupportedImageMimeTypeFromPath(entry.absolutePath)
          : undefined;
        if (mimeType) {
          const id = globalThis.crypto?.randomUUID?.()
            ?? `image-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
          const item: ResourceItem = {
            type: 'image',
            path: entry.absolutePath,
            name: entry.name,
            mimeType,
            imageAttachment: {
              id,
              type: 'image',
              name: entry.name,
              origin: 'file',
              source: { kind: 'local-file', uri: entry.absolutePath },
              mimeType,
              detail: 'auto',
            },
          };
          const previewUrl = this.createLocalImagePreview(entry.absolutePath, mimeType);
          if (previewUrl) {
            this.imagePreviewUrls.set(item, previewUrl);
          }
          return item;
        }

        return {
          type: entry.type,
          path: entry.absolutePath,
          name: entry.name,
        } as ResourceItem;
      })
      .filter((item): item is ResourceItem => !!item);
  }

  private createLocalImagePreview(
    imagePath: string,
    mimeType: NonNullable<ResourceItem['mimeType']>,
  ): string | undefined {
    const host = AilyHost.get();
    if (!host.fs.readFileAsBase64) {
      return undefined;
    }
    try {
      const stat = host.fs.statSync(imagePath);
      if (!stat.isFile() || stat.size <= 0 || stat.size > 5 * 1024 * 1024) {
        return undefined;
      }
      const base64 = host.fs.readFileAsBase64(imagePath);
      return typeof base64 === 'string' && base64.length > 0
        ? `data:${mimeType};base64,${base64}`
        : undefined;
    } catch {
      return undefined;
    }
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

async function readPreviewDataUrl(file: File): Promise<string | undefined> {
  if (file.size <= 0 || file.size > 5 * 1024 * 1024 || typeof FileReader === 'undefined') {
    return undefined;
  }
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(
      typeof reader.result === 'string' && reader.result.startsWith('data:image/')
        ? reader.result
        : undefined,
    ), { once: true });
    reader.addEventListener('error', () => resolve(undefined), { once: true });
    reader.readAsDataURL(file);
  });
}
