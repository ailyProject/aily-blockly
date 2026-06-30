import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';

import { buildImportedDebugSessionViewModel, type ImportedDebugSessionViewModel } from '../helpers/chat-debug-viewer-state';
import {
  resolveHostSessionDebugEventContent,
  type HostSessionDebugEvent,
  type HostSessionDebugResolvedEventContent,
  type HostSessionDebugResolvedTextContent,
} from './host-session-debug-events';
import type { ImportedDebugSessionRecord } from './chat-history.service';
import { ChatHistoryService } from './chat-history.service';

export enum ChatDebugBrowserViewState {
  Home = 'home',
  Overview = 'overview',
  Logs = 'logs',
  FlowChart = 'flowchart',
  CacheExplorer = 'cache',
}

export interface ImportedDebugResourceSummary {
  readonly sessionId: string;
  readonly sourceSessionId: string;
  readonly title: string;
  readonly displayTitle: string;
  readonly importedAt: number;
}

@Injectable({
  providedIn: 'root',
})
export class ChatDebugBrowserService {
  private isDebugBrowserOpen = false;
  private currentViewState = ChatDebugBrowserViewState.Home;
  private currentImportedResource: ImportedDebugSessionRecord | null = null;
  private lastOpenedImportedSessionId: string | null = null;
  private readonly didChangeSubject = new Subject<void>();
  readonly onDidChange = this.didChangeSubject.asObservable();

  constructor(
    private readonly chatHistoryService: ChatHistoryService,
  ) {
    this.chatHistoryService.hostSessionChanged$?.subscribe((event) => {
      this.handleHostSessionStoreChange(event);
    });
  }

  get isOpen(): boolean {
    return this.isDebugBrowserOpen;
  }

  get viewState(): ChatDebugBrowserViewState {
    return this.currentViewState;
  }

  get activeSessionId(): string | null {
    return this.currentImportedResource?.sessionId ?? null;
  }

  get activeImportedResource(): ImportedDebugSessionRecord | null {
    return this.currentImportedResource;
  }

  get activeImportedDebugView(): ImportedDebugSessionViewModel | null {
    const currentSession = this.currentImportedResource;
    return currentSession ? buildImportedDebugSessionViewModel(currentSession) : null;
  }

  get activeImportedDebugEvents(): readonly HostSessionDebugEvent[] {
    return this.currentImportedResource?.debugEvents ?? [];
  }

  get activeImportedResourceSummary(): ImportedDebugResourceSummary | null {
    return this.currentImportedResource ? summarizeImportedDebugResource(this.currentImportedResource) : null;
  }

  resolveActiveImportedDebugEventContent(eventId: string): HostSessionDebugResolvedEventContent | null {
    const currentSession = this.currentImportedResource;
    if (!currentSession) {
      return null;
    }

    const importedAugmentationContent = resolveImportedDebugAugmentationContent(currentSession, eventId);
    if (importedAugmentationContent) {
      return importedAugmentationContent;
    }

    return resolveHostSessionDebugEventContent(currentSession.hostRecord, eventId, {
      events: currentSession.debugEvents,
      readCompanionFile: currentSession.debugCompanionFiles
        ? (fileName: string) => currentSession.debugCompanionFiles?.[fileName]
        : undefined,
    }) ?? null;
  }

  listAvailableResources(): readonly ImportedDebugResourceSummary[] {
    const resources = this.chatHistoryService.listImportedDebugSnapshots().map(summarizeImportedDebugResource);
    return bubbleImportedResourcesToTop(resources, this.lastOpenedImportedSessionId, this.activeSessionId);
  }

  openHome(): void {
    this.isDebugBrowserOpen = true;
    this.currentImportedResource = null;
    this.currentViewState = ChatDebugBrowserViewState.Home;
    this.notifyDidChange();
  }

  openImportedRecord(
    record: ImportedDebugSessionRecord,
    viewState: ChatDebugBrowserViewState = ChatDebugBrowserViewState.Overview,
  ): void {
    this.isDebugBrowserOpen = true;
    this.currentImportedResource = record;
    this.lastOpenedImportedSessionId = record.sessionId;
    this.currentViewState = viewState;
    this.notifyDidChange();
  }

  openImportedSession(
    sessionId: string,
    viewState: ChatDebugBrowserViewState = ChatDebugBrowserViewState.Overview,
  ): boolean {
    const record = this.chatHistoryService.getImportedDebugSnapshot(sessionId);
    if (!record) {
      return false;
    }

    this.openImportedRecord(record, viewState);
    return true;
  }

  close(): void {
    this.isDebugBrowserOpen = false;
    this.currentImportedResource = null;
    this.currentViewState = ChatDebugBrowserViewState.Home;
    this.notifyDidChange();
  }

  showView(viewState: ChatDebugBrowserViewState): void {
    if (viewState === ChatDebugBrowserViewState.Home) {
      this.openHome();
      return;
    }

    if (!this.currentImportedResource) {
      return null;
    }

    this.currentViewState = viewState;
    this.notifyDidChange();
  }

  private handleHostSessionStoreChange(event: { readonly sessionId: string; readonly scope: 'persisted' | 'imported'; readonly kind: 'updated' | 'deleted' }): void {
    if (event.scope !== 'imported') {
      return;
    }

    let didChange = this.isDebugBrowserOpen && this.currentViewState === ChatDebugBrowserViewState.Home;
    if (this.currentImportedResource?.sessionId === event.sessionId) {
      if (event.kind === 'deleted') {
        this.currentImportedResource = null;
        this.currentViewState = ChatDebugBrowserViewState.Home;
        this.isDebugBrowserOpen = true;
      } else {
        this.currentImportedResource = this.chatHistoryService.getImportedDebugSnapshot(event.sessionId);
        if (!this.currentImportedResource) {
          this.currentViewState = ChatDebugBrowserViewState.Home;
        }
      }
      didChange = true;
    }

    if (didChange) {
      this.notifyDidChange();
    }
  }

  private notifyDidChange(): void {
    this.didChangeSubject.next();
  }
}

function summarizeImportedDebugResource(record: ImportedDebugSessionRecord): ImportedDebugResourceSummary {
  return {
    sessionId: record.sessionId,
    sourceSessionId: record.sourceSessionId,
    title: record.title,
    displayTitle: getImportedResourceDisplayTitle(record.title),
    importedAt: record.importedAt,
  };
}

function getImportedResourceDisplayTitle(title: string): string {
  const normalizedTitle = title.trim();
  return normalizedTitle ? `导入: ${normalizedTitle}` : '新聊天';
}

function bubbleImportedResourcesToTop(
  resources: readonly ImportedDebugResourceSummary[],
  lastOpenedSessionId: string | null,
  activeSessionId: string | null,
): readonly ImportedDebugResourceSummary[] {
  const nextResources = [...resources];

  const bubbleToTop = (sessionId: string | null) => {
    if (!sessionId) {
      return;
    }

    const index = nextResources.findIndex(resource => resource.sessionId === sessionId);
    if (index > 0) {
      const [resource] = nextResources.splice(index, 1);
      nextResources.unshift(resource);
    }
  };

  bubbleToTop(lastOpenedSessionId);
  bubbleToTop(activeSessionId);

  return nextResources;
}

function resolveImportedDebugAugmentationContent(
  record: ImportedDebugSessionRecord,
  eventId: string,
): HostSessionDebugResolvedTextContent | null {
  const event = record.debugEvents.find(candidate => candidate.id === eventId);
  if (!event || event.kind !== 'generic') {
    return null;
  }

  switch (event.name) {
    case 'Dual persistence boundary':
      return record.debugDualPersistence
        ? buildImportedDebugSummaryTextContent(record.debugDualPersistence)
        : null;
    case 'Live runtime overlay':
      return record.debugLiveRuntimeOverlay
        ? buildImportedDebugSummaryTextContent(record.debugLiveRuntimeOverlay)
        : null;
    case 'Restore Diagnostics':
      return record.debugRestoreDiagnostics
        ? buildImportedDebugSummaryTextContent(record.debugRestoreDiagnostics)
        : null;
    case 'Restore Failure':
      return record.debugRestoreFailure
        ? buildImportedDebugSummaryTextContent(record.debugRestoreFailure)
        : null;
    default:
      return null;
  }
}

function buildImportedDebugSummaryTextContent(summary: unknown): HostSessionDebugResolvedTextContent {
  return {
    kind: 'text',
    text: JSON.stringify(summary, null, 2),
  };
}
