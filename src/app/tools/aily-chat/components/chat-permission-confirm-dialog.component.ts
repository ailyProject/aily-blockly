import { CommonModule } from '@angular/common';
import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NZ_MODAL_DATA, NzModalRef } from 'ng-zorro-antd/modal';

export interface ChatPermissionConfirmDialogData {
  readonly title: string;
  readonly message: string;
  readonly riskNote?: string;
  readonly rememberLabel?: string;
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
}

export interface ChatPermissionConfirmDialogResult {
  readonly confirmed: boolean;
  readonly rememberForSession: boolean;
}

@Component({
  selector: 'aily-chat-permission-confirm-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="permission-confirm-dialog">
      <h3 class="permission-confirm-title">{{ data.title }}</h3>
      <p class="permission-confirm-message">{{ data.message }}</p>
      @if (data.riskNote) {
      <p class="permission-confirm-risk">{{ data.riskNote }}</p>
      }
      <label class="permission-confirm-remember">
        <input type="checkbox" [(ngModel)]="rememberForSession" />
        <span>{{ data.rememberLabel || '本会话内记住我的选择' }}</span>
      </label>
      <div class="permission-confirm-actions">
        <button type="button" class="cancel-btn" (click)="close(false)">
          {{ data.cancelLabel || '取消' }}
        </button>
        <button type="button" class="confirm-btn" (click)="close(true)">
          {{ data.confirmLabel || '继续启用' }}
        </button>
      </div>
    </div>
  `,
  styles: [`
    .permission-confirm-dialog {
      padding: 16px;
      color: #d4d4d4;
      background: #1f1f1f;
    }

    .permission-confirm-title {
      margin: 0 0 8px;
      font-size: 16px;
      line-height: 1.35;
      color: #f5f5f5;
    }

    .permission-confirm-message,
    .permission-confirm-risk {
      margin: 0 0 10px;
      font-size: 13px;
      line-height: 1.5;
    }

    .permission-confirm-risk {
      color: #ffcc80;
    }

    .permission-confirm-remember {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 14px;
      font-size: 12px;
      color: #c8c8c8;
      user-select: none;
    }

    .permission-confirm-actions {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
    }

    .permission-confirm-actions button {
      min-width: 88px;
      height: 30px;
      border-radius: 6px;
      border: 1px solid transparent;
      cursor: pointer;
      font-size: 12px;
    }

    .permission-confirm-actions .cancel-btn {
      background: #2f2f2f;
      border-color: #4a4a4a;
      color: #d8d8d8;
    }

    .permission-confirm-actions .confirm-btn {
      background: #8a2b20;
      border-color: #b84031;
      color: #fff;
    }
  `],
})
export class ChatPermissionConfirmDialogComponent {
  readonly modalRef = inject(NzModalRef<ChatPermissionConfirmDialogComponent>);
  readonly data = inject<ChatPermissionConfirmDialogData>(NZ_MODAL_DATA);

  rememberForSession = false;

  close(confirmed: boolean): void {
    const result: ChatPermissionConfirmDialogResult = {
      confirmed,
      rememberForSession: confirmed ? this.rememberForSession : false,
    };
    this.modalRef.close(result);
  }
}
