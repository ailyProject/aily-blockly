'use strict';

const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const { observeChildProcessTerminal } = require('./child-process-terminal');
const tick = () => new Promise(resolve => queueMicrotask(resolve));

function fixture({ ipc = true } = {}) {
    const child = Object.assign(new EventEmitter(), { pid: 12345,
        stdio: [new EventEmitter(), new EventEmitter(), new EventEmitter()] });
    [child.stdin, child.stdout, child.stderr] = child.stdio;
    if (ipc) Object.assign(child, { send() {}, connected: true });
    const events = [], observer = observeChildProcessTerminal(child, event => events.push(event));
    return { child, events, observer };
}

test('fallback joins actual exit, every owned pipe including stdin, and IPC disconnect', async () => {
    const f = fixture();
    f.child.emit('exit', 7, null); f.child.stdout.emit('close'); f.child.stderr.emit('close');
    await tick(); assert.equal(f.events.length, 0);
    f.child.connected = false; f.child.emit('disconnect');
    await tick(); assert.equal(f.events.length, 0, 'The actual owned stdin pipe remains outstanding');
    f.child.stdin.emit('close'); assert.equal(f.events.length, 0, 'Fallback is joined in a microtask');
    await tick();
    assert.deepEqual(f.events, [{ kind: 'exit-and-stdio-closed', code: 7, signal: null, closeObserved: false }]);
    assert.deepEqual(f.observer.snapshot().stdio, [0, 1, 2].map(fd => ({ fd, closeObserved: true })));
    assert.equal(f.observer.snapshot().close.observed, false);
});

test('field values and exit without actual IPC disconnect never prove termination', async () => {
    const f = fixture();
    f.child.exitCode = 0; f.child.connected = false;
    for (const pipe of f.child.stdio) { pipe.closed = true; pipe.destroyed = true; }
    f.child.emit('exit', 0, null); await tick(); assert.equal(f.events.length, 0);
    for (const pipe of f.child.stdio) pipe.emit('close');
    await tick(); assert.equal(f.events.length, 0, 'A false connected field is not the actual disconnect event');
    f.child.emit('disconnect'); await tick(); assert.equal(f.events.length, 1);
});

test('actual close wins a pending fallback and later events do not publish twice', async () => {
    const f = fixture();
    f.child.emit('disconnect'); for (const pipe of f.child.stdio) pipe.emit('close');
    f.child.emit('exit', null, 'SIGTERM'); f.child.emit('close', null, 'SIGTERM');
    assert.deepEqual(f.events, [{ kind: 'close', code: null, signal: 'SIGTERM', closeObserved: true }]);
    await tick(); f.child.emit('close', null, 'SIGTERM'); assert.equal(f.events.length, 1);
});

test('a late real close remains a separate observation after one fallback terminal', async () => {
    const f = fixture();
    f.child.emit('exit', 4, null); f.child.emit('disconnect');
    for (const pipe of f.child.stdio) pipe.emit('close');
    await tick(); assert.equal(f.events[0].closeObserved, false);
    f.child.emit('close', 4, null);
    assert.equal(f.events.length, 1); assert.equal(f.events[0].kind, 'exit-and-stdio-closed');
    assert.equal(f.events[0].closeObserved, false); assert.equal(f.observer.snapshot().close.observed, true);
});

test('spawn failure waits for the original close and keeps its exact result', async () => {
    const f = fixture({ ipc: false });
    f.child.emit('error', Object.assign(new Error('not found'), { code: 'ENOENT' }));
    await tick(); assert.equal(f.events.length, 0);
    f.child.emit('close', -4058, null);
    assert.deepEqual(f.events, [{ kind: 'close', code: -4058, signal: null, closeObserved: true }]);
    assert.deepEqual(f.observer.snapshot().error, { observed: true, code: 'ENOENT' });
});

test('disposing observations cancels a queued fallback without closing a pipe or process', async () => {
    const f = fixture();
    f.child.emit('disconnect'); f.child.emit('exit', 0, null);
    for (const pipe of f.child.stdio) pipe.emit('close');
    f.observer.dispose(); f.observer.dispose(); await tick();
    assert.equal(f.events.length, 0); assert.equal(f.child.listenerCount('close'), 0);
    assert.equal(f.child.stdout.listenerCount('close'), 0);
});

function commandFixture({ workspace, projectSessionId } = {}) {
    const f = fixture(), filename = require.resolve('./cmd');
    // The CommandManager owns the actual production terminal helper. Only the
    // process and tree boundary are deterministic event sources in this test.
    f.observer.dispose(); let kills = 0;
    const context = { module: { exports: {} }, process, setTimeout, clearTimeout,
        console: { log() {}, warn() {}, error() {}, info() {} },
        require: name => {
            if (name === 'electron') return { ipcMain: {} };
            if (name === 'child_process') return { spawn: () => f.child };
            if (name === './platform') return { isLinux: true };
            if (name === './process-tree') return { killRegisteredProcessTree: async () => { kills++; return false; } };
            if (name === './build-workspace-supervisor') return { createBuildWorkspaceSupervisor: () => workspace };
            return require(name);
        } };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
    const manager = new context.module.exports.CommandManager(), events = [];
    manager.onProcessExit(event => events.push(event));
    manager.executeCommand({ command: process.execPath, args: [], shellProfile: false, streamId: 'terminal-fixture',
        messagePort: { transport: 'node-ipc-v1', maxMessageBytes: 4096 }, projectSessionId });
    return { ...f, manager, events, get kills() { return kills; },
        complete(code = 0, signal = null) {
            f.child.emit('exit', code, signal); f.child.emit('disconnect');
            for (const pipe of f.child.stdio) pipe.emit('close');
        } };
}

test('CommandManager consumes one fallback without inventing close or retargeting a late reused stream', async () => {
    const f = commandFixture(); f.complete(); await tick();
    assert.equal(f.manager.getProcess('terminal-fixture'), undefined);
    assert.equal(f.events.length, 1); assert.equal(f.events[0].terminal.kind, 'exit-and-stdio-closed');
    assert.equal(f.events[0].terminal.closeObserved, false); assert.equal(f.events[0].expected, false);
    const replacement = { process: { pid: 67890 } }; f.manager.processes.set('terminal-fixture', replacement);
    f.child.emit('close', 0, null);
    assert.equal(f.events.length, 1); assert.equal(f.manager.processes.get('terminal-fixture'), replacement);
});

for (const protection of ['workspace', 'project']) test(`fallback keeps the original ${protection} termination guard`, async () => {
    const f = commandFixture(protection === 'workspace'
        ? { workspace: { environment: {}, canReleaseResources: () => false } }
        : { projectSessionId: 'owned-project-session' });
    f.complete(protection === 'project' ? null : 0, protection === 'project' ? 'SIGTERM' : null); await tick();
    const entry = f.manager.processes.get('terminal-fixture');
    assert.ok(entry); assert.equal(entry.terminationConfirmed, undefined);
    assert.equal(entry.terminal.kind, 'exit-and-stdio-closed'); assert.equal(entry.closed, undefined);
    assert.equal(await f.manager.killProcess('terminal-fixture'), false);
    assert.equal(f.kills, 0, 'A terminated PID must not be targeted again');
    f.child.emit('close', 0, null);
    assert.equal(f.events.length, 1); assert.equal(f.manager.processes.get('terminal-fixture'), entry);
});

test('real Node IPC disconnection joins actual process exit and all owned pipe close events', { timeout: 8000 }, async t => {
    const child = spawn(process.execPath, ['-e', `
        process.once('disconnect', () => { process.stdout.write('drained'); });
        process.send({ type: 'ready' });
    `], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
    let resolveTerminal;
    const terminalPromise = new Promise(resolve => { resolveTerminal = resolve; });
    const observer = observeChildProcessTerminal(child, resolveTerminal);
    const actualExit = once(child, 'exit'), actualStreams = Promise.all(child.stdio.slice(0, 3).map(pipe => once(pipe, 'close')));
    child.stdout.resume(); child.stderr.resume();
    t.after(async () => {
        if (child.connected) child.disconnect();
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await actualExit; await actualStreams; observer.dispose();
    });
    await once(child, 'message'); child.disconnect();
    const terminal = await terminalPromise, [code, signal] = await actualExit; await actualStreams;
    const facts = observer.snapshot();
    assert.equal(code, 0); assert.equal(signal, null); assert.equal(terminal.code, code); assert.equal(terminal.signal, signal);
    assert.ok(['close', 'exit-and-stdio-closed'].includes(terminal.kind));
    assert.equal(facts.exit.observed, true); assert.equal(facts.ipc.disconnectObserved, true);
    assert.deepEqual(facts.stdio, [0, 1, 2].map(fd => ({ fd, closeObserved: true })));
    assert.equal(terminal.closeObserved, terminal.kind === 'close');
    t.diagnostic(JSON.stringify({ pid: child.pid, terminal, actualFacts: facts,
        businessCleanupAcknowledged: false, descendantTerminationAcknowledged: false }));
});
