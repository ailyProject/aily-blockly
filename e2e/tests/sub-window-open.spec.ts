import {
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '../fixtures/electron-app';

type WarmSettingsWindow = {
  id: number;
  page: Page;
};

async function settingsWindowStates(electronApp: ElectronApplication) {
  return electronApp.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .filter((win) => win.webContents.getURL().includes('#/settings'))
      .map((win) => ({
        id: win.id,
        visible: win.isVisible(),
        loading: win.webContents.isLoading(),
      })),
  );
}

async function waitForHiddenWarmSettingsWindow(
  electronApp: ElectronApplication,
  excludedId?: number,
): Promise<WarmSettingsWindow> {
  await expect.poll(
    async () => (await settingsWindowStates(electronApp)).length,
    { timeout: 30_000 },
  ).toBe(1);

  const page = electronApp.windows().find((candidate) => candidate.url().includes('#/settings'));
  expect(page).toBeDefined();

  await expect.poll(
    () => page!.evaluate(() => {
      const settings = document.querySelector<HTMLElement>('app-settings app-sub-window');
      const basicSection = document.getElementById('SETTINGS.SECTIONS.BASIC');
      const settingsRect = settings?.getBoundingClientRect();
      const basicRect = basicSection?.getBoundingClientRect();
      return {
        documentReady: document.readyState === 'complete',
        loadingRemoved: !document.getElementById('app-loading-box'),
        settingsRendered: !!settingsRect && settingsRect.width > 0 && settingsRect.height > 0,
        basicSectionRendered: !!basicRect && basicRect.width > 0 && basicRect.height > 0,
      };
    }),
    { timeout: 30_000 },
  ).toEqual({
    documentReady: true,
    loadingRemoved: true,
    settingsRendered: true,
    basicSectionRendered: true,
  });

  await page!.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));

  const states = await settingsWindowStates(electronApp);
  expect(states).toHaveLength(1);
  const [state] = states;
  expect(state.visible).toBe(false);
  expect(state.loading).toBe(false);
  if (excludedId !== undefined) {
    expect(state.id).not.toBe(excludedId);
  }

  return { id: state.id, page: page! };
}

async function armNoReloadGuard(page: Page, marker: string) {
  const timeOrigin = await page.evaluate((value) => {
    const settings = document.querySelector<HTMLElement>('app-settings');
    settings?.setAttribute('data-e2e-warm-marker', value);
    (window as unknown as { __settingsLoaderSeen?: boolean }).__settingsLoaderSeen = false;
    const observer = new MutationObserver(() => {
      if (document.getElementById('app-loading-box')) {
        (window as unknown as { __settingsLoaderSeen?: boolean }).__settingsLoaderSeen = true;
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    return performance.timeOrigin;
  }, marker);

  let mainFrameNavigations = 0;
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) {
      mainFrameNavigations++;
    }
  });

  return {
    timeOrigin,
    navigationCount: () => mainFrameNavigations,
  };
}

async function openSettings(mainWindow: Page) {
  await mainWindow.evaluate(() => {
    const api = (window as unknown as {
      electronAPI: { subWindow: { open: (options: Record<string, unknown>) => void } };
    }).electronAPI;
    api.subWindow.open({
      path: 'settings',
      alwaysOnTop: true,
      width: 700,
      height: 550,
    });
  });
}

async function expectWarmWindowRevealed(
  electronApp: ElectronApplication,
  warmWindow: WarmSettingsWindow,
  marker: string,
  timeOrigin: number,
  navigationCount: () => number,
) {
  await expect.poll(
    async () => {
      const [state] = await settingsWindowStates(electronApp);
      return state?.id === warmWindow.id && state.visible;
    },
    { timeout: 1_000, intervals: [10, 20, 50] },
  ).toBe(true);

  expect(await settingsWindowStates(electronApp)).toHaveLength(1);
  await expect(warmWindow.page.locator('app-settings')).toBeVisible();
  await warmWindow.page.waitForTimeout(250);
  expect(navigationCount()).toBe(0);
  expect(await warmWindow.page.evaluate((value) => ({
    marker: document.querySelector('app-settings')?.getAttribute('data-e2e-warm-marker'),
    timeOrigin: performance.timeOrigin,
    loadingPresent: !!document.getElementById('app-loading-box'),
    loadingSeen: !!(window as unknown as { __settingsLoaderSeen?: boolean }).__settingsLoaderSeen,
  }), marker)).toEqual({
    marker,
    timeOrigin,
    loadingPresent: false,
    loadingSeen: false,
  });
}

test.describe('设置子窗口预热', () => {
  test('点击时直接显示已渲染内容，关闭后销毁并补热下一实例', async ({ electronApp, mainWindow }) => {
    const firstWarmWindow = await waitForHiddenWarmSettingsWindow(electronApp);
    const firstMarker = `settings-warm-${Date.now()}`;
    const firstGuard = await armNoReloadGuard(firstWarmWindow.page, firstMarker);

    await openSettings(mainWindow);
    await expectWarmWindowRevealed(
      electronApp,
      firstWarmWindow,
      firstMarker,
      firstGuard.timeOrigin,
      firstGuard.navigationCount,
    );

    const rendererGroup = firstWarmWindow.page.locator(
      '[id="SETTINGS.SECTIONS.BLOCKLY"] nz-radio-group',
    );
    const checkedRenderer = rendererGroup.locator('.ant-radio-button-wrapper-checked');
    await expect(checkedRenderer).toHaveCount(1);
    const originalRenderer = (await checkedRenderer.textContent())?.trim();
    expect(['Thrasos', 'Zelos']).toContain(originalRenderer);
    const unsavedRenderer = originalRenderer === 'Thrasos' ? 'Zelos' : 'Thrasos';
    await rendererGroup.getByText(unsavedRenderer, { exact: true }).click();
    await expect(checkedRenderer).toHaveText(unsavedRenderer);

    const firstPageClosed = firstWarmWindow.page.waitForEvent('close');
    await firstWarmWindow.page.locator('app-sub-window .win-btns .close').click();
    await firstPageClosed;
    await expect.poll(
      () => electronApp.evaluate(
        ({ BrowserWindow }, windowId) => BrowserWindow.getAllWindows().some((win) => win.id === windowId),
        firstWarmWindow.id,
      ),
      { timeout: 5_000 },
    ).toBe(false);

    const secondWarmWindow = await waitForHiddenWarmSettingsWindow(electronApp, firstWarmWindow.id);
    const secondRendererGroup = secondWarmWindow.page.locator(
      '[id="SETTINGS.SECTIONS.BLOCKLY"] nz-radio-group',
    );
    await expect(secondRendererGroup.locator('.ant-radio-button-wrapper-checked')).toHaveText(originalRenderer!);

    const secondMarker = `settings-warm-${Date.now()}-replacement`;
    const secondGuard = await armNoReloadGuard(secondWarmWindow.page, secondMarker);
    await openSettings(mainWindow);
    await expectWarmWindowRevealed(
      electronApp,
      secondWarmWindow,
      secondMarker,
      secondGuard.timeOrigin,
      secondGuard.navigationCount,
    );
  });
});
