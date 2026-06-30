import type { IAilyHostAPI, IDirent, IFileSystem } from '../../core/host-api';
import { resolveBlocklyMemoryStorageRoots } from '../../helpers/chat-memory-host';
import type {
  ChatMemoryEntry,
  ChatMemoryScope,
} from './memory-manager.types';

const MEMORY_FILE_EXTENSION = '.md';

interface ChatMemoryStorageContext {
  readonly projectPath?: string;
  readonly sessionId?: string;
}

export class ChatMemoryStorage {
  constructor(
    private readonly host: Pick<IAilyHostAPI, 'fs' | 'path' | 'project'>,
    private readonly projectPath: string,
    private readonly sessionId?: string,
  ) {}

  listEntries(
    scope: ChatMemoryScope,
    context?: ChatMemoryStorageContext,
  ): ChatMemoryEntry[] {
    const scopeDir = this.resolveScopeDir(scope, context);
    if (!scopeDir || !this.host.fs.existsSync(scopeDir)) {
      return [];
    }

    return this.readFilePaths(scopeDir)
      .map((relativePath) => this.readEntry(scope, scopeDir, relativePath))
      .sort((left, right) => {
        if (right.updatedAt !== left.updatedAt) {
          return right.updatedAt - left.updatedAt;
        }

        return left.fileName.localeCompare(right.fileName);
      });
  }

  createEntry(
    scope: ChatMemoryScope,
    context?: ChatMemoryStorageContext,
  ): ChatMemoryEntry {
    const scopeDir = this.requireScopeDir(scope, context);
    this.ensureDir(scopeDir);
    const fileName = this.createUniqueFileName(scopeDir);
    const absolutePath = this.host.path.join(scopeDir, fileName);
    this.host.fs.writeFileSync(absolutePath, '', 'utf-8');
    return this.readEntry(scope, scopeDir, fileName);
  }

  saveEntry(entry: ChatMemoryEntry, content: string): ChatMemoryEntry {
    this.host.fs.writeFileSync(entry.absolutePath, content, 'utf-8');
    const stat = this.host.fs.statSync(entry.absolutePath);
    return {
      ...entry,
      content,
      updatedAt: stat.mtime.getTime(),
    };
  }

  deleteEntry(entry: ChatMemoryEntry): void {
    if (!this.host.fs.existsSync(entry.absolutePath)) {
      return;
    }

    this.host.fs.unlinkSync(entry.absolutePath);
  }

  private readEntry(
    scope: ChatMemoryScope,
    scopeDir: string,
    relativePath: string,
  ): ChatMemoryEntry {
    const absolutePath = this.host.path.join(scopeDir, relativePath);
    const stat = this.host.fs.statSync(absolutePath);
    const content = this.host.fs.readFileSync(absolutePath, 'utf-8');
    const fileName = this.host.path.basename(relativePath);

    return {
      scope,
      absolutePath,
      publicPath: `${this.getPublicPrefix(scope)}${relativePath}`,
      relativePath,
      fileName,
      content,
      updatedAt: stat.mtime.getTime(),
    };
  }

  private resolveScopeDir(
    scope: ChatMemoryScope,
    context?: ChatMemoryStorageContext,
  ): string | undefined {
    const roots = resolveBlocklyMemoryStorageRoots(
      this.host,
      context?.projectPath ?? this.projectPath,
      context?.sessionId ?? this.sessionId,
    );
    if (!roots) {
      return undefined;
    }

    switch (scope) {
      case 'global':
        return roots.userDir;
      case 'project':
        return roots.repoDir;
      case 'session':
        return roots.sessionDir;
      default:
        return undefined;
    }
  }

  private requireScopeDir(
    scope: ChatMemoryScope,
    context?: ChatMemoryStorageContext,
  ): string {
    const scopeDir = this.resolveScopeDir(scope, context);
    if (!scopeDir) {
      throw new Error(`Memory scope is unavailable: ${scope}`);
    }

    return scopeDir;
  }

  private getPublicPrefix(scope: ChatMemoryScope): string {
    switch (scope) {
      case 'global':
        return '/memories/';
      case 'project':
        return '/memories/repo/';
      case 'session':
        return '/memories/session/';
      default:
        return '/memories/';
    }
  }

  private createUniqueFileName(scopeDir: string): string {
    const baseName = this.createGeneratedFileName();
    let candidate = baseName;
    let index = 2;

    while (
      this.host.fs.existsSync(this.host.path.join(scopeDir, candidate))
    ) {
      const nameWithoutExt = baseName.slice(0, -MEMORY_FILE_EXTENSION.length);
      candidate = `${nameWithoutExt}-${index}${MEMORY_FILE_EXTENSION}`;
      index += 1;
    }

    return candidate;
  }

  private createGeneratedFileName(): string {
    return `memory-${Date.now()}${MEMORY_FILE_EXTENSION}`;
  }

  private ensureDir(dirPath: string): void {
    if (!this.host.fs.existsSync(dirPath)) {
      this.host.fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  private readFilePaths(dirPath: string, baseDirPath = dirPath): string[] {
    const entries = readDirEntries(this.host.fs, dirPath);
    const filePaths: string[] = [];

    for (const entry of entries) {
      if (entry.name.startsWith('.')) {
        continue;
      }

      const absolutePath = this.host.path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        filePaths.push(...this.readFilePaths(absolutePath, baseDirPath));
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      filePaths.push(this.host.path.relative(baseDirPath, absolutePath));
    }

    return filePaths;
  }
}

function readDirEntries(
  fs: Pick<IFileSystem, 'readdirSync' | 'readDirSync' | 'statSync'>,
  dirPath: string,
): IDirent[] {
  if (fs.readDirSync) {
    return fs.readDirSync(dirPath);
  }

  return fs.readdirSync(dirPath).map((name) => ({
    name,
    isDirectory: () => fs.statSync(`${dirPath}/${name}`).isDirectory(),
    isFile: () => fs.statSync(`${dirPath}/${name}`).isFile(),
  }));
}
