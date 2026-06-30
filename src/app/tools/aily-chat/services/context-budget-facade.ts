import type { LexContextBudgetSnapshotExtra } from './context-budget-lex-event';
import type { ContextBudgetSnapshot } from './context-budget-snapshot';
import type { ModelConfigOption } from './aily-chat-config.service';

export interface ContextBudgetFacade {
  getSnapshot(): ContextBudgetSnapshot;
  updateModelContextSize(model: string | Partial<ModelConfigOption> | null): void;
  refreshLocalEstimate(messages: any[], tools?: any[]): void;
  applyLexBudgetEvent(
    maxTokens: number,
    usedTokens: number,
    extra?: LexContextBudgetSnapshotExtra,
  ): void;
  reset(): void;
}