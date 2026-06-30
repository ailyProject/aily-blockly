import type { SessionSnapshot, TurnRequest } from 'aily-lex/browser';

interface TurnControlLike {
  getCurrentTurnId(): string | undefined;
  getCurrentTurnIndex?(): number | undefined;
  findTurnIdByRoundId(roundId: string): string | undefined;
  getRequestContent(turnId: string): string | undefined;
  getLastRoundId(turnId: string): string | undefined;
  getCurrentRequestMetadata?(): TurnRequest['metadata'] | undefined;
  startTurn(content: string, displayContent?: string, metadata?: TurnRequest['metadata']): string | undefined;
  completeTurn(response: string): void;
  failTurn(): void;
  removeIncomplete(): boolean;
  removeFromTurn(turnId: string): void;
  truncateToTurn(turnId: string): void;
  clearTurns(): void;
  toSnapshot(): SessionSnapshot | null;
}

export class LexTurnControlBridge {
  constructor(private readonly turnControl: TurnControlLike) {}

  currentId(): string | undefined {
    return this.turnControl.getCurrentTurnId();
  }

  currentIndex(): number | undefined {
    return this.turnControl.getCurrentTurnIndex?.();
  }

  turnIdByRound(roundId: string): string | undefined {
    return this.turnControl.findTurnIdByRoundId(roundId);
  }

  requestContent(turnId: string): string | undefined {
    return this.turnControl.getRequestContent(turnId);
  }

  lastRoundId(turnId: string): string | undefined {
    return this.turnControl.getLastRoundId(turnId);
  }

  currentRequestMetadata(): TurnRequest['metadata'] | undefined {
    return this.turnControl.getCurrentRequestMetadata?.();
  }

  start(content: string, displayContent?: string, metadata?: TurnRequest['metadata']): string | undefined {
    return this.turnControl.startTurn(content, displayContent, metadata);
  }

  complete(response: string): void {
    this.turnControl.completeTurn(response);
  }

  fail(): void {
    this.turnControl.failTurn();
  }

  discardIncomplete(): boolean {
    return this.turnControl.removeIncomplete();
  }

  removeFrom(turnId: string): void {
    this.turnControl.removeFromTurn(turnId);
  }

  restartFrom(turnId: string): void {
    this.turnControl.truncateToTurn(turnId);
  }

  clear(): void {
    this.turnControl.clearTurns();
  }

  snapshot(): SessionSnapshot | null {
    return this.turnControl.toSnapshot();
  }
}
