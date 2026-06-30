import { AilyHost } from '../core/host';
import { normalizeChatSurfaceModeId } from '../core/chat-mode';
import { normalizeChatSessionTitleText, normalizePersistedChatSessionTitleSource } from '../core/chat-session-title';
import {
  normalizeHostSessionRequestRoutingSummary,
  resolveHostSessionRequestRoutingSummary,
} from '../helpers/host-session-request-routing';
import {
  normalizeHostSessionInteractionActionSummary,
  resolveHostSessionInteractionActionSummary,
} from '../helpers/host-session-interaction-action';
import {
  type HostSessionSelectedModeResolveOptions,
  normalizeHostSessionInputStateFromMetadata,
  resolveHostSessionModeDescriptor,
  resolveHostSessionModeDescriptorFromMetadata,
  resolveHostSessionInputState,
  resolveHostSessionSummaryModeFromMetadata,
  resolveHostSessionSelectedMode,
  resolveHostSessionSelectedModeFromMetadata,
} from '../helpers/host-session-input-state';

import type { HostSessionRecord, ProjectIndexEntry, SessionIndexEntry } from './chat-history.service';
import { countHostRecordMessages } from './chat-history.service';

export interface ChatHistoryIndexStoreOptions {
  indexFile: string;
  projectChatDir: string;
  getGlobalAilyDir: () => string;
  getCurrentProjectPath: () => string | null;
  joinPath: (...parts: string[]) => string;
  extractProjectName: (projectPath: string | null) => string | null;
  isSamePath: (a: string | null | undefined, b: string | null | undefined) => boolean;
  readHostRecord: (sessionId: string, projectPath: string | null) => HostSessionRecord | null;
  resolveModeById?: HostSessionSelectedModeResolveOptions['resolveModeById'];
  resolveModeByName?: HostSessionSelectedModeResolveOptions['resolveModeByName'];
}

export interface ChatHistoryIndexLoadDiagnostics {
  readonly projectIndexPatchedProjectPathCount: number;
  readonly rebuiltProjectEntryCount: number;
}

/**
 * Host-side index persistence adapter for chat history.
 *
 * Keeps global/project index IO and project-index reconstruction out of ChatHistoryService.
 */
export class ChatHistoryIndexStore {
  private latestLoadDiagnostics: ChatHistoryIndexLoadDiagnostics = {
    projectIndexPatchedProjectPathCount: 0,
    rebuiltProjectEntryCount: 0,
  };

  constructor(private readonly options: ChatHistoryIndexStoreOptions) {}

  loadMergedIndex(): SessionIndexEntry[] {
    this.latestLoadDiagnostics = {
      projectIndexPatchedProjectPathCount: 0,
      rebuiltProjectEntryCount: 0,
    };
    const globalIndex = this.loadGlobalIndex();
    return this.mergeProjectIndex(globalIndex);
  }

  getLatestLoadDiagnostics(): ChatHistoryIndexLoadDiagnostics {
    return { ...this.latestLoadDiagnostics };
  }

  mergeProjectIndex(index: SessionIndexEntry[], projectPath?: string | null): SessionIndexEntry[] {
    if (!this.hasFs()) return index;

    const prjPath = projectPath ?? this.options.getCurrentProjectPath();
    if (!prjPath) return index;

    const chatDir = this.options.joinPath(prjPath, this.options.projectChatDir);
    const projectIndexPath = this.options.joinPath(chatDir, this.options.indexFile);

    if (this.fileExists(projectIndexPath)) {
      return this.mergeProjectIndexFromFile(index, prjPath, projectIndexPath);
    }
    if (this.fileExists(chatDir)) {
      return this.rebuildProjectIndexFromDataFiles(index, prjPath, chatDir);
    }
    return index;
  }

  writeGlobalIndex(index: SessionIndexEntry[]): boolean {
    try {
      this.writeGlobalIndexOrThrow(index);
      return true;
    } catch (error) {
      console.warn('[ChatHistory] 写入全局索引失败:', error);
      return false;
    }
  }

  writeProjectIndex(index: SessionIndexEntry[], projectPath?: string | null): void {
    try {
      this.writeProjectIndexOrThrow(index, projectPath);
    } catch (error) {
      console.warn('[ChatHistory] 写入项目索引失败:', error);
    }
  }

  writeGlobalIndexOrThrow(index: SessionIndexEntry[]): void {
    if (!this.hasFs()) return;

    const globalDir = this.options.getGlobalAilyDir();
    const indexPath = this.options.joinPath(globalDir, this.options.indexFile);
    this.ensureDir(globalDir);
    this.writeFileSync(indexPath, JSON.stringify(index.map((entry) => this.normalizeIndexEntry(entry)), null, 2));
  }

  writeProjectIndexOrThrow(index: SessionIndexEntry[], projectPath?: string | null): void {
    if (!this.hasFs()) return;

    const prjPath = projectPath ?? this.options.getCurrentProjectPath();
    if (!prjPath) return;

    const projectEntries: ProjectIndexEntry[] = index
      .filter((entry) => this.options.isSamePath(entry.projectPath, prjPath))
      .map(({ projectPath: _pp, projectName: _pn, ...rest }) => {
        const selectedMode = resolveHostSessionSummaryModeFromMetadata(rest);
        const modeDescriptor = resolveHostSessionModeDescriptorFromMetadata(rest, this.getModeResolveOptions());
        const inputState = normalizeHostSessionInputStateFromMetadata(rest, this.getModeResolveOptions());
        const requestRouting = normalizeHostSessionRequestRoutingSummary(rest.requestRouting, selectedMode);
        const interactionActionSummary = normalizeHostSessionInteractionActionSummary(rest.interactionActionSummary);
        return {
          ...rest,
          mode: selectedMode.modeId,
          modeDescriptor,
          inputState,
          requestRouting,
          ...(interactionActionSummary ? { interactionActionSummary } : {}),
        };
      });

    if (projectEntries.length === 0) return;

    const dir = this.options.joinPath(prjPath, this.options.projectChatDir);
    this.ensureDir(dir);
    const projectIndexPath = this.options.joinPath(dir, this.options.indexFile);
    this.writeFileSync(projectIndexPath, JSON.stringify(projectEntries, null, 2));
  }

  private loadGlobalIndex(): SessionIndexEntry[] {
    if (!this.hasFs()) return [];

    try {
      const indexPath = this.options.joinPath(this.options.getGlobalAilyDir(), this.options.indexFile);
      if (!this.fileExists(indexPath)) {
        return [];
      }

      const content = this.readFileSync(indexPath);
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        console.log(`[ChatHistory] 全局索引已加载, ${parsed.length} 条记录`);
        return parsed.map((entry) => this.normalizeIndexEntry(entry as SessionIndexEntry));
      }
    } catch (error) {
      console.warn('[ChatHistory] 加载全局索引失败:', error);
    }

    return [];
  }

  private mergeProjectIndexFromFile(
    index: SessionIndexEntry[],
    prjPath: string,
    projectIndexPath: string,
  ): SessionIndexEntry[] {
    try {
      const content = this.readFileSync(projectIndexPath);
      const parsed = JSON.parse(content);
      if (!Array.isArray(parsed)) return index;

      const projectEntries: ProjectIndexEntry[] = parsed;
      const projectName = this.options.extractProjectName(prjPath);
      const indexMap = new Map<string, SessionIndexEntry>();
      for (const entry of index) {
        indexMap.set(entry.sessionId, entry);
      }

      for (const entry of projectEntries) {
        if (!('projectPath' in (entry as Record<string, unknown>)) || !(entry as Record<string, unknown>)['projectPath']) {
          this.latestLoadDiagnostics = {
            ...this.latestLoadDiagnostics,
            projectIndexPatchedProjectPathCount: this.latestLoadDiagnostics.projectIndexPatchedProjectPathCount + 1,
          };
        }
        indexMap.set(entry.sessionId, this.normalizeIndexEntry({
          ...entry,
          projectPath: prjPath,
          projectName,
        }));
      }

      const merged = Array.from(indexMap.values());
      console.log(`[ChatHistory] 已合并项目索引 (${projectEntries.length} 条), 总计 ${merged.length} 条`);
      return merged;
    } catch (error) {
      console.warn('[ChatHistory] 加载项目索引失败:', error);
      return index;
    }
  }

  private rebuildProjectIndexFromDataFiles(
    index: SessionIndexEntry[],
    prjPath: string,
    chatDir: string,
  ): SessionIndexEntry[] {
    try {
      const files: string[] = AilyHost.get().fs.readdirSync(chatDir);
      const sessionFiles = files.filter((file) => file.endsWith('.json') && file !== this.options.indexFile);
      if (sessionFiles.length === 0) return index;

      const projectName = this.options.extractProjectName(prjPath);
      const indexMap = new Map<string, SessionIndexEntry>();
      for (const entry of index) {
        indexMap.set(entry.sessionId, entry);
      }

      let rebuilt = 0;
      for (const file of sessionFiles) {
        const sessionId = file.replace(/\.json$/, '');
        const existing = indexMap.get(sessionId);
        if (existing && this.options.isSamePath(existing.projectPath, prjPath)) {
          continue;
        }

        const data = this.options.readHostRecord(sessionId, prjPath);
        if (!data?.metadata) {
          continue;
        }

        const selectedMode = resolveHostSessionSelectedMode(data, this.getModeResolveOptions());
        const modeDescriptor = resolveHostSessionModeDescriptor(data, this.getModeResolveOptions());
        const requestRouting = resolveHostSessionRequestRoutingSummary(data);
        const interactionActionSummary = resolveHostSessionInteractionActionSummary(data);

        indexMap.set(sessionId, {
          sessionId,
          title: data.metadata.title || '',
          ...(data.metadata.titleSource ? { titleSource: data.metadata.titleSource } : {}),
          ...(data.metadata.defaultTitle ? { defaultTitle: data.metadata.defaultTitle } : {}),
          projectPath: prjPath,
          projectName,
          createdAt: data.metadata.createdAt || Date.now(),
          updatedAt: data.metadata.updatedAt || Date.now(),
          messageCount: countHostRecordMessages(data),
          mode: selectedMode.modeId,
          modeDescriptor,
          inputState: resolveHostSessionInputState(data, this.getModeResolveOptions()),
          requestRouting,
          ...(interactionActionSummary ? { interactionActionSummary } : {}),
          model: data.metadata.model ?? null,
          dataAvailable: true,
        });
        rebuilt++;
      }

      const rebuiltIndex = Array.from(indexMap.values());
      if (rebuilt > 0) {
        this.latestLoadDiagnostics = {
          ...this.latestLoadDiagnostics,
          rebuiltProjectEntryCount: this.latestLoadDiagnostics.rebuiltProjectEntryCount + rebuilt,
        };
        this.writeProjectIndex(rebuiltIndex, prjPath);
        console.log(`[ChatHistory] 已从数据文件重建项目索引 (${rebuilt} 条), 总计 ${rebuiltIndex.length} 条`);
      }
      return rebuiltIndex;
    } catch (error) {
      console.warn('[ChatHistory] 重建项目索引失败:', error);
      return index;
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

  private normalizeIndexEntry(entry: SessionIndexEntry): SessionIndexEntry {
    const selectedMode = resolveHostSessionSummaryModeFromMetadata(entry);
    const modeDescriptor = resolveHostSessionModeDescriptorFromMetadata(entry, this.getModeResolveOptions());
    const inputState = normalizeHostSessionInputStateFromMetadata(entry, this.getModeResolveOptions());
    const requestRouting = normalizeHostSessionRequestRoutingSummary(entry.requestRouting, selectedMode);
    const interactionActionSummary = normalizeHostSessionInteractionActionSummary(entry.interactionActionSummary);

    const normalizedEntry: SessionIndexEntry = {
      ...entry,
      title: normalizeChatSessionTitleText(entry.title),
      mode: normalizeChatSurfaceModeId(selectedMode.modeId),
      modeDescriptor,
      inputState,
      requestRouting,
      ...(interactionActionSummary ? { interactionActionSummary } : {}),
      model: entry.model ?? null,
    };

    normalizedEntry.titleSource = normalizedEntry.title
      ? normalizePersistedChatSessionTitleSource(entry.titleSource)
      : undefined;
    normalizedEntry.defaultTitle = normalizeChatSessionTitleText(entry.defaultTitle) || undefined;
    if (!normalizedEntry.titleSource) {
      delete normalizedEntry.titleSource;
    }
    if (!normalizedEntry.defaultTitle) {
      delete normalizedEntry.defaultTitle;
    }

    return normalizedEntry;
  }

  private ensureDir(dirPath: string): void {
    if (!this.fileExists(dirPath)) {
      AilyHost.get().fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  private getModeResolveOptions(): HostSessionSelectedModeResolveOptions | undefined {
    return this.options.resolveModeById || this.options.resolveModeByName
      ? {
          ...(this.options.resolveModeById ? { resolveModeById: this.options.resolveModeById } : {}),
          ...(this.options.resolveModeByName ? { resolveModeByName: this.options.resolveModeByName } : {}),
        }
      : undefined;
  }
}
