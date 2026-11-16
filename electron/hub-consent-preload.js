const { contextBridge, ipcRenderer } = require('electron');
const id = process.argv.find(value => value.startsWith('--aily-hub-consent='))?.split('=')[1];
if (/^[a-f0-9]{24}$/.test(id || '')) {
  contextBridge.exposeInMainWorld('hubConsent', {
    theme: process.argv.includes('--aily-hub-theme=light') ? 'light' : 'dark',
    onTheme: callback => {
      const listener = (_event, theme) => { if (theme === 'light' || theme === 'dark') callback(theme); };
      ipcRenderer.on(`hub-consent:${id}:theme`, listener);
      return () => ipcRenderer.removeListener(`hub-consent:${id}:theme`, listener);
    },
    read: () => ipcRenderer.invoke(`hub-consent:${id}:data`),
    decide: allowed => { if (typeof allowed === 'boolean') ipcRenderer.send(`hub-consent:${id}:decision`, allowed); },
  });
}
