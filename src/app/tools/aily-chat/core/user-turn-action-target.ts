import type { TurnResponseTurn } from 'aily-lex/browser';

/**
 * Legacy interaction metadata kept only for helper/task-action compatibility.
 * New UI/view-model code should prefer DialogTurnContext directly.
 */
export interface LegacyTurnInteractionMetadata {
  readonly turnId: string;
  readonly requestContent?: string;
  readonly displayContent?: string;
  readonly roundCount: number;
  readonly toolCallCount: number;
  readonly lastRoundId?: string;
  readonly turnResponse: TurnResponseTurn | null;
}

export interface DialogTurnContext {
  readonly turnId: string;
  readonly request: TurnResponseTurn['request'] | null;
  readonly response: TurnResponseTurn['response'] | null;
  readonly rounds: TurnResponseTurn['rounds'];
  readonly requestDisabled?: boolean;
  readonly requestContent?: string;
  readonly displayContent?: string;
  readonly roundCount: number;
  readonly toolCallCount: number;
  readonly lastRoundId?: string;
  readonly turnResponse: TurnResponseTurn | null;
}

export type TurnInteractionTarget = LegacyTurnInteractionMetadata | DialogTurnContext;

export type TurnInteractionTargetLike = Partial<LegacyTurnInteractionMetadata> & Partial<DialogTurnContext>;

export function getTurnRoundCount(turn: TurnResponseTurn | null | undefined): number {
  return turn?.rounds.length ?? 0;
}

export function getTurnToolCallCount(turn: TurnResponseTurn | null | undefined): number {
  return turn?.rounds.reduce((count, round) => count + round.toolCalls.length, 0) ?? 0;
}

export function getTurnLastRoundId(turn: TurnResponseTurn | null | undefined): string | undefined {
  return turn?.rounds.at(-1)?.id;
}

export function getInteractionRounds(target: TurnInteractionTargetLike | null | undefined): TurnResponseTurn['rounds'] {
  return target?.rounds ?? target?.turnResponse?.rounds ?? [];
}

export function getInteractionRequestContent(target: TurnInteractionTargetLike | null | undefined): string | undefined {
  return target?.requestContent ?? target?.request?.content ?? target?.turnResponse?.request.content;
}

export function getInteractionDisplayContent(target: TurnInteractionTargetLike | null | undefined): string | undefined {
  return target?.displayContent
    ?? target?.request?.displayContent
    ?? target?.turnResponse?.request.displayContent
    ?? getInteractionRequestContent(target);
}

export function getInteractionRoundCount(target: TurnInteractionTargetLike | null | undefined): number {
  if (typeof target?.roundCount === 'number') {
    return target.roundCount;
  }

  return getInteractionRounds(target).length;
}

export function getInteractionToolCallCount(target: TurnInteractionTargetLike | null | undefined): number {
  if (typeof target?.toolCallCount === 'number') {
    return target.toolCallCount;
  }

  return getInteractionRounds(target).reduce((count, round) => count + round.toolCalls.length, 0);
}

export function getInteractionLastRoundId(target: TurnInteractionTargetLike | null | undefined): string | undefined {
  return target?.lastRoundId ?? getInteractionRounds(target).at(-1)?.id;
}

export function buildDialogTurnContext(params: {
  turnId?: string;
  turnResponse?: TurnResponseTurn | null;
  request?: TurnResponseTurn['request'] | null;
  response?: TurnResponseTurn['response'] | null;
  rounds?: TurnResponseTurn['rounds'];
  requestDisabled?: boolean;
  requestContent?: string;
  displayContent?: string;
}): DialogTurnContext | null {
  const turnResponse = params.turnResponse ?? null;
  const turnId = params.turnId ?? turnResponse?.turnId;
  if (!turnId) {
    return null;
  }

  const baseRequest = params.request ?? turnResponse?.request ?? null;
  const requestContent = params.requestContent ?? baseRequest?.content;
  const displayContent = params.displayContent
    ?? baseRequest?.displayContent
    ?? requestContent;
  const request = baseRequest
    ? ((requestContent === baseRequest.content && displayContent === baseRequest.displayContent)
        ? baseRequest
        : {
            ...baseRequest,
            ...(typeof requestContent === 'string' ? { content: requestContent } : {}),
            ...(typeof displayContent === 'string' ? { displayContent } : {}),
          })
    : (typeof requestContent === 'string' || typeof displayContent === 'string'
        ? {
            content: requestContent ?? displayContent ?? '',
            ...(typeof displayContent === 'string' ? { displayContent } : {}),
          } as TurnResponseTurn['request']
        : null);
  const rounds = params.rounds ?? turnResponse?.rounds ?? [];
  const response = params.response ?? turnResponse?.response ?? null;

  return {
    turnId,
    request,
    response,
    rounds,
    requestDisabled: params.requestDisabled === true,
    requestContent,
    displayContent,
    roundCount: getInteractionRoundCount({ roundCount: undefined, rounds, turnResponse }),
    toolCallCount: getInteractionToolCallCount({ toolCallCount: undefined, rounds, turnResponse }),
    lastRoundId: getInteractionLastRoundId({ lastRoundId: undefined, rounds, turnResponse }),
    turnResponse,
  } satisfies DialogTurnContext;
}

export function toDialogTurnContext(target: TurnInteractionTargetLike | null | undefined): DialogTurnContext | null {
  if (!target) {
    return null;
  }

  if (
    'request' in target
    || 'response' in target
    || 'rounds' in target
  ) {
    return buildDialogTurnContext({
      turnId: target.turnId,
      turnResponse: target.turnResponse,
      request: target.request ?? undefined,
      response: target.response ?? undefined,
      rounds: target.rounds,
      requestDisabled: target.requestDisabled,
      requestContent: getInteractionRequestContent(target),
      displayContent: getInteractionDisplayContent(target),
    });
  }

  return buildDialogTurnContext({
    turnId: target.turnId,
    turnResponse: target.turnResponse,
    requestDisabled: target.requestDisabled,
    requestContent: getInteractionRequestContent(target),
    displayContent: getInteractionDisplayContent(target),
  });
}