import {defineConfig} from '@playwright/test';
export default defineConfig({testDir: './performance', testMatch: 'real-*.spec.ts', workers: 1, timeout: 300_000,
  expect: {timeout: 30_000}, reporter: [['list']],
  use: {trace: 'off', video: 'off', screenshot: 'off'}});
