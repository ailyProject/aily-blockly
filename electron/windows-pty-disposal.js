'use strict';

// node-pty's public kill enumerates console PIDs after its shell has exited,
// and its natural-exit path leaves the conout worker alive. Only use this
// adapter AFTER native Job accounting proves the entire owned task is empty.
// Keep all dependency internals in this one boundary, and reject unknown shapes
// rather than probing or killing a possibly recycled console PID.
async function disposeStoppedPty(terminal) {
  const agent = terminal?._agent, connection = agent?._conoutSocketWorker;
  if (typeof agent?._ptyNative?.kill !== 'function' || typeof connection?._worker?.terminate !== 'function'
      || typeof agent?._inSocket?.destroy !== 'function' || typeof agent?._outSocket?.destroy !== 'function') {
    throw new Error('Unsupported Windows PTY disposal contract');
  }
  // Wait for node-pty's native process callback so its exit code reaches the
  // existing renderer event. No arbitrary console processes are enumerated.
  const deadline = Date.now() + 5000;
  while (agent.exitCode === undefined) {
    if (Date.now() > deadline) throw new Error('Windows PTY exit was not acknowledged');
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  // The normal onExit path has already drained output. A cancelled terminal
  // follows public kill's policy of discarding further output; keep the worker
  // draining while ClosePseudoConsole runs, then dispose its thread and pipes.
  agent._ptyNative.kill(agent.pty);
  clearTimeout(agent._closeTimeout);clearTimeout(connection._drainTimeout);
  agent._inSocket.destroy();agent._outSocket.destroy();
  connection._isDisposed = true;
  await connection._worker.terminate();
}
module.exports = { disposeStoppedPty };
