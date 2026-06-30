import type { TurnResponseTurn } from 'aily-lex/browser';

import {
  hydrateQuestionAnswersFromAskUserToolMetadata,
} from './turn-response-part-mapper';
import {
  cloneTurnResponseModelSidecar,
} from '../helpers/turn-response-response-model';

export class CanonicalTurnResponseStore {
  private readonly turns = new Map<string, TurnResponseTurn>();
  private _revision = 0;

  get revision(): number {
    return this._revision;
  }

  get size(): number {
    return this.turns.size;
  }

  turnIds(): readonly string[] {
    return [...this.turns.keys()];
  }

  has(turnId: string | null | undefined): boolean {
    return typeof turnId === 'string' && this.turns.has(turnId);
  }

  get(turnId: string | null | undefined): TurnResponseTurn | null {
    if (typeof turnId !== 'string') {
      return null;
    }
    const turn = this.turns.get(turnId);
    return turn ? cloneCanonicalTurnResponseTurn(turn) : null;
  }

  set(turn: TurnResponseTurn): void {
    this.turns.set(turn.turnId, cloneCanonicalTurnResponseTurn(turn));
    this._revision += 1;
  }

  clear(): void {
    if (this.turns.size > 0) {
      this._revision += 1;
    }
    this.turns.clear();
  }

  replace(turns: readonly TurnResponseTurn[]): void {
    this.clear();
    for (const turn of turns) {
      this.set(turn);
    }
  }

  snapshot(): readonly TurnResponseTurn[] {
    return [...this.turns.values()]
      .sort((left, right) => left.createdAt - right.createdAt)
      .map(turn => cloneCanonicalTurnResponseTurn(turn));
  }

  resolveLatestStreamingTurn(): TurnResponseTurn | null {
    let latest: TurnResponseTurn | null = null;
    for (const turn of this.turns.values()) {
      if (turn.response.status !== 'streaming') {
        continue;
      }
      if (!latest || turn.updatedAt > latest.updatedAt) {
        latest = turn;
      }
    }
    return latest ? cloneCanonicalTurnResponseTurn(latest) : null;
  }
}

export function cloneCanonicalTurnResponseTurn(turn: TurnResponseTurn): TurnResponseTurn {
  const responseModel = cloneTurnResponseModelSidecar(turn.responseModel);

  return {
    ...turn,
    ...(turn.usage ? { usage: { ...turn.usage } } : {}),
    request: { ...turn.request },
    rounds: turn.rounds.map(round => ({
      ...round,
      toolCalls: round.toolCalls.map(toolCall => ({ ...toolCall })),
    })),
    response: {
      ...turn.response,
      ...(turn.response.usedContext
        ? {
          usedContext: {
            ...turn.response.usedContext,
            documents: turn.response.usedContext.documents.map(document => ({
              ...document,
              ranges: document.ranges.map(range => ({ ...range })),
            })),
          },
        }
        : {}),
      contentReferences: (turn.response.contentReferences ?? []).map(reference => ({
        ...reference,
        ...(reference.options
          ? {
            options: {
              ...reference.options,
              ...(reference.options.status ? { status: { ...reference.options.status } } : {}),
              ...(reference.options.diffMeta ? { diffMeta: { ...reference.options.diffMeta } } : {}),
            },
          }
          : {}),
      })),
      codeCitations: (turn.response.codeCitations ?? []).map(citation => ({ ...citation })),
      progressMessages: (turn.response.progressMessages ?? []).map(message => ({ ...message })),
      parts: hydrateQuestionAnswersFromAskUserToolMetadata(turn.response.parts).map(part => ({ ...part })),
    },
    ...(responseModel ? { responseModel } : {}),
  };
}
