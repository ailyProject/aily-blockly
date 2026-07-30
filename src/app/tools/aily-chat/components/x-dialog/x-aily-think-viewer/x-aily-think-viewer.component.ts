import {
  Component,
  Input,
  ViewChild,
  ElementRef,
  AfterViewChecked,
  OnChanges,
  SimpleChanges,
  OnDestroy,
  ChangeDetectorRef,
  ChangeDetectionStrategy,
  NgZone,
  inject,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { XMarkdownComponent } from 'ngx-x-markdown';
import type { StreamingOption, XMarkdownIncrementalRenderEvent } from 'ngx-x-markdown';
import {
  getThinkContent,
  getThinkContentLength,
} from '../../../core/think-content-store';
import { ChatPerformanceTracer } from '../../../services/chat-perf-tracer';
import { AilyMarkdownExternalLinksDirective } from '../../../directives/aily-markdown-external-links.directive';

@Component({
  selector: 'x-aily-think-viewer',
  standalone: true,
  imports: [CommonModule, XMarkdownComponent, AilyMarkdownExternalLinksDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="ac-think" [class.expanded]="thinkExpanded || embedded" [class.streaming]="data?.isComplete === false" [class.embedded]="embedded">
      @if (!embedded) {
        <div class="ac-think-header" (click)="thinkExpanded = !thinkExpanded">
          @if (data?.isComplete) {
            <i class="fa-light fa-circle-check ac-think-icon done"></i>
          } @else {
            <i class="fa-light fa-spinner-third ac-think-icon loading ac-spin"></i>
          }
          <span class="ac-think-label" [class.ac-think-shimmer]="data?.isComplete === false && !thinkExpanded">
            {{ displayLabel }}
          </span>
          <i class="fa-light fa-chevron-down ac-think-arrow"></i>
        </div>
      }
      @if (thinkExpanded || embedded) {
        <div class="ac-think-body" #thinkBody (scroll)="onThinkBodyScroll($event)">
          @if (markdownContent || activeContentRef) {
            <x-markdown
              [content]="markdownContent"
              [contentRef]="activeContentRef || undefined"
              [contentLength]="activeContentLength"
              [contentResolver]="markdownContentResolver"
              [streaming]="streamingConfig"
              rootClassName="x-markdown-dark ac-thinking-markdown"
              ailyMarkdownExternalLinks
              [heightChangeCallback]="markdownHeightChangeCallback"
              [incrementalRenderCallback]="markdownIncrementalRenderCallback"
            />
          }
        </div>
      }
    </div>
  `,
  styles: [
    `
      /*
       * Think Viewer — 对齐 Copilot chatThinkingContent.css
       * 使用 x-dialog 通过 DOM 传播的 --chat-* 变量
       * 无独立背景面板，内嵌在 aily 响应区内
       */
      :host {
        display: block;
        width: 100%;
        min-width: 0;
      }

      /* ===== 外层容器：无背景面板（Copilot .chat-thinking-box 风格）=====  */
      .ac-think {
        position: relative;
        margin: 2px 0;
        color: var(--chat-fg, #ccc);
        contain: layout style;
      }
      .ac-think.embedded {
        margin: 0;
        color: var(--chat-fg-dim, #8e8e8e);
        font-size: 12px;
        line-height: 1.35;
      }

      /* ===== 折叠头部（Copilot .monaco-button.monaco-icon-button 风格）===== */
      .ac-think-header {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 3px 4px;
        cursor: pointer;
        font-size: 13px;
        color: var(--chat-fg-dim, #8e8e8e);
        user-select: none;
        border-radius: 5px;
        transition: background 0.15s;
      }
      .ac-think-header:hover {
        background: var(--chat-bg-hover, rgba(255,255,255,0.06));
      }

      /* 状态图标 */
      .ac-think-icon {
        flex-shrink: 0;
        font-size: 12px;
        width: 14px;
        text-align: center;
      }
      .ac-think-icon.loading { color: var(--chat-info, #75beff); }
      .ac-think-icon.done    { color: var(--chat-success, #89d185); }

      /* 标签文字 */
      .ac-think-label {
        font-size: 13px;
        color: var(--chat-fg-dim, #8e8e8e);
        line-height: 1.4;
      }

      /* ===== Shimmer 扫光动画（Copilot chat-thinking-title-shimmer 对齐）===== */
      @keyframes ac-think-shimmer {
        0%   { background-position: 120% 0; }
        100% { background-position: -120% 0; }
      }
      .ac-think-shimmer {
        background: linear-gradient(90deg,
          var(--chat-fg-dim, #8e8e8e) 0%,
          var(--chat-fg-dim, #8e8e8e) 30%,
          var(--chat-shimmer, #4fc3f7) 50%,
          var(--chat-fg-dim, #8e8e8e) 70%,
          var(--chat-fg-dim, #8e8e8e) 100%);
        background-size: 400% 100%;
        background-clip: text;
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        animation: ac-think-shimmer 2s linear infinite;
        will-change: background-position;
      }

      /* 展开箭头 */
      .ac-think-arrow {
        margin-left: auto;
        font-size: 10px;
        color: var(--chat-fg-muted, #6a6a6a);
        transition: transform 0.15s ease;
      }
      .ac-think.expanded .ac-think-arrow {
        transform: rotate(180deg);
      }

      /* ===== 展开体：左侧连接线（Copilot chain-of-thought ::before 风格）===== */
      .ac-think-body {
        position: relative;
        padding: 4px 2px 6px 20px;
        margin-top: 2px;
        max-height: 200px;
        overflow-y: auto;
        overflow-x: hidden;
        scrollbar-width: thin;
        scrollbar-color: var(--chat-border, rgba(255,255,255,0.10)) transparent;
        scrollbar-gutter: stable;
        user-select: text;
      }
      .ac-think.embedded .ac-think-body {
        max-height: none;
        overflow: visible;
        scrollbar-gutter: auto;
        padding: 2px 12px 0 0px;
        padding-top: 0;
        margin-top: 0;
      }
      .ac-think.embedded .ac-think-body::before {
        content: none;
      }

      /* 垂直连接线 */
      .ac-think-body::before {
        content: '';
        position: absolute;
        left: 9px;
        top: 0;
        bottom: 0;
        width: 1px;
        background-color: var(--chat-border, rgba(255,255,255,0.10));
        mask-image: linear-gradient(to bottom,
          transparent 0px, #000 8px, #000 calc(100% - 8px), transparent 100%);
        -webkit-mask-image: linear-gradient(to bottom,
          transparent 0px, #000 8px, #000 calc(100% - 8px), transparent 100%);
      }

      /* Header → Body 弯曲连接弧 */
      .ac-think-header::after {
        content: none;
      }
      .ac-think.expanded .ac-think-header::after {
        content: '';
        position: absolute;
        left: 9px;
        top: 20px;
        height: 10px;
        width: 6px;
        border-left: 1px solid var(--chat-border, rgba(255,255,255,0.10));
        border-bottom: 1px solid var(--chat-border, rgba(255,255,255,0.10));
        border-bottom-left-radius: 4px;
        pointer-events: none;
      }
      .ac-think.expanded {
        position: relative;
      }

      /* Markdown 内容样式：复用普通 assistant markdown/code 组件；内嵌 activity 模式继承工具状态文本权重 */
      :host ::ng-deep .ac-think-body .x-markdown-dark {
        word-break: break-word;
        overflow-wrap: anywhere;
        white-space: normal;
        max-width: 100%;
        min-width: 0;
      }
      :host ::ng-deep .ac-think-body .x-markdown-dark * { max-width: 100%; }
      :host ::ng-deep .ac-think.embedded .ac-think-body .x-markdown-dark,
      :host ::ng-deep .ac-think.embedded .ac-think-body .x-markdown-dark p,
      :host ::ng-deep .ac-think.embedded .ac-think-body .x-markdown-dark li,
      :host ::ng-deep .ac-think.embedded .ac-think-body .x-markdown-dark blockquote {
        font-size: 12px;
        line-height: 1.35;
        color: var(--chat-fg-dim, #8e8e8e);
        font-weight: 400;
      }
      :host ::ng-deep .ac-think.embedded .ac-think-body .x-markdown-dark p {
        margin: 0 0 4px;
      }
      :host ::ng-deep .ac-think.embedded .ac-think-body .x-markdown-dark p:last-child {
        margin-bottom: 0;
      }
      :host ::ng-deep .ac-think.embedded .ac-think-body .x-markdown-dark strong {
        color: inherit;
        font-weight: 600;
      }
      :host ::ng-deep .ac-think-body .x-markdown-dark ul,
      :host ::ng-deep .ac-think-body .x-markdown-dark ol {
        padding-left: 1.2em;
      }
      :host ::ng-deep .ac-think.embedded .ac-think-body .x-markdown-dark ul,
      :host ::ng-deep .ac-think.embedded .ac-think-body .x-markdown-dark ol {
        margin: 2px 0 4px;
      }
      :host ::ng-deep .ac-think.embedded .ac-think-body .x-markdown-dark code:not(pre code) {
        font-size: 11px;
        line-height: 1.25;
        color: var(--chat-fg-dim, #8e8e8e);
        background: var(--chat-bg-subtle, rgba(255,255,255,0.04));
        border-radius: 3px;
        padding: 0 3px;
      }
      :host ::ng-deep .ac-think-body .x-markdown-dark pre {
        box-sizing: border-box;
        margin: 4px 0;
        padding: 6px 8px;
        max-width: 100%;
        overflow-x: auto;
        background-color: var(--aily-chat-viewer-code-bg, var(--chat-bg-subtle, rgba(255,255,255,0.04)));
        border: 1px solid var(--aily-chat-viewer-code-border, var(--chat-border-dim, rgba(255,255,255,0.08)));
        border-radius: 4px;
      }
      :host ::ng-deep .ac-think-body .ac-thinking-markdown pre > code[data-block='true'] {
        display: block;
        margin: 0;
        padding: 0;
        color: inherit;
        background: transparent;
        border-radius: 0;
        font-family: Consolas, 'Courier New', monospace;
        font-size: 11px;
        line-height: 1.5;
        white-space: pre-wrap;
        overflow-wrap: normal;
        word-break: normal;
      }
      :host ::ng-deep .ac-think-body .x-markdown-dark table {
        max-width: 100%;
        display: block;
        overflow-x: auto;
      }
      @keyframes ac-spin {
        to { transform: rotate(360deg); }
      }
      .ac-spin {
        animation: ac-spin 0.8s linear infinite;
        display: inline-block;
      }
    `,
  ],
})
export class XAilyThinkViewerComponent implements AfterViewChecked, OnChanges, OnDestroy {
  @Input() data: {
    content?: string;
    encoded?: boolean;
    isComplete?: boolean;
    ref?: string;
    contentLength?: number;
  } | null = null;
  @Input() embedded = false;
  @Input() impliedWordLoadRate: number | undefined;
  @Input() contentDeltaHandler: (() => void) | undefined;
  @ViewChild('thinkBody') thinkBodyRef?: ElementRef<HTMLElement>;
  @ViewChild(XMarkdownComponent) private markdownComponent?: XMarkdownComponent;

  thinkContent = '';
  thinkExpanded = false;
  readonly markdownHeightChangeCallback = () => this.onMarkdownHeightChange();
  markdownContent = '';
  streamingConfig: StreamingOption = {
    hasNextChunk: false,
    enableAnimation: false,
    buffering: 'paragraph',
    impliedWordLoadRate: undefined,
  };
  activeContentRef = '';
  activeContentLength = 0;
  readonly markdownContentResolver = (contentRef: string): string => getThinkContent(contentRef);
  readonly markdownIncrementalRenderCallback = (event: XMarkdownIncrementalRenderEvent): void => {
    ChatPerformanceTracer.recordDuration(
      'thinking_markdown_incremental_flush',
      event.durationMs,
      `raw=${event.markdownLength},rendered=${event.renderedLength},buffering=${event.buffering},final=${event.isFinalChunk}`,
      { slowThresholdMs: 16 },
    );
  };
  private shouldScrollThink = false;
  /** 用户未主动上滚时跟随流式到底部 */
  private thinkStickToBottom = true;
  private readonly thinkScrollBottomThresholdPx = 48;

  // ===== Title extraction & rotating phrases =====
  private _extractedTitle = '';
  private readonly _phrases = ['Thinking...', 'Reasoning...', 'Analyzing...', 'Considering...', 'Evaluating...'];
  private _phraseIndex = 0;
  private _phraseTimer: ReturnType<typeof setInterval> | null = null;
  displayLabel = 'Thinking...';
  private readonly ngZone = inject(NgZone);
  private readonly cdr = inject(ChangeDetectorRef);

  /** 从 think 内容开头提取 **粗体标题** */
  private _extractTitle(content: string): string {
    if (!content) return '';
    const match = content.match(/^\s*\*\*([^*]+)\*\*/);
    return match ? match[1].trim() : '';
  }

  /** 更新显示标签：完成时显示提取的标题或 "Thought"，流式中显示旋转短语 */
  private _updateLabel(): void {
    if (this.data?.isComplete) {
      this.displayLabel = this._extractedTitle || 'Thought';
      this._stopPhraseRotation();
    } else {
      this.displayLabel = this._phrases[this._phraseIndex];
    }
  }

  private _startPhraseRotation(): void {
    if (this.embedded) return;
    if (this._phraseTimer) return;
    this.ngZone.runOutsideAngular(() => {
      this._phraseTimer = setInterval(() => {
        this.ngZone.run(() => {
          this._phraseIndex = (this._phraseIndex + 1) % this._phrases.length;
          this.displayLabel = this._phrases[this._phraseIndex];
          this.cdr.markForCheck();
        });
      }, 3000);
    });
  }

  private _stopPhraseRotation(): void {
    if (this._phraseTimer) {
      clearInterval(this._phraseTimer);
      this._phraseTimer = null;
    }
  }

  private _lastRenderedRawLen = 0;

  ngOnChanges(changes: SimpleChanges): void {
    if (!this.data) return;
    const isStreaming = this.data.isComplete === false;
    this.streamingConfig = {
      hasNextChunk: isStreaming,
      enableAnimation: false,
      buffering: 'paragraph',
      impliedWordLoadRate: this.impliedWordLoadRate,
    };
    if (!changes['data']) {
      if (this.markdownComponent) {
        this.markdownComponent.streaming = this.streamingConfig;
      }
      return;
    }

    const prevData = changes['data'].previousValue as { isComplete?: boolean } | null | undefined;
    const prevStreaming = prevData && prevData.isComplete === false;

    // 首次进入流式：重置滚动状态
    if (this.data.isComplete === false && !prevStreaming) {
      this.thinkStickToBottom = true;
    }

    const contentRef = this.data.ref || '';
    this.activeContentRef = contentRef;

    if (contentRef && this.data.isComplete === false) {
      const rawLength = typeof this.data.contentLength === 'number'
        ? this.data.contentLength
        : getThinkContentLength(contentRef);
      this.thinkExpanded = true;
      this.shouldScrollThink = this.shouldAutoScrollThinkBody();
      this.refreshThinkingContentRef(contentRef, rawLength);
      this._startPhraseRotation();
      return;
    }

    // 获取原始内容
    let raw = '';
    let rawLength = 0;
    if (contentRef) {
      rawLength = getThinkContentLength(contentRef);
      raw = getThinkContent(contentRef);
    } else if (this.data.encoded && this.data.content) {
      try {
        raw = decodeURIComponent(atob(this.data.content));
      } catch {
        raw = this.data.content;
      }
    } else {
      raw = this.data.content || '';
    }
    if (!rawLength) {
      rawLength = raw.length;
    }
    // 提取标题（每次内容更新时尝试）
    if (!this._extractedTitle && raw.length > 10) {
      this._extractedTitle = this._extractTitle(raw);
    }

    // ★ 关键修复：isComplete 变化时立即渲染（不做节流）
    if (this.data.isComplete === true && prevStreaming) {
      this._renderNow(raw, true, rawLength);
      this.thinkExpanded = false;
      this._updateLabel();
      return;
    }

    if (this.data.isComplete === true) {
      this._updateLabel();
      // ★ 修复：首次以 isComplete=true 渲染时（历史/finalize），必须调用 _renderNow
      // 之前仅在 streaming→done 转换时渲染，直接 isComplete=true 时 raw 被计算但未渲染
      this._renderNow(raw, true, rawLength);
      return;
    }

    if (!this.data.isComplete) {
      this.thinkExpanded = true;
      this.shouldScrollThink = this.shouldAutoScrollThinkBody();
      this._scheduleRender(raw, rawLength);
      this._startPhraseRotation();
    }
  }

  private _scheduleRender(raw: string, rawLength = raw.length): void {
    this._renderNow(raw, false, rawLength);
  }

  /** Update the mounted streaming content part without checking its Angular parent item. */
  applyVisibleThinkingPatch(
    data: NonNullable<XAilyThinkViewerComponent['data']>,
    impliedWordLoadRate: number | undefined,
  ): boolean {
    const previousRef = this.data?.ref || '';
    const nextRef = data.ref || '';
    if (!previousRef || previousRef !== nextRef || this.data?.isComplete !== false || data.isComplete !== false) {
      return false;
    }

    this.data = data;
    this.impliedWordLoadRate = impliedWordLoadRate;
    this.streamingConfig = {
      hasNextChunk: true,
      enableAnimation: false,
      buffering: 'paragraph',
      impliedWordLoadRate,
    };
    const rawLength = typeof data.contentLength === 'number'
      ? data.contentLength
      : getThinkContentLength(nextRef);
    this.activeContentRef = nextRef;
    this.thinkExpanded = true;
    this.shouldScrollThink = this.shouldAutoScrollThinkBody();
    this.refreshThinkingContentRef(nextRef, rawLength);
    return true;
  }

  private refreshThinkingContentRef(contentRef: string, rawLength: number): void {
    if (rawLength < this._lastRenderedRawLen) {
      return;
    }
    this._lastRenderedRawLen = rawLength;
    this.activeContentLength = rawLength;
    const markdownComponent = this.markdownComponent;
    if (!markdownComponent) {
      return;
    }
    markdownComponent.content = '';
    markdownComponent.contentRef = contentRef;
    markdownComponent.contentLength = rawLength;
    markdownComponent.contentResolver = this.markdownContentResolver;
    markdownComponent.streaming = this.streamingConfig;
    markdownComponent.refreshExternalContent(rawLength);
  }

  private _renderNow(raw: string, isFinal: boolean, rawLength = raw.length): void {
    const surface = ChatPerformanceTracer.enterSurface(
      'thinking_render',
      `raw=${rawLength},final=${isFinal},embedded=${this.embedded}`,
    );
    const renderStartedAt = performance.now();
    try {
      if (!raw) {
        this.markdownContent = '';
        this.activeContentLength = 0;
        this.thinkContent = '';
        this._lastRenderedRawLen = 0;
        ChatPerformanceTracer.recordDuration('thinking_render_commit', performance.now() - renderStartedAt, 'empty', {
          slowThresholdMs: 8,
        });
        return;
      }

      if (!this.commitThinkingContent(raw, rawLength, isFinal)) {
        return;
      }

      const displayContent = raw;
      this.markdownContent = this.activeContentRef ? '' : displayContent;
      this.activeContentLength = rawLength;
      const markdownComponent = this.markdownComponent;
      if (markdownComponent) {
        markdownComponent.content = this.markdownContent;
        markdownComponent.contentRef = this.activeContentRef || undefined;
        markdownComponent.contentLength = rawLength;
        markdownComponent.contentResolver = this.markdownContentResolver;
        markdownComponent.streaming = this.streamingConfig;
        markdownComponent.refreshExternalContent(rawLength);
      }
      ChatPerformanceTracer.recordDuration(
        'thinking_render_commit',
        performance.now() - renderStartedAt,
        `raw=${rawLength},visible=${raw.length},display=${displayContent.length},final=${isFinal},embedded=${this.embedded}`,
        { slowThresholdMs: 8 },
      );
    } finally {
      surface.dispose();
    }
  }

  private commitThinkingContent(raw: string, rawLength: number, isFinal: boolean): boolean {
    if (!isFinal && rawLength < this._lastRenderedRawLen) {
      return false;
    }

    if (!isFinal && raw.length < this.thinkContent.length) {
      return false;
    }

    if (raw === this.thinkContent && rawLength === this._lastRenderedRawLen) {
      return false;
    }

    this.thinkContent = raw;
    this._lastRenderedRawLen = rawLength;
    return true;
  }

  onThinkBodyScroll(event: Event): void {
    const el = event.target as HTMLElement | null;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    this.thinkStickToBottom = dist <= this.thinkScrollBottomThresholdPx;
  }

  onMarkdownHeightChange(): void {
    // The activity group owns the single fixed-scrolling viewport, matching
    // VS Code's ChatThinkingContentPart. An embedded thinking item must not
    // force a second scrollHeight read/write transaction for every chunk.
    if (this.embedded) {
      this.contentDeltaHandler?.();
      return;
    }
    const el = this.thinkBodyRef?.nativeElement;
    if (el && this.thinkStickToBottom) {
      el.scrollTop = el.scrollHeight;
    }
    this.contentDeltaHandler?.();
  }

  ngAfterViewChecked(): void {
    if (!this.embedded && this.shouldScrollThink && this.thinkBodyRef?.nativeElement) {
      const el = this.thinkBodyRef.nativeElement;
      if (this.thinkStickToBottom) {
        el.scrollTop = el.scrollHeight;
      }
      this.shouldScrollThink = false;
    }
  }

  private shouldAutoScrollThinkBody(): boolean {
    return !this.embedded;
  }

  ngOnDestroy(): void {
    this._stopPhraseRotation();
  }
}
