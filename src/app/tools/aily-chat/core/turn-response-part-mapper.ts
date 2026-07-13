import type {
  TurnResponseConfirmationPart,
  TurnResponsePart,
  TurnResponsePlanPart,
  TurnResponseQuestionPart,
  TurnResponseStatePart,
  TurnResponseTerminalPart,
} from 'aily-lex/browser';
import { collectTurnResponseText } from 'aily-lex/browser';

import type { ChatPart, ChatPartScope } from './chat-parts';
import {
  buildConfirmationPartId,
  mkConfirmation,
  mkError,
  mkMarkdown,
  mkPlan,
  mkQuestion,
  mkState,
  mkSubagentToolCall,
  mkTerminal,
  mkThinking,
  mkToolCall,
  normalizeChatPartScope,
  withChatPartScopeMetadata,
} from './chat-parts';
import { getMarkdownContent } from './markdown-content-store';
import { getThinkContent } from './think-content-store';
import { normalizeChatErrorNotice } from './chat-error-notice-normalizer';
import { isTerminalSessionToolName } from './tool-name-normalizer';

type MutableQuestionAnswers = Extract<ChatPart, { type: 'question' }>['answers'];
type ScopedTurnResponsePartMetadata = { readonly metadata?: Record<string, unknown> };
type ScopedTurnResponsePart = ScopedTurnResponsePartMetadata & ChatPartScope;

export function collectMainTurnResponseText(parts: readonly TurnResponsePart[]): string {
  return collectTurnResponseText(parts.filter(part => !isSubagentScopedTurnResponsePart(part)));
}

export function projectTurnResponseDisplayParts(parts: readonly TurnResponsePart[]): TurnResponsePart[] {
  const terminalOwners = collectTerminalInvocationOwners(parts);
  if (terminalOwners.toolCallIds.size === 0 && terminalOwners.sessionIds.size === 0 && terminalOwners.commands.size === 0) {
    return [...parts];
  }

  return parts.filter(part =>
    !isTerminalOwnedToolCallPart(part, terminalOwners)
    && !isTerminalOwnedConfirmationPart(part, terminalOwners));
}

export function turnResponsePartsToDisplayChatParts(
  parts: readonly TurnResponsePart[] | null | undefined,
): readonly ChatPart[] {
  if (!Array.isArray(parts)) {
    return [];
  }

  return hydrateQuestionAnswersFromAskUserToolMetadata(projectTurnResponseDisplayParts(parts))
    .flatMap(part => turnResponsePartToChatParts(part));
}

export function isSubagentScopedTurnResponsePart(part: TurnResponsePart): boolean {
  const scope = readTurnResponsePartScope(part);
  return scope?.sourceAgentRole === 'subagent'
    || typeof scope?.subAgentInvocationId === 'string'
    || typeof scope?.parentToolCallId === 'string';
}

function optionalTurnResponsePartId(part: TurnResponsePart): string | undefined {
  const partId = (part as unknown as { readonly partId?: unknown }).partId;
  return typeof partId === 'string' && partId.trim().length > 0 ? partId : undefined;
}

function collectTerminalInvocationOwners(
  parts: readonly TurnResponsePart[],
): { toolCallIds: Set<string>; sessionIds: Set<string>; commands: Set<string> } {
  const toolCallIds = new Set<string>();
  const sessionIds = new Set<string>();
  const commands = new Set<string>();

  for (const part of parts) {
    if (part.type !== 'terminal') {
      continue;
    }

    const terminal = part as TurnResponseTerminalPart;
    if (terminal.toolCallId) {
      toolCallIds.add(terminal.toolCallId);
    }
    for (const sourceToolCallId of terminal.sourceToolCallIds ?? []) {
      if (sourceToolCallId) {
        toolCallIds.add(sourceToolCallId);
      }
    }
    for (const sessionId of [terminal.processId, terminal.outputSessionId, terminal.terminalId]) {
      if (sessionId) {
        sessionIds.add(sessionId);
      }
    }
    addTerminalCommandOwner(commands, terminal.command);
    const metadata = readRecord(terminal.metadata);
    const approval = readRecord(metadata?.['approval']);
    const approvalArgs = readRecord(approval?.['args']);
    addTerminalCommandOwner(commands, approvalArgs?.['command']);
    addTerminalCommandOwner(commands, approvalArgs?.['cmd']);
  }

  return { toolCallIds, sessionIds, commands };
}

function isTerminalOwnedToolCallPart(
  part: TurnResponsePart,
  owners: { toolCallIds: ReadonlySet<string>; sessionIds: ReadonlySet<string>; commands: ReadonlySet<string> },
): boolean {
  if (part.type !== 'tool_call' || !isTerminalSessionToolName(part.toolName)) {
    return false;
  }

  if (owners.toolCallIds.has(part.toolCallId)) {
    return true;
  }

  const args = readRecord(part.args);
  const metadata = readRecord(part.metadata);
  const approval = readRecord(metadata?.['approval']);
  const approvalArgs = readRecord(approval?.['args']);
  const sessionIds = [
    readString(args?.['processId']),
    readString(args?.['outputSessionId']),
    readString(args?.['terminalId']),
    readString(args?.['id']),
    readString(metadata?.['processId']),
    readString(metadata?.['outputSessionId']),
    readString(metadata?.['terminalId']),
    readString(metadata?.['id']),
    readString(approvalArgs?.['processId']),
    readString(approvalArgs?.['outputSessionId']),
    readString(approvalArgs?.['terminalId']),
    readString(approvalArgs?.['id']),
    ...extractTerminalSessionIdsFromText(part.text),
  ].filter((value): value is string => !!value);

  if (sessionIds.some(sessionId => owners.sessionIds.has(sessionId))) {
    return true;
  }

  const command = readString(args?.['command'])
    || readString(args?.['cmd'])
    || readString(approvalArgs?.['command'])
    || readString(approvalArgs?.['cmd']);
  return !!command && owners.commands.has(command);
}

function isTerminalOwnedConfirmationPart(
  part: TurnResponsePart,
  owners: { toolCallIds: ReadonlySet<string>; sessionIds: ReadonlySet<string>; commands: ReadonlySet<string> },
): boolean {
  if (part.type !== 'confirmation' || !isTerminalSessionToolName(part.toolName)) {
    return false;
  }

  const partId = optionalTurnResponsePartId(part)?.replace(/^confirmation:/, '');
  if ((part.askId && owners.toolCallIds.has(part.askId)) || (partId && owners.toolCallIds.has(partId))) {
    return true;
  }

  const args = readRecord(part.args);
  const metadata = readRecord(part.metadata);
  const approval = readRecord(metadata?.['approval']);
  const approvalArgs = readRecord(approval?.['args']);
  const sessionIds = [
    readString(args?.['processId']),
    readString(args?.['outputSessionId']),
    readString(args?.['terminalId']),
    readString(args?.['id']),
    readString(approvalArgs?.['processId']),
    readString(approvalArgs?.['outputSessionId']),
    readString(approvalArgs?.['terminalId']),
    readString(approvalArgs?.['id']),
  ].filter((value): value is string => !!value);

  if (sessionIds.some(sessionId => owners.sessionIds.has(sessionId))) {
    return true;
  }

  const command = readString(args?.['command'])
    || readString(args?.['cmd'])
    || readString(approvalArgs?.['command'])
    || readString(approvalArgs?.['cmd']);
  return !!command && owners.commands.has(command);
}

function addTerminalCommandOwner(commands: Set<string>, value: unknown): void {
  const command = readString(value);
  if (command) {
    commands.add(command);
  }
}

function extractTerminalSessionIdsFromText(text: unknown): string[] {
  const raw = readString(text);
  if (!raw) {
    return [];
  }

  const ids: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (!match) {
      continue;
    }
    if (match[1] !== 'processId' && match[1] !== 'outputSessionId' && match[1] !== 'terminalId' && match[1] !== 'id') {
      continue;
    }
    const value = readString(match[2]);
    if (value) {
      ids.push(value);
    }
  }
  return ids;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function hydrateQuestionAnswersFromAskUserToolMetadata(
  parts: readonly TurnResponsePart[],
): readonly TurnResponsePart[] {
  const askUserPayloads = parts
    .map((part, index) => {
      const payload = extractAskUserQuestionPayload(part);
      return payload ? { ...payload, partIndex: index } : null;
    })
    .filter((payload): payload is AskUserQuestionPayload & { partIndex: number } => !!payload);
  if (askUserPayloads.length === 0) {
    return parts;
  }

  const nextParts = parts.map(part => ({ ...part })) as TurnResponsePart[];
  const matchedPayloadIndexes = new Set<number>();
  const duplicateQuestionPartIndexes = new Set<number>();
  let changed = false;

  for (let partIndex = 0; partIndex < nextParts.length; partIndex++) {
    const part = nextParts[partIndex] as Partial<TurnResponseQuestionPart> | undefined;
    if (part?.type !== 'question') {
      continue;
    }

    const matchingPayload = askUserPayloads.find(payload => questionPartMatchesAskUserPayload(part, payload))
      ?? (askUserPayloads.length === 1 ? askUserPayloads[0] : undefined);
    if (!matchingPayload) {
      continue;
    }

    if (matchedPayloadIndexes.has(matchingPayload.partIndex)) {
      duplicateQuestionPartIndexes.add(partIndex);
      changed = true;
      continue;
    }

    if (!part.answers || !answersMatchQuestions(matchingPayload.answers, part)) {
      nextParts[partIndex] = mergeQuestionPartWithAskUserPayload(part, matchingPayload);
      changed = true;
    }
    matchedPayloadIndexes.add(matchingPayload.partIndex);
  }

  const withSynthesizedQuestions: TurnResponsePart[] = [];
  for (let partIndex = 0; partIndex < nextParts.length; partIndex++) {
    if (duplicateQuestionPartIndexes.has(partIndex)) {
      continue;
    }
    withSynthesizedQuestions.push(nextParts[partIndex]);
    const payload = askUserPayloads.find(item => item.partIndex === partIndex);
    if (!payload || matchedPayloadIndexes.has(partIndex) || payload.questions.length === 0) {
      continue;
    }
    withSynthesizedQuestions.push(createAnsweredQuestionPartFromAskUserPayload(payload));
    changed = true;
  }

  return changed ? withSynthesizedQuestions : parts;
}

export function chatPartToTurnResponsePart(part: ChatPart): TurnResponsePart {
  switch (part.type) {
    case 'markdown': {
      const scope = normalizeChatPartScope(part);
      const metadata = withChatPartScopeMetadata(undefined, scope);
      return {
        type: 'markdown',
        ...(part.partId ? { partId: part.partId } : {}),
        content: part.content || (part.contentRef ? getMarkdownContent(part.contentRef) : ''),
        ...(scope ? scope : {}),
        ...(metadata ? { metadata } : {}),
      } as TurnResponsePart;
    }
    case 'thinking': {
      const scope = normalizeChatPartScope(part);
      const metadata = withChatPartScopeMetadata(undefined, scope);
      return {
        type: 'thinking',
        ...(part.partId ? { partId: part.partId } : {}),
        content: part.content || (part.contentRef ? getThinkContent(part.contentRef) : ''),
        isComplete: part.isComplete,
        ...(scope ? scope : {}),
        ...(metadata ? { metadata } : {}),
      } as TurnResponsePart;
    }
    case 'tool_call': {
      const scope = normalizeChatPartScope(part);
      const metadata = withChatPartScopeMetadata(part.metadata, scope);
      return {
        type: 'tool_call',
        partId: part.partId,
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        text: part.text,
        state: part.state,
        args: part.args,
        ...(scope ? scope : {}),
        ...(metadata ? { metadata } : {}),
      } as TurnResponsePart;
    }
    case 'state': {
      const scope = normalizeChatPartScope(part.metadata);
      const metadata = withChatPartScopeMetadata(part.metadata, scope);
      return {
        type: 'state',
        stateId: part.stateId,
        text: part.text,
        state: part.state,
        progress: part.progress,
        kind: part.kind as TurnResponseStatePart['kind'],
        ...(scope ? scope : {}),
        ...(metadata ? { metadata } : {}),
      } as TurnResponsePart;
    }
    case 'error':
      if (part.severity === 'warning') {
        return {
          type: 'warning',
          message: part.message,
          metadata: part.metadata,
        };
      }
      if (part.severity === 'info') {
        return {
          type: 'info',
          message: part.message,
          metadata: part.metadata,
        };
      }
      return {
        type: 'error',
        message: part.message,
        ...(part.metadata ? { metadata: part.metadata } : {}),
      } as TurnResponsePart;
    case 'question': {
      const scope = normalizeChatPartScope(part);
      const metadata = withChatPartScopeMetadata(part.metadata, scope);
      return {
        type: 'question',
        partId: part.partId,
        questions: part.questions.map(question => ({
          id: question.id,
          header: question.header,
          question: question.question,
          options: question.options?.map(option => ({ ...option })),
          allowFreeform: question.allowFreeform ?? question.allow_freeform ?? question.allowFreeformInput,
          allowFreeformInput: question.allowFreeformInput,
          multiSelect: question.multiSelect ?? question.multi_select,
        })),
        answers: cloneQuestionAnswers(part.answers),
        isHistory: part.isHistory,
        ...(scope ? scope : {}),
        ...(metadata ? { metadata } : {}),
      } satisfies TurnResponseQuestionPart;
    }
    case 'confirmation': {
      const scope = normalizeChatPartScope(part);
      const metadata = withChatPartScopeMetadata(part.metadata, scope);
      return {
        type: 'confirmation',
        partId: part.partId,
        askId: part.askId,
        toolName: part.toolName,
        title: part.title,
        subtitle: part.subtitle,
        message: part.message,
        args: part.args,
        source: part.source,
        actions: part.actions,
        primaryScope: part.primaryScope,
        resolved: part.resolved,
        result: part.result,
        scope: part.scope,
        ...(scope ? scope : {}),
        ...(metadata ? { metadata } : {}),
        ...(part.description != null ? { description: part.description } : {}),
      } as TurnResponseConfirmationPart;
    }
    case 'terminal': {
      const scope = normalizeChatPartScope(part);
      const metadata = withChatPartScopeMetadata(part.metadata, scope);
      return {
        type: 'terminal',
        partId: part.partId,
        command: part.command,
        output: part.output,
        stderr: part.stderr,
        exitCode: part.exitCode,
        isRunning: part.isRunning,
        toolCallId: part.toolCallId,
        sourceToolCallIds: part.sourceToolCallIds,
        processId: part.processId,
        outputSessionId: part.outputSessionId,
        terminalId: part.terminalId,
        outputFilePath: part.outputFilePath,
        cwd: part.cwd,
        status: part.status,
        bytesTotal: part.bytesTotal,
        lastOutputAt: part.lastOutputAt,
        ...(scope ? scope : {}),
        ...(metadata ? { metadata } : {}),
      } as TurnResponseTerminalPart;
    }
    case 'plan': {
      const scope = normalizeChatPartScope(part);
      const metadata = withChatPartScopeMetadata(undefined, scope);
      return {
        type: 'plan',
        partId: part.partId,
        status: part.status,
        text: part.text,
        steps: part.steps?.map(step => ({ ...step })),
        assumptions: part.assumptions ? [...part.assumptions] : undefined,
        verification: part.verification ? [...part.verification] : undefined,
        source: part.source,
        ...(scope ? scope : {}),
        ...(metadata ? { metadata } : {}),
      } satisfies TurnResponsePlanPart;
    }
  }
}

export function turnResponsePartToChatPart(part: TurnResponsePart, existing?: ChatPart): ChatPart {
  switch (part.type) {
    case 'markdown':
      return mkMarkdown(
        part.content,
        readTurnResponsePartScope(part),
        optionalTurnResponsePartId(part),
      );
    case 'thinking':
      return mkThinking(
        part.content,
        part.isComplete,
        readTurnResponsePartScope(part),
        optionalTurnResponsePartId(part),
      );
    case 'tool_call': {
      const scope = readTurnResponsePartScope(part);
      const metadata = withChatPartScopeMetadata(part.metadata, scope);
      return {
        ...mkToolCall(part.toolCallId, part.toolName, part.text, part.state, part.args, metadata, scope),
        partId: part.partId,
      };
    }
    case 'state':
      const statePart = part as TurnResponseStatePart;
      if (isPersistedSubagentStatePart(statePart)) {
        return persistedSubagentStatePartToToolCall(statePart);
      }
      return mkState(statePart.stateId, statePart.text, statePart.state, statePart.kind, statePart.progress, withChatPartScopeMetadata(statePart.metadata, readTurnResponsePartScope(statePart)));
    case 'error': {
      const metadata = readPartMetadata(part);
      const normalized = normalizeChatErrorNotice({
        message: part.message,
        details: metadata?.['details'],
        metadata,
      });
      const existingErrorDetails = metadata?.['errorDetails'];
      const hasExistingErrorActions = !!existingErrorDetails
        && typeof existingErrorDetails === 'object'
        && Array.isArray((existingErrorDetails as Record<string, unknown>)['confirmationButtons']);
      if (normalized.message === part.message && (!normalized.retryable || hasExistingErrorActions)) {
        return mkError(part.message, 'error', metadata);
      }
      return mkError(normalized.message, 'error', normalized.metadata);
    }
    case 'warning':
      return mkError(part.message, 'warning', part.metadata);
    case 'info':
      return mkError(part.message, 'info', part.metadata);
    case 'question': {
      const scope = readTurnResponsePartScope(part);
      const question = mkQuestion(part.questions.map(item => {
        const questionIdentity = item as typeof item & { id?: string; header?: string };
        return {
          id: questionIdentity.id,
          header: questionIdentity.header,
          question: item.question,
          options: item.options?.map(option => ({ ...option })),
          allow_freeform: item.allowFreeform,
          multi_select: item.multiSelect,
        };
      }), part.isHistory, part.partId?.replace(/^question:/, ''), scope, withChatPartScopeMetadata(part.metadata, scope));
      question.partId = part.partId ?? question.partId;
      const mergedAnswers = part.answers
        ? cloneQuestionAnswers(part.answers)
        : existing?.type === 'question'
          ? cloneQuestionAnswers(existing.answers)
          : undefined;
      if (mergedAnswers) {
        question.answers = mergedAnswers;
      }
      return question;
    }
    case 'confirmation': {
      const scope = readTurnResponsePartScope(part);
      const existingConfirmation = existing?.type === 'confirmation' ? existing : undefined;
      const confirmation = mkConfirmation(part.askId, part.message, part.toolName, part.source, {
        args: part.args ?? existingConfirmation?.args,
        title: part.title ?? existingConfirmation?.title,
        subtitle: part.subtitle ?? existingConfirmation?.subtitle,
        description: part.description ?? existingConfirmation?.description,
        actions: part.actions ?? existingConfirmation?.actions,
        primaryScope: part.primaryScope ?? existingConfirmation?.primaryScope,
        metadata: withChatPartScopeMetadata(part.metadata ?? existingConfirmation?.metadata, scope),
        ...(scope ?? {}),
      });
      confirmation.partId = part.partId ?? confirmation.partId;
      confirmation.resolved = part.resolved || existingConfirmation?.resolved || false;
      confirmation.result = part.result ?? existingConfirmation?.result;
      confirmation.scope = part.scope ?? existingConfirmation?.scope;
      return confirmation;
    }
    case 'terminal': {
      const scope = readTurnResponsePartScope(part);
      const terminal = mkTerminal(part.command, part.toolCallId, part.partId, {
        sourceToolCallIds: part.sourceToolCallIds ? [...part.sourceToolCallIds] : undefined,
        processId: part.processId,
        outputSessionId: part.outputSessionId,
        terminalId: part.terminalId,
        outputFilePath: part.outputFilePath,
        cwd: part.cwd,
        status: part.status,
        bytesTotal: part.bytesTotal,
        lastOutputAt: part.lastOutputAt,
        metadata: withChatPartScopeMetadata(part.metadata, scope),
        ...(scope ?? {}),
      });
      terminal.output = part.output;
      terminal.stderr = part.stderr;
      terminal.exitCode = part.exitCode;
      terminal.isRunning = part.isRunning;
      return terminal;
    }
    case 'plan':
      return mkPlan(part.text, part.status, part.partId, {
        steps: part.steps?.map(step => ({ ...step })),
        assumptions: part.assumptions ? [...part.assumptions] : undefined,
        verification: part.verification ? [...part.verification] : undefined,
        source: part.source,
        scope: readTurnResponsePartScope(part),
      });
    case 'subagent': {
      const subAgentInvocationId = (part as { readonly subAgentInvocationId?: string }).subAgentInvocationId || part.toolCallId;
      const toolCall = mkSubagentToolCall(part.toolCallId, part.agentName, part.description, {
        ...(part.metadata || {}),
        subAgentInvocationId,
        phase: part.state === 'error' ? 'failed' : part.state === 'done' ? 'completed' : 'started',
        toolSpecificData: {
          ...((((part.metadata && typeof part.metadata === 'object' && !Array.isArray(part.metadata))
            ? (part.metadata as Record<string, unknown>)['toolSpecificData']
            : undefined) as Record<string, unknown> | undefined) || {}),
          kind: 'subagent',
          agentName: part.agentName,
          description: part.description,
          result: part.resultText,
          childItems: part.childItems?.map(item => ({ ...item })) || [],
        },
      });
      toolCall.partId = part.partId ?? toolCall.partId;
      toolCall.state = part.state === 'error' ? 'error' : part.state === 'done' ? 'done' : 'doing';
      return toolCall;
    }
  }
}

export function turnResponsePartToChatParts(part: TurnResponsePart, existing?: ChatPart): ChatPart[] {
  const primary = turnResponsePartToChatPart(part, existing);
  if (part.type !== 'subagent' || !Array.isArray(part.childItems) || part.childItems.length === 0) {
    return [primary];
  }

  const subAgentInvocationId = part.subAgentInvocationId || part.toolCallId;
  return [
    stripLegacySubagentChildItems(primary),
    ...part.childItems.map((child, index) => legacySubagentChildItemToChatPart(
      child,
      {
        sourceAgentRole: 'subagent',
        subAgentInvocationId,
        parentToolCallId: part.toolCallId,
        sequence: index,
      },
      part.toolCallId,
      index,
    )),
  ];
}

function stripLegacySubagentChildItems(part: ChatPart): ChatPart {
  if (part.type !== 'tool_call' || !part.metadata || typeof part.metadata !== 'object') {
    return part;
  }

  const metadata = { ...part.metadata };
  const toolSpecificData = metadata['toolSpecificData'];
  if (!toolSpecificData || typeof toolSpecificData !== 'object' || Array.isArray(toolSpecificData)) {
    return part;
  }

  const nextToolSpecificData = { ...(toolSpecificData as Record<string, unknown>) };
  delete nextToolSpecificData['childItems'];
  return {
    ...part,
    metadata: {
      ...metadata,
      toolSpecificData: nextToolSpecificData,
    },
  };
}

function isPersistedSubagentStatePart(part: TurnResponseStatePart): boolean {
  return part.type === 'state'
    && typeof part.stateId === 'string'
    && part.stateId.startsWith('subagent:');
}

function persistedSubagentStatePartToToolCall(part: TurnResponseStatePart): ChatPart {
  const metadata = readPartMetadata(part) ?? {};
  const toolCallId = stringMetadata(metadata, 'toolCallId')
    || stringMetadata(metadata, 'subAgentInvocationId')
    || part.stateId.slice('subagent:'.length);
  const agentName = stringMetadata(metadata, 'agentName')
    || stringMetadata(metadata, 'name')
    || 'Agent';
  const description = stringMetadata(metadata, 'description')
    || part.text
    || agentName;
  const subAgentInvocationId = stringMetadata(metadata, 'subAgentInvocationId') || toolCallId;
  const toolCall = mkSubagentToolCall(toolCallId, agentName, description, {
    ...metadata,
    subAgentInvocationId,
    toolSpecificData: {
      ...metadataRecord(metadata['toolSpecificData']),
      kind: 'subagent',
      agentName,
      description,
      result: stringMetadata(metadata, 'resultText') || stringMetadata(metadata, 'result') || '',
    },
  });
  toolCall.state = part.state === 'error' ? 'error' : part.state === 'done' ? 'done' : 'doing';
  return toolCall;
}

function stringMetadata(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function metadataRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function legacySubagentChildItemToChatPart(
  child: Extract<TurnResponsePart, { type: 'subagent' }>['childItems'][number],
  scope: NonNullable<ReturnType<typeof normalizeChatPartScope>>,
  parentToolCallId: string,
  index: number,
): ChatPart {
  switch (child.kind) {
    case 'thinking':
      return mkThinking(child.content || '', true, scope);
    case 'text':
      return mkMarkdown(child.content || '', scope);
    case 'tool': {
      const toolCallId = typeof child.toolCallId === 'string' && child.toolCallId.trim().length > 0
        ? child.toolCallId
        : `${parentToolCallId}:legacy-child:${index}`;
      const toolName = typeof child.toolName === 'string' && child.toolName.trim().length > 0
        ? child.toolName
        : 'tool';
      const state = child.state === 'error'
        ? 'error'
        : child.state === 'doing'
          ? 'doing'
          : 'done';
      return mkToolCall(
        toolCallId,
        toolName,
        child.content || child.argsSummary || toolName,
        state,
        child.argsSummary ? { summary: child.argsSummary } : undefined,
        withChatPartScopeMetadata({
          legacySubagentChild: true,
          ...(typeof child.duration === 'number' ? { duration: child.duration } : {}),
        }, scope),
        scope,
      );
    }
  }
}

function cloneQuestionAnswers(
  answers: TurnResponseQuestionPart['answers'] | MutableQuestionAnswers,
): MutableQuestionAnswers | undefined {
  if (!answers) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(answers)
      .map(([key, answer]) => {
        const normalized = normalizeQuestionAnswer(answer);
        return normalized ? [key, normalized] as const : null;
      })
      .filter((entry): entry is readonly [string, MutableQuestionAnswers[string]] => !!entry),
  );
}

function normalizeQuestionAnswer(answer: unknown): MutableQuestionAnswers[string] | null {
  if (typeof answer === 'string') {
    return {
      selected: [answer],
      freeText: null,
      skipped: false,
    };
  }
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) {
    return null;
  }
  const candidate = answer as { selected?: unknown; freeText?: unknown; skipped?: unknown };
  return {
    selected: Array.isArray(candidate.selected)
      ? candidate.selected.filter((item): item is string => typeof item === 'string')
      : [],
    freeText: typeof candidate.freeText === 'string' ? candidate.freeText : null,
    skipped: !!candidate.skipped,
  };
}

type AskUserQuestionPayload = {
  readonly toolCallId?: string;
  readonly questions: TurnResponseQuestionPart['questions'];
  readonly answers: NonNullable<MutableQuestionAnswers>;
  readonly metadata?: Record<string, unknown>;
};

function extractAskUserQuestionPayload(part: TurnResponsePart): AskUserQuestionPayload | undefined {
  if (part.type !== 'tool_call' || part.toolName !== 'ask_questions') {
    return undefined;
  }

  const metadata = (part as { metadata?: unknown }).metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return undefined;
  }

  const payload = readAskUserQuestionAnswerPayload(metadata as Record<string, unknown>);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return undefined;
  }

  const answers = normalizeQuestionAnswers((payload as { answers?: unknown }).answers);
  if (!answers) {
    return undefined;
  }

  return {
    toolCallId: part.toolCallId,
    questions: normalizeAskUserQuestionsFromToolPart(part),
    answers,
    metadata: {
      ...(metadata as Record<string, unknown>),
      askUserQuestionAnswer: payload,
    },
  };
}

function readAskUserQuestionAnswerPayload(metadata: Record<string, unknown>): unknown {
  const direct = metadata['askUserQuestionAnswer'];
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) {
    return direct;
  }

  const result = metadata['result'];
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return undefined;
  }
  const resultMetadata = (result as Record<string, unknown>)['metadata'];
  if (!resultMetadata || typeof resultMetadata !== 'object' || Array.isArray(resultMetadata)) {
    return undefined;
  }
  return (resultMetadata as Record<string, unknown>)['askUserQuestionAnswer'];
}

function normalizeAskUserQuestionsFromToolPart(part: TurnResponsePart): TurnResponseQuestionPart['questions'] {
  const argsQuestions = normalizeAskUserQuestionsFromArgs((part as { args?: unknown }).args);
  if (argsQuestions.length > 0) {
    return argsQuestions;
  }

  return normalizeAskUserQuestions((part as { questions?: unknown }).questions);
}

function normalizeQuestionAnswers(answers: unknown): MutableQuestionAnswers | undefined {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
    return undefined;
  }

  const normalized: NonNullable<MutableQuestionAnswers> = {};
  for (const [question, answer] of Object.entries(answers)) {
    const normalizedAnswer = normalizeQuestionAnswer(answer);
    if (!normalizedAnswer) {
      continue;
    }
    normalized[question] = normalizedAnswer;
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeAskUserQuestionsFromArgs(args: unknown): TurnResponseQuestionPart['questions'] {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return [];
  }

  const record = args as Record<string, unknown>;
  const listQuestions = normalizeAskUserQuestions(record['questions']);
  if (listQuestions.length > 0) {
    return listQuestions;
  }

  const questionText = typeof record['question'] === 'string' ? record['question'].trim() : '';
  if (!questionText) {
    return [];
  }

  return [{
    ...(typeof record['header'] === 'string' && record['header'].trim().length > 0 ? { header: record['header'].trim() } : {}),
    ...(typeof record['id'] === 'string' && record['id'].trim().length > 0 ? { id: record['id'].trim() } : {}),
    question: questionText,
    options: normalizeAskUserOptions(record['options']),
    allowFreeform: !!(record['allowFreeformInput'] ?? record['allowFreeform'] ?? record['allow_freeform']),
    multiSelect: !!(record['multiSelect'] ?? record['multi_select']),
  }];
}

function normalizeAskUserQuestions(questions: unknown): TurnResponseQuestionPart['questions'] {
  if (!Array.isArray(questions)) {
    return [];
  }

  return questions
    .map(question => {
      if (!question || typeof question !== 'object' || Array.isArray(question)) {
        return null;
      }
      const record = question as Record<string, unknown>;
      const questionText = typeof record['question'] === 'string' ? record['question'].trim() : '';
      if (!questionText) {
        return null;
      }
      const normalizedQuestion: TurnResponseQuestionPart['questions'][number] = {
        ...(typeof record['header'] === 'string' && record['header'].trim().length > 0 ? { header: record['header'].trim() } : {}),
        ...(typeof record['id'] === 'string' && record['id'].trim().length > 0 ? { id: record['id'].trim() } : {}),
        question: questionText,
        options: normalizeAskUserOptions(record['options']),
        allowFreeform: !!(record['allowFreeformInput'] ?? record['allowFreeform'] ?? record['allow_freeform']),
        multiSelect: !!(record['multiSelect'] ?? record['multi_select']),
      };
      return normalizedQuestion;
    })
    .filter((question): question is TurnResponseQuestionPart['questions'][number] => !!question);
}

function normalizeAskUserOptions(options: unknown): TurnResponseQuestionPart['questions'][number]['options'] {
  if (!Array.isArray(options)) {
    return undefined;
  }

  const normalized = options
    .map(option => {
      if (!option || typeof option !== 'object' || Array.isArray(option)) {
        return null;
      }
      const record = option as Record<string, unknown>;
      const label = typeof record['label'] === 'string' ? record['label'].trim() : '';
      if (!label) {
        return null;
      }
      return {
        label,
        ...(typeof record['description'] === 'string' ? { description: record['description'] } : {}),
        ...(typeof record['recommended'] === 'boolean' ? { recommended: record['recommended'] } : {}),
      };
    })
    .filter((option): option is NonNullable<TurnResponseQuestionPart['questions'][number]['options']>[number] => !!option);

  return normalized.length > 0 ? normalized : undefined;
}

function createAnsweredQuestionPartFromAskUserPayload(payload: AskUserQuestionPayload): TurnResponsePart {
  return {
    type: 'question',
    partId: payload.toolCallId ? `question:${payload.toolCallId}` : undefined,
    questions: payload.questions,
    answers: cloneQuestionAnswers(payload.answers),
    isHistory: true,
    metadata: {
      askUserQuestionAnswer: payload.metadata?.['askUserQuestionAnswer'],
      materializedFromAskUserToolCall: true,
      ...(payload.toolCallId ? { sourceToolCallId: payload.toolCallId } : {}),
    },
  } satisfies TurnResponseQuestionPart;
}

function mergeQuestionPartWithAskUserPayload(
  part: Partial<TurnResponseQuestionPart>,
  payload: AskUserQuestionPayload,
): TurnResponsePart {
  const existingQuestions = Array.isArray(part.questions) ? part.questions : [];
  return {
    ...part,
    questions: existingQuestions.length > 0 ? existingQuestions : payload.questions,
    answers: cloneQuestionAnswers(payload.answers),
    isHistory: true,
    metadata: {
      ...(part.metadata && typeof part.metadata === 'object' && !Array.isArray(part.metadata)
        ? part.metadata
        : {}),
      askUserQuestionAnswer: payload.metadata?.['askUserQuestionAnswer'],
      materializedFromAskUserToolCall: true,
      ...(payload.toolCallId ? { sourceToolCallId: payload.toolCallId } : {}),
    },
  } as TurnResponsePart;
}

function questionPartMatchesAskUserPayload(
  part: Partial<TurnResponseQuestionPart>,
  payload: AskUserQuestionPayload,
): boolean {
  const partId = typeof part.partId === 'string' ? part.partId : '';
  if (payload.toolCallId && partId === `question:${payload.toolCallId}`) {
    return true;
  }

  const metadata = part.metadata && typeof part.metadata === 'object' && !Array.isArray(part.metadata)
    ? part.metadata as Record<string, unknown>
    : undefined;
  if (payload.toolCallId && metadata?.['sourceToolCallId'] === payload.toolCallId) {
    return true;
  }

  return answersMatchQuestions(payload.answers, part);
}

function answersMatchQuestions(
  answers: NonNullable<MutableQuestionAnswers>,
  questionPart: Partial<TurnResponseQuestionPart>,
): boolean {
  const questions = Array.isArray(questionPart.questions)
    ? questionPart.questions
      .map(question => question?.question)
      .filter((question): question is string => typeof question === 'string' && question.trim().length > 0)
    : [];
  if (questions.length === 0) {
    return false;
  }

  const questionSet = new Set(questions);
  const answerKeys = Object.keys(answers).filter(question => question.trim().length > 0);
  return answerKeys.length > 0 && answerKeys.every(question => questionSet.has(question));
}

function readPartMetadata(part: unknown): Record<string, unknown> | undefined {
  const metadata = part && typeof part === 'object' && !Array.isArray(part)
    ? (part as { metadata?: unknown }).metadata
    : undefined;
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : undefined;
}

function readTurnResponsePartScope(part: TurnResponsePart): ChatPartScope | undefined {
  const metadataScope = normalizeChatPartScope((part as ScopedTurnResponsePartMetadata).metadata);
  const directScope = normalizeChatPartScope(part as ScopedTurnResponsePart);
  if (!metadataScope) {
    return directScope;
  }
  if (!directScope) {
    return metadataScope;
  }
  return normalizeChatPartScope({
    ...metadataScope,
    ...directScope,
  });
}
