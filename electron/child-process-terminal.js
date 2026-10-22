'use strict';

/** Observe process/transport termination, never domain cleanup or descendant
 * termination. Windows Node IPC may omit ChildProcess close after disconnect;
 * its actual exit plus every owned pipe close is a separate terminal fact. */
function observeChildProcessTerminal(child, onTerminal) {
    if (!child || typeof child.on !== 'function' || typeof child.removeListener !== 'function'
        || typeof onTerminal !== 'function') throw new TypeError('A ChildProcess and terminal observer are required');
    const ipcRequired = typeof child.send === 'function' || child.channel != null || child.connected === true;
    const sourceStreams = Array.isArray(child.stdio) ? child.stdio : [child.stdin, child.stdout, child.stderr];
    const pipes = sourceStreams.flatMap((stream, fd) => stream && typeof stream.on === 'function'
        && typeof stream.removeListener === 'function' ? [{ fd, stream, closeObserved: false }] : []);
    const facts = { exit: { observed: false, code: null, signal: null },
        close: { observed: false, code: null, signal: null }, disconnectObserved: false,
        error: { observed: false, code: null } };
    let terminal = null, queued = false, disposed = false;
    const listeners = [];
    const listen = (emitter, event, listener) => {
        emitter.on(event, listener); listeners.push(() => emitter.removeListener(event, listener));
    };
    const publish = (kind, event) => {
        if (disposed || terminal) return;
        terminal = Object.freeze({ kind, code: event.code, signal: event.signal, closeObserved: facts.close.observed });
        onTerminal(terminal);
    };
    const join = () => {
        if (disposed || terminal || queued) return;
        queued = true;
        queueMicrotask(() => {
            queued = false;
            if (disposed || terminal || !facts.exit.observed || pipes.some(pipe => !pipe.closeObserved)
                || ipcRequired && !facts.disconnectObserved) return;
            publish('exit-and-stdio-closed', facts.exit);
        });
    };
    listen(child, 'exit', (code, signal) => {
        facts.exit = { observed: true, code, signal }; join();
    });
    listen(child, 'disconnect', () => { facts.disconnectObserved = true; join(); });
    listen(child, 'error', error => { facts.error = { observed: true, code: typeof error?.code === 'string' ? error.code : null }; });
    listen(child, 'close', (code, signal) => {
        facts.close = { observed: true, code, signal };
        publish('close', facts.close);
    });
    for (const pipe of pipes) listen(pipe.stream, 'close', () => { pipe.closeObserved = true; join(); });
    return {
        snapshot() {
            return { terminal: terminal && { ...terminal }, exit: { ...facts.exit }, close: { ...facts.close },
                ipc: { required: ipcRequired, disconnectObserved: facts.disconnectObserved },
                stdio: pipes.map(({ fd, closeObserved }) => ({ fd, closeObserved })), error: { ...facts.error } };
        },
        dispose() {
            if (disposed) return;
            disposed = true; for (const remove of listeners) remove();
        },
    };
}

module.exports = { observeChildProcessTerminal };
