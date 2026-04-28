import { Component, inject, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NZ_MODAL_DATA, NzModalRef } from 'ng-zorro-antd/modal';
import { NzInputModule } from 'ng-zorro-antd/input';
import { CommonModule } from '@angular/common';
import { BaseDialogComponent, DialogButton } from '../../../../components/base-dialog/base-dialog.component';

@Component({
  selector: 'app-chat-rename-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule, NzInputModule, BaseDialogComponent],
  template: `
    <app-base-dialog
      title="重命名对话"
      [buttons]="buttons"
      (closeDialog)="onClose()"
      (buttonClick)="onButtonClick($event)">
      <input
        nz-input
        [(ngModel)]="titleValue"
        placeholder="请输入对话标题"
        (keydown.enter)="onButtonClick('ok')"
        autofocus
        style="width:100%" />
    </app-base-dialog>
  `,
})
export class ChatRenameDialogComponent implements OnInit {
  readonly modalRef = inject(NzModalRef);
  readonly data: { currentName: string } = inject(NZ_MODAL_DATA);

  titleValue: string = '';

  get buttons(): DialogButton[] {
    return [
      { text: '取消', type: 'default', action: 'cancel' },
      { text: '确定', type: 'primary', action: 'ok' },
    ];
  }

  ngOnInit(): void {
    this.titleValue = this.data?.currentName || '';
  }

  onClose(): void {
    this.modalRef.close(null);
  }

  onButtonClick(action: string): void {
    if (action === 'ok') {
      const trimmed = this.titleValue.trim();
      if (!trimmed) return;
      this.modalRef.close({ result: trimmed });
    } else {
      this.modalRef.close(null);
    }
  }
}
