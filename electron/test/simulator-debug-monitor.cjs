'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), { EventEmitter } = require('node:events');
const { createDebugMonitorPresenter } = require('../simulator-debug-monitor');
class Window extends EventEmitter {
    static instances = [];
    constructor(options) {
        super(); this.options = options; this.messages = []; this.webContents = new EventEmitter();
        this.webContents.mainFrame = {};
        this.webContents.setWindowOpenHandler = handler => { this.open = handler; };
        this.webContents.send = (_channel, data) => this.messages.push(data);
        Window.instances.push(this);
    }
    loadFile(file) { this.file = file; return Promise.resolve(); }
    isDestroyed() { return !!this.dead; }
    destroy() { this.dead = true; }
    showInactive() { this.shown = true; }
}
test('observation view is sandboxed, read-only and retains terminal state through late load', () => {
    const present = createDebugMonitorPresenter(Window), view = present('D:/owned/ui/index.html'), window = Window.instances.at(-1);
    assert.equal(window.options.webPreferences.nodeIntegration, false);
    assert.equal(window.options.webPreferences.sandbox, true); assert.equal(window.options.webPreferences.contextIsolation, true);
    assert.deepEqual(window.open(), { action: 'deny' });
    let blocked = false; window.webContents.emit('will-navigate', { preventDefault() { blocked = true; } }); assert.ok(blocked);
    view.update({ phase: 'scenario', steps: [{ id: 'value', expression: 'counter', outcome: 'running' }], uart: 'READY' });
    view.update({ phase: 'finished', outcome: 'passed', steps: [{ id: 'value', actual: '3' }], ownerSessionId: 'secret', token: 'secret' });
    window.webContents.emit('did-finish-load');
    const state = window.messages.at(-1);
    assert.equal(state.outcome, 'passed'); assert.equal(state.uart, 'READY'); assert.equal(state.steps[0].expression, 'counter');
    assert.equal(state.ownerSessionId, undefined); assert.equal(state.token, undefined);
    view.update({ firmware: { artifactId: 'x'.repeat(10000), target: 'esp32s3', board: 'XIAO', token: 'secret' } });
    assert.deepEqual(window.messages.at(-1).firmware, { artifactId: 'x'.repeat(128), target: 'esp32s3', board: 'XIAO' });
    view.update({ phase: 'finished', outcome: 'failed', steps: [{ id: 'value', actual: 'x'.repeat(200000) }] });
    assert.equal(window.messages.at(-1).outcome, 'failed'); assert.equal(window.messages.at(-1).displayTruncated, true);
    window.destroy(); assert.doesNotThrow(() => view.update({ outcome: 'failed' }));
});
test('a later batch does not receive old progress and no UI file means no window', () => {
    const present = createDebugMonitorPresenter(Window, { visible: false }), count = Window.instances.length;
    assert.equal(present(), undefined); assert.equal(Window.instances.length, count);
    const old = present('D:/a.html'), first = Window.instances.at(-1);
    const current = present('D:/a.html'), next = Window.instances.at(-1);
    assert.equal(first.dead, true); const before = next.messages.length;
    old.update({ outcome: 'failed' }); assert.equal(next.messages.length, before);
    current.update({ outcome: 'passed' }); assert.equal(next.messages.at(-1).outcome, 'passed');
    next.emit('ready-to-show'); assert.equal(next.shown, undefined);
});

test('explicit stop is bound to this view main frame and batch; acknowledgement is not completed cleanup', () => {
    let handler, stopped = 0;
    const present = createDebugMonitorPresenter(Window, { ipcMain: { handle(channel, fn) { assert.equal(channel, 'simulator-debug-monitor-stop'); handler = fn; } } });
    const view = present('D:/a.html', undefined, () => { stopped++; }), window = Window.instances.at(-1);
    const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
    for (const forged of [{}, { sender: {}, senderFrame: {} }, { sender: event.sender, senderFrame: {} }]) {
        assert.equal(handler(forged).errorCode, 'RPC_FORBIDDEN');
    }
    assert.equal(stopped, 0);
    assert.deepEqual(handler(event), { ok: true, requested: true });
    assert.equal(stopped, 1); assert.equal(window.messages.at(-1).outcome, 'running');
    assert.equal(window.messages.at(-1).stopRequested, true); assert.equal(window.messages.at(-1).canStop, false);
    assert.equal(handler(event).requested, true); assert.equal(stopped, 1);
    view.update({ phase: 'finished', outcome: 'cancelled' });
    assert.equal(handler(event).requested, false); assert.equal(stopped, 1);
    const next = present('D:/a.html', undefined, () => { stopped += 100; });
    assert.equal(handler(event).errorCode, 'RPC_FORBIDDEN'); assert.equal(stopped, 1);
    next.update({ phase: 'finished', outcome: 'passed' });
});

test('closing the monitor does not stop the batch, and failed stop remains retryable', () => {
    let handler, attempts = 0;
    const present = createDebugMonitorPresenter(Window, { ipcMain: { handle(_channel, fn) { handler = fn; } } });
    present('D:/a.html', undefined, () => { attempts++; throw new Error('failed'); });
    const window = Window.instances.at(-1), event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
    assert.equal(handler(event).errorCode, 'DEBUG_STOP_FAILED'); assert.equal(handler(event).errorCode, 'DEBUG_STOP_FAILED');
    assert.equal(attempts, 2); window.destroy(); window.emit('closed');
    assert.equal(handler(event).errorCode, 'RPC_FORBIDDEN'); assert.equal(attempts, 2);
});

test('a shared observer projection reopens without execution and isolates conversation/old stop requests', () => {
    let stopped = 0;
    const present = createDebugMonitorPresenter(Window, { visible: false });
    assert.equal(present.snapshot().outcome, 'idle');
    assert.equal(present.open(), false);
    const before = Window.instances.length;
    const run = present('D:/ui/index.html', undefined, () => stopped++, { sessionId: 'A', showWindow: false });
    assert.equal(Window.instances.length, before);
    const firstId = present.snapshot('A').runId;
    run.update({ phase: 'scenario', uart: 'ONLY A' });
    assert.equal(present.snapshot('B').uart, '');
    assert.equal(present.stop(firstId, 'B').ok, false);
    present.open(); const window = Window.instances.at(-1);
    window.destroy(); window.emit('closed');
    run.update({ outcome: 'passed', phase: 'finished' });
    assert.equal(present.open(), true);
    Window.instances.at(-1).webContents.emit('did-finish-load');
    assert.equal(Window.instances.at(-1).messages.at(-1).uart, 'ONLY A');
    assert.equal(stopped, 0);
    present('D:/ui/index.html', undefined, () => stopped++, { sessionId: 'B', showWindow: false });
    assert.equal(present.snapshot('A').outcome, 'idle');
    assert.equal(present.stop(firstId, 'B').errorCode, 'DEBUG_RUN_STALE');
    assert.equal(present.stop(present.snapshot('B').runId, 'B').requested, true);
    assert.equal(stopped, 1);
});
