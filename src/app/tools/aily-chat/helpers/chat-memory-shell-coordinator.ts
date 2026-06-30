import type { NzModalService } from 'ng-zorro-antd/modal';

import type { IAilyHostAPI } from '../core/host-api';
import type { ChatSessionListItem } from '../services/menu-manager.service';
import { ChatClearMemoriesDialogComponent } from '../components/chat-clear-memories-dialog/chat-clear-memories-dialog.component';
import { ChatShowMemoriesDialogComponent } from '../components/chat-show-memories-dialog/chat-show-memories-dialog.component';
import { MemoryManagerDialogComponent } from '../components/memory/memory-manager-dialog.component';
import { clearBlocklyLocalMemories, listBlocklyLocalMemoryEntries, type BlocklyMemoryEntry } from './chat-memory-host';

interface RecentProjectItem {
  readonly name: string;
  readonly path: string;
  readonly nickname?: string;
}

export interface ChatMemoryShellCoordinatorDeps {
  readonly modal: Pick<NzModalService, 'create'>;
  readonly getHost: () => IAilyHostAPI;
  readonly getProjectPath: () => string;
  readonly getSessionId: () => string | undefined;
  readonly getRecentProjects: () => readonly RecentProjectItem[];
  readonly getSessionItems: () => readonly ChatSessionListItem[];
  readonly getRepositoryMemoryEnabled: () => boolean;
  readonly notifyInfo: (message: string) => void;
  readonly notifyError: (message: string) => void;
}

export class ChatMemoryShellCoordinator {
  constructor(private readonly deps: ChatMemoryShellCoordinatorDeps) {}

  requestManageMemories(): boolean {
    this.deps.modal.create({
      nzTitle: null,
      nzFooter: null,
      nzClosable: false,
      nzBodyStyle: { padding: '0' },
      nzWidth: 980,
      nzContent: MemoryManagerDialogComponent,
      nzData: {
        host: this.deps.getHost(),
        projectPath: this.deps.getProjectPath(),
        sessionId: this.deps.getSessionId(),
        recentProjects: this.deps.getRecentProjects(),
        sessionItems: this.deps.getSessionItems(),
      },
    });

    return true;
  }

  requestShowMemories(): boolean {
    const entries = listBlocklyLocalMemoryEntries(
      this.deps.getHost(),
      this.deps.getProjectPath(),
      this.deps.getSessionId(),
      this.deps.getRepositoryMemoryEnabled(),
    );

    if (entries.length === 0) {
      this.deps.notifyInfo('当前没有可查看的 memories');
      return true;
    }

    const modalRef = this.deps.modal.create({
      nzTitle: null,
      nzFooter: null,
      nzClosable: false,
      nzBodyStyle: { padding: '0' },
      nzWidth: 520,
      nzContent: ChatShowMemoriesDialogComponent,
      nzData: { entries },
    });

    modalRef.afterClose.subscribe((result: { selected?: BlocklyMemoryEntry } | null | undefined) => {
      if (!result?.selected) {
        return;
      }

      this.openMemoryEntry(result.selected);
    });

    return true;
  }

  requestClearMemories(): boolean {
    const modalRef = this.deps.modal.create({
      nzTitle: null,
      nzFooter: null,
      nzClosable: false,
      nzBodyStyle: { padding: '0' },
      nzWidth: 360,
      nzContent: ChatClearMemoriesDialogComponent,
    });

    modalRef.afterClose.subscribe((result: { confirmed?: boolean } | null | undefined) => {
      if (!result?.confirmed) {
        return;
      }

      const clearResult = clearBlocklyLocalMemories(this.deps.getHost(), this.deps.getProjectPath());
      if (clearResult.hadError) {
        this.deps.notifyError('部分 memories 清空失败，请重试');
        return;
      }
      if (!clearResult.deletedAny) {
        this.deps.notifyInfo('当前没有可清空的 memories');
        return;
      }

      this.deps.notifyInfo('已清空所有本地 memories');
    });

    return true;
  }

  private openMemoryEntry(entry: BlocklyMemoryEntry): void {
    const host = this.deps.getHost();
    const projectPath = this.deps.getProjectPath();
    const openResult = host.editor?.showTextDocument?.(entry.absolutePath, { projectPath });

    if (typeof (openResult as Promise<boolean> | undefined)?.then === 'function') {
      void (openResult as Promise<boolean>).then((opened) => {
        if (!opened) {
          this.deps.notifyError(`无法打开 memory 文件: ${entry.publicPath}`);
        }
      }).catch(() => {
        this.deps.notifyError(`无法打开 memory 文件: ${entry.publicPath}`);
      });
      return;
    }

    if (!openResult) {
      this.deps.notifyError(`无法打开 memory 文件: ${entry.publicPath}`);
    }
  }
}
