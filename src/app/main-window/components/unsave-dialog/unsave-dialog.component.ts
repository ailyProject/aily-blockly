import { Component, OnInit, inject } from '@angular/core';
import { NZ_MODAL_DATA, NzModalRef } from 'ng-zorro-antd/modal';
import { CommonModule } from '@angular/common';
import { TranslateModule } from '@ngx-translate/core';
import { BaseDialogComponent, DialogButton } from '../../../components/base-dialog/base-dialog.component';

@Component({
  selector: 'app-unsave-dialog',
  imports: [CommonModule, TranslateModule, BaseDialogComponent],
  templateUrl: './unsave-dialog.component.html',
  styleUrl: './unsave-dialog.component.scss'
})
export class UnsaveDialogComponent {

  readonly modal = inject(NzModalRef);
  readonly data: { action: 'close' | 'open' | 'new' } = inject(NZ_MODAL_DATA);

  get title(): string {
    return 'UNSAVE_DIALOG.TITLE';
  }

  get text(): string {
    const action = this.data.action;
    if (action === 'open') {
      return 'UNSAVE_DIALOG.MESSAGE_OPEN';
    } else if (action === 'new') {
      return 'UNSAVE_DIALOG.MESSAGE_NEW';
    } else if (action === 'close') {
      return 'UNSAVE_DIALOG.MESSAGE_CLOSE';
    }
    return 'UNSAVE_DIALOG.MESSAGE_DEFAULT';
  }

  get buttons(): DialogButton[] {
    return [
      {
        text: 'UNSAVE_DIALOG.CANCEL',
        type: 'default',
        action: 'cancel'
      },
      {
        text: 'UNSAVE_DIALOG.SKIP_SAVE',
        type: 'primary',
        danger: true,
        action: 'continue'
      },
      {
        text: 'UNSAVE_DIALOG.SAVE_AND_CONTINUE',
        type: 'primary',
        action: 'save'
      }
    ];
  }

  constructor() {
  }

  ngOnInit(): void {
  }

  onClose(): void {
    this.modal.close({ result: 'cancel' });
  }

  onButtonClick(action: string): void {
    this.modal.close({ result: action });
  }
}
