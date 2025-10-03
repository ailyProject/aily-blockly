import { Component, inject } from '@angular/core';
import { NZ_MODAL_DATA, NzModalRef } from 'ng-zorro-antd/modal';
import { CommonModule } from '@angular/common';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { BaseDialogComponent, DialogButton } from '../../../components/base-dialog/base-dialog.component';

@Component({
  selector: 'app-github-login-dialog',
  imports: [NzButtonModule, CommonModule, NzIconModule, BaseDialogComponent],
  templateUrl: './github-login-dialog.component.html',
  styleUrl: './github-login-dialog.component.scss'
})
export class GitHubLoginDialogComponent {

  readonly modal = inject(NzModalRef);
  readonly data: { title?: string; text?: string } = inject(NZ_MODAL_DATA);

  get title(): string {
    return this.data?.title || 'GitHub 登录确认';
  }

  get text(): string {
    return this.data?.text || '';
  }

  // 配置对话框按钮
  buttons: DialogButton[] = [
    {
      text: '取消',
      type: 'default',
      action: 'cancel'
    },
    {
      text: '同意并继续',
      type: 'primary',
      action: 'agree'
    }
  ];

  constructor() {
  }

  ngOnInit(): void {
  }

  onCloseDialog(): void {
    this.modal.close({ result: 'cancel' });
  }

  onButtonClick(action: string): void {
    if (action === 'cancel') {
      this.modal.close({ result: 'cancel' });
    } else if (action === 'agree') {
      this.modal.close({ result: 'agree' });
    }
  }

  // 保留原有方法以兼容性
  cancel(): void {
    this.modal.close({ result: 'cancel' });
  }

  agree(): void {
    this.modal.close({ result: 'agree' });
  }
}