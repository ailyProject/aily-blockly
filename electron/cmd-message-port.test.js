'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { CommandManager } = require('./cmd');

test('directly spawns one bounded bidirectional Node IPC process', async () => {
  const manager = new CommandManager();
  const events = [];
  const removeListener = manager.onProcessMessage((event) => events.push(event));
  const streamId = 'message-port-fixture';
  const result = manager.executeCommand({
    command: process.execPath,
    args: ['-e', `
      process.on('message', message => {
        process.send({ type: 'fixture.pong', requestId: message.requestId }, () => process.disconnect());
      });
      process.send({ type: 'fixture.ready' });
    `],
    cwd: __dirname,
    streamId,
    messagePort: {
      transport: 'node-ipc-v1',
      maxMessageBytes: 4096,
    },
  });

  try {
    await waitFor(() => events.some(
      event => event.message?.type === 'fixture.ready',
    ));
    assert.deepEqual(manager.getProcessMessagePortInfo(streamId), {
      transport: 'node-ipc-v1',
      maxMessageBytes: 4096,
    });

    const sent = await manager.sendProcessMessage(streamId, {
      type: 'fixture.ping',
      requestId: 'request-1',
    });
    assert.equal(sent.success, true);
    await waitFor(() => events.some(
      event => event.message?.type === 'fixture.pong',
    ));
    assert.deepEqual(
      events.map(event => event.message),
      [
        { type: 'fixture.ready' },
        { type: 'fixture.pong', requestId: 'request-1' },
      ],
    );
    await waitForExit(result.process);
  } finally {
    removeListener();
    if (result.process.exitCode === null && result.process.signalCode === null) {
      result.process.kill();
      await waitForExit(result.process);
    }
  }
});

async function waitFor(predicate) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Timed out waiting for child process message.');
}

test('process exit is observable in main after inventory cleanup without a renderer', async () => {
  const manager = new CommandManager();
  const events = [];
  const remove = manager.onProcessExit(event => {
    assert.equal(manager.getProcess(event.streamId), undefined);
    events.push(event);
  });
  const child = manager.executeCommand({
    command: process.execPath, args: ['-e', 'process.exit(7)'],
    streamId: 'exit-fixture', shellProfile: false,
  }).process;
  try {
    await waitFor(() => events.length === 1);
    assert.deepEqual(events, [{ streamId: 'exit-fixture', pid: child.pid, code: 7, signal: null, expected: false }]);
  } finally {
    remove();
    if (child.exitCode === null) { child.kill(); await waitForExit(child); }
  }
});

test('failed termination retains process ownership and clears stop intent', async () => {
  const manager = new CommandManager();
  const entry = { process: { pid: 0 }, startedAt: Date.now(), stopRequested: false };
  manager.processes.set('missing-pid', entry);
  assert.equal(await manager.killProcess('missing-pid'), false);
  assert.equal(manager.processes.get('missing-pid'), entry);
  assert.equal(entry.stopRequested, false);
});

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    child.once('exit', resolve);
    child.once('error', reject);
  });
}

test('explicit process termination emits one expected exit and ignores a late exit for a reused stream id', async () => {
  const manager = new CommandManager();
  const events = [];
  const remove = manager.onProcessExit(event => events.push(event));
  const first = manager.executeCommand({
    command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'],
    streamId: 'stop-fixture', shellProfile: false,
  }).process;
  let second;
  try {
    await manager.killProcess('stop-fixture');
    await waitFor(() => events.length === 1);
    assert.equal(events[0].expected, true);
    assert.equal(manager.getProcess('stop-fixture'), undefined);
    second = manager.executeCommand({
      command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'],
      streamId: 'stop-fixture', shellProfile: false,
    }).process;
    first.emit('close', 1, null);
    assert.equal(manager.getProcess('stop-fixture'), second);
    assert.equal(events.length, 1);
  } finally {
    await manager.killAllProcesses();
    if (second) await waitFor(() => events.length === 2);
    remove();
  }
});
