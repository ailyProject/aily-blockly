import type { TurnResponseTurn } from 'aily-lex/browser';

import type { ChatPart } from '../../core/chat-parts';

export interface ProgressMessageDisplayPart {
  type: 'progress';
  id: string;
  content: string;
  progressKind: 'working' | 'confirmation_pending';
  settled: boolean;
}

export type RenderableChatPart = ChatPart | ProgressMessageDisplayPart;

export function isProgressMessageDisplayPart(part: RenderableChatPart | null | undefined): part is ProgressMessageDisplayPart {
  return !!part && part.type === 'progress';
}

export function mkProgressMessageDisplayPart(
  content: string,
  progressKind: ProgressMessageDisplayPart['progressKind'] = 'working',
  options?: {
    readonly id?: string;
    readonly settled?: boolean;
  },
): ProgressMessageDisplayPart {
  return {
    type: 'progress',
    id: options?.id ?? `progress:${progressKind}:${content}`,
    content,
    progressKind,
    settled: options?.settled === true,
  };
}

export function buildRenderableProgressParts(
  response: TurnResponseTurn['response'] | null | undefined,
  baseParts: readonly ChatPart[],
  doing: boolean,
  showConfirmationPendingProgress = false,
): readonly ProgressMessageDisplayPart[] {
  if (!response) {
    return [];
  }

  const progressParts: ProgressMessageDisplayPart[] = [];
  const existingKeys = new Set<string>();
  for (const message of response.progressMessages ?? []) {
    if (!message || typeof message.content !== 'string' || !message.content.trim()) {
      continue;
    }

    const content = message.content.trim();
    if (message.kind === 'progressTask') {
      const id = message.id.trim();
      if (!id || existingKeys.has(id)) {
        continue;
      }
      existingKeys.add(id);
      progressParts.push(mkProgressMessageDisplayPart(content, 'working', {
        id,
        settled: message.state === 'settled',
      }));
      continue;
    }

    if (!doing || message.kind !== 'progressMessage') {
      continue;
    }

    const id = `message:${content}`;
    if (existingKeys.has(id)) {
      continue;
    }

    existingKeys.add(id);
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
    const id = `confirmation:${content}`;
    if (!existingKeys.has(id)) {
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
