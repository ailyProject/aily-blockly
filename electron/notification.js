// 提供系统通知和窗口注意提醒功能。
const { Notification, ipcMain, BrowserWindow, app } = require('electron');
const { randomUUID } = require('node:crypto');
const { requestWindowAttention } = require('./window-attention');
const { createActivationServer, createWindowsToastXml } = require('./notification-activation');

const MAX_RETAINED_NOTIFICATIONS = 128;
// Electron 35 的原生通知只弱引用 JS delegate。Windows 横幅超时后，
// 通知中心仍可点击，因而 close 不能成为释放 JS 对象的时机。
const notifications = new Map();
const owners = new Map();
let cachedMainWindow = null;
let notificationProduct = 'blockly';
let activationServer;
let shuttingDown = false;

function activateNotification(id) {
  const record = notifications.get(id);
  if (!record) return false;
  try {
    const win = record.window;
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show(); win.focus(); win.flashFrame(false);
    }
    if (app.dock) app.dock.setBadge('');
  } catch (error) { console.warn('恢复通知所属窗口失败:', error.message); }
  record.emit('click');
  record.resolve({ event: 'click', notificationId: id });
  releaseNotification(record, { close: true, settle: false });
  return true;
}

function releaseNotification(record, { close = false, reason, settle = true } = {}) {
  if (!notifications.delete(record.id)) return;
  const owner = owners.get(record.window);
  if (owner) {
    owner.records.delete(record);
    if (!owner.records.size) {
      record.window.removeListener('closed', owner.onClosed);
      owners.delete(record.window);
    }
  }
  record.notification.removeAllListeners();
  if (close) {
    // 移除系统通知后才丢弃引用，避免留下已无回调的通知中心条目。
    try { record.notification.close(); } catch (error) {
      console.warn('关闭系统通知失败:', error.message);
    }
    if (settle) {
      record.emit('close', { reason });
      record.resolve({ event: 'close', notificationId: record.id, reason });
    }
  }
}

function retainNotification(record) {
  notifications.set(record.id, record);
  if (record.window && !record.window.isDestroyed()) {
    let owner = owners.get(record.window);
    if (!owner) {
      owner = {
        records: new Set(),
        onClosed() {
          for (const item of [...owner.records]) {
            releaseNotification(item, { close: true, reason: 'window-closed' });
          }
        },
      };
      owners.set(record.window, owner);
      record.window.once('closed', owner.onClosed);
    }
    owner.records.add(record);
  }
  while (notifications.size > MAX_RETAINED_NOTIFICATIONS) {
    releaseNotification(notifications.values().next().value, {
      close: true, reason: 'history-limit',
    });
  }
}

app.once('will-quit', () => {
  shuttingDown = true;
  for (const record of [...notifications.values()]) {
    releaseNotification(record, { close: true, reason: 'app-quit' });
  }
  activationServer?.close();
});

/**
 * 返回第一次 click/close；Windows 历史通知的后续 click 通过 onEvent 发送。
 * @returns {Promise<{event: string, notificationId: string}>}
 */
async function showNotification(options = {}, browserWindow, onEvent) {
  if (!Notification.isSupported()) throw new Error('当前系统不支持通知功能');
  if (process.platform === 'win32') {
    activationServer ||= createActivationServer({ product: notificationProduct, onActivate: activateNotification });
    await activationServer.ready;
  }
  if (shuttingDown) throw new Error('应用正在退出');
  return new Promise((resolve, reject) => {
    let record;
    try {
      if (browserWindow?.isDestroyed()) throw new Error('通知所属窗口已关闭');
      const id = randomUUID();
      const notificationOptions = {
        title: options.title || '通知',
        body: options.body || '',
        silent: options.silent || false,
        timeoutType: options.timeoutType || 'default',
      };
      if (options.icon) notificationOptions.icon = options.icon;
      if (activationServer) notificationOptions.toastXml = createWindowsToastXml(notificationOptions, activationServer.url(id));
      if (process.platform === 'linux' && options.urgency) {
        notificationOptions.urgency = options.urgency;
      }
      const notification = new Notification(notificationOptions);
      record = {
        id, notification, window: browserWindow, resolve,
        emit(event, extra = {}) {
          try { onEvent?.({ notificationId: record.id, event, ...extra }); }
          catch (error) { console.warn('发送系统通知事件失败:', error.message); }
        },
      };
      retainNotification(record);
      notification.on('click', () => activateNotification(record.id));
      notification.on('close', () => {
        record.emit('close');
        resolve({ event: 'close', notificationId: record.id });
        if (process.platform !== 'win32') releaseNotification(record);
      });
      notification.on('show', () => record.emit('show'));
      notification.on('failed', (_event, message) => {
        const error = new Error(message || '显示系统通知失败');
        record.emit('failed', { error: error.message });
        releaseNotification(record);
        reject(error);
      });
      requestWindowAttention(browserWindow);
      notification.show();
    } catch (error) {
      if (record) {
        record.emit('failed', { error: error.message });
        releaseNotification(record, { close: true, reason: 'show-failed', settle: false });
      }
      reject(error);
    }
  });
}

function registerNotificationHandlers(mainWindow, product = 'blockly') {
  cachedMainWindow = mainWindow;
  notificationProduct = product;
  ipcMain.handle('notification-show', async (event, options) => {
    try {
      const senderWindow = BrowserWindow.fromWebContents(event.sender);
      const targetWindow = senderWindow && !senderWindow.isDestroyed()
        ? senderWindow : cachedMainWindow;
      const result = await showNotification(options, targetWindow, payload => {
        if (!event.sender.isDestroyed()) event.sender.send('notification-event', payload);
      });
      return { success: true, result };
    } catch (error) {
      console.error('显示通知失败:', error);
      return { success: false, error: error.message };
    }
  });
  ipcMain.handle('notification-is-supported', () => Notification.isSupported());
}

module.exports = { showNotification, registerNotificationHandlers };
