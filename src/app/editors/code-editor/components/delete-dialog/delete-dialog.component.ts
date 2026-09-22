import { Component, Inject } from '@angular/core';
import { NZ_MODAL_DATA, NzModalRef } from 'ng-zorro-antd/modal';
import { CommonModule } from '@angular/common';
import { BaseDialogComponent, DialogButton } from '../../../../components/base-dialog/base-dialog.component';

@Component({
  selector: 'app-delete-dialog',
  imports: [CommonModule, BaseDialogComponent],
  templateUrl: './delete-dialog.component.html',
  styleUrls: ['./delete-dialog.component.scss']
})
export class DeleteDialogComponent {
  title: string;
  text: string;
  nodes: any[];

  constructor(
    @Inject(NZ_MODAL_DATA) public data: any,
    private modal: NzModalRef,
  ) {
    this.title = data.title || '确认删除';
    this.text = data.text || '';
    this.nodes = data.nodes || [];
    // console.log('DeleteDialogComponent data:', data);
  }

  get buttons(): DialogButton[] {
    return [
      { text: '取消', type: 'default', action: 'cancel' },
      { text: '删除', type: 'primary', danger: true, action: 'confirm' },
    ];
  }

  getFormattedText(): string {
    return this.nodes.map(node => node.title).join(', ');
  }

  close(result: string = '') {
    this.modal.close(result);
  }

  cancel() {
    this.close('cancel');
  }

  deleteFile() {
    this.close('confirm');
  }

  onButtonClick(action: string): void {
    if (action === 'confirm') {
      this.deleteFile();
    } else {
      this.cancel();
    }
  }
}
