import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests', testMatch: 'blockly-coder-conversion.spec.ts', workers: 1,
  timeout: 240_000, expect: { timeout: 30_000 }, reporter: [['list']],
  outputDir: './.artifacts/coder-conversion',
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
