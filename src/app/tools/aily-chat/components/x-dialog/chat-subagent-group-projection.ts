import { ChatPart, getParentToolCallId, getSubAgentInvocationId, isSubagentChildPart } from '../../core/chat-parts';
import { isProgressMessageDisplayPart, type RenderableChatPart } from './chat-render-parts';
import {
  buildActivityGroupIdentity,
  buildChatPartIdentity,
  isSubagentToolCall,
} from './chat-activity-group-projection';
import { ChatPerformanceTracer } from '../../services/chat-perf-tracer';
import {
  isInternalDiscoveryToolName,
  isTerminalSessionToolName,
  isTodoToolName,
  normalizeReadSideToolName,
} from '../../core/tool-name-normalizer';

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
        id: buildActivityGroupIdentity(groupParts, index),
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

    group.item.id = buildActivityGroupIdentity(group.parts, group.startIndex);
    group.item.revision = buildActivityGroupRevision(group.parts);
    return true;
  };

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
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
      if (shouldPinToolCallToThinking(part)) {
        if (buffer.length === 0) {
          bufferStartIndex = index;
        }
        buffer.push(part as ChatPart);
        continue;
      }
      flushBuffer();
      items.push({ kind: 'part', id: buildChatPartIdentity(part, index), part });
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
    || isTodoToolName(toolPart.toolName)
    || isAskQuestionsToolName(toolPart.toolName)
    || hasTerminalSpecificData(toolPart)) {
    return false;
  }

  return true;
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
  readonly state?: string;
  readonly metadata?: Record<string, unknown>;
} {
  return part as {
    readonly type?: string;
    readonly toolName?: string;
    readonly state?: string;
    readonly metadata?: Record<string, unknown>;
  };
}

function isAskQuestionsToolName(toolName: string | undefined): boolean {
  const normalized = normalizeReadSideToolName(toolName);
  return normalized === 'ask_questions'
    || normalized === 'ask_user'
    || normalized === 'askQuestions'
    || normalized === 'copilot_askQuestions'
    || normalized === 'vscode_askQuestions';
}

function hasTerminalSpecificData(part: { readonly metadata?: Record<string, unknown> }): boolean {
  const toolSpecificData = part.metadata?.['toolSpecificData'];
  return !!toolSpecificData
    && typeof toolSpecificData === 'object'
    && (toolSpecificData as Record<string, unknown>)['kind'] === 'terminal';
}

function buildActivityGroupRevision(parts: readonly ChatPart[]): string {
  return parts.map((part, index) => buildActivityPartRevision(part, index)).join('|');
}

function buildActivityPartRevision(part: ChatPart, index: number): string {
  const base = `${index}:${buildChatPartIdentity(part, index)}:${part.type}`;
  switch (part.type) {
    case 'thinking':
      return [
        base,
        part.partId ?? '',
        part.contentRef ?? '',
        part.contentLength ?? part.content.length,
        part.isComplete ? 'complete' : 'running',
      ].join(':');
    case 'tool_call':
      return [
        base,
        part.partId ?? '',
        part.toolCallId,
        part.toolName,
        part.state,
        fingerprintText(part.text),
        fingerprintJson(part.args),
        fingerprintJson(part.metadata),
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
        fingerprintText(part.message),
        fingerprintJson(part.metadata),
      ].join(':');
    case 'terminal':
      return [
        base,
        part.partId ?? '',
        part.processId ?? '',
        part.outputSessionId ?? '',
        part.terminalId ?? '',
        part.toolCallId ?? '',
        part.isRunning ? 'running' : 'settled',
        part.status ?? '',
        part.exitCode ?? '',
        part.cwd ?? '',
        fingerprintText(part.command),
        fingerprintText(part.output),
        fingerprintText(part.stderr),
      ].join(':');
    case 'state':
      return [
        base,
        part.stateId,
        part.kind,
        part.state,
        fingerprintText(part.text),
        fingerprintJson(part.metadata),
      ].join(':');
    case 'markdown':
      return [
        base,
        part.partId ?? '',
        part.contentRef ?? '',
        part.contentLength ?? part.content.length,
      ].join(':');
    default:
      return base;
  }
}

function fingerprintJson(value: unknown): string {
  if (value == null) {
    return '';
  }
  try {
    return fingerprintText(JSON.stringify(value));
  } catch {
    return fingerprintText(String(value));
  }
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
