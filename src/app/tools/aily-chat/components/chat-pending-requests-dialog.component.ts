import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NZ_MODAL_DATA, NzModalRef } from 'ng-zorro-antd/modal';
import { BaseDialogComponent, DialogButton } from '../../../components/base-dialog/base-dialog.component';

export type ChatPendingRequestsDialogResult = 'keep' | 'remove' | 'cancel';

@Component({
  selector: 'app-chat-pending-requests-dialog',
  standalone: true,
  imports: [CommonModule, BaseDialogComponent],
  template: `
    <app-base-dialog
      title="待发送请求"
      [buttons]="buttons"
      (closeDialog)="onClose()"
      (buttonClick)="onButtonClick($event)">
      <div class="text">当前会话已有 {{ pendingCount }} 条待发送请求。</div>
      <div class="hint">发送这条新消息前，是否保留这些 pending 请求，还是先移除它们？</div>
    </app-base-dialog>
  `,
  styles: [
    `.text { min-height: 28px; line-height: 24px; }`,
    `.hint { margin-top: 6px; font-size: 12px; line-height: 18px; color: #7f8a96; }`,
  ],
})
export class ChatPendingRequestsDialogComponent {
  readonly modalRef = inject(NzModalRef<ChatPendingRequestsDialogComponent>);
  readonly data: { count?: number } = inject(NZ_MODAL_DATA);

  get pendingCount(): number {
    const count = Number(this.data?.count ?? 0);
    return Number.isFinite(count) && count > 0 ? Math.floor(count) : 1;
  }

  get buttons(): DialogButton[] {
    return [
      { text: '取消', type: 'default', action: 'cancel' },
      { text: '移除待发送', type: 'default', danger: true, action: 'remove' },
      { text: '保留待发送', type: 'primary', action: 'keep' },
    ];
  }

  onClose(): void {
    this.modalRef.close('cancel');
  }

  onButtonClick(action: string): void {
    this.modalRef.close(action as ChatPendingRequestsDialogResult);
  }
}