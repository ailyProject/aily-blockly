import { createBrowserFrameBudget } from '@shared/public-api';

describe('createBrowserFrameBudget', () => {
  it('yields only after the frame budget is exhausted', async () => {
    let now = 0;
    const yields: string[] = [];
    const yieldSpy = jasmine.createSpy('yield').and.callFake(async () => {
      yields.push('yield');
      now += 1;
    });
    const onYield = jasmine.createSpy('onYield');
    const budget = createBrowserFrameBudget({
      budgetMs: 6,
      maxContinuousMs: 18,
      now: () => now,
      yield: yieldSpy,
      onYield,
    });

    await budget.checkpoint('start');
    now = 5;
    await budget.checkpoint('under-budget');

    expect(yieldSpy).not.toHaveBeenCalled();
    expect(budget.checkpointCount).toBe(2);

    now = 6;
    await budget.checkpoint('at-budget');

    expect(yieldSpy).toHaveBeenCalledTimes(1);
    expect(onYield).toHaveBeenCalledWith(jasmine.objectContaining({
      label: 'at-budget',
      elapsedMs: 6,
      continuousMs: 6,
      checkpointCount: 3,
    }));
    expect(yields).toEqual(['yield']);
  });

  it('uses the continuous budget even when individual checkpoint elapsed time is small', async () => {
    let now = 0;
    const yieldSpy = jasmine.createSpy('yield').and.callFake(async () => {
      now += 1;
    });
    const budget = createBrowserFrameBudget({
      budgetMs: 100,
      maxContinuousMs: 10,
      now: () => now,
      yield: yieldSpy,
    });

    now = 9;
    await budget.checkpoint('still-ok');
    expect(yieldSpy).not.toHaveBeenCalled();

    now = 10;
    await budget.checkpoint('continuous-limit');
    expect(yieldSpy).toHaveBeenCalledTimes(1);
  });

  it('reset starts a fresh operation budget', async () => {
    let now = 0;
    const yieldSpy = jasmine.createSpy('yield').and.resolveTo(undefined);
    const budget = createBrowserFrameBudget({
      budgetMs: 4,
      now: () => now,
      yield: yieldSpy,
    });

    now = 5;
    await budget.checkpoint('first-operation');
    expect(yieldSpy).toHaveBeenCalledTimes(1);
    expect(budget.checkpointCount).toBe(1);

    budget.reset();
    now = 6;
    await budget.checkpoint('second-operation');
    expect(yieldSpy).toHaveBeenCalledTimes(1);
    expect(budget.checkpointCount).toBe(1);
  });
});
