import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests', testMatch: 'coder-case-path-close.spec.ts', workers: 1,
  timeout: 300_000, expect: { timeout: 30_000 }, reporter: [['list']],
  outputDir: './.artifacts/coder-case-path-close',
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
