import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NzModalRef } from 'ng-zorro-antd/modal';
import { BaseDialogComponent, DialogButton } from '../../../../components/base-dialog/base-dialog.component';

@Component({
  selector: 'app-chat-clear-memories-dialog',
  standalone: true,
  imports: [CommonModule, BaseDialogComponent],
  template: `
    <app-base-dialog
      title="清空记忆"
      [buttons]="buttons"
      (closeDialog)="onClose()"
      (buttonClick)="onButtonClick($event)">
      <div class="text">确定清空所有本地 memories 吗？这会删除 user memories 和当前工作区下的全部 local memories，且无法恢复。</div>
    </app-base-dialog>
  `,
  styles: ['.text { min-height: 48px; line-height: 24px; }'],
})
export class ChatClearMemoriesDialogComponent {
  readonly modalRef = inject(NzModalRef);

  get buttons(): DialogButton[] {
    return [
      { text: '取消', type: 'default', action: 'cancel' },
      { text: '清空', type: 'primary', danger: true, action: 'clear' },
    ];
  }

  onClose(): void {
    this.modalRef.close(null);
  }

  onButtonClick(action: string): void {
    this.modalRef.close(action === 'clear' ? { confirmed: true } : null);
  }
}