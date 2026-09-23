'use strict';
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { idleSnapshot, projectProgress } = require('./simulator-debug-projection');

/** One bounded latest-batch projection shared by all observers. A view owns no
 * execution resources; closing/reopening it cannot cancel or restart QEMU. */
function createDebugMonitorPresenter(BrowserWindow, { visible = true, ipcMain } = {}) {
    let current;
    const listeners = new Set();
    const snapshot = sessionId => !current || (sessionId && sessionId !== current.sessionId)
        ? idleSnapshot() : { ...current.latest, runId: current.id, stopRequested: current.stopRequested,
            canStop: !!current.stop && current.latest.outcome === 'running' && !current.stopRequested };
    const publish = () => {
        const data = snapshot();
        if (current?.view && !current.view.isDestroyed()) current.view.webContents.send('simulator-debug-progress', data);
        for (const listener of listeners) { try { listener({ sessionId: current?.sessionId || '', snapshot: data }); } catch {} }
    };
    const stop = (runId, sessionId) => {
        if (!current || runId !== current.id || (sessionId && current.sessionId !== sessionId)) return { ok: false, errorCode: 'DEBUG_RUN_STALE' };
        if (current.latest.outcome !== 'running' || !current.stop) return { ok: true, requested: false };
        if (!current.stopRequested) {
            try { current.stop(); current.stopRequested = true; publish(); }
            catch { return { ok: false, errorCode: 'DEBUG_STOP_FAILED' }; }
        }
        return { ok: true, requested: true };
    };
    ipcMain?.handle('simulator-debug-monitor-stop', event => {
        const view = current?.view;
        if (!view || view.isDestroyed() || event.sender !== view.webContents || event.senderFrame !== view.webContents.mainFrame) {
            return { ok: false, errorCode: 'RPC_FORBIDDEN' };
        }
        return stop(current.id);
    });
    function open() {
        const batch = current;
        if (!batch?.monitorPath) return false;
        if (batch.view && !batch.view.isDestroyed()) { if (visible) batch.view.showInactive(); return true; }
        const view = new BrowserWindow({ show: false, width: 900, height: 680, minWidth: 580, minHeight: 420,
            ...(batch.sender ? { parent: BrowserWindow.fromWebContents(batch.sender) || undefined } : {}),
            title: 'Simulator Debugger', backgroundColor: '#111820', autoHideMenuBar: true,
            webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false,
                preload: path.join(__dirname, 'simulator-debug-monitor-preload.js'), partition: 'simulator-debug-monitor' } });
        batch.view = view;
        view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        view.webContents.on('will-navigate', event => event.preventDefault());
        view.webContents.on('will-attach-webview', event => event.preventDefault());
        view.webContents.on('did-finish-load', () => { if (current === batch) publish(); });
        view.once('ready-to-show', () => { if (visible && !view.isDestroyed()) view.showInactive(); });
        void view.loadFile(batch.monitorPath).catch(() => { if (!view.isDestroyed()) view.destroy(); });
        return true;
    }
    const present = (monitorPath, sender, requestStop, { sessionId = '', showWindow = true } = {}) => {
        if (!monitorPath) return undefined;
        if (current?.view && !current.view.isDestroyed()) current.view.destroy();
        const batch = { id: randomUUID(), sessionId, monitorPath, sender, stop: requestStop, stopRequested: false,
            latest: { ...idleSnapshot(), phase: 'starting', outcome: 'running' } };
        current = batch;
        if (showWindow) open();
        publish();
        return { update(data) {
            if (!data || current !== batch) return;
            batch.latest = projectProgress(batch.latest, data);
            if (batch.latest.outcome !== 'running') { batch.stop = undefined; batch.sender = undefined; }
            publish();
        } };
    };
    return Object.assign(present, { snapshot, stop, open, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } });
}
module.exports = { createDebugMonitorPresenter };
