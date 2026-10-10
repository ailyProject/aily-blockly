import {defineConfig} from '@playwright/test';
export default defineConfig({testDir: './tests', testMatch: ['blockly-insertion-preview.spec.ts'], workers: 1,
  timeout: 180_000, expect: {timeout: 30_000}, reporter: [['list']],
  use: {trace: 'off', video: 'off'}, outputDir: './.artifacts/insertion-preview'});
