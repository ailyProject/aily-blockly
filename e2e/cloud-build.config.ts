import { defineConfig } from '@playwright/test';

// Uses the existing development renderer and a separate Electron profile.
export default defineConfig({
  globalSetup: process.env['AILY_E2E_DEV_URL'] ? undefined : './global-setup.ts',
  testDir: './tests', testMatch: ['cloud-build-live.spec.ts', 'aily-tools-install-state.spec.ts'],
  workers: 1, timeout: 300_000, expect: { timeout: 30_000 }, reporter: [['list']],
  outputDir: './.artifacts/cloud-build',
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
