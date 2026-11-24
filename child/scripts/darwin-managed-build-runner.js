'use strict';

const { execFileSync, spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function readTag(filename, token) {
    let fd;
    try {
        fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size !== token.length || fs.readFileSync(fd, 'utf8') !== token) {
            throw new Error('macOS build authority marker did not match.');
        }
        return true;
    } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function writeTag(filename, token) {
    const temporary = filename + '.' + randomUUID() + '.tmp';
    let fd;
    try {
        fd = fs.openSync(temporary, 'wx', 0o600);
        fs.writeFileSync(fd, token);
        fs.fsyncSync(fd);
        // One durable publication. Never replace an existing authority marker.
        fs.linkSync(temporary, filename);
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
        fs.rmSync(temporary, { force: true });
    }
}

function send(peer, payload, callback = () => {}) {
    if (peer.connected) peer.send(payload, callback);
    else callback();
}

function groupExists(pid) {
    try { process.kill(-pid, 0); return true; }
    catch (error) {
        if (error.code === 'ESRCH') return false;
        // macOS can return EPERM while a killed process group is draining.
        if (error.code === 'EPERM') return true;
        throw error;
    }
}

// A POSIX group is not a sandbox for custom recipes. Reject any still-visible
// child that has moved to another group rather than claiming to have stopped it.
function groupContainsDescendants() {
    const result = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid='], {
        encoding: 'utf8', timeout: 1000, maxBuffer: 4 * 1024 * 1024,
    });
    const descendants = new Map();
    let ownGroup;
    for (const line of result.trim().split('\n')) {
        const [pid, parent, group] = line.trim().split(/\s+/).map(Number);
        if (![pid, parent, group].every(Number.isSafeInteger)) return false;
        if (pid === process.pid) ownGroup = group;
        const children = descendants.get(parent) ?? [];
        children.push({ pid, group });
        descendants.set(parent, children);
    }
    if (ownGroup !== process.pid) return false;
    const queue = [...(descendants.get(process.pid) ?? [])];
    for (const child of queue) {
        if (child.group !== ownGroup) return false;
        queue.push(...(descendants.get(child.pid) ?? []));
    }
    return true;
}

function groupKeeper() {
    if (!process.connected || !groupContainsDescendants()) process.exit(1);
    let child, terminating = false;
    function finish(code) {
        if (terminating) return;
        terminating = true;
        let owned = false;
        try { owned = groupContainsDescendants(); }
        catch { /* Unknown membership cannot authorize a durable receipt. */ }
        // Only this still-live, verified group leader sends a destructive
        // signal, and it sends it to its own group, never a saved group id.
        send(process, { type: 'group-ending', code, owned }, () => process.kill(0, 'SIGKILL'));
    }
    process.on('disconnect', () => {
        if (terminating) process.kill(0, 'SIGKILL');
        else finish(1);
    });
    process.on('message', message => {
        if (message?.type === 'stop') return finish(1);
        if (terminating) return;
        if (message?.type === 'input' && child) return send(child, message.payload);
        if (message?.type !== 'launch' || child) return;
        const { file, args, env, argv0, relay, serialization } = message.command;
        try {
            child = spawn(file, args, {
                env, argv0, shell: false, stdio: relay ? [0, 1, 2, 'ipc'] : [0, 1, 2], serialization,
            });
        } catch (error) {
            console.error(error.message);
            return finish(1);
        }
        if (relay) child.on('message', payload => send(process, { type: 'output', payload }));
        child.once('error', error => console.error(error.message));
        child.once('close', code => finish(Number.isInteger(code) ? code : 1));
    });
}

function monitor(token, receiptPath) {
    if (!/^AilyDarwinBuild-[a-f0-9-]{36}$/.test(token) || !path.isAbsolute(receiptPath)
        || typeof process.send !== 'function') {
        process.exit(1);
    }
    let keeper, terminal, pendingExit, relays = 0, aborting = false;
    const interval = setInterval(() => {
        if (stopRequested()) stop();
    }, 50);

    function stopRequested() {
        try { return readTag(receiptPath + '.stop', token); }
        catch { return true; }
    }

    function finish(code, drained) {
        clearInterval(interval);
        pendingExit = { code, drained };
        flushExit();
    }

    function flushExit() {
        if (!pendingExit || (relays && process.connected)) return;
        if (pendingExit.drained) writeTag(receiptPath, token);
        process.exit(pendingExit.code);
    }

    function forwardOutput(payload) {
        ++relays;
        send(process, payload, () => {
            --relays;
            flushExit();
        });
    }

    function stop() {
        if (pendingExit) return flushExit();
        if (aborting) return;
        aborting = true;
        if (!keeper) return finish(1, true);
        send(keeper, { type: 'stop' });
    }

    process.on('disconnect', stop);
    if (!process.connected) return stop();
    process.on('message', message => {
        if (aborting) return;
        if (keeper) return send(keeper, { type: 'input', payload: message });
        if (stopRequested()) return stop();
        // The original host sends this control message only after the binding
        // is on disk. No build process is admitted without it.
        writeTag(receiptPath + '.admitted', token);
        keeper = spawn(process.execPath, [__filename, 'keeper'], {
            detached: true, stdio: [0, 1, 2, 'ipc'], serialization: message.serialization,
        });
        keeper.on('message', event => {
            if (event?.type === 'group-ending') terminal = event;
            if (event?.type === 'output') forwardOutput(event.payload);
        });
        keeper.once('error', error => console.error(error.message));
        keeper.once('close', () => {
            if (!keeper.pid) return finish(1, true);
            if (!terminal?.owned) return finish(1, false);
            const deadline = Date.now() + 4000;
            function observeDrain() {
                try {
                    if (!groupExists(keeper.pid)) return finish(terminal.code, true);
                } catch { return finish(1, false); }
                if (Date.now() >= deadline) return finish(1, false);
                setTimeout(observeDrain, 25);
            }
            observeDrain();
        });
        send(keeper, { type: 'launch', command: message });
    });
}

if (process.argv[2] === 'keeper') groupKeeper();
else if (process.argv[2] === 'monitor') monitor(process.argv[3], process.argv[4]);
else process.exit(1);
