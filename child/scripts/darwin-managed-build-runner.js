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
function inspectGroup() {
    const result = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,lstart='], {
        encoding: 'utf8', timeout: 1000, maxBuffer: 4 * 1024 * 1024,
    });
    const processes = new Map();
    const childrenByParent = new Map();
    for (const line of result.trim().split('\n')) {
        const entry = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
        if (!entry) throw new Error('Unrecognized macOS process snapshot.');
        const [, pidValue, parentValue, groupValue, start] = entry;
        const member = { pid: Number(pidValue), parent: Number(parentValue), group: Number(groupValue), start };
        processes.set(member.pid, member);
        const children = childrenByParent.get(member.parent) ?? [];
        children.push(member);
        childrenByParent.set(member.parent, children);
    }
    if (processes.get(process.pid)?.group !== process.pid) throw new Error('Build process group is unavailable.');
    const descendants = new Map();
    const externalGroups = new Set();
    const queue = [...(childrenByParent.get(process.pid) ?? [])];
    for (const member of queue) {
        if (descendants.has(member.pid)) throw new Error('Inconsistent macOS process snapshot.');
        descendants.set(member.pid, member);
        if (member.group !== process.pid) externalGroups.add(member.group);
        queue.push(...(childrenByParent.get(member.pid) ?? []));
    }
    return { descendants, externalGroups };
}

function recipeGroupOwner({ descendants }, group) {
    const leader = descendants.get(group);
    if (!leader || leader.group !== group) return null;
    const parent = descendants.get(leader.parent);
    return parent?.group === process.pid ? parent : null;
}

function isInstalledNinja(pid) {
    const prefix = process.env.AILY_NPM_PREFIX;
    if (!prefix || !path.isAbsolute(prefix)) return false;
    const ninja = fs.realpathSync(path.join(prefix, 'lib', 'node_modules', '@aily-project', 'aily-builder', 'ninja', 'ninja'));
    // macOS ps can report a supplied argv[0] as the command. Use the live
    // process' executable text mapping to identify the installed executable.
    const output = execFileSync('/usr/sbin/lsof', ['-nP', '-a', '-p', String(pid), '-d', 'txt', '-F0pfn'], {
        encoding: 'utf8', timeout: 500, maxBuffer: 256 * 1024,
    });
    const [processFields, firstMapping] = output.split('\n', 2);
    return processFields === `p${pid}\0` && firstMapping === `ftxt\0n${ninja}\0`;
}

function groupKeeper() {
    if (!process.connected || inspectGroup().externalGroups.size) process.exit(1);
    let child, terminating = false;
    function terminate(code, owned) {
        // The verified group leader force-stops its own group, never a saved group ID.
        send(process, { type: 'group-ending', code, owned }, () => process.kill(0, 'SIGKILL'));
    }
    function finish(code) {
        if (terminating) return;
        terminating = true;
        let owned = false;
        try { owned = inspectGroup().externalGroups.size === 0; }
        catch { /* Unknown membership cannot authorize a durable receipt. */ }
        terminate(code, owned);
    }
    function stop() {
        if (terminating) return;
        terminating = true;
        try {
            const original = inspectGroup();
            const tracked = original.externalGroups;
            if (!tracked.size) return terminate(1, true);
            const ninja = recipeGroupOwner(original, tracked.values().next().value);
            if (!ninja || [...tracked].some(group => recipeGroupOwner(original, group) !== ninja)
                || !isInstalledNinja(ninja.pid)) return terminate(1, false);

            function trackGroups(snapshot) {
                const live = snapshot.descendants.get(ninja.pid);
                if (live && (live.start !== ninja.start || live.parent !== ninja.parent || live.group !== process.pid)) return false;
                for (const group of snapshot.externalGroups) {
                    if (tracked.has(group)) continue;
                    if (recipeGroupOwner(snapshot, group)?.pid !== ninja.pid) return false;
                    tracked.add(group);
                }
                return true;
            }

            const current = inspectGroup();
            if (!current.descendants.has(ninja.pid) || !trackGroups(current)) return terminate(1, false);

            // Ninja creates one group per ordinary recipe. Let Ninja interrupt
            // and reap its recipes while the original ancestry remains live.
            // Stored group IDs are only observed with signal 0.
            process.kill(ninja.pid, 'SIGINT');
            const deadline = Date.now() + 1000;
            function observeNinja() {
                try {
                    const snapshot = inspectGroup();
                    if (!trackGroups(snapshot)) return terminate(1, false);
                    if (!snapshot.descendants.has(ninja.pid) && !snapshot.externalGroups.size
                        && [...tracked].every(group => !groupExists(group))) return terminate(1, true);
                } catch { return terminate(1, false); }
                if (Date.now() >= deadline) return terminate(1, false);
                setTimeout(observeNinja, 25);
            }
            observeNinja();
        } catch { terminate(1, false); }
    }
    process.on('disconnect', stop);
    process.on('message', message => {
        if (message?.type === 'stop') return stop();
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
