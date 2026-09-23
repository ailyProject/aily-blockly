const { contextBridge, ipcRenderer } = require('electron');
// Same two fixed IPC ports exposed by production preload. No Runtime token or
// executable path is made available to the renderer or the Agent client.
contextBridge.exposeInMainWorld('electronAPI', { childToolSession: {
    superviseOwner: input => ipcRenderer.invoke('subapp-owner-supervision', input),
    invokeNativeAgent: input => ipcRenderer.invoke('subapp-native-agent', input),
} });
