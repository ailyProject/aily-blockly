const path = require('node:path');
const { randomBytes } = require('node:crypto');

// Keep the consent document isolated while presenting it inside the host window.
function createHubConsentPresenter({ window, WebContentsView, ipcMain }) {
  let dismiss;
  let theme = 'dark', publishTheme;
  return {
    setTheme(mode) {
      if (mode !== 'light' && mode !== 'dark') return;
      theme = mode; publishTheme?.(mode);
    },
    confirm({ account, origin, expiresAt }) {
      dismiss?.();
      if (window.isDestroyed()) return Promise.resolve(false);
      return new Promise(resolve => {
        const id = randomBytes(12).toString('hex');
        const dataChannel = `hub-consent:${id}:data`;
        const decisionChannel = `hub-consent:${id}:decision`;
        const consent = new WebContentsView({
          webPreferences: {
            preload: path.join(__dirname, 'hub-consent-preload.js'),
            additionalArguments: [`--aily-hub-consent=${id}`, `--aily-hub-theme=${theme}`],
            contextIsolation: true, nodeIntegration: false, sandbox: true,
            webSecurity: true, partition: `hub-consent-${id}`,
          },
        });
        const contents = consent.webContents;
        consent.setBackgroundColor('#00000000');
        consent.setVisible(false);
        window.contentView.addChildView(consent);
        let settled = false;
        const ownFrame = event => !window.isDestroyed() && !contents.isDestroyed()
          && event.sender === contents && event.senderFrame === contents.mainFrame;
        const layout = () => {
          if (settled || window.isDestroyed()) return;
          const bounds = window.getContentBounds();
          const width = Math.max(1, Math.min(488, bounds.width - 32));
          const height = Math.max(1, Math.min(640, bounds.height - 56));
          consent.setBounds({ x: Math.round((bounds.width - width) / 2),
            y: Math.max(40, Math.round((bounds.height - height) / 2)), width, height });
        };
        const finish = allowed => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          ipcMain.removeHandler(dataChannel);
          ipcMain.removeListener(decisionChannel, decide);
          window.removeListener('resize', layout);
          window.removeListener('closed', cancel);
          if (dismiss === cancel) { dismiss = undefined; publishTheme = undefined; }
          const restoreFocus = !contents.isDestroyed() && contents.isFocused();
          if (!window.isDestroyed()) window.contentView.removeChildView(consent);
          if (!contents.isDestroyed()) contents.close();
          if (restoreFocus && !window.isDestroyed()) window.webContents.focus();
          resolve(allowed === true && Date.now() < expiresAt);
        };
        const cancel = () => finish(false);
        const decide = (event, allowed) => { if (ownFrame(event) && typeof allowed === 'boolean') finish(allowed); };
        const timer = setTimeout(cancel, Math.max(0, Math.min(expiresAt - Date.now(), 120_000)));
        timer.unref?.();
        dismiss = cancel;
        publishTheme = mode => { if (!settled && !contents.isDestroyed()) contents.send(`hub-consent:${id}:theme`, mode); };
        ipcMain.handle(dataChannel, event => ownFrame(event) ? { account, origin, expiresAt, theme } : null);
        ipcMain.on(decisionChannel, decide);
        contents.setWindowOpenHandler(() => ({ action: 'deny' }));
        contents.on('will-navigate', event => event.preventDefault());
        contents.on('will-attach-webview', event => event.preventDefault());
        contents.on('render-process-gone', cancel);
        contents.once('destroyed', cancel);
        window.once('closed', cancel);
        window.on('resize', layout);
        contents.once('did-finish-load', () => {
          if (settled || window.isDestroyed()) return;
          layout(); consent.setVisible(true);
          if (window.isMinimized()) window.restore();
          window.show(); contents.focus();
        });
        layout();
        void contents.loadFile(path.join(__dirname, 'hub-consent.html')).catch(cancel);
      });
    },
    cancel() { dismiss?.(); },
  };
}

module.exports = { createHubConsentPresenter };
