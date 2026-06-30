import { Component, Input, OnChanges, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { AILY_CONFIRMATION_RESULT_EVENT } from '../../helpers/interaction-events';
import { XAilyConfirmationViewerComponent } from '../x-dialog/x-aily-confirmation-viewer/x-aily-confirmation-viewer.component';
import type { RuntimeConfirmationDecision } from '../../services/chat-runtime-interaction-host.service';
import type { ToolApprovalAction, ToolApprovalScope } from '../../helpers/tool-approval-ui';

export interface AilyConfirmationData {
  type: 'aily-confirmation';
  partId?: string;
  askId?: string;
  toolCallId?: string;
  toolName?: string;
  title?: string;
  message?: string;
  args?: any;
  subtitle?: string;
  source?: string;
  actions?: readonly ToolApprovalAction[];
  primaryScope?: ToolApprovalScope;
  result?: 'approved' | 'rejected';
  scope?: ToolApprovalScope;
  /** 审批是否已完成 */
  resolved?: boolean;
  /** 用户是否批准 */
  approved?: boolean;
}

@Component({
  selector: 'app-aily-confirmation-viewer',
  standalone: true,
  imports: [CommonModule, XAilyConfirmationViewerComponent],
  templateUrl: './aily-confirmation-viewer.component.html',
  styleUrls: ['./aily-confirmation-viewer.component.scss']
})
export class AilyConfirmationViewerComponent implements OnChanges {
  @Input() data: AilyConfirmationData | null = null;

  viewerData: Record<string, unknown> | null = null;

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['data']) {
      this.processData();
    }
  }

  setData(data: AilyConfirmationData): void {
    this.data = data;
    this.processData();
  }

  processData(): void {
    if (!this.data) {
      this.viewerData = null;
      return;
    }

    const resultApproved = this.data.result === 'approved';
    const resultRejected = this.data.result === 'rejected';
    const approved = resultApproved || (!!this.data.approved && !resultRejected);
    const resolved = !!this.data.resolved || resultApproved || resultRejected;
    this.viewerData = {
      kind: this.data.toolCallId ? 'approval' : 'confirmation',
      partId: this.data.partId || '',
      askId: this.data.askId || '',
      toolCallId: this.data.toolCallId || '',
      toolName: this.data.toolName || '',
      title: this.data.title || '',
      subtitle: this.data.subtitle || '',
      message: this.data.message || '',
      args: this.data.args,
      actions: Array.isArray(this.data.actions) ? this.data.actions : [],
      primaryScope: this.data.primaryScope || 'once',
      resolved,
      approved,
      scope: this.data.scope,
    };
  }

  onDecision(decision: RuntimeConfirmationDecision & { askId?: string; partId?: string; toolCallId?: string }): void {
    if (!this.data) {
      return;
    }

    const toolCallId = decision.toolCallId || this.data.toolCallId || '';
    const askId = decision.askId || this.data.askId || '';
    const partId = decision.partId || this.data.partId || '';
    document.dispatchEvent(new CustomEvent(AILY_CONFIRMATION_RESULT_EVENT, {
      detail: toolCallId
        ? { toolCallId, approved: decision.approved, scope: decision.scope, reason: decision.reason }
        : { askId, partId, approved: decision.approved, scope: decision.scope, reason: decision.reason }
    }));
  }

  logDetail(): void {
    // Intentionally quiet: chat renderers must not dump large payloads to DevTools.
  }
}
