import { ChangeDetectionStrategy, Component, HostBinding, Input, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TranslateModule } from '@ngx-translate/core';
import { XMarkdownComponent } from 'ngx-x-markdown';

import { AilyHost } from '../core/host';
import { AilyMarkdownExternalLinksDirective } from '../directives/aily-markdown-external-links.directive';
import { getBlocklyArtifactReferenceLabel, resolveBlocklyArtifactReferenceTarget } from '../helpers/chat-artifact-reference';
import { ChatRuntimeInteractionHostService } from '../services/chat-runtime-interaction-host.service';
import { ChatConfirmationActionsComponent, type ChatConfirmationActionOption } from './x-dialog/chat-confirmation-actions/chat-confirmation-actions.component';

@Component({
  selector: 'aily-chat-runtime-plan-review',
  standalone: true,
  imports: [CommonModule, TranslateModule, XMarkdownComponent, ChatConfirmationActionsComponent, AilyMarkdownExternalLinksDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (activeReview; as active) {
      <div class="rpr-shell">
        <div class="rpr-header">
          <div class="rpr-title-group">
            <div class="rpr-title">{{ active.data.title }}</div>
            @if (active.data.planUri; as planUri) {
              <div class="rpr-plan-ref-row">
                <div class="rpr-plan-ref">{{ getPlanLabel(planUri) }}</div>
                @if (canOpenPlan(planUri)) {
                  <button type="button" class="rpr-open-btn" (click)="openPlan(planUri, $event)">
                    {{ 'AILY_CHAT.PLAN_ACTION_OPEN_IN_EDITOR' | translate }}
                  </button>
                }
              </div>
            }
          </div>
          <div class="rpr-header-actions">
            @if (active.data.canProvideFeedback && active.data.planUri) {
              <button type="button" class="rpr-review-btn" (click)="toggleFeedbackMode()">
                {{ feedbackMode ? '隐藏反馈' : '审阅计划' }}
              </button>
            }
          </div>
        </div>

        <div class="rpr-body">
          <x-markdown [content]="active.data.content" rootClassName="x-markdown-dark" ailyMarkdownExternalLinks />
        </div>

        @if (showFeedbackSection(active)) {
          <div class="rpr-feedback">
            <label class="rpr-feedback-label" for="runtime-plan-review-feedback">反馈</label>
            <textarea
              id="runtime-plan-review-feedback"
              class="rpr-feedback-input"
              rows="4"
              [value]="feedbackText"
              placeholder="指出需要调整的计划内容或遗漏的风险。"
              (input)="updateFeedback(($any($event.target).value || '').toString())"></textarea>
          </div>
        }

        @if (showsFeedbackSubmit(active)) {
          <div class="rpr-footer rpr-footer-feedback">
            <label class="rpr-action-select-label" for="runtime-plan-review-action">批准后动作</label>
            <select
              id="runtime-plan-review-action"
              class="rpr-action-select"
              [value]="selectedActionId"
              (change)="selectAction(($any($event.target).value || '').toString())">
              @for (action of active.data.actions; track action.id) {
                <option [value]="action.id">{{ action.label }}</option>
              }
            </select>
            <div class="rpr-feedback-actions">
              <button
                type="button"
                class="rpr-submit-btn"
                [disabled]="feedbackText.trim().length === 0"
                (click)="submitFeedback()">提交反馈</button>
              <button type="button" class="rpr-reject-btn" (click)="reject()">拒绝</button>
            </div>
          </div>
        } @else {
          <div class="rpr-footer">
            <aily-chat-confirmation-actions
              [primaryLabel]="selectedActionLabel"
              [primaryValue]="selectedActionId"
              [primaryTooltip]="selectedActionDescription"
              [moreActionsTooltip]="'选择其他计划动作'"
              [rejectLabel]="'拒绝'"
              [rejectTooltip]="'拒绝当前计划审查结果'"
              [options]="actionOptions"
              (approve)="approve($event)"
              (reject)="reject()" />
          </div>
        }
      </div>
    }
  `,
  styles: [`
    :host {
      display: block;
      min-width: 0;
    }

    .rpr-shell {
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin: 0 0 8px;
      padding: 10px 12px;
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 10px;
      background: rgba(255,255,255,0.03);
    }

    .rpr-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
    }

    .rpr-title-group {
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .rpr-title {
      font-size: 12px;
      font-weight: 600;
      line-height: 1.4;
      color: var(--chat-fg, #cccccc);
    }

    .rpr-plan-ref {
      font-size: 11px;
      line-height: 1.35;
      color: var(--chat-fg-dim, #8e8e8e);
      word-break: break-word;
    }

    .rpr-plan-ref-row {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }

    .rpr-header-actions {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 8px;
      flex-wrap: wrap;
    }

    .rpr-review-btn,
    .rpr-open-btn,
    .rpr-submit-btn,
    .rpr-reject-btn {
      min-height: 24px;
      padding: 0 10px;
      border-radius: 6px;
      border: 1px solid rgba(255,255,255,0.08);
      background: transparent;
      color: var(--chat-fg, #cccccc);
      font-size: 12px;
      cursor: pointer;
    }

    .rpr-submit-btn {
      background: #0e639c;
      border-color: transparent;
      color: #ffffff;
    }

    .rpr-submit-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .rpr-body {
      min-width: 0;
      font-size: 12px;
      line-height: 1.5;
      color: var(--chat-fg, #cccccc);
    }

    .rpr-feedback {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .rpr-feedback-label,
    .rpr-action-select-label {
      font-size: 11px;
      color: var(--chat-fg-dim, #8e8e8e);
    }

    .rpr-feedback-input,
    .rpr-action-select {
      width: 100%;
      min-width: 0;
      border-radius: 8px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(0,0,0,0.18);
      color: var(--chat-fg, #cccccc);
      padding: 8px 10px;
      box-sizing: border-box;
      font-size: 12px;
      font-family: inherit;
    }

    .rpr-feedback-input {
      resize: vertical;
      min-height: 84px;
    }

    .rpr-footer {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .rpr-footer-feedback {
      align-items: stretch;
    }

    .rpr-feedback-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
  `],
})
export class ChatRuntimePlanReviewComponent {
  @Input() sessionId = '';

  private readonly runtimeHost = inject(ChatRuntimeInteractionHostService);

  feedbackMode = false;
  feedbackText = '';
  selectedActionId = '';

  get activeReview() {
    const active = this.sessionId ? this.runtimeHost.getActivePlanReview(this.sessionId) : null;
    if (!active) {
      this.feedbackMode = false;
      this.feedbackText = '';
      this.selectedActionId = '';
      return null;
    }

    if (!this.selectedActionId || !active.data.actions.some(action => action.id === this.selectedActionId)) {
      this.selectedActionId = this.resolveDefaultActionId(active.data.actions);
    }

    return active;
  }

  @HostBinding('class.has-plan-review')
  get hasPlanReview(): boolean {
    return !!this.activeReview;
  }

  get selectedActionLabel(): string {
    const active = this.activeReview;
    return active?.data.actions.find(action => action.id === this.selectedActionId)?.label || '批准计划';
  }

  get selectedActionDescription(): string {
    const active = this.activeReview;
    return active?.data.actions.find(action => action.id === this.selectedActionId)?.description || '';
  }

  get actionOptions(): readonly ChatConfirmationActionOption[] {
    const active = this.activeReview;
    if (!active) {
      return [];
    }

    return active.data.actions
      .filter(action => action.id !== this.selectedActionId)
      .map(action => ({
        value: action.id,
        label: action.label,
        tooltip: action.description,
      }));
  }

  toggleFeedbackMode(): void {
    this.feedbackMode = !this.feedbackMode;
  }

  showFeedbackSection(active: NonNullable<ChatRuntimePlanReviewComponent['activeReview']>): boolean {
    if (!active.data.canProvideFeedback) {
      return false;
    }

    return !active.data.planUri || this.feedbackMode;
  }

  showsFeedbackSubmit(active: NonNullable<ChatRuntimePlanReviewComponent['activeReview']>): boolean {
    return !!active.data.planUri && this.showFeedbackSection(active);
  }

  updateFeedback(value: string): void {
    this.feedbackText = value;
  }

  selectAction(actionId: string): void {
    this.selectedActionId = actionId;
  }

  approve(actionId: string): void {
    const active = this.activeReview;
    if (!active || !this.sessionId) {
      return;
    }

    this.selectedActionId = actionId;
    this.runtimeHost.resolvePlanReview(this.sessionId, active.id, {
      approved: true,
      actionId,
      ...(this.inlineFeedback.length > 0 ? { feedback: this.inlineFeedback } : {}),
    });
  }

  submitFeedback(): void {
    const active = this.activeReview;
    if (!active || !this.sessionId || this.inlineFeedback.length === 0) {
      return;
    }

    this.runtimeHost.resolvePlanReview(this.sessionId, active.id, {
      approved: false,
      actionId: this.selectedActionId,
      feedback: this.inlineFeedback,
    });
  }

  reject(): void {
    const active = this.activeReview;
    if (!active || !this.sessionId) {
      return;
    }

    this.runtimeHost.resolvePlanReview(this.sessionId, active.id, {
      approved: false,
    });
  }

  canOpenPlan(planUri: string): boolean {
    return Boolean(this.resolvePlanTarget(planUri)?.absolutePath && AilyHost.get().editor?.showTextDocument);
  }

  openPlan(planUri: string, event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();

    const target = this.resolvePlanTarget(planUri);
    const projectPath = AilyHost.get().project?.currentProjectPath || undefined;
    if (!target?.absolutePath || !AilyHost.get().editor?.showTextDocument) {
      return;
    }

    void Promise.resolve(AilyHost.get().editor.showTextDocument(target.absolutePath, { projectPath }));
  }

  getPlanLabel(planUri: string): string {
    const host = AilyHost.get();
    const cwd = host.project?.currentProjectPath || host.project?.projectRootPath || undefined;
    return `计划文件: ${getBlocklyArtifactReferenceLabel(host, planUri, { cwd, sessionId: this.sessionId })}`;
  }

  private get inlineFeedback(): string {
    return this.feedbackText.trim();
  }

  private resolveDefaultActionId(actions: readonly { id: string; default?: boolean }[]): string {
    return actions.find(action => action.default)?.id || actions[0]?.id || '';
  }

  private resolvePlanTarget(planUri: string) {
    const host = AilyHost.get();
    const cwd = host.project?.currentProjectPath || host.project?.projectRootPath || undefined;
    return resolveBlocklyArtifactReferenceTarget(host, planUri, { cwd, sessionId: this.sessionId });
  }
}
