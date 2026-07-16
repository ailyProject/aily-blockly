/**
 * ChatActivityGroupComponent — 统一活动组渲染器
 *
 * 对标 Copilot `ChatThinkingContentPart extends ChatCollapsibleContentPart` 的结构，
 * 将 thinking/tool_call/state 等所有活动类 Part 聚合在单一可折叠组件中。
 *
 * DOM 对齐：
 *   .cag              → Copilot .chat-used-context / .chat-thinking-box
 *   button.cag-header → Copilot .chat-used-context-label button (border:0; padding:2px 6px 2px 2px)
 *   .cag-list         → Copilot .chat-used-context-list.chat-thinking-collapsible (border:none; margin-left:5px)
 *   .cag-item         → Copilot .chat-thinking-tool-wrapper / .chat-thinking-item
 *     .cag-item-icon  → Copilot .chat-thinking-icon (position:absolute; left:5px; top:9px; 12×12)
 */

import {
  AfterViewChecked,
  ChangeDetectorRef,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Input,
  OnChanges,
  OnDestroy,
  SimpleChanges,
  ViewChild,
  inject,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import type { TurnResponseTurn } from 'aily-lex/browser';

import { ChatPart, ConfirmationPart, MarkdownPart, StatePart, TerminalPart, ThinkingPart, ToolCallPart, getParentToolCallId, getSubAgentInvocationId, isSubagentChildPart } from '../../core/chat-parts';
import { ChatRuntimeInteractionHostService } from '../../services/chat-runtime-interaction-host.service';
import {
  buildConfirmationActivityDisplayItem,
  buildPrimaryActivitySummary,
  buildTodoPrimaryActivitySummary,
  buildSubagentActivityItems,
  buildActivityGroupPresentation,
  buildInvocationDetailDisplay,
  buildTerminalActivityDisplayItem,
  buildToolActivityDisplayItem,
  buildResolvedApprovalSummary,
  buildScopedMarkdownActivityDisplayItem,
  buildThinkingActivityPresentation,
  buildStateActivityShellPresentation,
  buildChatPartIdentity,
  getPreparedDetailSections,
  isSubagentToolCall,
} from './chat-activity-group-projection';
import { ChatActivityListComponent } from './chat-activity-list.component';
import type { ActivityGroupDisplayItem, ActivityGroupHeaderDisplayData } from './chat-activity-group.types';
import {
  buildTurnResponseContinuationDetailSections,
  type DetailSectionDescriptor,
} from './x-aily-state-viewer/activity-detail-items';
import { ChatPerformanceTracer } from '../../services/chat-perf-tracer';
import { isTerminalSessionToolName } from '../../core/tool-name-normalizer';
import { storeThinkContent } from '../../core/think-content-store';

@Component({
  selector: 'aily-chat-activity-group',
  standalone: true,
  imports: [CommonModule, ChatActivityListComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="cag"
      [attr.data-state]="groupState"
      [class.cag-expanded]="expanded"
      [class.cag-first-item-not-tool]="isFirstItemNotTool"
      [class.cag-fixed-streaming]="useFixedViewport"
      [class.cag-fade-top]="showDetailViewportTopFade"
      [class.cag-fade-bottom]="showDetailViewportBottomFade">
      <button
        type="button"
        class="cag-header"
        [attr.aria-expanded]="expanded"
        (click)="toggle()">
        <div class="cag-icon-shell ccenter" [class.loading-icon]="isGroupSpinning" [class.lloading]="isGroupSpinning">
          <i [class]="groupIconClass" class="cag-icon"></i>
        </div>
        @switch (groupHeader.kind) {
          @case ('subagent') {
            <span class="cag-title cag-subagent-prefix">{{ groupHeader.title }}:</span>
            @if (groupHeader.detail) {
              <span class="cag-subagent-detail cag-subtitle" [class.cag-shimmer]="isGroupSpinning && !expanded">{{ groupHeader.detail }}</span>
            }
          }
          @case ('thinking') {
            <span class="cag-group-thinking-header">
              <span class="cag-title cag-thinking-title">{{ groupHeader.title }}</span>
              @if (groupHeader.titleDetail) {
                <span class="cag-thinking-title-detail" [class.cag-shimmer]="isGroupSpinning && !expanded">{{ groupHeader.titleDetail }}</span>
              }
            </span>
          }
          @case ('tool') {
            <span class="cag-group-tool-header">
              <span class="cag-title cag-tool-group-title">{{ groupHeader.title }}</span>
              @if (groupHeader.detail) {
                <span class="cag-tool-group-detail cag-subtitle" [class.cag-shimmer]="isGroupSpinning && !expanded">{{ groupHeader.detail }}</span>
              }
            </span>
          }
          @case ('state') {
            <span class="cag-group-state-header">
              <span class="cag-title cag-state-title">{{ groupHeader.title }}</span>
              @if (groupHeader.detail) {
                <span class="cag-state-detail cag-subtitle" [class.cag-shimmer]="isGroupSpinning && !expanded">{{ groupHeader.detail }}</span>
              }
            </span>
          }
          @case ('collaboration') {
            <span class="cag-group-collaboration-header">
              <span class="cag-title cag-collaboration-title">{{ groupHeader.title }}</span>
              @if (groupHeader.detail) {
                <span class="cag-collaboration-detail cag-subtitle" [class.cag-shimmer]="isGroupSpinning && !expanded">{{ groupHeader.detail }}</span>
              }
            </span>
          }
          @default {
            <span class="cag-group-default-header">
              <span class="cag-title cag-default-title">{{ groupHeader.title }}</span>
              @if (groupHeader.detail) {
                <span class="cag-default-detail cag-subtitle" [class.cag-shimmer]="isGroupSpinning && !expanded">{{ groupHeader.detail }}</span>
              }
            </span>
          }
        }
        <span class="cag-chevron-wrap" aria-hidden="true">
          <i class="fa-light fa-chevron-down cag-chevron"></i>
        </span>
      </button>

      @if (expanded) {
        <div
          #detailViewport
          class="cag-detail-viewport"
          [class.cag-detail-viewport-fixed]="useFixedViewport"
          (scroll)="onDetailViewportScroll()">
          @if (displayItems.length) {
            <aily-chat-activity-list
              [items]="displayItems"
              [sessionId]="sessionId"
              [impliedWordLoadRate]="impliedWordLoadRate"
              [contentDeltaHandler]="contentDeltaHandler" />
          }
        </div>
      }
    </div>
  `,
  styles: [`
    :host {
      display: block;
      width: 100%;
      min-width: 0;
    }

    .cag {
      position: relative;
      margin: 2px 0;
      color: var(--chat-fg, #cccccc);
    }

    .cag.cag-expanded::after {
      content: '';
      position: absolute;
      left: 7px;
      top: 18px;
      height: 16px;
      width: 4px;
      border-left: 1px solid var(--chat-border, rgba(255,255,255,0.10));
      border-bottom: 1px solid var(--chat-border, rgba(255,255,255,0.10));
      border-bottom-left-radius: 5px;
      pointer-events: none;
    }

    .cag.cag-expanded.cag-first-item-not-tool::after {
      height: 16px;
    }

    .cag-header {
      display: flex;
      align-items: flex-start;
      gap: 4px;
      width: 100%;
      min-width: 0;
      padding: 2px 6px 2px 2px;
      margin-left: -2px;
      border: 0;
      background: transparent;
      color: inherit;
      text-align: initial;
      cursor: pointer;
      border-radius: 5px;
      transition: background 0.15s;
      min-height: 22px;
      line-height: unset;
    }

    .cag-header:hover {
      background: var(--chat-bg-hover, rgba(255,255,255,0.06));
    }

    .cag-icon-shell {
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      width: 16px;
      height: 16px;
      top: 1px;
      position: relative;
    }

    .cag-icon {
      font-size: 12px;
      color: var(--chat-fg-muted, #6a6a6a);
    }

    .cag[data-state='doing'] > .cag-header .cag-icon { color: var(--chat-info, #75beff); }
    .cag[data-state='done']  > .cag-header .cag-icon { color: var(--chat-success, #89d185); }
    .cag[data-state='error'] > .cag-header .cag-icon { color: var(--chat-error, #f14c4c); }

    .cag-title {
      min-width: 0;
      font-size: 13px;
      font-weight: 500;
      color: var(--chat-fg-dim, #8e8e8e);
      line-height: 1.35;
      white-space: normal;
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .cag-thinking-title {
      font-weight: 500;
    }

    .cag-group-thinking-header,
    .cag-group-tool-header,
    .cag-group-state-header,
    .cag-group-collaboration-header,
    .cag-group-default-header {
      flex: 1;
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      min-width: 0;
      gap: 1px 4px;
    }

    .cag-thinking-title-detail {
      min-width: 0;
      font-size: 13px;
      line-height: 1.4;
      color: var(--chat-fg-dim, #8e8e8e);
      white-space: normal;
      word-break: break-word;
      overflow-wrap: anywhere;
      opacity: 0.7;
    }

    .cag-tool-group-title {
      font-weight: 500;
    }

    .cag-tool-group-detail {
      opacity: 0.7;
    }

    .cag-subagent-detail {
      align-self: flex-end;
    }

    .cag-state-title,
    .cag-collaboration-title,
    .cag-default-title {
      font-weight: 500;
    }

    .cag-state-detail,
    .cag-collaboration-detail,
    .cag-default-detail {
      opacity: 0.7;
    }

    .cag-subtitle {
      flex: 1 1 auto;
      min-width: 0;
      font-size: 11px;
      line-height: 1.4;
      color: var(--chat-fg-dim, #8e8e8e);
      white-space: normal;
      word-break: break-word;
      overflow-wrap: anywhere;
      opacity: 0.7;
    }

    @keyframes cag-shimmer {
      0%   { background-position: 120% 0; }
      100% { background-position: -120% 0; }
    }

    .cag-shimmer {
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
      animation: cag-shimmer 2s linear infinite;
    }

    .cag-chevron {
      font-size: 9px;
      color: var(--chat-fg-muted, #6a6a6a);
      transition: transform 0.15s ease;
    }

    .cag-chevron-wrap {
      flex-shrink: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 12px;
      margin-left: auto;
      align-self: flex-start;
      padding-top: 2px;
      opacity: 0;
      transition: opacity 0.15s ease;
    }

    .cag-subtitle.cag-shimmer {
      opacity: 1;
    }

    .cag-header:hover .cag-chevron-wrap,
    .cag-header:focus-visible .cag-chevron-wrap,
    .cag-expanded .cag-chevron-wrap {
      opacity: 1;
    }

    .cag-expanded .cag-chevron {
      transform: rotate(180deg);
    }

    .cag-detail-viewport {
      position: relative;
      min-width: 0;
    }

    .cag-detail-viewport-fixed {
      max-height: 200px;
      overflow-y: auto;
      overflow-x: hidden;
      scrollbar-width: thin;
      scrollbar-color: var(--chat-border, rgba(255,255,255,0.10)) transparent;
      scrollbar-gutter: stable;
    }

    .cag.cag-fixed-streaming > .cag-detail-viewport-fixed {
      mask-image: none;
      -webkit-mask-image: none;
    }

    .cag.cag-fixed-streaming.cag-fade-top > .cag-detail-viewport-fixed {
      mask-image: linear-gradient(to bottom, transparent 0px, black 20px);
      -webkit-mask-image: linear-gradient(to bottom, transparent 0px, black 20px);
    }

    .cag.cag-fixed-streaming.cag-fade-bottom > .cag-detail-viewport-fixed {
      mask-image: linear-gradient(to top, transparent 0px, black 20px);
      -webkit-mask-image: linear-gradient(to top, transparent 0px, black 20px);
    }

    .cag.cag-fixed-streaming.cag-fade-top.cag-fade-bottom > .cag-detail-viewport-fixed {
      mask-image: linear-gradient(to bottom, transparent 0px, black 20px, black calc(100% - 20px), transparent 100%);
      -webkit-mask-image: linear-gradient(to bottom, transparent 0px, black 20px, black calc(100% - 20px), transparent 100%);
    }
  `],
})
export class ChatActivityGroupComponent implements OnChanges, AfterViewChecked, OnDestroy {
  @Input() renderItemId = '';
  @Input() parts: readonly ChatPart[] = [];
  @Input() doing = false;
  @Input() sessionId = '';
  @Input() turnResponse: TurnResponseTurn | null = null;
  @Input() impliedWordLoadRate: number | undefined;
  @Input() detailProjectionEnabled = true;
  @Input() contentDeltaHandler: (() => void) | undefined;
  @ViewChild('detailViewport') private detailViewportRef?: ElementRef<HTMLElement>;
  @ViewChild(ChatActivityListComponent) private activityListComponent?: ChatActivityListComponent;

  expanded = false;
  groupState: 'doing' | 'done' | 'error' = 'doing';
  groupHeader: ActivityGroupHeaderDisplayData = { kind: 'default', title: '' };
  displayItems: ActivityGroupDisplayItem[] = [];

  private lastAutoExpanded = false;
  private detailViewportAutoScrollEnabled = true;
  private lastViewportScrollHeight = 0;
  private ignoreNextViewportScroll = false;
  private readonly runtimeInteractionHost = inject(ChatRuntimeInteractionHostService, { optional: true });
  private readonly cdr = inject(ChangeDetectorRef, { optional: true });
  private detailViewportSyncScheduled = false;
  private detailViewportFrameId: number | null = null;
  private detailViewportTimerId: ReturnType<typeof setTimeout> | null = null;
  private lastProjectionKey = '';
  private lastDetailProjectionKey = '';
  private readonly projectedPartItems = new Map<string, {
    readonly revision: string;
    readonly items: ActivityGroupDisplayItem[];
  }>();
  private userRequestedDetailProjection = false;
  showDetailViewportTopFade = false;
  showDetailViewportBottomFade = false;

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['parts'] || changes['doing'] || changes['turnResponse'] || changes['detailProjectionEnabled']) {
      this._refresh({
        forceDetailProjection: !!changes['detailProjectionEnabled'] && this.detailProjectionEnabled,
      });
    }
  }

  ngAfterViewChecked(): void {
    if (!this.shouldProjectDetails() || !this.useFixedViewport) {
      if (this.showDetailViewportTopFade || this.showDetailViewportBottomFade) {
        this.showDetailViewportTopFade = false;
        this.showDetailViewportBottomFade = false;
      }
      return;
    }

    this.scheduleDetailViewportSync();
  }

  ngOnDestroy(): void {
    if (this.detailViewportFrameId !== null && typeof globalThis.cancelAnimationFrame === 'function') {
      globalThis.cancelAnimationFrame(this.detailViewportFrameId);
    }
    if (this.detailViewportTimerId !== null) {
      clearTimeout(this.detailViewportTimerId);
    }
    this.detailViewportFrameId = null;
    this.detailViewportTimerId = null;
    this.detailViewportSyncScheduled = false;
  }

  /** Keep the mounted group and spinner DOM while applying a new part revision. */
  applyVisibleGroupPatch(input: {
    readonly parts: readonly ChatPart[];
    readonly changedParts?: readonly ChatPart[];
    readonly doing: boolean;
    readonly sessionId: string;
    readonly turnResponse: TurnResponseTurn | null;
    readonly impliedWordLoadRate?: number;
    readonly detailProjectionEnabled: boolean;
  }): boolean {
    return ChatPerformanceTracer.runWithSurface(
      'chat_projection',
      () => this.applyVisibleGroupPatchInternal(input),
      'activity_group_incremental_patch',
    );
  }

  private applyVisibleGroupPatchInternal(input: {
    readonly parts: readonly ChatPart[];
    readonly changedParts?: readonly ChatPart[];
    readonly doing: boolean;
    readonly sessionId: string;
    readonly turnResponse: TurnResponseTurn | null;
    readonly impliedWordLoadRate?: number;
    readonly detailProjectionEnabled: boolean;
  }): boolean {
    const wasDoing = this.doing;
    const incompleteThinkingBefore = this.parts.filter(
      part => part.type === 'thinking' && part.isComplete === false,
    ).length;
    if (this.tryApplyStreamingThinkingRevision(input)) {
      return true;
    }
    const previousShellSignature = this.readShellSignature();
    this.parts = input.parts;
    this.doing = input.doing;
    this.sessionId = input.sessionId;
    this.turnResponse = input.turnResponse;
    this.impliedWordLoadRate = input.impliedWordLoadRate;
    this.detailProjectionEnabled = input.detailProjectionEnabled;
    this._refresh();
    const shellChanged = previousShellSignature !== this.readShellSignature();
    if (!shellChanged) {
      if (!this.expanded || this.displayItems.length === 0) {
        this.reportFinalGroupRevision(wasDoing, input, incompleteThinkingBefore);
        return true;
      }
      if (this.activityListComponent?.applyItemsPatch(
        this.displayItems,
        this.sessionId,
        this.impliedWordLoadRate,
      )) {
        this.reportFinalGroupRevision(wasDoing, input, incompleteThinkingBefore);
        return true;
      }
    }
    this.cdr?.detectChanges();
    this.reportFinalGroupRevision(wasDoing, input, incompleteThinkingBefore);
    return true;
  }

  private reportFinalGroupRevision(
    wasDoing: boolean,
    input: {
      readonly parts: readonly ChatPart[];
      readonly doing: boolean;
      readonly sessionId: string;
      readonly turnResponse: TurnResponseTurn | null;
    },
    incompleteThinkingBefore: number,
  ): void {
    if (!wasDoing || input.doing) {
      return;
    }
    const incompleteThinkingAfter = input.parts.filter(
      part => part.type === 'thinking' && part.isComplete === false,
    ).length;
    console.info(
      '[AilyChat][ActivityGroupFinalRenderScalar]',
      [
        `session=${input.sessionId || 'unknown'}`,
        `turn=${input.turnResponse?.turnId || input.turnResponse?.response?.id || 'unknown'}`,
        `parts=${input.parts.length}`,
        `incompleteThinkingBefore=${incompleteThinkingBefore}`,
        `incompleteThinkingAfter=${incompleteThinkingAfter}`,
        `state=${this.groupState}`,
        `wallAt=${Date.now()}`,
      ].join(' '),
    );
  }

  private tryApplyStreamingThinkingRevision(input: {
    readonly parts: readonly ChatPart[];
    readonly changedParts?: readonly ChatPart[];
    readonly doing: boolean;
    readonly sessionId: string;
    readonly turnResponse: TurnResponseTurn | null;
    readonly impliedWordLoadRate?: number;
    readonly detailProjectionEnabled: boolean;
  }): boolean {
    if (!this.doing || !input.doing
      || !this.expanded
      || !this.activityListComponent
      || this.parts.length !== input.parts.length
      || input.changedParts?.length !== 1
      || buildContinuationProjectionKey(this.turnResponse) !== buildContinuationProjectionKey(input.turnResponse)) {
      return false;
    }

    const changedThinking = input.changedParts[0];
    if (changedThinking.type !== 'thinking') {
      return false;
    }
    const thinkingIndex = input.parts.indexOf(changedThinking);
    if (thinkingIndex < 0) {
      return false;
    }
    const previousThinking = this.parts[thinkingIndex];
    const nextThinking = input.parts[thinkingIndex];
    if (previousThinking?.type !== 'thinking'
      || nextThinking?.type !== 'thinking'
      || previousThinking.isComplete !== false
      || nextThinking.isComplete !== false
      || buildChatPartIdentity(previousThinking, thinkingIndex)
        !== buildChatPartIdentity(nextThinking, thinkingIndex)) {
      return false;
    }
    const previousLength = previousThinking.contentLength ?? previousThinking.content.length;
    const nextLength = nextThinking.contentLength ?? nextThinking.content.length;
    if (nextLength < previousLength) {
      return false;
    }
    const displayItemId = buildChatPartIdentity(nextThinking, thinkingIndex);
    const displayItemIndex = this.displayItems.findIndex(item => item.id === displayItemId && item.kind === 'thinking');
    if (displayItemIndex < 0) {
      return false;
    }

    const presentation = buildThinkingActivityPresentation(nextThinking);
    const nextDisplayItems = [...this.displayItems];
    nextDisplayItems[displayItemIndex] = {
      ...nextDisplayItems[displayItemIndex],
      thinking: presentation.thinking,
    };
    this.parts = input.parts;
    this.sessionId = input.sessionId;
    this.turnResponse = input.turnResponse;
    this.impliedWordLoadRate = input.impliedWordLoadRate;
    this.detailProjectionEnabled = input.detailProjectionEnabled;
    this.displayItems = nextDisplayItems;
    return this.activityListComponent.applyItemPatch(
      nextDisplayItems[displayItemIndex],
      input.sessionId,
      input.impliedWordLoadRate,
    );
  }

  private readShellSignature(): string {
    const header = this.groupHeader;
    return [
      this.expanded ? '1' : '0',
      this.groupState,
      header.kind,
      header.title,
      header.detail ?? '',
      header.titleDetail ?? '',
      this.useFixedViewport ? '1' : '0',
      this.showDetailViewportTopFade ? '1' : '0',
      this.showDetailViewportBottomFade ? '1' : '0',
    ].join('\u0000');
  }

  toggle(): void {
    this.expanded = !this.expanded;
    this.userRequestedDetailProjection = this.expanded;
    if (this.expanded && this.groupState === 'doing') {
      this.detailViewportAutoScrollEnabled = true;
      this.lastViewportScrollHeight = 0;
    }
    this.lastDetailProjectionKey = '';
    if (!this.expanded) {
      this.displayItems = [];
      return;
    }

    this._refresh({ forceDetailProjection: this.shouldProjectDetails() });
  }

  get isGroupSpinning(): boolean {
    return this.groupState === 'doing';
  }

  get isFirstItemNotTool(): boolean {
    const firstItem = this.displayItems[0];
    return !!firstItem && !firstItem.toolHeader && firstItem.headerKind !== 'tool';
  }

  get useFixedViewport(): boolean {
    return this.groupState === 'doing';
  }

  get groupIconClass(): string {
    switch (this.groupState) {
      case 'done':  return 'fa-light fa-circle-check';
      case 'error': return 'fa-light fa-circle-exclamation';
      default:      return 'fa-light fa-spinner-third';
    }
  }

  onDetailViewportScroll(): void {
    const viewport = this.detailViewportRef?.nativeElement;
    if (!viewport) {
      return;
    }

    if (this.ignoreNextViewportScroll) {
      this.ignoreNextViewportScroll = false;
      this.updateDetailViewportFades(viewport);
      return;
    }

    const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    this.detailViewportAutoScrollEnabled = maxScrollTop <= 0 || viewport.scrollTop >= maxScrollTop - 10;
    this.updateDetailViewportFades(viewport);
  }

  emitContentDelta(): void {
    this.contentDeltaHandler?.();
  }

  private _refresh(options?: { forceDetailProjection?: boolean }): void {
    ChatPerformanceTracer.runWithSurface('chat_projection', () => {
      this._refreshProjected(options);
    }, 'activity_group_refresh');
  }

  private _refreshProjected(options?: { forceDetailProjection?: boolean }): void {
    if (!this.parts.length) {
      this.displayItems = [];
      this.lastProjectionKey = '';
      this.lastDetailProjectionKey = '';
      this.projectedPartItems.clear();
      return;
    }
    const refreshStartedAt = performance.now();
    const projectionKey = buildActivityGroupProjectionKey(this.parts, this.doing, this.turnResponse);
    const detailProjectionKey = buildActivityGroupDetailProjectionKey(this.parts, this.doing, this.turnResponse);
    const headerCacheHit = projectionKey === this.lastProjectionKey;
    if (headerCacheHit && !options?.forceDetailProjection) {
      this._syncExpandedState();
      if (!this.shouldProjectDetails()) {
        if (this.displayItems.length) {
          this.displayItems = [];
          this.lastDetailProjectionKey = '';
        }
        ChatPerformanceTracer.increment(`activity_group_refresh.${this.detailProjectionSkipMetric()}`);
        ChatPerformanceTracer.recordDuration(
          'activity_group_refresh',
          performance.now() - refreshStartedAt,
          `cache-hit,detail-skipped=${this.detailProjectionSkipReason()},parts=${this.parts.length},doing=${this.doing},state=${this.groupState}`,
          { slowThresholdMs: 8 },
        );
        return;
      }
      if (detailProjectionKey === this.lastDetailProjectionKey) {
        ChatPerformanceTracer.increment('activity_group_refresh.cache_hit');
        ChatPerformanceTracer.recordDuration(
          'activity_group_refresh',
          performance.now() - refreshStartedAt,
          `cache-hit,parts=${this.parts.length},items=${this.displayItems.length},doing=${this.doing},state=${this.groupState}`,
          { slowThresholdMs: 8 },
        );
        return;
      }
    }

    if (!headerCacheHit) {
      this.lastProjectionKey = projectionKey;
      const pres = buildActivityGroupPresentation(this.parts);
      this.groupState = pres.state;
      this.groupHeader = mergeStableGroupHeader(this.groupHeader, pres.header);
    }

    this._syncExpandedState();
    if (!this.shouldProjectDetails()) {
      if (this.displayItems.length) {
        this.displayItems = [];
      }
      this.lastDetailProjectionKey = '';
      ChatPerformanceTracer.increment(`activity_group_refresh.${this.detailProjectionSkipMetric()}`);
      ChatPerformanceTracer.increment('activity_group_refresh.cache_hit');
      ChatPerformanceTracer.recordDuration(
        'activity_group_refresh',
        performance.now() - refreshStartedAt,
        `detail-skipped=${this.detailProjectionSkipReason()},parts=${this.parts.length},doing=${this.doing},state=${this.groupState},headerCache=${headerCacheHit}`,
        { slowThresholdMs: 8 },
      );
      return;
    }

    if (!options?.forceDetailProjection && detailProjectionKey === this.lastDetailProjectionKey) {
      ChatPerformanceTracer.increment('activity_group_refresh.cache_hit');
      ChatPerformanceTracer.recordDuration(
        'activity_group_refresh',
        performance.now() - refreshStartedAt,
        `detail-cache-hit,parts=${this.parts.length},items=${this.displayItems.length},doing=${this.doing},state=${this.groupState}`,
        { slowThresholdMs: 8 },
      );
      return;
    }

    this.lastDetailProjectionKey = detailProjectionKey;
    const projectedItems = this._attachTurnResponseContinuation(
      this._projectRevisionedItems(),
    );
    this.displayItems = reuseStableDisplayItems(this.displayItems, projectedItems);
    this._syncExpandedState();
    this.emitContentDelta();
    ChatPerformanceTracer.recordDuration(
      'activity_group_refresh',
      performance.now() - refreshStartedAt,
      `parts=${this.parts.length},items=${this.displayItems.length},doing=${this.doing},state=${this.groupState}`,
      { slowThresholdMs: 8 },
    );
    ChatPerformanceTracer.recordJankSnapshot('activity_group_refresh', {
      parts: this.parts.length,
      items: this.displayItems.length,
      doing: this.doing,
      state: this.groupState,
      headerKind: this.groupHeader.kind,
      scopedSubagentChildren: this.parts.filter((part) => isSubagentChildPart(part)).length,
      legacySubagentChildren: countLegacySubagentChildren(this.parts),
    });
  }

  private _attachTurnResponseContinuation(items: ActivityGroupDisplayItem[]): ActivityGroupDisplayItem[] {
    const continuationSections = buildTurnResponseContinuationDetailSections({
      id: this.turnResponse?.turnId,
      continuation: this.turnResponse?.response?.continuation,
    });
    if (continuationSections.length === 0) {
      return items;
    }

    let targetIndex = -1;
    for (let index = items.length - 1; index >= 0; index--) {
      const item = items[index];
      if (item.kind === 'activity' && item.detailKind !== 'subagent') {
        targetIndex = index;
        break;
      }
    }

    if (targetIndex < 0) {
      return items;
    }

    const target = items[targetIndex];
    const detailSections = [...(target.detailSections ?? []), ...continuationSections];
    const detailKind = target.detailKind
      ?? (target.headerKind === 'tool' || target.invocationDetail || target.approval ? 'invocation' : 'state');

    return items.map((item, index) => {
      if (index !== targetIndex) {
        return item;
      }

      return {
        ...target,
        revision: `${target.revision ?? target.id}:continuation:${buildContinuationProjectionKey(this.turnResponse)}`,
        detailSections,
        detailKind,
        invocationDetail: detailKind === 'invocation'
          ? buildInvocationDetailDisplay({
              detailSections,
              postConfirmation: !!target.approvalSummary,
            })
          : target.invocationDetail,
      };
    });
  }

  private _buildRevisionedItems(
    part: ChatPart,
    index: number,
    groupParts: readonly ChatPart[],
  ): ActivityGroupDisplayItem[] {
    const sourceRevision = buildActivityPartDetailProjectionKey(part, index, this.doing);
    return this._buildItems(part, index, groupParts).map((item, itemIndex) => ({
      ...item,
      revision: `${sourceRevision}:display:${itemIndex}`,
    }));
  }

  private _projectRevisionedItems(): ActivityGroupDisplayItem[] {
    const groupStructureRevision = buildActivityGroupStructureProjectionKey(this.parts);
    const liveCacheKeys = new Set<string>();
    const projectedItems: ActivityGroupDisplayItem[] = [];

    for (let index = 0; index < this.parts.length; index += 1) {
      const part = this.parts[index];
      const cacheKey = `${buildChatPartIdentity(part, index)}:${index}`;
      liveCacheKeys.add(cacheKey);
      const revision = [
        groupStructureRevision,
        buildActivityPartDetailProjectionKey(part, index, this.doing),
        buildActivityPartDependencyProjectionKey(part, this.parts, this.doing),
      ].join('|');
      const cached = this.projectedPartItems.get(cacheKey);
      if (cached?.revision === revision) {
        projectedItems.push(...cached.items);
        continue;
      }

      const items = this._buildRevisionedItems(part, index, this.parts);
      this.projectedPartItems.set(cacheKey, { revision, items });
      projectedItems.push(...items);
    }

    for (const cacheKey of this.projectedPartItems.keys()) {
      if (!liveCacheKeys.has(cacheKey)) {
        this.projectedPartItems.delete(cacheKey);
      }
    }
    return projectedItems;
  }

  private _syncExpandedState(): void {
    const shouldAutoExpand = this.groupState === 'doing' || this.hasActivePendingInlineApproval();
    if (shouldAutoExpand === this.lastAutoExpanded) {
      return;
    }

    this.expanded = shouldAutoExpand;
    if (!shouldAutoExpand) {
      this.userRequestedDetailProjection = false;
    }
    this.lastAutoExpanded = shouldAutoExpand;
    this.detailViewportAutoScrollEnabled = shouldAutoExpand;
    this.lastViewportScrollHeight = 0;
    this.showDetailViewportTopFade = false;
    this.showDetailViewportBottomFade = false;
  }

  private hasActivePendingInlineApproval(): boolean {
    if (!this.sessionId || !this.parts.length) {
      return false;
    }

    const activeConfirmation = this.runtimeInteractionHost?.getActiveConfirmation(this.sessionId);
    if (!activeConfirmation) {
      return false;
    }

    return this.parts.some((part) => this.partMatchesActivePendingApproval(part, activeConfirmation));
  }

  private shouldProjectDetails(): boolean {
    return this.expanded && (
      this.userRequestedDetailProjection
      || this.detailProjectionEnabled
      || this.hasActivePendingInlineApproval()
    );
  }

  private detailProjectionSkipReason(): 'collapsed' | 'offscreen' {
    return this.expanded && !this.detailProjectionEnabled ? 'offscreen' : 'collapsed';
  }

  private detailProjectionSkipMetric(): 'detail_skipped_collapsed' | 'detail_skipped_offscreen' {
    return this.detailProjectionSkipReason() === 'offscreen'
      ? 'detail_skipped_offscreen'
      : 'detail_skipped_collapsed';
  }

  private partMatchesActivePendingApproval(
    part: ChatPart,
    activeConfirmation: ReturnType<ChatRuntimeInteractionHostService['getActiveConfirmation']>,
  ): boolean {
    if (!activeConfirmation) {
      return false;
    }

    if (part.type === 'confirmation') {
      if (part.resolved === true) {
        return false;
      }

      if (activeConfirmation.partId && part.partId) {
        return activeConfirmation.partId === part.partId;
      }

      if (activeConfirmation.askId && part.askId) {
        return activeConfirmation.askId === part.askId;
      }

      if (activeConfirmation.toolCallId && part.toolName) {
        return activeConfirmation.toolCallId === part.askId || activeConfirmation.toolCallId === part.partId;
      }

      return false;
    }

    if (part.type !== 'tool_call') {
      return false;
    }

    const metadataApproval = asRecord(part.metadata?.['approval']);
    const metadataResolved = metadataApproval?.['resolved'] === true;
    if (part.state !== 'pending_approval' && metadataResolved) {
      return false;
    }

    if (activeConfirmation.toolCallId && part.toolCallId) {
      return activeConfirmation.toolCallId === part.toolCallId;
    }

    if (activeConfirmation.partId && part.partId) {
      return activeConfirmation.partId === part.partId;
    }

    return false;
  }

  private _syncDetailViewportScroll(): void {
    const surface = ChatPerformanceTracer.enterSurface('renderer_scroll', 'activity_group_detail');
    const syncStartedAt = performance.now();
    const recordSync = (detail: string): void => {
      ChatPerformanceTracer.recordDuration(
        'activity_group_scroll_sync',
        performance.now() - syncStartedAt,
        detail,
        { slowThresholdMs: 8 },
      );
      surface.dispose();
    };

    if (!this.expanded || !this.useFixedViewport) {
      this.showDetailViewportTopFade = false;
      this.showDetailViewportBottomFade = false;
      recordSync('not-fixed');
      return;
    }

    const viewport = this.detailViewportRef?.nativeElement;
    if (!viewport) {
      recordSync('missing-viewport');
      return;
    }

    const scrollHeight = viewport.scrollHeight;
    if (!scrollHeight) {
      recordSync('empty-scroll-height');
      return;
    }

    if (scrollHeight === this.lastViewportScrollHeight && !this.detailViewportAutoScrollEnabled) {
      recordSync('unchanged-disabled');
      return;
    }

    this.lastViewportScrollHeight = scrollHeight;
    if (!this.detailViewportAutoScrollEnabled) {
      this.updateDetailViewportFades(viewport);
      recordSync('manual-scroll');
      return;
    }

    const maxScrollTop = Math.max(0, scrollHeight - viewport.clientHeight);
    if (maxScrollTop <= 0 || viewport.scrollTop >= maxScrollTop - 1) {
      this.updateDetailViewportFades(viewport);
      recordSync('already-bottom');
      return;
    }

    this.ignoreNextViewportScroll = true;
    viewport.scrollTop = maxScrollTop;
    this.updateDetailViewportFades(viewport);
    recordSync('auto-scroll');
  }

  private scheduleDetailViewportSync(): void {
    if (this.detailViewportSyncScheduled) {
      return;
    }

    this.detailViewportSyncScheduled = true;
    const callback = (): void => {
      this.detailViewportSyncScheduled = false;
      this.detailViewportFrameId = null;
      this.detailViewportTimerId = null;
      this._syncDetailViewportScroll();
    };

    if (typeof globalThis.requestAnimationFrame === 'function') {
      this.detailViewportFrameId = globalThis.requestAnimationFrame(callback);
      return;
    }

    this.detailViewportTimerId = setTimeout(callback, 16);
  }

  private updateDetailViewportFades(viewport: HTMLElement): void {
    if (!this.useFixedViewport) {
      this.showDetailViewportTopFade = false;
      this.showDetailViewportBottomFade = false;
      return;
    }

    const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    this.showDetailViewportTopFade = maxScrollTop > 0 && viewport.scrollTop > 5;
    this.showDetailViewportBottomFade = maxScrollTop > 0 && viewport.scrollTop < maxScrollTop - 5;
  }

  private _buildItems(part: ChatPart, index: number, groupParts: readonly ChatPart[]): ActivityGroupDisplayItem[] {
    const id = buildChatPartIdentity(part, index);

    if (isSubagentChildPart(part) && hasScopedSubagentParent(groupParts, part)) {
      return [];
    }

    if (part.type === 'markdown' && isSubagentChildPart(part)) {
      return [buildScopedMarkdownActivityDisplayItem(part as MarkdownPart, { id })];
    }

    if (part.type === 'thinking') {
      const tp = this._normalizeThinkingPartForStableRendering(part as ThinkingPart, id);
      const isSpinning = !tp.isComplete;
      const thinking = buildThinkingActivityPresentation(tp);
      return [{
        id,
        kind: 'thinking',
        iconClass: thinking.iconClass,
        isSpinning,
        iconColor: thinking.iconColor,
        kicker: thinking.kicker,
        label: thinking.label,
        note: thinking.note,
        thinking: thinking.thinking,
        pill: '',
        pillTone: 'neutral',
      }];
    }

    if (part.type === 'tool_call') {
      if (isTerminalOwnedToolCallActivity(part as ToolCallPart, groupParts)) {
        return [];
      }
      if (isSubagentToolCall(part)) {
        const scopedChildren = collectScopedSubagentChildren(groupParts, part);
        if (scopedChildren.length > 0) {
          const nestedItems = scopedChildren.flatMap((child, childIndex) => this._buildScopedSubagentChildItems(child, childIndex));
          const parentPart = stripLegacySubagentChildItems(part);
          return buildSubagentActivityItems(parentPart).map((item, itemIndex) => ({
            ...item,
            id: itemIndex === 0 ? id : item.id,
            subagentItems: nestedItems.length > 0 ? [
              ...(item.subagentItems ?? []),
              ...nestedItems,
            ] : item.subagentItems,
            detailKind: item.detailKind ?? 'subagent',
          }));
        }
        return [...buildSubagentActivityItems(part)];
      }

      return [buildToolActivityDisplayItem(part as ToolCallPart, { id })];
    }

    if (part.type === 'confirmation') {
      if (isTerminalOwnedConfirmationActivity(part as ConfirmationPart, groupParts)) {
        return [];
      }
      return [buildConfirmationActivityDisplayItem(part as ConfirmationPart, { id })];
    }

    if (part.type === 'terminal') {
      return [buildTerminalActivityDisplayItem(part as TerminalPart, { id })];
    }

    if (part.type === 'state') {
      const sp = part as StatePart;
      const isSpinning = sp.state === 'doing';
      const activitySummary = sp.kind === 'todo'
        ? buildTodoPrimaryActivitySummary(sp)
        : buildPrimaryActivitySummary(part);
      const useEmbeddedStateBody = sp.kind === 'instructions';
      const lazyTodoDetail = !useEmbeddedStateBody && sp.kind === 'todo'
        ? () => {
            const sections = getPreparedDetailSections(part);
            return {
              detailSections: sections,
              detailKind: sections?.length ? 'state' as const : undefined,
            };
          }
        : undefined;
      const detailSections = useEmbeddedStateBody || lazyTodoDetail ? undefined : getPreparedDetailSections(part);
      const shell = buildStateActivityShellPresentation({
        state: sp.state,
        defaultKicker: activitySummary?.kicker,
      });
      return [{
        id,
        kind: 'activity',
        iconClass: shell.iconClass,
        isSpinning,
        iconColor: shell.iconColor,
        kicker: shell.kicker,
        label: sp.text || '任务',
        subtitle: activitySummary?.subtitle,
        note: undefined,
        pill: shell.pill,
        pillTone: shell.pillTone,
        children: undefined,
        loadDetail: lazyTodoDetail,
        detailSections,
        detailExpanded: useEmbeddedStateBody,
        detailKind: detailSections?.length || useEmbeddedStateBody || lazyTodoDetail ? 'state' : undefined,
        instructionMetadata: useEmbeddedStateBody ? (sp.metadata || null) : undefined,
      }];
    }

    return [{
      id,
      kind: 'activity',
      iconClass: 'fa-light fa-circle',
      isSpinning: false,
      iconColor: 'var(--chat-fg-muted)',
      label: '项目',
      subtitle: '',
      note: '',
      pill: '',
      pillTone: 'neutral',
    }];
  }

  private _buildScopedSubagentChildItems(part: ChatPart, index: number): ActivityGroupDisplayItem[] {
    const id = buildChatPartIdentity(part, index);
    if (part.type === 'markdown') {
      return [buildScopedMarkdownActivityDisplayItem(part as MarkdownPart, { id })];
    }
    if (part.type === 'thinking') {
      const tp = this._normalizeThinkingPartForStableRendering(part as ThinkingPart, id);
      const isSpinning = !tp.isComplete;
      const thinking = buildThinkingActivityPresentation(tp);
      return [{
        id,
        kind: 'thinking',
        iconClass: thinking.iconClass,
        isSpinning,
        iconColor: thinking.iconColor,
        kicker: thinking.kicker,
        label: thinking.label,
        note: thinking.note,
        thinking: thinking.thinking,
        pill: '',
        pillTone: 'neutral',
      }];
    }
    if (part.type === 'tool_call') {
      return [buildToolActivityDisplayItem(part as ToolCallPart, { id })];
    }
    if (part.type === 'confirmation') {
      return [buildConfirmationActivityDisplayItem(part as ConfirmationPart, { id })];
    }
    if (part.type === 'terminal') {
      return [buildTerminalActivityDisplayItem(part as TerminalPart, { id })];
    }
    if (part.type === 'state') {
      const sp = part as StatePart;
      const isSpinning = sp.state === 'doing';
      const activitySummary = sp.kind === 'todo'
        ? buildTodoPrimaryActivitySummary(sp)
        : buildPrimaryActivitySummary(part);
      const shell = buildStateActivityShellPresentation({
        state: sp.state,
        defaultKicker: activitySummary?.kicker,
      });
      const detailSections = getPreparedDetailSections(part);
      return [{
        id,
        kind: 'activity',
        iconClass: shell.iconClass,
        isSpinning,
        iconColor: shell.iconColor,
        kicker: shell.kicker,
        label: sp.text || '任务',
        subtitle: activitySummary?.subtitle,
        pill: shell.pill,
        pillTone: shell.pillTone,
        detailSections,
        detailKind: detailSections?.length ? 'state' : undefined,
      }];
    }
    return [];
  }

  private _normalizeThinkingPartForStableRendering(part: ThinkingPart, itemId: string): ThinkingPart {
    if (part.contentRef || part.isComplete || !part.content) {
      return part;
    }

    const contentRef = [
      'activity-thinking',
      this.sessionId || 'session',
      this.turnResponse?.turnId || 'turn',
      itemId,
    ].join(':');
    storeThinkContent(contentRef, part.content);
    return {
      ...part,
      content: '',
      contentRef,
      contentLength: part.contentLength ?? part.content.length,
    };
  }
}

function isTerminalOwnedConfirmationActivity(part: ConfirmationPart, groupParts: readonly ChatPart[]): boolean {
  if (!isTerminalSessionToolName(part.toolName)) {
    return false;
  }

  const command = readTerminalCommandFromRecord(readRecord(part.args), readRecord(part.metadata));
  const askId = part.askId || part.partId?.replace(/^confirmation:/, '') || '';
  return groupParts.some(candidate => {
    if (candidate.type !== 'terminal') {
      return false;
    }
    if (askId && (candidate.toolCallId === askId || candidate.sourceToolCallIds?.includes(askId))) {
      return true;
    }
    return !!command && candidate.command === command;
  });
}

function isTerminalOwnedToolCallActivity(part: ToolCallPart, groupParts: readonly ChatPart[]): boolean {
  if (!isTerminalSessionToolName(part.toolName)) {
    return false;
  }

  const args = readRecord(part.args);
  const metadata = readRecord(part.metadata);
  const command = readTerminalCommandFromRecord(args, metadata);
  const sessionIds = readTerminalSessionIdsFromRecord(args, metadata);

  return groupParts.some(candidate => {
    if (candidate.type !== 'terminal') {
      return false;
    }
    if (candidate.toolCallId === part.toolCallId || candidate.sourceToolCallIds?.includes(part.toolCallId)) {
      return true;
    }
    if (sessionIds.some(sessionId => terminalHasSessionId(candidate, sessionId))) {
      return true;
    }
    return !!command && candidate.command === command;
  });
}

function terminalHasSessionId(terminal: TerminalPart, sessionId: string): boolean {
  return [terminal.processId, terminal.outputSessionId, terminal.terminalId]
    .some(value => readString(value) === sessionId);
}

function readTerminalCommandFromRecord(
  args: Record<string, unknown> | undefined,
  metadata?: Record<string, unknown> | undefined,
): string {
  const approval = readRecord(metadata?.['approval']);
  const approvalArgs = readRecord(approval?.['args']);
  return readString(args?.['command'])
    || readString(args?.['cmd'])
    || readString(approvalArgs?.['command'])
    || readString(approvalArgs?.['cmd'])
    || '';
}

function readTerminalSessionIdsFromRecord(
  args: Record<string, unknown> | undefined,
  metadata?: Record<string, unknown> | undefined,
): string[] {
  const approval = readRecord(metadata?.['approval']);
  const approvalArgs = readRecord(approval?.['args']);
  return [
    args?.['processId'],
    args?.['outputSessionId'],
    args?.['terminalId'],
    args?.['id'],
    metadata?.['processId'],
    metadata?.['outputSessionId'],
    metadata?.['terminalId'],
    metadata?.['id'],
    approvalArgs?.['processId'],
    approvalArgs?.['outputSessionId'],
    approvalArgs?.['terminalId'],
    approvalArgs?.['id'],
  ].map(value => readString(value)).filter((value): value is string => !!value);
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function collectScopedSubagentChildren(parts: readonly ChatPart[], parent: ToolCallPart): ChatPart[] {
  const subAgentInvocationId = parent.toolCallId;
  return parts.filter((part) => part !== parent
    && isSubagentChildPart(part)
    && getScopedSubagentChildId(part) === subAgentInvocationId);
}

function stripLegacySubagentChildItems(parent: ToolCallPart): ToolCallPart {
  const toolSpecificData = parent.metadata?.['toolSpecificData'];
  if (!toolSpecificData || typeof toolSpecificData !== 'object' || !Array.isArray((toolSpecificData as Record<string, unknown>)['childItems'])) {
    return parent;
  }

  const { childItems: _childItems, ...nextToolSpecificData } = toolSpecificData as Record<string, unknown>;
  return {
    ...parent,
    metadata: {
      ...(parent.metadata || {}),
      toolSpecificData: nextToolSpecificData,
    },
  };
}

function hasScopedSubagentParent(parts: readonly ChatPart[], child: ChatPart): boolean {
  const childSubAgentInvocationId = getScopedSubagentChildId(child);
  return !!childSubAgentInvocationId
    && parts.some((part): part is ToolCallPart => part.type === 'tool_call'
      && isSubagentToolCall(part)
      && part.toolCallId === childSubAgentInvocationId);
}

function getScopedSubagentChildId(part: ChatPart): string | undefined {
  return getSubAgentInvocationId(part) || getParentToolCallId(part);
}

function countLegacySubagentChildren(parts: readonly ChatPart[]): number {
  let count = 0;
  for (const part of parts) {
    if (part.type !== 'tool_call') {
      continue;
    }
    const toolSpecificData = part.metadata?.['toolSpecificData'];
    if (!toolSpecificData || typeof toolSpecificData !== 'object') {
      continue;
    }
    const childItems = (toolSpecificData as Record<string, unknown>)['childItems'];
    if (Array.isArray(childItems)) {
      count += childItems.length;
    }
  }
  return count;
}

function buildActivityGroupProjectionKey(
  parts: readonly ChatPart[],
  doing: boolean,
  turnResponse: TurnResponseTurn | null,
): string {
  return [
    doing ? 'doing' : 'idle',
    buildContinuationProjectionKey(turnResponse),
    ...parts.map((part, index) => buildActivityPartProjectionKey(part, index)),
  ].join('|');
}

function mergeStableGroupHeader(
  previous: ActivityGroupHeaderDisplayData,
  next: ActivityGroupHeaderDisplayData,
): ActivityGroupHeaderDisplayData {
  if (!previous.title || previous.kind !== next.kind) {
    return next;
  }

  return {
    ...next,
    title: next.title || previous.title,
    titleDetail: next.titleDetail || previous.titleDetail,
    detail: next.detail || previous.detail,
  };
}

function reuseStableDisplayItems(
  previousItems: readonly ActivityGroupDisplayItem[],
  nextItems: readonly ActivityGroupDisplayItem[],
): ActivityGroupDisplayItem[] {
  if (previousItems.length === 0 || nextItems.length === 0) {
    return [...nextItems];
  }

  const previousById = new Map(previousItems.map(item => [item.id, item]));
  return nextItems.map((item) => {
    const previous = previousById.get(item.id);
    return previous?.revision === item.revision ? previous : item;
  });
}

function buildActivityGroupDetailProjectionKey(
  parts: readonly ChatPart[],
  doing: boolean,
  turnResponse: TurnResponseTurn | null,
): string {
  return [
    buildActivityGroupProjectionKey(parts, doing, turnResponse),
    ...parts.map((part, index) => buildActivityPartDetailProjectionKey(part, index, doing)),
  ].join('|');
}

function buildActivityGroupStructureProjectionKey(parts: readonly ChatPart[]): string {
  return parts.map((part, index) => {
    const base = `${buildChatPartIdentity(part, index)}:${part.type}`;
    if (part.type === 'tool_call') {
      const args = readRecord(part.args);
      const metadata = readRecord(part.metadata);
      return [
        base,
        part.toolCallId,
        part.toolName,
        part.subAgentInvocationId ?? '',
        part.parentToolCallId ?? '',
        readTerminalCommandFromRecord(args, metadata) ?? '',
        ...readTerminalSessionIdsFromRecord(args, metadata),
      ].join(':');
    }
    if (part.type === 'confirmation') {
      return [
        base,
        part.askId,
        part.toolName,
        readTerminalCommandFromRecord(readRecord(part.args), readRecord(part.metadata)) ?? '',
      ].join(':');
    }
    if (part.type === 'terminal') {
      return [
        base,
        part.toolCallId ?? '',
        ...(part.sourceToolCallIds ?? []),
        part.processId ?? '',
        part.outputSessionId ?? '',
        part.terminalId ?? '',
        part.command,
      ].join(':');
    }
    if (isSubagentChildPart(part)) {
      return [base, getScopedSubagentChildId(part) ?? ''].join(':');
    }
    return base;
  }).join('|');
}

function buildActivityPartDependencyProjectionKey(
  part: ChatPart,
  groupParts: readonly ChatPart[],
  doing: boolean,
): string {
  if (part.type !== 'tool_call' || !isSubagentToolCall(part)) {
    return '';
  }

  const dependencies: string[] = [];
  for (let index = 0; index < groupParts.length; index += 1) {
    const candidate = groupParts[index];
    if (candidate !== part
      && isSubagentChildPart(candidate)
      && getScopedSubagentChildId(candidate) === part.toolCallId) {
      dependencies.push(buildActivityPartDetailProjectionKey(candidate, index, doing));
    }
  }
  return dependencies.join('|');
}

function buildContinuationProjectionKey(turnResponse: TurnResponseTurn | null): string {
  const continuation = turnResponse?.response?.continuation;
  if (!continuation) {
    return '';
  }
  const pendingState = continuation.pendingState;
  const budgets = continuation.budgets;
  return [
    turnResponse?.turnId ?? '',
    continuation.interactionId ?? '',
    continuation.stepIndex ?? '',
    continuation.lease ?? '',
    continuation.status ?? '',
    continuation.stopReason ?? '',
    continuation.hardStopReason ?? '',
    pendingState?.['kind'] ?? '',
    pendingState?.['requestId'] ?? '',
    pendingState?.['sourceEvent'] ?? '',
    budgets?.executionId ?? '',
    budgets?.origin ?? '',
  ].join(':');
}

function buildActivityPartProjectionKey(part: ChatPart, index: number): string {
  const base = `${buildChatPartIdentity(part, index)}:${part.type}`;
  switch (part.type) {
    case 'markdown':
      return [
        base,
        part.partId ?? '',
        part.contentRef ?? '',
        isSubagentChildPart(part) ? getSubAgentInvocationId(part) ?? '' : '',
      ].join(':');
    case 'thinking':
      return [
        base,
        part.partId ?? '',
        part.contentRef ?? '',
        part.isComplete ? 'complete' : 'running',
        isSubagentChildPart(part) ? getSubAgentInvocationId(part) ?? '' : '',
      ].join(':');
    case 'tool_call':
      return [
        base,
        part.partId ?? '',
        part.toolCallId,
        part.toolName,
        part.state,
        part.sourceAgentRole ?? '',
        part.subAgentInvocationId ?? '',
        part.parentToolCallId ?? '',
      ].join(':');
    case 'confirmation':
      return [
        base,
        part.partId ?? '',
        part.askId,
        part.resolved ? 'resolved' : 'pending',
        part.result ?? '',
      ].join(':');
    case 'terminal':
      return [
        base,
        part.partId ?? '',
        part.processId ?? '',
        part.outputSessionId ?? '',
        part.terminalId ?? '',
        part.toolCallId ?? '',
        part.status ?? '',
        part.isRunning ? 'running' : 'idle',
        part.exitCode ?? '',
      ].join(':');
    case 'state':
      return [
        base,
        part.stateId,
        part.state,
        part.kind ?? '',
      ].join(':');
    case 'question':
      return [
        base,
        part.partId ?? '',
        part.questions.length,
        part.answers ? 'answered' : 'open',
      ].join(':');
    case 'error':
      return [base, part.severity ?? ''].join(':');
    case 'plan':
      return [base, part.partId ?? '', part.status].join(':');
    default:
      return base;
  }
}

function buildActivityPartDetailProjectionKey(part: ChatPart, index: number, doing: boolean): string {
  const base = buildActivityPartProjectionKey(part, index);
  switch (part.type) {
    case 'markdown':
      if (doing && part.contentRef) {
        return base;
      }
      return [
        base,
        part.contentLength ?? part.content.length,
      ].join(':');
    case 'thinking':
      if (doing && part.contentRef) {
        return base;
      }
      return [
        base,
        contentProgressKey(part),
      ].join(':');
    case 'tool_call':
      return [
        base,
        buildStructuredProjectionKey(part.args),
        buildMetadataProjectionKey(part.metadata),
      ].join(':');
    case 'confirmation':
      return [
        base,
        buildStructuredProjectionKey(part.args),
        projectionValue(part.message),
        buildMetadataProjectionKey(part.metadata),
      ].join(':');
    case 'terminal':
      return [
        base,
        part.bytesTotal ?? '',
        part.lastOutputAt ?? '',
        part.output?.length ?? 0,
        part.stderr?.length ?? 0,
      ].join(':');
    case 'state':
      return [
        base,
        part.text,
        part.progress ?? '',
        buildMetadataProjectionKey(part.metadata),
      ].join(':');
    case 'question':
      return [
        base,
        buildMetadataProjectionKey(part.metadata),
      ].join(':');
    case 'error':
      return [
        base,
        part.message,
        buildMetadataProjectionKey(part.metadata),
      ].join(':');
    case 'plan':
      return [
        base,
        part.text.length,
      ].join(':');
    default:
      return base;
  }
}

function contentProgressKey(part: { readonly content?: string; readonly contentLength?: number }): string {
  const length = part.contentLength ?? part.content?.length ?? 0;
  if (!part.content || part.content.length === 0) {
    return String(length);
  }
  return `${length}:${projectionValue(part.content)}`;
}

function buildMetadataProjectionKey(metadata: Record<string, unknown> | undefined): string {
  if (!metadata) {
    return '';
  }

  const toolSpecificData = asRecord(metadata['toolSpecificData']);
  const childItems = asArray(toolSpecificData?.['childItems']);
  return [
    projectionValue(metadata['kind']),
    projectionValue(metadata['phase']),
    projectionValue(metadata['status']),
    projectionValue(metadata['argsSummary']),
    buildApprovalProjectionKey(metadata['approval']),
    buildTimelineProjectionKey(metadata['timeline']),
    projectionValue(toolSpecificData?.['kind']),
    projectionValue(toolSpecificData?.['agentName']),
    projectionValue(toolSpecificData?.['description']),
    childItems.length,
    ...childItems.map((child, index) => buildSubagentChildProjectionKey(child, index)),
  ].join(':');
}

function buildSubagentChildProjectionKey(value: unknown, index: number): string {
  const child = asRecord(value);
  if (!child) {
    return String(index);
  }

  return [
    index,
    projectionValue(child['kind']),
    projectionValue(child['toolCallId']),
    projectionValue(child['toolName']),
    projectionValue(child['state']),
    projectionValue(child['contentRef']),
    projectionValue(child['contentKind']),
    projectionValue(child['contentLength']),
    projectionLength(child['content']),
  ].join(',');
}

function buildTimelineProjectionKey(value: unknown): string {
  const timeline = asArray(value);
  const last = asRecord(timeline[timeline.length - 1]);
  return [
    timeline.length,
    projectionValue(last?.['recordId']),
    projectionValue(last?.['phase']),
    projectionValue(last?.['state']),
    buildProgressDetailsProjectionKey(last?.['progressDetails']),
  ].join(',');
}

function buildProgressDetailsProjectionKey(value: unknown): string {
  const details = asRecord(value);
  return [
    projectionValue(details?.['contentRef']),
  ].join(',');
}

function buildApprovalProjectionKey(value: unknown): string {
  const approval = asRecord(value);
  return [
    projectionValue(approval?.['resolved']),
    projectionValue(approval?.['approved']),
  ].join(',');
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function projectionValue(value: unknown): string {
  switch (typeof value) {
    case 'string':
      return value;
    case 'number':
    case 'boolean':
      return String(value);
    default:
      return '';
  }
}

function projectionLength(value: unknown): string {
  return typeof value === 'string' ? String(value.length) : '';
}

function buildStructuredProjectionKey(value: unknown): string {
  if (value == null) {
    return '';
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? '';
  } catch {
    serialized = String(value);
  }

  let hash = 2166136261;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${serialized.length}:${(hash >>> 0).toString(36)}`;
}
