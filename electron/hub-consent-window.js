const path = require('node:path');
const { randomBytes } = require('node:crypto');

// This window has no parent and is never modal: editing, builds and uploads in
// the main window continue while the user reviews the account and permissions.
function createHubConsentPresenter({ BrowserWindow, ipcMain }) {
  let dismiss;
  return {
    confirm({ account, origin, expiresAt }) {
      dismiss?.();
      return new Promise(resolve => {
        const id = randomBytes(12).toString('hex');
        const dataChannel = `hub-consent:${id}:data`;
        const decisionChannel = `hub-consent:${id}:decision`;
        const consent = new BrowserWindow({
          width: 540, height: 800, minWidth: 460, minHeight: 680,
          title: '连接项目广场', backgroundColor: '#f5f6f9',
          show: false, modal: false, autoHideMenuBar: true,
          webPreferences: {
            preload: path.join(__dirname, 'hub-consent-preload.js'),
            additionalArguments: [`--aily-hub-consent=${id}`],
            contextIsolation: true, nodeIntegration: false, sandbox: true,
            webSecurity: true, partition: `hub-consent-${id}`,
          },
        });
        const contents = consent.webContents;
        let settled = false;
        const ownFrame = event => !consent.isDestroyed()
          && event.sender === contents && event.senderFrame === contents.mainFrame;
        const finish = allowed => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          ipcMain.removeHandler(dataChannel);
          ipcMain.removeListener(decisionChannel, decide);
          if (dismiss === cancel) dismiss = undefined;
          if (!consent.isDestroyed()) consent.destroy();
          resolve(allowed === true && Date.now() < expiresAt);
        };
        const cancel = () => finish(false);
        const decide = (event, allowed) => { if (ownFrame(event) && typeof allowed === 'boolean') finish(allowed); };
        const timer = setTimeout(cancel, Math.max(0, Math.min(expiresAt - Date.now(), 120_000)));
        timer.unref?.();
        dismiss = cancel;
        ipcMain.handle(dataChannel, event => ownFrame(event) ? { account, origin, expiresAt } : null);
        ipcMain.on(decisionChannel, decide);
        contents.setWindowOpenHandler(() => ({ action: 'deny' }));
        contents.on('will-navigate', event => event.preventDefault());
        contents.on('will-attach-webview', event => event.preventDefault());
        contents.on('render-process-gone', cancel);
        consent.once('closed', cancel);
        consent.once('ready-to-show', () => { if (!settled) consent.showInactive(); });
        void consent.loadFile(path.join(__dirname, 'hub-consent.html')).catch(cancel);
      });
    },
    cancel() { dismiss?.(); },
  };
}

module.exports = { createHubConsentPresenter };
