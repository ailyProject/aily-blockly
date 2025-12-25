const { Notification, ipcMain } = require('electron');
const path = require('path');

/**
 * 显示系统通知
 * @param {Object} options - 通知选项
 * @param {string} options.title - 通知标题
 * @param {string} options.body - 通知内容
 * @param {string} options.icon - 通知图标路径（可选）
 * @param {boolean} options.silent - 是否静音（可选，默认 false）
 * @param {string} options.timeoutType - 超时类型（可选，'default' | 'never'）
 * @param {string} options.urgency - 紧急程度（可选，'normal' | 'critical' | 'low'）
 * @returns {Promise<void>}
 */
function showNotification(options) {
  return new Promise((resolve, reject) => {
    try {
      // 检查是否支持通知
      if (!Notification.isSupported()) {
        reject(new Error('当前系统不支持通知功能'));
        return;
      }

      const notificationOptions = {
        title: options.title || '通知',
        body: options.body || '',
        silent: options.silent || false,
        timeoutType: options.timeoutType || 'default',
      };

      // 如果提供了图标路径，添加到选项中
      if (options.icon) {
        notificationOptions.icon = options.icon;
      }

      // Linux 系统支持 urgency 属性
      if (process.platform === 'linux' && options.urgency) {
        notificationOptions.urgency = options.urgency;
      }

      const notification = new Notification(notificationOptions);

      // 监听通知点击事件
      notification.on('click', () => {
        resolve({ event: 'click' });
      });

      // 监听通知关闭事件
      notification.on('close', () => {
        resolve({ event: 'close' });
      });

      // 监听通知显示事件
      notification.on('show', () => {
        // 通知已显示，但不立即 resolve，等待用户交互或关闭
      });

      // 监听通知失败事件
      notification.on('failed', (error) => {
        reject(error);
      });

      // 显示通知
      notification.show();

    } catch (error) {
      reject(error);
    }
  });
}

/**
 * 初始化通知模块的 IPC 监听器
 */
function registerNotificationHandlers(mainWindow) {
  // 处理来自渲染进程的通知请求
  ipcMain.handle('notification-show', async (event, options) => {
    try {
      const result = await showNotification(options);
      return { success: true, result };
    } catch (error) {
      console.error('显示通知失败:', error);
      return { success: false, error: error.message };
    }
  });

  // 检查是否支持通知
  ipcMain.handle('notification-is-supported', () => {
    return Notification.isSupported();
  });
}

module.exports = {
  showNotification,
  registerNotificationHandlers
};
