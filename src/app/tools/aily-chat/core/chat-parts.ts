/**
 * ChatPart — Part-based 消息模型类型定义
 *
 * Phase 1: ThinkingPart + ToolCallPart（最大性能收益）
 * Phase 2: QuestionPart + ConfirmationPart + TerminalPart（新渲染能力）
 *
 * 设计原则：
 *   - 每个 Part 是不可变快照（更新通过 store 重建）
 *   - discriminated union 通过 `type` 分发
 *   - 与现有 ChatMessage.content string 并行运行（双轨模式）
 */

import { normalizeToolApprovalPresentation, type ToolApprovalAction, type ToolApprovalScope } from '../helpers/tool-approval-ui';

// ==================== Phase 1 Part 类型 ====================

export interface ChatPartScope {
  /** Render origin. Subagent children remain first-class parts scoped to their parent invocation. */
  sourceAgentRole?: 'main' | 'subagent';
  /** Stable child invocation id aligned with Copilot ChatToolInvocationPart.subAgentInvocationId. */
  subAgentInvocationId?: string;
  /** Parent tool_call id that launched the scoped subagent. */
  parentToolCallId?: string;
  /** Optional producer order for future grouped projection without relying on content text. */
  sequence?: number;
}

/** Markdown 文本 Part（收集 think/tool 之外的普通文本） */
export interface MarkdownPart extends ChatPartScope {
  type: 'markdown';
  /** Stable renderer identity for streamed markdown blocks. */
  partId?: string;
  /** 累积的 markdown 文本 */
  content: string;
  /** Optional renderer-side external content reference for large live markdown blocks. */
  contentRef?: string;
  /** Current raw markdown content length when content is stored externally. */
  contentLength?: number;
}

/** 思考过程 Part — 替代 filterThinkTags + think-content-store */
export interface ThinkingPart extends ChatPartScope {
  type: 'thinking';
  /** Stable renderer identity for streamed reasoning blocks. */
  partId?: string;
  /** 思考内容原始文本 */
  content: string;
  /** Optional renderer-side external content reference for large live thinking blocks. */
  contentRef?: string;
  /** Current raw thinking content length when content is stored externally. */
  contentLength?: number;
  /** 是否已完成（未闭合的 think 块为 false） */
  isComplete: boolean;
}

/** 工具调用 Part — 替代 filterToolCalls + aily-state 代码块 */
export interface ToolCallPart {
  type: 'tool_call';
  /** 稳定 part identity，用于 turn-native 持久化与恢复 */
  partId?: string;
  /** 工具调用 ID */
  toolCallId: string;
  /** 工具名称 */
  toolName: string;
  /** 显示文本 */
  text: string;
  /** 工具调用参数 */
  args?: any;
  /** 调用状态 */
  state: 'doing' | 'done' | 'warn' | 'error' | 'pending_approval';
  /** 轻量元数据，供 restore/viewer 扩展使用 */
  metadata?: Record<string, unknown>;
  sourceAgentRole?: 'main' | 'subagent';
  subAgentInvocationId?: string;
  parentToolCallId?: string;
  sequence?: number;
}

/** 通用状态 Part — 承载任务图/调度/自治/协作团队等宿主状态 */
export interface StatePart {
  type: 'state';
  /** 状态项 ID（用于同一 turn 内增量更新） */
  stateId: string;
  /** 显示文本 */
  text: string;
  /** 状态样式 */
  state: 'doing' | 'done' | 'warn' | 'error' | 'info';
  /** 可选进度百分比 */
  progress?: number;
  /** 事件类型 */
  kind?: 'task_graph' | 'task_scheduler' | 'task_autonomy' | 'agent_team' | 'mcp' | 'background_task' | 'instructions' | 'provider_context_management' | 'handoff' | 'todo';
  /** 轻量元数据，供持久化/恢复使用 */
  metadata?: Record<string, unknown>;
}

/** 错误 Part */
export interface ErrorPart {
  type: 'error';
  /** Stable identity for canonical notice/error response parts. */
  partId?: string;
  message: string;
  severity?: 'error' | 'warning' | 'info';
  metadata?: Record<string, unknown>;
}

// ==================== Phase 2 Part 类型 ====================

/** 问题选项 */
export interface QuestionOption {
  label: string;
  description?: string;
  recommended?: boolean;
}

/** 单个问题定义 */
export interface QuestionItem {
  id?: string;
  header?: string;
  question: string;
  options?: QuestionOption[];
  allow_freeform?: boolean;
  multi_select?: boolean;
  allowFreeform?: boolean;
  allowFreeformInput?: boolean;
  multiSelect?: boolean;
}

/** 用户提问 Part — 替代 aily-question markdown 代码块 */
export interface QuestionPart extends ChatPartScope {
  type: 'question';
  /** 稳定 part identity，优先绑定 ask_user requestId */
  partId?: string;
  /** 问题列表 */
  questions: QuestionItem[];
  /** 用户回答（提交后填入） */
  answers?: Record<string, { selected: string[]; freeText: string | null; skipped: boolean }>;
  /** 是否来自历史记录 */
  isHistory?: boolean;
  metadata?: Record<string, unknown>;
}

/** 通用确认 Part — 对齐 Copilot standalone confirmation part 语义。 */
export interface ConfirmationPart extends ChatPartScope {
  type: 'confirmation';
  /** 稳定 part identity，绑定 generic confirmation requestId */
  partId?: string;
  /** 确认请求 ID */
  askId: string;
  /** 可选工具名称，仅用于展示来源 */
  toolName?: string;
  /** UI 标题 */
  title: string;
  /** UI 副标题（工具 ID / 来源） */
  subtitle?: string;
  /** 确认消息 */
  message: string;
  /** 附加详情，通常用于展示 diff 预览或补充说明。 */
  description?: string;
  /** 原始参数，供 viewer 做结构化展示 */
  args?: any;
  /** 消息来源 */
  source?: string;
  /** 可选动作列表 */
  actions: readonly ToolApprovalAction[];
  /** 主按钮对应的 scope */
  primaryScope: ToolApprovalScope;
  /** 是否已决定 */
  resolved: boolean;
  /** 结果：同意或拒绝 */
  result?: 'approved' | 'rejected';
  /** 可选范围（若 host 需要额外记住本次选择） */
  scope?: ToolApprovalScope;
  metadata?: Record<string, unknown>;
}

/** 终端命令输出 Part — Phase 2 新渲染能力 */
export interface TerminalPart extends ChatPartScope {
  type: 'terminal';
  /** 稳定 part identity，优先绑定命令会话身份 */
  partId?: string;
  /** 执行的命令 */
  command: string;
  /** 终端输出（累积） */
  output: string;
  /** 标准错误输出 */
  stderr?: string;
  /** 退出码 */
  exitCode?: number;
  /** 是否正在运行 */
  isRunning: boolean;
  /** 关联的工具调用 ID */
  toolCallId?: string;
  /** 触发/更新该命令会话的工具调用 ID 列表 */
  sourceToolCallIds?: string[];
  /** 命令进程 ID */
  processId?: string;
  /** 长输出会话 ID */
  outputSessionId?: string;
  /** 兼容旧终端 ID 或宿主终端 ID */
  terminalId?: string;
  /** 长输出文件路径 */
  outputFilePath?: string;
  /** 命令工作目录 */
  cwd?: string;
  /** 宿主返回的命令状态 */
  status?: string;
  /** 当前已记录输出字节数 */
  bytesTotal?: number;
  /** 最近输出时间 */
  lastOutputAt?: string;
  /** 输出更新语义：delta 追加，snapshot 替换当前窗口。 */
  outputUpdateKind?: 'delta' | 'snapshot';
  /** Lightweight invocation metadata, including approval state for terminal tools. */
  metadata?: Record<string, unknown>;
}

export interface TerminalPartOptions extends ChatPartScope {
  processId?: string;
  outputSessionId?: string;
  terminalId?: string;
  outputFilePath?: string;
  cwd?: string;
  status?: string;
  bytesTotal?: number;
  lastOutputAt?: string;
  sourceToolCallIds?: string[];
  outputUpdateKind?: 'delta' | 'snapshot';
  metadata?: Record<string, unknown>;
}

/**
 * Legacy 子Agent 内部结构化子项。
 *
 * New live subagent rendering must use first-class scoped ChatPart entries
 * (`sourceAgentRole='subagent'`, `subAgentInvocationId`, `parentToolCallId`).
 * This shape is kept only for old history restore/migration fallback.
 */
export interface SubagentChildItem {
  /** 子项类型：thinking=思考, tool=工具调用, text=文本输出, question=子代理提问 */
  kind: 'thinking' | 'tool' | 'text' | 'question';
  /** 内容（thinking 文本 / markdown 文本 / question 文本） */
  content: string;
  /** 工具名称（仅 kind='tool'） */
  contentRef?: string;
  contentKind?: 'markdown' | 'thinking';
  contentLength?: number;
  toolName?: string;
  /** 工具调用ID（仅 kind='tool'） */
  toolCallId?: string;
  /** 工具参数摘要（仅 kind='tool'） */
  argsSummary?: string;
  /** 工具执行状态（仅 kind='tool'） */
  state?: 'doing' | 'done' | 'error';
  /** 工具执行耗时，秒（仅 kind='tool', state='done'|'error'） */
  duration?: number;
}

/** 子Agent tool_call metadata 的临时投影视图。 */
export interface SubagentToolCallSnapshot {
  /** 工具调用 ID */
  toolCallId: string;
  /** Grouping id for one subagent invocation. */
  subAgentInvocationId?: string;
  /** 子Agent 名称（如 'Explore', 'Plan'） */
  agentName: string;
  /** 任务简述 */
  description: string;
  /** 执行状态 */
  state: 'doing' | 'done' | 'error';
  /** 子Agent 返回的结果文本（兼容/序列化用） */
  resultText: string;
  /**
   * Legacy child items for old history restore/migration only.
   *
   * Do not write live child output here. Live child thinking/text/tool output
   * is represented as first-class scoped parts associated by `subAgentInvocationId`.
   */
  childItems?: SubagentChildItem[];
  /** 轻量元数据，供 restore/viewer 扩展使用 */
  metadata?: Record<string, unknown>;
  /** 子工具起始时间缓存，仅 bridge 内部维护 */
  _toolTimers?: Record<string, unknown>;
}

export function normalizeSubagentToolCallState(value: unknown): SubagentToolCallSnapshot['state'] {
  if (value === 'done'
    || value === 'completed'
    || value === 'complete'
    || value === 'success'
    || value === 'succeeded') {
    return 'done';
  }
  if (value === 'error'
    || value === 'failed'
    || value === 'failure'
    || value === 'cancelled'
    || value === 'canceled'
    || value === 'stopped') {
    return 'error';
  }
  return 'doing';
}

export interface PlanStep {
  id: string;
  text: string;
  status?: 'pending' | 'inProgress' | 'completed';
}

export interface PlanPart extends ChatPartScope {
  type: 'plan';
  partId?: string;
  status: 'streaming' | 'completed' | 'failed';
  text: string;
  steps?: readonly PlanStep[];
  assumptions?: readonly string[];
  verification?: readonly string[];
  source?: 'proposed_plan' | 'plan_file' | 'summary';
}

// ==================== 联合类型 ====================

/** 支持的 Part 类型联合 */
export type ChatPart =
  | MarkdownPart | ThinkingPart | ToolCallPart | StatePart | ErrorPart
  | QuestionPart | ConfirmationPart | TerminalPart | PlanPart;

// ==================== Part 辅助函数 ====================

export function normalizeChatPartScope(scope: ChatPartScope | null | undefined): ChatPartScope | undefined {
  if (!scope) {
    return undefined;
  }

  const normalized: ChatPartScope = {};
  if (scope.sourceAgentRole === 'main' || scope.sourceAgentRole === 'subagent') {
    normalized.sourceAgentRole = scope.sourceAgentRole;
  }
  if (typeof scope.subAgentInvocationId === 'string' && scope.subAgentInvocationId.trim().length > 0) {
    normalized.subAgentInvocationId = scope.subAgentInvocationId;
  }
  if (typeof scope.parentToolCallId === 'string' && scope.parentToolCallId.trim().length > 0) {
    normalized.parentToolCallId = scope.parentToolCallId;
  }
  if (typeof scope.sequence === 'number' && Number.isFinite(scope.sequence)) {
    normalized.sequence = scope.sequence;
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function chatPartScopeOf(part: ChatPart | null | undefined): ChatPartScope | undefined {
  if (!part) {
    return undefined;
  }

  const directScope = normalizeChatPartScope(part as ChatPartScope);
  if (directScope) {
    return directScope;
  }

  if ('metadata' in part) {
    const metadata = asRecord(part.metadata);
    return normalizeChatPartScope(metadata)
      ?? normalizeChatPartScope(asRecord(metadata?.['scope']));
  }

  return undefined;
}

export function getSubAgentInvocationId(part: ChatPart | null | undefined): string | undefined {
  return chatPartScopeOf(part)?.subAgentInvocationId;
}

export function getParentToolCallId(part: ChatPart | null | undefined): string | undefined {
  return chatPartScopeOf(part)?.parentToolCallId;
}

export function isSubagentChildPart(part: ChatPart | null | undefined): boolean {
  if (part?.type === 'tool_call' && isSubagentToolCallMetadata(part.metadata)) {
    return false;
  }

  const scope = chatPartScopeOf(part);
  return scope?.sourceAgentRole === 'subagent'
    || typeof scope?.subAgentInvocationId === 'string'
    || typeof scope?.parentToolCallId === 'string';
}

export function isSameChatPartScope(a: ChatPartScope | null | undefined, b: ChatPartScope | null | undefined): boolean {
  const left = normalizeChatPartScope(a);
  const right = normalizeChatPartScope(b);
  return (left?.sourceAgentRole ?? 'main') === (right?.sourceAgentRole ?? 'main')
    && (left?.subAgentInvocationId ?? '') === (right?.subAgentInvocationId ?? '')
    && (left?.parentToolCallId ?? '') === (right?.parentToolCallId ?? '');
}

export function withChatPartScopeMetadata(
  metadata: Record<string, unknown> | undefined,
  scope: ChatPartScope | null | undefined,
): Record<string, unknown> | undefined {
  const normalized = normalizeChatPartScope(scope);
  if (!normalized) {
    return metadata;
  }

  return {
    ...(metadata ?? {}),
    sourceAgentRole: normalized.sourceAgentRole,
    subAgentInvocationId: normalized.subAgentInvocationId,
    parentToolCallId: normalized.parentToolCallId,
    sequence: normalized.sequence,
  };
}

/** 创建 MarkdownPart */
export function mkMarkdown(content: string, scope?: ChatPartScope, partId?: string): MarkdownPart {
  return { type: 'markdown', partId, content, ...normalizeChatPartScope(scope) };
}

/** 创建 ThinkingPart */
export function mkThinking(content: string, isComplete: boolean, scope?: ChatPartScope, partId?: string): ThinkingPart {
  return { type: 'thinking', partId, content, isComplete, ...normalizeChatPartScope(scope) };
}

/** 创建 ToolCallPart */
export function mkToolCall(
  toolCallId: string, toolName: string, text: string,
  state: ToolCallPart['state'], args?: any, metadata?: Record<string, unknown>,
  scope?: ChatPartScope,
): ToolCallPart {
  const normalizedScope = normalizeChatPartScope(scope);
  return {
    type: 'tool_call',
    partId: buildToolCallPartId(toolCallId),
    toolCallId,
    toolName,
    text,
    state,
    args,
    metadata: normalizedScope ? withChatPartScopeMetadata(metadata, normalizedScope) : metadata,
    ...normalizedScope,
  };
}

/** 创建 StatePart */
export function mkState(
  stateId: string,
  text: string,
  state: StatePart['state'],
  kind?: StatePart['kind'],
  progress?: number,
  metadata?: Record<string, unknown>,
): StatePart {
  return { type: 'state', stateId, text, state, kind, progress, metadata };
}

/** 创建 ErrorPart */
export function mkError(
  message: string,
  severity: ErrorPart['severity'] = 'error',
  metadata?: Record<string, unknown>,
): ErrorPart {
  return { type: 'error', message, severity, metadata };
}

/** 创建 QuestionPart */
export function mkQuestion(
  questions: QuestionItem[],
  isHistory?: boolean,
  requestId?: string,
  scope?: ChatPartScope,
  metadata?: Record<string, unknown>,
): QuestionPart {
  const normalizedScope = normalizeChatPartScope(scope);
  return {
    type: 'question',
    partId: buildQuestionPartId(questions, requestId),
    questions,
    isHistory,
    metadata: withChatPartScopeMetadata(metadata, normalizedScope),
    ...normalizedScope,
  };
}

/** 创建 ConfirmationPart */
export function mkConfirmation(
  askId: string,
  message: string,
  toolName?: string,
  source?: string,
  presentation?: Partial<Pick<ConfirmationPart, 'title' | 'subtitle' | 'description' | 'actions' | 'primaryScope' | 'args' | 'metadata'>> & ChatPartScope,
): ConfirmationPart {
  const normalizedScope = normalizeChatPartScope(presentation);
  const normalized = normalizeToolApprovalPresentation({
    toolName,
    source,
    title: presentation?.title,
    subtitle: presentation?.subtitle,
    message,
    actions: presentation?.actions,
    primaryScope: presentation?.primaryScope,
    args: presentation?.args,
  });
  return {
    type: 'confirmation',
    partId: buildConfirmationPartId(askId),
    askId,
    message: normalized.message,
    description: presentation?.description,
    args: normalized.args,
    toolName,
    title: normalized.title,
    subtitle: normalized.subtitle,
    source,
    actions: normalized.actions,
    primaryScope: normalized.primaryScope,
    resolved: false,
    metadata: withChatPartScopeMetadata(presentation?.metadata, normalizedScope),
    ...normalizedScope,
  };
}

/** 创建 TerminalPart */
export function mkTerminal(
  command: string,
  toolCallId?: string,
  partId?: string,
  options: TerminalPartOptions = {},
): TerminalPart {
  const sessionId = getTerminalSessionId(options);
  const sourceToolCallIds = uniqueStrings([
    ...(toolCallId ? [toolCallId] : []),
    ...(options.sourceToolCallIds ?? []),
  ]);
  const scope = normalizeChatPartScope(options);
  return {
    type: 'terminal',
    partId: partId ?? buildTerminalPartId(command, toolCallId, sessionId),
    command,
    output: '',
    isRunning: true,
    toolCallId,
    ...(sourceToolCallIds.length > 0 ? { sourceToolCallIds } : {}),
    ...(options.processId ? { processId: options.processId } : {}),
    ...(options.outputSessionId ? { outputSessionId: options.outputSessionId } : {}),
    ...(options.terminalId ? { terminalId: options.terminalId } : {}),
    ...(options.outputFilePath ? { outputFilePath: options.outputFilePath } : {}),
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.status ? { status: options.status } : {}),
    ...(typeof options.bytesTotal === 'number' ? { bytesTotal: options.bytesTotal } : {}),
    ...(options.lastOutputAt ? { lastOutputAt: options.lastOutputAt } : {}),
    ...(options.outputUpdateKind ? { outputUpdateKind: options.outputUpdateKind } : {}),
    ...(options.metadata ? { metadata: options.metadata } : {}),
    ...scope,
  };
}

export function mkPlan(
  text: string,
  status: PlanPart['status'] = 'completed',
  partId = 'plan:proposed',
  options: Partial<Pick<PlanPart, 'steps' | 'assumptions' | 'verification' | 'source'>> & {
    readonly scope?: ChatPartScope;
  } = {},
): PlanPart {
  const scope = normalizeChatPartScope(options.scope);
  return {
    type: 'plan',
    partId,
    status,
    text,
    ...(options.steps ? { steps: options.steps } : {}),
    ...(options.assumptions ? { assumptions: options.assumptions } : {}),
    ...(options.verification ? { verification: options.verification } : {}),
    ...(options.source ? { source: options.source } : {}),
    ...(scope ? scope : {}),
  };
}

export function isLikelyPlanMarkdown(value: string): boolean {
  const text = value.trim();
  if (!text) {
    return false;
  }

  const headingMatches = text.match(/^\s{0,3}#{1,6}\s+\S.+$/gm) ?? [];
  const orderedListMatches = text.match(/^\s*\d+[.)、]\s+\S.+$/gm) ?? [];
  const bulletListMatches = text.match(/^\s*[-*]\s+\S.+$/gm) ?? [];
  const hasPlanHeading = /^\s{0,3}#{1,6}\s+.*(?:plan|方案|计划|设计|实施|implementation).*$/gim.test(text);
  const sectionTerms = [
    /硬件需求|组件|连线|引脚|pinmap|board|library|constraints?/i,
    /实施步骤|实现步骤|steps?|approach|architecture/i,
    /验证|测试|build|flash|verification/i,
    /风险|安全|回滚|rollback|safety/i,
    /假设|assumptions?/i,
  ];
  const matchedSections = sectionTerms.reduce((count, pattern) => count + (pattern.test(text) ? 1 : 0), 0);
  const hasListStructure = orderedListMatches.length >= 2 || bulletListMatches.length >= 3;
  const hasSectionStructure = headingMatches.length >= 2 || matchedSections >= 2;

  if (hasPlanHeading && (hasListStructure || hasSectionStructure)) {
    return true;
  }

  return matchedSections >= 3 && (hasListStructure || headingMatches.length >= 1);
}

function normalizeQuestionIdentitySeed(questions: readonly QuestionItem[]): string {
  return questions
    .map(question => question.question.trim())
    .filter(question => question.length > 0)
    .join('|') || 'unknown';
}

export function buildToolCallPartId(toolCallId: string): string {
  return `tool:${toolCallId}`;
}

export function buildQuestionPartId(questions: readonly QuestionItem[], requestId?: string): string {
  return requestId && requestId.trim().length > 0
    ? `question:${requestId}`
    : `question:${normalizeQuestionIdentitySeed(questions)}`;
}

export function buildConfirmationPartId(askId: string): string {
  return `confirmation:${askId}`;
}

export function buildTerminalPartId(command: string, toolCallId?: string, sessionId?: string): string {
  return sessionId && sessionId.trim().length > 0
    ? `terminal-session:${sessionId.trim()}`
    : toolCallId && toolCallId.trim().length > 0
    ? `terminal:${toolCallId}`
    : `terminal:${command.trim() || 'unknown'}`;
}

export function buildScopedTextPartId(
  kind: 'markdown' | 'thinking',
  scope: ChatPartScope | null | undefined,
  localIndex: number,
): string {
  const normalized = normalizeChatPartScope(scope);
  const source = normalized?.sourceAgentRole === 'subagent' ? 'subagent' : 'main';
  const invocation = normalized?.subAgentInvocationId || normalized?.parentToolCallId || 'root';
  const sequence = typeof normalized?.sequence === 'number' && Number.isFinite(normalized.sequence)
    ? normalized.sequence
    : localIndex;
  return `${source}:${invocation}:${kind}:${sequence}`;
}

function getTerminalSessionId(options: Pick<TerminalPartOptions, 'processId' | 'outputSessionId' | 'terminalId'>): string | undefined {
  return asString(options.processId) || asString(options.outputSessionId) || asString(options.terminalId);
}

function uniqueStrings(values: readonly (string | undefined)[]): string[] {
  return Array.from(new Set(values.map(value => asString(value)).filter((value): value is string => !!value)));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value
      .map(item => asRecord(item))
      .filter((item): item is Record<string, unknown> => !!item)
      .map(item => ({ ...item }))
    : [];
}

function cloneSubagentChildItems(childItems: readonly SubagentChildItem[] | undefined): SubagentChildItem[] {
  return Array.isArray(childItems)
    ? childItems.map(item => ({ ...item }))
    : [];
}

function stripLegacySubagentToolSpecificData(record: Record<string, unknown>): Record<string, unknown> {
  const { childItems: _childItems, _toolTimers: _toolTimers, ...rest } = record;
  return rest;
}

function subagentStateToToolState(state: SubagentToolCallSnapshot['state']): ToolCallPart['state'] {
  const normalized = normalizeSubagentToolCallState(state);
  return normalized === 'error' ? 'error' : normalized === 'done' ? 'done' : 'doing';
}

function subagentStateToNarrativePhase(state: SubagentToolCallSnapshot['state']): 'started' | 'completed' | 'failed' {
  const normalized = normalizeSubagentToolCallState(state);
  return normalized === 'error' ? 'failed' : normalized === 'done' ? 'completed' : 'started';
}

export function mkSubagentTimelineEntry(entry: {
  recordId?: string;
  phase: 'started' | 'progress' | 'completed' | 'failed';
  summary?: string;
  resultText?: string;
  progress?: number;
  progressDetails?: Record<string, unknown>;
  timestamp?: number;
}): Record<string, unknown> {
  return {
    recordId: entry.recordId,
    phase: entry.phase,
    summary: entry.summary,
    resultText: entry.resultText,
    progress: entry.progress,
    progressDetails: entry.progressDetails,
    ...(typeof entry.timestamp === 'number' ? { timestamp: entry.timestamp } : {}),
  };
}

export function isSubagentToolCallMetadata(metadata: unknown): metadata is Record<string, unknown> {
  const record = asRecord(metadata);
  if (!record) {
    return false;
  }

  const toolSpecificData = asRecord(record['toolSpecificData']);
  return !!toolSpecificData && (
    toolSpecificData['kind'] === 'subagent'
    || typeof toolSpecificData['agentName'] === 'string'
    || typeof toolSpecificData['description'] === 'string'
  );
}

export function toolCallPartToSubagentSnapshot(part: ToolCallPart): SubagentToolCallSnapshot | null {
  if (!isSubagentToolCallMetadata(part.metadata)) {
    return null;
  }

  const metadata = asRecord(part.metadata) ?? {};
  const toolSpecificData = asRecord(metadata['toolSpecificData']) ?? {};
  const childItems = Array.isArray(toolSpecificData['childItems'])
    ? (toolSpecificData['childItems'] as unknown[])
      .map(item => asRecord(item))
      .filter((item): item is Record<string, unknown> => !!item)
      .map(item => ({
        kind: (item['kind'] as SubagentChildItem['kind']) || 'text',
        content: asString(item['content']) || '',
        contentRef: asString(item['contentRef']),
        contentKind: item['contentKind'] === 'thinking'
          ? 'thinking' as const
          : item['contentKind'] === 'markdown'
            ? 'markdown' as const
            : undefined,
        contentLength: typeof item['contentLength'] === 'number' ? item['contentLength'] : undefined,
        toolName: asString(item['toolName']),
        toolCallId: asString(item['toolCallId']),
        argsSummary: asString(item['argsSummary']),
        state: item['state'] as SubagentChildItem['state'],
        duration: typeof item['duration'] === 'number' ? item['duration'] : undefined,
      }))
    : [];

  return {
    toolCallId: part.toolCallId,
    subAgentInvocationId: asString(metadata['subAgentInvocationId']) || part.toolCallId,
    agentName: asString(toolSpecificData['agentName']) || part.toolName || 'Agent',
    description: asString(toolSpecificData['description'])
      || asString(metadata['argsSummary'])
      || asString(metadata['invocationMessage'])
      || asString(metadata['pastTenseMessage'])
      || part.toolName
      || 'Agent',
    state: normalizeSubagentToolCallState(part.state),
    resultText: asString(toolSpecificData['result']) || '',
    childItems,
    metadata,
    _toolTimers: asRecord(toolSpecificData['_toolTimers']),
  };
}

export function subagentSnapshotToToolCall(part: SubagentToolCallSnapshot, existing?: ToolCallPart): ToolCallPart {
  const existingMetadata = asRecord(existing?.metadata) ?? {};
  const partMetadata = asRecord(part.metadata) ?? {};
  const existingToolSpecificData = stripLegacySubagentToolSpecificData(asRecord(existingMetadata['toolSpecificData']) ?? {});
  const partToolSpecificData = stripLegacySubagentToolSpecificData(asRecord(partMetadata['toolSpecificData']) ?? {});
  const partTimeline = asRecordArray(partMetadata['timeline']);
  const existingTimeline = asRecordArray(existingMetadata['timeline']);
  const childItems = cloneSubagentChildItems(part.childItems);
  const timeline = partTimeline.length > 0
    ? partTimeline
    : existingTimeline.length > 0
      ? existingTimeline
      : [mkSubagentTimelineEntry({
        recordId: `${part.toolCallId}:${part.state}`,
        phase: subagentStateToNarrativePhase(part.state),
        summary: part.description || part.agentName,
        resultText: part.resultText || undefined,
      })];

  return {
    type: 'tool_call',
    partId: existing?.partId || buildToolCallPartId(part.toolCallId),
    toolCallId: part.toolCallId,
    toolName: existing?.toolName || 'agent',
    text: existing?.text || part.description || part.agentName,
    state: subagentStateToToolState(part.state),
    args: existing?.args ?? {
      agentName: part.agentName,
      description: part.description,
    },
    metadata: {
      ...existingMetadata,
      ...partMetadata,
      toolName: asString(partMetadata['toolName']) || asString(existingMetadata['toolName']) || existing?.toolName || 'agent',
      phase: subagentStateToNarrativePhase(part.state),
      argsSummary: part.description || asString(partMetadata['argsSummary']) || asString(existingMetadata['argsSummary']),
      recordId: part.toolCallId,
      subAgentInvocationId: part.subAgentInvocationId || part.toolCallId,
      invocationMessage: asString(partMetadata['invocationMessage']) || asString(existingMetadata['invocationMessage']) || part.description || part.agentName,
      pastTenseMessage: asString(partMetadata['pastTenseMessage']) || asString(existingMetadata['pastTenseMessage']) || (part.description ? `Completed Task: "${part.description}"` : part.agentName),
      timeline,
      toolSpecificData: {
        ...existingToolSpecificData,
        ...partToolSpecificData,
        kind: 'subagent',
        agentName: part.agentName,
        description: part.description,
        result: part.resultText,
        ...(childItems.length > 0 ? { childItems } : {}),
        ...(part._toolTimers ? { _toolTimers: part._toolTimers } : {}),
      },
    },
  };
}

export function mkSubagentToolCall(
  toolCallId: string,
  agentName: string,
  description: string,
  metadata?: Record<string, unknown>,
): ToolCallPart {
  const initialMetadata = asRecord(metadata) ?? {};
  const timeline = asRecordArray(initialMetadata['timeline']);

  return subagentSnapshotToToolCall({
    toolCallId,
    subAgentInvocationId: asString(initialMetadata['subAgentInvocationId']) || toolCallId,
    agentName,
    description,
    state: 'doing',
    resultText: '',
    childItems: [],
    metadata: {
      ...initialMetadata,
      timeline: timeline.length > 0
        ? timeline
        : [mkSubagentTimelineEntry({
          recordId: `${toolCallId}:started`,
          phase: 'started',
          summary: description || agentName,
        })],
    },
  });
}

// ==================== Part-based 消息扩展 ====================

/**
 * 带 Parts 的消息接口 — 扩展 ChatMessage
 * Phase 1 中仅新消息（通过 lex-stream 产生）会携带 parts，
 * 历史消息和 stream-processor 消息仍为 content-only。
 */
export interface ChatMessageWithParts {
  role: string;
  content: string;
  state: 'doing' | 'done';
  source?: string;
  modelName?: string;
  /** Part-based 渲染数据（仅 lex-stream 路径产生） */
  parts?: ChatPart[];
}
