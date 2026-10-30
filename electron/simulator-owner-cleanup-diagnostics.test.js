'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { createSimulatorOwnerCleanupDiagnostics } = require('./simulator-owner-cleanup-diagnostics');
const stages = ['owner.scene-generation', 'owner.application', 'owner.workspace',
    'application.control-sessions', 'application.tool-launches', 'application.artifact-reads', 'application.editor-locations'];
const codes = ['artifact-in-use', 'artifact-unavailable', 'artifact-import-failed', 'artifact-capacity-reached',
    'cleanup-failed', 'cleanup-unconfirmed', 'closed', 'owner-closing', 'capacity-reached',
    'request-cancelled', 'control-closed', 'busy', 'session-conflict', 'session-not-found',
    'scene-close-failed', 'scene-not-found', 'launch-close-failed', 'launch-not-found',
    'authority-closed', 'attachment-not-found', 'owner-mismatch', 'owner-expired',
    'main-release-unconfirmed', 'gateway-failed', 'invalid-request', 'in-use',
    'source-invalid', 'source-missing', 'integrity-failed', 'scope-mismatch', 'workspace-busy',
    'aggregate-error', 'unclassified-error'];
const row = (stage = stages[0], errorCode = 'cleanup-failed') => ({ event: 'simulator-owner-cleanup-stage-failed', stage, errorCode });
const line = value => Buffer.from(JSON.stringify(value) + '\n');

test('only the seven exact stage names and safe error codes are projected', () => {
    const received = [], sink = createSimulatorOwnerCleanupDiagnostics({ enabled: true, write: value => received.push(value) });
    for (const stage of stages) for (const code of codes) sink.push(line(row(stage, code)));
    sink.close();
    assert.deepEqual(received, stages.flatMap(stage => codes.map(code => row(stage, code))));
    assert.ok(received.every(value => Object.keys(value).sort().join(',') === 'errorCode,event,stage'));
});

test('every byte split, CRLF, multiple records and final complete record retain exact framing', () => {
    const encoded = line(row());
    for (let split = 0; split <= encoded.length; split++) {
        const received = [], sink = createSimulatorOwnerCleanupDiagnostics({ enabled: true, write: value => received.push(value) });
        sink.push(encoded.subarray(0, split)); sink.push(encoded.subarray(split)); sink.close(); sink.close(); sink.push(encoded);
        assert.deepEqual(received, [row()]);
    }
    const received = [], sink = createSimulatorOwnerCleanupDiagnostics({ enabled: true, write: value => received.push(value) });
    sink.push(Buffer.from('\r\n' + JSON.stringify(row()) + '\r\n' + JSON.stringify(row(stages[1]))));
    sink.close(); assert.deepEqual(received, [row(), row(stages[1])]);
});

test('extra fields, private text, unknown enums, malformed JSON and truncated EOF are never logged', () => {
    const received = [], sink = createSimulatorOwnerCleanupDiagnostics({ enabled: true, write: value => received.push(value) });
    for (const value of [{ ...row(), message: '/private/token-or-path' }, { ...row(), cause: 'private' },
        { ...row(), stack: 'private' }, { ...row(), ownerSessionId: 'private' }, row('/private/stage'), row(stages[0], '/private/code'),
        { ...row(), event: 'other-event' }, [row()], null, 'private stderr', { ...row(), stage: {} }]) sink.push(line(value));
    sink.push(Buffer.from('private raw stderr\n{not json}\n{"event":"simulator-owner-cleanup-stage-failed"'));
    sink.close(); assert.deepEqual(received, []);
});

test('oversized lines are dropped through their terminator and cannot retain or splice private bytes', () => {
    const received = [], sink = createSimulatorOwnerCleanupDiagnostics({ enabled: true, write: value => received.push(value) });
    sink.push(Buffer.alloc(2 * 1024 * 1024, 120)); sink.push(line(row()));
    assert.deepEqual(received, []);
    sink.push(line(row(stages[2]))); sink.close(); assert.deepEqual(received, [row(stages[2])]);
    const bounded = [], second = createSimulatorOwnerCleanupDiagnostics({ enabled: true, write: value => bounded.push(value) });
    const padded = Buffer.from(' '.repeat(1024 - JSON.stringify(row()).length) + JSON.stringify(row()));
    for (const byte of padded) second.push(Buffer.from([byte]));
    second.push(Buffer.from('\n')); second.close(); assert.deepEqual(bounded, [row()]);
});

test('disabled sink, unsupported chunks and a throwing logger never affect the caller', () => {
    const disabled = createSimulatorOwnerCleanupDiagnostics({ enabled: false, write: () => assert.fail('Not enabled') });
    disabled.push(line(row())); disabled.close();
    let calls = 0;
    const sink = createSimulatorOwnerCleanupDiagnostics({ enabled: true, write() { calls++; throw Error('Sink unavailable'); } });
    assert.doesNotThrow(() => { sink.push('private string'); sink.push(line(row())); sink.push(line(row())); sink.close(); });
    assert.equal(calls, 2);
});

function commandFixture({ throws = false } = {}) {
    const handlers = new Map(), messages = [], warnings = [], children = [];
    let destroyed = false;
    const sender = { id: 1, mainFrame: {}, isDestroyed: () => destroyed,
        send: (channel, payload) => messages.push({ channel, payload }) };
    const context = { module: { exports: {} }, process, setTimeout, clearTimeout,
        console: { log() {}, info() {}, error() {}, warn(value) { if (throws) throw Error('Main logger failed'); warnings.push(value); } },
        require: name => {
            if (name === 'electron') return { ipcMain: { handle: (key, handler) => handlers.set(key, handler) } };
            if (name === './platform') return { isLinux: true };
            if (name === './child-process-message-port') {
                const original = require(name);
                return { ...original, normalizeProcessMessagePortConfig: value => original.normalizeProcessMessagePortConfig(
                    value == null ? value : JSON.parse(JSON.stringify(value))) };
            }
            if (name === 'child_process') return { spawn() {
                const pipes = [new EventEmitter(), new EventEmitter(), new EventEmitter()];
                const child = Object.assign(new EventEmitter(), { pid: 12345 + children.length, connected: true, send() {},
                    stdio: pipes, stdin: pipes[0], stdout: pipes[1], stderr: pipes[2] });
                children.push(child); return child;
            } };
            return require(name);
        } };
    const filename = require.resolve('./cmd'); vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
    const api = context.module.exports; api.registerCmdHandlers(null);
    return { api, children, messages, warnings, destroyRenderer: () => { destroyed = true; },
        run: options => handlers.get('cmd-run')({ sender, senderFrame: sender.mainFrame }, {
            command: process.execPath, args: [], shellProfile: false, streamId: 'child_tool_simulator_test_1',
            messagePort: { transport: 'node-ipc-v1', maxMessageBytes: 4096 }, env: { AILY_CHILD_TOOL_ID: 'simulator' }, ...options,
        }) };
}

test('actual CMD logs safe diagnostics without any Renderer while preserving its sole terminal observer', async () => {
    const f = commandFixture(), stream = 'child_tool_simulator_test_1';
    assert.equal((await f.run({})).success, true); const child = f.children[0];
    assert.equal(child.listenerCount('close'), 1); assert.equal(child.listenerCount('exit'), 1);
    child.stderr.emit('data', Buffer.from('ordinary private stderr\n'));
    assert.equal(f.messages[0].payload.data, 'ordinary private stderr\n'); assert.deepEqual(f.warnings, []);
    f.destroyRenderer(); const count = f.messages.length;
    const value = line(row(stages[4], 'session-conflict'));
    child.stderr.emit('data', value.subarray(0, 15)); child.stderr.emit('data', value.subarray(15));
    assert.deepEqual(f.warnings.map(JSON.parse), [row(stages[4], 'session-conflict')]); assert.equal(f.messages.length, count);
    child.emit('close', 0, null); assert.equal(f.api.getCmdProcess(stream), undefined);
    assert.equal(child.listenerCount('close'), 1, 'Diagnostic framing adds no independent process observer.');
});

test('actual CMD keeps raw forwarding and exact legacy terminal behavior even if Main logging throws', async () => {
    const f = commandFixture({ throws: true }), stream = 'child_tool_simulator_test_1'; await f.run({});
    const child = f.children[0], value = line(row());
    assert.doesNotThrow(() => child.stderr.emit('data', value));
    assert.equal(f.messages[0].payload.type, 'stderr'); assert.equal(f.messages[0].payload.data, value.toString());
    child.emit('close', 7, null);
    const terminal = f.messages.filter(value => value.channel === 'cmd-data-' + stream && value.payload.type === 'close');
    assert.equal(terminal.length, 1); assert.equal(terminal[0].payload.code, 7); assert.equal(terminal[0].payload.terminal.closeObserved, true);
    assert.equal(f.api.getCmdProcess(stream), undefined);
});

test('actual CMD does not enable the sink for unrelated tools, streams or non-IPC commands', async () => {
    for (const options of [{ env: { AILY_CHILD_TOOL_ID: 'another-tool' } }, { streamId: 'ordinary-command' }, { messagePort: undefined }]) {
        const f = commandFixture(); await f.run(options); const child = f.children[0];
        child.stderr.emit('data', line(row())); assert.deepEqual(f.warnings, []); assert.equal(f.messages[0].payload.type, 'stderr');
        child.emit('close', 0, null);
    }
});
