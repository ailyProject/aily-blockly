// 通知中心的历史点击可能晚于 show() 的第一次 close 回执。
function createNotificationApi(ipcRenderer) {
  return {
    show: options => ipcRenderer.invoke('notification-show', options),
    isSupported: () => ipcRenderer.invoke('notification-is-supported'),
    onEvent(callback) {
      if (typeof callback !== 'function') throw new TypeError('通知事件监听器必须是函数');
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('notification-event', listener);
      return () => ipcRenderer.removeListener('notification-event', listener);
    },
  };
}

module.exports = { createNotificationApi };
