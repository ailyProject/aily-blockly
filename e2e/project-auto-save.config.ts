import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests', testMatch: 'project-auto-save.spec.ts', workers: 1,
  timeout: 180_000, expect: { timeout: 20_000 }, retries: 0,
  outputDir: './test-results/project-auto-save', reporter: [['list']],
  use: { screenshot: 'only-on-failure', trace: 'retain-on-failure' },
});
