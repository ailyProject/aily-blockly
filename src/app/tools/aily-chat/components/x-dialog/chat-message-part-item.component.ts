import {
  Component,
  Input,
  OnChanges,
  SimpleChanges,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  ViewChild,
  inject,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { TranslateModule } from '@ngx-translate/core';
import { XMarkdownComponent } from 'ngx-x-markdown';
import type {
  StreamingOption,
  ComponentMap,
  XMarkdownIncrementalFallbackEvent,
  XMarkdownIncrementalRenderEvent,
} from 'ngx-x-markdown';
import type { TurnRequest, TurnResponseTurn } from 'aily-lex/browser';

import { ChatPart, MarkdownPart, ErrorPart, QuestionPart, PlanPart } from '../../core/chat-parts';
import { AilyChatConfigService } from '../../services/aily-chat-config.service';
import { isDefaultAutoPresetSelected } from '../../helpers/model-billing-label';
import { AilyChatCodeComponent } from './aily-chat-code.component';
import { XAilyErrorViewerComponent, type ErrorActionItem } from './x-aily-error-viewer/x-aily-error-viewer.component';
import { XAilyQuestionViewerComponent } from './x-aily-question-viewer/x-aily-question-viewer.component';
import { ChatInteractionDecisionReceiptComponent } from './chat-interaction-decision-receipt.component';
import { ChatActivityGroupComponent } from './chat-activity-group.component';
import { ChatStandaloneToolCallComponent } from './chat-standalone-tool-call.component';
import { AilyMarkdownExternalLinksDirective } from '../../directives/aily-markdown-external-links.directive';
import { isGroupableActivityPart, isSubagentToolCall } from './chat-activity-group-projection';
import {
  isInteractionDecisionDisplayPart,
  isProgressMessageDisplayPart,
  isSyntheticChatDisplayPart,
  type InteractionDecisionDisplayPart,
  type ProgressMessageDisplayPart,
  type RenderableChatPart,
} from './chat-render-parts';
import { ChatEngineService } from '../../services/chat-engine.service';
import { ChatRuntimeInteractionHostService } from '../../services/chat-runtime-interaction-host.service';
import { ChatService, type ModelConfig } from '../../services/chat.service';
import {
  getMarkdownContent as readStoredMarkdownContent,
  getMarkdownContentLength as readStoredMarkdownContentLength,
} from '../../core/markdown-content-store';
import { ChatPerformanceTracer } from '../../services/chat-perf-tracer';

interface ContinueOnErrorConfirmationData {
  readonly ailyContinueOnError: true;
}

interface SwitchToAutoOnRateLimitConfirmationData {
  readonly ailySwitchToAutoOnRateLimit: true;
  readonly alwaysSwitchToAuto: boolean;
}

interface ContinueInteractionActionData {
  readonly ailyContinueInteraction: true;
}

interface RetryLastActionData {
  readonly ailyRetryLastAction: true;
}

type ErrorConfirmationData =
  | ContinueOnErrorConfirmationData
  | SwitchToAutoOnRateLimitConfirmationData
  | ContinueInteractionActionData
  | RetryLastActionData;

const PLAN_MARKDOWN_RENDER_CHAR_LIMIT = 6_000;
const PLAN_CHUNK_SIZE = 2_000;
const LARGE_MARKDOWN_RENDER_CHAR_LIMIT = 24_000;
const LARGE_MARKDOWN_CHUNK_SIZE = 4_000;

interface PlanTextChunk {
  readonly id: string;
  readonly text: string;
}

interface MarkdownTextChunk {
  readonly id: string;
  readonly text: string;
}

@Component({
  selector: 'aily-chat-message-part-item',
  standalone: true,
  imports: [
    CommonModule,
    TranslateModule,
    XMarkdownComponent,
    XAilyErrorViewerComponent,
    XAilyQuestionViewerComponent,
    ChatInteractionDecisionReceiptComponent,
    ChatActivityGroupComponent,
    ChatStandaloneToolCallComponent,
    AilyMarkdownExternalLinksDirective,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @switch (part?.type) {
      @case ('markdown') {
        @if (shouldRenderMarkdownAsChunkedText()) {
          <div class="chat-markdown-plain" role="text" aria-label="Assistant message">
            @for (chunk of getMarkdownTextChunks(); track chunk.id) {
              <span class="chat-markdown-text-chunk">{{ chunk.text }}</span>
            }
          </div>
        } @else {
          <x-markdown
            [content]="getMarkdownDisplayContent()"
            [contentRef]="getMarkdownContentRef()"
            [contentLength]="getMarkdownContentLengthInput()"
            [contentResolver]="markdownContentResolver"
            [streaming]="streamingConfig"
            [components]="componentMap"
            rootClassName="x-markdown-dark"
            ailyMarkdownExternalLinks
            [heightChangeCallback]="markdownHeightChangeCallback"
            [incrementalFallbackCallback]="markdownIncrementalFallbackCallback"
            [incrementalRenderCallback]="markdownIncrementalRenderCallback"
          />
        }
      }
      @case ('thinking') {
        @if (shouldUseStandaloneActivityGroup()) {
          <aily-chat-activity-group [parts]="getStandaloneActivityParts()" [doing]="doing" [sessionId]="sessionId" />
        }
      }
      @case ('tool_call') {
        @if (shouldUseStandaloneSubagentGroup()) {
          <aily-chat-activity-group [parts]="getStandaloneActivityParts()" [doing]="doing" [sessionId]="sessionId" />
        } @else if (isStandaloneToolCall()) {
          <aily-chat-standalone-tool-call [part]="asToolCall()" [sessionId]="sessionId" />
        }
      }
      @case ('state') {
        <aily-chat-activity-group [parts]="getStandaloneActivityParts()" [doing]="doing" [sessionId]="sessionId" />
      }
      @case ('error') {
        <x-aily-error-viewer [data]="getErrorData()" (action)="onErrorAction($event)" />
      }
      @case ('question') {
        @if (shouldRenderInlineQuestion()) {
          <x-aily-question-viewer
            [data]="getQuestionData()"
            [interactive]="isInteractiveInlineQuestion()"
            (answered)="onInlineQuestionAnswered($event)" />
        }
      }
      @case ('confirmation') {
        <aily-chat-activity-group [parts]="getStandaloneActivityParts()" [doing]="doing" [sessionId]="sessionId" />
      }
      @case ('terminal') {
        <aily-chat-activity-group [parts]="getStandaloneActivityParts()" [doing]="doing" [sessionId]="sessionId" />
      }
      @case ('plan') {
        <section class="chat-plan-card" [attr.data-plan-status]="getPlanData().status">
          <header class="chat-plan-card-header">
            <span class="chat-plan-card-icon ccenter">
              @if (getPlanData().status === 'streaming') {
                <i class="fa-light fa-spinner-third ac-spin"></i>
              } @else {
                <i class="fa-light fa-list-check"></i>
              }
            </span>
            <span class="chat-plan-card-title">Plan</span>
            <span class="chat-plan-card-status">{{ getPlanStatusLabel() }}</span>
          </header>
          <div class="chat-plan-card-body">
            @if (shouldRenderPlanAsChunkedText()) {
              <div class="chat-plan-card-plain" role="text" aria-label="Plan text">
                @for (chunk of getPlanTextChunks(); track chunk.id) {
                  <span class="chat-plan-text-chunk">{{ chunk.text }}</span>
                }
              </div>
            } @else {
              <x-markdown
                [content]="getPlanData().text"
                [streaming]="streamingConfig"
                [components]="componentMap"
                rootClassName="x-markdown-dark"
                ailyMarkdownExternalLinks
                [heightChangeCallback]="markdownHeightChangeCallback"
              />
            }
          </div>
          @if (shouldShowPlanActions()) {
            <footer class="chat-plan-card-actions">
              <button
                type="button"
                class="chat-plan-action chat-plan-action-primary"
                [disabled]="planActionBusy"
                (click)="startImplementation($event)">
                {{ 'AILY_CHAT.PLAN_ACTION_START_IMPLEMENTATION' | translate }}
              </button>
              <button
                type="button"
                class="chat-plan-action"
                [disabled]="planActionBusy"
                (click)="clearContextAndImplement($event)">
                {{ 'AILY_CHAT.PLAN_ACTION_CLEAR_CONTEXT_AND_IMPLEMENT' | translate }}
              </button>
              <button
                type="button"
                class="chat-plan-action"
                [disabled]="planActionBusy"
                (click)="stayInPlan($event)">
                {{ 'AILY_CHAT.PLAN_ACTION_STAY_IN_PLAN' | translate }}
              </button>
              <button
                type="button"
                class="chat-plan-action chat-plan-action-icon"
                [disabled]="planActionBusy"
                [title]="'AILY_CHAT.PLAN_ACTION_OPEN_IN_EDITOR' | translate"
                [attr.aria-label]="'AILY_CHAT.PLAN_ACTION_OPEN_IN_EDITOR' | translate"
                (click)="openPlanInEditor($event)">
                <i class="fa-light fa-up-right-from-square"></i>
              </button>
            </footer>
          }
        </section>
      }
      @case ('progress') {
        <div class="chat-working-progress" [attr.data-progress-kind]="getProgressData()?.progressKind || 'working'">
          <span class="chat-working-progress-icon ccenter">
            @if (getProgressData()?.settled) {
              <i class="fa-light fa-circle-check"></i>
            } @else {
              <i class="fa-light fa-spinner-third ac-spin"></i>
            }
          </span>
          <span class="chat-working-progress-text">{{ getProgressData()?.content }}</span>
        </div>
      }
      @case ('interaction_decision') {
        <aily-chat-interaction-decision-receipt
          [part]="getInteractionDecisionPart()" />
      }
    }
  `,
  styles: [`
    :host {
      display: block;
      width: 100%;
      min-width: 0;
    }

    @keyframes ac-spin {
      to {
        transform: rotate(360deg);
      }
    }

    .ac-spin {
      animation: ac-spin 0.8s linear infinite;
      display: inline-block;
    }

    .chat-working-progress {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      padding: 2px 0;
      color: var(--chat-fg-dim, #8e8e8e);
      font-size: 12px;
      line-height: 1.5;
    }

    .chat-working-progress-icon {
      flex: 0 0 auto;
      width: 14px;
      height: 14px;
      color: var(--chat-info, #75beff);
      font-size: 11px;
    }

    .chat-working-progress-text {
      min-width: 0;
      overflow-wrap: anywhere;
      word-break: break-word;
    }

    .chat-plan-card {
      border: 1px solid var(--chat-border, rgba(255, 255, 255, 0.14));
      border-radius: 8px;
      background: var(--chat-panel-bg, rgba(255, 255, 255, 0.045));
      overflow: hidden;
    }

    .chat-plan-card-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      border-bottom: 1px solid var(--chat-border, rgba(255, 255, 255, 0.12));
      color: var(--chat-fg, #d4d4d4);
      font-size: 12px;
      line-height: 1.4;
    }

    .chat-plan-card-icon {
      flex: 0 0 auto;
      width: 16px;
      height: 16px;
      color: var(--chat-info, #75beff);
      font-size: 12px;
    }

    .chat-plan-card-title {
      flex: 0 0 auto;
      font-weight: 600;
    }

    .chat-plan-card-status {
      min-width: 0;
      color: var(--chat-fg-dim, #9a9a9a);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .chat-plan-card-body {
      padding: 8px 10px 10px;
      min-width: 0;
    }

    .chat-plan-card-plain {
      margin: 0;
      min-width: 0;
      color: var(--chat-fg, #d4d4d4);
      font-family: var(--chat-font-family, inherit);
      font-size: 13px;
      line-height: 1.55;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      word-break: break-word;
    }

    .chat-plan-text-chunk {
      display: block;
      content-visibility: auto;
      contain-intrinsic-size: 0 180px;
    }

    .chat-markdown-plain {
      min-width: 0;
      color: var(--chat-fg, #d4d4d4);
      font-family: var(--chat-font-family, inherit);
      font-size: 13px;
      line-height: 1.55;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      word-break: break-word;
    }

    .chat-markdown-text-chunk {
      display: block;
      content-visibility: auto;
      contain-intrinsic-size: 0 220px;
    }

    .chat-plan-card-actions {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
      padding: 0 10px 10px;
    }

    .chat-plan-action {
      min-height: 26px;
      padding: 0 10px;
      border-radius: 6px;
      border: 1px solid rgba(255,255,255,0.12);
      background: rgba(255,255,255,0.04);
      color: var(--chat-fg, #d4d4d4);
      font-size: 12px;
      cursor: pointer;
    }

    .chat-plan-action-primary {
      background: #0e639c;
      border-color: transparent;
      color: #ffffff;
    }

    .chat-plan-action-icon {
      width: 28px;
      min-width: 28px;
      padding: 0;
    }

    .chat-plan-action:not(:disabled):hover {
      background: rgba(255,255,255,0.08);
    }

    .chat-plan-action-primary:not(:disabled):hover {
      background: #1177bb;
    }

    .chat-plan-action:disabled {
      opacity: 0.55;
      cursor: default;
    }
  `],
})
export class ChatMessagePartItemComponent implements OnChanges {
  @Input() renderItemId = '';
  @Input() part: RenderableChatPart | null = null;
  @Input() doing = false;
  @Input() sessionId = '';
  @Input() turnResponse: TurnResponseTurn | null = null;
  @Input() impliedWordLoadRate: number | undefined;

  readonly componentMap: ComponentMap = { code: AilyChatCodeComponent };
  readonly markdownHeightChangeCallback = () => this.onMarkdownHeightChange();
  readonly markdownIncrementalFallbackCallback = (event: XMarkdownIncrementalFallbackEvent) => (
    this.onMarkdownIncrementalFallback(event)
  );
  readonly markdownIncrementalRenderCallback = (event: XMarkdownIncrementalRenderEvent) => (
    this.onMarkdownIncrementalRender(event)
  );
  streamingConfig: StreamingOption = { hasNextChunk: false, enableAnimation: false };

  private readonly questionDataCache = new WeakMap<RenderableChatPart, {
    questions: QuestionPart['questions'];
    answers: QuestionPart['answers'];
    answersSignature: string;
    isHistory: boolean;
    data: any;
  }>();
  private readonly chatEngine = inject(ChatEngineService, { optional: true });
  private readonly chatService = inject(ChatService, { optional: true });
  private readonly ailyChatConfigService = inject(AilyChatConfigService, { optional: true });
  private readonly runtimeInteractionHost = inject(ChatRuntimeInteractionHostService, { optional: true });
  private readonly cdr = inject(ChangeDetectorRef);
  @ViewChild(XMarkdownComponent) private markdownComponent?: XMarkdownComponent;
  private planChunkCache: { readonly text: string; readonly chunks: readonly PlanTextChunk[] } | null = null;
  private markdownChunkCache: { readonly text: string; readonly chunks: readonly MarkdownTextChunk[] } | null = null;
  private activeMarkdownContentRef = '';
  private activeMarkdownContentLength = -1;
  private activeMarkdownPartIdentity = '';
  private liveMarkdownPartIdentity = '';
  private markdownDisplayContent = '';
  readonly markdownContentResolver = (contentRef: string): string => readStoredMarkdownContent(contentRef);
  planActionBusy = false;

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['doing'] || changes['impliedWordLoadRate']) {
      this.updateStreamingConfig();
    }

    if (changes['part'] || changes['doing']) {
      this.syncMarkdownDisplayContent();
    }
  }

  /**
   * Update an already-mounted content part in place. The transcript renderer
   * calls this only when the render-item identity and kind are unchanged,
   * matching VS Code's IChatContentPart.tryIncrementalUpdate boundary.
   */
  applyVisiblePartPatch(input: {
    readonly part: RenderableChatPart;
    readonly doing: boolean;
    readonly sessionId: string;
    readonly turnResponse: TurnResponseTurn | null;
    readonly impliedWordLoadRate?: number;
  }): boolean {
    const previousPart = this.part;
    if (!previousPart || previousPart.type !== input.part.type) {
      return false;
    }

    const previousMarkdown = previousPart.type === 'markdown' ? previousPart as MarkdownPart : null;
    const nextMarkdown = input.part.type === 'markdown' ? input.part as MarkdownPart : null;
    if (previousMarkdown && nextMarkdown
      && this.getMarkdownPartIdentity(previousMarkdown) !== this.getMarkdownPartIdentity(nextMarkdown)) {
      return false;
    }

    this.part = input.part;
    this.doing = input.doing;
    this.sessionId = input.sessionId;
    this.turnResponse = input.turnResponse;
    this.impliedWordLoadRate = input.impliedWordLoadRate;
    this.updateStreamingConfig();
    this.syncMarkdownDisplayContent();

    if (nextMarkdown && this.tryIncrementalMarkdownUpdate(previousMarkdown, nextMarkdown)) {
      return true;
    }

    this.cdr.detectChanges();
    return true;
  }

  getMarkdownDisplayContent(): string {
    return this.markdownDisplayContent;
  }

  getMarkdownContentRef(): string | undefined {
    const markdown = this.part?.type === 'markdown' ? this.part as MarkdownPart : null;
    return markdown?.contentRef || undefined;
  }

  getMarkdownContentLengthInput(): number | undefined {
    const markdown = this.part?.type === 'markdown' ? this.part as MarkdownPart : null;
    if (!markdown) {
      return undefined;
    }

    const contentRef = markdown.contentRef || '';
    if (contentRef && this.activeMarkdownContentRef === contentRef && this.activeMarkdownContentLength >= 0) {
      return this.activeMarkdownContentLength;
    }

    if (typeof markdown.contentLength === 'number') {
      return markdown.contentLength;
    }

    if (contentRef) {
      return readStoredMarkdownContentLength(contentRef);
    }

    return this.markdownDisplayContent.length;
  }

  shouldRenderMarkdownAsChunkedText(): boolean {
    const markdown = this.part?.type === 'markdown' ? this.part as MarkdownPart : null;
    if (!markdown) {
      return false;
    }
    if (this.doing) {
      return false;
    }

    // VS Code keeps the same ChatMarkdownContentPart mounted through the
    // completion diff. The chunked fallback is only for completed history
    // first-loads; switching a live part here would discard its morpher and
    // create a second completion render path.
    if (this.liveMarkdownPartIdentity === this.getMarkdownPartIdentity(markdown)) {
      return false;
    }

    const contentLength = typeof markdown.contentLength === 'number'
      ? markdown.contentLength
      : this.markdownDisplayContent.length;
    return contentLength > LARGE_MARKDOWN_RENDER_CHAR_LIMIT;
  }

  getMarkdownTextChunks(): readonly MarkdownTextChunk[] {
    const text = this.markdownDisplayContent;
    if (this.markdownChunkCache?.text === text) {
      return this.markdownChunkCache.chunks;
    }

    const chunks: MarkdownTextChunk[] = [];
    for (let offset = 0; offset < text.length; offset += LARGE_MARKDOWN_CHUNK_SIZE) {
      chunks.push({
        id: `markdown-chunk-${offset}`,
        text: text.slice(offset, offset + LARGE_MARKDOWN_CHUNK_SIZE),
      });
    }
    this.markdownChunkCache = { text, chunks };
    return chunks;
  }

  getStandaloneActivityParts(): readonly ChatPart[] {
    return this.part && !isSyntheticChatDisplayPart(this.part) ? [this.part] : [];
  }

  shouldUseStandaloneActivityGroup(): boolean {
    return !!this.part && !isSyntheticChatDisplayPart(this.part) && (this.part.type === 'state' || isGroupableActivityPart(this.part));
  }

  shouldUseStandaloneSubagentGroup(): boolean {
    return !!this.part && !isSyntheticChatDisplayPart(this.part) && this.part.type === 'tool_call' && isSubagentToolCall(this.part);
  }

  isStandaloneToolCall(): boolean {
    return !!this.part && !isSyntheticChatDisplayPart(this.part) && this.part.type === 'tool_call' && !isSubagentToolCall(this.part);
  }

  asToolCall(): any {
    return this.part as any;
  }

  getProgressData(): ProgressMessageDisplayPart | null {
    return isProgressMessageDisplayPart(this.part) ? this.part : null;
  }

  getInteractionDecisionPart(): InteractionDecisionDisplayPart | null {
    return isInteractionDecisionDisplayPart(this.part) ? this.part : null;
  }

  getPlanData(): PlanPart {
    return this.part as PlanPart;
  }

  getPlanStatusLabel(): string {
    switch (this.getPlanData().status) {
      case 'streaming':
        return 'Planning';
      case 'failed':
        return 'Plan failed';
      case 'completed':
      default:
        return 'Ready for review';
    }
  }

  shouldRenderPlanAsChunkedText(): boolean {
    const plan = this.part?.type === 'plan' ? this.part as PlanPart : null;
    if (!plan) {
      return false;
    }

    return plan.text.length > PLAN_MARKDOWN_RENDER_CHAR_LIMIT;
  }

  getPlanTextChunks(): readonly PlanTextChunk[] {
    const text = this.part?.type === 'plan' ? (this.part as PlanPart).text : '';
    if (this.planChunkCache?.text === text) {
      return this.planChunkCache.chunks;
    }

    const chunks: PlanTextChunk[] = [];
    for (let offset = 0; offset < text.length; offset += PLAN_CHUNK_SIZE) {
      chunks.push({
        id: `plan-chunk-${offset}`,
        text: text.slice(offset, offset + PLAN_CHUNK_SIZE),
      });
    }
    this.planChunkCache = { text, chunks };
    return chunks;
  }

  shouldShowPlanActions(): boolean {
    return !!this.part
      && this.part.type === 'plan'
      && this.part.status === 'completed'
      && !this.doing;
  }

  async startImplementation(event?: Event): Promise<void> {
    event?.preventDefault();
    event?.stopPropagation();
    await this.runPlanAction(() => this.chatEngine?.startImplementationFromPlanPart?.(
      this.sessionId,
      this.getPlanData().text,
    ));
  }

  async clearContextAndImplement(event?: Event): Promise<void> {
    event?.preventDefault();
    event?.stopPropagation();
    await this.runPlanAction(() => this.chatEngine?.clearContextAndImplementPlanPart?.(
      this.getPlanData().text,
      this.sessionId,
    ));
  }

  async stayInPlan(event?: Event): Promise<void> {
    event?.preventDefault();
    event?.stopPropagation();
    await this.runPlanAction(() => this.chatEngine?.stayInPlanFromPlanPart?.(this.sessionId));
  }

  async openPlanInEditor(event?: Event): Promise<void> {
    event?.preventDefault();
    event?.stopPropagation();
    await this.runPlanAction(() => this.chatEngine?.openPlanPartInEditor?.(
      this.getPlanData().text,
      this.sessionId,
    ));
  }

  private async runPlanAction(action: () => Promise<unknown> | undefined): Promise<void> {
    if (!this.shouldShowPlanActions() || this.planActionBusy) {
      return;
    }

    this.planActionBusy = true;
    this.cdr.markForCheck();
    try {
      await action();
    } finally {
      this.planActionBusy = false;
      this.cdr.detectChanges();
    }
  }

  private syncMarkdownDisplayContent(): void {
    const surface = ChatPerformanceTracer.enterSurface(
      'markdown_render',
      `doing=${this.doing},part=${this.part?.type ?? 'unknown'}`,
    );
    const startedAt = performance.now();
    try {
      const markdown = this.part?.type === 'markdown' ? this.part as MarkdownPart : null;
      const liveStreamingRef = !!markdown?.contentRef && this.doing;
      const markdownIdentity = this.getMarkdownPartIdentity(markdown);
      if (markdown && this.doing) {
        this.liveMarkdownPartIdentity = markdownIdentity;
      } else if (this.activeMarkdownPartIdentity
        && markdownIdentity !== this.activeMarkdownPartIdentity
        && this.liveMarkdownPartIdentity !== markdownIdentity) {
        this.liveMarkdownPartIdentity = '';
      }
      let rawContent = '';
      let nextLength = 0;

      if (markdown) {
        if (markdown.contentRef) {
          rawContent = liveStreamingRef ? '' : readStoredMarkdownContent(markdown.contentRef);
          if (typeof markdown.contentLength === 'number') {
            nextLength = markdown.contentLength;
          } else {
            nextLength = readStoredMarkdownContentLength(markdown.contentRef);
          }
        } else {
          rawContent = markdown.content;
          if (typeof markdown.contentLength === 'number') {
            nextLength = markdown.contentLength;
          } else {
            nextLength = rawContent.length;
          }
        }
      }

      let nextContent = rawContent;

      if (
        this.markdownDisplayContent === nextContent
        && this.activeMarkdownContentRef === (markdown?.contentRef || '')
        && this.activeMarkdownPartIdentity === markdownIdentity
        && this.activeMarkdownContentLength === nextLength
      ) {
        return;
      }

      if (!this.commitMarkdownDisplayContent({
        content: nextContent,
        rawLength: nextLength,
        contentRef: markdown?.contentRef || '',
        partIdentity: markdownIdentity,
        live: this.doing,
      })) {
        return;
      }
      ChatPerformanceTracer.recordDuration(
        'markdown_display_sync',
        performance.now() - startedAt,
        `raw=${rawContent.length},visible=${nextContent.length},ref=${!!markdown?.contentRef},doing=${this.doing}`,
        { slowThresholdMs: 8 },
      );
    } finally {
      surface.dispose();
    }
  }

  onMarkdownHeightChange(): void {
    this.chatEngine?.handleStreamingMarkdownHeightChange?.();
  }

  onMarkdownIncrementalFallback(event: XMarkdownIncrementalFallbackEvent): void {
    const markdown = this.part?.type === 'markdown' ? this.part as MarkdownPart : null;
    const partId = this.getMarkdownPartIdentity(markdown);
    ChatPerformanceTracer.increment('markdown_incremental_fallback.count');
    ChatPerformanceTracer.mark(
      'markdown_incremental_fallback',
      `session=${this.sessionId || 'unknown'},turn=${this.turnResponse?.turnId || this.turnResponse?.response?.id || 'unknown'},part=${partId || 'unknown'},ref=${markdown?.contentRef || 'inline'},previous=${event.previousLength},next=${event.nextLength},reason=${event.reason}`,
    );
  }

  onMarkdownIncrementalRender(event: XMarkdownIncrementalRenderEvent): void {
    const markdown = this.part?.type === 'markdown' ? this.part as MarkdownPart : null;
    const partId = this.getMarkdownPartIdentity(markdown);
    const detail = `session=${this.sessionId || 'unknown'},turn=${this.turnResponse?.turnId || this.turnResponse?.response?.id || 'unknown'},part=${partId || 'unknown'},ref=${markdown?.contentRef || 'inline'},raw=${event.markdownLength},rendered=${event.renderedLength},buffering=${event.buffering},final=${event.isFinalChunk}`;
    ChatPerformanceTracer.recordDuration(
      'markdown_incremental_flush',
      event.durationMs,
      detail,
      { slowThresholdMs: 16 },
    );
    if (event.durationMs >= 50) {
      ChatPerformanceTracer.increment('markdown_incremental_flush.hard_regression');
      ChatPerformanceTracer.mark('markdown_incremental_flush_hard_regression', `${event.durationMs.toFixed(1)}ms ${detail}`);
    }
    if (event.isFinalChunk) {
      console.info(
        '[AilyChat][MarkdownFinalRenderScalar]',
        `${detail},wallAt=${Date.now()}`,
      );
    }
  }

  private commitMarkdownDisplayContent(input: {
    content: string;
    rawLength: number;
    contentRef: string;
    partIdentity: string;
    live: boolean;
  }): boolean {
    const samePart = this.activeMarkdownPartIdentity === input.partIdentity;
    const sameRef = this.activeMarkdownContentRef === input.contentRef;
    const currentContent = this.markdownDisplayContent;

    if (input.live && samePart && sameRef) {
      if (input.rawLength >= 0 && this.activeMarkdownContentLength >= 0 && input.rawLength < this.activeMarkdownContentLength) {
        return false;
      }

      if (currentContent && input.content.length < currentContent.length) {
        return false;
      }
    }

    this.activeMarkdownContentRef = input.contentRef;
    this.activeMarkdownPartIdentity = input.partIdentity;
    this.activeMarkdownContentLength = input.rawLength;
    this.markdownDisplayContent = input.content;
    this.markdownChunkCache = null;
    return true;
  }

  private getMarkdownPartIdentity(markdown: MarkdownPart | null): string {
    if (!markdown) {
      return '';
    }

    return markdown.partId || markdown.contentRef || `${markdown.sourceAgentRole || 'main'}:${markdown.sequence ?? ''}:markdown`;
  }

  private updateStreamingConfig(): void {
    if (this.streamingConfig.hasNextChunk === this.doing
      && this.streamingConfig.enableAnimation === false
      && this.streamingConfig.buffering === 'paragraph'
      && this.streamingConfig.impliedWordLoadRate === this.impliedWordLoadRate) {
      return;
    }
    this.streamingConfig = {
      hasNextChunk: this.doing,
      enableAnimation: false,
      buffering: 'paragraph',
      impliedWordLoadRate: this.impliedWordLoadRate,
    };
  }

  private tryIncrementalMarkdownUpdate(
    previous: MarkdownPart | null,
    next: MarkdownPart,
  ): boolean {
    const markdownComponent = this.markdownComponent;
    if (!previous || !markdownComponent) {
      return false;
    }

    const nextLength = this.getMarkdownContentLengthInput() ?? next.content.length;
    if (!this.doing
      && nextLength > LARGE_MARKDOWN_RENDER_CHAR_LIMIT
      && this.liveMarkdownPartIdentity !== this.getMarkdownPartIdentity(next)) {
      return false;
    }

    markdownComponent.content = this.getMarkdownDisplayContent();
    markdownComponent.contentRef = this.getMarkdownContentRef();
    markdownComponent.contentLength = nextLength;
    markdownComponent.contentResolver = this.markdownContentResolver;
    markdownComponent.streaming = this.streamingConfig;
    markdownComponent.refreshExternalContent(nextLength);
    return true;
  }

  getStateData(): {
    state: string;
    text: string;
    id: string;
    progress?: number;
    kind?: any;
    metadata?: Record<string, unknown> | null;
  } {
    const sp = this.part as any;
    return {
      state: sp.state,
      text: sp.text,
      id: sp.stateId,
      progress: sp.progress,
      kind: sp.kind,
      metadata: sp.metadata || null,
    };
  }

  getErrorData(): {
    message: string;
    severity?: ErrorPart['severity'];
    metadata?: Record<string, unknown>;
    diagnostics?: Record<string, unknown>;
    actions?: readonly ErrorActionItem[];
  } {
    const errorPart = this.part as ErrorPart;
    const metadata = isRecord(errorPart.metadata) ? errorPart.metadata : undefined;
    const continuation = this.turnResponse?.response?.continuation as unknown as Record<string, unknown> | undefined;
    const budgets = continuation?.['budgets'];
    const continuationDiagnostics = isRecord(continuation?.['diagnostics']) ? continuation['diagnostics'] : undefined;
    const identity = isRecord(continuationDiagnostics?.['identity']) ? continuationDiagnostics['identity'] : undefined;
    const trace = isRecord(continuationDiagnostics?.['trace']) ? continuationDiagnostics['trace'] : undefined;
    const usage = isRecord(continuationDiagnostics?.['usage']) ? continuationDiagnostics['usage'] : undefined;
    const outcome = isRecord(continuationDiagnostics?.['outcome']) ? continuationDiagnostics['outcome'] : undefined;
    const behavior = isRecord(continuationDiagnostics?.['behavior']) ? continuationDiagnostics['behavior'] : undefined;
    const executionId = isRecord(budgets) ? readString(budgets['executionId']) : undefined;
    const diagnostics = compactRecord({
      interactionId: readString(continuation?.['interactionId']) ?? readString(identity?.['interactionId']),
      executionId: executionId ?? readString(identity?.['executionId']),
      requestId: readString(identity?.['requestId']),
      toolCallId: readString(trace?.['toolCallId']),
      stopReason: readString(continuation?.['stopReason']) ?? readString(outcome?.['stopReason']),
      hardStopReason: readString(continuation?.['hardStopReason']),
      status: readString(continuation?.['status']) ?? readString(outcome?.['status']),
      errorCode: readString(outcome?.['errorCode']),
      sourceEvent: readString(outcome?.['sourceEvent']),
      resolvedModel: readString(usage?.['resolvedModel']),
      modelBillingLabel: readString(usage?.['modelBillingLabel']),
      promptTokens: readNumberText(usage?.['promptTokens']),
      completionTokens: readNumberText(usage?.['completionTokens']),
      cacheReadTokens: readNumberText(usage?.['cacheReadTokens']),
      cacheCreationTokens: readNumberText(usage?.['cacheCreationTokens']),
      repeatedTextScore: readNumberText(behavior?.['repeatedTextScore']),
      repeatedChunkStreak: readNumberText(behavior?.['repeatedChunkStreak']),
      noProgressRounds: readNumberText(behavior?.['noProgressRounds']),
      repeatedToolCallStreak: readNumberText(behavior?.['repeatedToolCallStreak']),
      repeatedPendingStreak: readNumberText(behavior?.['repeatedPendingStreak']),
      syncConflictStreak: readNumberText(behavior?.['syncConflictStreak']),
      pendingInterruptions: readNumberText(behavior?.['pendingInterruptions']),
      pendingReplyOscillationCount: readNumberText(behavior?.['pendingReplyOscillationCount']),
      sameToolFingerprintCount: readNumberText(behavior?.['sameToolFingerprintCount']),
      samePendingFingerprintCount: readNumberText(behavior?.['samePendingFingerprintCount']),
      lastProgressAtRound: readNumberText(behavior?.['lastProgressAtRound']),
    });
    const actions = this.getErrorActions(metadata);

    return {
      message: errorPart.message,
      severity: errorPart.severity,
      ...(metadata ? { metadata } : {}),
      ...(Object.keys(diagnostics).length > 0 ? { diagnostics } : {}),
      ...(actions.length > 0 ? { actions } : {}),
    };
  }

  getQuestionData(): any {
    if (!this.part) {
      return null;
    }

    const qp = this.part as QuestionPart;
    const hasAnswers = !!qp.answers && Object.keys(qp.answers).length > 0;
    const isHistory = !!qp.isHistory || hasAnswers || !this.doing;
    const answersSignature = stringifyQuestionAnswers(qp.answers);
    const cached = this.questionDataCache.get(this.part);
    if (
      cached
      && cached.questions === qp.questions
      && cached.answers === qp.answers
      && cached.answersSignature === answersSignature
      && cached.isHistory === isHistory
    ) {
      return cached.data;
    }

    const data = { questions: qp.questions, answers: qp.answers, isHistory };
    this.questionDataCache.set(this.part, {
      questions: qp.questions,
      answers: qp.answers,
      answersSignature,
      isHistory,
      data,
    });
    return data;
  }

  shouldRenderInlineQuestion(): boolean {
    const data = this.getQuestionData();
    if (!data) {
      return false;
    }

    return data.isHistory;
  }

  isInteractiveInlineQuestion(): boolean {
    return false;
  }

  onInlineQuestionAnswered(result: { answers: Record<string, { selected: string[]; freeText: string | null; skipped: boolean }> }): void {
    if (!this.isInteractiveInlineQuestion()) {
      return;
    }

    if (!this.sessionId || !this.hasActiveInlineQuestion()) {
      return;
    }

    this.runtimeInteractionHost?.completeQuestion(this.sessionId, result);
  }

  onErrorAction(action: ErrorActionItem): void {
    void this.handleErrorAction(action);
  }

  private async handleErrorAction(action: ErrorActionItem): Promise<void> {
    if (!this.chatEngine) {
      return;
    }

    if (isContinueInteractionAction(action.data)) {
      await this.chatEngine.submitInteractionActionRequest(
        action.label,
        { kind: 'continue' },
        undefined,
        this.sessionId,
      );
      return;
    }

    if (isRetryLastAction(action.data)) {
      await this.chatEngine.retryLastAction();
      return;
    }

    if (isSwitchToAutoOnRateLimitConfirmation(action.data)) {
      const autoModel = this.resolveDefaultAutoModel();
      if (!autoModel || this.isDefaultAutoModelSelected()) {
        return;
      }

      if (action.data.alwaysSwitchToAuto) {
        this.chatService.setRateLimitAutoSwitchToAuto(true);
      }

      await this.chatEngine.switchToModel(autoModel);
    } else if (!isContinueOnErrorConfirmation(action.data)) {
      return;
    }

    await this.chatEngine.submitInteractionActionRequest(
      action.label,
      this.buildErrorConfirmationInteractionAction(action),
      undefined,
      this.sessionId,
    );
  }

  private hasActiveInlineQuestion(): boolean {
    if (!this.sessionId || this.part?.type !== 'question') {
      return false;
    }

    const activeQuestion = this.runtimeInteractionHost?.getQuestionWidget(this.sessionId);
    return !!activeQuestion && activeQuestion.partId === (this.part as QuestionPart).partId;
  }

  private getErrorActions(metadata: Record<string, unknown> | undefined): readonly ErrorActionItem[] {
    const errorDetails = isRecord(metadata?.['errorDetails']) ? metadata['errorDetails'] : undefined;
    const confirmationButtons = Array.isArray(errorDetails?.['confirmationButtons'])
      ? errorDetails['confirmationButtons']
      : [];

    const actions = confirmationButtons
      .map((button, index) => this.toErrorAction(button, index))
      .filter((button): button is ErrorActionItem => button !== null);
    if (actions.length === 0 && isContinuableErrorContinuation(this.turnResponse?.response?.continuation)) {
      return [{
        id: 'error-action-continue-interaction',
        label: '继续',
        data: { ailyContinueInteraction: true },
      }];
    }

    return actions;
  }

  private toErrorAction(value: unknown, index: number): ErrorActionItem | null {
    if (!isRecord(value)) {
      return null;
    }

    const label = readString(value['label']);
    const data = this.readErrorConfirmationData(value);
    if (!label || !data) {
      return null;
    }

    if (isSwitchToAutoOnRateLimitConfirmation(data)) {
      const autoModel = this.resolveDefaultAutoModel();
      if (!autoModel || this.isDefaultAutoModelSelected()) {
        return null;
      }
    }

    return {
      id: `error-action-${index}`,
      label,
      data,
      ...(value['isSecondary'] === true ? { isSecondary: true } : {}),
      ...(value['disabled'] === true ? { disabled: true } : {}),
    };
  }

  private readErrorConfirmationData(value: Record<string, unknown>): ErrorConfirmationData | null {
    const rawData = value['data'];
    if (isContinueOnErrorConfirmation(rawData)
      || isSwitchToAutoOnRateLimitConfirmation(rawData)
      || isContinueInteractionAction(rawData)
      || isRetryLastAction(rawData)) {
      return rawData;
    }

    const legacyAction = readString(value['action']);
    switch (legacyAction) {
      case 'switch_to_auto':
        return { ailySwitchToAutoOnRateLimit: true, alwaysSwitchToAuto: false };
      case 'try_again':
        return { ailyContinueOnError: true };
      default:
        return null;
    }
  }

  private buildErrorConfirmationInteractionAction(action: ErrorActionItem): NonNullable<TurnRequest['metadata']>['interactionAction'] {
    if (isContinueInteractionAction(action.data)) {
      return { kind: 'continue' };
    }

    const confirmationData = action.data === undefined ? [] : [action.data];
    return {
      kind: 'confirmation',
      payload: {
        result: action.isSecondary === true ? 'rejected' : 'approved',
        source: 'error_details',
        ...(action.isSecondary === true
          ? { rejectedConfirmationData: confirmationData }
          : { acceptedConfirmationData: confirmationData }),
      },
    };
  }

  private isDefaultAutoModelSelected(): boolean {
    return !!this.chatService?.currentModel && isDefaultAutoPresetSelected(this.chatService.currentModel);
  }

  private resolveDefaultAutoModel(): ModelConfig | null {
    if (!this.ailyChatConfigService) {
      return null;
    }

    return this.ailyChatConfigService.resolvePresetModel(
      this.ailyChatConfigService.getDefaultModelPresetId(),
    );
  }

}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function readNumberText(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? `${value}`
    : undefined;
}

function compactRecord(record: Record<string, string | undefined>): Record<string, string> {
  const entries = Object.entries(record).filter((entry): entry is [string, string] => {
    const value = entry[1];
    return typeof value === 'string' && value.length > 0;
  });

  return Object.fromEntries(entries);
}

function stringifyQuestionAnswers(answers: QuestionPart['answers']): string {
  if (!answers || Object.keys(answers).length === 0) {
    return '';
  }

  try {
    return JSON.stringify(answers);
  } catch {
    return Object.keys(answers).join('\n');
  }
}

function isContinueOnErrorConfirmation(value: unknown): value is ContinueOnErrorConfirmationData {
  return isRecord(value) && value['ailyContinueOnError'] === true;
}

function isSwitchToAutoOnRateLimitConfirmation(value: unknown): value is SwitchToAutoOnRateLimitConfirmationData {
  return isRecord(value)
    && value['ailySwitchToAutoOnRateLimit'] === true
    && typeof value['alwaysSwitchToAuto'] === 'boolean';
}

function isContinueInteractionAction(value: unknown): value is ContinueInteractionActionData {
  return isRecord(value) && value['ailyContinueInteraction'] === true;
}

function isRetryLastAction(value: unknown): value is RetryLastActionData {
  return isRecord(value) && value['ailyRetryLastAction'] === true;
}

function isContinuableErrorContinuation(
  continuation: TurnResponseTurn['response']['continuation'] | null | undefined,
): boolean {
  if (!continuation || typeof continuation !== 'object') {
    return false;
  }

  const interactionId = typeof continuation.interactionId === 'string'
    ? continuation.interactionId.trim()
    : '';
  const lease = typeof continuation.lease === 'string'
    ? continuation.lease.trim()
    : '';
  if (!interactionId || !lease || !Number.isFinite(continuation.stepIndex)) {
    return false;
  }

  const pendingState = continuation.pendingState && typeof continuation.pendingState === 'object'
    ? continuation.pendingState as Record<string, unknown>
    : undefined;
  const pendingKind = typeof pendingState?.['kind'] === 'string'
    ? pendingState['kind']
    : undefined;
  return pendingKind === 'continue';
}
