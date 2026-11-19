import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests', testMatch: 'coder-library-save.spec.ts', workers: 1,
  timeout: 360_000, expect: { timeout: 30_000 }, reporter: [['list']],
  outputDir: './.artifacts/coder-library-save',
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
