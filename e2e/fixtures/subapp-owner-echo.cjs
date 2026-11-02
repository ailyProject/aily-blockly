'use strict';

// A stateless, private acceptance Runtime. No device, simulator or network
// interface besides this process's loopback HTTP/WebSocket server is used.
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const trace = path.join(__dirname, 'calls.jsonl');
const server = http.createServer((_request, response) => response.end('owner-echo-fixture'));
const ws = new WebSocketServer({ server });
ws.on('connection', socket => socket.on('message', bytes => {
  const input = JSON.parse(String(bytes));
  if (!['fixture.echo', 'fixture.ownerRelease'].includes(input.method)) {
    socket.send(JSON.stringify({ id: input.id, ok: false, errorCode: 'FIXTURE_METHOD_DENIED' }));
    return;
  }
  fs.appendFileSync(trace, JSON.stringify({ method: input.method, sessionId: input.context?.sessionId,
    toolCallId: input.context?.toolCallId }) + '\n');
  socket.send(JSON.stringify({ id: input.id, ok: true, result: input.method === 'fixture.echo'
    ? { text: input.params.text, stateless: true } : { released: true, resources: 0 } }));
}));
server.listen(0, '127.0.0.1', () => {
  const port = server.address().port, origin = `http://127.0.0.1:${port}`;
  process.stdout.write(JSON.stringify({ event: 'ready', data: { mode: 'serve', url: origin, origin,
    wsUrl: `ws://127.0.0.1:${port}`, port, pid: process.pid, sessionId: 'private-owner-echo' } }) + '\n');
});
const stop = () => { ws.close(); server.close(() => process.exit(0)); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
