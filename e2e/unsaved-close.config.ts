import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests', testMatch: 'unsaved-close.spec.ts', workers: 1,
  timeout: 90_000, expect: { timeout: 10_000 }, retries: 0,
  outputDir: './test-results/unsaved-close', reporter: [['list']],
  webServer: {
    command: 'npm start', url: 'http://localhost:4200',
    reuseExistingServer: !process.env['CI'], timeout: 120_000,
  },
});
