'use strict';

const { EventEmitter } = require('node:events');

const fault = message => new Error(message);

/** Geometry is expressed in the owning renderer's CSS viewport. The adapter
 * converts it to Electron DIP bounds and never accepts a window id or URL. */
function viewBounds(input, parentWindow, parent) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).sort().join(',') !== 'height,width,x,y'
        || !['x', 'y', 'width', 'height'].every(key => Number.isSafeInteger(input[key]))
        || input.x < 0 || input.y < 0 || input.width < 1 || input.height < 1
        || ['x', 'y', 'width', 'height'].some(key => input[key] > 16384)) {
        throw fault('Embedded View bounds must be a bounded viewport rectangle');
    }
    const zoom = typeof parent.getZoomFactor === 'function' ? parent.getZoomFactor() : 1;
    if (!Number.isFinite(zoom) || zoom <= 0 || zoom > 5) throw fault('Embedded View zoom is unavailable');
    const available = parentWindow.getContentBounds();
    const left = Math.floor(input.x * zoom), top = Math.floor(input.y * zoom);
    const right = Math.ceil((input.x + input.width) * zoom), bottom = Math.ceil((input.y + input.height) * zoom);
    if (right > available.width || bottom > available.height) throw fault('Embedded View bounds exceed its owner viewport');
    return { x: left, y: top, width: right - left, height: bottom - top };
}

/** A presentation-only document. Ownership, RPC and cleanup acknowledgements
 * remain in the execution Host. Parent loss physically retires this View but
 * supplies no Runtime or Node business cleanup acknowledgement. */
function createEmbeddedViewDocument({ BrowserWindow, WebContentsView, parent, webPreferences, bounds, visible = true }) {
    if (!parent || parent.isDestroyed() || typeof BrowserWindow?.fromWebContents !== 'function') {
        throw fault('Embedded View requires its current owner document');
    }
    const parentWindow = BrowserWindow.fromWebContents(parent);
    if (!parentWindow || parentWindow.isDestroyed() || parentWindow.webContents !== parent
        || !parentWindow.contentView?.addChildView || !parentWindow.contentView?.removeChildView) {
        throw fault('Embedded View requires the owning Main window');
    }
    if (typeof visible !== 'boolean') throw fault('Embedded View visibility must be boolean');
    const initialBounds = viewBounds(bounds, parentWindow, parent);
    // Lazy Electron access keeps the default BrowserWindow path independent of
    // this optional presentation. Tests may inject the real View constructor.
    const Constructor = WebContentsView || require('electron').WebContentsView;
    const view = new Constructor({ webPreferences });
    const contents = view.webContents, events = new EventEmitter();
    let attached = false, closed = false, closing = null, desiredVisible = visible;
    const currentParent = () => {
        if (parent.isDestroyed() || parentWindow.isDestroyed() || BrowserWindow.fromWebContents(parent) !== parentWindow) {
            throw fault('Embedded View owner document ended');
        }
    };
    const removeParentListeners = () => {
        parent.removeListener('destroyed', parentEnded);
        parent.removeListener('render-process-gone', parentEnded);
        parent.removeListener('did-start-navigation', parentNavigated);
    };
    const detach = () => {
        if (!attached) return;
        try { parentWindow.contentView.removeChildView(view); }
        catch (error) { if (!parentWindow.isDestroyed()) throw error; }
        attached = false;
    };
    const ended = () => {
        if (closed) return;
        closed = true; removeParentListeners();
        try { detach(); } finally { events.emit('closed'); }
    };
    const document = {
        webContents: contents, presentation: 'embedded',
        loadURL: url => contents.loadURL(url),
        isDestroyed: () => contents.isDestroyed(),
        on: (event, listener) => { events.on(event, listener); return document; },
        once: (event, listener) => { events.once(event, listener); return document; },
        show() { currentParent(); view.setVisible(desiredVisible); },
        update({ bounds: nextBounds, visible: nextVisible }) {
            currentParent();
            if (contents.isDestroyed()) throw fault('Embedded View document ended');
            if (typeof nextVisible !== 'boolean') throw fault('Embedded View visibility must be boolean');
            const next = viewBounds(nextBounds, parentWindow, parent);
            view.setBounds(next); desiredVisible = nextVisible; view.setVisible(nextVisible);
        },
        async destroy() {
            if (contents.isDestroyed()) { ended(); return; }
            if (closing) return closing;
            closing = new Promise((resolve, reject) => {
                const done = () => resolve();
                contents.once('destroyed', done);
                try { view.setVisible(false); detach(); contents.close({ waitForBeforeUnload: false }); }
                catch (error) { contents.removeListener('destroyed', done); reject(error); }
            });
            try { await closing; }
            finally { if (!contents.isDestroyed()) closing = null; }
        },
    };
    function parentEnded() { void document.destroy().catch(() => {}); }
    function parentNavigated(_event, _url, inPlace, mainFrame) { if (mainFrame && !inPlace) parentEnded(); }
    contents.once('destroyed', ended);
    parent.once('destroyed', parentEnded);
    parent.once('render-process-gone', parentEnded);
    parent.on('did-start-navigation', parentNavigated);
    try {
        view.setVisible(false); view.setBounds(initialBounds);
        parentWindow.contentView.addChildView(view); attached = true;
    } catch (error) { void document.destroy().catch(() => {}); throw error; }
    return document;
}

module.exports = { createEmbeddedViewDocument };
