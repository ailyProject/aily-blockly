'use strict';

const { EventEmitter } = require('node:events');
const { randomUUID, createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SubappBrowserExecutionHost } = require('../../subapp-browser-execution-host');
const { createEmbeddedViewDocument } = require('../../subapp-browser-view-document');
const { PROTOCOL, readBrowserExecutionSource } = require('../../subapp-browser-execution-source');

const tick = () => new Promise(resolve => setImmediate(resolve));

function fakeElectron() {
    const windows = [], views = [], windowForContents = new Map();
    let nextId = 1;
    class Contents extends EventEmitter {
        constructor() {
            super(); this.id = nextId++; this.dead = false; this.url = ''; this.zoom = 1; this.received = []; this.closeCalls = 0;
            this.mainFrame = {};
            this.session = { setPermissionRequestHandler() {}, setPermissionCheckHandler() {},
                webRequest: { onBeforeRequest: handler => { this.requestHandler = handler; } } };
        }
        isDestroyed() { return this.dead; }
        getURL() { return this.url; }
        getZoomFactor() { return this.zoom; }
        setWindowOpenHandler(handler) { this.popup = handler; }
        async loadURL(url) { this.url = url; }
        postMessage(channel, data, ports) { this.received.push({ channel, data, ports }); this.emit('delivered', { channel, data, ports }); }
        close(options) {
            this.closeCalls++; this.closeOptions = options;
            if (this.closeError) throw this.closeError;
            if (!this.holdClose) this.finishClose();
        }
        finishClose() { if (this.dead) return; this.dead = true; this.emit('destroyed'); }
    }
    class Window extends EventEmitter {
        constructor(options = {}) {
            super(); this.options = options; this.dead = false; this.webContents = new Contents(); this.children = new Set();
            this.contentBounds = { x: 0, y: 0, width: 800, height: 600 };
            this.contentView = { addChildView: view => { this.children.add(view); }, removeChildView: view => { this.children.delete(view); } };
            windows.push(this); windowForContents.set(this.webContents, this);
        }
        static fromWebContents(contents) { return windowForContents.get(contents); }
        getContentBounds() { return { ...this.contentBounds }; }
        loadURL(url) { return this.webContents.loadURL(url); }
        isDestroyed() { return this.dead; }
        show() { this.shown = true; }
        destroy() { if (this.dead) return; this.dead = true; this.webContents.finishClose(); this.emit('closed'); }
    }
    class View {
        constructor(options) { this.options = options; this.webContents = new Contents(); views.push(this); }
        setBounds(bounds) { this.bounds = bounds; }
        setVisible(visible) { this.visible = visible; }
    }
    class Port extends EventEmitter {
        postMessage(data, ports = []) {
            if (this.closed) throw new Error('Port closed');
            queueMicrotask(() => { if (!this.peer.closed) this.peer.emit('message', { data, ports }); });
        }
        start() {}
        close() { this.closed = true; }
    }
    class Channel {
        constructor() { this.port1 = new Port(); this.port2 = new Port(); this.port1.peer = this.port2; this.port2.peer = this.port1; }
    }
    return { Window, View, Contents, Channel, windows, views };
}

function selectedSource(t) {
    const temporaryRoot = path.resolve(os.tmpdir());
    const directory = fs.mkdtempSync(path.join(temporaryRoot, 'aily-embedded-view-test-'));
    t.after(() => {
        if (path.dirname(path.resolve(directory)) !== temporaryRoot || !path.basename(directory).startsWith('aily-embedded-view-test-')) {
            throw new Error('Refusing cleanup outside the owned test directory');
        }
        fs.rmSync(directory, { recursive: true, force: true });
    });
    fs.mkdirSync(path.join(directory, 'public'));
    const html = '<!doctype html><title>Execution</title>';
    fs.writeFileSync(path.join(directory, 'public/execution.html'), html);
    fs.writeFileSync(path.join(directory, 'public/view.html'), '<!doctype html><title>View</title>');
    const manifest = { name: '@fixture/embedded-view', version: '1.2.3', ailySubapp: {
        runtime: { browserExecution: { protocol: PROTOCOL, root: 'public', entry: 'execution.html',
            sha256: createHash('sha256').update(html).digest('hex') } },
        ui: { surfaces: { full: { entry: 'public/view.html' } } },
    } };
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify(manifest));
    const config = { id: 'fixture', catalogId: 'fixture', packageName: manifest.name, version: manifest.version, packagePath: directory };
    return { config, source: readBrowserExecutionSource(config) };
}

function hostHarness(t) {
    const electron = fakeElectron(), { Window, View, Channel } = electron;
    const parentWindow = new Window(), parent = parentWindow.webContents, lifecycle = [];
    const selected = selectedSource(t);
    const runtimeId = 'registered-embedded-view-stream';
    let serverCloses = 0;
    const host = new SubappBrowserExecutionHost({ BrowserWindow: Window, MessageChannelMain: Channel, timeoutMs: 200,
        createViewDocument: input => createEmbeddedViewDocument({ BrowserWindow: Window, WebContentsView: View, ...input }),
        createServer: () => ({ start: async () => ({ origin: 'http://127.0.0.1:49152' }), close: async () => { serverCloses++; } }),
    });
    const originalDocument = host.createDocument.bind(host);
    host.createDocument = state => {
        const document = originalDocument(state);
        document.webContents.on('delivered', ({ data, ports }) => {
            if (data.role !== 'host') return;
            const port = ports[0];
            port.on('message', ({ data: message }) => {
                lifecycle.push(message);
                port.postMessage({ id: message.id, ok: true, value: { resources: 0 } });
            });
            port.postMessage({ type: 'ready', protocol: PROTOCOL });
        });
        return document;
    };
    const owner = (leaseId = randomUUID()) => {
        const cleanups = new Set(); let valid = true;
        const guard = () => { if (!valid) throw new Error('Owner revoked'); };
        Object.assign(guard, { runtime: { streamId: runtimeId }, ownerSessionId: leaseId,
            attachCleanup(cleanup) { guard(); cleanups.add(cleanup); return () => cleanups.delete(cleanup); } });
        return { runtimeId, source: selected.source, ownerId: parent.id, leaseId, guard,
            revokeAdmission() { valid = false; } };
    };
    t.after(async () => {
        for (const view of electron.views) { view.webContents.closeError = null; view.webContents.holdClose = false; view.webContents.finishClose(); }
        await host.closeAll();
    });
    return { ...electron, ...selected, host, parent, parentWindow, runtimeId, owner, lifecycle,
        get serverCloses() { return serverCloses; }, bounds: { x: 20, y: 30, width: 400, height: 200 } };
}

module.exports = { fakeElectron, hostHarness, tick };
