import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './performance', testMatch: 'autosave.spec.ts', workers: 1,
  timeout: 900_000, expect: { timeout: 120_000 }, retries: 0,
  outputDir: './performance/test-results/autosave/runs', reporter: [['list']],
});
