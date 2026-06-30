const { app } = require('electron');

/**
 * 请求用户注意窗口：任务栏闪烁（Windows）、Dock 弹跳与角标（macOS）、flashFrame（Linux）。
 * 与系统通知配合，避免仅依赖短时气泡。
 * @param {import('electron').BrowserWindow | null | undefined} browserWindow
 * @returns {{ success: boolean, error?: string }}
 */
function requestWindowAttention(browserWindow) {
  if (!browserWindow || browserWindow.isDestroyed()) {
    return { success: false, error: 'no-window' };
  }
  try {
    if (process.platform === 'win32') {
      // 获得焦点前会持续闪烁任务栏按钮
      browserWindow.flashFrame(true);
    } else if (process.platform === 'darwin' && app.dock) {
      app.dock.bounce('informational');
      app.dock.setBadge('!');
    } else if (process.platform === 'linux') {
      if (typeof browserWindow.flashFrame === 'function') {
        browserWindow.flashFrame(true);
      }
    }
    return { success: true };
  } catch (err) {
    console.warn('[requestWindowAttention]', err.message);
    return { success: false, error: err.message };
  }
}

module.exports = { requestWindowAttention };
