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

// A separate finite Node-control transport; the View still has no invoke,
// controller lease, private owner context or arbitrary process-message API.
ipcRenderer.on('subapp-node-control-port', (event, data) => {
    if (data?.protocol !== 'aily-subapp-node-control-v1' || data.version !== 1 || data.role !== 'view'
        || event.ports.length !== 1 || !/^[a-f0-9-]{36}$/.test(data.runtimeId || '')
        || !/^[a-f0-9-]{36}$/.test(data.connectionId || '') || typeof data.packageName !== 'string'
        || typeof data.packageVersion !== 'string'
        || Object.keys(data).sort().join(',') !== ['protocol', 'version', 'role', 'runtimeId', 'connectionId', 'packageName', 'packageVersion'].sort().join(',')) return;
    window.postMessage(data, location.origin, [event.ports[0]]);
});
