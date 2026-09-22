const { contextBridge, ipcRenderer } = require('electron');
let diagnostics = '';
contextBridge.exposeInMainWorld('buildTest', {
  invoke: (channel, value) => ipcRenderer.invoke(channel, value),
  watch: streamId => {
    ipcRenderer.on(`cmd-data-${streamId}`, (_event, value) => {
      if (value.type === 'stderr') diagnostics = (diagnostics + value.data).slice(-16384);
    });
  },
  diagnostics: () => diagnostics,
});
