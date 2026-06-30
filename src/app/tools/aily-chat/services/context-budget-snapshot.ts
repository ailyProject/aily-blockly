export interface ContextBudgetSnapshot {
  currentTokens: number;
  maxContextTokens: number;
  compressionThreshold: number;
  summarizationThreshold: number;
  usagePercent: number;
  messageCount: number;
  updatedAt: number;
  systemTokens: number;
  baseSystemTokens: number;
  instructionTokens: number;
  skillTokens: number;
  toolsTokens: number;
  toolSourceTokens: Record<string, number>;
  contextTokens: number;
  conversationTokens: number;
  messagesTokens: number;
  toolResultsTokens: number;
  systemPercent: number;
  baseSystemPercent: number;
  instructionPercent: number;
  skillPercent: number;
  toolsPercent: number;
  contextPercent: number;
  conversationPercent: number;
  messagesPercent: number;
  toolResultsPercent: number;
}

export interface ContextBudgetSnapshotInput {
  maxContextTokens: number;
  compressionThreshold: number;
  summarizationThreshold: number;
  messageCount: number;
  systemTokens: number;
  baseSystemTokens?: number;
  instructionTokens?: number;
  skillTokens?: number;
  toolsTokens: number;
  toolSourceTokens?: Record<string, number>;
  contextTokens: number;
  messagesTokens: number;
  toolResultsTokens?: number;
  currentTokens?: number;
  usagePercent?: number;
}

function toPercent(tokens: number, maxContextTokens: number): number {
  return maxContextTokens > 0
    ? Math.round((tokens / maxContextTokens) * 1000) / 10
    : 0;
}

function normalizeToolSourceTokens(value?: Record<string, number>): Record<string, number> {
  if (!value || typeof value !== 'object') {
    return {};
  }

  const normalized: Record<string, number> = {};
  for (const [key, tokenCount] of Object.entries(value)) {
    if (!key || typeof tokenCount !== 'number' || !Number.isFinite(tokenCount) || tokenCount <= 0) {
      continue;
    }
    normalized[key] = tokenCount;
  }
  return normalized;
}

export function createContextBudgetSnapshot(input: ContextBudgetSnapshotInput): ContextBudgetSnapshot {
  const instructionTokens = input.instructionTokens ?? 0;
  const skillTokens = input.skillTokens ?? 0;
  const toolSourceTokens = normalizeToolSourceTokens(input.toolSourceTokens);
  const baseSystemTokens = input.baseSystemTokens
    ?? Math.max(input.systemTokens - instructionTokens - skillTokens, 0);
  const currentTokens = input.currentTokens
    ?? (input.systemTokens + input.toolsTokens + input.contextTokens + input.messagesTokens + (input.toolResultsTokens ?? 0));
  const usagePercent = input.usagePercent
    ?? (input.maxContextTokens > 0
      ? Math.min(100, Math.round((currentTokens / input.maxContextTokens) * 100))
      : 0);

  return {
    currentTokens,
    maxContextTokens: input.maxContextTokens,
    compressionThreshold: input.compressionThreshold,
    summarizationThreshold: input.summarizationThreshold,
    usagePercent,
    messageCount: input.messageCount,
    updatedAt: Date.now(),
    systemTokens: input.systemTokens,
    baseSystemTokens,
    instructionTokens,
    skillTokens,
    toolsTokens: input.toolsTokens,
    toolSourceTokens,
    contextTokens: input.contextTokens,
    conversationTokens: input.messagesTokens,
    messagesTokens: input.messagesTokens,
    toolResultsTokens: input.toolResultsTokens ?? 0,
    systemPercent: toPercent(input.systemTokens, input.maxContextTokens),
    baseSystemPercent: toPercent(baseSystemTokens, input.maxContextTokens),
    instructionPercent: toPercent(instructionTokens, input.maxContextTokens),
    skillPercent: toPercent(skillTokens, input.maxContextTokens),
    toolsPercent: toPercent(input.toolsTokens, input.maxContextTokens),
    contextPercent: toPercent(input.contextTokens, input.maxContextTokens),
    conversationPercent: toPercent(input.messagesTokens, input.maxContextTokens),
    messagesPercent: toPercent(input.messagesTokens, input.maxContextTokens),
    toolResultsPercent: toPercent(input.toolResultsTokens ?? 0, input.maxContextTokens),
  };
}

export function createEmptyContextBudgetSnapshot(options?: {
  maxContextTokens?: number;
  compressionThreshold?: number;
  summarizationThreshold?: number;
}): ContextBudgetSnapshot {
  return createContextBudgetSnapshot({
    maxContextTokens: options?.maxContextTokens ?? 0,
    compressionThreshold: options?.compressionThreshold ?? 0,
    summarizationThreshold: options?.summarizationThreshold ?? 0,
    messageCount: 0,
    systemTokens: 0,
    baseSystemTokens: 0,
    instructionTokens: 0,
    skillTokens: 0,
    toolsTokens: 0,
    toolSourceTokens: {},
    contextTokens: 0,
    messagesTokens: 0,
    toolResultsTokens: 0,
    currentTokens: 0,
    usagePercent: 0,
  });
}