import { ChatPart, MarkdownPart, getParentToolCallId, getSubAgentInvocationId, isSubagentChildPart } from '../../core/chat-parts';
import {
  isInteractionDecisionDisplayPart,
  isProgressMessageDisplayPart,
  type InteractionDecisionDisplayPart,
  type RenderableChatPart,
} from './chat-render-parts';
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
import { projectToolCallApprovalDisplayData } from '../../core/tool-call-approval';
import { projectAskUserToolDecisionData } from '../../core/ask-user-tool-projection';

export interface PartRenderItem {
  kind: 'part';
  id: string;
  part: RenderableChatPart;
  /** Canonical index in the response part list. Synthetic display parts omit it. */
  sourcePartIndex?: number;
}

export interface ActivityGroupRenderItem {
  kind: 'group';
  id: string;
  parts: readonly ChatPart[];
  /** Canonical response indices aligned one-to-one with `parts`. */
  sourcePartIndices: readonly number[];
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
  let bufferSourcePartIndices: number[] = [];
  let bufferStartIndex = -1;
  const terminalOwnedToolCallIds = collectTerminalOwnedToolCallIds(parts);
  const terminalOwnedDecisionParts = collectTerminalOwnedDecisionParts(parts, terminalOwnedToolCallIds);
  const emittedDecisionIds = new Set<string>();
  const subagentGroups = new Map<string, {
    item: ActivityGroupRenderItem;
    parts: ChatPart[];
    sourcePartIndices: number[];
    startIndex: number;
  }>();

  const flushBuffer = (): void => {
    if (buffer.length >= 1) {
      items.push({
        kind: 'group',
        id: buildActivityGroupIdentity(buffer, Math.max(0, bufferStartIndex)),
        parts: buffer,
        sourcePartIndices: bufferSourcePartIndices,
        revision: buildActivityGroupRevision(buffer, bufferSourcePartIndices),
        live: false,
      });
    }
    buffer = [];
    bufferSourcePartIndices = [];
    bufferStartIndex = -1;
  };

  const appendDecisionPart = (decision: InteractionDecisionDisplayPart | null): void => {
    if (!decision || emittedDecisionIds.has(decision.id)) {
      return;
    }
    emittedDecisionIds.add(decision.id);
    items.push({ kind: 'part', id: decision.id, part: decision });
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
      const sourcePartIndices = [index];
      const item: ActivityGroupRenderItem = {
        kind: 'group',
        id: buildSubagentActivityGroupIdentity(subagentId),
        parts: groupParts,
        sourcePartIndices,
        revision: buildActivityGroupRevision(groupParts, sourcePartIndices),
        live: false,
      };
      group = { item, parts: groupParts, sourcePartIndices, startIndex: index };
      subagentGroups.set(subagentId, group);
      items.push(item);
      return true;
    }

    if (isSubagentParentToolPart(chatPart) && !group.parts.some(isSubagentParentToolPart)) {
      group.parts.unshift(chatPart);
      group.sourcePartIndices.unshift(index);
    } else if (!group.parts.includes(chatPart)) {
      group.parts.push(chatPart);
      group.sourcePartIndices.push(index);
    }

    group.item.revision = buildActivityGroupRevision(group.parts, group.sourcePartIndices);
    return true;
  };

  for (let index = 0; index < parts.length; index += 1) {
    const part = normalizePartForProjection(parts[index], index);
    if (isIgnorablePart(part)) {
      continue;
    }

    if (isProgressMessageDisplayPart(part)) {
      flushBuffer();
      items.push({ kind: 'part', id: `progress:${part.id}`, part, sourcePartIndex: index });
      continue;
    }
    if (isInteractionDecisionDisplayPart(part)) {
      flushBuffer();
      appendDecisionPart(part);
      continue;
    }

    if (appendSubagentPart(part, index)) {
      appendDecisionPart(buildInteractionDecisionDisplayPart(part));
      continue;
    }

    const interactionDecision = buildInteractionDecisionDisplayPart(part);
    if (interactionDecision && part.type !== 'tool_call') {
      flushBuffer();
      appendDecisionPart(interactionDecision);
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
        bufferSourcePartIndices.push(index);
        if (interactionDecision) {
          flushBuffer();
          appendDecisionPart(interactionDecision);
        }
        const mermaidPart = buildSaveArchMermaidDisplayPart(part);
        if (mermaidPart) {
          flushBuffer();
          items.push({ kind: 'part', id: buildChatPartIdentity(mermaidPart, index), part: mermaidPart });
        }
        continue;
      }
      flushBuffer();
      items.push({ kind: 'part', id: buildChatPartIdentity(part, index), part, sourcePartIndex: index });
      appendDecisionPart(interactionDecision);
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
      bufferSourcePartIndices.push(index);
      continue;
    }

    // VS Code's default collapsed-tools policy keeps a terminal invocation in
    // the active thinking container after confirmation. The terminal part is
    // the canonical owner once execution starts, so keep it in the same group
    // instead of projecting a second top-level command row.
    if (part.type === 'terminal') {
      if (buffer.length === 0) {
        bufferStartIndex = index;
      }
      buffer.push(part as ChatPart);
      bufferSourcePartIndices.push(index);
      for (const toolCallId of terminalDecisionToolCallIds(part)) {
        const decision = terminalOwnedDecisionParts.get(toolCallId);
        if (decision) {
          flushBuffer();
          appendDecisionPart(decision);
        }
      }
      continue;
    }

    flushBuffer();
    items.push({ kind: 'part', id: buildChatPartIdentity(part, index), part, sourcePartIndex: index });
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

function isRuntimeToolCallPart(
  part: RenderableChatPart,
): part is Extract<ChatPart, { type: 'tool_call' }> {
  return part.type === 'tool_call';
}

function isThinkingPart(
  part: RenderableChatPart,
): part is Extract<ChatPart, { type: 'thinking' }> {
  return part.type === 'thinking';
}

function buildInteractionDecisionDisplayPart(
  part: RenderableChatPart,
): InteractionDecisionDisplayPart | null {
  if (isProgressMessageDisplayPart(part) || isInteractionDecisionDisplayPart(part)) {
    return null;
  }

  if (part.type === 'question') {
    if (!part.answers || Object.keys(part.answers).length === 0) {
      return null;
    }
    return {
      type: 'interaction_decision',
      id: `interaction:question:${part.partId || questionDecisionIdentity(part)}`,
      interactionKind: 'question',
      source: part,
    };
  }

  if (part.type === 'confirmation') {
    if (!part.resolved) {
      return null;
    }
    return {
      type: 'interaction_decision',
      id: `interaction:confirmation:${part.partId || part.askId}`,
      interactionKind: 'confirmation',
      source: part,
    };
  }

  if (part.type !== 'tool_call') {
    return null;
  }

  if (projectAskUserToolDecisionData(part)) {
    return {
      type: 'interaction_decision',
      id: `interaction:question:${part.toolCallId}`,
      interactionKind: 'question',
      source: part,
    };
  }

  const approval = projectToolCallApprovalDisplayData(part);
  if (!approval?.resolved || approval.reviewer === 'auto_review') {
    return null;
  }

  return {
    type: 'interaction_decision',
    id: `interaction:approval:${part.toolCallId}`,
    interactionKind: 'approval',
    source: part,
  };
}

export function buildInteractionDecisionProjectionIdentity(
  part: RenderableChatPart,
): string | null {
  return buildInteractionDecisionDisplayPart(part)?.id ?? null;
}

function collectTerminalOwnedDecisionParts(
  parts: readonly RenderableChatPart[],
  terminalOwnedToolCallIds: ReadonlySet<string>,
): ReadonlyMap<string, InteractionDecisionDisplayPart> {
  const decisions = new Map<string, InteractionDecisionDisplayPart>();
  for (const part of parts) {
    if (isProgressMessageDisplayPart(part) || isInteractionDecisionDisplayPart(part)) {
      continue;
    }

    if (part.type !== 'tool_call' || !terminalOwnedToolCallIds.has(part.toolCallId)) {
      continue;
    }
    const decision = buildInteractionDecisionDisplayPart(part);
    if (decision) {
      decisions.set(part.toolCallId, decision);
    }
  }
  return decisions;
}

function terminalDecisionToolCallIds(part: Extract<ChatPart, { type: 'terminal' }>): readonly string[] {
  return [...new Set([
    ...(part.toolCallId ? [part.toolCallId] : []),
    ...(part.sourceToolCallIds ?? []),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0))];
}

function questionDecisionIdentity(part: Extract<ChatPart, { type: 'question' }>): string {
  return part.questions.map(question => question.id || question.question).join('|');
}

function shouldPinToolCallToThinking(part: RenderableChatPart): boolean {
  const toolPart = toRuntimeToolCallPart(part);
  if (toolPart.type !== 'tool_call') {
    return false;
  }

  if (isSubagentToolCall(part as ChatPart)
    || isInternalDiscoveryToolName(toolPart.toolName)) {
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
  if (isProgressMessageDisplayPart(part) || isInteractionDecisionDisplayPart(part)) {
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

export function buildActivityGroupRevision(
  parts: readonly ChatPart[],
  sourcePartIndices?: readonly number[],
): string {
  return parts.map((part, index) =>
    buildActivityPartRevision(part, sourcePartIndices?.[index] ?? index)).join('|');
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
        stableRevisionJson(part.metadata?.['toolSpecificData'] ?? null),
        stableRevisionJson(part.metadata?.['approval'] ?? part.metadata?.['approvalRequest'] ?? null),
      ].join(':');
    case 'confirmation':
      return [
        base,
        part.partId ?? '',
        part.askId,
        part.resolved ? 'resolved' : 'pending',
        part.result ?? '',
        part.scope ?? '',
        part.selectedActionId ?? '',
        part.selectedActionLabel ?? '',
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
    if (isProgressMessageDisplayPart(part) || isInteractionDecisionDisplayPart(part)) {
      continue;
    }
    if (isSubagentChildPart(part)) {
      count += 1;
    }
  }
  return count;
}
