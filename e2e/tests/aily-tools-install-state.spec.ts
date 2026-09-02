import { expect, test } from '@playwright/test';

const { shouldInstallForAppVersion } = require('../../electron/tools/aily-tools-install-state');

test.describe('aily tools startup install policy', () => {
  test('regular startup refreshes latest when the app version changes', () => {
    expect(shouldInstallForAppVersion({ installed: '1.0.0' }, '1.1.0')).toBe(true);
    expect(shouldInstallForAppVersion({ installed: '1.1.0' }, '1.1.0')).toBe(false);
  });

  test('E2E startup skips latest refresh by default', () => {
    expect(
      shouldInstallForAppVersion({ installed: '1.0.0' }, '1.1.0', {
        isE2E: true,
      }),
    ).toBe(false);
  });

  test('E2E startup can explicitly allow the version-change refresh', () => {
    expect(
      shouldInstallForAppVersion({ installed: '1.0.0' }, '1.1.0', {
        isE2E: true,
        allowE2ERefresh: true,
      }),
    ).toBe(true);
  });
});
