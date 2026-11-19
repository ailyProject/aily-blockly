import type { Reporter, TestCase, TestStep } from '@playwright/test/reporter';
export default class SaveAsReporter implements Reporter {
  onStepBegin(test: TestCase, _result: unknown, step: TestStep) {
    if (step.category === 'test.step') console.log(`[另存为] ${test.parent.title}: ${step.title}`);
  }
}
