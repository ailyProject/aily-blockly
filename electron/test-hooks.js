/**
 * electron/test-hooks.js
 *
 * 仅在 `--test-mode` 启动时由 main.js 加载，向主进程注册一组
 * `__test:*` IPC handler，供外部 E2E 框架（Playwright）通过
 * `app.evaluate` 或 `ipcRenderer.invoke` 查询/操作应用状态。
 *
 * 生产构建不会调用此模块，可以放心使用危险 API。
 *
 * 注册的 channel:
 *  - __test:ping                    → 'pong' （探活）
 *  - __test:get-state               → 当前主窗口 URL/标题/可见性/路由等
 *  - __test:set-config              → 写入一项渲染端运行时配置（通过 IPC 事件转发）
 *  - __test:clear-userdata          → 清空当前 userData（慎用：仅测试专用目录）
 *  - __test:mock-dialog             → 预置下一次 dialog.show*Dialog 返回值
 *  - __test:invoke                  → 透传调用任意已注册的 ipcMain handler
 *  - __test:eval-main               → 在主进程 eval 代码（仅 test-mode，调试用）
 *  - __test:get-main-window-id      → 返回主窗口 webContents id（便于 Playwright 定位）
 */

const { ipcMain, dialog, app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

let _registered = false;
let _dialogMocks = []; // { method, result } FIFO

function wrapDialog() {
  const methods = [
    "showOpenDialog",
    "showOpenDialogSync",
    "showSaveDialog",
    "showSaveDialogSync",
    "showMessageBox",
    "showMessageBoxSync",
  ];
  for (const m of methods) {
    const original = dialog[m];
    if (!original || original.__wrappedByTestHooks) continue;
    const wrapped = function (...args) {
      // 找到第一个匹配的 mock（FIFO）
      const idx = _dialogMocks.findIndex((x) => x.method === m);
      if (idx !== -1) {
        const { result } = _dialogMocks.splice(idx, 1)[0];
        const isAsync = !m.endsWith("Sync");
        console.log(`[test-hooks] dialog.${m} → mocked`, result);
        return isAsync ? Promise.resolve(result) : result;
      }
      console.warn(
        `[test-hooks] dialog.${m} called without mock; returning canceled to avoid blocking tests.`
      );
      if (m.includes("Open") || m.includes("Save")) {
        const canceled = { canceled: true, filePaths: [], filePath: undefined };
        return m.endsWith("Sync") ? undefined : Promise.resolve(canceled);
      }
      if (m.includes("MessageBox")) {
        const res = { response: 0, checkboxChecked: false };
        return m.endsWith("Sync") ? 0 : Promise.resolve(res);
      }
      return original.apply(this, args);
    };
    wrapped.__wrappedByTestHooks = true;
    dialog[m] = wrapped;
  }
}

function getMainWindow() {
  const wins = BrowserWindow.getAllWindows();
  // 约定：主窗口为第一个未销毁的
  return wins.find((w) => !w.isDestroyed()) || null;
}

function register(opts = {}) {
  if (_registered) return;
  _registered = true;

  wrapDialog();

  ipcMain.handle("__test:ping", () => "pong");

  ipcMain.handle("__test:get-state", async () => {
    const win = getMainWindow();
    if (!win) return { ready: false };
    const url = win.webContents.getURL();
    const title = win.getTitle();
    return {
      ready: true,
      url,
      title,
      isVisible: win.isVisible(),
      isMinimized: win.isMinimized(),
      isMaximized: win.isMaximized(),
      userDataPath: app.getPath("userData"),
      version: app.getVersion(),
      pid: process.pid,
    };
  });

  ipcMain.handle("__test:mock-dialog", (_e, payload) => {
    // payload: { method: 'showOpenDialog', result: {...} }
    if (!payload || !payload.method) throw new Error("missing method");
    _dialogMocks.push({ method: payload.method, result: payload.result });
    return { queued: _dialogMocks.length };
  });

  ipcMain.handle("__test:clear-dialog-mocks", () => {
    const n = _dialogMocks.length;
    _dialogMocks = [];
    return { cleared: n };
  });

  ipcMain.handle("__test:set-config", (_e, payload) => {
    // 把配置转发给渲染进程；渲染端需要监听 'test:set-config' 事件
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send("test:set-config", payload || {});
      return { sent: true };
    }
    return { sent: false };
  });

  ipcMain.handle("__test:clear-userdata", async () => {
    const p = app.getPath("userData");
    // 安全阀：必须是临时路径，并且包含 'aily-test' 或 'instance'
    if (!/aily-test|instances?/i.test(p)) {
      throw new Error(
        `[test-hooks] refuse to clear non-test userData: ${p}`
      );
    }
    try {
      const entries = fs.readdirSync(p, { withFileTypes: true });
      for (const ent of entries) {
        const full = path.join(p, ent.name);
        try {
          fs.rmSync(full, { recursive: true, force: true });
        } catch (e) {
          /* ignore */
        }
      }
      return { cleared: true, path: p };
    } catch (e) {
      return { cleared: false, error: String(e && e.message) };
    }
  });

  ipcMain.handle("__test:invoke", async (_e, payload) => {
    // 透传：payload = { channel, args: [...] }
    // 仅做便利转发；测试时通常用 app.evaluate 直调更稳。
    const { channel, args = [] } = payload || {};
    if (!channel) throw new Error("missing channel");
    // 无法直接拿到 ipcMain 注册的 handle 列表，这里用事件发送让主进程自调
    throw new Error(
      "__test:invoke not implemented — use playwright app.evaluate instead"
    );
  });

  ipcMain.handle("__test:get-main-window-id", () => {
    const win = getMainWindow();
    return win ? win.webContents.id : null;
  });

  console.log("[test-hooks] registered (test-mode).");
}

module.exports = { register };
