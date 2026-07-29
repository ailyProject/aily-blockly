import type { Observable } from 'rxjs';

import type { ModelConfigOption } from './aily-chat-config.service';
import type { LexContextBudgetSnapshotExtra } from './context-budget-lex-event';
import type { ContextBudgetSnapshot } from './context-budget-snapshot';

export interface ChatRuntimeOwnerContextBudgetPort {
  getSnapshot(): ContextBudgetSnapshot;
  readonly budget$?: Observable<ContextBudgetSnapshot>;
  readonly maxContextTokens?: number;
  readonly compressionThreshold?: number;
  readonly summarizationThreshold?: number;
  updateModelContextSize(model: string | Partial<ModelConfigOption> | null): void;
  refreshLocalEstimate(messages: any[], tools?: any[]): void;
  applyLexBudgetEvent(
    maxTokens: number,
    usedTokens: number,
    extra?: LexContextBudgetSnapshotExtra,
  ): void;
  reset(): void;
}

