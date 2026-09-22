'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('debugMonitor', {
    stop: () => ipcRenderer.invoke('simulator-debug-monitor-stop'),
    subscribe: listener => {
        const handle = (_event, snapshot) => listener(snapshot);
        ipcRenderer.on('simulator-debug-progress', handle);
        return () => ipcRenderer.removeListener('simulator-debug-progress', handle);
    },
});
