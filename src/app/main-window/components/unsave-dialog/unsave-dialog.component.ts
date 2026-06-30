import { Component, OnInit, inject } from '@angular/core';
import { NZ_MODAL_DATA, NzModalRef } from 'ng-zorro-antd/modal';
import { CommonModule } from '@angular/common';
import { TranslateModule } from '@ngx-translate/core';
import { BaseDialogComponent, DialogButton } from '../../../components/base-dialog/base-dialog.component';

export interface UnsaveDialogCustomData {
  title: string;
  text: string;
  detail?: string;
  buttons: DialogButton[];
}

export interface UnsaveDialogActionData {
  action: 'close' | 'open' | 'new';
}

export type UnsaveDialogData = UnsaveDialogActionData | UnsaveDialogCustomData;

@Component({
  selector: 'app-unsave-dialog',
  imports: [CommonModule, TranslateModule, BaseDialogComponent],
  templateUrl: './unsave-dialog.component.html',
  styleUrl: './unsave-dialog.component.scss'
})
export class UnsaveDialogComponent {

  readonly modal = inject(NzModalRef);
  readonly data: UnsaveDialogData = inject(NZ_MODAL_DATA);

  private get customData(): UnsaveDialogCustomData | null {
    return 'action' in this.data ? null : this.data;
  }

  private get actionData(): UnsaveDialogActionData | null {
    return 'action' in this.data ? this.data : null;
  }

  get title(): string {
    return this.customData?.title ?? 'UNSAVE_DIALOG.TITLE';
  }

  get text(): string {
    if (this.customData) {
      return this.customData.text;
    }

    const action = this.actionData?.action;
    if (action === 'open') {
      return 'UNSAVE_DIALOG.MESSAGE_OPEN';
    } else if (action === 'new') {
      return 'UNSAVE_DIALOG.MESSAGE_NEW';
    } else if (action === 'close') {
      return 'UNSAVE_DIALOG.MESSAGE_CLOSE';
    }
    return 'UNSAVE_DIALOG.MESSAGE_DEFAULT';
  }

  get detail(): string | null {
    return this.customData?.detail ?? null;
  }

  get buttons(): DialogButton[] {
    if (this.customData) {
      return this.customData.buttons;
    }

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
