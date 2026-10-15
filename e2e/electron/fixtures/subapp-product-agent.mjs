import { randomUUID } from 'node:crypto';

// Real Chat wire protocol; no injected tools, sessions or renderer state.
export async function connectAgent(WebSocket, url) {
  const socket = new WebSocket(url, { handshakeTimeout: 5000 });
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  const pending = new Map();
  const fail = error => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
  };
  socket.on('error', fail);
  socket.on('close', () => fail(new Error('Chat connection closed')));
  socket.on('message', data => {
    const message = JSON.parse(data.toString());
    const request = pending.get(message.id);
    if (!request || message.type !== 'response') return;
    pending.delete(message.id); clearTimeout(request.timer);
    if (message.ok) request.resolve(message.result);
    else request.reject(new Error(message.error));
  });
  return {
    call(command) {
      return new Promise((resolve, reject) => {
        const id = randomUUID();
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Chat timed out: ${command.type}`)); }, 30000);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, channel: 'agent', command }));
      });
    },
    close() { fail(new Error('Test complete')); socket.close(); }
  };
}
