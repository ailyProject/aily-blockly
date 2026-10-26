import { defineConfig } from '@playwright/test';
import path from 'node:path';
const directory = path.resolve(process.env['AILY_E2E_SAVE_AS_OUTPUT'] || 'e2e/.artifacts/project-save-as-suite');
export default defineConfig({
  testDir: './tests', testMatch: 'project-save-as.spec.ts',
  globalSetup: './fixtures/project-save-as-setup.ts', workers: 1, fullyParallel: false,
  timeout: 300_000, expect: { timeout: 30_000 }, retries: 0,
  outputDir: path.join(directory, 'tests'),
  reporter: [['list'], ['./fixtures/project-save-as-reporter.ts'], ['json', { outputFile: path.join(directory, 'results.json') }],
    ['html', { outputFolder: path.join(directory, 'html'), open: 'never' }]],
});
