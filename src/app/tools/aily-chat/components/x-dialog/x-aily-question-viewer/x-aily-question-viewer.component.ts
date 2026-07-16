import { Component, Input, OnChanges, SimpleChanges, ChangeDetectionStrategy, ChangeDetectorRef, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AskUserOption, AskUserQuestion, AskUserAnswer } from '../../../core/ask-user';
import { ChatPartHeaderShellComponent } from '../chat-part-header-shell.component';

/** 组件内部归一化的问题（所有字段必填） */
interface NormalizedQuestion {
  id?: string;
  header?: string;
  question: string;
  options: AskUserOption[];
  multi_select: boolean;
  allow_freeform: boolean;
}

interface AnswerRecord {
  selected: Set<number>;
  freeform: string;
}

interface QuestionAnsweredEvent {
  answers: Record<string, AskUserAnswer>;
}

interface HistorySummaryItem {
  key: string;
  question: string;
  answer: string;
  skipped: boolean;
}

@Component({
  selector: 'x-aily-question-viewer',
  standalone: true,
  imports: [CommonModule, FormsModule, ChatPartHeaderShellComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (questions.length > 0) {
      <div class="aq-container" [class.aq-all-done]="allDone">
        <div class="aq-card" [class.aq-card-collapsed]="collapsed" [class.aq-card-summary]="showHistorySummaryList">
          @if (showHistorySummaryList) {
            <div class="aq-history-summary">
              @for (item of historySummaryItems; track item.key) {
                <div class="aq-history-summary-item" [class.aq-history-summary-skipped]="item.skipped">
                  <div class="aq-history-summary-question">{{ item.question }}</div>
                  <div class="aq-history-summary-answer">{{ item.answer }}</div>
                </div>
              }
            </div>
          } @else {
            <aily-chat-part-header-shell
            [title]="currentQ.question"
            [meta]="headerMeta"
            [pill]="headerPill"
            [pillTone]="headerTone"
            [tone]="headerTone"
            [iconClass]="headerIconClass"
            [showChevron]="true"
            [showExpandedConnector]="false"
            [clickable]="true"
            [expanded]="!collapsed"
            (toggleRequested)="toggleCollapsed()">
            @if (!allDone && !isHistory && interactive) {
              <span header-actions class="aq-header-actions">
                <button class="aq-close" type="button" (click)="onSkipFromHeader($event)" title="跳过" aria-label="跳过当前问题">
                  <i class="fa-solid fa-xmark"></i>
                </button>
              </span>
            }
          </aily-chat-part-header-shell>

          @if (!collapsed) {
            <div class="aq-body">
              <div class="aq-input-container">
                @if (!showHistorySummaryList && currentQ.options.length > 0) {
                  <div class="aq-options">
                    @for (opt of currentQ.options; track $index) {
                      <label class="aq-option"
                        [class.aq-checked]="isOptionSelected($index)"
                        [class.aq-disabled]="interactionLocked">
                        <span class="aq-opt-num">{{ $index + 1 }}</span>
                        <span class="aq-option-body">
                          <span class="aq-option-label">
                            <span>{{ opt.label }}</span>
                            @if (opt.recommended) {
                              <span class="aq-badge-rec">推荐</span>
                            }
                          </span>
                          @if (opt.description) {
                            <span class="aq-option-desc">{{ opt.description }}</span>
                          }
                        </span>
                        @if (isOptionSelected($index)) {
                          <i class="fa-solid fa-check aq-check-icon"></i>
                        }
                        <input type="checkbox" class="aq-hidden-input"
                          [checked]="isOptionSelected($index)"
                          [disabled]="interactionLocked"
                          (change)="toggleOption($index)" />
                      </label>
                    }
                  </div>
                }

                @if (!showHistorySummaryList && currentQ.allow_freeform) {
                  <div class="aq-freeform" [class.aq-freeform-only]="currentQ.options.length === 0">
                    @if (currentQ.options.length > 0) {
                      <span class="aq-opt-num aq-opt-num-free">{{ currentQ.options.length + 1 }}</span>
                    }
                    <input
                      class="aq-freeform-input"
                      type="text"
                      placeholder="Enter custom answer"
                      [ngModel]="currentAnswer.freeform"
                      (ngModelChange)="onFreeformChange($event)"
                      [disabled]="interactionLocked"
                      (keydown.enter)="onConfirm()" />
                  </div>
                }

                @if (resultSummary) {
                  <div class="aq-result-note">{{ resultSummary }}</div>
                }
              </div>

              @if (!showHistorySummaryList && questions.length > 1) {
                <div class="aq-nav">
                  <div class="aq-nav-left">
                    <button class="aq-nav-btn" [disabled]="currentIndex === 0" (click)="goPrev()">
                      <i class="fa-solid fa-chevron-left"></i>
                    </button>
                    @if (interactive && !isHistory) {
                      <button class="aq-nav-btn" (click)="goNextOrConfirm()">
                        <i class="fa-solid fa-chevron-right"></i>
                      </button>
                    } @else {
                      <button class="aq-nav-btn" [disabled]="isLastQuestion" (click)="goNext()">
                        <i class="fa-solid fa-chevron-right"></i>
                      </button>
                    }
                    <span class="aq-nav-page">{{ currentIndex + 1 }}/{{ questions.length }}</span>
                  </div>
                  @if (interactive && !isHistory && isLastQuestion) {
                    <div class="aq-nav-right">
                      <button class="aq-nav-submit" [disabled]="!canSubmitAll" (click)="submitAll()">确认提交</button>
                    </div>
                  }
                </div>
              }

              @if (interactive && !allDone && !isHistory && questions.length === 1 && hasCurrentSelection) {
                <div class="aq-nav aq-nav-single">
                  <div class="aq-nav-right">
                    <button class="aq-nav-submit" (click)="onConfirm()">确认提交</button>
                  </div>
                </div>
              }
            </div>
          }
          }
        </div>
      </div>
    }
  `,
  styles: [`
    :host {
      display: block;
      min-width: 0;
      --aq-fg: var(--chat-fg-head, var(--aily-text-quaternary, #e3e3e3));
      --aq-fg-dim: var(--chat-fg-dim, var(--aily-text-muted, #8e8e8e));
      --aq-fg-muted: var(--chat-fg-muted, var(--aily-text-disabled, #6a6a6a));
      --aq-border: var(--chat-border, var(--aily-chat-xdialog-msg-divider, rgba(255,255,255,0.12)));
      --aq-border-soft: color-mix(in srgb, var(--aq-border) 70%, transparent);
      --aq-bg: var(--aily-chat-viewer-overlay-soft, rgba(255,255,255,0.05));
      --aq-bg-hover: var(--aily-chat-viewer-option-hover, var(--chat-bg-hover, rgba(255,255,255,0.06)));
      --aq-bg-selected: var(--aily-chat-viewer-option-selected-bg, rgba(24,144,255,0.08));
      --aq-border-selected: var(--aily-chat-viewer-option-selected-border, rgba(24,144,255,0.35));
      --aq-info: var(--chat-info, var(--aily-chat-viewer-state-info, #75beff));
    }

    .aq-container {
      padding: 2px 0;
      margin: 0;
      min-width: 0;
    }
    .aq-all-done { opacity: 0.88; }

    .aq-card {
      display: flex;
      flex-direction: column;
      min-width: 0;
      margin: 0;
      border: 1px solid var(--chat-border, rgba(255,255,255,0.10));
      border-radius: 5px;
      background: rgba(255,255,255,0.02);
      overflow: hidden;
    }

    .aq-card-summary {
      padding: 8px;
    }

    .aq-body {
      display: flex;
      flex-direction: column;
      min-width: 0;
      border-top: 1px solid var(--chat-border, rgba(255,255,255,0.10));
    }

    .aq-header-actions {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      margin-left: -2px;
    }

    :host ::ng-deep .aq-card .cphs-header {
      margin-bottom: 0;
      padding: 8px 8px 8px 12px;
      border-radius: 0;
    }

    .aq-close {
      width: 22px;
      height: 22px;
      padding: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: none;
      border-radius: 5px;
      background: transparent;
      color: var(--chat-fg-dim, #8e8e8e);
      outline: none;
      cursor: pointer;
    }

    .aq-close:hover {
      background: rgba(255,255,255,0.04);
      color: var(--chat-fg, #cccccc);
    }

    .aq-input-container {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 8px;
      min-width: 0;
    }

    /* Options */
    .aq-options { display: flex; flex-direction: column; gap: 8px; }
    .aq-option {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 9px 10px;
      border-radius: 5px;
      cursor: pointer;
      background: var(--aq-bg);
      border: 1px solid var(--aq-border-soft);
      color: var(--aq-fg);
      transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
      user-select: none;
    }
    .aq-option:hover:not(.aq-disabled) {
      background: var(--aq-bg-hover);
      border-color: color-mix(in srgb, var(--aq-border) 88%, var(--aq-info) 12%);
      color: var(--aq-fg);
    }
    .aq-option.aq-checked {
      background: var(--aq-bg-selected);
      border-color: var(--aq-border-selected);
      box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--aq-border-selected) 18%, transparent);
    }
    .aq-option.aq-disabled { cursor: default; opacity: 0.6; }
    .aq-option.aq-disabled.aq-checked { opacity: 0.86; }

    /* Option number prefix (Copilot style) */
    .aq-opt-num {
      flex-shrink: 0;
      font-size: 12px;
      font-weight: 600;
      color: var(--aq-fg-muted);
      line-height: 1.35;
    }
    .aq-check-icon {
      flex-shrink: 0;
      font-size: 11px;
      color: var(--aq-info);
      margin-left: auto;
      align-self: center;
    }

    /* Option body (label + description) */
    .aq-option-body {
      display: flex;
      flex-direction: column;
      gap: 2px;
      flex: 1;
      min-width: 0;
    }
    .aq-option-label {
      font-size: 12px;
      color: var(--aq-fg);
      line-height: 1.4;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      white-space: pre-wrap;
      word-break: break-word;
      overflow-wrap: anywhere;
    }
    .aq-badge-rec {
      display: inline-block;
      font-size: 10px;
      font-weight: 600;
      color: var(--aq-info);
      background: var(--aily-chat-viewer-badge-bg, rgba(116, 179, 255, 0.12));
      border-radius: 5px;
      padding: 1px 6px;
      line-height: 1.4;
      vertical-align: middle;
      white-space: nowrap;
    }
    .aq-option-desc {
      font-size: 11px;
      color: var(--aq-fg-dim);
      line-height: 1.4;
      white-space: pre-wrap;
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .aq-hidden-input {
      position: absolute; opacity: 0; width: 0; height: 0; pointer-events: none;
    }

    /* Freeform */
    .aq-freeform {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 0;
    }
    .aq-freeform-only { margin-top: 0; padding: 0; }
    .aq-opt-num-free { flex-shrink: 0; }
    .aq-freeform-input {
      width: 100%;
      box-sizing: border-box;
      min-height: 22px;
      padding: 0 10px;
      border-radius: 5px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(255,255,255,0.02);
      color: var(--chat-fg, #cccccc);
      font-size: 12px;
      outline: none;
      transition: border-color 0.2s;
    }
    .aq-freeform-input:focus { border-color: #74b3ff; }
    .aq-freeform-input:disabled { opacity: 0.5; cursor: not-allowed; }
    .aq-freeform-input::placeholder { color: var(--chat-fg-muted, #6a6a6a); }

    /* Bottom nav (Copilot style) */
    .aq-nav {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 5px;
      padding: 5px;
      border-top: 1px solid var(--chat-border, rgba(255,255,255,0.10));
      min-width: 0;
    }

    .aq-nav-left,
    .aq-nav-right {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
    }

    .aq-nav-single {
      justify-content: flex-end;
    }

    .aq-nav-btn {
      width: 22px; height: 22px;
      display: flex; align-items: center; justify-content: center;
      background: transparent;
      border: none;
      outline: none;
      color: var(--chat-fg-dim, #8e8e8e);
      font-size: 11px;
      cursor: pointer;
      border-radius: 5px; transition: all 0.15s;
    }
    .aq-nav-btn:hover:not(:disabled) { color: var(--chat-fg, #cccccc); background: rgba(255,255,255,0.04); border-color: rgba(255,255,255,0.08); }
    .aq-nav-btn:disabled { opacity: 0.3; cursor: default; }
    .aq-nav-page {
      font-size: 11px;
      color: var(--chat-fg-muted, #6a6a6a);
      user-select: none;
    }
    .aq-nav-confirm {
      padding: 4px 14px; border-radius: 5px;
      font-size: 12px; font-weight: 500;
      background: transparent; color: #999;
      border: 1px solid #444; outline: none;
      cursor: pointer; transition: all 0.15s;
    }
    .aq-nav-confirm:hover { color: #ddd; border-color: #666; }
    .aq-nav-submit {
      margin-left: auto;
      min-height: 22px;
      padding: 0 10px; border-radius: 5px;
      font-size: 12px; font-weight: 400;
      background: #0e639c; color: #ffffff;
      border: 1px solid transparent; outline: none;
      cursor: pointer; transition: all 0.15s;
    }
    .aq-nav-submit:hover:not(:disabled) { background: #1177bb; }
    .aq-nav-submit:disabled { opacity: 0.35; cursor: not-allowed; }

    .aq-result-note {
      font-size: 11px;
      line-height: 1.35;
      color: var(--chat-fg-dim, #8e8e8e);
      white-space: pre-wrap;
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .aq-history-summary {
      display: flex;
      flex-direction: column;
      gap: 8px;
      min-width: 0;
    }

    .aq-history-summary-item {
      min-width: 0;
    }

    .aq-history-summary-question {
      font-size: 11px;
      line-height: 1.35;
      color: var(--aq-fg-dim);
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .aq-history-summary-answer {
      margin-top: 2px;
      font-size: 12px;
      line-height: 1.4;
      color: var(--aq-fg);
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .aq-history-summary-skipped .aq-history-summary-answer {
      color: var(--aq-fg-muted);
    }

  `],
})
export class XAilyQuestionViewerComponent implements OnChanges {
  @Input() data: any = null;
  @Input() streamStatus: string = 'done';
  @Input() interactive = true;
  @Output() answered = new EventEmitter<QuestionAnsweredEvent>();

  questions: NormalizedQuestion[] = [];
  currentIndex = 0;
  isHistory = false;
  allDone = false;
  submittedSummary = '';
  collapsed = false;

  answers = new Map<number, AnswerRecord>();
  answeredSet = new Set<number>();

  /** ★ 引用守卫：防止 parent CD 导致 processData 反复重置用户选择（参考 VSCode hasSameContent 模式） */
  private _lastQuestionsRef: any = null;
  private _lastAnswersRef: Record<string, AskUserAnswer> | undefined = undefined;
  private _lastHistoryFlag = false;

  constructor(private cdr: ChangeDetectorRef) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['data']) {
      this.collapsed = false;
      this.processData();
    }
  }

  // ===== Getters =====

  get currentQ(): NormalizedQuestion {
    return this.questions[this.currentIndex];
  }

  get currentAnswer(): AnswerRecord {
    if (!this.answers.has(this.currentIndex)) {
      this.answers.set(this.currentIndex, { selected: new Set(), freeform: '' });
    }
    return this.answers.get(this.currentIndex)!;
  }

  get headerIconClass(): string {
    if (this.allDone && !this.isHistory) {
      return 'fa-light fa-circle-check';
    }

    if (this.isHistory && this.isCurrentSkipped) {
      return 'fa-light fa-forward';
    }

    return 'fa-light fa-circle-question';
  }

  get headerTone(): 'neutral' | 'success' {
    return this.allDone && !this.isHistory ? 'success' : 'neutral';
  }

  get headerMeta(): string | undefined {
    return undefined;
  }

  get headerPill(): string | undefined {
    if (this.allDone && !this.isHistory) {
      return '已提交';
    }

    if (this.isHistory && this.isCurrentSkipped) {
      return '已跳过';
    }

    if (this.isHistory && !this.isMultiQuestion) {
      return '已回答';
    }

    return undefined;
  }

  get resultSummary(): string {
    if (this.allDone && !this.isHistory) {
      return this.submittedSummary;
    }

    if (this.isHistory) {
      return this.historySummary || (this.isCurrentSkipped ? '已跳过' : '');
    }

    return '';
  }

  get showHistorySummaryList(): boolean {
    return this.isHistory && this.historySummaryItems.length > 0;
  }

  get historySummaryItems(): HistorySummaryItem[] {
    if (!this.isHistory) return [];
    return this.questions.map((question, index) => {
      const answerRecord = this.answers.get(index);
      const answer = this.formatAnswerSummary(question, answerRecord);
      return {
        key: this.getQuestionAnswerKey(question),
        question: question.question,
        answer: answer || '已跳过',
        skipped: !answer,
      };
    });
  }

  toggleCollapsed(): void {
    this.collapsed = !this.collapsed;
    this.cdr.markForCheck();
  }

  get hasCurrentSelection(): boolean {
    return this.currentAnswer.selected.size > 0 || this.currentAnswer.freeform.trim().length > 0;
  }

  get interactionLocked(): boolean {
    return this.allDone || this.isHistory || !this.interactive;
  }

  get isLastQuestion(): boolean {
    return this.currentIndex === this.questions.length - 1;
  }

  get isMultiQuestion(): boolean {
    return this.questions.length > 1;
  }

  /** 多问题模式：至少有一个问题有回答才能提交 */
  get canSubmitAll(): boolean {
    for (let i = 0; i < this.questions.length; i++) {
      const ans = this.answers.get(i);
      if (ans && (ans.selected.size > 0 || ans.freeform.trim().length > 0)) return true;
    }
    return false;
  }

  /** 当前问题在历史模式下是否被跳过 */
  get isCurrentSkipped(): boolean {
    if (!this.isHistory) return false;
    const ans = this.answers.get(this.currentIndex);
    return !ans || (ans.selected.size === 0 && !ans.freeform.trim());
  }

  /** 历史模式摘要：显示用户之前的选择 */
  get historySummary(): string {
    const ans = this.answers.get(this.currentIndex);
    const q = this.questions[this.currentIndex];
    if (!q) return '';
    const answer = this.formatAnswerSummary(q, ans);
    return answer ? '已选择: ' + answer : '';
  }

  private formatAnswerSummary(question: NormalizedQuestion, answer: AnswerRecord | undefined): string {
    if (!answer) return '';
    const labels = Array.from(answer.selected).sort((a, b) => a - b)
      .map(idx => question.options[idx]?.label)
      .filter((label): label is string => Boolean(label));
    const parts = [...labels];
    const freeform = answer.freeform.trim();
    if (freeform) parts.push(freeform);
    return parts.join(', ');
  }

  private getQuestionAnswerKey(question: NormalizedQuestion): string {
    return question.id || question.header || question.question;
  }

  isOptionSelected(idx: number): boolean {
    return this.currentAnswer.selected.has(idx);
  }

  // ===== Actions =====

  toggleOption(index: number): void {
    if (this.interactionLocked) return;
    const ans = this.currentAnswer;
    if (this.currentQ.multi_select) {
      if (ans.selected.has(index)) {
        ans.selected.delete(index);
      } else {
        ans.selected.add(index);
      }
    } else {
      ans.selected.clear();
      ans.selected.add(index);
      this.onConfirm();
      return;
    }
    // ★ detectChanges 替代 markForCheck：仅触发自身 CD，
    // 阻断脏标记冒泡到 parent 导致 getQuestionData() 创建新对象
    this.cdr.detectChanges();
  }

  onFreeformChange(value: string): void {
    if (this.interactionLocked) return;
    this.currentAnswer.freeform = value;
    this.cdr.detectChanges();
  }

  onConfirm(): void {
    if (this.interactionLocked || !this.hasCurrentSelection) return;
    this.answeredSet.add(this.currentIndex);

    if (this.isLastQuestion) {
      this.submitAll();
    } else {
      this.currentIndex++;
      this.initRecommended(this.currentIndex);
      this.cdr.detectChanges();
    }
  }

  /** 多问题模式 > 按钮：非末页前进，末页不做操作（由提交按钮负责） */
  goNextOrConfirm(): void {
    if (this.interactionLocked) return;
    this.answeredSet.add(this.currentIndex);
    if (!this.isLastQuestion) {
      this.currentIndex++;
      this.initRecommended(this.currentIndex);
      this.cdr.detectChanges();
    }
  }

  /** 历史模式翻页 */
  goNext(): void {
    if (this.currentIndex < this.questions.length - 1) {
      this.currentIndex++;
      this.cdr.detectChanges();
    }
  }

  onSkip(): void {
    if (this.interactionLocked) return;
    // 清空当前回答，标记为已处理（跳过）
    this.answers.set(this.currentIndex, { selected: new Set(), freeform: '' });
    this.answeredSet.add(this.currentIndex);

    if (this.isLastQuestion) {
      this.submitAll();
    } else {
      this.currentIndex++;
      this.initRecommended(this.currentIndex);
      this.cdr.detectChanges();
    }
  }

  onSkipFromHeader(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    this.onSkip();
  }

  goPrev(): void {
    if (this.currentIndex > 0) {
      this.currentIndex--;
      this.cdr.detectChanges();
    }
  }

  // ===== Submit =====

  submitAll(): void {
    if (!this.interactive || this.isHistory) {
      return;
    }
    this.allDone = true;

    const answersMap: Record<string, AskUserAnswer> = {};
    const summaryParts: string[] = [];

    for (let i = 0; i < this.questions.length; i++) {
      const q = this.questions[i];
      const answerKey = this.getQuestionAnswerKey(q);
      const ans = this.answers.get(i);
      if (!ans) {
        answersMap[answerKey] = { selected: [], freeText: null, skipped: true };
        continue;
      }

      const selectedLabels = Array.from(ans.selected)
        .sort((a, b) => a - b)
        .map(idx => q.options[idx]?.label)
        .filter(Boolean);

      const freeText = ans.freeform.trim() || null;

      answersMap[answerKey] = {
        selected: selectedLabels,
        freeText,
        skipped: selectedLabels.length === 0 && !freeText,
      };

      const displayParts = [...selectedLabels];
      if (freeText) displayParts.push(freeText);
      if (displayParts.length > 0) summaryParts.push(displayParts.join(', '));
    }

    this.submittedSummary = summaryParts.length > 0
      ? '已提交: ' + summaryParts.join(' | ')
      : '已提交';
    this.cdr.detectChanges();

    // 直接写入 data 对象，确保后续 saveSession 时 JSON.stringify 能序列化出 answers
    if (this.data && typeof this.data === 'object') {
      this.data.answers = answersMap;
    }

    this.answered.emit({ answers: answersMap });
  }

  // ===== Data processing =====

  private processData(): void {
    // 已提交后忽略后续数据变更（防止 _patchAilyQuestionBlock 触发 re-render 导致重置）
    const incomingAnswers = this.readSavedAnswers();
    const incomingIsHistory = this.data?.isHistory === true;
    if (this.allDone && !this.isHistory && !incomingIsHistory && !incomingAnswers) return;

    if (!this.data) {
      if (this.streamStatus === 'done') this.questions = [];
      return;
    }
    try {
      let rawQuestions: AskUserQuestion[];
      const savedAnswers = incomingAnswers;
      const nextIsHistory = incomingIsHistory;

      // 主格式：{ questions: AskUserQuestion[] }（来自 chat-engine._handleAskUser）
      if (this.data.questions && Array.isArray(this.data.questions)) {
        rawQuestions = this.data.questions;
      } else if (Array.isArray(this.data)) {
        // 防御性兼容：直接传入数组
        rawQuestions = this.data;
      } else {
        this.questions = [];
        return;
      }

      // VS Code question carousel 会复用同一个 runtime widget。
      // 这里至少要把“语义相同但对象重建”的 live question 视为同一交互，
      // 避免映射层 remap 后把当前选择和分页重置掉。
      if (
        this.areQuestionsEquivalent(this._lastQuestionsRef, rawQuestions)
        && this.areSavedAnswersEquivalent(this._lastAnswersRef, savedAnswers)
        && this._lastHistoryFlag === nextIsHistory
        && this.questions.length > 0
      ) {
        return;
      }
      this._lastQuestionsRef = rawQuestions;
      this._lastAnswersRef = savedAnswers;
      this._lastHistoryFlag = nextIsHistory;

      this.isHistory = nextIsHistory;
      this.questions = rawQuestions
        .filter((d: any) => d.question && typeof d.question === 'string')
        .map((d: AskUserQuestion) => this.normalizeQuestion(d));

      if (this.questions.length === 0) return;

      this.currentIndex = 0;
      this.answers.clear();
      this.answeredSet.clear();
      this.allDone = false;
      this.submittedSummary = '';

      if (this.isHistory) {
        this.allDone = true;
        this.restoreAnswersFromHistory();
      } else {
        this.initRecommended(0);
      }
    } catch {
      this.questions = [];
    }
  }

  private normalizeQuestion(d: AskUserQuestion): NormalizedQuestion {
    const options: AskUserOption[] = Array.isArray(d.options)
      ? d.options.map(o => this.normalizeOption(o))
      : [];

    return {
      question: d.question,
      id: (d as { id?: string }).id,
      header: (d as { header?: string }).header,
      options,
      multi_select: d.multi_select ?? (d as { multiSelect?: boolean }).multiSelect ?? false,
      allow_freeform: d.allow_freeform
        ?? (d as { allowFreeform?: boolean }).allowFreeform
        ?? (d as { allowFreeformInput?: boolean }).allowFreeformInput
        ?? (options.length === 0),
    };
  }

  private normalizeOption(o: any): AskUserOption {
    if (typeof o === 'string') return { label: o };
    return {
      label: o.label ?? String(o),
      description: o.description,
      recommended: o.recommended ?? false,
    };
  }

  private initRecommended(qIndex: number): void {
    if (this.answers.has(qIndex)) return;
    const q = this.questions[qIndex];
    if (!q) return;
    const ans: AnswerRecord = { selected: new Set(), freeform: '' };
    q.options.forEach((o, i) => {
      if (o.recommended) ans.selected.add(i);
    });
    this.answers.set(qIndex, ans);
  }

  /**
   * 从历史数据中恢复用户之前的选择。
   * 数据格式：data.answers = { [questionText]: { selected: string[], freeText: string|null, skipped: boolean } }
   */
  private restoreAnswersFromHistory(): void {
    const savedAnswers = this.readSavedAnswers();
    if (!savedAnswers) return;

    for (let i = 0; i < this.questions.length; i++) {
      const q = this.questions[i];
      const saved = (q.id ? savedAnswers[q.id] : undefined)
        ?? (q.header ? savedAnswers[q.header] : undefined)
        ?? savedAnswers[q.question];
      if (!saved) continue;

      const ans: AnswerRecord = { selected: new Set(), freeform: saved.freeText || '' };

      // 将 label 匹配回 index
      if (Array.isArray(saved.selected)) {
        for (const label of saved.selected) {
          const idx = q.options.findIndex(o => o.label === label);
          if (idx >= 0) ans.selected.add(idx);
        }
      }

      this.answers.set(i, ans);
    }
  }

  private readSavedAnswers(): Record<string, AskUserAnswer> | undefined {
    const answers = this.data?.answers;
    if (!answers || typeof answers !== 'object') {
      return undefined;
    }
    return answers as Record<string, AskUserAnswer>;
  }

  private areQuestionsEquivalent(
    previous: AskUserQuestion[] | null | undefined,
    next: AskUserQuestion[] | null | undefined,
  ): boolean {
    if (previous === next) {
      return true;
    }
    if (!Array.isArray(previous) || !Array.isArray(next) || previous.length !== next.length) {
      return false;
    }

    return previous.every((prevQuestion, index) => {
      const nextQuestion = next[index];
      if (!nextQuestion) {
        return false;
      }
      if (
        prevQuestion.question !== nextQuestion.question
        || (prevQuestion as { id?: string }).id !== (nextQuestion as { id?: string }).id
        || (prevQuestion as { header?: string }).header !== (nextQuestion as { header?: string }).header
        || (prevQuestion.multi_select ?? false) !== (nextQuestion.multi_select ?? false)
        || ((prevQuestion as { multiSelect?: boolean }).multiSelect ?? false) !== ((nextQuestion as { multiSelect?: boolean }).multiSelect ?? false)
        || (prevQuestion.allow_freeform ?? false) !== (nextQuestion.allow_freeform ?? false)
        || ((prevQuestion as { allowFreeform?: boolean }).allowFreeform ?? false) !== ((nextQuestion as { allowFreeform?: boolean }).allowFreeform ?? false)
        || ((prevQuestion as { allowFreeformInput?: boolean }).allowFreeformInput ?? false) !== ((nextQuestion as { allowFreeformInput?: boolean }).allowFreeformInput ?? false)
      ) {
        return false;
      }

      const prevOptions = Array.isArray(prevQuestion.options) ? prevQuestion.options : [];
      const nextOptions = Array.isArray(nextQuestion.options) ? nextQuestion.options : [];
      if (prevOptions.length !== nextOptions.length) {
        return false;
      }

      return prevOptions.every((prevOption, optionIndex) => {
        const nextOption = nextOptions[optionIndex];
        return !!nextOption
          && prevOption.label === nextOption.label
          && prevOption.description === nextOption.description
          && !!prevOption.recommended === !!nextOption.recommended;
      });
    });
  }

  private areSavedAnswersEquivalent(
    previous: Record<string, AskUserAnswer> | undefined,
    next: Record<string, AskUserAnswer> | undefined,
  ): boolean {
    if (previous === next) {
      return true;
    }
    if (!previous || !next) {
      return false;
    }

    const previousKeys = Object.keys(previous);
    const nextKeys = Object.keys(next);
    if (previousKeys.length !== nextKeys.length) {
      return false;
    }

    return previousKeys.every((key) => {
      const prevAnswer = previous[key];
      const nextAnswer = next[key];
      if (!prevAnswer || !nextAnswer) {
        return false;
      }

      const prevSelected = Array.isArray(prevAnswer.selected) ? prevAnswer.selected : [];
      const nextSelected = Array.isArray(nextAnswer.selected) ? nextAnswer.selected : [];
      if (prevSelected.length !== nextSelected.length) {
        return false;
      }

      return prevAnswer.freeText === nextAnswer.freeText
        && !!prevAnswer.skipped === !!nextAnswer.skipped
        && prevSelected.every((value, index) => value === nextSelected[index]);
    });
  }
}
