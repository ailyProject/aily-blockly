'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createEmbeddedViewDocument } = require('./subapp-browser-view-document');
const { fakeElectron, tick } = require('./test/fixtures/subapp-browser-view.cjs');

function fixture() {
    const electron = fakeElectron(), window = new electron.Window(), parent = window.webContents;
    const bounds = { x: 8, y: 16, width: 160, height: 80 };
    const open = (input = {}) => createEmbeddedViewDocument({ BrowserWindow: electron.Window,
        WebContentsView: electron.View, parent, bounds, webPreferences: { sandbox: true }, ...input });
    return { ...electron, window, parent, bounds, open };
}

test('embedded document binds the exact owner Main and converts its CSS rectangle to DIP', async () => {
    const f = fixture(); f.parent.zoom = 1.25;
    const document = f.open(), view = f.views[0];
    assert.equal(document.webContents, view.webContents); assert.equal(document.presentation, 'embedded');
    assert.deepEqual(view.options.webPreferences, { sandbox: true });
    assert.equal(f.window.children.has(view), true); assert.equal(view.visible, false);
    assert.deepEqual(view.bounds, { x: 10, y: 20, width: 200, height: 100 });
    document.show(); assert.equal(view.visible, true);
    document.update({ bounds: { x: 16, y: 24, width: 80, height: 40 }, visible: false });
    assert.deepEqual(view.bounds, { x: 20, y: 30, width: 100, height: 50 }); assert.equal(view.visible, false);
    await document.destroy(); assert.equal(document.isDestroyed(), true); assert.equal(f.window.children.size, 0);
    assert.deepEqual(view.webContents.closeOptions, { waitForBeforeUnload: false });
});

test('invalid or unrelated owner documents, geometry and visibility cannot create an embedded View', () => {
    const f = fixture();
    assert.throws(() => f.open({ parent: new f.Contents() }), /owning Main/);
    const impostor = new f.Window();
    assert.throws(() => f.open({ BrowserWindow: { fromWebContents: () => impostor } }), /owning Main/);
    for (const bounds of [
        { x: -1, y: 0, width: 10, height: 10 }, { x: 0.5, y: 0, width: 10, height: 10 },
        { x: 0, y: 0, width: 0, height: 10 }, { x: 0, y: 0, width: 20000, height: 10 },
        { x: 795, y: 0, width: 10, height: 10 }, { x: 0, y: 0, width: 10, height: 10, url: 'https://elsewhere' },
    ]) assert.throws(() => f.open({ bounds }), /bounds/);
    assert.throws(() => f.open({ visible: 'true' }), /visibility/);
    f.parent.zoom = 0; assert.throws(() => f.open(), /zoom/);
    assert.equal(f.views.length, 0);
});

test('destroy waits for actual WebContents destruction, joins repeat calls and permits a failed close retry', async () => {
    const f = fixture(), document = f.open(), contents = document.webContents;
    contents.closeError = new Error('actual close failed');
    await assert.rejects(document.destroy(), /actual close failed/);
    assert.equal(document.isDestroyed(), false); assert.equal(f.window.children.size, 0);
    assert.equal(f.parent.listenerCount('destroyed'), 1);
    contents.closeError = null; contents.holdClose = true;
    let settled = false; const pending = document.destroy().then(() => { settled = true; });
    const joined = document.destroy(); await tick();
    assert.equal(settled, false); assert.equal(document.isDestroyed(), false); assert.equal(contents.closeCalls, 2);
    contents.finishClose(); await Promise.all([pending, joined]);
    assert.equal(document.isDestroyed(), true); assert.equal(f.parent.listenerCount('destroyed'), 0);
    assert.equal(f.parent.listenerCount('render-process-gone'), 0); assert.equal(f.parent.listenerCount('did-start-navigation'), 0);
});

test('same-document and subframe navigation preserve presentation; parent main navigation retires only its View', async () => {
    const f = fixture(), document = f.open(), contents = document.webContents; contents.holdClose = true;
    f.parent.emit('did-start-navigation', {}, 'https://owner/#same', true, true);
    f.parent.emit('did-start-navigation', {}, 'https://frame/', false, false);
    assert.equal(contents.closeCalls, 0);
    f.parent.emit('did-start-navigation', {}, 'https://new-owner/', false, true); await tick();
    assert.equal(contents.closeCalls, 1); assert.equal(document.isDestroyed(), false);
    assert.equal(f.parent.isDestroyed(), false); assert.equal(f.window.children.size, 0);
    contents.finishClose(); await document.destroy(); assert.equal(document.isDestroyed(), true);
});

test('parent renderer crash and destruction physically retire the View without destroying the Main window', async () => {
    for (const event of ['render-process-gone', 'destroyed']) {
        const f = fixture(), document = f.open();
        f.parent.emit(event); await tick();
        assert.equal(document.isDestroyed(), true); assert.equal(f.window.isDestroyed(), false);
        assert.equal(f.window.children.size, 0);
    }
});
