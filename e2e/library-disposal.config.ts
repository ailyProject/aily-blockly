import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests', testMatch: 'library-disposal.spec.ts', workers: 1,
  timeout: 360_000, expect: { timeout: 30_000 }, retries: 0,
  outputDir: process.env['AILY_E2E_OUTPUT_DIR'] || './test-results/library-disposal', reporter: [['list']],
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
