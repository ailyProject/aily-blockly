import { ChangeDetectionStrategy, Component, Input, OnChanges, SimpleChanges, inject } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';

import type { QuestionPart } from '../../core/chat-parts';
import { projectAskUserToolDecisionData } from '../../core/ask-user-tool-projection';
import { projectToolCallApprovalDisplayData } from '../../core/tool-call-approval';
import { readToolApprovalCommand } from '../../core/tool-approval-input';
import { buildToolInvocationDisplaySummary } from '../../core/tool-invocation-formatter';
import type { ToolApprovalScope } from '../../helpers/tool-approval-ui';
import type { InteractionDecisionDisplayPart } from './chat-render-parts';

interface InteractionDecisionReceiptItem {
  readonly key: string;
  readonly kind: 'question' | 'approval';
  readonly prompt: string;
  readonly answer: string;
  readonly tone: 'success' | 'warn' | 'neutral';
  readonly iconClass?: string;
  readonly detail?: string;
  readonly detailKind?: 'text' | 'code';
}

@Component({
  selector: 'aily-chat-interaction-decision-receipt',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (items.length > 0) {
      <section class="cidr-card">
        @for (item of items; track item.key) {
          <div class="cidr-item">
            @if (item.kind === 'question') {
              <div class="cidr-line cidr-question">
                <span class="cidr-label">Q:</span>
                <span>{{ item.prompt }}</span>
              </div>
              <div class="cidr-line cidr-question-answer" [attr.data-tone]="item.tone">
                <span class="cidr-label">A:</span>
                <span>{{ item.answer }}</span>
              </div>
            } @else {
              <div class="cidr-prompt">{{ item.prompt }}</div>
              @if (item.detail) {
                <div class="cidr-detail" [attr.data-kind]="item.detailKind">{{ item.detail }}</div>
              }
              <div class="cidr-answer" [attr.data-tone]="item.tone">
                @if (item.iconClass) {
                  <i [class]="item.iconClass + ' cidr-answer-icon'"></i>
                }
                <span>{{ item.answer }}</span>
              </div>
            }
          </div>
        }
      </section>
    }
  `,
  styles: [`
    :host {
      display: block;
      min-width: 0;
      padding: 2px 0;
      --cidr-fg: var(--chat-fg-head, var(--aily-text-quaternary, #e3e3e3));
      --cidr-fg-dim: var(--chat-fg-dim, var(--aily-text-muted, #8e8e8e));
      --cidr-border: var(--chat-border, var(--aily-chat-xdialog-msg-divider, rgba(255,255,255,0.12)));
    }

    .cidr-card {
      display: flex;
      flex-direction: column;
      min-width: 0;
      overflow: hidden;
      border: 1px solid var(--cidr-border);
      border-radius: 5px;
      background: rgba(255,255,255,0.02);
    }

    .cidr-item {
      min-width: 0;
      padding: 8px;
    }

    .cidr-item + .cidr-item {
      border-top: 1px solid var(--cidr-border);
    }

    .cidr-prompt {
      color: var(--cidr-fg-dim);
      font-size: 11px;
      line-height: 1.35;
      white-space: pre-wrap;
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .cidr-line {
      display: grid;
      grid-template-columns: 18px minmax(0, 1fr);
      align-items: start;
      min-width: 0;
      font-size: 12px;
      line-height: 1.4;
      white-space: pre-wrap;
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .cidr-question {
      color: var(--cidr-fg-dim);
    }

    .cidr-question-answer {
      margin-top: 3px;
      color: var(--cidr-fg);
    }

    .cidr-question-answer[data-tone='neutral'] {
      color: var(--cidr-fg-dim);
    }

    .cidr-label {
      color: var(--cidr-fg-dim);
      font-weight: 600;
      user-select: none;
    }

    .cidr-detail {
      min-width: 0;
      margin-top: 4px;
      color: var(--cidr-fg);
      font-size: 12px;
      line-height: 1.4;
      white-space: pre-wrap;
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .cidr-detail[data-kind='code'] {
      font-family: var(--monaco-monospace-font, var(--aily-font-mono, Consolas, monospace));
    }

    .cidr-answer {
      display: flex;
      align-items: flex-start;
      gap: 6px;
      min-width: 0;
      margin-top: 3px;
      color: var(--cidr-fg);
      font-size: 12px;
      line-height: 1.4;
      white-space: pre-wrap;
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .cidr-answer-icon {
      flex: 0 0 auto;
      margin-top: 2px;
      font-size: 11px;
      line-height: 1;
    }

    .cidr-answer[data-tone='success'] .cidr-answer-icon {
      color: var(--chat-success, #89d185);
    }

    .cidr-answer[data-tone='warn'] .cidr-answer-icon {
      color: var(--chat-warn, #cca700);
    }

    .cidr-answer[data-tone='neutral'] {
      color: var(--cidr-fg-dim);
    }
  `],
})
export class ChatInteractionDecisionReceiptComponent implements OnChanges {
  private readonly translate = inject(TranslateService);

  @Input() part: InteractionDecisionDisplayPart | null = null;

  items: readonly InteractionDecisionReceiptItem[] = [];

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['part']) {
      this.items = this.projectItems(this.part);
    }
  }

  private projectItems(part: InteractionDecisionDisplayPart | null): readonly InteractionDecisionReceiptItem[] {
    if (!part) {
      return [];
    }

    if (part.interactionKind === 'question') {
      const data = part.source.type === 'question'
        ? { questions: part.source.questions, answers: part.source.answers }
        : part.source.type === 'tool_call'
          ? projectAskUserToolDecisionData(part.source)
          : null;
      return data ? this.projectQuestionItems(part.id, data.questions, data.answers) : [];
    }

    if (part.interactionKind === 'confirmation' && part.source.type === 'confirmation') {
      const approved = part.source.result === 'approved';
      const status = approved
        ? this.translate.instant('AILY_CHAT.PROCESS_CONFIRM_RESOLVED_APPROVED')
        : this.translate.instant('AILY_CHAT.PROCESS_CONFIRM_RESOLVED_CANCELLED');
      const selection = this.resolveSelection(
        part.source.scope,
        part.source.selectedActionId,
        part.source.selectedActionLabel,
      );
      return [{
        key: part.id,
        kind: 'approval',
        prompt: part.source.title || part.source.message,
        answer: this.joinStatusAndSelection(status, selection),
        tone: approved ? 'success' : 'warn',
        iconClass: approved ? 'fa-light fa-circle-check' : 'fa-light fa-circle-minus',
        ...this.resolveApprovalDetail({
          toolName: part.source.toolName,
          args: part.source.args,
          title: part.source.title,
          message: part.source.message,
          description: part.source.description,
        }),
      }];
    }

    if (part.interactionKind === 'approval' && part.source.type === 'tool_call') {
      const data = projectToolCallApprovalDisplayData(part.source);
      if (!data?.resolved) {
        return [];
      }
      const approved = data.approved === true;
      const status = approved
        ? this.translate.instant('AILY_CHAT.PROCESS_CONFIRM_SCOPE_ALLOWED')
        : this.translate.instant('AILY_CHAT.PROCESS_CONFIRM_RESOLVED_SKIPPED');
      const selection = this.resolveSelection(data.scope, data.selectedActionId, data.selectedActionLabel);
      return [{
        key: part.id,
        kind: 'approval',
        prompt: data.title || this.translate.instant('AILY_CHAT.PROCESS_APPROVAL_DEFAULT_TITLE'),
        answer: this.joinStatusAndSelection(status, selection),
        tone: approved ? 'success' : 'warn',
        iconClass: approved ? 'fa-light fa-circle-check' : 'fa-light fa-circle-minus',
        ...this.resolveApprovalDetail({
          toolName: data.toolName,
          args: data.args,
          title: data.title,
          message: data.message,
          description: data.description,
        }),
      }];
    }

    return [];
  }

  private projectQuestionItems(
    partId: string,
    questions: readonly { id?: string; header?: string; question: string }[],
    answers: QuestionPart['answers'],
  ): readonly InteractionDecisionReceiptItem[] {
    return questions.map((question, index) => {
      const answer = (question.id ? answers?.[question.id] : undefined)
        ?? (question.header ? answers?.[question.header] : undefined)
        ?? answers?.[question.question];
      const values = [
        ...(Array.isArray(answer?.selected) ? answer.selected : []),
        ...(typeof answer?.freeText === 'string' && answer.freeText.trim() ? [answer.freeText.trim()] : []),
      ];
      const uniqueValues = [...new Set(values)];
      const skipped = answer?.skipped === true || uniqueValues.length === 0;
      return {
        key: `${partId}:${question.id || question.header || index}`,
        kind: 'question',
        prompt: question.question,
        answer: skipped
          ? this.translate.instant('AILY_CHAT.PROCESS_CONFIRM_RESOLVED_SKIPPED')
          : uniqueValues.join(', '),
        tone: skipped ? 'neutral' : 'success',
      };
    });
  }

  private resolveApprovalDetail(input: {
    toolName?: string;
    args?: unknown;
    title?: string;
    message?: string;
    description?: string;
  }): Pick<InteractionDecisionReceiptItem, 'detail' | 'detailKind'> {
    const command = readToolApprovalCommand(input.toolName, input.args, input.message);
    if (command) {
      return { detail: command, detailKind: 'code' };
    }

    const message = this.normalizeDetailText(input.message, input.title);
    if (message && !this.isGenericToolApprovalMessage(message)) {
      return { detail: message, detailKind: 'text' };
    }

    if (input.toolName) {
      const summary = buildToolInvocationDisplaySummary({
        toolName: input.toolName,
        args: input.args,
        state: 'done',
      });
      if (summary?.label) {
        return {
          detail: [summary.label, summary.subtitle].filter(Boolean).join('\n'),
          detailKind: 'text',
        };
      }
    }

    if (message) {
      return { detail: message, detailKind: 'text' };
    }

    const description = this.normalizeDetailText(input.description, input.title);
    return description
      ? { detail: description, detailKind: 'text' }
      : {};
  }

  private normalizeDetailText(value: string | undefined, title: string | undefined): string {
    const text = value?.trim() || '';
    if (!text || text === title?.trim()) {
      return '';
    }
    return text;
  }

  private isGenericToolApprovalMessage(message: string): boolean {
    const normalized = message.trim();
    return /^(?:about to run tool|confirm(?:ing)? tool)\b/i.test(normalized)
      || normalized.startsWith('即将执行工具');
  }

  private resolveSelection(
    scope: ToolApprovalScope | undefined,
    selectedActionId?: string,
    selectedActionLabel?: string,
  ): string {
    if (selectedActionId && selectedActionLabel?.trim()) {
      return selectedActionLabel.trim();
    }

    return this.formatScope(scope) || selectedActionLabel?.trim() || '';
  }

  private formatScope(scope: ToolApprovalScope | undefined): string {
    switch (scope) {
      case 'once':
        return this.translate.instant('AILY_CHAT.PROCESS_CONFIRM_SCOPE_ONCE');
      case 'session':
        return this.translate.instant('AILY_CHAT.PROCESS_CONFIRM_SCOPE_SESSION');
      case 'workspace':
        return this.translate.instant('AILY_CHAT.PROCESS_CONFIRM_SCOPE_WORKSPACE');
      case 'session-all-terminal':
        return this.translate.instant('AILY_CHAT.PROCESS_CONFIRM_SCOPE_ALL_TERMINAL');
      case 'session-safe':
        return this.translate.instant('AILY_CHAT.PROCESS_CONFIRM_SCOPE_SAFE_TERMINAL');
      default:
        return '';
    }
  }

  private joinStatusAndSelection(status: string, selection: string): string {
    return selection && selection !== status ? `${status} / ${selection}` : status;
  }
}
