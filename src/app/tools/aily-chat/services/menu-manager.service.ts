import { Injectable } from '@angular/core';
import { NzMessageService } from 'ng-zorro-antd/message';
import { NzModalService } from 'ng-zorro-antd/modal';
import { TranslateService } from '@ngx-translate/core';
import { ChatService } from './chat.service';
import { ChatHistoryService } from './chat-history.service';
import { AilyHost } from '../core/host';
import { ChatRenameDialogComponent } from '../components/chat-rename-dialog/chat-rename-dialog.component';
import { ChatDeleteDialogComponent } from '../components/chat-delete-dialog/chat-delete-dialog.component';

export interface IMenuItem {
  name: string;
  action: string;
  icon?: string;
  data?: any;
}

export interface MenuPosition {
  x: number;
  y: number;
}

/**
 * 管理聊天界面的所有菜单/下拉面板状态：
 * - 历史记录列表
 * - 模式切换菜单
 * - 模型切换菜单
 * - 历史记录的重命名/删除操作
 */
@Injectable()
export class MenuManagerService {
  showHistoryList = false;
  showMode = false;
  showModelMenu = false;
  historyListPosition: MenuPosition = { x: 0, y: 0 };
  modeListPosition: MenuPosition = { x: 0, y: 0 };
  modelListPosition: MenuPosition = { x: 0, y: 0 };
  historyList: any[] = [];

  constructor(
    private chatService: ChatService,
    private chatHistoryService: ChatHistoryService,
    private message: NzMessageService,
    private modal: NzModalService,
    private translate: TranslateService,
  ) {}

  closeAll(): void {
    this.showHistoryList = false;
    this.showMode = false;
    this.showModelMenu = false;
  }

  /** 打开/关闭历史记录面板 */
  openHistoryChat(): void {
    if (!this.historyList?.length) {
      this.message.info(this.translate.instant('AILY_CHAT.NO_HISTORY_SESSION') || '没有历史会话记录');
      return;
    }
    this.historyListPosition = { x: window.innerWidth - 302, y: 72 };
    this.showHistoryList = !this.showHistoryList;
  }

  /** 切换模式菜单的显示/隐藏 */
  toggleModeMenu(event: MouseEvent): void {
    const target = event.currentTarget as HTMLElement;
    if (target) {
      const rect = target.getBoundingClientRect();
      const menuHeight = 68;
      let x = rect.left;
      let y = rect.top - menuHeight - 1;
      if (x < 0) x = rect.left;
      if (y < 0) y = rect.bottom - 1;
      this.modeListPosition = { x: Math.max(0, x), y: Math.max(0, y) };
    } else {
      this.modeListPosition = { x: window.innerWidth - 302, y: window.innerHeight - 280 };
    }
    event.preventDefault();
    event.stopPropagation();
    this.showModelMenu = false;
    this.showMode = !this.showMode;
  }

  /** 切换模型菜单的显示/隐藏 */
  toggleModelMenu(event: MouseEvent, modelCount: number): void {
    const target = event.currentTarget as HTMLElement;
    if (target) {
      const rect = target.getBoundingClientRect();
      const menuHeight = modelCount * 30 + 12;
      let x = rect.left;
      let y = rect.top - menuHeight - 1;
      if (x < 0) x = rect.left;
      if (y < 0) y = rect.bottom - 1;
      this.modelListPosition = { x: Math.max(0, x), y: Math.max(0, y) };
    } else {
      this.modelListPosition = { x: window.innerWidth - 302, y: window.innerHeight - 280 };
    }
    event.preventDefault();
    event.stopPropagation();
    this.showMode = false;
    this.showModelMenu = !this.showModelMenu;
  }

  /**
   * 历史记录行内操作（重命名/删除）
   * @param callbacks 用于触发组件级行为的回调
   */
  historyActionClick(
    e: { action: string; data: any },
    currentSessionId: string,
    callbacks: {
      onGetHistory: () => void;
      onNewChat: () => void;
      onDetectChanges: () => void;
      onUpdateTitle: (title: string) => void;
      onRefreshHistory: () => void;
    }
  ): void {
    const { action, data } = e;
    const sessionId = data?.sessionId;
    if (!sessionId) return;

    if (action === 'rename-history') {
      const modalRef = this.modal.create({
        nzTitle: null,
        nzFooter: null,
        nzClosable: false,
        nzBodyStyle: { padding: '0' },
        nzWidth: 340,
        nzContent: ChatRenameDialogComponent,
        nzData: { currentName: data?.name || '' },
      });
      modalRef.afterClose.subscribe((result: { result: string } | null) => {
        if (!result?.result) return;
        this.chatHistoryService.updateTitle(sessionId, result.result);
        if (sessionId === currentSessionId) {
          callbacks.onUpdateTitle(result.result);
        }
        callbacks.onRefreshHistory();
        callbacks.onDetectChanges();
      });
    } else if (action === 'delete-history') {
      const name = data?.name || sessionId;
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
        if (!result?.confirmed) return;
        const isDeletingCurrent = sessionId === currentSessionId;
        this.chatHistoryService.deleteSession(sessionId);
        callbacks.onRefreshHistory();
        callbacks.onDetectChanges();
        if (isDeletingCurrent) {
          const remaining = this.historyList[0];
          if (remaining?.sessionId) {
            this.chatService.currentSessionId = remaining.sessionId;
            const entry = this.chatHistoryService.findEntry(remaining.sessionId);
            const _curPath1 = AilyHost.get().project.currentProjectPath;
            const _rootPath1 = AilyHost.get().project.projectRootPath;
            this.chatService.currentSessionPath = entry?.projectPath
              || (_curPath1 && _curPath1 !== _rootPath1 ? _curPath1 : '');
            callbacks.onGetHistory();
          } else {
            callbacks.onNewChat();
          }
        }
      });
    }
  }

  /**
   * 点击历史会话条目，切换到该会话
   * @returns true 表示执行了切换
   */
  switchToSession(
    sessionId: string,
    currentSessionId: string,
    callbacks: {
      onSaveCurrentSession: () => void;
      onGetHistory: () => void;
      onSetCompleted: () => void;
      onSetServerSessionInactive: () => void;
    }
  ): boolean {
    if (currentSessionId === sessionId) return false;

    callbacks.onSaveCurrentSession();
    this.chatService.currentSessionId = sessionId;
    const entry = this.chatHistoryService.findEntry(sessionId);
    const _curPath2 = AilyHost.get().project.currentProjectPath;
    const _rootPath2 = AilyHost.get().project.projectRootPath;
    this.chatService.currentSessionPath = entry?.projectPath
      || (_curPath2 && _curPath2 !== _rootPath2 ? _curPath2 : '');
    callbacks.onGetHistory();
    callbacks.onSetCompleted();
    callbacks.onSetServerSessionInactive();
    this.closeAll();
    return true;
  }
}
