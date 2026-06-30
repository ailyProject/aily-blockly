/**
 * ChatPartStore — Part-based 消息存储
 *
 * 管理每条消息的 Parts 数组，支持：
 *   - addPart / updatePart / appendToMarkdown — 增量更新
 *   - getParts / getLastPart — 查询
 *   - createChangeTracker — 变更跟踪（供低层 projector / 测试观测变更）
 *
 * 设计：纯 TypeScript class（非 Angular injectable），由 ChatEngineService 持有实例。
 * 与 think-content-store 类似的全局 Map 模式，但结构化。
 */

import { Subject } from 'rxjs';
import { collectMarkdownPostProcessPatches } from './chat-part-markdown-postprocessor';
import { appendMarkdownContent, getMarkdownContentLength, getMarkdownContentWindow, storeMarkdownContent } from './markdown-content-store';
import { appendThinkContent, getThinkContentLength, getThinkContentWindow, storeThinkContent } from './think-content-store';
import {
  ChatPart, MarkdownPart, ThinkingPart, ToolCallPart, StatePart, TerminalPart,
  SubagentToolCallSnapshot, isSubagentToolCallMetadata, mkMarkdown, mkThinking, mkToolCall, mkError, mkState, mkSubagentTimelineEntry, subagentSnapshotToToolCall, toolCallPartToSubagentSnapshot, mkPlan, mkQuestion, mkConfirmation, isLikelyPlanMarkdown, buildScopedTextPartId,
  type ChatPartScope, isSameChatPartScope, normalizeChatPartScope, withChatPartScopeMetadata,
} from './chat-parts';
import type { SubagentChildItem } from './chat-parts';
import type { ConfirmationPart, QuestionPart } from './chat-parts';
import { ChatPerformanceTracer } from '../services/chat-perf-tracer';

type ChatPartStoreKey = object | symbol | number | string;
const TERMINAL_LIVE_STREAM_MAX_CHARS = 32 * 1024;
const TERMINAL_LIVE_OMITTED_MARKER = '[earlier terminal output omitted]\n';
const SUBAGENT_CHILD_LIVE_STREAM_MAX_CHARS = 12 * 1024;
const SUBAGENT_CHILD_LIVE_OMITTED_MARKER = '[earlier subagent output omitted]\n';
let subagentChildContentRefCounter = 0;
type RunningPartFinalizeStatus = 'completed' | 'cancelled' | 'error';

// ==================== 变更事件 ====================

export interface PartChange {
  /** Part 在该消息 parts 数组中的索引 */
  partIndex: number;
  /** 变更类型 */
  kind: 'add' | 'update' | 'append';
}

export interface ChatPartStoreChangeTracker {
  drainChangesForHandle(handle: ChatPartStoreReadableHandle | null): PartChange[];
  drainPartIndexChangesForHandle(handle: ChatPartStoreReadableHandle | null): Array<Pick<PartChange, 'partIndex'>>;
  clear(): void;
  dispose(): void;
}

export interface ToolCallPartPatch {
  state?: ToolCallPart['state'];
  text?: string;
  args?: ToolCallPart['args'];
  metadata?: Record<string, unknown>;
}

export interface StatePartPatch {
  state?: StatePart['state'];
  text?: string;
  progress?: number;
  kind?: StatePart['kind'];
  metadata?: Record<string, unknown>;
}

export interface TextPayloadPartPatch {
  contentKind: 'markdown' | 'thinking';
  contentRef?: string;
  text?: string;
  contentLength: number;
}

type ChatPartProjectionSourceStore = Pick<ChatPartStore, 'getPartsForHandle'>;

interface ChatPartStoreHandleBase {
  storeKey?: object | symbol;
}

export interface ChatPartStoreOpaqueHandle extends ChatPartStoreHandleBase {}

interface ChatPartStoreIndexedHandle extends ChatPartStoreHandleBase {
  msgIndex: number;
}

export interface ChatPartStoreResponseHandle {
  readonly kind: 'response';
  readonly turnId: string;
  readonly responseId?: string;
  readonly itemId?: string;
}

export type ChatPartStoreReadableHandle<TMessage extends object = object> =
  | ChatPartStoreOpaqueHandle
  | ChatPartStoreResponseHandle
  | ChatPartStoreIndexedHandle
  | (ChatPartStoreHandleBase & { msgIndex: number; readonly message: TMessage });

type ChatPartStoreHandle = ChatPartStoreIndexedHandle | ChatPartStoreOpaqueHandle | ChatPartStoreResponseHandle;

interface TrackedPartChange {
  storeKey: ChatPartStoreKey;
  change: PartChange;
}

function getHandleMessageStoreKey(handle: ChatPartStoreHandle | null): object | null {
  const message = (handle as { message?: unknown } | null)?.message;
  return message && typeof message === 'object' ? message as object : null;
}

function getHandleOpaqueStoreKey(handle: ChatPartStoreHandle | null): object | symbol | string | null {
  if (!handle) {
    return null;
  }

  return 'storeKey' in handle
    ? (handle.storeKey ?? getHandleMessageStoreKey(handle))
    : getHandleMessageStoreKey(handle);
}

function getHandleResponseStoreKey(handle: ChatPartStoreHandle | null): string | null {
  if (!handle || !('kind' in handle) || handle.kind !== 'response') {
    return null;
  }

  const turnId = typeof handle.turnId === 'string' ? handle.turnId.trim() : '';
  if (!turnId) {
    return null;
  }

  const itemId = typeof handle.itemId === 'string' ? handle.itemId.trim() : '';
  return itemId || `response:${turnId}`;
}

function getHandleOrderIndex(handle: ChatPartStoreHandle | null): number | null {
  if (!handle || !('msgIndex' in handle) || typeof handle.msgIndex !== 'number') {
    return null;
  }

  return handle.msgIndex >= 0 ? handle.msgIndex : null;
}

function isIndexedChatPartStoreHandle(
  handle: ChatPartStoreHandle | null,
): handle is ChatPartStoreIndexedHandle {
  return typeof getHandleOrderIndex(handle) === 'number';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value
      .map(item => asRecord(item))
      .filter((item): item is Record<string, unknown> => !!item)
      .map(item => ({ ...item }))
    : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function getChatPartStableStoreKey(part: ChatPart): string | undefined {
  switch (part.type) {
    case 'markdown':
    case 'thinking':
    case 'question':
    case 'confirmation':
    case 'terminal':
    case 'plan':
      return asString(part.partId);
    case 'tool_call':
      return asString(part.partId) || `tool:${part.toolCallId}`;
    case 'state':
      return `state:${part.stateId}`;
    case 'error':
      return asString(part.partId);
  }
}

function appendTerminalLiveStream(existing: string | undefined, delta: string | undefined): string | undefined {
  const combined = `${existing || ''}${delta || ''}`;
  if (combined.length <= TERMINAL_LIVE_STREAM_MAX_CHARS) {
    return combined;
  }

  const tailLength = Math.max(0, TERMINAL_LIVE_STREAM_MAX_CHARS - TERMINAL_LIVE_OMITTED_MARKER.length);
  return `${TERMINAL_LIVE_OMITTED_MARKER}${combined.slice(-tailLength)}`;
}

function normalizeTerminalLivePart(terminal: TerminalPart): TerminalPart {
  return {
    ...terminal,
    output: appendTerminalLiveStream(undefined, terminal.output),
    stderr: appendTerminalLiveStream(undefined, terminal.stderr),
  };
}

function getSubagentChildContentKind(child: Pick<SubagentChildItem, 'kind' | 'contentKind'>): 'markdown' | 'thinking' {
  if (child.contentKind === 'markdown' || child.contentKind === 'thinking') {
    return child.contentKind;
  }
  return child.kind === 'thinking' ? 'thinking' : 'markdown';
}

function createSubagentChildContentRef(kind: SubagentChildItem['kind']): string {
  const randomId = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}-${(++subagentChildContentRefCounter).toString(36)}`;
  return `subagent-child:${kind}:${randomId}`;
}

function storeSubagentChildContent(kind: 'markdown' | 'thinking', key: string, content: string): void {
  if (kind === 'thinking') {
    storeThinkContent(key, content);
    return;
  }
  storeMarkdownContent(key, content);
}

function appendSubagentChildContent(kind: 'markdown' | 'thinking', key: string, delta: string): void {
  if (kind === 'thinking') {
    appendThinkContent(key, delta);
    return;
  }
  appendMarkdownContent(key, delta);
}

function getSubagentChildContentLength(kind: 'markdown' | 'thinking', key: string): number {
  return kind === 'thinking' ? getThinkContentLength(key) : getMarkdownContentLength(key);
}

function getSubagentChildContentWindow(kind: 'markdown' | 'thinking', key: string): string {
  return kind === 'thinking'
    ? getThinkContentWindow(key, SUBAGENT_CHILD_LIVE_STREAM_MAX_CHARS, SUBAGENT_CHILD_LIVE_OMITTED_MARKER)
    : getMarkdownContentWindow(key, SUBAGENT_CHILD_LIVE_STREAM_MAX_CHARS, SUBAGENT_CHILD_LIVE_OMITTED_MARKER);
}

function ensureSubagentChildContentRef(child: SubagentChildItem): SubagentChildItem {
  if (child.kind !== 'thinking' && child.kind !== 'text') {
    return child;
  }

  const contentKind = getSubagentChildContentKind(child);
  let contentRef = asString(child.contentRef);
  if (!contentRef) {
    contentRef = createSubagentChildContentRef(child.kind);
    storeSubagentChildContent(contentKind, contentRef, child.content || '');
  }

  const contentLength = getSubagentChildContentLength(contentKind, contentRef);
  child.contentRef = contentRef;
  child.contentKind = contentKind;
  child.contentLength = contentLength;
  child.content = getSubagentChildContentWindow(contentKind, contentRef);
  return child;
}

function getTerminalSessionKey(terminal: Pick<TerminalPart, 'processId' | 'outputSessionId' | 'terminalId'>): string | undefined {
  return asString(terminal.processId) || asString(terminal.outputSessionId) || asString(terminal.terminalId);
}

function mergeTerminalSourceToolCallIds(existing: TerminalPart, next: TerminalPart): string[] | undefined {
  const merged = Array.from(new Set([
    ...(existing.sourceToolCallIds ?? []),
    ...(existing.toolCallId ? [existing.toolCallId] : []),
    ...(next.sourceToolCallIds ?? []),
    ...(next.toolCallId ? [next.toolCallId] : []),
  ].map(value => asString(value)).filter((value): value is string => !!value)));
  return merged.length > 0 ? merged : undefined;
}

function mergeToolCallMetadata(
  part: ToolCallPart,
  patch: ToolCallPartPatch,
): Record<string, unknown> | undefined {
  if (patch.metadata == null) {
    return undefined;
  }

  const currentMetadata = asRecord(part.metadata) ?? {};
  const nextMetadata: Record<string, unknown> = {
    ...currentMetadata,
    ...patch.metadata,
  };

  const currentApproval = asRecord(currentMetadata['approval']);
  const nextApprovalPatch = asRecord(patch.metadata['approval']);
  if (nextApprovalPatch) {
    const nextApproval: Record<string, unknown> = {
      ...(currentApproval ?? {}),
      ...nextApprovalPatch,
    };

    if (patch.state === 'pending_approval' && typeof nextApproval['previousText'] !== 'string') {
      const previousText = asString(part.text);
      if (previousText) {
        nextApproval['previousText'] = previousText;
      }
    }

    nextMetadata['approval'] = nextApproval;
  }

  return nextMetadata;
}

function resolvePatchedToolCallText(
  part: ToolCallPart,
  patch: ToolCallPartPatch,
  nextMetadata: Record<string, unknown> | undefined,
): string {
  if (patch.text != null) {
    return patch.text;
  }

  if (part.state !== 'pending_approval' || patch.state === 'pending_approval') {
    return part.text;
  }

  const approval = asRecord(nextMetadata?.['approval'])
    ?? asRecord(asRecord(part.metadata)?.['approval']);
  const previousText = asString(approval?.['previousText']);
  return previousText || part.text;
}

function buildCompletedSubagentMetadata(
  part: Pick<SubagentToolCallSnapshot, 'metadata' | 'description' | 'agentName' | 'toolCallId'>,
  resultText: string,
): Record<string, unknown> {
  const existingMetadata = asRecord(part.metadata) ?? {};
  const existingToolSpecificData = asRecord(existingMetadata['toolSpecificData']) ?? {};
  const description = part.description?.trim() || part.agentName;

  return {
    ...existingMetadata,
    subAgentInvocationId: typeof existingMetadata['subAgentInvocationId'] === 'string'
      ? existingMetadata['subAgentInvocationId']
      : part.toolCallId,
    invocationMessage: typeof existingMetadata['invocationMessage'] === 'string'
      ? existingMetadata['invocationMessage']
      : description,
    pastTenseMessage: typeof existingMetadata['pastTenseMessage'] === 'string'
      ? existingMetadata['pastTenseMessage']
      : (description ? `Completed Task: "${description}"` : part.agentName),
    toolSpecificData: {
      ...existingToolSpecificData,
      description: typeof existingToolSpecificData['description'] === 'string'
        ? existingToolSpecificData['description']
        : part.description,
      agentName: typeof existingToolSpecificData['agentName'] === 'string'
        ? existingToolSpecificData['agentName']
        : part.agentName,
      result: resultText,
    },
  };
}

function buildSubagentChildTimelineEntry(child: SubagentChildItem, index: number): Record<string, unknown> {
  const recordId = `child:${child.toolCallId || index}`;

  if (child.kind === 'tool') {
    const phase = child.state === 'error'
      ? 'failed'
      : child.state === 'done'
        ? 'completed'
        : child.content
          ? 'progress'
          : 'started';

    return mkSubagentTimelineEntry({
      recordId,
      phase,
      summary: [child.toolName, child.argsSummary].filter(Boolean).join(' · ') || child.content,
      resultText: child.state === 'done' || child.state === 'error' ? child.content || undefined : undefined,
      progressDetails: child.content ? { message: child.content } : undefined,
    });
  }

  return mkSubagentTimelineEntry({
    recordId,
    phase: 'progress',
    summary: child.kind === 'thinking' ? '子代理思考' : child.kind === 'question' ? '子代理提问' : '子代理输出',
    resultText: child.content || undefined,
    progressDetails: child.contentRef
      ? {
        contentRef: child.contentRef,
        contentKind: child.contentKind,
        contentLength: child.contentLength,
      }
      : undefined,
  });
}

function finalizeSubagentChildItems(
  childItems: readonly SubagentChildItem[] | undefined,
  status: RunningPartFinalizeStatus | undefined,
): SubagentChildItem[] | undefined {
  if (!Array.isArray(childItems) || childItems.length === 0) {
    return childItems ? [...childItems] : undefined;
  }

  const finalToolState: NonNullable<SubagentChildItem['state']> = status === 'error' || status === 'cancelled'
    ? 'error'
    : 'done';
  let changed = false;
  const nextItems = childItems.map((child) => {
    if (child.kind !== 'tool' || child.state === 'done' || child.state === 'error') {
      return child;
    }

    changed = true;
    return {
      ...child,
      state: finalToolState,
    };
  });

  return changed ? nextItems : [...childItems];
}

function finalizeQuestionAnswers(part: QuestionPart): QuestionPart['answers'] {
  const existingAnswers = part.answers ?? {};
  const answers: NonNullable<QuestionPart['answers']> = { ...existingAnswers };

  for (const question of part.questions || []) {
    const questionText = typeof question.question === 'string' ? question.question : '';
    if (!questionText || answers[questionText]) {
      continue;
    }
    answers[questionText] = { selected: [], freeText: null, skipped: true };
  }

  return answers;
}

function finalizeInteractionMetadata(
  metadata: Record<string, unknown> | undefined,
  status: RunningPartFinalizeStatus | undefined,
): Record<string, unknown> {
  return {
    ...(metadata ?? {}),
    finalizationStatus: status ?? 'completed',
    finalizedBy: 'turnCompleted',
  };
}

function finalizePendingApprovalMetadata(
  part: ToolCallPart,
  status: RunningPartFinalizeStatus | undefined,
): Record<string, unknown> | undefined {
  const currentMetadata = asRecord(part.metadata) ?? {};
  const currentApproval = asRecord(currentMetadata['approval']) ?? {};
  const nextMetadata = mergeToolCallMetadata(part, {
    state: status === 'error' ? 'error' : 'warn',
    metadata: {
      approval: {
        ...currentApproval,
        resolved: true,
        result: 'rejected',
        decisionSource: status === 'cancelled' ? 'cancelled' : 'turn_finalized',
        finalizedBy: 'turnCompleted',
      },
    },
  }) ?? currentMetadata;

  return Object.keys(nextMetadata).length > 0 ? nextMetadata : undefined;
}

function mergeSubagentToolChildItem(existing: SubagentChildItem, next: SubagentChildItem): SubagentChildItem {
  if (existing.kind !== 'tool' || next.kind !== 'tool') {
    return next;
  }

  return {
    ...existing,
    ...next,
    toolName: next.toolName ?? existing.toolName,
    toolCallId: next.toolCallId ?? existing.toolCallId,
    argsSummary: next.argsSummary ?? existing.argsSummary,
    content: next.content,
    state: next.state,
    duration: next.duration ?? existing.duration,
  };
}

function appendSubagentTextChildInPlace(
  part: ToolCallPart,
  child: SubagentChildItem,
): boolean {
  if ((child.kind !== 'thinking' && child.kind !== 'text' && child.kind !== 'question') || !child.content) {
    return false;
  }

  const metadata = asRecord(part.metadata);
  const toolSpecificData = asRecord(metadata?.['toolSpecificData']);
  if (!metadata || !toolSpecificData) {
    return false;
  }

  let childItems = Array.isArray(toolSpecificData['childItems'])
    ? toolSpecificData['childItems'] as SubagentChildItem[]
    : undefined;
  if (!childItems) {
    childItems = [];
    toolSpecificData['childItems'] = childItems;
  }

  const previousChild = childItems[childItems.length - 1];
  const shouldAppendToPrevious = previousChild?.kind === child.kind;
  if (shouldAppendToPrevious) {
    if (previousChild.kind === 'thinking' || previousChild.kind === 'text') {
      ensureSubagentChildContentRef(previousChild);
      const contentKind = getSubagentChildContentKind(previousChild);
      appendSubagentChildContent(contentKind, previousChild.contentRef!, child.content);
      previousChild.contentLength = getSubagentChildContentLength(contentKind, previousChild.contentRef!);
      previousChild.content = getSubagentChildContentWindow(contentKind, previousChild.contentRef!);
    } else {
      previousChild.content = `${previousChild.content || ''}${child.content}`;
    }
  } else {
    const nextChild = { ...child };
    ensureSubagentChildContentRef(nextChild);
    childItems.push(nextChild);
  }

  const timeline = Array.isArray(metadata['timeline'])
    ? metadata['timeline'] as Record<string, unknown>[]
    : undefined;
  if (timeline) {
    const childIndex = childItems.length - 1;
    const recordId = `child:${childIndex}`;
    if (shouldAppendToPrevious) {
      const timelineEntry = timeline.find(entry => entry['recordId'] === recordId);
      if (timelineEntry) {
        timelineEntry['resultText'] = childItems[childIndex].content || undefined;
        if (childItems[childIndex].contentRef) {
          timelineEntry['progressDetails'] = {
            contentRef: childItems[childIndex].contentRef,
            contentKind: childItems[childIndex].contentKind,
            contentLength: childItems[childIndex].contentLength,
          };
        }
      } else {
        timeline.push(buildSubagentChildTimelineEntry(childItems[childIndex], childIndex));
      }
    } else {
      timeline.push(buildSubagentChildTimelineEntry(childItems[childIndex], childIndex));
    }
  }

  return true;
}

function isUsableChatPartStoreHandle(
  handle: ChatPartStoreHandle | null,
): handle is ChatPartStoreHandle {
  return !!handle && (
    getHandleResponseStoreKey(handle) !== null
    || getHandleOpaqueStoreKey(handle) !== null
    || getHandleOrderIndex(handle) !== null
  );
}

// ==================== Store ====================

export class ChatPartStore {
  /** storeKey → ChatPart[] */
  private _store = new Map<ChatPartStoreKey, ChatPart[]>();
  private _revision = 0;

  /** storeKey → 最新 host list 索引（detached handle 可能不存在） */
  private readonly orderByKey = new Map<ChatPartStoreKey, number>();

  /** host list 索引 → 当前 storeKey，兼容裸 `{ msgIndex }` 查询 */
  private readonly keyByMsgIndex = new Map<number, ChatPartStoreKey>();

  /** 变更通知流（仅供 store 内部 tracker 订阅） */
  private readonly changes$ = new Subject<TrackedPartChange>();

  get revision(): number {
    return this._revision;
  }

  createChangeTracker(): ChatPartStoreChangeTracker {
    return new StoreChangeTracker(this.changes$, handle => this.resolveStoreKey(handle));
  }

  private rebindStoreKey(
    fromKey: ChatPartStoreKey,
    toKey: ChatPartStoreKey,
    orderIndex: number | null,
  ): void {
    if (fromKey === toKey) {
      return;
    }

    const fromParts = this._store.get(fromKey);
    const toParts = this._store.get(toKey);
    if (fromParts) {
      this._store.set(toKey, toParts ? [...fromParts, ...toParts] : fromParts);
      this._store.delete(fromKey);
    }

    const fallbackOrderIndex = this.orderByKey.get(fromKey);
    const nextOrderIndex = orderIndex ?? fallbackOrderIndex;
    if (typeof nextOrderIndex === 'number') {
      this.orderByKey.set(toKey, nextOrderIndex);
    }
    this.orderByKey.delete(fromKey);

    for (const [msgIndex, mappedKey] of [...this.keyByMsgIndex.entries()]) {
      if (mappedKey === fromKey) {
        this.keyByMsgIndex.set(msgIndex, toKey);
      }
    }

    this.bumpRevision();
  }

  private bumpRevision(): void {
    this._revision += 1;
  }

  private resolveStoreKey(handle: ChatPartStoreHandle | null): ChatPartStoreKey | null {
    if (!isUsableChatPartStoreHandle(handle)) {
      return null;
    }

    const responseKey = getHandleResponseStoreKey(handle);
    if (responseKey !== null) {
      return responseKey;
    }

    const explicitKey = getHandleOpaqueStoreKey(handle);
    const orderIndex = getHandleOrderIndex(handle);
    const mappedKey = orderIndex !== null ? this.keyByMsgIndex.get(orderIndex) : undefined;
    let storeKey = explicitKey
      ?? (mappedKey ?? (orderIndex !== null ? orderIndex : null));

    if (explicitKey !== null && mappedKey !== undefined && mappedKey !== explicitKey) {
      this.rebindStoreKey(mappedKey, explicitKey, orderIndex);
      storeKey = explicitKey;
    }

    if (storeKey === null) {
      return null;
    }

    if (orderIndex !== null) {
      this.orderByKey.set(storeKey, orderIndex);
      this.keyByMsgIndex.set(orderIndex, storeKey);
    }

    return storeKey;
  }

  private resolveHandleOrderIndex(handle: ChatPartStoreHandle | null): number | null {
    const storeKey = this.resolveStoreKey(handle);
    if (storeKey !== null) {
      const mappedIndex = this.orderByKey.get(storeKey);
      if (typeof mappedIndex === 'number') {
        return mappedIndex;
      }

      if (typeof storeKey === 'number') {
        return storeKey;
      }
    }

    return getHandleOrderIndex(handle);
  }

  private emitChange(
    storeKey: ChatPartStoreKey,
    partIndex: number,
    kind: PartChange['kind'],
  ): void {
    this.bumpRevision();
    this.changes$.next({
      storeKey,
      change: { partIndex, kind },
    });
  }

  private deleteStoreKey(storeKey: ChatPartStoreKey): void {
    const existed = this._store.has(storeKey)
      || this.orderByKey.has(storeKey)
      || [...this.keyByMsgIndex.values()].some(mappedKey => mappedKey === storeKey);
    this._store.delete(storeKey);
    this.orderByKey.delete(storeKey);

    for (const [msgIndex, mappedKey] of [...this.keyByMsgIndex.entries()]) {
      if (mappedKey === storeKey) {
        this.keyByMsgIndex.delete(msgIndex);
      }
    }

    if (existed) {
      this.bumpRevision();
    }
  }

  createDetachedHandle(label?: string | number): ChatPartStoreOpaqueHandle {
    return {
      storeKey: Symbol(label === undefined ? 'detached' : `detached:${String(label)}`),
    };
  }

  createResponseHandle(turnId: string, responseId?: string, itemId?: string): ChatPartStoreResponseHandle {
    return {
      kind: 'response',
      turnId,
      ...(responseId ? { responseId } : {}),
      ...(itemId ? { itemId } : {}),
    };
  }

  // ==================== 查询 ====================

  /** 获取指定消息的所有 Parts */
  private getParts(storeKey: ChatPartStoreKey): ChatPart[] {
    return this._store.get(storeKey) || [];
  }

  getPartsForIndexedHandle(handle: (ChatPartStoreHandleBase & { msgIndex: number }) | null): ChatPart[] {
    const storeKey = this.resolveStoreKey(handle);
    return storeKey !== null ? this.getParts(storeKey) : [];
  }

  getPartsForHandle(handle: ChatPartStoreReadableHandle | null): ChatPart[] {
    const storeKey = this.resolveStoreKey(handle);
    return storeKey !== null ? this.getParts(storeKey) : [];
  }

  getPartsForResponse(turnId: string): ChatPart[] {
    return this.getPartsForHandle(this.createResponseHandle(turnId));
  }

  /** 获取指定消息的最后一个 Part */
  private getLastPart(storeKey: ChatPartStoreKey): ChatPart | undefined {
    const parts = this._store.get(storeKey);
    return parts && parts.length > 0 ? parts[parts.length - 1] : undefined;
  }

  /** 获取指定消息的指定 Part */
  private getPart(storeKey: ChatPartStoreKey, partIndex: number): ChatPart | undefined {
    const parts = this._store.get(storeKey);
    return parts ? parts[partIndex] : undefined;
  }

  private getPartForHandle(handle: ChatPartStoreReadableHandle | null, partIndex: number): ChatPart | undefined {
    const storeKey = this.resolveStoreKey(handle);
    return storeKey !== null ? this.getPart(storeKey, partIndex) : undefined;
  }

  private findPartIndexByPartId(storeKey: ChatPartStoreKey, partId: string): number {
    const parts = this._store.get(storeKey);
    if (!parts || partId.trim().length === 0) {
      return -1;
    }

    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = parts[partIndex] as ChatPart & { partId?: string };
      if (part.partId === partId) {
        return partIndex;
      }
    }

    return -1;
  }

  /** 检查消息是否有 Parts */
  private hasParts(storeKey: ChatPartStoreKey): boolean {
    const parts = this._store.get(storeKey);
    return !!parts && parts.length > 0;
  }

  hasPartsForHandle(handle: ChatPartStoreReadableHandle | null): boolean {
    const storeKey = this.resolveStoreKey(handle);
    return storeKey !== null && this.hasParts(storeKey);
  }

  // ==================== 写入 ====================

  /** 添加新 Part 到消息末尾 */
  private addPart(storeKey: ChatPartStoreKey, part: ChatPart): number {
    let parts = this._store.get(storeKey);
    if (!parts) {
      parts = [];
      this._store.set(storeKey, parts);
    }
    const partIndex = parts.length;
    parts.push(part);
    this.emitChange(storeKey, partIndex, 'add');
    return partIndex;
  }

  addPartToHandle(handle: ChatPartStoreReadableHandle | null, part: ChatPart): number {
    const storeKey = this.resolveStoreKey(handle);
    if (storeKey === null) {
      return -1;
    }

    return this.addPart(storeKey, part);
  }

  upsertPartForResponse(turnId: string, part: ChatPart): boolean {
    const storeKey = this.resolveStoreKey(this.createResponseHandle(turnId));
    if (storeKey === null) {
      return false;
    }

    const partKey = getChatPartStableStoreKey(part);
    if (!partKey) {
      this.addPart(storeKey, part);
      return true;
    }

    const parts = this.getParts(storeKey);
    const existingIndex = parts.findIndex(candidate => getChatPartStableStoreKey(candidate) === partKey);
    if (existingIndex < 0) {
      this.addPart(storeKey, part);
      return true;
    }

    this.updatePart(storeKey, existingIndex, part);
    return true;
  }

  replacePartsForResponse(turnId: string, parts: readonly ChatPart[] | null | undefined): boolean {
    const handle = this.createResponseHandle(turnId);
    const storeKey = this.resolveStoreKey(handle);
    if (storeKey === null) {
      return false;
    }

    this.clearMessage(storeKey);
    if (!Array.isArray(parts) || parts.length === 0) {
      return true;
    }

    for (const part of parts) {
      this.addPart(storeKey, part);
    }
    return true;
  }

  upsertToolCallPartForHandle(
    handle: ChatPartStoreReadableHandle | null,
    next: {
      toolCallId: string;
      toolName: string;
      text: string;
      state: ToolCallPart['state'];
      args?: ToolCallPart['args'];
      metadata?: Record<string, unknown>;
      scope?: ChatPartScope;
    },
  ): boolean {
    const storeKey = this.resolveStoreKey(handle);
    if (storeKey === null || next.toolCallId.trim().length === 0) {
      return false;
    }

    const parts = this.getParts(storeKey);
    const existingIndex = parts.findIndex(part => part.type === 'tool_call' && part.toolCallId === next.toolCallId);
    const nextPart = mkToolCall(
      next.toolCallId,
      next.toolName,
      next.text,
      next.state,
      next.args,
      next.metadata,
      next.scope,
    );

    if (existingIndex < 0) {
      this.addPart(storeKey, nextPart);
      return true;
    }

    const existing = parts[existingIndex] as ToolCallPart;
    this.updatePart(storeKey, existingIndex, {
      ...existing,
      ...nextPart,
      partId: existing.partId || nextPart.partId,
      args: next.args !== undefined ? next.args : existing.args,
      metadata: next.metadata !== undefined ? mergeToolCallMetadata(existing, { metadata: next.metadata }) : existing.metadata,
    });
    return true;
  }

  upsertQuestionPartForHandle(
    handle: ChatPartStoreReadableHandle | null,
    requestId: string,
    questions: QuestionPart['questions'],
    scope?: ChatPartScope,
    metadata?: Record<string, unknown>,
  ): boolean {
    const storeKey = this.resolveStoreKey(handle);
    if (storeKey === null) {
      return false;
    }

    const nextPart = mkQuestion(questions, undefined, requestId, scope, metadata);
    const partId = nextPart.partId || '';
    const existingIndex = this.findPartIndexByPartId(storeKey, partId);
    if (existingIndex < 0) {
      this.addPart(storeKey, nextPart);
      return true;
    }

    const existing = this.getPart(storeKey, existingIndex);
    this.updatePart(storeKey, existingIndex, {
      ...nextPart,
      answers: existing?.type === 'question' ? existing.answers : undefined,
    });
    return true;
  }

  upsertConfirmationPartForHandle(
    handle: ChatPartStoreReadableHandle | null,
    askId: string,
    message: string,
    toolName?: string,
    source?: string,
    presentation?: Parameters<typeof mkConfirmation>[4],
  ): boolean {
    const storeKey = this.resolveStoreKey(handle);
    if (storeKey === null) {
      return false;
    }

    const nextPart = mkConfirmation(askId, message, toolName, source, presentation);
    const partId = nextPart.partId || '';
    const existingIndex = this.findPartIndexByPartId(storeKey, partId);
    if (existingIndex < 0) {
      this.addPart(storeKey, nextPart);
      return true;
    }

    const existing = this.getPart(storeKey, existingIndex);
    this.updatePart(storeKey, existingIndex, {
      ...nextPart,
      resolved: existing?.type === 'confirmation' ? existing.resolved : nextPart.resolved,
      result: existing?.type === 'confirmation' ? existing.result : nextPart.result,
      scope: existing?.type === 'confirmation' ? existing.scope : nextPart.scope,
    });
    return true;
  }

  upsertNoticePartForHandle(
    handle: ChatPartStoreReadableHandle | null,
    partId: string,
    message: string,
    severity: 'error' | 'warning' | 'info',
    metadata?: Record<string, unknown>,
    scope?: ChatPartScope,
  ): boolean {
    const storeKey = this.resolveStoreKey(handle);
    if (storeKey === null || partId.trim().length === 0) {
      return false;
    }

    const nextPart = {
      ...mkError(message, severity, withChatPartScopeMetadata(metadata, scope)),
      partId,
    };
    const existingIndex = this.findPartIndexByPartId(storeKey, partId);
    if (existingIndex < 0) {
      this.addPart(storeKey, nextPart);
      return true;
    }

    this.updatePart(storeKey, existingIndex, nextPart);
    return true;
  }

  upsertTerminalForHandle(
    handle: ChatPartStoreReadableHandle | null,
    terminal: TerminalPart,
  ): number {
    const storeKey = this.resolveStoreKey(handle);
    if (storeKey === null) {
      return -1;
    }

    const parts = this.getParts(storeKey);
    const terminalSessionKey = getTerminalSessionKey(terminal);
    const existingIndex = parts.findIndex(part => {
      if (part.type !== 'terminal') {
        return false;
      }
      const partSessionKey = getTerminalSessionKey(part);
      if (terminalSessionKey && partSessionKey === terminalSessionKey) {
        return true;
      }
      if (terminalSessionKey || partSessionKey) {
        return false;
      }
      return (!!terminal.toolCallId && part.toolCallId === terminal.toolCallId)
        || (!!terminal.partId && part.partId === terminal.partId);
    });

    if (existingIndex < 0) {
      return this.addPart(storeKey, normalizeTerminalLivePart(terminal));
    }

    const existing = parts[existingIndex] as TerminalPart;
    const replacesOutput = terminal.outputUpdateKind === 'snapshot';
    const output = replacesOutput
      ? appendTerminalLiveStream(undefined, terminal.output)
      : terminal.output
      ? appendTerminalLiveStream(existing.output, terminal.output)
      : existing.output;
    const stderr = replacesOutput
      ? appendTerminalLiveStream(undefined, terminal.stderr)
      : terminal.stderr
      ? appendTerminalLiveStream(existing.stderr, terminal.stderr)
      : existing.stderr;
    const sourceToolCallIds = mergeTerminalSourceToolCallIds(existing, terminal);
    this.updatePart(storeKey, existingIndex, {
      ...existing,
      ...terminal,
      partId: existing.partId || terminal.partId,
      command: terminal.command || existing.command,
      output,
      stderr,
      isRunning: terminal.isRunning,
      exitCode: terminal.exitCode,
      sourceToolCallIds,
      processId: terminal.processId || existing.processId,
      outputSessionId: terminal.outputSessionId || existing.outputSessionId,
      terminalId: terminal.terminalId || existing.terminalId,
      outputFilePath: terminal.outputFilePath || existing.outputFilePath,
      cwd: terminal.cwd || existing.cwd,
      status: terminal.status || existing.status,
      bytesTotal: terminal.bytesTotal ?? existing.bytesTotal,
      lastOutputAt: terminal.lastOutputAt || existing.lastOutputAt,
      outputUpdateKind: terminal.outputUpdateKind || existing.outputUpdateKind,
    });
    return existingIndex;
  }

  /** 在指定位置插入 Part。超出范围时追加到末尾。 */
  private insertPart(
    storeKey: ChatPartStoreKey,
    partIndex: number,
    part: ChatPart,
  ): number {
    let parts = this._store.get(storeKey);
    if (!parts) {
      parts = [];
      this._store.set(storeKey, parts);
    }

    const nextIndex = Math.max(0, Math.min(partIndex, parts.length));
    parts.splice(nextIndex, 0, part);
    this.emitChange(storeKey, nextIndex, 'add');
    return nextIndex;
  }

  private insertPartForHandle(handle: ChatPartStoreHandle | null, partIndex: number, part: ChatPart): number {
    const storeKey = this.resolveStoreKey(handle);
    if (storeKey === null) {
      return -1;
    }

    return this.insertPart(storeKey, partIndex, part);
  }

  /** 更新指定 Part（整体替换） */
  private updatePart(storeKey: ChatPartStoreKey, partIndex: number, part: ChatPart): void {
    const parts = this._store.get(storeKey);
    if (!parts || partIndex >= parts.length) return;
    parts[partIndex] = part;
    this.emitChange(storeKey, partIndex, 'update');
  }

  /**
   * 追加文本到最后一个 MarkdownPart。
   * 如果最后一个 Part 不是 MarkdownPart，则创建新的。
   * 返回受影响的 partIndex。
   */
  appendToMarkdown(storeKey: ChatPartStoreKey, text: string, scope?: ChatPartScope): number {
    let parts = this._store.get(storeKey);
    if (!parts) {
      parts = [];
      this._store.set(storeKey, parts);
    }

    const normalizedScope = normalizeChatPartScope(scope);
    const last = parts.length > 0 ? parts[parts.length - 1] : undefined;
    if (last && last.type === 'markdown' && isSameChatPartScope(last, normalizedScope)) {
      const idx = parts.length - 1;
      (last as MarkdownPart).content += text;
      this.emitChange(storeKey, idx, 'append');
      return idx;
    }

    // 创建新 MarkdownPart
    const idx = parts.length;
    parts.push(mkMarkdown(text, normalizedScope, buildScopedTextPartId('markdown', normalizedScope, idx)));
    this.emitChange(storeKey, idx, 'add');
    return idx;
  }

  appendToMarkdownHandle(handle: ChatPartStoreReadableHandle | null, text: string, scope?: ChatPartScope): number {
    const storeKey = this.resolveStoreKey(handle);
    if (storeKey === null) {
      return -1;
    }

    return this.appendToMarkdown(storeKey, text, scope);
  }

  appendToPlanHandle(handle: ChatPartStoreReadableHandle | null, text: string): number {
    const storeKey = this.resolveStoreKey(handle);
    if (storeKey === null) {
      return -1;
    }

    let parts = this._store.get(storeKey);
    if (!parts) {
      parts = [];
      this._store.set(storeKey, parts);
    }

    const last = parts.length > 0 ? parts[parts.length - 1] : undefined;
    if (last && last.type === 'plan' && last.status === 'streaming') {
      const idx = parts.length - 1;
      last.text += text;
      this.emitChange(storeKey, idx, 'append');
      return idx;
    }

    const idx = parts.length;
    parts.push(mkPlan(text, 'streaming', 'plan:proposed', { source: 'proposed_plan' }));
    this.emitChange(storeKey, idx, 'add');
    return idx;
  }

  upsertPlanPartForHandle(
    handle: ChatPartStoreReadableHandle | null,
    partId: string,
    textDelta: string,
    status: 'streaming' | 'completed' | 'failed',
    source: 'proposed_plan' | 'plan_file' | 'summary' = 'proposed_plan',
  ): boolean {
    const storeKey = this.resolveStoreKey(handle);
    if (storeKey === null) {
      return false;
    }

    let parts = this._store.get(storeKey);
    if (!parts) {
      parts = [];
      this._store.set(storeKey, parts);
    }

    const existingIndex = parts.findIndex(part => part.type === 'plan' && part.partId === partId);
    if (existingIndex < 0) {
      this.addPart(storeKey, mkPlan(textDelta, status, partId, { source }));
      return true;
    }

    const existing = parts[existingIndex];
    if (existing.type !== 'plan') {
      return false;
    }

    this.updatePart(storeKey, existingIndex, {
      ...existing,
      text: `${existing.text || ''}${textDelta || ''}`,
      status,
      source: existing.source || source,
    });
    return true;
  }

  completePlanPartForHandle(
    handle: ChatPartStoreReadableHandle | null,
    partId: string,
    status: 'completed' | 'failed' = 'completed',
  ): boolean {
    const storeKey = this.resolveStoreKey(handle);
    if (storeKey === null) {
      return false;
    }

    const parts = this._store.get(storeKey);
    if (!parts) {
      return false;
    }

    const partIndex = parts.findIndex(part => part.type === 'plan' && part.partId === partId);
    if (partIndex < 0) {
      return false;
    }

    const part = parts[partIndex];
    if (part.type !== 'plan') {
      return false;
    }

    this.updatePart(storeKey, partIndex, {
      ...part,
      status,
      text: part.text.trim(),
    });
    return true;
  }

  completePlanHandle(handle: ChatPartStoreReadableHandle | null): void {
    const storeKey = this.resolveStoreKey(handle);
    if (storeKey === null) {
      return;
    }

    const parts = this._store.get(storeKey);
    if (!parts) {
      return;
    }

    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = parts[partIndex];
      if (part.type === 'plan' && part.status === 'streaming') {
        this.updatePart(storeKey, partIndex, {
          ...part,
          status: 'completed',
          text: part.text.trim(),
        });
        return;
      }
    }
  }

  materializeFinalMarkdownAsPlanForHandle(handle: ChatPartStoreReadableHandle | null): boolean {
    const storeKey = this.resolveStoreKey(handle);
    if (storeKey === null) {
      return false;
    }

    const parts = this._store.get(storeKey);
    if (!parts || parts.some(part => part.type === 'plan')) {
      return false;
    }

    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = parts[partIndex];
      if (part.type !== 'markdown') {
        continue;
      }
      if (part.sourceAgentRole === 'subagent' || part.subAgentInvocationId || part.parentToolCallId) {
        continue;
      }
      const text = part.content.trim();
      if (!isLikelyPlanMarkdown(text)) {
        continue;
      }
      this.updatePart(storeKey, partIndex, mkPlan(text, 'completed', 'plan:fallback', { source: 'summary' }));
      return true;
    }

    return false;
  }

  /**
   * 追加文本到最后一个 ThinkingPart。
   * 如果最后一个 Part 不是 ThinkingPart，则创建新的。
   */
  appendToThinking(storeKey: ChatPartStoreKey, text: string, scope?: ChatPartScope): number {
    let parts = this._store.get(storeKey);
    if (!parts) {
      parts = [];
      this._store.set(storeKey, parts);
    }

    const normalizedScope = normalizeChatPartScope(scope);
    const last = parts.length > 0 ? parts[parts.length - 1] : undefined;
    if (last && last.type === 'thinking' && !last.isComplete && isSameChatPartScope(last, normalizedScope)) {
      const idx = parts.length - 1;
      (last as ThinkingPart).content += text;
      this.emitChange(storeKey, idx, 'append');
      return idx;
    }

    // 创建新 ThinkingPart（streaming，未完成）
    const idx = parts.length;
    parts.push(mkThinking(text, false, normalizedScope, buildScopedTextPartId('thinking', normalizedScope, idx)));
    this.emitChange(storeKey, idx, 'add');
    return idx;
  }

  appendToThinkingHandle(handle: ChatPartStoreReadableHandle | null, text: string, scope?: ChatPartScope): number {
    const storeKey = this.resolveStoreKey(handle);
    if (storeKey === null) {
      return -1;
    }

    return this.appendToThinking(storeKey, text, scope);
  }

  upsertTextPayloadPartForHandle(
    handle: ChatPartStoreReadableHandle | null,
    partId: string,
    payload: TextPayloadPartPatch,
    scope?: ChatPartScope,
  ): boolean {
    const storeKey = this.resolveStoreKey(handle);
    if (storeKey === null || partId.trim().length === 0) {
      return false;
    }

    const normalizedScope = normalizeChatPartScope(scope);
    const partIndex = this.findPartIndexByPartId(storeKey, partId);
    const existing = partIndex >= 0 ? this.getPart(storeKey, partIndex) : undefined;
    const text = payload.text ?? '';

    if (payload.contentKind === 'thinking') {
      const existingThinking = existing?.type === 'thinking' ? existing as ThinkingPart : undefined;
      const next: ThinkingPart = {
        type: 'thinking',
        partId,
        content: payload.contentRef && !text ? '' : `${existingThinking?.content || ''}${text}`,
        isComplete: existingThinking?.isComplete ?? false,
        ...(payload.contentRef ? { contentRef: payload.contentRef } : {}),
        ...(typeof payload.contentLength === 'number' ? { contentLength: payload.contentLength } : {}),
        ...normalizedScope,
      };
      if (partIndex >= 0) {
        this.updatePart(storeKey, partIndex, next);
      } else {
        this.addPart(storeKey, next);
      }
      return true;
    }

    const existingMarkdown = existing?.type === 'markdown' ? existing as MarkdownPart : undefined;
    const next: MarkdownPart = {
      type: 'markdown',
      partId,
      content: payload.contentRef && !text ? '' : `${existingMarkdown?.content || ''}${text}`,
      ...(payload.contentRef ? { contentRef: payload.contentRef } : {}),
      ...(typeof payload.contentLength === 'number' ? { contentLength: payload.contentLength } : {}),
      ...normalizedScope,
    };
    if (partIndex >= 0) {
      this.updatePart(storeKey, partIndex, next);
    } else {
      this.addPart(storeKey, next);
    }
    return true;
  }

  /**
   * 完成最后一个 ThinkingPart（设 isComplete = true）
   */
  completeThinking(storeKey: ChatPartStoreKey, scope?: ChatPartScope): void {
    const parts = this._store.get(storeKey);
    if (!parts) return;
    const normalizedScope = normalizeChatPartScope(scope);
    for (let i = parts.length - 1; i >= 0; i--) {
      const part = parts[i];
      if (part.type === 'thinking' && !part.isComplete && isSameChatPartScope(part, normalizedScope)) {
        part.isComplete = true;
        this.emitChange(storeKey, i, 'update');
        break;
      }
    }
  }

  completeThinkingHandle(handle: ChatPartStoreReadableHandle | null, scope?: ChatPartScope): void {
    const storeKey = this.resolveStoreKey(handle);
    if (storeKey === null) {
      return;
    }

    this.completeThinking(storeKey, scope);
  }

  /**
   * 更新 ToolCallPart 的状态和文本
   */
  private updateToolCall(
    storeKey: ChatPartStoreKey,
    toolCallId: string,
    state: ToolCallPart['state'],
    text: string,
  ): void {
    const parts = this._store.get(storeKey);
    if (!parts) return;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (p.type === 'tool_call' && p.toolCallId === toolCallId) {
        (p as ToolCallPart).state = state;
        (p as ToolCallPart).text = text;
        this.emitChange(storeKey, i, 'update');
        return;
      }
    }
  }

  private patchToolCall(
    storeKey: ChatPartStoreKey,
    toolCallId: string,
    patch: ToolCallPartPatch,
  ): boolean {
    const parts = this._store.get(storeKey);
    if (!parts) {
      return false;
    }

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part.type !== 'tool_call' || part.toolCallId !== toolCallId) {
        continue;
      }

      const nextMetadata = mergeToolCallMetadata(part, patch);
      const nextText = resolvePatchedToolCallText(part, patch, nextMetadata);

      const nextPart: ToolCallPart = {
        ...part,
        ...(patch.state != null ? { state: patch.state } : {}),
        text: nextText,
        ...(patch.args !== undefined ? { args: patch.args } : {}),
        ...(nextMetadata != null ? { metadata: nextMetadata } : {}),
      };

      this.updatePart(storeKey, i, nextPart);
      return true;
    }

    return false;
  }

  updateToolCallForHandle(
    handle: ChatPartStoreReadableHandle | null,
    toolCallId: string,
    state: ToolCallPart['state'],
    text: string,
  ): void {
    const storeKey = this.resolveStoreKey(handle);
    if (storeKey === null) {
      return;
    }

    this.updateToolCall(storeKey, toolCallId, state, text);
  }

  patchToolCallForHandle(
    handle: ChatPartStoreReadableHandle | null,
    toolCallId: string,
    patch: ToolCallPartPatch,
  ): boolean {
    const storeKey = this.resolveStoreKey(handle);
    if (storeKey === null) {
      return false;
    }

    return this.patchToolCall(storeKey, toolCallId, patch);
  }

  /** 更新 StatePart 的状态/文本 */
  private findStatePartIndex(storeKey: ChatPartStoreKey, stateId: string): number {
    const parts = this._store.get(storeKey);
    if (!parts) return -1;

    for (let i = parts.length - 1; i >= 0; i--) {
      const part = parts[i];
      if (part.type === 'state' && part.stateId === stateId) {
        return i;
      }
    }

    return -1;
  }

  private updateState(
    storeKey: ChatPartStoreKey,
    stateId: string,
    next: {
      state: StatePart['state'];
      text: string;
      progress?: number;
      kind?: StatePart['kind'];
      metadata?: Record<string, unknown>;
    },
  ): void {
    const parts = this._store.get(storeKey);
    if (!parts) return;
    const partIndex = this.findStatePartIndex(storeKey, stateId);
    if (partIndex < 0) {
      return;
    }

    const part = parts[partIndex] as StatePart;
    part.state = next.state;
    part.text = next.text;
    if ('progress' in next) {
      part.progress = next.progress;
    }
    if ('kind' in next) {
      part.kind = next.kind;
    }
    if ('metadata' in next) {
      part.metadata = next.metadata;
    }
    this.emitChange(storeKey, partIndex, 'update');
  }

  private upsertState(
    storeKey: ChatPartStoreKey,
    stateId: string,
    next: {
      state: StatePart['state'];
      text: string;
      progress?: number;
      kind?: StatePart['kind'];
      metadata?: Record<string, unknown>;
    },
  ): void {
    const partIndex = this.findStatePartIndex(storeKey, stateId);
    if (partIndex >= 0) {
      this.updateState(storeKey, stateId, next);
      return;
    }

    this.addPart(storeKey, mkState(
      stateId,
      next.text,
      next.state,
      next.kind,
      next.progress,
      next.metadata,
    ));
  }

  updateStateForHandle(
    handle: ChatPartStoreReadableHandle | null,
    stateId: string,
    next: {
      state: StatePart['state'];
      text: string;
      progress?: number;
      kind?: StatePart['kind'];
      metadata?: Record<string, unknown>;
    },
  ): void {
    const storeKey = this.resolveStoreKey(handle);
    if (storeKey === null) {
      return;
    }

    this.updateState(storeKey, stateId, next);
  }

  patchStateForHandle(
    handle: ChatPartStoreReadableHandle | null,
    stateId: string,
    patch: StatePartPatch,
  ): boolean {
    const storeKey = this.resolveStoreKey(handle);
    if (storeKey === null) {
      return false;
    }

    const parts = this._store.get(storeKey);
    if (!parts) {
      return false;
    }

    const partIndex = this.findStatePartIndex(storeKey, stateId);
    if (partIndex < 0) {
      return false;
    }

    const part = parts[partIndex] as StatePart;
    this.updatePart(storeKey, partIndex, {
      ...part,
      ...(patch.state != null ? { state: patch.state } : {}),
      ...(patch.text != null ? { text: patch.text } : {}),
      ...(patch.progress !== undefined ? { progress: patch.progress } : {}),
      ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
      ...(patch.metadata !== undefined ? { metadata: patch.metadata } : {}),
    });
    return true;
  }

  upsertStateForHandle(
    handle: ChatPartStoreReadableHandle | null,
    stateId: string,
    next: {
      state: StatePart['state'];
      text: string;
      progress?: number;
      kind?: StatePart['kind'];
      metadata?: Record<string, unknown>;
    },
  ): void {
    const storeKey = this.resolveStoreKey(handle);
    if (storeKey === null) {
      return;
    }

    this.upsertState(storeKey, stateId, next);
  }

  finalizeRunningPartsForHandle(
    handle: ChatPartStoreReadableHandle | null,
    options: { readonly status?: RunningPartFinalizeStatus } = {},
  ): void {
    const storeKey = this.resolveStoreKey(handle);
    if (storeKey === null) {
      return;
    }

    const parts = this._store.get(storeKey);
    if (!parts) {
      return;
    }

    for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
      const part = parts[partIndex];

      if (part.type === 'state' && part.state === 'doing') {
        this.updatePart(storeKey, partIndex, {
          ...part,
          state: options.status === 'error' ? 'error' : options.status === 'cancelled' ? 'warn' : 'done',
        });
        continue;
      }

      if (part.type === 'tool_call' && (part.state === 'doing' || part.state === 'pending_approval')) {
        const compatSubagent = isSubagentToolCallMetadata(part.metadata)
          ? toolCallPartToSubagentSnapshot(part)
          : null;
        const finalToolState: ToolCallPart['state'] = options.status === 'error'
          ? 'error'
          : options.status === 'cancelled'
            ? 'warn'
            : 'done';
        const finalizedApprovalMetadata = part.state === 'pending_approval'
          ? finalizePendingApprovalMetadata(part, options.status)
          : undefined;
        const finalText = finalizedApprovalMetadata
          ? resolvePatchedToolCallText(part, { state: finalToolState }, finalizedApprovalMetadata)
          : part.text;

        this.updatePart(
          storeKey,
          partIndex,
          compatSubagent
            ? {
              ...this.rebuildSubagentToolCallPart(part, {
                ...compatSubagent,
                state: options.status === 'error' ? 'error' : 'done',
                childItems: finalizeSubagentChildItems(compatSubagent.childItems, options.status),
              }, { appendTerminalEntry: true }),
              state: finalToolState,
              text: finalText,
              ...(finalizedApprovalMetadata ? { metadata: finalizedApprovalMetadata } : {}),
            }
            : {
              ...part,
              state: finalToolState,
              text: finalText,
              ...(finalizedApprovalMetadata ? { metadata: finalizedApprovalMetadata } : {}),
            },
        );
        continue;
      }

      if (part.type === 'thinking' && !part.isComplete) {
        this.updatePart(storeKey, partIndex, {
          ...part,
          isComplete: true,
        });
        continue;
      }

      if (part.type === 'terminal' && part.isRunning) {
        this.updatePart(storeKey, partIndex, {
          ...part,
          isRunning: false,
        });
        continue;
      }

      if (part.type === 'plan' && part.status === 'streaming') {
        this.updatePart(storeKey, partIndex, {
          ...part,
          status: options.status === 'error' ? 'failed' : 'completed',
          text: part.text.trim(),
        });
        continue;
      }

      if (part.type === 'question' && !part.answers) {
        this.updatePart(storeKey, partIndex, {
          ...part,
          answers: finalizeQuestionAnswers(part),
          isHistory: true,
          metadata: finalizeInteractionMetadata(part.metadata, options.status),
        });
        continue;
      }

      if (part.type === 'confirmation' && !part.resolved) {
        this.updatePart(storeKey, partIndex, {
          ...part,
          resolved: true,
          result: 'rejected',
          metadata: finalizeInteractionMetadata(part.metadata, options.status),
        });
        continue;
      }

    }
  }

  private updatePartForHandle(handle: ChatPartStoreReadableHandle | null, partIndex: number, part: ChatPart): void {
    const storeKey = this.resolveStoreKey(handle);
    if (storeKey === null) {
      return;
    }

    this.updatePart(storeKey, partIndex, part);
  }

  private rebuildSubagentToolCallPart(
    existing: ToolCallPart,
    compat: SubagentToolCallSnapshot,
    options: { appendTerminalEntry?: boolean } = {},
  ): ToolCallPart {
    const nextPart = subagentSnapshotToToolCall(compat, existing);
    const metadata = asRecord(nextPart.metadata) ?? {};
    const baseTimeline = asRecordArray(metadata['timeline'])
      .filter(entry => !String(entry['recordId'] || '').startsWith('child:'));
    const childTimeline = compat.childItems?.map((child, index) => buildSubagentChildTimelineEntry(child, index)) || [];
    const timeline = [...baseTimeline, ...childTimeline];

    if (options.appendTerminalEntry) {
      timeline.push(mkSubagentTimelineEntry({
        recordId: `${compat.toolCallId}:${compat.state}`,
        phase: compat.state === 'error' ? 'failed' : 'completed',
        summary: compat.description || compat.agentName,
        resultText: compat.resultText || undefined,
      }));
    }

    nextPart.metadata = {
      ...metadata,
      phase: compat.state === 'error' ? 'failed' : compat.state === 'done' ? 'completed' : 'started',
      timeline,
      toolSpecificData: {
        ...(asRecord(metadata['toolSpecificData']) ?? {}),
        kind: 'subagent',
        agentName: compat.agentName,
        description: compat.description,
        result: compat.resultText,
        ...((compat.childItems || []).length > 0
          ? { childItems: (compat.childItems || []).map(child => ({ ...child })) }
          : {}),
      },
    };
    nextPart.text = compat.description || existing.text || compat.agentName;

    return nextPart;
  }

  /**
   * 更新 subagent tool_call metadata 的状态和结果
   */
  private updateSubagent(
    storeKey: ChatPartStoreKey,
    toolCallId: string,
    state: SubagentToolCallSnapshot['state'],
    resultText: string,
  ): void {
    const parts = this._store.get(storeKey);
    if (!parts) return;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (p.type === 'tool_call' && p.toolCallId === toolCallId && isSubagentToolCallMetadata(p.metadata)) {
        const compat = toolCallPartToSubagentSnapshot(p);
        if (!compat) {
          return;
        }

        this.updatePart(
          storeKey,
          i,
          this.rebuildSubagentToolCallPart(p, { ...compat, state, resultText }, { appendTerminalEntry: true }),
        );
        return;
      }
    }
  }

  private findSubagentPartIndex(storeKey: ChatPartStoreKey, toolCallId: string): number {
    const parts = this._store.get(storeKey);
    if (!parts) return -1;

    for (let i = parts.length - 1; i >= 0; i--) {
      const part = parts[i];
      if (part.type === 'tool_call' && part.toolCallId === toolCallId && isSubagentToolCallMetadata(part.metadata)) {
        return i;
      }
    }

    return -1;
  }

  private upsertSubagentChildItem(
    storeKey: ChatPartStoreKey,
    toolCallId: string,
    child: SubagentChildItem,
  ): boolean {
    const startedAt = performance.now();
    let outcome = 'miss';
    let beforeCount = 0;
    let afterCount = 0;

    try {
      const parts = this._store.get(storeKey);
      if (!parts) return false;

      const partIndex = this.findSubagentPartIndex(storeKey, toolCallId);
      if (partIndex < 0) {
        return false;
      }

      const storePart = parts[partIndex];
      const compat = storePart.type === 'tool_call' && isSubagentToolCallMetadata(storePart.metadata)
        ? toolCallPartToSubagentSnapshot(storePart)
        : null;

      if (!compat) {
        return false;
      }

      const childItems = [...(compat.childItems || [])];
      beforeCount = childItems.length;
      afterCount = childItems.length;

      if (child.kind === 'tool' && child.toolCallId) {
        const existingIndex = childItems.findIndex(
          item => item.kind === 'tool' && item.toolCallId === child.toolCallId,
        );
        if (existingIndex >= 0) {
          childItems[existingIndex] = mergeSubagentToolChildItem(childItems[existingIndex], child);
          outcome = 'tool_update';
        } else {
          childItems.push(child);
          outcome = 'tool_add';
        }
        afterCount = childItems.length;
      } else if (appendSubagentTextChildInPlace(storePart as ToolCallPart, child)) {
        const updatedCompat = toolCallPartToSubagentSnapshot(storePart as ToolCallPart);
        afterCount = updatedCompat?.childItems?.length ?? beforeCount;
        outcome = 'text_append';
        this.emitChange(storeKey, partIndex, 'append');
        return true;
      } else {
        outcome = 'ignored';
        return false;
      }

      this.updatePart(
        storeKey,
        partIndex,
        this.rebuildSubagentToolCallPart(storePart as ToolCallPart, {
          ...compat,
          childItems,
        }),
      );
      return true;
    } finally {
      ChatPerformanceTracer.increment(`part_store.subagent_child_upsert.kind.${child.kind}`);
      ChatPerformanceTracer.recordDuration(
        'part_store.subagent_child_upsert',
        performance.now() - startedAt,
        `kind=${child.kind},outcome=${outcome},before=${beforeCount},after=${afterCount}`,
        { slowThresholdMs: 4 },
      );
    }
  }

  updateSubagentForHandle(
    handle: ChatPartStoreReadableHandle | null,
    toolCallId: string,
    state: SubagentToolCallSnapshot['state'],
    resultText: string,
  ): void {
    const storeKey = this.resolveStoreKey(handle);
    if (storeKey === null) {
      return;
    }

    this.updateSubagent(storeKey, toolCallId, state, resultText);
  }

  upsertSubagentForHandle(
    handle: ChatPartStoreReadableHandle | null,
    snapshot: SubagentToolCallSnapshot,
  ): boolean {
    const storeKey = this.resolveStoreKey(handle);
    if (storeKey === null || snapshot.toolCallId.trim().length === 0) {
      return false;
    }

    const parts = this._store.get(storeKey);
    if (!parts) {
      this.addPart(storeKey, subagentSnapshotToToolCall(snapshot));
      return true;
    }

    const partIndex = this.findSubagentPartIndex(storeKey, snapshot.toolCallId);
    if (partIndex < 0) {
      this.addPart(storeKey, subagentSnapshotToToolCall(snapshot));
      return true;
    }

    const existing = parts[partIndex];
    if (existing.type !== 'tool_call') {
      return false;
    }

    this.updatePart(storeKey, partIndex, this.rebuildSubagentToolCallPart(existing, snapshot, {
      appendTerminalEntry: snapshot.state !== 'doing',
    }));
    return true;
  }

  upsertSubagentChildItemForHandle(
    handle: ChatPartStoreReadableHandle | null,
    toolCallId: string,
    child: SubagentChildItem,
  ): boolean {
    const storeKey = this.resolveStoreKey(handle);
    if (storeKey === null) {
      return false;
    }

    return this.upsertSubagentChildItem(storeKey, toolCallId, child);
  }

  updateLatestRunningSubagentForHandle<T extends SubagentToolCallSnapshot>(
    handle: ChatPartStoreReadableHandle | null,
    update: (part: T) => T,
  ): T | null {
    const storeKey = this.resolveStoreKey(handle);
    if (storeKey === null) {
      return null;
    }

    const parts = this._store.get(storeKey);
    if (!parts) {
      return null;
    }

    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex--) {
      const part = parts[partIndex];
      if (part.type !== 'tool_call' || part.state !== 'doing' || !isSubagentToolCallMetadata(part.metadata)) {
        continue;
      }

      const compat = toolCallPartToSubagentSnapshot(part);
      if (!compat) {
        continue;
      }

      const nextPart = update({ ...compat } as T);
      this.updatePart(storeKey, partIndex, this.rebuildSubagentToolCallPart(part, nextPart));
      return nextPart;
    }

    return null;
  }

  updateQuestionAnswersForHandle(
    handle: ChatPartStoreReadableHandle | null,
    answers: QuestionPart['answers'],
    partId: string,
  ): boolean {
    const storeKey = this.resolveStoreKey(handle);
    if (storeKey === null) {
      return false;
    }

    const parts = this._store.get(storeKey);
    if (!parts) return false;
    if (partId.trim().length === 0) {
      return false;
    }

    for (let i = parts.length - 1; i >= 0; i--) {
      const part = parts[i];
      if (part.type !== 'question' || part.partId !== partId) continue;
      this.updatePart(storeKey, i, {
        ...(part as QuestionPart),
        answers,
      });
      return true;
    }
    return false;
  }

  updateConfirmationResultForHandle(
    handle: ChatPartStoreReadableHandle | null,
    partId: string,
    next: {
      resolved: boolean;
      result?: ConfirmationPart['result'];
      scope?: ConfirmationPart['scope'];
    },
  ): boolean {
    const storeKey = this.resolveStoreKey(handle);
    if (storeKey === null) {
      return false;
    }
    if (partId.trim().length === 0) {
      return false;
    }

    const parts = this._store.get(storeKey);
    if (!parts) return false;
    for (let i = parts.length - 1; i >= 0; i--) {
      const part = parts[i];
      if (part.type !== 'confirmation' || part.partId !== partId) continue;
      this.updatePart(storeKey, i, {
        ...(part as ConfirmationPart),
        resolved: next.resolved,
        result: next.result,
        scope: next.scope,
      });
      return true;
    }
    return false;
  }

  // ==================== 按 toolCallId 查找 ====================

  private findQuestionStoreKey(partId: string): ChatPartStoreKey | undefined {
    for (const [storeKey, parts] of this._store) {
      for (const p of parts) {
        if (p.type === 'question' && p.partId === partId) {
          return storeKey;
        }
      }
    }
    return undefined;
  }

  findQuestionOpaqueHandle(partId: string): ChatPartStoreOpaqueHandle | null {
    const storeKey = this.findQuestionStoreKey(partId);
    if (storeKey === undefined || typeof storeKey === 'number') {
      return null;
    }

    return { storeKey: storeKey as object | symbol };
  }

  private findConfirmationStoreKey(partId: string): ChatPartStoreKey | undefined {
    for (const [storeKey, parts] of this._store) {
      for (const p of parts) {
        if (p.type === 'confirmation' && p.partId === partId) {
          return storeKey;
        }
      }
    }
    return undefined;
  }

  findConfirmationOpaqueHandle(partId: string): ChatPartStoreOpaqueHandle | null {
    const storeKey = this.findConfirmationStoreKey(partId);
    if (storeKey === undefined || typeof storeKey === 'number') {
      return null;
    }

    return { storeKey: storeKey as object | symbol };
  }

  /** 查找包含指定 toolCallId 的消息句柄 */
  private findToolCallStoreKey(toolCallId: string): ChatPartStoreKey | undefined {
    for (const [storeKey, parts] of this._store) {
      for (const p of parts) {
        if (p.type === 'tool_call' && p.toolCallId === toolCallId) {
          return storeKey;
        }
      }
    }
    return undefined;
  }

  findToolCallOpaqueHandle(toolCallId: string): ChatPartStoreOpaqueHandle | null {
    const storeKey = this.findToolCallStoreKey(toolCallId);
    if (storeKey === undefined || typeof storeKey === 'number') {
      return null;
    }

    return { storeKey: storeKey as object | symbol };
  }

  // ==================== 生命周期 ====================

  /** 清除指定消息的 Parts */
  private clearMessage(storeKey: ChatPartStoreKey): void {
    if (this._store.delete(storeKey)) {
      this.bumpRevision();
    }
  }

  private collectStoreKeysAtOrAfter(msgIndex: number): ChatPartStoreKey[] {
    const keys = new Set<ChatPartStoreKey>();

    for (const [storeKey, orderIndex] of this.orderByKey.entries()) {
      if (orderIndex >= msgIndex) {
        keys.add(storeKey);
      }
    }

    return [...keys];
  }

  clearMessageHandle(handle: ChatPartStoreReadableHandle | null): void {
    const storeKey = this.resolveStoreKey(handle);
    if (storeKey === null) {
      return;
    }

    this.clearMessage(storeKey);
  }

  private clearMessagesAtOrAfter(msgIndex: number): number {
    let clearedCount = 0;

    for (const key of this.collectStoreKeysAtOrAfter(msgIndex)) {
      this.deleteStoreKey(key);
      clearedCount++;
    }

    return clearedCount;
  }

  shiftMessageIndexes(startIndex: number, delta: number): void {
    if (delta === 0 || startIndex < 0) {
      return;
    }

    const nextEntries = [...this.keyByMsgIndex.entries()]
      .sort((a, b) => delta > 0 ? b[0] - a[0] : a[0] - b[0]);
    let changed = false;

    for (const [msgIndex, storeKey] of nextEntries) {
      if (msgIndex < startIndex) {
        continue;
      }

      this.keyByMsgIndex.delete(msgIndex);
      const nextIndex = msgIndex + delta;
      if (nextIndex >= 0) {
        this.keyByMsgIndex.set(nextIndex, storeKey);
        this.orderByKey.set(storeKey, nextIndex);
      } else {
        this.orderByKey.delete(storeKey);
      }
      changed = true;
    }

    if (changed) {
      this.bumpRevision();
    }
  }

  clearMessagesAtOrAfterIndexedHandle(handle: (ChatPartStoreHandleBase & { msgIndex: number }) | null): number {
    if (!handle || typeof handle.msgIndex !== 'number' || handle.msgIndex < 0) {
      return 0;
    }

    return this.clearMessagesAtOrAfter(handle.msgIndex);
  }

  clearMessagesAtOrAfterHandle(handle: ChatPartStoreReadableHandle | null): number {
    const msgIndex = this.resolveHandleOrderIndex(handle);
    if (msgIndex === null) {
      return 0;
    }

    return this.clearMessagesAtOrAfter(msgIndex);
  }

  projectPartChangesFromHandle(
    sourceStore: ChatPartProjectionSourceStore,
    sourceHandle: ChatPartStoreOpaqueHandle | null,
    changes: readonly Pick<PartChange, 'partIndex'>[],
    targetHandle: ChatPartStoreReadableHandle | null,
    project: (part: ChatPart, existing?: ChatPart) => ChatPart,
  ): boolean {
    let changed = false;

    for (const change of changes) {
      const sourcePart = sourceStore.getPartsForHandle(sourceHandle)[change.partIndex];
      if (!sourcePart) {
        continue;
      }

      const existing = this.getPartForHandle(targetHandle, change.partIndex);
      const projected = project(sourcePart, existing);
      const currentParts = this.getPartsForHandle(targetHandle);

      if (!existing) {
        if (change.partIndex < currentParts.length) {
          this.insertPartForHandle(targetHandle, change.partIndex, projected);
        } else {
          this.addPartToHandle(targetHandle, projected);
        }
        changed = true;
        continue;
      }

      this.updatePartForHandle(targetHandle, change.partIndex, projected);
      changed = true;
    }

    return changed;
  }

  postProcessMarkdownForHandle(handle: ChatPartStoreReadableHandle | null): void {
    if (!isUsableChatPartStoreHandle(handle)) {
      return;
    }

    const patches = collectMarkdownPostProcessPatches(this.getPartsForHandle(handle));
    for (const patch of patches) {
      this.updatePartForHandle(handle, patch.partIndex, patch.nextPart);
    }
  }

  /** 重置所有数据 */
  reset(): void {
    this._store.clear();
    this.orderByKey.clear();
    this.keyByMsgIndex.clear();
    this.bumpRevision();
  }

  /** 销毁（关闭 Subject） */
  destroy(): void {
    this._store.clear();
    this.orderByKey.clear();
    this.keyByMsgIndex.clear();
    this.bumpRevision();
    this.changes$.complete();
  }

  // ==================== 序列化 ====================

  /**
   * 将 Parts 序列化为 content string（用于会话持久化）
   * 将 Part 模型转换回现有的 string 格式（<think>、aily-state 代码块等）
   */
  private serializeToContent(storeKey: ChatPartStoreKey): string {
    const parts = this._store.get(storeKey);
    if (!parts || parts.length === 0) return '';

    const segments: string[] = [];
    for (const part of parts) {
      switch (part.type) {
        case 'markdown':
          segments.push(part.content);
          break;
        case 'thinking':
          segments.push(`<think>${part.content}</think>`);
          break;
        case 'tool_call':
          segments.push(
            `\n\`\`\`aily-state\n${JSON.stringify({ state: part.state, text: part.text, id: part.toolCallId })}\n\`\`\`\n`
          );
          break;
        case 'state': {
          const payload: Record<string, unknown> = {
            displayKind: 'state',
            state: part.state,
            text: part.text,
            id: part.stateId,
          };
          if (part.kind) payload['kind'] = part.kind;
          if (part.progress != null) payload['progress'] = part.progress;
          if (part.metadata) payload['metadata'] = part.metadata;
          segments.push(`\n\`\`\`aily-state\n${JSON.stringify(payload)}\n\`\`\`\n`);
          break;
        }
        case 'error':
          segments.push(
            `\n\`\`\`aily-error\n${JSON.stringify({ message: part.message, ...(part.severity ? { severity: part.severity } : {}), ...(part.metadata ? { metadata: part.metadata } : {}) })}\n\`\`\`\n`
          );
          break;
        case 'question':
          segments.push(
            `\n\`\`\`aily-question\n${JSON.stringify({ questions: part.questions, answers: part.answers })}\n\`\`\`\n`
          );
          break;
        case 'confirmation':
          segments.push(
            `\n\`\`\`aily-confirmation\n${JSON.stringify({ askId: part.askId, partId: part.partId, title: part.title, subtitle: part.subtitle, message: part.message, description: part.description, args: part.args, toolName: part.toolName, source: part.source, actions: part.actions, primaryScope: part.primaryScope, resolved: part.resolved, result: part.result, scope: part.scope })}\n\`\`\`\n`
          );
          break;
        case 'terminal':
          segments.push(
            `\n\`\`\`aily-terminal\n${JSON.stringify({ partId: part.partId, command: part.command, output: part.output, stderr: part.stderr, exitCode: part.exitCode, isRunning: false, toolCallId: part.toolCallId, sourceToolCallIds: part.sourceToolCallIds, processId: part.processId, outputSessionId: part.outputSessionId, terminalId: part.terminalId, outputFilePath: part.outputFilePath, cwd: part.cwd, status: part.status, bytesTotal: part.bytesTotal, lastOutputAt: part.lastOutputAt })}\n\`\`\`\n`
          );
          break;
        case 'plan':
          segments.push(`\n<proposed_plan>\n${part.text}\n</proposed_plan>\n`);
          break;
      }
    }
    return segments.join('');
  }

  serializeToContentHandle(handle: ChatPartStoreReadableHandle | null): string {
    const storeKey = this.resolveStoreKey(handle);
    if (storeKey === null) {
      return '';
    }

    return this.serializeToContent(storeKey);
  }
}

class StoreChangeTracker implements ChatPartStoreChangeTracker {
  private readonly pendingChanges: TrackedPartChange[] = [];
  private readonly subscription;

  constructor(
    changes$: Subject<TrackedPartChange>,
    private readonly resolveHandleStoreKey: (handle: ChatPartStoreReadableHandle | null) => ChatPartStoreKey | null,
  ) {
    this.subscription = changes$.subscribe(change => {
      this.pendingChanges.push(change);
    });
  }

  private drainMatchedChanges(handle: ChatPartStoreReadableHandle | null): PartChange[] {
    if (!isUsableChatPartStoreHandle(handle)) {
      return [];
    }

    const drained: PartChange[] = [];
    const retained: TrackedPartChange[] = [];
    const resolvedStoreKey = this.resolveHandleStoreKey(handle);
    if (resolvedStoreKey === null) {
      return [];
    }

    for (const change of this.pendingChanges) {
      if (change.storeKey === resolvedStoreKey) {
        drained.push({
          partIndex: change.change.partIndex,
          kind: change.change.kind,
        });
      } else {
        retained.push(change);
      }
    }

    this.pendingChanges.length = 0;
    this.pendingChanges.push(...retained);
    return drained;
  }

  drainChangesForHandle(handle: ChatPartStoreReadableHandle | null): PartChange[] {
    return this.drainMatchedChanges(handle);
  }

  drainPartIndexChangesForHandle(handle: ChatPartStoreReadableHandle | null): Array<Pick<PartChange, 'partIndex'>> {
    return this.drainMatchedChanges(handle).map(change => ({ partIndex: change.partIndex }));
  }

  clear(): void {
    this.pendingChanges.length = 0;
  }

  dispose(): void {
    this.subscription.unsubscribe();
    this.pendingChanges.length = 0;
  }
}
