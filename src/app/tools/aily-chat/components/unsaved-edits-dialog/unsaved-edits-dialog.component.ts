import { Component, inject } from '@angular/core';
import { NZ_MODAL_DATA, NzModalRef } from 'ng-zorro-antd/modal';
import { CommonModule } from '@angular/common';
import { BaseDialogComponent, DialogButton } from '../../../../components/base-dialog/base-dialog.component';
import { getInteractionDisplayContent, type DialogTurnContext } from '../../core/user-turn-action-target';

@Component({
  selector: 'app-unsaved-edits-dialog',
  standalone: true,
  imports: [CommonModule, BaseDialogComponent],
  template: `
    <app-base-dialog
      title="未保留的文件变更"
      [buttons]="buttons"
      (closeDialog)="onClose()"
      (buttonClick)="onButtonClick($event)">
      <div class="text">当前对话有 {{ data?.fileCount }} 个文件的变更尚未保留。是否保留这些变更？</div>
      <div class="hint" *ngIf="requestPreview as preview" [title]="requestTitle">关联请求：{{ preview }}</div>
    </app-base-dialog>
  `,
  styles: [
    `.text { min-height: 32px; line-height: 25px; }`,
    `.hint { margin-top: 6px; font-size: 12px; line-height: 18px; color: #7f8a96; }`,
  ],
})
export class UnsavedEditsDialogComponent {
  readonly modalRef = inject(NzModalRef);
  readonly data: { fileCount: number; turnContext?: DialogTurnContext | null } = inject(NZ_MODAL_DATA);

  get requestTitle(): string | undefined {
    return getInteractionDisplayContent(this.data?.turnContext);
  }

  get requestPreview(): string | null {
    const normalized = (this.requestTitle ?? '').replace(/\s+/g, ' ').trim();
    if (!normalized) {
      return null;
    }

    return normalized.length > 56
      ? `${normalized.slice(0, 56).trimEnd()}...`
      : normalized;
  }

  get buttons(): DialogButton[] {
    return [
      { text: '放弃变更', type: 'default', danger: true, action: 'discard' },
      { text: '保留', type: 'primary', action: 'keep' },
    ];
  }

  onClose(): void {
    this.modalRef.close(null);
  }

  onButtonClick(action: string): void {
    this.modalRef.close(action);
  }
}
