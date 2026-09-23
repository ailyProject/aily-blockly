const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const {
    attachMacWindowCloseBridge,
    authorizeRendererWindowClose,
    shouldUseNativeMacFrame,
} = require('./mac-window-controls');

test('keeps the native frame only for macOS hiddenInset subwindows', () => {
    assert.equal(shouldUseNativeMacFrame('darwin'), true);
    assert.equal(shouldUseNativeMacFrame('win32'), false);
    assert.equal(shouldUseNativeMacFrame('linux'), false);
});

test('routes a native macOS close request through the renderer', () => {
    const win = new EventEmitter();
    win.isDestroyed = () => false;
    let requests = 0;
    let prevented = 0;
    assert.equal(attachMacWindowCloseBridge(win, () => requests += 1, { platform: 'darwin' }), true);

    win.emit('close', { preventDefault: () => prevented += 1 });
    assert.equal(requests, 1);
    assert.equal(prevented, 1);
});

test('allows one renderer-confirmed close without requesting again', () => {
    const win = new EventEmitter();
    win.isDestroyed = () => false;
    let requests = 0;
    let prevented = 0;
    attachMacWindowCloseBridge(win, () => requests += 1, { platform: 'darwin' });

    assert.equal(authorizeRendererWindowClose(win), true);
    win.emit('close', { preventDefault: () => prevented += 1 });
    assert.equal(requests, 0);
    assert.equal(prevented, 0);

    win.emit('close', { preventDefault: () => prevented += 1 });
    assert.equal(requests, 1);
    assert.equal(prevented, 1);
});

test('does not intercept close while the application is quitting or on other platforms', () => {
    const mac = new EventEmitter();
    mac.isDestroyed = () => false;
    let requests = 0;
    let prevented = 0;
    attachMacWindowCloseBridge(mac, () => requests += 1, { platform: 'darwin', isQuitting: () => true });
    mac.emit('close', { preventDefault: () => prevented += 1 });
    assert.equal(requests, 0);
    assert.equal(prevented, 0);

    const windows = new EventEmitter();
    assert.equal(attachMacWindowCloseBridge(windows, () => requests += 1, { platform: 'win32' }), false);
    windows.emit('close', { preventDefault: () => prevented += 1 });
    assert.equal(requests, 0);
    assert.equal(prevented, 0);
});
