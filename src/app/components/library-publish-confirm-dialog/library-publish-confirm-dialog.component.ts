import { CommonModule } from '@angular/common';
import { Component, inject } from '@angular/core';
import { NZ_MODAL_DATA, NzModalRef } from 'ng-zorro-antd/modal';
import { BaseDialogComponent, DialogButton } from '../base-dialog/base-dialog.component';

export interface LibraryPublishConfirmDialogData {
  title: string;
  content: string;
  okText: string;
  cancelText: string;
}

@Component({
  selector: 'app-library-publish-confirm-dialog',
  standalone: true,
  imports: [CommonModule, BaseDialogComponent],
  templateUrl: './library-publish-confirm-dialog.component.html',
  styleUrl: './library-publish-confirm-dialog.component.scss',
})
export class LibraryPublishConfirmDialogComponent {
  readonly modal = inject(NzModalRef);
  readonly data: LibraryPublishConfirmDialogData = inject(NZ_MODAL_DATA);

  get buttons(): DialogButton[] {
    return [
      {
        text: this.data.cancelText,
        type: 'default',
        action: 'cancel',
      },
      {
        text: this.data.okText,
        type: 'primary',
        action: 'ok',
      },
    ];
  }

  onClose(): void {
    this.modal.close({ result: false });
  }

  onButtonClick(action: string): void {
    this.modal.close({ result: action === 'ok' });
  }
}
