import { Component, OnInit, inject } from '@angular/core';
import { NZ_MODAL_DATA, NzModalRef } from 'ng-zorro-antd/modal';
import { CommonModule } from '@angular/common';
import { NzTagModule } from 'ng-zorro-antd/tag';
import { TranslateModule } from '@ngx-translate/core';
import { BaseDialogComponent, DialogButton } from '../../../../components/base-dialog/base-dialog.component';

@Component({
  selector: 'app-compatible-dialog',
  imports: [NzTagModule, CommonModule, TranslateModule, BaseDialogComponent],
  templateUrl: './compatible-dialog.component.html',
  styleUrl: './compatible-dialog.component.scss'
})
export class CompatibleDialogComponent {

  readonly modal = inject(NzModalRef);
  readonly data: { libCompatibility: string[]; boardCore: string } = inject(NZ_MODAL_DATA);

  get libCompatibility(): string[] {
    return this.data.libCompatibility;
  }

  get boardCore(): string {
    return this.data.boardCore;
  }

  get buttons(): DialogButton[] {
    return [
      {
        text: 'COMPATIBILITY_DIALOG.CANCEL',
        type: 'default',
        action: 'cancel',
      },
      {
        text: 'COMPATIBILITY_DIALOG.CONTINUE_INSTALL',
        type: 'primary',
        danger: true,
        action: 'continue',
      },
    ];
  }

  constructor(
  ) {
  }

  ngOnInit(): void {
  }

  cancel(): void {
    this.modal.close({ result: 'cancel' });
  }

  continue(): void {
    this.modal.close({ result: 'continue' });
  }

  onButtonClick(action: string): void {
    if (action === 'continue') {
      this.continue();
    } else {
      this.cancel();
    }
  }
}
