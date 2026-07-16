import type { TurnResponseTurn } from 'aily-lex/browser';
import type { ChatRuntimeHostTurnPage } from './chat-runtime-host-contract';

export interface ChatVisibleTurnWindowSnapshot {
  readonly sessionId: string | null;
  readonly turns: readonly TurnResponseTurn[];
  readonly nextCursor: string | null;
  readonly backwardsCursor: string | null;
  readonly revision: number;
  readonly loadingOlder: boolean;
  readonly generation: number;
}

export interface ChatVisibleTurnWindowPrependResult {
  readonly addedTurnIds: readonly string[];
  readonly addedCount: number;
}

/**
 * Renderer hydration state only. The complete request list remains owned by
 * the execution-host session model.
 */
export class ChatVisibleTurnWindowModel {
  private sessionId: string | null = null;
  private turns: readonly TurnResponseTurn[] = [];
  private readonly turnIndexById = new Map<string, number>();
  private nextCursor: string | null = null;
  private backwardsCursor: string | null = null;
  private revision = 0;
  private loadingOlder = false;
  private generation = 0;

  get snapshot(): ChatVisibleTurnWindowSnapshot {
    return {
      sessionId: this.sessionId,
      turns: this.turns,
      nextCursor: this.nextCursor,
      backwardsCursor: this.backwardsCursor,
      revision: this.revision,
      loadingOlder: this.loadingOlder,
      generation: this.generation,
    };
  }

  attach(sessionId: string, page: ChatRuntimeHostTurnPage | null): void {
    const normalizedSessionId = sessionId.trim();
    this.generation += 1;
    this.sessionId = normalizedSessionId || null;
    this.loadingOlder = false;
    if (!normalizedSessionId || !page || page.sessionId !== normalizedSessionId) {
      this.turns = [];
      this.turnIndexById.clear();
      this.nextCursor = null;
      this.backwardsCursor = null;
      this.revision = 0;
      return;
    }

    this.turns = deduplicateTurnsChronologically(page.data);
    this.rebuildTurnIndex();
    this.nextCursor = page.nextCursor;
    this.backwardsCursor = page.backwardsCursor;
    this.revision = page.revision;
  }

  detach(sessionId?: string | null): void {
    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (normalizedSessionId && normalizedSessionId !== this.sessionId) {
      return;
    }
    this.generation += 1;
    this.sessionId = null;
    this.turns = [];
    this.turnIndexById.clear();
    this.nextCursor = null;
    this.backwardsCursor = null;
    this.revision = 0;
    this.loadingOlder = false;
  }

  readTurns(sessionId: string | null | undefined): readonly TurnResponseTurn[] | null {
    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    return normalizedSessionId && normalizedSessionId === this.sessionId ? this.turns : null;
  }

  beginOlderLoad(sessionId: string): { readonly cursor: string; readonly generation: number } | null {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId
      || normalizedSessionId !== this.sessionId
      || this.loadingOlder
      || !this.nextCursor) {
      return null;
    }
    this.loadingOlder = true;
    return { cursor: this.nextCursor, generation: this.generation };
  }

  prependOlderPage(
    sessionId: string,
    generation: number,
    page: ChatRuntimeHostTurnPage | null,
  ): ChatVisibleTurnWindowPrependResult | null {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId
      || normalizedSessionId !== this.sessionId
      || generation !== this.generation) {
      return null;
    }
    this.loadingOlder = false;
    if (!page || page.sessionId !== normalizedSessionId) {
      return { addedTurnIds: [], addedCount: 0 };
    }

    const olderTurns = deduplicateTurnsChronologically(page.data)
      .filter(turn => !this.turnIndexById.has(turn.turnId));
    this.turns = olderTurns.length > 0 ? [...olderTurns, ...this.turns] : this.turns;
    if (olderTurns.length > 0) {
      this.rebuildTurnIndex();
    }
    this.nextCursor = page.nextCursor;
    this.backwardsCursor = this.backwardsCursor ?? page.backwardsCursor;
    this.revision = Math.max(this.revision, page.revision);
    return {
      addedTurnIds: olderTurns.map(turn => turn.turnId),
      addedCount: olderTurns.length,
    };
  }

  failOlderLoad(sessionId: string, generation: number): void {
    if (sessionId.trim() === this.sessionId && generation === this.generation) {
      this.loadingOlder = false;
    }
  }

  upsertLatestTurn(sessionId: string, turn: TurnResponseTurn): boolean {
    const normalizedSessionId = sessionId.trim();
    const turnId = typeof turn?.turnId === 'string' ? turn.turnId.trim() : '';
    if (!normalizedSessionId || normalizedSessionId !== this.sessionId || !turnId) {
      return false;
    }

    const index = this.turnIndexById.get(turnId);
    if (index !== undefined) {
      if (this.turns[index] === turn) {
        return false;
      }
      const next = [...this.turns];
      next[index] = turn;
      this.turns = next;
      return true;
    }

    this.turns = [...this.turns, turn];
    this.turnIndexById.set(turnId, this.turns.length - 1);
    return true;
  }

  mergeLoadedTurns(sessionId: string, turns: readonly TurnResponseTurn[]): boolean {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId || normalizedSessionId !== this.sessionId || turns.length === 0) {
      return false;
    }

    const incomingById = new Map(turns.map(turn => [turn.turnId, turn]));
    let changed = false;
    const next = this.turns.map(turn => {
      const incoming = incomingById.get(turn.turnId);
      if (!incoming || incoming === turn) {
        return turn;
      }
      changed = true;
      return incoming;
    });
    const latest = turns[turns.length - 1];
    if (latest && !next.some(turn => turn.turnId === latest.turnId)) {
      next.push(latest);
      changed = true;
    }
    if (changed) {
      this.turns = next;
      this.rebuildTurnIndex();
    }
    return changed;
  }

  private rebuildTurnIndex(): void {
    this.turnIndexById.clear();
    for (let index = 0; index < this.turns.length; index += 1) {
      this.turnIndexById.set(this.turns[index].turnId, index);
    }
  }
}

function deduplicateTurnsChronologically(
  turns: readonly TurnResponseTurn[],
): readonly TurnResponseTurn[] {
  const seen = new Set<string>();
  const descending: TurnResponseTurn[] = [];
  for (const turn of turns) {
    const turnId = typeof turn?.turnId === 'string' ? turn.turnId.trim() : '';
    if (turnId && !seen.has(turnId)) {
      seen.add(turnId);
      descending.push(turn);
    }
  }
  return descending.reverse();
}
