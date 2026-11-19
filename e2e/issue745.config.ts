import {defineConfig} from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: 'build-workspace-recovery.spec.ts',
  workers: 1,
  timeout: 300_000,
  expect: {timeout: 30_000},
  reporter: [['list']],
  outputDir: process.env['AILY_ISSUE745_BASELINE'] === '1'
    ? './test-results/issue745-baseline' : './test-results/issue745-fixed',
  use: {trace: 'retain-on-failure', screenshot: 'only-on-failure'},
});
