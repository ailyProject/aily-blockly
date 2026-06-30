import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';

import {
  type HostSessionDebugCacheExplorerContent,
  type HostSessionDebugEvent,
  type HostSessionDebugModelTurnEvent,
  type HostSessionDebugResolvedEventContent,
  type HostSessionDebugResolvedModelTurnContent,
  type HostSessionDebugUserMessageEvent,
} from '../../services/host-session-debug-events';
import { ChatDebugBrowserService } from '../../services/chat-debug-browser.service';
import { AilyChatDebugBreadcrumbComponent } from '../aily-chat-debug-breadcrumb/aily-chat-debug-breadcrumb.component';

interface ChatDebugCacheGroup {
  readonly key: string;
  readonly label: string;
  readonly turns: readonly ChatDebugCacheGroupTurn[];
}

interface ChatDebugCacheGroupTurn {
  readonly index: number;
  readonly event: HostSessionDebugModelTurnEvent;
}

interface ChatDebugCacheResolvedTurn {
  readonly event: HostSessionDebugModelTurnEvent;
  readonly cache: HostSessionDebugCacheExplorerContent;
}

interface ChatDebugCacheSignatureSegment {
  readonly key: string;
  readonly label: string;
  readonly role: 'system' | 'tools' | 'user';
  readonly content: string;
  readonly charLength: number;
  readonly weight: number;
  readonly changed: boolean;
}

interface ChatDebugCacheComponentRow {
  readonly label: string;
  readonly previous?: string;
  readonly current?: string;
  readonly changed: boolean;
  readonly available: boolean;
}

interface ChatDebugCacheOptionRow {
  readonly key: string;
  readonly previous?: string;
  readonly current?: string;
  readonly changed: boolean;
}

interface ChatDebugCacheDiffSummary {
  readonly breakReason: string;
  readonly firstDifferenceLabel?: string;
  readonly identicalCount: number;
  readonly changedCount: number;
  readonly addedCount: number;
  readonly removedCount: number;
}

interface ChatDebugCacheComparison {
  readonly current: ChatDebugCacheResolvedTurn;
  readonly previous: ChatDebugCacheResolvedTurn | null;
  readonly previousSegments: readonly ChatDebugCacheSignatureSegment[];
  readonly currentSegments: readonly ChatDebugCacheSignatureSegment[];
  readonly requestOptionRows: readonly ChatDebugCacheOptionRow[];
  readonly componentRows: readonly ChatDebugCacheComponentRow[];
  readonly summary: ChatDebugCacheDiffSummary;
}

interface ChatDebugRawMessagePart {
  readonly type?: string;
  readonly content?: unknown;
  readonly name?: string;
  readonly id?: string;
  readonly status?: string;
  readonly tools?: unknown;
  readonly response?: unknown;
  readonly arguments?: unknown;
}

interface ChatDebugRawMessage {
  readonly role?: string;
  readonly name?: string;
  readonly parts?: readonly ChatDebugRawMessagePart[];
}

interface ChatDebugRequestShapeMetadata {
  readonly api?: string;
  readonly hasPreviousResponseId?: boolean;
  readonly inputItemTypes?: readonly string[];
}

@Component({
  selector: 'aily-chat-debug-cache',
  standalone: true,
  imports: [CommonModule, AilyChatDebugBreadcrumbComponent],
  templateUrl: './aily-chat-debug-cache.component.html',
  styleUrl: './aily-chat-debug-cache.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AilyChatDebugCacheExplorerComponent {
  private _events: readonly HostSessionDebugEvent[] = [];
  private modelTurns: readonly HostSessionDebugModelTurnEvent[] = [];

  @Input({ required: true }) sessionTitle = '';
  @Input({ required: true }) sessionId = '';
  @Input() sourceSessionId = '';
  @Input() importedAt = 0;
  @Input()
  set events(value: readonly HostSessionDebugEvent[]) {
    this._events = value;
    this.rebuildState();
  }

  get events(): readonly HostSessionDebugEvent[] {
    return this._events;
  }

  @Output() overviewRequested = new EventEmitter<void>();
  @Output() homeRequested = new EventEmitter<void>();
  @Output() closeRequested = new EventEmitter<void>();

  selectedIndex = -1;
  turnGroups: readonly ChatDebugCacheGroup[] = [];
  comparison: ChatDebugCacheComparison | null = null;

  constructor(
    private readonly debugBrowserService: ChatDebugBrowserService,
  ) {}

  selectTurn(index: number): void {
    if (index < 0 || index >= this.modelTurns.length || this.selectedIndex === index) {
      return;
    }

    this.selectedIndex = index;
    this.refreshComparison();
  }

  isSelected(index: number): boolean {
    return this.selectedIndex === index;
  }

  hasSystemGap(): boolean {
    return !!this.comparison
      && !this.comparison.current.cache.system
      && !this.comparison.previous?.cache.system;
  }

  formatCacheHit(event: HostSessionDebugModelTurnEvent): number {
    if (!event.inputTokens || event.inputTokens <= 0) {
      return 0;
    }

    return Math.round(((event.cachedTokens ?? 0) / event.inputTokens) * 100);
  }

  formatTokens(value: number | undefined): string {
    return typeof value === 'number' ? String(value) : '0';
  }

  private rebuildState(): void {
    this.modelTurns = this._events.filter((event): event is HostSessionDebugModelTurnEvent => event.kind === 'modelTurn');
    this.turnGroups = buildTurnGroups(this._events, this.modelTurns);

    if (this.modelTurns.length === 0) {
      this.selectedIndex = -1;
      this.comparison = null;
      return;
    }

    if (this.selectedIndex < 0 || this.selectedIndex >= this.modelTurns.length) {
      this.selectedIndex = this.modelTurns.length - 1;
    }

    this.refreshComparison();
  }

  private refreshComparison(): void {
    if (this.selectedIndex < 0 || this.selectedIndex >= this.modelTurns.length) {
      this.comparison = null;
      return;
    }

    const current = this.resolveTurn(this.modelTurns[this.selectedIndex]);
    const previous = this.selectedIndex > 0 ? this.resolveTurn(this.modelTurns[this.selectedIndex - 1]) : null;
    this.comparison = buildComparison(previous, current);
  }

  private resolveTurn(event: HostSessionDebugModelTurnEvent): ChatDebugCacheResolvedTurn {
    const resolved = this.debugBrowserService.resolveActiveImportedDebugEventContent(event.id);
    return {
      event,
      cache: resolveCacheExplorerContent(resolved),
    };
  }
}

function buildTurnGroups(
  events: readonly HostSessionDebugEvent[],
  modelTurns: readonly HostSessionDebugModelTurnEvent[],
): ChatDebugCacheGroup[] {
  const userMessages = new Map(
    events
      .filter((event): event is HostSessionDebugUserMessageEvent => event.kind === 'userMessage')
      .map(event => [event.id, event]),
  );
  const grouped = new Map<string, { label: string; turns: ChatDebugCacheGroupTurn[] }>();

  modelTurns.forEach((event, index) => {
    const parentPrompt = event.parentEventId ? userMessages.get(event.parentEventId) : undefined;
    const key = parentPrompt?.id ?? event.turnId;
    const label = parentPrompt?.message?.trim() || event.requestName || '未捕获请求';
    const group = grouped.get(key);
    if (group) {
      group.turns.push({ index, event });
      return;
    }

    grouped.set(key, {
      label,
      turns: [{ index, event }],
    });
  });

  return Array.from(grouped.entries()).map(([key, value]) => ({
    key,
    label: value.label,
    turns: value.turns,
  }));
}

function buildComparison(
  previous: ChatDebugCacheResolvedTurn | null,
  current: ChatDebugCacheResolvedTurn,
): ChatDebugCacheComparison {
  const previousBaseSegments = previous ? createSignatureSegments(previous.cache) : [];
  const currentBaseSegments = createSignatureSegments(current.cache);
  const maxLength = Math.max(previousBaseSegments.length, currentBaseSegments.length);
  const previousSegments: ChatDebugCacheSignatureSegment[] = [];
  const currentSegments: ChatDebugCacheSignatureSegment[] = [];
  let firstDifferenceLabel: string | undefined;
  let identicalCount = 0;
  let changedCount = 0;
  let addedCount = 0;
  let removedCount = 0;

  for (let index = 0; index < maxLength; index++) {
    const previousSegment = previousBaseSegments[index];
    const currentSegment = currentBaseSegments[index];
    const isSame = !!previousSegment
      && !!currentSegment
      && previousSegment.role === currentSegment.role
      && previousSegment.content === currentSegment.content;

    if (isSame) {
      identicalCount += 1;
    } else if (previousSegment && currentSegment) {
      changedCount += 1;
      firstDifferenceLabel ??= currentSegment.label;
    } else if (currentSegment) {
      addedCount += 1;
      firstDifferenceLabel ??= currentSegment.label;
    } else if (previousSegment) {
      removedCount += 1;
      firstDifferenceLabel ??= previousSegment.label;
    }

    if (previousSegment) {
      previousSegments.push({
        ...previousSegment,
        changed: !isSame,
      });
    }
    if (currentSegment) {
      currentSegments.push({
        ...currentSegment,
        changed: !isSame,
      });
    }
  }

  const requestOptionRows = buildRequestOptionRows(previous, current);
  const componentRows = buildComponentRows(previous, current);
  const summary = buildDiffSummary(previous, current, firstDifferenceLabel, identicalCount, changedCount, addedCount, removedCount, requestOptionRows);

  return {
    current,
    previous,
    previousSegments,
    currentSegments,
    requestOptionRows,
    componentRows,
    summary,
  };
}

function createSignatureSegments(content: HostSessionDebugCacheExplorerContent): ChatDebugCacheSignatureSegment[] {
  const segments: ChatDebugCacheSignatureSegment[] = [];
  if (content.system) {
    segments.push(createSegment('system', '系统', 'system', content.system));
  }
  if (content.tools) {
    segments.push(createSegment('tools', '工具', 'tools', content.tools));
  }
  for (const [index, message] of content.inputMessages.entries()) {
    segments.push(createSegment(`message-${index}`, message.label, message.role, message.content, message.charLength));
  }

  return segments;
}

function createSegment(
  key: string,
  label: string,
  role: 'system' | 'tools' | 'user',
  content: string,
  charLength?: number,
): ChatDebugCacheSignatureSegment {
  const length = typeof charLength === 'number' && charLength > 0 ? charLength : Math.max(content.length, 1);
  return {
    key,
    label,
    role,
    content,
    charLength: length,
    weight: Math.max(length, 1),
    changed: false,
  };
}

function buildComponentRows(
  previous: ChatDebugCacheResolvedTurn | null,
  current: ChatDebugCacheResolvedTurn,
): ChatDebugCacheComponentRow[] {
  const currentShape = formatRequestShape(current.cache);
  const previousShape = previous ? formatRequestShape(previous.cache) : undefined;
  const currentInputMessages = formatInputMessages(current.cache);
  const previousInputMessages = previous ? formatInputMessages(previous.cache) : undefined;

  return [
    createComponentRow('系统', previous?.cache.system, current.cache.system),
    createComponentRow('工具', previous?.cache.tools, current.cache.tools),
    createComponentRow('请求形状', previousShape, currentShape, true),
    createComponentRow('输入消息', previousInputMessages, currentInputMessages, true),
  ];
}

function createComponentRow(
  label: string,
  previous: string | undefined,
  current: string | undefined,
  forceAvailable: boolean = false,
): ChatDebugCacheComponentRow {
  const previousValue = normalizeMultilineValue(previous);
  const currentValue = normalizeMultilineValue(current);
  const available = forceAvailable || !!previousValue || !!currentValue;
  return {
    label,
    previous: previousValue,
    current: currentValue,
    changed: (previousValue ?? '') !== (currentValue ?? ''),
    available,
  };
}

function normalizeMultilineValue(value: string | undefined): string | undefined {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || undefined;
}

function buildDiffSummary(
  previous: ChatDebugCacheResolvedTurn | null,
  current: ChatDebugCacheResolvedTurn,
  firstDifferenceLabel: string | undefined,
  identicalCount: number,
  changedCount: number,
  addedCount: number,
  removedCount: number,
  requestOptionRows: readonly ChatDebugCacheOptionRow[],
): ChatDebugCacheDiffSummary {
  const breakReason = previous
    ? resolveBreakReason(previous.cache, current.cache, firstDifferenceLabel, requestOptionRows)
    : '这是当前会话里的第一轮模型请求。';

  return {
    breakReason,
    firstDifferenceLabel,
    identicalCount,
    changedCount,
    addedCount,
    removedCount,
  };
}

function resolveBreakReason(
  previous: HostSessionDebugCacheExplorerContent,
  current: HostSessionDebugCacheExplorerContent,
  firstDifferenceLabel: string | undefined,
  requestOptionRows: readonly ChatDebugCacheOptionRow[],
): string {
  if ((previous.system ?? '') !== (current.system ?? '')) {
    return '系统提示发生变化。';
  }
  if ((previous.tools ?? '') !== (current.tools ?? '')) {
    return '工具定义发生变化。';
  }
  if (firstDifferenceLabel) {
    return `${firstDifferenceLabel}发生变化。`;
  }
  if (requestOptionRows.some(row => row.changed)) {
    return '请求选项发生变化。';
  }

  return '未检测到可见请求前缀差异。';
}

function buildRequestOptionRows(
  previous: ChatDebugCacheResolvedTurn | null,
  current: ChatDebugCacheResolvedTurn,
): ChatDebugCacheOptionRow[] {
  const previousOptions = previous ? resolveRequestOptions(previous) : {};
  const currentOptions = resolveRequestOptions(current);
  const keys = Array.from(new Set([...Object.keys(previousOptions), ...Object.keys(currentOptions)])).sort((left, right) => left.localeCompare(right));

  return keys.map((key) => {
    const previousValue = previousOptions[key];
    const currentValue = currentOptions[key];
    return {
      key,
      previous: formatRequestOptionValue(previousValue),
      current: formatRequestOptionValue(currentValue),
      changed: serializeRequestOptionValue(previousValue) !== serializeRequestOptionValue(currentValue),
    };
  });
}

function resolveRequestOptions(
  turn: ChatDebugCacheResolvedTurn,
): Record<string, unknown> {
  const parsedOptions = parseRequestOptions(turn.cache.requestOptions);
  return turn.event.model
    ? { model: turn.event.model, ...parsedOptions }
    : parsedOptions;
}

function parseRequestOptions(requestOptionsJson: string | undefined): Record<string, unknown> {
  if (!requestOptionsJson) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(requestOptionsJson);
  } catch {
    return {};
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }

  const flattened: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [nestedKey, nestedValue] of Object.entries(value as Record<string, unknown>)) {
        flattened[`${key}.${nestedKey}`] = nestedValue;
      }
      continue;
    }

    flattened[key] = value;
  }

  return flattened;
}

function serializeRequestOptionValue(value: unknown): string {
  if (value === undefined) {
    return '__undefined__';
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatRequestOptionValue(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatRequestShape(content: HostSessionDebugCacheExplorerContent): string {
  const lines = [content.requestShape.label];
  if (content.requestShape.description) {
    lines.push(content.requestShape.description);
  }
  if (content.requestShape.inputItemTypes.length > 0) {
    lines.push(`输入项: ${content.requestShape.inputItemTypes.join(', ')}`);
  }

  return lines.join('\n');
}

function formatInputMessages(content: HostSessionDebugCacheExplorerContent): string | undefined {
  if (content.inputMessages.length === 0) {
    return undefined;
  }

  return content.inputMessages
    .map(message => `[${message.label}]\n${message.content}`)
    .join('\n\n');
}

function resolveCacheExplorerContent(
  resolved: HostSessionDebugResolvedEventContent | null,
): HostSessionDebugCacheExplorerContent {
  const modelTurn = resolved?.kind === 'modelTurn'
    ? resolved as HostSessionDebugResolvedModelTurnContent
    : null;

  if (modelTurn?.sections) {
    const system = findSection(modelTurn.sections, 'System');
    const tools = findSection(modelTurn.sections, 'Tools');
    const requestShapeJson = findSection(modelTurn.sections, 'Request Shape');
    const requestOptions = modelTurn.requestOptions ?? findSection(modelTurn.sections, 'Request Options');
    const rawInputMessages = parseInputMessages(findSection(modelTurn.sections, 'Input Messages'));
    const inputMessages = stripLeadingSystemMessages(rawInputMessages, system);

    return {
      ...(system ? { system } : {}),
      ...(tools ? { tools } : {}),
      inputMessages,
      requestShape: describeRequestShape(inputMessages, requestShapeJson),
      ...(requestOptions ? { requestOptions } : {}),
    };
  }

  return {
    inputMessages: [],
    requestShape: {
      label: '未捕获请求形状',
      description: '导入快照没有保留这一轮的 request-side 结构化数据。',
      isContinuation: false,
      inputItemTypes: [],
    },
  };
}

function findSection(
  sections: ReadonlyArray<{ name: string; content: string }> | undefined,
  name: string,
): string | undefined {
  return sections?.find(section => section.name === name)?.content;
}

function parseInputMessages(inputMessagesJson: string | undefined): HostSessionDebugCacheExplorerContent['inputMessages'] {
  if (!inputMessagesJson) {
    return [];
  }

  let raw: unknown;
  try {
    raw = JSON.parse(inputMessagesJson);
  } catch {
    return [];
  }

  if (!Array.isArray(raw)) {
    return [];
  }

  const messages: Array<HostSessionDebugCacheExplorerContent['inputMessages'][number]> = [];
  for (const message of raw as readonly ChatDebugRawMessage[]) {
    if (!message || typeof message !== 'object') {
      continue;
    }

    let rawRole = typeof message.role === 'string' ? message.role : 'unknown';
    const name = typeof message.name === 'string' ? message.name : undefined;
    let content = '';
    let hasText = false;
    let hasToolResponse = false;
    let hasToolSearchOutput = false;

    if (Array.isArray(message.parts)) {
      for (const part of message.parts) {
        if (!part || typeof part !== 'object') {
          continue;
        }

        switch (part.type) {
          case undefined:
          case 'text':
          case 'reasoning':
            if (typeof part.content === 'string') {
              content += part.content;
              hasText = true;
            }
            break;
          case 'tool_call_response':
          case 'tool_result':
            content += stringifyUnknown(part.response ?? part.content);
            hasToolResponse = true;
            break;
          case 'tool_search_output':
            content += stringifyUnknown({
              id: part.id,
              status: part.status,
              tools: part.tools,
            });
            hasToolSearchOutput = true;
            break;
          case 'tool_call':
            if (typeof part.name === 'string' && part.name.trim().length > 0) {
              content += `call:${part.name}`;
            }
            if (part.arguments !== undefined) {
              content += stringifyUnknown(part.arguments);
            }
            break;
        }
      }
    }

    if (hasToolSearchOutput && !hasText) {
      rawRole = 'tool_search';
    } else if (hasToolResponse && !hasText) {
      rawRole = 'tool';
    }

    if (!content) {
      content = stringifyUnknown(message);
    }
    if (!content) {
      continue;
    }

    messages.push({
      role: toDisplayRole(rawRole),
      rawRole,
      label: createInputMessageLabel(rawRole, name),
      content,
      charLength: content.length,
    });
  }

  return messages;
}

function stripLeadingSystemMessages(
  inputMessages: HostSessionDebugCacheExplorerContent['inputMessages'],
  system: string | undefined,
): HostSessionDebugCacheExplorerContent['inputMessages'] {
  let stripFrom = 0;
  if (system) {
    while (stripFrom < inputMessages.length && inputMessages[stripFrom].rawRole === 'system') {
      stripFrom += 1;
    }
  }

  return stripFrom > 0 ? inputMessages.slice(stripFrom) : inputMessages;
}

function describeRequestShape(
  inputMessages: HostSessionDebugCacheExplorerContent['inputMessages'],
  requestShapeJson: string | undefined,
): HostSessionDebugCacheExplorerContent['requestShape'] {
  const metadata = parseRequestShapeMetadata(requestShapeJson);
  const inputItemTypes = Array.isArray(metadata?.inputItemTypes)
    ? metadata.inputItemTypes.filter((item): item is string => typeof item === 'string')
    : [];
  const rawRoles = inputMessages.map(message => message.rawRole ?? message.role);
  const hasPreviousResponseId = metadata?.hasPreviousResponseId === true;
  const hasToolSearchOutput = inputItemTypes.includes('tool_search_output') || rawRoles.some(role => role === 'tool_search');
  const hasOnlyToolOutput = rawRoles.length > 0 && rawRoles.every(role => role === 'tool');

  if (hasPreviousResponseId && hasToolSearchOutput) {
    return {
      label: 'tool_search_output 续跑',
      description: '这一轮只发送了 tool_search delta，前文由 previous response id 在服务端重建。',
      isContinuation: true,
      hasPreviousResponseId: true,
      inputItemTypes,
    };
  }

  if (hasPreviousResponseId && hasOnlyToolOutput) {
    return {
      label: '工具输出续跑',
      description: '这一轮只发送了工具输出 delta，前文由 previous response id 在服务端重建。',
      isContinuation: true,
      hasPreviousResponseId: true,
      inputItemTypes,
    };
  }

  if (hasPreviousResponseId) {
    return {
      label: '续跑请求',
      description: '这一轮只发送了增量输入，前文由 previous response id 在服务端重建。',
      isContinuation: true,
      hasPreviousResponseId: true,
      inputItemTypes,
    };
  }

  if (hasToolSearchOutput) {
    return {
      label: 'tool_search_output 请求',
      description: '检测到 tool_search_output 输入项，但没有 previous response continuation 标记。',
      isContinuation: false,
      inputItemTypes,
    };
  }

  if (hasOnlyToolOutput) {
    return {
      label: '工具输出请求',
      isContinuation: false,
      inputItemTypes,
    };
  }

  return {
    label: '完整输入请求',
    isContinuation: false,
    inputItemTypes,
  };
}

function parseRequestShapeMetadata(requestShapeJson: string | undefined): ChatDebugRequestShapeMetadata | undefined {
  if (!requestShapeJson) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(requestShapeJson) as ChatDebugRequestShapeMetadata;
    if (parsed && typeof parsed === 'object') {
      return parsed;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function createInputMessageLabel(rawRole: string, name: string | undefined): string {
  switch (rawRole) {
    case 'system':
      return '系统';
    case 'tool_search':
      return 'tool_search_output';
    case 'tool':
      return name ? `工具输出 · ${name}` : '工具输出';
    case 'assistant':
      return '助手消息';
    case 'user':
      return '用户请求';
    default:
      return name ? `${rawRole} · ${name}` : rawRole;
  }
}

function toDisplayRole(rawRole: string): 'system' | 'tools' | 'user' {
  switch (rawRole) {
    case 'system':
      return 'system';
    case 'tool':
    case 'tool_search':
    case 'tools':
      return 'tools';
    default:
      return 'user';
  }
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return value === undefined || value === null ? '' : String(value);
  }
}