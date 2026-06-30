import { AilyHost } from '../core/host';

import type { HostSessionRecord, SessionIndexEntry } from './chat-history.service';
import { HostSessionRecordStore } from './host-session-record-store';

export interface HostSessionAdoptionBridgeOptions {
  projectChatDir: string;
  joinPath: (...parts: string[]) => string;
  extractProjectName: (projectPath: string | null) => string | null;
  isSamePath: (a: string | null | undefined, b: string | null | undefined) => boolean;
  deleteSessionFile: (sessionId: string, projectPath: string | null) => void;
  deleteSessionFileOrThrow: (sessionId: string, projectPath: string | null) => void;
}

/**
 * Host-side orphan session migration adapter.
 *
 * Keeps project adoption and orphan arch migration out of ChatHistoryService.
 */
export class HostSessionAdoptionBridge {
  constructor(
    private readonly hostRecordStore: HostSessionRecordStore,
    private readonly options: HostSessionAdoptionBridgeOptions,
  ) {}

  adoptOrphanSessions(
    index: SessionIndexEntry[],
    sessionCache: Map<string, HostSessionRecord>,
    projectPath: string,
    rootPath?: string | null,
  ): number {
    if (!projectPath) return 0;

    const orphans = index.filter((entry) =>
      entry.projectPath === null
      || (rootPath
        && this.options.isSamePath(entry.projectPath, rootPath)
        && !this.options.isSamePath(rootPath, projectPath))
    );
    if (orphans.length === 0) return 0;

    const projectName = this.options.extractProjectName(projectPath);
    for (const entry of orphans) {
      this.adoptEntry(entry, sessionCache, projectPath, projectName, rootPath);
    }

    console.log(`[ChatHistory] 已将 ${orphans.length} 个孤儿会话迁移到项目: ${projectPath}`);
    return orphans.length;
  }

  adoptSingleGlobalSession(
    index: SessionIndexEntry[],
    sessionCache: Map<string, HostSessionRecord>,
    sessionId: string,
    projectPath: string,
    rootPath?: string | null,
  ): boolean {
    if (!sessionId || !projectPath) return false;

    const entry = index.find(item => item.sessionId === sessionId);
    if (!entry) return false;

    const oldProjectPath = entry.projectPath;
    const isGlobalEntry = oldProjectPath === null
      || (rootPath
        && this.options.isSamePath(oldProjectPath, rootPath)
        && !this.options.isSamePath(rootPath, projectPath));
    if (!isGlobalEntry) return false;

    this.adoptEntry(
      entry,
      sessionCache,
      projectPath,
      this.options.extractProjectName(projectPath),
      rootPath,
    );
    return true;
  }

  private adoptEntry(
    entry: SessionIndexEntry,
    sessionCache: Map<string, HostSessionRecord>,
    projectPath: string,
    projectName: string | null,
    rootPath?: string | null,
  ): void {
    const oldProjectPath = entry.projectPath;
    const data = sessionCache.get(entry.sessionId)
      || this.hostRecordStore.read(entry.sessionId, oldProjectPath);
    const previousEntry = JSON.parse(JSON.stringify(entry)) as SessionIndexEntry;
    const previousRecord = data
      ? JSON.parse(JSON.stringify(data)) as HostSessionRecord
      : null;

    entry.projectPath = projectPath;
    entry.projectName = projectName;
    entry.updatedAt = Date.now();

    try {
      if (data) {
        data.metadata.projectPath = projectPath;
        data.metadata.updatedAt = entry.updatedAt;
        sessionCache.set(entry.sessionId, data);

        this.hostRecordStore.writeOrThrow(entry.sessionId, data);
        this.options.deleteSessionFileOrThrow(entry.sessionId, oldProjectPath);
        if (oldProjectPath !== null) {
          this.options.deleteSessionFileOrThrow(entry.sessionId, null);
        }
      }

      this.migrateOrphanArch(entry.sessionId, projectPath, rootPath);
    } catch (error) {
      this.rollbackAdoption(entry, sessionCache, previousEntry, previousRecord, projectPath);
      throw error;
    }
  }

  private rollbackAdoption(
    entry: SessionIndexEntry,
    sessionCache: Map<string, HostSessionRecord>,
    previousEntry: SessionIndexEntry,
    previousRecord: HostSessionRecord | null,
    adoptedProjectPath: string,
  ): void {
    entry.projectPath = previousEntry.projectPath ?? null;
    entry.projectName = previousEntry.projectName;
    entry.updatedAt = previousEntry.updatedAt;
    entry.title = previousEntry.title;
    entry.titleSource = previousEntry.titleSource;
    entry.defaultTitle = previousEntry.defaultTitle;
    entry.messageCount = previousEntry.messageCount;
    entry.mode = previousEntry.mode;
    entry.modeDescriptor = previousEntry.modeDescriptor;
    entry.inputState = previousEntry.inputState;
    entry.requestRouting = previousEntry.requestRouting;
    entry.interactionActionSummary = previousEntry.interactionActionSummary;
    entry.model = previousEntry.model;
    entry.sessionType = previousEntry.sessionType;
    entry.sessionScopeSchemaVersion = previousEntry.sessionScopeSchemaVersion;
    entry.dataAvailable = previousEntry.dataAvailable;

    if (!previousRecord) {
      sessionCache.delete(entry.sessionId);
      this.options.deleteSessionFile(entry.sessionId, adoptedProjectPath);
      return;
    }

    sessionCache.set(entry.sessionId, previousRecord);
    try {
      this.hostRecordStore.writeOrThrow(entry.sessionId, previousRecord);
    } catch (rollbackError) {
      console.warn(`[ChatHistory] 回滚收养记录失败 (${entry.sessionId}):`, rollbackError);
    }

    this.options.deleteSessionFile(entry.sessionId, adoptedProjectPath);
  }

  private migrateOrphanArch(sessionId: string, projectPath: string, rootPath?: string | null): void {
    if (!rootPath || !this.hasFs()) return;

    const orphanArchPath = this.options.joinPath(rootPath, this.options.projectChatDir, `${sessionId}_arch.md`);
    if (!this.fileExists(orphanArchPath)) return;

    try {
      const content = this.readFileSync(orphanArchPath);
      const targetArchPath = this.options.joinPath(projectPath, 'arch.md');
      this.ensureDir(projectPath);
      this.writeFileSync(targetArchPath, content);
      AilyHost.get().fs.unlinkSync(orphanArchPath);
      console.log(`[ChatHistory] 已迁移孤儿 arch: ${sessionId}_arch.md → ${projectPath}/arch.md`);
    } catch (error) {
      console.warn(`[ChatHistory] 迁移孤儿 arch 失败 (${sessionId}):`, error);
    }
  }

  private hasFs(): boolean {
    return typeof window !== 'undefined' && !!AilyHost.get().fs;
  }

  private fileExists(path: string): boolean {
    try {
      return AilyHost.get().fs.existsSync(path);
    } catch {
      return false;
    }
  }

  private readFileSync(path: string): string {
    return AilyHost.get().fs.readFileSync(path, 'utf-8');
  }

  private writeFileSync(path: string, content: string): void {
    AilyHost.get().fs.writeFileSync(path, content, 'utf-8');
  }

  private ensureDir(dirPath: string): void {
    if (!this.fileExists(dirPath)) {
      AilyHost.get().fs.mkdirSync(dirPath, { recursive: true });
    }
  }
}
