import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests', testMatch: 'save-contention.spec.ts', workers: 1,
  timeout: 180_000, expect: { timeout: 30_000 }, reporter: [['list']],
  outputDir: './test-results/save-contention',
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
