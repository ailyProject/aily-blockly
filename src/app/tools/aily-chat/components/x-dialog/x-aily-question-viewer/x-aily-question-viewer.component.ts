import { Component, Input, OnChanges, SimpleChanges, ChangeDetectionStrategy, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AskUserOption, AskUserQuestion, AskUserAnswer } from '../../../tools/askUserTool';

/** 组件内部归一化的问题（所有字段必填） */
interface NormalizedQuestion {
  question: string;
  options: AskUserOption[];
  multi_select: boolean;
  allow_freeform: boolean;
}

interface AnswerRecord {
  selected: Set<number>;
  freeform: string;
}

@Component({
  selector: 'x-aily-question-viewer',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (questions.length > 0) {
      <div class="aq-container" [class.aq-all-done]="allDone">
        <!-- Header -->
        <div class="aq-header">
          <div class="aq-question">{{ currentQ.question }}</div>
          @if (!allDone && !isHistory) {
            <button class="aq-close" (click)="onSkip()" title="跳过">
              <i class="fa-solid fa-xmark"></i>
            </button>
          }
        </div>

        <!-- Options -->
        @if (currentQ.options.length > 0) {
          <div class="aq-options">
            @for (opt of currentQ.options; track $index) {
              <label class="aq-option"
                [class.aq-checked]="isOptionSelected($index)"
                [class.aq-disabled]="allDone || isHistory">
                <span class="aq-opt-num">{{ $index + 1 }}</span>
                <span class="aq-option-body">
                  <span class="aq-option-label">
                    {{ opt.label }}
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
                  [disabled]="allDone || isHistory"
                  (change)="toggleOption($index)" />
              </label>
            }
          </div>
        }

        <!-- Freeform input -->
        @if (currentQ.allow_freeform) {
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
              [disabled]="allDone || isHistory"
              (keydown.enter)="onConfirm()" />
          </div>
        }

        <!-- Bottom nav (Copilot style) -->
        @if (questions.length > 1 && (!allDone || isHistory)) {
          <div class="aq-nav">
            <button class="aq-nav-btn" [disabled]="currentIndex === 0" (click)="goPrev()">
              <i class="fa-solid fa-chevron-left"></i>
            </button>
            @if (!isHistory) {
              <button class="aq-nav-btn" (click)="goNextOrConfirm()">
                <i class="fa-solid fa-chevron-right"></i>
              </button>
            } @else {
              <button class="aq-nav-btn" [disabled]="isLastQuestion" (click)="goNext()">
                <i class="fa-solid fa-chevron-right"></i>
              </button>
            }
            <span class="aq-nav-page">{{ currentIndex + 1 }}/{{ questions.length }}</span>
            @if (!isHistory && isLastQuestion) {
              <button class="aq-nav-submit" [disabled]="!canSubmitAll" (click)="submitAll()">确认提交</button>
            }
          </div>
        }

        <!-- Single question: confirm button (same style as multi-question submit) -->
        @if (!allDone && !isHistory && questions.length === 1 && hasCurrentSelection) {
          <div class="aq-nav">
            <button class="aq-nav-submit" (click)="onConfirm()">确认提交</button>
          </div>
        }

        <!-- History: skipped indicator -->
        @if (isHistory && isCurrentSkipped) {
          <div class="aq-skipped-bar">
            <i class="fa-solid fa-forward"></i>
            <span>已跳过</span>
          </div>
        }

        <!-- All done result -->
        @if (allDone && !isHistory) {
          <div class="aq-done-bar">
            <i class="fa-solid fa-circle-check"></i>
            <span>{{ submittedSummary }}</span>
          </div>
        }
        @if (allDone && isHistory && !isMultiQuestion && !isCurrentSkipped) {
          <div class="aq-done-bar">
            <i class="fa-solid fa-circle-check"></i>
            <span>{{ historySummary || '已回答' }}</span>
          </div>
        }
      </div>
    }
  `,
  styles: [`
    .aq-container {
      border-radius: 10px;
      padding: 10px;
      margin: 0;
      background: var(--aily-chat-viewer-panel, #1e1e1e);
      border: 1px solid var(--aily-chat-viewer-border-soft, #333333);
      transition: border-color 0.2s;
      overflow: hidden;
      min-width: 0;
    }
    .aq-container:not(.aq-all-done):hover { border-color: var(--aily-chat-viewer-border, #444444); }
    .aq-all-done { opacity: 0.72; }

    /* Header */
    .aq-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 10px;
    }
    .aq-question {
      font-size: 13px;
      font-weight: 500;
      color: var(--aily-chat-viewer-title-fg, #d4d4d4);
      line-height: 1.5;
      flex: 1;
      min-width: 0;
      word-break: break-word;
      overflow-wrap: break-word;
      white-space: pre-wrap;
    }
    .aq-close {
      flex-shrink: 0;
      width: 24px; height: 24px;
      display: flex; align-items: center; justify-content: center;
      background: transparent; border: none; outline: none;
      color: var(--aily-text-disabled, #666666); font-size: 13px; cursor: pointer;
      border-radius: 4px; transition: all 0.15s;
    }
    .aq-close:hover { color: var(--aily-text-quaternary, #bbbbbb); background: var(--aily-chat-viewer-overlay-hover, rgba(255,255,255,0.06)); }

    /* Options */
    .aq-options { display: flex; flex-direction: column; gap: 6px; }
    .aq-option {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 10px;
      border-radius: 8px;
      cursor: pointer;
      background: var(--aily-chat-viewer-panel-raised, #252526);
      border: 1px solid var(--aily-chat-viewer-border-soft, #333333);
      transition: all 0.15s ease;
      user-select: none;
    }
    .aq-option:hover:not(.aq-disabled) { background: var(--aily-chat-viewer-option-hover, #2a2d2e); border-color: var(--aily-chat-viewer-border, #444444); }
    .aq-option.aq-checked:not(.aq-disabled) {
      background: var(--aily-chat-viewer-option-selected-bg, rgba(24, 144, 255, 0.08));
      border-color: var(--aily-chat-viewer-option-selected-border, rgba(24, 144, 255, 0.4));
    }
    .aq-option.aq-disabled { cursor: default; opacity: 0.6; }

    /* Option number prefix (Copilot style) */
    .aq-opt-num {
      flex-shrink: 0;
      font-size: 13px;
      font-weight: 600;
      color: var(--aily-chat-viewer-muted, #888888);
      line-height: 1.4;
    }
    .aq-check-icon {
      flex-shrink: 0;
      font-size: 12px;
      color: var(--aily-chat-viewer-title-fg, #d4d4d4);
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
      font-size: 13px;
      color: var(--aily-chat-viewer-fg, #cccccc);
      line-height: 1.4;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      white-space: pre-wrap;
      word-break: break-all;
    }
    .aq-badge-rec {
      display: inline-block;
      font-size: 10px;
      font-weight: 600;
      color: var(--aily-chat-viewer-primary, #1890ff);
      background: var(--aily-chat-viewer-badge-bg, rgba(24, 144, 255, 0.12));
      border-radius: 4px;
      padding: 1px 5px;
      line-height: 1.4;
      vertical-align: middle;
      white-space: nowrap;
    }
    .aq-option-desc {
      font-size: 11px;
      color: var(--aily-chat-viewer-option-desc, #777777);
      line-height: 1.3;
      white-space: pre-wrap;
      word-break: break-all;
    }

    .aq-hidden-input {
      position: absolute; opacity: 0; width: 0; height: 0; pointer-events: none;
    }

    /* Freeform */
    .aq-freeform {
      margin-top: 6px;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 0 12px;
    }
    .aq-freeform-only { margin-top: 0; padding: 0; }
    .aq-opt-num-free { flex-shrink: 0; }
    .aq-freeform-input {
      width: 100%;
      box-sizing: border-box;
      padding: 8px 12px;
      border-radius: 8px;
      border: 1px solid var(--aily-chat-viewer-border-soft, #333333);
      background: var(--aily-chat-viewer-panel-raised, #252526);
      color: var(--aily-chat-viewer-title-fg, #d4d4d4);
      font-size: 13px;
      outline: none;
      transition: border-color 0.2s;
    }
    .aq-freeform-input:focus { border-color: var(--aily-chat-viewer-primary, #1890ff); }
    .aq-freeform-input:disabled { opacity: 0.5; cursor: not-allowed; }
    .aq-freeform-input::placeholder { color: var(--aily-text-disabled, #666666); }

    /* Bottom nav (Copilot style) */
    .aq-nav {
      margin-top: 10px;
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .aq-nav-btn {
      width: 28px; height: 28px;
      display: flex; align-items: center; justify-content: center;
      background: transparent; border: none; outline: none;
      color: var(--aily-chat-viewer-subtle, #999999); font-size: 12px; cursor: pointer;
      border-radius: 4px; transition: all 0.15s;
    }
    .aq-nav-btn:hover:not(:disabled) { color: var(--aily-text-quaternary, #dddddd); background: var(--aily-chat-viewer-overlay-hover, rgba(255,255,255,0.06)); }
    .aq-nav-btn:disabled { opacity: 0.3; cursor: default; }
    .aq-nav-page {
      font-size: 12px;
      color: var(--aily-text-disabled, #666666);
      margin-left: 4px;
      user-select: none;
    }
    .aq-nav-confirm {
      padding: 4px 14px; border-radius: 4px;
      font-size: 12px; font-weight: 500;
      background: transparent; color: var(--aily-chat-viewer-subtle, #999999);
      border: 1px solid var(--aily-chat-viewer-border, #444444); outline: none;
      cursor: pointer; transition: all 0.15s;
    }
    .aq-nav-confirm:hover { color: var(--aily-text-quaternary, #dddddd); border-color: var(--aily-chat-viewer-btn-secondary-hover-border, #666666); }
    .aq-nav-submit {
      margin-left: auto;
      padding: 4px 14px; border-radius: 6px;
      font-size: 12px; font-weight: 500;
      background: var(--aily-chat-viewer-primary, #1890ff); color: var(--aily-chat-viewer-on-primary, #ffffff);
      border: none; outline: none;
      cursor: pointer; transition: all 0.15s;
    }
    .aq-nav-submit:hover:not(:disabled) { background: var(--aily-chat-viewer-primary-hover, #40a9ff); }
    .aq-nav-submit:disabled { opacity: 0.35; cursor: not-allowed; }

    /* Skipped indicator */
    .aq-skipped-bar {
      margin-top: 10px;
      display: flex; align-items: center; gap: 6px;
      font-size: 12px; color: var(--aily-chat-viewer-muted, #888888);
    }
    .aq-skipped-bar i { font-size: 11px; color: var(--aily-text-disabled, #666666); }

    /* Done bar */
    .aq-done-bar {
      margin-top: 10px;
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: var(--aily-chat-viewer-state-done, #52c41a);
    }
    .aq-done-bar i { font-size: 13px; }
    .aq-done-bar span { color: var(--aily-chat-viewer-muted, #888888); white-space: pre-wrap; word-break: break-all; }


  `],
})
export class XAilyQuestionViewerComponent implements OnChanges {
  @Input() data: any = null;
  @Input() streamStatus: string = 'done';

  questions: NormalizedQuestion[] = [];
  currentIndex = 0;
  isHistory = false;
  allDone = false;
  submittedSummary = '';

  answers = new Map<number, AnswerRecord>();
  answeredSet = new Set<number>();

  constructor(private cdr: ChangeDetectorRef) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['data']) this.processData();
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

  get hasCurrentSelection(): boolean {
    return this.currentAnswer.selected.size > 0 || this.currentAnswer.freeform.trim().length > 0;
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
    const ans = this.answers.get(0);
    if (!ans) return '';
    const q = this.questions[0];
    if (!q) return '';
    const labels = Array.from(ans.selected).sort((a, b) => a - b)
      .map(idx => q.options[idx]?.label).filter(Boolean);
    const parts = [...labels];
    if (ans.freeform.trim()) parts.push(ans.freeform.trim());
    return parts.length > 0 ? '已选择: ' + parts.join(', ') : '';
  }

  isOptionSelected(idx: number): boolean {
    return this.currentAnswer.selected.has(idx);
  }

  // ===== Actions =====

  toggleOption(index: number): void {
    if (this.allDone || this.isHistory) return;
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
    }
    this.cdr.markForCheck();
  }

  onFreeformChange(value: string): void {
    this.currentAnswer.freeform = value;
    this.cdr.markForCheck();
  }

  onConfirm(): void {
    if (this.allDone || !this.hasCurrentSelection) return;
    this.answeredSet.add(this.currentIndex);

    if (this.isLastQuestion) {
      this.submitAll();
    } else {
      this.currentIndex++;
      this.initRecommended(this.currentIndex);
      this.cdr.markForCheck();
    }
  }

  /** 多问题模式 > 按钮：非末页前进，末页不做操作（由提交按钮负责） */
  goNextOrConfirm(): void {
    if (this.allDone || this.isHistory) return;
    this.answeredSet.add(this.currentIndex);
    if (!this.isLastQuestion) {
      this.currentIndex++;
      this.initRecommended(this.currentIndex);
      this.cdr.markForCheck();
    }
  }

  /** 历史模式翻页 */
  goNext(): void {
    if (this.currentIndex < this.questions.length - 1) {
      this.currentIndex++;
      this.cdr.markForCheck();
    }
  }

  onSkip(): void {
    if (this.allDone || this.isHistory) return;
    // 清空当前回答，标记为已处理（跳过）
    this.answers.set(this.currentIndex, { selected: new Set(), freeform: '' });
    this.answeredSet.add(this.currentIndex);

    if (this.isLastQuestion) {
      this.submitAll();
    } else {
      this.currentIndex++;
      this.initRecommended(this.currentIndex);
      this.cdr.markForCheck();
    }
  }

  goPrev(): void {
    if (this.currentIndex > 0) {
      this.currentIndex--;
      this.cdr.markForCheck();
    }
  }

  // ===== Submit =====

  submitAll(): void {
    this.allDone = true;

    const answersMap: Record<string, AskUserAnswer> = {};
    const summaryParts: string[] = [];

    for (let i = 0; i < this.questions.length; i++) {
      const q = this.questions[i];
      const ans = this.answers.get(i);
      if (!ans) {
        answersMap[q.question] = { selected: [], freeText: null, skipped: true };
        continue;
      }

      const selectedLabels = Array.from(ans.selected)
        .sort((a, b) => a - b)
        .map(idx => q.options[idx]?.label)
        .filter(Boolean);

      const freeText = ans.freeform.trim() || null;

      answersMap[q.question] = {
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
    this.cdr.markForCheck();

    // 直接写入 data 对象，确保后续 saveSession 时 JSON.stringify 能序列化出 answers
    if (this.data && typeof this.data === 'object') {
      this.data.answers = answersMap;
    }

    document.dispatchEvent(new CustomEvent('aily-question-answer', {
      bubbles: true,
      detail: { answers: answersMap },
    }));
  }

  // ===== Data processing =====

  private processData(): void {
    // 已提交后忽略后续数据变更（防止 _patchAilyQuestionBlock 触发 re-render 导致重置）
    if (this.allDone && !this.isHistory) return;

    if (!this.data) {
      if (this.streamStatus === 'done') this.questions = [];
      return;
    }
    try {
      let rawQuestions: AskUserQuestion[];

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

      this.isHistory = this.data.isHistory === true;
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
      options,
      multi_select: d.multi_select ?? false,
      allow_freeform: d.allow_freeform ?? (options.length === 0),
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
    const savedAnswers: Record<string, AskUserAnswer> | undefined = this.data?.answers;
    console.log('[AilyQuestion] restoreAnswersFromHistory, data.answers:', savedAnswers, 'data keys:', Object.keys(this.data || {}));
    if (!savedAnswers) return;

    for (let i = 0; i < this.questions.length; i++) {
      const q = this.questions[i];
      const saved = savedAnswers[q.question];
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
}
