import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, getMainWindow, launchAilyElectron, test } from '../fixtures/electron-app';

// Inject account states only in this disposable profile; use the real host IPC,
// settings UI, configuration persistence and build-backend selection.
for (const mode of ['blockly', 'coder'] as const) {
  test(`${mode}: cloud compilation is restricted to Windows cn`, async () => {
    const launch = await launchAilyElectron({ environment: { AILY_BUILD_PRODUCT: mode }, config: {
      region: 'cn', selectedLanguage: 'zh_cn', blocklyOnboardingCompleted: true,
      compile: { backend: 'cloud' }, devmode: { enabled: true, autoSave: false },
    } });
    try {
      const main = await getMainWindow(launch.app);
      await expect.poll(() => main.evaluate(() => {
        const auth = (window as any).ng.getComponent(document.querySelector('app-main-window')).authService;
        return auth.getAuthInitializationState();
      })).toBe('signed_out');
      const native = await main.evaluate(() => {
        const w = window as any;
        const auth = w.ng.getComponent(document.querySelector('app-main-window')).authService;
        auth.isLoggedInSubject.next(true);
        auth.setCurrentUserInfo({ id: 'cloud-scope-fixture', subscription_plan: { name: 'pro' } });
        const config = w.ng.getComponent(document.querySelector('app-header')).configService;
        return { platform: w.platform.type, backend: config.getCompileBackend() };
      });
      expect(native.backend).toBe(native.platform === 'win32' ? 'cloud' : 'local');
      await main.evaluate(() => (window as any).electronAPI.subWindow.open({ path: 'settings', windowClass: 'builtin', width: 700, height: 550 }));
      await expect.poll(() => launch.app.windows().some(page => page.url().includes('#/settings'))).toBe(true);
      const settings = launch.app.windows().find(page => page.url().includes('#/settings'))!;
      await settings.locator('app-settings').waitFor();
      for (const platform of ['darwin', 'linux', 'win32']) {
        for (const region of ['cn', 'eu', 'localhost', '']) {
          const allowed = platform === 'win32' && region === 'cn';
          const backend = await main.evaluate(({ platform, region }) => {
            const w = window as any;
            w.platform = { ...w.platform, type: platform };
            const config = w.ng.getComponent(document.querySelector('app-header')).configService;
            config.data.region = region;
            return config.getCompileBackend();
          }, { platform, region });
          expect(backend).toBe(allowed ? 'cloud' : 'local');
          const access = await settings.evaluate(async ({ platform, region }) => {
            const w = window as any;
            w.platform = { ...w.platform, type: platform };
            const component = w.ng.getComponent(document.querySelector('app-settings'));
            component.configData.region = region;
            await component.refreshCloudCompilationAccess();
            w.ng.applyChanges(component);
            return { visible: component.showCloudCompilation, allowed: component.canUseCloudCompilation };
          }, { platform, region });
          expect(access).toEqual({ visible: allowed, allowed });
          await expect(settings.locator('#cloud-compilation-enabled')).toHaveCount(allowed ? 1 : 0);
          // Send real IPC even with a forged Windows renderer. Native platform
          // and main-process region must reject before touching the network.
          if (native.platform !== 'win32' || region !== 'cn') {
            const result = await main.evaluate(async region => {
              const ipc = (window as any).ipcRenderer;
              await ipc.invoke('env-set', { key: 'AILY_REGION', value: region });
              return ipc.invoke('cloud-build', { action: 'compile', settings: { platform: 'win32', region: 'cn' } });
            }, region);
            expect(result).toMatchObject({ ok: false, error: { code: 'CLOUD_BUILD_UNAVAILABLE' } });
          }
        }
      }
      expect(JSON.parse(await readFile(path.join(launch.userDataDir, 'config.json'), 'utf8')).compile.backend).toBe('cloud');
    } finally { await launch.close(); }
  });

  test(`${mode}: cloud compilation follows main-window Pro access`, async ({}, info) => {
    const launch = await launchAilyElectron({ environment: { AILY_BUILD_PRODUCT: mode }, config: {
      region: 'cn', selectedLanguage: 'zh_cn', blocklyOnboardingCompleted: true,
      compile: { backend: 'cloud' }, devmode: { enabled: true, autoSave: false },
    } });
    try {
      const main = await getMainWindow(launch.app);
      await main.addLocatorHandler(main.locator('app-login .login-close'), button => button.click());
      await expect.poll(() => main.evaluate(() => {
        const auth = (window as any).ng.getComponent(document.querySelector('app-main-window')).authService;
        return auth.getAuthInitializationState();
      })).toBe('signed_out');
      // Simulate the supported renderer branch only; native IPC restrictions are
      // verified separately above with the real platform and no network stubs.
      await main.evaluate(() => {
        const w = window as any;
        w.platform = { ...w.platform, type: 'win32' };
      });
      const backend = () => main.evaluate(() => (window as any).ng.getComponent(document.querySelector('app-header')).configService.getCompileBackend());
      const account = (loggedIn: boolean, plan: string) => main.evaluate(({ loggedIn, plan }) => {
        const auth = (window as any).ng.getComponent(document.querySelector('app-main-window')).authService;
        auth.isLoggedInSubject.next(loggedIn);
        auth.setCurrentUserInfo(loggedIn ? { id: 'cloud-access-fixture', subscription_plan: { name: plan } } : null);
      }, { loggedIn, plan });

      expect(await backend()).toBe('local');
      await main.evaluate(() => (window as any).electronAPI.subWindow.open({ path: 'settings', windowClass: 'builtin', width: 700, height: 550 }));
      await expect.poll(() => launch.app.windows().some(page => page.url().includes('#/settings'))).toBe(true);
      const settings = launch.app.windows().find(page => page.url().includes('#/settings'))!;
      await settings.locator('app-settings').waitFor();
      // The product exposes this section on Windows. Exercise its rendering in
      // macOS Electron too, without claiming Windows platform acceptance.
      await settings.addInitScript(() => {
        const w = window as any;
        Object.defineProperty(w, 'platform', { configurable: true,
          get: () => ({ ...w.electronAPI?.platform, type: 'win32' }), set: () => {} });
      });
      await settings.reload();
      await settings.locator('app-settings').waitFor();
      const toggle = settings.locator('#cloud-compilation-enabled');
      await toggle.scrollIntoViewIfNeeded();
      await expect(toggle).toBeDisabled();
      await expect(toggle).not.toHaveClass(/ant-switch-checked/);
      // Native window activation and initial settings layout may interrupt the
      // first hover. Re-enter after focus settles without bypassing the event.
      await expect(async () => {
        await settings.bringToFront();
        await settings.mouse.move(10, 10);
        await settings.locator('.cloud-build-switch').hover();
        await expect(settings.locator('.ant-tooltip-inner')).toHaveText('登录 Pro 账号后可用', { timeout: 1000 });
      }).toPass({ timeout: 10_000 });
      await settings.screenshot({ path: info.outputPath(`${mode}-signed-out.png`) });

      await account(true, 'free');
      await expect(toggle).toBeDisabled();
      expect(await backend()).toBe('local');
      await account(true, 'pro');
      await expect(toggle).toBeEnabled();
      await expect(toggle).toHaveClass(/ant-switch-checked/);
      expect(await backend()).toBe('cloud');
      await toggle.click();
      await expect(toggle).not.toHaveClass(/ant-switch-checked/);
      await expect.poll(backend).toBe('local');
      // Only the network health response is stubbed; all access checks and
      // cross-window configuration writes use the production implementation.
      await settings.evaluate(() => {
        const w = window as any;
        w.cloudBuild = { ...w.cloudBuild, health: async () => ({ healthy: true }) };
      });
      await toggle.click();
      await expect(toggle).toHaveClass(/ant-switch-checked/);
      await expect.poll(backend).toBe('cloud');
      expect(JSON.parse(await readFile(path.join(launch.userDataDir, 'config.json'), 'utf8')).compile.backend).toBe('cloud');

      await account(false, 'pro');
      await expect(toggle).toBeDisabled();
      await expect(toggle).not.toHaveClass(/ant-switch-checked/);
      expect(await backend()).toBe('local');
      await account(true, 'free');
      await expect(toggle).toBeDisabled();
      expect(await backend()).toBe('local');
      await settings.screenshot({ path: info.outputPath(`${mode}-free.png`) });
    } finally {
      await launch.close();
    }
  });
}
