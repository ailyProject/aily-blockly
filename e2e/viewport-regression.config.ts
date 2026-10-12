import { defineConfig } from '@playwright/test';

// Reuse real editor regressions against the explicitly selected dev runtime.
export default defineConfig({
  testDir: './tests',
  testMatch: ['blockly-function-view.spec.ts', 'blockly-editor.spec.ts', 'blockly-decorative-icon.spec.ts'],
  workers: 1,
  timeout: 300_000,
  expect: { timeout: 30_000 },
  reporter: [['list']],
  outputDir: './.artifacts/blockly-viewport-regression',
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
