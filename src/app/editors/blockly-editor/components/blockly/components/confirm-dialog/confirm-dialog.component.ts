import { Component, inject } from '@angular/core';
import { NZ_MODAL_DATA, NzModalRef } from 'ng-zorro-antd/modal';
import { BaseDialogComponent, DialogButton } from '../../../../../../components/base-dialog/base-dialog.component';

export interface BlocklyConfirmDialogData {
  message: string;
  okText: string;
  cancelText: string;
}

@Component({
  selector: 'app-blockly-confirm-dialog',
  standalone: true,
  imports: [BaseDialogComponent],
  template: `
    <app-base-dialog
      title="Blockly"
      [buttons]="buttons"
      (closeDialog)="close(false)"
      (buttonClick)="onButtonClick($event)">
      <div class="message">{{ data.message }}</div>
    </app-base-dialog>
  `,
  styles: [`.message { min-height: 32px; line-height: 25px; }`],
})
export class BlocklyConfirmDialogComponent {
  readonly modalRef = inject(NzModalRef);
  readonly data = inject<BlocklyConfirmDialogData>(NZ_MODAL_DATA);

  get buttons(): DialogButton[] {
    return [
      { text: this.data.cancelText, type: 'default', action: 'cancel' },
      { text: this.data.okText, type: 'primary', danger: true, action: 'confirm' },
    ];
  }

  close(confirmed: boolean): void {
    this.modalRef.close(confirmed);
  }

  onButtonClick(action: string): void {
    this.close(action === 'confirm');
  }
}
