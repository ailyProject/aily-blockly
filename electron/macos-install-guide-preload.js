// 安装引导页只允许发送打开「应用程序」和退出两个动作。
const { contextBridge, ipcRenderer } = require('electron');

const actions = new Set(['open-applications', 'quit']);

contextBridge.exposeInMainWorld('installGuide', {
  send: action => {
    if (actions.has(action)) ipcRenderer.send('macos-install-guide', action);
  },
});
