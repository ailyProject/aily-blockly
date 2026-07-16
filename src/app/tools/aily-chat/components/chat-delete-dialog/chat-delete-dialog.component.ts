import { Component, inject } from '@angular/core';
import { NZ_MODAL_DATA, NzModalRef } from 'ng-zorro-antd/modal';
import { CommonModule } from '@angular/common';
import { BaseDialogComponent, DialogButton } from '../../../../components/base-dialog/base-dialog.component';

@Component({
  selector: 'app-chat-delete-dialog',
  standalone: true,
  imports: [CommonModule, BaseDialogComponent],
  template: `
    <app-base-dialog
      title="删除对话"
      [buttons]="buttons"
      (closeDialog)="onClose()"
      (buttonClick)="onButtonClick($event)">
      @if (data.requestInProgress) {
        <div class="text">对话「{{ data.name }}」仍在进行中。继续将停止当前请求并永久删除该对话。</div>
      } @else {
        <div class="text">确定删除对话「{{ data.name }}」？此操作不可恢复。</div>
      }
    </app-base-dialog>
  `,
  styles: [`.text { min-height: 32px; line-height: 25px; }`],
})
export class ChatDeleteDialogComponent {
  readonly modalRef = inject(NzModalRef);
  readonly data: { name: string; requestInProgress: boolean } = inject(NZ_MODAL_DATA);

  get buttons(): DialogButton[] {
    return [
      { text: '取消', type: 'default', action: 'cancel' },
      {
        text: this.data.requestInProgress ? '停止并删除' : '删除',
        type: 'primary',
        danger: true,
        action: 'delete',
      },
    ];
  }

  onClose(): void {
    this.modalRef.close(null);
  }

  onButtonClick(action: string): void {
    this.modalRef.close(action === 'delete' ? { confirmed: true } : null);
  }
}
