import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests', testMatch: 'log-navigation.spec.ts', workers: 1,
  timeout: 120_000, expect: { timeout: 15_000 }, retries: 0,
  outputDir: './test-results/log-navigation', reporter: [['list']],
  use: { screenshot: 'only-on-failure', trace: 'retain-on-failure' },
});
