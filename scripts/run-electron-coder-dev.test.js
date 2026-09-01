const assert = require('node:assert/strict');
const net = require('net');
const test = require('node:test');

const {
  isPortOpen,
  waitForPort,
} = require('./run-electron-coder-dev');

test('detects and reuses an existing development server port', async (t) => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();

  assert.equal(await isPortOpen(address.port, '127.0.0.1'), true);
  await waitForPort(address.port, '127.0.0.1', 1000);
});

test('reports a closed port without hanging', async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));

  assert.equal(await isPortOpen(address.port, '127.0.0.1', 100), false);
});
