'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { EventEmitter } = require('node:events');
const { readObserverDocument, registerNativeObserver } = require('../subapp-native-observer');
const { projectProgress } = require('../simulator-debug-projection');

test('observer embeds only installed assets under a nonce CSP and needs no Runtime/firmware', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-observer-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const pkg = path.join(root, 'node_modules/@aily-project/subapp-simulator-debugger');
    fs.mkdirSync(pkg, { recursive: true });
    const source = path.resolve(__dirname, '../../../aily-subapp/packages/simulator-debugger');
    fs.copyFileSync(path.join(source, 'package.json'), path.join(pkg, 'package.json'));
    fs.cpSync(path.join(source, 'ui'), path.join(pkg, 'ui'), { recursive: true });
    const html = readObserverDocument(root);
    assert.match(html, /script-src 'nonce-/); assert.match(html, /style-src 'nonce-/);
    assert.doesNotMatch(html, /src="monitor.js"|href="monitor.css"/);
    assert.ok(html.lastIndexOf('<script') > html.indexOf('<footer>'));
    assert.match(html, /aily-native-observer-v1/);
    fs.writeFileSync(path.join(pkg, 'ui/monitor.js'), 'x'.repeat(300000));
    assert.throws(() => readObserverDocument(root), /Invalid observer asset/);
});

test('observer IPC authorizes host main frames; update messages contain no other conversation data', () => {
    let handle, changed, stopped;
    const sender = new EventEmitter(); sender.mainFrame = {}; sender.isDestroyed = () => false;
    const events = []; sender.send = (...args) => events.push(args);
    registerNativeObserver({ handle(_name, fn) { handle = fn; } }, {
        isRenderer: candidate => candidate === sender,
        presenter: { subscribe(fn) { changed = fn; }, snapshot(scope) { return { scope }; }, stop(...args) { stopped = args; return { ok: true }; } },
    });
    const input = { toolId: 'simulator-debugger', action: 'snapshot', sessionId: 'A' };
    assert.equal(handle({ sender, senderFrame: {} }, input).errorCode, 'RPC_FORBIDDEN');
    assert.equal(handle({ sender: {}, senderFrame: {} }, input).errorCode, 'RPC_FORBIDDEN');
    const event = { sender, senderFrame: sender.mainFrame };
    assert.deepEqual(handle(event, input).snapshot, { scope: 'A' });
    changed({ snapshot: { uart: 'SECRET B' } });
    assert.deepEqual(events, [['subapp-native-observer-changed']]);
    handle(event, { ...input, action: 'stop', runId: 'run-A' });
    assert.deepEqual(stopped, ['run-A', 'A']);
    assert.equal(handle(event, { ...input, toolId: 'unknown' }).errorCode, 'RPC_FORBIDDEN');
    sender.emit('destroyed'); changed(); assert.equal(events.length, 1);
});

test('individually bounded patches cannot accumulate unbounded observer state', () => {
    let state = projectProgress({}, { outcome: 'running', steps: [{ id: 'one', actual: 'a'.repeat(75000) }] });
    state = projectProgress(state, { uart: 'u'.repeat(75000), outcome: 'failed' });
    assert.equal(state.outcome, 'failed'); assert.equal(state.displayTruncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(state)) < 128 * 1024);
    state = projectProgress({}, { outcome: 'running', evidenceDirectory: 'p'.repeat(75000) });
    state = projectProgress(state, { error: { message: 'e'.repeat(75000) }, outcome: 'error' });
    assert.equal(state.outcome, 'error'); assert.equal(state.displayTruncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(state)) < 128 * 1024);
});
