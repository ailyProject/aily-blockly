const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { getBridgeDir, startCliBridge } = require('./cli-bridge');

test('CLI bridge aborts an active command when its client disconnects', async () => {
  let commandStarted;
  let commandCancelled;
  const started = new Promise(resolve => { commandStarted = resolve; });
  const cancelled = new Promise(resolve => { commandCancelled = resolve; });
  const bridge = startCliBridge({
    getStatus: () => ({}),
    logger: { log() {}, warn() {}, error() {} },
    handleCommand: async (_action, _payload, signal) => {
      commandStarted();
      await new Promise(resolve => {
        signal.addEventListener('abort', () => {
          commandCancelled(signal.reason);
          resolve();
        }, { once: true });
      });
      return { ok: false };
    },
  });

  try {
    await waitUntil(() => bridge.getPort() !== null);
    const discovery = JSON.parse(fs.readFileSync(
      path.join(getBridgeDir(), `${process.pid}.json`),
      'utf8',
    ));
    const request = http.request({
      host: '127.0.0.1',
      port: bridge.getPort(),
      path: '/command',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    request.on('error', () => undefined);
    request.end(JSON.stringify({ token: discovery.token, action: 'wait' }));

    await started;
    request.destroy();
    const reason = await Promise.race([
      cancelled,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Cancellation was not forwarded')), 2000)),
    ]);
    assert.match(String(reason?.message || reason), /disconnected|aborted/u);
  } finally {
    bridge.close();
  }
});

async function waitUntil(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('CLI bridge did not start');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
