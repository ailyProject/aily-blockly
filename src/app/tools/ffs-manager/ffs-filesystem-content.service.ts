import { Injectable } from '@angular/core';
import { FfsFilesystemType, FfsPartitionInfo } from './ffs-manager.service';

export type FfsFileEntryType = 'file' | 'dir';

export interface FfsFileEntry {
  name: string;
  path: string;
  type: FfsFileEntryType;
  size: number;
  sizeText: string;
}

export interface FfsFilesystemUsage {
  capacityBytes: number;
  usedBytes: number;
  freeBytes: number;
  capacityText: string;
  usedText: string;
  freeText: string;
  usedPercent: number;
}

export interface FfsMountedFilesystem {
  type: FfsFilesystemType;
  partition: FfsPartitionInfo;
  client: any;
  image: Uint8Array;
  blockSize?: number;
  files: FfsFileEntry[];
  usage: FfsFilesystemUsage | null;
}

const DEFAULT_BLOCK_SIZE = 4096;
const SPIFFS_PAGE_SIZE = 256;
const BLOCK_SIZE_CANDIDATES = [4096, 2048, 1024, 512];
const FAT_MOUNT = '/fatfs';
const FILE_NAME_MAX_BYTES: Record<FfsFilesystemType, number> = {
  spiffs: 30,
  littlefs: 63,
  fatfs: 255,
};
const FILESYSTEM_LABELS: Record<FfsFilesystemType, string> = {
  spiffs: 'SPIFFS',
  littlefs: 'LittleFS',
  fatfs: 'FATFS',
};

@Injectable({
  providedIn: 'root'
})
export class FfsFilesystemContentService {
  async mountPartition(
    partition: FfsPartitionInfo,
    image: Uint8Array
  ): Promise<FfsMountedFilesystem> {
    if (!partition.filesystemType) {
      throw new Error('请选择 SPIFFS / LittleFS / FATFS 文件系统分区');
    }

    const type = partition.filesystemType;
    const mounted: FfsMountedFilesystem = {
      type,
      partition,
      client: await this.createClient(type, image),
      image,
      files: [],
      usage: null,
    };

    mounted.files = await this.listFiles(mounted);
    mounted.usage = await this.getUsage(mounted);
    return mounted;
  }

  async listFiles(filesystem: FfsMountedFilesystem): Promise<FfsFileEntry[]> {
    let entries: any[] = [];

    if (filesystem.type === 'spiffs') {
      entries = await filesystem.client.list();
    } else if (filesystem.type === 'littlefs') {
      entries = this.listLittlefsEntries(filesystem.client);
    } else {
      entries = this.listFatfsEntries(filesystem.client);
    }

    return entries
      .map(entry => this.normalizeEntry(filesystem.type, entry))
      .sort((a, b) => {
        if (a.type !== b.type) {
          return a.type === 'dir' ? -1 : 1;
        }
        return a.path.localeCompare(b.path);
      });
  }

  async readFile(filesystem: FfsMountedFilesystem, path: string): Promise<Uint8Array> {
    const normalized = this.normalizeFilePath(path, filesystem.type);
    if (filesystem.type === 'spiffs') {
      return await filesystem.client.read(normalized);
    }
    return filesystem.client.readFile(this.toClientPath(filesystem.type, normalized));
  }

  async writeFile(filesystem: FfsMountedFilesystem, path: string, data: Uint8Array): Promise<void> {
    const normalized = this.normalizeFilePath(path, filesystem.type);
    if (filesystem.type === 'spiffs') {
      await filesystem.client.write(normalized, data);
      return;
    }

    this.ensureParentDirectories(filesystem, normalized);
    filesystem.client.writeFile(this.toClientPath(filesystem.type, normalized), data);
  }

  async deleteEntry(filesystem: FfsMountedFilesystem, entry: FfsFileEntry): Promise<void> {
    if (filesystem.type === 'spiffs') {
      await filesystem.client.remove(entry.path);
      return;
    }

    const path = this.toClientPath(filesystem.type, entry.path);
    if (filesystem.type === 'littlefs' && entry.type === 'dir') {
      filesystem.client.delete(path, { recursive: true });
      return;
    }

    filesystem.client.deleteFile(path);
  }

  async renameEntry(filesystem: FfsMountedFilesystem, entry: FfsFileEntry, newPath: string): Promise<void> {
    const normalized = entry.type === 'dir'
      ? this.normalizeDirectoryPath(newPath)
      : this.normalizeFilePath(newPath, filesystem.type);

    if (filesystem.type === 'spiffs') {
      const data = await this.readFile(filesystem, entry.path);
      await filesystem.client.write(normalized, data);
      await filesystem.client.remove(entry.path);
      return;
    }

    this.ensureParentDirectories(filesystem, normalized);
    filesystem.client.rename(
      this.toClientPath(filesystem.type, entry.path),
      this.toClientPath(filesystem.type, normalized)
    );
  }

  async mkdir(filesystem: FfsMountedFilesystem, path: string): Promise<void> {
    if (filesystem.type === 'spiffs') {
      throw new Error('SPIFFS 不支持目录');
    }

    const normalized = this.normalizeDirectoryPath(path);
    this.ensureParentDirectories(filesystem, normalized);
    filesystem.client.mkdir(this.toClientPath(filesystem.type, normalized));
  }

  async format(filesystem: FfsMountedFilesystem): Promise<void> {
    await filesystem.client.format();
  }

  async toImage(filesystem: FfsMountedFilesystem): Promise<Uint8Array> {
    return await filesystem.client.toImage();
  }

  async getUsage(filesystem: FfsMountedFilesystem): Promise<FfsFilesystemUsage | null> {
    if (!filesystem.client.getUsage) {
      return null;
    }

    const usage = await filesystem.client.getUsage();
    if (!usage) {
      return null;
    }

    const capacityBytes = Number(usage.capacityBytes || 0);
    const usedBytes = filesystem.type === 'fatfs'
      ? this.listFatfsEntries(filesystem.client).reduce((total, entry) => entry.type === 'file' ? total + Number(entry.size || 0) : total, 0)
      : Number(usage.usedBytes || 0);
    const freeBytes = capacityBytes > usedBytes ? capacityBytes - usedBytes : Number(usage.freeBytes || 0);
    return {
      capacityBytes,
      usedBytes,
      freeBytes,
      capacityText: this.formatBytes(capacityBytes),
      usedText: this.formatBytes(usedBytes),
      freeText: this.formatBytes(freeBytes),
      usedPercent: capacityBytes ? Math.min(100, Math.round(usedBytes / capacityBytes * 100)) : 0,
    };
  }

  normalizeFilePath(path: string, type: FfsFilesystemType): string {
    const normalized = this.normalizePath(path);
    const segments = normalized.split('/').filter(Boolean);
    if (!segments.length) {
      throw new Error('文件路径不能为空');
    }
    if (type === 'spiffs' && segments.length > 1) {
      throw new Error('SPIFFS 文件名不能包含目录');
    }
    return `/${segments.join('/')}`;
  }

  getDefaultUploadPath(fileName: string, type: FfsFilesystemType): string {
    const safeName = this.getDefaultUploadFileName(fileName);
    if (type === 'spiffs') {
      return `/${safeName}`;
    }
    return `/${safeName}`;
  }

  validateUploadFileName(fileName: string, type: FfsFilesystemType): string | null {
    const safeName = this.getDefaultUploadFileName(fileName);
    const byteLength = this.getUtf8ByteLength(safeName);
    const maxBytes = FILE_NAME_MAX_BYTES[type];
    if (byteLength <= maxBytes) {
      return null;
    }

    const originalName = fileName || 'file.bin';
    const safeNameNote = safeName === originalName
      ? ''
      : `（清理后文件名：${this.truncateName(safeName)}）`;
    return `${FILESYSTEM_LABELS[type]} 文件名过长${safeNameNote}：当前 ${byteLength} 字节，最多支持 ${maxBytes} 字节。请缩短文件名后再上传；中文通常每个字占 3 字节。`;
  }

  formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) {
      return '0 B';
    }
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex++;
    }
    const digits = value >= 10 || unitIndex === 0 ? 0 : 1;
    return `${value.toFixed(digits)} ${units[unitIndex]}`;
  }

  private async createClient(type: FfsFilesystemType, image: Uint8Array): Promise<any> {
    if (type === 'spiffs') {
      return await this.createSpiffsClient(image);
    }
    if (type === 'littlefs') {
      return await this.createLittlefsClient(image);
    }
    return await this.createFatfsClient(image);
  }

  private async createSpiffsClient(image: Uint8Array): Promise<any> {
    const { createSpiffsFromImage, createSpiffs } = await import('./wasm/spiffs/index.js');
    const wasmURL = this.getWasmUrl('spiffs/spiffs.wasm');

    // 若分区从未写入（全 0xFF），直接创建一个空的、已格式化的 SPIFFS，
    // 以便用户在「内容」面板里看到空文件列表并直接上传文件。
    if (this.isBlankImage(image)) {
      const blockSize = DEFAULT_BLOCK_SIZE;
      const blockCount = Math.max(1, Math.floor(image.length / blockSize));
      console.info('[FfsManager] SPIFFS 分区为空，自动初始化空文件系统');
      return await createSpiffs({
        wasmURL,
        pageSize: SPIFFS_PAGE_SIZE,
        blockSize,
        blockCount,
        formatOnInit: true,
      });
    }

    // 与 ESPConnect 一致：默认 pageSize=256 / blockSize=4096，先按默认尝试。
    let lastError: unknown;
    try {
      return await createSpiffsFromImage(image, { wasmURL });
    } catch (error) {
      lastError = error;
      console.warn('[FfsManager] SPIFFS 默认参数挂载失败，尝试候选 blockSize:', error);
    }
    for (const blockSize of BLOCK_SIZE_CANDIDATES) {
      if (blockSize === DEFAULT_BLOCK_SIZE) continue;
      if (image.length % blockSize !== 0) continue;
      try {
        return await createSpiffsFromImage(image, {
          wasmURL,
          pageSize: SPIFFS_PAGE_SIZE,
          blockSize,
          blockCount: image.length / blockSize,
        });
      } catch (error) {
        lastError = error;
      }
    }
    throw this.toSpiffsMountError(lastError, image);
  }

  private isBlankImage(image: Uint8Array): boolean {
    if (!image.length) return false;
    // 抽样检查首尾与中段，命中再做完整确认，避免大镜像每次都全量扫描。
    const samples = [0, image.length - 1, image.length >> 1];
    for (const i of samples) {
      if (image[i] !== 0xff) return false;
    }
    for (let i = 0; i < image.length; i++) {
      if (image[i] !== 0xff) return false;
    }
    return true;
  }

  private toSpiffsMountError(error: unknown, _image: Uint8Array): Error {
    const code = (error as any)?.code;
    const description = (error as any)?.description;
    const detail = error instanceof Error ? error.message : String(error || '');
    const codeText = typeof code === 'number' ? `（错误码 ${code}${description ? ` ${description}` : ''}）` : '';
    return new Error(`${detail || 'Failed to initialize SPIFFS from image'}${codeText}。可能是 SPIFFS 配置不匹配（pageSize/blockSize）或镜像数据损坏。`);
  }

  private async createLittlefsClient(image: Uint8Array): Promise<any> {
    const { createLittleFSFromImage, createLittleFS } = await import('./wasm/littlefs/index.js');
    const wasmURL = this.getWasmUrl('littlefs/littlefs.wasm');

    if (this.isBlankImage(image)) {
      const blockSize = DEFAULT_BLOCK_SIZE;
      const blockCount = Math.max(1, Math.floor(image.length / blockSize));
      console.info('[FfsManager] LittleFS 分区为空，自动初始化空文件系统');
      return await createLittleFS({ wasmURL, blockSize, blockCount, formatOnInit: true });
    }

    let lastError: unknown;
    for (const blockSize of BLOCK_SIZE_CANDIDATES) {
      if (image.length % blockSize !== 0) {
        continue;
      }
      try {
        return await createLittleFSFromImage(image, {
          wasmURL,
          blockSize,
          blockCount: image.length / blockSize,
        });
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('无法挂载 LittleFS 镜像');
  }

  private async createFatfsClient(image: Uint8Array): Promise<any> {
    const { createFatFSFromImage } = await import('./wasm/fatfs/index.js');
    return await createFatFSFromImage(image, {
      wasmURL: this.getWasmUrl('fatfs/fatfs.wasm'),
      blockSize: DEFAULT_BLOCK_SIZE,
    });
  }

  private listLittlefsEntries(client: any): any[] {
    const entries: any[] = [];
    const stack = ['/'];

    while (stack.length) {
      const currentPath = stack.pop() || '/';
      const listed = client.list(currentPath);
      for (const entry of listed) {
        entries.push(entry);
        if (entry.type === 'dir') {
          stack.push(entry.path);
        }
      }
    }

    return entries;
  }

  private listFatfsEntries(client: any): any[] {
    const entries: any[] = [];
    const stack = [FAT_MOUNT];

    while (stack.length) {
      const currentPath = stack.pop() || FAT_MOUNT;
      const listed = client.list(currentPath);
      for (const entry of listed) {
        entries.push(entry);
        if (entry.type === 'dir') {
          stack.push(entry.path);
        }
      }
    }

    return entries;
  }

  private normalizeEntry(type: FfsFilesystemType, entry: any): FfsFileEntry {
    let path = String(entry.path || entry.name || '');
    if (type === 'fatfs') {
      path = this.stripFatMount(path);
    }
    path = this.normalizePath(path);
    const segments = path.split('/').filter(Boolean);
    const name = String(entry.name || segments[segments.length - 1] || path);
    const entryType = entry.type === 'dir' ? 'dir' : 'file';
    const size = entryType === 'file' ? Number(entry.size || 0) : 0;

    return {
      name,
      path,
      type: entryType,
      size,
      sizeText: entryType === 'file' ? this.formatBytes(size) : '-',
    };
  }

  private ensureParentDirectories(filesystem: FfsMountedFilesystem, filePath: string): void {
    if (filesystem.type === 'spiffs') {
      return;
    }

    const segments = filePath.split('/').filter(Boolean);
    if (segments.length <= 1) {
      return;
    }

    let currentPath = '';
    for (const segment of segments.slice(0, -1)) {
      currentPath += `/${segment}`;
      try {
        filesystem.client.mkdir(this.toClientPath(filesystem.type, currentPath));
      } catch (error) {
        console.warn('[FfsFilesystem] 创建父目录失败或已存在:', currentPath, error);
      }
    }
  }

  private toClientPath(type: FfsFilesystemType, path: string): string {
    if (type === 'fatfs') {
      return this.hasFatMount(path) ? path : `${FAT_MOUNT}${path}`;
    }
    return path;
  }

  private normalizeDirectoryPath(path: string): string {
    const normalized = this.normalizePath(path);
    if (normalized === '/') {
      throw new Error('目录路径不能为空');
    }
    return normalized;
  }

  private normalizePath(path: string): string {
    const normalized = String(path || '')
      .trim()
      .replace(/\\/g, '/')
      .replace(/\/+/g, '/');
    const withoutFatMount = this.stripFatMount(normalized);
    const prefixed = withoutFatMount.startsWith('/') ? withoutFatMount : `/${withoutFatMount}`;
    const segments = prefixed.split('/').filter(Boolean);
    if (segments.some(segment => segment === '.' || segment === '..')) {
      throw new Error('路径不能包含 . 或 ..');
    }
    return segments.length ? `/${segments.join('/')}` : '/';
  }

  private stripFatMount(path: string): string {
    const normalized = String(path || '');
    if (normalized.toLowerCase() === FAT_MOUNT) {
      return '/';
    }
    if (this.hasFatMount(normalized)) {
      return normalized.slice(FAT_MOUNT.length) || '/';
    }
    return normalized;
  }

  private hasFatMount(path: string): boolean {
    const lowerPath = String(path || '').toLowerCase();
    return lowerPath === FAT_MOUNT || lowerPath.startsWith(`${FAT_MOUNT}/`);
  }

  private getDefaultUploadFileName(fileName: string): string {
    return this.sanitizePathSegment(fileName || 'file.bin');
  }

  private sanitizePathSegment(value: string): string {
    return String(value || 'file.bin').replace(/[\\/:*?"<>|]+/g, '_').replace(/^_+|_+$/g, '') || 'file.bin';
  }

  private getUtf8ByteLength(value: string): number {
    return new TextEncoder().encode(value).length;
  }

  private truncateName(value: string): string {
    const chars = Array.from(value);
    if (chars.length <= 48) {
      return value;
    }
    return `${chars.slice(0, 24).join('')}...${chars.slice(-21).join('')}`;
  }

  private getWasmUrl(path: string): string {
    return new URL(`ffs-manager/wasm/${path}`, document.baseURI).href;
  }
}
