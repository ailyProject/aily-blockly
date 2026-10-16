'use strict';

// Scoped one-way MessagePort delivery only. No contextBridge, invoke, Node, file,
// compiler, Agent credentials, arbitrary IPC or localhost access is exposed.
const { ipcRenderer } = require('electron');
ipcRenderer.on('subapp-browser-execution-port', (event, data) => {
    if (data?.protocol !== 'aily-browser-execution-v1' || event.ports.length !== 1
        || !['host', 'connection'].includes(data.role)
        || !/^[a-f0-9-]{36}$/.test(data.executionId || '')) return;
    window.postMessage(data, location.origin, [event.ports[0]]);
});
