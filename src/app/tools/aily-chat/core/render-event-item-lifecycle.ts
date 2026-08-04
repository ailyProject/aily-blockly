import type { RenderEvent } from 'aily-lex/browser';
import { appendMarkdownContent, getMarkdownContentLength, storeMarkdownContent } from './markdown-content-store';
import { appendThinkContent, getThinkContentLength, storeThinkContent } from './think-content-store';
import { parseTerminalPayload, type ParsedTerminalPayload } from './terminal-payload';
import { collectToolResultText, extractRawToolResultPayloadText } from './tool-result-content';
import { ProposedPlanParser, type ProposedPlanSegment } from './proposed-plan-parser';
import type { QuestionItem, ToolCallPart } from './chat-parts';
import { normalizeSubagentToolCallState } from './chat-parts';
import { normalizeChatErrorNotice } from './chat-error-notice-normalizer';
import { isTodoToolName } from './tool-name-normalizer';

export type CanonicalRenderItemKind =
  | 'markdown'
  | 'thinking'
  | 'tool'
  | 'state'
  | 'terminal'
  | 'question'
  | 'confirmation'
  | 'notice'
  | 'subagent'
  | 'plan'
  | 'metadata';

export type CanonicalRenderItemStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface CanonicalRenderItemScope {
  readonly sourceAgentRole?: 'main' | 'subagent';
  readonly subAgentInvocationId?: string;
  readonly parentToolCallId?: string;
}

export interface CanonicalRenderItemPayloadRef {
  readonly type: 'text';
  readonly contentKind: 'markdown' | 'thinking';
  readonly mode: 'inline' | 'ref';
  readonly contentRef?: string;
  readonly text?: string;
  readonly deltaLength: number;
  readonly contentLength: number;
}

export type CanonicalRenderItemStructuredPayload =
  | {
      readonly type: 'tool';
      readonly toolCallId: string;
      readonly toolName: string;
      readonly text: string;
      readonly state: ToolCallPart['state'];
      readonly args?: unknown;
      readonly metadata?: Record<string, unknown>;
    }
  | {
      readonly type: 'question';
      readonly requestId: string;
      readonly questions: readonly QuestionItem[];
    }
  | {
      readonly type: 'confirmation';
      readonly askId: string;
      readonly message: string;
      readonly toolName?: string;
      readonly source?: string;
      readonly title?: string;
      readonly subtitle?: string;
      readonly description?: string;
      readonly actions?: readonly unknown[];
      readonly primaryScope?: unknown;
      readonly args?: unknown;
      readonly toolCallId?: string;
      readonly resolved?: boolean;
      readonly result?: 'approved' | 'rejected';
      readonly scope?: string;
      readonly selectedActionId?: string;
      readonly selectedActionLabel?: string;
      readonly reviewer?: 'user' | 'auto_review';
      readonly reviewStatus?: 'reviewing' | 'approved' | 'denied' | 'timedOut' | 'aborted';
      readonly reviewRiskLevel?: 'low' | 'medium' | 'high';
      readonly reviewStartedAt?: number;
      readonly reviewCompletedAt?: number;
      readonly decisionSource?: string;
    }
  | {
      readonly type: 'terminal';
      readonly toolCallId: string;
      readonly terminal: ParsedTerminalPayload;
      readonly outputUpdateKind?: 'delta' | 'snapshot';
    }
  | {
      readonly type: 'state';
      readonly stateId: string;
      readonly text: string;
      readonly state: 'doing' | 'done' | 'warn' | 'error' | 'info';
      readonly kind?: string;
      readonly progress?: number;
      readonly metadata?: Record<string, unknown>;
    }
  | {
      readonly type: 'notice';
      readonly message: string;
      readonly severity: 'error' | 'warning' | 'info';
      readonly code?: string;
      readonly metadata?: Record<string, unknown>;
    }
  | {
      readonly type: 'subagent';
      readonly toolCallId: string;
      readonly subAgentInvocationId?: string;
      readonly agentName: string;
      readonly description: string;
      readonly state: 'doing' | 'done' | 'error';
      readonly resultText?: string;
      readonly metadata?: Record<string, unknown>;
    }
  | {
      readonly type: 'plan';
      readonly partId: string;
      readonly text: string;
      readonly status: 'streaming' | 'completed' | 'failed';
      readonly source: 'proposed_plan';
    };

export type CanonicalRenderLifecycleEvent =
  | {
      readonly type: 'turnStarted';
      readonly turnId: string;
      readonly timestamp: number;
    }
  | {
      readonly type: 'turnCompleted';
      readonly turnId: string;
      readonly timestamp: number;
      readonly status: CanonicalRenderItemStatus;
    }
  | {
      readonly type: 'itemStarted';
      readonly itemId: string;
      readonly itemKind: CanonicalRenderItemKind;
      readonly timestamp: number;
      readonly scope?: CanonicalRenderItemScope;
      readonly sourceEventType: RenderEvent['type'];
    }
  | {
      readonly type: 'itemDelta';
      readonly itemId: string;
      readonly itemKind: CanonicalRenderItemKind;
      readonly timestamp: number;
      readonly scope?: CanonicalRenderItemScope;
      readonly deltaKind: 'append' | 'update';
      readonly deltaCount?: number;
      readonly byteLength?: number;
      readonly payloadRef?: CanonicalRenderItemPayloadRef;
      readonly structuredPayload?: CanonicalRenderItemStructuredPayload;
      readonly delivery?: 'immediate' | 'coalesced' | 'suppressed';
      readonly sourceEventType: RenderEvent['type'];
    }
  | {
      readonly type: 'itemCompleted';
      readonly itemId: string;
      readonly itemKind: CanonicalRenderItemKind;
      readonly timestamp: number;
      readonly scope?: CanonicalRenderItemScope;
      readonly status: CanonicalRenderItemStatus;
      readonly sourceEventType: RenderEvent['type'];
    };

interface ActiveTextItem {
  readonly itemId: string;
  readonly itemKind: 'markdown' | 'thinking';
}

interface ActiveTodoToolItem {
  readonly itemId: string;
  readonly toolCallId: string;
  readonly toolName: string;
}

interface ProposedPlanParserState {
  readonly parser: ProposedPlanParser;
  readonly scope?: CanonicalRenderItemScope;
  readonly itemId: string;
}

const INLINE_PAYLOAD_MAX_CHARS = 2048;
const INLINE_TOTAL_PAYLOAD_MAX_CHARS = 4096;
const STRUCTURED_ARG_MAX_CHARS = 4096;
const SUBAGENT_RESULT_MAX_CHARS = 4096;

/**
 * Normalizes legacy Aily RenderEvent names into a Codex-style turn/item lifecycle.
 *
 * This is intentionally a side-by-side contract layer: it does not mutate UI state.
 * Existing render paths can continue to consume RenderEvent while host/UI consumers
 * migrate toward stable itemStarted -> itemDelta -> itemCompleted boundaries.
 */
export class RenderEventItemLifecycleNormalizer {
  private activeTurnId = '';
  private turnCompleted = false;
  private nextTextItemOrdinal = 0;
  private readonly activeTextItems = new Map<string, ActiveTextItem>();
  private readonly startedItems = new Set<string>();
  private readonly startedItemKinds = new Map<string, CanonicalRenderItemKind>();
  private readonly startedItemScopes = new Map<string, CanonicalRenderItemScope | undefined>();
  private readonly completedItems = new Set<string>();
  private readonly payloadRefs = new Map<string, string>();
  private readonly proposedPlanParsers = new Map<string, ProposedPlanParserState>();
  private activeTodoToolItem: ActiveTodoToolItem | null = null;

  process(event: RenderEvent): CanonicalRenderLifecycleEvent[] {
    const output: CanonicalRenderLifecycleEvent[] = [];
    const timestamp = readTimestamp(event);

    switch (event.type) {
      case 'turn_begin':
        this.resetTurn(event.turnId);
        output.push({ type: 'turnStarted', turnId: event.turnId, timestamp });
        return output;

      case 'response_complete':
      case 'turn_end':
        output.push(...this.flushProposedPlanParsers(timestamp, event.type));
        output.push(...this.completeActiveTextItems(timestamp, 'completed', event.type));
        output.push(...this.completeAllStartedItems(timestamp, 'completed', event.type));
        if (!this.turnCompleted) {
          output.push({
            type: 'turnCompleted',
            turnId: event.turnId || this.activeTurnId,
            timestamp,
            status: 'completed',
          });
          this.turnCompleted = true;
        }
        return output;

      case 'markdown_delta':
        if (shouldParseProposedPlan(event)) {
          output.push(...this.processProposedPlanMarkdownDelta(event, timestamp));
          return output;
        }
        output.push(...this.appendMarkdownTextSegment(event, timestamp, event.text, event.type));
        return output;

      case 'thinking_delta':
        output.push(...this.completeDifferentTextItem(event, 'thinking', timestamp));
        output.push(...this.ensureTextItem(event, 'thinking', timestamp));
        output.push(this.deltaFor(this.activeTextItem(event, 'thinking').itemId, 'thinking', timestamp, 'append', event.type, event.text));
        return output;

      case 'thinking_complete': {
        const active = this.activeTextItems.get(textScopeKey(event, 'thinking'));
        if (active) {
          output.push(this.completeItem(active.itemId, 'thinking', timestamp, 'completed', event.type));
          this.activeTextItems.delete(textScopeKey(event, 'thinking'));
        }
        return output;
      }

      case 'tool_call_begin': {
        const itemId = toolItemId(event);
        output.push(...this.completeActiveTextItemsForScope(event, timestamp, event.type));
        output.push(...this.ensureItem(itemId, 'tool', event, timestamp));
        output.push(this.deltaFor(itemId, 'tool', timestamp, 'update', event.type, undefined, toolBeginPayload(event)));
        if (isTodoToolName(event.toolName)) {
          this.activeTodoToolItem = {
            itemId,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
          };
        }
        return output;
      }

      case 'tool_call_progress':
        {
          const terminalEvents = this.terminalItemsForToolProgress(event, timestamp);
          if (terminalEvents.length > 0) {
            return terminalEvents;
          }
        }
        output.push(...this.ensureItem(toolItemId(event), 'tool', event, timestamp));
        output.push(this.deltaFor(
          toolItemId(event),
          'tool',
          timestamp,
          'update',
          event.type,
          summarizeToolProgress(event),
          toolProgressPayload(event),
        ));
        return output;

      case 'tool_call_end': {
        {
          const terminalEvents = this.terminalItemForToolResult(event, timestamp);
          if (terminalEvents.length > 0) {
            return terminalEvents;
          }
        }
        const itemId = toolItemId(event);
        output.push(...this.ensureItem(itemId, 'tool', event, timestamp));
        output.push(this.deltaFor(itemId, 'tool', timestamp, 'update', event.type, event.resultText, toolEndPayload(event)));
        output.push(this.completeItem(itemId, 'tool', timestamp, event.state === 'error' ? 'failed' : 'completed', event.type));
        if (this.activeTodoToolItem?.itemId === itemId) {
          this.activeTodoToolItem = null;
        }
        return output;
      }

      case 'state_update':
        if (isSubagentStateUpdateEvent(event)) {
          const id = subagentItemId(
            subagentToolCallIdFromStateUpdate(event),
            subagentInvocationIdFromStateUpdate(event),
          );
          output.push(...this.completeActiveTextItemsForScope(event, timestamp, event.type));
          output.push(...this.ensureItem(id, 'subagent', event, timestamp));
          output.push(this.deltaFor(
            id,
            'subagent',
            timestamp,
            'update',
            event.type,
            event.text,
            subagentStateUpdatePayload(event),
          ));
          const subagentState = normalizeSubagentToolCallState(event.state);
          if (subagentState === 'error' || subagentState === 'done') {
            output.push(this.completeItem(id, 'subagent', timestamp, subagentState === 'error' ? 'failed' : 'completed', event.type));
          }
          return output;
        }
        output.push(...this.upsertStateItem(`state:${event.stateId}`, 'state', event, timestamp, event.state === 'error' ? 'failed' : event.state === 'doing' ? undefined : 'completed', event.text, statePayload(event)));
        return output;

      case 'background_task_update':
        output.push(...this.upsertStateItem(`background:${event.stateId}`, 'state', event, timestamp, event.state === 'error' ? 'failed' : event.state === 'doing' ? undefined : 'completed', summarizeBackgroundTaskUpdate(event), backgroundStatePayload(event)));
        return output;

      case 'todo_update':
        if (this.activeTodoToolItem) {
          const activeTodoToolItem = this.activeTodoToolItem;
          output.push(this.deltaFor(
            activeTodoToolItem.itemId,
            'tool',
            timestamp,
            'update',
            event.type,
            event.summary,
            todoToolPayload(event, activeTodoToolItem),
          ));
          output.push(this.completeItem(activeTodoToolItem.itemId, 'tool', timestamp, 'completed', event.type));
          this.activeTodoToolItem = null;
        }
        return output;

      case 'question_request':
        output.push(...this.ensureItem(`question:${event.requestId}`, 'question', event, timestamp));
        output.push(this.deltaFor(`question:${event.requestId}`, 'question', timestamp, 'update', event.type, summarizeQuestionRequest(event), questionPayload(event)));
        return output;

      case 'approval_request': {
        if (hasToolCallId(event)) {
          const id = toolScopedItemId(event, event.toolCallId);
          output.push(...this.ensureItem(id, 'tool', event, timestamp));
          output.push(this.deltaFor(id, 'tool', timestamp, 'update', event.type, event.message || event.title || event.toolName, confirmationPayload(event)));
          return output;
        }
        const id = approvalItemId(event);
        output.push(...this.ensureItem(id, 'confirmation', event, timestamp));
        output.push(this.deltaFor(id, 'confirmation', timestamp, 'update', event.type, event.message || event.title || event.toolName, confirmationPayload(event)));
        return output;
      }

      case 'approval_resolve': {
        if (hasToolCallId(event)) {
          const id = toolScopedItemId(event, event.toolCallId);
          output.push(...this.ensureItem(id, 'tool', event, timestamp));
          output.push(this.deltaFor(id, 'tool', timestamp, 'update', event.type, undefined, confirmationResolvePayload(event)));
          if (event.result !== 'approved') {
            output.push(this.completeItem(id, 'tool', timestamp, 'cancelled', event.type));
          }
          return output;
        }
        const id = approvalItemId(event);
        output.push(...this.ensureItem(id, 'confirmation', event, timestamp));
        output.push(this.deltaFor(id, 'confirmation', timestamp, 'update', event.type, undefined, confirmationResolvePayload(event)));
        output.push(this.completeItem(id, 'confirmation', timestamp, event.result === 'approved' ? 'completed' : 'cancelled', event.type));
        return output;
      }

      case 'warning_notice':
      case 'info_notice':
      case 'error_notice': {
        const id = `notice:${event.type}:${timestamp}:${this.nextTextItemOrdinal++}`;
        output.push(...this.ensureItem(id, 'notice', event, timestamp));
        output.push(this.deltaFor(
          id,
          'notice',
          timestamp,
          'update',
          event.type,
          'message' in event ? event.message : undefined,
          noticePayload(event),
        ));
        output.push(this.completeItem(id, 'notice', timestamp, event.type === 'error_notice' ? 'failed' : 'completed', event.type));
        return output;
      }

      case 'subagent_begin': {
        const id = subagentItemId(event.toolCallId, event.subAgentInvocationId);
        output.push(...this.completeActiveTextItemsForScope(event, timestamp, event.type));
        output.push(...this.ensureItem(id, 'subagent', event, timestamp));
        output.push(this.deltaFor(id, 'subagent', timestamp, 'update', event.type, event.description || event.agentName, subagentBeginPayload(event)));
        return output;
      }

      case 'subagent_activity': {
        output.push(...this.ensureSubagentParentForActivity(event, timestamp));
        if (event.activityKind === 'thinking') {
          output.push(...this.completeDifferentTextItem(event, 'thinking', timestamp));
          output.push(...this.ensureTextItem(event, 'thinking', timestamp));
          output.push(this.deltaFor(this.activeTextItem(event, 'thinking').itemId, 'thinking', timestamp, 'append', event.type, event.content));
          return output;
        }
        if (event.activityKind === 'text') {
          output.push(...this.appendMarkdownTextSegment(event, timestamp, event.content || '', event.type));
          return output;
        }

        const id = subagentActivityItemId(event);
        const kind = isSubagentToolActivity(event) ? 'tool' : 'subagent';
        output.push(...this.completeActiveTextItemsForScope(event, timestamp, event.type));
        output.push(...this.ensureItem(id, kind, event, timestamp));
        output.push(this.deltaFor(id, kind, timestamp, 'update', event.type, event.content, subagentActivityStructuredPayload(event)));
        if (event.activityKind === 'tool_completed' || event.activityKind === 'tool_failed') {
          output.push(this.completeItem(id, kind, timestamp, event.activityKind === 'tool_failed' ? 'failed' : 'completed', event.type));
        }
        return output;
      }

      case 'subagent_end': {
        const id = subagentItemId(event.toolCallId, event.subAgentInvocationId);
        output.push(...this.ensureItem(id, 'subagent', event, timestamp));
        output.push(this.deltaFor(id, 'subagent', timestamp, 'update', event.type, undefined, subagentEndPayload(event)));
        output.push(this.completeItem(id, 'subagent', timestamp, event.state === 'error' ? 'failed' : 'completed', event.type));
        return output;
      }

      case 'approval_auto_review_start': {
        if (typeof event.toolCallId === 'string' && event.toolCallId.trim().length > 0) {
          const id = toolScopedItemId(event, event.toolCallId);
          output.push(...this.ensureItem(id, 'tool', event, timestamp));
          output.push(this.deltaFor(id, 'tool', timestamp, 'update', event.type, event.reason, autoReviewStartPayload(event, event.toolCallId)));
          return output;
        }
        output.push(...this.ensureItem(`metadata:${event.type}`, 'metadata', event, timestamp));
        output.push(this.deltaFor(`metadata:${event.type}`, 'metadata', timestamp, 'update', event.type));
        return output;
      }

      case 'approval_auto_review_complete': {
        if (typeof event.toolCallId === 'string' && event.toolCallId.trim().length > 0) {
          const id = toolScopedItemId(event, event.toolCallId);
          output.push(...this.ensureItem(id, 'tool', event, timestamp));
          output.push(this.deltaFor(id, 'tool', timestamp, 'update', event.type, event.rationale, autoReviewCompletePayload(event, event.toolCallId)));
          if (event.status !== 'approved') {
            output.push(this.completeItem(id, 'tool', timestamp, 'failed', event.type));
          }
          return output;
        }
        output.push(...this.ensureItem(`metadata:${event.type}`, 'metadata', event, timestamp));
        output.push(this.deltaFor(`metadata:${event.type}`, 'metadata', timestamp, 'update', event.type));
        return output;
      }

      case 'response_reference':
      case 'response_code_citation':
      case 'response_progress_message':
      case 'response_followups':
      case 'response_command':
      case 'usage':
      case 'session_meta':
      case 'clear_to_previous_tool_invocation':
        return output;
    }

    return output;
  }

  reset(): void {
    this.activeTurnId = '';
    this.turnCompleted = false;
    this.nextTextItemOrdinal = 0;
    this.activeTextItems.clear();
    this.startedItems.clear();
    this.startedItemKinds.clear();
    this.startedItemScopes.clear();
    this.completedItems.clear();
    this.payloadRefs.clear();
    this.proposedPlanParsers.clear();
    this.activeTodoToolItem = null;
  }

  finalizeActiveTurn(
    status: CanonicalRenderItemStatus,
    timestamp = Date.now(),
    turnId = this.activeTurnId,
  ): CanonicalRenderLifecycleEvent[] {
    const output: CanonicalRenderLifecycleEvent[] = [];
    output.push(...this.flushProposedPlanParsers(timestamp, 'turn_end'));
    output.push(...this.completeActiveTextItems(timestamp, status, 'turn_end'));
    output.push(...this.completeAllStartedItems(timestamp, status, 'turn_end'));

    const resolvedTurnId = typeof turnId === 'string' ? turnId.trim() : '';
    if (resolvedTurnId && !this.turnCompleted) {
      output.push({
        type: 'turnCompleted',
        turnId: resolvedTurnId,
        timestamp,
        status,
      });
      this.turnCompleted = true;
    }

    return output;
  }

  private resetTurn(turnId: string): void {
    this.reset();
    this.activeTurnId = turnId;
  }

  private ensureTextItem(
    event: RenderEvent,
    itemKind: 'markdown' | 'thinking',
    timestamp: number,
  ): CanonicalRenderLifecycleEvent[] {
    const key = textScopeKey(event, itemKind);
    if (!this.activeTextItems.has(key)) {
      const itemId = `${key}:${this.nextTextItemOrdinal++}`;
      this.activeTextItems.set(key, { itemId, itemKind });
    }
    const active = this.activeTextItems.get(key)!;
    return this.ensureItem(active.itemId, itemKind, event, timestamp);
  }

  private activeTextItem(event: RenderEvent, itemKind: 'markdown' | 'thinking'): ActiveTextItem {
    return this.activeTextItems.get(textScopeKey(event, itemKind))!;
  }

  private appendMarkdownTextSegment(
    event: RenderEvent,
    timestamp: number,
    text: string,
    sourceEventType: RenderEvent['type'],
  ): CanonicalRenderLifecycleEvent[] {
    if (!text) {
      return [];
    }
    const output: CanonicalRenderLifecycleEvent[] = [];
    output.push(...this.completeDifferentTextItem(event, 'markdown', timestamp));
    output.push(...this.ensureTextItem(event, 'markdown', timestamp));
    output.push(this.deltaFor(this.activeTextItem(event, 'markdown').itemId, 'markdown', timestamp, 'append', sourceEventType, text));
    return output;
  }

  private processProposedPlanMarkdownDelta(
    event: Extract<RenderEvent, { type: 'markdown_delta' }>,
    timestamp: number,
  ): CanonicalRenderLifecycleEvent[] {
    const state = this.proposedPlanParserState(event);
    return this.proposedPlanSegmentsToEvents(event, timestamp, state, state.parser.push(event.text));
  }

  private proposedPlanParserState(event: RenderEvent): ProposedPlanParserState {
    const key = scopeKey(event);
    let state = this.proposedPlanParsers.get(key);
    if (!state) {
      state = {
        parser: new ProposedPlanParser(),
        scope: readScope(event),
        itemId: `${key}:plan:proposed`,
      };
      this.proposedPlanParsers.set(key, state);
    }
    return state;
  }

  private proposedPlanSegmentsToEvents(
    event: RenderEvent,
    timestamp: number,
    state: ProposedPlanParserState,
    segments: readonly ProposedPlanSegment[],
  ): CanonicalRenderLifecycleEvent[] {
    const output: CanonicalRenderLifecycleEvent[] = [];
    for (const segment of segments) {
      switch (segment.type) {
        case 'normal':
          output.push(...this.appendMarkdownTextSegment(event, timestamp, segment.text, event.type));
          break;
        case 'planStart':
          output.push(...this.completeActiveTextItemsForScope(event, timestamp, event.type));
          output.push(...this.ensureItemWithScope(state.itemId, 'plan', timestamp, event.type, state.scope));
          break;
        case 'planDelta':
          output.push(...this.ensureItemWithScope(state.itemId, 'plan', timestamp, event.type, state.scope));
          output.push(this.deltaFor(state.itemId, 'plan', timestamp, 'append', event.type, segment.text, planPayload(state.itemId, segment.text, 'streaming')));
          break;
        case 'planEnd':
          output.push(this.completeItem(state.itemId, 'plan', timestamp, 'completed', event.type));
          break;
      }
    }
    return output;
  }

  private flushProposedPlanParsers(
    timestamp: number,
    sourceEventType: RenderEvent['type'],
  ): CanonicalRenderLifecycleEvent[] {
    const output: CanonicalRenderLifecycleEvent[] = [];
    for (const [scope, state] of [...this.proposedPlanParsers]) {
      const event = {
        type: sourceEventType,
        timestamp,
        ...(state.scope?.sourceAgentRole ? { sourceAgentRole: state.scope.sourceAgentRole } : {}),
        ...(state.scope?.subAgentInvocationId ? { subAgentInvocationId: state.scope.subAgentInvocationId } : {}),
        ...(state.scope?.parentToolCallId ? { parentToolCallId: state.scope.parentToolCallId } : {}),
      } as RenderEvent;
      output.push(...this.proposedPlanSegmentsToEvents(event, timestamp, state, state.parser.finish()));
      this.proposedPlanParsers.delete(scope);
    }
    return output;
  }

  private completeDifferentTextItem(
    event: RenderEvent,
    itemKind: 'markdown' | 'thinking',
    timestamp: number,
  ): CanonicalRenderLifecycleEvent[] {
    const scope = scopeKey(event);
    const oppositeKind = itemKind === 'markdown' ? 'thinking' : 'markdown';
    const key = `${scope}:${oppositeKind}`;
    const active = this.activeTextItems.get(key);
    if (!active) {
      return [];
    }
    this.activeTextItems.delete(key);
    return [this.completeItem(active.itemId, active.itemKind, timestamp, 'completed', event.type)];
  }

  private completeActiveTextItemsForScope(
    event: RenderEvent,
    timestamp: number,
    sourceEventType: RenderEvent['type'],
  ): CanonicalRenderLifecycleEvent[] {
    const prefix = `${scopeKey(event)}:`;
    const output: CanonicalRenderLifecycleEvent[] = [];
    for (const [key, active] of [...this.activeTextItems]) {
      if (!key.startsWith(prefix)) {
        continue;
      }
      this.activeTextItems.delete(key);
      output.push(this.completeItem(active.itemId, active.itemKind, timestamp, 'completed', sourceEventType));
    }
    return output;
  }

  private completeActiveTextItems(
    timestamp: number,
    status: CanonicalRenderItemStatus,
    sourceEventType: RenderEvent['type'],
  ): CanonicalRenderLifecycleEvent[] {
    const output: CanonicalRenderLifecycleEvent[] = [];
    for (const [key, active] of [...this.activeTextItems]) {
      this.activeTextItems.delete(key);
      output.push(this.completeItem(active.itemId, active.itemKind, timestamp, status, sourceEventType));
    }
    return output;
  }

  private upsertStateItem(
    itemId: string,
    itemKind: CanonicalRenderItemKind,
    event: RenderEvent,
    timestamp: number,
    completeAs?: CanonicalRenderItemStatus,
    text?: string,
    structuredPayload?: CanonicalRenderItemStructuredPayload,
  ): CanonicalRenderLifecycleEvent[] {
    const output = this.ensureItem(itemId, itemKind, event, timestamp);
    output.push(this.deltaFor(itemId, itemKind, timestamp, 'update', event.type, text, structuredPayload));
    if (completeAs && !this.completedItems.has(itemId)) {
      output.push(this.completeItem(itemId, itemKind, timestamp, completeAs, event.type));
    }
    return output;
  }

  private terminalItemForToolResult(
    event: Extract<RenderEvent, { type: 'tool_call_end' }>,
    timestamp: number,
  ): CanonicalRenderLifecycleEvent[] {
    const terminal = parseTerminalPayload(event.resultText)
      ?? parseTerminalPayload(extractRawToolResultPayloadText(event.result))
      ?? terminalSessionPayloadFromToolResult(event);
    if (!terminal) {
      return [];
    }

    // VS Code keeps terminal state on the original IChatToolInvocation. A
    // command result changes the invocation's tool-specific payload; it must
    // not create a sibling response item with a second identity.
    const itemId = toolItemId(event);
    const output: CanonicalRenderLifecycleEvent[] = [
      ...this.ensureItem(itemId, 'tool', event, timestamp),
      this.deltaFor(itemId, 'tool', timestamp, 'update', event.type, summarizeTerminalPayload(terminal), terminalPayload(event, terminal)),
    ];
    if (!terminal.isRunning) {
      output.push(this.completeItem(
        itemId,
        'tool',
        timestamp,
        event.state === 'error' || (typeof terminal.exitCode === 'number' && terminal.exitCode !== 0) ? 'failed' : 'completed',
        event.type,
      ));
    }
    return output;
  }

  private terminalItemsForToolProgress(
    event: Extract<RenderEvent, { type: 'tool_call_progress' }>,
    timestamp: number,
  ): CanonicalRenderLifecycleEvent[] {
    const payload = terminalPayloadFromToolProgress(event);
    if (!payload) {
      return [];
    }

    const itemId = toolItemId(event);
    const output: CanonicalRenderLifecycleEvent[] = [
      ...this.ensureItem(itemId, 'tool', event, timestamp),
      this.deltaFor(
        itemId,
        'tool',
        timestamp,
        'update',
        event.type,
        summarizeTerminalPayload(payload.terminal),
        payload,
      ),
    ];
    if (!payload.terminal.isRunning) {
      output.push(this.completeItem(
        itemId,
        'tool',
        timestamp,
        terminalPayloadCompletionStatus(payload.terminal),
        event.type,
      ));
    }
    return output;
  }

  private ensureSubagentParentForActivity(
    event: Extract<RenderEvent, { type: 'subagent_activity' }>,
    timestamp: number,
  ): CanonicalRenderLifecycleEvent[] {
    const id = subagentItemId(event.toolCallId, event.subAgentInvocationId);
    if (this.startedItems.has(id)) {
      return [];
    }
    return [
      ...this.ensureItem(id, 'subagent', event, timestamp),
      this.deltaFor(id, 'subagent', timestamp, 'update', event.type, undefined, subagentActivityParentPayload(event)),
    ];
  }

  private ensureItem(
    itemId: string,
    itemKind: CanonicalRenderItemKind,
    event: RenderEvent,
    timestamp: number,
  ): CanonicalRenderLifecycleEvent[] {
    if (this.startedItems.has(itemId)) {
      return [];
    }
    this.startedItems.add(itemId);
    this.startedItemKinds.set(itemId, itemKind);
    this.startedItemScopes.set(itemId, readScope(event));
    return [{
      type: 'itemStarted',
      itemId,
      itemKind,
      timestamp,
      scope: this.startedItemScopes.get(itemId),
      sourceEventType: event.type,
    }];
  }

  private ensureItemWithScope(
    itemId: string,
    itemKind: CanonicalRenderItemKind,
    timestamp: number,
    sourceEventType: RenderEvent['type'],
    scope?: CanonicalRenderItemScope,
  ): CanonicalRenderLifecycleEvent[] {
    if (this.startedItems.has(itemId)) {
      return [];
    }
    this.startedItems.add(itemId);
    this.startedItemKinds.set(itemId, itemKind);
    this.startedItemScopes.set(itemId, scope);
    return [{
      type: 'itemStarted',
      itemId,
      itemKind,
      timestamp,
      scope,
      sourceEventType,
    }];
  }

  private deltaFor(
    itemId: string,
    itemKind: CanonicalRenderItemKind,
    timestamp: number,
    deltaKind: 'append' | 'update',
    sourceEventType: RenderEvent['type'],
    text?: string,
    structuredPayload?: CanonicalRenderItemStructuredPayload,
  ): CanonicalRenderLifecycleEvent {
    const payloadRef = buildPayloadRef(this.payloadRefs, itemId, itemKind, text);
    return {
      type: 'itemDelta',
      itemId,
      itemKind,
      timestamp,
      scope: this.startedItemScopes.get(itemId),
      deltaKind,
      deltaCount: 1,
      ...(text ? { byteLength: text.length } : {}),
      ...(payloadRef ? { payloadRef } : {}),
      ...(structuredPayload ? { structuredPayload } : {}),
      delivery: 'immediate',
      sourceEventType,
    };
  }

  private completeItem(
    itemId: string,
    itemKind: CanonicalRenderItemKind,
    timestamp: number,
    status: CanonicalRenderItemStatus,
    sourceEventType: RenderEvent['type'],
  ): CanonicalRenderLifecycleEvent {
    if (this.completedItems.has(itemId)) {
      return this.deltaFor(itemId, itemKind, timestamp, 'update', sourceEventType);
    }
    this.completedItems.add(itemId);
    this.startedItemKinds.set(itemId, itemKind);
    return {
      type: 'itemCompleted',
      itemId,
      itemKind,
      timestamp,
      scope: this.startedItemScopes.get(itemId),
      status,
      sourceEventType,
    };
  }

  private completeAllStartedItems(
    timestamp: number,
    status: CanonicalRenderItemStatus,
    sourceEventType: RenderEvent['type'],
  ): CanonicalRenderLifecycleEvent[] {
    const output: CanonicalRenderLifecycleEvent[] = [];
    for (const itemId of this.startedItems) {
      if (this.completedItems.has(itemId)) {
        continue;
      }
      const itemKind = this.startedItemKinds.get(itemId);
      if (!itemKind) {
        continue;
      }
      output.push(this.completeItem(itemId, itemKind, timestamp, status, sourceEventType));
    }
    return output;
  }
}

function readTimestamp(event: RenderEvent): number {
  return typeof (event as { timestamp?: unknown }).timestamp === 'number'
    ? (event as { timestamp: number }).timestamp
    : Date.now();
}

function readScope(event: RenderEvent): CanonicalRenderItemScope | undefined {
  const record = event as unknown as Record<string, unknown>;
  const isSubagentActivity = record['type'] === 'subagent_activity';
  const sourceAgentRole = record['sourceAgentRole'] === 'subagent' ? 'subagent'
    : record['sourceAgentRole'] === 'main' ? 'main'
    : isSubagentActivity ? 'subagent'
    : undefined;
  const subAgentInvocationId = asString(record['subAgentInvocationId'])
    || (isSubagentActivity ? asString(record['toolCallId']) : undefined);
  const parentToolCallId = asString(record['parentToolCallId'])
    || (isSubagentActivity ? asString(record['toolCallId']) : undefined)
    || (sourceAgentRole === 'subagent' ? asString(record['toolCallId']) : undefined);

  if (!sourceAgentRole && !subAgentInvocationId && !parentToolCallId) {
    return undefined;
  }

  return {
    ...(sourceAgentRole ? { sourceAgentRole } : {}),
    ...(subAgentInvocationId ? { subAgentInvocationId } : {}),
    ...(parentToolCallId ? { parentToolCallId } : {}),
  };
}

function scopeKey(event: RenderEvent): string {
  const scope = readScope(event);
  return [
    scope?.sourceAgentRole || 'main',
    scope?.subAgentInvocationId || 'root',
    scope?.parentToolCallId || 'root',
  ].join(':');
}

function shouldParseProposedPlan(event: Extract<RenderEvent, { type: 'markdown_delta' }>): boolean {
  return readScope(event)?.sourceAgentRole !== 'subagent';
}

function textScopeKey(event: RenderEvent, itemKind: 'markdown' | 'thinking'): string {
  return `${scopeKey(event)}:${itemKind}`;
}

function toolItemId(event: Extract<RenderEvent, { type: 'tool_call_begin' | 'tool_call_progress' | 'tool_call_end' }>): string {
  return `${scopeKey(event)}:tool:${event.toolCallId}`;
}

function toolScopedItemId(event: RenderEvent, toolCallId: string): string {
  return `${scopeKey(event)}:tool:${toolCallId}`;
}

function approvalItemId(event: Extract<RenderEvent, { type: 'approval_request' | 'approval_resolve' }>): string {
  return `${scopeKey(event)}:approval:${event.toolCallId || event.requestId || 'unknown'}`;
}

function hasToolCallId<T extends { readonly toolCallId?: string }>(event: T): event is T & { readonly toolCallId: string } {
  return typeof event.toolCallId === 'string' && event.toolCallId.trim().length > 0;
}

function summarizeQuestionRequest(event: Extract<RenderEvent, { type: 'question_request' }>): string {
  return event.questions
    .map(question => question.question.trim())
    .filter(question => question.length > 0)
    .join('\n');
}

function summarizeBackgroundTaskUpdate(event: Extract<RenderEvent, { type: 'background_task_update' }>): string {
  return [
    event.description,
    event.summary,
    event.error,
    event.activity?.summary,
    event.activity?.description,
    event.activity?.resultText,
  ]
    .map(value => typeof value === 'string' ? value.trim() : '')
    .find(value => value.length > 0) || event.state;
}

function summarizeTerminalPayload(terminal: ParsedTerminalPayload): string {
  const header = [
    terminal.command ? `$ ${terminal.command}` : '',
    terminal.status ? `status: ${terminal.status}` : '',
    typeof terminal.exitCode === 'number' ? `exitCode: ${terminal.exitCode}` : '',
    terminal.outputSessionId ? `outputSessionId: ${terminal.outputSessionId}` : '',
  ].filter(Boolean).join('\n');
  const output = [terminal.output, terminal.stderr].filter(value => value.trim().length > 0).join('\n');
  return [header, output].filter(value => value.trim().length > 0).join('\n\n');
}

function toolBeginPayload(event: Extract<RenderEvent, { type: 'tool_call_begin' }>): CanonicalRenderItemStructuredPayload {
  return {
    type: 'tool',
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    text: `${event.toolName}...`,
    state: 'doing',
    args: boundedStructuredValue(event.input),
  };
}

function toolEndPayload(event: Extract<RenderEvent, { type: 'tool_call_end' }>): CanonicalRenderItemStructuredPayload {
  return {
    type: 'tool',
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    text: event.resultText,
    state: event.state === 'error' ? 'error' : 'done',
    metadata: {
      durationMs: event.durationMs,
      isError: event.isError,
    },
  };
}

function toolProgressPayload(event: Extract<RenderEvent, { type: 'tool_call_progress' }>): CanonicalRenderItemStructuredPayload | undefined {
  const progress = normalizeToolProgress(event.data);
  if (!progress) {
    return undefined;
  }

  const phase = normalizeProgressPhase(progress.phase);
  if (progress.kind === 'editor_operation') {
    return {
      type: 'tool',
      toolCallId: event.toolCallId,
      toolName: progress.toolName || 'tool',
      text: progress.summary || progress.label || progress.statusText || 'Tool still running...',
      state: resolveProgressToolState(progress),
      metadata: boundedRecord({
        phase,
        progress: progress.progress,
        progressKind: 'editor_operation',
        operationId: progress.operationId,
        operationKind: progress.operationKind,
        operationLabel: progress.label,
        queueSize: progress.queueSize,
        durationMs: progress.durationMs,
        running: progress.running,
      }),
    };
  }

  return {
    type: 'tool',
    toolCallId: event.toolCallId,
    toolName: progress.toolName || 'tool',
    text: progress.summary || progress.label || progress.statusText || 'Tool still running...',
    state: resolveProgressToolState(progress),
    metadata: boundedRecord({
      phase,
      progress: progress.progress,
      progressKind: progress.kind,
      operationId: progress.operationId,
      operationKind: progress.operationKind,
      operationLabel: progress.label,
      queueSize: progress.queueSize,
      durationMs: progress.durationMs,
      timeline: [
        {
          recordId: `${event.toolCallId}:progress`,
          phase,
          summary: progress.summary,
          progress: progress.progress,
          progressDetails: buildToolProgressDetails(progress),
          timestamp: event.timestamp,
        },
      ],
    }),
  };
}

function summarizeToolProgress(event: Extract<RenderEvent, { type: 'tool_call_progress' }>): string | undefined {
  const progress = normalizeToolProgress(event.data);
  return progress?.summary || progress?.label || progress?.statusText;
}

function statePayload(event: Extract<RenderEvent, { type: 'state_update' }>): CanonicalRenderItemStructuredPayload {
  return {
    type: 'state',
    stateId: event.stateId,
    text: event.text,
    state: event.state,
    kind: event.kind,
    progress: event.progress,
    metadata: boundedRecord(event.metadata),
  };
}

function backgroundStatePayload(event: Extract<RenderEvent, { type: 'background_task_update' }>): CanonicalRenderItemStructuredPayload {
  return {
    type: 'state',
    stateId: event.stateId,
    text: event.description || event.summary || event.state,
    state: event.state,
    kind: 'background_task',
    progress: event.progress,
    metadata: boundedRecord({
      taskId: event.taskId,
      agentName: event.agentName,
      summary: event.summary,
      activity: event.activity,
    }),
  };
}

function todoToolPayload(
  event: Extract<RenderEvent, { type: 'todo_update' }>,
  activeTodoToolItem: ActiveTodoToolItem,
): CanonicalRenderItemStructuredPayload {
  const todoList = Array.isArray(event.items)
    ? event.items.map((item, index) => {
        const value = item as { readonly id?: unknown; readonly title?: unknown; readonly content?: unknown; readonly status?: unknown };
        return {
          id: String(value.id ?? index + 1),
          title: typeof value.title === 'string' && value.title.trim().length > 0
            ? value.title
            : typeof value.content === 'string' && value.content.trim().length > 0
              ? value.content
              : `Todo ${index + 1}`,
          status: typeof value.status === 'string' && value.status.trim().length > 0
            ? value.status
            : 'not-started',
        };
      })
    : [];
  return {
    type: 'tool',
    toolCallId: activeTodoToolItem.toolCallId,
    toolName: activeTodoToolItem.toolName,
    text: event.summary,
    state: 'done',
    metadata: boundedRecord({
      toolSpecificData: {
        kind: 'todoList',
        todoList,
      },
    }),
  };
}

function noticePayload(event: Extract<RenderEvent, { type: 'warning_notice' | 'info_notice' | 'error_notice' }>): CanonicalRenderItemStructuredPayload {
  const rawCode = 'code' in event ? event.code : undefined;
  const rawDetails = (event as { readonly details?: unknown }).details;
  if (event.type === 'error_notice') {
    const normalized = normalizeChatErrorNotice({
      message: event.message,
      code: typeof rawCode === 'string' ? rawCode : undefined,
      details: rawDetails,
    });
    return {
      type: 'notice',
      message: normalized.message,
      severity: 'error',
      code: normalized.code,
      metadata: boundedRecord({
        ...(normalized.metadata ?? {}),
      }),
    };
  }

  const code = typeof rawCode === 'string' && rawCode.trim().length > 0
    ? rawCode.trim()
    : undefined;
  return {
    type: 'notice',
    message: event.message,
    severity: event.type === 'warning_notice' ? 'warning' : 'info',
    code,
    metadata: boundedRecord({
      ...(code ? { code } : {}),
      ...(rawDetails && typeof rawDetails === 'object' ? { details: rawDetails } : {}),
    }),
  };
}

function subagentBeginPayload(event: Extract<RenderEvent, { type: 'subagent_begin' }>): CanonicalRenderItemStructuredPayload {
  return {
    type: 'subagent',
    toolCallId: event.toolCallId,
    subAgentInvocationId: event.subAgentInvocationId,
    agentName: event.agentName,
    description: event.description,
    state: 'doing',
    metadata: subagentMetadata(event, 'started'),
  };
}

function subagentActivityParentPayload(event: Extract<RenderEvent, { type: 'subagent_activity' }>): CanonicalRenderItemStructuredPayload {
  const subAgentInvocationId = event.subAgentInvocationId || event.toolCallId;
  return {
    type: 'subagent',
    toolCallId: event.toolCallId,
    subAgentInvocationId,
    agentName: 'Agent',
    description: 'Subagent',
    state: 'doing',
    resultText: '',
    metadata: subagentMetadata({
      type: 'subagent_begin',
      toolCallId: event.toolCallId,
      subAgentInvocationId,
      agentName: 'Agent',
      description: 'Subagent',
      timestamp: event.timestamp,
    }, 'started'),
  };
}

function subagentStateUpdatePayload(event: Extract<RenderEvent, { type: 'state_update' }>): CanonicalRenderItemStructuredPayload {
  const toolCallId = subagentToolCallIdFromStateUpdate(event);
  const subAgentInvocationId = subagentInvocationIdFromStateUpdate(event);
  const agentName = subagentStateUpdateString(event, 'agentName')
    || subagentStateUpdateString(event, 'name')
    || 'Agent';
  const description = subagentStateUpdateString(event, 'description')
    || event.text
    || agentName;
  return {
    type: 'subagent',
    toolCallId,
    subAgentInvocationId,
    agentName,
    description,
    state: normalizeSubagentToolCallState(event.state),
    resultText: subagentStateUpdateString(event, 'resultText')
      || subagentStateUpdateString(event, 'result')
      || '',
    metadata: subagentStateUpdateMetadata(event, agentName, description, subAgentInvocationId),
  };
}

function subagentEndPayload(event: Extract<RenderEvent, { type: 'subagent_end' }>): CanonicalRenderItemStructuredPayload {
  const boundedResult = boundedString(event.resultText, SUBAGENT_RESULT_MAX_CHARS);
  const description = event.agentName || 'Agent';
  const state = normalizeSubagentToolCallState(event.state || 'done');
  const metadata = boundedRecord(subagentMetadata(event, state === 'error' ? 'failed' : 'completed')) ?? {};
  return {
    type: 'subagent',
    toolCallId: event.toolCallId,
    subAgentInvocationId: event.subAgentInvocationId,
    agentName: description,
    description,
    state,
    resultText: boundedResult.text,
    metadata: {
      ...metadata,
      ...(boundedResult.omitted ? {
        resultTextOmitted: true,
        resultTextBytes: event.resultText.length,
      } : {}),
    },
  };
}

function isSubagentStateUpdateEvent(event: Extract<RenderEvent, { type: 'state_update' }>): boolean {
  return typeof event.stateId === 'string' && event.stateId.startsWith('subagent:');
}

function subagentToolCallIdFromStateUpdate(event: Extract<RenderEvent, { type: 'state_update' }>): string {
  return subagentStateUpdateString(event, 'toolCallId')
    || subagentStateUpdateString(event, 'subAgentInvocationId')
    || event.stateId.slice('subagent:'.length)
    || event.stateId;
}

function subagentInvocationIdFromStateUpdate(event: Extract<RenderEvent, { type: 'state_update' }>): string {
  return subagentStateUpdateString(event, 'subAgentInvocationId')
    || subagentToolCallIdFromStateUpdate(event);
}

function subagentStateUpdateString(
  event: Extract<RenderEvent, { type: 'state_update' }>,
  key: string,
): string | undefined {
  const metadata = event.metadata && typeof event.metadata === 'object' && !Array.isArray(event.metadata)
    ? event.metadata as Record<string, unknown>
    : undefined;
  const value = metadata?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function subagentStateUpdateMetadata(
  event: Extract<RenderEvent, { type: 'state_update' }>,
  agentName: string,
  description: string,
  subAgentInvocationId: string,
): Record<string, unknown> | undefined {
  const metadata = event.metadata && typeof event.metadata === 'object' && !Array.isArray(event.metadata)
    ? event.metadata as Record<string, unknown>
    : {};
  const toolSpecificData = metadata['toolSpecificData'] && typeof metadata['toolSpecificData'] === 'object' && !Array.isArray(metadata['toolSpecificData'])
    ? metadata['toolSpecificData'] as Record<string, unknown>
    : {};
  return boundedRecord({
    ...metadata,
    subAgentInvocationId,
    toolSpecificData: {
      ...toolSpecificData,
      kind: 'subagent',
      agentName,
      description,
    },
  });
}

function planPayload(
  itemId: string,
  text: string,
  status: 'streaming' | 'completed' | 'failed',
): CanonicalRenderItemStructuredPayload {
  return {
    type: 'plan',
    partId: `canonical:plan:${itemId}`,
    text,
    status,
    source: 'proposed_plan',
  };
}

function subagentMetadata(
  event: Extract<RenderEvent, { type: 'subagent_begin' | 'subagent_end' }>,
  phase: 'started' | 'completed' | 'failed',
): Record<string, unknown> {
  const explicitDescription = 'description' in event ? event.description : '';
  const description = explicitDescription?.trim() || event.agentName || 'Agent';
  const boundedResult = 'resultText' in event
    ? boundedString(event.resultText, SUBAGENT_RESULT_MAX_CHARS)
    : { text: '', omitted: false };
  return {
    toolName: 'agent',
    phase,
    argsSummary: description,
    recordId: event.toolCallId,
    subAgentInvocationId: event.subAgentInvocationId || event.toolCallId,
    invocationMessage: description,
    pastTenseMessage: description ? `Completed Task: "${description}"` : event.agentName,
    timeline: [boundedRecord({
      recordId: `${event.toolCallId}:${phase}`,
      phase,
      summary: description,
      resultText: boundedResult.text || undefined,
      timestamp: event.timestamp,
    })],
    toolSpecificData: {
      kind: 'subagent',
      description,
      agentName: event.agentName,
      result: boundedResult.text,
    },
  };
}

function questionPayload(event: Extract<RenderEvent, { type: 'question_request' }>): CanonicalRenderItemStructuredPayload {
  return {
    type: 'question',
    requestId: event.requestId,
    questions: event.questions.map(question => ({
      question: question.question,
      options: question.options?.map(option => ({ ...option })),
      allow_freeform: question.allowFreeform,
      multi_select: question.multiSelect,
    })),
  };
}

function confirmationPayload(event: Extract<RenderEvent, { type: 'approval_request' }>): CanonicalRenderItemStructuredPayload {
  return {
    type: 'confirmation',
    askId: event.requestId || event.toolCallId || 'unknown',
    message: event.message || '',
    toolName: event.toolName,
    source: event.source,
    title: event.title,
    subtitle: event.subtitle,
    description: event.description,
    actions: event.actions,
    primaryScope: event.primaryScope,
    args: boundedStructuredValue(event.input),
    toolCallId: event.toolCallId,
  };
}

function confirmationResolvePayload(event: Extract<RenderEvent, { type: 'approval_resolve' }>): CanonicalRenderItemStructuredPayload {
  return {
    type: 'confirmation',
    askId: event.requestId || event.toolCallId || 'unknown',
    message: '',
    toolCallId: event.toolCallId,
    resolved: true,
    result: event.result,
    scope: event.scope,
    selectedActionId: event.selectedActionId,
    selectedActionLabel: event.selectedActionLabel,
  };
}

function autoReviewStartPayload(
  event: Extract<RenderEvent, { type: 'approval_auto_review_start' }>,
  toolCallId: string,
): CanonicalRenderItemStructuredPayload {
  return {
    type: 'confirmation',
    askId: event.reviewId || toolCallId,
    message: event.reason,
    toolName: event.toolName,
    source: event.source,
    title: '自动审查中',
    actions: [],
    primaryScope: 'once',
    toolCallId,
    resolved: false,
    reviewer: 'auto_review',
    reviewStatus: 'reviewing',
    reviewStartedAt: event.timestamp,
  };
}

function autoReviewCompletePayload(
  event: Extract<RenderEvent, { type: 'approval_auto_review_complete' }>,
  toolCallId: string,
): CanonicalRenderItemStructuredPayload {
  const approved = event.status === 'approved';
  const decisionSource = (event as { readonly decisionSource?: string }).decisionSource ?? 'auto_review';
  return {
    type: 'confirmation',
    askId: event.reviewId || toolCallId,
    message: event.rationale,
    toolName: event.toolName,
    source: event.source,
    title: approved ? '自动审查已允许' : event.status === 'timedOut' ? '自动审查超时' : '自动审查已拒绝',
    description: `风险等级：${event.riskLevel}`,
    toolCallId,
    resolved: true,
    result: approved ? 'approved' : 'rejected',
    reviewer: 'auto_review',
    reviewStatus: event.status,
    reviewRiskLevel: event.riskLevel,
    reviewCompletedAt: event.timestamp,
    decisionSource,
  };
}

function terminalPayload(
  event: Extract<RenderEvent, { type: 'tool_call_end' }>,
  terminal: ParsedTerminalPayload,
): CanonicalRenderItemStructuredPayload {
  return {
    type: 'terminal',
    toolCallId: event.toolCallId,
    terminal,
    outputUpdateKind: 'snapshot',
  };
}

function terminalPayloadCompletionStatus(terminal: ParsedTerminalPayload): CanonicalRenderItemStatus {
  if (terminal.status === 'cancelled' || terminal.status === 'killed') {
    return 'cancelled';
  }
  if (terminal.status === 'failed'
    || terminal.status === 'timeout'
    || (typeof terminal.exitCode === 'number' && terminal.exitCode !== 0)) {
    return 'failed';
  }
  return 'completed';
}

function terminalSessionPayloadFromToolResult(
  event: Extract<RenderEvent, { type: 'tool_call_end' }>,
): ParsedTerminalPayload | null {
  if (!isTerminalSessionResultToolName(event.toolName)) {
    return null;
  }

  const input = asRecord((event as { input?: unknown }).input);
  const rawText = collectToolResultText(event.result) || event.resultText || '';
  const { headers, body } = splitTerminalReadResult(rawText);
  const header = (...keys: readonly string[]): string | undefined => {
    for (const key of keys) {
      const value = asString(headers.get(key)) || asString(headers.get(key.toLowerCase()));
      if (value) {
        return value;
      }
    }
    return undefined;
  };
  const processId = asString(input?.['processId'])
    || asString(input?.['outputSessionId'])
    || asString(input?.['terminalId'])
    || asString(input?.['id'])
    || header('processId')
    || header('outputSessionId')
    || header('terminalId')
    || header('id');
  if (!processId) {
    return null;
  }

  const output = body.trimEnd();
  if (!output && headers.size === 0) {
    return null;
  }

  return {
    command: asString(input?.['command']) || header('command') || '',
    output,
    stderr: '',
    isRunning: header('status') === 'running',
    processId,
    outputSessionId: asString(input?.['outputSessionId']) || header('outputSessionId') || processId,
    terminalId: asString(input?.['terminalId']) || header('terminalId'),
    outputFilePath: header('outputFilePath'),
    cwd: asString(input?.['cwd']) || header('cwd'),
    status: header('status'),
    bytesTotal: asNumber(header('bytesTotal')),
  };
}

function isTerminalSessionResultToolName(toolName: string | undefined): boolean {
  return toolName === 'command_read'
    || toolName === 'command_tail'
    || toolName === 'command_status'
    || toolName === 'get_terminal_output'
    || toolName === 'command_exec'
    || toolName === 'run_in_terminal';
}

function splitTerminalReadResult(text: string): { headers: Map<string, string>; body: string } {
  const normalized = text.replace(/\r\n/g, '\n');
  const separatorIndex = normalized.indexOf('\n\n');
  let headerText = separatorIndex >= 0 ? normalized.slice(0, separatorIndex) : '';
  let body = separatorIndex >= 0 ? normalized.slice(separatorIndex + 2) : normalized;
  const headers = new Map<string, string>();

  const parseHeaderLines = (value: string): boolean => {
    const lines = value.split('\n').map(line => line.trim()).filter(Boolean);
    if (lines.length === 0) {
      return false;
    }
    const parsed: [string, string][] = [];
    for (const line of lines) {
      const match = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
      if (!match) {
        return false;
      }
      parsed.push([match[1], match[2]]);
    }
    for (const [key, value] of parsed) {
      headers.set(key, value);
    }
    return true;
  };

  if (separatorIndex < 0 && parseHeaderLines(normalized)) {
    headerText = normalized;
    body = '';
  }

  for (const line of headerText.split('\n')) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (match) {
      headers.set(match[1], match[2]);
    }
  }

  return { headers, body };
}

function terminalPayloadFromToolProgress(
  event: Extract<RenderEvent, { type: 'tool_call_progress' }>,
): Extract<CanonicalRenderItemStructuredPayload, { type: 'terminal' }> | undefined {
  const commandProgress = normalizeCommandProgress(event.data);
  if (!commandProgress) {
    return undefined;
  }

  return {
    type: 'terminal',
    toolCallId: event.toolCallId,
    outputUpdateKind: commandProgress.updateKind,
    terminal: {
      command: commandProgress.command,
      output: commandProgress.stdout,
      stderr: commandProgress.stderr,
      exitCode: commandProgress.exitCode,
      isRunning: commandProgress.running,
      toolCallId: event.toolCallId,
      processId: commandProgress.processId,
      outputSessionId: commandProgress.outputSessionId,
      outputFilePath: commandProgress.outputFilePath,
      cwd: commandProgress.cwd,
      status: commandProgress.status,
      bytesTotal: commandProgress.bytesTotal,
      lastOutputAt: commandProgress.lastOutputAt,
    },
  };
}

function normalizeToolProgress(data: unknown): {
  toolName?: string;
  summary?: string;
  progress?: number;
  detail?: string;
  step?: string;
  statusText?: string;
  kind?: string;
  phase?: string;
  label?: string;
  operationId?: string;
  operationKind?: string;
  queueSize?: number;
  durationMs?: number;
  running?: boolean;
} | null {
  if (typeof data === 'string') {
    const summary = data.trim();
    return summary ? { summary } : null;
  }

  if (typeof data === 'number' && Number.isFinite(data)) {
    return { progress: data, summary: 'Tool still running...' };
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return null;
  }

  const record = data as Record<string, unknown>;
  const summary = firstMeaningfulString(record['summary'], record['message'], record['text'], record['status'], record['detail'], record['step']);
  const label = firstMeaningfulString(record['label']);
  const progress = asNumber(record['progress']) ?? asNumber(record['percentage']);
  const normalized = {
    toolName: firstMeaningfulString(record['toolName']),
    summary: summary ?? label,
    progress,
    detail: firstMeaningfulString(record['detail']),
    step: firstMeaningfulString(record['step']),
    statusText: firstMeaningfulString(record['status'], record['statusText']),
    kind: firstMeaningfulString(record['kind']),
    phase: firstMeaningfulString(record['phase']),
    label,
    operationId: firstMeaningfulString(record['operationId']),
    operationKind: firstMeaningfulString(record['operationKind']),
    queueSize: asNumber(record['queueSize']),
    durationMs: asNumber(record['durationMs']),
    running: typeof record['running'] === 'boolean' ? record['running'] : undefined,
  };

  if (!normalized.summary
    && normalized.progress == null
    && !normalized.detail
    && !normalized.step
    && !normalized.statusText
    && !normalized.phase
    && !normalized.label
    && !normalized.operationId
    && !normalized.operationKind) {
    return null;
  }

  return normalized;
}

function normalizeCommandProgress(data: unknown): {
  command: string;
  stdout: string;
  stderr: string;
  updateKind: 'delta' | 'snapshot';
  running: boolean;
  processId?: string;
  outputSessionId?: string;
  outputFilePath?: string;
  cwd?: string;
  status?: string;
  exitCode?: number;
  bytesTotal?: number;
  lastOutputAt?: string;
} | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return null;
  }

  const record = data as Record<string, unknown>;
  const kind = asString(record['kind']);
  if (kind !== 'command_output' && kind !== 'command_session_update') {
    return null;
  }

  const stream = asString(record['stream']) === 'stderr' ? 'stderr' : 'stdout';
  const text = asString(record['text']) ?? asString(record['detail']) ?? '';
  const status = asString(record['status']);
  const running = typeof record['running'] === 'boolean'
    ? record['running']
    : status === 'running';

  if (kind === 'command_output') {
    return {
      command: asTerminalCommand(record['command']) ?? '',
      stdout: stream === 'stdout' ? text : '',
      stderr: stream === 'stderr' ? text : '',
      updateKind: 'delta',
      running,
      processId: asString(record['processId']),
      outputSessionId: asString(record['outputSessionId']),
      outputFilePath: asString(record['outputFilePath']),
      cwd: asString(record['cwd']),
      status,
      bytesTotal: asNumber(record['bytesTotal']),
      lastOutputAt: normalizeTimestamp(record['lastOutputAt']),
    };
  }

  return {
    command: asTerminalCommand(record['command']) ?? '',
    stdout: typeof record['stdout'] === 'string' ? record['stdout'] : '',
    stderr: typeof record['stderr'] === 'string' ? record['stderr'] : '',
    updateKind: 'snapshot',
    running,
    processId: asString(record['processId']),
    outputSessionId: asString(record['outputSessionId']),
    outputFilePath: asString(record['outputFilePath']),
    cwd: asString(record['cwd']),
    status,
    exitCode: asNumber(record['exitCode']),
    bytesTotal: asNumber(record['bytesTotal']),
    lastOutputAt: normalizeTimestamp(record['lastOutputAt']),
  };
}

function buildToolProgressDetails(input: {
  summary?: string;
  progress?: number;
  detail?: string;
  step?: string;
  statusText?: string;
  kind?: string;
  phase?: string;
  label?: string;
  operationId?: string;
  operationKind?: string;
  queueSize?: number;
  durationMs?: number;
  running?: boolean;
}): Record<string, unknown> | undefined {
  return boundedRecord({
    message: input.summary,
    detail: input.detail,
    step: input.step,
    statusText: input.statusText,
    progress: input.progress,
    kind: input.kind,
    phase: input.phase ? normalizeProgressPhase(input.phase) : undefined,
    label: input.label,
    operationId: input.operationId,
    operationKind: input.operationKind,
    queueSize: input.queueSize,
    durationMs: input.durationMs,
    running: input.running,
  });
}

function resolveProgressToolState(progress: { kind?: string; phase?: string }): ToolCallPart['state'] {
  if (progress.kind !== 'editor_operation') {
    return 'doing';
  }

  switch (normalizeProgressPhase(progress.phase)) {
    case 'completed':
      return 'done';
    case 'failed':
      return 'error';
    case 'cancelled':
      return 'warn';
    default:
      return 'doing';
  }
}

function normalizeProgressPhase(phase?: string): string {
  switch (phase) {
    case 'queued':
    case 'started':
    case 'progress':
    case 'completed':
    case 'failed':
    case 'cancelled':
      return phase;
    default:
      return 'progress';
  }
}

function firstMeaningfulString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const text = asString(value);
    if (text) {
      return text;
    }
  }
  return undefined;
}

function buildPayloadRef(
  payloadRefs: Map<string, string>,
  itemId: string,
  itemKind: CanonicalRenderItemKind,
  text: string | undefined,
): CanonicalRenderItemPayloadRef | undefined {
  if (!text) {
    return undefined;
  }

  const contentKind = itemKind === 'thinking' ? 'thinking' : 'markdown';
  const contentRef = payloadRefs.get(itemId) || createCanonicalPayloadRef(contentKind, itemId);
  payloadRefs.set(itemId, contentRef);

  if (contentKind === 'thinking') {
    const existingLength = getThinkContentLength(contentRef);
    if (existingLength > 0) {
      appendThinkContent(contentRef, text);
    } else {
      storeThinkContent(contentRef, text);
    }
    const contentLength = getThinkContentLength(contentRef);
    return {
      type: 'text',
      contentKind,
      mode: shouldInlinePayload(text, contentLength) ? 'inline' : 'ref',
      contentRef,
      ...(shouldInlinePayload(text, contentLength) ? { text } : {}),
      deltaLength: text.length,
      contentLength,
    };
  }

  const existingLength = getMarkdownContentLength(contentRef);
  if (existingLength > 0) {
    appendMarkdownContent(contentRef, text);
  } else {
    storeMarkdownContent(contentRef, text);
  }
  const contentLength = getMarkdownContentLength(contentRef);
  return {
    type: 'text',
    contentKind,
    mode: shouldInlinePayload(text, contentLength) ? 'inline' : 'ref',
    contentRef,
    ...(shouldInlinePayload(text, contentLength) ? { text } : {}),
    deltaLength: text.length,
    contentLength,
  };
}

function shouldInlinePayload(delta: string, contentLength: number): boolean {
  return delta.length <= INLINE_PAYLOAD_MAX_CHARS
    && contentLength <= INLINE_TOTAL_PAYLOAD_MAX_CHARS;
}

function createCanonicalPayloadRef(contentKind: 'markdown' | 'thinking', itemId: string): string {
  const randomId = Math.random().toString(36).slice(2);
  const safeItemId = itemId.replace(/[^a-zA-Z0-9:_-]/g, '_');
  return `canonical-${contentKind}:${safeItemId}:${Date.now().toString(36)}:${randomId}`;
}

function boundedStructuredValue(value: unknown): unknown {
  if (value == null) {
    return undefined;
  }

  try {
    const text = JSON.stringify(value);
    if (!text || text.length <= STRUCTURED_ARG_MAX_CHARS) {
      return value;
    }
    return {
      omitted: true,
      reason: 'structured_payload_too_large',
      bytes: text.length,
    };
  } catch {
    return {
      omitted: true,
      reason: 'structured_payload_not_serializable',
    };
  }
}

function boundedRecord(value: unknown): Record<string, unknown> | undefined {
  const bounded = boundedStructuredValue(value);
  return bounded && typeof bounded === 'object' && !Array.isArray(bounded)
    ? bounded as Record<string, unknown>
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function boundedString(value: string | undefined, maxChars: number): { text: string; omitted: boolean } {
  const text = value || '';
  if (text.length <= maxChars) {
    return { text, omitted: false };
  }
  return {
    text: text.slice(Math.max(0, text.length - maxChars)),
    omitted: true,
  };
}

function subagentItemId(toolCallId: string, subAgentInvocationId?: string): string {
  return `subagent:${subAgentInvocationId || toolCallId}`;
}

function subagentActivityItemId(event: Extract<RenderEvent, { type: 'subagent_activity' }>): string {
  if (isSubagentToolActivity(event)) {
    return `subagent:${event.subAgentInvocationId || event.toolCallId}:tool:${subagentActivityToolCallId(event)}`;
  }
  return `subagent:${event.subAgentInvocationId || event.toolCallId}:${event.activityKind}`;
}

function isSubagentToolActivity(
  event: Extract<RenderEvent, { type: 'subagent_activity' }>,
): boolean {
  return event.activityKind === 'tool_started'
    || event.activityKind === 'tool_progress'
    || event.activityKind === 'tool_completed'
    || event.activityKind === 'tool_failed';
}

function subagentActivityToolCallId(event: Extract<RenderEvent, { type: 'subagent_activity' }>): string {
  return event.childToolCallId
    || `${event.toolCallId}:legacy:${event.toolName || 'tool'}`;
}

function subagentActivityStructuredPayload(
  event: Extract<RenderEvent, { type: 'subagent_activity' }>,
): CanonicalRenderItemStructuredPayload | undefined {
  if (!isSubagentToolActivity(event)) {
    return undefined;
  }

  const state: ToolCallPart['state'] = event.activityKind === 'tool_failed'
    ? 'error'
    : event.activityKind === 'tool_completed'
      ? 'done'
      : 'doing';
  const phase = event.activityKind === 'tool_started'
    ? 'started'
    : event.activityKind === 'tool_progress'
      ? 'progress'
      : event.activityKind === 'tool_completed'
        ? 'completed'
        : 'failed';

  return {
    type: 'tool',
    toolCallId: subagentActivityToolCallId(event),
    toolName: event.toolName || 'tool',
    text: event.content?.trim() || event.toolName || 'Tool',
    state,
    args: event.argsSummary,
    metadata: boundedRecord({
      toolName: event.toolName,
      argsSummary: event.argsSummary,
      phase,
      durationMs: event.durationMs,
    }),
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function isPlaceholderTerminalCommand(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === 'undefined'
    || normalized === 'null'
    || normalized === 'terminal command';
}

function asTerminalCommand(value: unknown): string | undefined {
  const command = asString(value);
  return command && !isPlaceholderTerminalCommand(command) ? command : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return asString(value);
}
