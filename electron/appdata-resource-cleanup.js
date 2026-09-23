'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { app, ipcMain } = require('electron');
const { retainAppDataResourceLock } = require('./appdata-resource-lock');
let registered = false;

// Only an exact resource under the managed SDK/tools bases can be removed.
// The caller's earlier enumeration is advisory; recheck the boundary in main.
function resolveManagedResource(root, target) {
    if (typeof target !== 'string' || !path.isAbsolute(target)) throw new Error('APPDATA_RESOURCE_PATH_UNSAFE');
    const appData = path.resolve(root), absolute = path.resolve(target);
    const parts = path.relative(appData, absolute).split(path.sep);
    if (parts.length !== 2 || !['sdk', 'tools'].includes(parts[0].toLowerCase())
        || !parts[1] || parts[1] === '..') throw new Error('APPDATA_RESOURCE_PATH_UNSAFE');
    const base = path.dirname(absolute);
    // Never traverse a redirected root/base or a resource symlink/junction.
    if (path.relative(appData, fs.realpathSync(appData)) !== '') throw new Error('APPDATA_RESOURCE_PATH_UNSAFE');
    for (const candidate of [base, absolute]) {
        try {
            if (fs.lstatSync(candidate).isSymbolicLink()) throw new Error('APPDATA_RESOURCE_PATH_UNSAFE');
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return absolute;
}

function registerAppDataResourceCleanupHandlers() {
    if (registered) return;
    registered = true;
    ipcMain.handle('appdata-resource-remove', async (event, { token, target }) => {
        const lease = retainAppDataResourceLock(token, event.sender.id, 'write');
        try {
            const absolute = resolveManagedResource(process.env.AILY_APPDATA_PATH || app.getPath('userData'), target);
            await fs.promises.rm(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
            return { ok: true };
        } finally { lease.release(); }
    });
}

module.exports = { registerAppDataResourceCleanupHandlers, resolveManagedResource };
