'use strict';
const { randomUUID } = require('node:crypto');

/** Confirmation owns no shutdown resources. Only an accepted answer starts cleanup. */
function createApplicationQuitCoordinator({ app, ipcMain, getWindow, canConfirm, confirmUnavailable, cleanup,
  onError = console.warn, deliveryTimeoutMs = 5000 }) {
  let pending = null;
  let phase = 'idle';

  const frameOf = sender => sender.isDestroyed() ? null : sender.mainFrame;
  const isCurrent = request => pending === request && getWindow() === request.win
    && !request.win.isDestroyed() && frameOf(request.sender) === request.frame;

  function clearPending() {
    if (!pending) return;
    clearTimeout(pending.timer);
    for (const [name, listener] of pending.listeners) pending.sender.removeListener(name, listener);
    pending = null;
  }

  function drain() {
    clearPending();
    phase = 'draining';
    Promise.resolve().then(cleanup).catch(onError).finally(() => {
      phase = 'complete';
      app.quit();
    });
  }

  function answer(request, allowed) {
    if (!isCurrent(request)) { if (pending === request) clearPending(); return; }
    clearPending();
    if (allowed === true) drain();
  }

  function requestQuit() {
    if (pending && !isCurrent(pending)) clearPending();
    if (phase !== 'idle' || pending) return;
    const win = getWindow();
    // Startup failures and an already closed main window have no live editor to ask.
    if (!win || win.isDestroyed()) { drain(); return; }
    const sender = win.webContents;
    const request = { win, sender, frame: frameOf(sender), requestId: randomUUID(), listeners: [] };
    pending = request;
    const invalidate = () => { if (pending === request) clearPending(); };
    const askNative = () => {
      if (!isCurrent(request) || request.native) return;
      request.native = true;
      clearTimeout(request.timer);
      // Only transport delivery is bounded; there is no timer on the user's save dialog.
      Promise.resolve().then(() => confirmUnavailable(win)).then(allowed => answer(request, allowed), error => {
        invalidate(); onError(error);
      });
    };
    const navigation = (_event, _url, isInPlace, isMainFrame) => { if (isMainFrame && !isInPlace) invalidate(); };
    request.listeners = [['did-start-navigation', navigation], ['render-process-gone', invalidate],
      ['destroyed', invalidate], ['unresponsive', askNative]];
    for (const [name, listener] of request.listeners) sender.on(name, listener);
    try {
      if (!sender.isDestroyed() && !sender.isCrashed() && canConfirm(win)) {
        request.timer = setTimeout(askNative, deliveryTimeoutMs);
        request.timer.unref?.();
        sender.send('window-close-request', { requestId: request.requestId });
      } else {
        // Never silently discard an unavailable renderer's unsaved buffers.
        askNative();
      }
    } catch (error) { invalidate(); onError(error); }
  }

  function beforeQuit(event) {
    if (phase === 'complete') return;
    event.preventDefault();
    requestQuit();
  }

  function matchingRequest(event, reply) {
    const request = pending;
    return request && !request.native && !request.sender.isDestroyed() && event.sender === request.sender
      && event.senderFrame === request.frame && reply?.requestId === request.requestId ? request : null;
  }

  function confirmed(event, reply) {
    const request = matchingRequest(event, reply);
    if (!request || typeof reply.allowed !== 'boolean') return;
    answer(request, reply.allowed);
  }

  app.on('before-quit', beforeQuit);
  ipcMain.on('window-close-checking', (event, reply) => {
    const request = matchingRequest(event, reply);
    if (request) clearTimeout(request.timer);
  });
  ipcMain.on('window-close-confirmed', confirmed);
  return { canClose: () => phase === 'complete' };
}

module.exports = { createApplicationQuitCoordinator };
