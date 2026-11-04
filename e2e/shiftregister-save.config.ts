import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests', testMatch: 'shiftregister-save.spec.ts', workers: 1,
  timeout: 180_000, expect: { timeout: 30_000 }, reporter: [['list']],
  outputDir: './test-results/shiftregister-save',
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
