import { Injectable } from '@angular/core';
import { NzModalService } from 'ng-zorro-antd/modal';

import { AilyHost } from '../core/host';
import { ChatDeleteDialogComponent } from '../components/chat-delete-dialog/chat-delete-dialog.component';
import { ChatRenameDialogComponent } from '../components/chat-rename-dialog/chat-rename-dialog.component';
import type { ChatSessionListItem } from './menu-manager.service';
import { ChatSessionItemsService } from './chat-session-items.service';
import { ChatSessionSelectionService } from './chat-session-selection.service';

export interface ChatSessionRowActionCallbacks {
  onSwitchSession: (sessionId: string, fallbackProjectPath?: string | null) => Promise<boolean>;
  onNewChat: () => void | Promise<void>;
  onEnterEntryState: (sessionId?: string | null) => void | Promise<void>;
  isSessionRequestInProgress: (sessionId: string) => boolean;
  onDeleteSession: (sessionId: string) => Promise<boolean>;
  onDetectChanges: () => void;
  onUpdateTitle: (title: string) => void;
  onRefreshSessions: () => void;
}

export interface ChatSessionSwitchCallbacks {
  onSaveCurrentSession: () => void;
  onSwitchSession: (sessionId: string, fallbackProjectPath?: string | null) => Promise<boolean>;
  onSetCompleted: () => void;
  onSetServerSessionInactive: () => void;
}

export interface ChatSessionCommandCallbacks {
  onNewChat: () => void | Promise<void>;
  onImportDebugSnapshot: () => void | Promise<void>;
}

export interface ChatSessionEntryCommandCallbacks {
  onEnterEntryState: (sessionId?: string | null) => void | Promise<void>;
}

export interface ChatSessionSwitchRequestCallbacks extends ChatSessionSwitchCallbacks {
  onCloseSessionPicker: () => void;
}

export interface ChatSessionCommandRequestCallbacks extends ChatSessionCommandCallbacks {
  onSaveCurrentSession: () => void;
}

export interface ChatSessionEntryCommandRequestCallbacks extends ChatSessionEntryCommandCallbacks {
  onSaveCurrentSession: () => void;
}

type ChatSessionSelectionItem = Pick<
  ChatSessionListItem,
  'sessionId' | 'projectPath' | 'sessionType' | 'title' | 'mode' | 'requestRouting' | 'inputState'
>;

@Injectable()
export class ChatSessionActionsService {
  constructor(
    private readonly modal: NzModalService,
    private readonly chatSessionItemsService: ChatSessionItemsService,
    private readonly chatSessionSelectionService: ChatSessionSelectionService,
  ) {}

  async requestSwitchToSession(
    sessionId: string,
    currentSessionId: string,
    callbacks: ChatSessionSwitchRequestCallbacks,
    selectionItem?: ChatSessionSelectionItem,
  ): Promise<void> {
    const onSwitch = async () => {
      callbacks.onCloseSessionPicker();
      await this.switchToSession(sessionId, currentSessionId, callbacks, selectionItem);
    };

    await onSwitch();
  }

  async requestNewChat(
    callbacks: ChatSessionCommandRequestCallbacks,
  ): Promise<void> {
    await this.newChat(callbacks);
  }

  async requestImportDebugSnapshot(
    callbacks: ChatSessionCommandRequestCallbacks,
  ): Promise<void> {
    await this.importDebugSnapshot(callbacks);
  }

  async requestReturnToEntryInventory(
    callbacks: ChatSessionEntryCommandRequestCallbacks,
    sessionId?: string | null,
    options?: { readonly saveCurrentSession?: boolean },
  ): Promise<void> {
    if (options?.saveCurrentSession !== false) {
      callbacks.onSaveCurrentSession();
    }
    await this.enterEntryInventory(callbacks, sessionId);
  }

  sessionActionClick(
    e: { action: string; data: any },
    currentSessionId: string,
    callbacks: ChatSessionRowActionCallbacks,
  ): void {
    const { action, data } = e;
    const sessionId = data?.sessionId;
    if (!sessionId) {
      return;
    }

    const sessionItemController = this.chatSessionItemsService.sessionItemController;

    if (action === 'rename-session') {
      const modalRef = this.modal.create({
        nzTitle: null,
        nzFooter: null,
        nzClosable: false,
        nzBodyStyle: { padding: '0' },
        nzWidth: 340,
        nzContent: ChatRenameDialogComponent,
        nzData: { currentName: data?.title || data?.name || '' },
      });
      modalRef.afterClose.subscribe((result: { result: string } | null) => {
        if (!result?.result) {
          return;
        }
        sessionItemController.renameChatSessionItem(sessionId, result.result);
        if (sessionId === currentSessionId) {
          callbacks.onUpdateTitle(result.result);
        }
        callbacks.onRefreshSessions();
        callbacks.onDetectChanges();
      });
      return;
    }

    if (action === 'pin-session' || action === 'unpin-session') {
      sessionItemController.setSessionPinned(sessionId, action === 'pin-session');
      callbacks.onRefreshSessions();
      callbacks.onDetectChanges();
      return;
    }

    if (action === 'mark-session-read' || action === 'mark-session-unread') {
      sessionItemController.setSessionRead(sessionId, action === 'mark-session-read');
      callbacks.onRefreshSessions();
      callbacks.onDetectChanges();
      return;
    }

    if (action === 'archive-session' || action === 'unarchive-session') {
      sessionItemController.setSessionArchived(sessionId, action === 'archive-session');
      callbacks.onRefreshSessions();
      callbacks.onDetectChanges();
      return;
    }

    if (action !== 'delete-session') {
      return;
    }

    const name = data?.title || data?.name || sessionId;
    const requestInProgress = callbacks.isSessionRequestInProgress(sessionId)
      || data?.status === 'in_progress'
      || data?.status === 'needs_input';
    const modalRef = this.modal.create({
      nzTitle: null,
      nzFooter: null,
      nzClosable: false,
      nzBodyStyle: { padding: '0' },
      nzWidth: 340,
      nzContent: ChatDeleteDialogComponent,
      nzData: { name, requestInProgress },
    });
    modalRef.afterClose.subscribe((result: { confirmed: boolean } | null) => {
      if (!result?.confirmed) {
        return;
      }

      void (async () => {
        const deleted = await callbacks.onDeleteSession(sessionId);
        if (!deleted) {
          return;
        }

        const isDeletingCurrent = sessionId === currentSessionId;
        callbacks.onRefreshSessions();
        callbacks.onDetectChanges();
        if (!isDeletingCurrent) {
          return;
        }

        // The cached list is committed after paint and can still contain the
        // deleted row here. Resolve the next target from canonical inventory
        // instead of racing the list renderer's projection cache.
        const remaining = this.chatSessionItemsService.readSessionViewItems()
          .find(item => item.sessionId !== sessionId);
        if (remaining?.sessionId) {
          await this.switchToSession(
            remaining.sessionId,
            currentSessionId,
            {
              onSaveCurrentSession: () => undefined,
              onSwitchSession: callbacks.onSwitchSession,
              onSetCompleted: () => undefined,
              onSetServerSessionInactive: () => undefined,
            },
            remaining,
            {
              saveCurrentSession: false,
              discardCurrentSession: false,
            },
          );
          return;
        }

        await callbacks.onEnterEntryState(sessionId);
      })().catch(error => {
        console.warn('[ChatSessionActionsService] failed to delete session cleanly:', error);
      });
    });
  }

  async switchToSession(
    sessionId: string,
    currentSessionId: string,
    callbacks: ChatSessionSwitchCallbacks,
    selectionItem?: ChatSessionSelectionItem,
    options: {
      readonly saveCurrentSession?: boolean;
      readonly discardCurrentSession?: boolean;
    } = {},
  ): Promise<boolean> {
    if (currentSessionId === sessionId) {
      return false;
    }

    const sessionItemController = this.chatSessionItemsService.sessionItemController;
    const fallbackProjectPath = this.resolveSelectionProjectPath(selectionItem);
    if (options.saveCurrentSession !== false) {
      callbacks.onSaveCurrentSession();
    }

    const switched = await callbacks.onSwitchSession(sessionId, fallbackProjectPath);
    if (!switched) {
      return false;
    }

    if (options.discardCurrentSession !== false) {
      const hasLiveCurrentRuntime = this.chatSessionItemsService.readSessionListItems()
        .some(item => item.sessionId === currentSessionId && (item.status === 'in_progress' || item.status === 'needs_input'));
      if (!hasLiveCurrentRuntime) {
        sessionItemController.discardChatSessionItem(currentSessionId);
      }
    }
    this.chatSessionSelectionService.selectSession(sessionId);
    sessionItemController.setSessionRead(sessionId, true, fallbackProjectPath);
    callbacks.onSetCompleted();
    callbacks.onSetServerSessionInactive();
    return true;
  }

  async newChat(callbacks: ChatSessionCommandCallbacks): Promise<void> {
    await callbacks.onNewChat();
  }

  async importDebugSnapshot(callbacks: ChatSessionCommandCallbacks): Promise<void> {
    await callbacks.onImportDebugSnapshot();
  }

  async enterEntryInventory(
    callbacks: ChatSessionEntryCommandCallbacks,
    sessionId?: string | null,
  ): Promise<void> {
    await callbacks.onEnterEntryState(sessionId);
  }

  private resolveCurrentProjectPath(): string | null {
    const currentProjectPath = AilyHost.get().project.currentProjectPath;
    const projectRootPath = AilyHost.get().project.projectRootPath;
    return currentProjectPath && currentProjectPath !== projectRootPath
      ? currentProjectPath
      : projectRootPath || null;
  }

  private resolveSelectionProjectPath(selectionItem?: ChatSessionSelectionItem): string | null {
    if (typeof selectionItem?.projectPath === 'string' && selectionItem.projectPath.trim().length > 0) {
      return selectionItem.projectPath.trim();
    }

    return this.resolveCurrentProjectPath();
  }

}
