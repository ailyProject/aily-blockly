import { Injectable } from '@angular/core';
import { NzModalService } from 'ng-zorro-antd/modal';

import { AilyHost } from '../core/host';
import type { DialogTurnContext } from '../core/user-turn-action-target';
import { ChatDeleteDialogComponent } from '../components/chat-delete-dialog/chat-delete-dialog.component';
import { ChatRenameDialogComponent } from '../components/chat-rename-dialog/chat-rename-dialog.component';
import { UnsavedEditsDialogComponent } from '../components/unsaved-edits-dialog/unsaved-edits-dialog.component';
import type { ChatSessionListItem } from './menu-manager.service';
import { ChatSessionItemsService } from './chat-session-items.service';
import { ChatSessionSelectionService } from './chat-session-selection.service';

interface EditSummaryLike {
  fileCount: number;
  turnContext?: DialogTurnContext | null;
}

interface EditCheckpointServiceLike {
  hasUnsavedEdits(): boolean;
  getEditsSummary(): Promise<EditSummaryLike | null>;
  acceptAllAsBaseline(): void;
  dismissSummary(): void;
  readonly canUndo: boolean;
  undo(): Promise<unknown>;
}

export interface ChatSessionRowActionCallbacks {
  onSwitchSession: (sessionId: string, fallbackProjectPath?: string | null) => Promise<boolean>;
  onNewChat: () => void | Promise<void>;
  onEnterEntryState: (sessionId?: string | null) => void | Promise<void>;
  onDeleteSession?: (sessionId: string) => boolean | void | Promise<boolean | void>;
  onDeleteSessionRuntime?: (sessionId: string) => void | Promise<void>;
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
    editCheckpointService: EditCheckpointServiceLike,
    callbacks: ChatSessionSwitchRequestCallbacks,
    selectionItem?: ChatSessionSelectionItem,
  ): Promise<void> {
    const onSwitch = async () => {
      callbacks.onCloseSessionPicker();
      await this.switchToSession(sessionId, currentSessionId, callbacks, selectionItem);
    };

    if (editCheckpointService.hasUnsavedEdits()) {
      await this.confirmUnsavedEditsBeforeSwitch(editCheckpointService, callbacks.onSaveCurrentSession, onSwitch);
      return;
    }

    await onSwitch();
  }

  async requestNewChat(
    editCheckpointService: EditCheckpointServiceLike,
    callbacks: ChatSessionCommandRequestCallbacks,
  ): Promise<void> {
    const onConfirm = () => this.newChat(callbacks);

    if (editCheckpointService.hasUnsavedEdits()) {
      await this.confirmUnsavedEditsBeforeSwitch(editCheckpointService, callbacks.onSaveCurrentSession, onConfirm);
      return;
    }

    await onConfirm();
  }

  async requestImportDebugSnapshot(
    editCheckpointService: EditCheckpointServiceLike,
    callbacks: ChatSessionCommandRequestCallbacks,
  ): Promise<void> {
    const onConfirm = () => this.importDebugSnapshot(callbacks);

    if (editCheckpointService.hasUnsavedEdits()) {
      await this.confirmUnsavedEditsBeforeSwitch(editCheckpointService, callbacks.onSaveCurrentSession, onConfirm);
      return;
    }

    await onConfirm();
  }

  async requestReturnToEntryInventory(
    editCheckpointService: EditCheckpointServiceLike,
    callbacks: ChatSessionEntryCommandRequestCallbacks,
    sessionId?: string | null,
    options?: { readonly saveCurrentSession?: boolean },
  ): Promise<void> {
    const onConfirm = () => this.enterEntryInventory(callbacks, sessionId);

    if (editCheckpointService.hasUnsavedEdits()) {
      await this.confirmUnsavedEditsBeforeSwitch(editCheckpointService, callbacks.onSaveCurrentSession, onConfirm);
      return;
    }

    if (options?.saveCurrentSession !== false) {
      callbacks.onSaveCurrentSession();
    }
    await onConfirm();
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
    const modalRef = this.modal.create({
      nzTitle: null,
      nzFooter: null,
      nzClosable: false,
      nzBodyStyle: { padding: '0' },
      nzWidth: 340,
      nzContent: ChatDeleteDialogComponent,
      nzData: { name },
    });
    modalRef.afterClose.subscribe((result: { confirmed: boolean } | null) => {
      if (!result?.confirmed) {
        return;
      }

      void (async () => {
        const handledBySessionOwner = callbacks.onDeleteSession
          ? await callbacks.onDeleteSession(sessionId)
          : false;
        if (!handledBySessionOwner) {
          await callbacks.onDeleteSessionRuntime?.(sessionId);
          sessionItemController.deleteChatSessionItem(sessionId);
        }

        const isDeletingCurrent = sessionId === currentSessionId;
        callbacks.onRefreshSessions();
        callbacks.onDetectChanges();
        if (!isDeletingCurrent) {
          return;
        }

        const remaining = this.chatSessionItemsService.sessionListItems[0];
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

  private async confirmUnsavedEditsBeforeSwitch(
    editCheckpointService: EditCheckpointServiceLike,
    onSaveCurrentSession: () => void,
    onConfirm: () => void | Promise<void>,
  ): Promise<void> {
    const summary = await editCheckpointService.getEditsSummary();
    if (!summary || summary.fileCount === 0) {
      editCheckpointService.acceptAllAsBaseline();
      editCheckpointService.dismissSummary();
      await onConfirm();
      return;
    }

    const modalRef = this.modal.create({
      nzTitle: null,
      nzFooter: null,
      nzClosable: false,
      nzBodyStyle: { padding: '0' },
      nzWidth: 340,
      nzContent: UnsavedEditsDialogComponent,
      nzData: { fileCount: summary.fileCount, turnContext: summary.turnContext },
    });

    modalRef.afterClose.subscribe(async (action: string | null) => {
      if (action === 'keep') {
        editCheckpointService.acceptAllAsBaseline();
        editCheckpointService.dismissSummary();
        onSaveCurrentSession();
        await onConfirm();
        return;
      }

      if (action === 'discard') {
        while (editCheckpointService.canUndo) {
          await editCheckpointService.undo();
        }
        editCheckpointService.dismissSummary();
        onSaveCurrentSession();
        await onConfirm();
      }
    });
  }
}
