const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { prepareConsentWindow } = require('./window-chrome');

// Keep a native titled child; macOS gates owner input without a titleless sheet.
function createHubConsentPresenter({ window, BrowserWindow, ipcMain, prepareChrome = prepareConsentWindow }) {
  let dismiss;
  let theme = 'dark', publishTheme;
  return {
    setTheme(mode) {
      if (mode !== 'light' && mode !== 'dark') return;
      theme = mode; publishTheme?.(mode);
    },
    confirm({ account, origin, region, expiresAt, onShown }) {
      dismiss?.();
      if (window.isDestroyed()) return Promise.resolve(false);
      return new Promise(resolve => {
        const id = randomBytes(12).toString('hex');
        const dataChannel = `hub-consent:${id}:data`;
        const decisionChannel = `hub-consent:${id}:decision`;
        const bounds = window.getContentBounds();
        const width = Math.min(456, bounds.width), height = Math.min(608, bounds.height - 32);
        const consent = new BrowserWindow({
          parent: window, modal: process.platform !== 'darwin', show: false, frame: true, transparent: false,
          titleBarStyle: 'default', closable: true,
          width, height, x: Math.round(bounds.x + (bounds.width - width) / 2),
          y: Math.round(bounds.y + (bounds.height - height) / 2), useContentSize: true,
          title: '登录项目广场', resizable: false, minimizable: false, maximizable: false,
          fullscreenable: false, skipTaskbar: true, autoHideMenuBar: true,
          backgroundColor: theme === 'light' ? '#ededed' : '#1f1f1f',
          webPreferences: {
            preload: path.join(__dirname, 'hub-consent-preload.js'),
            additionalArguments: [`--aily-hub-consent=${id}`, `--aily-hub-theme=${theme}`],
            contextIsolation: true, nodeIntegration: false, sandbox: true,
            webSecurity: true, partition: `hub-consent-${id}`,
          },
        });
        if (process.platform !== 'darwin') consent.setMenu(null);
        const contents = consent.webContents;
        let settled = false, chrome;
        const ownFrame = event => !window.isDestroyed() && !contents.isDestroyed()
          && event.sender === contents && event.senderFrame === contents.mainFrame;
        const finish = allowed => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          ipcMain.removeHandler(dataChannel);
          ipcMain.removeListener(decisionChannel, decide);
          window.removeListener('closed', cancel);
          if (dismiss === cancel) { dismiss = undefined; publishTheme = undefined; }
          chrome?.restore();
          if (!consent.isDestroyed()) consent.destroy();
          if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.focus();
          resolve(allowed === true && Date.now() < expiresAt);
        };
        const cancel = () => finish(false);
        const decide = (event, allowed) => { if (ownFrame(event) && typeof allowed === 'boolean') finish(allowed); };
        const timer = setTimeout(cancel, Math.max(0, Math.min(expiresAt - Date.now(), 120_000)));
        timer.unref?.();
        dismiss = cancel;
        publishTheme = mode => {
          if (!settled && !contents.isDestroyed()) { chrome?.setTheme(mode); contents.send(`hub-consent:${id}:theme`, mode); }
        };
        ipcMain.handle(dataChannel, event => ownFrame(event) ? { account, origin, region, expiresAt, theme } : null);
        ipcMain.on(decisionChannel, decide);
        contents.setWindowOpenHandler(() => ({ action: 'deny' }));
        contents.on('will-navigate', event => event.preventDefault());
        contents.on('will-attach-webview', event => event.preventDefault());
        contents.on('render-process-gone', cancel);
        contents.once('destroyed', cancel);
        consent.once('closed', cancel);
        window.once('closed', cancel);
        consent.once('ready-to-show', () => {
          if (settled || window.isDestroyed()) return;
          try { chrome = prepareChrome(consent, window, theme); }
          catch (error) { console.warn('[HubLogin] Native window unavailable:', error.message); cancel(); return; }
          if (window.isMinimized()) window.restore();
          window.show(); consent.show(); consent.focus();
          onShown?.();
        });
        void contents.loadFile(path.join(__dirname, 'hub-consent.html')).catch(cancel);
      });
    },
    cancel() { dismiss?.(); },
  };
}

module.exports = { createHubConsentPresenter };
