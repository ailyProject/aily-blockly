import { CommonModule } from '@angular/common';
import { Component, inject } from '@angular/core';
import { NZ_MODAL_DATA, NzModalRef } from 'ng-zorro-antd/modal';

import { BaseDialogComponent } from '../../../../components/base-dialog/base-dialog.component';
import type { BlocklyMemoryEntry } from '../../helpers/chat-memory-host';

interface ChatShowMemoriesDialogData {
  readonly entries: readonly BlocklyMemoryEntry[];
}

interface MemorySection {
  readonly title: string;
  readonly items: readonly BlocklyMemoryEntry[];
}

@Component({
  selector: 'app-chat-show-memories-dialog',
  standalone: true,
  imports: [CommonModule, BaseDialogComponent],
  template: `
    <app-base-dialog
      title="查看记忆"
      [showFooter]="false"
      (closeDialog)="onClose()">
      <div class="memory-picker">
        <p class="memory-picker-subtitle">选择一个 memory 文件以查看</p>

        <div class="memory-sections">
          <section class="memory-section" *ngFor="let section of sections">
            <div class="memory-section-title">{{ section.title }}</div>
            <button
              *ngFor="let entry of section.items"
              class="memory-item"
              type="button"
              (click)="select(entry)">
              <span class="memory-item-name">{{ entry.name }}</span>
              <span class="memory-item-path">{{ entry.publicPath }}</span>
            </button>
          </section>
        </div>
      </div>
    </app-base-dialog>
  `,
  styles: [`
    .memory-picker {
      width: 100%;
      min-width: 420px;
      max-width: 100%;
    }

    .memory-picker-subtitle {
      margin: 0 0 16px;
      color: #8c8c8c;
      font-size: 13px;
      line-height: 20px;
    }

    .memory-sections {
      display: flex;
      flex-direction: column;
      gap: 16px;
      max-height: 420px;
      overflow: auto;
    }

    .memory-section {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .memory-section-title {
      font-size: 12px;
      line-height: 18px;
      font-weight: 600;
      color: #8c8c8c;
    }

    .memory-item {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 2px;
      width: 100%;
      padding: 10px 12px;
      border: 1px solid #f0f0f0;
      border-radius: 8px;
      background: #fff;
      text-align: left;
      cursor: pointer;
      transition: border-color 120ms ease, background-color 120ms ease;
    }

    .memory-item:hover {
      border-color: #91caff;
      background: #f0f7ff;
    }

    .memory-item-name {
      color: #262626;
      font-size: 14px;
      line-height: 20px;
      font-weight: 500;
    }

    .memory-item-path {
      color: #8c8c8c;
      font-size: 12px;
      line-height: 18px;
      word-break: break-all;
    }
  `],
})
export class ChatShowMemoriesDialogComponent {
  readonly modalRef = inject(NzModalRef);
  readonly data = inject<ChatShowMemoriesDialogData>(NZ_MODAL_DATA, { optional: true }) ?? { entries: [] };

  get sections(): readonly MemorySection[] {
    return [
      this.toSection('/memories', 'user'),
      this.toSection('/memories/repo', 'repo'),
      this.toSection('/memories/session', 'session'),
    ].filter((section): section is MemorySection => section.items.length > 0);
  }

  onClose(): void {
    this.modalRef.close(null);
  }

  select(entry: BlocklyMemoryEntry): void {
    this.modalRef.close({ selected: entry });
  }

  private toSection(title: string, scope: BlocklyMemoryEntry['scope']): MemorySection {
    return {
      title,
      items: this.data.entries.filter(entry => entry.scope === scope),
    };
  }
}