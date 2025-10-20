import { Component, inject } from '@angular/core';
import { NzModalRef } from 'ng-zorro-antd/modal';
import { CommonModule } from '@angular/common';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { BaseDialogComponent, DialogButton } from '../../../components/base-dialog/base-dialog.component';

@Component({
  selector: 'app-serial-dialog',
  imports: [NzButtonModule, CommonModule, BaseDialogComponent],
  templateUrl: './serial-dialog.component.html',
  styleUrl: './serial-dialog.component.scss'
})
export class SerialDialogComponent {

  readonly modal = inject(NzModalRef);

  title = '请先选择设备端口';

  // 配置对话框按钮
  buttons: DialogButton[] = [
    {
      text: '知道了',
      type: 'default',
      action: 'confirm'
    }
  ];

  constructor(
  ) {
  }

  ngOnInit(): void {
  }

  onCloseDialog(): void {
    this.modal.close({ result: 'cancel' });
  }

  onButtonClick(action: string): void {
    if (action === 'confirm') {
      this.modal.close({ result: 'cancel' });
    }
  }

  // 保留原有方法以兼容性
  cancel(): void {
    this.modal.close({ result: 'cancel' });
  }
}
