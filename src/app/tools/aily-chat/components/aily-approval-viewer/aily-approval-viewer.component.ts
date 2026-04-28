import { Component, Input, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';

export interface AilyApprovalData {
  type: 'aily-approval';
  toolCallId?: string;
  toolName?: string;
  title?: string;
  message?: string;
  args?: any;
  /** 审批是否已完成 */
  resolved?: boolean;
  /** 用户是否批准 */
  approved?: boolean;
}

@Component({
  selector: 'app-aily-approval-viewer',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './aily-approval-viewer.component.html',
  styleUrls: ['./aily-approval-viewer.component.scss']
})
export class AilyApprovalViewerComponent implements OnInit {
  @Input() data: AilyApprovalData | null = null;

  toolCallId = '';
  toolName = '';
  title = '确认操作';
  message = '';
  resolved = false;
  approved = false;

  ngOnInit() {
    this.processData();
  }

  setData(data: AilyApprovalData): void {
    this.data = data;
    this.processData();
  }

  processData(): void {
    if (!this.data) return;
    this.toolCallId = this.data.toolCallId || '';
    this.toolName = this.data.toolName || '';
    this.title = this.data.title || '确认操作';
    this.message = this.data.message || '';
    this.resolved = !!this.data.resolved;
    this.approved = !!this.data.approved;
  }

  approve(): void {
    this.resolved = true;
    this.approved = true;
    document.dispatchEvent(new CustomEvent('aily-approval-result', {
      detail: { toolCallId: this.toolCallId, approved: true }
    }));
  }

  reject(): void {
    this.resolved = true;
    this.approved = false;
    document.dispatchEvent(new CustomEvent('aily-approval-result', {
      detail: { toolCallId: this.toolCallId, approved: false, reason: '用户拒绝执行' }
    }));
  }

  logDetail(): void {
    console.log('[AilyApproval]', this.data);
  }
}
