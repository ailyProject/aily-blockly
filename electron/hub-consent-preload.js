const { contextBridge, ipcRenderer } = require('electron');
const id = process.argv.find(value => value.startsWith('--aily-hub-consent='))?.split('=')[1];
if (/^[a-f0-9]{24}$/.test(id || '')) {
  contextBridge.exposeInMainWorld('hubConsent', {
    read: () => ipcRenderer.invoke(`hub-consent:${id}:data`),
    decide: allowed => { if (typeof allowed === 'boolean') ipcRenderer.send(`hub-consent:${id}:decision`, allowed); },
  });
}
