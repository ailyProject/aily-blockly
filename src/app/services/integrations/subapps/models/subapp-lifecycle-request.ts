/** One-shot cleanup against an already known Runtime endpoint. Never starts a process. */
export function sendSubappLifecycleRequest(
  wsUrl: string,
  method: string,
  params: Record<string, unknown>,
  context: Record<string, unknown>,
  timeoutMs: number,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    const id = `cleanup-${crypto.randomUUID()}`;
    let settled = false;
    const finish = (error?: Error, result?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (socket.readyState < WebSocket.CLOSING) socket.close();
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error('Subapp lifecycle cleanup timed out')), timeoutMs);
    socket.addEventListener('open', () => {
      if (settled) return;
      try { socket.send(JSON.stringify({ id, method, params, context })); }
      catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
    socket.addEventListener('message', event => {
      try {
        const message = JSON.parse(String(event.data));
        if (message.id !== id) return;
        if (message.ok === true) finish(undefined, message.result);
        else finish(new Error(String(message.error || 'Subapp lifecycle cleanup failed')));
      } catch { finish(new Error('Invalid Subapp lifecycle cleanup response')); }
    });
    socket.addEventListener('error', () => finish(new Error('Subapp lifecycle endpoint is unavailable')));
    socket.addEventListener('close', () => finish(new Error('Subapp lifecycle endpoint closed before acknowledgement')));
  });
}
