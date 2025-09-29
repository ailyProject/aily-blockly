import { Component, inject } from '@angular/core';
import { NZ_MODAL_DATA, NzModalRef } from 'ng-zorro-antd/modal';
import { CommonModule } from '@angular/common';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzIconModule } from 'ng-zorro-antd/icon';

@Component({
  selector: 'app-github-login-dialog',
  imports: [NzButtonModule, CommonModule, NzIconModule],
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

  constructor() {
  }

  ngOnInit(): void {
  }

  cancel(): void {
    this.modal.close({ result: 'cancel' });
  }

  agree(): void {
    this.modal.close({ result: 'agree' });
  }
}