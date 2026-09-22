'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { resolveInstalledPackagePath, resolveSubappRoot } = require('./subapp-manager');

// Fixed registered adapter. Never accept filesystem paths or URLs from an observer.
function readObserverDocument(rootDir = resolveSubappRoot()) {
    const selected = resolveInstalledPackagePath(rootDir, { id: 'simulator-debugger', package: '@aily-project/subapp-simulator-debugger' });
    if (selected.disabled || selected.selectionError) throw new Error('Debugger package is unavailable');
    const root = fs.realpathSync(selected.packagePath);
    const read = file => {
        const resolved = fs.realpathSync(path.join(root, file)), relative = path.relative(root, resolved);
        if (relative.startsWith('..') || path.isAbsolute(relative) || fs.statSync(resolved).size > 256 * 1024) throw new Error('Invalid observer asset');
        return fs.readFileSync(resolved, 'utf8');
    };
    const pkg = JSON.parse(read('package.json'));
    if (pkg.name !== '@aily-project/subapp-simulator-debugger' || pkg.ailySubapp?.runtime?.observer !== true) throw new Error('Observer package update required');
    const nonce = randomBytes(16).toString('base64');
    return read('ui/index.html')
        .replace("script-src 'self'", `script-src 'nonce-${nonce}'`).replace("style-src 'self'", `style-src 'nonce-${nonce}'`)
        .replace('<link rel="stylesheet" href="monitor.css">', () => `<style nonce="${nonce}">${read('ui/monitor.css').replace(/<\/style/gi, '<\\/style')}</style>`)
        .replace('<script src="monitor.js" defer></script>', '')
        // Inline scripts do not honor defer: execute after the installed DOM.
        .replace('</body>', () => `<script nonce="${nonce}">${read('ui/monitor.js').replace(/<\/script/gi, '<\\/script')}</script></body>`);
}

function registerNativeObserver(ipcMain, { presenter, isRenderer, rootDir }) {
    const readers = new Set();
    const authorized = event => isRenderer(event.sender) && event.senderFrame === event.sender.mainFrame;
    presenter.subscribe(() => {
        for (const sender of readers) {
            if (sender.isDestroyed() || !isRenderer(sender)) { readers.delete(sender); continue; }
            // Invalidation only. Each iframe reads its own conversation projection.
            sender.send('subapp-native-observer-changed');
        }
    });
    ipcMain.handle('subapp-native-observer', (event, input = {}) => {
        try {
            if (!authorized(event) || input.toolId !== 'simulator-debugger') return { ok: false, errorCode: 'RPC_FORBIDDEN' };
            const sessionId = typeof input.sessionId === 'string' ? input.sessionId.slice(0, 256) : '';
            if (input.action === 'stop') return presenter.stop(input.runId, sessionId);
            if (!['document', 'snapshot'].includes(input.action)) return { ok: false, errorCode: 'INVALID_INPUT' };
            if (!readers.has(event.sender)) {
                readers.add(event.sender);
                event.sender.once('destroyed', () => readers.delete(event.sender));
            }
            return { ok: true, snapshot: presenter.snapshot(sessionId),
                ...(input.action === 'document' ? { html: readObserverDocument(rootDir) } : {}) };
        } catch (error) { return { ok: false, errorCode: 'OBSERVER_UNAVAILABLE', error: error.message }; }
    });
}
module.exports = { readObserverDocument, registerNativeObserver };
