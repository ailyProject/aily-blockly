import type { TurnResponseTurn } from 'aily-lex/browser';

import type { ChatPart } from '../../core/chat-parts';

export interface ProgressMessageDisplayPart {
  type: 'progress';
  content: string;
  progressKind: 'working' | 'confirmation_pending';
}

export type RenderableChatPart = ChatPart | ProgressMessageDisplayPart;

export function isProgressMessageDisplayPart(part: RenderableChatPart | null | undefined): part is ProgressMessageDisplayPart {
  return !!part && part.type === 'progress';
}

export function mkProgressMessageDisplayPart(
  content: string,
  progressKind: ProgressMessageDisplayPart['progressKind'] = 'working',
): ProgressMessageDisplayPart {
  return {
    type: 'progress',
    content,
    progressKind,
  };
}

export function buildRenderableProgressParts(
  response: TurnResponseTurn['response'] | null | undefined,
  baseParts: readonly ChatPart[],
  doing: boolean,
  showConfirmationPendingProgress = false,
): readonly ProgressMessageDisplayPart[] {
  if (!response || !doing) {
    return [];
  }

  const progressParts: ProgressMessageDisplayPart[] = [];
  const existingContents = new Set<string>();
  for (const message of response.progressMessages ?? []) {
    if (message?.kind !== 'progressMessage' || typeof message.content !== 'string' || !message.content.trim()) {
      continue;
    }

    const content = message.content.trim();
    if (existingContents.has(content)) {
      continue;
    }

    existingContents.add(content);
    progressParts.push(mkProgressMessageDisplayPart(content, 'working'));
  }

  const pendingConfirmationCount = showConfirmationPendingProgress
    ? getPendingConfirmationCount(baseParts, false)
    : 0;
  const shouldShowFallbackConfirmationProgress = showConfirmationPendingProgress
    && pendingConfirmationCount === 0
    && !getPendingConfirmationCount(baseParts, true)
    && !hasActiveSubagentPart(baseParts);
  if (pendingConfirmationCount > 0 || shouldShowFallbackConfirmationProgress) {
    const content = getConfirmationPendingLabel(pendingConfirmationCount || 1);
    if (!existingContents.has(content)) {
      progressParts.push(mkProgressMessageDisplayPart(content, 'confirmation_pending'));
    }
  }

  return progressParts;
}

function hasActiveSubagentPart(parts: readonly ChatPart[]): boolean {
  return parts.some(part => {
    if (part.type !== 'tool_call') {
      return false;
    }

    const metadata = asRecord(part.metadata);
    const toolSpecificData = asRecord(metadata?.['toolSpecificData']);
    return part.state === 'doing' && isSubagentToolSpecificData(toolSpecificData);
  });
}

function getPendingConfirmationCount(parts: readonly ChatPart[], includeSubagentConfirmations: boolean): number {
  let count = 0;
  for (const part of parts) {
    if (part.type === 'tool_call' && part.state === 'pending_approval' && isSubagentToolCall(part) === includeSubagentConfirmations) {
      count += 1;
      continue;
    }

    if (!includeSubagentConfirmations && part.type === 'confirmation' && part.resolved !== true) {
      count += 1;
    }
  }

  return count;
}

function isSubagentToolCall(part: Extract<ChatPart, { type: 'tool_call' }>): boolean {
  const metadata = asRecord(part.metadata);
  const toolSpecificData = asRecord(metadata?.['toolSpecificData']);
  return isSubagentToolSpecificData(toolSpecificData);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isSubagentToolSpecificData(toolSpecificData: Record<string, unknown> | undefined): boolean {
  return !!toolSpecificData && (
    toolSpecificData['kind'] === 'subagent'
    || typeof toolSpecificData['agentName'] === 'string'
    || typeof toolSpecificData['description'] === 'string'
  );
}

function getConfirmationPendingLabel(count: number): string {
  return count === 1
    ? '1 confirmation pending'
    : `${count} confirmations pending`;
}
