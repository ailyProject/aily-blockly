import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

import { createEmptyContextBudgetSnapshot } from './context-budget-snapshot';
import type { ContextBudgetSnapshot } from './context-budget-snapshot';

@Injectable({
  providedIn: 'root',
})
export class ContextBudgetViewService {
  private readonly budgetSubject = new BehaviorSubject<ContextBudgetSnapshot>(createEmptyContextBudgetSnapshot());

  readonly budget$ = this.budgetSubject.asObservable();

  getSnapshot(): ContextBudgetSnapshot {
    return this.budgetSubject.getValue();
  }

  applySnapshot(snapshot: ContextBudgetSnapshot): void {
    this.budgetSubject.next(snapshot);
  }

  reset(snapshot?: ContextBudgetSnapshot): void {
    this.budgetSubject.next(snapshot ?? createEmptyContextBudgetSnapshot());
  }
}