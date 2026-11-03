'use strict';

// Global application quit closes admission first, then gives registered
// Runtimes one bounded opportunity to settle before the command-tree fallback.
function createChildToolSessionShutdown({ beginShutdown, getSessions, cancelRelease, stopSession, drainOwners,
  timeoutMs = 10000 }) {
  let shutdown;
  return function stopAllChildToolSessions() {
    if (shutdown) return shutdown;
    beginShutdown();
    const sessions = [...new Set(getSessions())];
    for (const session of sessions) cancelRelease(session);
    const controller = new AbortController();
    let timer;
    const expired = new Promise(resolve => {
      timer = setTimeout(() => { controller.abort(); resolve(null); }, timeoutMs);
    });
    let ownerCleanup = { complete: true, errors: [], pending: 0, timedOut: false };
    let ownerSettled = false;
    let owners;
    // Invoke synchronously: no new owner can enter after this call returns.
    try { owners = Promise.resolve(drainOwners ? drainOwners({ signal: controller.signal }) : ownerCleanup); }
    catch (error) { owners = Promise.reject(error); }
    owners = owners.then(result => { ownerSettled = true; return ownerCleanup = result && typeof result.complete === 'boolean' ? result : {
      complete: false, errors: ['Owner cleanup result unconfirmed'], pending: null, timedOut: false,
    }; }, error => { ownerSettled = true; return ownerCleanup = {
      complete: false, errors: [String(error?.message || error)], pending: null, timedOut: false,
    }; });
    shutdown = (async () => {
      let settled = 0;
      try {
        const ready = await Promise.race([owners, expired]);
        if (ready === null || controller.signal.aborted) return { complete: false, timedOut: true, sessions: sessions.length, pending: sessions.length,
          ownerCleanup: ownerSettled ? ownerCleanup : { complete: false, errors: ['Owner cleanup deadline exceeded'], pending: null, timedOut: true } };
        const stopped = Promise.all(sessions.map(session => Promise.resolve()
          .then(() => stopSession(session))
          .then(success => { settled++; return success === true; }, () => { settled++; return false; })));
        const results = await Promise.race([stopped, expired]);
        return { complete: ownerCleanup.complete === true && results !== null && results.every(Boolean),
          timedOut: results === null, sessions: sessions.length, pending: sessions.length - settled, ownerCleanup };
      } finally { clearTimeout(timer); }
    })();
    return shutdown;
  };
}

module.exports = { createChildToolSessionShutdown };
