import {
  buildTurnRequestPromptTokenDetails,
  readTurnRequestDebugArtifactsSnapshot,
  readTurnRequestDebugSectionsSnapshot,
  readTurnRequestOutputBuffer,
  type TurnResponseTurn,
} from 'aily-lex/browser';

import type { ContextBudgetSnapshot } from './context-budget-snapshot';
import { estimateTokenCount } from './context-budget-estimation';

export interface ChatContextUsagePromptTokenDetail {
  readonly category: string;
  readonly label: string;
  readonly percentageOfPrompt: number;
}

export interface ChatContextUsageSnapshot {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly usedTokens: number;
  readonly totalContextWindow: number;
  readonly percentage: number;
  readonly source?: 'provider-request' | 'provider-turn-final' | 'estimate';
  readonly outputBuffer?: number;
  readonly outputBufferPercentage?: number;
  readonly promptTokenDetails?: readonly ChatContextUsagePromptTokenDetail[];
}

export interface ChatContextUsageSummary {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly source: 'provider-request' | 'provider-turn-final' | 'estimate';
  readonly outputBuffer?: number;
  readonly promptTokenDetails?: readonly ChatContextUsagePromptTokenDetail[];
}

export interface ChatContextUsageSnapshotInput {
  readonly turnResponses: readonly TurnResponseTurn[] | null | undefined;
  readonly maxContextTokens?: number | null;
  readonly contextBudgetSnapshot?: ContextBudgetSnapshot | null;
}

interface RequestDebugSerializableMessagePart {
  readonly type?: string;
  readonly content?: string;
  readonly name?: string;
  readonly arguments?: unknown;
}

interface RequestDebugSerializableMessage {
  readonly role?: string;
  readonly name?: string;
  readonly parts?: readonly RequestDebugSerializableMessagePart[];
}

const PROMPT_TOKEN_CATEGORY = {
  system: 'System',
  userContext: 'User Context',
} as const;

const PROMPT_TOKEN_LABEL = {
  systemInstructions: 'System Instructions',
  toolDefinitions: 'Tool Definitions',
  files: 'Files',
  messages: 'Messages',
  toolResults: 'Tool Results',
} as const;

const tagToPromptDetail = new Map<string, { category: string; label: string }>([
  ['attachment', { category: PROMPT_TOKEN_CATEGORY.userContext, label: PROMPT_TOKEN_LABEL.files }],
  ['attachments', { category: PROMPT_TOKEN_CATEGORY.userContext, label: PROMPT_TOKEN_LABEL.files }],
  ['file', { category: PROMPT_TOKEN_CATEGORY.userContext, label: PROMPT_TOKEN_LABEL.files }],
  ['editorContext', { category: PROMPT_TOKEN_CATEGORY.userContext, label: PROMPT_TOKEN_LABEL.files }],
  ['currentDocument', { category: PROMPT_TOKEN_CATEGORY.userContext, label: PROMPT_TOKEN_LABEL.files }],
  ['currentFile', { category: PROMPT_TOKEN_CATEGORY.userContext, label: PROMPT_TOKEN_LABEL.files }],
  ['resource', { category: PROMPT_TOKEN_CATEGORY.userContext, label: PROMPT_TOKEN_LABEL.files }],
  ['selection', { category: PROMPT_TOKEN_CATEGORY.userContext, label: PROMPT_TOKEN_LABEL.files }],
  ['documentFragment', { category: PROMPT_TOKEN_CATEGORY.userContext, label: PROMPT_TOKEN_LABEL.files }],
  ['languageServerContext', { category: PROMPT_TOKEN_CATEGORY.userContext, label: PROMPT_TOKEN_LABEL.files }],
  ['symbolDefinitions', { category: PROMPT_TOKEN_CATEGORY.userContext, label: PROMPT_TOKEN_LABEL.files }],
  ['symbol', { category: PROMPT_TOKEN_CATEGORY.userContext, label: PROMPT_TOKEN_LABEL.files }],
  ['codeToTest', { category: PROMPT_TOKEN_CATEGORY.userContext, label: PROMPT_TOKEN_LABEL.files }],
  ['testsFile', { category: PROMPT_TOKEN_CATEGORY.userContext, label: PROMPT_TOKEN_LABEL.files }],
  ['testExample', { category: PROMPT_TOKEN_CATEGORY.userContext, label: PROMPT_TOKEN_LABEL.files }],
  ['testDependencies', { category: PROMPT_TOKEN_CATEGORY.userContext, label: PROMPT_TOKEN_LABEL.files }],
  ['sampleTest', { category: PROMPT_TOKEN_CATEGORY.userContext, label: PROMPT_TOKEN_LABEL.files }],
  ['relatedTest', { category: PROMPT_TOKEN_CATEGORY.userContext, label: PROMPT_TOKEN_LABEL.files }],
  ['relatedSource', { category: PROMPT_TOKEN_CATEGORY.userContext, label: PROMPT_TOKEN_LABEL.files }],
  ['readme', { category: PROMPT_TOKEN_CATEGORY.userContext, label: PROMPT_TOKEN_LABEL.files }],
  ['original-code', { category: PROMPT_TOKEN_CATEGORY.userContext, label: PROMPT_TOKEN_LABEL.files }],
  ['code-changes', { category: PROMPT_TOKEN_CATEGORY.userContext, label: PROMPT_TOKEN_LABEL.files }],
  ['changeDescription', { category: PROMPT_TOKEN_CATEGORY.userContext, label: PROMPT_TOKEN_LABEL.files }],
  ['currentChange', { category: PROMPT_TOKEN_CATEGORY.userContext, label: PROMPT_TOKEN_LABEL.files }],
  ['cell', { category: PROMPT_TOKEN_CATEGORY.userContext, label: PROMPT_TOKEN_LABEL.files }],
  ['cellsAbove', { category: PROMPT_TOKEN_CATEGORY.userContext, label: PROMPT_TOKEN_LABEL.files }],
  ['cellsBelow', { category: PROMPT_TOKEN_CATEGORY.userContext, label: PROMPT_TOKEN_LABEL.files }],
  ['cell-output', { category: PROMPT_TOKEN_CATEGORY.userContext, label: PROMPT_TOKEN_LABEL.files }],
  ['notebook-cell-output', { category: PROMPT_TOKEN_CATEGORY.userContext, label: PROMPT_TOKEN_LABEL.files }],
  ['some_of_the_cells_after_edit', { category: PROMPT_TOKEN_CATEGORY.userContext, label: PROMPT_TOKEN_LABEL.files }],
  ['workspaceFolder', { category: PROMPT_TOKEN_CATEGORY.userContext, label: PROMPT_TOKEN_LABEL.files }],
  ['projectLabels', { category: PROMPT_TOKEN_CATEGORY.userContext, label: PROMPT_TOKEN_LABEL.files }],
  ['error', { category: PROMPT_TOKEN_CATEGORY.userContext, label: PROMPT_TOKEN_LABEL.toolResults }],
  ['errors', { category: PROMPT_TOKEN_CATEGORY.userContext, label: PROMPT_TOKEN_LABEL.toolResults }],
  ['compileError', { category: PROMPT_TOKEN_CATEGORY.userContext, label: PROMPT_TOKEN_LABEL.toolResults }],
  ['suggestedFix', { category: PROMPT_TOKEN_CATEGORY.userContext, label: PROMPT_TOKEN_LABEL.toolResults }],
  ['testFailure', { category: PROMPT_TOKEN_CATEGORY.userContext, label: PROMPT_TOKEN_LABEL.toolResults }],
  ['cell-execution-error', { category: PROMPT_TOKEN_CATEGORY.userContext, label: PROMPT_TOKEN_LABEL.toolResults }],
  ['stackFrame', { category: PROMPT_TOKEN_CATEGORY.userContext, label: PROMPT_TOKEN_LABEL.toolResults }],
  ['feedback', { category: PROMPT_TOKEN_CATEGORY.userContext, label: PROMPT_TOKEN_LABEL.toolResults }],
  ['analysis', { category: PROMPT_TOKEN_CATEGORY.userContext, label: PROMPT_TOKEN_LABEL.toolResults }],
  ['criteria', { category: PROMPT_TOKEN_CATEGORY.userContext, label: PROMPT_TOKEN_LABEL.toolResults }],
  ['invalidPatch', { category: PROMPT_TOKEN_CATEGORY.userContext, label: PROMPT_TOKEN_LABEL.toolResults }],
  ['correctedEdit', { category: PROMPT_TOKEN_CATEGORY.userContext, label: PROMPT_TOKEN_LABEL.toolResults }],
  ['actualOutput', { category: PROMPT_TOKEN_CATEGORY.userContext, label: PROMPT_TOKEN_LABEL.toolResults }],
  ['expectedOutput', { category: PROMPT_TOKEN_CATEGORY.userContext, label: PROMPT_TOKEN_LABEL.toolResults }],
  ['match', { category: PROMPT_TOKEN_CATEGORY.userContext, label: PROMPT_TOKEN_LABEL.toolResults }],
]);

type MutablePromptDetailCounts = Map<string, Map<string, number>>;

export function createChatContextUsageSnapshot(
  input: ChatContextUsageSnapshotInput,
): ChatContextUsageSnapshot | null {
  const usageTurn = findLatestUsageTurn(input.turnResponses);
  const requestUsage = usageTurn ? readTurnRequestUsage(usageTurn) : undefined;
  const promptTokens = requestUsage?.promptTokens;
  const completionTokens = requestUsage?.completionTokens;
  const totalContextWindow = normalizePositiveNumber(
    input.maxContextTokens ?? input.contextBudgetSnapshot?.maxContextTokens,
  );

  if (!usageTurn || !isFiniteNonNegative(promptTokens) || !isFiniteNonNegative(completionTokens) || !totalContextWindow) {
    return null;
  }

  const outputBuffer = requestUsage?.outputBuffer ?? readOutputBufferFromTurn(usageTurn);
  const usedTokens = promptTokens + completionTokens;
  const percentage = totalContextWindow > 0
    ? (usedTokens / totalContextWindow) * 100
    : 0;
  const outputBufferPercentage = typeof outputBuffer === 'number'
    ? (Math.max(0, outputBuffer - completionTokens) / totalContextWindow) * 100
    : undefined;
  const promptTokenDetails = requestUsage?.promptTokenDetails ?? buildPromptTokenDetails(usageTurn, promptTokens);

  return {
    promptTokens,
    completionTokens,
    usedTokens,
    totalContextWindow,
    percentage,
    ...(requestUsage?.source ? { source: requestUsage.source } : {}),
    ...(typeof outputBuffer === 'number' ? { outputBuffer } : {}),
    ...(typeof outputBufferPercentage === 'number' ? { outputBufferPercentage } : {}),
    ...(promptTokenDetails.length > 0 ? { promptTokenDetails } : {}),
  };
}

export function findLatestUsageTurn(
  turnResponses: readonly TurnResponseTurn[] | null | undefined,
): TurnResponseTurn | null {
  if (!Array.isArray(turnResponses) || turnResponses.length === 0) {
    return null;
  }

  // Current lex/blockly subagent activity is projected inside the parent turn's
  // response parts/childItems, not as separate child turnResponses. If a future
  // path introduces dedicated child turnResponses, this scan must become
  // request-owner aware so parent widgets do not pick child request usage.
  for (let index = turnResponses.length - 1; index >= 0; index -= 1) {
    const requestUsage = readTurnRequestUsage(turnResponses[index]);
    if (isFiniteNonNegative(requestUsage?.promptTokens) && isFiniteNonNegative(requestUsage?.completionTokens)) {
      return turnResponses[index];
    }
  }

  return null;
}

export function readLatestContextUsageSummary(
  turnResponses: readonly TurnResponseTurn[] | null | undefined,
): ChatContextUsageSummary | null {
  const usageTurn = findLatestUsageTurn(turnResponses);
  if (!usageTurn) {
    return null;
  }

  const requestUsage = readTurnRequestUsage(usageTurn);
  if (!requestUsage) {
    return null;
  }

  return {
    promptTokens: requestUsage.promptTokens,
    completionTokens: requestUsage.completionTokens,
    source: requestUsage.source,
    ...(typeof requestUsage.outputBuffer === 'number' ? { outputBuffer: requestUsage.outputBuffer } : {}),
    ...(requestUsage.promptTokenDetails?.length ? { promptTokenDetails: requestUsage.promptTokenDetails } : {}),
  };
}

function buildPromptTokenDetails(
  turn: TurnResponseTurn,
  promptTokens: number,
): ChatContextUsagePromptTokenDetail[] {
  const sharedDetails = buildTurnRequestPromptTokenDetails(turn.request?.metadata, promptTokens, estimateTokenCount);
  if (sharedDetails?.length) {
    return [...sharedDetails];
  }

  const counts = buildPromptDetailCountsFromTurn(turn);
  return toPromptTokenDetails(counts, promptTokens);
}

function buildPromptDetailCountsFromTurn(turn: TurnResponseTurn): MutablePromptDetailCounts {
  const counts = new Map<string, Map<string, number>>();
  const artifacts = readTurnRequestDebugArtifactsSnapshot(turn.request?.metadata) ?? [];
  const sections = readTurnRequestDebugSectionsSnapshot(turn.request?.metadata) ?? [];

  const systemArtifact = artifacts.find(artifact => artifact.kind === 'system');
  if (systemArtifact?.content) {
    addPromptDetailCount(counts, PROMPT_TOKEN_CATEGORY.system, PROMPT_TOKEN_LABEL.systemInstructions, estimateTokenCount(systemArtifact.content));
  }

  const toolsArtifact = artifacts.find(artifact => artifact.kind === 'tools');
  if (toolsArtifact?.content) {
    addPromptDetailCount(counts, PROMPT_TOKEN_CATEGORY.system, PROMPT_TOKEN_LABEL.toolDefinitions, estimateTokenCount(toolsArtifact.content));
  }

  const inputMessagesSection = sections.find(section => section.name === 'Input Messages');
  const parsedMessages = parseInputMessagesSection(inputMessagesSection?.content);
  for (const message of parsedMessages) {
    addPromptCountsFromMessage(counts, message, !systemArtifact?.content);
  }

  return counts;
}

function parseInputMessagesSection(content: string | undefined): RequestDebugSerializableMessage[] {
  if (!content) {
    return [];
  }

  try {
    const parsed = JSON.parse(content);
    return Array.isArray(parsed)
      ? parsed.filter((message): message is RequestDebugSerializableMessage => !!message && typeof message === 'object')
      : [];
  } catch {
    return [];
  }
}

function addPromptCountsFromMessage(
  counts: MutablePromptDetailCounts,
  message: RequestDebugSerializableMessage,
  includeSystemMessage: boolean,
): void {
  const role = typeof message.role === 'string' ? message.role : '';
  const messageTokens = estimateDebugMessageTokens(message);
  if (messageTokens <= 0) {
    return;
  }

  switch (role) {
    case 'system':
      if (includeSystemMessage) {
        addPromptDetailCount(counts, PROMPT_TOKEN_CATEGORY.system, PROMPT_TOKEN_LABEL.systemInstructions, messageTokens);
      }
      return;
    case 'tool':
      addPromptDetailCount(counts, PROMPT_TOKEN_CATEGORY.userContext, PROMPT_TOKEN_LABEL.toolResults, messageTokens);
      return;
    case 'assistant':
      addPromptDetailCount(counts, PROMPT_TOKEN_CATEGORY.userContext, PROMPT_TOKEN_LABEL.messages, messageTokens);
      return;
    case 'user': {
      let accountedTokens = 0;
      for (const part of message.parts ?? []) {
        if (part.type === 'text' && typeof part.content === 'string' && part.content.length > 0) {
          accountedTokens += parseTaggedTextTokens(part.content, counts);
        }
      }

      const unaccountedTokens = Math.max(0, messageTokens - accountedTokens);
      if (unaccountedTokens > 0) {
        addPromptDetailCount(counts, PROMPT_TOKEN_CATEGORY.userContext, PROMPT_TOKEN_LABEL.messages, unaccountedTokens);
      }
      return;
    }
    default:
      addPromptDetailCount(counts, PROMPT_TOKEN_CATEGORY.userContext, PROMPT_TOKEN_LABEL.messages, messageTokens);
  }
}

function estimateDebugMessageTokens(message: RequestDebugSerializableMessage): number {
  let tokens = 4;

  if (typeof message.role === 'string' && message.role.length > 0) {
    tokens += estimateTokenCount(message.role);
  }
  if (typeof message.name === 'string' && message.name.length > 0) {
    tokens += estimateTokenCount(message.name);
  }

  for (const part of message.parts ?? []) {
    if (typeof part.content === 'string' && part.content.length > 0) {
      tokens += estimateTokenCount(part.content);
    }
    if (typeof part.name === 'string' && part.name.length > 0) {
      tokens += estimateTokenCount(part.name);
    }
    if (part.arguments !== undefined) {
      tokens += estimateTokenCount(typeof part.arguments === 'string' ? part.arguments : JSON.stringify(part.arguments));
    }
    if (part.type === 'tool_call') {
      tokens += 4;
    }
  }

  return tokens;
}

function parseTaggedTextTokens(
  text: string,
  counts: MutablePromptDetailCounts,
): number {
  let accountedTokens = 0;
  const allTagsRegex = /<([a-zA-Z_][\w.\-]*)[^>]*>[\s\S]*?<\/\1>/g;
  const processedRanges: Array<{ start: number; end: number }> = [];
  let match: RegExpExecArray | null;

  while ((match = allTagsRegex.exec(text)) !== null) {
    const tagName = match[1];
    const fullMatch = match[0];
    const start = match.index;
    const end = start + fullMatch.length;
    const isNested = processedRanges.some(range => start >= range.start && end <= range.end);
    if (isNested) {
      continue;
    }

    const mapping = tagToPromptDetail.get(tagName) ?? {
      category: PROMPT_TOKEN_CATEGORY.userContext,
      label: PROMPT_TOKEN_LABEL.messages,
    };
    const tokens = estimateTokenCount(fullMatch);
    addPromptDetailCount(counts, mapping.category, mapping.label, tokens);
    accountedTokens += tokens;
    processedRanges.push({ start, end });
  }

  return accountedTokens;
}

function addPromptDetailCount(
  counts: MutablePromptDetailCounts,
  category: string,
  label: string,
  value: number,
): void {
  if (!isFiniteNonNegative(value) || value <= 0) {
    return;
  }

  let categoryCounts = counts.get(category);
  if (!categoryCounts) {
    categoryCounts = new Map<string, number>();
    counts.set(category, categoryCounts);
  }

  categoryCounts.set(label, (categoryCounts.get(label) ?? 0) + value);
}

function toPromptTokenDetails(
  counts: MutablePromptDetailCounts,
  promptTokens: number,
): ChatContextUsagePromptTokenDetail[] {
  if (!isFiniteNonNegative(promptTokens) || promptTokens <= 0) {
    return [];
  }

  const details: ChatContextUsagePromptTokenDetail[] = [];
  for (const [category, categoryCounts] of counts.entries()) {
    for (const [label, tokenCount] of categoryCounts.entries()) {
      const percentageOfPrompt = Math.round((tokenCount / promptTokens) * 100);
      if (percentageOfPrompt <= 0) {
        continue;
      }

      details.push({ category, label, percentageOfPrompt });
    }
  }

  return details;
}

function readOutputBufferFromTurn(turn: TurnResponseTurn): number | undefined {
  const sharedOutputBuffer = readTurnRequestOutputBuffer(turn.request?.metadata);
  if (typeof sharedOutputBuffer === 'number') {
    return sharedOutputBuffer;
  }

  const requestOptionsSection = (readTurnRequestDebugSectionsSnapshot(turn.request?.metadata) ?? [])
    .find(section => section.name === 'Request Options');
  if (!requestOptionsSection?.content) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(requestOptionsSection.content) as Record<string, unknown>;
    const maxTokens = parsed['max_tokens'] ?? parsed['maxOutputTokens'];
    return normalizePositiveNumber(maxTokens);
  } catch {
    return undefined;
  }
}

function normalizePositiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function readTurnRequestUsage(
  turn: TurnResponseTurn | null | undefined,
): {
  promptTokens: number;
  completionTokens: number;
  source: 'provider-request' | 'provider-turn-final' | 'estimate';
  outputBuffer?: number;
  promptTokenDetails?: readonly ChatContextUsagePromptTokenDetail[];
} | undefined {
  const sidecarUsage = turn?.responseModel?.requestUsage;
  if (isFiniteNonNegative(sidecarUsage?.promptTokens) && isFiniteNonNegative(sidecarUsage?.completionTokens)) {
    const outputBuffer = normalizePositiveNumber(sidecarUsage?.outputBuffer);
    const promptTokenDetails = normalizePromptTokenDetails(sidecarUsage?.promptTokenDetails);
    return {
      promptTokens: sidecarUsage.promptTokens,
      completionTokens: sidecarUsage.completionTokens,
      source: 'provider-request',
      ...(typeof outputBuffer === 'number' ? { outputBuffer } : {}),
      ...(promptTokenDetails.length > 0 ? { promptTokenDetails } : {}),
    };
  }

  const continuationDiagnostics = turn?.response?.continuation?.diagnostics;
  if (continuationDiagnostics && typeof continuationDiagnostics === 'object') {
    const usage = 'usage' in continuationDiagnostics ? continuationDiagnostics['usage'] : undefined;
    if (usage && typeof usage === 'object') {
      const promptTokens = 'promptTokens' in usage ? usage['promptTokens'] : undefined;
      const completionTokens = 'completionTokens' in usage ? usage['completionTokens'] : undefined;
      if (isFiniteNonNegative(promptTokens) && isFiniteNonNegative(completionTokens)) {
        return { promptTokens, completionTokens, source: 'provider-turn-final' };
      }
    }
  }

  const cumulativeUsage = turn?.usage;
  if (isFiniteNonNegative(cumulativeUsage?.inputTokens) && isFiniteNonNegative(cumulativeUsage?.outputTokens)) {
    return {
      promptTokens: cumulativeUsage.inputTokens,
      completionTokens: cumulativeUsage.outputTokens,
      source: 'provider-turn-final',
    };
  }

  return undefined;
}

function normalizePromptTokenDetails(
  details: readonly ChatContextUsagePromptTokenDetail[] | undefined,
): ChatContextUsagePromptTokenDetail[] {
  return (details ?? [])
    .map(detail => {
      const category = typeof detail?.category === 'string' ? detail.category.trim() : '';
      const label = typeof detail?.label === 'string' ? detail.label.trim() : '';
      const percentageOfPrompt = typeof detail?.percentageOfPrompt === 'number'
        && Number.isFinite(detail.percentageOfPrompt)
        && detail.percentageOfPrompt >= 0
        ? detail.percentageOfPrompt
        : undefined;

      if (!category || !label || percentageOfPrompt === undefined) {
        return undefined;
      }

      return {
        category,
        label,
        percentageOfPrompt,
      };
    })
    .filter((detail): detail is ChatContextUsagePromptTokenDetail => !!detail);
}