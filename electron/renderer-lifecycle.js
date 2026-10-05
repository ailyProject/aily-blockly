function shouldBeginRendererGeneration(details) {
  return !!details
    && details.isMainFrame === true
    && details.isSameDocument !== true;
}

// Wakes command callers that arrived before the renderer handshake.
// Availability stays with the caller: this gate only stores who is waiting.
function createRendererCommandGate() {
  const waiters = new Set();

  return {
    notify() {
      for (const waiter of [...waiters]) waiter();
    },

    wait(timeoutMs, signal, availability) {
      const current = availability();
      if (current) return Promise.resolve(current);
      if (signal?.aborted) return Promise.resolve('aborted');
      if (!(timeoutMs > 0)) return Promise.resolve('timeout');

      return new Promise((resolve) => {
        let settled = false;
        const finish = (status) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          waiters.delete(check);
          signal?.removeEventListener('abort', onAbort);
          resolve(status);
        };
        const check = () => {
          const status = availability();
          if (status) finish(status);
        };
        const onAbort = () => finish('aborted');
        const timer = setTimeout(() => finish('timeout'), timeoutMs);
        waiters.add(check);
        signal?.addEventListener('abort', onAbort, { once: true });
        check();
      });
    },
  };
}

module.exports = {
  shouldBeginRendererGeneration,
  createRendererCommandGate,
};
