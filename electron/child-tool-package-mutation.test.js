const assert = require('node:assert/strict');
const test = require('node:test');

const {
  quiesceChildToolPackageMutation,
} = require('./child-tool-package-mutation');

test('package mutation is idle when no runtime session exists', async () => {
  const result = await quiesceChildToolPackageMutation({
    toolId: 'simulator',
    sessions: new Map(),
    ownerCount: () => 0,
  });
  assert.deepEqual(result, { status: 'idle', toolId: 'simulator', action: 'update' });
});

test('package mutation rejects active owners before stopping or changing the registry', async () => {
  const session = { streamId: 'stream-active' };
  const sessions = new Map([['simulator', session]]);
  let stopped = false;
  await assert.rejects(
    quiesceChildToolPackageMutation({
      toolId: 'simulator',
      action: 'update',
      sessions,
      ownerCount: () => 2,
      cancelRelease: () => assert.fail('active session release must not be cancelled'),
      stopSession: async () => { stopped = true; },
      pendingMessages: new Map(),
      onChanged: () => assert.fail('active registry must not change'),
    }),
    (error) => (
      error.code === 'SUBAPP_UPDATE_IN_USE'
      && error.toolId === 'simulator'
      && error.refCount === 2
    ),
  );
  assert.equal(stopped, false);
  assert.equal(sessions.get('simulator'), session);
});

test('package mutation gracefully stops an unowned grace session and clears its registry state', async () => {
  const session = { streamId: 'stream-grace' };
  const sessions = new Map([['simulator', session]]);
  const pendingMessages = new Map([['stream-grace', [{ type: 'pending' }]]]);
  const events = [];
  const result = await quiesceChildToolPackageMutation({
    toolId: 'simulator',
    action: 'update',
    sessions,
    ownerCount: () => 0,
    cancelRelease: (value) => events.push(['cancel', value.streamId]),
    stopSession: async (value) => events.push(['stop', value.streamId]),
    pendingMessages,
    onChanged: () => events.push(['changed']),
  });
  assert.deepEqual(result, { status: 'stopped', toolId: 'simulator', action: 'update' });
  assert.deepEqual(events, [
    ['cancel', 'stream-grace'],
    ['stop', 'stream-grace'],
    ['changed'],
  ]);
  assert.equal(sessions.size, 0);
  assert.equal(pendingMessages.size, 0);
});
