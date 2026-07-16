import { ChatPart, MarkdownPart, getParentToolCallId, getSubAgentInvocationId, isSubagentChildPart } from '../../core/chat-parts';
import { isProgressMessageDisplayPart, type RenderableChatPart } from './chat-render-parts';
import {
  buildActivityGroupIdentity,
  buildSubagentActivityGroupIdentity,
  buildChatPartIdentity,
  isSubagentToolCall,
} from './chat-activity-group-projection';
import { ChatPerformanceTracer } from '../../services/chat-perf-tracer';
import {
  isInternalDiscoveryToolName,
  isTerminalSessionToolName,
  normalizeReadSideToolName,
} from '../../core/tool-name-normalizer';
import { storeThinkContent } from '../../core/think-content-store';

export interface PartRenderItem {
  kind: 'part';
  id: string;
  part: RenderableChatPart;
}

export interface ActivityGroupRenderItem {
  kind: 'group';
  id: string;
  parts: readonly ChatPart[];
  revision: string;
  live: boolean;
}

export type ChatRenderItem = PartRenderItem | ActivityGroupRenderItem;

export function buildChatRenderItems(
  parts: readonly RenderableChatPart[],
  doing: boolean,
): ChatRenderItem[] {
  const startedAt = performance.now();
  const baseItems = buildBaseRenderItems(parts);
  const items = markLiveActivityGroups(baseItems, doing);
  const groupCount = items.filter((item) => item.kind === 'group').length;
  const subagentGroupCount = items.filter((item) => item.kind === 'group'
    && item.parts.some((part) => isSubagentToolCall(part))).length;
  const scopedSubagentChildCount = countScopedSubagentChildren(parts);
  const legacyChildCount = countLegacySubagentChildren(parts);
  recordSubagentProjectionInvariant(items);

  ChatPerformanceTracer.recordDuration(
    'message_parts_projection',
    performance.now() - startedAt,
    `parts=${parts.length},items=${items.length},groups=${groupCount},subagentGroups=${subagentGroupCount},scopedChildren=${scopedSubagentChildCount},legacyChildren=${legacyChildCount},doing=${doing}`,
    { slowThresholdMs: 6 },
  );
  ChatPerformanceTracer.recordJankSnapshot('message_parts_projection', {
    parts: parts.length,
    items: items.length,
    groups: groupCount,
    subagentGroups: subagentGroupCount,
    scopedSubagentChildren: scopedSubagentChildCount,
    legacySubagentChildren: legacyChildCount,
    doing,
  });

  return items;
}

function recordSubagentProjectionInvariant(items: readonly ChatRenderItem[]): void {
  const topLevelScopedChildren = items
    .map((item, index) => ({ item, index }))
    .filter((entry): entry is { item: PartRenderItem; index: number } =>
      entry.item.kind === 'part'
      && !isProgressMessageDisplayPart(entry.item.part)
      && isSubagentChildPart(entry.item.part as ChatPart));
  const childOnlyGroups = items
    .map((item, index) => ({ item, index }))
    .filter((entry): entry is { item: ActivityGroupRenderItem; index: number } =>
      entry.item.kind === 'group'
      && entry.item.parts.some((part) => isSubagentChildPart(part))
      && !entry.item.parts.some((part) => isSubagentParentToolPart(part)));
  if (topLevelScopedChildren.length === 0 && childOnlyGroups.length === 0) {
    return;
  }

  console.warn('[AilyChat][SubagentProjectionInvariant]', {
    phase: topLevelScopedChildren.length > 0 ? 'top-level-scoped-child' : 'group-without-subagent-parent',
    children: topLevelScopedChildren.map(({ item, index }) => {
      const part = item.part as ChatPart;
      return {
        index,
        type: part.type,
        id: buildChatPartIdentity(part, index),
        subAgentInvocationId: getSubAgentInvocationId(part),
        parentToolCallId: getParentToolCallId(part),
        sourceAgentRole: 'sourceAgentRole' in part ? part.sourceAgentRole : undefined,
      };
    }),
    groups: childOnlyGroups.map(({ item, index }) => ({
      index,
      id: item.id,
      partCount: item.parts.length,
      children: item.parts
        .filter((part) => isSubagentChildPart(part))
        .map((part, partIndex) => ({
          partIndex,
          type: part.type,
          id: buildChatPartIdentity(part, partIndex),
          subAgentInvocationId: getSubAgentInvocationId(part),
          parentToolCallId: getParentToolCallId(part),
          sourceAgentRole: 'sourceAgentRole' in part ? part.sourceAgentRole : undefined,
        })),
    })),
  });
}

function buildBaseRenderItems(parts: readonly RenderableChatPart[]): ChatRenderItem[] {
  const items: ChatRenderItem[] = [];
  let buffer: ChatPart[] = [];
  let bufferStartIndex = -1;
  const terminalOwnedToolCallIds = collectTerminalOwnedToolCallIds(parts);
  const subagentGroups = new Map<string, {
    item: ActivityGroupRenderItem;
    parts: ChatPart[];
    startIndex: number;
  }>();

  const flushBuffer = (): void => {
    if (buffer.length >= 1) {
      items.push({
        kind: 'group',
        id: buildActivityGroupIdentity(buffer, Math.max(0, bufferStartIndex)),
        parts: buffer,
        revision: buildActivityGroupRevision(buffer),
        live: false,
      });
    }
    buffer = [];
    bufferStartIndex = -1;
  };

  const appendSubagentPart = (part: RenderableChatPart, index: number): boolean => {
    const subagentId = getSubagentGroupId(part);
    if (!subagentId) {
      return false;
    }

    flushBuffer();
    const chatPart = part as ChatPart;
    let group = subagentGroups.get(subagentId);
    if (!group) {
      const groupParts = [chatPart];
      const item: ActivityGroupRenderItem = {
        kind: 'group',
        id: buildSubagentActivityGroupIdentity(subagentId),
        parts: groupParts,
        revision: buildActivityGroupRevision(groupParts),
        live: false,
      };
      group = { item, parts: groupParts, startIndex: index };
      subagentGroups.set(subagentId, group);
      items.push(item);
      return true;
    }

    if (isSubagentParentToolPart(chatPart) && !group.parts.some(isSubagentParentToolPart)) {
      group.parts.unshift(chatPart);
    } else if (!group.parts.includes(chatPart)) {
      group.parts.push(chatPart);
    }

    group.item.revision = buildActivityGroupRevision(group.parts);
    return true;
  };

  for (let index = 0; index < parts.length; index += 1) {
    const part = normalizePartForProjection(parts[index], index);
    if (isIgnorablePart(part)) {
      continue;
    }

    if (isProgressMessageDisplayPart(part)) {
      flushBuffer();
      items.push({ kind: 'part', id: `progress:${part.progressKind}:${index}:${part.content}`, part });
      continue;
    }

    if (appendSubagentPart(part, index)) {
      continue;
    }

    if (isRuntimeToolCallPart(part)) {
      if (isToolCallOwnedByTerminalPart(part, terminalOwnedToolCallIds)) {
        continue;
      }
      if (shouldPinToolCallToThinking(part)) {
        if (buffer.length === 0) {
          bufferStartIndex = index;
        }
        buffer.push(part as ChatPart);
        const mermaidPart = buildSaveArchMermaidDisplayPart(part);
        if (mermaidPart) {
          flushBuffer();
          items.push({ kind: 'part', id: buildChatPartIdentity(mermaidPart, index), part: mermaidPart });
        }
        continue;
      }
      flushBuffer();
      items.push({ kind: 'part', id: buildChatPartIdentity(part, index), part });
      const mermaidPart = buildSaveArchMermaidDisplayPart(part);
      if (mermaidPart) {
        items.push({ kind: 'part', id: buildChatPartIdentity(mermaidPart, index), part: mermaidPart });
      }
      continue;
    }

    if (isThinkingPart(part)) {
      if (buffer.length === 0) {
        bufferStartIndex = index;
      }
      buffer.push(part as ChatPart);
      continue;
    }

    flushBuffer();
    items.push({ kind: 'part', id: buildChatPartIdentity(part, index), part });
  }

  flushBuffer();
  return items;
}

export function normalizePartForProjection(part: RenderableChatPart, index: number): RenderableChatPart {
  if (part.type !== 'thinking' || part.isComplete || part.contentRef || !part.content) {
    return part;
  }

  const contentRef = [
    'render-thinking',
    part.sourceAgentRole ?? 'main',
    part.subAgentInvocationId ?? 'root',
    part.parentToolCallId ?? 'root',
    part.partId || buildChatPartIdentity(part, index),
  ].join(':');
  storeThinkContent(contentRef, part.content);
  return {
    ...part,
    content: '',
    contentRef,
    contentLength: part.contentLength ?? part.content.length,
  };
}

function collectTerminalOwnedToolCallIds(parts: readonly RenderableChatPart[]): Set<string> {
  const ids = new Set<string>();
  const terminalSessionIds = new Set<string>();
  for (const part of parts) {
    if ((part as { readonly type?: string }).type !== 'terminal') {
      continue;
    }

    const terminal = part as {
      readonly toolCallId?: string;
      readonly sourceToolCallIds?: readonly string[];
      readonly processId?: string;
      readonly outputSessionId?: string;
      readonly terminalId?: string;
    };
    if (terminal.toolCallId) {
      ids.add(terminal.toolCallId);
    }
    for (const sourceToolCallId of terminal.sourceToolCallIds ?? []) {
      if (sourceToolCallId) {
        ids.add(sourceToolCallId);
      }
    }
    for (const sessionId of [terminal.processId, terminal.outputSessionId, terminal.terminalId]) {
      if (sessionId) {
        terminalSessionIds.add(sessionId);
      }
    }
  }

  for (const part of parts) {
    const toolPart = toRuntimeToolCallPart(part);
    if (toolPart.type !== 'tool_call'
      || !toolPart.toolCallId
      || !isTerminalSessionToolName(toolPart.toolName)
      || !isToolCallBoundToTerminalSession(toolPart, terminalSessionIds)) {
      continue;
    }
    ids.add(toolPart.toolCallId);
  }
  return ids;
}

function isToolCallOwnedByTerminalPart(
  part: RenderableChatPart,
  terminalOwnedToolCallIds: ReadonlySet<string>,
): boolean {
  const toolPart = toRuntimeToolCallPart(part);
  return toolPart.type === 'tool_call'
    && typeof toolPart.toolCallId === 'string'
    && terminalOwnedToolCallIds.has(toolPart.toolCallId);
}

function isToolCallBoundToTerminalSession(
  toolPart: {
    readonly args?: unknown;
    readonly metadata?: Record<string, unknown>;
  },
  terminalSessionIds: ReadonlySet<string>,
): boolean {
  if (terminalSessionIds.size === 0) {
    return false;
  }

  const args = asRecord(toolPart.args);
  const metadata = asRecord(toolPart.metadata);
  const candidateIds = [
    asString(args?.['processId']),
    asString(args?.['outputSessionId']),
    asString(args?.['terminalId']),
    asString(args?.['id']),
    asString(metadata?.['processId']),
    asString(metadata?.['outputSessionId']),
    asString(metadata?.['terminalId']),
  ];
  return candidateIds.some((candidateId) => !!candidateId && terminalSessionIds.has(candidateId));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function markLiveActivityGroups(items: readonly ChatRenderItem[], doing: boolean): ChatRenderItem[] {
  if (!doing || items.length === 0) {
    return items.map((item) => item.kind === 'group' ? { ...item, live: false } : item);
  }

  return items.map((item, index) => item.kind === 'group'
    ? { ...item, live: !hasLookAheadBoundary(items, index) }
    : item);
}

function hasLookAheadBoundary(items: readonly ChatRenderItem[], groupIndex: number): boolean {
  for (let index = groupIndex + 1; index < items.length; index++) {
    if (items[index].kind === 'part') {
      return true;
    }
  }

  return false;
}

function isIgnorablePart(part: RenderableChatPart): boolean {
  if (isProgressMessageDisplayPart(part)) {
    return part.content.trim().length === 0;
  }

  const runtimeToolPart = toRuntimeToolCallPart(part);
  if (runtimeToolPart.type === 'tool_call' && isInternalDiscoveryToolName(runtimeToolPart.toolName)) {
    return true;
  }

  return part.type === 'markdown' && part.content.trim().length === 0;
}

function isRuntimeToolCallPart(part: RenderableChatPart): boolean {
  return toRuntimeToolCallPart(part).type === 'tool_call';
}

function isThinkingPart(part: RenderableChatPart): boolean {
  return (part as { readonly type?: string }).type === 'thinking';
}

function shouldPinToolCallToThinking(part: RenderableChatPart): boolean {
  const toolPart = toRuntimeToolCallPart(part);
  if (toolPart.type !== 'tool_call') {
    return false;
  }

  if (toolPart.state === 'pending_approval') {
    return false;
  }

  if (isSubagentToolCall(part as ChatPart)
    || isInternalDiscoveryToolName(toolPart.toolName)
    || isTerminalSessionToolName(toolPart.toolName)
    || hasTerminalSpecificData(toolPart)) {
    return false;
  }

  return true;
}

function buildSaveArchMermaidDisplayPart(part: RenderableChatPart): MarkdownPart | null {
  const toolPart = toRuntimeToolCallPart(part);
  if (toolPart.type !== 'tool_call' || normalizeReadSideToolName(toolPart.toolName) !== 'save_arch') {
    return null;
  }

  if (toolPart.state !== 'done' && toolPart.state !== 'warn') {
    return null;
  }

  const code = extractSaveArchMermaidCode(toolPart.args, toolPart.metadata, (part as { readonly text?: string }).text);
  if (!code) {
    return null;
  }

  const scoped = part as {
    readonly sourceAgentRole?: 'main' | 'subagent';
    readonly subAgentInvocationId?: string;
    readonly parentToolCallId?: string;
    readonly sequence?: number;
  };
  return {
    type: 'markdown',
    partId: `${toolPart.toolCallId || 'save_arch'}:mermaid-artifact`,
    content: `\`\`\`mermaid\n${code}\n\`\`\``,
    sourceAgentRole: scoped.sourceAgentRole,
    subAgentInvocationId: scoped.subAgentInvocationId,
    parentToolCallId: scoped.parentToolCallId,
    sequence: typeof scoped.sequence === 'number' ? scoped.sequence + 0.01 : undefined,
  };
}

function extractSaveArchMermaidCode(args: unknown, metadata: unknown, text: unknown): string | null {
  const metadataRecord = asRecord(metadata);
  const artifact = asRecord(metadataRecord?.['artifact']);
  const artifactCode = asString(artifact?.['code']);
  if (artifactCode) {
    return artifactCode;
  }

  const argsCode = asString(asRecord(args)?.['code']);
  if (argsCode) {
    return argsCode;
  }

  const resultText = [
    asString(metadataRecord?.['resultText']),
    typeof text === 'string' ? text : undefined,
  ].find((candidate): candidate is string => !!candidate);
  const fencedCode = extractMermaidFence(resultText);
  return fencedCode || null;
}

function extractMermaidFence(text: string | undefined): string | null {
  if (!text) {
    return null;
  }

  const match = text.match(/```(?:mermaid|aily-mermaid)?\s*([\s\S]*?)```/i);
  const code = match?.[1]?.trim();
  return code || null;
}

function getSubagentGroupId(part: RenderableChatPart): string | null {
  if (isProgressMessageDisplayPart(part)) {
    return null;
  }

  const chatPart = part as ChatPart;
  if (isSubagentToolCall(chatPart)) {
    return chatPart.type === 'tool_call' ? chatPart.toolCallId : null;
  }

  if (!isSubagentChildPart(chatPart)) {
    return null;
  }

  return getSubAgentInvocationId(chatPart)
    || getParentToolCallId(chatPart)
    || null;
}

function isSubagentParentToolPart(part: ChatPart): boolean {
  return isSubagentToolCall(part);
}

function toRuntimeToolCallPart(part: RenderableChatPart): {
  readonly type?: string;
  readonly toolName?: string;
  readonly toolCallId?: string;
  readonly args?: unknown;
  readonly state?: string;
  readonly metadata?: Record<string, unknown>;
} {
  return part as {
    readonly type?: string;
    readonly toolName?: string;
    readonly toolCallId?: string;
    readonly args?: unknown;
    readonly state?: string;
    readonly metadata?: Record<string, unknown>;
  };
}

function hasTerminalSpecificData(part: { readonly metadata?: Record<string, unknown> }): boolean {
  const toolSpecificData = part.metadata?.['toolSpecificData'];
  return !!toolSpecificData
    && typeof toolSpecificData === 'object'
    && (toolSpecificData as Record<string, unknown>)['kind'] === 'terminal';
}

export function buildActivityGroupRevision(parts: readonly ChatPart[]): string {
  return parts.map((part, index) => buildActivityPartRevision(part, index)).join('|');
}

export function buildActivityPartRevision(part: ChatPart, index: number): string {
  const base = `${buildChatPartIdentity(part, index)}:${part.type}`;
  switch (part.type) {
    case 'thinking':
      return [
        base,
        part.partId ?? '',
        part.contentRef ?? '',
        contentProgressKey(part),
        part.isComplete ? 'complete' : 'running',
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
        part.scope ?? '',
      ].join(':');
    case 'terminal':
      return [
        base,
        part.partId ?? '',
        part.processId ?? '',
        part.outputSessionId ?? '',
        part.terminalId ?? '',
        part.toolCallId ?? '',
        (part.sourceToolCallIds ?? []).join(','),
        part.isRunning ? 'running' : 'settled',
        part.status ?? '',
        part.exitCode ?? '',
        part.cwd ?? '',
        fingerprintText(part.command),
      ].join(':');
    case 'state':
      return [
        base,
        part.stateId,
        part.kind,
        part.state,
      ].join(':');
    case 'markdown':
      return [
        base,
        part.partId ?? '',
        part.contentRef ?? '',
        contentProgressKey(part),
      ].join(':');
    default:
      return `${base}:${fingerprintText(stableRevisionJson(part))}`;
  }
}

function stableRevisionJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value ?? '');
  }
}

function contentProgressKey(part: { readonly content?: string; readonly contentLength?: number }): string {
  const length = part.contentLength ?? part.content?.length ?? 0;
  if (!part.content || part.content.length === 0) {
    return String(length);
  }
  return `${length}:${fingerprintText(part.content)}`;
}

function fingerprintText(value: unknown): string {
  if (typeof value !== 'string') {
    return value == null ? '' : String(value);
  }
  if (value.length <= 120) {
    return value;
  }
  return `${value.length}:${value.slice(0, 60)}:${value.slice(-60)}`;
}

function countLegacySubagentChildren(parts: readonly RenderableChatPart[]): number {
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

function countScopedSubagentChildren(parts: readonly RenderableChatPart[]): number {
  let count = 0;
  for (const part of parts) {
    if (isProgressMessageDisplayPart(part)) {
      continue;
    }
    if (isSubagentChildPart(part)) {
      count += 1;
    }
  }
  return count;
}
