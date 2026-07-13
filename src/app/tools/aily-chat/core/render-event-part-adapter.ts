/**
 * RenderEventPartAdapter — RenderEvent → ChatPart 薄映射层
 *
 * 消费 aily-lex 的 RenderEvent 流，将每个事件映射为 ChatPartStore 的写操作。
 * 不含状态机逻辑 — 所有状态跟踪（think tag 解析、工具调用生命周期等）
 * 已由 lex 侧的 RenderEventEmitter 处理。
 *
 * 事件流：
 *   AgentHandle.chat() → RenderEvent → RenderEventPartAdapter → ChatPartStore
 *
 * 职责：
 *   - 每种 RenderEvent 精确映射到一个 ChatPartStore 操作
 *   - 维护必要的 UI 上下文（当前消息 handle、活跃的 toolCallId 列表）
 *   - 提供 finalize() + reset() 供 turn 生命周期调用
 */

import type {
  RenderEvent,
  SubagentActivity,
} from 'aily-lex/browser';
import {
  buildConfirmationPartId,
  type ChatPartScope,
  type StatePart,
  type SubagentToolCallSnapshot,
  mkSubagentTimelineEntry,
  normalizeSubagentToolCallState,
  mkTerminal,
  mkToolCall,
  mkState,
  mkError,
  mkQuestion,
  mkConfirmation,
  normalizeChatPartScope,
  withChatPartScopeMetadata,
} from './chat-parts';
import {
  buildPendingToolCallApprovalMetadata,
  buildResolvedToolCallApprovalMetadata,
} from './tool-call-approval';
import { isTerminalSessionToolName, isTodoToolName } from './tool-name-normalizer';
import { parseTerminalPayload } from './terminal-payload';
import { buildToolResultMetadataPatch, collectToolResultText, extractRawToolResultPayloadText } from './tool-result-content';
import {
  type ChatPartStore,
  type ChatPartStoreOpaqueHandle,
  type ToolCallPartPatch,
} from './chat-part-store';
import { ChatPerformanceTracer } from '../services/chat-perf-tracer';
import { normalizeChatErrorNotice } from './chat-error-notice-normalizer';

export type RenderEventPartStoreAccess = Pick<
  ChatPartStore,
  | 'appendToMarkdownHandle'
  | 'appendToPlanHandle'
  | 'completePlanHandle'
  | 'appendToThinkingHandle'
  | 'completeThinkingHandle'
  | 'addPartToHandle'
  | 'getPartsForHandle'
  | 'updateToolCallForHandle'
  | 'patchToolCallForHandle'
  | 'upsertStateForHandle'
  | 'upsertSubagentForHandle'
  | 'updateConfirmationResultForHandle'
  | 'updateSubagentForHandle'
  | 'finalizeSubagentScopedPartsForHandle'
  | 'upsertTerminalForHandle'
>;

function hasUsableStoreHandle(
  handle: ({ storeKey?: object | symbol | string; message?: unknown; msgIndex?: unknown } & object) | null,
): boolean {
  if (!handle) {
    return false;
  }

  if (
    typeof handle.storeKey === 'object'
    || typeof handle.storeKey === 'symbol'
    || (typeof handle.storeKey === 'string' && handle.storeKey.trim().length > 0)
  ) {
    return true;
  }

  if (typeof handle.msgIndex === 'number' && handle.msgIndex >= 0) {
    return true;
  }

  return !!handle.message && typeof handle.message === 'object';
}

function eventScope(event: RenderEvent): ChatPartScope | undefined {
  return normalizeChatPartScope(event as unknown as ChatPartScope);
}

function eventStringProp(event: RenderEvent, key: string): string | undefined {
  const value = (event as unknown as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function eventTextSize(event: RenderEvent): number {
  const text = (event as unknown as { readonly text?: unknown }).text;
  return typeof text === 'string' ? text.length : 0;
}

function isScopedSubagentRenderEvent(event: RenderEvent): boolean {
  const scope = eventScope(event);
  return scope?.sourceAgentRole === 'subagent' || !!scope?.subAgentInvocationId;
}

function scopedSubagentRenderEventDetail(
  event: RenderEvent,
  action: string,
  wrote: boolean,
): string {
  const scope = eventScope(event);
  const type = typeof event.type === 'string' ? event.type : 'unknown';
  const toolCallId = eventStringProp(event, 'toolCallId');
  const toolName = eventStringProp(event, 'toolName');
  const subAgentInvocationId = scope?.subAgentInvocationId || eventStringProp(event, 'subAgentInvocationId');
  const pieces = [
    `type=${type}`,
    `action=${action}`,
    `wrote=${wrote}`,
    subAgentInvocationId ? `subAgent=${subAgentInvocationId}` : '',
    toolCallId ? `toolCallId=${toolCallId}` : '',
    toolName ? `tool=${toolName}` : '',
  ].filter(Boolean);
  const textSize = eventTextSize(event);
  if (textSize > 0) {
    pieces.push(`text=${textSize}`);
  }
  return pieces.join(',');
}

function recordScopedSubagentRenderEvent(
  event: RenderEvent,
  durationMs: number,
  wrote: boolean,
  action: string,
): void {
  if (!ChatPerformanceTracer.isEnabled()) {
    return;
  }
  if (!isScopedSubagentRenderEvent(event)) {
    return;
  }

  const type = typeof event.type === 'string' ? event.type : 'unknown';
  ChatPerformanceTracer.increment(`render_event.scoped_subagent.${type}.count`);
  if (!wrote) {
    ChatPerformanceTracer.increment(`render_event.scoped_subagent.${type}.ignored`);
  }
  ChatPerformanceTracer.recordDuration(
    'render_event.scoped_subagent_write',
    durationMs,
    scopedSubagentRenderEventDetail(event, action, wrote),
    { slowThresholdMs: 4 },
  );
}

function recordScopedSubagentToolHandleMiss(event: RenderEvent, action: string): void {
  if (!ChatPerformanceTracer.isEnabled()) {
    return;
  }
  if (!isScopedSubagentRenderEvent(event)) {
    return;
  }
  ChatPerformanceTracer.increment('render_event.scoped_subagent_tool_handle_miss');
  ChatPerformanceTracer.mark('scoped_subagent_tool_handle_miss', scopedSubagentRenderEventDetail(event, action, false));
}

const PROPOSED_PLAN_OPEN_TAG = '<proposed_plan>';
const PROPOSED_PLAN_CLOSE_TAG = '</proposed_plan>';

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class RenderEventPartAdapter {
  private readonly _store: RenderEventPartStoreAccess;
  private _planStreamState: 'markdown' | 'plan' = 'markdown';
  private _planStreamBuffer = '';
  private readonly _toolOriginHandles = new Map<string, ChatPartStoreOpaqueHandle>();
  private readonly _toolInputs = new Map<string, unknown>();

  constructor(store: RenderEventPartStoreAccess) {
    this._store = store;
  }

  /**
   * Process a single RenderEvent and apply the corresponding ChatPartStore mutation.
   *
   * Returns true if the event resulted in a store write, false if ignored.
   */
  process(event: RenderEvent, handle: ChatPartStoreOpaqueHandle | null): boolean {
    const traceEnabled = ChatPerformanceTracer.isEnabled();
    const startedAt = traceEnabled ? performance.now() : 0;
    const finish = (wrote: boolean, action: string = event.type): boolean => {
      if (traceEnabled) {
        recordScopedSubagentRenderEvent(event, performance.now() - startedAt, wrote, action);
      }
      return wrote;
    };

    if (!hasUsableStoreHandle(handle)) return finish(false, 'no_message_handle');

    switch (event.type) {
      // ---- Text ----
      case 'markdown_delta':
        this._processMarkdownDelta(handle, event.text, eventScope(event));
        return finish(true);

      case 'thinking_delta':
        this._store.appendToThinkingHandle(handle, event.text, eventScope(event));
        return finish(true);

      case 'thinking_complete':
        this._store.completeThinkingHandle(handle, eventScope(event));
        return finish(true);

      // ---- Tool Call ----
      case 'tool_call_begin':
        if (this._isTerminalSessionToolCoveredByTerminal(handle, event)) {
          this._rememberToolOrigin(event.toolCallId, handle, eventScope(event));
          this._rememberToolInput(event.toolCallId, event.input, eventScope(event));
          return finish(false, 'terminal_tool_call_begin_covered');
        }
        this._rememberToolOrigin(event.toolCallId, handle, eventScope(event));
        this._rememberToolInput(event.toolCallId, event.input, eventScope(event));
        this._store.addPartToHandle(handle, mkToolCall(
          event.toolCallId,
          event.toolName,
          `${event.toolName}…`,
          'doing',
          event.input,
          undefined,
          eventScope(event),
        ));
        return finish(true);

      case 'tool_call_progress':
        return finish(this._applyToolCallProgress(handle, event));

      case 'tool_call_end': {
        const scope = eventScope(event);
        if (this._appendTerminalPart(handle, event)) {
          return finish(true, 'terminal_tool_call_end');
        }
        const toolHandle = this._findToolCallHandle(event.toolCallId, handle, scope);
        if (!this._hasExactToolCallHandle(event.toolCallId, handle, scope)) {
          recordScopedSubagentToolHandleMiss(event, 'tool_call_end');
        }
        this._store.patchToolCallForHandle(
          toolHandle,
          event.toolCallId,
          {
            state: event.state === 'error' ? 'error' : 'done',
            text: event.resultText,
            metadata: withChatPartScopeMetadata(buildToolResultMetadataPatch({
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              state: event.state === 'error' ? 'error' : 'done',
              resultText: event.resultText,
              result: event.result,
              timestamp: event.timestamp,
              durationMs: event.durationMs,
            }), scope),
          },
        );
        return finish(true);
      }

      // ---- State ----
      case 'state_update': {
        const subagentSnapshot = subagentStateUpdateToSnapshot(event);
        if (subagentSnapshot) {
          this._store.upsertSubagentForHandle(handle, subagentSnapshot);
          return true;
        }
        this._upsertState(handle, event.stateId, {
          state: event.state,
          text: event.text,
          progress: event.progress,
          kind: event.kind,
          metadata: event.metadata,
        });
        return true;
      }

      case 'background_task_update':
        this._upsertState(handle, event.stateId, {
          state: event.state,
          text: event.description,
          progress: event.progress,
          kind: 'background_task',
          metadata: {
            taskId: event.taskId,
            agentName: event.agentName,
            summary: event.summary,
            activity: event.activity,
          },
        });
        return true;

      case 'todo_update':
        const todoItems = normalizeTodoItems(event.items);
        const todoMetadata = buildTodoStateMetadata(
          event.sessionId,
          event.summary,
          todoItems,
          this.getExistingStateMetadata(handle, `todo-${event.sessionId}`),
        );
        this._upsertState(handle, `todo-${event.sessionId}`, {
          state: resolveTodoState(todoItems),
          text: event.summary,
          kind: 'todo',
          metadata: todoMetadata,
        });
        this.patchLatestTodoToolCall(handle, todoMetadata);
        return true;

      // ---- Interaction ----
      case 'question_request':
        this._store.addPartToHandle(handle, questionRequestToPart(event));
        return true;

      case 'approval_request':
        if (isToolExecutionApprovalEvent(event)) {
          this._rememberToolInput(event.toolCallId, event.input, eventScope(event));
          this._store.patchToolCallForHandle(
            this._findToolCallHandle(event.toolCallId, handle, eventScope(event)),
            event.toolCallId,
            approvalRequestToToolCallPatch(event),
          );
        } else {
          this._store.addPartToHandle(handle, confirmationRequestToPart(event));
        }
        return true;

      case 'approval_auto_review_start':
        if (typeof event.toolCallId === 'string' && event.toolCallId.trim().length > 0) {
          const toolCallId = event.toolCallId;
          this._store.patchToolCallForHandle(
            this._findToolCallHandle(toolCallId, handle, eventScope(event)),
            toolCallId,
            approvalAutoReviewStartToToolCallPatch({ ...event, toolCallId }),
          );
          return true;
        }
        return false;

      case 'approval_auto_review_complete':
        if (typeof event.toolCallId === 'string' && event.toolCallId.trim().length > 0) {
          const toolCallId = event.toolCallId;
          this._store.patchToolCallForHandle(
            this._findToolCallHandle(toolCallId, handle, eventScope(event)),
            toolCallId,
            approvalAutoReviewCompleteToToolCallPatch({ ...event, toolCallId }),
          );
          return true;
        }
        return false;

      case 'approval_resolve':
        if (isToolExecutionApprovalEvent(event)) {
          this._store.patchToolCallForHandle(
            this._findToolCallHandle(event.toolCallId, handle, eventScope(event)),
            event.toolCallId,
            approvalResolveToToolCallPatch(event),
          );
        } else {
          this._store.updateConfirmationResultForHandle(handle, buildConfirmationPartId(getStandaloneApprovalRequestId(event)), {
            resolved: true,
            result: event.result,
            scope: event.scope,
          });
        }
        return true;

      // ---- Info / Warning / Error ----
      case 'info_notice':
        this._store.addPartToHandle(handle, infoNoticeToPart(event));
        return true;

      case 'warning_notice':
        this._store.addPartToHandle(handle, warningNoticeToPart(event));
        return true;

      case 'error_notice':
        this._store.addPartToHandle(handle, errorNoticeToPart(event));
        return true;

      // ---- Sub-agent ----
      case 'subagent_begin': {
        this._rememberToolOrigin(event.toolCallId, handle);
        this._store.upsertSubagentForHandle(handle, subagentBeginToSnapshot(event));
        return finish(true);
      }

      case 'subagent_activity':
        return finish(this._processLegacySubagentActivity(handle, event), 'subagent_activity_first_class');

      case 'subagent_end': {
        const toolHandle = this._findToolCallHandle(event.toolCallId, handle);
        if (!this._hasExactToolCallHandle(event.toolCallId, handle)) {
          recordScopedSubagentToolHandleMiss(event, 'subagent_end');
        }
        const state = normalizeSubagentToolCallState(event.state || 'done');
        this._store.updateSubagentForHandle(
          toolHandle,
          event.toolCallId,
          state,
          event.resultText,
        );
        this._store.finalizeSubagentScopedPartsForHandle(toolHandle, {
          subAgentInvocationId: event.subAgentInvocationId,
          parentToolCallId: event.toolCallId,
          toolCallId: event.toolCallId,
        }, { status: state === 'error' ? 'error' : 'completed' });
        return finish(true);
      }

      // ---- Turn lifecycle (non-Part) ----
      case 'turn_begin':
      case 'response_complete':
      case 'turn_end':
      case 'session_meta':
        // These are lifecycle signals, not rendered as Parts.
        // The caller (bridge) may use them for message lifecycle management.
        return finish(false);

      default:
        return finish(false);
    }
  }

  /** Reset per-turn state. Call at the start of each new turn. */
  reset(): void {
    this._planStreamState = 'markdown';
    this._planStreamBuffer = '';
    this._toolOriginHandles.clear();
    this._toolInputs.clear();
  }

  finalize(handle: ChatPartStoreOpaqueHandle | null): void {
    if (!hasUsableStoreHandle(handle)) {
      this.reset();
      return;
    }

    if (this._planStreamBuffer) {
      if (this._planStreamState === 'plan') {
        this._store.appendToPlanHandle(handle, this._planStreamBuffer);
      } else {
        this._store.appendToMarkdownHandle(handle, this._planStreamBuffer);
      }
    }

    if (this._planStreamState === 'plan') {
      this._store.completePlanHandle(handle);
    }

    this.reset();
  }

  /** Clean up. */
  dispose(): void {
    // no-op
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Upsert a StatePart: if stateId already exists in this message, update it;
   * otherwise add a new one.
   */
  private _upsertState(
    handle: ChatPartStoreOpaqueHandle,
    stateId: string,
    next: {
      state: StatePart['state'];
      text: string;
      progress?: number;
      kind?: StatePart['kind'];
      metadata?: Record<string, unknown>;
    },
  ): void {
    this._store.upsertStateForHandle(handle, stateId, next);
  }

  private _processLegacySubagentActivity(
    handle: ChatPartStoreOpaqueHandle,
    event: SubagentActivity,
  ): boolean {
    const parentHandle = this._ensureSubagentParentForActivity(handle, event);
    const scope = subagentActivityScope(event);
    switch (event.activityKind) {
      case 'thinking':
        this._store.appendToThinkingHandle(parentHandle, event.content ?? '', scope);
        return true;

      case 'text':
        this._store.completeThinkingHandle(parentHandle, scope);
        this._store.appendToMarkdownHandle(parentHandle, event.content ?? '', scope);
        return true;

      case 'tool_started': {
        this._store.completeThinkingHandle(parentHandle, scope);
        const toolCallId = subagentActivityToolCallId(event);
        this._rememberToolOrigin(toolCallId, parentHandle, scope);
        this._store.addPartToHandle(parentHandle, mkToolCall(
          toolCallId,
          event.toolName || 'tool',
          subagentActivityToolText(event, event.toolName || 'Tool'),
          'doing',
          event.argsSummary,
          withChatPartScopeMetadata({
            toolName: event.toolName,
            argsSummary: event.argsSummary,
            phase: 'started',
            durationMs: event.durationMs,
          }, scope),
          scope,
        ));
        return true;
      }

      case 'tool_progress':
        return this._upsertLegacySubagentToolActivity(parentHandle, event, 'doing', scope);

      case 'tool_completed':
        return this._upsertLegacySubagentToolActivity(parentHandle, event, 'done', scope);

      case 'tool_failed':
        return this._upsertLegacySubagentToolActivity(parentHandle, event, 'error', scope);

      default:
        return false;
    }
  }

  private _upsertLegacySubagentToolActivity(
    handle: ChatPartStoreOpaqueHandle,
    event: SubagentActivity,
    state: 'doing' | 'done' | 'error',
    scope: ChatPartScope,
  ): boolean {
    this._store.completeThinkingHandle(handle, scope);
    const toolCallId = subagentActivityToolCallId(event);
    const toolHandle = this._findToolCallHandle(toolCallId, handle, scope);
    const text = subagentActivityToolText(event, event.toolName || 'Tool');
    const metadata = withChatPartScopeMetadata({
      toolName: event.toolName,
      argsSummary: event.argsSummary,
      phase: state === 'doing' ? 'progress' : state === 'done' ? 'completed' : 'failed',
      durationMs: event.durationMs,
    }, scope);

    if (!toolHandle) {
      this._rememberToolOrigin(toolCallId, handle, scope);
      this._store.addPartToHandle(handle, mkToolCall(
        toolCallId,
        event.toolName || 'tool',
        text,
        state,
        event.argsSummary,
        metadata,
        scope,
      ));
      return true;
    }

    this._store.patchToolCallForHandle(toolHandle, toolCallId, {
      state,
      text,
      metadata,
    });
    return true;
  }

  private _applyToolCallProgress(
    fallbackHandle: ChatPartStoreOpaqueHandle,
    event: Extract<RenderEvent, { type: 'tool_call_progress' }>,
  ): boolean {
    const scope = eventScope(event);
    const toolHandle = this._findToolCallHandle(event.toolCallId, fallbackHandle, scope);
    const commandOutput = normalizeCommandOutputProgress(event.data);
    if (commandOutput) {
      const terminal = commandTerminalUpdateToPart(
        this._withInheritedTerminalCommand(commandOutput, event.toolCallId, toolHandle, scope),
        event.toolCallId,
        true,
      );
      if (scope) {
        Object.assign(terminal, scope);
      }
      this._store.upsertTerminalForHandle(toolHandle ?? fallbackHandle, terminal);
      return true;
    }

    const commandSession = normalizeCommandSessionUpdate(event.data);
    if (commandSession) {
      const terminal = commandTerminalUpdateToPart(
        this._withInheritedTerminalCommand(commandSession, event.toolCallId, toolHandle, scope),
        event.toolCallId,
        false,
      );
      if (scope) {
        Object.assign(terminal, scope);
      }
      this._store.upsertTerminalForHandle(toolHandle ?? fallbackHandle, terminal);
      return true;
    }

    if (!this._hasExactToolCallHandle(event.toolCallId, fallbackHandle, scope)) {
      recordScopedSubagentToolHandleMiss(event, 'tool_call_progress');
    }
    if (!toolHandle) {
      return false;
    }

    const toolPart = this._findToolCallPart(toolHandle, event.toolCallId);
    const progressUpdate = normalizeToolCallProgressUpdate(event.data, toolPart?.toolName);
    if (!progressUpdate) {
      return false;
    }

    const nextMetadata = withChatPartScopeMetadata(buildToolCallProgressMetadataPatch({
      toolCallId: event.toolCallId,
      toolName: toolPart?.toolName,
      timestamp: event.timestamp,
      summary: progressUpdate.summary,
      progress: progressUpdate.progress,
      detail: progressUpdate.detail,
      step: progressUpdate.step,
      statusText: progressUpdate.statusText,
      kind: progressUpdate.kind,
      phase: progressUpdate.phase,
      label: progressUpdate.label,
      operationId: progressUpdate.operationId,
      operationKind: progressUpdate.operationKind,
      queueSize: progressUpdate.queueSize,
      durationMs: progressUpdate.durationMs,
      running: progressUpdate.running,
      existingMetadata: toolPart?.metadata,
    }), scope);

    this._store.patchToolCallForHandle(toolHandle, event.toolCallId, {
      state: resolveProgressToolCallState(progressUpdate),
      ...(progressUpdate.summary ? { text: progressUpdate.summary } : {}),
      metadata: nextMetadata,
    });
    return true;
  }

  private _findToolCallPart(
    handle: ChatPartStoreOpaqueHandle,
    toolCallId: string,
  ): Extract<ReturnType<RenderEventPartStoreAccess['getPartsForHandle']>[number], { type: 'tool_call' }> | undefined {
    return this._store.getPartsForHandle(handle).find(
      (part): part is Extract<ReturnType<RenderEventPartStoreAccess['getPartsForHandle']>[number], { type: 'tool_call' }> =>
        part.type === 'tool_call' && part.toolCallId === toolCallId,
    );
  }

  private _hasToolInvocationPart(
    handle: ChatPartStoreOpaqueHandle,
    toolCallId: string,
  ): boolean {
    return this._store.getPartsForHandle(handle).some(part => {
      if (part.type === 'tool_call') {
        return part.toolCallId === toolCallId;
      }
      if (part.type === 'terminal') {
        return part.toolCallId === toolCallId || part.sourceToolCallIds?.includes(toolCallId) === true;
      }
      return false;
    });
  }

  private _ensureSubagentParentForActivity(
    handle: ChatPartStoreOpaqueHandle,
    event: SubagentActivity,
  ): ChatPartStoreOpaqueHandle {
    const existingHandle = this._findToolCallHandle(event.toolCallId, handle);
    if (existingHandle) {
      return existingHandle;
    }

    this._store.upsertSubagentForHandle(handle, subagentActivityParentSnapshot(event));
    this._rememberToolOrigin(event.toolCallId, handle);
    return handle;
  }

  private _findToolCallHandle(
    toolCallId: string,
    fallbackHandle: ChatPartStoreOpaqueHandle | null,
    scope?: ChatPartScope,
  ): ChatPartStoreOpaqueHandle | null {
    const originHandle = this._toolOriginHandles.get(this._toolOriginKey(toolCallId, scope))
      ?? this._toolOriginHandles.get(this._toolOriginKey(toolCallId));
    if (originHandle && this._hasToolInvocationPart(originHandle, toolCallId)) {
      return originHandle;
    }

    if (!fallbackHandle) {
      return null;
    }

    return this._hasToolInvocationPart(fallbackHandle, toolCallId) ? fallbackHandle : null;
  }

  private _hasExactToolCallHandle(toolCallId: string, handle: ChatPartStoreOpaqueHandle | null, scope?: ChatPartScope): boolean {
    return !!this._findToolCallHandle(toolCallId, handle, scope);
  }

  private _rememberToolOrigin(toolCallId: string, handle: ChatPartStoreOpaqueHandle, scope?: ChatPartScope): void {
    this._toolOriginHandles.set(this._toolOriginKey(toolCallId, scope), handle);
  }

  private _rememberToolInput(toolCallId: string, input: unknown, scope?: ChatPartScope): void {
    this._toolInputs.set(this._toolOriginKey(toolCallId, scope), input);
    this._toolInputs.set(this._toolOriginKey(toolCallId), input);
  }

  private _readToolInput(toolCallId: string, scope?: ChatPartScope): unknown {
    return this._toolInputs.get(this._toolOriginKey(toolCallId, scope))
      ?? this._toolInputs.get(this._toolOriginKey(toolCallId));
  }

  private _withInheritedTerminalCommand<T extends { command: string }>(
    update: T,
    toolCallId: string,
    toolHandle: ChatPartStoreOpaqueHandle | null,
    scope?: ChatPartScope,
  ): T {
    if (asTerminalCommand(update.command)) {
      return update;
    }

    const storedInput = asRecord(this._readToolInput(toolCallId, scope));
    const toolPartInput = toolHandle
      ? asRecord(this._findToolCallPart(toolHandle, toolCallId)?.args)
      : undefined;
    const command = asTerminalCommand(storedInput?.['command'])
      ?? asTerminalCommand(storedInput?.['cmd'])
      ?? asTerminalCommand(toolPartInput?.['command'])
      ?? asTerminalCommand(toolPartInput?.['cmd']);

    return command ? { ...update, command } : update;
  }

  private _toolOriginKey(toolCallId: string, scope?: ChatPartScope): string {
    const normalizedScope = normalizeChatPartScope(scope);
    return [
      normalizedScope?.sourceAgentRole ?? '',
      normalizedScope?.subAgentInvocationId ?? '',
      normalizedScope?.parentToolCallId ?? '',
      toolCallId,
    ].join('\u001f');
  }

  private getExistingStateMetadata(
    handle: ChatPartStoreOpaqueHandle,
    stateId: string,
  ): Record<string, unknown> | undefined {
    const part = this._store.getPartsForHandle(handle).find(
      (candidate): candidate is StatePart => candidate.type === 'state' && candidate.stateId === stateId,
    );

    return asRecord(part?.metadata);
  }

  private patchLatestTodoToolCall(
    handle: ChatPartStoreOpaqueHandle,
    todoMetadata: Record<string, unknown>,
  ): void {
    const parts = this._store.getPartsForHandle(handle);
    for (let index = parts.length - 1; index >= 0; index -= 1) {
      const part = parts[index];
      if (part.type !== 'tool_call' || !isTodoToolName(part.toolName)) {
        continue;
      }

      this._store.patchToolCallForHandle(handle, part.toolCallId, {
        metadata: {
          toolSpecificData: buildTodoToolSpecificData(todoMetadata),
        },
      });
      return;
    }
  }

  private _appendTerminalPart(handle: ChatPartStoreOpaqueHandle, event: Extract<RenderEvent, { type: 'tool_call_end' }>): boolean {
    if (!isTerminalSessionToolName(event.toolName)) {
      return false;
    }

    const terminal = extractTerminalPart(event.toolCallId, event.result)
      ?? extractTerminalReadPart(event);
    if (!terminal) {
      return false;
    }

    const scope = eventScope(event);
    if (scope) {
      Object.assign(terminal, scope);
    }

    const toolHandle = this._findToolCallHandle(event.toolCallId, handle, eventScope(event));
    Object.assign(terminal, this._withInheritedTerminalCommand(terminal, event.toolCallId, toolHandle, scope));
    this._store.upsertTerminalForHandle(toolHandle ?? handle, terminal);
    return true;
  }

  private _isTerminalSessionToolCoveredByTerminal(
    handle: ChatPartStoreOpaqueHandle,
    event: Extract<RenderEvent, { type: 'tool_call_begin' }>,
  ): boolean {
    if (!isTerminalSessionToolName(event.toolName)) {
      return false;
    }

    const input = asRecord(event.input);
    const sessionIds = [
      input?.['processId'],
      input?.['outputSessionId'],
      input?.['terminalId'],
      input?.['id'],
    ].map(value => asString(value)).filter((value): value is string => !!value);
    if (sessionIds.length === 0) {
      return false;
    }

    return this._store.getPartsForHandle(handle).some(part => {
      if (part.type !== 'terminal') {
        return false;
      }
      return [
        part.processId,
        part.outputSessionId,
        part.terminalId,
      ].some(value => {
        const normalized = asString(value);
        return !!normalized && sessionIds.includes(normalized);
      });
    });
  }

  private _processMarkdownDelta(handle: ChatPartStoreOpaqueHandle, text: string, scope?: ChatPartScope): void {
    const normalizedScope = normalizeChatPartScope(scope);
    if (normalizedScope?.sourceAgentRole === 'subagent' || normalizedScope?.subAgentInvocationId) {
      this._store.appendToMarkdownHandle(handle, text, normalizedScope);
      return;
    }

    this._planStreamBuffer += text;

    while (this._planStreamBuffer.length > 0) {
      if (this._planStreamState === 'markdown') {
        const openIndex = indexOfCaseInsensitive(this._planStreamBuffer, PROPOSED_PLAN_OPEN_TAG);
        if (openIndex >= 0) {
          const before = this._planStreamBuffer.slice(0, openIndex);
          if (before) {
            this._store.appendToMarkdownHandle(handle, before);
          }
          this._planStreamBuffer = this._planStreamBuffer.slice(openIndex + PROPOSED_PLAN_OPEN_TAG.length);
          this._planStreamState = 'plan';
          continue;
        }

        const keep = longestSuffixPrefixLength(this._planStreamBuffer, PROPOSED_PLAN_OPEN_TAG);
        const safeLength = this._planStreamBuffer.length - keep;
        if (safeLength <= 0) {
          return;
        }

        this._store.appendToMarkdownHandle(handle, this._planStreamBuffer.slice(0, safeLength));
        this._planStreamBuffer = this._planStreamBuffer.slice(safeLength);
        return;
      }

      const closeIndex = indexOfCaseInsensitive(this._planStreamBuffer, PROPOSED_PLAN_CLOSE_TAG);
      if (closeIndex >= 0) {
        const planDelta = this._planStreamBuffer.slice(0, closeIndex);
        if (planDelta) {
          this._store.appendToPlanHandle(handle, planDelta);
        }
        this._store.completePlanHandle(handle);
        this._planStreamBuffer = this._planStreamBuffer.slice(closeIndex + PROPOSED_PLAN_CLOSE_TAG.length);
        this._planStreamState = 'markdown';
        continue;
      }

      const keep = longestSuffixPrefixLength(this._planStreamBuffer, PROPOSED_PLAN_CLOSE_TAG);
      const safeLength = this._planStreamBuffer.length - keep;
      if (safeLength <= 0) {
        return;
      }

      this._store.appendToPlanHandle(handle, this._planStreamBuffer.slice(0, safeLength));
      this._planStreamBuffer = this._planStreamBuffer.slice(safeLength);
      return;
    }
  }
}

function buildTodoStateMetadata(
  sessionId: string,
  summary: string,
  items: readonly { id: number; title: string; status: string }[],
  previousMetadata?: Record<string, unknown>,
): Record<string, unknown> {
  const normalizedItems = items.map(item => ({
    id: item.id,
    title: item.title,
    status: item.status,
  }));
  const completedCount = normalizedItems.filter(item => item.status === 'completed').length;
  const totalCount = normalizedItems.length;
  const activeTodo = normalizedItems.find(item => item.status === 'in-progress')
    ?? normalizedItems.find(item => item.status === 'not-started');
  const currentStep = totalCount > 0
    ? Math.min(totalCount, activeTodo ? completedCount + 1 : totalCount)
    : 0;
  const state = resolveTodoState(items);
  const signature = buildTodoSignature(normalizedItems);
  const previousTimeline = asRecordArray(previousMetadata?.['timeline']);
  const previousSnapshot = previousTimeline.at(-1);
  const phase = classifyTodoPhase(previousSnapshot, normalizedItems, {
    summary,
    state,
    totalCount,
    completedCount,
    currentStep,
    activeTitle: activeTodo?.title,
  });
  const snapshot: Record<string, unknown> = {
    recordId: asString(previousSnapshot?.['recordId']) && asString(previousSnapshot?.['signature']) === signature
      ? asString(previousSnapshot?.['recordId'])
      : `todo:${sessionId}:${previousTimeline.length + 1}`,
    signature,
    summary,
    state,
    totalCount,
    completedCount,
    currentStep,
    activeTitle: activeTodo?.title,
    phaseKind: phase.kind,
    phaseLabel: phase.label,
    phaseDetail: phase.detail,
    items: normalizedItems,
  };

  const timeline = previousTimeline.length === 0
    ? [snapshot]
    : asString(previousSnapshot?.['signature']) === signature
      ? [...previousTimeline.slice(0, -1), snapshot]
      : [...previousTimeline, snapshot].slice(-8);

  return {
    items: normalizedItems,
    summary,
    state,
    totalCount,
    completedCount,
    currentStep,
    activeTitle: activeTodo?.title,
    signature,
    timeline,
  };
}

function normalizeTodoItems(value: unknown): Array<{ id: number; title: string; status: string }> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry, index) => {
      const record = asRecord(entry);
      if (!record) {
        return undefined;
      }
      const id = asNumber(record['id']) ?? index + 1;
      const title = asString(record['title']) || asString(record['content']) || `Todo ${id}`;
      const status = asString(record['status']) || 'not-started';
      return { id, title, status };
    })
    .filter((entry): entry is { id: number; title: string; status: string } => !!entry);
}

function classifyTodoPhase(
  previousSnapshot: Record<string, unknown> | undefined,
  items: readonly { id: number; title: string; status: string }[],
  next: {
    summary: string;
    state: StatePart['state'];
    totalCount: number;
    completedCount: number;
    currentStep: number;
    activeTitle?: string;
  },
): { kind: string; label: string; detail?: string } {
  const previousItems = asRecordArray(previousSnapshot?.['items']).map(item => ({
    id: Number(item['id']),
    title: asString(item['title']) || '',
    status: asString(item['status']) || 'not-started',
  }));
  const previousActiveTitle = asString(previousSnapshot?.['activeTitle']);
  const previousCompletedCount = asNumber(previousSnapshot?.['completedCount']) ?? 0;
  const previousTotalCount = asNumber(previousSnapshot?.['totalCount']) ?? 0;

  if (!previousSnapshot) {
    if (next.totalCount === 0) {
      return { kind: 'empty', label: 'Todo 列表为空' };
    }

    if (next.activeTitle) {
      return { kind: 'start', label: `开始 ${next.activeTitle}`, detail: formatTodoProgress(next.currentStep, next.totalCount) };
    }

    return { kind: 'snapshot', label: '建立 Todo 计划', detail: formatTodoProgress(next.currentStep, next.totalCount) };
  }

  if (next.totalCount === 0 && previousTotalCount > 0) {
    return { kind: 'cleared', label: '清空 Todo 列表' };
  }

  if (next.totalCount > 0 && next.completedCount === next.totalCount) {
    if (previousActiveTitle) {
      return { kind: 'complete-all', label: `完成 ${previousActiveTitle}`, detail: '全部完成' };
    }

    return { kind: 'complete-all', label: '完成全部任务', detail: formatTodoProgress(next.totalCount, next.totalCount) };
  }

  if (next.completedCount > previousCompletedCount && previousActiveTitle) {
    return next.activeTitle && next.activeTitle !== previousActiveTitle
      ? {
          kind: 'advance',
          label: `完成 ${previousActiveTitle}`,
          detail: `切换到 ${next.activeTitle}`,
        }
      : {
          kind: 'complete',
          label: `完成 ${previousActiveTitle}`,
          detail: formatTodoProgress(next.currentStep, next.totalCount),
        };
  }

  if (next.activeTitle && next.activeTitle !== previousActiveTitle) {
    return {
      kind: 'switch',
      label: `切换到 ${next.activeTitle}`,
      detail: formatTodoProgress(next.currentStep, next.totalCount),
    };
  }

  if (next.totalCount !== previousTotalCount) {
    return {
      kind: 'reshape',
      label: next.totalCount > previousTotalCount ? '扩展 Todo 计划' : '收缩 Todo 计划',
      detail: formatTodoProgress(next.currentStep, next.totalCount),
    };
  }

  const changedTitles = items.filter(item => {
    const previous = previousItems.find(candidate => candidate.id === item.id);
    return !!previous && previous.title !== item.title;
  });
  if (changedTitles.length > 0) {
    return {
      kind: 'rename',
      label: `更新 ${changedTitles[0].title}`,
      detail: formatTodoProgress(next.currentStep, next.totalCount),
    };
  }

  return {
    kind: 'sync',
    label: next.activeTitle ? `同步 ${next.activeTitle}` : '同步 Todo 列表',
    detail: formatTodoProgress(next.currentStep, next.totalCount),
  };
}

function formatTodoProgress(currentStep: number, totalCount: number): string | undefined {
  return totalCount > 0 ? `${Math.max(0, currentStep)}/${totalCount}` : undefined;
}

function buildTodoToolSpecificData(todoMetadata: Record<string, unknown>): Record<string, unknown> {
  const items = asRecordArray(todoMetadata['items']);
  return {
    kind: 'todoList',
    todoList: items.map(item => ({
      id: String(item['id'] ?? ''),
      title: asString(item['title']) || 'Todo',
      status: asString(item['status']) || 'not-started',
    })),
    summary: asString(todoMetadata['summary']) || '',
    currentTask: asString(todoMetadata['activeTitle']) || undefined,
    totalCount: asNumber(todoMetadata['totalCount']) ?? items.length,
    completedCount: asNumber(todoMetadata['completedCount']) ?? 0,
    currentStep: asNumber(todoMetadata['currentStep']) ?? 0,
    result: asString(todoMetadata['summary']) || '',
  };
}

function buildTodoSignature(items: readonly { id: number; title: string; status: string }[]): string {
  return items
    .map(item => `${item.id}:${item.status}:${item.title}`)
    .join('|');
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function indexOfCaseInsensitive(text: string, search: string): number {
  return text.toLowerCase().indexOf(search.toLowerCase());
}

function longestSuffixPrefixLength(text: string, marker: string): number {
  const max = Math.min(text.length, marker.length - 1);
  const lowerText = text.toLowerCase();
  const lowerMarker = marker.toLowerCase();
  for (let length = max; length > 0; length -= 1) {
    if (lowerMarker.startsWith(lowerText.slice(-length))) {
      return length;
    }
  }
  return 0;
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value
      .map(entry => asRecord(entry))
      .filter((entry): entry is Record<string, unknown> => !!entry)
      .map(entry => ({ ...entry }))
    : [];
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
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  return undefined;
}

function resolveTodoState(items: readonly { status: string }[]): StatePart['state'] {
  if (!items.length) {
    return 'info';
  }

  const hasInFlightItem = items.some(item => item.status === 'in-progress' || item.status === 'not-started');
  if (hasInFlightItem) {
    return 'doing';
  }

  return items.every(item => item.status === 'completed') ? 'done' : 'info';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function subagentActivityScope(event: SubagentActivity): ChatPartScope {
  return {
    sourceAgentRole: 'subagent',
    subAgentInvocationId: event.subAgentInvocationId || event.toolCallId,
    parentToolCallId: event.toolCallId,
  };
}

function subagentActivityToolCallId(event: SubagentActivity): string {
  return event.childToolCallId
    || `${event.toolCallId}:legacy:${event.toolName || 'tool'}`;
}

function subagentActivityToolText(event: SubagentActivity, fallback: string): string {
  return event.content?.trim() || fallback;
}

function extractTerminalPart(toolCallId: string, result: Extract<RenderEvent, { type: 'tool_call_end' }>['result']) {
  const text = extractRawToolResultPayloadText(result);
  if (!text) {
    return null;
  }

  const parsed = parseTerminalPayload(text);
  if (!parsed) {
    return null;
  }

  const terminal = mkTerminal(parsed.command, toolCallId, undefined, {
    processId: parsed.processId,
    outputSessionId: parsed.outputSessionId,
    terminalId: parsed.terminalId,
    outputFilePath: parsed.outputFilePath,
    cwd: parsed.cwd,
    status: parsed.status,
    bytesTotal: parsed.bytesTotal,
    lastOutputAt: parsed.lastOutputAt,
    outputUpdateKind: 'snapshot',
  });
  terminal.output = parsed.output;
  terminal.stderr = parsed.stderr;
  terminal.exitCode = parsed.exitCode;
  terminal.isRunning = parsed.isRunning;
  return terminal;
}

function extractTerminalReadPart(event: Extract<RenderEvent, { type: 'tool_call_end' }>) {
  if (!isTerminalReadToolName(event.toolName)) {
    return null;
  }

  const input = asRecord((event as { input?: unknown }).input);
  const processId = asString(input?.['processId'])
    || asString(input?.['outputSessionId'])
    || asString(input?.['terminalId'])
    || asString(input?.['id']);
  if (!processId) {
    return null;
  }

  const rawText = extractToolResultText(event.result);
  const { headers, body } = splitTerminalReadResult(rawText);
  const output = body.trimEnd();
  if (!output) {
    return null;
  }

  const terminal = mkTerminal('', event.toolCallId, undefined, {
    processId,
    outputSessionId: asString(input?.['outputSessionId']) || processId,
    terminalId: asString(input?.['terminalId']),
    status: headers.get('status'),
    bytesTotal: asNumber(headers.get('bytesTotal')),
    outputUpdateKind: 'snapshot',
  });
  terminal.output = output;
  terminal.stderr = '';
  terminal.isRunning = headers.get('status') === 'running';
  return terminal;
}

function isTerminalReadToolName(toolName: string | undefined): boolean {
  return toolName === 'command_read'
    || toolName === 'command_tail'
    || toolName === 'command_status'
    || toolName === 'get_terminal_output';
}

function splitTerminalReadResult(text: string): { headers: Map<string, string>; body: string } {
  const normalized = text.replace(/\r\n/g, '\n');
  const separatorIndex = normalized.indexOf('\n\n');
  const headerText = separatorIndex >= 0 ? normalized.slice(0, separatorIndex) : '';
  const body = separatorIndex >= 0 ? normalized.slice(separatorIndex + 2) : normalized;
  const headers = new Map<string, string>();

  for (const line of headerText.split('\n')) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (match) {
      headers.set(match[1], match[2]);
    }
  }

  return { headers, body };
}

function extractToolResultText(result: Extract<RenderEvent, { type: 'tool_call_end' }>['result']): string {
  return collectToolResultText(result);
}

function subagentStateUpdateToSnapshot(
  event: Extract<RenderEvent, { type: 'state_update' }>,
) {
  if (!event.stateId?.startsWith('subagent:')) {
    return null;
  }

  const metadata = event.metadata && typeof event.metadata === 'object' && !Array.isArray(event.metadata)
    ? event.metadata as Record<string, unknown>
    : {};
  const toolCallId = asString(metadata['toolCallId'])
    || asString(metadata['subAgentInvocationId'])
    || event.stateId.slice('subagent:'.length);
  if (!toolCallId) {
    return null;
  }

  const agentName = asString(metadata['agentName'])
    || asString(metadata['name'])
    || 'Agent';
  const description = asString(metadata['description'])
    || event.text
    || agentName;
  return {
    toolCallId,
    subAgentInvocationId: asString(metadata['subAgentInvocationId']) || toolCallId,
    agentName,
    description,
    state: normalizeSubagentToolCallState(event.state),
    resultText: asString(metadata['resultText']) || asString(metadata['result']) || '',
    childItems: [],
    metadata: {
      ...metadata,
      subAgentInvocationId: asString(metadata['subAgentInvocationId']) || toolCallId,
      toolSpecificData: {
        ...((metadata['toolSpecificData'] && typeof metadata['toolSpecificData'] === 'object' && !Array.isArray(metadata['toolSpecificData']))
          ? metadata['toolSpecificData'] as Record<string, unknown>
          : {}),
        kind: 'subagent',
        agentName,
        description,
      },
    },
  };
}

function normalizeToolCallProgressUpdate(
  data: unknown,
  toolName?: string,
): {
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
    return {
      summary: toolName ? `${toolName} still running...` : 'Tool still running...',
      progress: data,
    };
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return null;
  }

  const record = data as Record<string, unknown>;
  const summary = firstMeaningfulString(record['summary'], record['message'], record['text'], record['status'], record['detail'], record['step']);
  const detail = firstMeaningfulString(record['detail']);
  const step = firstMeaningfulString(record['step']);
  const statusText = firstMeaningfulString(record['status'], record['statusText']);
  const progress = asNumber(record['progress']) ?? asNumber(record['percentage']);
  const kind = firstMeaningfulString(record['kind']);
  const phase = firstMeaningfulString(record['phase']);
  const label = firstMeaningfulString(record['label']);
  const operationId = firstMeaningfulString(record['operationId']);
  const operationKind = firstMeaningfulString(record['operationKind']);
  const queueSize = asNumber(record['queueSize']);
  const durationMs = asNumber(record['durationMs']);
  const running = typeof record['running'] === 'boolean' ? record['running'] : undefined;

  if (!summary && progress == null && !detail && !step && !statusText && !phase && !label && !operationId && !operationKind) {
    return null;
  }

  return {
    summary: summary ?? label ?? (toolName ? `${toolName} still running...` : 'Tool still running...'),
    ...(progress != null ? { progress } : {}),
    ...(detail ? { detail } : {}),
    ...(step ? { step } : {}),
    ...(statusText ? { statusText } : {}),
    ...(kind ? { kind } : {}),
    ...(phase ? { phase } : {}),
    ...(label ? { label } : {}),
    ...(operationId ? { operationId } : {}),
    ...(operationKind ? { operationKind } : {}),
    ...(queueSize != null ? { queueSize } : {}),
    ...(durationMs != null ? { durationMs } : {}),
    ...(running != null ? { running } : {}),
  };
}

function normalizeCommandOutputProgress(data: unknown): {
  command: string;
  stdout: string;
  stderr: string;
  processId?: string;
  outputSessionId?: string;
  outputFilePath?: string;
  cwd?: string;
  status?: string;
  running?: boolean;
  bytesTotal?: number;
  lastOutputAt?: string;
} | null {
  const record = asRecord(data);
  if (!record || asString(record['kind']) !== 'command_output') {
    return null;
  }

  const text = asString(record['text']) ?? asString(record['detail']) ?? '';
  if (!text) {
    return null;
  }

  const stream = asString(record['stream']) === 'stderr' ? 'stderr' : 'stdout';
  const command = asTerminalCommand(record['command']) ?? '';
  return {
    command,
    stdout: stream === 'stdout' ? text : '',
    stderr: stream === 'stderr' ? text : '',
    processId: asString(record['processId']),
    outputSessionId: asString(record['outputSessionId']),
    outputFilePath: asString(record['outputFilePath']),
    cwd: asString(record['cwd']),
    status: asString(record['status']),
    running: typeof record['running'] === 'boolean' ? record['running'] : undefined,
    bytesTotal: asNumber(record['bytesTotal']),
    lastOutputAt: normalizeTimestamp(record['lastOutputAt']),
  };
}

function normalizeCommandSessionUpdate(data: unknown): {
  command: string;
  stdout: string;
  stderr: string;
  processId?: string;
  outputSessionId?: string;
  outputFilePath?: string;
  cwd?: string;
  status?: string;
  running?: boolean;
  exitCode?: number;
  bytesTotal?: number;
  lastOutputAt?: string;
} | null {
  const record = asRecord(data);
  if (!record || asString(record['kind']) !== 'command_session_update') {
    return null;
  }

  return {
    command: asTerminalCommand(record['command']) ?? '',
    stdout: typeof record['stdout'] === 'string' ? record['stdout'] : '',
    stderr: typeof record['stderr'] === 'string' ? record['stderr'] : '',
    processId: asString(record['processId']),
    outputSessionId: asString(record['outputSessionId']),
    outputFilePath: asString(record['outputFilePath']),
    cwd: asString(record['cwd']),
    status: asString(record['status']),
    running: typeof record['running'] === 'boolean' ? record['running'] : undefined,
    exitCode: asNumber(record['exitCode']),
    bytesTotal: asNumber(record['bytesTotal']),
    lastOutputAt: normalizeTimestamp(record['lastOutputAt']),
  };
}

function commandTerminalUpdateToPart(
  update: {
    command: string;
    stdout: string;
    stderr: string;
    processId?: string;
    outputSessionId?: string;
    outputFilePath?: string;
    cwd?: string;
    status?: string;
    running?: boolean;
    exitCode?: number;
    bytesTotal?: number;
    lastOutputAt?: string;
  },
  toolCallId: string,
  defaultRunning: boolean,
) {
  const terminal = mkTerminal(update.command, toolCallId, undefined, {
    processId: update.processId,
    outputSessionId: update.outputSessionId,
    outputFilePath: update.outputFilePath,
    cwd: update.cwd,
    status: update.status || (defaultRunning ? 'running' : undefined),
    bytesTotal: update.bytesTotal,
    lastOutputAt: update.lastOutputAt,
    outputUpdateKind: defaultRunning ? 'delta' : 'snapshot',
  });
  terminal.output = update.stdout;
  terminal.stderr = update.stderr;
  terminal.exitCode = update.exitCode;
  terminal.isRunning = update.running ?? (update.status ? update.status === 'running' : defaultRunning);
  return terminal;
}

function buildToolCallProgressMetadataPatch(input: {
  toolCallId: string;
  toolName?: string;
  timestamp: number;
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
  existingMetadata?: Record<string, unknown>;
}): Record<string, unknown> {
  const existingMetadata = asRecord(input.existingMetadata) ?? {};
  const phase = normalizeProgressPhase(input.phase);
  if (input.kind === 'editor_operation') {
    const {
      phase: _previousPhase,
      progress: _previousProgress,
      progressKind: _previousProgressKind,
      operationId: _previousOperationId,
      operationKind: _previousOperationKind,
      operationLabel: _previousOperationLabel,
      queueSize: _previousQueueSize,
      durationMs: _previousDurationMs,
      running: _previousRunning,
      timeline: _previousTimeline,
      toolSpecificData: _previousToolSpecificData,
      ...stableMetadata
    } = existingMetadata;
    return {
      ...stableMetadata,
      ...(input.toolName ? { toolName: input.toolName } : {}),
      progress: undefined,
      queueSize: undefined,
      durationMs: undefined,
      running: undefined,
      timeline: undefined,
      toolSpecificData: undefined,
      phase,
      ...(input.progress != null ? { progress: input.progress } : {}),
      progressKind: 'editor_operation',
      ...(input.operationId ? { operationId: input.operationId } : {}),
      ...(input.operationKind ? { operationKind: input.operationKind } : {}),
      ...(input.label ? { operationLabel: input.label } : {}),
      ...(input.queueSize != null ? { queueSize: input.queueSize } : {}),
      ...(input.durationMs != null ? { durationMs: input.durationMs } : {}),
      ...(input.running != null ? { running: input.running } : {}),
    };
  }

  const existingTimeline = asRecordArray(existingMetadata['timeline']);
  const recordId = input.kind === 'editor_operation' && input.operationId
    ? `${input.toolCallId}:${input.operationId}:${phase === 'progress' ? 'progress' : phase}`
    : `${input.toolCallId}:progress`;
  const progressDetails = buildProgressDetails(input);
  const progressEntry: Record<string, unknown> = {
    recordId,
    phase,
    ...(input.summary ? { summary: input.summary } : {}),
    ...(input.progress != null ? { progress: input.progress } : {}),
    ...(progressDetails ? { progressDetails } : {}),
    timestamp: input.timestamp,
  };

  const timeline = mergeProgressTimeline(existingTimeline, progressEntry);
  const toolSpecificData = existingMetadata['toolSpecificData'];

  return {
    ...existingMetadata,
    ...(input.toolName ? { toolName: input.toolName } : {}),
    phase,
    ...(input.progress != null ? { progress: input.progress } : {}),
    ...(input.kind ? { progressKind: input.kind } : {}),
    ...(input.operationId ? { operationId: input.operationId } : {}),
    ...(input.operationKind ? { operationKind: input.operationKind } : {}),
    ...(input.label ? { operationLabel: input.label } : {}),
    ...(input.queueSize != null ? { queueSize: input.queueSize } : {}),
    ...(input.durationMs != null ? { durationMs: input.durationMs } : {}),
    ...(toolSpecificData ? { toolSpecificData } : {}),
    timeline,
  };
}

function buildProgressDetails(input: {
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
  if (!input.summary
    && !input.detail
    && !input.step
    && !input.statusText
    && input.progress == null
    && !input.kind
    && !input.phase
    && !input.label
    && !input.operationId
    && !input.operationKind
    && input.queueSize == null
    && input.durationMs == null
    && input.running == null) {
    return undefined;
  }

  return {
    ...(input.summary ? { message: input.summary } : {}),
    ...(input.detail ? { detail: input.detail } : {}),
    ...(input.step ? { step: input.step } : {}),
    ...(input.statusText ? { statusText: input.statusText } : {}),
    ...(input.progress != null ? { progress: input.progress } : {}),
    ...(input.kind ? { kind: input.kind } : {}),
    ...(input.phase ? { phase: normalizeProgressPhase(input.phase) } : {}),
    ...(input.label ? { label: input.label } : {}),
    ...(input.operationId ? { operationId: input.operationId } : {}),
    ...(input.operationKind ? { operationKind: input.operationKind } : {}),
    ...(input.queueSize != null ? { queueSize: input.queueSize } : {}),
    ...(input.durationMs != null ? { durationMs: input.durationMs } : {}),
    ...(input.running != null ? { running: input.running } : {}),
  };
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

function resolveProgressToolCallState(progressUpdate: {
  kind?: string;
  phase?: string;
}): 'doing' | 'done' | 'warn' | 'error' {
  if (progressUpdate.kind !== 'editor_operation') {
    return 'doing';
  }

  switch (normalizeProgressPhase(progressUpdate.phase)) {
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

function mergeProgressTimeline(
  existingTimeline: readonly Record<string, unknown>[],
  progressEntry: Record<string, unknown>,
): Record<string, unknown>[] {
  if (existingTimeline.length === 0) {
    return [{ ...progressEntry }];
  }

  const nextTimeline = existingTimeline.map(entry => ({ ...entry }));
  const lastEntry = nextTimeline[nextTimeline.length - 1];
  if (asString(lastEntry?.['recordId']) === asString(progressEntry['recordId'])) {
    nextTimeline[nextTimeline.length - 1] = { ...progressEntry };
    return nextTimeline;
  }

  nextTimeline.push({ ...progressEntry });
  return nextTimeline;
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

function questionRequestToPart(event: Extract<RenderEvent, { type: 'question_request' }>) {
  return mkQuestion(
    event.questions.map(q => ({
      question: q.question,
      options: q.options?.map(o => ({ ...o })),
      allow_freeform: q.allowFreeform,
      multi_select: q.multiSelect,
    })),
    undefined,
    event.requestId,
    eventScope(event),
  );
}

function confirmationRequestToPart(event: Extract<RenderEvent, { type: 'approval_request' }>) {
  return mkConfirmation(
    getStandaloneApprovalRequestId(event),
    event.message,
    event.toolName,
    event.source,
    {
      args: event.input,
      title: event.title,
      subtitle: event.subtitle,
      description: event.description,
      actions: event.actions,
      primaryScope: event.primaryScope,
      sourceAgentRole: event.sourceAgentRole,
      subAgentInvocationId: event.subAgentInvocationId,
      parentToolCallId: event.parentToolCallId,
      sequence: event.sequence,
    },
  );
}

function approvalRequestToToolCallPatch(
  event: Extract<RenderEvent, { type: 'approval_request' }> & { toolCallId: string },
): ToolCallPartPatch {
  return {
    state: 'pending_approval',
    text: event.message || `${event.toolName} requires approval`,
    args: event.input,
    metadata: withChatPartScopeMetadata({
      approval: buildPendingToolCallApprovalMetadata({
        approvalTraceId: event.approvalTraceId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        message: event.message,
        description: event.description,
        source: event.source,
        title: event.title,
        subtitle: event.subtitle,
        actions: event.actions,
        primaryScope: event.primaryScope,
        args: event.input,
      }),
    }, eventScope(event)),
  };
}

function approvalResolveToToolCallPatch(
  event: Extract<RenderEvent, { type: 'approval_resolve' }> & { toolCallId: string },
): ToolCallPartPatch {
  return {
    state: event.result === 'approved' ? 'doing' : 'error',
    metadata: withChatPartScopeMetadata({
      approval: buildResolvedToolCallApprovalMetadata({
        approvalTraceId: event.approvalTraceId,
        toolCallId: event.toolCallId,
        result: event.result,
        scope: event.scope,
      }),
    }, eventScope(event)),
  };
}

function approvalAutoReviewStartToToolCallPatch(
  event: Extract<RenderEvent, { type: 'approval_auto_review_start' }> & { toolCallId: string },
): ToolCallPartPatch {
  return {
    text: event.reason,
    metadata: {
      approval: buildPendingToolCallApprovalMetadata({
        approvalTraceId: event.approvalTraceId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        title: '自动审查中',
        message: event.reason,
        source: event.source,
        reviewer: 'auto_review',
        reviewStatus: 'reviewing',
        reviewStartedAt: event.timestamp,
        args: undefined,
        actions: [],
        primaryScope: 'once',
      }),
    },
  };
}

function approvalAutoReviewCompleteToToolCallPatch(
  event: Extract<RenderEvent, { type: 'approval_auto_review_complete' }> & { toolCallId: string },
): ToolCallPartPatch {
  const approved = event.status === 'approved';
  const decisionSource = (event as { readonly decisionSource?: string }).decisionSource ?? 'auto_review';
  return {
    ...(approved ? {} : { state: 'error' as const }),
    metadata: {
      approval: buildResolvedToolCallApprovalMetadata({
        approvalTraceId: event.approvalTraceId,
        toolCallId: event.toolCallId,
        result: approved ? 'approved' : 'rejected',
        reviewer: 'auto_review',
        reviewStatus: event.status,
        reviewRiskLevel: event.riskLevel,
        source: event.source,
        reviewCompletedAt: event.timestamp,
        decisionSource,
        title: approved ? '自动审查已允许' : (event.status === 'timedOut' ? '自动审查超时' : '自动审查已拒绝'),
        message: event.rationale,
        description: `风险等级：${event.riskLevel}`,
      }),
    },
  };
}

function isToolExecutionApprovalEvent(
  event: Extract<RenderEvent, { type: 'approval_request' | 'approval_resolve' }>,
): event is Extract<RenderEvent, { type: 'approval_request' | 'approval_resolve' }> & { toolCallId: string } {
  return typeof event.toolCallId === 'string' && event.toolCallId.trim().length > 0;
}

function getStandaloneApprovalRequestId(
  event: Extract<RenderEvent, { type: 'approval_request' | 'approval_resolve' }>,
): string {
  if (typeof event.requestId === 'string' && event.requestId.trim().length > 0) {
    return event.requestId;
  }

  return '';
}

function errorNoticeToPart(event: Extract<RenderEvent, { type: 'error_notice' }>) {
  const normalized = normalizeChatErrorNotice({
    message: event.message,
    code: event.code,
    details: (event as { readonly details?: unknown }).details,
  });
  return mkError(
    normalized.message,
    'error',
    withChatPartScopeMetadata(normalized.metadata, eventScope(event)),
  );
}

function warningNoticeToPart(event: Extract<RenderEvent, { type: 'warning_notice' }>) {
  return mkError(event.message, 'warning', withChatPartScopeMetadata({
    ...(typeof event.code === 'string' ? { code: event.code } : {}),
    ...(event.details && typeof event.details === 'object' ? { details: event.details } : {}),
  }, eventScope(event)));
}

function infoNoticeToPart(event: Extract<RenderEvent, { type: 'info_notice' }>) {
  return mkError(event.message, 'info', withChatPartScopeMetadata(undefined, eventScope(event)));
}

function subagentBeginToSnapshot(event: Extract<RenderEvent, { type: 'subagent_begin' }>): SubagentToolCallSnapshot {
  return {
    toolCallId: event.toolCallId,
    subAgentInvocationId: event.subAgentInvocationId || event.toolCallId,
    agentName: event.agentName,
    description: event.description,
    state: 'doing',
    resultText: '',
    childItems: [],
    metadata: buildSubagentMetadata(event),
  };
}

function subagentActivityParentSnapshot(event: SubagentActivity): SubagentToolCallSnapshot {
  const subAgentInvocationId = event.subAgentInvocationId || event.toolCallId;
  return {
    toolCallId: event.toolCallId,
    subAgentInvocationId,
    agentName: 'Agent',
    description: 'Subagent',
    state: 'doing',
    resultText: '',
    childItems: [],
    metadata: buildSubagentMetadata({
      type: 'subagent_begin',
      toolCallId: event.toolCallId,
      subAgentInvocationId,
      agentName: 'Agent',
      description: 'Subagent',
      timestamp: event.timestamp,
    }),
  };
}

function buildSubagentMetadata(
  event: Extract<RenderEvent, { type: 'subagent_begin' }>,
): Record<string, unknown> {
  const description = event.description?.trim() || event.agentName;
  const subAgentInvocationId = (event as { readonly subAgentInvocationId?: string }).subAgentInvocationId || event.toolCallId;

  return {
    toolName: 'agent',
    phase: 'started',
    argsSummary: event.description,
    recordId: event.toolCallId,
    subAgentInvocationId,
    invocationMessage: description,
    pastTenseMessage: description ? `Completed Task: "${description}"` : event.agentName,
    timeline: [mkSubagentTimelineEntry({
      recordId: `${event.toolCallId}:started`,
      phase: 'started',
      summary: description,
      timestamp: event.timestamp,
    })],
    toolSpecificData: {
      kind: 'subagent',
      description: event.description,
      agentName: event.agentName,
      result: '',
    },
  };
}
