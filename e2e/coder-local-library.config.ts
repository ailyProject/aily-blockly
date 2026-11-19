import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests', testMatch: 'coder-local-library.spec.ts', workers: 1,
  timeout: 360_000, expect: { timeout: 30_000 }, reporter: [['list']],
  outputDir: './.artifacts/coder-local-library',
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
