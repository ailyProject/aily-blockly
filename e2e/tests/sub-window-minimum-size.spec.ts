import {
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '../fixtures/electron-app';

async function openDetachedWindow(
  mainWindow: Page,
  options: Record<string, unknown>,
) {
  await mainWindow.evaluate((windowOptions) => {
    const api = (window as unknown as {
      electronAPI: { subWindow: { open: (value: Record<string, unknown>) => void } };
    }).electronAPI;
    api.subWindow.open(windowOptions);
  }, options);
}

async function detachedWindowSizeState(
  electronApp: ElectronApplication,
  route: string,
) {
  return electronApp.evaluate(({ BrowserWindow }, expectedRoute) => {
    const target = BrowserWindow.getAllWindows()
      .find((win) => win.webContents.getURL().includes(`#/${expectedRoute}`));
    if (!target) return null;
    const [minWidth, minHeight] = target.getMinimumSize();
    const bounds = target.getBounds();
    return { minWidth, minHeight, width: bounds.width, height: bounds.height };
  }, route);
}

test('内置窗口使用较大下限，子应用窗口至少为 400 × 500', async ({ electronApp, mainWindow }) => {
  await openDetachedWindow(mainWindow, {
    path: 'settings',
    width: 700,
    height: 550,
  });
  await expect.poll(
    () => detachedWindowSizeState(electronApp, 'settings'),
    { timeout: 5_000 },
  ).toEqual({ minWidth: 640, minHeight: 480, width: 700, height: 550 });

  await openDetachedWindow(mainWindow, {
    path: 'external-subapp/e2e-window-minimum',
    windowClass: 'subapp',
    width: 100,
    height: 100,
  });
  await expect.poll(
    () => detachedWindowSizeState(electronApp, 'external-subapp/e2e-window-minimum'),
    { timeout: 5_000 },
  ).toEqual({ minWidth: 400, minHeight: 500, width: 400, height: 500 });
});
